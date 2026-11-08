// Node views: how math, raw source, figures, chips, title lines, environments ... look and
// how they are edited (popovers / inline source editors). DOM only, loaded with the editor.
import katex from "katex";
import hljs from "highlight.js/lib/common";
import latexLang from "highlight.js/lib/languages/latex";
import { NodeSelection, TextSelection, Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { TableView } from "prosemirror-tables";
import { schema } from "./schema.js";

if (!hljs.getLanguage("latex")) hljs.registerLanguage("latex", latexLang);

const S = schema.nodes;
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// ---------------- KaTeX ----------------
// rendered math, per set of macros (each document's preamble can define its own)
const mathCaches = new WeakMap();
const noMacros = {};
export function renderKatex(tex, display, macros) {
  const m = macros || noMacros;
  let cache = mathCaches.get(m);
  if (!cache) { cache = new Map(); mathCaches.set(m, cache); }
  const key = (display ? "D" : "I") + tex;
  let v = cache.get(key);
  if (v === undefined) {
    try {
      v = { html: katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: "ignore", trust: false, macros: { ...m }, maxExpand: 500 }) };
    } catch (e) {
      v = { error: String(e.message || e).replace(/^KaTeX parse error: /, "") };
    }
    if (cache.size > 5000) cache.clear();
    cache.set(key, v);
  }
  return v;
}

/** Split a math body at top-level \\ (rows). */
function splitRows(body) {
  const rows = [];
  let depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "\\") {
      if (body.startsWith("\\begin", i)) depth++;
      else if (body.startsWith("\\end", i)) depth--;
      else if (body[i + 1] === "\\" && depth === 0) { rows.push(body.slice(start, i)); start = i + 2; i++; continue; }
      i++;
    }
  }
  rows.push(body.slice(start));
  return rows;
}
const NUMBERED = { equation: "single", align: "rows", gather: "rows", multline: "single", flalign: "rows", alignat: "rows", eqnarray: "rows", dmath: "single" };
/** How many equation numbers a display-math node takes. */
export function eqCount(attrs) {
  const env = attrs.env;
  if (!env || !NUMBERED[env]) return 0;
  const body = attrs.tex;
  if (NUMBERED[env] === "single") return /\\(nonumber|notag)\b/.test(body) ? 0 : 1;
  return splitRows(body).filter((r) => r.trim() && !/\\(nonumber|notag)\b/.test(r)).length;
}
/** Labels in a display-math node, with the row they're on (for \eqref numbers). */
export function eqLabels(attrs) {
  const env = attrs.env;
  const out = [];
  if (!env || !NUMBERED[env]) return out;
  if (NUMBERED[env] === "single") { for (const m of attrs.tex.matchAll(/\\label\{([^{}]*)\}/g)) out.push({ label: m[1], row: 0 }); return out; }
  let n = 0;
  for (const r of splitRows(attrs.tex)) {
    if (!r.trim()) continue;
    const numbered = !/\\(nonumber|notag)\b/.test(r);
    for (const m of r.matchAll(/\\label\{([^{}]*)\}/g)) out.push({ label: m[1], row: numbered ? n : n - 1 });
    if (numbered) n++;
  }
  return out;
}
/** KaTeX input for a display-math node, numbered from `first`. */
function katexSource(attrs, first) {
  const env = attrs.env;
  let body = attrs.tex.replace(/\\label\{[^{}]*\}/g, "");
  if (!env || env === "$$" || env === "\\[" || env === "displaymath" || env === "math") return body;
  const base = env.replace(/\*$/, "");
  const numbered = !env.endsWith("*") && first != null;
  const strip = (r) => r.replace(/\\(nonumber|notag)\b/g, "");
  if (base === "equation" || base === "dmath") {
    return numbered && !/\\(nonumber|notag)\b/.test(body) ? strip(body) + `\\tag{${first}}` : strip(body);
  }
  if (base === "subequations") return body;
  let inner = { align: "align*", flalign: "align*", eqnarray: "align*", gather: "gather*", multline: "gather*", alignat: "alignat*" }[base] || base + "*";
  if (base === "alignat") inner = "alignat*";
  const rows = splitRows(body);
  let n = first;
  const tagged = rows.map((r, i) => {
    if (!numbered || !r.trim()) return strip(r);
    if (base === "multline") return i === rows.length - 1 ? strip(r) + `\\tag{${first}}` : strip(r);
    if (/\\(nonumber|notag)\b/.test(r)) return strip(r);
    return r + `\\tag{${n++}}`;
  });
  if (base === "alignat") {
    const m = /\{(\d+)\}\s*$/.exec(attrs.open);
    return `\\begin{alignat*}{${m ? m[1] : 1}}${tagged.join("\\\\")}\\end{alignat*}`;
  }
  return `\\begin{${inner}}${tagged.join("\\\\")}\\end{${inner}}`;
}

// render math only when it scrolls near the viewport (a long paper opens instantly)
const observers = new WeakMap();
const pending = new WeakMap();
function lazy(el, fn, root) {
  if (typeof IntersectionObserver === "undefined" || !root) return fn();
  let io = observers.get(root);
  if (!io) {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { const f = pending.get(e.target); io.unobserve(e.target); if (f) { pending.delete(e.target); f(); } }
    }, { root, rootMargin: "1200px 0px" });
    observers.set(root, io);
  }
  pending.set(el, fn);
  io.observe(el);
}

// ---------------- popover ----------------
export class Popover {
  constructor(container) { this.container = container; this.el = null; this.owner = null; this.onDoc = this.onDoc.bind(this); }
  open(anchor, owner, build) {
    this.close();
    const el = h("div", "wy-pop");
    el.addEventListener("mousedown", (e) => e.stopPropagation());
    this.el = el;
    this.owner = owner;
    this.anchor = anchor;
    this.container.appendChild(el);
    const focus = build(el, () => this.close());
    this.place();
    document.addEventListener("mousedown", this.onDoc, true);
    if (focus) requestAnimationFrame(() => { focus.focus(); if (focus.select && focus.dataset.select !== "no") focus.select(); });
    return el;
  }
  place() {
    if (!this.el || !this.anchor || !this.anchor.isConnected) return;
    const c = this.container, r = this.anchor.getBoundingClientRect(), cr = c.getBoundingClientRect();
    const w = this.el.offsetWidth;
    let left = r.left - cr.left + c.scrollLeft;
    left = Math.max(8, Math.min(left, c.scrollLeft + c.clientWidth - w - 12));
    let top = r.bottom - cr.top + c.scrollTop + 6;
    if (r.bottom + this.el.offsetHeight + 12 > cr.bottom && r.top - cr.top > this.el.offsetHeight + 12) top = r.top - cr.top + c.scrollTop - this.el.offsetHeight - 6;
    this.el.style.left = left + "px";
    this.el.style.top = top + "px";
  }
  onDoc(e) { if (this.el && !this.el.contains(e.target) && !(this.anchor && this.anchor.contains(e.target))) this.close(); }
  close() {
    document.removeEventListener("mousedown", this.onDoc, true);
    if (this.el) { const f = this.onclose; this.onclose = null; this.el.remove(); this.el = null; this.owner = null; if (f) f(); }
  }
  isOpenFor(owner) { return this.el && this.owner === owner; }
}

