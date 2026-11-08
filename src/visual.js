// Visual editing for Markdown and LaTeX, in the same editor (like Obsidian's live preview):
// away from the cursor, markup is hidden and shown as what it means — headings, bold, italic,
// links, lists, check boxes, images, math (KaTeX) and citations. The line you are on shows
// its source, so nothing is ever hidden while you edit it. Plus formatting commands for the
// toolbar, written as Markdown or LaTeX depending on the file.
import { EditorSelection, StateField, RangeSetBuilder } from "@codemirror/state";
import { EditorView, Decoration, ViewPlugin, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import katex from "katex";
import "katex/dist/katex.min.css";
import { fileSrc } from "./api.js";

let ctx = { dir: () => "" };
export function setVisualContext(c) { ctx = { ...ctx, ...c }; }

// ---------------- widgets ----------------
const mathCache = new Map();
function katexHtml(tex, display) {
  const key = (display ? "D" : "I") + tex;
  let v = mathCache.get(key);
  if (v === undefined) {
    try { v = katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: "ignore", trust: false }); }
    catch (e) { v = null; }
    if (mathCache.size > 3000) mathCache.clear();
    mathCache.set(key, v);
  }
  return v;
}
/** Clicking a widget puts the cursor there, which reveals its source. */
function revealOnClick(dom, view) {
  dom.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pos = view.posAtDOM(dom);
    view.dispatch({ selection: EditorSelection.cursor(pos) });
    view.focus();
  });
}
class MathWidget extends WidgetType {
  constructor(tex, display) { super(); this.tex = tex; this.display = display; }
  eq(o) { return o.tex === this.tex && o.display === this.display; }
  toDOM(view) {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "cm-v-math-block" : "cm-v-math";
    const html = katexHtml(this.tex, this.display);
    if (html) el.innerHTML = html;
    else { el.textContent = this.tex; el.classList.add("cm-v-math-err"); el.title = "KaTeX can't show this (it may still compile)"; }
    revealOnClick(el, view);
    return el;
  }
  ignoreEvent() { return true; }
}
class ImageWidget extends WidgetType {
  constructor(src, alt) { super(); this.src = src; this.alt = alt; }
  eq(o) { return o.src === this.src && o.alt === this.alt; }
  toDOM(view) {
    const wrap = document.createElement("span");
    wrap.className = "cm-v-img";
    const img = document.createElement("img");
    img.alt = this.alt || "";
    img.src = this.src;
    img.loading = "lazy";
    img.onerror = () => { wrap.textContent = `🖼 ${this.alt || this.src}`; wrap.classList.add("broken"); };
    wrap.appendChild(img);
    revealOnClick(wrap, view);
    return wrap;
  }
  ignoreEvent() { return true; }
}
class ChipWidget extends WidgetType {
  constructor(text, cls, title) { super(); this.text = text; this.cls = cls; this.title = title; }
  eq(o) { return o.text === this.text && o.cls === this.cls; }
  toDOM(view) {
    const el = document.createElement("span");
    el.className = "cm-v-chip " + (this.cls || "");
    el.textContent = this.text;
    if (this.title) el.title = this.title;
    revealOnClick(el, view);
    return el;
  }
  ignoreEvent() { return true; }
}
class BulletWidget extends WidgetType {
  constructor(ch) { super(); this.ch = ch; }
  eq(o) { return o.ch === this.ch; }
  toDOM() { const el = document.createElement("span"); el.className = "cm-v-bullet"; el.textContent = this.ch; return el; }
}
class CheckWidget extends WidgetType {
  constructor(on) { super(); this.on = on; }
  eq(o) { return o.on === this.on; }
  toDOM(view) {
    const el = document.createElement("input");
    el.type = "checkbox"; el.checked = this.on; el.className = "cm-v-check";
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(el);
      const line = view.state.doc.lineAt(pos);
      const m = /\[( |x|X)\]/.exec(line.text);
      if (!m) return;
      const at = line.from + m.index + 1;
      view.dispatch({ changes: { from: at, to: at + 1, insert: this.on ? " " : "x" }, userEvent: "input" });
    });
    return el;
  }
  ignoreEvent() { return true; }
}
class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const el = document.createElement("span"); el.className = "cm-v-hr"; return el; }
}

