// Text boxes and notes on PDF pages, with any installed font, size, colour, bold/italic.
// While editing they are HTML boxes over the pages (positions kept in PDF points, so they
// follow zoom and layout). Saving writes each as a standard FreeText annotation whose
// appearance uses the chosen font, embedded (subset) with pdf-lib — every PDF reader shows it.
// Boxes Callio wrote before (marked with /NM "callio-…") are lifted back into editable boxes
// when the PDF is opened, so they stay editable later.
import { call } from "./api.js";

const DEFAULT = { font: "Arial", size: 12, color: "#1f2328", bold: false, italic: false, bg: "", kind: "text" };
const NOTE = { font: "Segoe UI", size: 10, color: "#1f2328", bold: false, italic: false, bg: "#fff3a8", kind: "note" };

let viewer = null, container = null, onChange = () => {}, onSelect = () => {};
let tool = null; // "text" | "note" | null
let boxes = new Map(); // id → box
let selected = null;
let style = { ...DEFAULT };
let seq = 0;

export function initTextBoxes(opts) {
  ({ viewer, container } = opts);
  onChange = opts.onChange || onChange;
  onSelect = opts.onSelect || onSelect;
  const eb = opts.eventBus;
  const later = () => requestAnimationFrame(renderAll);
  for (const ev of ["pagerendered", "pagesinit", "scalechanging", "rotationchanging", "updateviewarea", "spreadmodechanged", "scrollmodechanged"]) eb.on(ev, later);
  container.addEventListener("pointerdown", onPagePointer, true);
  document.addEventListener("keydown", (e) => {
    if (!selected || selected.editing) return;
    if ((e.key === "Delete" || e.key === "Backspace") && container.contains(document.activeElement || container) && !e.target.closest?.("input,select,textarea,[contenteditable=true]")) {
      e.preventDefault();
      removeBox(selected.id);
    }
    if (e.key === "Escape") select(null);
  });
}

export const boxCount = () => boxes.size;
export function setTool(t) {
  if (t !== tool) select(null);
  tool = t === "text" || t === "note" ? t : null;
  container?.classList.toggle("q-text-tool", !!tool);
  if (tool === "note") style = { ...style, ...NOTE };
  else if (tool === "text" && style.kind === "note") style = { ...style, ...DEFAULT, font: style.font === NOTE.font ? DEFAULT.font : style.font };
}
export const currentStyle = () => (selected ? { ...selected.style } : { ...style });
/** Toolbar change: applies to the selected box, and to new boxes. */
export function setStyle(patch) {
  style = { ...style, ...patch };
  if (selected) {
    selected.style = { ...selected.style, ...patch };
    paint(selected);
    onChange();
  }
}
/** A new document: forget the boxes (the caller re-adds lifted ones). */
export function reset(list = []) {
  for (const b of boxes.values()) b.el?.remove();
  boxes = new Map();
  selected = null;
  for (const b of list) boxes.set(b.id, b);
  requestAnimationFrame(renderAll);
}
export const allBoxes = () => [...boxes.values()].map(({ el, editing, ...b }) => ({ ...b, style: { ...b.style }, text: b.el ? textOf(b.el) : b.text }));

// ---------------- placing and drawing ----------------
function pageViewOf(pageNumber) { return viewer?.getPageView(pageNumber - 1); }
function layerFor(pageNumber) {
  const pv = pageViewOf(pageNumber);
  if (!pv?.div) return null;
  let l = pv.div.querySelector(":scope > .q-text-layer");
  if (!l) { l = document.createElement("div"); l.className = "q-text-layer"; pv.div.appendChild(l); }
  return l;
}
function renderAll() {
  for (const b of boxes.values()) place(b);
}
function place(b) {
  const pv = pageViewOf(b.page);
  const layer = layerFor(b.page);
  if (!pv?.viewport || !layer) return;
  if (!b.el) b.el = makeEl(b);
  if (b.el.parentNode !== layer) layer.appendChild(b.el);
  const vp = pv.viewport;
  const [x1, y1] = vp.convertToViewportPoint(b.x, b.y - b.h), [x2, y2] = vp.convertToViewportPoint(b.x + b.w, b.y);
  const s = vp.scale;
  Object.assign(b.el.style, { left: Math.min(x1, x2) + "px", top: Math.min(y1, y2) + "px", width: Math.abs(x2 - x1) + "px", minHeight: Math.abs(y2 - y1) + "px" });
  b.el.style.setProperty("--s", s);
  paint(b);
}
function paint(b) {
  const el = b.el; if (!el) return;
  const st = b.style;
  const s = +(el.style.getPropertyValue("--s") || 1);
  el.classList.toggle("note", !!st.bg);
  Object.assign(el.style, {
    fontFamily: `"${st.font}", sans-serif`, fontSize: st.size * s * (4 / 3) * 0.75 + "px", color: st.color,
    fontWeight: st.bold ? "700" : "400", fontStyle: st.italic ? "italic" : "normal", background: st.bg || "transparent",
  });
}
const textOf = (el) => (el.querySelector(".q-tb-text")?.innerText ?? "").replace(/ /g, " ").replace(/\n$/, "");

