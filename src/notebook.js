// Jupyter notebooks (.ipynb): view cells with their outputs and edit cell text, add, move,
// delete cells and clear outputs. Nothing is executed — there is no kernel.
// The notebook JSON stays the tab's text (so saving, history, AI and diffing work as for
// any file); edits here re-serialise it the way Jupyter writes it (1-space indent, sorted keys).
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import { mdToHtml } from "./md.js";
import { ic } from "./icons.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ansi = (s) => String(s ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
const src = (v) => (Array.isArray(v) ? v.join("") : String(v ?? ""));
/** "a\nb\n" → ["a\n", "b\n"] (how Jupyter stores multi-line strings). */
const lines = (s) => (s ? s.match(/[^\n]*\n|[^\n]+$/g) || [] : []);

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
function outputHtml(o, dir) {
  if (!o || typeof o !== "object") return "";
  if (o.output_type === "stream") return `<pre class="nb-stream${o.name === "stderr" ? " err" : ""}">${esc(ansi(src(o.text)))}</pre>`;
  if (o.output_type === "error") return `<pre class="nb-error"><b>${esc(o.ename)}</b>: ${esc(o.evalue)}\n${esc(ansi((o.traceback || []).join("\n")))}</pre>`;
  const d = o.data || {};
  if (d["image/png"]) return `<img class="nb-img" alt="" src="data:image/png;base64,${esc(src(d["image/png"]).replace(/\s/g, ""))}">`;
  if (d["image/jpeg"]) return `<img class="nb-img" alt="" src="data:image/jpeg;base64,${esc(src(d["image/jpeg"]).replace(/\s/g, ""))}">`;
  if (d["image/gif"]) return `<img class="nb-img" alt="" src="data:image/gif;base64,${esc(src(d["image/gif"]).replace(/\s/g, ""))}">`;
  if (d["image/svg+xml"]) return `<div class="nb-svg">${DOMPurify.sanitize(src(d["image/svg+xml"]), { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["style", "image", "foreignObject"], FORBID_ATTR: ["style"] })}</div>`;
  if (d["text/html"]) return `<div class="nb-html">${noRemote(DOMPurify.sanitize(src(d["text/html"]), SAFE))}</div>`;
  if (d["text/markdown"]) return `<div class="nb-md markdown-body">${mdToHtml(src(d["text/markdown"]), dir)}</div>`;
  if (d["text/latex"]) {
    const t = src(d["text/latex"]).trim();
    return `<div class="nb-md markdown-body">${mdToHtml(/^\$|^\\\[|^\\begin/.test(t) ? t.replace(/^\\\[|\\\]$/g, "$$$$") : `$$${t}$$`, dir)}</div>`;
  }
  if (d["application/json"]) return `<pre class="nb-stream">${esc(JSON.stringify(d["application/json"], null, 2))}</pre>`;
  if (d["text/plain"]) return `<pre class="nb-stream">${esc(ansi(src(d["text/plain"])))}</pre>`;
  const kinds = Object.keys(d);
  return kinds.length ? `<div class="nb-note">(output: ${esc(kinds.join(", "))} — not shown)</div>` : "";
}

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
      const outs = (c.outputs || []).map((o) => outputHtml(o, dir)).join("");
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
.nb-stream.err, .nb-error { background: #fff0f0; color: #a00; padding: 4px 6px; }
.nb-img { max-width: 100%; }
.nb-html table { border-collapse: collapse; font-size: 9pt; } .nb-html td, .nb-html th { border: 1px solid #ccc; padding: 2px 6px; }
.nb-note { color: #888; font-size: 9pt; }
</style>${html}`;
}

// ---------------- the editable view ----------------
/**
 * Show `text` in `el`. `onChange(newText)` gets the re-serialised notebook after each edit.
 * Returns { update(text) } to refresh from outside changes (undo, reload, AI edits).
 */
export function mountNotebook(el, text, { dir = "", onChange, onRaw } = {}) {
  let nb, lang = "python", editing = null;
  const commit = () => { const t = serialize(nb); state.text = t; onChange?.(t); };
  const state = { text };

  function header() {
    const k = nb.metadata?.kernelspec?.display_name || nb.metadata?.kernelspec?.name || lang;
    const outs = nb.cells.some((c) => c.outputs?.length);
    return `<div class="nb-bar"><span class="nb-kernel" title="Callio shows and edits notebooks; it doesn't run code">📓 ${esc(k)} · ${nb.cells.length} cell${nb.cells.length === 1 ? "" : "s"} · view &amp; edit only</span>
      <button class="small" data-nb="add-md">＋ Text</button><button class="small" data-nb="add-code">＋ Code</button>
      ${outs ? `<button class="small" data-nb="clear" title="Remove all outputs from the notebook">Clear outputs</button>` : ""}
      <button class="small" data-nb="raw" title="Show or hide the notebook's JSON next to it">{ } JSON</button></div>`;
  }
  function cellHtml(c, i) {
    const s = src(c.source);
    const tools = `<div class="nb-tools"><select data-nb="type" title="Cell type"><option value="code"${c.cell_type === "code" ? " selected" : ""}>Code</option><option value="markdown"${c.cell_type === "markdown" ? " selected" : ""}>Markdown</option><option value="raw"${c.cell_type === "raw" ? " selected" : ""}>Raw</option></select>
      <button class="icon small" data-nb="up" title="Move up">${ic("arrow-up")}</button><button class="icon small" data-nb="down" title="Move down">${ic("arrow-down")}</button>
      <button class="icon small" data-nb="below-code" title="Insert code cell below">${ic("plus")}</button><button class="icon small" data-nb="below-md" title="Insert text cell below">¶</button>
      ${c.outputs?.length ? `<button class="icon small" data-nb="clear-one" title="Clear this cell's output">${ic("eraser")}</button>` : ""}
      <button class="icon small" data-nb="del" title="Delete cell">${ic("trash")}</button></div>`;
    if (c.cell_type === "markdown") {
      return `<div class="nb-cell md" data-i="${i}">${tools}<div class="nb-mdv markdown-body" title="Double-click to edit">${s.trim() ? mdToHtml(s, dir) : `<p class="nb-ph">Empty text cell — double-click to write</p>`}</div></div>`;
    }
    if (c.cell_type === "code") {
      const n = c.execution_count == null ? " " : c.execution_count;
      const outs = (c.outputs || []).map((o) => outputHtml(o, dir)).join("");
      return `<div class="nb-cell code" data-i="${i}">${tools}<div class="nb-in"><span class="nb-prompt">[${esc(n)}]</span><pre class="nb-src hljs" title="Click to edit"><code>${highlight(s, lang) || " "}</code></pre></div>${outs ? `<div class="nb-out">${outs}</div>` : ""}</div>`;
    }
    return `<div class="nb-cell raw" data-i="${i}">${tools}<pre class="nb-src nb-rawsrc" title="Click to edit">${esc(s) || " "}</pre></div>`;
  }
  function render() {
    editing = null;
    let body;
    try { nb = parse(state.text); lang = language(nb); body = header() + nb.cells.map(cellHtml).join("") + `<div class="nb-end"><button class="small" data-nb="add-code">＋ Code</button><button class="small" data-nb="add-md">＋ Text</button></div>`; }
    catch (e) { nb = null; body = `<div class="nb-bad"><b>Can't show this notebook.</b><p>${esc(e.message)}</p><button class="small" data-nb="raw">Edit the JSON</button></div>`; }
    const top = el.scrollTop;
    el.innerHTML = body;
    el.scrollTop = top;
  }
  // nbformat 4.5+ gives every cell an id
  const withId = (c) => ((nb.nbformat > 4 || nb.nbformat_minor >= 5 || nb.cells.some((x) => x.id)) ? { id: Math.random().toString(16).slice(2, 10).padEnd(8, "0"), ...c } : c);
  const newCell = (type) => withId(type === "markdown"
    ? { cell_type: "markdown", metadata: {}, source: [] }
    : type === "raw" ? { cell_type: "raw", metadata: {}, source: [] }
    : { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: [] });

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
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || (e.key === "Enter" && e.shiftKey)) { e.preventDefault(); finishEdit(); }
      else if (e.key === "Tab" && c.cell_type !== "markdown") {
        e.preventDefault();
        const { selectionStart: a, selectionEnd: b } = ta;
        ta.setRangeText("    ", a, b, "end");
        ta.dispatchEvent(new Event("input"));
      }
    });
    ta.addEventListener("blur", () => setTimeout(() => { if (editing?.ta === ta && document.activeElement !== ta) finishEdit(); }, 120));
    editing = { i, ta, t: 0 };
    ta.focus();
  }
  function finishEdit() {
    if (!editing) return;
    const { i, ta, t } = editing;
    editing = null;
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

  el.onclick = (e) => {
    const b = e.target.closest("[data-nb]");
    const cellEl = e.target.closest(".nb-cell");
    if (b && b.tagName === "BUTTON") {
      const act = b.dataset.nb;
      if (act === "raw") return onRaw?.();
      if (!nb) return;
      const i = cellEl ? +cellEl.dataset.i : -1;
      if (act === "add-code" || act === "add-md") return structural(() => nb.cells.push(newCell(act === "add-md" ? "markdown" : "code")));
      if (act === "clear") return structural(() => nb.cells.forEach((c) => { if (c.cell_type === "code") { c.outputs = []; c.execution_count = null; } }));
      if (i < 0) return;
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
    const sel = e.target.closest("select[data-nb=type]");
    if (!sel || !nb) return;
    const i = +sel.closest(".nb-cell").dataset.i;
    structural(() => {
      const c = nb.cells[i], s = c.source, to = sel.value;
      const next = newCell(to);
      delete next.id;
      next.metadata = c.metadata || {};
      next.source = s;
      if (c.id) next.id = c.id;
      nb.cells[i] = next;
    });
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

  render();
  return {
    /** Outside change (undo in the JSON, reload, AI edit): re-render unless it is our own. */
    update(t) { if (t === state.text) return; state.text = t; render(); },
    flush() { finishEdit(); },
    /** Commit what is being typed without leaving the cell (before saving). */
    sync() {
      if (!editing || !nb) return;
      const c = nb.cells[editing.i];
      if (!c) return;
      clearTimeout(editing.t); editing.t = 0;
      const v = lines(editing.ta.value);
      if (src(v) !== src(c.source) || state.text !== serialize(nb)) { c.source = v; commit(); }
    },
    get text() { return state.text; },
  };
}
