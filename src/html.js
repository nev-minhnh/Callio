// HTML files: the page drawn as a browser draws it (Preview), edited as source (Editor), both side
// by side (Split), and Visual editing — type straight into the drawn page, with a small format
// bar; what you change there is written back into the source (only the <body>, so the <head>,
// styles and scripts stay as you wrote them). Scripts in the page don't run.
import { api, fileSrc } from "./api.js";
import { ic } from "./icons.js";
import { ask } from "./main.js";

let host = null, frame = null, H = null; // H: { t, onEdit(text), visual, fromVisual, timer }
const $ = (s) => host.querySelector(s);

export function htmlHost() {
  if (host) return host;
  host = document.createElement("div");
  host.id = "html-view";
  host.hidden = true;
  host.innerHTML = `
    <div class="hv-bar">
      <label class="switch hv-visual" title="Visual editing: type into the page itself; changes go into the source"><span>Visual edit</span><input type="checkbox"><span class="knob"></span></label>
      <div class="hv-fmt" hidden>
        <select class="hv-block" title="Paragraph style"><option value="p">Paragraph</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option><option value="h4">Heading 4</option><option value="blockquote">Quote</option><option value="pre">Code block</option></select>
        <button class="icon small" data-c="bold" title="Bold (Ctrl+B)"><b>B</b></button>
        <button class="icon small" data-c="italic" title="Italic (Ctrl+I)"><i>I</i></button>
        <button class="icon small" data-c="underline" title="Underline (Ctrl+U)"><u>U</u></button>
        <button class="icon small" data-c="strikeThrough" title="Strikethrough"><s>S</s></button>
        <span class="sep"></span>
        <button class="icon small" data-c="insertUnorderedList" title="Bulleted list">${ic("list")}</button>
        <button class="icon small" data-c="insertOrderedList" title="Numbered list">${ic("list-ordered")}</button>
        <button class="icon small" data-c="link" title="Link (Ctrl+K)">${ic("link")}</button>
        <button class="icon small" data-c="image" title="Picture">${ic("image")}</button>
        <button class="icon small" data-c="removeFormat" title="Clear formatting">${ic("eraser")}</button>
        <span class="sep"></span>
        <button class="icon small" data-c="undo" title="Undo (Ctrl+Z)">${ic("rotate-ccw")}</button>
        <button class="icon small" data-c="redo" title="Redo (Ctrl+Y)">${ic("rotate-cw")}</button>
      </div>
      <span class="tb-spacer"></span>
      <button class="icon small hv-reload" title="Draw the page again">${ic("refresh")}</button>
      <button class="icon small hv-open" title="Open in your browser">${ic("external")}</button>
    </div>
    <iframe class="hv-frame" sandbox="allow-same-origin allow-modals" referrerpolicy="no-referrer" title="HTML preview"></iframe>`;
  frame = $(".hv-frame");
  $(".hv-visual input").onchange = (e) => setVisual(e.target.checked);
  $(".hv-reload").onclick = () => H && draw(H.text, true);
  $(".hv-open").onclick = () => { if (H?.t.path) api.openPath(H.t.path).catch(() => {}); };
  for (const b of host.querySelectorAll(".hv-fmt [data-c]")) b.onmousedown = (e) => { e.preventDefault(); command(b.dataset.c); };
  $(".hv-block").onchange = (e) => { command("formatBlock", e.target.value); frame.contentWindow?.focus(); };
  frame.addEventListener("load", onLoad);
  return host;
}

