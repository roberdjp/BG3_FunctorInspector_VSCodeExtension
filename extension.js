const vscode = require("vscode");
const { formatValue, formatEditable, collapseEditable } = require("./format");

const DATA_LINE = /^\s*data\s+"([^"]+)"\s+"(.*)"\s*$/;
const VALUE_START = /^\s*data\s+"[^"]+"\s+"/;
const SCHEME = "bg3-condition";
const config = () => vscode.workspace.getConfiguration("bg3ConditionHover");

// Returns { field, value, start, end } for a hoverable data line (start/end = value's columns), else null.
function parseLine(text) {
  const m = DATA_LINE.exec(text);
  if (!m || m[2].trim() === "") return null;
  if (!config().get("fields", []).includes(m[1])) return null;
  const start = VALUE_START.exec(text)[0].length;
  return { field: m[1], value: m[2], start, end: text.lastIndexOf('"') };
}

function entryName(document, lineNo) {
  for (let i = lineNo; i >= 0; i--) {
    const m = /^\s*new entry\s+"([^"]+)"/.exec(document.lineAt(i).text);
    if (m) return m[1];
  }
  return "entry";
}

const sameValue = (a, b) => a === b || collapseEditable(formatEditable(a)) === collapseEditable(formatEditable(b));
const countLines = s => (s.match(/\n/g) || []).length;

// ---------------------------------------------------------------------------------------------
// One editable pane per (source line). The pane is a file in our own file system, so Ctrl+S in it
// lands in writeFile below, which writes the collapsed text back into the source line.
//
// pane = { uri, sourceUri, line, field, baseline, content, mtime, lost, timer, reloading, asking,
//          opening, lastEditCount }
//   baseline: the source value the pane was last loaded from or last pushed to the source.
//   lastEditCount: non-whitespace characters before the end of the last edit made in the pane.
// ---------------------------------------------------------------------------------------------
const panes = new Map();   // pane uri string -> pane
const fsEvents = new vscode.EventEmitter();
let nextId = 1;

function findPane(document) {
  return panes.get(document.uri.toString());
}

function sourceDoc(pane) {
  return vscode.workspace.textDocuments.find(d => d.uri.toString() === pane.sourceUri);
}

function paneDoc(pane) {
  return vscode.workspace.textDocuments.find(d => d.uri.toString() === pane.uri);
}

// Make sure the source document is loaded (VS Code unloads it some time after its tab closes).
async function loadSource(pane) {
  if (!sourceDoc(pane)) {
    try { await vscode.workspace.openTextDocument(vscode.Uri.parse(pane.sourceUri)); } catch (_) { /* gone */ }
  }
}

// True if the pane holds edits that haven't reached the source. Compares content rather than
// VS Code's dirty flag, which can stay set after our own reloads.
function hasUnpushedEdits(pane) {
  const doc = paneDoc(pane);
  return !!doc && !sameValue(collapseEditable(doc.getText()), pane.baseline);
}

function hasOpenTab(pane) {
  return vscode.window.tabGroups.all.some(g => g.tabs.some(t =>
    t.input instanceof vscode.TabInputText && t.input.uri.toString() === pane.uri));
}

// Forget panes whose tab has been closed, so a closed pane never reacts to source edits.
function sweepClosedPanes() {
  for (const pane of [...panes.values()]) {
    if (pane.opening || hasOpenTab(pane)) continue;
    clearTimeout(pane.timer);
    panes.delete(pane.uri);
  }
}

// Column in the source line just after the n-th non-whitespace character of the value.
function columnAfterCount(parsed, n) {
  const value = parsed.value;
  let i = 0;
  while (n > 0 && i < value.length) {
    if (!/\s/.test(value[i])) n--;
    i++;
  }
  return parsed.start + i;
}

function wholeRange(doc) {
  const last = doc.lineCount - 1;
  return new vscode.Range(0, 0, last, doc.lineAt(last).text.length);
}

// The tracked source line, or null if it is gone / no longer a data line for the same field.
function readSource(pane) {
  const doc = sourceDoc(pane);
  if (!doc || pane.lost || pane.line >= doc.lineCount) return null;
  const parsed = parseLine(doc.lineAt(pane.line).text);
  if (!parsed || parsed.field !== pane.field) return null;
  return { doc, parsed };
}

