// Word documents (.docx, .doc, .odt, .rtf) edited in place, like Word: the office engine
// lays the document out and draws its pages; this module shows them, draws the caret
// and the selection, and turns every key, click and ribbon button into an engine command.
import { api, call } from "./api.js";
import { toast, status, ask, basename, dirname, openPath } from "./main.js";
import { office, exportDoc } from "./office.js";
import { registerUndo, refreshUndo } from "./undo.js";
import { Ribbon, loadIcons, autoTabs, iconMatcher, tellBox } from "./ribbon.js";
import { enter, setImage } from "./motion.js";
import { ic } from "./icons.js";

const $ = (s, el = host) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const PX = 96 / 72; // CSS pixels per point
const DPR = () => Math.min(3, window.devicePixelRatio || 1);
const WRITABLE = ["docx", "docm", "dotx", "dotm", "odt", "rtf"];

let host = null;
let W = null; // the shown document: { t, id, state, styles, zoom, pages: [{el, img, rev, scale}] }

const FONTS = ["Calibri", "Cambria", "Arial", "Times New Roman", "Aptos", "Georgia", "Verdana", "Tahoma", "Segoe UI", "Garamond", "Courier New", "Consolas", "Book Antiqua", "Century Gothic", "Trebuchet MS", "Palatino Linotype"];
const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];
const HIGHLIGHTS = [["yellow", "#ffff00"], ["brightGreen", "#00ff00"], ["turquoise", "#00ffff"], ["pink", "#ff00ff"], ["blue", "#0000ff"], ["red", "#ff0000"], ["gray25", "#c0c0c0"], ["none", "transparent"]];

const svg = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
const IC = {
  bullets: svg('<circle cx="5" cy="7" r="1.3" fill="currentColor"/><circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="5" cy="17" r="1.3" fill="currentColor"/><path d="M9 7h11M9 12h11M9 17h11"/>'),
  numbers: svg('<path d="M10 7h10M10 12h10M10 17h10M4 5h1.5v4M4 9h3M4 14.5c.5-1 2.8-1 2.8.4 0 1-2.8 1.6-2.8 2.6h3"/>'),
  outdent: svg('<path d="M21 6H11M21 12H11M21 18H11M7 9l-3 3 3 3"/>'),
  indent: svg('<path d="M21 6H11M21 12H11M21 18H11M4 9l3 3-3 3"/>'),
  left: svg('<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>'),
  center: svg('<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>'),
  right: svg('<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>'),
  justify: svg('<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>'),
  clear: svg('<path d="M6 5h12M12 5l-3 14M15 13l5 5m0-5-5 5"/>'),
  table: svg('<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9h18M3 14h18M9 4v16M15 4v16"/>'),
  picture: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  pageBreak: svg('<path d="M6 3v6h12V3M6 21v-6h12v6M3 12h3m3 0h2m3 0h2m3 0h3"/>'),
  header: svg('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 8h16"/>'),
  footer: svg('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 16h16"/>'),
  pageNum: svg('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M11 17h2"/>'),
  footnote: svg('<path d="M4 6h12M4 10h9M4 18h6"/><path d="M17 4v5M15.5 5 17 4"/>'),
  equation: svg('<path d="M18 5H7l5 7-5 7h11"/>'),
  toc: svg('<path d="M4 6h10M4 10h14M7 14h11M7 18h11"/>'),
  find: svg('<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>'),
  marks: '<span style="font-weight:700">¶</span>',
  palette: svg('<path d="m21 21-4.3-4.3"/><circle cx="11" cy="11" r="7"/><path d="M8 11h6M11 8v6"/>'),
};

export function wordHost() {
  if (host) return host;
  host = document.createElement("div");
  host.id = "word-view";
  host.hidden = true;
  host.innerHTML = `
    <div class="wd-rb"></div>
    <div class="wd-scroll" tabindex="-1"><div class="wd-pages"></div></div>
    <div class="wd-ghost" hidden></div>
    <textarea class="wd-input" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" aria-label="Document text"></textarea>
    <div class="wd-status"><span class="wd-st-page"></span><span class="wd-st-words"></span><span class="tb-spacer"></span><span class="wd-st-msg"></span><button class="icon small wd-zo" title="Zoom out">${ic("minus")}</button><span class="wd-zoom">100%</span><button class="icon small wd-zi" title="Zoom in">${ic("plus")}</button><button class="small wd-fit" title="Page width">⟷</button></div>`;
  wire();
  return host;
}

// ---------------- talking to the engine ----------------
let busy = Promise.resolve();
/** Engine calls one at a time, in order (typing, keys and clicks must not overtake each other). */
function q(cmd, args) {
  const p = busy.then(() => office(cmd, { id: W?.id, ...args }));
  busy = p.catch(() => {});
  return p;
}
async function run(cmd, params = {}) {
  if (!W) return;
  const r = await q("word.run", { cmd, params });
  if (r.error) toast(`${cmd}: ${r.error}`, "err", 5000);
  apply(r.state);
  return r.result;
}

