// Pictures and photos (JPEG, PNG, TIFF, WebP, AVIF, HEIC, raw camera files…) edited with
// The picture engine (in the office engine): a ribbon of commands, the adjustment panels on the right
// (every slider, with the histogram), and the picture in the middle — zoom, pan, crop,
// white balance picker, healing, red eye and masks are drawn on it. Edits stay adjustable until
// the picture is saved. Renders are made in the engine and shown as they arrive: while a slider
// moves, quick drafts at screen size; when it stops, the full-quality picture.
import { api, call } from "./api.js";
import { toast, status, ask, basename, dirname } from "./main.js";
import { office } from "./office.js";
import { registerUndo } from "./undo.js";
import { enter, setImage } from "./motion.js";
import { Ribbon, tellBox } from "./ribbon.js";
import { ic } from "./icons.js";

const $ = (s, el = host) => el.querySelector(s);
const $$ = (s, el = host) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const DPR = () => Math.min(2, window.devicePixelRatio || 1);
const WRITES = { jpg: "jpeg", jpeg: "jpeg", jpe: "jpeg", jfif: "jpeg", png: "png", tif: "tiff", tiff: "tiff", webp: "webp", avif: "avif", jxl: "jxl", psd: "psd" };
let host = null;
let I = null; // { t, id, state, info, geo, zoom (0 = fit, else CSS px per picture px), tool, before }

// ------------------------------------------------------------------ icons (stroke SVG)
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const IC = {
  auto: svg('<path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>'),
  bw: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>'),
  wb: svg('<path d="M14 4l6 6-9 9H5v-6z"/><path d="M12 6l6 6"/>'),
  temp: svg('<path d="M12 3a2 2 0 0 0-2 2v9.5a4 4 0 1 0 4 0V5a2 2 0 0 0-2-2z"/>'),
  rotl: svg('<path d="M4 9a8 8 0 1 1 1.5 8"/><path d="M4 4v5h5"/>'),
  rotr: svg('<path d="M20 9a8 8 0 1 0-1.5 8"/><path d="M20 4v5h-5"/>'),
  fliph: svg('<path d="M12 3v18"/><path d="M8 7L3 12l5 5z"/><path d="M16 7l5 5-5 5z"/>'),
  flipv: svg('<path d="M3 12h18"/><path d="M7 8l5-5 5 5z"/><path d="M7 16l5 5 5-5z"/>'),
  crop: svg('<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>'),
  level: svg('<path d="M3 17L21 7"/><path d="M3 21h18"/>'),
  upright: svg('<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M12 3v18M5 12h14"/>'),
  aspect: svg('<rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M7 10v4M17 10v4"/>'),
  reset: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  preset: svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  profile: svg('<circle cx="8" cy="9" r="5"/><circle cx="16" cy="9" r="5"/><circle cx="12" cy="15" r="5"/>'),
  before: svg('<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M12 4v16"/><path d="M3 20L12 11"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>'),
  paste: svg('<rect x="5" y="4" width="14" height="17" rx="1.5"/><path d="M9 4V3h6v1"/><path d="M9 11h6M9 15h6"/>'),
  heal: svg('<rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-45 12 12)"/><path d="M10.5 10.5h.01M13.5 13.5h.01M10.5 13.5h.01M13.5 10.5h.01"/>'),
  clone: svg('<circle cx="8" cy="8" r="4.5"/><circle cx="16" cy="16" r="4.5"/><path d="M11 11l2 2"/>'),
  fill: svg('<path d="M12 3l7 7-7 7-7-7z"/><path d="M19 15c0 2 1.5 3 1.5 4.5a1.5 1.5 0 0 1-3 0C17.5 18 19 17 19 15z"/>'),
  dust: svg('<circle cx="7" cy="8" r="1.5"/><circle cx="15" cy="6" r="1"/><circle cx="17" cy="14" r="2"/><circle cx="9" cy="16" r="1.2"/><path d="M3 21l4-4"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3" fill="currentColor"/>'),
  brush: svg('<path d="M14 4l6 6-8 8-6-6z"/><path d="M6 12c-2 1-3 3-3 6 3 0 5-1 6-3"/>'),
  linear: svg('<rect x="3" y="3" width="18" height="18" rx="1.5"/><path d="M3 9h18M3 15h18" stroke-dasharray="2 2"/><path d="M12 6v12"/>'),
  radial: svg('<ellipse cx="12" cy="12" rx="9" ry="6.5"/><ellipse cx="12" cy="12" rx="4.5" ry="3" stroke-dasharray="2 2"/>'),
  lum: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>'),
  color: svg('<path d="M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z"/>'),
  sky: svg('<path d="M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z"/>'),
  person: svg('<circle cx="12" cy="7" r="4"/><path d="M4 21c0-4 3.5-7 8-7s8 3 8 7"/>'),
  invert: svg('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  dup: svg('<rect x="8" y="8" width="12" height="12" rx="1.5"/><rect x="4" y="4" width="12" height="12" rx="1.5"/>'),
  zoomin: svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M8 11h6M11 8v6"/>'),
  zoomout: svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M8 11h6"/>'),
  fit: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  one: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M10 9l2-1.5V17"/>'),
  save: svg('<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>'),
  export: svg('<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 14v6h14v-6"/>'),
  hdr: svg('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10v4M10 10v4M7 12h3M13 10v4h1.5a2 2 0 0 0 0-4zM18 14v-4h1.5a1 1 0 0 1 0 2H18"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>'),
  mask: svg('<circle cx="12" cy="12" r="9"/><path d="M12 3v18" stroke-dasharray="2 2"/><path d="M12 3a9 9 0 0 1 0 18" fill="currentColor" opacity=".35"/>'),
  denoise: svg('<path d="M4 12h2M8 9v6M12 6v12M16 9v6M20 12h-2"/>'),
  curve: svg('<path d="M3 21C9 21 9 3 21 3"/><path d="M3 3v18h18"/>'),
};

// ------------------------------------------------------------------ host
export function imageHost() {
  if (host) return host;
  host = document.createElement("div");
  host.id = "image-view";
  host.hidden = true;
  host.innerHTML = `
    <div class="im-rb"></div>
    <div class="im-main">
      <div class="im-stage" tabindex="0">
        <div class="im-sizer">
          <img class="im-base" alt="" draggable="false">
          <img class="im-win" alt="" draggable="false" hidden>
          <canvas class="im-ov"></canvas>
        </div>
        <div class="im-busy" hidden><span class="spin small"></span></div>
        <div class="im-tool-hint" hidden></div>
      </div>
      <aside class="im-panel">
        <div class="im-hist-box"><canvas class="im-hist" width="256" height="96"></canvas><div class="im-hist-info"></div></div>
        <div class="im-masks" hidden></div>
        <div class="im-sections"></div>
      </aside>
    </div>
    <div class="im-status">
      <span class="im-st-size"></span><span class="im-st-pick"></span><span class="tb-spacer"></span>
      <button class="small im-before-btn" title="Show the picture without the edits (\\)">${ic("contrast")}<span>Before</span></button>
      <button class="icon small im-zo" title="Zoom out (Ctrl+−)">${ic("minus")}</button><button class="small im-zoom" title="Fit / 100% (Z)">Fit</button><button class="icon small im-zi" title="Zoom in (Ctrl++)">${ic("plus")}</button>
      <button class="small im-panel-btn" title="Show or hide the adjustments">${ic("sliders")}<span>Adjust</span></button>
      <label class="switch im-edit-sw" title="Back to the picture preview (your edits are kept)"><span>Edit</span><input type="checkbox" checked><span class="knob"></span></label>
    </div>`;
  wire();
  host.querySelector(".im-edit-sw input").onchange = (e) => { if (!e.target.checked) { e.target.checked = true; window.dispatchEvent(new CustomEvent("callio-image-preview")); } };
  return host;
}

// ------------------------------------------------------------------ engine calls
let busy = Promise.resolve();
/** Engine commands run one after another (renders have their own lane). */
function q(cmd, args = {}) {
  const p = busy.then(() => office(cmd, { id: I?.id, ...args }));
  busy = p.catch(() => {});
  return p;
}
async function run(cmd, params = {}, { quiet = false } = {}) {
  if (!I) return;
  const r = await q("image.run", { cmd, params });
  if (r.error && !quiet) toast(`${labelOf(cmd)}: ${r.error}`, "err", 6000);
  apply(r.state);
  return r.error ? null : r.result ?? true;
}
const labelOf = (id) => I?.cmds?.get(id)?.label || id;

// ------------------------------------------------------------------ open / show
export async function openImage(t) {
  imageHost();
  host.hidden = false;
  if (I && I.t === t) { layout(); return; }
  I = { t, id: t.imageId, state: t.imageState, info: t.imageInfo, zoom: t.imageZoom || 0, tool: null, before: false, geo: null, rendered: null };
  if (!t.imageId) {
    status(`Opening ${t.name}…`);
    $(".im-busy").hidden = false;
    const r = await office("image.open", { path: t.path });
    if (I?.t !== t) return;
    t.imageId = I.id = r.id;
    I.state = t.imageState = r.state;
    I.info = t.imageInfo = r.info;
  } else {
    I.state = await office("image.state", { id: I.id });
  }
  if (!CTL) CTL = await office("image.controls", { id: I.id }).catch(() => null);
  if (!I.cmds) {
    const list = await office("image.commands", { id: I.id }).catch(() => []);
    I.cmds = new Map(list.map((c) => [c.id, c]));
    t.imageCmds = I.cmds;
  }
  buildRibbon();
  buildPanel();
  apply(I.state, true);
  layout();
  status(`${t.name}: ${sizeText()}`, "ok");
  requestAnimationFrame(() => $(".im-stage").focus({ preventScroll: true }));
}
export function hideImage() {
  if (!host) return;
  if (I) { I.t.imageZoom = I.zoom; I.t.imageState = I.state; }
  setTool(null);
  host.hidden = true;
  I = null;
}
export async function closeImage(t) {
  if (t.imageId) office("image.close", { id: t.imageId }).catch(() => {});
  if (I?.t === t) hideImage();
}
const sizeText = () => {
  const p = I?.info?.photo || {};
  const w = p.width || p.w, h = p.height || p.h;
  return w ? `${w} × ${h} px` : "";
};

// ------------------------------------------------------------------ state → screen
let CTL = null; // the slider catalogue
function apply(st, first = false) {
  if (!I || !st) return;
  const old = I.state;
  I.state = st;
  I.t.imageState = st;
  if (I.t.dirty !== st.dirty) { I.t.dirty = st.dirty; window.dispatchEvent(new Event("callio-tab-dirty")); }
  window.dispatchEvent(new Event("callio-undo"));
  updatePanel();
  rb?.update();
  // only crop, rotation, flips, perspective and lens changes move the picture's frame
  const geoKey = (s) => JSON.stringify([s?.crop, s?.orientation, s?.geometry, s?.optics?.distortion, s?.optics?.profile_distortion]);
  const frameChanged = first || !I.geo || geoKey(old?.settings) !== geoKey(st.settings);
  const changed = frameChanged || JSON.stringify(old?.settings) !== JSON.stringify(st.settings);
  if (changed && !frameChanged) { drawOverlay(); requestRender(); }
  else if (changed) {
    const before = I.geo && `${I.geo.nativeW}x${I.geo.nativeH}|${I.geo.crop}`;
    refreshGeo().then(() => {
      if (!I?.geo) return;
      // a new shape (crop, rotation) or the first time: lay out again (which renders)
      if (`${I.geo.nativeW}x${I.geo.nativeH}|${I.geo.crop}` !== before) layout();
      else { drawOverlay(); requestRender(); }
    });
  }
}
/** View ↔ picture coordinates (affine, from three mapped points). */
async function refreshGeo() {
  if (!I) return;
  const crop = I.tool !== "crop";
  const r = await office("image.map", { id: I.id, crop, points: [[0, 0], [1, 0], [0, 1]] }).catch(() => null);
  if (!r || !I) return;
  const [o, ax, ay] = r.points;
  const m = [ax[0] - o[0], ax[1] - o[1], ay[0] - o[0], ay[1] - o[1], o[0], o[1]]; // view (0..1) → image
  const det = m[0] * m[3] - m[1] * m[2] || 1;
  const inv = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
  I.geo = {
    crop, toImg: (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]],
    toView: (X, Y) => { const dx = X - m[4], dy = Y - m[5]; return [inv[0] * dx + inv[2] * dy, inv[1] * dx + inv[3] * dy]; },
    imgW: r.imageW, imgH: r.imageH, aspect: r.viewW / r.viewH, quad: r.crop,
    // pixels of the whole (cropped) picture at 100 %
    nativeW: Math.round(Math.hypot(m[0] * r.imageW, m[1] * r.imageH)), nativeH: Math.round(Math.hypot(m[2] * r.imageW, m[3] * r.imageH)),
  };
}

