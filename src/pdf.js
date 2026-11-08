import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { EventBus, PDFViewer, PDFLinkService, PDFFindController, ScrollMode, SpreadMode } from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";
import * as tb from "./pdf-text.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

let viewer, eventBus, linkService, findController, container, doc = null, loadingTask = null;
let onDblClick = () => {};
let onFindCount = () => {};
let loadSeq = 0;
let onScaleChange = null;
let onDocLoaded = null;
export function onLoaded(cb) { onDocLoaded = cb; }

export function initPdf(el, { onPageChange, onInverse, onFindResult, onScale }) {
  container = el;
  onScaleChange = onScale;
  eventBus = new EventBus();
  linkService = new PDFLinkService({ eventBus, externalLinkTarget: 2 });
  findController = new PDFFindController({ eventBus, linkService, updateMatchesCountOnProgress: true });
  viewer = new PDFViewer({
    container,
    viewer: container.querySelector(".pdfViewer"),
    eventBus,
    linkService,
    findController,
    textLayerMode: 1,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
    // the editing layer (text boxes, drawing, highlights, images); idle until a tool is picked
    annotationEditorMode: pdfjsLib.AnnotationEditorType.NONE,
    removePageBorders: true,
    maxCanvasPixels: 16777216 * 2,
  });
  linkService.setViewer(viewer);
  tb.initTextBoxes({ viewer, container, eventBus, onChange: () => { boxesDirty = true; editGen++; onModified(true); }, onSelect: (st) => onBoxSelect(st) });
  // any typing/dragging on the pages counts as a change (so a save that was running when it
  // happened doesn't mark the tab clean)
  for (const ev of ["keyup", "pointerup", "input", "paste", "drop"]) container.addEventListener(ev, (e) => { if (viewer.annotationEditorMode > 0 || container.classList.contains("q-text-tool") || e.target.closest?.(".q-textbox, .annotationEditorLayer, .annotationLayer")) editGen++; }, true);
  // keep "fit width / fit page" right when the pane is resized (splitter, panels, window)
  let rz = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(rz);
    rz = requestAnimationFrame(() => {
      const v = viewer.currentScaleValue;
      if (doc && typeof v === "string" && isNaN(+v)) viewer.currentScaleValue = v;
      scheduleAuto();
    });
  }).observe(container);
  container.addEventListener("scroll", () => {
    if (!userScroll) return;
    cancelAnimationFrame(container._sr);
    container._sr = requestAnimationFrame(() => userScroll?.());
  }, { passive: true });
  eventBus.on("pagechanging", (e) => { onPageChange?.(e.pageNumber, viewer.pagesCount); markThumb(e.pageNumber); });
  eventBus.on("scalechanging", () => { onScaleChange?.(); scheduleAuto(); });
  eventBus.on("annotationeditoruimanager", (e) => { uiManager = e.uiManager; });
  eventBus.on("pagesinit", () => onPageChange?.(viewer.currentPageNumber, viewer.pagesCount));
  onFindCount = onFindResult || (() => {});
  eventBus.on("updatefindmatchescount", (e) => onFindCount(e.matchesCount));
  eventBus.on("updatefindcontrolstate", (e) => onFindCount(e.matchesCount, e.state));
  onDblClick = onInverse || (() => {});
  container.addEventListener("dblclick", (ev) => {
    const pageEl = ev.target.closest(".page");
    if (!pageEl) return;
    const pageNumber = +pageEl.dataset.pageNumber;
    const pv = viewer.getPageView(pageNumber - 1);
    if (!pv) return;
    const r = pageEl.getBoundingClientRect();
    const [x, y] = pv.viewport.convertToPdfPoint(ev.clientX - r.left, ev.clientY - r.top);
    const [, , , h] = pv.pdfPage.view;
    onDblClick(pageNumber, x, h - y); // top-left origin, PDF points
  });
  // Ctrl+wheel and touchpad pinch (Chromium reports pinch as ctrl+wheel): smooth zoom around
  // the pointer — pages are scaled with CSS at once and re-rendered sharply when the gesture ends.
  // PDF.js rounds each step to 1%, so the many tiny steps of a touchpad pinch would be lost:
  // accumulate the wanted scale and apply it once per frame.
  let target = 0, origin = null, frame = 0, idle = 0;
  container.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (!doc) return;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const factor = Math.exp(-dy * (Math.abs(dy) < 40 ? 0.008 : 0.0015));
    if (!target) target = viewer.currentScale;
    target = Math.min(6, Math.max(0.2, target * factor));
    origin = [e.clientX, e.clientY];
    clearTimeout(idle);
    idle = setTimeout(() => { target = 0; }, 250);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!target) return;
      const f = target / viewer.currentScale;
      if (Math.abs(f - 1) < 0.005) return;
      viewer.updateScale({ scaleFactor: f, origin, drawingDelay: 300 });
      onScaleChange?.();
    });
  }, { passive: false });
}