const hide = Decoration.replace({});
const mark = (cls) => Decoration.mark({ class: cls });
const line = (cls) => Decoration.line({ class: cls });

function resolveImg(src) {
  if (!src) return "";
  if (/^(https?:|data:)/i.test(src)) return src;
  let clean = src.split("#")[0].split("?")[0];
  try { clean = decodeURI(clean); } catch {}
  const dir = ctx.dir() || "";
  const p = /^([A-Za-z]:)?[\\/]/.test(clean) ? clean : (dir ? dir + "/" : "") + clean;
  return fileSrc(p.replace(/\\/g, "/"));
}

// ---------------- what is "being edited" ----------------
function activeLines(state) {
  const set = new Set();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number, b = state.doc.lineAt(r.to).number;
    for (let i = a; i <= b && i - a < 400; i++) set.add(i);
  }
  return set;
}
const touches = (state, from, to) => state.selection.ranges.some((r) => r.from <= to && r.to >= from);

// ---------------- display math & environments (may span lines: a state field) ----------------
const TEX_MATH_ENVS = "equation|equation\\*|align|align\\*|gather|gather\\*|multline|multline\\*|displaymath|eqnarray|eqnarray\\*|flalign|flalign\\*";
function blockMathRanges(text, kind) {
  const out = [];
  const re = kind === "md"
    ? /\$\$([\s\S]+?)\$\$/g
    : new RegExp(`\\\\begin\\{(${TEX_MATH_ENVS})\\}([\\s\\S]*?)\\\\end\\{\\1\\}|\\\\\\[([\\s\\S]+?)\\\\\\]`, "g");
  let m;
  while ((m = re.exec(text)) && out.length < 2000) {
    let tex;
    if (kind === "md") tex = m[1];
    else if (m[1]) {
      const env = m[1].replace("*", "");
      const body = m[2].replace(/\\label\{[^}]*\}/g, "").replace(/\\(nonumber|notag)\b/g, "");
      tex = env === "equation" || env === "displaymath" ? body : `\\begin{${env === "eqnarray" ? "aligned" : env === "multline" ? "gathered" : env === "flalign" ? "aligned" : env + "*"}}${body}\\end{${env === "eqnarray" ? "aligned" : env === "multline" ? "gathered" : env === "flalign" ? "aligned" : env + "*"}}`;
    } else tex = m[3];
    out.push({ from: m.index, to: m.index + m[0].length, tex: tex.trim() });
  }
  return out;
}
function mdCodeRanges(state) {
  const r = [];
  try {
    syntaxTree(state).iterate({ enter: (n) => { if (n.name === "FencedCode" || n.name === "CodeBlock" || n.name === "InlineCode" || n.name === "HTMLBlock" || n.name === "CommentBlock") { r.push([n.from, n.to]); return false; } } });
  } catch {}
  return r;
}
const inRanges = (ranges, from, to) => ranges.some(([a, b]) => from < b && to > a);

function buildBlocks(state, kind) {
  const text = state.doc.toString();
  if (text.length > 3_000_000) return Decoration.none;
  const code = kind === "md" ? mdCodeRanges(state) : [];
  const b = new RangeSetBuilder();
  for (const r of blockMathRanges(text, kind)) {
    if (kind === "md" && inRanges(code, r.from, r.to)) continue;
    const l1 = state.doc.lineAt(r.from), l2 = state.doc.lineAt(r.to);
    // only when the math has its lines to itself, and the cursor isn't in it
    if (text.slice(l1.from, r.from).trim() || text.slice(r.to, l2.to).trim()) continue;
    if (touches(state, l1.from, l2.to)) continue;
    b.add(l1.from, l2.to, Decoration.replace({ widget: new MathWidget(r.tex, true), block: true }));
  }
  return b.finish();
}
function blockField(kind) {
  return StateField.define({
    create: (s) => buildBlocks(s, kind),
    update(v, tr) { return tr.docChanged || tr.selection ? buildBlocks(tr.state, kind) : v; },
    provide: (f) => EditorView.decorations.from(f),
  });
}

