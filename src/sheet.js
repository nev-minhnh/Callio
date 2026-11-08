// Spreadsheets: a canvas grid over the GridCraft engine (callio-office). Only the cells on
// screen are fetched; formulas, recalculation, undo, formatting and saving happen in the engine,
// so .xlsx files keep everything (styles, charts, pivots…) when saved back.
import { office } from "./office.js";
import { api, call } from "./api.js";
import { registerUndo } from "./undo.js";
import { Ribbon, loadIcons, autoTabs, iconMatcher, tellBox } from "./ribbon.js";
import { toast, status, ask, basename, dirname, settings, updateSettings } from "./main.js";

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const HEAD_W = 46, HEAD_H = 22, DPR = () => window.devicePixelRatio || 1;
const colName = (c) => { let s = ""; c += 1; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
const a1 = (r, c) => `${colName(c)}${r + 1}`;
const rangeA1 = (s) => (s.r0 === s.r1 && s.c0 === s.c1 ? a1(s.r0, s.c0) : `${a1(Math.min(s.r0, s.r1), Math.min(s.c0, s.c1))}:${a1(Math.max(s.r0, s.r1), Math.max(s.c0, s.c1))}`);
const parseA1 = (t) => { const m = /^\s*\$?([A-Za-z]{1,3})\$?(\d{1,7})\s*$/.exec(t || ""); if (!m) return null; let c = 0; for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64); return { r: +m[2] - 1, c: c - 1 }; };

/** Line sizes with defaults and exceptions; positions by prefix sums over the exceptions. */
class Axis {
  constructor(def, list) {
    this.def = def;
    this.ex = new Map(); // index → size (0 = hidden)
    for (const [i, size, hidden] of list || []) this.ex.set(i, hidden ? 0 : size ?? def);
    this.keys = [...this.ex.keys()].sort((a, b) => a - b);
    this.pre = []; let acc = 0;
    for (const k of this.keys) { acc += this.ex.get(k) - def; this.pre.push(acc); }
  }
  size(i) { return this.ex.has(i) ? this.ex.get(i) : this.def; }
  /** start of line i */
  pos(i) {
    let lo = 0, hi = this.keys.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.keys[m] < i) lo = m + 1; else hi = m; }
    return i * this.def + (lo ? this.pre[lo - 1] : 0);
  }
  /** the line at offset x */
  at(x) {
    let lo = 0, hi = 1 << 21;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.pos(m) <= x) lo = m; else hi = m - 1; }
    return lo;
  }
}

let host = null;
let S = null; // the shown sheet: { t, book, si, meta, cols, rows, cells: Map, styles, sel, ... }

export function sheetHost() {
  if (host) return host;
  host = document.createElement("div");
  host.id = "sheet-view";
  host.hidden = true;
  host.innerHTML = `
    <div class="sh-rb"></div>
    <div class="sh-fbar"><input class="sh-name" spellcheck="false" title="Cell (type a reference to go there)"><span class="sh-fx">ƒx</span><input class="sh-formula" spellcheck="false" placeholder="Value or =formula"></div>
    <div class="sh-main">
      <canvas class="sh-canvas"></canvas>
      <div class="sh-scroll" tabindex="0"><div class="sh-space"><div class="sh-objects"></div></div></div>
      <textarea class="sh-editor" hidden spellcheck="false"></textarea>
      <div class="sh-tip" hidden></div>
    </div>
    <div class="sh-tabs"></div>
    <div class="sh-status"><span class="sh-stat"></span></div>`;
  wire();
  return host;
}

// ---------------- open / show ----------------
export async function openSheet(t) {
  sheetHost();
  if (!t.sheetId) {
    status(`Opening ${t.name}…`);
    await buildRibbon();
    const r = await office("sheet.open", { path: t.path });
    t.sheetId = r.id;
    t.book = r.book;
    if (r.warnings?.length) console.info("sheet warnings", r.warnings);
    status(`${t.name}`, "ok");
    loadHistory(t);
  }
  await showSheet(t, t.sheetIndex ?? t.book.active ?? 0);
}

async function showSheet(t, si) {
  t.sheetIndex = si;
  let meta;
  try { meta = await office("sheet.meta", { id: t.sheetId, sheet: si }); }
  catch (e) { if (/closed/.test(e.message)) { t.sheetId = null; return openSheet(t); } throw e; }
  const zoom = t.zoom || 1;
  S = {
    t, si, meta, zoom,
    cols: new Axis(meta.defaultW, meta.cols), rows: new Axis(meta.defaultH, meta.rows),
    cells: new Map(), styles: [], have: null, sel: t.sel?.[si] || { r0: 0, c0: 0, r1: 0, c1: 0, ar: 0, ac: 0 },
    pics: new Map(), editing: false,
  };
  S.freeze = meta.freeze ? { r: meta.freeze[0], c: meta.freeze[1] } : null;
  const used = meta.used || [0, 0];
  S.nr = Math.max(used[0] + 200, 100);
  S.nc = Math.max(used[1] + 20, 26);
  renderTabs();
  layout();
  placeObjects();
  await fetchVisible(true);
  showCell();
}

export function hideSheet() { if (host) host.hidden = true; }
export function sheetActive() { return !!S && host && !host.hidden; }

function renderTabs() {
  const box = $(".sh-tabs", host);
  box.innerHTML = "";
  (S.t.book.sheets || []).forEach((s, i) => {
    if (s.hidden) return;
    const b = document.createElement("button");
    b.className = "sh-tab" + (i === S.si ? " on" : "");
    b.textContent = s.name;
    if (s.tab) b.style.boxShadow = `inset 0 -3px 0 ${s.tab}`;
    b.onclick = () => { if (i !== S.si) { saveSel(); office("sheet.exec", { id: S.t.sheetId, cmd: "sheet.activate", params: { sheet: i } }).catch(() => {}); showSheet(S.t, i); } };
    box.appendChild(b);
  });
}
const saveSel = () => { (S.t.sel ||= {})[S.si] = S.sel; };

// ---------------- geometry ----------------
const z = () => S.zoom;
const X = (c) => S.cols.pos(c) * z();
const Y = (r) => S.rows.pos(r) * z();
const W = (c) => S.cols.size(c) * z();
const H = (r) => S.rows.size(r) * z();
function frozenSize() {
  return { fw: S.freeze?.c ? X(S.freeze.c) : 0, fh: S.freeze?.r ? Y(S.freeze.r) : 0 };
}

function layout() {
  const main = $(".sh-main", host), sc = $(".sh-scroll", host), sp = $(".sh-space", host);
  const { fw, fh } = frozenSize();
  sp.style.width = HEAD_W + X(S.nc) + 40 + "px";
  sp.style.height = HEAD_H + Y(S.nr) + 40 + "px";
  const cv = $(".sh-canvas", host), r = main.getBoundingClientRect();
  const d = DPR();
  cv.width = Math.max(1, Math.round(sc.clientWidth * d));
  cv.height = Math.max(1, Math.round(sc.clientHeight * d));
  cv.style.width = sc.clientWidth + "px";
  cv.style.height = sc.clientHeight + "px";
  $(".sh-zoom", host).textContent = Math.round(S.zoom * 100) + "%";
  void r; void fw; void fh;
}

/** Visible rows/cols (scrolled part), given the scroll offset. */
function visible() {
  const sc = $(".sh-scroll", host);
  const { fw, fh } = frozenSize();
  const x0 = sc.scrollLeft + fw, y0 = sc.scrollTop + fh;
  const w = sc.clientWidth - HEAD_W - fw, h = sc.clientHeight - HEAD_H - fh;
  const c0 = S.cols.at(x0 / z()), r0 = S.rows.at(y0 / z());
  const c1 = S.cols.at((x0 + w) / z()) + 1, r1 = S.rows.at((y0 + h) / z()) + 1;
  return { r0, r1, c0, c1, x0, y0 };
}

