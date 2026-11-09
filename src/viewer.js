// Picture preview: pictures open in a light viewer first (fit, zoom, pan, rotate the view, the
// next / previous picture in the folder). The photo editor starts only when "Edit" is switched
// on. Formats the browser can't show (camera raw, HEIC, TIFF, PSD, JPEG XL) are rendered once
// by the picture engine.
import { api, call, fileSrc } from "./api.js";
import { ic } from "./icons.js";
import { status, basename, dirname } from "./main.js";
import { loading } from "./loading.js";

const NATIVE = /\.(jpe?g|jpe|jfif|png|gif|webp|avif|bmp|svg|ico|cur)$/i;
let host = null, V = null;
const $ = (s) => host.querySelector(s);

export function previewHost() {
  if (host) return host;
  host = document.createElement("div");
  host.id = "preview-view";
  host.hidden = true;
  host.innerHTML = `
    <div class="pv-bar">
      <button class="icon small pv-prev" title="Previous picture in the folder (←)">${ic("arrow-left")}</button>
      <button class="icon small pv-next" title="Next picture in the folder (→)">${ic("arrow-right")}</button>
      <span class="pv-name"></span><span class="pv-meta note"></span>
      <span class="tb-spacer"></span>
      <button class="icon small pv-rot" title="Rotate the view (R) — the file isn't changed">${ic("rotate-cw")}</button>
      <button class="icon small pv-zo" title="Zoom out (−)">${ic("zoom-out")}</button>
      <button class="small pv-zoom" title="Fit / 100% (Z or double-click)">Fit</button>
      <button class="icon small pv-zi" title="Zoom in (+)">${ic("zoom")}</button>
      <label class="switch pv-edit" title="Edit the picture (crop, light, colour, retouch…)"><span>Edit</span><input type="checkbox"><span class="knob"></span></label>
    </div>
    <div class="pv-stage" tabindex="0"><div class="pv-sizer"><img class="pv-img" alt="" draggable="false"></div><div class="pv-msg" hidden></div></div>`;
  const stage = $(".pv-stage");
  $(".pv-zi").onclick = () => zoomBy(1.25);
  $(".pv-zo").onclick = () => zoomBy(0.8);
  $(".pv-zoom").onclick = () => setZoom(V?.zoom ? 0 : 1);
  $(".pv-rot").onclick = () => { if (!V) return; V.rot = (V.rot + 90) % 360; layout(); };
  $(".pv-prev").onclick = () => sibling(-1);
  $(".pv-next").onclick = () => sibling(1);
  $(".pv-edit input").onchange = (e) => { if (V && e.target.checked) V.onEdit?.(V.t); };
  stage.addEventListener("wheel", (e) => { if (!V) return; if (e.ctrlKey || V.zoom) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e); } }, { passive: false });
  stage.ondblclick = (e) => setZoom(V?.zoom ? 0 : 1, e);
  let drag = null;
  stage.onpointerdown = (e) => { if (!V?.zoom || e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, l: stage.scrollLeft, t: stage.scrollTop }; stage.setPointerCapture(e.pointerId); stage.classList.add("panning"); };
  stage.onpointermove = (e) => { if (!drag) return; stage.scrollLeft = drag.l - (e.clientX - drag.x); stage.scrollTop = drag.t - (e.clientY - drag.y); };
  stage.onpointerup = () => { drag = null; stage.classList.remove("panning"); };
  stage.onkeydown = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); sibling(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); sibling(1); }
    else if (e.key === "+" || e.key === "=") zoomBy(1.25);
    else if (e.key === "-") zoomBy(0.8);
    else if (e.key === "z" || e.key === "Z" || e.key === "0") setZoom(V?.zoom ? 0 : 1);
    else if (e.key === "r" || e.key === "R") $(".pv-rot").click();
    else if (e.key === "e" || e.key === "E") { $(".pv-edit input").checked = true; V?.onEdit?.(V.t); }
  };
  new ResizeObserver(() => V && layout()).observe(stage);
  return host;
}