// Write the pane text into the source line. Returns true if it was written (or nothing to write).
async function push(pane, text) {
  await loadSource(pane);
  const src = readSource(pane);
  if (!src) {
    vscode.window.showErrorMessage(`BG3 Condition: the original "${pane.field}" line is gone, so nothing was written.`);
    return false;
  }
  const value = collapseEditable(text);
  if (value.includes('"')) {
    vscode.window.showErrorMessage('BG3 Condition: a stats value can\'t contain a double quote ("), so nothing was written.');
    return false;
  }
  if (sameValue(value, src.parsed.value)) {   // unchanged apart from whitespace: leave the original alone
    pane.baseline = src.parsed.value;
    return true;
  }
  pane.baseline = value;   // set first, so our own edit isn't mistaken for an outside change
  const edit = new vscode.WorkspaceEdit();
  edit.replace(src.doc.uri, new vscode.Range(pane.line, src.parsed.start, pane.line, src.parsed.end), value);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    vscode.window.showErrorMessage("BG3 Condition: VS Code refused the edit to the original line.");
    return false;
  }
  // Leave the source cursor where the last change in the pane was made.
  const editor = vscode.window.visibleTextEditors.find(ed => ed.document.uri.toString() === pane.sourceUri);
  const after = readSource(pane);
  if (editor && after && pane.lastEditCount != null) {
    const pos = new vscode.Position(pane.line, columnAfterCount(after.parsed, pane.lastEditCount));
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
  return true;
}

// Replace the pane's text with the current source value (the pane's own edit, then saved).
async function reload(pane, value) {
  pane.baseline = value;
  const doc = paneDoc(pane);
  const text = formatEditable(value) + "\n";
  if (!doc) { pane.content = text; return; }
  if (doc.getText() === text && !doc.isDirty) return;
  pane.reloading = true;
  try {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, wholeRange(doc), text);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
  } finally {
    pane.reloading = false;
  }
}

const OVERWRITE = "Overwrite original", RELOAD = "Reload pane";

function askConflict(pane, modal) {
  return vscode.window.showWarningMessage(
    `BG3 Condition: the original "${pane.field}" line changed while its pane has unsaved edits.`,
    { modal },
    OVERWRITE, RELOAD
  );
}

// Non-modal version, shown when the original changes while the pane has unsaved edits.
async function notifyConflict(pane) {
  if (pane.asking) return;
  pane.asking = true;
  const choice = await askConflict(pane, false);
  pane.asking = false;
  const src = readSource(pane);
  if (!src) return;
  if (choice === OVERWRITE && paneDoc(pane)) {
    pane.baseline = src.parsed.value;
    await paneDoc(pane).save();
  } else if (choice === RELOAD) {
    await reload(pane, src.parsed.value);
  }
}

const fsProvider = {
  onDidChangeFile: fsEvents.event,
  watch: () => new vscode.Disposable(() => {}),
  stat(uri) {
    const pane = panes.get(uri.toString());
    if (!pane) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: pane.mtime, size: Buffer.byteLength(pane.content) };
  },
  readFile(uri) {
    const pane = panes.get(uri.toString());
    if (!pane) throw vscode.FileSystemError.FileNotFound(uri);
    return Buffer.from(pane.content, "utf8");
  },
  // Saves of one pane run one at a time. Two overlapping saves (quick Ctrl+S twice, or a live-sync
  // save plus Ctrl+S) would otherwise read the source before the first one's edit has landed and
  // mistake our own write for an outside change.
  writeFile(uri, bytes) {
    const pane = panes.get(uri.toString());
    if (!pane) throw vscode.FileSystemError.NoPermissions("This BG3 condition pane is no longer linked to a stats line.");
    const run = pane.queue.then(async () => {
      pane.writing = true;
      try {
        await writePane(pane, uri, bytes);
      } finally {
        pane.writing = false;
      }
      if (pane.recheck) { pane.recheck = false; reconcile(pane); }
    });
    pane.queue = run.catch(() => {});
    return run;
  },
  readDirectory: () => [],
  createDirectory() { throw vscode.FileSystemError.NoPermissions(); },
  delete() { throw vscode.FileSystemError.NoPermissions(); },
  rename() { throw vscode.FileSystemError.NoPermissions(); }
};

