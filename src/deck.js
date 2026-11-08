// PowerPoint presentations (.pptx, .ppsx, .potx, .odp) edited like PowerPoint: slide thumbnails on
// the left, the slide in the middle, notes below. DeckCraft (in the office engine) draws the
// slides and does the editing: clicks and drags are its pointer events, keys and typing go to its
// key handling, ribbon buttons are its commands. Selection handles and the text caret are drawn here.
import { api, call } from "./api.js";
import { toast, status, ask, basename, dirname, openPath } from "./main.js";
import { office } from "./office.js";
import { registerUndo } from "./undo.js";
import { sortable } from "./sortable.js";
import { flip, enter, setImage } from "./motion.js";
import { Ribbon, loadIcons, autoTabs, iconMatcher, tellBox } from "./ribbon.js";
import { ic } from "./icons.js";

const $ = (s, el = host) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const DPR = () => Math.min(3, window.devicePixelRatio || 1);
const THUMB_W = 176;
const WRITABLE = ["pptx", "pptm", "potx", "ppsx"];
let host = null;
let D = null; // { t, id, state, scale, thumbs: Map(slideId → {rev, src}) , img }

export function deckHost() {
  if (host) return host;
  host = document.createElement("div");
  host.id = "deck-view";
  host.hidden = true;
  host.innerHTML = `
    <div class="dk-rb"></div>
    <div class="dk-main">
      <div class="dk-slides" tabindex="0"></div>
      <div class="dk-center">
        <div class="dk-stage"><div class="dk-slide"><img class="dk-img" alt="" draggable="false"><div class="dk-ov"></div></div></div>
        <textarea class="dk-notes" placeholder="Click to add notes" spellcheck="true"></textarea>
      </div>
    </div>
    <textarea class="dk-input" spellcheck="false" autocomplete="off" aria-label="Slide text"></textarea>
    <div class="dk-status"><span class="dk-st-slide"></span><span class="tb-spacer"></span><button class="small dk-notes-btn" title="Show or hide the notes">${ic("file-text")}<span>Notes</span></button><button class="icon small dk-zo">${ic("minus")}</button><span class="dk-zoom">Fit</span><button class="icon small dk-zi">${ic("plus")}</button><button class="small dk-fit" title="Fit the slide to the window">⤢</button></div>`;
  wire();
  return host;
}

// ---------------- engine calls, in order ----------------
let busy = Promise.resolve();
function q(cmd, args) {
  const p = busy.then(() => office(cmd, { id: D?.id, ...args }));
  busy = p.catch(() => {});
  return p;
}
async function run(cmd, params = {}) {
  if (!D) return;
  const r = await q("deck.run", { cmd, params });
  if (r.error) toast(`${cmd}: ${r.error}`, "err", 5000);
  apply(r.state);
  return r.result;
}
let pendingText = "", typing = null;
function typeText(text) {
  pendingText += text;
  if (typing) return;
  typing = (async () => {
    while (pendingText) { const t = pendingText; pendingText = ""; const r = await q("deck.type", { text: t }); if (r.error) status(r.error, "err"); apply(r.state); }
    typing = null;
  })();
}

// ---------------- open / show ----------------
export async function openDeck(t) {
  deckHost();
  host.hidden = false;
  if (D && D.t === t) { layout(); return; }
  D = { t, id: t.deckId, state: t.deckState, zoom: t.deckZoom || 0, thumbs: t.deckThumbs || new Map(), rev: -1 };
  if (!t.deckId) {
    status(`Opening ${t.name}…`);
    const r = await office("deck.open", { path: t.path });
    t.deckId = D.id = r.id;
    D.state = r.state;
    status(`${t.name}: ${r.state.slides.length} slides`, "ok");
  } else {
    D.state = await office("deck.state", { id: D.id, format: true });
  }
  t.deckThumbs = D.thumbs;
  await buildRibbon();
  apply(D.state, true);
  requestAnimationFrame(() => { layout(); focusInput(); });
}
export function hideDeck() {
  if (!host) return;
  if (D) { D.t.deckZoom = D.zoom; D.t.deckState = D.state; }
  host.hidden = true;
  D = null;
}
export async function closeDeck(t) {
  if (t.deckId) office("deck.close", { id: t.deckId }).catch(() => {});
  if (D?.t === t) hideDeck();
}

// ---------------- state → screen ----------------
function apply(st, first = false) {
  if (!D || !st) return;
  const old = D.state;
  D.state = st;
  D.t.deckState = st;
  if (first || !old || old.slides.length !== st.slides.length || old.slides.some((s, i) => s.id !== st.slides[i]?.id || s.hidden !== st.slides[i]?.hidden) || old.sections?.length !== st.sections?.length) renderSlideList();
  else markCurrent();
  if (first || st.rev !== D.rev || old?.slide !== st.slide) renderSlide();
  drawOverlay();
  const notes = $(".dk-notes");
  if (document.activeElement !== notes) notes.value = st.notes || "";
  $(".dk-st-slide").textContent = `Slide ${st.slide + 1} of ${st.slides.length}`;
  if (D.t.dirty !== st.dirty) { D.t.dirty = st.dirty; window.dispatchEvent(new Event("callio-tab-dirty")); }
  window.dispatchEvent(new Event("callio-undo"));
  rb?.update();
}

