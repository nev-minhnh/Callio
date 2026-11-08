// Shared helpers for the Markdown converters (Docling-like output style).

export class ConvertError extends Error {
  constructor(message) { super(message); this.name = "ConvertError"; }
}

export function checkAbort(signal) {
  if (signal?.aborted) {
    const e = new Error("Conversion aborted");
    e.name = "AbortError";
    throw e;
  }
}

// yield to the event loop so long conversions keep the UI responsive
export const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------- text decoding ----------

export function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  let s;
  try { s = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { s = new TextDecoder("windows-1252").decode(bytes); }
  return s.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

// ---------- xml ----------

export function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (err && doc.documentElement.nodeName === "parsererror") throw new ConvertError("Malformed XML in document");
  return doc;
}

// element children with a given local name (any namespace)
export function kids(el, name) {
  const out = [];
  if (!el) return out;
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (!name || c.localName === name) out.push(c);
  return out;
}
export function kid(el, name) {
  if (!el) return null;
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name) return c;
  return null;
}
// descendant elements by local name
export function desc(el, name) {
  if (!el) return [];
  return Array.from(el.getElementsByTagNameNS("*", name));
}
export function attr(el, name) {
  if (!el) return null;
  if (el.hasAttribute(name)) return el.getAttribute(name);
  const local = name.includes(":") ? name.split(":")[1] : name;
  for (const a of el.attributes) if (a.localName === local) return a.value;
  return null;
}

// ---------- zip ----------

export async function unzip(bytes) {
  const { unzipSync } = await import("fflate");
  try { return unzipSync(bytes); }
  catch { throw new ConvertError("The file is not a valid Office/zip document (it may be corrupt or password-protected)."); }
}
export function zipText(files, path) {
  const f = files[path];
  return f ? new TextDecoder("utf-8").decode(f) : null;
}
export function zipXml(files, path) {
  const t = zipText(files, path);
  return t == null ? null : parseXml(t);
}
// resolve a relationship target relative to a part path ("word/document.xml" + "media/a.png")
export function resolvePath(base, target) {
  if (!target) return null;
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/");
  parts.pop();
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}
// read a .rels part for a given part: returns Map id -> { target (resolved path or external URL), type, external }
export function readRels(files, partPath) {
  const dir = partPath.split("/");
  const file = dir.pop();
  const relsPath = [...dir, "_rels", file + ".rels"].join("/");
  const map = new Map();
  const doc = zipXml(files, relsPath);
  if (!doc) return map;
  for (const r of desc(doc, "Relationship")) {
    const external = r.getAttribute("TargetMode") === "External";
    const t = r.getAttribute("Target");
    map.set(r.getAttribute("Id"), {
      target: external ? t : resolvePath(partPath, t),
      type: (r.getAttribute("Type") || "").split("/").pop(),
      external,
    });
  }
  return map;
}

// ---------- markdown escaping ----------