// ---------------- data ----------------
let fetching = null, again = false;
async function fetchVisible(force = false) {
  if (!S) return;
  const v = visible();
  const want = { r0: Math.max(0, v.r0 - 30), r1: v.r1 + 60, c0: Math.max(0, v.c0 - 8), c1: v.c1 + 16 };
  const have = S.have;
  const inside = have && want.r0 >= have.r0 && want.r1 <= have.r1 && want.c0 >= have.c0 && want.c1 <= have.c1 && v.r0 >= have.r0 && v.c0 >= have.c0;
  if (inside && !force) return draw();
  if (fetching) { again = true; return; }
  const range = { r0: Math.max(0, v.r0 - 60), r1: v.r1 + 120, c0: Math.max(0, v.c0 - 16), c1: v.c1 + 32 };
  const frozenRows = S.freeze?.r || 0, frozenCols = S.freeze?.c || 0;
  const s = S;
  fetching = (async () => {
    const parts = [office("sheet.view", { id: s.t.sheetId, sheet: s.si, ...range })];
    // the frozen rows and columns are always on screen
    if (frozenRows) parts.push(office("sheet.view", { id: s.t.sheetId, sheet: s.si, r0: 0, r1: frozenRows - 1, c0: range.c0, c1: range.c1 }));
    if (frozenCols) parts.push(office("sheet.view", { id: s.t.sheetId, sheet: s.si, r0: range.r0, r1: range.r1, c0: 0, c1: frozenCols - 1 }));
    if (frozenRows && frozenCols) parts.push(office("sheet.view", { id: s.t.sheetId, sheet: s.si, r0: 0, r1: frozenRows - 1, c0: 0, c1: frozenCols - 1 }));
    const res = await Promise.all(parts);
    if (S !== s) return;
    const cells = new Map(), styles = [];
    for (const r of res) {
      const off = styles.length;
      styles.push(...r.styles);
      for (const c of r.cells) cells.set(`${c[0]},${c[1]}`, { r: c[0], c: c[1], text: c[2], st: styles[off + c[3]], x: c[4] || {} });
    }
    s.cells = cells;
    s.have = range;
  })().catch((e) => toast(`Couldn't read the sheet: ${e.message}`, "err")).finally(() => { fetching = null; if (again) { again = false; fetchVisible(true); } });
  await fetching;
  draw();
}

// ---------------- drawing ----------------
const fontOf = (st, zz) => `${st?.i ? "italic " : ""}${st?.b ? "bold " : ""}${Math.max(6, ((st?.s || 11) * 96) / 72 * zz).toFixed(1)}px "${(st?.f || "Calibri").replace(/"/g, "")}", Calibri, Carlito, "Segoe UI", Arial, sans-serif`;
let raf = 0;
function draw() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(paint);
}