/** Pixels per point of the slide on screen. */
function slideScale() {
  if (!D?.state) return 1;
  const stage = $(".dk-stage");
  const fit = Math.min((stage.clientWidth - 48) / D.state.w, (stage.clientHeight - 32) / D.state.h);
  return Math.max(0.1, D.zoom || fit);
}
function layout() {
  if (!D?.state) return;
  const s = slideScale();
  const el = $(".dk-slide");
  el.style.width = D.state.w * s + "px";
  el.style.height = D.state.h * s + "px";
  $(".dk-zoom").textContent = D.zoom ? Math.round(D.zoom * 100 / (96 / 72)) + "%" : "Fit";
  renderSlide();
  drawOverlay();
}

let drawing = null, again = false;
async function renderSlide() {
  if (!D?.state) return;
  if (drawing) { again = true; return; }
  const want = { slide: D.state.slide, rev: D.state.rev, scale: slideScale() * DPR() };
  drawing = (async () => {
    try {
      const r = await q("deck.render", { slide: want.slide, scale: want.scale, edit: true });
      if (!D) return;
      const img = $(".dk-img");
      const changed = img.dataset.slide !== String(want.slide);
      await setImage(img, `data:image/png;base64,${r.png}`);
      img.dataset.slide = want.slide;
      if (changed) enter(img, "fade", { duration: 160 });
      D.rev = r.rev;
      // the thumbnail of this slide follows
      const id = D.state.slides[want.slide]?.id;
      if (id != null) updateThumb(want.slide, id, r.rev);
    } catch (e) { console.warn("deck render", e); }
  })();
  await drawing;
  drawing = null;
  if (again) { again = false; renderSlide(); }
}

let thumbQueue = [], thumbBusy = false;
function updateThumb(i, id, rev) {
  const th = D.thumbs.get(id);
  if (th && th.rev === rev) return;
  thumbQueue = thumbQueue.filter((x) => x.id !== id);
  thumbQueue.unshift({ i, id, rev });
  pumpThumbs();
}
async function pumpThumbs() {
  if (thumbBusy || !D) return;
  thumbBusy = true;
  while (thumbQueue.length && D) {
    const { i, id, rev } = thumbQueue.shift();
    try {
      const r = await q("deck.render", { slide: i, scale: (THUMB_W * DPR()) / D.state.w, edit: false });
      if (!D) break;
      D.thumbs.set(id, { rev, src: `data:image/png;base64,${r.png}` });
      const img = host.querySelector(`.dk-th[data-id="${id}"] img`);
      if (img) { const first = !img.getAttribute("src"); await setImage(img, D.thumbs.get(id).src); if (first) enter(img, "fade", { duration: 180 }); }
    } catch {}
  }
  thumbBusy = false;
}

function renderSlideList() {
  const box = $(".dk-slides");
  const st = D.state;
  const sectionAt = new Map();
  (st.sections || []).forEach((sc, k) => { const first = sc.slides?.[0]; if (first != null) sectionAt.set(first, { ...sc, k }); });
  box.innerHTML = st.slides.map((s, i) => {
    const sec = sectionAt.get(s.id);
    const th = D.thumbs.get(s.id);
    return `${sec ? `<div class="dk-sec">▾ ${esc(sec.name)} <small>(${sec.slides.length})</small></div>` : ""}<div class="dk-th${i === st.slide ? " on" : ""}${s.hidden ? " hid" : ""}" data-i="${i}" data-id="${s.id}"><span class="dk-num">${i + 1}</span><div class="dk-th-img" style="aspect-ratio:${st.w}/${st.h}"><img alt="" src="${th?.src || ""}"></div></div>`;
  }).join("");
  // thumbnails not drawn yet (or out of date) — in order
  st.slides.forEach((s, i) => { const th = D.thumbs.get(s.id); if (!th) thumbQueue.push({ i, id: s.id, rev: -1 }); });
  pumpThumbs();
}
function markCurrent() {
  host.querySelectorAll(".dk-th").forEach((el) => el.classList.toggle("on", +el.dataset.i === D.state.slide));
  host.querySelector(".dk-th.on")?.scrollIntoView({ block: "nearest" });
}