async function writePane(pane, uri, bytes) {
    const text = Buffer.from(bytes).toString("utf8");
    if (!pane.reloading) {
      clearTimeout(pane.timer);
      await loadSource(pane);
      const src = readSource(pane);
      if (src && !sameValue(src.parsed.value, pane.baseline)) {
        // The original changed underneath us and this save would overwrite it: ask first.
        const choice = await askConflict(pane, true);
        if (choice === RELOAD) {
          setTimeout(() => reload(pane, src.parsed.value), 0);   // after this save finishes
        } else if (choice === OVERWRITE) {
          pane.baseline = src.parsed.value;
          if (!(await push(pane, text))) throw vscode.FileSystemError.Unavailable("Nothing was written to the original line.");
        } else {
          throw vscode.FileSystemError.Unavailable("Save cancelled; the original line was left as it is.");
        }
      } else if (!(await push(pane, text))) {
        throw vscode.FileSystemError.Unavailable("Nothing was written to the original line.");
      }
    }
    pane.content = text;
    pane.mtime = Date.now();
    fsEvents.fire([{ type: vscode.FileChangeType.Changed, uri }]);
}

// The source line no longer matches what the pane last synced: reload a pane with nothing
// unpushed, otherwise ask.
function reconcile(pane) {
  const src = readSource(pane);
  if (!src || sameValue(src.parsed.value, pane.baseline)) return;
  if (config().get("liveSync") || !hasUnpushedEdits(pane)) {
    clearTimeout(pane.timer);
    reload(pane, src.parsed.value);
  } else {
    notifyConflict(pane);
  }
}

// Keep each pane's line number right as the source file is edited, and react to changes to the line itself.
function onSourceChanged(e) {
  const key = e.document.uri.toString();
  for (const pane of panes.values()) {
    if (pane.sourceUri !== key || pane.lost || !e.contentChanges.length) continue;
    // Ranges are in pre-change coordinates (VS Code orders them bottom-up), so they can be
    // compared with the tracked line directly.
    let shift = 0, touched = false, from = pane.line, to = pane.line;
    for (const c of e.contentChanges) {
      const delta = countLines(c.text) - (c.range.end.line - c.range.start.line);
      if (c.range.end.line < pane.line) shift += delta;
      else if (c.range.start.line <= pane.line) {
        touched = true;
        from = Math.min(from, c.range.start.line);
        to = Math.max(to, c.range.start.line + countLines(c.text));
      }
    }
    pane.line += shift;
    if (!touched) continue;

    // The change touched our line: find it again within the edited span. Prefer the line that
    // still holds the old value (it only moved), else the first line with the same field.
    let found = -1;
    for (let i = from + shift; i <= to + shift && i < e.document.lineCount; i++) {
      const p = parseLine(e.document.lineAt(i).text);
      if (!p || p.field !== pane.field) continue;
      if (sameValue(p.value, pane.baseline)) { found = i; break; }
      if (found < 0) found = i;
    }
    if (found < 0) { pane.lost = true; continue; }
    pane.line = found;

    // Mid-save, the change is most likely our own write: check again once the save is done.
    if (pane.writing || pane.reloading) { pane.recheck = true; continue; }
    reconcile(pane);
  }
}

// Remembers where the last edit in the pane ended (as a count of non-whitespace characters, which
// maps straight onto the source value). Live mode: push after a pause in typing, by saving the
// pane (same path as Ctrl+S).
function onPaneChanged(e) {
  const pane = findPane(e.document);
  if (!pane || pane.reloading || !e.contentChanges.length) return;

  // Changes arrive in pre-change offsets; walk them in order to find where the last one ends now.
  let shift = 0, endOffset = 0;
  for (const c of [...e.contentChanges].sort((a, b) => a.rangeOffset - b.rangeOffset)) {
    endOffset = c.rangeOffset + shift + c.text.length;
    shift += c.text.length - c.rangeLength;
  }
  pane.lastEditCount = e.document.getText().slice(0, endOffset).replace(/\s+/g, "").length;

  if (!config().get("liveSync")) return;
  clearTimeout(pane.timer);
  pane.timer = setTimeout(() => { if (e.document.isDirty) e.document.save(); }, Math.max(100, config().get("liveSyncDelay", 500)));
}

