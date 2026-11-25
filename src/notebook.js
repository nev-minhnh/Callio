// Jupyter notebooks (.ipynb): cells with their outputs, edited here and RUN on a kernel (local
// Python or a remote Jupyter server — see jupyter.js, loaded the first time a notebook opens).
// The notebook JSON stays the tab's text (so saving, history, AI and diffing work as for
// any file); edits and outputs here re-serialise it the way Jupyter writes it (1-space indent,
// sorted keys). Nothing is written to disk until the author saves.
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import { mdToHtml } from "./md.js";
import { ic } from "./icons.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const src = (v) => (Array.isArray(v) ? v.join("") : String(v ?? ""));
/** "a\nb\n" → ["a\n", "b\n"] (how Jupyter stores multi-line strings). */
export const lines = (s) => (s ? s.match(/[^\n]*\n|[^\n]+$/g) || [] : []);
export { src };

// ---------------- terminal text: \r and \b overwrite, ANSI colours become spans ----------------
/** Carriage return / backspace like a terminal (progress bars redraw one line). */
export function applyCR(s) {
  if (!/[\r\b]/.test(s)) return s;
  return s.split("\n").map((line) => {
    if (!/[\r\b]/.test(line)) return line;
    const cur = []; let pos = 0;
    for (const ch of line) { if (ch === "\r") pos = 0; else if (ch === "\b") pos = Math.max(0, pos - 1); else cur[pos++] = ch; }
    return cur.join("");
  }).join("\n");
}
const xterm = (n) => {
  if (n < 16) return null;
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  n -= 16; const c = (x) => (x ? 55 + x * 40 : 0);
  return `rgb(${c(Math.floor(n / 36))},${c(Math.floor(n / 6) % 6)},${c(n % 6)})`;
};
/** ANSI-coloured text → HTML (escaped). Standard colours are classes (themed), 256/RGB inline. */
export function ansiHtml(text) {
  const s = applyCR(String(text ?? ""));
  const re = /\x1b\[([0-9;:]*)m|\x1b\[[0-9;?]*[A-Za-ln-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
  let out = "", last = 0, m;
  let st = { fg: null, bg: null, b: false, d: false, i: false, u: false };
  const span = (t) => {
    if (!t) return "";
    const cls = [], sty = [];
    if (st.fg != null) { if (typeof st.fg === "number") cls.push("a-fg" + st.fg); else sty.push("color:" + st.fg); }
    if (st.bg != null) { if (typeof st.bg === "number") cls.push("a-bg" + st.bg); else sty.push("background:" + st.bg); }
    if (st.b) cls.push("a-b"); if (st.d) cls.push("a-d"); if (st.i) cls.push("a-i"); if (st.u) cls.push("a-u");
    if (!cls.length && !sty.length) return esc(t);
    return `<span${cls.length ? ` class="${cls.join(" ")}"` : ""}${sty.length ? ` style="${sty.join(";")}"` : ""}>${esc(t)}</span>`;
  };
  while ((m = re.exec(s))) {
    out += span(s.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] === undefined) continue; // some other escape: drop it
    const p = m[1] === "" ? [0] : m[1].split(/[;:]/).map((x) => +x || 0);
    for (let k = 0; k < p.length; k++) {
      const c = p[k];
      if (c === 0) st = { fg: null, bg: null, b: false, d: false, i: false, u: false };
      else if (c === 1) st.b = true; else if (c === 2) st.d = true; else if (c === 3) st.i = true; else if (c === 4) st.u = true;
      else if (c === 22) { st.b = false; st.d = false; } else if (c === 23) st.i = false; else if (c === 24) st.u = false;
      else if (c >= 30 && c <= 37) st.fg = c - 30; else if (c >= 90 && c <= 97) st.fg = c - 90 + 8; else if (c === 39) st.fg = null;
      else if (c >= 40 && c <= 47) st.bg = c - 40; else if (c >= 100 && c <= 107) st.bg = c - 100 + 8; else if (c === 49) st.bg = null;
      else if ((c === 38 || c === 48) && p[k + 1] === 5) { const n = p[k + 2] | 0; const v = n < 16 ? n : xterm(n); if (c === 38) st.fg = v; else st.bg = v; k += 2; }
      else if ((c === 38 || c === 48) && p[k + 1] === 2) { const v = `rgb(${p[k + 2] | 0},${p[k + 3] | 0},${p[k + 4] | 0})`; if (c === 38) st.fg = v; else st.bg = v; k += 4; }
    }
  }
  return out + span(s.slice(last));
}
/** Plain text without colour codes (for AI context and the MCP tools). */
export const stripAnsi = (s) => applyCR(String(s ?? "")).replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

export function parse(text) {
  const nb = JSON.parse(text);
  if (!nb || typeof nb !== "object" || !Array.isArray(nb.cells)) {
    // nbformat 3 kept cells in worksheets
    if (nb?.worksheets?.[0]?.cells) throw new Error("This is an old (v3) notebook. Open and save it once in Jupyter to convert it to v4.");
    throw new Error("Not a Jupyter notebook (no cells)");
  }
  return nb;
}

/** Jupyter's own layout: json.dumps(nb, indent=1, sort_keys=True, ensure_ascii=False) + "\n". */
export function serialize(nb) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    return v;
  };
  return JSON.stringify(sort(nb), null, 1) + "\n";
}