function drawOverlay() {
  if (!D?.state) return;
  const s = slideScale();
  const st = D.state;
  let html = "";
  for (const b of st.shapes || []) {
    html += `<div class="dk-box${st.editing ? " editing" : ""}" style="left:${b.x * s}px;top:${b.y * s}px;width:${b.w * s}px;height:${b.h * s}px;transform:rotate(${b.rot || 0}deg)">${st.editing ? "" : `<i class="h nw"></i><i class="h n"></i><i class="h ne"></i><i class="h e"></i><i class="h se"></i><i class="h s"></i><i class="h sw"></i><i class="h w"></i><i class="rot"></i>`}</div>`;
  }
  let pts = "";
  for (const poly of st.textSel || []) pts += `<polygon points="${poly.map(([x, y]) => `${x * s},${y * s}`).join(" ")}"/>`;
  if (pts) html += `<svg class="dk-tsel" width="${st.w * s}" height="${st.h * s}">${pts}</svg>`;
  if (st.caret && !(st.textSel || []).length) {
    const [x0, y0, x1, y1] = st.caret;
    html += `<svg class="dk-caret" width="${st.w * s}" height="${st.h * s}"><line x1="${x0 * s}" y1="${y0 * s}" x2="${x1 * s}" y2="${y1 * s}"/></svg>`;
    const inp = $(".dk-input"), r = $(".dk-slide").getBoundingClientRect(), hr = host.getBoundingClientRect();
    inp.style.left = r.left - hr.left + x0 * s + "px"; inp.style.top = r.top - hr.top + y0 * s + "px";
  }
  $(".dk-ov").innerHTML = html;
}

function focusInput() { $(".dk-input")?.focus({ preventScroll: true }); }

// ---------------- pointer ----------------
function slidePoint(e) {
  const r = $(".dk-slide").getBoundingClientRect(), s = slideScale();
  return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
}
let down = false, dragBusy = null, lastDrag = null;
const mods = (e) => ({ shift: e.shiftKey, alt: e.altKey, cmd: e.ctrlKey || e.metaKey });
async function onDown(e) {
  if (!D || (e.button !== 0 && e.button !== 2)) return;
  if (!e.target.closest(".dk-stage")) return;
  e.preventDefault();
  focusInput();
  const p = slidePoint(e);
  await typing;
  const kind = e.button === 2 ? "contextclick" : e.detail === 2 ? "dblclick" : e.detail >= 3 ? "tripleclick" : "down";
  down = e.button === 0;
  const r = await q("deck.pointer", { kind, ...p, ...mods(e), tol: 4 / slideScale(), format: false });
  if (r.error) status(r.error, "err");
  apply(r.state);
}
function onMove(e) {
  if (!down || !D) return;
  lastDrag = { ...slidePoint(e), ...mods(e) };
  if (dragBusy) return;
  dragBusy = (async () => {
    while (lastDrag) {
      const p = lastDrag; lastDrag = null;
      const r = await q("deck.pointer", { kind: "drag", ...p, tol: 4 / slideScale(), format: false });
      apply(r.state);
    }
    dragBusy = null;
  })();
}
async function onUp(e) {
  if (!down || !D) return;
  down = false;
  await dragBusy;
  const r = await q("deck.pointer", { kind: "up", ...slidePoint(e), ...mods(e), tol: 4 / slideScale() });
  apply(r.state);
}

// ---------------- keys ----------------
const RESERVED = /^(s|o|n|w|tab|p|,)$/i;
async function onKey(e) {
  if (!D || e.isComposing || e.key === "Process") return;
  if (["Control", "Shift", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && RESERVED.test(e.key)) return;
  if (mod && (e.key === "z" || e.key === "y" || e.key === "Z")) { e.preventDefault(); const redo = e.key === "y" || e.shiftKey; await q("deck.undoN", { count: 1, redo }).then((r) => apply(r.state)); return; }
  if (mod && e.key.toLowerCase() === "v") return; // the paste event brings the clipboard
  if (e.key.length === 1 && !mod && !e.altKey) return; // typed text comes through `input`
  e.preventDefault();
  await typing;
  const r = await q("deck.key", { key: e.key.length === 1 ? e.key.toLowerCase() : e.key, ...mods(e) });
  if (r.error) status(r.error, "err");
  apply(r.state);
  if (mod && (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "x") && r.result?.result?.text != null) { try { await navigator.clipboard.writeText(r.result.result.text); } catch {} }
}
async function onPaste(e) {
  if (!D) return;
  e.preventDefault();
  const cd = e.clipboardData;
  const file = [...(cd?.files || [])].find((f) => f.type.startsWith("image/"));
  if (file) {
    const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.readAsDataURL(file); });
    return run("insert.picture", { data: b64, name: file.name || "picture.png" });
  }
  const html = cd?.getData("text/html"), text = cd?.getData("text/plain");
  if (html || text) return run("edit.paste", html ? { html, text } : { text });
  return run("edit.paste", {});
}

// ---------------- slide list ----------------
function wireSlides() {
  const box = $(".dk-slides");
  box.addEventListener("mousedown", async (e) => {
    const th = e.target.closest(".dk-th"); if (!th) return;
    const i = +th.dataset.i;
    if (e.shiftKey) await run("slide.selectRange", { to: i });
    else if (e.ctrlKey || e.metaKey) await run("slide.selectSlides", { indices: [i], add: true });
    else if (i !== D.state.slide) await run("slide.go", { index: i });
  });
  sortable(box, {
    item: ".dk-th", axis: "y",
    drop: (th, to) => {
      const from = +th.dataset.i;
      if (to > from) to -= 1;
      if (to === from) return;
      return flip(box, ".dk-th", (x) => x.dataset.id, () => run("slide.move", { from, to }));
    },
  });
  box.addEventListener("keydown", async (e) => {
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); await run("slide.delete", {}); }
    else if (e.key === "ArrowDown" || e.key === "PageDown") { e.preventDefault(); await run("slide.next"); }
    else if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); await run("slide.previous"); }
    else if (e.key === "Enter") { e.preventDefault(); await run("slide.new", {}); }
  });
  box.addEventListener("contextmenu", (e) => {
    const th = e.target.closest(".dk-th"); if (!th) return;
    e.preventDefault();
    rb?.menu({ getBoundingClientRect: () => ({ left: e.clientX, bottom: e.clientY }) }, [
      { label: "New Slide", cmd: "slide.new" }, { label: "Duplicate Slide", cmd: "slide.duplicate" }, { label: "Delete Slide", cmd: "slide.delete" },
      { sep: true }, { label: "Add Section", cmd: "section.add" }, { label: "Hide Slide", cmd: "slide.hide" }, { label: "Reset Slide", cmd: "slide.reset" }]);
  });
}

