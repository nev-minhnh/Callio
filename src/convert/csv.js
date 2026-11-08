import { decodeText, renderTable, escapeMd } from "./util.js";

export function parseDelimited(text, delim) {
  const rows = [];
  let row = [], field = "", i = 0, quoted = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field.trim() === "") { quoted = true; field = ""; i++; continue; }
    if (ch === delim) { row.push(field); field = ""; i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function detectDelimiter(text) {
  const sample = text.slice(0, 20000);
  let best = ",", bestScore = -1;
  for (const d of [",", ";", "\t", "|"]) {
    const rows = parseDelimited(sample, d).slice(0, 50).filter((r) => r.some((c) => c.trim()));
    if (rows.length === 0) continue;
    const freq = new Map();
    for (const r of rows) freq.set(r.length, (freq.get(r.length) || 0) + 1);
    const mode = [...freq].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    if (mode < 2) continue;
    const consistent = rows.filter((r) => r.length === mode).length / rows.length;
    const score = consistent * 10 + Math.min(mode, 10) * 0.1;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

export async function convertCsv(ctx) {
  const text = decodeText(ctx.bytes);
  const delim = ctx.ext === "tsv" || ctx.ext === "tab" ? "\t" : detectDelimiter(text);
  let rows = parseDelimited(text, delim).filter((r) => r.some((c) => c.trim()));
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  rows = rows.map((r) => {
    const out = r.map((c) => escapeMd(c.trim()));
    while (out.length < width) out.push("");
    return out;
  });
  if (rows.length > 5000) ctx.warnings.push(`Large table: ${rows.length} rows.`);
  return renderTable(rows);
}