// typing: letters show at once (a "ghost" in the paragraph's font at the caret) while the engine
// lays them out; the page drawing that includes them replaces the ghost
let ghost = null; // { page, x, y, h, text }
function ghostShow() {
  const g = $(".wd-ghost");
  if (!ghost || !ghost.text) { g.hidden = true; host.classList.remove("ghosting"); return; }
  const p = W?.pages[ghost.page];
  if (!p) return;
  const z = W.zoom * PX;
  const f = fmt();
  const pr = p.el.getBoundingClientRect(), hr = host.getBoundingClientRect();
  const size = (f.size || ghost.h / 1.22) * z;
  g.style.left = pr.left - hr.left + ghost.x * z + "px";
  g.style.top = pr.top - hr.top + ghost.y * z + "px";
  g.style.height = ghost.h * z + "px";
  g.style.lineHeight = ghost.h * z + "px";
  g.style.fontSize = size + "px";
  g.style.fontFamily = `"${f.fontShownAs || f.font || "Calibri"}", "${f.font || "Calibri"}", Carlito, Calibri, "Segoe UI", sans-serif`;
  g.style.fontWeight = f.bold ? "700" : "400";
  g.style.fontStyle = f.italic ? "italic" : "normal";
  g.style.textDecoration = f.underline ? "underline" : "none";
  g.style.color = /^[0-9a-f]{6}$/i.test(f.color || "") ? "#" + f.color : "#111";
  g.textContent = ghost.text;
  g.hidden = false;
  host.classList.add("ghosting");
}
function ghostAdd(text) {
  const c = W?.state?.caret;
  if (!c) return;
  if (!ghost) ghost = { page: c.page, x: c.x, y: c.y, h: c.h, text: "" };
  ghost.text += text;
  ghostShow();
}
function ghostClear() { if (!ghost) return; ghost = null; ghostShow(); }

// typing: letters typed while the engine is busy go in one call
let pendingText = "";
let typing = null;
function typeText(text) {
  ghostAdd(text);
  pendingText += text;
  if (typing) return;
  typing = (async () => {
    while (pendingText) {
      const t = pendingText; pendingText = "";
      const r = await q("word.type", { text: t });
      if (r.error) toast(r.error, "err", 4000);
      apply(r.state);
    }
    typing = null;
  })();
}

// ---------------- the ribbon ----------------
let rb = null, tell = null;
const fmt = () => W?.state?.fmt || {};
const W_ICON = { "edit.paste": "paste", "edit.cut": "cut", "edit.copy": "copy", "edit.formatPainter": "painter", "format.growFont": "grow", "format.shrinkFont": "shrink",
  "format.changeCase": "case", "format.clear": "clear", "format.strikethrough": "strike", "format.color": "fontcolor", "view.marks": "pilcrow", "para.outdent": "outdent",
  "para.lineSpacing": "lineSpacing", "edit.findReplace": "replace", "edit.find": "find", "insert.picture": "picture", "insert.shape": "shapes", "insert.chart": "chart",
  "references.toc": "toc", "references.footnote": "footnote", "references.endnote": "endnote", "insert.crossReference": "crossRef", "review.newComment": "newComment",
  "layout.margins": "margins", "layout.orientation": "orientation", "layout.size": "size", "layout.columns": "columns", "layout.break": "breaks", "insert.textBox": "textBox",
  "insert.wordArt": "wordArt", "insert.dropCap": "dropCap", "insert.dateTime": "dateTime", "insert.symbol": "symbol", "insert.equation": "equation", "insert.smartArt": "smartArt",
  "insert.icon": "icons", "insert.link": "link", "insert.bookmark": "bookmark", "insert.header": "header", "insert.footer": "footer", "insert.pageNumber": "pageNumber",
  "insert.coverPage": "coverPage", "insert.blankPage": "blankPage", "insert.pageBreak": "pageBreak", "insert.table": "table", "view.zoomIn": "zoomIn", "view.zoomOut": "zoomOut" };