// ---------------- the ribbon ----------------
let rb = null, cmdsMap = null;
const fmt = () => D?.state?.fmt || {};
const LAYOUTS = [["title", "Title Slide"], ["titleAndContent", "Title and Content"], ["sectionHeader", "Section Header"], ["twoContent", "Two Content"], ["comparison", "Comparison"], ["titleOnly", "Title Only"], ["blank", "Blank"], ["contentWithCaption", "Content with Caption"], ["pictureWithCaption", "Picture with Caption"]];
const SHAPES = [["rect", "Rectangle"], ["roundRect", "Rounded Rectangle"], ["ellipse", "Oval"], ["triangle", "Triangle"], ["diamond", "Diamond"], ["rightArrow", "Right Arrow"], ["leftArrow", "Left Arrow"], ["chevron", "Chevron"], ["star5", "Star"], ["heart", "Heart"], ["line", "Line"], ["straightConnector1", "Arrow"], ["wedgeRectCallout", "Callout"], ["cloud", "Cloud"]];
const D_ICON = { "edit.paste": "paste", "edit.cut": "cut", "edit.copy": "copy", "format.painter": "format-painter", "slide.new": "new-slide", "slide.layout": "layout", "slide.reset": "reset-slide",
  "format.grow": "font-grow", "format.shrink": "font-shrink", "format.clear": "clear-formatting", "format.strikethrough": "strikethrough", "format.spacing": "char-spacing", "format.case": "change-case",
  "format.color": "font-color", "format.textShadow": "text-shadow", "format.outdent": "decrease-indent", "format.indent": "increase-indent", "format.lineSpacing": "line-spacing",
  "format.direction": "text-direction", "format.anchor": "align-text", "smartArt.fromText": "convert-smart-art", "shape.fill": "shape-fill", "shape.line": "shape-outline", "shape.effects": "shape-effects",
  "shape.quickStyle": "quick-styles", "insert.textBox": "text-box", "insert.picture": "picture", "shape.insert": "shapes", "insert.table": "table", "insert.chart": "chart", "insert.smartArt": "smart-art",
  "insert.wordArt": "word-art", "insert.video": "video", "insert.audio": "audio", "insert.hyperlink": "link", "insert.symbol": "symbol", "insert.slideNumber": "slide-number", "insert.dateTime": "date-time",
  "design.headerFooter": "header-footer", "design.slideSize": "slide-size", "design.background": "format-background", "design.theme": "themes", "slide.duplicate": "duplicate-slide", "slide.delete": "delete-slide",
  "slide.hide": "hide-slide", "arrange.bringToFront": "bring-to-front", "arrange.sendToBack": "send-to-back", "arrange.bringForward": "bring-forward", "arrange.sendBackward": "send-backward", "arrange.group": "group",
  "arrange.ungroup": "ungroup", "insert.icon": "icons", "review.newComment": "new-comment", "text.find": "search", "text.replace": "search", "insert.zoom": "zoom", "insert.actionButton": "action" };