// ------------------------------------------------------------------ layout, zoom, rendering
/** CSS px per picture px when fitted. */
function fitScale() {
  const st = $(".im-stage"), g = I?.geo;
  if (!g) return 1;
  return Math.min((st.clientWidth - 40) / g.nativeW, (st.clientHeight - 40) / g.nativeH);
}
const scale = () => (I?.zoom ? I.zoom : fitScale());
function layout() {
  if (!I?.geo) return;
  const st = $(".im-stage"), sz = $(".im-sizer"), g = I.geo;
  const s = scale();
  const w = Math.max(1, Math.round(g.nativeW * s)), h = Math.max(1, Math.round(g.nativeH * s));
  sz.style.width = w + "px"; sz.style.height = h + "px";
  // centred when smaller than the stage
  sz.style.marginLeft = Math.max(0, (st.clientWidth - w) / 2) + "px";
  sz.style.marginTop = Math.max(0, (st.clientHeight - h) / 2) + "px";
  st.classList.toggle("zoomed", !!I.zoom && (w > st.clientWidth || h > st.clientHeight));
  const ov = $(".im-ov");
  ov.width = Math.round(w * DPR()); ov.height = Math.round(h * DPR());
  ov.style.width = w + "px"; ov.style.height = h + "px";
  $(".im-zoom").textContent = I.zoom ? `${Math.round(I.zoom * 100)}%` : "Fit";
  drawOverlay();
  requestRender();
}

// One render at a time; the newest request waits for the one running and replaces older ones.
let rendering = false, wanted = null, settleTimer = 0, interacting = false;
function requestRender(draft = interacting) {
  if (!I?.geo) return;
  wanted = { draft };
  clearTimeout(settleTimer);
  if (!rendering) pump();
}
async function pump() {
  if (!wanted || !I) return;
  rendering = true;
  const w = wanted; wanted = null;
  const t = I.t;
  const st = $(".im-stage"), g = I.geo, s = scale(), dpr = DPR();
  const fullW = Math.round(g.nativeW * s * dpr), fullH = Math.round(g.nativeH * s * dpr);
  // the whole picture at most at its fitted size (smaller while dragging); when zoomed in past
  // that, the part on screen is rendered sharp on top of it
  const fit = fitScale();
  const fitLong = Math.max(g.nativeW, g.nativeH) * Math.min(s, fit) * dpr;
  const k = w.draft ? 0.6 : 1;
  const baseLong = Math.max(64, Math.min(fitLong * k, w.draft ? 1400 : 2600));
  const bw = Math.max(16, Math.round(fullW >= fullH ? baseLong : baseLong * fullW / fullH)), bh = Math.max(16, Math.round(fullW >= fullH ? baseLong * fullH / fullW : baseLong));
  // the same full picture as last time (a drag that ended twice, a resize back): nothing to do
  const key = JSON.stringify([I.state?.settings, bw, bh, fullW, fullH, I.before, g.crop, st.scrollLeft, st.scrollTop]);
  if (!w.draft && key === I.lastFull) { rendering = false; if (wanted) pump(); return; }
  const busyT = setTimeout(() => { if (I?.t === t) $(".im-busy").hidden = false; }, 350);
  try {
    if (!w.draft) I.lastFull = key; else I.lastFull = null;
    const r = await office("image.render", { id: I.id, w: bw, h: bh, draft: w.draft, before: I.before, crop: g.crop });
    if (I?.t !== t) return;
    I.rendered = r;
    // while dragging, the next render starts while this one decodes (the newest picture wins)
    const shown = setImage($(".im-base"), `data:image/jpeg;base64,${r.jpeg}`);
    if (w.draft) requestAnimationFrame(() => drawHist(r.hist));
    else { await shown; drawHist(r.hist); }
    const zoomedIn = fullW > bw * 1.15 || fullH > bh * 1.15;
    const win = $(".im-win");
    if (zoomedIn && !w.draft) {
      // the visible part, at full sharpness
      const sz = $(".im-sizer");
      const x0 = Math.max(0, st.scrollLeft - sz.offsetLeft), y0 = Math.max(0, st.scrollTop - sz.offsetTop);
      const vw = Math.min(st.clientWidth, sz.offsetWidth - x0), vh = Math.min(st.clientHeight, sz.offsetHeight - y0);
      const win0 = { x: Math.floor(x0 * dpr), y: Math.floor(y0 * dpr), w: Math.ceil(vw * dpr), h: Math.ceil(vh * dpr) };
      const rr = await office("image.render", { id: I.id, w: fullW, h: fullH, window: win0, before: I.before, crop: g.crop }).catch(() => null);
      if (rr && I?.t === t) {
        await setImage(win, `data:image/jpeg;base64,${rr.jpeg}`);
        Object.assign(win.style, { left: win0.x / dpr + "px", top: win0.y / dpr + "px", width: rr.width / dpr + "px", height: rr.height / dpr + "px" });
        win.hidden = false;
      }
    } else if (!zoomedIn) win.hidden = true;
  } catch (e) {
    if (I) I.lastFull = null;
    if (I?.t === t) status(`Couldn't show the picture: ${e.message}`, "err");
  } finally {
    clearTimeout(busyT);
    if (I?.t === t) $(".im-busy").hidden = true;
    rendering = false;
    if (wanted) pump();
    else if (w.draft && !interacting) requestRender(false);
  }
}

