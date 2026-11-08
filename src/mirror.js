// Split view + visual editor (Markdown): the preview mirrors the editor's page. Same text
// width and typography, and every block placed at the same height as in the editor, so each
// line sits level with its twin on the other side; scrolling is then a plain 1:1 copy.
// (The preview stays the real Markdown rendering: it only borrows the editor's geometry.)

let on = false, info = null, zoom = 1, raf = 0, ro = null, aligned = null;
/** Called after every re-layout (to put the preview back level with the editor). */
export function onAligned(fn) { aligned = fn; }

const $ = (s) => document.querySelector(s);

/** Turn mirroring on (with the visual editor's layoutInfo getter) or off. */
export function setMirror(getInfo, z = 1) {
  const pv = $("#md-preview");
  if (!getInfo) {
    if (!on) return;
    on = false; info = null;
    pv.classList.remove("mirror");
    pv.style.removeProperty("--mx"); pv.style.removeProperty("--mw"); pv.style.removeProperty("--page-l"); pv.style.removeProperty("--page-r");
    pv.style.paddingTop = pv.style.paddingBottom = "";
    for (const k of pv.children) k.style.removeProperty("margin-top");
    ro?.disconnect();
    return;
  }
  info = getInfo; zoom = z || 1;
  if (!on) {
    on = true;
    pv.classList.add("mirror");
    ro ??= new ResizeObserver(() => schedule());
    ro.observe(pv);
    try { ro.observe(info().scroller); ro.observe(info().doc); } catch {}
    // pictures change heights when they arrive
    pv.addEventListener("load", schedule, true);
    try { info().scroller.addEventListener("load", schedule, true); } catch {}
  }
  schedule();
}
export const mirroring = () => on;
export function setZoom(z) { zoom = z || 1; schedule(); }

export function schedule() {
  if (!on) return;
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(align);
}

/** Preview scrollTop for the editor's scrollTop, and back. */
export const toPreview = (vTop) => vTop * zoom;
export const toEditor = (pTop) => pTop / zoom;

function align() {
  if (!on || !info) return;
  const pv = $("#md-preview");
  if (pv.hidden) return;
  let li;
  try { li = info(); } catch { return; }
  const vs = li.scroller, vr = vs.getBoundingClientRect();
  if (!vr.width) return;
  const dr = li.doc.getBoundingClientRect(), pr = li.page.getBoundingClientRect();
  const docTop = dr.top - vr.top + vs.scrollTop;
  const docW = dr.width;
  // the same text width (in CSS px; the preview's zoom scales it), centred like the page
  const z = zoom;
  const mx = Math.max(6, (pv.clientWidth - docW * z) / 2);
  pv.style.setProperty("--mw", docW + "px");
  pv.style.setProperty("--mx", mx + "px");
  pv.style.setProperty("--page-l", Math.max(0, mx - (dr.left - pr.left) * z) + "px");
  pv.style.setProperty("--page-r", Math.max(0, mx - (pr.right - dr.right) * z) + "px");
  // level on screen too: the editor's page starts below its ribbon
  const shift = vr.top - pv.getBoundingClientRect().top;
  pv.style.paddingTop = Math.max(0, docTop * z + shift) + "px";
  // where each source line's block starts in the editor (relative to the text's top)
  const vb = li.blocks.filter((b) => b.el && b.line != null).map((b) => ({ line: Math.round(b.line), top: b.el.getBoundingClientRect().top - dr.top }));
  const idxOf = new Map();
  vb.forEach((b, i) => { if (!idxOf.has(b.line)) idxOf.set(b.line, i); });
  // one read pass (heights), one write pass (gaps)
  const kids = [...pv.children];
  for (const k of kids) k.style.setProperty("margin-top", "0px", "important");
  const hs = kids.map((k) => k.getBoundingClientRect().height / z);
  const lineOf = (k) => { const l = +(k.dataset.line || k.querySelector("[data-line]")?.dataset.line); return Number.isFinite(l) && l > 0 ? l : null; };
  const lines = kids.map(lineOf);
  let bottom = 0, vi = -1;
  kids.forEach((k, i) => {
    let j = lines[i] != null ? idxOf.get(lines[i]) : undefined;
    if (j === undefined && lines[i] == null) {
      // no line (e.g. a display equation): the editor's next block, if it fits before the next known line
      const nextLine = lines.slice(i + 1).find((x) => x != null);
      const c = vb[vi + 1];
      if (c && (nextLine == null || c.line < nextLine)) j = vi + 1;
    }
    const want = j !== undefined ? vb[j].top : null;
    if (j !== undefined) vi = j;
    const gap = want != null ? Math.max(0, want - bottom) : i ? 12 : 0;
    k.style.setProperty("margin-top", gap + "px", "important");
    bottom += gap + hs[i];
  });
  // as tall as the editor, so both can scroll to the very end together
  const vTotal = vs.scrollHeight - vs.clientHeight;
  const pBase = Math.max(0, docTop * z + shift) + bottom * z;
  pv.style.paddingBottom = Math.max(24, vTotal * z + pv.clientHeight - pBase) + "px";
  aligned?.(li);
}