function homeTab() {
  const S = (cmd, icon, label, extra = {}) => ({ t: "small", cmd, icon, label, ...extra });
  const I = (cmd, icon, title, extra = {}) => ({ t: "small", cmd, icon, title, iconOnly: true, ...extra });
  const layoutMenu = (cmd) => LAYOUTS.map(([k, l]) => ({ label: l, cmd, params: { layout: k } }));
  return { name: "Home", groups: [
    { name: "Clipboard", items: [
      { t: "big", icon: "paste", label: "Paste", cmd: "edit.paste", menu: [{ label: "Use Destination Theme", cmd: "edit.pasteSpecial", params: { as: "destinationTheme" } }, { label: "Keep Source Formatting", cmd: "edit.pasteSpecial", params: { as: "keepSource" } }, { label: "Picture", cmd: "edit.pasteSpecial", params: { as: "picture" } }, { label: "Keep Text Only", cmd: "edit.pasteSpecial", params: { as: "text" } }] },
      { t: "stack", items: [S("edit.cut", "cut", "Cut"), S("edit.copy", "copy", "Copy"), S("format.painter", "format-painter", "Format")] }] },
    { name: "Slides", items: [
      { t: "big", icon: "new-slide", label: "New Slide", cmd: "slide.new", menu: () => [...layoutMenu("slide.new"), { sep: true }, { label: "Duplicate Selected Slides", cmd: "slide.duplicate" }, { label: "Slides from Outline…", cmd: "slide.fromOutline" }] },
      { t: "stack", items: [S(null, "layout", "Layout", { menu: () => layoutMenu("slide.layout") }), S("slide.reset", "reset-slide", "Reset"),
        S(null, "section", "Section", { menu: [{ label: "Add Section", cmd: "section.add" }, { label: "Rename Section…", cmd: "section.rename" }, { label: "Remove Section", cmd: "section.remove" }, { label: "Remove All Sections", cmd: "section.removeAll" }] })] }] },
    { name: "Font", items: [{ t: "rows", rows: [
      [{ t: "select", width: 150, title: "Font", options: ["Aptos", "Aptos Display", "Calibri", "Calibri Light", "Arial", "Segoe UI", "Times New Roman", "Georgia", "Verdana", "Tahoma", "Century Gothic", "Garamond", "Consolas"], value: (f) => f.family || f.font, pick: (v) => run("format.font", { family: v }) },
       { t: "select", width: 56, title: "Font size", options: ["8", "9", "10", "10.5", "11", "12", "14", "16", "18", "20", "24", "28", "32", "36", "40", "44", "48", "54", "60", "66", "72", "80", "88", "96"], value: (f) => f.size, pick: (v) => run("format.size", { size: +v }) },
       I("format.grow", "font-grow", "Increase Font Size"), I("format.shrink", "font-shrink", "Decrease Font Size"), I("format.clear", "clear-formatting", "Clear All Formatting")],
      [I("format.bold", "bold", "Bold (Ctrl+B)", { on: (f) => f.bold }), I("format.italic", "italic", "Italic (Ctrl+I)", { on: (f) => f.italic }), I("format.underline", "underline", "Underline (Ctrl+U)", { on: (f) => f.underline && f.underline !== "none" }),
       I("format.strikethrough", "strikethrough", "Strikethrough", { on: (f) => f.strike || f.strikethrough }), I("format.superscript", "superscript", "Superscript"), I("format.subscript", "subscript", "Subscript"),
       I(null, "char-spacing", "Character Spacing", { menu: [["veryTight", -3], ["tight", -1.5], ["normal", 0], ["loose", 3], ["veryLoose", 6]].map(([n, pt]) => ({ label: n.replace(/([A-Z])/g, " $1").replace(/^./, (x) => x.toUpperCase()), cmd: "format.spacing", params: { pt } })) }),
       I(null, "change-case", "Change Case", { menu: [["sentence", "Sentence case."], ["lower", "lowercase"], ["upper", "UPPERCASE"], ["title", "Capitalize Each Word"], ["toggle", "tOGGLE cASE"]].map(([m, l]) => ({ label: l, cmd: "format.case", params: { mode: m } })) }),
       I(null, "highlight", "Text Highlight Color", { menu: [["#FFFF00", "Yellow"], ["#00FF00", "Bright Green"], ["#00FFFF", "Turquoise"], ["#FF00FF", "Pink"], ["#FF0000", "Red"]].map(([c, l]) => ({ label: l, cmd: "format.highlight", params: { color: c } })).concat([{ label: "No Color", cmd: "format.highlight", params: {} }]) }),
       { t: "color", icon: "font-color", title: "Font Color", value: "#c00000", pick: (v) => run("format.color", { color: v.toUpperCase() }) }] ] }] },
    { name: "Paragraph", items: [{ t: "rows", rows: [
      [I("format.bullets", "bullets", "Bullets", { menu: ["•", "○", "■", "□", "◆", "➢", "✓", "–"].map((c) => ({ label: `${c}  Bullets`, cmd: "format.bullets", params: { on: true, char: c } })).concat([{ label: "None", cmd: "format.bullets", params: { on: false } }]) }),
       I("format.numbering", "numbering", "Numbering", { menu: [["arabicPeriod", "1. 2. 3."], ["arabicParenR", "1) 2) 3)"], ["romanUcPeriod", "I. II. III."], ["romanLcPeriod", "i. ii. iii."], ["alphaUcPeriod", "A. B. C."], ["alphaLcPeriod", "a. b. c."]].map(([s, l]) => ({ label: l, cmd: "format.numbering", params: { on: true, scheme: s } })).concat([{ label: "None", cmd: "format.numbering", params: { on: false } }]) }),
       I("format.outdent", "decrease-indent", "Decrease List Level"), I("format.indent", "increase-indent", "Increase List Level"),
       I(null, "line-spacing", "Line Spacing", { menu: [1, 1.15, 1.5, 2, 2.5, 3].map((v) => ({ label: v.toFixed(v % 1 ? 2 : 1), cmd: "format.lineSpacing", params: { lines: v } })) }),
       I(null, "columns", "Columns", { menu: [1, 2, 3].map((n) => ({ label: `${n} Column${n > 1 ? "s" : ""}`, cmd: "format.columns", params: { count: n } })) })],
      [I("format.alignLeft", "align-left", "Align Left", { on: (f) => f.align === "left" || f.align === "l" }), I("format.alignCenter", "align-center", "Center", { on: (f) => f.align === "center" || f.align === "ctr" }),
       I("format.alignRight", "align-right", "Align Right", { on: (f) => f.align === "right" || f.align === "r" }), I("format.justify", "justify", "Justify", { on: (f) => f.align === "justify" || f.align === "just" }),
       I(null, "text-direction", "Text Direction", { menu: [["horizontal", "Horizontal"], ["rotate90", "Rotate all text 90°"], ["rotate270", "Rotate all text 270°"], ["stacked", "Stacked"]].map(([d, l]) => ({ label: l, cmd: "format.direction", params: { dir: d } })) }),
       I(null, "align-text", "Align Text", { menu: [["top", "Top"], ["middle", "Middle"], ["bottom", "Bottom"]].map(([a, l]) => ({ label: l, cmd: "format.anchor", params: { anchor: a } })) }),
       I(null, "convert-smart-art", "Convert to SmartArt", { menu: ["list", "process", "cycle", "hierarchy", "pyramid", "matrix"].map((k) => ({ label: k[0].toUpperCase() + k.slice(1), cmd: "smartArt.fromText", params: { kind: k } })) })] ] }] },
    { name: "Drawing", items: [
      { t: "big", icon: "picture", label: "Picture", action: () => ACTIONS.picture() },
      { t: "big", icon: "shapes", label: "Shapes", menu: SHAPES.map(([p, l]) => ({ label: l, action: () => drawShape(p) })) },
      { t: "big", icon: "text-box", label: "Text Box", action: () => q("deck.tool", { tool: "textBox" }).then((r) => { apply(r.state); status("Drag on the slide to draw the text box", "ok"); }) },
      { t: "big", icon: "arrange", label: "Arrange", menu: [["arrange.bringToFront", "Bring to Front"], ["arrange.bringForward", "Bring Forward"], ["arrange.sendBackward", "Send Backward"], ["arrange.sendToBack", "Send to Back"], null, ["arrange.group", "Group"], ["arrange.ungroup", "Ungroup"], null,
        ...["left", "center", "right", "top", "middle", "bottom"].map((e) => ["arrange.align", `Align ${e[0].toUpperCase() + e.slice(1)}`, { edge: e }]), ["arrange.distribute", "Distribute Horizontally", { dir: "horizontal" }], ["arrange.distribute", "Distribute Vertically", { dir: "vertical" }], null,
        ["arrange.rotateRight", "Rotate Right 90°"], ["arrange.rotateLeft", "Rotate Left 90°"], ["arrange.flipVertical", "Flip Vertical"], ["arrange.flipHorizontal", "Flip Horizontal"]].map((x) => (x ? { label: x[1], cmd: x[0], params: x[2] || {}, icon: D_ICON[x[0]] } : { sep: true })) },
      { t: "big", icon: "quick-styles", label: "Quick Styles", menu: Array.from({ length: 42 }, (_, i) => ({ label: `Style ${Math.floor(i / 6) + 1} · Accent ${(i % 6) + 1}`, cmd: "shape.quickStyle", params: { index: i } })) },
      { t: "stack", items: [
        S(null, "shape-fill", "Shape Fill", { menu: [["#4472C4", "Blue"], ["#ED7D31", "Orange"], ["#70AD47", "Green"], ["#FFC000", "Gold"], ["#7030A0", "Purple"], ["#C00000", "Red"], ["#FFFFFF", "White"], ["#000000", "Black"]].map(([c, l]) => ({ label: l, cmd: "shape.fill", params: { color: c } })).concat([{ label: "No Fill", cmd: "shape.fill", params: { none: true } }]) }),
        S(null, "shape-outline", "Shape Outline", { menu: [["#000000", "Black"], ["#4472C4", "Blue"], ["#C00000", "Red"], ["#FFFFFF", "White"]].map(([c, l]) => ({ label: l, cmd: "shape.line", params: { color: c } })).concat([{ sep: true }, ...[0.75, 1.5, 3, 6].map((w) => ({ label: `${w} pt`, cmd: "shape.line", params: { width: w } })), { label: "No Outline", cmd: "shape.line", params: { none: true } }]) }),
        S(null, "shape-effects", "Shape Effects", { menu: [{ label: "Shadow", cmd: "shape.effects", params: { shadow: "outer" } }, { label: "Inner Shadow", cmd: "shape.effects", params: { shadow: "inner" } }, { label: "No Shadow", cmd: "shape.effects", params: { shadow: "none" } }, { label: "Glow", cmd: "shape.effects", params: { glow: { color: "#4472C4", radius: 8 } } }, { label: "No Glow", cmd: "shape.effects", params: { glow: "none" } }] })] }] },
    { name: "Editing", items: [{ t: "stack", items: [S("text.find", "search", "Find", { action: () => ACTIONS.find() }), S("text.replace", "search", "Replace", { action: () => ACTIONS.replace() }), S(null, "lasso-select", "Select", { menu: [{ label: "Select All", action: () => q("deck.key", { key: "a", cmd: true }).then((r) => apply(r.state)) }] })] }] },
    { name: "Designer", items: [{ t: "big", icon: "design-ideas", label: "Design Ideas", action: () => ACTIONS.ideas() }] },
  ] };
}
async function drawShape(preset) {
  const r = await q("deck.tool", { tool: "shape", preset });
  apply(r.state);
  status("Drag on the slide to draw the shape (click for the default size)", "ok");
  focusInput();
}
const ACTIONS = {
  async picture() {
    const f = await call("pick_files", { name: "Pictures", exts: ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "emf", "wmf", "tif", "tiff"] });
    if (f?.[0]) await run("insert.picture", { path: f[0] });
  },
  async video() { const f = await call("pick_files", { name: "Videos", exts: ["mp4", "mov", "m4v", "webm", "mkv"] }); if (f?.[0]) await run("insert.video", { path: f[0] }); },
  async audio() { const f = await call("pick_files", { name: "Audio", exts: ["mp3", "m4a", "wav", "ogg", "opus"] }); if (f?.[0]) await run("insert.audio", { path: f[0] }); },
  async find() {
    const t = await ask({ title: "Find", text: "Find:", input: "" }); if (!t) return;
    const r = await run("text.find", { text: t });
    const hits = Array.isArray(r) ? r : r?.matches || [];
    if (!hits.length) return toast(`“${t}” wasn't found`, "", 3000);
    toast(`${hits.length} match${hits.length > 1 ? "es" : ""} — on slide ${[...new Set(hits.map((h) => h.slide + 1))].join(", ")}`, "ok", 5000);
    await run("slide.go", { index: hits[0].slide });
  },
  async replace() {
    const t = await ask({ title: "Replace", text: "Find:", input: "" }); if (!t) return;
    const w = await ask({ title: "Replace", text: `Replace every “${t}” with:`, input: "" }); if (w == null) return;
    const r = await run("text.replace", { text: t, with: w });
    toast(`Replaced ${r?.replaced ?? r?.count ?? ""}`, "ok", 3000);
  },
  async ideas() {
    const r = await run("design.ideas", {});
    const list = Array.isArray(r) ? r : r?.ideas || [];
    if (!list.length) return toast("No design ideas for this slide", "", 3000);
    rb.menu(host.querySelector(".rb-body"), list.map((x) => ({ label: x.label, cmd: "design.applyIdea", params: { id: x.id } })));
  },
};
const ACTION_CMDS = { "insert.picture": () => ACTIONS.picture(), "insert.video": () => ACTIONS.video(), "insert.audio": () => ACTIONS.audio(), "text.find": () => ACTIONS.find(), "text.replace": () => ACTIONS.replace(), "shape.insert": () => drawShape("rect"), "insert.textBox": () => q("deck.tool", { tool: "textBox" }).then((r) => apply(r.state)) };