function paint() {
  if (!S || host.hidden) return;
  const cv = $(".sh-canvas", host), g = cv.getContext("2d"), d = DPR();
  const sc = $(".sh-scroll", host);
  const W0 = sc.clientWidth, H0 = sc.clientHeight;
  g.setTransform(d, 0, 0, d, 0, 0);
  const dark = document.documentElement.dataset.theme === "dark" || (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  // cells are always paper, as in Excel: a workbook's colours (white fills, "automatic" black
  // text, theme colours) are made for a white sheet and turn unreadable on a dark one
  const pal = dark
    ? { bg: "#ffffff", grid: "#dadce0", head: "#26292e", headTx: "#a9adb5", headSel: "#2f4a3c", txt: "#000000", sel: "#2fa36b" }
    : { bg: "#ffffff", grid: "#dadce0", head: "#f3f4f6", headTx: "#5b6068", headSel: "#d8efe2", txt: "#000000", sel: "#1e7d4f" };
  g.fillStyle = pal.bg;
  g.fillRect(0, 0, W0, H0);
  const { fw, fh } = frozenSize();
  const v = visible();
  // four panes: frozen corner, frozen rows, frozen cols, scrolled body
  const panes = [];
  const bodyX = HEAD_W + fw, bodyY = HEAD_H + fh;
  panes.push({ r0: v.r0, r1: v.r1, c0: v.c0, c1: v.c1, ox: bodyX - (v.x0 - fw) - fw, oy: bodyY - (v.y0 - fh) - fh, clip: [bodyX, bodyY, W0 - bodyX, H0 - bodyY] });
  if (S.freeze?.r) panes.push({ r0: 0, r1: S.freeze.r - 1, c0: v.c0, c1: v.c1, ox: bodyX - (v.x0 - fw) - fw, oy: HEAD_H, clip: [bodyX, HEAD_H, W0 - bodyX, fh] });
  if (S.freeze?.c) panes.push({ r0: v.r0, r1: v.r1, c0: 0, c1: S.freeze.c - 1, ox: HEAD_W, oy: bodyY - (v.y0 - fh) - fh, clip: [HEAD_W, bodyY, fw, H0 - bodyY] });
  if (S.freeze?.r && S.freeze?.c) panes.push({ r0: 0, r1: S.freeze.r - 1, c0: 0, c1: S.freeze.c - 1, ox: HEAD_W, oy: HEAD_H, clip: [HEAD_W, HEAD_H, fw, fh] });
  for (const p of panes) paintPane(g, p, pal);
  // headers
  g.font = `${11 * Math.min(1.2, Math.max(0.8, S.zoom))}px "Segoe UI", system-ui, sans-serif`;
  g.textBaseline = "middle";
  const sel = norm(S.sel);
  const headCols = (c0, c1, ox, clipX, clipW) => {
    g.save(); g.beginPath(); g.rect(clipX, 0, clipW, HEAD_H); g.clip();
    for (let c = c0; c <= c1; c++) {
      const x = ox + X(c), w = W(c);
      if (w <= 0) continue;
      const on = c >= sel.c0 && c <= sel.c1;
      g.fillStyle = on ? pal.headSel : pal.head; g.fillRect(x, 0, w, HEAD_H);
      g.fillStyle = pal.grid; g.fillRect(x + w - 1, 0, 1, HEAD_H);
      g.fillStyle = on ? pal.sel : pal.headTx; g.textAlign = "center"; g.fillText(colName(c), x + w / 2, HEAD_H / 2 + 1);
    }
    g.restore();
  };
  const headRows = (r0, r1, oy, clipY, clipH) => {
    g.save(); g.beginPath(); g.rect(0, clipY, HEAD_W, clipH); g.clip();
    for (let r = r0; r <= r1; r++) {
      const y = oy + Y(r), h = H(r);
      if (h <= 0) continue;
      const on = r >= sel.r0 && r <= sel.r1;
      g.fillStyle = on ? pal.headSel : pal.head; g.fillRect(0, y, HEAD_W, h);
      g.fillStyle = pal.grid; g.fillRect(0, y + h - 1, HEAD_W, 1);
      g.fillStyle = on ? pal.sel : pal.headTx; g.textAlign = "center"; g.fillText(String(r + 1), HEAD_W / 2, y + h / 2 + 1);
    }
    g.restore();
  };
  headCols(v.c0, v.c1, panes[0].ox, bodyX, W0 - bodyX);
  headRows(v.r0, v.r1, panes[0].oy, bodyY, H0 - bodyY);
  if (S.freeze?.c) headCols(0, S.freeze.c - 1, HEAD_W, HEAD_W, fw);
  if (S.freeze?.r) headRows(0, S.freeze.r - 1, HEAD_H, HEAD_H, fh);
  g.fillStyle = pal.head; g.fillRect(0, 0, HEAD_W, HEAD_H);
  g.fillStyle = pal.grid; g.fillRect(HEAD_W - 1, 0, 1, H0); g.fillRect(0, HEAD_H - 1, W0, 1);
  if (fw) { g.fillStyle = "#9aa0a6"; g.fillRect(HEAD_W + fw - 1, HEAD_H, 1, H0); }
  if (fh) { g.fillStyle = "#9aa0a6"; g.fillRect(HEAD_W, HEAD_H + fh - 1, W0, 1); }
  // where the overlay objects go
  const obj = $(".sh-objects", host);
  obj.style.transform = `translate(${HEAD_W}px, ${HEAD_H}px)`;
}

function norm(s) { return { r0: Math.min(s.r0, s.r1), r1: Math.max(s.r0, s.r1), c0: Math.min(s.c0, s.c1), c1: Math.max(s.c0, s.c1) }; }

function mergeAt(r, c) {
  for (const m of S.meta.merges) if (r >= m[0] && r <= m[2] && c >= m[1] && c <= m[3]) return m;
  return null;
}

function paintPane(g, p, pal) {
  const [cx, cy, cw, ch] = p.clip;
  if (cw <= 0 || ch <= 0) return;
  g.save();
  g.beginPath(); g.rect(cx, cy, cw, ch); g.clip();
  const zz = z();
  const cellRect = (r, c) => {
    const m = mergeAt(r, c);
    if (m) return { x: p.ox + X(m[1]), y: p.oy + Y(m[0]), w: X(m[3] + 1) - X(m[1]), h: Y(m[2] + 1) - Y(m[0]), m };
    return { x: p.ox + X(c), y: p.oy + Y(r), w: W(c), h: H(r), m: null };
  };
  // gridlines
  if (S.meta.gridlines !== false) {
    g.fillStyle = pal.grid;
    for (let c = p.c0; c <= p.c1 + 1; c++) { const x = p.ox + X(c) - 1; g.fillRect(x, cy, 1, ch); }
    for (let r = p.r0; r <= p.r1 + 1; r++) { const y = p.oy + Y(r) - 1; g.fillRect(cx, y, cw, 1); }
  }
  // merged areas: blank out their inner gridlines
  for (const m of S.meta.merges) {
    if (m[2] < p.r0 || m[0] > p.r1 || m[3] < p.c0 || m[1] > p.c1) continue;
    const x = p.ox + X(m[1]), y = p.oy + Y(m[0]);
    g.fillStyle = pal.bg; g.fillRect(x, y, X(m[3] + 1) - X(m[1]) - 1, Y(m[2] + 1) - Y(m[0]) - 1);
  }
  const list = [];
  for (const cell of S.cells.values()) {
    if (cell.r < p.r0 || cell.r > p.r1 || cell.c < p.c0 || cell.c > p.c1) {
      // a merged area whose anchor is above/left of the pane still shows
      const m = mergeAt(cell.r, cell.c);
      if (!m || m[0] !== cell.r || m[1] !== cell.c || m[2] < p.r0 || m[3] < p.c0) continue;
    }
    list.push(cell);
  }
  // fills
  for (const cell of list) {
    const st = cell.st; const rc = cellRect(cell.r, cell.c);
    if (rc.m && (rc.m[0] !== cell.r || rc.m[1] !== cell.c)) continue;
    if (st?.bg) { g.fillStyle = st.bg; g.fillRect(rc.x, rc.y, rc.w - 1, rc.h - 1); }
    if (cell.x.bar) {
      const [f, col, grad] = cell.x.bar;
      const bw = Math.max(0, (rc.w - 4) * f);
      if (grad) { const gr = g.createLinearGradient(rc.x, 0, rc.x + bw, 0); gr.addColorStop(0, col); gr.addColorStop(1, col + "22"); g.fillStyle = gr; } else g.fillStyle = col;
      g.fillRect(rc.x + 2, rc.y + 2, bw, rc.h - 5);
    }
  }
  // text
  for (const cell of list) {
    const st = cell.st || {};
    const rc = cellRect(cell.r, cell.c);
    if (rc.m && (rc.m[0] !== cell.r || rc.m[1] !== cell.c)) continue;
    if (cell.x.pic) { drawPic(g, cell.x.pic, rc); }
    if (cell.x.icon) drawIcon(g, cell.x.icon, rc);
    let text = cell.text;
    if (!text) continue;
    g.font = fontOf(st, zz);
    g.fillStyle = st.c || (cell.x.link ? "#1a5fb4" : pal.txt);
    const pad = 3 * zz + (st.in || 0) * 9 * zz;
    let h = st.h || "l";
    if (h === "j" || h === "f") h = "l";
    const fsz = ((st.s || 11) * 96) / 72 * zz;
    const lineH = fsz * 1.22;
    let lines = [text];
    let tw = g.measureText(text).width;
    let clipW = rc.w;
    let clipX = rc.x;
    if (st.w) {
      lines = wrapLines(g, text, rc.w - pad * 2);
    } else if (tw > rc.w - pad * 2) {
      if (cell.x.num) {
        text = "#".repeat(Math.max(1, Math.floor((rc.w - pad * 2) / g.measureText("#").width)));
        lines = [text]; tw = g.measureText(text).width;
      } else if (!rc.m) {
        // spill over empty neighbours (left-aligned to the right, right-aligned to the left)
        if (h === "l" || h === "c") { let c = cell.c + 1, ex = rc.x + rc.w; while (ex - rc.x < tw + pad * 2 && c <= p.c1 + 50 && !S.cells.get(`${cell.r},${c}`)?.text && !mergeAt(cell.r, c)) { ex += W(c); c++; } clipW = ex - rc.x; }
        if (h === "r" || h === "c") { let c = cell.c - 1, sx = rc.x; while (rc.x + rc.w - sx < tw + pad * 2 && c >= 0 && !S.cells.get(`${cell.r},${c}`)?.text && !mergeAt(cell.r, c)) { sx -= W(c); c--; } clipW += rc.x - sx; clipX = sx; }
      }
    }
    g.save();
    g.beginPath(); g.rect(clipX, rc.y, clipW - 1, rc.h - 1); g.clip();
    const total = lines.length * lineH;
    let y = st.v === "t" ? rc.y + 2 + lineH / 2 : st.v === "m" ? rc.y + rc.h / 2 - total / 2 + lineH / 2 : rc.y + rc.h - 3 - total + lineH / 2;
    g.textBaseline = "middle";
    for (const ln of lines) {
      const lw = g.measureText(ln).width;
      let x = h === "r" ? rc.x + rc.w - pad - lw : h === "c" ? rc.x + rc.w / 2 - lw / 2 : rc.x + pad;
      g.textAlign = "left";
      g.fillText(ln, x, y + 0.5);
      if (st.u || cell.x.link) g.fillRect(x, y + fsz * 0.42, lw, Math.max(1, zz));
      if (st.st) g.fillRect(x, y, lw, Math.max(1, zz));
      y += lineH;
    }
    g.restore();
  }
  // borders
  for (const cell of list) {
    const st = cell.st; if (!st) continue;
    const rc = cellRect(cell.r, cell.c);
    const line = (b, x1, y1, x2, y2) => {
      if (!b) return;
      const [w, kind, col] = b;
      g.strokeStyle = col; g.lineWidth = Math.max(1, w * Math.min(1, zz));
      g.setLineDash(kind === "dash" ? [4, 2] : kind === "dot" ? [1, 2] : []);
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      if (kind === "double") { g.beginPath(); if (y1 === y2) { g.moveTo(x1, y1 - 2); g.lineTo(x2, y2 - 2); } else { g.moveTo(x1 - 2, y1); g.lineTo(x2 - 2, y2); } g.stroke(); }
    };
    const x0 = rc.x - 0.5, y0 = rc.y - 0.5, x1 = rc.x + rc.w - 0.5, y1 = rc.y + rc.h - 0.5;
    line(st.bt, x0, y0, x1, y0); line(st.bb, x0, y1, x1, y1); line(st.bl, x0, y0, x0, y1); line(st.br, x1, y0, x1, y1);
    if (cell.x.note) { g.fillStyle = "#d93025"; g.beginPath(); g.moveTo(x1 - 6, y0); g.lineTo(x1, y0); g.lineTo(x1, y0 + 6); g.fill(); }
  }
  g.setLineDash([]);
  // selection
  const s = norm(S.sel);
  if (!(s.r1 < p.r0 || s.r0 > p.r1 || s.c1 < p.c0 || s.c0 > p.c1) || true) {
    const x = p.ox + X(s.c0), y = p.oy + Y(s.r0), w = X(s.c1 + 1) - X(s.c0), h = Y(s.r1 + 1) - Y(s.r0);
    g.fillStyle = "rgba(33, 150, 83, 0.10)";
    if (w > W(s.c0) || h > H(s.r0)) g.fillRect(x, y, w, h);
    const ac = cellRect(S.sel.ar ?? s.r0, S.sel.ac ?? s.c0);
    g.fillStyle = "#ffffff00";
    g.strokeStyle = "#1e7d4f"; g.lineWidth = 2;
    g.strokeRect(x - 1, y - 1, w + 1, h + 1);
    g.lineWidth = 1; g.strokeRect(ac.x, ac.y, ac.w - 1, ac.h - 1);
    g.fillStyle = "#1e7d4f"; g.fillRect(x + w - 4, y + h - 4, 6, 6);
  }
  g.restore();
}

function wrapLines(g, text, width) {
  const out = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      const t = line + word;
      if (g.measureText(t).width > width && line.trim()) { out.push(line.trimEnd()); line = word.trimStart(); }
      else line = t;
    }
    out.push(line);
  }
  return out;
}

const imgCache = new Map();
function drawPic(g, src, rc) {
  let im = imgCache.get(src);
  if (!im) { im = new Image(); im.onload = () => draw(); im.src = src; imgCache.set(src, im); if (imgCache.size > 300) imgCache.delete(imgCache.keys().next().value); }
  if (!im.complete || !im.naturalWidth) return;
  const s = Math.min((rc.w - 4) / im.naturalWidth, (rc.h - 4) / im.naturalHeight);
  const w = im.naturalWidth * s, h = im.naturalHeight * s;
  g.drawImage(im, rc.x + (rc.w - w) / 2, rc.y + (rc.h - h) / 2, w, h);
}
function drawIcon(g, [set, i], rc) {
  const n = /5/.test(set) ? 5 : /4/.test(set) ? 4 : 3;
  const frac = n > 1 ? i / (n - 1) : 1;
  const col = frac >= 0.66 ? "#2e9e5b" : frac >= 0.33 ? "#e6a700" : "#d93025";
  const cx = rc.x + 9, cy = rc.y + rc.h / 2;
  g.fillStyle = col; g.beginPath();
  if (/Arrow/i.test(set)) { const up = frac >= 0.66, down = frac < 0.33; if (up) { g.moveTo(cx, cy - 6); g.lineTo(cx + 5, cy + 1); g.lineTo(cx - 5, cy + 1); } else if (down) { g.moveTo(cx, cy + 6); g.lineTo(cx + 5, cy - 1); g.lineTo(cx - 5, cy - 1); } else { g.moveTo(cx + 6, cy); g.lineTo(cx - 1, cy - 5); g.lineTo(cx - 1, cy + 5); } }
  else g.arc(cx, cy, 5, 0, Math.PI * 2);
  g.fill();
}