/**
 * Show a PDF. `opts.keep`: keep the current zoom/scroll (recompiles of the same document);
 * `opts.view`: restore a saved {scale, top, left}; otherwise fit the width.
 */
export async function loadPdf(bytes, opts = {}) {
  const seq = ++loadSeq;
  // text boxes Callio wrote earlier come back as editable boxes
  let lifted = [];
  if (hasQuireMarks(bytes)) {
    try { const r = await tb.liftBoxes(bytes); bytes = r.bytes; lifted = r.boxes; } catch (e) { console.warn("text boxes", e); }
    if (seq !== loadSeq) return;
  }
  const view = opts.view || (opts.keep && doc ? getViewState() : null);
  const task = pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false });
  const newDoc = await task.promise;
  if (seq !== loadSeq) { task.destroy(); return; } // a newer load won
  const oldTask = loadingTask;
  loadingTask = task;
  doc = newDoc;
  boxesDirty = false;
  tb.reset(lifted);
  const restore = () => {
    eventBus.off("pagesinit", restore);
    if (seq !== loadSeq) return; // a newer document took over
    try {
      setLayout(layout);
      viewer.currentScaleValue = view?.scale || opts.defaultZoom || "page-width";
      if (view) { container.scrollTop = view.top; container.scrollLeft = view.left; }
      // the same place in the new PDF: by page and position (pixel offsets shift when the
      // layout or page sizes change); again once late layout changes have settled
      const at = view?.at;
      if (at) scrollToPoint(at.page, at.y, 12);
      setTimeout(() => { if (seq !== loadSeq) return; if (at) scrollToPoint(at.page, at.y, 12); opts.after?.(); }, 350);
    } catch (e) { console.warn("pdf view restore", e); }
  };
  eventBus.on("pagesinit", restore);
  viewer.setDocument(doc);
  linkService.setDocument(doc, null);
  // the layout is applied once the pages exist ("pagesinit" → restore): changing the scroll
  // or spread mode before that makes PDF.js scroll to a page that isn't there yet
  thumbDoc = null;
  syncEmpty();
  watchStorage();
  onDocLoaded?.();
  // free the previous document only after the viewer switched over
  if (oldTask) oldTask.destroy().catch(() => {});
}

export function getViewState() {
  if (!viewer || !doc) return null;
  return { scale: viewer.currentScaleValue, top: container.scrollTop, left: container.scrollLeft, at: topPoint() };
}

// ---------- positions in PDF terms (for keeping the place and scrolling with the editor) ----------
/** The point at the top of the view: { page, x, y } in PDF points, y from the page top. */
/**
 * Where every page sits in the scroll area: [{top, k}] (scroll px of the page's y = 0, px per
 * PDF point). null when pages sit side by side (then a vertical map doesn't exist).
 */
