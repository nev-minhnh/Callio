// Visual (WYSIWYG) editor for Markdown and LaTeX — a document page with a Word-like ribbon.
//
//   const ed = mountVisual(el, { kind: "md" | "tex", text, dir, fileSrc, onChange, onCite, pickImage });
//   ed.update(text)   // the file changed outside: re-parse (ignored if it's what we last emitted)
//   ed.flush()        // emit a pending change now
//   ed.getText()      // current source
//   ed.insertCitation(keys)  // after onCite: put \cite{key} / [@key] at the cursor
//   ed.focus(); ed.destroy();
//
// Source fidelity: blocks you don't edit are written back byte for byte; an edited block is
// rewritten keeping its original line breaks where the words didn't change (see roundtrip.js).
import "katex/dist/katex.min.css";
import "./wysiwyg.css";
import { EditorState, Plugin, TextSelection, Selection } from "prosemirror-state";
import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
import { Slice, Fragment } from "prosemirror-model";
import { history } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { tableEditing } from "prosemirror-tables";
import DOMPurify from "dompurify";
import { schema } from "./schema.js";
import { parseMarkdown, serializeMarkdown, parseMarkdownFragment } from "./markdown.js";
import { parseLatex, serializeLatex, parseLatexFragment, makeCtx, texMeta } from "./latex.js";
import { makeNodeViews, highlightPlugin, numberingPlugin, Popover } from "./views.js";
import { buildKeymap, buildInputRules, insertCitation } from "./commands.js";
import { tableUI } from "./tables.js";
import { buildRibbon, showMenu, closePanel, insertImage } from "./toolbar.js";

const S = schema.nodes;
const FORMATS = {
  md: { parse: parseMarkdown, serialize: serializeMarkdown },
  tex: { parse: parseLatex, serialize: serializeLatex },
};

function relPathFn(dir) {
  return (p) => {
    const n = (s) => String(s || "").replace(/\\/g, "/");
    const a = n(p), d = n(dir).replace(/\/+$/, "");
    if (d && a.toLowerCase().startsWith(d.toLowerCase() + "/")) return a.slice(d.length + 1);
    return a;
  };
}