// ---------------- pictures and charts (floating) ----------------
function placeObjects() {
  const box = $(".sh-objects", host);
  box.innerHTML = "";
  const put = (o, inner) => {
    const el = document.createElement("div");
    el.className = "sh-obj";
    el.style.left = (S.cols.pos(o.col) + o.dx) * z() + "px";
    el.style.top = (S.rows.pos(o.row) + o.dy) * z() + "px";
    el.style.width = o.w * z() + "px";
    el.style.height = o.h * z() + "px";
    el.innerHTML = inner;
    box.appendChild(el);
  };
  for (const p of S.meta.pictures || []) put(p, `<img src="${p.src}" alt="${esc(p.alt)}" draggable="false">`);
  for (const c of S.meta.charts || []) put(c, c.svg.replace("<svg ", `<svg preserveAspectRatio="none" `).replace(/width="[^"]*" height="[^"]*"/, `width="100%" height="100%"`));
}

// ---------------- selection, formula bar, editing ----------------
function cellAtPoint(px, py) {
  const sc = $(".sh-scroll", host), r = sc.getBoundingClientRect();
  const x = px - r.left, y = py - r.top;
  const { fw, fh } = frozenSize();
  const v = visible();
  let cx, cy;
  if (x < HEAD_W) cx = -1; else if (S.freeze?.c && x < HEAD_W + fw) cx = S.cols.at((x - HEAD_W) / z()); else cx = S.cols.at((x - HEAD_W - fw + v.x0) / z());
  if (y < HEAD_H) cy = -1; else if (S.freeze?.r && y < HEAD_H + fh) cy = S.rows.at((y - HEAD_H) / z()); else cy = S.rows.at((y - HEAD_H - fh + v.y0) / z());
  return { r: cy, c: cx };
}

async function showCell() {
  if (!S) return;
  setTimeout(() => rb?.update(), 0);
  const s = S.sel;
  $(".sh-name", host).value = rangeA1(s).includes(":") ? rangeA1(s) : a1(s.ar ?? s.r0, s.ac ?? s.c0);
  try {
    const info = await office("sheet.cell", { id: S.t.sheetId, sheet: S.si, r: s.ar ?? s.r0, c: s.ac ?? s.c0 });
    if (S.sel !== s && !(S.sel.ar === s.ar && S.sel.ac === s.ac)) return;
    if (!S.editing) $(".sh-formula", host).value = info.edit;
    const tip = $(".sh-tip", host);
    if (info.comment || info.link) {
      tip.textContent = [info.comment, info.link && `🔗 ${info.link} (Ctrl+click to open)`].filter(Boolean).join("\n");
      tip.hidden = false;
      positionTip();
    } else tip.hidden = true;
    S.cellInfo = info;
  } catch { /* closed */ }
  stats();
}
function positionTip() {
  const s = norm(S.sel), sc = $(".sh-scroll", host);
  const v = visible(); const { fw, fh } = frozenSize();
  const x = HEAD_W + fw + X(s.c1 + 1) - v.x0 + 6, y = HEAD_H + fh + Y(s.r0) - v.y0;
  const tip = $(".sh-tip", host);
  tip.style.left = Math.min(sc.clientWidth - 260, x) + "px";
  tip.style.top = Math.max(HEAD_H, y) + "px";
}
function stats() {
  const s = norm(S.sel);
  let n = 0, sum = 0, cnt = 0;
  for (const c of S.cells.values()) {
    if (c.r < s.r0 || c.r > s.r1 || c.c < s.c0 || c.c > s.c1 || !c.text) continue;
    cnt++;
    if (c.x.num) { const v = parseFloat(c.text.replace(/[^0-9.\-eE]/g, "")); if (Number.isFinite(v)) { n++; sum += v; } }
  }
  $(".sh-stat", host).textContent = (s.r0 !== s.r1 || s.c0 !== s.c1) && cnt ? `Count ${cnt}${n ? ` · Sum ${+sum.toFixed(6)} · Average ${+(sum / n).toFixed(6)}` : ""}` : "";
}

function select(r, c, extend = false) {
  r = Math.max(0, r); c = Math.max(0, c);
  if (extend) { S.sel = { ...S.sel, r1: r, c1: c }; }
  else {
    const m = mergeAt(r, c);
    S.sel = m ? { r0: m[0], c0: m[1], r1: m[2], c1: m[3], ar: m[0], ac: m[1] } : { r0: r, c0: c, r1: r, c1: c, ar: r, ac: c };
  }
  if (r >= S.nr - 20) { S.nr = r + 200; layout(); }
  if (c >= S.nc - 5) { S.nc = c + 26; layout(); }
  scrollIntoView(extend ? r : S.sel.ar, extend ? c : S.sel.ac);
  draw();
  showCell();
}
function scrollIntoView(r, c) {
  const sc = $(".sh-scroll", host); const { fw, fh } = frozenSize();
  const vw = sc.clientWidth - HEAD_W - fw, vh = sc.clientHeight - HEAD_H - fh;
  if (!(S.freeze?.c > c)) { const x = X(c) - fw; if (x < sc.scrollLeft) sc.scrollLeft = x; else if (x + W(c) > sc.scrollLeft + vw) sc.scrollLeft = x + W(c) - vw; }
  if (!(S.freeze?.r > r)) { const y = Y(r) - fh; if (y < sc.scrollTop) sc.scrollTop = y; else if (y + H(r) > sc.scrollTop + vh) sc.scrollTop = y + H(r) - vh; }
}

async function exec(cmd, params = {}, { refresh = true } = {}) {
  try {
    const r = await office("sheet.exec", { id: S.t.sheetId, cmd, params: { sheet: S.si, ...params } });
    if (refresh) await afterEdit();
    return r;
  } catch (e) { toast(e.message, "err", 6000); }
}
async function afterEdit() {
  markDirty(true);
  loadHistory(S.t);
  S.meta = await office("sheet.meta", { id: S.t.sheetId, sheet: S.si });
  S.cols = new Axis(S.meta.defaultW, S.meta.cols); S.rows = new Axis(S.meta.defaultH, S.meta.rows);
  S.freeze = S.meta.freeze ? { r: S.meta.freeze[0], c: S.meta.freeze[1] } : null;
  layout(); placeObjects();
  await fetchVisible(true);
  showCell();
}
function markDirty(d) {
  const t = S.t;
  t.dirty = d;
  window.dispatchEvent(new CustomEvent("callio-tab-dirty", { detail: t }));
}

function beginEdit(initial) {
  const ed = $(".sh-editor", host);
  const s = S.sel, r = s.ar ?? s.r0, c = s.ac ?? s.c0;
  const v = visible(); const { fw, fh } = frozenSize();
  const m = mergeAt(r, c);
  const x = (S.freeze?.c > c ? HEAD_W + X(c) : HEAD_W + fw + X(c) - v.x0);
  const y = (S.freeze?.r > r ? HEAD_H + Y(r) : HEAD_H + fh + Y(r) - v.y0);
  ed.style.left = x + "px"; ed.style.top = y + "px";
  ed.style.minWidth = (m ? X(m[3] + 1) - X(m[1]) : W(c)) + "px";
  ed.style.height = (m ? Y(m[2] + 1) - Y(m[0]) : H(c === undefined ? r : r)) + "px";
  ed.style.font = fontOf(S.cells.get(`${r},${c}`)?.st, z());
  ed.value = initial ?? $(".sh-formula", host).value;
  ed.hidden = false;
  S.editing = true;
  ed.focus();
  ed.setSelectionRange(ed.value.length, ed.value.length);
}
async function commit(value, move = [1, 0]) {
  const ed = $(".sh-editor", host);
  const s = S.sel, r = s.ar ?? s.r0, c = s.ac ?? s.c0;
  ed.hidden = true;
  S.editing = false;
  await exec("cell.set", { cell: a1(r, c), input: value });
  if (move) select(r + move[0], c + move[1]);
  $(".sh-scroll", host).focus({ preventScroll: true });
}
function cancelEdit() {
  $(".sh-editor", host).hidden = true;
  S.editing = false;
  showCell();
  $(".sh-scroll", host).focus({ preventScroll: true });
}

