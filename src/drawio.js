// draw.io diagrams (.drawio, .dio, .drawio.svg, .drawio.png): the full draw.io editor — its
// menus, toolbar, shape libraries, format panel, layouts, templates, export — running in a frame
// from the copy shipped with Callio (drawio.zip; nothing comes from the internet). It talks to
// Callio with draw.io's embed protocol: Callio hands it the file, draw.io reports every change
// (so the tab shows ● and Ctrl+S saves) and sends exports back to be saved where you choose.
import { api, call, IS_TAURI } from "./api.js";
import { settings, status, toast, ask } from "./main.js";

let host = null;
const D = new Map(); // tab id → { t, frame, ready, xml, saved, waiting: Map(format → resolve) }
let wired = false;

const BLANK = `<mxfile><diagram name="Page-1" id="${Math.random().toString(36).slice(2, 12)}"><mxGraphModel dx="1000" dy="640" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>\n`;
/** The text of a new, empty diagram. */
export const blankDiagram = () => BLANK;
/** Is this file a draw.io diagram? */
export const isDrawio = (p) => /\.(drawio|dio)(\.xml)?$/i.test(p || "") || /\.drawio\.(svg|png)$/i.test(p || "");
const flavour = (p) => (/\.drawio\.svg$/i.test(p) ? "svg" : /\.drawio\.png$/i.test(p) ? "png" : "xml");