export function pageGeometry() {
  if (!viewer || !doc || !viewer.pagesCount) return null;
  const c = container.getBoundingClientRect(), out = [];
  let prevTop = -Infinity;
  for (let i = 0; i < viewer.pagesCount; i++) {
    const pv = viewer.getPageView(i);
    if (!pv?.viewport || !pv.div) return null;
    const ph = pv.pdfPage?.view?.[3] ?? pv.viewport.viewBox[3];
    const y0 = pv.viewport.convertToViewportPoint(0, ph)[1], y1 = pv.viewport.convertToViewportPoint(0, ph - 100)[1];
    const r = pv.div.getBoundingClientRect();
    const top = container.scrollTop + r.top - c.top + (pv.div.clientTop || 0) + y0;
    if (top <= prevTop + 1) return null; // side by side
    prevTop = top;
    out.push({ top, k: (y1 - y0) / 100 });
  }
  return out;
}
export function topPoint() {
  if (!viewer || !doc || !viewer.pagesCount) return null;
  const c = container.getBoundingClientRect();
  const probeY = c.top + 12, probeX = c.left + c.width / 2;
  for (const el of container.querySelectorAll(".page")) {
    const r = el.getBoundingClientRect();
    if (r.bottom < probeY || r.top > c.bottom) continue;
    if (r.top > probeY && r.left > probeX) continue;
    const n = +el.dataset.pageNumber;
    const pv = viewer.getPageView(n - 1);
    if (!pv?.viewport) continue;
    const [x, y] = pv.viewport.convertToPdfPoint(Math.max(0, Math.min(r.width, probeX - r.left)), Math.max(0, probeY - r.top));
    const ph = pv.pdfPage.view[3];
    return { page: n, x, y: ph - y };
  }
  return null;
}
/** Scroll so PDF point (page, y from top) is at the top of the view (offset px below the top). */
/** The container's scrollTop that shows point y (PDF units) of `page` at `offset` px from the top. */
export function targetForPoint(page, y, offset = 24) {
  if (!viewer || !doc) return null;
  const pv = viewer.getPageView(page - 1);
  if (!pv?.viewport) return null;
  const [, vy] = pv.viewport.convertToViewportPoint(0, (pv.pdfPage?.view?.[3] ?? pv.viewport.viewBox[3]) - y);
  const r = pv.div.getBoundingClientRect(), c = container.getBoundingClientRect();
  return container.scrollTop + r.top - c.top + vy - offset;
}
export const scroller = () => container;
export function scrollToPoint(page, y, offset = 24) {
  if (!viewer || !doc) return;
  const pv = viewer.getPageView(page - 1);
  if (!pv?.viewport) return;
  const ph = pv.pdfPage.view[3];
  const [, vy] = pv.viewport.convertToViewportPoint(0, ph - y);
  const el = pv.div;
  const r = el.getBoundingClientRect(), c = container.getBoundingClientRect();
  container.scrollTop += r.top - c.top + vy - offset;
}
let userScroll = null;
export function onUserScroll(cb) { userScroll = cb; }

/** The "Compile to see the PDF" hint shows exactly when no document is loaded. */
function syncEmpty() {
  const e = document.getElementById("pdf-empty");
  if (e) e.hidden = !!doc;
}

export function clearPdf() {
  if (!viewer) return;
  queueMicrotask(syncEmpty);
  loadSeq++;
  viewer.setDocument(null);
  linkService.setDocument(null, null);
  if (loadingTask) loadingTask.destroy().catch(() => {});
  loadingTask = null;
  doc = null;
  syncEmpty();
}

export const hasPdf = () => !!doc;