const ACTION_CMDS = {
  "insert.picture": () => ACTIONS.picture(),
  "insert.link": () => ACTIONS.link(),
  "edit.findReplace": () => findReplace(),
  "edit.paste": () => pasteFromClipboard(),
  "edit.copy": () => clip(false),
  "edit.cut": () => clip(true),
  "view.zoomIn": () => ACTIONS.zoomIn(),
  "view.zoomOut": () => ACTIONS.zoomOut(),
  "view.pageWidth": () => ACTIONS.fitWidth(),
  "view.onePage": () => ACTIONS.onePage(),
};
async function pasteFromClipboard() {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      if (it.types.includes("text/html")) { const html = await (await it.getType("text/html")).text(); const text = it.types.includes("text/plain") ? await (await it.getType("text/plain")).text() : ""; return run("edit.paste", { html, text }); }
      const img = it.types.find((x) => x.startsWith("image/"));
      if (img) { const b = await it.getType(img); const b64 = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(",")[1]); fr.readAsDataURL(b); }); return run("insert.picture", { data: b64 }); }
    }
  } catch {}
  try { const text = await navigator.clipboard.readText(); if (text) return run("edit.paste", { text }); } catch {}
  toast("Use Ctrl+V to paste here.", "", 3000);
}
const STYLE_LOOK = { Normal: "font-size:11px", "No Spacing": "font-size:11px", "Heading 1": "font-size:15px;color:#2f5496", "Heading 2": "font-size:13px;color:#2f5496", "Heading 3": "font-size:12px;color:#1f3763", Title: "font-size:17px", Subtitle: "font-size:11px;color:#5a5a5a;letter-spacing:.5px", Quote: "font-size:11px;font-style:italic;color:#404040", "Intense Quote": "font-size:11px;font-style:italic;color:#2f5496", Emphasis: "font-size:11px;font-style:italic", Strong: "font-size:11px;font-weight:700", "List Paragraph": "font-size:11px" };
function homeTab() {
  const S = (cmd, icon, label, extra = {}) => ({ t: "small", cmd, icon, label, ...extra });
  const I = (cmd, icon, title, extra = {}) => ({ t: "small", cmd, icon, title, iconOnly: true, ...extra });
  return { name: "Home", groups: [
    { name: "Clipboard", items: [
      { t: "big", icon: "paste", label: "Paste", action: pasteFromClipboard, menu: [{ label: "Paste", action: pasteFromClipboard, icon: "paste" }, { label: "Keep Text Only", cmd: "edit.pasteText" }, { label: "Merge Formatting", cmd: "edit.pasteMerge" }] },
      { t: "stack", items: [S("edit.cut", "cut", "Cut", { action: () => clip(true) }), S("edit.copy", "copy", "Copy", { action: () => clip(false) }), S("edit.formatPainter", "painter", "Format Painter")] } ] },
    { name: "Font", items: [{ t: "rows", rows: [
      [{ t: "select", width: 150, title: "Font", options: () => FONTS, value: (f) => f.font, pick: (v) => run("format.font", { name: v }) },
       { t: "select", width: 56, title: "Font size", options: () => SIZES.map(String), value: (f) => f.size, pick: (v) => run("format.size", { size: +v }) },
       I("format.growFont", "grow", "Grow Font (Ctrl+Shift+>)"), I("format.shrinkFont", "shrink", "Shrink Font (Ctrl+Shift+<)"),
       I(null, "case", "Change Case", { menu: ["sentence", "lower", "upper", "title", "toggle"].map((m) => ({ label: { sentence: "Sentence case.", lower: "lowercase", upper: "UPPERCASE", title: "Capitalize Each Word", toggle: "tOGGLE cASE" }[m], cmd: "format.changeCase", params: { mode: m } })) }),
       I("format.clear", "clear", "Clear All Formatting")],
      [I("format.bold", "bold", "Bold (Ctrl+B)", { on: (f) => f.bold }), I("format.italic", "italic", "Italic (Ctrl+I)", { on: (f) => f.italic }),
       I("format.underline", "underline", "Underline (Ctrl+U)", { on: (f) => f.underline, menu: [{ label: "Underline", cmd: "format.underline" }, { label: "Double Underline", cmd: "format.doubleUnderline" }, { label: "Words Only", cmd: "format.wordUnderline" }, { label: "Dotted", cmd: "format.underline", params: { style: "dotted" } }, { label: "Thick", cmd: "format.underline", params: { style: "thick" } }] }),
       I("format.strikethrough", "strike", "Strikethrough", { on: (f) => f.strike }), I("format.subscript", "subscript", "Subscript (Ctrl+=)", { on: (f) => f.subscript }), I("format.superscript", "superscript", "Superscript (Ctrl+Shift++)", { on: (f) => f.superscript }),
       I(null, "effects", "Text Effects", { menu: ["solid", "outlined", "hollow", "gradient", "shadowed", "glowing"].map((v) => ({ label: v[0].toUpperCase() + v.slice(1), cmd: "format.textEffects", params: { style: v } })) }),
       I(null, "highlight", "Text Highlight Color", { menu: HIGHLIGHTS.map(([n]) => ({ label: n === "none" ? "No Color" : n.replace(/([A-Z])/g, " $1").replace(/^./, (x) => x.toUpperCase()), cmd: "format.highlight", params: { color: n } })) }),
       { t: "color", icon: "fontcolor", title: "Font Color", value: "#c00000", pick: (v) => run("format.color", { color: v.slice(1).toUpperCase() }) }] ] }] },
    { name: "Paragraph", items: [{ t: "rows", rows: [
      [I("para.bullets", "bullets", "Bullets", { menu: [{ label: "Bullets •", cmd: "para.bullets" }, { label: "Bullets ○", cmd: "para.bullets", params: { kind: "○" } }, { label: "Bullets ■", cmd: "para.bullets", params: { kind: "■" } }, { label: "Bullets ✓", cmd: "para.bullets", params: { kind: "✓" } }, { label: "None", cmd: "para.bullets", params: { off: true } }] }),
       I("para.numbering", "numbering", "Numbering", { menu: ["numbered", "numberedParen", "upperLetter", "lowerLetter", "lowerRoman", "upperRoman"].map((k) => ({ label: { numbered: "1. 2. 3.", numberedParen: "1) 2) 3)", upperLetter: "A. B. C.", lowerLetter: "a. b. c.", lowerRoman: "i. ii. iii.", upperRoman: "I. II. III." }[k], cmd: "para.numbering", params: { kind: k } })) }),
       I("para.multilevel", "multilevel", "Multilevel List", { menu: [{ label: "1 / 1.1 / 1.1.1", cmd: "para.multilevel", params: { kind: "legal" } }, { label: "Outline", cmd: "para.multilevel", params: { kind: "outline" } }, { label: "Headings", cmd: "list.multilevelPreset", params: { preset: "headings" } }] }),
       I("para.outdent", "outdent", "Decrease Indent"), I("para.indent", "indent", "Increase Indent"), I("para.sort", "sort", "Sort"), I("view.marks", "pilcrow", "Show/Hide ¶ (Ctrl+*)")],
      [I("para.alignLeft", "alignLeft", "Align Left (Ctrl+L)", { on: () => W?.state?.align === "left" }), I("para.alignCenter", "alignCenter", "Center (Ctrl+E)", { on: () => W?.state?.align === "center" }),
       I("para.alignRight", "alignRight", "Align Right (Ctrl+R)", { on: () => W?.state?.align === "right" }), I("para.justify", "justify", "Justify (Ctrl+J)", { on: () => W?.state?.align === "justify" }),
       I(null, "lineSpacing", "Line and Paragraph Spacing", { menu: [...[1, 1.15, 1.5, 2, 2.5, 3].map((v) => ({ label: v.toFixed(v % 1 ? 2 : 1), cmd: "para.lineSpacing", params: { value: v } })), { sep: true }, { label: "Add Space Before Paragraph", cmd: "para.addSpaceBefore" }, { label: "Remove Space After Paragraph", cmd: "para.removeSpaceAfter" }] }),
       I(null, "shading", "Shading", { menu: [["FFF2CC", "Gold"], ["E2EFDA", "Green"], ["DDEBF7", "Blue"], ["FCE4D6", "Orange"], ["EDEDED", "Gray"]].map(([c, n]) => ({ label: n, cmd: "para.shading", params: { color: c } })).concat([{ label: "No Color", cmd: "para.shading", params: { color: null } }]) }),
       I(null, "borders", "Borders", { menu: ["bottom", "top", "left", "right", "none", "all", "outside", "inside"].map((k) => ({ label: k[0].toUpperCase() + k.slice(1) + " Border", cmd: "para.borders", params: { kind: k } })).concat([{ label: "Horizontal Line", cmd: "insert.horizontalLine" }]) })] ] }] },
    { name: "Styles", items: [{ t: "gallery", items: () => orderedStyles().slice(0, 16).map((s) => ({ label: s.name, cmd: "para.style", params: { style: s.id }, style: STYLE_LOOK[s.name] || "font-size:11px", preview: s.name === "Title" ? "AaBb" : s.name.startsWith("Heading") ? "AaBbCc" : "AaBbCcDd" })), current: (f) => f.styleName }] },
    { name: "Editing", items: [{ t: "stack", items: [S("edit.find", "find", "Find", { action: async () => { const t = await ask({ title: "Find", text: "Find:", input: W?.lastFind || "" }); if (t) { W.lastFind = t; run("edit.find", { text: t }); } } }), S("edit.findReplace", "replace", "Replace", { action: findReplace }),
      S(null, "select", "Select", { menu: [{ label: "Select All", cmd: "select.all", key: "Ctrl+A" }, { label: "Select Objects", cmd: "select.objects" }, { label: "Select Text with Similar Formatting", cmd: "select.similar" }] })] }] },
    { name: "Editor", items: [{ t: "big", icon: "editor", label: "Editor", cmd: "review.editor" }] },
  ] };
}
const STYLE_ORDER = ["Normal", "No Spacing", "Heading 1", "Heading 2", "Heading 3", "Title", "Subtitle", "Subtle Emphasis", "Emphasis", "Intense Emphasis", "Strong", "Quote", "Intense Quote", "List Paragraph"];
function orderedStyles() {
  const list = W?.styles || [];
  const rank = (n) => { const i = STYLE_ORDER.indexOf(n); return i < 0 ? 100 : i; };
  return [...list].sort((a, b) => rank(a.name) - rank(b.name));
}
async function buildRibbon() {
  if (rb) return;
  await loadIcons();
  const list = await office("word.commands", {}).catch(() => []);
  const cmds = list.map((c) => ({ ...c, path: c.where.split("›").map((x) => x.trim()) }));
  const map = new Map(cmds.map((c) => [c.id, c]));
  const match = iconMatcher("word", W_ICON);
  const auto = autoTabs(cmds, { order: ["Insert", "Draw", "Design", "Layout", "References", "Mailings", "Review", "View", "Table Design", "Table Layout", "Developer"], skip: ["Home", "File", "Navigation", "Editing", "Quick Access Toolbar", "Status Bar", "Title Bar", "Agents", "Zotero", "Reading", "Outlining", "Equation", "Header & Footer", "Shape Format", "Picture Format", "SmartArt Design", "Chart Design"], iconFor: match });
  rb = new Ribbon({
    el: $(".wd-rb"), set: "word", tabs: [homeTab(), ...auto], commands: map,
    run: async (id, p) => (ACTION_CMDS[id] ? ACTION_CMDS[id]() : run(id, p)),
    state: fmt, focus: focusInput,
    extra: (row) => {
      tell = tellBox(rb || { commands: map, exec: (id) => rb.exec(id) });
      row.appendChild(tell);
      const ex = document.createElement("button");
      ex.className = "small rb-export"; ex.textContent = "Export ▾"; ex.title = "Save a copy as PDF, Word, OpenDocument, RTF, HTML, Markdown or LaTeX";
      ex.onclick = () => W && exportDoc(W.t);
      row.appendChild(ex);
    },
  });
  rb.exec = ((orig) => async function (id, params) { if (ACTION_CMDS[id] && !Object.keys(params || {}).length) return ACTION_CMDS[id](); return orig.call(this, id, params); })(rb.exec);
}