// Cursor in the pane -> select the same character on the source line.
function onPaneSelection(e) {
  const pane = findPane(e.textEditor.document);
  if (!pane || !config().get("syncCursor", true)) return;
  const src = readSource(pane);
  if (!src) return;
  const editor = vscode.window.visibleTextEditors.find(ed => ed.document.uri.toString() === pane.sourceUri);
  if (!editor) return;

  // Count the non-whitespace characters before the cursor; the same count lands on the same
  // character of the source value, because the pane only adds whitespace.
  const doc = e.textEditor.document;
  const before = doc.getText(new vscode.Range(new vscode.Position(0, 0), e.selections[0].active));
  let n = before.replace(/\s+/g, "").length;
  const value = src.parsed.value;
  let i = 0;
  for (; i < value.length; i++) {
    if (/\s/.test(value[i])) continue;
    if (n-- === 0) break;
  }
  const col = src.parsed.start + i;
  const end = Math.min(col + 1, src.parsed.end);
  const sel = new vscode.Selection(pane.line, col, pane.line, end);
  editor.selection = sel;
  editor.revealRange(sel, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function openBeside(linkUri, lineNo) {
  const source = await vscode.workspace.openTextDocument(vscode.Uri.parse(linkUri));
  // The hover link's URI comes back decoded ("c:" instead of "c%3A"), so it doesn't match the
  // document's own URI string. Use the document's.
  const sourceUri = source.uri.toString();
  const parsed = parseLine(source.lineAt(lineNo).text);
  if (!parsed) return;

  let pane = [...panes.values()].find(p => p.sourceUri === sourceUri && p.line === lineNo && !p.lost);
  if (!pane) {
    const name = `${entryName(source, lineNo)} ${parsed.field}`.replace(/[\\/:*?"<>|]/g, "_");
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${nextId++}/${name}` });
    pane = {
      uri: uri.toString(), sourceUri, line: lineNo, field: parsed.field, baseline: parsed.value,
      content: formatEditable(parsed.value) + "\n", mtime: Date.now(), lost: false, timer: null,
      reloading: false, asking: false, opening: false, lastEditCount: null,
      queue: Promise.resolve(), writing: false, recheck: false
    };
    panes.set(pane.uri, pane);
  }
  pane.opening = true;   // no tab yet: keep sweepClosedPanes from dropping it
  try {
    let doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(pane.uri));
    if (doc.languageId !== "bg3") doc = await vscode.languages.setTextDocumentLanguage(doc, "bg3");
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true });
  } finally {
    pane.opening = false;
  }
}

function activate(context) {
  const hover = vscode.languages.registerHoverProvider(
    [{ language: "bg3" }, { scheme: "file", pattern: "**/Stats/Generated/**/*.txt" }],
    {
      provideHover(document, position) {
        if (document.uri.scheme === SCHEME) return null;
        const line = document.lineAt(position.line);
        const parsed = parseLine(line.text);
        if (!parsed) return null;

        const args = encodeURIComponent(JSON.stringify([document.uri.toString(), position.line]));
        const md = new vscode.MarkdownString();
        md.isTrusted = { enabledCommands: ["bg3ConditionHover.openBeside"] };
        md.appendMarkdown(`**${parsed.field}** · [open beside](command:bg3ConditionHover.openBeside?${args})\n`);
        // "bg3" makes VS Code colour the block with the same grammar as the stats file.
        md.appendCodeblock(formatValue(parsed.value), "bg3");
        return new vscode.Hover(md, line.range);
      }
    }
  );

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, fsProvider, { isCaseSensitive: true }),
    hover,
    vscode.commands.registerCommand("bg3ConditionHover.openBeside", openBeside),
    vscode.workspace.onDidChangeTextDocument(e => (e.document.uri.scheme === SCHEME ? onPaneChanged(e) : onSourceChanged(e))),
    vscode.window.onDidChangeTextEditorSelection(onPaneSelection),
    // A pane lives as long as its tab. (Document close events are no good for this: VS Code
    // unloads documents long after their tab closes, and a language change closes and reopens one.)
    vscode.window.tabGroups.onDidChangeTabs(sweepClosedPanes),
    vscode.window.tabGroups.onDidChangeTabGroups(sweepClosedPanes)
  );
}

exports.activate = activate;