async function buildRibbon() {
  if (rb) return;
  await loadIcons();
  const list = await office("deck.commands", { id: D.id }).catch(() => []);
  const cmds = list.map((c) => ({ ...c, path: c.menu || [] }));
  cmdsMap = new Map(cmds.map((c) => [c.id, c]));
  const match = iconMatcher("deck", D_ICON);
  const auto = autoTabs(cmds, { order: ["Insert", "Draw", "Design", "Transitions", "Animations", "Slide Show", "Review", "View", "Shape Format", "Picture Format", "Table Design", "Table Layout", "Arrange"], skip: ["Home", "File", "Window", "Edit", "Tools", "Format", "Format Shape", "Format Background", "Selection Pane", "Animation Pane", "Comments", "Handout Master", "Notes Master", "Slide Master", "Playback", "Video Format", "Chart Design", "SmartArt Design"], iconFor: match });
  rb = new Ribbon({
    el: $(".dk-rb"), set: "deck", tabs: [homeTab(), ...auto], commands: cmdsMap, auto: ["ids", "index", "slide", "rect"],
    run: async (id, p) => (ACTION_CMDS[id] && !Object.keys(p || {}).length ? ACTION_CMDS[id]() : run(id, p)),
    state: fmt, focus: focusInput,
    extra: (row) => {
      row.appendChild(tellBox({ commands: cmdsMap, exec: (id) => rb.exec(id), focus: focusInput }));
      const ex = document.createElement("button"); ex.className = "small rb-export"; ex.textContent = "Export ▾"; ex.title = "Save a copy as PDF, pictures or PowerPoint";
      ex.onclick = () => D && exportDeck(D.t); row.appendChild(ex);
    },
  });
}