// ---------------- open / show ----------------
export async function openWord(t) {
  wordHost();
  host.hidden = false;
  if (W && W.t === t) { layoutPages(); return; }
  W = { t, id: t.wordId, state: t.wordState, styles: t.wordStyles || [], zoom: t.wordZoom || 1, pages: [] };
  if (!t.wordId) {
    status(`Opening ${t.name}…`);
    const r = await office("word.open", { path: t.path });
    t.wordId = W.id = r.id; t.wordStyles = W.styles = r.styles; t.wordState = W.state = r.state;
    status(`${t.name}: ${r.state.words} words`, "ok");
  } else {
    W.state = (await office("word.state", { id: W.id }));
  }
  await buildRibbon();
  fillStyles();
  buildPages();
  apply(W.state, true);
  requestAnimationFrame(() => {
    if (t.wordScroll) $(".wd-scroll").scrollTop = t.wordScroll;
    focusInput();
  });
}

export function hideWord() {
  if (!host) return;
  if (W) { W.t.wordScroll = $(".wd-scroll").scrollTop; W.t.wordZoom = W.zoom; }
  host.hidden = true;
  W = null;
}

export async function closeWord(t) {
  if (t.wordId) office("word.close", { id: t.wordId }).catch(() => {});
  if (W?.t === t) hideWord();
}