// ------------------------------------------------------------------ histogram
function drawHist(h) {
  const c = $(".im-hist");
  if (!c || !h) return;
  const g = c.getContext("2d");
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const n = h.l.length;
  const max = Math.max(1, ...["r", "g", "b"].flatMap((k) => h[k].slice(2, n - 2)));
  g.globalCompositeOperation = "lighter";
  for (const [k, col] of [["r", "rgba(230,70,70,.75)"], ["g", "rgba(70,200,90,.75)"], ["b", "rgba(80,130,240,.75)"]]) {
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(0, H);
    h[k].forEach((v, i) => g.lineTo((i / (n - 1)) * W, H - Math.min(1, v / max) * (H - 4)));
    g.lineTo(W, H);
    g.fill();
  }
  g.globalCompositeOperation = "source-over";
  // clipping warnings
  const clipLo = (h.l[0] || 0) / Math.max(1, h.l.reduce((a, b) => a + b, 0)), clipHi = (h.l[n - 1] || 0) / Math.max(1, h.l.reduce((a, b) => a + b, 0));
  $(".im-hist-info").innerHTML = `${clipLo > 0.002 ? `<span class="clip lo" title="Shadows clipped">▲ ${(clipLo * 100).toFixed(1)}%</span>` : ""}${clipHi > 0.002 ? `<span class="clip hi" title="Highlights clipped">▲ ${(clipHi * 100).toFixed(1)}%</span>` : ""}<span class="exif">${esc(exifLine())}</span>`;
}
function exifLine() {
  const p = I?.info?.photo || {};
  const e = p.exif || p;
  const parts = [];
  if (e.iso || e.ISO) parts.push(`ISO ${e.iso || e.ISO}`);
  if (e.focalLength || e.focal) parts.push(`${Math.round(e.focalLength || e.focal)} mm`);
  if (e.aperture || e.fNumber) parts.push(`ƒ/${e.aperture || e.fNumber}`);
  if (e.shutter || e.exposureTime) parts.push(`${e.shutter || e.exposureTime}`);
  return parts.join("  ") || sizeText();
}

// ------------------------------------------------------------------ adjustment panel
const SECTIONS = [
  ["light", "Light"], ["curve", "Tone Curve"], ["color", "Color"], ["mixer", "Color Mixer"], ["bwMix", "B&W Mixer"], ["grading", "Color Grading"],
  ["effects", "Effects"], ["vignette", "Vignette"], ["grain", "Grain"], ["detail", "Detail"], ["optics", "Optics"], ["geometry", "Geometry"],
  ["profile", "Profile"], ["calibration", "Calibration"],
];
const RESETTABLE = new Set(["profile", "light", "curve", "color", "mixer", "grading", "effects", "vignette", "grain", "detail", "optics", "geometry"]);
const BANDS = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"];
const BAND_COLORS = ["#e0443a", "#f08a2c", "#e8d23c", "#4cbb4c", "#3cc8c8", "#3c6ee8", "#8a4ce0", "#d84ca8"];
function catalogue() {
  const list = Array.isArray(CTL) ? CTL : CTL?.controls || [];
  return list.filter((c) => c.id && !/^\w+\.\d+\./.test(c.id));
}
function trackBg(c) {
  const t = c.track || {};
  const k = t.kind || t;
  if (k === "temp") return "linear-gradient(90deg,#3b78d8,#e8e8e8,#e8c03c)";
  if (k === "tint") return "linear-gradient(90deg,#3cb84c,#e8e8e8,#c84cc0)";
  if (k === "gradient") return `linear-gradient(90deg,${t.from},${t.to})`;
  if (k === "rainbow") return "linear-gradient(90deg,#f33,#ff3,#3f3,#3ff,#33f,#f3f,#f33)";
  if (k === "hue") { const i = t.band ?? 0; return `linear-gradient(90deg,${BAND_COLORS[(i + 7) % 8]},${BAND_COLORS[i]},${BAND_COLORS[(i + 1) % 8]})`; }
  if (k === "sat") return `linear-gradient(90deg,#8a8a8a,${BAND_COLORS[t.band ?? 0]})`;
  if (k === "lum") return `linear-gradient(90deg,#222,${BAND_COLORS[t.band ?? 0]},#fafafa)`;
  return "";
}
const fmt = (c, v) => {
  const d = c.decimals ?? 0;
  const s = Number(v ?? c.default).toFixed(d);
  return v > 0 && c.min < 0 && +s !== 0 ? `+${s}` : s;
};
function sliderHtml(c) {
  const bg = trackBg(c);
  return `<div class="im-sl" data-id="${esc(c.id)}">
    <label title="Double-click to reset">${esc(c.label)}</label>
    <input class="im-val" value="${esc(fmt(c, c.default))}" spellcheck="false" inputmode="decimal">
    <input type="range" min="${c.min}" max="${c.max}" step="${c.step || 1}" value="${c.default}" ${bg ? `style="--track:${bg}" class="painted"` : ""}>
  </div>`;
}
function buildPanel() {
  const box = $(".im-sections");
  if (box.dataset.built) return;
  box.dataset.built = "1";
  const all = catalogue();
  const by = new Map();
  for (const c of all) { const s = c.section || "light"; if (!by.has(s)) by.set(s, []); by.get(s).push(c); }
  const open = new Set(JSON.parse(localStorage.getItem("callio.im.open") || '["light","color","effects"]'));
  let html = "";
  for (const [key, name] of SECTIONS) {
    const list = by.get(key) || [];
    if (!list.length && key !== "curve") continue;
    let body = "";
    if (key === "color") body += `<div class="im-row"><span>White Balance</span><select class="im-wb">${["asShot:As Shot", "auto:Auto", "daylight:Daylight", "cloudy:Cloudy", "shade:Shade", "tungsten:Tungsten", "fluorescent:Fluorescent", "flash:Flash", "custom:Custom"].map((x) => { const [v, l] = x.split(":"); return `<option value="${v}">${l}</option>`; }).join("")}</select><button class="icon small im-wbpick" title="White Balance Selector (W): click something that should be neutral grey">${IC.wb}</button></div>`;
    if (key === "curve") body += `<div class="im-curve-box"><div class="seg im-curve-ch">${["master:RGB", "red:R", "green:G", "blue:B"].map((x, i) => `<button data-ch="${x.split(":")[0]}" class="${i ? "" : "active"}">${x.split(":")[1]}</button>`).join("")}</div><canvas class="im-curve" width="240" height="240"></canvas><div class="note">Click to add a point, drag to move, double-click to remove.</div></div>`;
    if (key === "mixer") {
      body += `<div class="seg im-mix-tabs">${["hue:Hue", "sat:Saturation", "lum:Luminance"].map((x, i) => `<button data-m="${x.split(":")[0]}" class="${i ? "" : "active"}">${x.split(":")[1]}</button>`).join("")}</div>`;
      body += `<div class="im-mix">${list.map((c) => sliderHtml({ ...c, label: c.label.replace(/ (Hue|Saturation|Luminance)$/, "") })).join("")}</div>`;
    } else body += list.map(sliderHtml).join("");
    const resettable = RESETTABLE.has(key);
    html += `<section class="im-sec${open.has(key) ? " open" : ""}" data-sec="${key}">
      <header><span class="im-tw"></span><span class="im-sec-name">${esc(name)}</span><span class="tb-spacer"></span>
        ${resettable ? `<button class="icon small im-sec-reset" title="Reset ${esc(name)}">${IC.reset}</button>` : ""}
        <label class="im-sec-on" title="Show the effect of this panel"><input type="checkbox" checked></label></header>
      <div class="im-sec-body">${body}</div></section>`;
  }
  box.innerHTML = html;
  box.querySelectorAll('.im-mix .im-sl').forEach((el) => { el.hidden = !/\.hue$/.test(el.dataset.id); });
  wireCurve();
}
function updatePanel() {
  if (!I) return;
  const v = I.state.values || {};
  const st = I.state.settings || {};
  for (const el of $$(".im-sl")) {
    if (el === dragEl) continue;
    const id = el.dataset.id, c = CTLMAP().get(id);
    if (!c || !(id in v)) continue;
    const r = el.querySelector("input[type=range]"), t = el.querySelector(".im-val");
    if (+r.value !== v[id]) r.value = v[id];
    if (document.activeElement !== t) t.value = fmt(c, v[id]);
    el.classList.toggle("changed", Math.abs(v[id] - c.default) > 1e-9);
  }
  // sections switched off
  const off = new Set(st.disabled_sections || []);
  for (const sec of $$(".im-sec")) sec.querySelector(".im-sec-on input").checked = !off.has(sec.dataset.sec);
  // white balance mode, B&W mixer only for B&W
  const wb = $(".im-wb");
  if (wb && document.activeElement !== wb) wb.value = st.wb?.mode || "asShot";
  const hdrOn = !!st.hdr?.enabled;
  for (const el of $$('.im-sl[data-id^="hdr."]')) el.hidden = !hdrOn;
  const bw = isBW();
  const bwSec = $('.im-sec[data-sec="bwMix"]'), mix = $('.im-sec[data-sec="mixer"]');
  if (bwSec) bwSec.hidden = !bw;
  if (mix) mix.hidden = bw;
  drawCurve();
  updateMasksPanel();
}
const isBW = () => { const t = I?.state?.settings?.treatment; return t === "bw" || t === "Bw" || t === "BW"; };
let ctlMap = null;
const CTLMAP = () => (ctlMap ||= new Map(catalogue().map((c) => [c.id, c])));

// sliders: one undo step per drag; drafts while it moves, the full picture when it stops
let dragEl = null, pendingVals = null, sending = false;
function setValues(vals) {
  pendingVals = { ...(pendingVals || {}), ...vals };
  if (!sending) flush();
}
async function flush() {
  sending = true;
  while (pendingVals && I) {
    const v = pendingVals; pendingVals = null;
    const r = await q("image.run", { cmd: "develop.set", params: { values: v } });
    if (r.error) toast(r.error, "err", 4000);
    apply(r.state);
  }
  sending = false;
}
async function beginDrag(el) {
  dragEl = el;
  interacting = true;
  const c = CTLMAP().get(el.dataset.id);
  await q("image.run", { cmd: "develop.beginInteraction", params: { label: c?.label || "Adjust" } }).catch(() => {});
}
async function endDrag() {
  if (!dragEl) return;
  dragEl = null;
  interacting = false;
  while (sending || pendingVals) await new Promise((r) => setTimeout(r, 16));
  const r = await q("image.run", { cmd: "develop.endInteraction", params: {} }).catch(() => null);
  if (r) apply(r.state);
  requestRender(false);
}