// ---------- editing (text boxes, drawing, highlights, images, notes, form filling) ----------
export const EDIT = pdfjsLib.AnnotationEditorType;
const P = pdfjsLib.AnnotationEditorParamsType;
let onModified = () => {}, onBoxSelect = () => {}, boxesDirty = false, editGen = 0;
let uiManager = null;
export function onTextBoxSelect(cb) { onBoxSelect = cb; }
export const textBoxes = tb;
function hasQuireMarks(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const pat = [40, 113, 117, 105, 114, 101, 45]; // "(quire-"
  outer: for (let i = 0; i < b.length - pat.length; i++) {
    if (b[i] !== 40) continue;
    for (let k = 1; k < pat.length; k++) if (b[i + k] !== pat[k]) continue outer;
    return true;
  }
  return false;
}
export function onPdfModified(cb) { onModified = cb; }
function watchStorage() {
  if (!doc) return;
  const st = doc.annotationStorage;
  st.onSetModified = () => { editGen++; onModified(true); };
  st.onResetModified = () => { if (!boxesDirty) onModified(false); };
}
/** Pick a tool: "none" (select/move), "text", "draw", "highlight", "image", "note". */
export async function setEditTool(tool) {
  if (!viewer || !doc) return;
  // text boxes and notes are Callio's own (any font); the rest are pdf.js editors
  const mode = { draw: EDIT.INK, highlight: EDIT.HIGHLIGHT, image: EDIT.STAMP }[tool] ?? EDIT.NONE;
  tb.setTool(tool);
  try { viewer.annotationEditorMode = { mode }; } catch (e) { console.warn(e); return; }
  if (tool === "image") {
    // opens the file picker and drops the picture on the current page
    await new Promise((r) => setTimeout(r, 60));
    eventBus.dispatch("switchannotationeditorparams", { source: null, type: P.CREATE, value: null });
  }
}
export function editParam(kind, value) {
  if (!eventBus) return;
  const type = { "text-color": P.FREETEXT_COLOR, "text-size": P.FREETEXT_SIZE, "ink-color": P.INK_COLOR, "ink-thickness": P.INK_THICKNESS, "highlight-color": P.HIGHLIGHT_COLOR }[kind];
  if (type) eventBus.dispatch("switchannotationeditorparams", { source: null, type, value });
}
export function onEditMode(cb) { eventBus?.on("annotationeditormodechanged", (e) => cb(e.mode)); }
export const isPdfModified = () => !!doc && (doc.annotationStorage.size > 0 || boxesDirty);
/** Paste a picture from the clipboard onto the current page. */
export async function pasteImage(file) {
  if (!viewer || !doc || !file) return false;
  tb.setTool(null);
  if (viewer.annotationEditorMode !== EDIT.STAMP) {
    viewer.annotationEditorMode = { mode: EDIT.STAMP };
    await new Promise((r) => setTimeout(r, 80));
  }
  eventBus.dispatch("switchannotationeditorparams", { source: null, type: P.CREATE, value: { bitmapFile: file } });
  return true;
}
/** The PDF with the edits written in (pdf.js saves them as standard annotations). */
/** Returns { bytes, clean }: clean = nothing changed while saving (else the tab stays unsaved). */
export async function saveEditedPdf({ commit = true } = {}) {
  if (!doc) throw new Error("No PDF");
  if (commit) {
    viewer.annotationEditorMode = { mode: EDIT.NONE }; // commit the box being typed in
    await new Promise((r) => setTimeout(r, 30));
  }
  const gen = editGen;
  let bytes = doc.annotationStorage.size ? await doc.saveDocument() : await doc.getData();
  bytes = await tb.writeBoxes(bytes);
  const clean = gen === editGen;
  if (clean) { boxesDirty = false; doc.annotationStorage.resetModified(); }
  return { bytes, clean };
}
export const pageCount = () => (doc ? doc.numPages : 0);
export function setZoom(v) { if (viewer && doc) viewer.currentScaleValue = v; }
export function zoomBy(f) { if (viewer && doc) viewer.currentScale = Math.min(6, Math.max(0.2, viewer.currentScale * f)); }
export const currentScalePct = () => (viewer && doc ? Math.round(viewer.currentScale * 100) : 100);