// ---------------- events ----------------
function wire() {
  const sc = $(".sh-scroll", host);
  sc.addEventListener("scroll", () => { draw(); fetchVisible(); if (!$(".sh-tip", host).hidden) positionTip(); }, { passive: true });
  new ResizeObserver(() => { if (S && !host.hidden) { layout(); draw(); fetchVisible(); } }).observe(host);
  let dragging = false;
  sc.addEventListener("mousedown", (e) => {
    if (!S || e.button !== 0) return;
    if (S.editing) commit($(".sh-editor", host).value, null);
    const { r, c } = cellAtPoint(e.clientX, e.clientY);
    sc.focus({ preventScroll: true });
    if (r < 0 && c < 0) { S.sel = { r0: 0, c0: 0, r1: S.nr, c1: S.nc, ar: 0, ac: 0 }; draw(); return; }
    if (r < 0) { S.sel = e.shiftKey ? { ...S.sel, c1: c, r0: 0, r1: 1048575 } : { r0: 0, r1: 1048575, c0: c, c1: c, ar: 0, ac: c }; draw(); showCell(); return; }
    if (c < 0) { S.sel = e.shiftKey ? { ...S.sel, r1: r, c0: 0, c1: 16383 } : { r0: r, r1: r, c0: 0, c1: 16383, ar: r, ac: 0 }; draw(); showCell(); return; }
    if ((e.ctrlKey || e.metaKey) && S.cells.get(`${r},${c}`)?.x.link) { select(r, c); setTimeout(() => S.cellInfo?.link && /^(https?|mailto):/i.test(S.cellInfo.link) && api.openUrl(S.cellInfo.link), 150); return; }
    select(r, c, e.shiftKey);
    dragging = true;
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging || !S) return;
    const { r, c } = cellAtPoint(e.clientX, e.clientY);
    if (r >= 0 && c >= 0 && (r !== S.sel.r1 || c !== S.sel.c1)) { S.sel = { ...S.sel, r1: r, c1: c }; draw(); }
  });
  window.addEventListener("mouseup", () => { if (dragging) { dragging = false; showCell(); } });
  sc.addEventListener("dblclick", (e) => { const { r, c } = cellAtPoint(e.clientX, e.clientY); if (r >= 0 && c >= 0) beginEdit(); });
  sc.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });
  sc.addEventListener("keydown", async (e) => {
    if (!S || S.editing) return;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    const s = S.sel, ar = s.ar ?? s.r0, ac = s.ac ?? s.c0;
    const mv = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[k];
    if (mv) {
      e.preventDefault();
      if (mod) { // jump to the edge of the data
        let r = e.shiftKey ? s.r1 : ar, c = e.shiftKey ? s.c1 : ac;
        const filled = (rr, cc) => !!S.cells.get(`${rr},${cc}`)?.text;
        const step = () => { r += mv[0]; c += mv[1]; };
        if (filled(r + mv[0], c + mv[1])) { while (r + mv[0] >= 0 && c + mv[1] >= 0 && filled(r + mv[0], c + mv[1])) step(); }
        else { step(); while (r >= 0 && c >= 0 && r < S.nr && c < S.nc && !filled(r, c)) step(); }
        return select(Math.max(0, r), Math.max(0, c), e.shiftKey);
      }
      if (e.shiftKey) return select(s.r1 + mv[0], s.c1 + mv[1], true);
      return select(ar + mv[0], ac + mv[1]);
    }
    if (k === "Enter") { e.preventDefault(); return select(ar + (e.shiftKey ? -1 : 1), ac); }
    if (k === "Tab") { e.preventDefault(); return select(ar, ac + (e.shiftKey ? -1 : 1)); }
    if (k === "PageDown" || k === "PageUp") { e.preventDefault(); const n = Math.floor((sc.clientHeight - HEAD_H) / (S.meta.defaultH * z())); return select(ar + (k === "PageDown" ? n : -n), ac); }
    if (k === "Home") { e.preventDefault(); return select(mod ? 0 : ar, 0); }
    if (k === "F2") { e.preventDefault(); return beginEdit(); }
    if (k === "Delete" || k === "Backspace") { e.preventDefault(); return exec("edit.clearContents", { range: rangeA1(s) }); }
    if (mod && k.toLowerCase() === "z") { e.preventDefault(); return exec(e.shiftKey ? "edit.redo" : "edit.undo", {}); }
    if (mod && k.toLowerCase() === "y") { e.preventDefault(); return exec("edit.redo", {}); }
    if (mod && k.toLowerCase() === "b") { e.preventDefault(); return ribbon("bold"); }
    if (mod && k.toLowerCase() === "i") { e.preventDefault(); return ribbon("italic"); }
    if (mod && k.toLowerCase() === "s") { return; } // the app saves
    if (mod && k.toLowerCase() === "a") { e.preventDefault(); S.sel = { r0: 0, c0: 0, r1: S.nr, c1: S.nc, ar: 0, ac: 0 }; draw(); return; }
    if (mod && (k.toLowerCase() === "c" || k.toLowerCase() === "x")) {
      e.preventDefault();
      const r = await exec(k.toLowerCase() === "x" ? "edit.cut" : "edit.copy", { range: rangeA1(s) }, { refresh: k.toLowerCase() === "x" });
      if (r?.text != null) { try { await navigator.clipboard.writeText(r.text); status(`Copied ${rangeA1(s)}`); } catch {} }
      return;
    }
    if (mod && k.toLowerCase() === "v") {
      e.preventDefault();
      try { const text = await navigator.clipboard.readText(); if (text) await exec("edit.paste", { at: a1(ar, ac), text }); } catch (er) { toast(`Couldn't paste: ${er.message}`, "err"); }
      return;
    }
    if (k.length === 1 && !mod && !e.altKey) { e.preventDefault(); beginEdit(k); }
  });
  const ed = $(".sh-editor", host);
  ed.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.altKey) { e.preventDefault(); commit(ed.value, e.shiftKey ? [-1, 0] : [1, 0]); }
    else if (e.key === "Enter" && e.altKey) { e.preventDefault(); const p = ed.selectionStart; ed.value = ed.value.slice(0, p) + "\n" + ed.value.slice(ed.selectionEnd); ed.selectionStart = ed.selectionEnd = p + 1; }
    else if (e.key === "Tab") { e.preventDefault(); commit(ed.value, [0, e.shiftKey ? -1 : 1]); }
    else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
    e.stopPropagation();
  });
  ed.addEventListener("input", () => { $(".sh-formula", host).value = ed.value; });
  ed.addEventListener("blur", () => { if (S?.editing && document.activeElement !== $(".sh-formula", host)) commit(ed.value, null); });
  const fx = $(".sh-formula", host);
  fx.addEventListener("focus", () => { if (S) S.editing = true; });
  fx.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(fx.value); }
    else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
    e.stopPropagation();
  });
  fx.addEventListener("blur", () => { if (S && $(".sh-editor", host).hidden) S.editing = false; });
  const nm = $(".sh-name", host);
  nm.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const [a, b] = nm.value.split(":").map(parseA1);
    if (!a) return toast("Type a cell like B12 or a range like A1:C9", "warn");
    select(a.r, a.c);
    if (b) { S.sel = { ...S.sel, r1: b.r, c1: b.c }; draw(); }
    sc.focus();
  });
}

function setZoom(zz) {
  S.zoom = Math.max(0.25, Math.min(4, zz));
  S.t.zoom = S.zoom;
  layout(); placeObjects(); draw(); fetchVisible();
}

async function ribbon(a, v) {
  if (!S) return;
  const range = rangeA1(S.sel);
  const s = norm(S.sel);
  const st = S.cells.get(`${S.sel.ar ?? s.r0},${S.sel.ac ?? s.c0}`)?.st || {};
  switch (a) {
    case "undo": return exec("edit.undo", {});
    case "redo": return exec("edit.redo", {});
    case "fontName": return exec("home.fontName", { range, name: v });
    case "fontSize": return exec("home.fontSize", { range, size: +v });
    case "underline": return exec("home.underline", { range, on: !st.u });
    case "bold": return exec("home.bold", { range, on: !st.b });
    case "italic": return exec("home.italic", { range, on: !st.i });
    case "strike": return exec("home.strikethrough", { range, on: !st.st });
    case "fontColor": return exec("home.fontColor", { range, color: v });
    case "fillColor": return exec("home.fillColor", { range, color: v });
    case "left": return exec("home.alignLeft", { range });
    case "center": return exec("home.alignCenter", { range });
    case "right": return exec("home.alignRight", { range });
    case "wrap": return exec("home.wrapText", { range, on: !st.w });
    case "merge": return exec(mergeAt(s.r0, s.c0) ? "home.unmergeCells" : "home.mergeCenter", { range });
    case "numfmt": return exec("home.numberFormat", { range, format: v });
    case "dec+": return exec("home.increaseDecimal", { range });
    case "dec-": return exec("home.decreaseDecimal", { range });
    case "borders": return exec("home.borders", { range, preset: v });
    case "sum": return exec("formulas.autoSum", { range, function: "SUM" });
    case "sortAsc": return exec("data.sortAscending", { range });
    case "sortDesc": return exec("data.sortDescending", { range });
    case "rowcol": {
      const rows = `${s.r0 + 1}:${s.r1 + 1}`, cols = `${colName(s.c0)}:${colName(s.c1)}`;
      if (v === "insRow") return exec("home.insertRows", { rows });
      if (v === "insCol") return exec("home.insertColumns", { cols });
      if (v === "delRow") return exec("home.deleteRows", { rows });
      if (v === "delCol") return exec("home.deleteColumns", { cols });
      if (v === "freeze") return exec("view.freezePanes", { cell: a1(S.sel.ar ?? s.r0, S.sel.ac ?? s.c0) });
      if (v === "unfreeze") return exec("view.unfreezePanes", {});
      if (v === "autofit") return exec("home.autofitColumnWidth", { cols });
      return;
    }
    case "zoomIn": return setZoom(S.zoom * 1.1);
    case "zoomOut": return setZoom(S.zoom / 1.1);
    case "export": return exportSheet(S.t);
  }
}

