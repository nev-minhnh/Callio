// The Word-like ribbon above the page, plus small dropdown/menu helpers.
import { undo, redo, undoDepth, redoDepth } from "prosemirror-history";
import { liftListItem, sinkListItem } from "prosemirror-schema-list";
import { schema } from "./schema.js";
import {
  markActive, currentStyle, ancestor, setStyle, toggleList, indent, outdent, insertMath, insertDisplayMath,
  insertFootnote, insertCitation, setLink, insertBlock, figureNode, tableNode, ensurePackage, toggleMarkCmd,
} from "./commands.js";

const S = schema.nodes, M = schema.marks;
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const svg = (body, w = 18) => `<svg viewBox="0 0 20 20" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  bold: '<span class="wy-glyph b">B</span>',
  italic: '<span class="wy-glyph i">I</span>',
  underline: '<span class="wy-glyph u">U</span>',
  strike: '<span class="wy-glyph s">S</span>',
  code: svg('<path d="M7 6l-4 4 4 4M13 6l4 4-4 4"/>'),
  link: svg('<path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-1 1"/><path d="M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l1-1"/>'),
  ul: svg('<circle cx="4" cy="5.5" r="1" fill="currentColor"/><circle cx="4" cy="10" r="1" fill="currentColor"/><circle cx="4" cy="14.5" r="1" fill="currentColor"/><path d="M8 5.5h9M8 10h9M8 14.5h9"/>'),
  ol: svg('<path d="M8 5.5h9M8 10h9M8 14.5h9"/><text x="1.6" y="7.4" font-size="5.6" fill="currentColor" stroke="none" font-family="sans-serif">1</text><text x="1.6" y="12" font-size="5.6" fill="currentColor" stroke="none" font-family="sans-serif">2</text><text x="1.6" y="16.6" font-size="5.6" fill="currentColor" stroke="none" font-family="sans-serif">3</text>'),
  task: svg('<rect x="2.5" y="3.5" width="5" height="5" rx="1"/><path d="M3.6 6l1.2 1.2 2-2.2"/><rect x="2.5" y="11.5" width="5" height="5" rx="1"/><path d="M10 6h7M10 14h7"/>'),
  outdent: svg('<path d="M3 4.5h14M9 8.5h8M9 12h8M3 15.5h14"/><path d="M6 8l-2.5 2.2L6 12.5"/>'),
  indent: svg('<path d="M3 4.5h14M9 8.5h8M9 12h8M3 15.5h14"/><path d="M3.5 8L6 10.2 3.5 12.5"/>'),
  image: svg('<rect x="2.5" y="3.5" width="15" height="13" rx="1.5"/><circle cx="7" cy="8" r="1.5"/><path d="M3 15l4.5-4.5 3 3 2-2 4.5 4.5"/>'),
  table: svg('<rect x="2.5" y="3.5" width="15" height="13" rx="1"/><path d="M2.5 8h15M2.5 12.3h15M7.5 3.5v13M12.5 3.5v13"/>'),
  math: '<span class="wy-glyph math">𝑥²</span>',
  equation: '<span class="wy-glyph math">π</span>',
  footnote: '<span class="wy-glyph fn">ab<sup>1</sup></span>',
  cite: svg('<path d="M4 6.5h4v4H5.5c0 2 .8 3 2.5 3.5M12 6.5h4v4h-2.5c0 2 .8 3 2.5 3.5"/>'),
  undo: svg('<path d="M7.5 5L4 8.5 7.5 12"/><path d="M4.5 8.5H12a4 4 0 0 1 0 8H9"/>'),
  redo: svg('<path d="M12.5 5L16 8.5 12.5 12"/><path d="M15.5 8.5H8a4 4 0 0 0 0 8h3"/>'),
  caret: '<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// ---------------- menus / dropdown panels ----------------
let openPanel = null;
function closePanel() {
  if (!openPanel) return;
  const p = openPanel;
  openPanel = null;
  p.el.remove();
  document.removeEventListener("mousedown", p.outside, true);
  document.removeEventListener("keydown", p.key, true);
  window.removeEventListener("blur", closePanel);
  if (p.anchor) p.anchor.classList.remove("open");
  if (p.onClose) p.onClose();
}
/** A floating panel at (x, y) (viewport coordinates), or under `anchor`. */
export function showPanel({ x, y, anchor, cls, build, onClose }) {
  closePanel();
  const el = h("div", "wy-panel " + (cls || ""));
  el.addEventListener("mousedown", (e) => { if (!/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) e.preventDefault(); });
  document.body.appendChild(el);
  const focus = build(el, closePanel);
  if (anchor) { const r = anchor.getBoundingClientRect(); x = r.left; y = r.bottom + 4; anchor.classList.add("open"); }
  const w = el.offsetWidth, hgt = el.offsetHeight;
  el.style.left = Math.max(6, Math.min(x, window.innerWidth - w - 6)) + "px";
  el.style.top = (y + hgt > window.innerHeight - 6 ? Math.max(6, y - hgt - (anchor ? anchor.offsetHeight + 8 : 0)) : y) + "px";
  const outside = (e) => { if (!el.contains(e.target) && e.target !== anchor && !(anchor && anchor.contains(e.target))) closePanel(); };
  const key = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePanel(); } };
  openPanel = { el, outside, key, anchor, onClose };
  setTimeout(() => { if (openPanel && openPanel.el === el) { document.addEventListener("mousedown", outside, true); document.addEventListener("keydown", key, true); window.addEventListener("blur", closePanel); } }, 0);
  if (focus) requestAnimationFrame(() => focus.focus());
  return el;
}
export function showMenu(x, y, items, anchor) {
  showPanel({
    x, y, anchor, cls: "wy-menu",
    build(el, close) {
      for (const it of items) {
        if (!it) { el.appendChild(h("div", "wy-menu-sep")); continue; }
        const [label, fn, cls, html] = it;
        const b = h("button", "wy-menu-item " + (cls || ""));
        b.type = "button";
        if (html) b.innerHTML = html; else b.textContent = label;
        b.addEventListener("click", () => { close(); fn(); });
        el.appendChild(b);
      }
    },
  });
}
export { closePanel };

// ---------------- the ribbon ----------------
export function buildRibbon(ctx) {
  const el = h("div", "wy-ribbon");
  el.setAttribute("role", "toolbar");
  el.addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
  const tex = ctx.kind === "tex";
  const run = (cmd) => { const v = ctx.view; cmd(v.state, v.dispatch, v); v.focus(); };
  const btns = {};
  let grp = null;
  const group = () => { grp = h("div", "wy-grp"); el.appendChild(grp); return grp; };
  const button = (id, title, icon, onClick, label) => {
    const b = h("button", "wy-btn" + (label ? " labeled" : ""));
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title.replace(/\s*\(.*\)$/, ""));
    b.innerHTML = icon + (label ? `<span class="wy-btn-label">${label}</span>` : "");
    b.addEventListener("click", (e) => onClick(e, b));
    grp.appendChild(b);
    btns[id] = b;
    return b;
  };

  // paragraph style
  group().classList.add("style");
  const STYLES = tex
    ? [["p", "Normal"], ...(ctx.hasChapter ? [["h1", "Chapter"], ["h2", "Section"], ["h3", "Subsection"], ["h4", "Subsubsection"]] : [["h1", "Section"], ["h2", "Subsection"], ["h3", "Subsubsection"], ["h4", "Paragraph"]]), ["quote", "Quote"], ["code", "Verbatim"]]
    : [["p", "Normal text"], ["h1", "Heading 1"], ["h2", "Heading 2"], ["h3", "Heading 3"], ["h4", "Heading 4"], ["quote", "Quote"], ["code", "Code block"]];
  const styleBtn = h("button", "wy-style");
  styleBtn.type = "button";
  styleBtn.title = "Paragraph style";
  styleBtn.innerHTML = `<span class="wy-style-name">Normal</span>${ICONS.caret}`;
  grp.appendChild(styleBtn);
  styleBtn.addEventListener("click", () => {
    if (openPanel && openPanel.anchor === styleBtn) return closePanel();
    const cur = currentStyle(ctx.view.state);
    showPanel({
      anchor: styleBtn, cls: "wy-menu wy-style-menu",
      build(p, close) {
        for (const [id, name] of STYLES) {
          const b = h("button", "wy-menu-item st-" + id + (id === cur ? " on" : ""));
          b.type = "button";
          b.appendChild(h("span", "wy-st-preview", name));
          b.addEventListener("click", () => { close(); run(setStyle(ctx, id)); });
          p.appendChild(b);
        }
      },
    });
  });

  // character formatting
  group();
  button("bold", "Bold (Ctrl+B)", ICONS.bold, () => run(toggleMarkCmd(M.strong)));
  button("italic", tex ? "Emphasis (Ctrl+I)" : "Italic (Ctrl+I)", ICONS.italic, () => run(toggleMarkCmd(M.em)));
  if (tex) button("underline", "Underline (Ctrl+U)", ICONS.underline, () => run(toggleMarkCmd(M.underline)));
  else button("strike", "Strikethrough (Ctrl+Shift+X)", ICONS.strike, () => run(toggleMarkCmd(M.strike)));
  button("code", tex ? "Typewriter \\texttt (Ctrl+E)" : "Inline code (Ctrl+E)", ICONS.code, () => run(toggleMarkCmd(M.code)));
  button("link", "Link (Ctrl+K)", ICONS.link, (e, b) => linkPanel(ctx, b));

  // lists
  group();
  button("ul", "Bulleted list", ICONS.ul, () => run(toggleList(ctx, S.bullet_list)));
  button("ol", "Numbered list", ICONS.ol, () => run(toggleList(ctx, S.ordered_list)));
  if (!tex) button("task", "Task list", ICONS.task, () => run(toggleList(ctx, S.bullet_list, true)));
  button("outdent", "Decrease indent (Shift+Tab)", ICONS.outdent, () => run(outdent));
  button("indent", "Increase indent (Tab)", ICONS.indent, () => run(indent));

  // insert
  group();
  button("image", tex ? "Insert figure" : "Insert image", ICONS.image, () => insertImage(ctx), tex ? "Figure" : "Image");
  const tb = button("table", "Insert table", ICONS.table, (e, b) => tablePicker(ctx, b), "Table" + ICONS.caret);
  tb.classList.add("dd");

  group();
  button("math", "Inline math (Ctrl+M)", ICONS.math, () => run(insertMath(ctx)));
  button("equation", "Display equation (Ctrl+Shift+M)", ICONS.equation, () => run(insertDisplayMath(ctx)), "Equation");
  button("footnote", "Footnote", ICONS.footnote, () => run(insertFootnote(ctx)));
  button("cite", "Cite (Alt+C)", ICONS.cite, (e, b) => (ctx.onCite ? ctx.onCite() : citePanel(ctx, b)), "Cite");

  group().classList.add("history");
  button("undo", "Undo (Ctrl+Z)", ICONS.undo, () => run(undo));
  button("redo", "Redo (Ctrl+Y)", ICONS.redo, () => run(redo));

  const styleName = styleBtn.querySelector(".wy-style-name");
  return {
    el,
    update(state) {
      for (const [id, type] of [["bold", M.strong], ["italic", M.em], ["underline", M.underline], ["strike", M.strike], ["code", M.code], ["link", M.link]]) {
        if (btns[id]) btns[id].classList.toggle("on", markActive(state, type));
      }
      const list = ancestor(state, [S.bullet_list, S.ordered_list]);
      const isTask = list && list.node.firstChild && list.node.firstChild.attrs.checked != null;
      btns.ul.classList.toggle("on", !!list && list.node.type === S.bullet_list && !isTask);
      btns.ol.classList.toggle("on", !!list && list.node.type === S.ordered_list);
      if (btns.task) btns.task.classList.toggle("on", !!isTask);
      btns.indent.disabled = !sinkListItem(S.list_item)(state);
      btns.outdent.disabled = !liftListItem(S.list_item)(state);
      btns.undo.disabled = undoDepth(state) === 0;
      btns.redo.disabled = redoDepth(state) === 0;
      const st = currentStyle(state);
      const par = state.selection.$from.parent;
      const OTHER = { meta: (par.attrs.cmd || "").replace(/^./, (c) => c.toUpperCase()), caption: "Caption", table_cell: "Table cell", table_header: "Table header", footnote_def: "Footnote", raw_block: par.attrs.kind === "preamble" ? "Document settings" : "Source", code_block: tex ? "Verbatim" : "Code block" };
      const name = (STYLES.find((s) => s[0] === st) || [null, OTHER[par.type.name] || "—"])[1];
      if (styleName.textContent !== name) styleName.textContent = name;
      const code = state.selection.$from.parent.type.spec.code;
      for (const id of ["bold", "italic", "underline", "strike", "code", "link", "math", "footnote", "cite"]) if (btns[id]) btns[id].disabled = !!code;
    },
  };
}

function linkPanel(ctx, anchor) {
  const view = ctx.view;
  const { from, to } = view.state.selection;
  let cur = "";
  view.state.doc.nodesBetween(from, Math.max(to, from + 1), (n) => { const m = M.link.isInSet(n.marks); if (m) cur = m.attrs.href; });
  showPanel({
    anchor, cls: "wy-form",
    build(el, close) {
      el.appendChild(h("div", "wy-pop-title", "Link"));
      const i = h("input", "wy-pop-input");
      i.type = "url";
      i.placeholder = "https://";
      i.value = cur;
      el.appendChild(i);
      const row = h("div", "wy-form-row");
      const ok = h("button", "wy-pop-btn primary", cur ? "Update" : "Insert");
      const rm = h("button", "wy-pop-btn", "Remove");
      rm.hidden = !cur;
      row.append(ok, rm);
      el.appendChild(row);
      const apply = (href) => { close(); setLink(ctx, href)(view.state, view.dispatch); view.focus(); };
      ok.addEventListener("click", () => apply(i.value.trim()));
      rm.addEventListener("click", () => apply(""));
      i.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); apply(i.value.trim()); } });
      return i;
    },
  });
}

function citePanel(ctx, anchor) {
  const view = ctx.view;
  showPanel({
    anchor, cls: "wy-form",
    build(el, close) {
      el.appendChild(h("div", "wy-pop-title", "Cite"));
      const i = h("input", "wy-pop-input mono");
      i.type = "text";
      i.placeholder = "citation key, e.g. smith2020";
      el.appendChild(i);
      const go = () => { const keys = i.value.split(/[\s,;]+/).map((k) => k.replace(/^@/, "")).filter(Boolean); close(); if (keys.length) insertCitation(ctx, keys)(view.state, view.dispatch); view.focus(); };
      i.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
      return i;
    },
  });
}

function tablePicker(ctx, anchor) {
  if (openPanel && openPanel.anchor === anchor) return closePanel();
  const COLS = 10, ROWS = 8;
  showPanel({
    anchor, cls: "wy-grid-panel",
    build(el, close) {
      const label = h("div", "wy-grid-label", "Insert Table");
      const grid = h("div", "wy-grid");
      grid.style.gridTemplateColumns = `repeat(${COLS}, 1fr)`;
      const cells = [];
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        const d = h("div", "wy-grid-cell");
        d.dataset.r = r; d.dataset.c = c;
        grid.appendChild(d);
        cells.push(d);
      }
      const mark = (R, C) => {
        for (const d of cells) d.classList.toggle("on", +d.dataset.r <= R && +d.dataset.c <= C);
        label.textContent = R < 0 ? "Insert Table" : `${C + 1}×${R + 1} Table`;
      };
      grid.addEventListener("mousemove", (e) => { const d = e.target.closest(".wy-grid-cell"); if (d) mark(+d.dataset.r, +d.dataset.c); });
      grid.addEventListener("mouseleave", () => mark(-1, -1));
      grid.addEventListener("click", (e) => {
        const d = e.target.closest(".wy-grid-cell");
        if (!d) return;
        close();
        insertTable(ctx, +d.dataset.r + 1, +d.dataset.c + 1);
      });
      el.append(label, grid);
    },
  });
}

export function insertTable(ctx, rows, cols) {
  const view = ctx.view;
  const node = tableNode(ctx, Math.max(rows, 1), Math.max(cols, 1));
  insertBlock(view.state, view.dispatch, node, true);
  if (ctx.kind === "tex") ensurePackage(ctx, "booktabs");
  view.focus();
}

export async function insertImage(ctx) {
  const view = ctx.view;
  let path = null;
  if (ctx.pickImage) path = await ctx.pickImage();
  else path = "figure.png";
  if (!path) return;
  const rel = ctx.relPath(path);
  if (ctx.kind === "tex") {
    insertBlock(view.state, view.dispatch, figureNode(ctx, rel), false);
    // put the cursor in the caption
    const { $from } = view.state.selection;
    let pos = null;
    view.state.doc.nodesBetween(Math.max(0, $from.pos - 4), Math.min(view.state.doc.content.size, $from.pos + 400), (n, p) => { if (pos == null && n.type === S.caption) pos = p + 1; });
    ensurePackage(ctx, "graphicx");
  } else {
    const img = S.image.create({ src: /\s/.test(rel) ? rel : rel, alt: rel.replace(/^.*\//, "").replace(/\.[^.]+$/, "") });
    insertBlock(view.state, view.dispatch, S.paragraph.create(null, img));
  }
  view.focus();
}