// ---------- layouts ----------
export const LAYOUTS = {
  continuous: { scroll: ScrollMode.VERTICAL, spread: SpreadMode.NONE, label: "Single page, continuous" },
  "two-page": { scroll: ScrollMode.VERTICAL, spread: SpreadMode.ODD, label: "Two pages side by side" },
  "two-page-cover": { scroll: ScrollMode.VERTICAL, spread: SpreadMode.EVEN, label: "Two pages, cover separate" },
  wrapped: { scroll: ScrollMode.WRAPPED, spread: SpreadMode.NONE, label: "Grid (wrapped)" },
  horizontal: { scroll: ScrollMode.HORIZONTAL, spread: SpreadMode.NONE, label: "Horizontal" },
  "single-page": { scroll: ScrollMode.PAGE, spread: SpreadMode.NONE, label: "One page at a time" },
};
// "auto": single page while a page fills the width; two pages side by side once two fit;
// a grid once three fit (zooming out with Ctrl+wheel / pinch flips between them).
let layout = "auto", autoApplied = null, autoT = 0;
export function autoLayoutFor(pageW, avail) {
  const n = Math.floor((avail + 8) / (pageW + 8));
  return n >= 3 ? "wrapped" : n >= 2 ? "two-page" : "continuous";
}
function autoLayout() {
  if (layout !== "auto" || !pagesReady()) return;
  const pv = viewer.getPageView(Math.max(0, viewer.currentPageNumber - 1));
  if (!pv?.viewport) return;
  const want = autoLayoutFor(pv.viewport.width, container.clientWidth - 24);
  if (want === autoApplied) return;
  autoApplied = want;
  const page = viewer.currentPageNumber;
  if (!viewer.getPageView(page - 1)) return;
  viewer.scrollMode = LAYOUTS[want].scroll;
  viewer.spreadMode = LAYOUTS[want].spread;
  if (page <= viewer.pagesCount) viewer.currentPageNumber = page;
}
function scheduleAuto() { clearTimeout(autoT); autoT = setTimeout(autoLayout, 280); }
const pagesReady = () => !!viewer && !!doc && viewer.pagesCount > 0 && !!viewer.getPageView(0);
export function setLayout(name) {
  layout = name === "auto" || LAYOUTS[name] ? name : "auto";
  if (!viewer || (doc && !pagesReady())) return;
  if (layout === "auto") {
    // fitted zooms always fill the width: start from one page and adapt from there
    autoApplied = null;
    viewer.scrollMode = ScrollMode.VERTICAL;
    viewer.spreadMode = SpreadMode.NONE;
    autoApplied = "continuous";
    scheduleAuto();
    return;
  }
  autoApplied = null;
  const l = LAYOUTS[layout];
  viewer.scrollMode = l.scroll;
  viewer.spreadMode = l.spread;
  // keep "fit" zooms meaningful for the new layout
  const v = viewer.currentScaleValue;
  if (doc && typeof v === "string" && isNaN(+v)) {
    // re-apply "fit width/page" so it accounts for two pages side by side
    requestAnimationFrame(() => { viewer.currentScaleValue = "auto"; viewer.currentScaleValue = v; });
  }
}

// ---------- page thumbnails ----------
let thumbBox = null, thumbObserver = null, thumbDoc = null;
function markThumb(n) {
  if (!thumbBox) return;
  for (const el of thumbBox.querySelectorAll(".thumb.current")) el.classList.remove("current");
  const t = thumbBox.querySelector(`.thumb[data-page="${n}"]`);
  if (t) { t.classList.add("current"); t.scrollIntoView({ block: "nearest" }); }
}
/** Fill `box` with lazily rendered page thumbnails. */
export async function renderThumbnails(box) {
  thumbBox = box;
  if (!doc) { box.innerHTML = ""; return; }
  if (thumbDoc === doc && box.childElementCount) return markThumb(viewer.currentPageNumber);
  thumbDoc = doc;
  thumbObserver?.disconnect();
  box.innerHTML = "";
  const first = await doc.getPage(1);
  const vp1 = first.getViewport({ scale: 1 });
  const w = 118, h = Math.round((vp1.height / vp1.width) * w);
  const myDoc = doc;
  thumbObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting || en.target.dataset.done) continue;
      en.target.dataset.done = "1";
      thumbObserver.unobserve(en.target);
      const n = +en.target.dataset.page;
      myDoc.getPage(n).then((page) => {
        if (myDoc !== doc) return;
        const vp = page.getViewport({ scale: w / page.getViewport({ scale: 1 }).width });
        const c = document.createElement("canvas");
        const dpr = window.devicePixelRatio || 1;
        c.width = Math.round(vp.width * dpr); c.height = Math.round(vp.height * dpr);
        c.style.width = vp.width + "px"; c.style.height = vp.height + "px";
        en.target.querySelector(".thumb-img").replaceChildren(c);
        page.render({ canvas: c, canvasContext: c.getContext("2d"), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise.catch(() => {});
      });
    }
  }, { root: box, rootMargin: "300px" });
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= doc.numPages; n++) {
    const el = document.createElement("div");
    el.className = "thumb";
    el.dataset.page = n;
    el.innerHTML = `<div class="thumb-img" style="width:${w}px;height:${h}px"></div><span>${n}</span>`;
    el.onclick = () => goToPage(n);
    frag.appendChild(el);
    thumbObserver.observe(el);
  }
  box.appendChild(frag);
  markThumb(viewer.currentPageNumber);
}
export function goToPage(n) { if (viewer && doc) viewer.currentPageNumber = Math.max(1, Math.min(n, viewer.pagesCount)); }