// ------------------------------------------------------------------ tone curve editor
let curveCh = "master", curveDrag = null;
function curvePoints() {
  const c = I?.state?.settings?.curve || {};
  const pts = c[curveCh]?.length ? c[curveCh] : [[0, 0], [1, 1]];
  return pts.map((p) => (Array.isArray(p) ? [...p] : [p.x, p.y]));
}
function drawCurve() {
  const c = $(".im-curve");
  if (!c || !c.isConnected || c.closest(".im-sec:not(.open)")) return;
  const g = c.getContext("2d"), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  g.strokeStyle = "rgba(128,128,128,.25)"; g.lineWidth = 1;
  for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo((i * W) / 4, 0); g.lineTo((i * W) / 4, H); g.moveTo(0, (i * H) / 4); g.lineTo(W, (i * H) / 4); g.stroke(); }
  g.beginPath(); g.moveTo(0, H); g.lineTo(W, 0); g.strokeStyle = "rgba(128,128,128,.4)"; g.setLineDash([3, 3]); g.stroke(); g.setLineDash([]);
  const pts = curvePoints().slice().sort((a, b) => a[0] - b[0]);
  const col = { master: "#ddd", red: "#e55", green: "#5c5", blue: "#58f" }[curveCh];
  // monotone cubic through the points
  g.strokeStyle = col; g.lineWidth = 2; g.beginPath();
  const f = monotone(pts);
  for (let i = 0; i <= W; i += 2) { const x = i / W, y = Math.max(0, Math.min(1, f(x))); i ? g.lineTo(i, H - y * H) : g.moveTo(i, H - y * H); }
  g.stroke();
  g.fillStyle = col;
  for (const [x, y] of pts) { g.beginPath(); g.arc(x * W, H - y * H, 4.5, 0, Math.PI * 2); g.fill(); }
}
function monotone(p) {
  const n = p.length;
  if (n < 2) return (x) => x;
  const dx = [], m = [], t = [];
  for (let i = 0; i < n - 1; i++) { dx.push(p[i + 1][0] - p[i][0] || 1e-6); m.push((p[i + 1][1] - p[i][1]) / dx[i]); }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  return (x) => {
    if (x <= p[0][0]) return p[0][1];
    if (x >= p[n - 1][0]) return p[n - 1][1];
    let i = 0; while (x > p[i + 1][0]) i++;
    const h = dx[i], s = (x - p[i][0]) / h;
    const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s, h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
    return h00 * p[i][1] + h10 * h * t[i] + h01 * p[i + 1][1] + h11 * h * t[i + 1];
  };
}
function wireCurve() {
  const c = $(".im-curve");
  if (!c) return;
  const at = (e) => { const r = c.getBoundingClientRect(); return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height))]; };
  const send = (pts, label) => run("develop.curve", { channel: curveCh, points: pts.slice().sort((a, b) => a[0] - b[0]) }, { quiet: true }).then(() => { if (label) status(label, "ok"); });
  c.addEventListener("pointerdown", (e) => {
    const p = at(e), pts = curvePoints();
    let i = pts.findIndex(([x, y]) => Math.hypot(x - p[0], y - p[1]) < 0.05);
    if (i < 0) { pts.push(p); i = pts.length - 1; }
    curveDrag = { pts, i };
    c.setPointerCapture(e.pointerId);
    q("image.run", { cmd: "develop.beginInteraction", params: { label: "Tone Curve" } }).catch(() => {});
    interacting = true;
  });
  c.addEventListener("pointermove", (e) => {
    if (!curveDrag) return;
    const p = at(e), { pts, i } = curveDrag;
    const lo = i > 0 ? pts.slice().sort((a, b) => a[0] - b[0]) : null;
    void lo;
    pts[i] = [i === 0 && pts[i][0] === 0 ? 0 : p[0], p[1]];
    drawCurveLocal(pts);
    clearTimeout(c._t); c._t = setTimeout(() => send(pts), 30);
  });
  c.addEventListener("pointerup", async () => {
    if (!curveDrag) return;
    const { pts } = curveDrag; curveDrag = null;
    await send(pts);
    interacting = false;
    const r = await q("image.run", { cmd: "develop.endInteraction", params: {} }).catch(() => null);
    if (r) apply(r.state);
    requestRender(false);
  });
  c.addEventListener("dblclick", (e) => {
    const p = at(e), pts = curvePoints();
    const i = pts.findIndex(([x, y]) => Math.hypot(x - p[0], y - p[1]) < 0.05);
    if (i > 0 && i < pts.length - 1) { pts.splice(i, 1); send(pts, "Point removed"); }
  });
  $(".im-curve-ch").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    curveCh = b.dataset.ch;
    $$(".im-curve-ch button").forEach((x) => x.classList.toggle("active", x === b));
    drawCurve();
  });
}
function drawCurveLocal(pts) {
  const st = I.state.settings || (I.state.settings = {});
  st.curve ||= {};
  st.curve[curveCh] = pts.map(([x, y]) => ({ x, y }));
  drawCurve();
}

// ------------------------------------------------------------------ masks panel
const MASK_ADJ = [
  ["exposure", "Exposure", -4, 4, 0.01, 2], ["contrast", "Contrast"], ["highlights", "Highlights"], ["shadows", "Shadows"], ["whites", "Whites"], ["blacks", "Blacks"],
  ["temp", "Temperature"], ["tint", "Tint"], ["hue", "Hue", -180, 180, 1, 0], ["saturation", "Saturation"], ["texture", "Texture"], ["clarity", "Clarity"], ["dehaze", "Dehaze"],
  ["sharpness", "Sharpness"], ["noise", "Noise"], ["moire", "Moiré"], ["defringe", "Defringe"], ["amount", "Amount", 0, 200, 1, 0, 100],
];
function masks() { return I?.state?.settings?.masks || []; }
function selectedMask() {
  const st = I?.state?.settings || {};
  const ms = masks();
  const sel = I?.state?.activeMask;
  return ms.find((m) => m.id === sel) || null;
}
function updateMasksPanel() {
  const box = $(".im-masks");
  const ms = masks();
  const show = I?.tool?.startsWith("mask") || I?.showMasks || (ms.length && I?.maskPanel);
  box.hidden = !show;
  if (!show) return;
  const sel = selectedMask();
  const adj = sel?.adjust || {};
  box.innerHTML = `<header><b>Masks</b><span class="tb-spacer"></span><button class="small im-mask-done">Done</button></header>
    <div class="im-mask-list">${ms.map((m, i) => `<div class="im-mask-item${m === sel ? " on" : ""}" data-id="${esc(m.id)}"><span class="im-mask-dot"></span><span class="im-mask-name">${esc(m.name || `Mask ${i + 1}`)}</span>
      <button class="icon small" data-a="mask.visible" title="Show / hide">${ic(m.visible === false ? "eye-off" : "eye")}</button><button class="icon small" data-a="mask.invert" title="Invert">${IC.invert}</button><button class="icon small" data-a="mask.duplicate" title="Duplicate">${IC.dup}</button><button class="icon small" data-a="mask.delete" title="Delete">${IC.trash}</button></div>`).join("") || `<div class="note">Pick a mask tool on the ribbon (Masking) and draw on the picture.</div>`}</div>
    ${sel ? `<div class="im-mask-adj">${MASK_ADJ.map(([k, l, min = -100, max = 100, step = 1, dec = 0, def = 0]) => {
      const v = adj[k] ?? def;
      return `<div class="im-sl mask" data-mk="${k}"><label title="Double-click to reset">${l}</label><input class="im-val" value="${(+v).toFixed(dec)}"><input type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-def="${def}"></div>`;
    }).join("")}</div>` : ""}`;
}

// ------------------------------------------------------------------ tools drawn on the picture
const TOOL_HINT = {
  crop: "Drag the corners or edges to crop · drag inside to move · Enter or Done to finish",
  wb: "Click something that should be neutral grey or white",
  spot: "Click (or drag) over a blemish or dust spot to heal it · [ ] change the size",
  clone: "Click over what should be covered: it is cloned from nearby",
  fillspot: "Paint over something to remove (content-aware fill)",
  redeye: "Drag a box around each red eye",
  "mask-linear": "Drag across the picture: the effect fades from the start to the end",
  "mask-radial": "Drag a box: the effect is inside the ellipse (Invert for outside)",
  "mask-brush": "Paint where the effect goes · Alt to erase · [ ] change the size",
  "mask-color": "Click a colour to select every area of that colour",
  "mask-lum": "Click a tone to select areas of that brightness",
};
let brushSize = 0.04;
function setTool(tool) {
  if (!I) return;
  const was = I.tool;
  I.tool = tool === was ? null : tool;
  $(".im-stage").dataset.tool = I.tool || "";
  const hint = $(".im-tool-hint");
  hint.hidden = !I.tool;
  hint.textContent = TOOL_HINT[I.tool] || "";
  if (!hint.hidden) enter(hint, "drop");
  if (was === "crop" || I.tool === "crop") refreshGeo().then(() => { layout(); });
  else drawOverlay();
  updateMasksPanel();
  rb?.update();
}