// escape inline text so it renders literally
export function escapeMd(s) {
  if (!s) return "";
  return s
    .replace(/\\/g, "\\\\")
    .replace(/([*`])/g, "\\$1")
    .replace(/(^|[^\p{L}\p{N}])_|_(?=$|[^\p{L}\p{N}])/gu, (m) => m.replace("_", "\\_"))
    .replace(/<(?=[A-Za-z/!?])/g, "&lt;")
    .replace(/\[(?=[^\]]*\]\()/g, "\\[")
    .replace(/\$/g, "\\$");
}
// escape characters that would start a block construct at the beginning of a line
export function escapeLineStart(s) {
  return s
    .replace(/^(\s*)([#>+])/, "$1\\$2")
    .replace(/^(\s*)([-*])(\s)/, "$1\\$2$3")
    .replace(/^(\s*)(\d{1,9})([.)])(\s)/, "$1$2\\$3$4")
    .replace(/^(\s*)(=+|-{3,})\s*$/, "$1\\$2");
}

export function mime(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  return {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp",
    webp: "image/webp", tif: "image/tiff", tiff: "image/tiff", svg: "image/svg+xml",
    emf: "image/emf", wmf: "image/wmf", jfif: "image/jpeg",
  }[ext] || "application/octet-stream";
}
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/bmp": "bmp", "image/webp": "webp", "image/tiff": "tiff", "image/svg+xml": "svg", "image/emf": "emf", "image/wmf": "wmf" };

export function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(b64) {
  const s = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// Collects images according to imageMode and returns the Markdown that references each.
export class ImageSink {
  constructor(mode = "placeholder", baseName = "document") {
    this.mode = mode || "placeholder";
    this.dir = baseName.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|#\s]+/g, "_") + "_files";
    this.images = [];
    this.byKey = new Map();
  }
  // bytes may be null (unknown image) -> placeholder
  add(bytes, mimeType, alt = "", key = null) {
    if (this.mode === "placeholder" || !bytes || !bytes.length) return "<!-- image -->";
    const a = escapeAlt(alt);
    if (this.mode === "embed") return `![${a}](data:${mimeType};base64,${toBase64(bytes)})`;
    let name = key != null ? this.byKey.get(key) : null;
    if (!name) {
      name = `${this.dir}/image${this.images.length + 1}.${EXT[mimeType] || "bin"}`;
      this.images.push({ name, file: name.split("/").pop(), bytes, mime: mimeType });
      if (key != null) this.byKey.set(key, name);
    }
    return `![${a}](${encodeURI(name)})`;
  }
}
function escapeAlt(s) { return (s || "").replace(/\s+/g, " ").replace(/([\[\]\\])/g, "\\$1").trim(); }

// ---------- inline formatting ----------
// segments: { text, b, i, s, u, code, sup, sub, href, raw }
// raw: pre-rendered markdown (images, math, footnote refs) inserted verbatim
const ORDER = ["href", "code", "b", "i", "s", "u", "sup", "sub"];
export function renderInline(segs) {
  segs = segs.filter((s) => s.raw || s.text);
  // merge neighbours with identical formatting
  const merged = [];
  for (const s of segs) {
    const p = merged[merged.length - 1];
    if (p && !p.raw && !s.raw && ORDER.every((k) => (p[k] || false) === (s[k] || false))) p.text += s.text;
    else merged.push({ ...s });
  }
  // whitespace-only formatted runs lose their formatting
  for (const s of merged) if (!s.raw && !s.code && !s.href && !s.text.trim()) for (const k of ORDER) s[k] = false;
  return group(merged, 0);
}
function group(segs, k) {
  if (k >= ORDER.length) return segs.map((s) => (s.raw ? s.raw : escapeMd(s.text))).join("");
  const key = ORDER[k];
  let out = "";
  let i = 0;
  while (i < segs.length) {
    const v = segs[i][key] || false;
    let j = i;
    while (j < segs.length && (segs[j][key] || false) === v) j++;
    const run = segs.slice(i, j);
    if (!v) out += group(run, k + 1);
    else if (key === "code") {
      const t = run.map((s) => s.raw || s.text).join("");
      out += wrapWs(t, (x) => codeSpan(x));
    } else {
      const inner = group(run, k + 1);
      out += wrapWs(inner, (x) => {
        if (key === "href") return `[${x}](${linkUrl(v)})`;
        if (key === "b") return `**${x}**`;
        if (key === "i") return `*${x}*`;
        if (key === "s") return `~~${x}~~`;
        if (key === "u") return `<u>${x}</u>`;
        if (key === "sup") return `<sup>${x}</sup>`;
        if (key === "sub") return `<sub>${x}</sub>`;
        return x;
      });
    }
    i = j;
  }
  return out;
}
function wrapWs(t, fn) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(t);
  if (!m[2]) return t;
  return m[1] + fn(m[2]) + m[3];
}
export function codeSpan(t) {
  const runs = t.match(/`+/g);
  const n = runs ? Math.max(...runs.map((r) => r.length)) + 1 : 1;
  const f = "`".repeat(n);
  const pad = t.startsWith("`") || t.endsWith("`") ? " " : "";
  return f + pad + t + pad + f;
}
export function linkUrl(u) {
  u = String(u).trim();
  if (/[\s()<>]/.test(u)) return `<${u.replace(/[<>]/g, encodeURIComponent)}>`;
  return u;
}

// ---------- tables ----------
// grid: array of rows; each row an array of cell objects { text (markdown), colspan, rowspan, header, block }
// or plain strings. Spanned positions are filled with the origin cell's text (Docling style).
export function normalizeGrid(rows) {
  const grid = [];
  rows.forEach((row, r) => {
    grid[r] ||= [];
    let c = 0;
    for (const cell0 of row) {
      const cell = typeof cell0 === "object" && cell0 ? cell0 : { text: cell0 == null ? "" : String(cell0) };
      while (grid[r][c]) c++;
      const cs = Math.max(1, cell.colspan || 1), rs = Math.max(1, cell.rowspan || 1);
      for (let dr = 0; dr < rs; dr++) {
        grid[r + dr] ||= [];
        for (let dc = 0; dc < cs; dc++) grid[r + dr][c + dc] = dr || dc ? { span: cell } : cell;
      }
      c += cs;
    }
  });
  const width = Math.max(0, ...grid.map((r) => r.length));
  for (const row of grid) for (let c = 0; c < width; c++) row[c] ||= { text: "" };
  return grid;
}

export function renderTable(rows, { header = true, forceHtml = false } = {}) {
  let grid = normalizeGrid(rows);
  // drop fully empty trailing columns/rows
  const empty = (c) => !(c.span ? c.span.text : c.text)?.trim();
  while (grid.length && grid[grid.length - 1].every(empty)) grid.pop();
  if (!grid.length) return "";
  let width = grid[0].length;
  while (width > 0 && grid.every((r) => empty(r[width - 1]))) width--;
  grid = grid.map((r) => r.slice(0, width));
  if (!width) return "";
  const needHtml = forceHtml || grid.some((r) => r.some((c) => !c.span && c.block));
  if (needHtml) return renderHtmlTable(grid, header);
  const cellText = (c) => {
    const t = (c.span ? c.span.text : c.text) || "";
    return t.replace(/\\\n/g, "\n").replace(/\n+/g, "<br>").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  };
  const body = grid.map((r) => r.map(cellText));
  let head;
  if (header) head = body.shift();
  else head = Array(width).fill("");
  const widths = head.map((_, c) => Math.min(60, Math.max(3, strWidth(head[c]), ...body.map((r) => strWidth(r[c])))));
  const line = (cells) => "| " + cells.map((t, c) => t + " ".repeat(Math.max(0, widths[c] - strWidth(t)))).join(" | ") + " |";
  const out = [line(head), "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|", ...body.map(line)];
  return out.join("\n");
}
function strWidth(s) {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}
let _md = null;
function renderHtmlTable(grid, header) {
  const lines = ["<table>"];
  grid.forEach((row, r) => {
    const cells = [];
    row.forEach((c) => {
      if (c.span) return;
      const tag = (header && r === 0) || c.header ? "th" : "td";
      let a = "";
      if ((c.colspan || 1) > 1) a += ` colspan="${c.colspan}"`;
      if ((c.rowspan || 1) > 1) a += ` rowspan="${c.rowspan}"`;
      cells.push(`<${tag}${a}>${c.html != null ? c.html : mdToHtml(c.text || "")}</${tag}>`);
    });
    lines.push("<tr>" + cells.join("") + "</tr>");
  });
  lines.push("</table>");
  return lines.join("\n");
}
// tiny markdown -> html for table cells (paragraphs, lists, inline marks)
export function mdToHtml(md) {
  if (!md.trim()) return "";
  const inline = (t) => {
    let s = t.replace(/&(?![a-z#0-9]+;)/gi, "&amp;");
    s = s.replace(/<(?!\/?(u|sup|sub|br)\b)/g, "&lt;");
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1">')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      .replace(/\\([\\*_`[\]$|#>+-])/g, "$1");
    return s;
  };
  const out = [];
  const stack = [];
  const closeTo = (lvl) => { while (stack.length > lvl) out.push(`</li></${stack.pop()}>`); };
  for (const block of md.split(/\n{2,}/)) {
    const lines = block.split("\n");
    const isList = lines.every((l) => /^\s*([-*+]|\d+[.)])\s/.test(l) || /^\s{2,}\S/.test(l));
    if (isList) {
      for (const l of lines) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
        if (!m) { out.push(" " + inline(l.trim())); continue; }
        const lvl = Math.floor(m[1].length / 2) + 1;
        const tag = /\d/.test(m[2]) ? "ol" : "ul";
        if (stack.length < lvl) { while (stack.length < lvl) { stack.push(tag); out.push(`<${tag}><li>`); } }
        else { closeTo(lvl); out.push("</li><li>"); }
        out.push(inline(m[3]));
      }
      closeTo(0);
    } else if (lines.length === 1 && lines[0].startsWith("<")) out.push(lines[0]);
    else out.push(`<p>${lines.map(inline).join("<br>")}</p>`);
  }
  return out.join("").replace(/<p>([\s\S]*)<\/p>$/, (m, x) => (out.length === 1 ? x : m));
}

// ---------- block assembly ----------
// blocks: strings (separated by blank lines), or { md, list: true } list lines that join with single newlines
export function joinBlocks(blocks) {
  let out = "";
  let prevList = false;
  let prevKind = null;
  for (const b of blocks) {
    if (b == null) continue;
    const isList = typeof b === "object" && b.list;
    const md = (typeof b === "object" ? b.md : b);
    if (md == null || !String(md).trim()) continue;
    const kind = isList ? (/^\d+[.)]\s/.test(md) ? "ol" : /^[-*+]\s/.test(md) ? "ul" : "cont") : null;
    // a top-level item of a different list type starts a new list (keep a blank line between)
    const sameList = isList && prevList && (kind === "cont" || !prevKind || kind === prevKind);
    if (out) out += sameList ? "\n" : "\n\n";
    out += md;
    prevList = isList;
    if (kind && kind !== "cont") prevKind = kind;
    if (!isList) prevKind = null;
  }
  return out;
}

export function cleanMarkdown(md) {
  // protect fenced code blocks from cleanup
  const fences = [];
  md = md.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, (m) => { fences.push(m); return `\u0000F${fences.length - 1}\u0000`; });
  md = md
    .replace(/[ \t]+$/gm, "")
    .replace(/ /g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "");
  md = md.replace(/\u0000F(\d+)\u0000/g, (_, i) => fences[+i].replace(/[ \t]+$/gm, ""));
  return md.trimEnd() + "\n";
}

export function fence(code, lang = "") {
  const runs = code.match(/^`{3,}/gm);
  const n = runs ? Math.max(...runs.map((r) => r.length)) + 1 : 3;
  const f = "`".repeat(n);
  return `${f}${lang}\n${code.replace(/\n+$/, "")}\n${f}`;
}

export function indent(md, n) {
  const pad = " ".repeat(n);
  return md.split("\n").map((l) => (l ? pad + l : l)).join("\n");
}

export function baseName(name) { return (name || "document").split(/[\\/]/).pop(); }