function fillStyles() { rb?.refreshLists(); }

function buildPages() {
  const box = $(".wd-pages");
  box.innerHTML = "";
  W.pages = [];
  ensurePages(W.state.pages.length);
  layoutPages();
}
function ensurePages(n) {
  const box = $(".wd-pages");
  while (W.pages.length < n) {
    const i = W.pages.length;
    const el = document.createElement("div");
    el.className = "wd-page";
    el.dataset.p = i;
    el.innerHTML = `<img alt="" draggable="false"><div class="wd-sel"></div>`;
    box.appendChild(el);
    W.pages.push({ el, img: el.firstChild, rev: -1, scale: 0 });
    observer().observe(el);
  }
  while (W.pages.length > n) { const p = W.pages.pop(); observer().unobserve(p.el); p.el.remove(); }
}
function layoutPages() {
  if (!W?.state) return;
  W.state.pages.forEach(([w, h], i) => {
    const p = W.pages[i]; if (!p) return;
    p.el.style.width = w * PX * W.zoom + "px";
    p.el.style.height = h * PX * W.zoom + "px";
  });
  $(".wd-zoom").textContent = Math.round(W.zoom * 100) + "%";
  drawOverlay();
  renderVisible();
}

let io = null;
const visible = new Set();
function observer() {
  io ||= new IntersectionObserver((entries) => {
    for (const e of entries) { const i = +e.target.dataset.p; if (e.isIntersecting) visible.add(i); else visible.delete(i); }
    renderVisible();
  }, { root: host.querySelector(".wd-scroll"), rootMargin: "600px 0px" });
  return io;
}

let rendering = false;
/** Draw the pages on screen that are out of date (the caret's page first). */
async function renderVisible() {
  if (rendering || !W) return;
  rendering = true;
  try {
    for (;;) {
      if (!W) break;
      const scale = W.zoom * PX * DPR();
      const caretPage = W.state.caret?.page ?? -1;
      const want = [...visible].filter((i) => W.pages[i] && (W.pages[i].rev !== W.state.rev || Math.abs(W.pages[i].scale - scale) > 0.01));
      if (!want.length) break;
      want.sort((a, b) => (a === caretPage ? -1 : b === caretPage ? 1 : Math.abs(a - caretPage) - Math.abs(b - caretPage)));
      const i = want[0];
      const rev = W.state.rev;
      const r = await q("word.render", { page: i, scale });
      if (!W || !W.pages[i]) break;
      const p = W.pages[i];
      const first = !p.img.getAttribute("src");
      await setImage(p.img, `data:image/png;base64,${r.png}`);
      if (first) enter(p.img, "fade", { duration: 200 });
      p.rev = r.rev === rev ? rev : r.rev;
      p.scale = scale;
      if (r.rev !== W.state.rev) p.rev = -1; // edited while drawing: draw again
      else if (ghost && i === ghost.page && !pendingText && !typing) ghostClear();
    }
  } catch (e) { console.warn("word render", e); }
  finally { rendering = false; }
}