function makeEl(b) {
  const el = document.createElement("div");
  el.className = "q-textbox";
  el.dataset.id = b.id;
  el.innerHTML = `<div class="q-tb-text" spellcheck="true"></div><span class="q-tb-grip" title="Drag to move"></span><span class="q-tb-size" title="Drag to resize"></span>`;
  el.querySelector(".q-tb-text").innerText = b.text || "";
  const txt = el.querySelector(".q-tb-text");
  txt.addEventListener("input", () => { b.text = textOf(el); syncHeight(b); onChange(); });
  txt.addEventListener("blur", () => stopEditing(b));
  el.addEventListener("dblclick", (e) => { e.stopPropagation(); startEditing(b); });
  el.addEventListener("pointerdown", (e) => onBoxPointer(e, b));
  return el;
}
function syncHeight(b) {
  const pv = pageViewOf(b.page);
  if (!pv?.viewport || !b.el) return;
  const s = pv.viewport.scale;
  const h = b.el.scrollHeight / s;
  if (Math.abs(h - b.h) > 0.5) b.h = h;
}
function startEditing(b) {
  select(b);
  b.editing = true;
  const t = b.el.querySelector(".q-tb-text");
  t.contentEditable = "true";
  t.focus();
  const r = document.createRange(); r.selectNodeContents(t); r.collapse(false);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
}
function stopEditing(b) {
  if (!b.editing) return;
  b.editing = false;
  const t = b.el?.querySelector(".q-tb-text");
  if (t) t.contentEditable = "false";
  b.text = b.el ? textOf(b.el) : b.text;
  if (!b.text.trim()) removeBox(b.id); // an empty box goes away, like Word
  else { syncHeight(b); onChange(); }
}
function select(b) {
  if (selected && selected !== b) { selected.el?.classList.remove("sel"); if (selected.editing) stopEditing(selected); }
  selected = b;
  b?.el?.classList.add("sel");
  onSelect(b ? { ...b.style } : null);
}
function removeBox(id) {
  const b = boxes.get(id);
  if (!b) return;
  b.el?.remove();
  boxes.delete(id);
  if (selected === b) { selected = null; onSelect(null); }
  onChange();
}

function onPagePointer(e) {
  if (e.button !== 0) return;
  if (e.target.closest(".q-textbox")) return;
  if (selected && !tool) select(null);
  if (!tool) return;
  const pageEl = e.target.closest(".page");
  if (!pageEl) return;
  e.preventDefault(); e.stopPropagation();
  const page = +pageEl.dataset.pageNumber;
  const pv = pageViewOf(page);
  if (((pv?.pdfPage?.rotate || 0) % 360) !== 0) {
    import("./main.js").then((m) => m.toast("Text boxes aren't supported on rotated pages yet — use a note on another page, or a drawing.", "", 5000));
    return;
  }
  const r = pageEl.getBoundingClientRect();
  const [x, y] = pv.viewport.convertToPdfPoint(e.clientX - r.left, e.clientY - r.top);
  const st = { ...style };
  const w = st.kind === "note" ? 160 : 200;
  const b = { id: `quire-${Date.now().toString(36)}-${seq++}`, page, x, y, w, h: st.size * 1.5 + 6, text: "", style: st };
  boxes.set(b.id, b);
  place(b);
  startEditing(b);
}