function language(nb) {
  return (nb.metadata?.language_info?.name || nb.metadata?.kernelspec?.language || "python").toLowerCase();
}
function highlight(code, lang) {
  if (lang && hljs.getLanguage(lang)) { try { return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch {} }
  return esc(code);
}


// no inline styles (an output could cover the window) and no remote pictures (opening a
// notebook must not contact a server)
const SAFE = { FORBID_TAGS: ["style", "form", "iframe", "object", "embed", "base", "meta", "link", "script", "video", "audio", "source"], FORBID_ATTR: ["srcset", "style", "background", "poster"] };
const noRemote = (html) => html.replace(/<img\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:)?\/\/[^>]*>/gi, '<span class="nb-note">[remote image not loaded]</span>');
const b64 = (v) => esc(src(v).replace(/\s/g, ""));

/** A block of text output; long ones are cut after `maxLines` with a "Show all" button. */
function textBlock(cls, text, opts, k, toHtml = ansiHtml) {
  const flat = applyCR(text);
  const max = opts.maxLines | 0;
  if (max > 0) {
    const ls = flat.split("\n");
    if (ls.length > max + 5 && !opts.expanded?.(k)) {
      return `<div class="nb-clip"><pre class="${cls}">${toHtml(ls.slice(0, max).join("\n"))}</pre><button class="small nb-more" data-nb="more" data-k="${esc(k)}">Show all (${ls.length} lines)</button></div>`;
    }
  }
  return `<pre class="${cls}">${toHtml(flat)}</pre>`;
}

/**
 * One output as HTML. opts: { maxLines, expanded(key), trustHtml (default true) }; `k` identifies
 * the output inside its cell (for "Show all").
 */
export function outputHtml(o, dir, opts = {}, k = "0") {
  if (!o || typeof o !== "object") return "";
  if (o.output_type === "stream") return textBlock(`nb-stream${o.name === "stderr" ? " err" : ""}`, src(o.text), opts, k);
  if (o.output_type === "error") {
    const tb = (o.traceback || []).join("\n");
    return textBlock("nb-error", tb.trim() ? tb : `${o.ename || "Error"}: ${o.evalue || ""}`, opts, k);
  }
  const d = o.data || {};
  const trust = opts.trustHtml !== false;
  // richest first, as Jupyter picks them
  if (d["text/html"] && trust) return `<div class="nb-html">${noRemote(DOMPurify.sanitize(src(d["text/html"]), SAFE))}</div>`;
  if (d["image/svg+xml"]) return `<div class="nb-svg">${DOMPurify.sanitize(src(d["image/svg+xml"]), { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["style", "image", "foreignObject"], FORBID_ATTR: ["style"] })}</div>`;
  if (d["image/png"]) return `<img class="nb-img" alt="" src="data:image/png;base64,${b64(d["image/png"])}">`;
  if (d["image/jpeg"]) return `<img class="nb-img" alt="" src="data:image/jpeg;base64,${b64(d["image/jpeg"])}">`;
  if (d["image/gif"]) return `<img class="nb-img" alt="" src="data:image/gif;base64,${b64(d["image/gif"])}">`;
  if (d["text/markdown"]) return `<div class="nb-md markdown-body">${mdToHtml(src(d["text/markdown"]), dir)}</div>`;
  if (d["text/latex"]) {
    const t = src(d["text/latex"]).trim();
    return `<div class="nb-md markdown-body">${mdToHtml(/^\$|^\\\[|^\\begin/.test(t) ? t.replace(/^\\\[|\\\]$/g, "$$$$") : `$$${t}$$`, dir)}</div>`;
  }
  if (d["application/json"]) return textBlock("nb-stream", JSON.stringify(d["application/json"], null, 2), opts, k, esc);
  if (d["text/plain"]) return textBlock("nb-stream", src(d["text/plain"]), opts, k);
  const kinds = Object.keys(d);
  return kinds.length ? `<div class="nb-note">(output: ${esc(kinds.join(", "))} — not shown)</div>` : "";
}
const outputsHtml = (c, dir, opts) => (c.outputs || []).map((o, k) => outputHtml(o, dir, opts, `${c.id || ""}:${k}`)).join("");

