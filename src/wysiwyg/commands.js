// Editing commands, keyboard shortcuts and input rules for the visual editor.
import { toggleMark, setBlockType, wrapIn, lift, chainCommands, exitCode, baseKeymap, joinBackward, selectNodeBackward, deleteSelection } from "prosemirror-commands";
import { wrapInList, splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { undo, redo } from "prosemirror-history";
import { inputRules, wrappingInputRule, textblockTypeInputRule, InputRule } from "prosemirror-inputrules";
import { NodeSelection, TextSelection, Selection } from "prosemirror-state";
import { Fragment } from "prosemirror-model";
import { isInTable, goToNextCell } from "prosemirror-tables";
import { schema } from "./schema.js";
import { addRowAt, cellPosition } from "./tables.js";

const S = schema.nodes, M = schema.marks;

// ---------------- what is at the cursor ----------------
export function markActive(state, type) {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}
/** The innermost ancestor of the selection start of one of the given types: { node, pos, depth } */
export function ancestor(state, types) {
  const $f = state.selection.$from;
  for (let d = $f.depth; d > 0; d--) {
    const n = $f.node(d);
    if (types.includes(n.type)) return { node: n, pos: $f.before(d), depth: d };
  }
  return null;
}
/** Paragraph style at the cursor: p, h1..h6, quote, code */
export function currentStyle(state) {
  const $f = state.selection.$from;
  const p = $f.parent;
  if (p.type === S.heading) return "h" + p.attrs.level;
  if (p.type === S.code_block) return "code";
  if (ancestor(state, [S.blockquote])) return "quote";
  if (p.type === S.paragraph) return "p";
  return null;
}

// ---------------- marks ----------------
export function toggleMarkCmd(type) {
  return (state, dispatch) => toggleMark(type)(state, dispatch);
}

// ---------------- block style ----------------
export function setStyle(ctx, style) {
  return (state, dispatch, view) => {
    const tex = ctx.kind === "tex";
    if (style === "quote") {
      const q = ancestor(state, [S.blockquote]);
      if (q) return lift(state, dispatch);
      if (state.selection.$from.parent.type !== S.paragraph) setBlockType(S.paragraph)(state, (tr) => { state = state.apply(tr); dispatch && dispatch(tr); });
      return wrapIn(S.blockquote, tex ? { open: "\\begin{quote}", close: "\\end{quote}" } : null)(state, dispatch);
    }
    if (style === "code") {
      if (state.selection.$from.parent.type === S.code_block) return setBlockType(S.paragraph)(state, dispatch);
      return setBlockType(S.code_block, tex ? { open: "\\begin{verbatim}\n", close: "\n\\end{verbatim}" } : { lang: "" })(state, dispatch);
    }
    if (style === "p") return setBlockType(S.paragraph)(state, dispatch);
    const level = +style.slice(1);
    let attrs = { level };
    if (tex) {
      const cmds = ctx.hasChapter ? ["", "chapter", "section", "subsection", "subsubsection", "paragraph"] : ["", "section", "subsection", "subsubsection", "paragraph", "subparagraph"];
      const cur = state.selection.$from.parent;
      attrs = { level, cmd: cmds[level] || "paragraph", star: cur.type === S.heading ? cur.attrs.star : false, label: cur.type === S.heading ? cur.attrs.label : null, labelSep: cur.type === S.heading ? cur.attrs.labelSep : "" };
    }
    return setBlockType(S.heading, attrs)(state, dispatch);
  };
}

// ---------------- lists ----------------
function listAttrs(ctx, type) {
  if (ctx.kind !== "tex") return type === S.bullet_list ? { bullet: "-" } : { start: 1, delim: "." };
  const env = type === S.ordered_list ? "enumerate" : "itemize";
  return { open: `\\begin{${env}}`, close: `\\end{${env}}`, env };
}
export function toggleList(ctx, type, task = false) {
  return (state, dispatch) => {
    const list = ancestor(state, [S.bullet_list, S.ordered_list]);
    if (list) {
      const isTask = list.node.firstChild && list.node.firstChild.attrs.checked != null;
      if (list.node.type === type && isTask === task) return liftListItem(S.list_item)(state, dispatch);
      if (dispatch) {
        const tr = state.tr;
        if (list.node.type !== type) tr.setNodeMarkup(list.pos, type, listAttrs(ctx, type));
        if (task !== isTask) list.node.forEach((item, off) => { tr.setNodeMarkup(list.pos + 1 + off, null, { ...item.attrs, checked: task ? false : null }); });
        dispatch(tr);
      }
      return true;
    }
    return wrapInList(type, listAttrs(ctx, type))(state, dispatch && ((tr) => {
      if (task) {
        const l = (() => { const $f = tr.selection.$from; for (let d = $f.depth; d > 0; d--) if ($f.node(d).type === type) return { node: $f.node(d), pos: $f.before(d) }; return null; })();
        if (l) l.node.forEach((item, off) => tr.setNodeMarkup(l.pos + 1 + off, null, { ...item.attrs, checked: false }));
      }
      dispatch(tr);
    }));
  };
}
export const indent = (state, dispatch) => sinkListItem(S.list_item)(state, dispatch);
export const outdent = (state, dispatch) => liftListItem(S.list_item)(state, dispatch);

// ---------------- inserting ----------------
/** Insert a block node after the current block (or in place of an empty paragraph). */
export function insertBlock(state, dispatch, node, selectInside = false) {
  const { $from } = state.selection;
  let tr = state.tr;
  // find the textblock we're in (or the selected block)
  let depth = $from.depth;
  while (depth > 0 && !$from.node(depth).isTextblock) depth--;
  const inEmptyPara = depth > 0 && $from.node(depth).type === S.paragraph && $from.node(depth).content.size === 0;
  if (state.selection instanceof NodeSelection && state.selection.node.isBlock) {
    const at = state.selection.to;
    tr.insert(at, node);
    var pos = at;
  } else if (inEmptyPara) {
    const from = $from.before(depth);
    tr.replaceWith(from, from + $from.node(depth).nodeSize, node);
    pos = from;
  } else {
    const at = depth > 0 ? $from.after(depth) : $from.pos;
    // can't put a block inside a table cell / caption: go to after the outermost such block
    let d = depth;
    while (d > 1 && !$from.node(d - 1).type.contentMatch.matchType(node.type)) d--;
    const at2 = d > 0 ? $from.after(d) : at;
    tr.insert(at2, node);
    pos = at2;
  }
  const after = pos + node.nodeSize;
  if (selectInside) {
    // into the first table cell if there is one (a new table), else the first text
    let cell = null;
    tr.doc.nodesBetween(pos, pos + node.nodeSize, (n, p) => { if (cell == null && (n.type === S.table_header || n.type === S.table_cell)) cell = p + 1; return cell == null; });
    const sel = cell != null ? TextSelection.create(tr.doc, cell) : TextSelection.findFrom(tr.doc.resolve(pos + 1), 1, true);
    if (sel) tr.setSelection(sel);
  } else if (node.isAtom) tr.setSelection(NodeSelection.create(tr.doc, pos));
  else {
    const sel = TextSelection.findFrom(tr.doc.resolve(Math.min(after, tr.doc.content.size)), 1, true);
    if (sel) tr.setSelection(sel);
  }
  // keep a paragraph after a block that ends the document, so the cursor can go there
  if (after >= tr.doc.content.size - 0 && !tr.doc.lastChild.isTextblock) tr.insert(tr.doc.content.size, S.paragraph.create());
  dispatch(tr.scrollIntoView());
  return pos;
}

export function insertInlineAtom(state, dispatch, node, select = true) {
  const tr = state.tr.replaceSelectionWith(node, false);
  const pos = tr.selection.from - node.nodeSize;
  if (select) tr.setSelection(NodeSelection.create(tr.doc, pos));
  dispatch(tr.scrollIntoView());
  return pos;
}

export function insertMath(ctx) {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    const tex = empty ? "" : state.doc.textBetween(from, to, " ");
    if (!dispatch) return true;
    insertInlineAtom(state, dispatch, S.math_inline.create({ tex, open: "$", close: "$" }));
    return true;
  };
}
export function insertDisplayMath(ctx) {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const { from, to, empty } = state.selection;
    const sel = empty ? "" : state.doc.textBetween(from, to, " ");
    const node = ctx.kind === "tex"
      ? S.math_display.create({ env: "equation", open: "\\begin{equation}", close: "\\end{equation}", tex: "\n  " + sel + "\n" })
      : S.math_display.create({ tex: sel, open: "$$\n", close: "\n$$" });
    insertBlock(state, dispatch, node);
    return true;
  };
}