function viewPt(e) {
  const r = $(".im-sizer").getBoundingClientRect();
  return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
}
const toImg = (p) => I.geo.toImg(p[0], p[1]);
const longEdge = () => Math.max(I.geo.imgW, I.geo.imgH);

let gesture = null;
function onPointerDown(e) {
  if (!I?.geo || e.button !== 0) return;
  const stage = $(".im-stage");
  const p = viewPt(e);
  const tool = I.tool;
  if (!tool || e.target.closest(".im-tool-hint")) {
    // pan when zoomed in
    if (stage.classList.contains("zoomed")) { gesture = { kind: "pan", x: e.clientX, y: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop }; stage.setPointerCapture(e.pointerId); stage.classList.add("panning"); }
    return;
  }
  e.preventDefault();
  stage.setPointerCapture(e.pointerId);
  if (tool === "wb") { const [x, y] = toImg(p); run("develop.wbPick", { x, y }); return; }
  if (tool === "mask-color" || tool === "mask-lum") { addMaskAt(tool === "mask-color" ? "colorRange" : "luminanceRange", p, e); return; }
  if (tool === "crop") { const h = cropHandleAt(p); gesture = { kind: "crop", handle: h, from: p, start: cropRect() }; return; }
  gesture = { kind: tool, from: p, to: p, points: [p], alt: e.altKey };
}
function onPointerMove(e) {
  if (!I) return;
  const p = viewPt(e);
  I.hover = p;
  if (!gesture) { if (I.tool === "spot" || I.tool === "clone" || I.tool === "fillspot" || I.tool === "mask-brush") drawOverlay(); return; }
  if (gesture.kind === "pan") { const st = $(".im-stage"); st.scrollLeft = gesture.sl - (e.clientX - gesture.x); st.scrollTop = gesture.st - (e.clientY - gesture.y); return; }
  gesture.to = p;
  if (gesture.kind === "crop") {
    const now = performance.now();
    if (!gesture.busy && now - (gesture.last || 0) > 30) {
      gesture.busy = true; gesture.last = now;
      q("image.run", { cmd: "crop.drag", params: { handle: gesture.handle, from: gesture.from, to: p, start: gesture.start, keepRatio: e.shiftKey } }).then((r) => { gesture && (gesture.busy = false); if (r?.state) { I.state = r.state; drawOverlay(); } });
    }
    return;
  }
  if (gesture.kind === "mask-brush" || gesture.kind === "fillspot") gesture.points.push(p);
  drawOverlay();
}
async function onPointerUp(e) {
  if (!gesture || !I) return;
  const g = gesture; gesture = null;
  $(".im-stage").classList.remove("panning");
  if (g.kind === "pan") { requestRender(false); return; }
  const p = viewPt(e);
  if (g.kind === "crop") {
    const r = await q("image.run", { cmd: "crop.drag", params: { handle: g.handle, from: g.from, to: p, start: g.start, keepRatio: e.shiftKey } });
    apply(r.state);
    return;
  }
  const [a, b] = [toImg(g.from), toImg(p)];
  const L = longEdge();
  if (g.kind === "spot" || g.kind === "clone" || g.kind === "fillspot") {
    const mode = { spot: "heal", clone: "clone", fillspot: "fill" }[g.kind];
    const pts = (g.kind === "fillspot" ? g.points : [g.from]).map(toImg);
    await run("spot.add", { mode, points: pts, size: brushSize / 2 });
  } else if (g.kind === "redeye") {
    const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
    const rx = Math.max(0.004, (Math.abs(b[0] - a[0]) * I.geo.imgW) / L / 2), ry = Math.max(0.004, (Math.abs(b[1] - a[1]) * I.geo.imgH) / L / 2);
    await run("redeye.add", { center: [cx, cy], rx, ry });
  } else if (g.kind === "mask-linear") {
    if (Math.hypot(p[0] - g.from[0], p[1] - g.from[1]) < 0.01) return;
    await addMask("linear", { start: a, end: b });
  } else if (g.kind === "mask-radial") {
    const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
    const rx = Math.max(0.01, (Math.abs(b[0] - a[0]) * I.geo.imgW) / L / 2), ry = Math.max(0.01, (Math.abs(b[1] - a[1]) * I.geo.imgH) / L / 2);
    await addMask("radial", { center: [cx, cy], rx, ry, angle: 0, feather: 50 });
  } else if (g.kind === "mask-brush") {
    const sel = selectedMask();
    const pts = g.points.map(toImg);
    await run("mask.brushStroke", { ...(sel ? { id: sel.id } : {}), points: pts, size: brushSize, erase: g.alt || e.altKey });
  }
  drawOverlay();
}
async function addMask(kind, shape) {
  const r = await run("mask.add", { kind, ...shape });
  if (r) { I.maskPanel = true; updateMasksPanel(); status("Mask added — set its adjustments in the Masks panel", "ok"); }
}
async function addMaskAt(kind, p) {
  const [x, y] = toImg(p);
  const sel = selectedMask();
  const comp = sel?.components?.[0]?.shape;
  if (sel && comp?.kind === kind) { await run("mask.sampleColor", { x, y, add: true }); return; }
  await addMask(kind, {});
  await run("mask.sampleColor", { x, y }, { quiet: true });
}