// ---------------- inline (visible lines only: a view plugin) ----------------
function collect(view, kind) {
  const { state } = view;
  const act = activeLines(state);
  const code = kind === "md" ? mdCodeRanges(state) : [];
  const blocks = buildBlocksCache.get(state) || [];
  const decos = [], lineDecos = [];
  const add = (from, to, d) => { if (from < to || d.spec?.widget) decos.push(d.range(from, to)); };
  const addLine = (pos, d) => lineDecos.push(d.range(pos));
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const ln = state.doc.lineAt(pos);
      pos = ln.to + 1;
      const t = ln.text;
      if (!t.trim()) continue;
      const editing = act.has(ln.number);
      const L = ln.from;
      const skip = (a, b) => inRanges(code, L + a, L + b) || inRanges(blocks, L + a, L + b);
      if (kind === "md") mdLine(t, L, editing, skip, add, addLine, code);
      else texLine(t, L, editing, skip, add, addLine);
    }
  }
  const isReplace = (d) => d.value === hide || d.value.spec?.widget !== undefined;
  decos.sort((a, b) => a.from - b.from || (isReplace(b) - isReplace(a)) || b.to - a.to);
  // a replaced range wins: drop anything starting inside it
  const out = [];
  let end = -1;
  for (const d of decos) {
    if (d.from < end || (d.from === end && d.to === end && isReplace(d))) continue;
    out.push(d);
    if (isReplace(d)) end = Math.max(end, d.to);
  }
  try { return Decoration.set([...lineDecos, ...out], true); } catch (e) { console.warn("visual", e); return Decoration.none; }
}
const buildBlocksCache = new WeakMap();

function scan(re, t, fn) { re.lastIndex = 0; let m; while ((m = re.exec(t))) { fn(m); if (m[0].length === 0) re.lastIndex++; } }