// ---------------- the ribbon ----------------
let rb = null;
const curStyle = () => { if (!S) return {}; const s = norm(S.sel); return S.cells.get(`${S.sel.ar ?? s.r0},${S.sel.ac ?? s.c0}`)?.st || {}; };
const G_ICON = { "edit.paste": "Paste", "edit.cut": "Cut", "edit.copy": "Copy", "edit.formatPainter": "Brush", "home.increaseFontSize": "Plus", "home.decreaseFontSize": "Minus",
  "home.fillColor": "Fill", "home.fontColor": "FontColor", "home.increaseIndent": "IndentInc", "home.decreaseIndent": "IndentDec", "home.wrapText": "Wrap", "home.mergeCenter": "Merge",
  "home.accounting": "Currency", "home.percent": "Percent", "home.comma": "Comma", "home.increaseDecimal": "DecInc", "home.decreaseDecimal": "DecDec", "home.conditionalFormat": "CondFormat",
  "home.formatAsTable": "FormatTable", "home.cellStyle": "CellStyles", "formulas.autoSum": "Sum", "data.sortAscending": "SortAsc", "data.sortDescending": "SortDesc", "data.filter": "Filter",
  "insert.pivotTable": "PivotTable", "insert.table": "Table", "insert.chart": "Chart", "insert.picture": "Picture", "insert.shape": "Shapes", "insert.textBox": "TextBox", "insert.link": "Link",
  "insert.sparkline": "Sparkline", "insert.symbol": "Symbol", "insert.equation": "Equation", "insert.checkbox": "Checkbox", "review.newComment": "Comment", "review.newNote": "Note",
  "view.freezePanes": "Freeze", "view.gridlines": "Gridlines", "pageLayout.margins": "Margins", "pageLayout.orientation": "Orientation", "pageLayout.size": "Paper", "pageLayout.printArea": "PrintArea",
  "pageLayout.breaks": "PageBreak", "formulas.insertFunction": "Fx", "data.removeDuplicates": "Duplicates", "data.validation": "Validation", "data.group": "Group", "data.ungroup": "Ungroup",
  "data.subtotal": "Subtotal", "review.spelling": "Spell", "review.protectSheet": "Lock", "view.zoom": "Zoom", "developer.macros": "Macro" };