// ---------------- state → screen ----------------
function apply(st, first = false) {
  if (!W || !st) return;
  const old = W.state;
  W.state = st;
  W.t.wordState = st;
  if (!first && old && old.pages.length !== st.pages.length) ensurePages(st.pages.length);
  if (first || !old || old.pages.length !== st.pages.length || old.pages.some((p, i) => p[0] !== st.pages[i]?.[0] || p[1] !== st.pages[i]?.[1])) layoutPages();
  else { drawOverlay(); renderVisible(); }
  rb?.update();
  $(".wd-st-page").textContent = st.caret ? `Page ${st.caret.page + 1} of ${st.pages.length}` : `${st.pages.length} pages`;
  $(".wd-st-words").textContent = `${st.words} words`;
  if (W.t.dirty !== st.dirty) { W.t.dirty = st.dirty; window.dispatchEvent(new Event("callio-tab-dirty")); }
  window.dispatchEvent(new Event("callio-undo"));
  if (!first) keepCaretInView();
  window.dispatchEvent(new CustomEvent("callio-doc-changed", { detail: { kind: "word" } }));
}

function drawOverlay() {
  if (!W?.state) return;
  const z = W.zoom * PX;
  for (const p of W.pages) p.el.querySelector(".wd-sel").innerHTML = "";
  const by = new Map();
  for (const [pg, x, y, w, h] of W.state.sel || []) {
    const html = `<div class="wd-hl-r" style="left:${x * z}px;top:${y * z}px;width:${Math.max(2, w * z)}px;height:${h * z}px"></div>`;
    by.set(pg, (by.get(pg) || "") + html);
  }
  for (const [pg, html] of by) { const p = W.pages[pg]; if (p) p.el.querySelector(".wd-sel").innerHTML = html; }
  const c = W.state.caret;
  if (c && !(W.state.sel || []).length) {
    const p = W.pages[c.page];
    if (p) p.el.querySelector(".wd-sel").insertAdjacentHTML("beforeend", `<div class="wd-caret" style="left:${c.x * z}px;top:${c.y * z}px;height:${c.h * z}px"></div>`);
  }
  placeInput();
}
/** The hidden input sits at the caret, so the IME's window opens there. */
function placeInput() {
  if (!W?.state) return;
  const z = W.zoom * PX, c = W.state.caret;
  const inp = $(".wd-input");
  if (c && W.pages[c.page]) {
    const pr = W.pages[c.page].el.getBoundingClientRect(), hr = host.getBoundingClientRect();
    inp.style.left = pr.left - hr.left + c.x * z + "px";
    inp.style.top = pr.top - hr.top + c.y * z + "px";
    inp.style.height = c.h * z + "px";
  }
}

function keepCaretInView() {
  const c = W?.state.caret;
  if (!c || !W.pages[c.page]) return;
  const sc = $(".wd-scroll");
  const el = W.pages[c.page].el;
  const z = W.zoom * PX;
  const top = el.offsetTop + c.y * z, bot = top + c.h * z;
  if (top < sc.scrollTop + 20) sc.scrollTop = top - 60;
  else if (bot > sc.scrollTop + sc.clientHeight - 20) sc.scrollTop = bot - sc.clientHeight + 60;
}

function focusInput() { $(".wd-input").focus({ preventScroll: true }); }

// ---------------- input ----------------
const NAMED = { ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", " ": "Space", Esc: "Escape" };
const RESERVED = new Set(["Mod+S", "Mod+Shift+S", "Mod+O", "Mod+N", "Mod+W", "Mod+Tab", "Mod+Shift+Tab", "Mod+,", "Mod+Shift+E", "Mod+Shift+M", "Mod+Shift+O", "Mod+P", "F11", "F12"]);
function keyName(e) {
  let k = NAMED[e.key] || e.key;
  if (e.ctrlKey || e.metaKey || e.altKey) {
    if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
    else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  }
  if (k.length === 1) k = k.toUpperCase();
  return `${e.ctrlKey || e.metaKey ? "Mod+" : ""}${e.altKey ? "Alt+" : ""}${e.shiftKey && (k.length > 1 || e.ctrlKey || e.metaKey || e.altKey) ? "Shift+" : ""}${k}`;
}

async function onKey(e) {
  if (!W || e.isComposing || e.key === "Process") return;
  if (["Control", "Shift", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
  const name = keyName(e);
  if (RESERVED.has(name)) return; // Callio's own (save, open, tabs…)
  const plainChar = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
  if (plainChar) return; // typed text arrives through `input`
  if (name === "Mod+C" || name === "Mod+X") { e.preventDefault(); return clip(name === "Mod+X"); }
  if (name === "Mod+V" || name === "Shift+Insert") return; // the paste event brings the clipboard
  if (name === "Mod+H" || name === "Mod+F") { e.preventDefault(); return findReplace(); }
  if (name === "Alt+Q") { e.preventDefault(); tell?.focusSearch(); return; }
  e.preventDefault();
  if (ghost && name === "Backspace" && ghost.text) { ghost.text = ghost.text.slice(0, -1); ghostShow(); }
  else if (ghost) ghostClear();
  await typing;
  const r = await q("word.key", { key: name });
  if (r.error) status(r.error, "err");
  apply(r.state);
}

async function clip(cut) {
  const r = await run(cut ? "edit.cut" : "edit.copy");
  if (!r) return;
  try {
    if (r.html && window.ClipboardItem) await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([r.text || ""], { type: "text/plain" }), "text/html": new Blob([r.html], { type: "text/html" }) })]);
    else await navigator.clipboard.writeText(r.text || "");
  } catch { try { await navigator.clipboard.writeText(r.text || ""); } catch {} }
}