function mdLine(t, L, editing, skip, add, addLine, code) {
  if (skip(0, Math.max(1, t.length)) && inRangesWhole(code, L, L + t.length)) return;
  let m;
  // headings
  if ((m = /^(#{1,6})[ \t]+/.exec(t))) {
    addLine(L, line(`cm-v-h cm-v-h${m[1].length}`));
    if (!editing) add(L, L + m[0].length, hide);
  }
  // quote
  if ((m = /^(\s*>[ \t]?)+/.exec(t))) {
    addLine(L, line("cm-v-quote"));
    if (!editing) add(L, L + m[0].length, hide);
  }
  // rule
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(t) && !/^\s*[-*+]\s+\S/.test(t)) {
    if (!editing) add(L, L + t.length, Decoration.replace({ widget: new RuleWidget() }));
    return;
  }
  // task / bullet / number
  if ((m = /^(\s*)([-*+])[ \t]+\[( |x|X)\][ \t]+/.exec(t))) {
    if (!editing) add(L + m[1].length, L + m[0].length, Decoration.replace({ widget: new CheckWidget(m[3] !== " ") }));
    if (m[3] !== " ") add(L + m[0].length, L + t.length, mark("cm-v-done"));
  } else if ((m = /^(\s*)([-*+])[ \t]+/.exec(t))) {
    if (!editing) add(L + m[1].length, L + m[1].length + 1, Decoration.replace({ widget: new BulletWidget("•") }));
  }
  const inline = (re, fn) => scan(re, t, (mm) => { if (!skip(mm.index, mm.index + mm[0].length)) fn(mm); });
  // images, then links
  inline(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (mm) => {
    if (!editing) add(L + mm.index, L + mm.index + mm[0].length, Decoration.replace({ widget: new ImageWidget(resolveImg(mm[2]), mm[1]) }));
  });
  inline(/(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (mm) => {
    const a = L + mm.index, textEnd = a + 1 + mm[1].length;
    add(a + 1, textEnd, mark("cm-v-link"));
    if (!editing) { add(a, a + 1, hide); add(textEnd, a + mm[0].length, hide); }
  });
  // math (not $$)
  inline(/(?<![\\$])\$(?!\$)([^$\n]+?)(?<![\\\s])\$(?!\$)/g, (mm) => {
    if (!editing) add(L + mm.index, L + mm.index + mm[0].length, Decoration.replace({ widget: new MathWidget(mm[1], false) }));
    else add(L + mm.index, L + mm.index + mm[0].length, mark("cm-v-mathsrc"));
  });
  // inline code (its own backticks)
  scan(/(`+)([^`]+?)\1/g, t, (mm) => {
    const a = L + mm.index, n = mm[1].length;
    add(a + n, a + mm[0].length - n, mark("cm-v-code"));
    if (!editing) { add(a, a + n, hide); add(a + mm[0].length - n, a + mm[0].length, hide); }
  });
  const pair = (re, n, cls) => inline(re, (mm) => {
    const a = L + mm.index, b = a + mm[0].length;
    add(a + n, b - n, mark(cls));
    if (!editing) { add(a, a + n, hide); add(b - n, b, hide); }
  });
  pair(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, 2, "cm-v-b");
  pair(/(?<![\w_])__(?!\s)(.+?)(?<!\s)__(?![\w_])/g, 2, "cm-v-b");
  pair(/(?<![*\w])\*(?![\s*])(.+?)(?<![\s*])\*(?![*\w])/g, 1, "cm-v-i");
  pair(/(?<![\w_])_(?![\s_])(.+?)(?<![\s_])_(?![\w_])/g, 1, "cm-v-i");
  pair(/~~(?!\s)(.+?)(?<!\s)~~/g, 2, "cm-v-s");
  pair(/==(?!\s)(.+?)(?<!\s)==/g, 2, "cm-v-mark");
  // [@key] citations
  inline(/\[(-?@[\w:.#$%&\-+?<>~/]+(?:\s*;\s*-?@[\w:.#$%&\-+?<>~/]+)*)\]/g, (mm) => {
    if (!editing) add(L + mm.index, L + mm.index + mm[0].length, Decoration.replace({ widget: new ChipWidget(mm[1].replace(/-?@/g, ""), "cite", mm[0]) }));
  });
}
function inRangesWhole(ranges, from, to) { return ranges.some(([a, b]) => a <= from && b >= to); }

const TEX_HEAD = { part: 1, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 5 };
function texLine(t, L, editing, skip, add, addLine) {
  // comment part of the line
  let cut = t.length;
  for (let i = 0; i < t.length; i++) { if (t[i] === "%" && (i === 0 || t[i - 1] !== "\\")) { cut = i; break; } }
  if (cut < t.length) add(L + cut, L + t.length, mark("cm-v-comment"));
  const s = t.slice(0, cut);
  if (!s.trim()) return;
  let m;
  if ((m = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\[[^\]]*\])?\{([^{}]*)\}/.exec(s))) {
    addLine(L, line(`cm-v-h cm-v-h${TEX_HEAD[m[1]]}`));
    if (!editing) {
      const open = m[0].length - m[2].length - 1;
      add(L + m.index, L + open, hide);
      add(L + m[0].length - 1, L + m[0].length, hide);
    }
  }
  const inline = (re, fn) => scan(re, s, (mm) => { if (!skip(mm.index, mm.index + mm[0].length)) fn(mm); });
  if (!editing) inline(/^\s*\\item\b(\[[^\]]*\])?\s?/g, (mm) => add(L + mm.index + mm[0].indexOf("\\"), L + mm.index + mm[0].length, Decoration.replace({ widget: new BulletWidget(mm[1] ? mm[1].slice(1, -1) + " " : "•") })));
  const cmd = (names, cls) => inline(new RegExp(`\\\\(?:${names})\\{([^{}]*)\\}`, "g"), (mm) => {
    const a = L + mm.index, b = a + mm[0].length, open = mm[0].length - mm[1].length - 1;
    add(a + open, b - 1, mark(cls));
    if (!editing) { add(a, a + open, hide); add(b - 1, b, hide); }
  });
  cmd("textbf|mathbf|bfseries", "cm-v-b");
  cmd("textit|emph|textsl", "cm-v-i");
  cmd("underline|uline", "cm-v-u");
  cmd("sout|st", "cm-v-s");
  cmd("texttt", "cm-v-code");
  cmd("textsc", "cm-v-sc");
  cmd("url", "cm-v-link");
  inline(/\\href\{([^{}]*)\}\{([^{}]*)\}/g, (mm) => {
    const a = L + mm.index, b = a + mm[0].length, ts = b - 1 - mm[2].length;
    add(ts, b - 1, mark("cm-v-link"));
    if (!editing) { add(a, ts, hide); add(b - 1, b, hide); }
  });
  // citations, references, labels
  inline(/\\(?:[cC]ite[a-z]*|[pP]arencite|[tT]extcite|[aA]utocite|footcite|nocite)\*?(?:\[[^\]]*\]){0,2}\{([^{}]+)\}/g, (mm) => {
    if (!editing) add(L + mm.index, L + mm.index + mm[0].length, Decoration.replace({ widget: new ChipWidget(mm[1].split(",").map((k) => k.trim()).join("; "), "cite", mm[0]) }));
  });
  inline(/\\(?:eq|auto|c|C|name|page)?ref\{([^{}]+)\}/g, (mm) => {
    if (!editing) add(L + mm.index, L + mm.index + mm[0].length, Decoration.replace({ widget: new ChipWidget("→ " + mm[1], "ref", mm[0]) }));
  });
  inline(/\\label\{([^{}]+)\}/g, (mm) => {
    if (!editing) add(L + mm.index, L + mm.index + mm[0].length, Decoration.replace({ widget: new ChipWidget("#" + mm[1], "label", mm[0]) }));
  });
  // inline math: $…$ and \(…\)
  inline(/(?<![\\$])\$(?!\$)((?:\\.|[^$\\])+?)\$(?!\$)|\\\((.+?)\\\)/g, (mm) => {
    const tex = mm[1] ?? mm[2];
    if (!editing) add(L + mm.index, L + mm.index + mm[0].length, Decoration.replace({ widget: new MathWidget(tex, false) }));
    else add(L + mm.index, L + mm.index + mm[0].length, mark("cm-v-mathsrc"));
  });
  // pictures we can show
  inline(/\\includegraphics(?:\[[^\]]*\])?\{([^{}]+)\}/g, (mm) => {
    if (editing) return;
    let p = mm[1].trim();
    if (!/\.(png|jpe?g|gif|svg|webp)$/i.test(p)) {
      if (/\.(pdf|eps)$/i.test(p)) return add(L + mm.index, L + mm.index + mm[0].length, Decoration.replace({ widget: new ChipWidget("🖼 " + p, "fig", mm[0]) }));
      p += ".png"; // \includegraphics{fig} — commonly a PNG next to it
    }
    add(L + mm.index, L + mm.index + mm[0].length, Decoration.replace({ widget: new ImageWidget(resolveImg(p), mm[1]) }));
  });
  // \begin{itemize} / \end{…} lines fade
  if (/^\s*\\(begin|end)\{(itemize|enumerate|description|center|flushleft|flushright|quote|quotation)\}\s*$/.test(s)) addLine(L, line("cm-v-env"));
}