/** Read-only HTML for printing (Export to PDF). */
export async function notebookHtml(text, dir) {
  const nb = parse(text);
  const lang = language(nb);
  let html = "";
  for (const c of nb.cells) {
    const s = src(c.source);
    if (c.cell_type === "markdown") html += `<div class="nb-cell md">${mdToHtml(s, dir)}</div>`;
    else if (c.cell_type === "code") {
      const n = c.execution_count == null ? " " : c.execution_count;
      html += `<div class="nb-cell code"><div class="nb-in"><span class="nb-prompt">In [${esc(n)}]:</span><pre class="hljs"><code>${highlight(s, lang)}</code></pre></div>`;
      const outs = outputsHtml(c, dir, {});
      if (outs) html += `<div class="nb-out">${outs}</div>`;
      html += `</div>`;
    } else html += `<pre class="nb-raw">${esc(s)}</pre>`;
  }
  return `<style>
.nb-cell { margin: 0 0 12px; break-inside: auto; }
.nb-in { display: flex; gap: 8px; align-items: flex-start; }
.nb-prompt { color: #3060a0; font: 9pt Consolas, monospace; min-width: 52px; padding-top: 7px; }
.nb-in pre { flex: 1; margin: 0; padding: 6px 8px; background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 4px; white-space: pre-wrap; overflow-wrap: anywhere; font: 9pt/1.4 Consolas, "Cascadia Mono", monospace; }
.nb-out { margin: 4px 0 0 60px; }
.nb-stream, .nb-error, .nb-raw { margin: 2px 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 9pt/1.35 Consolas, monospace; }
.nb-stream.err { background: #fff0f0; color: #a00; padding: 4px 6px; }
.nb-error { background: #fff7f7; padding: 4px 6px; }
.a-fg0 { color: #000 } .a-fg1 { color: #c00 } .a-fg2 { color: #080 } .a-fg3 { color: #970 } .a-fg4 { color: #00c } .a-fg5 { color: #a0a } .a-fg6 { color: #088 } .a-fg7 { color: #666 }
.a-fg8 { color: #555 } .a-fg9 { color: #e33 } .a-fg10 { color: #2a2 } .a-fg11 { color: #b80 } .a-fg12 { color: #33e } .a-fg13 { color: #c3c } .a-fg14 { color: #0aa } .a-fg15 { color: #333 }
.a-b { font-weight: bold } .a-u { text-decoration: underline } .a-i { font-style: italic } .a-d { opacity: .7 }
.nb-img { max-width: 100%; }
.nb-html table { border-collapse: collapse; font-size: 9pt; } .nb-html td, .nb-html th { border: 1px solid #ccc; padding: 2px 6px; }
.nb-note { color: #888; font-size: 9pt; }
</style>${html}`;
}

// ---------------- the editable view ----------------
/** The mounted notebook for each key (path, or the tab for an untitled one): a running kernel
 *  keeps feeding the newest one, even while another tab is shown. */
const live = new Map();
export const liveNotebook = (key) => live.get(key) || null;
export const liveNotebooks = () => [...live.values()].filter((c) => !c.dead);
let cellClip = null; // cut / copied cell (c, x, v in command mode)

const newId = (taken) => {
  let id;
  do id = Math.random().toString(16).slice(2, 10).padEnd(8, "0"); while (taken?.has(id));
  return id;
};
const KEYS_HELP = `Keyboard (like Jupyter)
Shift+Enter  run cell and select next
Ctrl+Enter  run cell
Alt+Enter  run cell and insert below
Ctrl+Shift+Enter  run all
Esc  command mode · Enter  edit mode
Up/Down or K/J  select cell
A / B  insert cell above / below
D D  delete cell · C / X / V  copy / cut / paste cell
M / Y / R  markdown / code / raw cell
Shift+M  merge with the cell below
Ctrl+Shift+-  split cell at the cursor
I I  interrupt · 0 0  restart kernel
Tab  complete · Shift+Tab  help`;

/**
 * Show `text` in `el`. `onChange(newText)` gets the re-serialised notebook after each edit or
 * output. Returns the controller: update(text) refreshes from outside changes (undo, reload, AI
 * edits), flush()/sync() commit what is being typed, `host` is what jupyter.js drives.
 */
