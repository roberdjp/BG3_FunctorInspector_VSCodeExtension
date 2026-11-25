// Pretty-printer for BG3 stats Boosts / functor / condition strings.
// Splits top-level ";" into numbered entries, pulls IF(...) conditions out, and
// breaks conditions at "and" / "or", indenting one level per parenthesised group.
// Never splits inside quotes or inside a function call's own argument list unless
// that argument list itself contains and/or.

const INDENT = "    ";

// Split s at top level (depth 0, outside quotes) wherever isSep(s, i) returns a length > 0.
function splitTop(s, isSep) {
  const parts = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const len = isSep(s, i);
      if (len) {
        parts.push({ text: s.slice(start, i), sep: s.slice(i, i + len).trim() });
        start = i + len;
        i += len - 1;
      }
    }
  }
  parts.push({ text: s.slice(start), sep: null });
  return parts;
}

const semicolon = (s, i) => (s[i] === ";" ? 1 : 0);

// " and " / " or " as whole words (any surrounding whitespace).
function boolOp(s, i) {
  if (!/\s/.test(s[i])) return 0;
  const m = /^\s+(and|or)\s+/i.exec(s.slice(i));
  return m ? m[0].length : 0;
}

// Index of the ")" matching the "(" at position open, or -1.
function matchParen(s, open) {
  let depth = 0, quote = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

const hasTopBool = s => splitTop(s, boolOp).length > 1;

// Format a condition expression into lines (array of strings) at the given indent level.
function formatExpr(expr, level) {
  expr = expr.trim();
  const pad = INDENT.repeat(level);
  const parts = splitTop(expr, boolOp);
  if (parts.length > 1) {
    const lines = [];
    let op = null;
    for (const p of parts) {
      const sub = formatAtom(p.text.trim(), level);
      if (op) sub[0] = pad + op + " " + sub[0].trimStart();
      lines.push(...sub);
      op = p.sep;
    }
    return lines;
  }
  return formatAtom(expr, level);
}

// An atom is "not X", "name(args)", "(group)", or plain text. Expand groups that hold and/or.
function formatAtom(atom, level) {
  const pad = INDENT.repeat(level);
  const notMatch = /^not\s+/i.exec(atom);
  if (notMatch) {
    const inner = formatAtom(atom.slice(notMatch[0].length), level);
    inner[0] = pad + "not " + inner[0].trimStart();
    return inner;
  }
  const open = atom.indexOf("(");
  if (open >= 0 && /^[\w.]*$/.test(atom.slice(0, open).trim())) {
    const close = matchParen(atom, open);
    if (close === atom.length - 1) {
      const head = atom.slice(0, open + 1);
      const inner = atom.slice(open + 1, close);
      // Expand when the group's contents contain and/or (but leave plain calls inline).
      const args = splitTop(inner, (s, i) => (s[i] === "," ? 1 : 0));
      if (args.some(a => hasTopBool(a.text))) {
        if (args.length === 1) {
          return [pad + head, ...formatExpr(inner, level + 1), pad + ")"];
        }
        const lines = [pad + head];
        args.forEach((a, k) => {
          const sub = formatExpr(a.text, level + 1);
          if (k < args.length - 1) sub[sub.length - 1] += ",";
          lines.push(...sub);
        });
        lines.push(pad + ")");
        return lines;
      }
    }
  }
  return [pad + atom];
}

// Format one ";"-separated entry, e.g. "IF(cond):RollBonus(X,1)".
function formatEntry(entry) {
  entry = entry.trim();
  const m = /^IF\s*\(/i.exec(entry);
  if (m) {
    const open = entry.indexOf("(");
    const close = matchParen(entry, open);
    if (close > 0 && entry[close + 1] === ":") {
      const cond = entry.slice(open + 1, close);
      const body = entry.slice(close + 2).trim();
      return ["IF", ...formatExpr(cond, 1), "THEN " + body];
    }
  }
  return formatExpr(entry, 0);
}

// Whole value -> text block. Entries numbered when there is more than one.
function formatValue(value) {
  const entries = splitTop(value, semicolon).map(p => p.text.trim()).filter(Boolean);
  if (entries.length === 1) return formatEntry(entries[0]).join("\n");
  const width = String(entries.length).length;
  return entries.map((e, i) => {
    const label = String(i + 1).padStart(width) + ". ";
    const blank = " ".repeat(label.length);
    return formatEntry(e).map((line, k) => (k === 0 ? label : blank) + line).join("\n");
  }).join("\n\n");
}

// ---- Editable (reversible) format for the "open beside" pane.
// Same layout as formatValue, but keeps the real syntax (IF( ... ):body, ";") and adds
// nothing except line breaks and indentation, so collapseEditable() can rebuild the line.

function formatEditableEntry(entry) {
  entry = entry.trim();
  const m = /^IF\s*\(/i.exec(entry);
  if (m) {
    const open = entry.indexOf("(");
    const close = matchParen(entry, open);
    if (close > 0 && entry[close + 1] === ":") {
      const cond = entry.slice(open + 1, close);
      if (hasTopBool(cond)) {
        return [entry.slice(0, open + 1), ...formatExpr(cond, 1), entry.slice(close)];
      }
      return [entry];
    }
  }
  return formatExpr(entry, 0);
}

function formatEditable(value) {
  const entries = splitTop(value, semicolon).map(p => p.text.trim());
  return entries.map(formatEditableEntry).map(lines => lines.join("\n")).join(";\n\n");
}

// Inverse of formatEditable: trims every line and rejoins them. A line break becomes nothing
// after ( , ; : or before ) , ; and a single space everywhere else (e.g. before "and").
// Whitespace inside a line is kept exactly as typed.
function collapseEditable(text) {
  let out = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (out && !/[(,;:]$/.test(out) && !/^[),;]/.test(line)) out += " ";
    out += line;
  }
  return out;
}

module.exports = { formatValue, formatEditable, collapseEditable, splitTop, semicolon };