function inlinePlugin(kind) {
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.build(view); }
    update(u) { if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged) this.decorations = this.build(u.view); }
    build(view) {
      const text = view.state.doc.toString();
      buildBlocksCache.set(view.state, blockMathRanges(text, kind).map((r) => [r.from, r.to]));
      return collect(view, kind);
    }
  }, { decorations: (v) => v.decorations });
}

const theme = EditorView.theme({
  ".cm-v-h": { fontWeight: "650", fontFamily: '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif' },
  ".cm-v-h1": { fontSize: "1.65em", lineHeight: "1.4" },
  ".cm-v-h2": { fontSize: "1.4em", lineHeight: "1.4" },
  ".cm-v-h3": { fontSize: "1.2em" },
  ".cm-v-h4": { fontSize: "1.08em" },
  ".cm-v-b": { fontWeight: "700" },
  ".cm-v-i": { fontStyle: "italic" },
  ".cm-v-u": { textDecoration: "underline" },
  ".cm-v-s": { textDecoration: "line-through" },
  ".cm-v-sc": { fontVariant: "small-caps" },
  ".cm-v-mark": { background: "rgba(255, 213, 0, .28)", borderRadius: "2px" },
  ".cm-v-done": { textDecoration: "line-through", opacity: ".65" },
  ".cm-v-code": { fontFamily: "Consolas, 'Cascadia Mono', monospace", background: "var(--bg-3)", borderRadius: "3px", padding: "0 2px" },
  ".cm-v-link": { color: "var(--accent, #3b82f6)", textDecoration: "underline", textUnderlineOffset: "2px" },
  ".cm-v-quote": { borderLeft: "3px solid var(--border)", paddingLeft: "10px !important", color: "var(--fg-2)" },
  ".cm-v-comment": { opacity: ".55" },
  ".cm-v-env": { opacity: ".5", fontSize: ".9em" },
  ".cm-v-mathsrc": { background: "rgba(127,127,127,.12)", borderRadius: "3px" },
  ".cm-v-math": { cursor: "pointer", padding: "0 1px" },
  ".cm-v-math-block": { cursor: "pointer", textAlign: "center", padding: "6px 0", overflowX: "auto" },
  ".cm-v-math-err": { fontFamily: "monospace", color: "var(--danger)" },
  ".cm-v-bullet": { color: "var(--fg-2)", padding: "0 4px 0 0" },
  ".cm-v-check": { margin: "0 6px 0 0", verticalAlign: "middle", cursor: "pointer" },
  ".cm-v-hr": { display: "inline-block", width: "100%", borderTop: "1px solid var(--border)", verticalAlign: "middle" },
  ".cm-v-img": { display: "inline-block", cursor: "pointer", maxWidth: "100%" },
  ".cm-v-img img": { maxWidth: "100%", maxHeight: "320px", display: "block", margin: "4px 0", borderRadius: "4px" },
  ".cm-v-img.broken": { color: "var(--fg-2)", fontStyle: "italic" },
  ".cm-v-chip": { display: "inline-block", padding: "0 6px", margin: "0 1px", borderRadius: "10px", fontSize: ".86em", lineHeight: "1.5", cursor: "pointer", background: "var(--bg-3)", color: "var(--fg-2)", border: "1px solid var(--border)" },
  ".cm-v-chip.cite": { color: "var(--accent, #3b82f6)" },
  ".cm-v-chip.label": { opacity: ".7" },
});