export function mountNotebook(el, text, { dir = "", path = "", key = "", onChange, onRaw, getSettings } = {}) {
  let nb, lang = "python", editing = null, sel = 0, mode = "cmd", ext = null;
  let commitT = 0, pendingCommit = false, lastKey = ["", 0];
  const state = { text };
  const st = () => getSettings?.() || {};
  const ctl = { dead: false, key: key || path || "", path, dir };
  const visible = () => el._nbOwner === ctl && !ctl.dead;

  // a controller of the same notebook that was still alive hands its newest text over
  const prev = ctl.key ? live.get(ctl.key) : null;
  if (prev && prev !== ctl) { prev.retire(); if (prev.text !== text && prev.hadChanges()) { state.text = prev.text; setTimeout(() => onChange?.(state.text), 0); } }
  if (ctl.key) live.set(ctl.key, ctl);

  function doCommit() {
    clearTimeout(commitT); commitT = 0; pendingCommit = false;
    if (!nb || ctl.dead) return;
    const t = serialize(nb); state.text = t; onChange?.(t);
  }
  const commit = () => doCommit();
  /** Outputs arrive fast: write them into the tab at most every 400 ms. */
  const commitSoon = () => { if (ctl.dead) return; pendingCommit = true; if (!commitT) commitT = setTimeout(doCommit, 400); };

  const outOpts = () => ({ maxLines: st().jupyterMaxLines ?? 200, trustHtml: st().jupyterTrustHtml !== false, expanded: (k) => expanded.has(k) });
  const expanded = new Set();

  // ----- toolbar slot + cells -----
  function header() {
    return `<div class="nb-bar"><div class="jp-tb" role="toolbar" aria-label="Notebook"></div><span class="nb-spacer"></span>
      <button class="small" data-nb="add-md">＋ Text</button><button class="small" data-nb="add-code">＋ Code</button>
      <button class="small" data-nb="raw" title="Show or hide the notebook's JSON next to it">{ } JSON</button>
      <button class="small" data-nb="keys" title="${esc(KEYS_HELP)}" aria-label="Keyboard shortcuts">⌨</button></div>`;
  }
  const promptHtml = (c) => {
    const r = ext?.cellRun(c);
    const n = r ? "*" : c.execution_count == null ? " " : c.execution_count;
    let t = "";
    if (r?.state === "running") t = `<small class="nb-time live" data-t0="${r.t0}">0.0 s</small>`;
    else if (!r) { const ms = ext?.elapsed(c); if (ms != null) t = `<small class="nb-time">${fmtMs(ms)}</small>`; }
    return `[${esc(n)}]${t}`;
  };
  const fmtMs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`);
  const runCls = (c) => { const r = c.cell_type === "code" ? ext?.cellRun(c) : null; return r ? ` ${r.state}` : ""; };

  function cellHtml(c, i) {
    const s = src(c.source);
    const code = c.cell_type === "code";
    const tools = `<div class="nb-tools">${code ? `<button class="icon small" data-nb="run" title="Run cell (Ctrl+Enter)">${ic("play")}</button><button class="icon small" data-nb="ai" title="Ask AI to write this cell">${ic("sparkles")}</button>` : ""}<select data-nb="type" title="Cell type"><option value="code"${c.cell_type === "code" ? " selected" : ""}>Code</option><option value="markdown"${c.cell_type === "markdown" ? " selected" : ""}>Markdown</option><option value="raw"${c.cell_type === "raw" ? " selected" : ""}>Raw</option></select>
      <button class="icon small" data-nb="up" title="Move up">${ic("arrow-up")}</button><button class="icon small" data-nb="down" title="Move down">${ic("arrow-down")}</button>
      <button class="icon small" data-nb="below-code" title="Insert code cell below">${ic("plus")}</button><button class="icon small" data-nb="below-md" title="Insert text cell below">¶</button>
      ${c.outputs?.length ? `<button class="icon small" data-nb="clear-one" title="Clear this cell's output">${ic("eraser")}</button>` : ""}
      <button class="icon small" data-nb="del" title="Delete cell">${ic("trash")}</button></div>`;
    const cls = `${i === sel ? " sel" : ""}`;
    if (c.cell_type === "markdown") {
      return `<div class="nb-cell md${cls}" data-i="${i}">${tools}<div class="nb-mdv markdown-body" title="Double-click to edit">${s.trim() ? mdToHtml(s, dir) : `<p class="nb-ph">Empty text cell — double-click to write</p>`}</div></div>`;
    }
    if (code) {
      const outs = outputsHtml(c, dir, outOpts());
      const empty = !s.trim() && !outs;
      return `<div class="nb-cell code${cls}${runCls(c)}" data-i="${i}">${tools}<div class="nb-in"><span class="nb-prompt">${promptHtml(c)}</span><pre class="nb-src hljs" title="Click to edit"><code>${highlight(s, lang) || " "}</code></pre></div>${empty ? `<div class="nb-hint"><button class="small" data-nb="ai">${ic("sparkles")} Ask AI to write this cell</button><span>Shift+Enter run · Esc then A/B add a cell</span></div>` : ""}${outs ? `<div class="nb-out">${outs}</div>` : ""}</div>`;
    }
    return `<div class="nb-cell raw${cls}" data-i="${i}">${tools}<pre class="nb-src nb-rawsrc" title="Click to edit">${esc(s) || " "}</pre></div>`;
  }
  function render() {
    if (ctl.dead) return;
    editing = null;
    let body;
    try { nb = parse(state.text); lang = language(nb); if (sel >= nb.cells.length) sel = Math.max(0, nb.cells.length - 1); body = header() + nb.cells.map(cellHtml).join("") + `<div class="nb-end"><button class="small" data-nb="add-code">＋ Code</button><button class="small" data-nb="add-md">＋ Text</button></div>`; }
    catch (e) { nb = null; body = `<div class="nb-bad"><b>Can't show this notebook.</b><p>${esc(e.message)}</p><button class="small" data-nb="raw">Edit the JSON</button></div>`; }
    const top = el.scrollTop;
    el.innerHTML = body;
    el._nbOwner = ctl;
    el.tabIndex = 0;
    el.scrollTop = top;
    ext?.paintBar();
  }

  /** Refresh one cell's prompt, state and outputs without touching its editor (live output). */
  const dirtyCells = new Set();
  let paintRaf = 0;
  function paintCell(id) {
    if (!visible() || !nb) return;
    const i = nb.cells.findIndex((c) => c.id === id);
    const cellEl = i < 0 ? null : el.querySelector(`.nb-cell[data-i="${i}"]`);
    if (!cellEl) return;
    const c = nb.cells[i];
    cellEl.classList.toggle("running", ext?.cellRun(c)?.state === "running");
    cellEl.classList.toggle("queued", ext?.cellRun(c)?.state === "queued");
    const pr = cellEl.querySelector(".nb-prompt");
    if (pr) pr.innerHTML = promptHtml(c);
    const outs = outputsHtml(c, dir, outOpts());
    let out = cellEl.querySelector(":scope > .nb-out");
    if (outs) {
      if (!out) { out = document.createElement("div"); out.className = "nb-out"; (cellEl.querySelector(":scope > .nb-stdin") || null) ? cellEl.querySelector(":scope > .nb-stdin").before(out) : cellEl.appendChild(out); }
      if (out._html !== outs) { out.innerHTML = outs; out._html = outs; }
    } else out?.remove();
    cellEl.querySelector(":scope > .nb-hint")?.remove();
    const hasClear = cellEl.querySelector('[data-nb="clear-one"]');
    if (!!c.outputs?.length !== !!hasClear) { const tl = cellEl.querySelector(".nb-tools"); if (tl) { const t = document.createElement("div"); t.innerHTML = cellHtml(c, i); tl.replaceWith(t.firstElementChild.querySelector(".nb-tools")); } }
  }
  const schedulePaint = (id) => { dirtyCells.add(id); if (!paintRaf) paintRaf = requestAnimationFrame(() => { paintRaf = 0; const ids = [...dirtyCells]; dirtyCells.clear(); ids.forEach(paintCell); }); };

  // nbformat 4.5+ gives every cell an id
  const hasIds = () => nb.nbformat > 4 || nb.nbformat_minor >= 5 || nb.cells.some((x) => x.id);
  const withId = (c) => (hasIds() ? { id: newId(new Set(nb.cells.map((x) => x.id))), ...c } : c);
  /** Before running: every cell gets an id (a notebook written by older Jupyter has none). */
  function ensureIds() {
    if (!nb) return;
    const taken = new Set(nb.cells.map((c) => c.id).filter(Boolean));
    let changed = false;
    for (const c of nb.cells) if (!c.id) { c.id = newId(taken); taken.add(c.id); changed = true; }
    if (changed && nb.nbformat === 4 && (nb.nbformat_minor || 0) < 5) nb.nbformat_minor = 5;
    if (changed) commit();
  }
  const newCell = (type) => withId(type === "markdown"
    ? { cell_type: "markdown", metadata: {}, source: [] }
    : type === "raw" ? { cell_type: "raw", metadata: {}, source: [] }
    : { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: [] });

  // ----- selection / modes -----
  function select(i, { focus = true, scroll = true } = {}) {
    if (!nb || !nb.cells.length) return;
    i = Math.max(0, Math.min(nb.cells.length - 1, i));
    sel = i;
    for (const e of el.querySelectorAll(".nb-cell.sel")) e.classList.remove("sel");
    const ce = el.querySelector(`.nb-cell[data-i="${i}"]`);
    ce?.classList.add("sel");
    if (scroll) ce?.scrollIntoView({ block: "nearest" });
    if (focus && !editing) el.focus({ preventScroll: true });
    ext?.selected(i);
  }
  function setMode(m) { mode = m; el.classList.toggle("nb-editmode", m === "edit"); }

  function startEdit(cellEl) {
    if (!nb) return;
    const i = +cellEl.dataset.i, c = nb.cells[i];
    if (!c || editing?.i === i) return;
    finishEdit();
    const target = cellEl.querySelector(".nb-mdv, .nb-src");
    const ta = document.createElement("textarea");
    ta.className = "nb-edit" + (c.cell_type === "markdown" ? "" : " mono");
    ta.spellcheck = c.cell_type === "markdown";
    ta.value = src(c.source);
    target.replaceWith(ta);
    const fit = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; };
    fit();
    ta.addEventListener("input", () => { fit(); c.source = lines(ta.value); clearTimeout(editing?.t); editing.t = setTimeout(commit, 350); });
    ta.addEventListener("keydown", (e) => editKey(e, ta, i, c));
    ta.addEventListener("blur", () => setTimeout(() => { if (editing?.ta === ta && document.activeElement !== ta && !ext?.popupOpen()) finishEdit(); }, 120));
    editing = { i, ta, t: 0 };
    select(i, { focus: false });
    setMode("edit");
    ta.focus();
  }
  function finishEdit() {
    if (!editing) return;
    const { i, ta, t } = editing;
    editing = null;
    setMode("cmd");
    ext?.closePopup();
    clearTimeout(t);
    const c = nb?.cells[i];
    if (!c) return;
    const before = src(c.source);
    c.source = lines(ta.value);
    if (src(c.source) !== before || t) commit();
    const old = ta.closest(".nb-cell");
    if (old?.isConnected) {
      const tmp = document.createElement("div");
      tmp.innerHTML = cellHtml(c, i);
      old.replaceWith(tmp.firstElementChild);
    }
  }
  function structural(fn) {
    finishEdit();
    fn();
    commit();
    render();
  }
  function insertAt(i, type, source = "") {
    let at = i;
    structural(() => { const c = newCell(type); if (source) c.source = lines(source); nb.cells.splice(i, 0, c); });
    select(at, { focus: false });
    return nb.cells[at];
  }
  const cellCount = () => nb?.cells.length || 0;

  // ----- running (jupyter.js does the work) -----
  async function runKey(i, how) { // how: "next" | "stay" | "insert"
    if (!nb) return;
    const c = nb.cells[i];
    if (!c) return;
    finishEdit();
    if (c.cell_type === "code") {
      ensureIds();
      const id = nb.cells[i].id;
      const p = ext ? ext.run([id]) : Promise.resolve();
      if (how === "insert") { insertAt(i + 1, "code"); const n = el.querySelector(`.nb-cell[data-i="${i + 1}"]`); if (n) startEdit(n); }
      else if (how === "next") advance(i);
      await p;
    } else if (how === "insert") { insertAt(i + 1, "code"); const n = el.querySelector(`.nb-cell[data-i="${i + 1}"]`); if (n) startEdit(n); }
    else if (how === "next") advance(i);
  }
  function advance(i) {
    if (i + 1 < cellCount()) select(i + 1);
    else { insertAt(cellCount(), "code"); }
  }

  // ----- keyboard -----
  function editKey(e, ta, i, c) {
    const mod = e.ctrlKey || e.metaKey;
    if (ext?.popupKey(e, ta)) return;
    if (e.key === "Escape") { e.preventDefault(); finishEdit(); select(i); return; }
    if (e.key === "Enter" && e.shiftKey && !mod) { e.preventDefault(); runKey(i, "next"); return; }
    if (e.key === "Enter" && mod && e.shiftKey) { e.preventDefault(); finishEdit(); ext?.runAll(); return; }
    if (e.key === "Enter" && mod) { e.preventDefault(); runKey(i, "stay"); return; }
    if (e.key === "Enter" && e.altKey) { e.preventDefault(); runKey(i, "insert"); return; }
    if (mod && e.shiftKey && (e.key === "-" || e.key === "_")) { e.preventDefault(); splitAt(i, ta.selectionStart); return; }
    if (e.key === "Tab" && c.cell_type === "code" && !mod && !e.altKey) {
      if (ext?.tab(ta, i, e.shiftKey)) { e.preventDefault(); return; }
      if (e.shiftKey) return;
    }
    if (e.key === "Tab" && c.cell_type !== "markdown") {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b } = ta;
      ta.setRangeText("    ", a, b, "end");
      ta.dispatchEvent(new Event("input"));
    }
  }
  function splitAt(i, pos) {
    const c = nb.cells[i];
    const full = editing?.i === i ? editing.ta.value : src(c.source);
    const a = full.slice(0, pos).replace(/\n$/, ""), b = full.slice(pos).replace(/^\n/, "");
    finishEdit();
    structural(() => {
      c.source = lines(a);
      const n = newCell(c.cell_type); n.source = lines(b);
      if (c.cell_type === "code") { c.outputs = []; c.execution_count = null; }
      nb.cells.splice(i + 1, 0, n);
    });
    select(i + 1, { focus: false });
  }
  function cmdKey(e) {
    if (!nb) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const kl = k.length === 1 ? k.toLowerCase() : k;
    const twice = (ch) => { const now = Date.now(); const hit = lastKey[0] === ch && now - lastKey[1] < 700; lastKey = hit ? ["", 0] : [ch, now]; return hit; };
    if (k === "Enter" && mod && e.shiftKey) { e.preventDefault(); return ext?.runAll(); }
    if (k === "Enter" && mod) { e.preventDefault(); return runKey(sel, "stay"); }
    if (mod && !e.shiftKey && (kl === "a" || kl === "c" || kl === "v" || kl === "x" || kl === "z" || kl === "s")) return; // leave the app's shortcuts alone
    if (mod || e.altKey && k !== "Enter") return;
    if (k === "Enter" && e.shiftKey) { e.preventDefault(); return runKey(sel, "next"); }
    if (k === "Enter" && e.altKey) { e.preventDefault(); return runKey(sel, "insert"); }
    if (k === "Enter") { e.preventDefault(); const ce = el.querySelector(`.nb-cell[data-i="${sel}"]`); if (ce) startEdit(ce); return; }
    if (k === "ArrowUp" || kl === "k") { e.preventDefault(); return select(sel - 1); }
    if (k === "ArrowDown" || kl === "j") { e.preventDefault(); return select(sel + 1); }
    if (e.shiftKey && kl === "m") { e.preventDefault(); return mergeBelow(sel); }
    if (e.shiftKey) return;
    if (kl === "a") { e.preventDefault(); insertAt(sel, "code"); return; }
    if (kl === "b") { e.preventDefault(); insertAt(sel + 1, "code"); return; }
    if (kl === "d") { e.preventDefault(); if (twice("d")) deleteCell(sel); return; }
    if (kl === "m" || kl === "y" || kl === "r") { e.preventDefault(); return convert(sel, kl === "m" ? "markdown" : kl === "y" ? "code" : "raw"); }
    if (kl === "c") { e.preventDefault(); cellClip = JSON.parse(JSON.stringify(nb.cells[sel])); return; }
    if (kl === "x") { e.preventDefault(); cellClip = JSON.parse(JSON.stringify(nb.cells[sel])); return deleteCell(sel); }
    if (kl === "v") { e.preventDefault(); if (!cellClip) return; const n = JSON.parse(JSON.stringify(cellClip)); if (hasIds()) n.id = newId(new Set(nb.cells.map((x) => x.id))); else delete n.id; structural(() => nb.cells.splice(sel + 1, 0, n)); return select(sel + 1); }
    if (kl === "0") { e.preventDefault(); if (twice("0")) ext?.restart(); return; }
    if (kl === "i") { e.preventDefault(); if (twice("i")) ext?.interrupt(); return; }
  }
  function deleteCell(i) { if (!nb?.cells[i]) return; structural(() => nb.cells.splice(i, 1)); select(i); }
  function convert(i, to) {
    structural(() => {
      const c = nb.cells[i], next = newCell(to);
      next.metadata = c.metadata || {}; next.source = c.source;
      if (to === "code") { next.execution_count = null; next.outputs = []; }
      if (c.id) next.id = c.id; else delete next.id;
      nb.cells[i] = next;
    });
    select(i);
  }
  function mergeBelow(i) {
    if (!nb.cells[i + 1]) return;
    structural(() => {
      const a = nb.cells[i], b = nb.cells[i + 1];
      a.source = lines(src(a.source).replace(/\n?$/, "\n") + src(b.source));
      nb.cells.splice(i + 1, 1);
    });
    select(i);
  }
  el.onkeydown = (e) => {
    if (!visible() || e.target.closest("textarea, input, select, [contenteditable]") || e.defaultPrevented) return;
    if (e.target.tagName === "BUTTON" && (e.key === "Enter" || e.key === " ")) return;
    cmdKey(e);
  };

  // ----- clicks -----
  el.onclick = (e) => {
    const b = e.target.closest("[data-nb]");
    const cellEl = e.target.closest(".nb-cell");
    if (cellEl && !editing && nb) select(+cellEl.dataset.i, { focus: false, scroll: false });
    if (b && (b.tagName === "BUTTON")) {
      const act = b.dataset.nb;
      if (act === "raw") return onRaw?.();
      if (act === "keys") return;
      if (!nb) return;
      const i = cellEl ? +cellEl.dataset.i : -1;
      if (act === "more") { expanded.add(b.dataset.k); const c = nb.cells[i]; if (c?.id) paintCell(c.id); return; }
      if (act === "add-code" || act === "add-md") return structural(() => nb.cells.push(newCell(act === "add-md" ? "markdown" : "code")));
      if (i < 0) return;
      if (act === "run") return runKey(i, "stay");
      if (act === "ai") return ext?.askAI(i);
      if (act === "up" && i > 0) return structural(() => nb.cells.splice(i - 1, 0, nb.cells.splice(i, 1)[0]));
      if (act === "down" && i < nb.cells.length - 1) return structural(() => nb.cells.splice(i + 1, 0, nb.cells.splice(i, 1)[0]));
      if (act === "below-code" || act === "below-md") {
        structural(() => nb.cells.splice(i + 1, 0, newCell(act === "below-md" ? "markdown" : "code")));
        const n = el.querySelector(`.nb-cell[data-i="${i + 1}"]`);
        if (n) startEdit(n);
        return;
      }
      if (act === "clear-one") return structural(() => { nb.cells[i].outputs = []; nb.cells[i].execution_count = null; });
      if (act === "del") return structural(() => nb.cells.splice(i, 1));
      return;
    }
    if (cellEl && e.target.closest(".nb-src")) startEdit(cellEl);
  };
  el.ondblclick = (e) => {
    const cellEl = e.target.closest(".nb-cell.md");
    if (cellEl && e.target.closest(".nb-mdv")) { e.preventDefault(); startEdit(cellEl); }
  };
  el.onchange = (e) => {
    const sel2 = e.target.closest("select[data-nb=type]");
    if (!sel2 || !nb) return;
    convert(+sel2.closest(".nb-cell").dataset.i, sel2.value);
  };
  // links in markdown cells and HTML outputs never navigate the app: web links open in the
  // browser, #anchors scroll, anything else is ignored
  if (!el._nbLinks) {
    el._nbLinks = true;
    el.addEventListener("click", (e) => {
      const a = e.target.closest("a[href]");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href") || "";
      if (/^https?:/i.test(href)) import("./api.js").then((m) => m.api.openUrl(a.href));
      else if (href.startsWith("#")) { try { el.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView(); } catch {} }
    }, true);
    el.addEventListener("submit", (e) => e.preventDefault(), true);
  }

  // what jupyter.js drives
  ctl.host = {
    el, key: ctl.key, path, dir,
    get nb() { return nb; },
    settings: st,
    visible, commit, commitSoon, ensureIds, paintCell: schedulePaint, repaintAll: () => render(),
    sync: () => ctl.sync(), findCell: (id) => { const i = nb?.cells.findIndex((c) => c.id === id) ?? -1; return i < 0 ? null : { c: nb.cells[i], i }; },
    selected: () => sel, select, insertAt, deleteCell, cellCount,
    setSource(i, source) { structural(() => { nb.cells[i].source = lines(source); }); },
    expand: (k) => expanded.add(k),
    editing: () => editing,
  };
  render();
  import("./jupyter.js").then((m) => { if (!ctl.dead) { ext = m.attach(ctl.host); ctl.ext = ext; render(); } }).catch((e) => console.error("jupyter.js", e));

  Object.assign(ctl, {
    /** Outside change (undo in the JSON, reload, AI edit): re-render unless it is our own. */
    update(t) { if (t === state.text) return; state.text = t; render(); },
    flush() { finishEdit(); if (pendingCommit) doCommit(); },
    /** Commit what is being typed without leaving the cell (before saving). */
    sync() {
      if (pendingCommit) doCommit();
      if (!editing || !nb) return;
      const c = nb.cells[editing.i];
      if (!c) return;
      clearTimeout(editing.t); editing.t = 0;
      const v = lines(editing.ta.value);
      if (src(v) !== src(c.source) || state.text !== serialize(nb)) { c.source = v; commit(); }
    },
    /** A newer controller for the same notebook takes over: stop writing into the tab. */
    retire() { if (pendingCommit) doCommit(); ctl.dead = true; clearTimeout(commitT); ext?.dispose?.(); if (el._nbOwner === ctl) el._nbOwner = null; },
    hadChanges: () => state.text !== text,
  });
  Object.defineProperty(ctl, "text", { get: () => state.text }); // (Object.assign would copy the value, not the getter)
  return ctl;
}