function baseUrl() {
  if (!IS_TAURI) return "/__drawio/index.html";
  // http://drawio.localhost/ on Windows, drawio://localhost/ elsewhere (src-tauri/src/drawio.rs)
  try { return window.__TAURI_INTERNALS__.convertFileSrc("index.html", "drawio"); }
  catch { return /Windows/i.test(navigator.userAgent) ? "http://drawio.localhost/index.html" : "drawio://localhost/index.html"; }
}
function dark() {
  const th = settings.theme;
  return th === "dark" || (th !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
}
function frameUrl() {
  const p = new URLSearchParams({
    embed: "1", proto: "json", spin: "1", libraries: "1", saveAndExit: "0", noExitBtn: "1",
    stealth: "1", pwa: "0", offline: "1", splash: "0", lang: settings.uiLang === "vi" ? "vi" : "en",
    dark: dark() ? "1" : "0", ui: "kennedy", gapi: "0", db: "0", od: "0", gh: "0", gl: "0", tr: "0",
  });
  return `${baseUrl()}?${p}`;
}

export function drawioHost() {
  if (host) return host;
  host = document.createElement("div");
  host.id = "drawio-view";
  host.hidden = true;
  if (!wired) { wired = true; window.addEventListener("message", onMessage); }
  return host;
}

const entryFor = (src) => { for (const d of D.values()) if (d.frame.contentWindow === src) return d; return null; };
const post = (d, msg) => d.frame.contentWindow?.postMessage(JSON.stringify(msg), "*");

/** Show tab `t` (a diagram); its editor is started once and kept while the tab is open. */
export async function showDrawio(t) {
  drawioHost();
  host.hidden = false;
  for (const d of D.values()) d.frame.hidden = d.t !== t;
  let d = D.get(t.id);
  if (d) { d.frame.focus(); return; }
  if (IS_TAURI && !(await call("drawio_available").catch(() => false))) {
    host.innerHTML = `<div class="dv-missing"><b>The draw.io editor isn't installed.</b><p>Keep <code>drawio.zip</code> next to Callio.exe (it comes in the Callio zip), then open the diagram again.</p></div>`;
    return;
  }
  host.querySelector(".dv-missing")?.remove();
  const frame = document.createElement("iframe");
  frame.className = "dv-frame";
  frame.title = "draw.io";
  frame.setAttribute("allow", "clipboard-read; clipboard-write");
  d = { t, frame, ready: false, xml: null, saved: null, waiting: new Map(), loadedAt: 0 };
  D.set(t.id, d);
  frame.src = frameUrl();
  host.appendChild(frame);
}
export function hideDrawio() { if (host) host.hidden = true; }
export function closeDrawio(t) {
  const d = D.get(t.id);
  if (!d) return;
  d.frame.remove();
  D.delete(t.id);
}

async function fileMessage(t) {
  if (!t.path) return { xml: t.newXml || BLANK };
  const kind = flavour(t.path);
  if (kind === "png") {
    const bytes = new Uint8Array(await api.readBinary(t.path));
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { xmlpng: "data:image/png;base64," + btoa(bin) };
  }
  const { text, mtime } = await api.readText(t.path);
  t.mtime = mtime;
  if (kind === "svg") {
    // a .drawio.svg keeps the diagram in its content attribute
    const svg = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
    const c = svg?.getAttribute?.("content");
    return { xml: c || text };
  }
  return { xml: text.trim() ? text : BLANK };
}

async function onMessage(e) {
  const d = entryFor(e.source);
  if (!d || typeof e.data !== "string") return;
  let m;
  try { m = JSON.parse(e.data); } catch { return; }
  const t = d.t;
  switch (m.event) {
    case "init": {
      try {
        const msg = await fileMessage(t);
        post(d, { action: "load", autosave: 1, exportProtocol: true, title: t.name, modified: "unsavedChanges", noSaveBtn: 0, ...msg });
      } catch (er) { toast(`Couldn't open ${t.name}: ${er.message || er}`, "err", 8000); }
      break;
    }
    case "load":
      d.ready = true;
      d.xml = d.saved = m.xml ?? d.xml;
      d.loadedAt = performance.now();
      if (!t.path && t.newXml) { t.dirty = true; window.dispatchEvent(new Event("callio-tab-dirty")); }
      break;
    case "autosave": {
      d.xml = m.xml;
      const dirty = m.xml !== d.saved;
      if (dirty !== !!t.dirty) { t.dirty = dirty; window.dispatchEvent(new Event("callio-tab-dirty")); }
      break;
    }
    case "save":
      d.xml = m.xml ?? d.xml;
      import("./main.js").then((mm) => mm.saveTab(t));
      break;
    case "export": {
      const w = d.waiting.get(m.format);
      if (w) { d.waiting.delete(m.format); w(m); break; }
      await saveExport(t, m);
      break;
    }
    case "callio-open-url":
      if (/^(https?:|mailto:)/i.test(m.url || "")) api.openUrl(m.url).catch(() => {});
      break;
    case "exit":
      break;
  }
}

function dataBytes(data) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(data || "");
  if (!m) return new TextEncoder().encode(data || "");
  if (!m[2]) return new TextEncoder().encode(decodeURIComponent(m[3]));
  const bin = atob(m[3]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** draw.io's File → Export as…: the result is saved where you choose. */
async function saveExport(t, m) {
  const dir = t.path ? t.path.replace(/[\\/][^\\/]*$/, "") : null;
  const stem = (t.name || "diagram").replace(/\.(drawio|dio)(\.\w+)?$/i, "");
  let name = m.filename || `${stem}.${m.format}`;
  if (name.startsWith(".")) name = stem + name; // draw.io names some exports after the page only
  const out = await api.pickSaveFile(name, dir);
  if (!out) return;
  try {
    await api.writeBinary(out, dataBytes(m.data), 0, true);
    status(`Saved ${out.split(/[\\/]/).pop()}`, "ok");
  } catch (er) { toast(`Couldn't save ${name}: ${er.message || er}`, "err", 8000); }
}

function exportFrom(d, format) {
  return new Promise((resolve, reject) => {
    d.waiting.set(format, resolve);
    post(d, { action: "export", format, spinKey: "saving" });
    setTimeout(() => { if (d.waiting.get(format) === resolve) { d.waiting.delete(format); reject(new Error("draw.io didn't answer")); } }, 30000);
  });
}

/** Save the diagram (Ctrl+S, draw.io's Save, or Save As). */
export async function saveDrawio(t, saveAs = false) {
  const d = D.get(t.id);
  if (!d?.ready) return true;
  let path = t.path;
  if (!path || saveAs) {
    const dir = t.path ? t.path.replace(/[\\/][^\\/]*$/, "") : null;
    path = await api.pickSaveFile(t.path ? t.path.split(/[\\/]/).pop() : t.name, dir);
    if (!path) return false;
    if (!isDrawio(path)) {
      const r = await ask({ title: "Save diagram", text: "A diagram is saved as .drawio (or .drawio.svg / .drawio.png to keep a picture that draw.io can still edit). Add .drawio to the name?", buttons: [{ label: "Cancel", value: null }, { label: "Keep the name", value: "keep" }, { label: "Add .drawio", value: "add", primary: true }] });
      if (!r) return false;
      if (r === "add") path += ".drawio";
    }
  }
  try {
    const kind = flavour(path);
    if (kind === "xml") {
      t.mtime = await api.writeText(path, d.xml, "utf8", path === t.path ? t.mtime || 0 : 0);
    } else {
      const m = await exportFrom(d, kind === "svg" ? "xmlsvg" : "xmlpng");
      const bytes = dataBytes(m.data);
      if (kind === "svg") t.mtime = await api.writeText(path, new TextDecoder().decode(bytes), "utf8", 0);
      else await api.writeBinary(path, bytes, 0, true);
    }
    d.saved = d.xml;
    const renamed = path !== t.path;
    t.path = path;
    t.name = path.split(/[\\/]/).pop();
    t.dirty = false;
    post(d, { action: "status", messageKey: "allChangesSaved", modified: false });
    window.dispatchEvent(new Event("callio-tab-dirty"));
    if (renamed) import("./main.js").then((mm) => mm.tabRenamed?.(t));
    status(`Saved ${t.name}`, "ok");
    return true;
  } catch (er) {
    toast(`Couldn't save ${t.name}: ${er.message || er}`, "err", 8000);
    return false;
  }
}

/** The diagram as SVG (for AI and other callers that want a picture). */
export async function drawioSvg(t) {
  const d = D.get(t.id);
  if (!d?.ready) return null;
  const m = await exportFrom(d, "svg");
  return new TextDecoder().decode(dataBytes(m.data));
}