/** Replace a node's attrs, keeping it selected. */
function setAttrs(view, pos, attrs, addToHistory = true) {
  const node = view.state.doc.nodeAt(pos);
  if (!node) return;
  const tr = view.state.tr.setNodeMarkup(pos, null, { ...node.attrs, ...attrs });
  if (view.state.selection instanceof NodeSelection && view.state.selection.from === pos) tr.setSelection(NodeSelection.create(tr.doc, pos));
  if (!addToHistory) tr.setMeta("addToHistory", false);
  view.dispatch(tr);
}
function exitAfter(view, pos) {
  const node = view.state.doc.nodeAt(pos);
  if (!node) return view.focus();
  const after = pos + node.nodeSize;
  const tr = view.state.tr;
  const $a = tr.doc.resolve(after);
  tr.setSelection(node.isInline ? TextSelection.create(tr.doc, after) : (TextSelection.findFrom($a, 1, true) || NodeSelection.create(tr.doc, pos)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}
function deleteNode(view, pos) {
  const node = view.state.doc.nodeAt(pos);
  if (node) view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
  view.focus();
}

/** A source editor in a popover for an atom's attribute. */
function sourcePopover(nv, { attr, title, multiline, placeholder, render, hint, deleteIfEmpty = true }) {
  const { view, getPos, ctx } = nv;
  ctx.popover.open(nv.dom, nv, (el, close) => {
    if (title) el.appendChild(h("div", "wy-pop-title", title));
    const input = multiline ? h("textarea", "wy-pop-input mono") : h("input", "wy-pop-input mono");
    if (!multiline) input.type = "text";
    input.spellcheck = false;
    input.value = nv.node.attrs[attr] || "";
    if (placeholder) input.placeholder = placeholder;
    if (multiline) input.rows = Math.min(10, Math.max(2, input.value.split("\n").length));
    el.appendChild(input);
    const err = h("div", "wy-pop-err");
    el.appendChild(err);
    if (hint) el.appendChild(h("div", "wy-pop-hint", hint));
    const showErr = () => { const e = render ? render(input.value) : null; err.textContent = e || ""; err.hidden = !e; };
    showErr();
    let first = true;
    input.addEventListener("input", () => {
      const pos = getPos();
      if (pos == null) return;
      setAttrs(view, pos, { [attr]: input.value }, first);
      first = false;
      showErr();
      ctx.popover.place();
    });
    const finish = () => {
      const pos = getPos();
      close();
      if (pos == null) return view.focus();
      if (deleteIfEmpty && !input.value.trim()) return deleteNode(view, pos);
      exitAfter(view, pos);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || (e.key === "Enter" && (!multiline || e.ctrlKey || e.metaKey))) { e.preventDefault(); finish(); }
      if (e.key === "Tab" && multiline) { e.preventDefault(); document.execCommand?.("insertText", false, "  "); }
    });
    return input;
  });
}