/** Parameters the sheet fills in from the selection. */
function fillParams(c, p) {
  if (!S) return p;
  const desc = c?.params || "";
  const s = norm(S.sel), out = { ...p };
  const has = (k) => new RegExp(`\\b${k}\\??\\s*:|\\b${k}\\?[,}]|\\{${k}[,?}]|, ${k}[,?}]`).test(desc);
  if (has("range") && out.range == null) out.range = rangeA1(S.sel);
  if (has("rows") && out.rows == null) out.rows = `${s.r0 + 1}:${s.r1 + 1}`;
  if (has("cols") && out.cols == null) out.cols = `${colName(s.c0)}:${colName(s.c1)}`;
  if (has("cell") && out.cell == null) out.cell = a1(S.sel.ar ?? s.r0, S.sel.ac ?? s.c0);
  if (has("at") && out.at == null) out.at = a1(S.sel.ar ?? s.r0, S.sel.ac ?? s.c0);
  return out;
}
async function pasteHere() {
  try { const text = await navigator.clipboard.readText(); if (text) return exec("edit.paste", { at: a1(S.sel.ar ?? norm(S.sel).r0, S.sel.ac ?? norm(S.sel).c0), text }); } catch {}
  toast("Use Ctrl+V to paste here.", "", 3000);
}
async function copyHere(cut) {
  const r = await exec(cut ? "edit.cut" : "edit.copy", { range: rangeA1(S.sel) }, { refresh: cut });
  try { if (r?.text != null) await navigator.clipboard.writeText(r.text); } catch {}
}
function sheetHome() {
  const S_ = (cmd, icon, label, extra = {}) => ({ t: "small", cmd, icon, label, ...extra });
  const I = (cmd, icon, title, extra = {}) => ({ t: "small", cmd, icon, title, iconOnly: true, ...extra });
  const cf = (label, rule) => ({ label, cmd: "home.conditionalFormat", params: { rule } });
  return { name: "Home", groups: [
    { name: "Clipboard", items: [
      { t: "big", icon: "Paste", label: "Paste", action: pasteHere, menu: [{ label: "Paste", icon: "Paste", action: pasteHere }, ...["values", "formulas", "formats", "columnWidths", "allExceptBorders"].map((w) => ({ label: { values: "Paste Values", formulas: "Paste Formulas", formats: "Paste Formatting", columnWidths: "Keep Source Column Widths", allExceptBorders: "No Borders" }[w], cmd: "edit.pasteSpecial", params: { what: w } }))] },
      { t: "stack", items: [I("edit.cut", "Cut", "Cut (Ctrl+X)", { action: () => copyHere(true) }), I("edit.copy", "Copy", "Copy (Ctrl+C)", { action: () => copyHere(false) }), I("edit.formatPainter", "Brush", "Format Painter")] }] },
    { name: "Font", items: [{ t: "rows", rows: [
      [{ t: "select", width: 150, title: "Font", options: ["Aptos Narrow", "Calibri", "Arial", "Cambria", "Times New Roman", "Segoe UI", "Tahoma", "Verdana", "Courier New", "Consolas"], value: (st) => st.f, pick: (v) => exec("home.fontName", { range: rangeA1(S.sel), name: v }) },
       { t: "select", width: 56, title: "Font size", options: ["8", "9", "10", "11", "12", "14", "16", "18", "20", "24", "28", "36", "48", "72"], value: (st) => st.s, pick: (v) => exec("home.fontSize", { range: rangeA1(S.sel), size: +v }) },
       I("home.increaseFontSize", "Plus", "Increase Font Size"), I("home.decreaseFontSize", "Minus", "Decrease Font Size")],
      [I("home.bold", "Bold", "Bold (Ctrl+B)", { on: (st) => st.b, params: () => ({ on: !curStyle().b }) }), I("home.italic", "Italic", "Italic (Ctrl+I)", { on: (st) => st.i, params: () => ({ on: !curStyle().i }) }),
       I("home.underline", "Underline", "Underline (Ctrl+U)", { on: (st) => st.u, params: () => ({ on: !curStyle().u }), menu: [{ label: "Underline", cmd: "home.underline", params: () => ({ on: !curStyle().u }) }, { label: "Double Underline", cmd: "home.doubleUnderline" }] }),
       I("home.strikethrough", "Strike", "Strikethrough", { on: (st) => st.st, params: () => ({ on: !curStyle().st }) }),
       I(null, "Borders", "Borders", { menu: [["bottom", "Bottom Border"], ["top", "Top Border"], ["left", "Left Border"], ["right", "Right Border"], ["none", "No Border"], ["all", "All Borders"], ["outside", "Outside Borders"], ["thickOutside", "Thick Outside Borders"], ["doubleBottom", "Bottom Double Border"], ["thickBottom", "Thick Bottom Border"], ["topBottom", "Top and Bottom Border"]].map(([p, l]) => ({ label: l, icon: p === "none" ? "BorderNone" : p === "all" ? "BorderAll" : p === "outside" ? "BorderOutside" : p === "thickOutside" ? "BorderThick" : "Borders", cmd: "home.borders", params: { preset: p } })) }),
       { t: "color", icon: "Fill", title: "Fill Color", value: "#ffff00", pick: (v) => exec("home.fillColor", { range: rangeA1(S.sel), color: v }) },
       { t: "color", icon: "FontColor", title: "Font Color", value: "#c00000", pick: (v) => exec("home.fontColor", { range: rangeA1(S.sel), color: v }) }] ] }] },
    { name: "Alignment", items: [{ t: "rows", rows: [
      [I("home.alignTop", "AlignTop", "Top Align", { on: (st) => st.v === "t" }), I("home.alignMiddle", "AlignMiddle", "Middle Align", { on: (st) => st.v === "c" || st.v === "m" }), I("home.alignBottom", "AlignBottom", "Bottom Align", { on: (st) => st.v === "b" }),
       I(null, "Orientation", "Orientation", { menu: [["counterclockwise", "Angle Counterclockwise"], ["clockwise", "Angle Clockwise"], ["vertical", "Vertical Text"], ["up", "Rotate Text Up"], ["down", "Rotate Text Down"], [0, "Reset"]].map(([a, l]) => ({ label: l, cmd: "home.orientation", params: { angle: a } })) }),
       S_("home.wrapText", "Wrap", "Wrap Text", { on: (st) => st.w, params: () => ({ on: !curStyle().w }) })],
      [I("home.alignLeft", "AlignLeft", "Align Left", { on: (st) => st.h === "l" }), I("home.alignCenter", "AlignCenter", "Center", { on: (st) => st.h === "c" }), I("home.alignRight", "AlignRight", "Align Right", { on: (st) => st.h === "r" }),
       I("home.decreaseIndent", "IndentDec", "Decrease Indent"), I("home.increaseIndent", "IndentInc", "Increase Indent"),
       S_("home.mergeCenter", "Merge", "Merge & Center", { menu: [{ label: "Merge & Center", cmd: "home.mergeCenter" }, { label: "Merge Across", cmd: "home.mergeAcross" }, { label: "Merge Cells", cmd: "home.mergeCells" }, { label: "Unmerge Cells", cmd: "home.unmergeCells" }] })] ] }] },
    { name: "Number", items: [{ t: "rows", rows: [
      [{ t: "select", width: 150, title: "Number Format", placeholder: "General", options: ["General", "Number", "Currency", "Accounting", "Short Date", "Long Date", "Time", "Percentage", "Fraction", "Scientific", "Text"], pick: (v) => exec("home.numberFormat", { range: rangeA1(S.sel), format: v }) }],
      [I("home.accounting", "Currency", "Accounting Number Format", { menu: [["$", "$ English"], ["€", "€ Euro"], ["£", "£ English (UK)"], ["¥", "¥ Japanese"], ["₫", "₫ Vietnamese"]].map(([sy, l]) => ({ label: l, cmd: "home.accounting", params: { symbol: sy } })) }),
       I("home.percent", "Percent", "Percent Style"), I("home.comma", "Comma", "Comma Style"), I("home.increaseDecimal", "DecInc", "Increase Decimal"), I("home.decreaseDecimal", "DecDec", "Decrease Decimal")] ] }] },
    { name: "Styles", items: [
      { t: "big", icon: "CondFormat", label: "Conditional Formatting", menu: [
        cf("Greater Than… (red)", { type: "cellIs", operator: "greaterThan", value: "0", preset: "lightRedFillDarkRedText" }),
        cf("Duplicate Values", { type: "duplicate", preset: "lightRedFillDarkRedText" }),
        cf("Top 10 Items", { type: "top10", rank: 10, preset: "greenFill" }),
        cf("Above Average", { type: "aboveAverage", preset: "yellowFill" }),
        { sep: true },
        cf("Data Bars — Blue", { type: "dataBar", color: "#638EC6" }), cf("Data Bars — Green", { type: "dataBar", color: "#63BE7B" }), cf("Data Bars — Red", { type: "dataBar", color: "#F8696B" }),
        cf("Color Scale — Green-Yellow-Red", { type: "colorScale", colors: ["#63BE7B", "#FFEB84", "#F8696B"] }), cf("Color Scale — Red-White-Blue", { type: "colorScale", colors: ["#F8696B", "#FFFFFF", "#5A8AC6"] }),
        cf("Icon Set — 3 Arrows", { type: "iconSet", set: "3Arrows" }), cf("Icon Set — 3 Traffic Lights", { type: "iconSet", set: "3TrafficLights1" }),
        { sep: true }, { label: "Clear Rules from Selected Cells", cmd: "home.clearRules" }] },
      { t: "big", icon: "FormatTable", label: "Format as Table", menu: ["TableStyleLight1", "TableStyleLight9", "TableStyleMedium2", "TableStyleMedium4", "TableStyleMedium7", "TableStyleMedium9", "TableStyleDark1", "TableStyleDark9"].map((st) => ({ label: st.replace("TableStyle", ""), cmd: "home.formatAsTable", params: { style: st } })) },
      { t: "big", icon: "CellStyles", label: "Cell Styles", menu: ["Normal", "Good", "Bad", "Neutral", "Heading 1", "Heading 2", "Heading 3", "Title", "Total", "Accent1", "Accent2", "Accent3", "Accent4", "Accent5", "Accent6", "Note", "Warning Text", "Input", "Output", "Calculation"].map((n) => ({ label: n, cmd: "home.cellStyle", params: { name: n } })) }] },
    { name: "Cells", items: [{ t: "stack", items: [
      S_(null, "Insert", "Insert", { menu: [{ label: "Insert Cells…", cmd: "home.insertCells" }, { label: "Insert Sheet Rows", cmd: "home.insertRows" }, { label: "Insert Sheet Columns", cmd: "home.insertColumns" }, { label: "Insert Sheet", cmd: "home.insertSheet" }] }),
      S_(null, "Delete", "Delete", { menu: [{ label: "Delete Cells…", cmd: "home.deleteCells" }, { label: "Delete Sheet Rows", cmd: "home.deleteRows" }, { label: "Delete Sheet Columns", cmd: "home.deleteColumns" }, { label: "Delete Sheet", cmd: "home.deleteSheet" }] }),
      S_(null, "Format", "Format", { menu: [{ label: "Row Height…", cmd: "home.rowHeight" }, { label: "AutoFit Row Height", cmd: "home.autofitRowHeight" }, { label: "Column Width…", cmd: "home.columnWidth" }, { label: "AutoFit Column Width", cmd: "home.autofitColumnWidth" }, { sep: true }, { label: "Hide Rows", cmd: "home.hideRows" }, { label: "Hide Columns", cmd: "home.hideColumns" }, { label: "Unhide Rows", cmd: "home.unhideRows" }, { label: "Unhide Columns", cmd: "home.unhideColumns" }, { sep: true }, { label: "Rename Sheet…", cmd: "sheet.rename" }, { label: "Tab Color…", cmd: "sheet.tabColor" }, { label: "Lock Cell", cmd: "home.lockCell" }] })] }] },
    { name: "Editing", items: [
      { t: "stack", items: [
        I("formulas.autoSum", "Sum", "AutoSum", { menu: ["SUM", "AVERAGE", "COUNT", "MAX", "MIN"].map((f) => ({ label: { SUM: "Sum", AVERAGE: "Average", COUNT: "Count Numbers", MAX: "Max", MIN: "Min" }[f], cmd: "formulas.autoSum", params: { function: f } })), params: { function: "SUM" } }),
        I(null, "FillDown", "Fill", { menu: [["edit.fillDown", "Down"], ["edit.fillRight", "Right"], ["edit.fillUp", "Up"], ["edit.fillLeft", "Left"], ["edit.fillSeries", "Series…"], ["edit.flashFill", "Flash Fill"]].map(([c, l]) => ({ label: l, cmd: c })) }),
        I(null, "Eraser", "Clear", { menu: [["edit.clearAll", "Clear All"], ["edit.clearFormats", "Clear Formats"], ["edit.clearContents", "Clear Contents"], ["edit.clearComments", "Clear Comments and Notes"], ["edit.clearHyperlinks", "Clear Hyperlinks"]].map(([c, l]) => ({ label: l, cmd: c })) })] },
      { t: "big", icon: "SortFilter", label: "Sort & Filter", menu: [{ label: "Sort A to Z", icon: "SortAsc", cmd: "data.sortAscending" }, { label: "Sort Z to A", icon: "SortDesc", cmd: "data.sortDescending" }, { label: "Custom Sort…", cmd: "data.sort" }, { sep: true }, { label: "Filter", icon: "Filter", cmd: "data.filter" }, { label: "Clear", cmd: "data.clearFilter" }] },
      { t: "big", icon: "Find", label: "Find & Select", menu: [{ label: "Find…", cmd: "edit.find" }, { label: "Replace…", cmd: "edit.replace" }, { label: "Go To…", cmd: "edit.goTo" }, { sep: true }, ...["formulas", "comments", "conditionalFormats", "constants", "dataValidation", "blanks"].map((k) => ({ label: { formulas: "Formulas", comments: "Notes", conditionalFormats: "Conditional Formatting", constants: "Constants", dataValidation: "Data Validation", blanks: "Blanks" }[k], cmd: "edit.goToSpecial", params: { kind: k } }))] }] },
  ] };
}
async function buildRibbon() {
  if (rb) return;
  await loadIcons();
  // the catalogue comes from any open workbook: a blank one for the first
  const tmp = await call("office_temp", { name: "catalog.csv" });
  await api.writeText(tmp, "", "utf8", 0).catch(() => {});
  let list = [];
  try { const r = await office("sheet.open", { path: tmp }); list = await office("sheet.commands", { id: r.id }); office("sheet.close", { id: r.id }).catch(() => {}); } catch {}
  sheetCommands = list;
  const cmds = list.map((c) => ({ ...c, path: c.menu || [] }));
  const map = new Map(cmds.map((c) => [c.id, c]));
  const match = iconMatcher("grid", G_ICON);
  const auto = autoTabs(cmds, { order: ["Insert", "Draw", "Page Layout", "Formulas", "Data", "Review", "View", "Automate", "Table Design", "PivotTable Analyze", "PivotTable Design", "Chart Design", "Format"], skip: ["Home", "File", "Window", "Edit", "Table"], iconFor: match });
  rb = new Ribbon({
    el: host.querySelector(".sh-rb"), set: "grid", tabs: [sheetHome(), ...auto], commands: map,
    auto: ["range", "rows", "cols", "cell", "at", "sheet"],
    run: async (id, p) => exec(id, fillParams(map.get(id), p)),
    state: curStyle,
    focus: () => host.querySelector(".sh-scroll")?.focus({ preventScroll: true }),
    extra: (row) => {
      row.appendChild(tellBox({ commands: map, exec: (id) => rb.exec(id), focus: () => host.querySelector(".sh-scroll")?.focus() }));
      const ex = document.createElement("button"); ex.className = "small rb-export"; ex.textContent = "Export ▾"; ex.title = "Save a copy as XLSX, CSV, PDF or Markdown";
      ex.onclick = () => S && exportSheet(S.t); row.appendChild(ex);
    },
  });
}
export const refreshSheetRibbon = () => rb?.update();