// crop frame (normalized view coordinates of the uncropped picture shown while cropping)
function cropRect() {
  const q4 = I?.geo?.quad;
  if (!q4 || I.geo.crop) return [0, 0, 1, 1];
  const pts = q4.map(([x, y]) => I.geo.toView(x, y));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function cropHandleAt(p) {
  const [x0, y0, x1, y1] = cropRect();
  const tol = 14 / $(".im-sizer").clientWidth;
  const near = (a, b) => Math.abs(a - b) < tol * 1.5;
  const L = near(p[0], x0), R = near(p[0], x1), T = near(p[1], y0), B = near(p[1], y1);
  if (T && L) return "topLeft"; if (T && R) return "topRight"; if (B && R) return "bottomRight"; if (B && L) return "bottomLeft";
  if (T) return "top"; if (B) return "bottom"; if (L) return "left"; if (R) return "right";
  return "move";
}

function drawOverlay() {
  const c = $(".im-ov");
  if (!c || !I?.geo) return;
  const g = c.getContext("2d");
  const W = c.width, H = c.height, d = DPR();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, H);
  const V = (p) => [p[0] * W, p[1] * H];
  const fromImg = (x, y) => V(I.geo.toView(x, y));
  const L = longEdge();
  g.lineWidth = 1.5 * d;
  if (I.tool === "crop") {
    const [x0, y0, x1, y1] = cropRect().map((v, i) => v * (i % 2 ? H : W));
    g.fillStyle = "rgba(0,0,0,.55)";
    g.beginPath(); g.rect(0, 0, W, H); g.rect(x0, y0, x1 - x0, y1 - y0); g.fill("evenodd");
    g.strokeStyle = "rgba(255,255,255,.95)"; g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    g.strokeStyle = "rgba(255,255,255,.45)"; g.lineWidth = 1 * d;
    for (let i = 1; i < 3; i++) { const x = x0 + ((x1 - x0) * i) / 3, y = y0 + ((y1 - y0) * i) / 3; g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); }
    g.fillStyle = "#fff";
    const hs = 7 * d;
    for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1], [(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1], [x0, (y0 + y1) / 2], [x1, (y0 + y1) / 2]]) g.fillRect(x - hs / 2, y - hs / 2, hs, hs);
    return;
  }
  const st = I.state.settings || {};
  // healing spots
  if (["spot", "clone", "fillspot"].includes(I.tool)) {
    for (const s of st.spots || []) {
      const pts = (s.points || []).map((p) => (Array.isArray(p) ? p : [p.x, p.y]));
      const r = (s.size || 0.02) * L;
      for (const pt of pts.slice(0, 1)) {
        const [x, y] = fromImg(pt[0], pt[1]);
        const rx = (r / I.geo.imgW) * W * Math.abs(I.geo.nativeW / I.geo.imgW || 1);
        g.strokeStyle = "rgba(255,255,255,.9)"; g.beginPath(); g.arc(x, y, Math.max(4 * d, rx), 0, Math.PI * 2); g.stroke();
      }
    }
  }
  // masks (the selected one's shapes)
  if (I.tool?.startsWith("mask") || I.maskPanel) {
    const m = selectedMask();
    for (const comp of m?.components || (m ? [m] : [])) {
      const sh = comp.shape || comp;
      const P = (p, d0) => (p ? (Array.isArray(p) ? p : [p.x, p.y]) : d0);
      const lin = sh.kind === "linear" ? sh : null, rad = sh.kind === "radial" ? sh : null;
      if (lin) {
        const [ax, ay] = fromImg(...P(lin.start, [0, 0])), [bx, by] = fromImg(...P(lin.end, [1, 1]));
        g.strokeStyle = "rgba(255,255,255,.95)"; g.setLineDash([6 * d, 4 * d]);
        const nx = -(by - ay), ny = bx - ax, k = 3;
        for (const [px, py] of [[ax, ay], [bx, by]]) { g.beginPath(); g.moveTo(px - nx * k, py - ny * k); g.lineTo(px + nx * k, py + ny * k); g.stroke(); }
        g.setLineDash([]); g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      }
      if (rad) {
        const [cx, cy] = fromImg(...P(rad.center, [0.5, 0.5]));
        const rx = (rad.rx || 0.1) * L / I.geo.imgW * W, ry = (rad.ry || 0.1) * L / I.geo.imgH * H;
        g.strokeStyle = "rgba(255,255,255,.95)"; g.beginPath(); g.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), ((rad.angle || 0) * Math.PI) / 180, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.arc(cx, cy, 4 * d, 0, Math.PI * 2); g.fillStyle = "#fff"; g.fill();
      }
    }
  }
  // the gesture in progress
  if (gesture && gesture.kind !== "pan") {
    const [ax, ay] = V(gesture.from), [bx, by] = V(gesture.to);
    g.strokeStyle = "rgba(255,255,255,.95)"; g.fillStyle = "rgba(90,160,255,.25)";
    if (gesture.kind === "mask-linear") { g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke(); }
    if (gesture.kind === "mask-radial" || gesture.kind === "redeye") { g.beginPath(); g.ellipse((ax + bx) / 2, (ay + by) / 2, Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2, 0, 0, Math.PI * 2); g.fill(); g.stroke(); }
    if (gesture.kind === "mask-brush" || gesture.kind === "fillspot") {
      g.strokeStyle = gesture.alt ? "rgba(255,90,90,.6)" : "rgba(90,160,255,.55)"; g.lineCap = "round"; g.lineJoin = "round";
      g.lineWidth = brushSize * Math.max(W, H);
      g.beginPath(); gesture.points.forEach((q2, i) => { const [x, y] = V(q2); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
      g.lineWidth = 1.5 * d;
    }
  }
  // brush cursor
  if (I.hover && ["spot", "clone", "fillspot", "mask-brush"].includes(I.tool)) {
    const [x, y] = V(I.hover);
    g.strokeStyle = "rgba(255,255,255,.9)"; g.beginPath(); g.arc(x, y, (brushSize * Math.max(W, H)) / 2, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = "rgba(0,0,0,.5)"; g.beginPath(); g.arc(x, y, (brushSize * Math.max(W, H)) / 2 + d, 0, Math.PI * 2); g.stroke();
  }
}

// ------------------------------------------------------------------ ribbon
let rb = null;
const ASPECTS = [["original", "Original"], ["free", "Free"], ["1x1", "1 : 1 (square)"], ["4x5", "4 : 5"], ["5x7", "5 : 7"], ["2x3", "2 : 3"], ["4x3", "4 : 3"], ["16x9", "16 : 9"], ["16x10", "16 : 10"], ["8.5x11", "8.5 : 11"]];
const WB = [["asShot", "As Shot"], ["auto", "Auto"], ["daylight", "Daylight"], ["cloudy", "Cloudy"], ["shade", "Shade"], ["tungsten", "Tungsten"], ["fluorescent", "Fluorescent"], ["flash", "Flash"]];
let presets = null, profiles = null;
async function loadLists() {
  if (!presets) presets = await run("presets.list", {}, { quiet: true }).catch(() => null);
  if (!profiles) profiles = await run("profiles.list", {}, { quiet: true }).catch(() => null);
}
const listOf = (v) => (Array.isArray(v) ? v : v?.presets || v?.profiles || v?.items || []);
function groupMenu(list, cmd, key = "id") {
  const groups = new Map();
  for (const p of listOf(list)) { const g = p.group || p.category || "Presets"; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(p); }
  const out = [];
  for (const [g, ps] of groups) {
    if (out.length) out.push({ sep: true });
    out.push({ label: g, header: true });
    for (const p of ps.slice(0, 80)) out.push({ label: p.name || p.label || p[key], cmd, params: { id: p[key] ?? p.id } });
  }
  return out.length ? out : [{ label: "(none)", action: () => {} }];
}

function buildRibbon() {
  if (rb) { rb.commands = I.cmds; return; }
  const B = (label, icon, x) => ({ t: "big", label, icon, ...x });
  const S = (label, icon, x) => ({ t: "small", label, icon, ...x });
  const tool = (name) => ({ action: () => setTool(name), on: () => I?.tool === name });
  const tabs = [
    { name: "Home", groups: [
      { name: "Edit", items: [B("Auto", IC.auto, { cmd: "develop.auto", title: "Auto Settings (Shift+A): exposure, contrast, white balance and tones set for this picture" }),
        B("Black & White", IC.bw, { cmd: "develop.treatment", on: () => isBW(), title: "Black & White (V)" }),
        { t: "stack", items: [S("White Balance", IC.temp, { menu: WB.map(([m, l]) => ({ label: l, cmd: "develop.wb", params: { mode: m } })) }), S("WB Selector", IC.wb, { ...tool("wb"), title: "White Balance Selector (W)" }), S("HDR", IC.hdr, { cmd: "develop.hdr", title: "HDR editing: keep highlights above white for HDR screens and exports" })] }] },
      { name: "Transform", items: [{ t: "stack", items: [S("Rotate Left", IC.rotl, { cmd: "photo.rotateLeft" }), S("Rotate Right", IC.rotr, { cmd: "photo.rotateRight" }), S("Straighten", IC.level, { cmd: "crop.autoStraighten", title: "Auto Straighten: level the horizon" })] },
        { t: "stack", items: [S("Flip Horizontal", IC.fliph, { cmd: "photo.flipHorizontal" }), S("Flip Vertical", IC.flipv, { cmd: "photo.flipVertical" }), S("Upright", IC.upright, { menu: [["auto", "Auto"], ["level", "Level"], ["vertical", "Vertical"], ["full", "Full"], ["off", "Off"]].map(([m, l]) => ({ label: l, cmd: "geometry.upright", params: { mode: m } })) })] },
        B("Crop", IC.crop, { ...tool("crop"), title: "Crop & Straighten (R)", menu: [...ASPECTS.map(([a, l]) => ({ label: `Aspect ${l}`, cmd: "crop.aspect", params: { aspect: a } })), { sep: true }, { label: "Rotate Crop Aspect (X)", cmd: "crop.rotateAspect" }, { label: "Reset Crop", cmd: "crop.reset" }] })] },
      { name: "Looks", items: [B("Presets", IC.preset, { menu: () => groupMenu(presets, "preset.apply"), title: "Apply a preset (a whole look)" }), B("Profile", IC.profile, { menu: () => groupMenu(profiles, "develop.profile"), title: "Profile: how colours and tones are rendered (Adobe-like looks, B&W, film…)" })] },
      { name: "Settings", items: [{ t: "stack", items: [S("Copy Settings", IC.copy, { cmd: "develop.copy" }), S("Paste Settings", IC.paste, { cmd: "develop.paste" }), S("Reset All", IC.reset, { cmd: "develop.reset", title: "Reset every edit (Ctrl+Shift+R)" })] }] },
      { name: "View", items: [B("Before", IC.before, { action: toggleBefore, on: () => I?.before, title: "Before / After (\\)" }), { t: "stack", items: [S("Fit", IC.fit, { action: () => zoomTo(0) }), S("100%", IC.one, { action: () => zoomTo(1) }), S("Zoom In", IC.zoomin, { action: () => zoomBy(1.25) })] }] },
      { name: "File", items: [B("Save", IC.save, { action: () => I && saveImage(I.t), title: "Save the edited picture (Ctrl+S); the original is kept in Callio's backups" }), B("Export", IC.export, { action: () => I && exportImage(I.t), title: "Save a copy as JPEG, PNG, TIFF, WebP, AVIF or JPEG XL" })] },
    ] },
    { name: "Crop & Geometry", groups: [
      { name: "Crop", items: [B("Crop", IC.crop, tool("crop")), { t: "stack", items: ASPECTS.slice(0, 3).map(([a, l]) => S(l, IC.aspect, { cmd: "crop.aspect", params: { aspect: a } })) }, { t: "stack", items: ASPECTS.slice(3, 6).map(([a, l]) => S(l, IC.aspect, { cmd: "crop.aspect", params: { aspect: a } })) }, { t: "stack", items: ASPECTS.slice(6, 9).map(([a, l]) => S(l, IC.aspect, { cmd: "crop.aspect", params: { aspect: a } })) },
        { t: "stack", items: [S("Rotate Aspect", IC.rotr, { cmd: "crop.rotateAspect" }), S("Lock Aspect", IC.aspect, { cmd: "crop.aspect", params: { aspect: "toggle" } }), S("Reset Crop", IC.reset, { cmd: "crop.reset" })] }] },
      { name: "Straighten", items: [B("Auto Straighten", IC.level, { cmd: "crop.autoStraighten" }), { t: "stack", items: [-5, -1, 1, 5].slice(0, 3).map((d) => S(`${d > 0 ? "+" : ""}${d}°`, IC.level, { action: () => run("crop.straighten", { angle: (I.state.values["crop.angle"] || 0) + d }) })) }] },
      { name: "Rotate & Flip", items: [{ t: "stack", items: [S("Rotate Left", IC.rotl, { cmd: "photo.rotateLeft" }), S("Rotate Right", IC.rotr, { cmd: "photo.rotateRight" })] }, { t: "stack", items: [S("Flip Horizontal", IC.fliph, { cmd: "photo.flipHorizontal" }), S("Flip Vertical", IC.flipv, { cmd: "photo.flipVertical" })] }] },
      { name: "Upright", items: [["auto", "Auto"], ["level", "Level"], ["vertical", "Vertical"], ["full", "Full"], ["off", "Off"]].map(([m, l]) => ({ t: "small", label: l, icon: IC.upright, cmd: "geometry.upright", params: { mode: m } })).reduce((a, x, i) => { if (i % 3 === 0) a.push({ t: "stack", items: [] }); a[a.length - 1].items.push(x); return a; }, []) },
    ] },
    { name: "Masking", groups: [
      { name: "Create", items: [B("Brush", IC.brush, tool("mask-brush")), B("Linear Gradient", IC.linear, tool("mask-linear")), B("Radial Gradient", IC.radial, tool("mask-radial")),
        { t: "stack", items: [S("Color Range", IC.color, tool("mask-color")), S("Luminance Range", IC.lum, tool("mask-lum")), S("Sky", IC.sky, { cmd: "mask.add", params: { kind: "sky" }, title: "Select the sky (needs the picture AI model)" })] },
        { t: "stack", items: [S("Subject", IC.person, { cmd: "mask.add", params: { kind: "subject" }, title: "Select the subject (needs the picture AI model)" }), S("Background", IC.person, { cmd: "mask.add", params: { kind: "background" } })] }] },
      { name: "Mask", items: [{ t: "stack", items: [S("Invert", IC.invert, { cmd: "mask.invert" }), S("Duplicate", IC.dup, { cmd: "mask.duplicate" }), S("Duplicate & Invert", IC.invert, { cmd: "mask.duplicate", params: { invert: true } })] },
        { t: "stack", items: [S("Delete", IC.trash, { cmd: "mask.delete" }), S("Delete All", IC.trash, { cmd: "mask.deleteAll" }), S("Show Masks Panel", IC.mask, { action: () => { I.maskPanel = !I.maskPanel; updateMasksPanel(); drawOverlay(); }, on: () => I?.maskPanel })] }] },
      { name: "Brush", items: [{ t: "stack", items: [S("Smaller [", IC.zoomout, { action: () => { brushSize = Math.max(0.005, brushSize / 1.25); drawOverlay(); } }), S("Larger ]", IC.zoomin, { action: () => { brushSize = Math.min(0.5, brushSize * 1.25); drawOverlay(); } })] }] },
    ] },
    { name: "Retouch", groups: [
      { name: "Remove", items: [B("Heal", IC.heal, tool("spot")), B("Clone", IC.clone, tool("clone")), B("Content-Aware Fill", IC.fill, tool("fillspot")), B("Find Dust", IC.dust, { cmd: "spot.findDust", title: "Find sensor dust spots and heal them" })] },
      { name: "Eyes", items: [B("Red Eye", IC.eye, tool("redeye")), { t: "stack", items: [S("Pet Eye", IC.eye, { action: () => { I.petEye = !I.petEye; setTool("redeye"); }, on: () => I?.petEye })] }] },
      { name: "Spots", items: [{ t: "stack", items: [S("Delete Spot", IC.trash, { cmd: "spot.delete" }), S("Next Source", IC.reset, { cmd: "spot.refreshSource" })] }] },
    ] },
    { name: "Adjust", groups: [
      { name: "Tone", items: [B("Auto", IC.auto, { cmd: "develop.auto" }), { t: "stack", items: [S("Auto B&W Mix", IC.bw, { cmd: "develop.autoBwMix" }), S("Denoise", IC.denoise, { cmd: "denoise.toggle", title: "AI Denoise (raw photos)" }), S("Tone Curve Reset", IC.curve, { cmd: "curve.reset" })] }] },
      { name: "Reset", items: SECTIONS.filter(([k]) => RESETTABLE.has(k)).map(([k, l]) => ({ t: "small", label: l, icon: IC.reset, cmd: "develop.resetSection", params: { section: k } })).reduce((a, x, i) => { if (i % 3 === 0) a.push({ t: "stack", items: [] }); a[a.length - 1].items.push(x); return a; }, []) },
      { name: "History", items: [{ t: "stack", items: [S("Previous Step", IC.rotl, { cmd: "history.previous" }), S("Next Step", IC.rotr, { cmd: "history.next" }), S("Clear History", IC.trash, { cmd: "history.clear" })] }] },
    ] },
    { name: "Before / After", groups: [
      { name: "Compare", items: [B("Before", IC.before, { action: toggleBefore, on: () => I?.before }), { t: "stack", items: [S("Copy After → Before", IC.copy, { cmd: "beforeAfter.copyAfterToBefore" }), S("Copy Before → After", IC.paste, { cmd: "beforeAfter.copyBeforeToAfter" }), S("Swap", IC.fliph, { cmd: "beforeAfter.swap" })] }, { t: "stack", items: [S("Before = Import", IC.reset, { cmd: "beforeAfter.resetBefore" }), S("Before = Current", IC.copy, { cmd: "beforeAfter.setBefore", params: { source: "current" } })] }] },
    ] },
  ];
  // every other picture command, by family, so nothing is out of reach
  const used = new Set(JSON.stringify(tabs).match(/"cmd":"([^"]+)"/g)?.map((x) => x.slice(7, -1)));
  const fam = new Map();
  for (const c of I.cmds.values()) {
    if (used.has(c.id) || /^(develop\.(beginInteraction|endInteraction|cancelInteraction|set|adjust|merge|get|controls)|edit\.|presets\.list|profiles\.(list|menu)|history\.list|export\.presets)/.test(c.id)) continue;
    const f = c.id.split(".")[0];
    const name = { develop: "Develop", crop: "Crop", mask: "Masks", spot: "Spots", redeye: "Red Eye", preset: "Presets", presets: "Presets", profile: "Profiles", profiles: "Profiles", curve: "Curves", pointColor: "Point Color", geometry: "Geometry", history: "History", beforeAfter: "Before/After", photo: "Photo", denoise: "Denoise" }[f] || f;
    if (!fam.has(name)) fam.set(name, []);
    fam.get(name).push(c);
  }
  tabs.push({ name: "All Commands", groups: [...fam].map(([name, list]) => ({ name, items: list.reduce((a, c, i) => { if (i % 3 === 0) a.push({ t: "stack", items: [] }); a[a.length - 1].items.push({ t: "small", label: c.label, cmd: c.id, title: `${c.label}${c.shortcut ? ` (${c.shortcut})` : ""}` }); return a; }, []) })) });

  rb = new Ribbon({
    el: $(".im-rb"), set: "deck", tabs, commands: I.cmds, auto: ["ids", "id"],
    run: (id, p) => run(id, p),
    state: () => ({}), focus: () => $(".im-stage").focus({ preventScroll: true }),
    extra: (row) => row.appendChild(tellBox({ commands: I.cmds, exec: (id) => rb.exec(id), focus: () => $(".im-stage").focus({ preventScroll: true }) })),
  });
  loadLists();
}

// ------------------------------------------------------------------ zoom & view
function zoomTo(z, at) {
  if (!I) return;
  const st = $(".im-stage"), sz = $(".im-sizer");
  const old = scale();
  const r = st.getBoundingClientRect();
  const ax = at ? at[0] - r.left : st.clientWidth / 2, ay = at ? at[1] - r.top : st.clientHeight / 2;
  // the picture point under the anchor stays put
  const px = (st.scrollLeft + ax - sz.offsetLeft) / old, py = (st.scrollTop + ay - sz.offsetTop) / old;
  const fit = fitScale();
  I.zoom = z && Math.abs(z - fit) / fit > 0.02 ? Math.max(0.05, Math.min(16, z)) : 0;
  layout();
  const s = scale();
  st.scrollLeft = px * s + sz.offsetLeft - ax;
  st.scrollTop = py * s + sz.offsetTop - ay;
  requestRender(false);
}
const zoomBy = (f, at) => zoomTo(scale() * f, at);
function toggleBefore() {
  if (!I) return;
  I.before = !I.before;
  $(".im-before-btn").classList.toggle("on", I.before);
  status(I.before ? "Before (without the edits) — press \\ again for after" : "After", "ok");
  rb?.update();
  requestRender(false);
}

// ------------------------------------------------------------------ wiring
function wire() {
  const stage = $(".im-stage");
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointerleave", () => { if (I) { I.hover = null; drawOverlay(); } });
  stage.addEventListener("wheel", (e) => {
    if (!I) return;
    if (e.ctrlKey || !stage.classList.contains("zoomed")) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, [e.clientX, e.clientY]); }
  }, { passive: false });
  let scrollT = 0;
  stage.addEventListener("scroll", () => { clearTimeout(scrollT); scrollT = setTimeout(() => requestRender(false), 90); }, { passive: true });
  stage.addEventListener("dblclick", (e) => { if (!I || I.tool) return; zoomTo(I.zoom ? 0 : 1, [e.clientX, e.clientY]); });
  stage.addEventListener("keydown", onKey);
  $(".im-zi").onclick = () => zoomBy(1.25);
  $(".im-zo").onclick = () => zoomBy(1 / 1.25);
  $(".im-zoom").onclick = () => zoomTo(I?.zoom ? 0 : 1);
  $(".im-before-btn").onclick = toggleBefore;
  $(".im-panel-btn").onclick = () => host.classList.toggle("no-panel");
  new ResizeObserver(() => { if (I) layout(); }).observe(stage);

  // the adjustment panel
  const panel = $(".im-panel");
  panel.addEventListener("click", (e) => {
    const sec = e.target.closest(".im-sec");
    if (e.target.closest(".im-sec-reset")) { run("develop.resetSection", { section: sec.dataset.sec }); return; }
    if (e.target.closest(".im-sec-on")) return;
    if (e.target.closest(".im-sec > header")) {
      sec.classList.toggle("open");
      const open = $$(".im-sec.open").map((s) => s.dataset.sec);
      try { localStorage.setItem("callio.im.open", JSON.stringify(open)); } catch {}
      if (sec.classList.contains("open")) { enter(sec.querySelector(".im-sec-body"), "drop", { duration: 150 }); drawCurve(); }
      return;
    }
    if (e.target.closest(".im-wbpick")) { setTool("wb"); return; }
    const mt = e.target.closest(".im-mix-tabs button");
    if (mt) {
      $$(".im-mix-tabs button").forEach((b) => b.classList.toggle("active", b === mt));
      $$(".im-mix .im-sl").forEach((el) => { el.hidden = !el.dataset.id.endsWith("." + mt.dataset.m); });
      return;
    }
    const ma = e.target.closest(".im-mask-item [data-a]");
    if (ma) { const id = ma.closest(".im-mask-item").dataset.id; run(ma.dataset.a, { id }); return; }
    const mi = e.target.closest(".im-mask-item");
    if (mi) { run("mask.select", { id: mi.dataset.id }); return; }
    if (e.target.closest(".im-mask-done")) { I.maskPanel = false; setTool(null); updateMasksPanel(); drawOverlay(); }
  });
  panel.addEventListener("change", (e) => {
    const on = e.target.closest(".im-sec-on input");
    if (on) { run("develop.sectionEnabled", { section: on.closest(".im-sec").dataset.sec, enabled: on.checked }); return; }
    if (e.target.matches(".im-wb")) { run("develop.wb", { mode: e.target.value }); return; }
    const val = e.target.closest(".im-val");
    if (val) {
      const sl = val.closest(".im-sl");
      const v = parseFloat(val.value.replace(",", "."));
      if (!isFinite(v)) return updatePanel();
      if (sl.dataset.mk) setMaskValue(sl.dataset.mk, v, true);
      else run("develop.set", { values: { [sl.dataset.id]: v } });
    }
  });
  panel.addEventListener("input", (e) => {
    const r = e.target.closest(".im-sl input[type=range]");
    if (!r) return;
    const sl = r.closest(".im-sl");
    const v = +r.value;
    if (sl.dataset.mk) { sl.querySelector(".im-val").value = v; setMaskValue(sl.dataset.mk, v, false); return; }
    const c = CTLMAP().get(sl.dataset.id);
    sl.querySelector(".im-val").value = fmt(c || {}, v);
    if (dragEl !== sl) { beginDrag(sl); }
    setValues({ [sl.dataset.id]: v });
  });
  panel.addEventListener("pointerup", () => { if (dragEl) endDrag(); });
  panel.addEventListener("change", (e) => { if (e.target.matches(".im-sl input[type=range]") && dragEl) endDrag(); });
  panel.addEventListener("dblclick", (e) => {
    const lab = e.target.closest(".im-sl label");
    if (!lab) return;
    const sl = lab.closest(".im-sl");
    if (sl.dataset.mk) setMaskValue(sl.dataset.mk, +sl.querySelector("input[type=range]").dataset.def, true);
    else run("develop.resetControl", { control: sl.dataset.id });
  });
  panel.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches(".im-val")) e.target.blur(); e.stopPropagation(); });
}
let maskT = 0;
function setMaskValue(k, v, now) {
  clearTimeout(maskT);
  const go = () => { const sel = selectedMask(); run("mask.adjust", { ...(sel ? { id: sel.id } : {}), values: { [k]: v } }, { quiet: true }); };
  if (now) go(); else maskT = setTimeout(go, 40);
}