export function nextFootnoteLabel(doc) {
  let max = 0;
  doc.descendants((n) => {
    if (n.type === S.footnote_ref || n.type === S.footnote_def) { const v = parseInt(n.attrs.label, 10); if (v > max) max = v; }
    return !n.isLeaf;
  });
  return String(max + 1);
}
export function insertFootnote(ctx) {
  return (state, dispatch, view) => {
    if (!dispatch) return true;
    if (ctx.kind === "tex") { insertInlineAtom(state, dispatch, S.footnote.create({ open: "\\footnote{", body: "" })); return true; }
    const label = nextFootnoteLabel(state.doc);
    let tr = state.tr.replaceSelectionWith(S.footnote_ref.create({ label }), false);
    const def = S.footnote_def.create({ label });
    tr.insert(tr.doc.content.size, def);
    tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Insert a citation for `key` at the cursor, joining an adjacent citation. */
export function insertCitation(ctx, keys) {
  return (state, dispatch) => {
    keys = [].concat(keys).filter(Boolean);
    if (!keys.length) return false;
    const { $from } = state.selection;
    const before = $from.nodeBefore;
    if (before && before.type === S.cite) {
      let src = before.attrs.src;
      if (ctx.kind === "tex") src = src.replace(/\{([^{}]*)\}\s*$/, (m, k) => `{${k}${k.trim() ? "," : ""}${keys.join(",")}}`);
      else src = src.replace(/\]$/, "; " + keys.map((k) => "@" + k).join("; ") + "]");
      const pos = $from.pos - before.nodeSize;
      dispatch && dispatch(state.tr.setNodeMarkup(pos, null, { src }).scrollIntoView());
      return true;
    }
    let tr = state.tr;
    const src = ctx.kind === "tex" ? `${ctx.citeCommand || "\\cite"}{${keys.join(",")}}` : `[${keys.map((k) => "@" + k).join("; ")}]`;
    const prevChar = $from.nodeBefore && $from.nodeBefore.isText ? $from.nodeBefore.text.slice(-1) : "";
    if (ctx.kind === "tex" && prevChar && /[\p{L}\p{N}.,;:)]/u.test(prevChar)) tr.insertText("\u00a0");
    else if (ctx.kind === "md" && prevChar && /[\p{L}\p{N}]/u.test(prevChar)) tr.insertText(" ");
    tr.replaceSelectionWith(S.cite.create({ src }), false);
    dispatch && dispatch(tr.scrollIntoView());
    return true;
  };
}