/** Show `t` (an image tab). onEdit(t) switches to the editor; onOpen(path) opens another picture. */
export async function showPreview(t, { onEdit, onOpen }) {
  previewHost();
  host.hidden = false;
  if (V?.t === t) { layout(); return; }
  V = { t, zoom: 0, rot: 0, w: 0, h: 0, onEdit, onOpen };
  $(".pv-name").textContent = t.name;
  $(".pv-meta").textContent = "";
  $(".pv-edit input").checked = false;
  const img = $(".pv-img");
  const msg = $(".pv-msg");
  msg.hidden = true;
  img.style.opacity = "0";
  const ld = loading(`Opening ${t.name}…`, { delay: 300 });
  try {
    let src;
    if (NATIVE.test(t.path) && !t.dirty) src = fileSrc(t.path.replace(/\\/g, "/"));
    else {
      // camera raw, HEIC, TIFF, PSD, JPEG XL: one render by the picture engine
      ld.text(`Opening ${t.name}…`, "Reading the picture");
      const { office } = await import("./office.js");
      if (!t.imageId) {
        const r = await office("image.open", { path: t.path });
        t.imageId = r.id; t.imageState = r.state; t.imageInfo = r.info;
      }
      const stage = $(".pv-stage").getBoundingClientRect();
      const dpr = devicePixelRatio || 1;
      const r = await office("image.render", { id: t.imageId, w: Math.round(Math.max(800, stage.width) * dpr), h: Math.round(Math.max(600, stage.height) * dpr), draft: false });
      src = `data:image/jpeg;base64,${r.jpeg}`;
    }
    if (V?.t !== t) return;
    img.src = src;
    await img.decode();
    if (V?.t !== t) return;
    V.w = img.naturalWidth; V.h = img.naturalHeight;
    const info = await call("path_info", { path: t.path }).catch(() => null);
    const p = t.imageInfo?.photo || {};
    const W = p.width || p.w || V.w, H = p.height || p.h || V.h;
    $(".pv-meta").textContent = [`${W} × ${H}`, info?.size ? fmtSize(info.size) : ""].filter(Boolean).join(" · ");
    layout();
    img.style.opacity = "";
    img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
    $(".pv-stage").focus({ preventScroll: true });
  } catch (e) {
    if (V?.t !== t) return;
    msg.hidden = false;
    msg.textContent = `Couldn't show ${t.name}: ${e.message || e}`;
    status(`Couldn't open ${t.name}: ${e.message || e}`, "err");
  } finally { ld.done(); }
}
export function hidePreview() { if (host) host.hidden = true; V = null; }
export function forgetPreview(t) { if (V?.t === t) hidePreview(); }

const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function layout() {
  if (!V || !V.w) return;
  const stage = $(".pv-stage"), sizer = $(".pv-sizer"), img = $(".pv-img");
  const rot = V.rot % 180 !== 0;
  const iw = rot ? V.h : V.w, ih = rot ? V.w : V.h;
  const sw = stage.clientWidth - 32, sh = stage.clientHeight - 32;
  const fit = Math.min(1, sw / iw, sh / ih);
  const z = V.zoom || fit;
  const w = Math.round(iw * z), h = Math.round(ih * z);
  sizer.style.width = w + "px"; sizer.style.height = h + "px";
  img.style.width = Math.round(V.w * z) + "px"; img.style.height = Math.round(V.h * z) + "px";
  img.style.transform = `translate(-50%, -50%) rotate(${V.rot}deg)`;
  $(".pv-zoom").textContent = V.zoom ? `${Math.round(V.zoom * 100)}%` : "Fit";
  stage.classList.toggle("zoomed", !!V.zoom && (w > sw + 32 || h > sh + 32));
}
function fitScale() {
  const stage = $(".pv-stage");
  const rot = V.rot % 180 !== 0;
  return Math.min(1, (stage.clientWidth - 32) / (rot ? V.h : V.w), (stage.clientHeight - 32) / (rot ? V.w : V.h));
}
function setZoom(z, e) {
  if (!V) return;
  const stage = $(".pv-stage");
  const before = V.zoom || fitScale();
  const r = stage.getBoundingClientRect();
  const ax = e ? e.clientX - r.left : stage.clientWidth / 2, ay = e ? e.clientY - r.top : stage.clientHeight / 2;
  const px = (stage.scrollLeft + ax) / before, py = (stage.scrollTop + ay) / before;
  V.zoom = z && Math.abs(z - fitScale()) > 0.001 ? Math.max(0.05, Math.min(16, z)) : 0;
  layout();
  const after = V.zoom || fitScale();
  stage.scrollLeft = px * after - ax;
  stage.scrollTop = py * after - ay;
}
function zoomBy(f, e) { if (V) setZoom((V.zoom || fitScale()) * f, e); }

async function sibling(dir) {
  if (!V?.t?.path) return;
  const d = dirname(V.t.path);
  let items = [];
  try { items = await api.listDir(d); } catch { return; }
  const pics = items.filter((x) => !x.isDir && /\.(jpe?g|jpe|jfif|png|gif|webp|avif|bmp|svg|ico|tiff?|heic|heif|jxl|psd|dng|cr2|cr3|nef|arw|raf|orf|rw2)$/i.test(x.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const i = pics.findIndex((x) => basename(x.path) === basename(V.t.path));
  const next = pics[(i + dir + pics.length) % pics.length];
  if (next && next.path !== V.t.path) V.onOpen?.(next.path);
}
