// XLSX (SpreadsheetML) -> Markdown: one "## Sheet" section per sheet, each data region as a table.
import { unzip, zipXml, readRels, kids, kid, desc, attr, renderTable, escapeMd, mime, ConvertError, checkAbort, tick } from "./util.js";

const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const BUILTIN = { 0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??", 14: "yyyy-mm-dd", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "yyyy-mm-dd h:mm", 37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@" };

export async function convertXlsx(ctx) {
  const files = await unzip(ctx.bytes);
  const wbPath = Object.keys(files).find((p) => /^xl\/workbook\d*\.xml$/.test(p)) || "xl/workbook.xml";
  const wb = zipXml(files, wbPath);
  if (!wb) throw new ConvertError("This doesn't look like an Excel workbook (xl/workbook.xml is missing).");
  const rels = readRels(files, wbPath);
  const date1904 = desc(wb, "workbookPr").some((p) => /^(1|true)$/.test(attr(p, "date1904") || ""));
  const shared = readShared(files, [...rels.values()].find((r) => r.type === "sharedStrings")?.target || "xl/sharedStrings.xml");
  const styles = readStyles(files, [...rels.values()].find((r) => r.type === "styles")?.target || "xl/styles.xml");
  const sheets = desc(wb, "sheet");
  const blocks = [];
  let i = 0;
  for (const sh of sheets) {
    checkAbort(ctx.signal);
    const name = attr(sh, "name");
    const state = attr(sh, "state");
    ctx.progress(i++, sheets.length, name);
    if (state === "hidden" || state === "veryHidden") { ctx.warnings.push(`Skipped hidden sheet “${name}”.`); continue; }
    const rel = rels.get(attr(sh, "r:id"));
    if (!rel || rel.type === "chartsheet") { blocks.push(`## ${escapeMd(name)}`, "<!-- image -->"); continue; }
    const doc = zipXml(files, rel.target);
    if (!doc) continue;
    blocks.push(`## ${escapeMd(name)}`);
    const grid = readSheet(doc, shared, styles, date1904);
    for (const region of regions(grid)) blocks.push(renderTable(region, { header: true }));
    blocks.push(...sheetImages(ctx, files, rel.target));
    await tick();
  }
  ctx.progress(sheets.length, sheets.length);
  return blocks.join("\n\n");
}

function readShared(files, path) {
  const doc = zipXml(files, path);
  if (!doc) return [];
  return kids(doc.documentElement, "si").map(richText);
}
// <si>/<is>: plain <t> or rich runs <r><t/></r>; skip phonetic runs
function richText(si) {
  let s = "";
  for (const c of kids(si)) {
    if (c.localName === "t") s += c.textContent;
    else if (c.localName === "r") {
      const t = kid(c, "t")?.textContent || "";
      const rpr = kid(c, "rPr");
      const b = rpr && kid(rpr, "b") && attr(kid(rpr, "b"), "val") !== "0";
      const i = rpr && kid(rpr, "i") && attr(kid(rpr, "i"), "val") !== "0";
      s += t;
      void b; void i;
    }
  }
  return s;
}

function readStyles(files, path) {
  const doc = zipXml(files, path);
  const fmts = new Map();
  const xfs = [];
  if (!doc) return { xfs, fmts };
  for (const f of desc(doc, "numFmt")) fmts.set(+attr(f, "numFmtId"), attr(f, "formatCode"));
  const cellXfs = desc(doc, "cellXfs")[0];
  for (const xf of kids(cellXfs, "xf")) xfs.push(+attr(xf, "numFmtId") || 0);
  return { xfs, fmts };
}

function colIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
    else break;
  }
  return n - 1;
}
function parseRef(ref) {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref);
  return m ? { c: colIndex(m[1]), r: +m[2] - 1 } : null;
}

function readSheet(doc, shared, styles, date1904) {
  const grid = [];
  const sheetData = desc(doc, "sheetData")[0];
  let rIdx = -1;
  for (const row of kids(sheetData, "row")) {
    rIdx = attr(row, "r") ? +attr(row, "r") - 1 : rIdx + 1;
    if (rIdx > 100000) break;
    let cIdx = -1;
    for (const c of kids(row, "c")) {
      const ref = attr(c, "r");
      cIdx = ref ? colIndex(ref) : cIdx + 1;
      if (cIdx > 2000) break;
      const v = cellValue(c, shared, styles, date1904);
      if (v === "") continue;
      (grid[rIdx] ||= [])[cIdx] = v;
    }
  }
  // merged cells: fill the whole range with the top-left value (Docling style)
  for (const m of desc(doc, "mergeCell")) {
    const [a, b] = (attr(m, "ref") || "").split(":");
    const p = parseRef(a), q = parseRef(b || a);
    if (!p || !q) continue;
    const v = grid[p.r]?.[p.c];
    if (v == null) continue;
    for (let r = p.r; r <= Math.min(q.r, p.r + 500); r++) for (let c = p.c; c <= Math.min(q.c, p.c + 200); c++) (grid[r] ||= [])[c] = v;
  }
  return grid;
}

function cellValue(c, shared, styles, date1904) {
  const t = attr(c, "t") || "n";
  const vEl = kid(c, "v");
  const raw = vEl ? vEl.textContent : null;
  let s;
  if (t === "s") s = raw != null ? shared[+raw] ?? "" : "";
  else if (t === "inlineStr") s = kid(c, "is") ? richText(kid(c, "is")) : raw || "";
  else if ((raw == null || raw === "") && kid(c, "f") && kid(c, "f").textContent) s = "=" + kid(c, "f").textContent; // formula without a cached value
  else if (t === "str") s = raw ?? "";
  else if (t === "b") s = raw === "1" ? "TRUE" : "FALSE";
  else if (t === "e") s = raw ?? "#ERROR";
  else if (t === "d") s = raw ? raw.replace(/T00:00:00(\.0+)?Z?$/, "") : "";
  else {
    if (raw == null || raw === "") return "";
    const num = +raw;
    const fmtId = styles.xfs[+(attr(c, "s") || 0)] || 0;
    s = formatNumber(num, fmtId, styles.fmts, date1904);
  }
  return escapeMd(String(s).trim()).replace(/\r?\n/g, "<br>");
}