async function onPaste(e) {
  if (!W) return;
  e.preventDefault();
  const cd = e.clipboardData;
  const file = [...(cd?.files || [])].find((f) => f.type.startsWith("image/"));
  if (file) {
    const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.readAsDataURL(file); });
    return run("insert.picture", { data: b64 });
  }
  const html = cd?.getData("text/html"), text = cd?.getData("text/plain");
  if (!html && !text) return;
  await run("edit.paste", html ? { html, text } : { text });
}

// ---------------- mouse ----------------
function pagePoint(e) {
  const el = e.target.closest?.(".wd-page");
  const pages = W.pages.map((p) => p.el);
  let page = el ? +el.dataset.p : -1;
  if (page < 0) {
    // between pages: the nearest one
    let best = Infinity;
    pages.forEach((p, i) => { const r = p.getBoundingClientRect(); const d = e.clientY < r.top ? r.top - e.clientY : e.clientY > r.bottom ? e.clientY - r.bottom : 0; if (d < best) { best = d; page = i; } });
  }
  if (page < 0) return null;
  const r = pages[page].getBoundingClientRect();
  const z = W.zoom * PX;
  return { page, x: Math.max(0, (e.clientX - r.left) / z), y: Math.max(0, (e.clientY - r.top) / z) };
}

let dragging = false;
let moving = null;
async function onDown(e) {
  if (!W || e.button !== 0) return;
  const p = pagePoint(e); if (!p) return;
  e.preventDefault();
  focusInput();
  dragging = true;
  await typing;
  const r = await q("word.click", { ...p, extend: e.shiftKey, count: Math.min(3, e.detail || 1) });
  apply(r.state);
}
function onMove(e) {
  if (!dragging || !W || moving) return;
  const p = pagePoint(e); if (!p) return;
  moving = q("word.click", { ...p, extend: true, count: 1 }).then((r) => apply(r.state)).finally(() => { moving = null; });
}

// ---------------- ribbon ----------------
async function findReplace() {
  const what = await ask({ title: "Replace", text: "Find:", input: W?.lastFind || "" });
  if (what == null || !what) return;
  W.lastFind = what;
  const by = await ask({ title: "Replace", text: `Replace every “${what}” with:`, input: "" });
  if (by == null) { await run("edit.find", { text: what }); return; }
  const r = await run("edit.replaceAll", { text: what, with: by });
  toast(`Replaced ${r?.count ?? r?.replaced ?? "all"} occurrence(s)`, "ok", 3000);
}

const ACTIONS = {
  find: findReplace,
  async table() {
    const v = await ask({ title: "Insert table", text: "Rows × columns:", input: "3 x 3" });
    const m = /(\d+)\s*[x×*,]\s*(\d+)/i.exec(v || ""); if (!m) return;
    await run("insert.table", { rows: +m[1], cols: +m[2] });
  },
  async picture() {
    const f = await call("pick_files", { name: "Pictures", exts: ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "emf", "wmf"] });
    if (f?.[0]) await run("insert.picture", { path: f[0] });
  },
  async link() {
    const url = await ask({ title: "Link", text: "Web address:", input: "https://" });
    if (url && url !== "https://") await run("insert.link", { url });
  },
  async pagenum() {
    const v = await ask({ title: "Page number", text: "Where?", buttons: [{ label: "Cancel", value: null }, { label: "Top", value: "top" }, { label: "Bottom", value: "bottom", primary: true }] });
    if (v) await run("insert.pageNumber", { position: v, align: "center" });
  },
  async symbol() {
    const v = await ask({ title: "Symbol", text: "Type or paste the symbol (or a code like U+03A9):", input: "" });
    if (!v) return;
    const m = /^U\+([0-9a-f]{2,6})$/i.exec(v.trim());
    typeText(m ? String.fromCodePoint(parseInt(m[1], 16)) : v);
  },
  zoomIn: () => setZoom(W.zoom * 1.1),
  zoomOut: () => setZoom(W.zoom / 1.1),
  fitWidth: () => { const w = Math.max(...W.state.pages.map((p) => p[0])); setZoom(($(".wd-scroll").clientWidth - 48) / (w * PX)); },
  onePage: () => { const h = Math.max(...W.state.pages.map((p) => p[1])); setZoom(($(".wd-scroll").clientHeight - 32) / (h * PX)); },
  editMd: () => import("./office.js").then((m) => m.editAsMarkdown(W.t)),
};

function setZoom(z) {
  if (!W) return;
  const sc = $(".wd-scroll");
  const ratio = sc.scrollTop / Math.max(1, sc.scrollHeight);
  W.zoom = Math.max(0.3, Math.min(4, z));
  layoutPages();
  sc.scrollTop = ratio * sc.scrollHeight;
}