// ---------------- undo list, command search ----------------
async function loadHistory(t) {
  try { t.sheetHist = await office("sheet.history", { id: t.sheetId }); } catch { t.sheetHist = { undo: [], redo: [] }; }
  window.dispatchEvent(new Event("callio-undo"));
}
registerUndo("sheet", {
  list: (t) => t.sheetHist || { undo: [], redo: [] },
  step: async (t, n, redo) => {
    if (!t.sheetId) return;
    t.sheetHist = await office("sheet.undoN", { id: t.sheetId, count: n, redo });
    if (S?.t === t) await afterEdit();
    host.querySelector(".sh-scroll")?.focus({ preventScroll: true });
  },
});
/** For the AI: commands on an open workbook as one undo step. */
export async function aiBatch(t, commands, label) {
  const r = await office("sheet.batch", { id: t.sheetId, commands, label });
  t.dirty = true;
  window.dispatchEvent(new CustomEvent("callio-tab-dirty", { detail: t }));
  if (S?.t === t) await afterEdit(); else loadHistory(t);
  return r.results;
}
export const shownSheet = () => (S && host && !host.hidden ? S.t : null);
let sheetCommands = null;
async function showCommandList(q) {
  if (!S) return;
  sheetCommands ||= await office("sheet.commands", { id: S.t.sheetId }).catch(() => []);
  const s = q.trim().toLowerCase();
  const hits = sheetCommands.filter((c) => c.enabled !== false && (!s || (c.label + " " + (c.menu || []).join(" ") + " " + c.id).toLowerCase().includes(s))).slice(0, 60);
  const list = host.querySelector(".sh-cmd-list");
  list.innerHTML = hits.map((c) => `<div class="sh-cmd-it" data-id="${esc(c.id)}"><b>${esc(c.label)}</b><small>${esc((c.menu || []).join(" › "))}${c.shortcut ? " · " + esc(c.shortcut) : ""}</small></div>`).join("") || `<div class="note" style="padding:8px">No command</div>`;
  list.hidden = false;
}
async function runListed(id) {
  const c = sheetCommands?.find((x) => x.id === id);
  host.querySelector(".sh-cmd-list").hidden = true;
  host.querySelector(".sh-cmd").value = "";
  const params = { range: rangeA1(S.sel) };
  for (const m of (c?.params || "").matchAll(/"?(\w+)"?(\?)?:\s*([^,}]+)/g)) {
    if (m[2] || m[1] === "range" || m[1] === "sheet") continue;
    const v = await ask({ title: c.label, text: `${m[1]} (${m[3].trim()}):`, input: "" });
    if (v == null) return;
    params[m[1]] = /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v === "true" ? true : v === "false" ? false : v;
  }
  const r = await exec(id, params);
  if (r && typeof r === "object" && r.message) toast(r.message, "", 4000);
  host.querySelector(".sh-scroll")?.focus({ preventScroll: true });
}
function wireCommandSearch() {
  const inp = host.querySelector(".sh-cmd");
  inp.addEventListener("focus", () => showCommandList(inp.value));
  inp.addEventListener("input", () => showCommandList(inp.value));
  inp.addEventListener("blur", () => setTimeout(() => { host.querySelector(".sh-cmd-list").hidden = true; }, 150));
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") inp.blur();
    if (e.key === "Enter") { const f = host.querySelector(".sh-cmd-it"); if (f) runListed(f.dataset.id); }
  });
  host.querySelector(".sh-cmd-list").addEventListener("mousedown", (e) => { const it = e.target.closest(".sh-cmd-it"); if (it) { e.preventDefault(); runListed(it.dataset.id); } });
}

// ---------------- saving ----------------
const WRITES = ["xlsx", "xlsm", "csv", "tsv", "txt"];
export async function saveSheet(t, saveAs = false) {
  const ext = t.path.toLowerCase().split(".").pop();
  let out = t.path;
  if (saveAs || !WRITES.includes(ext)) {
    if (!saveAs) {
      const r = await ask({ title: "Save workbook", text: `.${ext} files can be opened but not written. Save a copy as an Excel workbook (.xlsx)?`, buttons: [{ label: "Cancel", value: null }, { label: "Save as .xlsx", value: "ok", primary: true }] });
      if (!r) return false;
    }
    out = await api.pickSaveFile(basename(t.path).replace(/\.[^.]+$/, "") + ".xlsx", dirname(t.path));
    if (!out) return false;
  }
  try {
    status(`Saving ${basename(out)}…`);
    // written to a temporary copy, then put in place with a backup of the old file
    const tmp = await call("office_temp", { name: basename(out) });
    await office("sheet.save", { id: t.sheetId, out: tmp });
    const bytes = new Uint8Array(await api.readBinary(tmp));
    try { t.mtime = await api.writeBinary(out, bytes, out === t.path ? t.mtime || 0 : 0, true); }
    catch (e) {
      if (e.message !== "CHANGED_ON_DISK") throw e;
      const ok = await ask({ title: "Changed on disk", text: `${t.name} was changed by another program since you opened it. Overwrite it? (The current file is backed up first.)`, buttons: [{ label: "Cancel", value: null }, { label: "Overwrite", value: "y", primary: true }] });
      if (!ok) return false;
      t.mtime = await api.writeBinary(out, bytes, 0, true);
    }
    if (out !== t.path) { t.path = out; t.name = basename(out); }
    t.dirty = false; window.dispatchEvent(new CustomEvent("callio-tab-dirty", { detail: t }));
    status(`Saved ${basename(out)}`, "ok");
    return true;
  } catch (e) { toast(`Couldn't save: ${e.message}`, "err", 8000); return false; }
}

export async function exportSheet(t) {
  const fmt = await ask({ title: `Export ${t.name}`, text: "Save a copy as:", vertical: true, buttons: [{ label: "Cancel", value: null }, { label: "Excel workbook (.xlsx)", value: "xlsx" }, { label: "CSV — this sheet (.csv)", value: "csv" }, { label: "Tab-separated — this sheet (.tsv)", value: "tsv" }, { label: "PDF — every sheet, with its print settings (.pdf)", value: "pdf" }, { label: "Markdown tables — every sheet (.md)", value: "md" }] });
  if (!fmt) return;
  const out = await api.pickSaveFile(basename(t.path).replace(/\.[^.]+$/, "") + "." + fmt, dirname(t.path));
  if (!out) return;
  try {
    await office("sheet.save", { id: t.sheetId, out });
    toast(`Saved ${basename(out)}`, "ok", 3000);
    if (fmt === "md" || fmt === "pdf") (await import("./main.js")).openPath(out);
  } catch (e) { toast(`Couldn't save: ${e.message}`, "err", 8000); }
}