function onKey(e) {
  if (!I) return;
  const k = e.key, mod = e.ctrlKey || e.metaKey;
  if (mod && (k === "=" || k === "+")) { e.preventDefault(); zoomBy(1.25); return; }
  if (mod && k === "-") { e.preventDefault(); zoomBy(1 / 1.25); return; }
  if (mod && k === "0") { e.preventDefault(); zoomTo(0); return; }
  if (mod && k === "1") { e.preventDefault(); zoomTo(1); return; }
  if (mod) return;
  if (k === "Escape") { if (I.tool) { e.preventDefault(); setTool(null); } return; }
  if (k === "Enter" && I.tool === "crop") { e.preventDefault(); setTool(null); return; }
  const tools = { r: "crop", w: "wb", q: "spot", m: "mask-linear", b: "mask-brush" };
  if (tools[k.toLowerCase()] && !e.shiftKey) { e.preventDefault(); setTool(tools[k.toLowerCase()]); return; }
  if (k === "\\") { e.preventDefault(); toggleBefore(); return; }
  if (k === "z" || k === "Z") { e.preventDefault(); zoomTo(I.zoom ? 0 : 1); return; }
  if (k === "v" || k === "V") { e.preventDefault(); run("develop.treatment"); return; }
  if (k === "A" && e.shiftKey) { e.preventDefault(); run("develop.auto"); return; }
  if (k === "x" || k === "X") { if (I.tool === "crop") { e.preventDefault(); run("crop.rotateAspect"); } return; }
  if (k === "[") { brushSize = Math.max(0.005, brushSize / 1.2); drawOverlay(); return; }
  if (k === "]") { brushSize = Math.min(0.5, brushSize * 1.2); drawOverlay(); return; }
  if ((k === "Delete" || k === "Backspace") && I.maskPanel && selectedMask()) { e.preventDefault(); run("mask.delete", { id: selectedMask().id }); }
}