function onBoxPointer(e, b) {
  if (e.button !== 0) return;
  const grip = e.target.closest(".q-tb-grip"), size = e.target.closest(".q-tb-size");
  if (b.editing && !grip && !size) return; // clicking inside the text while typing
  e.preventDefault(); e.stopPropagation();
  select(b);
  if (!grip && !size && e.detail >= 2) return startEditing(b);
  const pv = pageViewOf(b.page);
  const s = pv.viewport.scale;
  const start = { x: e.clientX, y: e.clientY, bx: b.x, by: b.y, w: b.w };
  const rot = pv.viewport.rotation || 0;
  b.el.classList.add("q-dragging");
  let moved = false;
  const move = (ev) => {
    let dx = (ev.clientX - start.x) / s, dy = (ev.clientY - start.y) / s;
    if (rot === 90) [dx, dy] = [dy, -dx]; else if (rot === 180) [dx, dy] = [-dx, -dy]; else if (rot === 270) [dx, dy] = [-dy, dx];
    if (Math.abs(dx) + Math.abs(dy) > 0.5) moved = true;
    if (size) b.w = Math.max(24, start.w + dx);
    else { b.x = start.bx + dx; b.y = start.by - dy; }
    place(b);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    b.el?.classList.remove("q-dragging");
    if (moved) { syncHeight(b); onChange(); }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ---------------- fonts ----------------
let fontList = null;
export async function fonts() {
  if (!fontList) { try { fontList = await call("system_fonts"); } catch {} if (!Array.isArray(fontList)) fontList = []; }
  return fontList;
}
async function fontBytes(st) {
  const list = await fonts();
  const f = list.find((x) => x.family.toLowerCase() === String(st.font).toLowerCase());
  if (!f) return null;
  const path = (st.bold && st.italic && f.boldItalic) || (st.bold && f.bold) || (st.italic && f.italic) || f.regular;
  try { return new Uint8Array(await call("font_file", { path })); } catch { return null; }
}

// ---------------- reading and writing the PDF ----------------
const hex = (c) => { const m = /^#?([0-9a-f]{6})$/i.exec(c || ""); const n = m ? parseInt(m[1], 16) : 0; return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };

/** Lift the text boxes Callio saved earlier out of `bytes`: returns the stripped PDF and the boxes. */
export async function liftBoxes(bytes) {
  const { PDFDocument, PDFName, PDFArray } = await import("pdf-lib");
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  if (pdf.isEncrypted) return { bytes, boxes: [] }; // can't be rewritten safely; leave it as it is
  const out = [];
  pdf.getPages().forEach((page, i) => {
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) return;
    for (let k = annots.size() - 1; k >= 0; k--) {
      const d = annots.lookup(k);
      const nm = d?.lookup?.(PDFName.of("NM"));
      const name = nm?.decodeText?.() || "";
      if (!name.startsWith("quire-")) continue;
      let st = {};
      try { st = JSON.parse(d.lookup(PDFName.of("QuireStyle"))?.decodeText?.() || "{}"); } catch {}
      const rect = d.lookup(PDFName.of("Rect"))?.asRectangle?.();
      const text = d.lookup(PDFName.of("Contents"))?.decodeText?.() || "";
      if (!rect) continue;
      out.push({ id: name, page: i + 1, x: rect.x, y: rect.y + rect.height, w: rect.width, h: rect.height, text, style: { ...DEFAULT, ...st } });
      annots.remove(k);
    }
  });
  if (!out.length) return { bytes, boxes: [] };
  return { bytes: await pdf.save({ updateFieldAppearances: false }), boxes: out };
}

/** Write the boxes into `bytes` (a PDF from pdf.js' saveDocument) as FreeText annotations. */
export async function writeBoxes(bytes) {
  const list = allBoxes().filter((b) => b.text.trim());
  if (!list.length) return bytes;
  const lib = await import("pdf-lib");
  const { PDFDocument, PDFName, PDFString, PDFHexString, StandardFonts, pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, moveText, showText, setFillingRgbColor, rectangle, fill, stroke, setStrokingRgbColor, setLineWidth } = lib;
  const fontkit = (await import("@pdf-lib/fontkit")).default;
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  // pdf-lib would write new objects unencrypted into an encrypted file, which readers then
  // garble: refuse instead of damaging the PDF
  if (pdf.isEncrypted) throw new Error("This PDF is encrypted (password-protected), so text boxes can't be written into it. Drawings, highlights and pictures still save; remove the text boxes or save an unprotected copy first.");
  pdf.registerFontkit(fontkit);
  const cache = new Map();
  const embed = async (st) => {
    const key = `${st.font}|${st.bold}|${st.italic}`;
    if (cache.has(key)) return cache.get(key);
    let font = null;
    const b = await fontBytes(st);
    if (b) { try { font = await pdf.embedFont(b, { subset: true }); } catch (e) { console.warn("font", e); } }
    if (!font) {
      const serif = /times|georgia|cambria|garamond|serif|book/i.test(st.font), mono = /mono|consolas|courier|code/i.test(st.font);
      const S = StandardFonts;
      const name = mono ? (st.bold ? (st.italic ? S.CourierBoldOblique : S.CourierBold) : st.italic ? S.CourierOblique : S.Courier)
        : serif ? (st.bold ? (st.italic ? S.TimesRomanBoldItalic : S.TimesRomanBold) : st.italic ? S.TimesRomanItalic : S.TimesRoman)
        : (st.bold ? (st.italic ? S.HelveticaBoldOblique : S.HelveticaBold) : st.italic ? S.HelveticaOblique : S.Helvetica);
      font = await pdf.embedFont(name);
    }
    cache.set(key, font);
    return font;
  };
  const pages = pdf.getPages();
  for (const b of list) {
    const page = pages[b.page - 1];
    if (!page) continue;
    const st = b.style, font = await embed(st), size = st.size;
    // wrap to the box width like the editor did
    const pad = st.bg ? 4 : 1, maxW = Math.max(10, b.w - 2 * pad);
    const lines = [];
    for (const para of b.text.split("\n")) {
      let cur = "";
      for (const word of para.split(/(\s+)/)) {
        const next = cur + word;
        let width; try { width = font.widthOfTextAtSize(next, size); } catch { width = next.length * size * 0.5; }
        if (width > maxW && cur.trim()) { lines.push(cur.trimEnd()); cur = word.trimStart(); } else cur = next;
      }
      lines.push(cur);
    }
    const lh = size * 1.2;
    const h = Math.max(b.h, lines.length * lh + 2 * pad);
    const [r, g, bl] = hex(st.color);
    const ops = [pushGraphicsState()];
    if (st.bg) {
      const [br, bg2, bb] = hex(st.bg);
      ops.push(setFillingRgbColor(br, bg2, bb), rectangle(0, 0, b.w, h), fill(), setStrokingRgbColor(br * 0.8, bg2 * 0.8, bb * 0.6), setLineWidth(0.6), rectangle(0.3, 0.3, b.w - 0.6, h - 0.6), stroke());
    }
    ops.push(beginText(), setFontAndSize("F0", size), setFillingRgbColor(r, g, bl), moveText(pad, h - pad - size * 0.95));
    lines.forEach((ln, i) => {
      if (i) ops.push(moveText(0, -lh));
      let enc; try { enc = font.encodeText(ln); } catch { enc = font.encodeText(ln.replace(/[^\x20-\x7e]/g, "?")); }
      ops.push(showText(enc));
    });
    ops.push(endText(), popGraphicsState());
    const ctx = pdf.context;
    const ap = ctx.formXObject(ops, { BBox: [0, 0, b.w, h], Resources: { Font: { F0: font.ref } } });
    const apRef = ctx.register(ap);
    const top = b.y, left = b.x;
    const annot = ctx.obj({
      Type: "Annot", Subtype: "FreeText", Rect: [left, top - h, left + b.w, top], F: 4,
      DA: PDFString.of(`/Helv ${size} Tf ${r.toFixed(3)} ${g.toFixed(3)} ${bl.toFixed(3)} rg`),
      AP: { N: apRef },
    });
    annot.set(PDFName.of("Contents"), PDFHexString.fromText(b.text));
    annot.set(PDFName.of("NM"), PDFString.of(b.id.replace(/[^\w-]/g, "")));
    annot.set(PDFName.of("T"), PDFHexString.fromText("Callio"));
    annot.set(PDFName.of("M"), PDFString.fromDate(new Date()));
    annot.set(PDFName.of("QuireStyle"), PDFHexString.fromText(JSON.stringify(st)));
    if (st.bg) annot.set(PDFName.of("C"), ctx.obj(hex(st.bg)));
    page.node.addAnnot(ctx.register(annot));
  }
  // plain objects (no object streams), so the "(quire-" mark is found quickly on open
  return await pdf.save({ updateFieldAppearances: false, useObjectStreams: false });
}