function wire() {
  $(".wd-zo").onclick = () => ACTIONS.zoomOut();
  $(".wd-zi").onclick = () => ACTIONS.zoomIn();
  $(".wd-fit").onclick = () => ACTIONS.fitWidth();
  // the document
  const sc = $(".wd-scroll");
  sc.addEventListener("mousedown", onDown);
  sc.addEventListener("contextmenu", (e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent("callio-ai-menu", { detail: { event: e, kind: "word" } })); });
  sc.addEventListener("dblclick", (e) => window.dispatchEvent(new CustomEvent("callio-ai-dblclick", { detail: { event: e, kind: "word" } })));
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", () => { dragging = false; });
  // the selection is drawn inside the pages, so it scrolls with them; only the input follows
  let scRaf = 0;
  sc.addEventListener("scroll", () => { if (!scRaf) scRaf = requestAnimationFrame(() => { scRaf = 0; placeInput(); if (ghost) ghostShow(); }); }, { passive: true });
  sc.addEventListener("mousedown", () => ghostClear(), true);
  sc.addEventListener("wheel", (e) => { if (e.ctrlKey && W) { e.preventDefault(); setZoom(W.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); } }, { passive: false });
  const inp = $(".wd-input");
  inp.addEventListener("keydown", onKey);
  inp.addEventListener("input", (e) => {
    if (e.isComposing) return;
    const v = inp.value; inp.value = "";
    if (v) typeText(v.replace(/\r?\n/g, ""));
  });
  inp.addEventListener("compositionend", () => { const v = inp.value; inp.value = ""; if (v) typeText(v); });
  inp.addEventListener("paste", onPaste);
  inp.addEventListener("focus", () => host.classList.add("focused"));
  inp.addEventListener("blur", () => host.classList.remove("focused"));
  new ResizeObserver(() => drawOverlay()).observe(sc);
}

// ---------------- saving ----------------
/** Save the document over its file (a backup of the previous one is kept), or as a new file. */
export async function saveWord(t, saveAs = false) {
  if (!t.wordId) return true;
  const ext = (t.path.split(".").pop() || "").toLowerCase();
  let out = t.path;
  if (saveAs || !WRITABLE.includes(ext)) {
    if (!saveAs) {
      const r = await ask({ title: `Save ${t.name}`, text: `Callio can't write .${ext} files. Save the document as a Word document (.docx) next to it? The original stays as it is.`, buttons: [{ label: "Cancel", value: null }, { label: "Save as .docx", value: "y", primary: true }] });
      if (!r) return false;
    }
    out = await api.pickSaveFile(basename(t.path).replace(/\.[^.]+$/, "") + ".docx", dirname(t.path));
    if (!out) return false;
  }
  try {
    status(`Saving ${basename(out)}…`);
    // written next to Callio first, then put in place with a backup of the old file
    const tmp = await call("office_temp", { name: basename(out) });
    const r = await office("word.save", { id: t.wordId, out: tmp, markSaved: true });
    const bytes = new Uint8Array(await api.readBinary(tmp));
    try { t.mtime = await api.writeBinary(out, bytes, out === t.path ? t.mtime || 0 : 0, true); }
    catch (e) {
      if (e.message !== "CHANGED_ON_DISK") throw e;
      const ok = await ask({ title: "Changed on disk", text: `${t.name} was changed by another program since you opened it. Overwrite it? (The current file is backed up first.)`, buttons: [{ label: "Cancel", value: null }, { label: "Overwrite", value: "y", primary: true }] });
      if (!ok) return false;
      t.mtime = await api.writeBinary(out, bytes, 0, true);
    }
    // mark it saved (word.save to the temp copy did; the real file is now that copy)
    if (out !== t.path) { t.path = out; t.name = basename(out); }
    t.dirty = false;
    if (W?.t === t) { W.state = r.state; W.state.dirty = false; }
    window.dispatchEvent(new Event("callio-tab-dirty"));
    status(`Saved ${basename(out)} (the previous version is kept in Callio's backups)`, "ok");
    return true;
  } catch (e) { status("Save failed", "err"); toast(`Couldn't save ${basename(out)}: ${e.message}`, "err", 8000); return false; }
}

// ---------------- undo ----------------
registerUndo("doc", {
  list: (t) => {
    const st = W?.t === t ? W.state : t.wordState;
    return { undo: st?.undo || [], redo: st?.canRedo ? [st.redo || "Redo"] : [] };
  },
  step: async (t, n, redo) => { if (W?.t === t) { await run(redo ? "edit.redoTo" : "edit.undoTo", { count: n }); focusInput(); } },
});

/** For the AI: run several commands on an open document as one undo step. */
export async function aiBatch(t, commands, label) {
  const r = await office("word.batch", { id: t.wordId, commands, label });
  if (W?.t === t) apply(r.state);
  else t.wordState = r.state;
  t.dirty = r.state.dirty;
  window.dispatchEvent(new Event("callio-tab-dirty"));
  return r.results;
}
export const shownWord = () => W?.t || null;
/** The writing assistant's access to the document (paragraphs, places on the pages, edits). */
export async function wordAI(op, args = {}) {
  if (!W) return null;
  await typing;
  const r = await q("word.ai", { op, ...args });
  if (r && r.state) { apply(r.state); if (r.error) throw new Error(r.error); }
  return r;
}
/** The pages on screen and the points → pixels factor. */
export function wordView() {
  return W ? { pages: W.pages.map((p) => p.el), z: W.zoom * PX, rev: W.state?.rev, scroller: $(".wd-scroll") } : null;
}
export function refreshShown() { if (W) office("word.state", { id: W.id }).then((s) => apply(s)); }