export function setLink(ctx, href) {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    const tex = ctx.kind === "tex";
    if (!href) { dispatch && dispatch(state.tr.removeMark(from, to, M.link)); return true; }
    const text = empty ? href : state.doc.textBetween(from, to, " ");
    const mark = M.link.create({ href, kind: tex ? (text === href ? "url" : "href") : null });
    if (!dispatch) return true;
    const tr = state.tr;
    if (empty) tr.insert(from, schema.text(text, [mark]));
    else tr.addMark(from, to, mark);
    dispatch(tr.scrollIntoView());
    if (tex) ensurePackage(ctx, "hyperref");
    return true;
  };
}

/** Add \usepackage{name} to the preamble if it isn't loaded. */
export function ensurePackage(ctx, name, opts = "") {
  const view = ctx.view;
  if (!view || ctx.kind !== "tex") return;
  const doc = view.state.doc;
  const pre = doc.firstChild;
  if (!pre || pre.type !== S.raw_block || pre.attrs.kind !== "preamble") return;
  const text = pre.textContent;
  const re = new RegExp(`^[^%\\n]*\\\\(usepackage|RequirePackage)(\\[[^\\]]*\\])?\\{[^}]*\\b${name}\\b[^}]*\\}`, "m");
  if (re.test(text)) return;
  if (name === "graphicx" && /\\documentclass(\[[^\]]*\])?\{(elsarticle|IEEEtran|revtex4-?\d?|amsart|beamer|acmart|llncs|svjour3)\}/.test(text) && name !== "graphicx") return;
  const line = `\\usepackage${opts}{${name}}`;
  // after the last \usepackage line, else at the end of the preamble
  const m = [...text.matchAll(/^[^%\n]*\\usepackage.*$/gm)].pop();
  const at = m ? m.index + m[0].length : text.length;
  const tr = view.state.tr.insertText((at ? "\n" : "") + line, 1 + at);
  tr.setMeta("addToHistory", true);
  view.dispatch(tr);
}