// ---------------- wiring ----------------
function wire() {
  host.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  $(".dk-stage").addEventListener("contextmenu", (e) => e.preventDefault());
  $(".dk-stage").addEventListener("wheel", (e) => {
    if (!D) return;
    if (e.ctrlKey) { e.preventDefault(); D.zoom = slideScale() * (e.deltaY < 0 ? 1.1 : 1 / 1.1); layout(); }
    else if (!D.zoom) { e.preventDefault(); if (Math.abs(e.deltaY) > 20) run(e.deltaY > 0 ? "slide.next" : "slide.previous"); }
  }, { passive: false });
  const inp = $(".dk-input");
  inp.addEventListener("keydown", onKey);
  inp.addEventListener("input", (e) => { if (e.isComposing) return; const v = inp.value; inp.value = ""; if (v) typeText(v); });
  inp.addEventListener("compositionend", () => { const v = inp.value; inp.value = ""; if (v) typeText(v); });
  inp.addEventListener("paste", onPaste);
  inp.addEventListener("focus", () => host.classList.add("focused"));
  inp.addEventListener("blur", () => host.classList.remove("focused"));
  const notes = $(".dk-notes");
  notes.addEventListener("change", () => { if (D) run("slide.notes", { text: notes.value }); });
  notes.addEventListener("keydown", (e) => e.stopPropagation());
  $(".dk-notes-btn").onclick = () => host.classList.toggle("no-notes");
  $(".dk-zi").onclick = () => { D.zoom = slideScale() * 1.15; layout(); };
  $(".dk-zo").onclick = () => { D.zoom = slideScale() / 1.15; layout(); };
  $(".dk-fit").onclick = () => { D.zoom = 0; layout(); };
  wireSlides();
  new ResizeObserver(() => { if (D) layout(); }).observe($(".dk-stage"));
}