function isDateFormat(code) {
  if (!code) return false;
  const stripped = code.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[(?!h\]|m\]|s\])[^\]]*\]/gi, "");
  return /[dmyhs]/i.test(stripped) && !/^[#0.,%E+\-? ]+$/.test(stripped);
}

export function formatNumber(num, fmtId, fmts, date1904) {
  if (!isFinite(num)) return String(num);
  const code = fmts.get(fmtId) ?? BUILTIN[fmtId] ?? "General";
  if (DATE_IDS.has(fmtId) || isDateFormat(code)) return formatDate(num, code, date1904);
  if (/%/.test(code.replace(/"[^"]*"/g, ""))) {
    const dec = (/\.(0+)%/.exec(code) || [, ""])[1].length;
    return (num * 100).toFixed(dec) + "%";
  }
  const m = /0\.(0+)(?![^;]*E)/.exec(code.split(";")[0]);
  if (m && !/E\+/i.test(code)) {
    const fixed = Math.abs(num).toFixed(m[1].length);
    const thousands = /#,##/.test(code);
    const body = thousands ? fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : fixed;
    const cur = /[$€£¥]/.exec(code.replace(/"[^"]*"/g, ""))?.[0] || "";
    return (num < 0 ? "-" : "") + cur + body;
  }
  if (/#,##0/.test(code) && !/\./.test(code)) return Math.round(num).toLocaleString("en-US");
  return general(num);
}
function general(num) {
  if (Number.isInteger(num)) return String(num);
  const s = String(+num.toPrecision(15));
  return s;
}
function formatDate(serial, code, date1904) {
  const ms = Math.round((serial + (date1904 ? 1462 : 0) - 25569) * 86400000);
  const d = new Date(ms);
  if (isNaN(d)) return String(serial);
  const iso = d.toISOString();
  const stripped = (code || "").replace(/"[^"]*"/g, "").toLowerCase();
  const hasDate = /[dy]/.test(stripped) || (/m/.test(stripped) && !/[hs]/.test(stripped));
  const hasTime = /[hs]/.test(stripped);
  if (hasDate && hasTime) return iso.slice(0, 10) + " " + iso.slice(11, /s/.test(stripped) ? 19 : 16);
  if (hasTime) {
    if (/\[h\]/.test(stripped)) {
      const total = Math.round(serial * 86400);
      return `${Math.floor(total / 3600)}:${String(Math.floor(total / 60) % 60).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    }
    return iso.slice(11, /s/.test(stripped) ? 19 : 16);
  }
  return iso.slice(0, 10);
}

// Split a sparse grid into rectangular data regions (connected non-empty cells, Docling-like).
export function regions(grid) {
  const cells = [];
  grid.forEach((row, r) => row && row.forEach((v, c) => { if (v != null && v !== "") cells.push([r, c]); }));
  if (!cells.length) return [];
  const key = (r, c) => r * 4096 + c;
  const has = new Set(cells.map(([r, c]) => key(r, c)));
  const seen = new Set();
  let boxes = [];
  for (const [r0, c0] of cells) {
    if (seen.has(key(r0, c0))) continue;
    const box = { r0, r1: r0, c0, c1: c0 };
    const stack = [[r0, c0]];
    seen.add(key(r0, c0));
    while (stack.length) {
      const [r, c] = stack.pop();
      box.r0 = Math.min(box.r0, r); box.r1 = Math.max(box.r1, r); box.c0 = Math.min(box.c0, c); box.c1 = Math.max(box.c1, c);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nc < 0) continue;
        const k = key(nr, nc);
        if (has.has(k) && !seen.has(k)) { seen.add(k); stack.push([nr, nc]); }
      }
    }
    boxes.push(box);
  }
  // merge overlapping / touching boxes
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.r0 <= b.r1 + 1 && b.r0 <= a.r1 + 1 && a.c0 <= b.c1 + 1 && b.c0 <= a.c1 + 1) {
        boxes[i] = { r0: Math.min(a.r0, b.r0), r1: Math.max(a.r1, b.r1), c0: Math.min(a.c0, b.c0), c1: Math.max(a.c1, b.c1) };
        boxes.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }
  boxes.sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0);
  return boxes.map((b) => {
    const rows = [];
    for (let r = b.r0; r <= b.r1; r++) {
      const row = [];
      for (let c = b.c0; c <= b.c1; c++) row.push(grid[r]?.[c] ?? "");
      rows.push(row);
    }
    return rows;
  });
}

function sheetImages(ctx, files, sheetPath) {
  const out = [];
  const rels = readRels(files, sheetPath);
  for (const rel of rels.values()) {
    if (rel.type !== "drawing") continue;
    const dr = zipXml(files, rel.target);
    if (!dr) continue;
    const drels = readRels(files, rel.target);
    for (const anchor of kids(dr.documentElement)) {
      const blip = desc(anchor, "blip")[0];
      if (blip) {
        const r = drels.get(attr(blip, "r:embed"));
        const alt = attr(desc(anchor, "cNvPr")[0], "descr") || "";
        if (r && !r.external) out.push(ctx.images.add(files[r.target], mime(r.target), alt, r.target));
      } else if (desc(anchor, "chart").length) out.push("<!-- image -->");
    }
  }
  return out;
}