export function figureNode(ctx, relPath) {
  const lab = "fig:" + (relPath.replace(/^.*\//, "").replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-") || "figure");
  return S.float.create({
    env: "figure",
    label: lab,
    parts: ["\\begin{figure}[htbp]\n  \\centering\n  ", { slot: "figure_image" }, "\n  ", { slot: "caption" }, "\n  ", { label: true }, "\n\\end{figure}"],
  }, [
    S.figure_image.create({ cmd: "\\includegraphics", opts: "[width=0.8\\linewidth]", path: relPath }),
    S.caption.create(),
  ]);
}

export function tableNode(ctx, rows, cols) {
  const hdr = () => S.table_header.create();
  const cell = () => S.table_cell.create();
  const mkRow = (cells, attrs) => S.table_row.create(attrs, cells);
  const trs = [mkRow(Array.from({ length: cols }, (_, c) => hdr(c)), ctx.kind === "tex" ? { pre: "\\toprule" } : null)];
  for (let r = 1; r < rows; r++) trs.push(mkRow(Array.from({ length: cols }, cell), ctx.kind === "tex" && r === 1 ? { pre: "\\midrule" } : null));
  if (ctx.kind !== "tex") return S.table.create(null, trs);
  const spec = "l".repeat(cols);
  const table = S.table.create({
    open: `\\begin{tabular}{${spec}}`, close: "\\end{tabular}", post: "\\bottomrule", booktabs: true,
    spec: { pre: "\\begin{tabular}{", items: Array.from({ length: cols }, () => ({ s: "", c: "l" })), end: "", orig: spec },
  }, trs);
  return S.float.create({
    env: "table",
    label: "tab:new",
    parts: ["\\begin{table}[htbp]\n  \\centering\n  ", { slot: "caption" }, "\n  ", { label: true }, "\n  ", { slot: "table" }, "\n\\end{table}"],
  }, [S.caption.create(), table]);
}

// ---------------- keys ----------------
const atStartOf = (state, type) => {
  const { $from, empty } = state.selection;
  return empty && $from.parentOffset === 0 && $from.parent.type === type;
};
// Backspace at the start of a heading / code block makes it a paragraph; at the start of a list item, lifts it
const backspaceToParagraph = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  const p = $from.parent;
  if (p.type === S.heading || (p.type === S.code_block && !p.textContent)) return setBlockType(S.paragraph)(state, dispatch);
  if ($from.depth >= 2 && $from.node(-1).type === S.list_item && $from.index(-1) === 0) return liftListItem(S.list_item)(state, dispatch);
  return false;
};
const hardBreak = (ctx) => (state, dispatch) => {
  if (state.selection.$from.parent.type.spec.code) return false;
  const inCell = isInTable(state);
  const src = ctx.kind === "tex" ? (inCell ? "\\newline " : "\\\\\n") : inCell ? null : "\\\n";
  if (ctx.kind === "md" && inCell) return false;
  dispatch && dispatch(state.tr.replaceSelectionWith(S.hard_break.create({ src })).scrollIntoView());
  return true;
};
const cellEnter = (state, dispatch, view) => {
  if (!isInTable(state)) return false;
  // Enter in a table cell: to the cell below (a new row at the bottom)
  const c = cellPosition(state);
  if (!c) return false;
  if (c.row + 1 >= c.map.height) { if (view) addRowAt(view, c.tablePos, c.map.height, c.col); return true; }
  const pos = c.tableStart + c.map.positionAt(c.row + 1, c.col, c.table);
  dispatch && dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos + 1 + state.doc.nodeAt(pos).content.size)).scrollIntoView());
  return true;
};
const tabInTable = (dir) => (state, dispatch, view) => {
  if (!isInTable(state)) return false;
  if (goToNextCell(dir)(state, dispatch)) return true;
  if (dir > 0 && view) {
    const c = cellPosition(state);
    if (c) { addRowAt(view, c.tablePos, c.map.height, 0); return true; }
  }
  return true;
};
const codeIndent = (state, dispatch) => {
  if (!state.selection.$from.parent.type.spec.code) return false;
  dispatch && dispatch(state.tr.insertText("  "));
  return true;
};

export function buildKeymap(ctx) {
  const k = {};
  k["Mod-z"] = undo;
  k["Shift-Mod-z"] = redo;
  k["Mod-y"] = redo;
  k["Mod-b"] = toggleMark(M.strong);
  k["Mod-i"] = toggleMark(M.em);
  k["Mod-u"] = toggleMark(M.underline);
  k["Mod-Shift-x"] = toggleMark(M.strike);
  k["Mod-`"] = toggleMark(M.code);
  k["Mod-e"] = toggleMark(M.code);
  k["Mod-m"] = insertMath(ctx);
  k["Mod-Shift-m"] = insertDisplayMath(ctx);
  k["Shift-Enter"] = hardBreak(ctx);
  k["Mod-Enter"] = chainCommands(exitCode, hardBreak(ctx));
  k["Enter"] = chainCommands(cellEnter, splitListItem(S.list_item));
  k["Tab"] = chainCommands(tabInTable(1), sinkListItem(S.list_item), codeIndent, () => true);
  k["Shift-Tab"] = chainCommands(tabInTable(-1), liftListItem(S.list_item), () => true);
  k["Backspace"] = chainCommands(deleteSelection, backspaceToParagraph, joinBackward, selectNodeBackward);
  for (let i = 1; i <= 4; i++) k[`Mod-Alt-${i}`] = setStyle(ctx, "h" + i);
  k["Mod-Alt-0"] = setStyle(ctx, "p");
  return k;
}