// ---------------- saving / export ----------------
export async function saveDeck(t, saveAs = false) {
  if (!t.deckId) return true;
  const ext = (t.path.split(".").pop() || "").toLowerCase();
  let out = t.path;
  if (saveAs || !WRITABLE.includes(ext)) {
    if (!saveAs) {
      const r = await ask({ title: `Save ${t.name}`, text: `.${ext} can't be written. Save the presentation as PowerPoint (.pptx) next to it? The original stays as it is.`, buttons: [{ label: "Cancel", value: null }, { label: "Save as .pptx", value: "y", primary: true }] });
      if (!r) return false;
    }
    out = await api.pickSaveFile(basename(t.path).replace(/\.[^.]+$/, "") + ".pptx", dirname(t.path));
    if (!out) return false;
  }
  try {
    status(`Saving ${basename(out)}…`);
    const tmp = await call("office_temp", { name: basename(out).replace(/\.[^.]+$/, ".pptx") });
    const r = await office("deck.save", { id: t.deckId, out: tmp, markSaved: true });
    const bytes = new Uint8Array(await api.readBinary(tmp));
    try { t.mtime = await api.writeBinary(out, bytes, out === t.path ? t.mtime || 0 : 0, true); }
    catch (e) {
      if (e.message !== "CHANGED_ON_DISK") throw e;
      const ok = await ask({ title: "Changed on disk", text: `${t.name} was changed by another program since you opened it. Overwrite it? (The current file is backed up first.)`, buttons: [{ label: "Cancel", value: null }, { label: "Overwrite", value: "y", primary: true }] });
      if (!ok) return false;
      t.mtime = await api.writeBinary(out, bytes, 0, true);
    }
    if (out !== t.path) { t.path = out; t.name = basename(out); }
    t.dirty = false;
    if (D?.t === t) { D.state = r.state; }
    window.dispatchEvent(new Event("callio-tab-dirty"));
    status(`Saved ${basename(out)} (the previous version is kept in Callio's backups)`, "ok");
    return true;
  } catch (e) { status("Save failed", "err"); toast(`Couldn't save ${basename(out)}: ${e.message}`, "err", 8000); return false; }
}
export async function exportDeck(t) {
  const fmtv = await ask({ title: `Export ${t.name}`, text: "Save a copy as:", vertical: true, buttons: [{ label: "Cancel", value: null }, { label: "PDF (.pdf)", value: "pdf" }, { label: "PowerPoint (.pptx)", value: "pptx" }, { label: "This slide as a picture (.png)", value: "png" }, { label: "Outline as Rich Text (.rtf)", value: "rtf" }, { label: "Animated GIF (.gif)", value: "gif" }] });
  if (!fmtv) return;
  const out = await api.pickSaveFile(basename(t.path).replace(/\.[^.]+$/, "") + "." + fmtv, dirname(t.path));
  if (!out) return;
  try {
    status(`Saving ${basename(out)}…`);
    if (fmtv === "png") await run("file.export", { path: out, format: "png", slide: D?.state?.slide ?? 0 });
    else await office("deck.save", { id: t.deckId, out });
    toast(`Saved ${basename(out)}`, "ok", 3000);
    if (fmtv === "pdf") openPath(out);
  } catch (e) { toast(`Couldn't save: ${e.message}`, "err", 8000); }
}

// ---------------- undo ----------------
registerUndo("deck", {
  list: (t) => { const st = D?.t === t ? D.state : t.deckState; return { undo: st?.undo || [], redo: st?.redo || [] }; },
  step: async (t, n, redo) => { if (D?.t !== t) return; const r = await q("deck.undoN", { count: n, redo }); apply(r.state); focusInput(); },
});

/** For the AI: commands on an open presentation as one undo step. */
export async function aiBatch(t, commands, label) {
  const r = await office("deck.batch", { id: t.deckId, commands, label });
  if (D?.t === t) apply(r.state); else t.deckState = r.state;
  t.dirty = r.state.dirty;
  window.dispatchEvent(new Event("callio-tab-dirty"));
  return r.result;
}