const cache = {};
/** The extension for a file kind ("md" or "tex"). */
export function visualExtension(kind) {
  if (kind !== "md" && kind !== "tex") return null;
  return (cache[kind] ||= [blockField(kind), inlinePlugin(kind), theme, EditorView.editorAttributes.of({ class: "cm-visual" })]);
}

// ---------------- formatting commands (toolbar) ----------------
function wrap(view, before, after, placeholder = "") {
  const tr = view.state.changeByRange((r) => {
    const text = view.state.sliceDoc(r.from, r.to) || placeholder;
    // already wrapped: unwrap
    const pre = view.state.sliceDoc(r.from - before.length, r.from), post = view.state.sliceDoc(r.to, r.to + after.length);
    if (!r.empty && pre === before && post === after) {
      return { changes: [{ from: r.from - before.length, to: r.from }, { from: r.to, to: r.to + after.length }], range: EditorSelection.range(r.from - before.length, r.to - before.length) };
    }
    return {
      changes: { from: r.from, to: r.to, insert: before + text + after },
      range: EditorSelection.range(r.from + before.length, r.from + before.length + text.length),
    };
  });
  view.dispatch(tr, { scrollIntoView: true, userEvent: "input" });
}
/** Apply `fn(lineText) → newText` to every line touched by the selection. */
function eachLine(view, fn) {
  const { state } = view;
  const changes = [];
  const seen = new Set();
  for (const r of state.selection.ranges) {
    for (let p = r.from; p <= r.to;) {
      const l = state.doc.lineAt(p);
      if (!seen.has(l.number)) { seen.add(l.number); const n = fn(l.text, seen.size - 1); if (n !== l.text) changes.push({ from: l.from, to: l.to, insert: n }); }
      p = l.to + 1;
    }
  }
  view.dispatch({ changes, userEvent: "input", scrollIntoView: true });
}
function insertBlock(view, text, cursorOffset) {
  const { state } = view;
  const r = state.selection.main;
  const l = state.doc.lineAt(r.from);
  // the selection is replaced (the equation command already took the selected text)
  const before = state.sliceDoc(l.from, r.from);
  const atStart = !before.trim() && (r.empty ? !l.text.trim() : true);
  const pre = atStart ? "" : "\n\n";
  const ins = pre + text + "\n";
  const from = atStart ? l.from : r.from;
  const to = r.empty ? (atStart ? l.to : r.to) : r.to;
  view.dispatch({ changes: { from, to, insert: ins }, selection: EditorSelection.cursor(from + pre.length + (cursorOffset ?? text.length)), userEvent: "input", scrollIntoView: true });
}
function wrapEnv(view, env, itemize) {
  const { state } = view;
  const r = state.selection.main;
  const a = state.doc.lineAt(r.from), b = state.doc.lineAt(r.to);
  const body = state.sliceDoc(a.from, b.to);
  const lines = body.split("\n").map((x) => (itemize ? (x.trim() ? `  \\item ${x.trim().replace(/^\\item\s*/, "")}` : x) : `  ${x}`));
  const text = `\\begin{${env}}\n${(r.empty && !body.trim()) ? (itemize ? "  \\item " : "  ") : lines.join("\n")}\n\\end{${env}}`;
  view.dispatch({ changes: { from: a.from, to: b.to, insert: text }, selection: EditorSelection.cursor(a.from + `\\begin{${env}}\n`.length + (r.empty && !body.trim() ? (itemize ? 8 : 2) : lines.join("\n").length)), userEvent: "input", scrollIntoView: true });
}
const relPath = (p, dir) => {
  const n = (s) => s.replace(/\\/g, "/");
  p = n(p); dir = n(dir || "");
  if (dir && p.toLowerCase().startsWith(dir.toLowerCase() + "/")) return p.slice(dir.length + 1);
  return p;
};