// ---------------- input rules ----------------
function markRule(re, type, attrs) {
  return new InputRule(re, (state, m, start, end) => {
    const inner = m[2];
    const lead = m[1] || "";
    if (!inner || state.selection.$from.parent.type.spec.code) return null;
    if (state.doc.rangeHasMark(start, end, M.code)) return null;
    const tr = state.tr;
    const s = start + lead.length;
    tr.replaceWith(s, end, schema.text(inner, [...state.selection.$from.marks(), type.create(attrs)]));
    tr.removeStoredMark(type);
    return tr;
  });
}
export function buildInputRules(ctx) {
  const tex = ctx.kind === "tex";
  const rules = [
    wrappingInputRule(/^\s*>\s$/, S.blockquote, tex ? { open: "\\begin{quote}", close: "\\end{quote}" } : null),
    wrappingInputRule(/^\s*([-+*])\s$/, S.bullet_list, (m) => (tex ? listAttrs(ctx, S.bullet_list) : { bullet: m[1] })),
    wrappingInputRule(/^(\d+)([.)])\s$/, S.ordered_list, (m) => (tex ? listAttrs(ctx, S.ordered_list) : { start: +m[1], delim: m[2] }), (m, node) => node.childCount + node.attrs.start === +m[1]),
    textblockTypeInputRule(/^(#{1,4})\s$/, S.heading, (m) => {
      const level = m[1].length;
      if (!tex) return { level };
      const cmds = ctx.hasChapter ? ["", "chapter", "section", "subsection", "subsubsection"] : ["", "section", "subsection", "subsubsection", "paragraph"];
      return { level, cmd: cmds[level] };
    }),
    textblockTypeInputRule(/^```([\w+#-]*)\s$/, S.code_block, (m) => (tex ? { open: "\\begin{verbatim}\n", close: "\n\\end{verbatim}" } : { lang: m[1] })),
    // display math: "$$ " on an empty line
    new InputRule(/^\$\$\s$/, (state, m, start, end) => {
      const $s = state.doc.resolve(start);
      if ($s.parent.type !== S.paragraph) return null;
      const node = tex ? S.math_display.create({ env: "equation", open: "\\begin{equation}", close: "\\end{equation}", tex: "\n  \n" }) : S.math_display.create({ tex: "", open: "$$\n", close: "\n$$" });
      const tr = state.tr.replaceWith($s.before(), $s.after(), node);
      tr.setSelection(NodeSelection.create(tr.doc, $s.before()));
      return tr;
    }),
    // inline math: $x^2$
    new InputRule(/(^|[^$\\\w])\$([^$\s](?:[^$]*[^$\s])?)\$$/, (state, m, start, end) => {
      if (state.selection.$from.parent.type.spec.code) return null;
      const s = start + m[1].length;
      return state.tr.replaceWith(s, end, S.math_inline.create({ tex: m[2], open: "$", close: "$" }));
    }),
    markRule(/(^|[^*])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, M.strong),
    markRule(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*$/, M.em),
    markRule(/(^|[^_\w])_([^_\s](?:[^_]*[^_\s])?)_$/, M.em, tex ? null : { open: "_" }),
    markRule(/(^|[^`])`([^`]+)`$/, M.code),
    markRule(/(^|[^~])~~([^~\s](?:[^~]*[^~\s])?)~~$/, M.strike),
  ];
  if (!tex) {
    rules.push(new InputRule(/^\[([ xX])\]\s$/, (state, m, start, end) => {
      const $s = state.doc.resolve(start);
      if ($s.depth < 2 || $s.node(-1).type !== S.list_item) return null;
      const itemPos = $s.before(-1);
      return state.tr.delete(start, end).setNodeMarkup(itemPos, null, { ...$s.node(-1).attrs, checked: m[1] !== " " });
    }));
    rules.push(new InputRule(/^(?:---|\*\*\*)$/, (state, m, start, end) => {
      const $s = state.doc.resolve(start);
      if ($s.parent.type !== S.paragraph || $s.depth !== 1) return null;
      const tr = state.tr.replaceWith($s.before(), $s.after(), [S.horizontal_rule.create({ markup: m[0] }), S.paragraph.create()]);
      tr.setSelection(TextSelection.create(tr.doc, $s.before() + 2));
      return tr;
    }));
  }
  return inputRules({ rules });
}