// ------------------------------------------------------------------ saving / export
export async function saveImage(t, saveAs = false) {
  if (!t.imageId) return true;
  const ext = (t.path.split(".").pop() || "").toLowerCase();
  let out = t.path;
  if (saveAs || !WRITES[ext]) {
    if (!saveAs) {
      const r = await ask({ title: `Save ${t.name}`, text: `Callio can't write .${ext} files (${/^(cr2|cr3|nef|arw|dng|raf|orf|rw2|pef|srw)$/.test(ext) ? "a camera raw file is never changed" : "Callio can't write this format"}). Save the edited picture as a new file next to it? The original stays as it is.`, buttons: [{ label: "Cancel", value: null }, { label: "Keep edits in a sidecar (.xmp)", value: "xmp" }, { label: "Save as JPEG / TIFF…", value: "copy", primary: true }] });
      if (!r) return false;
      if (r === "xmp") {
        try { await q("image.save", { out: t.path, params: { format: "original" }, markSaved: true }).then((x) => apply(x.state)); status(`Edits saved next to ${t.name} (.xmp)`, "ok"); return true; }
        catch (e) { toast(`Couldn't save the edits: ${e.message}`, "err"); return false; }
      }
    }
    out = await api.pickSaveFile(basename(t.path).replace(/\.[^.]+$/, "") + (WRITES[ext] ? `.${ext}` : ".jpg"), dirname(t.path));
    if (!out) return false;
  }
  try {
    status(`Saving ${basename(out)}…`);
    // through a temporary file, then into place with a backup of the old one
    const tmp = await call("office_temp", { name: basename(out) });
    const r = await q("image.save", { out: tmp, params: {}, markSaved: true });
    const bytes = new Uint8Array(await api.readBinary(tmp));
    await api.writeBinary(out, bytes, 0, true);
    apply(r.state);
    t.dirty = false;
    window.dispatchEvent(new Event("callio-tab-dirty"));
    status(`Saved ${basename(out)} (${r.result.width} × ${r.result.height}${out === t.path ? "; the previous version is in Callio's backups" : ""})`, "ok");
    return true;
  } catch (e) {
    toast(`Couldn't save ${basename(out)}: ${e.message}`, "err", 8000);
    return false;
  }
}
export async function exportImage(t) {
  if (!t.imageId) return;
  const fmtc = await ask({ title: `Export ${t.name}`, text: "Save a copy of the edited picture as:", vertical: true, buttons: [{ label: "Cancel", value: null }, { label: "JPEG (.jpg) — photos, small", value: "jpg" }, { label: "PNG (.png) — lossless", value: "png" }, { label: "TIFF (.tif) — 16-bit, for print", value: "tif" }, { label: "WebP (.webp) — web", value: "webp" }, { label: "AVIF (.avif) — smallest", value: "avif" }, { label: "JPEG XL (.jxl)", value: "jxl" }] });
  if (!fmtc) return;
  const out = await api.pickSaveFile(basename(t.path).replace(/\.[^.]+$/, "") + `-edited.${fmtc}`, dirname(t.path));
  if (!out) return;
  try {
    status(`Exporting ${basename(out)}…`);
    const r = await q("image.save", { out, params: fmtc === "tif" ? { bitDepth: 16 } : {}, markSaved: false });
    status(`Exported ${basename(out)} (${r.result.width} × ${r.result.height})`, "ok");
  } catch (e) { toast(`Couldn't export: ${e.message}`, "err", 8000); }
}

// ------------------------------------------------------------------ undo, AI
registerUndo("image", {
  list: (t) => { const st = I?.t === t ? I.state : t.imageState; return { undo: st?.undo || [], redo: st?.redo || [] }; },
  step: async (t, n, redo) => { if (I?.t !== t) return; const r = await q("image.undoN", { n, redo }); apply(r.state); },
});

/** For the AI: picture commands on an open picture as one undo step. */
export async function aiBatch(t, commands, label) {
  const r = await office("image.batch", { id: t.imageId, commands, label });
  if (I?.t === t) apply(r.state); else t.imageState = r.state;
  t.dirty = r.state.dirty;
  window.dispatchEvent(new Event("callio-tab-dirty"));
  return r.result;
}
export const imageTab = () => I?.t || null;