function folderUrl(path) {
  if (!path) return "";
  return fileSrc(path.replace(/\\/g, "/").replace(/\/[^/]*$/, "/"));
}
const RELATIVE = (u) => u && !/^([a-z][a-z0-9+.-]*:|\/\/|#|data:|blob:)/i.test(u.trim());
/**
 * The page with its relative links (pictures, styles, media) pointing at its folder, so they
 * load in the preview. The original values are kept in data-callio-* and put back when the
 * page is written into the source — the file never gets these addresses.
 */
function prepared(text, path) {
  const base = folderUrl(path);
  if (!base) return text;
  const doc = new DOMParser().parseFromString(text, "text/html");
  for (const [sel, attr] of [["img[src]", "src"], ["source[src]", "src"], ["video[src]", "src"], ["audio[src]", "src"], ["video[poster]", "poster"], ["link[rel~=stylesheet][href]", "href"], ["img[srcset]", "srcset"], ["source[srcset]", "srcset"]]) {
    for (const el of doc.querySelectorAll(sel)) {
      const v = el.getAttribute(attr);
      if (attr === "srcset") {
        const nv = v.split(",").map((part) => { const [u, ...rest] = part.trim().split(/\s+/); return RELATIVE(u) ? [new URL(u, base).href, ...rest].join(" ") : part.trim(); }).join(", ");
        if (nv !== v) { el.setAttribute("data-callio-" + attr, v); el.setAttribute(attr, nv); }
      } else if (RELATIVE(v)) {
        try { el.setAttribute("data-callio-" + attr, v); el.setAttribute(attr, new URL(v, base).href); } catch {}
      }
    }
  }
  // scripts never run here
  doc.querySelectorAll("script").forEach((x) => x.setAttribute("type", "text/x-callio-blocked"));
  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
}
/** Undo `prepared` in an element tree (before writing it back). */
function restore(root) {
  for (const attr of ["src", "href", "poster", "srcset"]) {
    for (const el of root.querySelectorAll(`[data-callio-${attr}]`)) { el.setAttribute(attr, el.getAttribute(`data-callio-${attr}`)); el.removeAttribute(`data-callio-${attr}`); }
  }
  for (const el of root.querySelectorAll('script[type="text/x-callio-blocked"]')) el.removeAttribute("type");
}

/**
 * Show tab `t` (an HTML file) with `text`. onEdit(text) receives the source after a visual edit.
 */
export function showHtml(t, text, onEdit) {
  htmlHost();
  host.hidden = false;
  const same = H?.t === t;
  H = { ...(same ? H : {}), t, onEdit, text };
  const vis = !!t.htmlVisual;
  $(".hv-visual input").checked = vis;
  $(".hv-fmt").hidden = !vis;
  host.classList.toggle("visual", vis);
  // the change came from the visual page itself: nothing to redraw
  if (same && H.fromVisual === text) return;
  draw(text, !same);
}
export function hideHtml() { if (host) host.hidden = true; }
export function forgetHtml(t) { if (H?.t === t) { H = null; if (frame) frame.srcdoc = ""; } }

function draw(text, fresh) {
  clearTimeout(H.timer);
  H.scroll = fresh ? 0 : frame.contentWindow?.scrollY || H.scroll || 0;
  H.fromVisual = null;
  frame.srcdoc = prepared(text, H.t.path);
}

function onLoad() {
  if (!H) return;
  const doc = frame.contentDocument;
  if (!doc) return;
  try { frame.contentWindow.scrollTo(0, H.scroll || 0); } catch {}
  if (H.t.htmlVisual) enableVisual(doc);
  // links open in the browser, never inside the preview
  doc.addEventListener("click", (e) => {
    const a = e.target.closest?.("a[href]");
    if (!a || H?.t.htmlVisual) return;
    e.preventDefault();
    const href = a.getAttribute("href");
    if (/^https?:/i.test(href)) import("./api.js").then((m) => m.api.openUrl?.(href));
    else if (href.startsWith("#")) doc.getElementById(href.slice(1))?.scrollIntoView({ behavior: "smooth" });
  });
}

function enableVisual(doc) {
  doc.designMode = "on";
  if (!doc.getElementById("callio-visual-style")) {
    const st = doc.createElement("style");
    st.id = "callio-visual-style";
    st.textContent = "html{cursor:text} body{outline:none;min-height:90vh} img{cursor:pointer} :focus{outline:none}";
    (doc.head || doc.documentElement).appendChild(st);
  }
  doc.addEventListener("input", () => scheduleWriteBack());
  doc.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); command("link"); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); writeBack(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true })); }
  });
  doc.addEventListener("selectionchange", () => {
    const n = doc.getSelection()?.anchorNode;
    const el = n && (n.nodeType === 1 ? n : n.parentElement);
    const blk = el?.closest?.("h1,h2,h3,h4,blockquote,pre,p");
    const sel = $(".hv-block");
    if (sel) sel.value = blk ? blk.tagName.toLowerCase() : "p";
  });
}

function setVisual(on) {
  if (!H) return;
  H.t.htmlVisual = on;
  $(".hv-fmt").hidden = !on;
  host.classList.toggle("visual", on);
  const doc = frame.contentDocument;
  if (!doc) return;
  if (on) { enableVisual(doc); frame.contentWindow.focus(); }
  else { writeBack(); doc.designMode = "off"; doc.getElementById("callio-visual-style")?.remove(); }
}

function command(c, value) {
  const doc = frame.contentDocument;
  if (!doc || !H?.t.htmlVisual) return;
  frame.contentWindow.focus();
  if (c === "link" || c === "image") {
    const sel = doc.getSelection();
    const range = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    ask({ title: c === "link" ? "Link" : "Picture", text: c === "link" ? "Link address:" : "Picture address (a file next to the page, or https://…):", input: c === "link" ? "https://" : "" }).then((url) => {
      url = (url || "").trim();
      if (!url) return;
      frame.contentWindow.focus();
      if (range) { sel.removeAllRanges(); sel.addRange(range); }
      if (c === "link") doc.execCommand("createLink", false, url);
      else {
        doc.execCommand("insertImage", false, url);
        // show a relative picture now; the source keeps what was typed
        if (RELATIVE(url)) for (const img of doc.querySelectorAll(`img[src="${CSS.escape(url)}"]`)) { img.setAttribute("data-callio-src", url); img.src = new URL(url, folderUrl(H.t.path) || location.href).href; }
      }
      scheduleWriteBack();
    });
    return;
  } else if (c === "formatBlock") doc.execCommand("formatBlock", false, `<${value}>`);
  else doc.execCommand(c, false, value ?? null);
  scheduleWriteBack();
}

function scheduleWriteBack() { clearTimeout(H.wb); H.wb = setTimeout(writeBack, 350); }

/** The edited page back into the source: only what is inside <body> changes. */
function writeBack() {
  if (!H) return;
  clearTimeout(H.wb);
  const doc = frame.contentDocument;
  if (!doc?.body) return;
  const clone = doc.body.cloneNode(true);
  clone.querySelectorAll("#callio-visual-style").forEach((x) => x.remove());
  restore(clone);
  let inner = clone.innerHTML;
  const src = H.text;
  let out;
  const m = /(<body[^>]*>)([\s\S]*?)(<\/body\s*>)/i.exec(src);
  if (m) out = src.slice(0, m.index) + m[1] + inner + m[3] + src.slice(m.index + m[0].length);
  else if (/<html|<head/i.test(src)) out = src.replace(/<\/html\s*>/i, `<body>${inner}</body></html>`);
  else out = inner; // a fragment: the whole file is the body
  if (out === src) return;
  H.text = out;
  H.fromVisual = out;
  H.onEdit?.(out);
}
