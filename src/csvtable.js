// CSV / TSV files as a table you can edit, next to (or instead of) their text. The text stays
// the file: every table edit is a change to the text (one step in Undo, minimal so the rest of
// the file is kept byte for byte), and the file is saved as the same CSV/TSV.
// The grid draws only the rows and columns on screen, so very large files scroll smoothly.

import { sortable } from "./sortable.js";
import { enter } from "./motion.js";
import { ic } from "./icons.js";

const ROW_H = 26, HEAD_H = 28, NUM_W = 52, OVERSCAN = 24;

// ------------------------------------------------------------------ the model
/**
 * Parse delimited text (line breaks already "\n"). Rows keep their range in the text so
 * an edit can replace just that row.
 */
export function parseCsv(text, delim) {
  const rows = [];
  const n = text.length;
  const dc = delim.charCodeAt(0);
  let i = 0;
  let quoted = 0;
  while (i < n || (i === n && rows.length === 0 && n > 0)) {
    const from = i;
    const cells = [];
    let field = "", inQ = false, wasQ = false, start = i;
    for (;;) {
      if (i >= n) { cells.push(wasQ || field ? field : text.slice(start, i)); break; }
      const c = text.charCodeAt(i);
      if (inQ) {
        if (c === 34) { if (text.charCodeAt(i + 1) === 34) { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
        field += text[i]; i++; continue;
      }
      if (c === 34 && i === start) { inQ = true; wasQ = true; quoted++; i++; continue; }
      if (c === dc) { cells.push(wasQ ? field : text.slice(start, i)); i++; start = i; field = ""; wasQ = false; continue; }
      if (c === 10) { cells.push(wasQ ? field : text.slice(start, i)); break; }
      if (wasQ) field += text[i]; // stray text after a closing quote
      i++;
    }
    rows.push({ cells, from, to: i });
    if (i >= n) break;
    i++; // the "\n"
    if (i === n) break; // trailing newline: no empty last row
  }
  let width = 0;
  for (const r of rows) if (r.cells.length > width) width = r.cells.length;
  const fields = rows.reduce((a, r) => a + r.cells.length, 0);
  return { rows, width, trailing: n > 0 && text.charCodeAt(n - 1) === 10, quoteAll: fields > 0 && quoted / fields > 0.9 };
}

export function detectDelimiter(text, name = "") {
  if (/\.(tsv|tab)$/i.test(name)) return "\t";
  if (/\.psv$/i.test(name)) return "|";
  const sample = text.slice(0, 50000);
  let best = ",", bestScore = -1;
  for (const d of [",", ";", "\t", "|"]) {
    const rows = parseCsv(sample, d).rows.slice(0, 60).filter((r) => r.cells.some((c) => c.trim()));
    if (!rows.length) continue;
    const freq = new Map();
    for (const r of rows) freq.set(r.cells.length, (freq.get(r.cells.length) || 0) + 1);
    const mode = [...freq].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    if (mode < 2) continue;
    const score = (rows.filter((r) => r.cells.length === mode).length / rows.length) * 10 + Math.min(mode, 10) * 0.1;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

export function quoteCell(c, delim, all = false) {
  if (all || c.includes(delim) || c.includes('"') || c.includes("\n") || c.includes("\r") || /^\s|\s$/.test(c) && delim !== "\t") return '"' + c.replace(/"/g, '""') + '"';
  return c;
}
export const rowText = (cells, delim, all) => cells.map((c) => quoteCell(c ?? "", delim, all)).join(delim);

/** Markdown table of the rows (for export and the AI). */
export function toMarkdownTable(text, delim) {
  const { rows, width } = parseCsv(text, delim);
  if (!rows.length) return "";
  const esc = (s) => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
  const line = (cells) => "| " + Array.from({ length: width }, (_, i) => esc(cells[i])).join(" | ") + " |";
  return [line(rows[0].cells), "| " + Array(width).fill("---").join(" | ") + " |", ...rows.slice(1).map((r) => line(r.cells))].join("\n") + "\n";
}

const colName = (i) => { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const numeric = (s) => s !== "" && s != null && /^\s*[-+]?(\d[\d,]*\.?\d*|\.\d+)(e[-+]?\d+)?\s*%?\s*$/i.test(s);
const DELIMS = [[",", "Comma"], [";", "Semicolon"], ["\t", "Tab"], ["|", "Pipe"]];

// ------------------------------------------------------------------ the grid
/**
 * @param {HTMLElement} host
 * @param {object} io
 *   getState(): the editor state of the tab; dispatch(spec): apply a change to the text;
 *   tab: the tab (keeps delim, header, widths); onCell(pos): a cell was selected (source offset);
 *   undo(redo)
 */
export function mountTable(host, io) {
  host.innerHTML = `
    <div class="csv-bar">
      <button data-a="row-below" title="Insert a row below the selection (Ctrl+Enter)">${ic("plus")}<span>Row</span></button>
      <button data-a="col-right" title="Insert a column right of the selection">${ic("plus")}<span>Column</span></button>
      <button data-a="del-rows" title="Delete the selected rows (Ctrl+−)">${ic("minus")}<span>Row</span></button>
      <button data-a="del-cols" title="Delete the selected columns">${ic("minus")}<span>Column</span></button>
      <span class="sep"></span>
      <button data-a="sort-asc" title="Sort by the selected column, A→Z / smallest first">${ic("sort-asc")}<span>Sort</span></button>
      <button data-a="sort-desc" title="Sort by the selected column, Z→A / largest first">${ic("sort-desc")}<span>Sort</span></button>
      <span class="sep"></span>
      <label class="csv-head" title="Show the first row as column titles (it stays a row of the file)"><input type="checkbox" data-a="header" /> Header row</label>
      <select data-a="delim" title="How the columns are separated in this file">${DELIMS.map(([d, n]) => `<option value="${d === "\t" ? "tab" : d}">${n}</option>`).join("")}</select>
      <input class="csv-filter" type="search" placeholder="Filter rows…" title="Show only rows containing this text" />
      <span class="tb-spacer"></span>
      <span class="csv-info"></span>
    </div>
    <div class="csv-grid" tabindex="0">
      <div class="csv-head-row"><div class="csv-corner"></div><div class="csv-ths"></div></div>
      <div class="csv-body">
        <div class="csv-nums"></div>
        <div class="csv-rows"></div>
        <div class="csv-sel" hidden></div>
        <div class="csv-cur"></div>
        <textarea class="csv-edit" hidden spellcheck="false"></textarea>
      </div>
    </div>`;
  const $ = (s) => host.querySelector(s);
  const grid = $(".csv-grid"), size = $(".csv-body"), headRow = $(".csv-ths"), nums = $(".csv-nums"), rowsEl = $(".csv-rows");
  const selEl = $(".csv-sel"), curEl = $(".csv-cur"), ed = $(".csv-edit");
  const t = io.tab;

  let model = null, modelDoc = null;
  let view = []; // indices of rows shown (header excluded, filter applied)
  let widths = [];
  let offs = [0];
  let cur = { r: 0, c: 0 }, anchor = { r: 0, c: 0 }; // in view rows / columns
  let editing = null;
  let filter = "";

  const delim = () => t.delim || ",";
  const hasHeader = () => !!t.csvHeader;
  const width = () => Math.max(1, model?.width || 1);

  function sync(force = false) {
    const st = io.getState();
    if (!force && st.doc === modelDoc) return false;
    modelDoc = st.doc;
    model = parseCsv(st.doc.toString(), delim());
    if (t.csvHeader === undefined) t.csvHeader = guessHeader(model);
    computeView();
    computeWidths();
    return true;
  }
  function guessHeader(m) {
    if (m.rows.length < 2) return false;
    const h = m.rows[0].cells;
    if (!h.length || h.some((c) => !c.trim() || numeric(c))) return false;
    const body = m.rows.slice(1, 30);
    // titles are text; a column of numbers under a text title says "header"
    return h.some((_, i) => body.some((r) => numeric(r.cells[i]))) || new Set(h).size === h.length && body.length > 0 && body.some((r) => r.cells.some((c, i) => c !== h[i]));
  }
  function computeView() {
    const start = hasHeader() ? 1 : 0;
    const f = filter.toLowerCase();
    view = [];
    for (let i = start; i < model.rows.length; i++) {
      if (f && !model.rows[i].cells.some((c) => c.toLowerCase().includes(f))) continue;
      view.push(i);
    }
  }
  function computeWidths() {
    const w = width();
    const saved = t.csvWidths || [];
    widths = Array.from({ length: w }, (_, c) => {
      if (saved[c]) return saved[c];
      let m = colName(c).length + 2;
      const sample = model.rows.length > 300 ? model.rows.slice(0, 300) : model.rows;
      for (const r of sample) { const s = r.cells[c]; if (s) { const l = Math.min(60, s.indexOf("\n") >= 0 ? s.indexOf("\n") : s.length); if (l > m) m = l; } }
      return Math.round(Math.min(340, Math.max(64, m * 7.4 + 20)));
    });
    offs = [0];
    for (const x of widths) offs.push(offs[offs.length - 1] + x);
  }
  const rowTop = (vr) => vr * ROW_H; // in the body (under the sticky column titles)
  const colLeft = (c) => NUM_W + offs[c];

  // ---------- drawing ----------
  let raf = 0, drawn = "", drawnCtx = "", drawnR = [0, 0], drawnC = [0, 0], editsSeq = 0;
  const invalidate = () => { drawn = ""; rowsKey = ""; };
  const rowEls = new Map(), numEls = new Map(), tpl = document.createElement("template");
  let rowsKey = "";
  const schedule = () => { if (!raf) raf = requestAnimationFrame(draw); };
  function draw() {
    raf = 0;
    if (!model) return;
    const t0 = performance.now();
    drawInner();
    if (import.meta.env?.DEV) { void rowsEl.offsetHeight; (window.__csvDraw ||= []).push(performance.now() - t0); }
  }
  function drawInner() {
    const W = width();
    const fullW = NUM_W + offs[W] + 40 + "px";
    size.style.width = fullW; headRow.parentElement.style.width = fullW;
    size.style.height = view.length * ROW_H + 60 + "px";
    const top = grid.scrollTop, left = grid.scrollLeft, h = grid.clientHeight, w = grid.clientWidth;
    // what is on screen…
    const v0 = Math.max(0, Math.floor(top / ROW_H)), v1 = Math.min(view.length, Math.ceil((top + h) / ROW_H));
    let vc0 = 0; while (vc0 < W && offs[vc0 + 1] < left) vc0++;
    let vc1 = vc0; while (vc1 < W && offs[vc1] < left + w) vc1++;
    // …is redrawn only when it leaves what was drawn last time (with a wide margin), so most
    // scrolling just moves the pixels already there
    const ctx = `${modelDoc?.length}|${view.length}|${W}|${filter}|${hasHeader()}|${widths.join(",")}|${editsSeq}`;
    const fits = drawn && drawnCtx === ctx && v0 >= drawnR[0] && v1 <= drawnR[1] && vc0 >= drawnC[0] && vc1 <= drawnC[1];
    const r0 = Math.max(0, v0 - OVERSCAN), r1 = Math.min(view.length, v1 + OVERSCAN);
    let c0 = vc0; while (c0 > 0 && offs[vc0] - offs[c0] < 500) c0--;
    let c1 = vc1; while (c1 < W && offs[c1] - offs[vc1] < 500) c1++;
    if (!fits) {
      if (import.meta.env?.DEV) window.__csvRenders = (window.__csvRenders || 0) + 1;
      drawn = "y"; drawnCtx = ctx; drawnR = [r0 === 0 ? 0 : r0 + 4, r1 === view.length ? r1 : r1 - 4]; drawnC = [c0 === 0 ? 0 : c0 + 1, c1 === W ? c1 : c1 - 1];
      // cells carry no inline style (the column widths are one grid template on the
      // container), so the browser styles them all at once
      const cols = widths.slice(c0, c1).map((x) => x + "px").join(" ");
      const head = hasHeader() ? model.rows[0]?.cells || [] : [];
      let hh = "";
      for (let c = c0; c < c1; c++) {
        const title = hasHeader() ? head[c] ?? "" : "";
        hh += `<div class="csv-th" data-c="${c}"><span class="csv-l">${colName(c)}</span>${title ? `<span class="csv-t">${esc(title)}</span>` : ""}<span class="csv-rz" data-c="${c}"></span></div>`;
      }
      headRow.style.cssText = `left:${colLeft(c0)}px;grid-template-columns:${cols}`;
      headRow.innerHTML = hh;
      // rows already on the page stay; only the rows coming into view are built
      const colKey = `${c0}|${c1}|${ctx}`;
      if (colKey !== rowsKey) { rowsKey = colKey; rowEls.clear(); numEls.clear(); rowsEl.textContent = ""; nums.textContent = ""; }
      for (const [vr, el] of rowEls) if (vr < r0 || vr >= r1) { el.remove(); rowEls.delete(vr); numEls.get(vr)?.remove(); numEls.delete(vr); }
      let nh = "", rh = "";
      const added = [];
      for (let vr = r0; vr < r1; vr++) {
        if (rowEls.has(vr)) continue;
        added.push(vr);
        const ri = view[vr], row = model.rows[ri];
        const y = rowTop(vr);
        nh += `<div class="csv-num" data-r="${vr}" style="top:${y}px">${ri + 1}</div>`;
        rh += `<div class="csv-tr${vr % 2 ? " odd" : ""}" data-r="${vr}" style="top:${y}px">`;
        for (let c = c0; c < c1; c++) {
          const v = row.cells[c];
          rh += v === undefined ? `<div class="csv-td miss" data-c="${c}"></div>` : `<div class="csv-td${numeric(v) ? " num" : ""}" data-c="${c}">${v ? esc(v.length > 400 ? v.slice(0, 400) + "…" : v) : ""}</div>`;
        }
        rh += `</div>`;
      }
      rowsEl.style.cssText = `left:${colLeft(c0)}px;--cols:${cols}`;
      if (added.length) {
        tpl.innerHTML = rh;
        const rs = [...tpl.content.children];
        tpl.innerHTML = nh;
        const ns = [...tpl.content.children];
        added.forEach((vr, i) => { rowEls.set(vr, rs[i]); numEls.set(vr, ns[i]); });
        rowsEl.append(...rs);
        nums.append(...ns);
      }
    }
    drawSel();
  }
  function drawSel() {
    const W = width();
    cur.r = Math.max(0, Math.min(cur.r, Math.max(0, view.length - 1)));
    cur.c = Math.max(0, Math.min(cur.c, W - 1));
    const ra = Math.min(cur.r, anchor.r), rb = Math.max(cur.r, anchor.r), ca = Math.min(cur.c, anchor.c), cb = Math.max(cur.c, anchor.c);
    const multi = ra !== rb || ca !== cb;
    selEl.hidden = !multi;
    if (multi) Object.assign(selEl.style, { left: colLeft(ca) + "px", top: rowTop(ra) + "px", width: offs[cb + 1] - offs[ca] + "px", height: (rb - ra + 1) * ROW_H + "px" });
    curEl.hidden = !view.length;
    Object.assign(curEl.style, { left: colLeft(cur.c) + "px", top: rowTop(cur.r) + "px", width: widths[cur.c] + "px", height: ROW_H + "px" });
    for (const el of headRow.querySelectorAll(".csv-th.on")) el.classList.remove("on");
    for (let c = ca; c <= cb; c++) headRow.querySelector(`.csv-th[data-c="${c}"]`)?.classList.add("on");
    for (const el of nums.querySelectorAll(".csv-num.on")) el.classList.remove("on");
    for (let r = ra; r <= rb && r - ra < 200; r++) nums.querySelector(`.csv-num[data-r="${r}"]`)?.classList.add("on");
    info();
  }
  function info() {
    const n = model.rows.length - (hasHeader() ? 1 : 0);
    const ri = view[cur.r];
    $(".csv-info").textContent = `${filter ? `${view.length.toLocaleString()} of ` : ""}${n.toLocaleString()} rows × ${width()} columns` + (ri !== undefined ? ` · ${colName(cur.c)}${ri + 1}` : "");
  }
  function scrollIntoView(r, c) {
    const y = rowTop(r) + HEAD_H, x = colLeft(c);
    if (y < grid.scrollTop + HEAD_H) grid.scrollTop = y - HEAD_H;
    else if (y + ROW_H > grid.scrollTop + grid.clientHeight - 14) grid.scrollTop = y + ROW_H - grid.clientHeight + 14;
    if (x < grid.scrollLeft + NUM_W) grid.scrollLeft = x - NUM_W;
    else if (x + widths[c] > grid.scrollLeft + grid.clientWidth - 14) grid.scrollLeft = x + widths[c] - grid.clientWidth + 14;
  }
  function select(r, c, extend = false) {
    cur = { r, c };
    if (!extend) anchor = { r, c };
    drawSel();
    scrollIntoView(cur.r, cur.c);
    schedule();
    const ri = view[cur.r];
    if (ri !== undefined && io.onCell) io.onCell(cellOffset(ri, cur.c));
  }
  /** Where cell (row ri, column c) starts in the text. */
  function cellOffset(ri, c) {
    const row = model.rows[ri];
    const text = modelDoc.sliceString(row.from, row.to);
    let i = 0, k = 0, inQ = false;
    while (k < c && i < text.length) {
      const ch = text[i];
      if (inQ) { if (ch === '"') { if (text[i + 1] === '"') i++; else inQ = false; } }
      else if (ch === '"') inQ = true;
      else if (ch === delim()) k++;
      i++;
    }
    return row.from + i;
  }
  /** The table row/column at a text offset (for following the cursor in the source). */
  function cellAt(pos) {
    if (!model) return null;
    let lo = 0, hi = model.rows.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (model.rows[m].from <= pos) lo = m; else hi = m - 1; }
    const row = model.rows[lo];
    if (!row) return null;
    const text = modelDoc.sliceString(row.from, Math.min(pos, row.to));
    let k = 0, inQ = false;
    for (let i = 0; i < text.length; i++) { const ch = text[i]; if (inQ) { if (ch === '"') { if (text[i + 1] === '"') i++; else inQ = false; } } else if (ch === '"') inQ = true; else if (ch === delim()) k++; }
    return { ri: lo, c: k };
  }

  // ---------- changes (each one step in Undo) ----------
  function apply(changes, label, after) {
    io.dispatch({ changes, label });
    sync();
    after?.();
    invalidate();
    schedule();
  }
  const fullText = (rows) => rows.map((r) => (r.raw !== undefined ? r.raw : rowText(r.cells, delim(), model.quoteAll))).join("\n") + (model.trailing || !rows.length ? "\n" : "");
  function rewrite(rows, label, after) {
    const text = fullText(rows);
    io.dispatch({ text, label });
    sync();
    after?.();
    invalidate();
    schedule();
  }
  const keep = (r) => ({ raw: modelDoc.sliceString(r.from, r.to), cells: r.cells });

  function setCells(edits, label) {
    // edits: [{ri, c, v}] — rows rewritten once each
    const byRow = new Map();
    for (const e of edits) {
      if (!byRow.has(e.ri)) byRow.set(e.ri, [...(model.rows[e.ri]?.cells || [])]);
      const cells = byRow.get(e.ri);
      while (cells.length <= e.c) cells.push("");
      cells[e.c] = e.v;
    }
    const changes = [];
    for (const [ri, cells] of [...byRow].sort((a, b) => a[0] - b[0])) {
      const row = model.rows[ri];
      const old = row.cells;
      if (cells.length === old.length && cells.every((v, i) => v === old[i])) continue;
      changes.push({ from: row.from, to: row.to, insert: rowText(cells, delim(), model.quoteAll) });
    }
    if (changes.length) apply(changes, label);
  }
  function insertRows(at, count = 1, label = "Insert row") {
    // at: model row index to insert before (rows.length = at the end)
    const blank = rowText(Array(width()).fill(""), delim(), false);
    const lines = Array(count).fill(blank).join("\n");
    const len = modelDoc.length;
    let change;
    if (at < model.rows.length) change = { from: model.rows[at].from, insert: lines + "\n" };
    else if (!model.rows.length) change = { from: 0, insert: lines + "\n" };
    else change = model.trailing ? { from: len, insert: lines + "\n" } : { from: len, insert: "\n" + lines };
    apply([change], label);
  }
  function deleteRows(ris, label) {
    if (!ris.length) return;
    const set = new Set(ris);
    const changes = [];
    const len = modelDoc.length;
    for (const ri of [...set].sort((a, b) => a - b)) {
      const r = model.rows[ri];
      let from = r.from, to = r.to;
      if (to < len) to++; // its line break
      else if (from > 0) from--; // last row: the break before it
      changes.push({ from, to });
    }
    // merge overlaps (adjacent last rows)
    changes.sort((a, b) => a.from - b.from);
    const merged = [];
    for (const ch of changes) { const p = merged[merged.length - 1]; if (p && ch.from <= p.to) p.to = Math.max(p.to, ch.to); else merged.push({ ...ch }); }
    apply(merged, label);
  }
  function insertCol(at, label = "Insert column") {
    const rows = model.rows.map((r) => { const cells = [...r.cells]; while (cells.length < at) cells.push(""); cells.splice(at, 0, ""); return { cells }; });
    t.csvWidths = widths.slice(0, at).concat([100], widths.slice(at));
    rewrite(rows, label);
  }
  function deleteCols(cs, label) {
    const set = new Set(cs);
    if (set.size >= width()) return io.toast?.("A table needs at least one column.");
    const rows = model.rows.map((r) => ({ cells: r.cells.filter((_, i) => !set.has(i)) }));
    t.csvWidths = widths.filter((_, i) => !set.has(i));
    rewrite(rows, label);
  }
  function sortBy(c, desc) {
    const start = hasHeader() ? 1 : 0;
    const body = model.rows.slice(start).map(keep);
    const allNum = body.every((r) => !r.cells[c] || numeric(r.cells[c]));
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    const val = (r) => r.cells[c] ?? "";
    body.sort((a, b) => {
      const x = val(a), y = val(b);
      if (!x && y) return 1; if (x && !y) return -1; // blanks last
      const d = allNum ? parseFloat(x.replace(/,/g, "")) - parseFloat(y.replace(/,/g, "")) : coll.compare(x, y);
      return desc ? -d : d;
    });
    rewrite([...model.rows.slice(0, start).map(keep), ...body], `Sort by ${colTitle(c)} ${desc ? "Z→A" : "A→Z"}`);
  }
  function moveRow(from, to) {
    const rows = model.rows.map(keep);
    const [r] = rows.splice(from, 1);
    rows.splice(to > from ? to - 1 : to, 0, r);
    rewrite(rows, "Move row");
  }
  function moveCol(from, to) {
    const W = width();
    const order = [...Array(W).keys()];
    const [x] = order.splice(from, 1);
    order.splice(to > from ? to - 1 : to, 0, x);
    const rows = model.rows.map((r) => ({ cells: order.map((i) => r.cells[i] ?? "").slice(0, Math.max(...order.map((i, k) => (i < r.cells.length ? k + 1 : 0)))) }));
    t.csvWidths = order.map((i) => widths[i]);
    rewrite(rows, `Move column ${colName(from)}`);
  }
  const colTitle = (c) => (hasHeader() && model.rows[0]?.cells[c] ? `“${model.rows[0].cells[c]}”` : `column ${colName(c)}`);
  const selRows = () => { const a = Math.min(cur.r, anchor.r), b = Math.max(cur.r, anchor.r); const out = []; for (let r = a; r <= b; r++) if (view[r] !== undefined) out.push(view[r]); return out; };
  const selCols = () => { const a = Math.min(cur.c, anchor.c), b = Math.max(cur.c, anchor.c); return Array.from({ length: b - a + 1 }, (_, i) => a + i); };

  const actions = {
    "row-above": () => { const ri = view[Math.min(cur.r, anchor.r)] ?? model.rows.length; insertRows(ri, 1, "Insert row above"); },
    "row-below": () => {
      const ri = view[Math.max(cur.r, anchor.r)];
      const at = ri === undefined ? model.rows.length : ri + 1;
      insertRows(at, 1, "Insert row");
      const vr = view.indexOf(at); if (vr >= 0) select(vr, cur.c);
    },
    "col-left": () => insertCol(Math.min(cur.c, anchor.c), "Insert column"),
    "col-right": () => { const c = Math.max(cur.c, anchor.c) + 1; insertCol(c, "Insert column"); select(cur.r, c); },
    "del-rows": () => { const rs = selRows(); deleteRows(rs, rs.length > 1 ? `Delete ${rs.length} rows` : "Delete row"); anchor = { ...cur }; },
    "del-cols": () => { const cs = selCols(); deleteCols(cs, cs.length > 1 ? `Delete ${cs.length} columns` : `Delete ${colTitle(cs[0])}`); anchor = { ...cur }; },
    "sort-asc": () => sortBy(cur.c, false),
    "sort-desc": () => sortBy(cur.c, true),
    clear: () => { const e = []; for (const ri of selRows()) for (const c of selCols()) e.push({ ri, c, v: "" }); setCells(e, "Clear cells"); },
    copy: () => copySel(),
    cut: async () => { await copySel(); actions.clear(); },
    paste: () => pasteAt(),
  };

  // ---------- editing a cell ----------
  function startEdit(initial) {
    if (!view.length) { insertRows(model.rows.length, 1, "Insert row"); }
    const ri = view[cur.r];
    if (ri === undefined) return;
    scrollIntoView(cur.r, cur.c);
    const v = model.rows[ri].cells[cur.c] ?? "";
    editing = { ri, c: cur.c };
    Object.assign(ed.style, { left: colLeft(cur.c) + "px", top: rowTop(cur.r) + "px", width: Math.max(widths[cur.c], 120) + "px", minHeight: ROW_H + "px" });
    ed.hidden = false;
    ed.value = initial ?? v;
    ed.style.height = "auto";
    ed.style.height = Math.max(ROW_H, Math.min(220, ed.scrollHeight)) + "px";
    ed.focus();
    if (initial == null) ed.select(); else ed.setSelectionRange(ed.value.length, ed.value.length);
  }
  function endEdit(commit) {
    if (!editing) return;
    const e = editing;
    editing = null;
    ed.hidden = true;
    if (commit) {
      const old = model.rows[e.ri]?.cells[e.c] ?? "";
      if (ed.value !== old) setCells([{ ri: e.ri, c: e.c, v: ed.value }], `Edit ${colName(e.c)}${e.ri + 1}`);
    }
    grid.focus({ preventScroll: true });
  }
  ed.addEventListener("input", () => { ed.style.height = "auto"; ed.style.height = Math.max(ROW_H, Math.min(220, ed.scrollHeight)) + "px"; });
  ed.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); endEdit(false); }
    else if (e.key === "Enter" && !e.altKey && !e.shiftKey) { e.preventDefault(); endEdit(true); move(1, 0); }
    else if (e.key === "Tab") { e.preventDefault(); endEdit(true); move(0, e.shiftKey ? -1 : 1); }
  });
  ed.addEventListener("blur", () => endEdit(true));

  function move(dr, dc, extend = false) {
    const W = width();
    let r = cur.r + dr, c = cur.c + dc;
    if (c >= W && dc > 0 && !extend) { c = 0; r++; }
    if (c < 0 && dc < 0 && !extend) { c = W - 1; r--; }
    // Enter on the last row adds a row, like a spreadsheet
    if (r >= view.length && dr === 1 && !extend && !filter) { actions["row-below"](); return; }
    select(Math.max(0, Math.min(view.length - 1, r)), Math.max(0, Math.min(W - 1, c)), extend);
  }

  // ---------- clipboard ----------
  async function copySel() {
    const lines = selRows().map((ri) => selCols().map((c) => { const v = model.rows[ri].cells[c] ?? ""; return /[\t\n"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join("\t"));
    try { await navigator.clipboard.writeText(lines.join("\n")); } catch {}
  }
  async function pasteAt() {
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch { return; }
    if (!text) return;
    text = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
    const d = text.includes("\t") ? "\t" : delim();
    const block = parseCsv(text, d).rows.map((r) => r.cells);
    const need = cur.r + block.length - view.length;
    if (need > 0 && !filter) { insertRows(model.rows.length, need, "Add rows for paste"); }
    const edits = [];
    block.forEach((cells, i) => { const ri = view[cur.r + i]; if (ri === undefined) return; cells.forEach((v, j) => edits.push({ ri, c: cur.c + j, v })); });
    if (edits.length) setCells(edits, block.length * (block[0]?.length || 1) > 1 ? "Paste cells" : "Paste");
  }

  // ---------- events ----------
  grid.addEventListener("scroll", () => { if (editing) endEdit(true); schedule(); }, { passive: true });
  const ro = new ResizeObserver(() => schedule());
  ro.observe(grid);

  let dragSel = false;
  grid.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    const rz = e.target.closest(".csv-rz");
    if (rz) return startResize(e, +rz.dataset.c);
    const td = e.target.closest(".csv-td"), th = e.target.closest(".csv-th"), num = e.target.closest(".csv-num");
    if (e.target === ed) return;
    if (editing) endEdit(true);
    if (td) {
      const r = +td.parentElement.dataset.r, c = +td.dataset.c;
      if (e.button === 2 && inSel(r, c)) return;
      select(r, c, e.shiftKey);
      if (e.button === 0) { dragSel = true; grid.setPointerCapture(e.pointerId); }
    } else if (th && e.button === 0 && !e.target.closest(".csv-rz")) {
      // a column: the whole column (drag the title to move it)
      const c = +th.dataset.c;
      anchor = { r: 0, c: e.shiftKey ? anchor.c : c }; cur = { r: Math.max(0, view.length - 1), c };
      drawSel();
    } else if (num && e.button === 0) {
      const r = +num.dataset.r;
      anchor = { r: e.shiftKey ? anchor.r : r, c: 0 }; cur = { r, c: width() - 1 };
      drawSel();
    }
    grid.focus({ preventScroll: true });
  });
  grid.addEventListener("pointermove", (e) => {
    if (!dragSel) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest(".csv-td");
    if (el && grid.contains(el)) { const r = +el.parentElement.dataset.r, c = +el.dataset.c; if (r !== cur.r || c !== cur.c) { cur = { r, c }; drawSel(); } }
  });
  grid.addEventListener("pointerup", () => { dragSel = false; });
  grid.addEventListener("dblclick", (e) => { if (e.target.closest(".csv-td")) startEdit(); else if (e.target.closest(".csv-rz")) autoFit(+e.target.closest(".csv-rz").dataset.c); });
  const inSel = (r, c) => r >= Math.min(cur.r, anchor.r) && r <= Math.max(cur.r, anchor.r) && c >= Math.min(cur.c, anchor.c) && c <= Math.max(cur.c, anchor.c);

  grid.addEventListener("keydown", (e) => {
    if (editing) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const page = Math.max(1, Math.floor(grid.clientHeight / ROW_H) - 2);
    if (mod && (k === "z" || k === "Z") && !e.shiftKey) { e.preventDefault(); io.undo(false); return; }
    if (mod && (k === "y" || ((k === "z" || k === "Z") && e.shiftKey))) { e.preventDefault(); io.undo(true); return; }
    if (mod && k === "c") { e.preventDefault(); actions.copy(); return; }
    if (mod && k === "x") { e.preventDefault(); actions.cut(); return; }
    if (mod && k === "v") { e.preventDefault(); actions.paste(); return; }
    if (mod && k === "a") { e.preventDefault(); anchor = { r: 0, c: 0 }; cur = { r: view.length - 1, c: width() - 1 }; drawSel(); return; }
    if (mod && k === "Enter") { e.preventDefault(); actions["row-below"](); return; }
    if (mod && k === "-") { e.preventDefault(); actions["del-rows"](); return; }
    if (mod && k === "f") { e.preventDefault(); $(".csv-filter").focus(); return; }
    const ext = e.shiftKey;
    const moves = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] };
    if (moves[k]) {
      e.preventDefault();
      const [dr, dc] = moves[k];
      if (mod) select(dr > 0 ? view.length - 1 : dr < 0 ? 0 : cur.r, dc > 0 ? width() - 1 : dc < 0 ? 0 : cur.c, ext);
      else select(Math.max(0, Math.min(view.length - 1, cur.r + dr)), Math.max(0, Math.min(width() - 1, cur.c + dc)), ext);
      return;
    }
    if (k === "PageDown" || k === "PageUp") { e.preventDefault(); select(Math.max(0, Math.min(view.length - 1, cur.r + (k === "PageDown" ? page : -page))), cur.c, ext); return; }
    if (k === "Home") { e.preventDefault(); select(mod ? 0 : cur.r, 0, ext); return; }
    if (k === "End") { e.preventDefault(); select(mod ? view.length - 1 : cur.r, width() - 1, ext); return; }
    if (k === "Tab") { e.preventDefault(); move(0, e.shiftKey ? -1 : 1); return; }
    if (k === "Enter" || k === "F2") { e.preventDefault(); startEdit(); return; }
    if (k === "Delete" || k === "Backspace") { e.preventDefault(); actions.clear(); return; }
    if (k.length === 1 && !mod && !e.altKey) { e.preventDefault(); startEdit(k); }
  });

  // context menu
  grid.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const items = [
      ["row-above", "Insert row above"], ["row-below", "Insert row below"], ["col-left", "Insert column left"], ["col-right", "Insert column right"], null,
      ["del-rows", selRows().length > 1 ? `Delete ${selRows().length} rows` : "Delete row"], ["del-cols", selCols().length > 1 ? `Delete ${selCols().length} columns` : "Delete column"], null,
      ["sort-asc", `Sort by ${colTitle(cur.c)} A→Z`], ["sort-desc", `Sort by ${colTitle(cur.c)} Z→A`], null,
      ["cut", "Cut", "Ctrl+X"], ["copy", "Copy", "Ctrl+C"], ["paste", "Paste", "Ctrl+V"], ["clear", "Clear", "Del"],
    ];
    showMenu(e.clientX, e.clientY, items);
  });
  function showMenu(x, y, items) {
    document.querySelector(".csv-menu")?.remove();
    const m = document.createElement("div");
    m.className = "csv-menu pmenu";
    m.innerHTML = items.map((it) => (it ? `<button data-a="${it[0]}"><span>${esc(it[1])}</span>${it[2] ? `<kbd>${it[2]}</kbd>` : ""}</button>` : `<hr>`)).join("");
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, innerWidth - r.width - 6) + "px";
    m.style.top = Math.min(y, innerHeight - r.height - 6) + "px";
    const close = (ev) => { if (!ev || !m.contains(ev.target)) { m.remove(); removeEventListener("pointerdown", close, true); } };
    addEventListener("pointerdown", close, true);
    m.addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (!b) return; close(); actions[b.dataset.a]?.(); grid.focus({ preventScroll: true }); });
  }

  // column resize
  function startResize(e, c) {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, w0 = widths[c];
    const mv = (ev) => { widths[c] = Math.max(40, Math.round(w0 + ev.clientX - x0)); offs = [0]; for (const x of widths) offs.push(offs[offs.length - 1] + x); t.csvWidths = [...widths]; invalidate(); schedule(); };
    const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); document.body.classList.remove("srt-active"); };
    document.body.classList.add("srt-active");
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  }
  function autoFit(c) {
    let m = 3;
    for (const r of model.rows.slice(0, 2000)) { const s = r.cells[c]; if (s) m = Math.max(m, Math.min(80, s.length)); }
    widths[c] = Math.round(Math.max(48, m * 7.4 + 20));
    t.csvWidths = [...widths];
    computeOffs(); invalidate(); schedule();
  }
  const computeOffs = () => { offs = [0]; for (const x of widths) offs.push(offs[offs.length - 1] + x); };

  // drag a row number / column title to move it
  sortable(nums, {
    item: ".csv-num", axis: "y",
    drop: (el, toVr) => {
      const from = view[+el.dataset.r];
      const to = toVr >= view.length ? model.rows.length : view[toVr];
      if (from === undefined || to === from || to === from + 1) return;
      moveRow(from, to);
    },
  });
  sortable(headRow, {
    item: ".csv-th", axis: "x", ignore: ".csv-rz",
    drop: (el, to) => {
      const ths = [...headRow.querySelectorAll(".csv-th")];
      const from = +el.dataset.c;
      const toC = to >= ths.length ? +ths[ths.length - 1].dataset.c + 1 : +ths[to].dataset.c;
      if (toC === from || toC === from + 1) return;
      moveCol(from, toC);
    },
  });

  // toolbar
  host.querySelector(".csv-bar").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-a]");
    if (b) { actions[b.dataset.a]?.(); grid.focus({ preventScroll: true }); }
  });
  const hb = host.querySelector('[data-a="header"]');
  hb.addEventListener("change", () => { t.csvHeader = hb.checked; computeView(); invalidate(); select(0, cur.c); });
  const ds = host.querySelector('[data-a="delim"]');
  ds.addEventListener("change", () => { t.delim = ds.value === "tab" ? "\t" : ds.value; t.csvWidths = null; io.onDelim?.(t.delim); sync(true); invalidate(); select(0, 0); });
  let ft = 0;
  host.querySelector(".csv-filter").addEventListener("input", (e) => {
    clearTimeout(ft);
    ft = setTimeout(() => { filter = e.target.value.trim(); computeView(); invalidate(); grid.scrollTop = 0; select(0, cur.c); }, 120);
  });

  function refresh(force = false) {
    if (sync(force)) { invalidate(); }
    hb.checked = hasHeader();
    ds.value = delim() === "\t" ? "tab" : delim();
    schedule();
  }
  refresh(true);
  enter(grid, "fade", { duration: 160 });

  // ---------- split view: scrolling together with the source ----------
  grid.addEventListener("scroll", () => io.onScroll?.(), { passive: true });
  /** The first row at or after model row `ri` that the table shows. */
  const viewIndexOf = (ri) => { let lo = 0, hi = view.length; while (lo < hi) { const m = (lo + hi) >> 1; if (view[m] < ri) lo = m + 1; else hi = m; } return lo; };
  const rowAtOffset = (pos) => { let lo = 0, hi = model.rows.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (model.rows[m].from <= pos) lo = m; else hi = m - 1; } return lo; };
  const lineSpan = (row) => { const a = modelDoc.lineAt(row.from).number, b = modelDoc.lineAt(Math.max(row.from, row.to)).number; return [a, b - a + 1]; };

  return {
    refresh,
    scroller: grid,
    /** The scrollTop that shows source line `line` (fractional) at the top. */
    topFor(line) {
      sync();
      if (!model.rows.length) return 0;
      const n = Math.max(1, Math.min(modelDoc.lines, Math.floor(line)));
      const ri = rowAtOffset(modelDoc.line(n).from);
      const vr = viewIndexOf(ri);
      if (vr >= view.length) return view.length * ROW_H;
      if (view[vr] !== ri) return vr * ROW_H; // header or a filtered-out row: the next one shown
      const [l0, span] = lineSpan(model.rows[ri]);
      return (vr + Math.max(0, Math.min(1, (line - l0) / span))) * ROW_H;
    },
    /** The source line (fractional) of the table's top edge. */
    topLine() {
      if (!model?.rows.length || !view.length) return 1;
      const f = grid.scrollTop / ROW_H, vr = Math.min(view.length - 1, Math.floor(f));
      const [l0, span] = lineSpan(model.rows[view[vr]]);
      return l0 + (f - vr) * span;
    },
    /** Follow the cursor of the source editor. */
    reveal(pos) {
      if (editing || !model) return;
      sync();
      const at = cellAt(pos);
      if (!at) return;
      const vr = view.indexOf(at.ri);
      if (vr < 0) return;
      cur = { r: vr, c: Math.min(at.c, width() - 1) }; anchor = { ...cur };
      drawSel();
      scrollIntoView(cur.r, cur.c);
      schedule();
    },
    focus: () => grid.focus({ preventScroll: true }),
    destroy() { ro.disconnect(); cancelAnimationFrame(raf); host.innerHTML = ""; },
    get tab() { return t; },
  };
}