/** Toolbar command `act` on the editor, for a "md" or "tex" file. */
export async function format(view, kind, act, extra = {}) {
  if (!view) return;
  const md = kind === "md";
  switch (act) {
    case "bold": return md ? wrap(view, "**", "**", "bold") : wrap(view, "\\textbf{", "}", "bold");
    case "italic": return md ? wrap(view, "*", "*", "italic") : wrap(view, "\\emph{", "}", "italic");
    case "strike": return md ? wrap(view, "~~", "~~", "text") : wrap(view, "\\sout{", "}", "text");
    case "code": return md ? wrap(view, "`", "`", "code") : wrap(view, "\\texttt{", "}", "code");
    case "math": return md ? wrap(view, "$", "$", "x^2") : wrap(view, "$", "$", "x^2");
    case "h1": case "h2": case "h3": case "p": {
      const n = act === "p" ? 0 : +act[1];
      if (md) return eachLine(view, (t) => { const s = t.replace(/^#{1,6}\s+/, ""); return n ? "#".repeat(n) + " " + s : s; });
      const cmds = ["", "section", "subsection", "subsubsection"];
      return eachLine(view, (t) => {
        const m = /^\s*\\(?:section|subsection|subsubsection|chapter|paragraph)\*?\{(.*)\}\s*$/.exec(t);
        const s = m ? m[1] : t;
        return n ? `\\${cmds[n]}{${s.trim() || "Title"}}` : s;
      });
    }
    case "ul": case "ol": case "task":
      if (md) return eachLine(view, (t, i) => {
        const s = t.replace(/^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "$1");
        const ind = /^\s*/.exec(s)[0];
        const body = s.slice(ind.length);
        const already = (act === "ul" && /^\s*[-*+]\s+(?!\[)/.test(t)) || (act === "ol" && /^\s*\d+[.)]\s/.test(t)) || (act === "task" && /^\s*[-*+]\s+\[[ xX]\]/.test(t));
        if (already) return s;
        return ind + (act === "ul" ? "- " : act === "ol" ? `${i + 1}. ` : "- [ ] ") + body;
      });
      return wrapEnv(view, act === "ol" ? "enumerate" : "itemize", true);
    case "quote":
      if (md) return eachLine(view, (t) => (/^\s*>\s?/.test(t) ? t.replace(/^(\s*)>\s?/, "$1") : "> " + t));
      return wrapEnv(view, "quote", false);
    case "link": {
      const url = extra.url || "https://";
      if (md) return wrap(view, "[", `](${url})`, "link text");
      return wrap(view, `\\href{${url}}{`, "}", "link text");
    }
    case "image": {
      const path = extra.path;
      if (!path) return;
      const rel = relPath(path, ctx.dir());
      if (md) return insertBlock(view, `![](${/\s/.test(rel) ? `<${rel}>` : rel})`, 2);
      const noExt = rel.replace(/\.(png|jpe?g|pdf|eps)$/i, (x) => (/(pdf|png|jpe?g)$/i.test(x) ? x : ""));
      const lab = rel.replace(/^.*\//, "").replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-");
      const fig = `\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${noExt}}\n  \\caption{}\n  \\label{fig:${lab}}\n\\end{figure}`;
      return insertBlock(view, fig, fig.indexOf("\\caption{") + 9);
    }
    case "display": {
      const sel = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
      if (md) { const t = `$$\n${sel || ""}\n$$`; return insertBlock(view, t, 3); }
      const t = `\\begin{equation}\n  ${sel || ""}\n\\end{equation}`;
      return insertBlock(view, t, t.indexOf("\n") + 3 + (sel ? sel.length : 0));
    }
    case "table": {
      const c = extra.cols || 3, r = extra.rows || 2;
      if (md) {
        const row = (cells) => "| " + cells.join(" | ") + " |";
        const head = row(Array.from({ length: c }, (_, i) => `Column ${i + 1}`));
        const t = [head, row(Array.from({ length: c }, () => "---")), ...Array.from({ length: r }, () => row(Array.from({ length: c }, () => "   ")))].join("\n");
        return insertBlock(view, t, 2);
      }
      const t = `\\begin{table}[htbp]\n  \\centering\n  \\caption{}\n  \\label{tab:}\n  \\begin{tabular}{${"l".repeat(c)}}\n    \\hline\n    ${Array.from({ length: c }, (_, i) => `Column ${i + 1}`).join(" & ")} \\\\\n    \\hline\n${Array.from({ length: r }, () => `    ${Array.from({ length: c }, () => " ").join(" & ")} \\\\`).join("\n")}\n    \\hline\n  \\end{tabular}\n\\end{table}`;
      return insertBlock(view, t, t.indexOf("\\caption{") + 9);
    }
    case "footnote":
      if (md) {
        const n = (view.state.doc.toString().match(/\[\^(\d+)\]:/g) || []).length + 1;
        const end = view.state.doc.length;
        const r = view.state.selection.main;
        view.dispatch({ changes: [{ from: r.to, insert: `[^${n}]` }, { from: end, insert: `${view.state.doc.sliceString(end - 1) === "\n" ? "" : "\n"}\n[^${n}]: ` }], selection: EditorSelection.cursor(end + `[^${n}]`.length + (view.state.doc.sliceString(end - 1) === "\n" ? 0 : 1) + `\n[^${n}]: `.length), userEvent: "input", scrollIntoView: true });
        return;
      }
      return wrap(view, "\\footnote{", "}", "note");
  }
}