const looksLikeMarkdown = (t) => /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|```|~~~|\|.*\|)|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\)|`[^`\n]+`|\$[^$\n]+\$/.test(t);
const looksLikeLatex = (t) => /\\[a-zA-Z]+[{[*]|\\(begin|section|item)\b|\$[^$\n]+\$/.test(t) && !/(^|[^\\])%/.test(t);

export function mountVisual(el, opts = {}) {
  const kind = opts.kind === "tex" ? "tex" : "md";
  const fmt = FORMATS[kind];
  const onChange = opts.onChange || (() => {});

  // ---- DOM ----
  const root = document.createElement("div");
  root.className = "wy-root wy-kind-" + kind;
  const scroller = document.createElement("div");
  scroller.className = "wy-scroll";
  const page = document.createElement("div");
  page.className = "wy-page";
  scroller.appendChild(page);

  const ctx = {
    kind,
    dir: opts.dir || "",
    fileSrc: opts.fileSrc || ((p) => p),
    onCite: opts.onCite || null,
    pickImage: opts.pickImage || null,
    citeCommand: opts.citeCommand || "\\cite",
    relPath: relPathFn(opts.dir || ""),
    scroller,
    popover: new Popover(scroller),
    showMenu: (x, y, items) => showMenu(x, y, items),
    view: null,
    macros: {}, theorems: new Map(), graphicsPaths: [], hasChapter: false, meta: {},
  };
  const ribbon = buildRibbon(ctx);
  root.append(ribbon.el, scroller);
  el.appendChild(root);

  // ---- state ----
  let rt = null;
  const applyRt = () => {
    if (kind !== "tex") return;
    const c = rt.ctx || {};
    ctx.macros = c.macros || {};
    ctx.theorems = c.theorems || new Map();
    ctx.graphicsPaths = c.graphicsPaths || [];
    ctx.hasChapter = !!c.hasChapter;
    ctx.meta = rt.meta || {};
  };
  // source line of each top-level block (for scrolling together with the PDF / preview)
  let lineOf = new Map();
  const mapLines = (text, doc) => {
    lineOf = new Map();
    let cur = 0, line = 1, counted = 0;
    const lineAt = (pos) => { for (let i = counted; i < pos; i++) if (text.charCodeAt(i) === 10) line++; counted = Math.max(counted, pos); return line; };
    if (kind === "tex" && rt?.hasDoc) { const b = text.indexOf("\\begin{document}"); if (b >= 0) cur = b; if (doc.firstChild) lineOf.set(doc.firstChild, 1); }
    for (const r of rt?.recs || []) {
      if (!r.src) continue;
      const at = text.indexOf(r.src, cur);
      if (at < 0) continue;
      lineOf.set(r.node, lineAt(at));
      cur = at + r.src.length;
    }
  };
  const parse = (text) => {
    const r = fmt.parse(text);
    rt = r.rt;
    applyRt();
    root.classList.toggle("wy-long", r.doc.childCount > 250);
    try { mapLines(text, r.doc); } catch { lineOf = new Map(); }
    return r.doc;
  };
  /** Top-level blocks with their DOM and (known or interpolated) source line. */
  const blocks = () => {
    const out = [];
    let pos = 0, lastLine = 1;
    view.state.doc.forEach((node, off) => {
      const dom = view.nodeDOM(off);
      const l = lineOf.get(node);
      out.push({ node, dom: dom && dom.nodeType === 1 ? dom : null, line: l ?? null });
      pos = off;
    });
    // edited / new blocks: between their neighbours
    for (let i = 0; i < out.length; i++) {
      if (out[i].line != null) { lastLine = out[i].line; continue; }
      let j = i; while (j < out.length && out[j].line == null) j++;
      const next = j < out.length ? out[j].line : lastLine + (j - i);
      for (let k = i; k < j; k++) out[k].line = lastLine + ((next - lastLine) * (k - i + 1)) / (j - i + 1);
      i = j - 1;
    }
    return out;
  };
  let syncing = 0;
  scroller.addEventListener("scroll", () => {
    if (!opts.onScroll || performance.now() < syncing) return;
    cancelAnimationFrame(scroller._raf);
    scroller._raf = requestAnimationFrame(() => { const l = topLine(); if (l != null) opts.onScroll(l); });
  }, { passive: true });
  const topLine = () => {
    const top = scroller.getBoundingClientRect().top + 8;
    const bs = blocks();
    for (let i = 0; i < bs.length; i++) {
      const r = bs[i].dom?.getBoundingClientRect();
      if (!r || r.bottom < top) continue;
      const next = bs[i + 1]?.line ?? bs[i].line + 1;
      const frac = r.height > 0 ? Math.min(1, Math.max(0, (top - r.top) / r.height)) : 0;
      return bs[i].line + frac * Math.max(0, next - bs[i].line);
    }
    return null;
  };
  const scrollToLine = (line) => {
    const bs = blocks();
    let i = 0;
    while (i + 1 < bs.length && bs[i + 1].line <= line) i++;
    const b = bs[i];
    if (!b?.dom) return;
    const next = bs[i + 1]?.line ?? b.line + 1;
    const frac = next > b.line ? Math.min(1, Math.max(0, (line - b.line) / (next - b.line))) : 0;
    const r = b.dom.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
    syncing = performance.now() + 250;
    scroller.scrollTop += r.top - sr.top + frac * r.height - 8;
  };

  // keep the LaTeX preamble block: it can be edited but not removed
  const keepPreamble = new Plugin({
    appendTransaction(trs, oldState, newState) {
      if (kind !== "tex" || !rt || !rt.hasDoc) return null;
      const was = oldState.doc.firstChild, now = newState.doc.firstChild;
      const isPre = (n) => n && n.type === S.raw_block && n.attrs.kind === "preamble";
      if (isPre(was) && !isPre(now)) return newState.tr.insert(0, was); // (same undo step as the deletion)
      return null;
    },
  });

  // mark the top-level block(s) holding the selection (see .wy-long in the CSS)
  const activeBlock = new Plugin({
    props: {
      decorations(state) {
        const { from, to } = state.selection;
        const decos = [];
        state.doc.nodesBetween(from, Math.max(from, to), (n, pos) => { decos.push(Decoration.node(pos, pos + n.nodeSize, { class: "wy-active" })); return false; });
        return DecorationSet.create(state.doc, decos);
      },
    },
  });

  const plugins = () => [
    buildInputRules(ctx),
    keymap(buildKeymap(ctx)),
    keymap(baseKeymap),
    history({ depth: 300, newGroupDelay: 600 }),
    dropCursor({ color: "var(--accent, #138a43)", width: 2 }),
    gapCursor(),
    tableEditing({ allowTableNodeSelection: true }),
    tableUI(ctx),
    highlightPlugin(kind),
    ...(kind === "tex" ? [numberingPlugin(ctx)] : []),
    keepPreamble,
    activeBlock,
  ];
  const makeState = (doc) => {
    // start in the first paragraph of the body, not in the preamble
    let sel;
    doc.descendants((n, pos) => {
      if (sel) return false;
      if (n.isTextblock && !n.type.spec.code) { sel = TextSelection.create(doc, pos + 1); return false; }
      return !(n.type.spec.code);
    });
    return EditorState.create({ doc, plugins: plugins(), selection: sel });
  };

  // ---- change emission ----
  let lastEmitted = opts.text || "";
  let timer = 0, dirty = false, preambleSeen = null;
  const serialize = () => fmt.serialize(view.state.doc, rt);
  const emit = () => {
    clearTimeout(timer);
    timer = 0;
    if (!dirty) return;
    dirty = false;
    let text;
    try { text = serialize(); } catch (e) { console.error("[wysiwyg] serialize failed", e); return; }
    if (text === lastEmitted) return;
    lastEmitted = text;
    // a changed preamble changes macros / theorem names for what's displayed
    if (kind === "tex" && rt.hasDoc) {
      const pre = view.state.doc.firstChild;
      if (pre !== preambleSeen && pre.attrs.kind === "preamble") {
        preambleSeen = pre;
        const c = makeCtx(pre.textContent, "");
        const macros = JSON.stringify(c.macros) === JSON.stringify(ctx.macros) ? ctx.macros : c.macros;
        Object.assign(ctx, { macros, theorems: c.theorems, graphicsPaths: c.graphicsPaths, meta: texMeta(pre.textContent) });
      }
    }
    try { onChange(text); } catch (e) { console.error(e); }
  };

  const view = new EditorView(page, {
    state: makeState(parse(opts.text || "")),
    nodeViews: makeNodeViews(ctx),
    attributes: { class: "wy-doc", spellcheck: "true", "aria-label": kind === "tex" ? "LaTeX document" : "Markdown document" },
    dispatchTransaction(tr) {
      const ns = view.state.apply(tr);
      view.updateState(ns);
      ribbon.update(ns);
      if (tr.docChanged) {
        dirty = true;
        clearTimeout(timer);
        timer = setTimeout(emit, 300);
      }
      if (ctx.popover.el) ctx.popover.place();
    },
    transformPastedHTML(html) {
      return DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "meta", "link", "base", "svg", "math"], FORBID_ATTR: ["style"] });
    },
    clipboardTextParser(text, $context, plain) {
      if ($context.parent.type.spec.code) return new Slice(Fragment.from(schema.text(text.replace(/\r\n?/g, "\n"))), 0, 0);
      try {
        let nodes = null;
        if (kind === "md" && looksLikeMarkdown(text)) nodes = parseMarkdownFragment(text.replace(/\r\n?/g, "\n"), rt.env);
        else if (kind === "tex" && looksLikeLatex(text)) nodes = parseLatexFragment(text.replace(/\r\n?/g, "\n"), rt.ctx);
        if (nodes && nodes.length) return Slice.maxOpen(Fragment.fromArray(nodes));
      } catch { /* plain text then */ }
      // plain text: blank lines separate paragraphs; single newlines inside become spaces
      const paras = text.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
      return Slice.maxOpen(Fragment.fromArray(paras.map((p) => S.paragraph.create(null, schema.text(p)))));
    },
    transformPasted(slice) {
      // nodes the format can't write: drop pasted web images in LaTeX, keep everything else
      if (kind !== "tex") return slice;
      const strip = (frag) => {
        const out = [];
        frag.forEach((n) => {
          if (n.type === S.image && !n.attrs.tex) return;
          out.push(n.isLeaf ? n : n.copy(strip(n.content)));
        });
        return Fragment.fromArray(out);
      };
      try { return new Slice(strip(slice.content), slice.openStart, slice.openEnd); } catch { return slice; }
    },
    handleKeyDown(v, e) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); root.querySelector(".wy-btn[aria-label^='Link']")?.click(); return true; }
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "c" && ctx.onCite) { e.preventDefault(); ctx.onCite(); return true; }
      return false;
    },
  });
  ctx.view = view;
  preambleSeen = kind === "tex" && rt.hasDoc ? view.state.doc.firstChild : null;
  ribbon.update(view.state);

  // clicking the page margin below the last block puts the cursor at the end (like Word)
  page.addEventListener("mousedown", (e) => {
    if (e.target !== page) return;
    const last = view.dom.lastElementChild;
    if (last && e.clientY > last.getBoundingClientRect().bottom) {
      e.preventDefault();
      const end = Selection.atEnd(view.state.doc);
      let tr = view.state.tr;
      if (!view.state.doc.lastChild.isTextblock) { tr = tr.insert(view.state.doc.content.size, S.paragraph.create()); }
      tr.setSelection(Selection.atEnd(tr.doc));
      view.dispatch(tr.scrollIntoView());
      view.focus();
    }
  });

  return {
    view,
    /** The source line at the top of the page (fractional), and scrolling to one. */
    topSourceLine: () => topLine(),
    scrollToSourceLine: (line) => scrollToLine(line),
    /** For the mirrored preview: the scroller, the page, and each top-level block with its source line. */
    layoutInfo: () => ({ scroller, page, doc: view.dom, blocks: blocks().map((b) => ({ line: b.line, el: b.dom })) }),
    /** Mirror mode: lay out every block (no lazy layout), so positions are exact. */
    setMirror(on) { root.classList.toggle("wy-mirror", !!on); },
    update(text) {
      if (text === lastEmitted) return;
      clearTimeout(timer); timer = 0; dirty = false;
      lastEmitted = text;
      const top = scroller.scrollTop;
      const head = view.state.selection.head;
      const doc = parse(text);
      const st = makeState(doc);
      let sel = null;
      try { sel = Selection.near(doc.resolve(Math.min(head, doc.content.size))); } catch { /* start */ }
      view.updateState(sel ? st.apply(st.tr.setSelection(sel)) : st);
      preambleSeen = kind === "tex" && rt.hasDoc ? view.state.doc.firstChild : null;
      ribbon.update(view.state);
      scroller.scrollTop = top;
    },
    flush() { if (dirty) emit(); },
    getText() { return dirty ? serialize() : lastEmitted; },
    focus() { view.focus(); },
    insertCitation(keys) { insertCitation(ctx, keys)(view.state, view.dispatch); view.focus(); },
    insertImage() { return insertImage(ctx); },
    destroy() {
      if (dirty) emit();
      clearTimeout(timer);
      ctx.popover.close();
      closePanel();
      view.destroy();
      root.remove();
    },
  };
}