// ---------- find ----------
let lastQuery = "";
export function find(query, previous = false) {
  if (!doc) return;
  const again = query === lastQuery;
  lastQuery = query;
  eventBus.dispatch("find", {
    source: null, type: again ? "again" : "", query, caseSensitive: false, entireWord: false,
    highlightAll: true, findPrevious: previous, matchDiacritics: false,
  });
}
export function closeFind() {
  lastQuery = "";
  eventBus?.dispatch("findbarclose", { source: null });
}

// ---------- outline (bookmarks) ----------
export async function getOutline() {
  if (!doc) return [];
  const raw = (await doc.getOutline().catch(() => null)) || [];
  const out = [];
  const walk = (items, level) => {
    for (const it of items) {
      out.push({ title: it.title, level, dest: it.dest, url: it.url });
      if (it.items?.length && level < 4) walk(it.items, level + 1);
    }
  };
  walk(raw, 0);
  return out;
}
export function goToDest(dest) { if (dest) linkService.goToDestination(dest); }

/** Scroll to a SyncTeX location (page, y in PDF points from the top) and flash a marker. */
export function showLocation(page, y, h = 12) {
  if (!viewer || !doc) return;
  const pv = viewer.getPageView(page - 1);
  if (!pv) return;
  const [, , , ph] = pv.pdfPage.view;
  const [, vy] = pv.viewport.convertToViewportPoint(0, ph - y); // y = top of the box
  const pageEl = pv.div;
  const top = pageEl.offsetTop + vy - container.clientHeight / 3;
  container.scrollTo({ top, behavior: "smooth" });
  const mark = document.createElement("div");
  mark.className = "sync-marker";
  mark.style.top = vy - 4 + "px";
  mark.style.height = Math.max(16, h * pv.viewport.scale + 8) + "px";
  pageEl.appendChild(mark);
  setTimeout(() => mark.remove(), 1700);
}

/**
 * Text of a PDF, page by page (for the AI and the paper library). Runs in PDF.js's worker,
 * independent of the viewer. Returns { pages: [string], info: {Title, Author, …}, numPages }.
 */
export async function extractText(bytes, { maxPages = 2000 } = {}) {
  const task = pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false });
  const d = await task.promise;
  try {
    const pages = [];
    let title = "";
    const n = Math.min(d.numPages, maxPages);
    for (let i = 1; i <= n; i++) {
      const p = await d.getPage(i);
      const tc = await p.getTextContent();
      if (i === 1) {
        // the title: the largest text in the top part of page 1
        const ph = p.view[3];
        const items = tc.items.filter((it) => "str" in it && it.str.trim() && (it.transform?.[5] ?? 0) > ph * 0.45);
        const size = (it) => Math.abs(it.transform?.[3] || it.height || 0);
        const max = Math.max(0, ...items.filter((it) => it.str.trim().length > 2).map(size));
        if (max > 0) title = items.filter((it) => size(it) >= max * 0.92).map((it) => it.str).join(" ").replace(/\s+/g, " ").trim();
      }
      let out = "", lastY = null;
      for (const it of tc.items) {
        if (!("str" in it)) continue;
        const y = it.transform?.[5];
        if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) out += "\n";
        else if (out && !out.endsWith(" ") && !out.endsWith("-") && it.str && !it.str.startsWith(" ")) out += " ";
        out += it.str;
        if (it.hasEOL) out += "\n";
        lastY = y ?? lastY;
      }
      pages.push(out.replace(/-\n(?=[a-z])/g, "").replace(/[ \t]+\n/g, "\n"));
      p.cleanup();
    }
    let info = {};
    try { info = (await d.getMetadata())?.info || {}; } catch {}
    return { pages, info, numPages: d.numPages, title };
  } finally { task.destroy(); }
}

/** One page as a PNG (base64), about 1600 px wide — for the AI to look at figures and tables. */
export async function renderPagePng(bytes, pageNo) {
  const task = pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false });
  const d = await task.promise;
  try {
    const n = Math.max(1, Math.min(d.numPages, pageNo | 0));
    const page = await d.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(3, 1600 / base.width) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    const data = canvas.toDataURL("image/png").split(",")[1];
    return { data, page: n, pages: d.numPages };
  } finally { task.destroy(); }
}