// ---------------- helpers ----------------
const ACC = { "'": "\u0301", "`": "\u0300", "^": "\u0302", '"': "\u0308", "~": "\u0303", "=": "\u0304", ".": "\u0307", c: "\u0327", v: "\u030C", u: "\u0306", H: "\u030B", r: "\u030A" };
export function texToPlain(s) {
  return String(s || "")
    .replace(/(^|[^\\])%.*$/gm, "$1")
    .replace(/\\today\b/g, new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }))
    .replace(/\\([`'^"~=.])\{?\\?([a-zA-Z])\}?|\\([cvuHr])\{\\?([a-zA-Z])\}/g, (m, a1, b1, a2, b2) => ((b1 || b2) === "i" && !/\{?\\i/.test(m) ? "i" : (b1 || b2)) + ACC[a1 || a2])
    .normalize("NFC")
    .replace(/\\\\(\[[^\]]*\])?/g, " · ")
    .replace(/\\and\b/g, " · ")
    .replace(/\\(thanks|footnote|corref|fnref|tnoteref|inst|IEEEauthorrefmark|orcidlink|orcid|thanksref|ead|label)\*?(\[[^\]]*\])?\{[^{}]*\}/g, "")
    .replace(/\\(textbf|textit|emph|textsc|texttt|underline|mbox|text)\{([^{}]*)\}/g, "$2")
    .replace(/\\([%&_#${}])/g, "$1")
    .replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?/g, "")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/``|''/g, '"')
    .replace(/---/g, "—").replace(/--/g, "–")
    .replace(/\s+/g, " ")
    .trim();
}
function resolvePath(ctx, p) {
  if (!p) return "";
  if (/^(https?:|data:|blob:)/i.test(p)) return p;
  let clean = p.split("#")[0].split("?")[0];
  try { clean = decodeURI(clean); } catch { /* literal % */ }
  const abs = /^([A-Za-z]:)?[\\/]/.test(clean) ? clean : (ctx.dir ? ctx.dir.replace(/[\\/]+$/, "") + "/" : "") + clean;
  const n = abs.replace(/\\/g, "/");
  return ctx.fileSrc ? ctx.fileSrc(n) : n;
}
/** <img> that tries each candidate path; falls back to a card. */
function imageEl(ctx, candidates, label, cls) {
  const wrap = h("span", cls);
  const card = () => {
    wrap.replaceChildren();
    wrap.classList.add("missing");
    const c = h("span", "wy-img-card");
    c.appendChild(h("span", "wy-img-ico", "🖼"));
    c.appendChild(h("span", "wy-img-name", label || "image"));
    wrap.appendChild(c);
  };
  if (!candidates.length) { card(); return wrap; }
  const img = document.createElement("img");
  img.alt = label || "";
  img.loading = "lazy";
  img.draggable = false;
  let i = 0;
  img.onerror = () => { i++; if (i < candidates.length) img.src = candidates[i]; else card(); };
  img.src = candidates[0];
  wrap.appendChild(img);
  return wrap;
}
function texImageCandidates(ctx, path) {
  if (/\.(pdf|eps|ps)$/i.test(path)) return [];
  const dirs = ["", ...(ctx.graphicsPaths || [])];
  const exts = /\.[a-z0-9]{2,4}$/i.test(path) ? [""] : [".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp"];
  const out = [];
  for (const d of dirs) for (const e of exts) out.push(resolvePath(ctx, d + path + e));
  return out;
}
const keysOf = (src, kind) => {
  if (kind === "md") return src.replace(/^\[|\]$/g, "").split(";").map((k) => k.trim()).join("; ");
  const m = /\{([^{}]*)\}\s*$/.exec(src);
  return m ? m[1].split(",").map((k) => k.trim()).join(", ") : src;
};

// ---------------- node views ----------------
class AtomView {
  constructor(node, view, getPos, ctx) {
    this.node = node; this.view = view; this.getPos = getPos; this.ctx = ctx;
  }
  update(node, decos) {
    if (node.type !== this.node.type) return false;
    const spec = specOf(decos);
    const changed = (node.attrs !== this.node.attrs && JSON.stringify(node.attrs) !== JSON.stringify(this.node.attrs)) || spec !== this.spec;
    this.node = node;
    this.spec = spec;
    if (changed) this.render();
    return true;
  }
  stopEvent(e) { return this.ctx.popover.el ? this.ctx.popover.el.contains(e.target) : false; }
  ignoreMutation() { return true; }
  selectNode() { this.dom.classList.add("ProseMirror-selectednode"); if (this.edit && !this.view.composing) this.edit(); }
  deselectNode() {
    this.dom.classList.remove("ProseMirror-selectednode");
    if (this.ctx.popover.isOpenFor(this) && !this.ctx.popover.el.contains(document.activeElement)) this.ctx.popover.close();
  }
  destroy() { if (this.ctx.popover.isOpenFor(this)) this.ctx.popover.close(); }
}

class MathInlineView extends AtomView {
  constructor(...a) { super(...a); this.dom = h("span", "wy-math"); this.dom.contentEditable = "false"; this.render(); }
  render() {
    const { tex, display } = this.node.attrs;
    this.dom.classList.toggle("display", !!display);
    const go = () => {
      const r = renderKatex(tex || "\\square", !!display, this.ctx.macros);
      this.dom.classList.toggle("err", !!r.error);
      if (r.html) this.dom.innerHTML = r.html; else this.dom.textContent = tex;
      this.dom.title = r.error || "";
      this.dom.classList.toggle("empty", !tex.trim());
    };
    if (this.rendered) go(); else { this.dom.textContent = tex; this.dom.classList.add("pending"); lazy(this.dom, () => { this.dom.classList.remove("pending"); this.rendered = true; go(); }, this.ctx.scroller); }
  }
  edit() {
    sourcePopover(this, {
      attr: "tex", title: "Math", placeholder: "x^2 + y^2", multiline: false,
      render: (v) => { const r = renderKatex(v || "x", false, this.ctx.macros); return r.error || null; },
      hint: "Enter to finish · Esc to close",
    });
  }
}

class MathDisplayView {
  constructor(node, view, getPos, ctx, decos) {
    this.node = node; this.view = view; this.getPos = getPos; this.ctx = ctx;
    this.dom = h("div", "wy-mathblock");
    this.dom.contentEditable = "false";
    this.out = h("div", "wy-mathblock-out");
    this.dom.appendChild(this.out);
    this.first = eqFirst(decos);
    this.render();
  }
  render() {
    const a = this.node.attrs;
    const labels = [...a.tex.matchAll(/\\label\{([^{}]*)\}/g)].map((m) => m[1]);
    const go = () => {
      const r = renderKatex(katexSource(a, this.first) || "\\square", true, this.ctx.macros);
      if (r.html) { this.out.innerHTML = r.html; this.out.classList.remove("err"); }
      else { this.out.replaceChildren(h("pre", "wy-math-src", a.tex.trim()), h("div", "wy-math-errmsg", r.error)); this.out.classList.add("err"); }
      if (labels.length) {
        const t = h("span", "wy-eq-labels");
        for (const l of labels) t.appendChild(h("span", "wy-chip label", l));
        this.out.appendChild(t);
      }
      this.dom.classList.toggle("empty", !a.tex.trim());
    };
    if (this.rendered) go();
    else {
      this.out.textContent = a.tex.trim();
      this.out.classList.add("pending");
      lazy(this.dom, () => { this.out.classList.remove("pending"); this.rendered = true; go(); }, this.ctx.scroller);
    }
  }
  update(node, decos) {
    if (node.type !== this.node.type) return false;
    const first = eqFirst(decos);
    const changed = node.attrs !== this.node.attrs || first !== this.first;
    this.node = node; this.first = first;
    if (changed) { this.render(); if (this.editor && document.activeElement !== this.ta) this.ta.value = this.bodyOf(); }
    return true;
  }
  bodyOf() { return this.node.attrs.tex.replace(/^\s*\n/, "").replace(/\s+$/, "").replace(/^ {2}/gm, (m) => (this.indent2 ? "" : m)); }
  selectNode() {
    this.dom.classList.add("ProseMirror-selectednode");
    if (this.editor) return;
    const ed = h("div", "wy-mathblock-ed");
    const a = this.node.attrs;
    // the body is edited without the env's leading newline/indent, which are kept as they were
    const lead = /^\s*/.exec(a.tex)[0], trail = /\s*$/.exec(a.tex.slice(lead.length))[0];
    this.lead = lead || (this.ctx.kind === "tex" && a.env && a.env !== "$$" ? "\n  " : "");
    this.trail = trail || (this.ctx.kind === "tex" && a.env && a.env !== "$$" ? "\n" : "");
    const ta = h("textarea", "wy-mathblock-ta mono");
    ta.spellcheck = false;
    ta.value = a.tex.slice(lead.length, a.tex.length - trail.length);
    ta.rows = 1;
    const fit = () => { ta.style.height = "auto"; ta.style.height = Math.min(320, ta.scrollHeight + 2) + "px"; };
    const bar = h("div", "wy-mathblock-bar");
    if (this.ctx.kind === "tex") {
      const sel = h("select", "wy-env-sel");
      const envs = ["equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "\\[ \\]"];
      const cur = a.env === "\\[" ? "\\[ \\]" : a.env;
      if (cur && !envs.includes(cur)) envs.unshift(cur);
      for (const e of envs) { const o = h("option", null, e); o.value = e; if (e === cur) o.selected = true; sel.appendChild(o); }
      sel.title = "Environment";
      sel.addEventListener("change", () => {
        const v = sel.value;
        const pos = this.getPos();
        if (pos == null) return;
        if (v === "\\[ \\]") setAttrs(this.view, pos, { env: "\\[", open: "\\[", close: "\\]" });
        else setAttrs(this.view, pos, { env: v, open: `\\begin{${v}}`, close: `\\end{${v}}` });
      });
      bar.appendChild(sel);
    }
    bar.appendChild(h("span", "wy-pop-hint", "Esc or Ctrl+Enter to finish"));
    const err = h("span", "wy-pop-err");
    bar.appendChild(err);
    ed.append(ta, bar);
    let first = true;
    ta.addEventListener("input", () => {
      const pos = this.getPos();
      if (pos == null) return;
      fit();
      setAttrs(this.view, pos, { tex: this.lead + ta.value + this.trail }, first);
      first = false;
      const r = renderKatex(katexSource(this.view.state.doc.nodeAt(pos).attrs, this.first) || "x", true, this.ctx.macros);
      err.textContent = r.error || "";
    });
    ta.addEventListener("keydown", (e) => {
      const pos = this.getPos();
      if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); this.close(); if (pos != null) exitAfter(this.view, pos); }
      else if (e.key === "ArrowUp" && ta.selectionStart === 0 && pos != null) { e.preventDefault(); this.close(); const $p = this.view.state.doc.resolve(pos); const s = TextSelection.findFrom($p, -1, true); if (s) this.view.dispatch(this.view.state.tr.setSelection(s)); this.view.focus(); }
      else if (e.key === "ArrowDown" && ta.selectionEnd === ta.value.length && pos != null) { e.preventDefault(); this.close(); exitAfter(this.view, pos); }
    });
    ta.addEventListener("blur", () => setTimeout(() => { if (this.editor && !this.dom.contains(document.activeElement) && !(this.view.state.selection instanceof NodeSelection && this.view.state.selection.from === this.getPos())) this.close(); }, 0));
    this.dom.appendChild(ed);
    this.editor = ed; this.ta = ta;
    requestAnimationFrame(() => { fit(); ta.focus(); });
  }
  close() { if (this.editor) { this.editor.remove(); this.editor = null; this.ta = null; } }
  deselectNode() { this.dom.classList.remove("ProseMirror-selectednode"); if (this.editor && !this.dom.contains(document.activeElement)) this.close(); }
  stopEvent(e) { return !!(this.editor && this.editor.contains(e.target)); }
  ignoreMutation() { return true; }
  destroy() {}
}
const eqFirst = (decos) => { for (const d of decos || []) if (d.spec && d.spec.eqn != null) return d.spec.eqn; return null; };

const specOf = (decos) => { for (const d of decos || []) if (d.spec && (d.spec.num != null || d.spec.target != null)) return d.spec.num ?? d.spec.target; return null; };
class ChipView extends AtomView {
  constructor(node, view, getPos, ctx, decos) { super(node, view, getPos, ctx); this.spec = specOf(decos); this.dom = h("span", "wy-chip"); this.dom.contentEditable = "false"; this.render(); }
  render() {
    const n = this.node, a = n.attrs, kind = this.ctx.kind;
    const d = this.dom;
    d.className = "wy-chip";
    d.title = "";
    switch (n.type.name) {
      case "cite":
        d.classList.add("cite");
        d.textContent = kind === "md" ? keysOf(a.src, "md").replace(/@/g, "") : "[" + keysOf(a.src, "tex") + "]";
        d.title = a.src;
        break;
      case "ref": {
        const m = /^\\([a-zA-Z]+)\*?(?:\[[^\]]*\])*\{([^{}]*)\}/.exec(a.src) || [];
        const cmd = m[1], key = m[2] || a.src;
        if (cmd === "label") { d.classList.add("label"); d.textContent = key; d.title = "\\label{" + key + "}"; }
        else if (this.spec != null) { d.className = "wy-ref"; d.textContent = this.spec; d.title = a.src; }
        else { d.classList.add("ref"); d.textContent = (cmd === "eqref" ? "(" + key + ")" : key); d.title = a.src + " — not found in this file"; }
        break;
      }
      case "footnote":
        d.classList.add("fn");
        d.textContent = this.spec != null ? this.spec : "*";
        d.title = texToPlain(a.body) || "(empty footnote)";
        break;
      case "footnote_ref":
        d.classList.add("fn");
        d.textContent = a.label;
        d.title = "Footnote " + a.label;
        break;
      case "raw_inline":
        d.classList.add("raw", a.kind || "raw");
        if (a.kind === "comment" && a.src.trim() === "%") { d.className = "wy-sym invisible"; d.textContent = ""; d.title = "% (line end)"; }
        else if (a.kind === "comment") { const c = a.src.replace(/\s+$/, ""); d.textContent = c.length > 48 ? c.slice(0, 46) + "…" : c; d.title = a.src; }
        else if (a.kind === "special") { d.textContent = a.src; d.title = "LaTeX special character"; }
        else { d.textContent = a.src.length > 60 ? a.src.slice(0, 57) + "…" : a.src; d.title = a.src; }
        break;
    }
  }
  edit() {
    const n = this.node;
    if (n.type === S.footnote) return sourcePopover(this, { attr: "body", title: "Footnote", multiline: true, placeholder: "Footnote text (LaTeX)", hint: "Ctrl+Enter to finish", deleteIfEmpty: false });
    if (n.type === S.footnote_ref) return;
    if (n.type === S.cite) return sourcePopover(this, { attr: "src", title: "Citation", placeholder: this.ctx.kind === "md" ? "[@key]" : "\\cite{key}" });
    if (n.type === S.ref) return sourcePopover(this, { attr: "src", title: /^\\label/.test(n.attrs.src) ? "Label" : "Cross-reference" });
    sourcePopover(this, { attr: "src", title: n.attrs.kind === "comment" ? "Comment" : this.ctx.kind === "md" ? "HTML" : "LaTeX", multiline: n.attrs.src.includes("\n") || n.attrs.src.length > 60 });
  }
}

class SymView extends AtomView {
  constructor(...a) { super(...a); this.dom = h("span", "wy-sym"); this.render(); }
  render() { this.dom.textContent = this.node.attrs.text; this.dom.title = this.node.attrs.src; this.dom.classList.toggle("invisible", this.node.attrs.text === "" || this.node.attrs.text === "\u00ad"); }
}

class ImageView extends AtomView {
  constructor(...a) { super(...a); this.dom = h("span", "wy-img-inline"); this.dom.contentEditable = "false"; this.render(); }
  render() {
    const a = this.node.attrs;
    const c = this.ctx.kind === "tex" ? texImageCandidates(this.ctx, a.src) : [resolvePath(this.ctx, a.src)];
    this.dom.replaceChildren(imageEl(this.ctx, c, a.src || a.alt, "wy-img"));
    this.dom.title = a.alt || a.src;
  }
  edit() {
    const { view, getPos, ctx } = this;
    if (ctx.kind === "tex") return sourcePopover(this, { attr: "tex", title: "Image (LaTeX)" });
    ctx.popover.open(this.dom, this, (el, close) => {
      el.appendChild(h("div", "wy-pop-title", "Image"));
      const mk = (label, attr, ph) => {
        const row = h("label", "wy-pop-row");
        row.appendChild(h("span", null, label));
        const i = h("input", "wy-pop-input"); i.type = "text"; i.value = this.node.attrs[attr] || ""; i.placeholder = ph;
        i.addEventListener("input", () => { const pos = getPos(); if (pos != null) setAttrs(view, pos, { [attr]: i.value }); });
        i.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); const pos = getPos(); close(); if (pos != null) exitAfter(view, pos); } });
        row.appendChild(i);
        el.appendChild(row);
        return i;
      };
      const first = mk("Path", "src", "images/figure.png");
      mk("Alt text", "alt", "Describe the image");
      return first;
    });
  }
}

class FigureImageView extends AtomView {
  constructor(...a) { super(...a); this.dom = h("div", "wy-fig-img"); this.dom.contentEditable = "false"; this.render(); }
  render() {
    const a = this.node.attrs;
    const el = imageEl(this.ctx, texImageCandidates(this.ctx, a.path), a.path + (/\.(pdf|eps)$/i.test(a.path) ? "  ·  PDF figure (shown when compiled)" : ""), "wy-img");
    const w = /width\s*=\s*([\d.]*)\s*\\(linewidth|textwidth|columnwidth|hsize)/.exec(a.opts || "");
    this.dom.style.width = w ? Math.min(100, parseFloat(w[1] || "1") * 100) + "%" : "";
    this.dom.replaceChildren(el);
    this.dom.title = (a.cmd || "") + (a.opts || "") + "{" + a.path + "}";
  }
  edit() {
    const { view, getPos, ctx } = this;
    ctx.popover.open(this.dom, this, (el, close) => {
      el.appendChild(h("div", "wy-pop-title", "Figure image"));
      const mk = (label, attr, ph) => {
        const row = h("label", "wy-pop-row");
        row.appendChild(h("span", null, label));
        const i = h("input", "wy-pop-input mono"); i.type = "text"; i.value = this.node.attrs[attr] || ""; i.placeholder = ph; i.spellcheck = false;
        i.addEventListener("input", () => { const pos = getPos(); if (pos != null) setAttrs(view, pos, { [attr]: i.value }); });
        i.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); const pos = getPos(); close(); if (pos != null) exitAfter(view, pos); } });
        row.appendChild(i);
        el.appendChild(row);
        return i;
      };
      const first = mk("File", "path", "figures/plot.pdf");
      mk("Options", "opts", "[width=0.8\\linewidth]");
      if (ctx.pickImage) {
        const b = h("button", "wy-pop-btn", "Choose file…");
        b.addEventListener("click", async () => {
          const p = await ctx.pickImage();
          const pos = getPos();
          if (p && pos != null) { setAttrs(view, pos, { path: ctx.relPath(p) }); first.value = ctx.relPath(p); }
        });
        el.appendChild(b);
      }
      return first;
    });
  }
}

const CMD_LABEL = {
  tableofcontents: ["☰", "Table of contents"], listoffigures: ["☰", "List of figures"], listoftables: ["☰", "List of tables"],
  newpage: ["", "Page break"], clearpage: ["", "Page break"], cleardoublepage: ["", "Page break"], pagebreak: ["", "Page break"],
  appendix: ["", "Appendix"], printbibliography: ["📚", "References"], bibliography: ["📚", "References"],
  bibliographystyle: ["", "Bibliography style"], input: ["📄", "Input"], include: ["📄", "Include"], addbibresource: ["📚", "Bibliography file"],
};
class TexCmdView extends AtomView {
  constructor(...a) { super(...a); this.dom = h("div", "wy-cmd"); this.dom.contentEditable = "false"; this.render(); }
  render() {
    const src = this.node.attrs.src;
    const m = /^\\([a-zA-Z]+)\*?/.exec(src);
    const name = m ? m[1] : "";
    const arg = (/\{([^{}]*)\}\s*$/.exec(src) || [])[1] || "";
    const d = this.dom;
    d.className = "wy-cmd";
    d.replaceChildren();
    d.title = src;
    if (name === "maketitle") {
      d.classList.add("maketitle");
      const meta = this.ctx.meta || {};
      if (meta.title) d.appendChild(h("div", "wy-mt-title", texToPlain(meta.title)));
      if (meta.author) d.appendChild(h("div", "wy-mt-author", texToPlain(meta.author)));
      if (meta.date !== undefined) d.appendChild(h("div", "wy-mt-date", texToPlain(meta.date) || ""));
      if (!meta.title && !meta.author) d.appendChild(h("div", "wy-cmd-label", "Title block (\\maketitle)"));
      return;
    }
    const lab = CMD_LABEL[name];
    if (lab) {
      d.classList.add("known", name);
      if (lab[0]) d.appendChild(h("span", "wy-cmd-ico", lab[0]));
      d.appendChild(h("span", "wy-cmd-label", lab[1]));
      if (arg && name !== "appendix") d.appendChild(h("span", "wy-cmd-arg", arg));
      return;
    }
    if (name === "affiliation" || name === "address") {
      d.classList.add("meta-like");
      d.appendChild(h("span", "wy-meta-tag", name === "affiliation" ? "Affiliation" : "Address"));
      const body = src.replace(/^\\[a-zA-Z]+(\[[^\]]*\])?\{/, "").replace(/\}\s*$/, "");
      d.appendChild(h("span", "wy-cmd-aff", body.replace(/\b[a-z]+\s*=\s*/g, "").replace(/[{}]/g, "").replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ").trim()));
      return;
    }
    d.classList.add("source");
    d.appendChild(h("code", null, src));
  }
  edit() { sourcePopover(this, { attr: "src", title: "LaTeX", multiline: this.node.attrs.src.includes("\n") || this.node.attrs.src.length > 50, hint: "Ctrl+Enter to finish" }); }
}

// ---- views with editable content ----
const RAW_TITLES = { preamble: "Document settings", comment: "Comment", html: "HTML", frontmatter: "Front matter", env: "LaTeX", raw: "LaTeX", md: "Markdown source" };
class RawBlockView {
  constructor(node, view, getPos, ctx) {
    this.node = node; this.ctx = ctx;
    const kind = node.attrs.kind;
    this.dom = h("div", "wy-raw kind-" + kind);
    this.head = h("div", "wy-raw-head");
    this.head.contentEditable = "false";
    this.pre = h("pre", "wy-raw-pre");
    this.contentDOM = h("code");
    this.pre.appendChild(this.contentDOM);
    this.dom.append(this.head, this.pre);
    if (kind === "preamble") {
      this.collapsed = true;
      this.dom.classList.add("collapsed");
      this.head.addEventListener("mousedown", (e) => { e.preventDefault(); this.collapsed = !this.collapsed; this.dom.classList.toggle("collapsed", this.collapsed); this.renderHead(); });
    }
    this.renderHead();
  }
  renderHead() {
    const kind = this.node.attrs.kind;
    this.head.replaceChildren();
    if (kind === "preamble") {
      this.head.appendChild(h("span", "wy-caret", this.collapsed ? "▸" : "▾"));
      this.head.appendChild(h("span", "wy-raw-title", "Document settings"));
      const t = this.node.textContent;
      const cls = (/\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/.exec(t) || [])[1];
      const pk = [...t.matchAll(/^[^%\n]*\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/gm)].reduce((n, m) => n + m[1].split(",").length, 0);
      this.head.appendChild(h("span", "wy-raw-sum", [cls && `${cls}`, pk && `${pk} package${pk === 1 ? "" : "s"}`, `${t.split("\n").length} lines`].filter(Boolean).join(" · ")));
      return;
    }
    if (kind === "comment") { this.head.hidden = true; return; }
    let title = RAW_TITLES[kind] || "Source";
    if (kind === "env") { const m = /^\s*\\begin\{([^}]+)\}/.exec(this.node.textContent); if (m) title = "LaTeX · " + m[1]; }
    this.head.appendChild(h("span", "wy-raw-title", title));
  }
  update(node) {
    if (node.type !== this.node.type || node.attrs.kind !== this.node.attrs.kind) return false;
    const headChanged = this.node.attrs.kind === "preamble" || this.node.attrs.kind === "env";
    this.node = node;
    if (headChanged) this.renderHead();
    return true;
  }
  ignoreMutation(m) { return !this.contentDOM.contains(m.target); }
}

class CodeBlockView {
  constructor(node, view, getPos, ctx) {
    this.node = node; this.view = view; this.getPos = getPos; this.ctx = ctx;
    this.dom = h("div", "wy-code");
    this.lang = h("button", "wy-code-lang");
    this.lang.contentEditable = "false";
    this.lang.addEventListener("mousedown", (e) => { e.preventDefault(); this.editLang(); });
    this.pre = h("pre");
    this.contentDOM = h("code");
    this.pre.appendChild(this.contentDOM);
    this.dom.append(this.lang, this.pre);
    this.render();
  }
  render() {
    const a = this.node.attrs;
    const env = a.open && (/\\begin\{([^}]+)\}/.exec(a.open) || [])[1];
    this.lang.textContent = (a.lang || (env ? env : "plain text"));
  }
  editLang() {
    if (this.ctx.kind === "tex") return;
    const fake = { node: this.node, view: this.view, getPos: this.getPos, ctx: this.ctx, dom: this.lang };
    sourcePopover(fake, { attr: "lang", title: "Language", placeholder: "python", deleteIfEmpty: false });
  }
  update(node) { if (node.type !== this.node.type) return false; const c = node.attrs !== this.node.attrs; this.node = node; if (c) this.render(); return true; }
  ignoreMutation(m) { return !this.contentDOM.contains(m.target); }
  stopEvent(e) { return this.lang.contains(e.target); }
}

class HeadingView {
  constructor(node, view, getPos, ctx) {
    this.node = node; this.view = view; this.getPos = getPos; this.ctx = ctx;
    this.dom = h("h" + node.attrs.level, "wy-h");
    this.contentDOM = h("span", "wy-h-text");
    this.dom.appendChild(this.contentDOM);
    this.render();
  }
  render() {
    const a = this.node.attrs;
    this.dom.classList.toggle("star", !!a.star);
    if (a.cmd) this.dom.dataset.cmd = a.cmd;
    if (this.chip) { this.chip.remove(); this.chip = null; }
    if (a.label != null) {
      const c = h("span", "wy-chip label", a.label);
      c.contentEditable = "false";
      c.title = "Label — click to edit";
      c.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const fake = { node: this.node, view: this.view, getPos: this.getPos, ctx: this.ctx, dom: c };
        sourcePopover(fake, { attr: "label", title: "Label", deleteIfEmpty: false });
      });
      this.chip = c;
      this.dom.appendChild(c);
    }
  }
  update(node) {
    if (node.type !== this.node.type || node.attrs.level !== this.node.attrs.level) return false;
    const c = node.attrs.label !== this.node.attrs.label || node.attrs.star !== this.node.attrs.star;
    this.node = node;
    if (c) this.render();
    return true;
  }
  ignoreMutation(m) { return !!(this.chip && this.chip.contains(m.target)); }
  stopEvent(e) { return !!(this.chip && this.chip.contains(e.target)); }
}

const META_TAGS = { title: "Title", subtitle: "Subtitle", author: "Author", date: "Date", affiliation: "Affiliation", address: "Address", institute: "Institute", ead: "Email", email: "Email", keywords: "Keywords", thanks: "Thanks", dedication: "Dedication", cortext: "Note", tnotetext: "Note", fntext: "Note" };
class MetaView {
  constructor(node) {
    this.node = node;
    this.dom = h("div", "wy-meta");
    this.dom.dataset.cmd = node.attrs.cmd;
    const tag = h("span", "wy-meta-tag", META_TAGS[node.attrs.cmd] || node.attrs.cmd);
    tag.contentEditable = "false";
    this.contentDOM = h("div", "wy-meta-body");
    this.dom.append(tag, this.contentDOM);
  }
  update(node) { if (node.type !== this.node.type || node.attrs.cmd !== this.node.attrs.cmd) return false; this.node = node; return true; }
  ignoreMutation(m) { return !this.contentDOM.contains(m.target); }
}

const ENV_TITLES = { abstract: "Abstract", proof: "Proof", keyword: "Keywords", keywords: "Keywords", IEEEkeywords: "Index Terms", acknowledgments: "Acknowledgments", acknowledgements: "Acknowledgements", acknowledgment: "Acknowledgment", highlights: "Highlights", graphicalabstract: "Graphical abstract" };
const THEOREMISH = new Set(["theorem", "lemma", "corollary", "proposition", "definition", "remark", "example", "claim", "conjecture", "assumption", "note", "notation", "observation", "fact", "exercise", "problem", "solution", "hypothesis"]);
class EnvView {
  constructor(node, view, getPos, ctx, decos) {
    this.node = node; this.ctx = ctx;
    const env = node.attrs.env.replace(/\*$/, "");
    this.dom = h("div", "wy-env");
    this.dom.dataset.env = env;
    const th = ctx.theorems && ctx.theorems.get(env);
    this.title = ENV_TITLES[env] || (th && th.title) || (THEOREMISH.has(env) ? env[0].toUpperCase() + env.slice(1) : null);
    this.inline = !!(th || THEOREMISH.has(env) || env === "proof" || env === "keyword" || env === "keywords" || env === "IEEEkeywords");
    if (th || THEOREMISH.has(env)) this.dom.classList.add("theorem");
    if (env === "proof" || (th && /proof/i.test(th.title))) this.dom.classList.add("proof");
    const opt = /^\\begin\{[^}]*\}\s*\[([^\]]*)\]/.exec(node.attrs.open);
    this.opt = opt ? texToPlain(opt[1]) : null;
    this.head = h("div", "wy-env-head");
    this.head.contentEditable = "false";
    this.contentDOM = h("div", "wy-env-body");
    this.dom.append(this.head, this.contentDOM);
    this.num = specOf(decos);
    this.render();
  }
  render() {
    const t = this.title ? this.title + (this.num != null ? " " + this.num : "") : null;
    if (this.inline) {
      // the title runs into the first paragraph, like LaTeX's theorem heads
      this.head.hidden = true;
      this.dom.style.setProperty("--wy-env-title", JSON.stringify(t ? t + (this.opt ? " (" + this.opt + ")" : "") + (this.dom.classList.contains("theorem") || this.dom.classList.contains("proof") ? "." : ":") : ""));
      return;
    }
    this.dom.style.setProperty("--wy-env-title", "none");
    this.head.replaceChildren();
    if (t) { this.head.appendChild(h("span", "wy-env-title", t)); if (this.opt) this.head.appendChild(h("span", "wy-env-opt", "(" + this.opt + ")")); }
    else this.head.hidden = true;
  }
  update(node, decos) {
    if (node.type !== this.node.type || node.attrs.open !== this.node.attrs.open) return false;
    this.node = node;
    const n = specOf(decos);
    if (n !== this.num) { this.num = n; this.render(); }
    return true;
  }
  ignoreMutation(m) { return !this.contentDOM.contains(m.target); }
}

class ListItemView {
  constructor(node, view, getPos, ctx) {
    this.node = node; this.view = view; this.getPos = getPos;
    this.dom = h("li");
    this.contentDOM = h("div", "wy-li-body");
    this.render();
    this.dom.appendChild(this.contentDOM);
  }
  render() {
    const a = this.node.attrs;
    if (this.box) { this.box.remove(); this.box = null; }
    this.dom.classList.toggle("task", a.checked != null);
    this.dom.classList.toggle("done", a.checked === true);
    if (a.checked != null) {
      const b = h("input", "wy-check");
      b.type = "checkbox";
      b.checked = !!a.checked;
      b.contentEditable = "false";
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const pos = this.getPos();
        if (pos == null) return;
        const n = this.view.state.doc.nodeAt(pos);
        this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, null, { ...n.attrs, checked: !n.attrs.checked }));
      });
      this.box = b;
      this.dom.prepend(b);
    } else if (a.label != null) {
      const l = h("span", "wy-li-label", texToPlain(a.label) || " ");
      l.contentEditable = "false";
      this.box = l;
      this.dom.prepend(l);
    }
  }
  update(node) {
    if (node.type !== this.node.type) return false;
    const c = node.attrs.checked !== this.node.attrs.checked || node.attrs.label !== this.node.attrs.label;
    this.node = node;
    if (c) this.render();
    return true;
  }
  ignoreMutation(m) { return !!(this.box && (m.target === this.box || this.box.contains(m.target))); }
  stopEvent(e) { return !!(this.box && e.target === this.box); }
}

class FloatView {
  constructor(node, view, getPos, ctx) {
    this.node = node; this.view = view; this.getPos = getPos; this.ctx = ctx;
    this.dom = h("div", "wy-float");
    this.dom.dataset.env = node.attrs.env.replace(/\*$/, "");
    this.contentDOM = h("div", "wy-float-body");
    this.dom.appendChild(this.contentDOM);
    this.render();
  }
  render() {
    if (this.chip) { this.chip.remove(); this.chip = null; }
    const a = this.node.attrs;
    if (a.label == null) return;
    const c = h("span", "wy-chip label wy-float-label", a.label || "label");
    c.contentEditable = "false";
    c.title = "Label — click to edit";
    c.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const fake = { node: this.node, view: this.view, getPos: this.getPos, ctx: this.ctx, dom: c };
      sourcePopover(fake, { attr: "label", title: "Label", deleteIfEmpty: false });
    });
    this.chip = c;
    this.dom.appendChild(c);
  }
  update(node) {
    if (node.type !== this.node.type) return false;
    const c = node.attrs.label !== this.node.attrs.label;
    this.node = node;
    if (c) this.render();
    return true;
  }
  ignoreMutation(m) { return !this.contentDOM.contains(m.target); }
  stopEvent(e) { return !!(this.chip && this.chip.contains(e.target)); }
}

class FootnoteDefView {
  constructor(node) {
    this.node = node;
    this.dom = h("div", "wy-fndef");
    this.tag = h("span", "wy-fndef-tag", node.attrs.label);
    this.tag.contentEditable = "false";
    this.contentDOM = h("div", "wy-fndef-body");
    this.dom.append(this.tag, this.contentDOM);
  }
  update(node) { if (node.type !== this.node.type) return false; this.node = node; this.tag.textContent = node.attrs.label; return true; }
  ignoreMutation(m) { return !this.contentDOM.contains(m.target); }
}

export function makeNodeViews(ctx) {
  const v = (C) => (node, view, getPos, decos) => new C(node, view, getPos, ctx, decos);
  return {
    math_inline: v(MathInlineView),
    math_display: v(MathDisplayView),
    cite: v(ChipView), ref: v(ChipView), footnote: v(ChipView), footnote_ref: v(ChipView), raw_inline: v(ChipView),
    sym: v(SymView),
    image: v(ImageView),
    figure_image: v(FigureImageView),
    tex_cmd: v(TexCmdView),
    raw_block: v(RawBlockView),
    code_block: v(CodeBlockView),
    heading: ctx.kind === "tex" ? v(HeadingView) : undefined,
    meta: v(MetaView),
    tex_env: v(EnvView),
    list_item: v(ListItemView),
    float: v(FloatView),
    footnote_def: v(FootnoteDefView),
    table: (node) => new TableView(node, 60),
  };
}

// ---------------- syntax highlighting for code / raw blocks ----------------
const hlCache = new WeakMap();
const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
function hlRanges(code, lang) {
  if (!lang || !hljs.getLanguage(lang) || code.length > 200000) return [];
  let html;
  try { html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch { return []; }
  const out = [], stack = [];
  let pos = 0;
  const re = /<span class="([^"]+)">|<\/span>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) stack.push(m[1]);
    else if (m[0] === "</span>") stack.pop();
    else {
      const text = m[2].replace(/&(amp|lt|gt|quot|#x27|#39);/g, (e) => ENT[e]);
      if (stack.length) out.push([pos, pos + text.length, stack.join(" ")]);
      pos += text.length;
    }
  }
  return out;
}
const LANG_ALIAS = { tex: "latex", html: "xml", sh: "bash", shell: "bash", yml: "yaml", js: "javascript", ts: "typescript", py: "python", md: "markdown", "c++": "cpp", rs: "rust" };
function langOf(node, kind) {
  if (node.type === S.raw_block) return node.attrs.lang === "html" ? "xml" : node.attrs.lang || (kind === "tex" ? "latex" : "");
  const l = (node.attrs.lang || "").toLowerCase().split(/[\s{]/)[0];
  return LANG_ALIAS[l] || l;
}
export function highlightPlugin(kind) {
  const decosFor = (node, pos, out) => {
    let r = hlCache.get(node);
    if (!r) { r = hlRanges(node.textContent, langOf(node, kind)); hlCache.set(node, r); }
    for (const [a, b, cls] of r) out.push(Decoration.inline(pos + 1 + a, pos + 1 + b, { class: cls }));
  };
  const isCode = (n) => n.type === S.code_block || n.type === S.raw_block;
  const build = (doc) => {
    const decos = [];
    doc.descendants((node, pos) => {
      if (!isCode(node)) return node.isBlock && !node.isTextblock;
      decosFor(node, pos, decos);
      return false;
    });
    return DecorationSet.create(doc, decos);
  };
  return new Plugin({
    key: new PluginKey("wyHighlight"),
    state: {
      init: (_, st) => build(st.doc),
      apply(tr, old) {
        if (!tr.docChanged) return old;
        // only re-highlight code blocks touched by this change
        let set = old.map(tr.mapping, tr.doc);
        const ranges = [];
        tr.mapping.maps.forEach((m, i) => m.forEach((oldS, oldE, newS, newE) => {
          const rest = tr.mapping.slice(i + 1);
          ranges.push([rest.map(newS, -1), rest.map(newE, 1)]);
        }));
        for (const [from, to] of ranges) {
          tr.doc.nodesBetween(Math.max(0, from - 1), Math.min(tr.doc.content.size, to + 1), (node, pos) => {
            if (!isCode(node)) return node.isBlock && !node.isTextblock;
            set = set.remove(set.find(pos, pos + node.nodeSize));
            const add = [];
            decosFor(node, pos, add);
            set = set.add(tr.doc, add);
            return false;
          });
        }
        return set;
      },
    },
    props: { decorations(st) { return this.getState(st); } },
  });
}

// ---------------- numbering (LaTeX): sections, figures, tables, equations, footnotes, refs ----------------
export const numberingKey = new PluginKey("wyNumbering");
const SEC_ORDER = ["part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"];
function computeNumbers(doc, ctx) {
  const decos = [];
  const labels = new Map();
  const top = ctx.hasChapter ? 1 : 2;
  const sec = [0, 0, 0, 0, 0, 0, 0];
  let appendix = false, fig = 0, tab = 0, eq = 0, fn = 0;
  const thm = new Map();
  const refs = [];
  const secNum = (lvl) => {
    const parts = [];
    for (let i = top; i <= lvl; i++) parts.push(i === top && appendix ? String.fromCharCode(64 + sec[i]) : sec[i]);
    return parts.join(".");
  };
  doc.descendants((node, pos) => {
    const t = node.type;
    if (t === S.heading) {
      const lvl = SEC_ORDER.indexOf(node.attrs.cmd);
      if (lvl >= top && !node.attrs.star && lvl <= 4) {
        sec[lvl]++;
        for (let i = lvl + 1; i < sec.length; i++) sec[i] = 0;
        const num = secNum(lvl);
        decos.push(Decoration.node(pos, pos + node.nodeSize, { "data-num": num }));
        if (node.attrs.label) labels.set(node.attrs.label, num);
      } else if (lvl >= 0 && lvl < top && !node.attrs.star) { for (let i = lvl + 1; i < sec.length; i++) sec[i] = 0; }
      return true;
    }
    if (t === S.tex_cmd) { if (/^\\appendix\b/.test(node.attrs.src)) { appendix = true; sec[top] = 0; } return false; }
    if (t === S.float) {
      const env = node.attrs.env.replace(/\*$/, "");
      const isTab = /table/.test(env), isFig = /figure/.test(env);
      let num = null;
      node.forEach((c, off) => {
        if (c.type === S.caption && (isTab || isFig) && !/^\\caption\*/.test(c.attrs.open)) {
          num = isTab ? ++tab : ++fig;
          decos.push(Decoration.node(pos + 1 + off, pos + 1 + off + c.nodeSize, { "data-num": `${isTab ? "Table" : "Figure"} ${num}:` }));
        }
      });
      if (node.attrs.label && num != null) labels.set(node.attrs.label, String(num));
      return true;
    }
    if (t === S.math_display) {
      const n = eqCount(node.attrs);
      if (n) {
        decos.push(Decoration.node(pos, pos + node.nodeSize, {}, { eqn: eq + 1 }));
        for (const l of eqLabels(node.attrs)) labels.set(l.label, String(eq + 1 + l.row));
        eq += n;
      }
      return false;
    }
    if (t === S.tex_env) {
      const env = node.attrs.env;
      const th = ctx.theorems && ctx.theorems.get(env);
      if (th && th.numbered) {
        const k = th.counter;
        thm.set(k, (thm.get(k) || 0) + 1);
        decos.push(Decoration.node(pos, pos + node.nodeSize, {}, { num: String(thm.get(k)) }));
      }
      return true;
    }
    if (t === S.footnote) { fn++; decos.push(Decoration.node(pos, pos + 1, {}, { num: String(fn) })); return false; }
    if (t === S.ref) { refs.push([pos, node]); return false; }
    if (node.isTextblock) {
      // labels written inside captions / paragraphs
      return true;
    }
    return !node.isLeaf;
  });
  // \label chips inside captions point at their float: resolve those too
  doc.descendants((node, pos) => {
    if (node.type === S.float) {
      const env = node.attrs.env;
      node.descendants((c) => {
        if (c.type === S.ref && /^\\label\{/.test(c.attrs.src)) {
          const key = /\{([^{}]*)\}/.exec(c.attrs.src)[1];
          if (!labels.has(key)) labels.set(key, "?" + env);
        }
      });
      return false;
    }
    return node.isBlock && !node.isTextblock;
  });
  for (const [pos, node] of refs) {
    const m = /^\\([a-zA-Z]+)\*?(?:\[[^\]]*\])*\{([^{}]*)\}/.exec(node.attrs.src);
    if (!m || m[1] === "label") continue;
    const keys = m[2].split(",").map((k) => k.trim());
    const nums = keys.map((k) => labels.get(k));
    if (nums.every((x) => x == null)) continue;
    let txt = nums.map((x, i) => x ?? "?" + keys[i]).join(", ");
    if (m[1] === "eqref") txt = "(" + txt + ")";
    decos.push(Decoration.node(pos, pos + 1, {}, { target: txt }));
  }
  return DecorationSet.create(doc, decos);
}
export function numberingPlugin(ctx) {
  let timer = 0;
  return new Plugin({
    key: numberingKey,
    state: {
      init: (_, st) => computeNumbers(st.doc, ctx),
      apply(tr, old) {
        const fresh = tr.getMeta(numberingKey);
        if (fresh) return fresh;
        return tr.docChanged ? old.map(tr.mapping, tr.doc) : old;
      },
    },
    props: { decorations(st) { return this.getState(st); } },
    view: () => ({
      update(view, prev) {
        if (view.state.doc === prev.doc) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (view.isDestroyed) return;
          const d = computeNumbers(view.state.doc, ctx);
          view.dispatch(view.state.tr.setMeta(numberingKey, d).setMeta("addToHistory", false));
        }, 120);
      },
      destroy() { clearTimeout(timer); },
    }),
  });
}
