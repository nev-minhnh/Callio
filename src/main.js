import { setLanguage } from "./i18n.js";
import "./styles.css";
import "./icons.js";
import { api, listen, IS_TAURI, call, fileSrc } from "./api.js";
import { initRpc, onRpc } from "./rpc.js";
import {
  initEditor, createState, setState, getView, applyOptions, refreshStateOptions, kindOf, gotoLine,
  showDiagnostics, topVisibleLine, cursorLine, project, scrollToLine,
} from "./editor.js";
import { markdownOutline, texOutline } from "./outline.js";

// The PDF and Markdown engines are loaded on first use, so startup only pays for the editor.
let mdMod = null, mdLoading = null, pdfMod = null, pdfLoading = null;
const loadMd = () => (mdLoading ??= import("./md.js").then((m) => (mdMod = m)));
const loadPdfMod = () => (pdfLoading ??= import("./pdf.js").then((m) => {
  m.initPdf($("#pdf-container"), pdfInitOptions());
  m.setLayout(settings.pdfLayout);
  m.onLoaded(onPdfLoaded);
  m.onUserScroll(() => syncFromPreview());
  m.onTextBoxSelect((st) => { if (st) { fillFonts(); syncTextControls(st); } });
  m.onPdfModified((on) => {
    const t = pdfShowing?.tab;
    if (!t || t.dirty === on) return;
    t.dirty = on; renderTabs();
    $("#pdf-edit-save").hidden = !on;
    if (on) schedulePdfAutosave();
  });
  m.onEditMode((mode) => { if (pdfTool === "text" || pdfTool === "note") return; const tool = { [m.EDIT.INK]: "draw", [m.EDIT.HIGHLIGHT]: "highlight", [m.EDIT.STAMP]: "image" }[mode] || "none"; markPdfTool(tool); });
  pdfMod = m;
  if (import.meta.env?.DEV) window.__pdf = m;
  return m;
}));
/** An edited PDF tab is on screen: save or discard before anything else replaces it. */
async function releaseEditedPdf(nextTab = null) {
  const shown = pdfShowing?.tab;
  if (!shown?.dirty || shown.kind !== "pdf" || shown === nextTab) return true;
  const r = await ask({ title: "Unsaved PDF changes", text: `Save your changes to ${shown.name} first?`, buttons: [{ label: "Cancel", value: null }, { label: "Discard", value: "discard" }, { label: "Save", value: "save", primary: true }] });
  if (!r) return false;
  if (r === "save") return await saveTab(shown);
  shown.dirty = false; renderTabs();
  return true;
}
/** Returns false when the user kept an edited PDF on screen instead. */
const loadPdf = async (bytes, opts, forTab = null) => {
  if (!(await releaseEditedPdf(forTab))) return false;
  await (await loadPdfMod()).loadPdf(bytes, opts);
  return true;
};
const clearPdf = () => { if (pdfShowing?.tab?.dirty) return false; pdfMod?.clearPdf(); return true; };
const hasPdf = () => !!pdfMod?.hasPdf();
const getViewState = () => pdfMod?.getViewState() ?? null;
const pageCount = () => pdfMod?.pageCount() ?? 0;
const setZoom = (v) => pdfMod?.setZoom(v);
const zoomBy = (f) => pdfMod?.zoomBy(f);
const goToPage = (n) => pdfMod?.goToPage(n);
const showLocation = (...a) => pdfMod?.showLocation(...a);
const pdfFind = (q, prev) => pdfMod?.find(q, prev);
const pdfCloseFind = () => pdfMod?.closeFind();
const getOutline = async () => (pdfMod ? pdfMod.getOutline() : []);
const goToDest = (d) => pdfMod?.goToDest(d);
import { installEngine, initEngineUI, refreshEngineCards, ENGINE_NAMES, ENGINE_SIZES } from "./engines.js";
import { initOverleaf, refreshOverleafPanel, handleSignInError } from "./overleaf.js";
import { initHistory, record as historyRecord, refreshHistoryPanel } from "./history.js";
import { initAI, toggleAIPanel, openActionMenu, fixError, refreshAIContext } from "./ai.js";
import { initInline } from "./ai-inline.js";
import { initWriting } from "./writing.js";
import * as mirror from "./mirror.js";
import { initUndo, refreshUndo, registerUndo } from "./undo.js";
import { enter, leave, cascade, settle, tabIn, tabOut, reduced } from "./motion.js";
import { loadLanguage, languageEffect, csvLanguage, setIndent, setCheckName, onLint, stepLabel } from "./editor.js";
import { isolateHistory } from "@codemirror/commands";
import { EditorView as CMView } from "@codemirror/view";
import { detectEol, setAnsi, encodingName } from "./textenc.js";
import { initCodeTools, updateCodeTools, showProblems } from "./codetools.js";
import { guessIndent } from "./structured.js";
import { isReviewing, endReview, setKindGetter, refreshExtraExtensions, addEditorExtension, reapplyExtras, editorLineTop, replaceDocAsStep, undoList, undoSteps } from "./editor.js";
import { ic } from "./icons.js";
import { fileBadge, isHiddenName, categoryOf } from "./filetypes.js";
import { loading, withLoading } from "./loading.js";
import { showContextMenu } from "./ctxmenu.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ---------------- settings ----------------
const DEFAULTS = {
  theme: "system", fontSize: 14, fontFamily: "", wordWrap: true, lineNumbers: true, spellcheck: false,
  autoSave: false, syncScroll: true, tabSize: 2, view: "split", sidebar: true, sideWidth: 230, previewRatio: 0.5,
  engine: "tectonic", latexmkFlavor: "pdf", autoCompile: "save", autoInstallPackages: true, pdfLayout: "auto", pdfNav: false, pdfViewer: "callio", editorZoom: 1, mdZoom: 1,
  aiProviders: {}, aiWeb: true, aiTools: true, aiInlineEnabled: false, aiInlineDelay: 700, aiSearchBackend: "none", aiSearchUrl: "",
  skillFolders: [], skillUseOwn: true, skillsDisabled: [], avoidLint: true, aiPanel: false, aiPanelWidth: 380, compileOnOpen: true, shellEscape: false, texBin: "",
  overleafUrl: "https://www.overleaf.com", overleafMode: "auto",
  uiLang: /^vi\b/i.test(navigator.language || "") ? "vi" : "en",
};
export let settings = { ...DEFAULTS };
let saveSettingsTimer;
export function updateSettings(patch) {
  settings = { ...settings, ...patch };
  applySettings();
  const asb = document.getElementById("autosave-cb");
  if (asb) asb.checked = !!settings.autoSave;
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(() => api.saveSettings(settings).catch((e) => toast(e.message, "err")), 300);
}

function applySettings() {
  const root = document.documentElement;
  if (settings.theme === "system") delete root.dataset.theme; else root.dataset.theme = settings.theme;
  try { localStorage.setItem("quire.theme", JSON.stringify(settings.theme)); } catch {}
  root.style.setProperty("--editor-size", (settings.fontSize * (settings.editorZoom || 1)).toFixed(2) + "px");
  root.style.setProperty("--md-zoom", settings.mdZoom || 1);
  if (settings.fontFamily) root.style.setProperty("--editor-font", `${settings.fontFamily}, var(--mono)`);
  else root.style.removeProperty("--editor-font");
  applyOptions({ wordWrap: settings.wordWrap, lineNumbers: settings.lineNumbers, spellcheck: settings.spellcheck, tabSize: +settings.tabSize || 2 });
  $("#app").classList.toggle("no-sidebar", !settings.sidebar);
  $("#sidebar").style.setProperty("--side-w", settings.sideWidth + "px");
  setView(settings.view, false);
  $("#sel-engine").value = settings.engine;
  setLanguage(settings.uiLang);
}

// ---------------- UI helpers ----------------
let lastToast = { msg: "", at: 0 };
export function toast(msg, kind = "", ms = 4200) {
  if (!msg) return;
  // the same message twice in a row (a status that also toasts): once is enough
  const now = performance.now();
  // (also when one says the same as the other, only shorter: "Saved a.docx" after "Saved a.docx (…)")
  if (now - lastToast.at < 1500 && (lastToast.msg === msg || lastToast.msg.startsWith(msg + " ") || lastToast.msg.startsWith(msg + " ("))) return;
  lastToast = { msg, at: now };
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.setAttribute("role", kind === "err" ? "alert" : "status");
  el.innerHTML = `${ic(kind === "err" ? "x-circle" : kind === "ok" ? "check-circle" : kind === "warn" ? "warning" : "info", "toast-ic")}<span class="toast-msg"></span>`;
  el.querySelector(".toast-msg").textContent = msg;
  el.onclick = () => leave(el, "right", { duration: 160 });
  if (kind === "err" && ms < 6000) ms = 6000;
  const box = $("#toasts");
  // many at once: the oldest goes
  while (box.children.length >= 4) box.firstElementChild.remove();
  box.appendChild(el);
  enter(el, "right", { duration: 200 });
  setTimeout(() => leave(el, "right", { duration: 180 }), ms);
}
export function status(msg, kind = "") {
  // finished actions (saved, converted, exported…) and failures always pop up too
  if (msg && (kind === "ok" || kind === "err")) toast(msg, kind, kind === "err" ? 7000 : 3200);
  const el = $("#st-msg");
  if (el.textContent === msg && el.className === kind) return;
  el.textContent = msg;
  el.className = kind;
  if (msg) enter(el, "fade", { duration: 160 });
}
export const basename = (p) => (p || "").split(/[\\/]/).pop();
export const dirname = (p) => { const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")); return i > 0 ? p.slice(0, i) : p; };
const norm = (p) => (p || "").replace(/\\/g, "/").toLowerCase();

/** Modal dialog. buttons: [{label, value, primary}] ; input: default value or undefined */
export function ask({ title, text = "", input, password = false, vertical = false, buttons = [{ label: "Cancel", value: null }, { label: "OK", value: "ok", primary: true }] }) {
  const dlg = $("#dlg-prompt");
  $("#prompt-title").textContent = title;
  $("#prompt-text").textContent = text;
  const inp = $("#prompt-input");
  inp.hidden = input === undefined;
  inp.type = password ? "password" : "text";
  inp.value = input ?? "";
  const foot = dlg.querySelector(".dlg-foot");
  foot.innerHTML = "";
  foot.classList.toggle("vertical", !!vertical);
  for (const b of buttons) {
    const el = document.createElement("button");
    el.textContent = b.label;
    el.value = b.value ?? "";
    el.dataset.v = JSON.stringify(b.value ?? null);
    if (b.primary) el.className = "primary";
    foot.appendChild(el);
  }
  return new Promise((resolve) => {
    let picked = null;
    foot.onclick = (e) => { const b = e.target.closest("button"); if (b) picked = JSON.parse(b.dataset.v); };
    dlg.onclose = () => resolve(picked === null ? null : input !== undefined ? (picked ? inp.value : null) : picked);
    // Enter in the text box means the main button, not the first one (Cancel)
    inp.onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); const b = buttons.find((x) => x.primary) || buttons[buttons.length - 1]; picked = b?.value ?? null; dlg.close(); } };
    dlg.showModal();
    if (input !== undefined) { inp.focus(); inp.select(); }
  });
}

// ---------------- tabs ----------------
/** Tabs without a text editor: shown by the PDF viewer or the spreadsheet grid. */
const VIEW_KINDS = new Set(["pdf", "doc", "sheet", "deck", "image", "media", "drawio"]);
let tabs = [];
let activeId = null;
let nextId = 1;
export const activeTab = () => tabs.find((t) => t.id === activeId) || null;
export const getTabs = () => tabs;

const seenTabs = new Set();
// ---------------- Mermaid diagrams: export, AI ----------------
let mmdWired = false;
function mermaidBar(t) {
  for (const b of $$("#md-toolbar .mmd-only")) b.hidden = t?.kind !== "mermaid";
  if (mmdWired) return;
  mmdWired = true;
  for (const b of $$("#md-toolbar [data-mmd]")) b.onclick = async () => {
    const tab = activeTab();
    const a = b.dataset.mmd;
    if (a === "ai") return import("./ai.js").then((m) => m.aiMermaid());
    const m = await import("./mermaid.js");
    const stem = (tab?.name || "diagram").replace(/\.[^.]+$/, "");
    const out = await api.pickSaveFile(`${stem}.${a}`, tab?.path ? dirname(tab.path) : folder);
    if (!out) return;
    try {
      if (a === "svg") { const svg = m.diagramSvg($("#md-preview")); if (!svg) throw new Error("Nothing is drawn yet"); await api.writeText(out, svg, "utf8", 0); }
      else { const blob = await m.diagramPng($("#md-preview")); if (!blob) throw new Error("Nothing is drawn yet"); await api.writeBinary(out, new Uint8Array(await blob.arrayBuffer()), 0, false); }
      status(`Saved ${basename(out)}`, "ok");
      if (folder) refreshTree();
    } catch (e) { status(`Couldn't save the diagram: ${e.message || e}`, "err"); }
  };
}

// ---------------- tab menu: close, pin, save, print, file actions ----------------
function pinTab(t, on = !t.pinned) {
  t.pinned = on;
  renderTabs();
  savePinned();
  status(on ? `Pinned ${t.name}` : `Unpinned ${t.name}`);
}
function savePinned() { try { localStorage.setItem("callio.pinned", JSON.stringify(tabs.filter((x) => x.pinned && x.path).map((x) => x.path))); } catch {} }
export function wasPinned(path) { try { return (JSON.parse(localStorage.getItem("callio.pinned") || "[]")).some((p) => norm(p) === norm(path)); } catch { return false; } }
async function closeTabs(list) {
  for (const x of list) { if (!tabs.includes(x)) continue; await closeTab(x.id); }
}
async function printTab(t) {
  if (t.path && !t.dirty && t.kind !== "md" && t.kind !== "csv") {
    try { await call("print_file", { path: t.path }); return status(`Sent ${t.name} to the printer`, "ok"); }
    catch (e) { /* no print verb for this type: print what's on screen */ }
  }
  if (t.id !== activeId) await activate(t.id);
  setTimeout(() => window.print(), 60);
}
async function renameTab(t) {
  const name = (await ask({ title: "Rename", text: `New name for ${t.name}`, input: t.name }))?.trim();
  if (!name || name === t.name) return;
  if (t.dirty && !(await saveTab(t))) return;
  try {
    const to = await api.renamePath(t.path, name, folder || dirname(t.path));
    await retargetTabs(t.path, to);
    status(`Renamed to ${name}`, "ok");
    refreshTree();
  } catch (e) { status(`Couldn't rename ${t.name}: ${e.message || e}`, "err"); }
}
function tabMenu(e, t) {
  const i = tabs.indexOf(t);
  const others = tabs.filter((x) => x !== t);
  const isPdf = t.kind === "pdf";
  const items = [
    { label: "Close", key: "Ctrl+W", icon: "x", action: () => closeTab(t.id) },
    { label: "Close Multiple Tabs", icon: "copy", sub: [
      { label: "Close All BUT This", disabled: !others.length, action: () => closeTabs(others.filter((x) => !x.pinned)) },
      { label: "Close All BUT Pinned", disabled: !tabs.some((x) => !x.pinned), action: () => closeTabs(tabs.filter((x) => !x.pinned)) },
      { label: "Close All to the Left", disabled: i <= 0, action: () => closeTabs(tabs.slice(0, i).filter((x) => !x.pinned)) },
      { label: "Close All to the Right", disabled: i >= tabs.length - 1, action: () => closeTabs(tabs.slice(i + 1).filter((x) => !x.pinned)) },
      { label: "Close All Unchanged", disabled: !tabs.some((x) => !x.dirty && !x.pinned), action: () => closeTabs(tabs.filter((x) => !x.dirty && !x.pinned)) },
      "-",
      { label: "Close All", action: () => closeTabs([...tabs]) },
    ] },
    { label: t.pinned ? "Unpin Tab" : "Pin Tab", icon: "pin", action: () => pinTab(t) },
    "-",
    { label: "Save", key: "Ctrl+S", icon: "save", disabled: !t.dirty && !!t.path, action: async () => { if (t.id !== activeId) await activate(t.id); cmdSave(false); } },
    { label: "Save As…", key: "Ctrl+Shift+S", icon: "copy", action: async () => { if (t.id !== activeId) await activate(t.id); cmdSave(true); } },
    { label: "Print…", key: "Ctrl+P", icon: "printer", action: () => printTab(t) },
    t.path && "-",
    isPdf && { label: "Convert to Word to edit", icon: `<span class="fb doc long">DOCX</span>`, action: () => import("./convertactions.js").then((m) => m.pdfToWord(t.path)) },
    isPdf && { label: "Convert to Markdown to edit", icon: `<span class="fb md">MD</span>`, action: () => import("./convertactions.js").then((m) => m.pdfToMarkdown(t.path)) },
    t.path && { label: "Open into", icon: "external", sub: [
      { label: "Default App", icon: "external", action: () => api.openPath(t.path).catch((er) => status(er.message, "err")) },
      { label: "File Explorer", key: "Shift+Alt+R", icon: "folder", action: () => api.revealPath(t.path) },
      { label: "Terminal", icon: "code", action: () => call("open_terminal", { dir: dirname(t.path) }) },
    ] },
    t.path && { label: "Reveal in File List", icon: "sidebar", action: () => { if (!settings.sidebar) updateSettings({ sidebar: true }); highlightTree(true); revealInTree(t.path, true); } },
    t.path && { label: "Add File to Chat", icon: "sparkles", action: () => import("./ai.js").then((m) => m.addToChat(t.path, false)) },
    t.path && "-",
    t.path && { label: "Copy Path", key: "Shift+Alt+C", icon: "copy", action: () => navigator.clipboard.writeText(t.path).then(() => status("Path copied", "ok")) },
    t.path && { label: "Copy Relative Path", icon: "copy", action: () => navigator.clipboard.writeText(relOf(t.path)).then(() => status("Relative path copied", "ok")) },
    t.path && { label: "Rename…", key: "F2", icon: "pen", action: () => renameTab(t) },
  ].filter(Boolean);
  showContextMenu(e, items);
}

function renderTabs() {
  const bar = $("#tabs");
  bar.innerHTML = "";
  // pinned tabs stay on the left
  const order = [...tabs.filter((x) => x.pinned), ...tabs.filter((x) => !x.pinned)];
  if (order.some((x, i) => x !== tabs[i])) { tabs.length = 0; tabs.push(...order); }
  for (const t of tabs) {
    const el = document.createElement("div");
    el.dataset.id = t.id;
    if (!seenTabs.has(t.id)) { seenTabs.add(t.id); requestAnimationFrame(() => tabIn(el)); }
    el.className = "tab" + (t.id === activeId ? " active" : "") + (t.dirty ? " dirty" : "") + (t.pinned ? " pinned" : "");
    el.title = (t.path || "Unsaved") + (t.pinned ? " · pinned" : "");
    el.innerHTML = `${fileBadge(t.path || t.name || "untitled.txt")}<span class="name"></span>${t.pinned ? `<button class="close pin" title="Unpin">${ic("pin")}</button>` : `<button class="close" title="Close (Ctrl+W)"><span>${ic("x")}</span></button>`}`;
    el.querySelector(".name").textContent = t.name;
    el.onclick = (e) => { if (!e.target.closest(".close")) activate(t.id); };
    el.onauxclick = (e) => { if (e.button === 1 && !t.pinned) closeTab(t.id); };
    el.querySelector(".close").onclick = () => (t.pinned ? pinTab(t, false) : closeTab(t.id));
    el.oncontextmenu = (e) => tabMenu(e, t);
    bar.appendChild(el);
    if (t.id === activeId) requestAnimationFrame(() => el.scrollIntoView({ block: "nearest", inline: "nearest" }));
  }
  $("#welcome").hidden = tabs.length > 0;
  updateTitle();
}

// ---------------- dragging tabs to reorder them ----------------
// Press on a tab and move: the tab follows the pointer, the others slide out of its way, and it
// drops into the gap. Pinned tabs stay among the pinned ones, the others among the others.
let tabDrag = null, tabDragEnded = 0;
function wireTabDrag() {
  const bar = $("#tabs");
  bar.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(".tab");
    if (!el || e.button !== 0 || e.target.closest(".close")) return;
    tabDrag = { el, id: +el.dataset.id || el.dataset.id, x0: e.clientX, started: false, pointer: e.pointerId };
  });
  addEventListener("pointermove", (e) => {
    const d = tabDrag; if (!d) return;
    const dx = e.clientX - d.x0;
    if (!d.started) {
      if (Math.abs(dx) < 6) return;
      d.started = true;
      const t = tabs.find((x) => String(x.id) === String(d.el.dataset.id));
      d.tab = t;
      d.els = [...bar.querySelectorAll(".tab")].filter((x) => tabs.find((y) => String(y.id) === x.dataset.id)?.pinned === t?.pinned);
      d.rects = d.els.map((x) => x.getBoundingClientRect());
      d.from = d.els.indexOf(d.el);
      d.to = d.from;
      d.el.classList.add("dragging");
      bar.classList.add("tab-dragging");
      try { d.el.setPointerCapture(d.pointer); } catch {}
    }
    const r0 = d.rects[d.from];
    const lo = d.rects[0].left - r0.left, hi = d.rects[d.rects.length - 1].right - r0.right;
    const x = Math.max(lo, Math.min(hi, dx));
    d.el.style.transform = `translateX(${x}px)`;
    // where its middle is now
    const mid = r0.left + r0.width / 2 + x;
    let to = d.from;
    d.rects.forEach((r, i) => { if (i < d.from && mid < r.left + r.width / 2) to = Math.min(to, i); if (i > d.from && mid > r.left + r.width / 2) to = Math.max(to, i); });
    d.to = to;
    d.els.forEach((other, i) => {
      if (other === d.el) return;
      let shift = 0;
      if (d.from < to && i > d.from && i <= to) shift = -r0.width;
      if (d.from > to && i < d.from && i >= to) shift = r0.width;
      other.style.transform = shift ? `translateX(${shift}px)` : "";
    });
    // near the edges: scroll the tab bar
    const br = bar.getBoundingClientRect();
    if (e.clientX < br.left + 30) bar.scrollLeft -= 12; else if (e.clientX > br.right - 30) bar.scrollLeft += 12;
  });
  const end = () => {
    const d = tabDrag; tabDrag = null;
    if (!d?.started) return;
    tabDragEnded = Date.now();
    bar.classList.remove("tab-dragging");
    d.els.forEach((x) => { x.style.transform = ""; x.classList.remove("dragging"); });
    if (d.to !== d.from && d.tab) {
      const group = d.els.map((x) => tabs.find((y) => String(y.id) === x.dataset.id));
      const moved = group.splice(d.from, 1)[0];
      group.splice(d.to, 0, moved);
      const pinned = d.tab.pinned;
      const rest = tabs.filter((x) => !!x.pinned !== !!pinned);
      tabs.length = 0;
      tabs.push(...(pinned ? [...group, ...rest] : [...rest, ...group]));
      if (pinned) savePinned?.();
      renderTabs();
      window.dispatchEvent(new Event("callio-tabs-reordered"));
    }
  };
  addEventListener("pointerup", end);
  addEventListener("pointercancel", end);
  // a drag isn't a click
  bar.addEventListener("click", (e) => { if (Date.now() - tabDragEnded < 200) { e.stopPropagation(); e.preventDefault(); } }, true);
}

function updateTitle() {
  const t = activeTab();
  const title = t ? `${t.dirty ? "● " : ""}${t.name} — Callio` : "Callio";
  document.title = title;
  if (IS_TAURI) call("set_title", { title }).catch(() => {});
}

function stashActive() {
  nbShowing?.ctl.sync();
  if (wys && wys.tab === activeTab()) wys.ctl.flush();
  const t = activeTab();
  const v = getView();
  if (t && v && !VIEW_KINDS.has(t.kind)) { t.state = v.state; t.scroll = v.scrollDOM.scrollTop; }
  stashPdfView();
}
const texView = new Map(); // root → saved PDF zoom/scroll
let pdfShowing = null;      // { tab } for a PDF tab, { root } for a LaTeX preview
function stashPdfView() {
  const vs = getViewState();
  if (!vs || !pdfShowing) return;
  if (pdfShowing.tab) pdfShowing.tab.view = vs;
  else if (pdfShowing.root) texView.set(norm(pdfShowing.root), vs);
}

export async function activate(id) {
  if (id === activeId) return;
  if (isReviewing()) {
    const r = await ask({ title: "AI suggestion still open", text: "Keep or discard the AI changes you haven't reviewed?", buttons: [
      { label: "Stay here", value: null }, { label: "Discard", value: "reject" }, { label: "Keep all", value: "accept", primary: true }] });
    if (!r) return;
    endReview(r === "accept");
  }
  // the PDF viewer is shared: an edited PDF must be saved before another PDF replaces it
  const next = tabs.find((x) => x.id === id);
  if (next && (next.kind === "pdf" || next.kind === "tex") && !(await releaseEditedPdf(next))) return;
  nbShowing?.ctl.flush();
  stashActive();
  activeId = id;
  const t = activeTab();
  if (!t) return;
  const isPdf = VIEW_KINDS.has(t.kind);
  $("#app").classList.toggle("pdf-mode", isPdf);
  $("#app").classList.toggle("sheet-mode", t.kind === "sheet");
  $("#app").classList.toggle("word-mode", t.kind === "doc");
  $("#app").classList.toggle("deck-mode", t.kind === "deck");
  $("#app").classList.toggle("image-mode", t.kind === "image");
  $("#app").classList.toggle("media-mode", t.kind === "media");
  $("#app").classList.toggle("drawio-mode", t.kind === "drawio");
  $("#app").classList.toggle("nb-mode", t.kind === "ipynb" && !t.nbRaw);
  if (!isPdf) {
    t.state = refreshExtraExtensions(refreshStateOptions(t.state, t.indent), t.kind);
    setState(t.state);
    const v = getView();
    requestAnimationFrame(() => { v.scrollDOM.scrollTop = t.scroll || 0; v.focus(); });
  } else closePdfFind();
  renderTabs();
  onDocChanged(true);
  if (!isPdf) updateCursor(t.state);
  else { $("#st-pos").textContent = ""; $("#st-words").textContent = ""; }
  highlightTree();
  if (!$("#side-history").hidden) refreshHistoryPanel();
  $("#st-path").textContent = t.path || "Unsaved file";
  $("#st-kind").textContent = { tex: "LaTeX", md: "Markdown", bib: "BibTeX", text: languageName(t), pdf: "PDF", ipynb: "Jupyter notebook", doc: "Word document", sheet: "Spreadsheet", deck: "Presentation", image: "Picture", drawio: "draw.io diagram", mermaid: "Mermaid diagram", html: "HTML", media: "Media", json: "JSON", xml: "XML", yaml: "YAML", csv: t.delim === "\t" ? "TSV" : "CSV" }[t.kind];
  $("#app").classList.toggle("kind-csv", t.kind === "csv");
  $("#app").classList.toggle("kind-struct", ["json", "xml", "yaml"].includes(t.kind));
  // CSV/TSV open as a table; other files use the chosen view
  setView(viewFor(t), false);
  updateCodeTools(t);
  $("#tex-tools").style.visibility = t.kind === "tex" || t.kind === "bib" ? "visible" : "hidden";
  if (t.path && !folder) setFolder(dirname(t.path));
  await updateLink(t.path);
  if (!isPdf) applyViewerKind(t);
  $("#fmt-bar").hidden = !(t.kind === "md" || t.kind === "tex");
  syncVisualMode(t);
  $("#app").classList.toggle("kind-md", t.kind === "md");
  $("#app").classList.toggle("kind-mermaid", t.kind === "mermaid");
  mermaidBar(t);
  if (t.kind === "tex") await ensureTexPreview(t);
  if (t.kind !== "doc") import("./word.js").then((m) => m.hideWord());
  if (t.kind !== "deck") import("./deck.js").then((m) => m.hideDeck());
  if (t.kind !== "image") { import("./image.js").then((m) => m.hideImage()); import("./viewer.js").then((m) => m.hidePreview()); }
  if (t.kind !== "media") import("./media.js").then((m) => m.hideMedia());
  if (t.kind !== "drawio") import("./drawio.js").then((m) => m.hideDrawio());
  settle($("#editor-pane")); settle($("#preview-pane"));
  if (t.kind === "sheet") await showSheetTab(t);
  else if (t.kind === "doc") { (await import("./sheet.js")).hideSheet(); await showWordTab(t); }
  else if (t.kind === "deck") { (await import("./sheet.js")).hideSheet(); await showDeckTab(t); }
  else if (t.kind === "image") { (await import("./sheet.js")).hideSheet(); await showImageTab(t); }
  else if (t.kind === "media") { (await import("./sheet.js")).hideSheet(); await showMediaTab(t); }
  else if (t.kind === "drawio") { (await import("./sheet.js")).hideSheet(); await showDrawioTab(t); }
  else if (isPdf) { (await import("./sheet.js")).hideSheet(); await showPdfTab(t); }
  refreshUndo();
}

window.addEventListener("callio-image-preview", () => { const t = activeTab(); if (t?.kind === "image") { t.imgEdit = false; import("./viewer.js").then((v) => v.forgetPreview(t)); showImageTab(t); } });
async function showDrawioTab(t) {
  const m = await import("./drawio.js");
  const h = m.drawioHost();
  if (!h.isConnected) $("#preview-pane").appendChild(h);
  $("#pdf-wrap").hidden = true;
  try { await m.showDrawio(t); }
  catch (e) { status(`Couldn't open ${t.name}: ${e.message}`, "err"); }
}
/** A tab's file was saved under a new name (Save As from a viewer). */
export function tabRenamed(t) {
  renderTabs();
  if (t.id === activeId) { $("#st-path").textContent = t.path || "Unsaved file"; highlightTree(); }
  if (t.path) addRecent(t.path);
  if (folder) refreshTree().catch(() => {});
}
async function showMediaTab(t) {
  const m = await import("./media.js");
  const h = m.mediaHost();
  if (!h.isConnected) $("#preview-pane").appendChild(h);
  $("#pdf-wrap").hidden = true;
  try { await m.openMedia(t); }
  catch (e) { status(`Couldn't open ${t.name}: ${e.message}`, "err"); }
}

async function showImageTab(t) {
  // pictures open in the light viewer; the editor starts when "Edit" is switched on
  if (!t.imgEdit) {
    const v = await import("./viewer.js");
    (await import("./image.js")).hideImage();
    const ph = v.previewHost();
    if (!ph.isConnected) $("#preview-pane").appendChild(ph);
    $("#pdf-wrap").hidden = true;
    return v.showPreview(t, { onEdit: (tab) => { tab.imgEdit = true; if (tab === activeTab()) showImageTab(tab); }, onOpen: (p) => openPath(p) });
  }
  (await import("./viewer.js")).hidePreview();
  const busy = loading(`Starting the photo editor…`, { delay: 200, detail: t.name });
  try { await openImageEditor(t); } finally { busy.done(); }
}
async function openImageEditor(t) {
  const m = await import("./image.js");
  const h = m.imageHost();
  if (!h.isConnected) $("#preview-pane").appendChild(h);
  $("#pdf-wrap").hidden = true;
  try { await m.openImage(t); }
  catch (e) { toast(`Couldn't open ${t.name}: ${e.message}`, "err", 8000); }
}

async function showDeckTab(t) {
  const m = await import("./deck.js");
  const h = m.deckHost();
  if (!h.isConnected) $("#preview-pane").appendChild(h);
  $("#pdf-wrap").hidden = true;
  try { await m.openDeck(t); }
  catch (e) { toast(`Couldn't open ${t.name}: ${e.message}`, "err", 8000); }
}

async function showWordTab(t) {
  const m = await import("./word.js");
  const h = m.wordHost();
  if (!h.isConnected) $("#preview-pane").appendChild(h);
  $("#pdf-wrap").hidden = true;
  try { await m.openWord(t); }
  catch (e) { toast(`Couldn't open ${t.name}: ${e.message}`, "err", 8000); }
}

async function showSheetTab(t) {
  const m = await import("./sheet.js");
  const h = m.sheetHost();
  if (!h.isConnected) $("#preview-pane").appendChild(h);
  $("#pdf-wrap").hidden = true;
  h.hidden = false;
  try { await m.openSheet(t); }
  catch (e) { toast(`Couldn't open ${t.name}: ${e.message}`, "err", 8000); }
  requestAnimationFrame(() => h.querySelector(".sh-scroll")?.focus({ preventScroll: true }));
}

async function showPdfTab(t) {
  hideCompileErrors();
  applyViewerKind(t);
  $("#pdf-empty").hidden = true;
  if (settings.pdfViewer === "edge") return;
  if (pdfShowing?.tab === t && hasPdf()) return;
  try {
    // a Word document shows as its pages, laid out by the office engine
    if (t.kind === "doc" && !t.render) {
      $("#pdf-empty").hidden = false;
      $("#pdf-empty").classList.add("busy");
      try { await (await import("./office.js")).renderDoc(t); } finally { $("#pdf-empty").classList.remove("busy"); }
      if (activeTab() !== t) return;
    }
    const bytes = await api.readBinary(t.kind === "doc" ? t.render : t.path);
    if (activeTab() !== t) return;
    if (!(await loadPdf(new Uint8Array(bytes), { view: t.view }, t))) return;
    pdfShowing = { tab: t };
    lastPdfRoot = null;
    $("#pdf-empty").hidden = true;
    $("#st-words").textContent = `${pageCount()} page${pageCount() === 1 ? "" : "s"}`;
    requestAnimationFrame(() => $("#pdf-container").focus({ preventScroll: true }));
    renderOutline();
  } catch (e) { toast(`Couldn't open ${t.name}: ${e.message}`, "err"); }
}

function newTab({ path = null, text = "", kind, mtime = 0, encoding = "utf8", eol = null, name = null }) {
  kind = kind || kindOf(path || name || "untitled.md");
  const t = { id: nextId++, path, name: path ? basename(path) : name || `Untitled-${nextId - 1}.${kind === "tex" ? "tex" : kind === "bib" ? "bib" : "md"}`, kind, dirty: false, saved: text, scroll: 0, mtime, encoding, eol: eol || "\n" };
  if (kind === "csv") t.delim = detectDelimiterFor(text, path || t.name);
  if (!VIEW_KINDS.has(kind)) { const g = guessIndent(text.slice(0, 200000)); if (g) t.indent = g; }
  t.state = createState(VIEW_KINDS.has(kind) ? "" : text, VIEW_KINDS.has(kind) ? "text" : kind, { delim: t.delim });
  tabs.push(t);
  // highlighting for JSON, XML, YAML and code, loaded in the background
  if (["json", "xml", "yaml", "text", "html"].includes(kind)) loadLanguage(path || t.name).then((ext) => { if (ext) setTabLanguage(t, ext); });
  return t;
}
function detectDelimiterFor(text, name) {
  if (/\.(tsv|tab)$/i.test(name)) return "\t";
  if (/\.psv$/i.test(name)) return "|";
  // a quick look at the first lines; the table view refines nothing — this is the file's separator
  const lines = text.split("\n", 30).filter((l) => l.trim());
  let best = ",", bestN = 0;
  for (const d of [",", ";", "\t", "|"]) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const n = counts.filter((c) => c > 0 && c === counts[0]).length * (counts[0] > 0 ? 1 : 0);
    if (n > bestN) { bestN = n; best = d; }
  }
  return best;
}
function setTabLanguage(t, ext) {
  if (t.id === activeId) getView().dispatch({ effects: languageEffect(ext) });
  else t.state = t.state.update({ effects: languageEffect(ext) }).state;
}
/** The text of a tab now (the active tab's is in the editor). */
export function tabText(t) { return (t.id === activeId && !VIEW_KINDS.has(t.kind) ? getView().state : t.state).doc.toString(); }
/** Read a text file: line breaks become "\n" in the editor; the file's own are kept for saving. */
async function readTextFile(path, encoding) {
  const r = await api.readText(path, encoding);
  const eol = detectEol(r.text);
  return { ...r, eol, text: r.text.includes("\r") ? r.text.replace(/\r\n?/g, "\n") : r.text };
}

export async function openPath(path, line) {
  const existing = tabs.find((t) => t.path && norm(t.path) === norm(path));
  if (existing) { await activate(existing.id); if (line) gotoLine(line); return existing; }
  const cat = categoryOf(path);
  // archives and programs are never read as text: extract / run them (after asking)
  if (cat === "archive") { await openArchive(path); return null; }
  if (cat === "exe") { await confirmLaunch(path); return null; }
  if (cat === "font" || cat === "book") {
    const r = await ask({ title: `Open ${basename(path)}?`, text: `Callio can't show ${cat === "font" ? "font files" : "e-books"}. Open it with its usual app?`, buttons: [{ label: "Cancel", value: null }, { label: "Open with default app", value: "ext", primary: true }] });
    if (r) api.openPath(path).catch((e) => toast(e.message, "err"));
    return null;
  }
  const k = cat === "video" || cat === "audio" ? "media" : kindOf(path);
  if (k === "pdf" || k === "doc" || k === "sheet" || k === "deck" || k === "image" || k === "media" || k === "drawio") {
    const t = newTab({ path, kind: k });
    t.pinned = wasPinned(path);
    t.mtime = await api.fileMtime(path).catch(() => 0);
    addRecent(path);
    await activate(t.id);
    return t;
  }
  // other Microsoft Office files open in Office; every other file opens here as plain text
  if (/\.(ppt|pot|pps|vsdx?|vsdm|one|onepkg|accdb|mdb|mpp|pub|msg|oft)$/i.test(path)) {
    api.openPath(path).catch((e) => toast(e.message, "err"));
    return null;
  }
  const busy = loading(`Opening ${basename(path)}…`, { delay: 220 });
  try {
    const info = await call("path_info", { path }).catch(() => null);
    if (info?.size > 64 * 1024 * 1024 && k === "text") {
      busy.done();
      const r = await ask({ title: `${basename(path)} is large`, text: `This file is ${(info.size / 1048576).toFixed(0)} MB. Opening it as text may be slow. Open it anyway, or with its usual app?`, buttons: [{ label: "Cancel", value: null }, { label: "Default app", value: "ext" }, { label: "Open here", value: "open", primary: true }] });
      if (r === "ext") { api.openPath(path).catch((e) => toast(e.message, "err")); return null; }
      if (r !== "open") return null;
    }
    if (info?.size > 2 * 1024 * 1024) busy.text(`Opening ${basename(path)}…`, `${(info.size / 1048576).toFixed(1)} MB`);
    const { text, mtime, encoding, eol } = await readTextFile(path);
    busy.done();
    // a binary file of a type Callio doesn't know: don't show it as garbage text
    if (k === "text" && text.slice(0, 65536).includes("\u0000")) {
      const r = await ask({ title: `${basename(path)} isn't a text file`, text: "Callio can't show this kind of file. Open it with its usual app instead?", buttons: [{ label: "Cancel", value: null }, { label: "Show as text anyway", value: "text" }, { label: "Open with default app", value: "ext", primary: true }] });
      if (r === "ext") { api.openPath(path).catch((e) => status(e.message, "err")); return null; }
      if (r !== "text") return null;
    }
    const t = newTab({ path, text, kind: k, mtime, encoding, eol });
    t.pinned = wasPinned(path);
    if (k === "text" && text.includes("\u0000")) toast(`${basename(path)} is shown as text; saving it from Callio may damage it.`, "warn", 7000);
    else if (!/^utf/.test(encoding)) toast(`${basename(path)} isn't Unicode; it was opened as ${encodingName(encoding)} and will be saved the same way. If letters look wrong, pick its encoding in the status bar.`, "", 7000);
    addRecent(path);
    await activate(t.id);
    if (line) gotoLine(line);
    return t;
  } catch (e) {
    busy.done();
    status(`Couldn't open ${basename(path)}: ${e.message}`, "err");
    return null;
  }
}

// ---------------- archives and programs ----------------
async function openArchive(path) {
  const name = basename(path);
  const info = await call("path_info", { path }).catch(() => null);
  const size = info?.size ? ` (${info.size > 1048576 ? (info.size / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(info.size / 1024)) + " KB"})` : "";
  const go = await ask({ title: "Extract this archive?", text: `${name}${size} is a compressed archive. Extract it into a folder next to it?`, buttons: [{ label: "No", value: null }, { label: "Yes, extract…", value: "yes", primary: true }] });
  if (!go) return;
  let list = [];
  try { list = await call("list_extractors"); } catch {}
  if (!list.length) return status("No extractor was found on this PC", "err");
  let last = null;
  try { last = localStorage.getItem("callio.extractor"); } catch {}
  list.sort((a, b) => (b.id === last) - (a.id === last));
  const pick = list.length === 1 ? list[0].id : await ask({ title: `Extract ${name} with…`, text: "Extractors installed on this PC:", vertical: true, buttons: [...list.map((x) => ({ label: x.name + (x.id === last ? "  — last used" : ""), value: x.id })), { label: "Cancel", value: null }] });
  if (!pick) return;
  try { localStorage.setItem("callio.extractor", pick); } catch {}
  const ex = list.find((x) => x.id === pick);
  const busy = loading(`Extracting ${name}…`, { delay: 0, detail: ex.name });
  try {
    const r = await call("extract_with", { archive: path, extractor: pick });
    if (r.finished) status(`Extracted ${name} into ${basename(r.dest)}`, "ok");
    else status(r.dest ? `${ex.name} is extracting ${name} into ${basename(r.dest)}` : `Opened ${name} in ${ex.name}`, "ok");
    if (folder && r.dest) { expanded.add(dirname(r.dest)); setTimeout(async () => { await refreshTree(); revealInTree(r.dest, true); }, r.finished ? 0 : 900); }
  } catch (e) { status(`Couldn't extract ${name}: ${e.message || e}`, "err"); }
  finally { busy.done(); }
}
async function confirmLaunch(path) {
  const name = basename(path);
  const ext = name.split(".").pop().toLowerCase();
  const kind = ext === "msi" || ext === "msix" || ext === "appx" ? "an installer" : ["bat", "cmd", "ps1", "vbs", "wsf", "js_"].includes(ext) ? "a script" : ext === "lnk" || ext === "url" ? "a shortcut" : "a program";
  const r = await ask({ title: `Run ${name}?`, text: `${name} is ${kind}. It will run outside Callio and can change your computer — only run it if you trust where it came from.`, buttons: [{ label: "Cancel", value: null }, { label: "Show in folder", value: "reveal" }, { label: "Run", value: "run", primary: true }] });
  if (r === "reveal") return api.revealPath(path);
  if (r !== "run") return;
  try { await call("launch_program", { path }); status(`Started ${name}`, "ok"); }
  catch (e) { status(`Couldn't start ${name}: ${e.message || e}`, "err"); }
}

async function closeTab(id) {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  if (id === activeId) stashActive();
  if (t.dirty) {
    const r = await ask({ title: "Unsaved changes", text: `Save changes to ${t.name}?`, buttons: [
      { label: "Cancel", value: null }, { label: "Don't save", value: "discard" }, { label: "Save", value: "save", primary: true }] });
    if (!r) return;
    if (r === "save" && !(await saveTab(t))) return;
  }
  if (t.kind === "doc" || t.kind === "sheet") import("./office.js").then((m) => m.closeDoc(t));
  if (t.kind === "doc") import("./word.js").then((m) => m.closeWord(t));
  if (t.kind === "deck") import("./deck.js").then((m) => m.closeDeck(t));
  if (t.kind === "image") { import("./image.js").then((m) => m.closeImage(t)); import("./viewer.js").then((m) => m.forgetPreview(t)); }
  if (t.kind === "media") import("./media.js").then((m) => m.closeMedia(t));
  if (t.kind === "drawio") import("./drawio.js").then((m) => m.closeDrawio(t));
  await tabOut($(`#tabs .tab[data-id="${id}"]`));
  const i = tabs.indexOf(t);
  if (i < 0) return;
  tabs.splice(i, 1);
  seenTabs.delete(id);
  if (activeId === id) {
    activeId = null;
    const n = tabs[Math.min(i, tabs.length - 1)];
    if (n) await activate(n.id);
    else { setState(createState("", "text")); onDocChanged(true); $("#st-path").textContent = ""; }
  }
  renderTabs();
}

async function saveTab(t, saveAs = false) {
  if (t.kind === "pdf") return savePdfTab(t, saveAs);
  if (t.kind === "sheet") return (await import("./sheet.js")).saveSheet(t, saveAs);
  if (t.kind === "doc") return (await import("./word.js")).saveWord(t, saveAs);
  if (t.kind === "deck") return (await import("./deck.js")).saveDeck(t, saveAs);
  if (t.kind === "image") return (await import("./image.js")).saveImage(t, saveAs);
  if (t.kind === "drawio") return (await import("./drawio.js")).saveDrawio(t, saveAs);
  if (t.id === activeId) stashActive();
  let path = t.path;
  if (!path || saveAs) {
    path = await api.pickSaveFile(t.name, folder || (t.path ? dirname(t.path) : null));
    if (!path) return false;
  }
  const raw = t.state.doc.toString();
  const toFile = () => (t.eol && t.eol !== "\n" ? raw.replace(/\n/g, t.eol) : raw);
  let text = toFile();
  const samePath = path === t.path;
  try {
    t.mtime = await api.writeText(path, text, t.encoding, samePath ? t.mtime : 0);
  } catch (e) {
    if (/^UNMAPPABLE:/.test(e.message)) {
      const ch = e.message.slice(11);
      const r = await ask({ title: `Can't save as ${encodingName(t.encoding)}`, text: `${t.name} contains “${ch}” (U+${(ch.codePointAt(0) || 0).toString(16).toUpperCase().padStart(4, "0")}), which ${encodingName(t.encoding)} can't store.\n\nSave it as UTF-8 instead? (Every character fits in UTF-8.)`, buttons: [{ label: "Cancel", value: null }, { label: "Save as UTF-8", value: "utf8", primary: true }] });
      if (!r) return false;
      t.encoding = "utf8";
      if (t.id === activeId) updateCodeTools(t);
      return saveTab(t, saveAs);
    }
    if (e.message !== "CHANGED_ON_DISK") { toast(`Save failed: ${e.message}`, "err"); return false; }
    const r = await ask({ title: "File changed on disk", text: `${t.name} was changed by another program or an Overleaf sync since you opened it.`,
      buttons: [{ label: "Cancel", value: null }, { label: "Reload from disk", value: "reload" }, { label: "Overwrite", value: "overwrite", primary: true }] });
    if (r === "overwrite") {
      try { t.mtime = await api.writeText(path, text, t.encoding, 0); } catch (e2) { toast(`Save failed: ${e2.message}`, "err"); return false; }
    } else {
      if (r === "reload") { t.dirty = false; await reloadFromDisk([t.path], true); }
      return false;
    }
  }
  const renamed = path !== t.path;
  t.path = path; t.name = basename(path); t.saved = raw; t.dirty = false; t.metaDirty = false;
  text = raw;
  historyRecord(t, text, "Saved", "save");
  if (renamed) {
    const k = kindOf(path);
    if (k !== t.kind) { t.kind = k; if (k === "csv") t.delim = detectDelimiterFor(text, path); t.state = createState(text, k, { delim: t.delim }); if (t.id === activeId) { setState(t.state); activeId = null; await activate(t.id); } if (["json", "xml", "yaml", "text", "html"].includes(k)) loadLanguage(path).then((ext) => ext && setTabLanguage(t, ext)); }
    addRecent(path);
    if (!folder) setFolder(dirname(path)); else refreshTree();
  }
  renderTabs();
  if (t.id === activeId) $("#st-path").textContent = path;
  return true;
}

export async function saveAll(filter = () => true) {
  for (const t of tabs) if (t.dirty && t.path && filter(t)) await saveTab(t);
}

export async function reloadFromDisk(paths, force = false, label = "Reloaded from disk") {
  const set = new Set(paths.map(norm));
  for (const t of tabs) {
    if (!t.path || !set.has(norm(t.path)) || (t.dirty && !force)) continue;
    try {
      const { text, mtime, encoding, eol } = await readTextFile(t.path, t.encodingChosen ? t.encoding : null);
      if (t.id === activeId) stashActive();
      if (t.dirty && !force) continue; // user typed while we were reading: keep their edits
      t.mtime = mtime; t.encoding = encoding; if (eol) t.eol = eol; t.metaDirty = false;
      if (text === t.state.doc.toString()) { t.saved = text; t.dirty = false; continue; }
      t.saved = text;
      // one named step, so Undo (and the Undo ▾ list) can take an AI's or a sync's change back
      if (t.id === activeId) {
        const v = getView();
        const spec = replaceDocAsStep(v.state, text, label);
        if (spec) v.dispatch(spec);
        t.state = v.state; t.dirty = false;
      } else {
        const spec = replaceDocAsStep(t.state, text, label);
        if (spec) t.state = t.state.update(spec).state;
        t.dirty = false;
      }
      window.dispatchEvent(new Event("callio-undo"));
    } catch {}
  }
  renderTabs();
}

// ---------------- recent ----------------
const getRecent = () => { try { return JSON.parse(localStorage.getItem("quire.recent") || "[]"); } catch { return []; } };
function addRecent(p) {
  const r = getRecent().filter((x) => norm(x) !== norm(p));
  r.unshift(p);
  try { localStorage.setItem("quire.recent", JSON.stringify(r.slice(0, 12))); } catch {}
  renderRecent();
}
function renderRecent() {
  const box = $("#recent");
  box.innerHTML = "";
  for (const p of getRecent().slice(0, 8)) {
    const el = document.createElement("div");
    el.className = "rc";
    el.innerHTML = `${fileBadge(p)}<span class="rc-name"></span><small></small>`;
    el.querySelector(".rc-name").textContent = basename(p);
    el.lastChild.textContent = dirname(p);
    el.onclick = () => openPath(p);
    box.appendChild(el);
  }
}

// ---------------- file tree ----------------
export let folder = null;
const expanded = new Set();
export function setFolder(f) {
  folder = f;
  expanded.clear();
  $("#folder-name").textContent = f ? basename(f) : "No folder";
  $("#folder-name").title = f || "";
  refreshTree();
  watchFolder(f);
  refreshProjectIndex();
  updateLink(f);
  window.dispatchEvent(new CustomEvent("callio-folder", { detail: f }));
}
let treeBusy = null, treeAgain = false;
/** Re-list the open folders and redraw the tree (selection, scroll and focus are kept). */
export async function refreshTree() {
  // one redraw at a time; changes arriving meanwhile cause one more pass
  if (treeBusy) { treeAgain = true; return treeBusy; }
  treeBusy = (async () => {
    do { treeAgain = false; await drawTree(); } while (treeAgain);
  })();
  try { await treeBusy; } finally { treeBusy = null; }
}
async function drawTree() {
  const tree = $("#tree");
  initTreeOps();
  if (!folder) { tree.innerHTML = `<div class="empty-note">Open a folder to see its files.</div>`; return; }
  const selected = new Set([...$$(".tree-item.sel")].map((x) => norm(x.dataset.path)));
  const focused = document.activeElement?.closest?.(".tree-item")?.dataset.path;
  const frag = document.createDocumentFragment();
  // the folder itself, on top: everything else hangs from it
  const root = document.createElement("div");
  root.className = "tree-item tree-root";
  root.dataset.path = folder;
  root.style.setProperty("--d", 0);
  root.style.paddingLeft = "8px";
  root.innerHTML = `<span class="twisty open">${ic("chevron-right")}</span>${fileBadge(folder, true)}<span class="nm"></span>`;
  root.querySelector(".nm").textContent = basename(folder) || folder;
  root.title = folder;
  root._it = { path: folder, name: basename(folder), isDir: true, root: true };
  root.tabIndex = -1;
  root.onclick = () => { for (const x of $$(".tree-item.sel")) x.classList.remove("sel"); root.classList.add("sel"); };
  root.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); treeMenu(e, null, root); };
  frag.appendChild(root);
  await renderDir(folder, 1, frag);
  const top = tree.scrollTop;
  tree.innerHTML = "";
  tree.appendChild(frag);
  tree.scrollTop = top;
  for (const el of $$(".tree-item", tree)) {
    if (selected.has(norm(el.dataset.path))) el.classList.add("sel");
    if (focused && el.dataset.path === focused) el.focus({ preventScroll: true });
  }
  highlightTree(false);
}
async function renderDir(dir, depth, into) {
  let items;
  try { items = await api.listDir(dir); } catch (e) { return; }
  items = items.filter((it) => !isHiddenName(it.name, it.isDir));
  items.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  // children of an open folder are listed in parallel, then put in order
  const subs = await Promise.all(items.map((it) => (it.isDir && expanded.has(it.path) ? (async () => { const f = document.createDocumentFragment(); await renderDir(it.path, depth + 1, f); return f; })() : null)));
  items.forEach((it, idx) => {
    const el = document.createElement("div");
    el.className = "tree-item" + (it.isDir ? " dir" : "");
    el.style.paddingLeft = 8 + depth * 14 + "px";
    el.style.setProperty("--d", depth);
    el.dataset.path = it.path;
    const open = expanded.has(it.path);
    el.innerHTML = `<span class="twisty${open ? " open" : ""}">${it.isDir ? ic("chevron-right") : ""}</span>${fileBadge(it.name, it.isDir)}<span class="nm"></span>`;
    el.querySelector(".nm").textContent = it.name;
    el.title = it.path;
    el._it = it;
    if (treeClip?.cut && treeClip.paths.includes(it.path)) el.classList.add("cut");
    el.onclick = async (e) => {
      if (el.querySelector("input.rename")) return;
      el.focus();
      // Ctrl-click: pick several (for copy, cut, delete, drag)
      if (e.ctrlKey || e.metaKey) { el.classList.toggle("sel"); return; }
      for (const x of $$(".tree-item.sel")) x.classList.remove("sel");
      el.classList.add("sel");
      if (it.isDir) {
        const under = () => [...$$(".tree-item")].filter((x) => norm(x.dataset.path).startsWith(norm(it.path) + "/"));
        if (expanded.has(it.path)) { expanded.delete(it.path); if (!reduced()) await Promise.all(under().slice(0, 40).map((x) => x.animate([{ opacity: 1 }, { opacity: 0, transform: "translateX(-6px)" }], { duration: 100, easing: "ease-in", fill: "forwards" }).finished.catch(() => {}))); await refreshTree(); }
        else { expanded.add(it.path); await refreshTree(); cascade(under()); }
      }
      else openPath(it.path);
    };
    el.tabIndex = -1;
    el.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); if (!el.classList.contains("sel")) { for (const x of $$(".tree-item.sel")) x.classList.remove("sel"); el.classList.add("sel"); } treeMenu(e, it, el); };
    // drag to move (Ctrl: copy). Pointer events: WebView2 gives HTML drag and drop to Tauri.
    el.onpointerdown = (e) => { if (e.button === 0 && !el.querySelector("input")) treeDragStart(e, it, el); };
    into.appendChild(el);
    if (subs[idx]) into.appendChild(subs[idx]);
  });
}

// the tree follows the disk: new, renamed, changed and deleted files show up at once
let fsUnlisten = null;
async function watchFolder(f) {
  try { await call("fs_watch", { path: f || null }); } catch {}
  if (fsUnlisten) return;
  fsUnlisten = await listen("fs-changed", (dirs) => {
    if (!folder || !Array.isArray(dirs)) return;
    const shown = new Set([norm(folder), ...[...expanded].map(norm)]);
    if (dirs.some((d) => shown.has(norm(d)))) refreshTree();
    window.dispatchEvent(new CustomEvent("callio-fs-changed", { detail: dirs }));
  }).catch(() => null);
}
// ---------------- file tree: right-click menu, clipboard, drag and drop, rename ----------------
let treeClip = null; // { paths, cut }
const relOf = (p) => (folder && norm(p).startsWith(norm(folder) + "/") ? p.replace(/\\/g, "/").slice(folder.replace(/\\/g, "/").replace(/\/$/, "").length + 1) : p);
const sep = () => (folder && folder.includes("\\") ? "\\" : "/");
const joinPath = (dir, name) => dir.replace(/[\\/]+$/, "") + sep() + name;
/** Selected tree items (Ctrl/Shift-click), or the one given. */
function treeSel(it) {
  const sel = [...$$(".tree-item.sel")].map((el) => el._it).filter(Boolean);
  return it && !sel.some((x) => x.path === it.path) ? [it] : sel.length ? sel : it ? [it] : [];
}
const dirOf = (it) => (!it ? folder : it.isDir ? it.path : dirname(it.path));

function treeMenu(e, it, el) {
  document.querySelector(".ctx-menu")?.remove();
  if (!folder) return;
  const items = treeSel(it), many = items.length > 1;
  const m = document.createElement("div");
  m.className = "menu ctx-menu";
  const B = (a, label, key = "", dis = false) => `<button data-a="${a}"${dis ? " disabled" : ""}><span>${label}</span><kbd>${key}</kbd></button>`;
  const hr = `<hr>`;
  m.innerHTML = [
    B("newfile", "New File…"), B("newfolder", "New Folder…"),
    hr,
    it && !it.isDir && !many ? B("open", "Open") + B("openext", "Open with Default App") : "",
    it && !it.isDir && !many && /\.pdf$/i.test(it.name) ? hr + B("toword", "Convert to Word to edit") + B("tomd", "Convert to Markdown to edit") + hr : "",
    B("reveal", "Reveal in File Explorer", "Shift+Alt+R"),
    B("terminal", "Open in Terminal"),
    hr,
    B("find", "Find in Folder…", "Shift+Alt+F"),
    B("chat", items.length && it ? (many ? `Add ${items.length} Items to Chat` : it.isDir ? "Add Folder to Chat" : "Add File to Chat") : "Add Folder to Chat"),
    hr,
    it ? B("cut", "Cut", "Ctrl+X") + B("copy", "Copy", "Ctrl+C") : "",
    B("paste", "Paste", "Ctrl+V", !treeClip),
    it && !many ? B("duplicate", "Duplicate") : "",
    hr,
    B("copypath", "Copy Path", "Shift+Alt+C"), B("copyrel", "Copy Relative Path"),
    it ? hr + (many ? "" : B("rename", "Rename", "F2")) + B("delete", many ? `Delete ${items.length} Items` : "Delete", "Del") : "",
  ].join("").replace(/(<hr>)+/g, "<hr>").replace(/^<hr>|<hr>$/g, "");
  document.body.appendChild(m);
  const h = m.offsetHeight;
  m.style.left = Math.min(e.clientX, innerWidth - m.offsetWidth - 8) + "px";
  m.style.top = Math.max(8, Math.min(e.clientY, innerHeight - h - 8)) + "px";
  const close = () => { m.remove(); document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", esc, true); };
  const away = (ev) => { if (!m.contains(ev.target)) close(); };
  const esc = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); close(); } };
  document.addEventListener("pointerdown", away, true);
  document.addEventListener("keydown", esc, true);
  m.onclick = (ev) => {
    const a = ev.target.closest("button:not([disabled])")?.dataset.a; if (!a) return;
    close();
    treeAction(a, it, el);
  };
}

async function treeAction(a, it, el) {
  const items = treeSel(it);
  const target = it || { path: folder, isDir: true, name: basename(folder) };
  try {
    switch (a) {
      case "newfile": case "newfolder": return await treeNew(dirOf(it), a === "newfolder");
      case "open": return openPath(it.path);
      case "openext": return await api.openPath(it.path);
      case "toword": return (await import("./convertactions.js")).pdfToWord(it.path);
      case "tomd": return (await import("./convertactions.js")).pdfToMarkdown(it.path);
      case "reveal": return await api.revealPath(target.path);
      case "terminal": return await call("open_terminal", { dir: dirOf(it) });
      case "find": return findInFolder(target.isDir ? target.path : dirname(target.path));
      case "chat": { const ai = await import("./ai.js"); for (const x of items.length ? items : [target]) await ai.addToChat(x.path, x.isDir); return; }
      case "cut": case "copy":
        treeClip = { paths: items.map((x) => x.path), cut: a === "cut" };
        for (const x of $$(".tree-item")) x.classList.toggle("cut", treeClip.cut && treeClip.paths.includes(x.dataset.path));
        return status(`${items.length > 1 ? items.length + " items" : basename(items[0].path)} ${a === "cut" ? "cut" : "copied"} — paste into a folder (Ctrl+V)`);
      case "paste": return await treePaste(dirOf(it));
      case "duplicate": { const to = await call("fs_duplicate", { root: folder, path: it.path }); await refreshTree(); return revealInTree(to, true); }
      case "copypath": return navigator.clipboard.writeText(items.length ? items.map((x) => x.path).join("\n") : folder).then(() => status("Path copied"));
      case "copyrel": return navigator.clipboard.writeText(items.length ? items.map((x) => relOf(x.path)).join("\n") : ".").then(() => status("Relative path copied"));
      case "rename": return startRename(it, el);
      case "delete": return await treeDelete(items);
    }
  } catch (er) { toast(er.message || String(er), "err", 7000); }
}

/** New file (any extension) or folder: typed right in the tree, like VS Code. */
async function treeNew(dir, isFolder) {
  if (!folder) return toast("Open a folder first", "warn");
  if (norm(dir) !== norm(folder) && !expanded.has(dir)) { expanded.add(dir); await refreshTree(); }
  const host = dir && norm(dir) !== norm(folder) ? [...$$(".tree-item")].find((x) => norm(x.dataset.path) === norm(dir)) : null;
  const depth = host ? (parseInt(host.style.paddingLeft) - 8) / 14 + 1 : 0;
  const row = document.createElement("div");
  row.className = "tree-item";
  row.style.paddingLeft = 8 + depth * 14 + "px";
  row.innerHTML = `<span class="twisty">${isFolder ? ic("chevron-right") : ""}</span><span class="fi"></span>`;
  const input = document.createElement("input");
  input.className = "rename";
  input.placeholder = isFolder ? "Folder name" : "File name with extension, e.g. notes.txt";
  row.appendChild(input);
  if (host) host.after(row); else $("#tree").prepend(row);
  row.scrollIntoView({ block: "nearest" });
  input.focus();
  let done = false;
  const finish = async (ok) => {
    if (done) return; done = true;
    const name = input.value.trim();
    row.remove();
    if (!ok || !name) return;
    try {
      const p = await call("fs_create", { root: folder, dir, name, folder: isFolder });
      if (isFolder) expanded.add(p);
      else await fillBlankOffice(p);
      await refreshTree();
      if (!isFolder) await openPath(p);
      revealInTree(p);
      status(`Created ${name}`, "ok");
    } catch (er) { toast(er.message || String(er), "err"); }
  };
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
  input.onblur = () => finish(true);
}

async function treePaste(dir) {
  if (!treeClip || !folder) return;
  const { paths, cut } = treeClip;
  if (cut) {
    await moveInto(paths, dir);
    treeClip = null;
  } else {
    const out = await call("fs_copy", { root: folder, paths, dest: dir });
    if (norm(dir) !== norm(folder)) expanded.add(dir);
    await refreshTree();
    revealInTree(out[0], true);
    status(`Pasted ${out.length > 1 ? out.length + " items" : basename(out[0])}`, "ok");
  }
}

/** Move (drag and drop / cut + paste) inside the open folder; open tabs follow their files. */
async function moveInto(paths, dir) {
  // a folder and something inside it both picked: moving the folder takes care of both
  const moving = paths.filter((p) => norm(dirname(p)) !== norm(dir) && !paths.some((q) => q !== p && norm(p).startsWith(norm(q) + "/")));
  if (!moving.length) return;
  // unsaved edits are saved first, so nothing is lost in the move
  for (const p of moving) for (const t of tabsUnder(p)) if (t.dirty && !(await saveTab(t))) return;
  const r = await call("fs_move", { root: folder, paths: moving, dest: dir });
  // tabs follow everything that did move, even when a later item failed
  for (const [from, to] of r.moved) await retargetTabs(from, to);
  if (norm(dir) !== norm(folder)) expanded.add(dir);
  await refreshTree();
  if (r.moved.length) { revealInTree(r.moved[0][1]); status(`Moved ${r.moved.length > 1 ? r.moved.length + " items" : basename(r.moved[0][0])} to ${basename(dir)}`, "ok"); }
  if (r.error) throw new Error(r.error);
}

async function treeDelete(items) {
  if (!items.length) return;
  const what = items.length > 1 ? `${items.length} items` : `“${items[0].name || basename(items[0].path)}”`;
  const r = await ask({ title: "Delete", text: `Move ${what} to the Recycle Bin? You can restore ${items.length > 1 ? "them" : "it"} from there.`, buttons: [{ label: "Cancel", value: null }, { label: "Move to Recycle Bin", value: "yes", primary: true }] });
  if (!r) return;
  const affected = items.flatMap((x) => tabsUnder(x.path));
  if (affected.some((t) => t.dirty)) {
    const k = await ask({ title: "Unsaved changes", text: "Some of these files are open with unsaved changes. They stay open as unsaved documents.", buttons: [{ label: "Cancel", value: null }, { label: "Delete anyway", value: "ok", primary: true }] });
    if (!k) return;
  }
  await call("fs_trash", { root: folder, paths: items.map((x) => x.path) });
  for (const t of affected) {
    if (t.dirty) { t.path = null; continue; }
    await closeTab(t.id);
  }
  renderTabs();
  await refreshTree();
  status(`Moved ${what} to the Recycle Bin`, "ok");
}

const tabsUnder = (p) => tabs.filter((t) => t.path && (norm(t.path) === norm(p) || norm(t.path).startsWith(norm(p) + "/")));
async function retargetTabs(fromPath, to) {
  const from = norm(fromPath);
  const isDir = !tabs.some((t) => t.path && norm(t.path) === from);
  for (const t of tabsUnder(fromPath)) {
    const rest = t.path.replace(/\\/g, "/").slice(from.length);
    t.path = to.replace(/\\/g, "/") + rest;
    if (to.includes("\\")) t.path = t.path.replace(/\//g, "\\");
    t.name = basename(t.path);
    t.mtime = await api.fileMtime(t.path).catch(() => 0);
    const k = kindOf(t.path);
    if (!isDir && k !== t.kind && t.kind !== "pdf" && k !== "pdf") { if (t.id === activeId) stashActive(); t.kind = k; t.state = createState(t.state.doc.toString(), k); if (t.id === activeId) setState(t.state); }
  }
  for (const e of [...expanded]) if (norm(e) === from || norm(e).startsWith(from + "/")) { expanded.delete(e); expanded.add(to + e.slice(fromPath.length)); }
  renderTabs();
  const t = activeTab(); if (t?.path) $("#st-path").textContent = t.path;
}
function revealInTree(p, select = false) {
  const el = [...$$(".tree-item")].find((x) => norm(x.dataset.path) === norm(p));
  if (!el) return;
  el.scrollIntoView({ block: "nearest" });
  if (select) { for (const x of $$(".tree-item.sel")) x.classList.remove("sel"); el.classList.add("sel"); el.focus(); }
}

// ---- Find in Folder ----
async function findInFolder(dir) {
  let dlg = $("#dlg-find-folder");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "dlg-find-folder";
    dlg.className = "find-folder";
    dlg.innerHTML = `<div class="ff-head"><b>Find in Folder</b> <span class="ff-dir note"></span><button class="icon ff-close" title="Close">${ic("x")}</button></div>
      <div class="ff-row"><input type="search" class="ff-q" placeholder="Text to find" spellcheck="false"><label class="chk"><input type="checkbox" class="ff-case"> Aa</label></div>
      <div class="ff-stat note"></div><div class="ff-list"></div>`;
    document.body.appendChild(dlg);
    dlg.querySelector(".ff-close").onclick = () => dlg.close();
    let tm = 0, seq = 0;
    const run = () => {
      clearTimeout(tm);
      tm = setTimeout(async () => {
        const q = dlg.querySelector(".ff-q").value, my = ++seq;
        const list = dlg.querySelector(".ff-list"), st = dlg.querySelector(".ff-stat");
        if (!q) { list.innerHTML = ""; st.textContent = ""; return; }
        st.textContent = "Searching…";
        try {
          const hits = await call("fs_find", { root: folder, dir: dlg._dir, query: q, case: dlg.querySelector(".ff-case").checked });
          if (my !== seq) return;
          const files = new Map();
          for (const h of hits) (files.get(h.path) || files.set(h.path, []).get(h.path)).push(h);
          st.textContent = hits.length ? `${hits.length}${hits.length >= 2000 ? "+" : ""} result${hits.length > 1 ? "s" : ""} in ${files.size} file${files.size > 1 ? "s" : ""}` : "No results";
          list.innerHTML = "";
          for (const [p, hs] of files) {
            const f = document.createElement("div");
            f.className = "ff-file";
            f.textContent = relOf(p);
            list.appendChild(f);
            for (const h of hs.slice(0, 50)) {
              const r = document.createElement("button");
              r.className = "ff-hit";
              const i = (dlg.querySelector(".ff-case").checked ? h.text : h.text.toLowerCase()).indexOf(dlg.querySelector(".ff-case").checked ? q : q.toLowerCase());
              r.innerHTML = `<span class="ff-ln">${h.line}</span><span class="ff-tx"></span>`;
              const tx = r.querySelector(".ff-tx");
              if (i >= 0) { tx.append(h.text.slice(0, i)); const mk = document.createElement("mark"); mk.textContent = h.text.slice(i, i + q.length); tx.append(mk, h.text.slice(i + q.length)); } else tx.textContent = h.text;
              r.onclick = () => openPath(h.path, h.line);
              list.appendChild(r);
            }
          }
        } catch (er) { if (my === seq) st.textContent = er.message || String(er); }
      }, 220);
    };
    dlg.querySelector(".ff-q").oninput = run;
    dlg.querySelector(".ff-case").onchange = run;
    dlg._run = run;
  }
  dlg._dir = dir;
  dlg.querySelector(".ff-dir").textContent = relOf(dir) === dir && norm(dir) === norm(folder) ? basename(dir) : relOf(dir);
  if (!dlg.open) dlg.show();
  const q = dlg.querySelector(".ff-q");
  const sel = getView()?.state.sliceDoc(getView().state.selection.main.from, getView().state.selection.main.to);
  if (sel && sel.length < 80 && !sel.includes("\n")) q.value = sel;
  q.focus(); q.select();
  dlg._run();
}

// ---- drag and drop (inside the tree) and drops from Explorer ----
function treeDragStart(e, it, el) {
  const x0 = e.clientX, y0 = e.clientY;
  let ghost = null, dir = null;
  const move = (ev) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      if (!el.classList.contains("sel")) { for (const x of $$(".tree-item.sel")) x.classList.remove("sel"); el.classList.add("sel"); }
      ghost = document.createElement("div");
      ghost.className = "tree-ghost";
      const n = treeSel(it).length;
      ghost.textContent = n > 1 ? `${n} items` : it.name;
      document.body.appendChild(ghost);
      document.body.classList.add("tree-dragging");
    }
    ghost.style.left = ev.clientX + 12 + "px"; ghost.style.top = ev.clientY + 8 + "px";
    ghost.classList.toggle("copy", ev.ctrlKey);
    const over = document.elementFromPoint(ev.clientX, ev.clientY);
    dir = $("#tree").contains(over) ? dropDirAt(over) : null;
    markDrop(dir);
  };
  const up = async (ev) => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    if (!ghost) return;
    ghost.remove();
    document.body.classList.remove("tree-dragging");
    markDrop(null);
    // the click that ends a drag must not open the item
    const stop = (c) => { c.stopPropagation(); c.preventDefault(); };
    window.addEventListener("click", stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
    if (!dir) return;
    const paths = treeSel(it).map((x) => x.path);
    try {
      if (ev.ctrlKey) { const out = await call("fs_copy", { root: folder, paths, dest: dir }); if (norm(dir) !== norm(folder)) expanded.add(dir); await refreshTree(); revealInTree(out[0], true); }
      else await moveInto(paths, dir);
    } catch (er) { toast(er.message || String(er), "err", 7000); }
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}
let treeOpsReady = false;
function dropDirAt(target) {
  const el = target?.closest?.(".tree-item");
  if (!el?._it) return folder;
  return el._it.isDir ? el._it.path : dirname(el._it.path);
}
function markDrop(dir) {
  for (const x of $$(".tree-item.drop")) x.classList.remove("drop");
  $("#tree").classList.toggle("drop-root", !!dir && norm(dir) === norm(folder));
  if (!dir || norm(dir) === norm(folder)) return;
  [...$$(".tree-item")].find((x) => norm(x.dataset.path) === norm(dir))?.classList.add("drop");
}
function initTreeOps() {
  if (treeOpsReady) return;
  treeOpsReady = true;
  const tree = $("#tree");
  tree.addEventListener("contextmenu", (e) => { if (!e.target.closest(".tree-item")) { e.preventDefault(); for (const x of $$(".tree-item.sel")) x.classList.remove("sel"); treeMenu(e, null, null); } });
  // keyboard on a focused item
  tree.addEventListener("keydown", (e) => {
    const el = e.target.closest?.(".tree-item"); const it = el?._it;
    if (!it || e.target.tagName === "INPUT") return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    const act = e.key === "F2" ? "rename" : e.key === "Delete" ? "delete" : mod && k === "c" ? "copy" : mod && k === "x" ? "cut" : mod && k === "v" ? "paste" : e.shiftKey && e.altKey && k === "r" ? "reveal" : e.shiftKey && e.altKey && k === "c" ? "copypath" : e.shiftKey && e.altKey && k === "f" ? "find" : e.key === "Enter" ? "enter" : null;
    if (!act) return;
    e.preventDefault(); e.stopPropagation();
    if (act === "enter") return el.click();
    treeAction(act, it, el);
  });
}
/** Files dropped from Explorer onto the file list: copied into the folder under the pointer. */
function explorerDrop(paths, pos) {
  if (!folder) return false;
  const tree = $("#tree"), r = tree.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const x = (pos?.x ?? -1) / dpr, y = (pos?.y ?? -1) / dpr;
  if (tree.offsetParent === null || x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
  const dir = dropDirAt(document.elementFromPoint(x, y));
  // dropped from inside the open folder itself: that's a move/no-op, not a copy
  const outside = paths.filter((p) => !(norm(p) === norm(folder) || norm(p).startsWith(norm(folder) + "/")));
  if (!outside.length) return true;
  call("fs_copy", { root: folder, paths: outside, dest: dir }).then(async (out) => {
    if (norm(dir) !== norm(folder)) expanded.add(dir);
    await refreshTree();
    revealInTree(out[0], true);
    status(`Copied ${out.length > 1 ? out.length + " items" : basename(out[0])} into ${basename(dir)}`, "ok");
  }).catch((er) => toast(er.message || String(er), "err", 7000));
  return true;
}
function explorerHover(pos) {
  if (!folder) return;
  const tree = $("#tree"), r = tree.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const x = (pos?.x ?? -1) / dpr, y = (pos?.y ?? -1) / dpr;
  markDrop(x >= r.left && x <= r.right && y >= r.top && y <= r.bottom ? dropDirAt(document.elementFromPoint(x, y)) : null);
}

function startRename(it, el) {
  const nm = el.querySelector(".nm");
  const input = document.createElement("input");
  input.className = "rename";
  input.value = it.name;
  nm.replaceWith(input);
  input.focus();
  const dot = it.isDir ? -1 : it.name.lastIndexOf(".");
  input.setSelectionRange(0, dot > 0 ? dot : it.name.length);
  let done = false;
  const finish = async (ok) => {
    if (done) return; done = true;
    const name = input.value.trim();
    if (!ok || !name || name === it.name) { input.replaceWith(nm); return; }
    // an open file with unsaved edits is saved first, so nothing is lost in the move
    const open = tabsUnder(it.path);
    for (const t of open) if (t.dirty && !(await saveTab(t))) { input.replaceWith(nm); return; }
    try {
      const to = await api.renamePath(it.path, name, folder || dirname(it.path));
      await retargetTabs(it.path, to);
      status(`Renamed to ${name}`, "ok");
    } catch (er) { toast(er.message, "err"); }
    refreshTree();
  };
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
  input.onblur = () => finish(true);
  input.onclick = (e) => e.stopPropagation();
}
/** Mark the active tab's file in the tree; on a tab switch, open its folders and scroll to it. */
function highlightTree(reveal = true) {
  const t = activeTab();
  let hit = null;
  for (const el of $$(".tree-item")) {
    const on = !!t?.path && norm(el.dataset.path) === norm(t.path);
    el.classList.toggle("active", on);
    if (on) hit = el;
  }
  if (!reveal || !t?.path || !folder) return;
  if (hit) { hit.scrollIntoView({ block: "nearest", behavior: reduced() ? "auto" : "smooth" }); return; }
  const f = norm(folder), p = norm(t.path);
  if (!p.startsWith(f + "/")) return;
  // open the folders down to the file, then show it
  const parts = t.path.replace(/\\/g, "/").slice(folder.replace(/\\/g, "/").replace(/\/$/, "").length + 1).split("/");
  let cur = folder.replace(/[\\/]+$/, "");
  let added = false;
  for (const part of parts.slice(0, -1)) { cur = cur + sep() + part; if (!expanded.has(cur)) { expanded.add(cur); added = true; } }
  if (added) refreshTree().then(() => { const el = [...$$(".tree-item")].find((x) => norm(x.dataset.path) === p); el?.scrollIntoView({ block: "nearest" }); });
}

let indexTimer;
export function refreshProjectIndex() {
  clearTimeout(indexTimer);
  indexTimer = setTimeout(async () => {
    const t = activeTab();
    const root = folder || (t?.path ? dirname(t.path) : null);
    if (!root) return;
    try { Object.assign(project, await api.scanProject(root)); } catch {}
  }, 400);
}

// ---------------- outline ----------------
function renderOutline() {
  const box = $("#outline");
  if ($("#side-outline").hidden) return;
  const t = activeTab();
  box.innerHTML = "";
  if (!t) return;
  if (t.kind === "pdf") return renderPdfOutline(box, t);
  const text = getView().state.doc.toString();
  const items = t.kind === "md" ? markdownOutline(text) : t.kind === "tex" ? texOutline(text) : [];
  if (!items.length) { box.innerHTML = `<div class="empty-note">No headings.</div>`; return; }
  const min = Math.min(...items.map((i) => i.level));
  for (const it of items) {
    const el = document.createElement("div");
    el.className = "outline-item";
    el.style.paddingLeft = 10 + (it.level - min) * 14 + "px";
    el.textContent = it.title;
    el.onclick = () => gotoLine(it.line);
    box.appendChild(el);
  }
}

async function renderPdfOutline(box, t) {
  const items = await getOutline();
  if (activeTab() !== t) return;
  box.innerHTML = "";
  if (!items.length) { box.innerHTML = `<div class="empty-note">This PDF has no bookmarks.</div>`; return; }
  for (const it of items) {
    const el = document.createElement("div");
    el.className = "outline-item";
    el.style.paddingLeft = 10 + it.level * 14 + "px";
    el.textContent = it.title;
    el.title = it.title;
    el.onclick = () => (it.dest ? goToDest(it.dest) : it.url && api.openUrl(it.url));
    box.appendChild(el);
  }
}

// ---------------- preview ----------------
let mdTimer, outlineTimer;
let citeTimer = 0;
function onDocChanged(immediate = false) {
  const t = activeTab();
  const mdEl = $("#md-preview"), pdfWrap = $("#pdf-wrap"), empty = $("#preview-empty"), nbEl = $("#nb-view"), txtEl = $("#txt-preview");
  txtEl.hidden = true;
  const isCsv = t?.kind === "csv", isStruct = ["json", "xml", "yaml"].includes(t?.kind);
  if (t?.kind !== "html") import("./html.js").then((h) => h.hideHtml());
  $("#csv-view").hidden = !isCsv;
  $("#struct-view").hidden = !isStruct;
  if (!isCsv && csvCtl) { csvCtl.destroy(); csvCtl = null; }
  if (!t) { mdEl.hidden = true; pdfWrap.hidden = true; nbEl.hidden = true; empty.hidden = false; return; }
  empty.hidden = true;
  nbEl.hidden = t.kind !== "ipynb";
  // an outside change (AI edit, reload, undo in the source) reaches the visual editor
  if (wys && wys.tab === t && wantVisual(t)) { clearTimeout(wysTimer); wysTimer = setTimeout(() => { if (wys?.tab === t) wys.ctl.update(getView().state.doc.toString()); }, immediate ? 0 : 120); }
  if (t.kind === "ipynb") {
    mdEl.hidden = true; pdfWrap.hidden = true;
    clearTimeout(mdTimer);
    mdTimer = setTimeout(() => showNotebook(t), immediate ? 0 : 250);
  } else if (t.kind === "html") {
    mdEl.hidden = true; pdfWrap.hidden = true;
    clearTimeout(mdTimer);
    const run = async () => {
      const h = await import("./html.js");
      if (activeTab() !== t) return;
      const host = h.htmlHost();
      if (!host.isConnected) $("#preview-pane").appendChild(host);
      h.showHtml(t, getView().state.doc.toString(), (text) => {
        // a visual edit: into the source as one undo step
        const v = getView();
        if (activeTab() !== t || v.state.doc.toString() === text) return;
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, userEvent: "input.visual" });
      });
    };
    if (immediate) run(); else mdTimer = setTimeout(run, 300);
  } else if (t.kind === "mermaid") {
    pdfWrap.hidden = true; mdEl.hidden = false;
    clearTimeout(mdTimer);
    const run = async () => {
      const m = mdMod || (await loadMd());
      if (activeTab() !== t) return;
      const text = getView().state.doc.toString();
      m.renderMarkdown(mdEl, "```mermaid\n" + text.replace(/```/g, "ˋˋˋ") + "\n```", t.path ? dirname(t.path) : "");
    };
    if (immediate) { mdEl.innerHTML = ""; run(); } else mdTimer = setTimeout(run, 250);
  } else if (t.kind === "md") {
    pdfWrap.hidden = true; mdEl.hidden = false;
    clearTimeout(mdTimer);
    const run = async () => {
      const m = mdMod || (await loadMd());
      if (activeTab() !== t) return;
      const text = getView().state.doc.toString();
      m.renderMarkdown(mdEl, text, t.path ? dirname(t.path) : "");
      updateMirror(t);
      if (settings.syncScroll) syncPreview();
      // [@key] citations: formatted with the chosen CSL style once typing pauses
      clearTimeout(citeTimer);
      if (text.includes("[@")) citeTimer = setTimeout(() => import("./cite.js").then(async (c) => { if (activeTab() === t) { await c.formatPreview(mdEl, text, t); m.relayoutPages(mdEl); } }).catch((e) => console.warn(e)), 500);
      if (immediate) m.layoutPages(mdEl);
    };
    if (immediate) { mdEl.innerHTML = ""; run(); } else mdTimer = setTimeout(run, 90);
  } else if (isCsv) {
    mdEl.hidden = true; pdfWrap.hidden = true;
    clearTimeout(mdTimer);
    if (!csvCtl || csvCtl.tab !== t) mountCsv(t);
    else mdTimer = setTimeout(() => csvCtl?.refresh(), immediate ? 0 : 90);
  } else if (isStruct) {
    mdEl.hidden = true; pdfWrap.hidden = true;
    clearTimeout(mdTimer);
    mdTimer = setTimeout(() => showStructTree(t), immediate ? 0 : 250);
  } else if (t.kind === "sheet" || t.kind === "doc" || t.kind === "deck" || t.kind === "image") {
    mdEl.hidden = true; pdfWrap.hidden = true;
  } else if (t.kind === "tex" || t.kind === "bib" || t.kind === "pdf") {
    mdEl.hidden = true; pdfWrap.hidden = false;
  } else {
    // any other file previews as its own text (never a PDF left over from another tab)
    mdEl.hidden = true; pdfWrap.hidden = true;
    txtEl.hidden = false;
    clearTimeout(mdTimer);
    const show = () => { if (activeTab() === t) { const top = txtEl.scrollTop; txtEl.textContent = getView().state.doc.toString(); txtEl.scrollTop = top; } };
    if (immediate) show(); else mdTimer = setTimeout(show, 200);
  }
  clearTimeout(outlineTimer);
  if (!VIEW_KINDS.has(t.kind)) outlineTimer = setTimeout(renderOutline, immediate ? 0 : 400);
  if (t.kind !== "sheet") import("./sheet.js").then((m) => m.hideSheet());
}
// ---------------- CSV/TSV tables, JSON/XML/YAML trees ----------------
let csvCtl = null, treeCtl = null;
const STRUCT_KINDS = new Set(["json", "xml", "yaml"]);
const previewScrolled = () => { cancelAnimationFrame(window.__pvsr); window.__pvsr = requestAnimationFrame(syncFromPreview); };
/** CSV opens as a table (or the view last chosen for CSV); everything else uses the chosen view. */
const viewFor = (t) => (t?.kind === "csv" ? settings.csvView || "preview" : settings.view);
function languageName(t) {
  const e = (t.path || t.name || "").toLowerCase().split(".").pop();
  return { js: "JavaScript", mjs: "JavaScript", ts: "TypeScript", tsx: "TypeScript", jsx: "JavaScript", py: "Python", html: "HTML", htm: "HTML", css: "CSS", scss: "SCSS", sql: "SQL", rs: "Rust", go: "Go", java: "Java", c: "C", cpp: "C++", cs: "C#", sh: "Shell", ps1: "PowerShell", toml: "TOML", ini: "INI", r: "R", php: "PHP", rb: "Ruby", lua: "Lua", txt: "Plain text" }[e] || "Plain text";
}
function editDispatch(t, { changes, text, label }) {
  if (t.id !== activeId) return;
  const v = getView();
  if (text !== undefined) { const spec = replaceDocAsStep(v.state, text, label); if (spec) v.dispatch(spec); }
  else v.dispatch({ changes, annotations: [stepLabel.of(label), isolateHistory.of("full")], userEvent: "input.table" });
}
async function mountCsv(t) {
  csvCtl?.destroy();
  csvCtl = null;
  const m = await import("./csvtable.js");
  if (activeTab() !== t || t.kind !== "csv") return;
  csvCtl = m.mountTable($("#csv-view"), {
    tab: t,
    getState: () => (activeTab() === t ? getView().state : t.state),
    dispatch: (spec) => editDispatch(t, spec),
    undo: (redo) => { undoSteps(1, redo, true); csvCtl?.refresh(); },
    toast: (msg) => toast(msg, "", 3000),
    onScroll: previewScrolled,
    onDelim: (d) => { if (activeTab() === t) getView().dispatch({ effects: languageEffect(csvLanguage(d)) }); $("#st-kind").textContent = d === "\t" ? "TSV" : "CSV"; },
    onCell: (pos) => {
      // in Split view the source follows the table
      if (settings.view === "editor" || viewFor(t) !== "split") return;
      const v = getView();
      csvFollowing = performance.now() + 300;
      v.dispatch({ selection: { anchor: Math.min(pos, v.state.doc.length) }, effects: CMView.scrollIntoView(Math.min(pos, v.state.doc.length), { y: "nearest" }) });
    },
  });
}
let csvFollowing = 0, csvRevealRaf = 0;
function csvFollowCursor(state) {
  if (!csvCtl || activeTab()?.kind !== "csv" || performance.now() < csvFollowing || viewFor(activeTab()) !== "split") return;
  if (!getView().hasFocus) return;
  cancelAnimationFrame(csvRevealRaf);
  csvRevealRaf = requestAnimationFrame(() => csvCtl?.reveal(state.selection.main.head));
}
async function showStructTree(t) {
  if (activeTab() !== t) return;
  const S = await import("./structured.js");
  if (!treeCtl) {
    const m = await import("./treeview.js");
    treeCtl = m.mountTree($("#struct-view"), {
      onPick: (from) => { if (settings.view === "preview") setView("split"); goToOffset(from); },
      lineCol: (pos) => S.lineCol(getView().state.doc.toString(), pos),
      toast: (msg) => status(msg, "ok"),
      onScroll: previewScrolled,
    });
  }
  const text = getView().state.doc.toString();
  const name = t.path || t.name;
  const comments = S.allowsComments(name) || /\.json5$/i.test(name);
  const lines = /\.(jsonl|ndjson)$/i.test(name);
  treeCtl.update(text, t.kind, async (x) => {
    if (x.length > 8_000_000) throw new Error("The file is too large for the tree view; use the source view.");
    if (t.kind === "yaml") return S.yamlTree(x);
    if (t.kind === "json" && !lines) S.validateJson(x, { comments });
    if (t.kind === "xml") return S.xmlTree(x);
    if (lines) {
      let pos = 0; const children = [];
      for (const ln of x.split("\n")) { if (ln.trim()) { const n = S.jsonTree(ln); const shift = (o) => { o.from += pos; o.to += pos; (o.children || []).forEach(shift); }; shift(n); n.key = children.length; children.push(n); } pos += ln.length + 1; }
      return { key: null, type: "array", from: 0, to: x.length, children };
    }
    return S.jsonTree(x, { comments });
  }, t.id);
}
/** Put the source cursor at `from` (and select to `to`). */
function goToOffset(from, to = from) {
  const v = getView();
  const len = v.state.doc.length;
  from = Math.min(from, len); to = Math.min(to, len);
  v.dispatch({ selection: { anchor: from, head: to }, effects: CMView.scrollIntoView(from, { y: "center" }) });
  v.focus();
}
/** Set cells of a CSV tab open in Callio (AI): { "B2": "x" } as one Undo step. */
export async function csvSetCells(t, cells, label) {
  const m = await import("./csvtable.js");
  if (activeTab() !== t) await activate(t.id);
  const v = getView();
  const model = m.parseCsv(v.state.doc.toString(), t.delim || ",");
  const byRow = new Map();
  for (const [ref, val] of Object.entries(cells || {})) {
    const mm = /^([A-Z]+)(\d+)$/i.exec(ref.trim());
    if (!mm) throw new Error(`"${ref}" isn't a cell like B2`);
    let c = 0; for (const ch of mm[1].toUpperCase()) c = c * 26 + ch.charCodeAt(0) - 64;
    c--; const r = +mm[2] - 1;
    if (!byRow.has(r)) byRow.set(r, [...(model.rows[r]?.cells || [])]);
    const row = byRow.get(r); while (row.length <= c) row.push(""); row[c] = String(val);
  }
  const lines = model.rows.map((r) => v.state.doc.sliceString(r.from, r.to));
  for (const [r, cellsOf] of byRow) { while (lines.length <= r) lines.push(""); lines[r] = m.rowText(cellsOf, t.delim || ",", model.quoteAll); }
  const spec = replaceDocAsStep(v.state, lines.join("\n") + (model.trailing || !lines.length ? "\n" : ""), label);
  if (spec) v.dispatch(spec);
  return byRow.size;
}
function initStructured() {
  api.systemAnsi().then(setAnsi).catch(() => {});
  setCheckName(() => { const t = activeTab(); return t ? t.path || t.name : ""; });
  onLint((list) => showProblems(list));
  initCodeTools({
    activeTab, getView, toast, status, ask,
    text: (t) => tabText(t),
    defaultIndent: () => settings.tabSize || 2,
    applyIndent: (t) => { if (t.id === activeId) setIndent(t.indent); },
    replaceText: (t, text, label) => {
      if (t.id !== activeId) return;
      const v = getView();
      const spec = replaceDocAsStep(v.state, text, label);
      if (spec) v.dispatch(spec);
    },
    goto: (from, to) => { if (settings.view === "preview" && activeTab()?.kind !== "csv") setView("split"); goToOffset(from, to ?? from); },
    markMeta: (t, label) => { t.metaDirty = true; t.dirty = true; renderTabs(); status(`${label} — saved with the file`, "ok"); if (settings.autoSave && t.path) saveTab(t); },
    reopen: async (t, enc) => {
      if (!t.path) { t.encoding = enc; updateCodeTools(t); return; }
      if (t.dirty) {
        const r = await ask({ title: "Reopen with another encoding?", text: `${t.name} has unsaved changes. Reopening it as ${encodingName(enc)} reads the file again from disk.`, buttons: [{ label: "Cancel", value: null }, { label: "Reopen", value: "ok", primary: true }] });
        if (!r) return;
      }
      try {
        const { text, mtime, encoding, eol } = await readTextFile(t.path, enc);
        t.encoding = encoding; t.encodingChosen = true; t.mtime = mtime; if (eol) t.eol = eol;
        if (t.id === activeId) { const v = getView(); const spec = replaceDocAsStep(v.state, text, `Reopened as ${encodingName(enc)}`); if (spec) v.dispatch(spec); }
        t.saved = text; t.dirty = false; t.metaDirty = false;
        renderTabs(); updateCodeTools(t);
        status(`Reopened as ${encodingName(enc)}`, "ok");
      } catch (e) { toast(`Couldn't reopen: ${e.message}`, "err"); }
    },
  });
}

// ---------------- visual editing + formatting bar (Markdown, LaTeX) ----------------
let visualMod = null;
async function loadVisual() {
  if (visualMod) return visualMod;
  visualMod = await import("./visual.js");
  visualMod.setVisualContext({ dir: () => { const t = activeTab(); return t?.path ? dirname(t.path) : folder || ""; } });
  return visualMod;
}
// Visual mode = the Word-like editor (src/wysiwyg) in place of the source editor; the source
// stays the tab's text (saving, history, AI, diff review all work on it) and is kept in sync.
let wys = null, wysTimer = 0; // { tab, ctl }
const wantVisual = (t) => !!t && (t.kind === "md" || t.kind === "tex") && settings.visualEditor === true && !t.sourceOnly;
async function syncVisualMode(t = activeTab()) {
  const on = wantVisual(t);
  $("#editor-pane").classList.toggle("wysiwyg-on", on);
  $("#fmt-bar").classList.toggle("visual-mode", on);
  const btn = $("#fmt-bar [data-fmt=visual]");
  btn.classList.toggle("on", on);
  btn.innerHTML = on ? `${ic("code")}<span>Source</span>` : `${ic("eye")}<span>Visual</span>`;
  btn.title = on ? "Edit the Markdown/LaTeX source" : "Visual editing: edit like in Word — headings, tables, math, figures and citations as they look";
  if (!on) { if (wys) { wys.ctl.flush(); } updateMirror(t); return; }
  const host = $("#wysiwyg-host");
  const text = getView().state.doc.toString();
  if (wys?.tab === t) { wys.ctl.update(text); updateMirror(t); return; }
  wys?.ctl.flush(); wys?.ctl.destroy();
  wys = null;
  host.innerHTML = `<div class="wys-loading"><span class="big-spinner"></span></div>`;
  let mod;
  try { mod = await import("./wysiwyg/index.js"); } catch (e) { toast(`The visual editor couldn't load: ${e.message}`, "err"); return; }
  if (activeTab() !== t || !wantVisual(t)) return;
  host.innerHTML = "";
  const ctl = mod.mountVisual(host, {
    kind: t.kind, text, dir: t.path ? dirname(t.path) : folder || "", fileSrc,
    onChange: (next) => {
      if (activeTab() !== t) { t.state = t.state.update({ changes: { from: 0, to: t.state.doc.length, insert: next } }).state; t.dirty = next !== t.saved; renderTabs(); return; }
      const v = getView(), cur = v.state.doc.toString();
      if (cur === next) return;
      let a = 0; const max = Math.min(cur.length, next.length);
      while (a < max && cur.charCodeAt(a) === next.charCodeAt(a)) a++;
      let b = 0;
      while (b < max - a && cur.charCodeAt(cur.length - 1 - b) === next.charCodeAt(next.length - 1 - b)) b++;
      v.dispatch({ changes: { from: a, to: cur.length - b, insert: next.slice(a, next.length - b) }, userEvent: "input.visual" });
    },
    onCite: () => import("./cite.js").then((m) => m.openCitePopup({ insert: (key) => wys?.ctl.insertCitation?.([key]) })),
    onScroll: (line) => syncFromSource(line),
    pickImage: () => api.pickImage(t.path ? dirname(t.path) : folder),
  });
  wys = { tab: t, ctl };
  requestAnimationFrame(() => ctl.focus?.());
  updateMirror(t);
}
function initFormatBar() {
  const bar = $("#fmt-bar");
  bar.addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); }); // keep the editor's selection
  bar.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-fmt]");
    if (!b || b.tagName === "SELECT") return;
    const t = activeTab();
    if (!t || (t.kind !== "md" && t.kind !== "tex")) return;
    const act = b.dataset.fmt;
    if (act === "visual") {
      const on = !wantVisual(t);
      if (on) { t.sourceOnly = false; if (settings.visualEditor !== true) updateSettings({ visualEditor: true }); }
      else { wys?.ctl.flush(); if (settings.visualEditor === true) updateSettings({ visualEditor: false }); }
      await syncVisualMode(t);
      status(on ? "Visual editing — like a word processor; “</> Source” shows the Markdown/LaTeX" : "Source editing");
      if (!on) getView().focus();
      return;
    }
    if (act === "cite") return import("./cite.js").then((m) => m.openCitePopup(wantVisual(t) ? { insert: (key) => wys?.ctl.insertCitation?.([key]) } : {}));
    const v = await loadVisual();
    const extra = {};
    if (act === "link") {
      const url = await ask({ title: "Insert link", text: "Web address:", input: "https://" });
      if (!url) return getView().focus();
      extra.url = url.trim();
    }
    if (act === "image") {
      const p = await api.pickImage(t.path ? dirname(t.path) : folder);
      if (!p) return getView().focus();
      extra.path = p;
    }
    await v.format(getView(), t.kind, act, extra);
    getView().focus();
  });
  bar.querySelector("[data-fmt=heading]").addEventListener("change", async (e) => {
    const t = activeTab();
    if (!t) return;
    const v = await loadVisual();
    await v.format(getView(), t.kind, e.target.value);
    e.target.value = "";
    getView().focus();
  });
}

// ---------------- Jupyter notebooks ----------------
let nbShowing = null; // { tab, ctl }
async function showNotebook(t) {
  if (activeTab() !== t) return;
  const nb = await import("./notebook.js");
  if (activeTab() !== t) return;
  const text = getView().state.doc.toString();
  if (nbShowing?.tab === t) return nbShowing.ctl.update(text);
  nbShowing?.ctl.flush();
  const ctl = nb.mountNotebook($("#nb-view"), text, {
    dir: t.path ? dirname(t.path) : "",
    onChange: (next) => {
      if (activeTab() !== t) {
        // committed after a tab switch: write it into that tab's own stored state
        t.state = t.state.update({ changes: { from: 0, to: t.state.doc.length, insert: next } }).state;
        t.dirty = next !== t.saved; renderTabs();
        return;
      }
      // smallest edit, so undo in the JSON stays meaningful
      const v = getView(), cur = v.state.doc.toString();
      let a = 0; const max = Math.min(cur.length, next.length);
      while (a < max && cur.charCodeAt(a) === next.charCodeAt(a)) a++;
      let b = 0;
      while (b < max - a && cur.charCodeAt(cur.length - 1 - b) === next.charCodeAt(next.length - 1 - b)) b++;
      v.dispatch({ changes: { from: a, to: cur.length - b, insert: next.slice(a, next.length - b) } });
    },
    onRaw: () => {
      t.nbRaw = !t.nbRaw;
      $("#app").classList.toggle("nb-mode", !t.nbRaw);
      if (t.nbRaw && settings.view !== "split") setView("split");
    },
  });
  nbShowing = { tab: t, ctl };
}

// ---------------- scrolling the editor and the preview together (split view) ----------------
// Markdown: by source line. LaTeX: through SyncTeX (editor line ↔ PDF position). Works the same
// from the source editor and the visual editor; whichever side you scroll leads.
// The side you scroll leads; the other side glides after it (animated, so it never jumps).
// While one side leads, scroll events from the follower (caused by the glide) are ignored.
let syncLeader = null, syncLeaderUntil = 0;
const syncOn = () => settings.syncScroll !== false && viewFor(activeTab()) === "split";
function claimSync(side) {
  const now = performance.now();
  if (side !== syncLeader && now < syncLeaderUntil) return false;
  syncLeader = side; syncLeaderUntil = now + 250;
  return true;
}
const holdSync = () => { syncLeaderUntil = Math.max(syncLeaderUntil, performance.now() + 120); };
const releaseSync = () => { syncLeaderUntil = 0; };
/** Animate `el.scrollTop` towards `target` (re-aimed on every call while moving). */
function glideTo(el, target) {
  if (!el) return;
  target = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, target));
  const a = el._glide || (el._glide = { raf: 0 });
  a.target = target;
  if (Math.abs(target - el.scrollTop) > el.clientHeight * 4) { el.scrollTop = target; } // far away: jump
  if (a.raf) return;
  const step = () => {
    holdSync();
    const cur = el.scrollTop, d = a.target - cur;
    if (Math.abs(d) < 0.75) { el.scrollTop = a.target; a.raf = 0; return; }
    el.scrollTop = cur + d * 0.3;
    if (el.scrollTop === cur) { a.raf = 0; return; } // can't move (end of the page)
    a.raf = requestAnimationFrame(step);
  };
  a.raf = requestAnimationFrame(step);
}
function visualActive(t = activeTab()) { return !!(wys && wys.tab === t && wantVisual(t)); }

// LaTeX: SyncTeX answers cached per compiled PDF; one request in flight, the latest line next
// (a new Map per build: an answer still on its way from the previous PDF lands in the old one)
const texCache = { pdf: "", fwd: new Map(), inv: new Map() };
function texCacheFor(pdf) { if (texCache.pdf !== pdf) { texCache.pdf = pdf; texCache.fwd = new Map(); texCache.inv = new Map(); } return texCache; }
let texFwdBusy = false, texFwdNext = null, texInvBusy = false, texInvNext = null;
// The whole line ↔ PDF map at once (one SyncTeX read per compile): scrolling then interpolates
// between neighbouring lines in scroll space — through the gap between two pages too — so the
// PDF moves continuously instead of jumping from page to page. Lines that LaTeX moved out of
// order (floats, footnotes) are left out, so the map only ever goes forward.
const texMap = { key: "", anchors: null, loading: null };
let pdfGen = 0; // +1 per compile: the map is read again
function texAnchors(t) {
  const key = `${lastPdfPath}|${t.path}|${pdfGen}`;
  if (texMap.key === key) return texMap.anchors || texMap.loading;
  texMap.key = key; texMap.anchors = null;
  texMap.loading = call("synctex_lines", { pdf: lastPdfPath, file: t.path }).then((raw) => {
    // TeX sets a paragraph when it reaches the blank line after it, so the paragraph's lines
    // are filed under that blank line: give them back to the paragraph's first line
    const doc = (t === activeTab() ? getView().state : t.state).doc;
    const byLine = new Map();
    for (const [line, page, y] of raw || []) {
      let l = line;
      if (l <= doc.lines && !doc.line(l).text.trim()) {
        let q = l - 1;
        while (q >= 1 && doc.line(q).text.trim() && !/^\s*\\(begin|end|section|subsection|chapter|item|\[)/.test(doc.line(q).text)) q--;
        if (q + 1 < l) l = q + 1;
      }
      const k = page * 1e5 + y, cur = byLine.get(l);
      if (!cur || k < cur.k) byLine.set(l, { line: l, page, y, k });
    }
    const a = [...byLine.values()].sort((x, y) => x.line - y.line);
    // longest non-decreasing run by position (patience sorting)
    const tails = [], prev = new Array(a.length), at = [];
    a.forEach((x, i) => {
      let lo = 0, hi = tails.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (a[tails[m]].k <= x.k) lo = m + 1; else hi = m; }
      prev[i] = lo ? tails[lo - 1] : -1;
      tails[lo] = i;
    });
    for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) at.push(a[i]);
    at.reverse();
    if (texMap.key === key) texMap.anchors = at;
    return at;
  }).catch(() => (texMap.key === key ? (texMap.anchors = []) : []));
  return texMap.loading;
}
const anchorTop = (g, a) => g[a.page - 1].top + a.y * g[a.page - 1].k;
/** PDF scroll position for (fractional) source line `line`, or null. */
function texLineToScroll(anchors, g, line) {
  if (!anchors?.length || !g) return null;
  anchors = anchors.filter((a) => g[a.page - 1]);
  if (!anchors.length) return null;
  let lo = 0, hi = anchors.length - 1;
  if (line <= anchors[0].line) return Math.max(0, anchorTop(g, anchors[0]) * Math.max(0, (line - 1) / Math.max(1, anchors[0].line - 1)));
  if (line >= anchors[hi].line) return anchorTop(g, anchors[hi]);
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (anchors[m].line <= line) lo = m; else hi = m; }
  const a = anchors[lo], b = anchors[hi];
  const f = (line - a.line) / (b.line - a.line);
  return anchorTop(g, a) + f * (anchorTop(g, b) - anchorTop(g, a));
}
/** Source line (fractional) for a PDF scroll position, or null. */
function texScrollToLine(anchors, g, top) {
  if (!anchors?.length || !g) return null;
  anchors = anchors.filter((a) => g[a.page - 1]);
  if (!anchors.length) return null;
  const tops = anchors.map((a) => anchorTop(g, a));
  if (top <= tops[0]) return Math.max(1, anchors[0].line * (tops[0] > 0 ? top / tops[0] : 1));
  const n = tops.length - 1;
  if (top >= tops[n]) return anchors[n].line;
  let lo = 0, hi = n;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tops[m] <= top) lo = m; else hi = m; }
  const span = tops[hi] - tops[lo];
  return anchors[lo].line + (span > 0 ? (top - tops[lo]) / span : 0) * (anchors[hi].line - anchors[lo].line);
}
const TEX_OFFSET = 24; // the line sits this far below the top of the PDF pane
async function texForward(t, line) {
  // the map, when there is one and the pages are stacked
  const anchors = await texAnchors(t);
  const g = anchors?.length ? pdfMod.pageGeometry?.() : null;
  if (g && activeTab() === t) {
    const top = texLineToScroll(anchors, g, line);
    if (top != null) { if (syncLeader === "editor") glideTo(pdfMod.scroller(), top - TEX_OFFSET); return; }
  }
  if (texFwdBusy) { texFwdNext = line; return; }
  texFwdBusy = true;
  try {
    const c = texCacheFor(lastPdfPath), n = Math.max(1, Math.floor(line)), frac = line - n;
    const fwd = c.fwd;
    const get = async (k) => { if (fwd.has(k)) return fwd.get(k); const r = await api.synctexForward(lastPdfPath, t.path, k).catch(() => null); if (r) fwd.set(k, r); return r; };
    const r0 = await get(n);
    if (r0 && activeTab() === t && syncLeader === "editor") {
      let y = r0.y;
      const r1 = frac > 0.05 ? await get(n + 1) : null;
      if (r1 && r1.page === r0.page && r1.y > r0.y) y = r0.y + frac * (r1.y - r0.y);
      const top = pdfMod.targetForPoint?.(r0.page, y, 24);
      if (top != null) glideTo(pdfMod.scroller(), top); else pdfMod.scrollToPoint(r0.page, y, 24);
    }
  } finally {
    texFwdBusy = false;
    if (texFwdNext != null) { const l = texFwdNext; texFwdNext = null; texForward(t, l); }
  }
}
async function texInverse(t) {
  const anchors = await texAnchors(t);
  const g = anchors?.length ? pdfMod.pageGeometry?.() : null;
  if (g && activeTab() === t) {
    const line = texScrollToLine(anchors, g, pdfMod.scroller().scrollTop + TEX_OFFSET);
    if (line != null) { if (syncLeader === "preview") editorGlideToLine(t, line); return; }
  }
  if (texInvBusy) { texInvNext = true; return; }
  texInvBusy = true;
  try {
    const p = pdfMod?.topPoint();
    if (!p) return;
    const c = texCacheFor(lastPdfPath), key = `${p.page}:${Math.round(p.y / 4)}`;
    const inv = c.inv;
    let r = inv.get(key);
    if (!r) { r = await api.synctexInverse(lastPdfPath, p.page, p.x, p.y + 6).catch(() => null); if (r) inv.set(key, r); }
    if (r && activeTab() === t && norm(r.file) === norm(t.path) && syncLeader === "preview") editorGlideToLine(t, r.line);
  } finally {
    texInvBusy = false;
    if (texInvNext) { texInvNext = null; texInverse(t); }
  }
}
function editorGlideToLine(t, line) {
  if (visualActive(t)) { holdSync(); wys.ctl.scrollToSourceLine?.(line); return; }
  const top = editorLineTop(line);
  if (top == null) scrollToLine(line); else glideTo(getView().scrollDOM, top);
}
// ---- the preview mirroring the visual editor (Markdown, split view) ----
const mirrorWanted = (t = activeTab()) => settings.mirrorPreview !== false && t?.kind === "md" && settings.view === "split" && visualActive(t) && !!wys?.ctl?.layoutInfo && !$("#md-preview").hidden;
function updateMirror(t = activeTab()) {
  const want = mirrorWanted(t);
  $("#md-toolbar [data-mdz=mirror]").hidden = !(t?.kind === "md" && visualActive(t));
  $("#md-toolbar [data-mdz=mirror]").classList.toggle("on", settings.mirrorPreview !== false);
  wys?.ctl?.setMirror?.(want);
  if (want) mirror.setMirror(() => wys.ctl.layoutInfo(), settings.mdZoom || 1);
  else mirror.setMirror(null);
}
mirror.onAligned((li) => {
  // level with the editor again (unless the reader is scrolling the preview right now)
  if (syncLeader === "preview" && performance.now() < syncLeaderUntil) return;
  holdSync(); syncLeader = "editor";
  $("#md-preview").scrollTop = mirror.toPreview(li.scroller.scrollTop);
});

/** The editor side moved to source line `line`. */
function syncFromSource(line) {
  const t = activeTab();
  if (t && mirror.mirroring() && settings.view === "split") {
    if (!claimSync("editor")) return;
    const vs = wys?.ctl?.layoutInfo?.().scroller;
    if (vs) $("#md-preview").scrollTop = mirror.toPreview(vs.scrollTop);
    return;
  }
  if (!t || !syncOn() || !claimSync("editor")) return;
  if (t.kind === "csv" && csvCtl) { glideTo(csvCtl.scroller, csvCtl.topFor(line)); return; }
  if (STRUCT_KINDS.has(t.kind) && treeCtl) {
    const doc = getView().state.doc, n = Math.max(1, Math.min(doc.lines, Math.floor(line))), l = doc.line(n);
    const next = n < doc.lines ? doc.line(n + 1).from : doc.length;
    glideTo(treeCtl.scroller, treeCtl.topForOffset(l.from + (line - n) * (next - l.from)));
    return;
  }
  if (t.kind === "md") {
    if (!mdMod || $("#md-preview").hidden) return;
    const el = $("#md-preview"), top = mdMod.previewTargetForLine?.(el, line);
    if (top != null) glideTo(el, top); else mdMod.scrollPreviewToLine(el, line);
  } else if (t.kind === "tex" && t.path && lastPdfPath && pdfMod?.hasPdf() && !$("#pdf-wrap").hidden) {
    texForward(t, line);
  }
}
/** The preview moved (the user scrolled it). */
function syncFromPreview() {
  const t = activeTab();
  if (t && mirror.mirroring() && settings.view === "split") {
    if (!claimSync("preview")) return;
    const vs = wys?.ctl?.layoutInfo?.().scroller;
    if (vs) vs.scrollTop = mirror.toEditor($("#md-preview").scrollTop);
    return;
  }
  if (!t || !syncOn() || !claimSync("preview")) return;
  if (t.kind === "csv" && csvCtl) { editorGlideToLine(t, csvCtl.topLine()); return; }
  if (STRUCT_KINDS.has(t.kind) && treeCtl) {
    const doc = getView().state.doc, pos = Math.min(doc.length, Math.round(treeCtl.topOffset()));
    const l = doc.lineAt(pos), next = l.number < doc.lines ? doc.line(l.number + 1).from : doc.length;
    editorGlideToLine(t, l.number + (next > l.from ? (pos - l.from) / (next - l.from) : 0));
    return;
  }
  if (t.kind === "md") {
    const el = $("#md-preview"), top = el.getBoundingClientRect().top + 4;
    const els = el.querySelectorAll("[data-line]");
    // the block at the top, and how far into it: a fractional source line
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (r.bottom <= top) continue;
      const l0 = +els[i].dataset.line, l1 = els[i + 1] ? +els[i + 1].dataset.line : l0 + 1;
      const f = r.height > 0 ? Math.min(1, Math.max(0, (top - r.top) / r.height)) : 0;
      editorGlideToLine(t, l0 + f * Math.max(0, l1 - l0));
      break;
    }
  } else if (t.kind === "tex" && t.path && lastPdfPath) {
    texInverse(t);
  }
}
/** Where the editor side is now (source line). */
const editorTopLine = (t = activeTab()) => (visualActive(t) ? wys.ctl.topSourceLine?.() ?? topVisibleLine() : topVisibleLine());

function syncPreview() {
  const t = activeTab();
  updateMirror(t);
  if (mirror.mirroring()) return; // re-aligned (and levelled) by the mirror
  if (!t || t.kind !== "md" || !syncOn()) return;
  syncLeader = "editor"; holdSync();
  const el = $("#md-preview");
  if (el._glide?.raf) { cancelAnimationFrame(el._glide.raf); el._glide.raf = 0; }
  mdMod?.scrollPreviewToLine(el, editorTopLine(t));
}

function setView(v, persist = true) {
  const app = $("#app");
  app.classList.remove("view-editor", "view-split", "view-preview");
  app.classList.add("view-" + v);
  for (const b of $$("#view-mode button")) b.classList.toggle("active", b.dataset.view === v);
  const t = activeTab();
  if (persist && t?.kind === "csv") { if (v !== settings.csvView) updateSettings({ csvView: v }); }
  else if (persist && v !== settings.view) updateSettings({ view: v });
  for (const b of $$("#view-mode button")) if (b.dataset.view === "preview") b.textContent = t?.kind === "csv" ? "Table" : t && ["json", "xml", "yaml"].includes(t.kind) ? "Tree" : "Preview";
  $("#preview-pane").style.flex = v === "split" ? `${settings.previewRatio} 1 0` : "1 1 0";
  $("#editor-pane").style.flex = v === "split" ? `${1 - settings.previewRatio} 1 0` : "1 1 0";
  try { updateMirror(); } catch {}
}

// ---------------- editor events ----------------
let autoSaveTimer, idleCompileTimer;
function onEdit() {
  const t = activeTab();
  if (!t) return;
  const v = getView();
  const dirty = !!t.metaDirty || v.state.doc.length !== t.saved.length || v.state.doc.toString() !== t.saved;
  if (dirty !== t.dirty) { t.dirty = dirty; renderTabs(); }
  onDocChanged();
  if (settings.autoSave && t.path) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => { if (t.dirty) saveTab(t); }, 1200);
  }
  if ((t.kind === "tex" || t.kind === "bib") && settings.autoCompile === "idle" && t.path) {
    clearTimeout(idleCompileTimer);
    idleCompileTimer = setTimeout(() => compile({ quiet: true }), 1600);
  }
}
let wordsTimer;
let aiCtxTimer;
function updateCursor(state) {
  csvFollowCursor(state);
  if (!$("#ai-panel").hidden) { clearTimeout(aiCtxTimer); aiCtxTimer = setTimeout(refreshAIContext, 250); }
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const sel = state.selection.main;
  $("#st-pos").textContent = `Ln ${line.number}, Col ${head - line.from + 1}` + (sel.empty ? "" : ` (${sel.to - sel.from} sel)`);
  clearTimeout(wordsTimer);
  wordsTimer = setTimeout(() => {
    const t = activeTab();
    let text = state.doc.toString();
    if (t?.kind === "tex") text = text.replace(/%.*$/gm, "").replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])?/g, " ").replace(/[{}$\\&_^]/g, " ");
    const n = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
    $("#st-words").textContent = `${n.toLocaleString()} words`;
  }, 250);
}

// ---------------- LaTeX compile ----------------
let compiling = false, compileQueued = false, lastPdfRoot = null, lastPdfPath = null, lastResult = null;
export const getLastCompile = () => lastResult;
const pdfByRoot = new Map();

async function rootFor(t) {
  if (!t?.path) return null;
  if (t.kind !== "tex" && t.kind !== "bib") return lastPdfRoot;
  try { return await api.findRoot(t.path); } catch { return t.path; }
}

export { saveTab, pdfByRoot, rootFor };
/** Compile now (after any running compile) and return that compile's result, or null. */
export async function compileFresh() {
  const wait = async () => { while (compiling) await new Promise((r) => setTimeout(r, 150)); };
  await wait();
  const before = lastResult;
  await compile({ quiet: true });
  await wait();
  return lastResult !== before ? lastResult : null;
}
export const getLastPdf = () => ({ root: lastPdfRoot, path: lastPdfPath });
export async function compile({ quiet = false } = {}) {
  const t = activeTab();
  if (!t) return;
  if (!t.path) { if (!(await saveTab(t))) return; }
  if (compiling) { compileQueued = true; return; }
  const root = await rootFor(t);
  if (!root) { if (!quiet) toast("Open a .tex file to compile.", "err"); return; }
  compiling = true;
  const btn = $("#btn-compile");
  btn.classList.add("busy"); btn.disabled = true;
  $("#compile-spinner").hidden = false;
  $("#pdf-wrap").classList.add("compiling");
  status("Compiling…");
  try {
    await saveAll((x) => x.kind === "tex" || x.kind === "bib" || x.kind === "text" || x.kind === "md");
    const res = await api.compile(root, settings.engine);
    if (res.updated?.length) await reloadFromDisk(res.updated);
    lastResult = res;
    applyDiagnostics(res);
    if (res.pdf) {
      const bytes = await api.readBinary(res.pdf);
      if (bytes) {
        if (activeTab()?.kind === "pdf") { pdfByRoot.set(norm(root), res.pdf); }
        else {
          const same = pdfShowing?.root && norm(pdfShowing.root) === norm(root);
          stashPdfView();
          // the PDF opens where the editor is (scrolling together), or where it was
          const follow = () => { if (syncOn() && activeTab()?.kind === "tex") { releaseSync(); syncFromSource(editorTopLine()); } };
          if (await loadPdf(new Uint8Array(bytes), same ? { keep: true, after: follow } : { view: texView.get(norm(root)), after: follow })) pdfShowing = { root };
        }
        $("#pdf-empty").hidden = true;
        lastPdfRoot = root; lastPdfPath = res.pdf; texCacheFor(""); pdfGen++; 
        pdfByRoot.set(norm(root), res.pdf);
      }
    }
    const errs = res.diagnostics.filter((d) => d.severity === "error").length;
    if (res.ok) hideCompileErrors(); else showCompileErrors(res, root);
    if (res.ok) status(`Compiled with ${res.engine} in ${(res.durationMs / 1000).toFixed(1)}s` + (errs ? ` · ${errs} error(s)` : ""), errs ? "err" : "ok");
    else {
      status(`Compile failed (${res.engine})`, "err");
      // the error list now sits where the PDF was; the log panel stays for the details
    }
  } catch (e) {
    status("Compile error", "err");
    const m = /^ENGINE_MISSING:(\w+):(.*)$/s.exec(e.message);
    if (m) {
      const [, kind, why] = m;
      status(why, "err");
      compiling = false;
      const r = await ask({
        title: `Install ${ENGINE_NAMES[kind]}?`,
        text: `${why} Callio can download and install ${ENGINE_NAMES[kind]} for you (${ENGINE_SIZES[kind]}, current user only, no admin rights).` +
          (kind === "tectonic" ? " Its first compile also fetches the packages your document uses." : " Missing LaTeX packages are then installed automatically when you compile."),
        buttons: [{ label: "Not now", value: null }, { label: "Install", value: "yes", primary: true }],
      });
      if (r && (await installEngine(kind))) setTimeout(() => compile(), 50);
    } else if (!(await handleSignInError(e))) toast(e.message, "err", 8000);
  } finally {
    compiling = false;
    btn.classList.remove("busy"); btn.disabled = false;
    $("#compile-spinner").hidden = true;
    $("#pdf-wrap").classList.remove("compiling");
    if (compileQueued) { compileQueued = false; compile({ quiet: true }); }
  }
}

function applyDiagnostics(res) {
  const byFile = new Map();
  for (const d of res.diagnostics) {
    if (!d.file) continue;
    const k = norm(d.file);
    if (!byFile.has(k)) byFile.set(k, []);
    byFile.get(k).push(d);
  }
  for (const t of tabs) {
    if (!t.path || (t.kind !== "tex" && t.kind !== "bib")) continue;
    const list = byFile.get(norm(t.path)) || [];
    if (t.id === activeId) { stashActive(); t.state = showDiagnostics(t.state, list); setState(t.state); }
    else t.state = showDiagnostics(t.state, list);
  }
  const errs = res.diagnostics.filter((d) => d.severity === "error").length;
  const warns = res.diagnostics.filter((d) => d.severity === "warning").length;
  const c = $("#log-count");
  c.textContent = errs || warns || "";
  c.className = "count " + (errs ? "err" : warns ? "warn" : "");
  renderLog(currentLogFilter);
}

let currentLogFilter = "all";
function renderLog(filter) {
  currentLogFilter = filter;
  for (const b of $$("#log-filter button")) b.classList.toggle("active", b.dataset.f === filter);
  const list = $("#log-list"), raw = $("#log-raw");
  raw.hidden = filter !== "raw"; list.hidden = filter === "raw";
  if (!lastResult) { list.innerHTML = `<div class="empty-note">No compile yet.</div>`; return; }
  raw.textContent = lastResult.log || "";
  list.innerHTML = "";
  const ds = lastResult.diagnostics.filter((d) => filter === "all" || d.severity === filter);
  if (!ds.length) list.innerHTML = `<div class="empty-note">${lastResult.ok ? "No problems. 🎉" : "No parsed messages; see Raw log."}</div>`;
  for (const d of ds) {
    const el = document.createElement("div");
    el.className = "log-item " + d.severity;
    el.innerHTML = `<div class="loc"></div><div class="msg"></div>`;
    el.firstChild.textContent = `${d.severity.toUpperCase()} · ${d.file ? basename(d.file) : "?"}${d.line ? ":" + d.line : ""}`;
    el.lastChild.textContent = d.message;
    el.onclick = (ev) => { if (ev.target.closest(".fix-btn")) return; if (d.file) openPath(d.file, d.line || 1); };
    if (d.severity === "error" && d.file) {
      const fx = document.createElement("button");
      fx.className = "fix-btn small"; fx.innerHTML = `${ic("sparkles")}<span>Fix</span>`; fx.title = "Let AI propose a fix (you review it)";
      fx.onclick = () => fixError(d);
      el.firstChild.appendChild(fx);
    }
    list.appendChild(el);
  }
}

// ---------------- a failed compile: the errors take the PDF's place ----------------
const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
let errorsRoot = null;
function showCompileErrors(res, root) {
  const box = $("#compile-errors");
  const errs = res.diagnostics.filter((d) => d.severity === "error");
  const warns = res.diagnostics.filter((d) => d.severity === "warning");
  errorsRoot = root;
  box.innerHTML = `<div class="ce-head"><div><b>Compile failed</b> <span class="note">${errs.length ? `${errs.length} error${errs.length === 1 ? "" : "s"}` : "no parsed errors — see the raw log"}${warns.length ? ` · ${warns.length} warning${warns.length === 1 ? "" : "s"}` : ""} · ${esc(res.engine || "")}</span></div>
    <div class="ce-actions">${hasPdf() ? `<button class="small" data-ce="pdf">Show the last PDF</button>` : ""}<button class="small" data-ce="raw">Raw log</button><button class="small primary" data-ce="again">Recompile</button></div></div><div class="ce-list"></div>`;
  const list = box.querySelector(".ce-list");
  const items = [...errs, ...warns.slice(0, 30)];
  if (!items.length) list.innerHTML = `<pre class="ce-raw">${esc((res.log || "").split("\n").slice(-60).join("\n"))}</pre>`;
  for (const d of items) {
    const el = document.createElement("div");
    el.className = "ce-item " + d.severity;
    el.innerHTML = `<div class="ce-loc"></div><div class="ce-msg"></div>`;
    el.firstChild.textContent = `${d.severity === "error" ? "✖" : "⚠"} ${d.file ? basename(d.file) : "?"}${d.line ? " : line " + d.line : ""}`;
    el.lastChild.textContent = d.message;
    el.title = d.file ? "Go to this line" : "";
    el.onclick = (ev) => { if (ev.target.closest(".fix-btn")) return; if (d.file) openPath(d.file, d.line || 1); };
    if (d.severity === "error" && d.file) {
      const fx = document.createElement("button");
      fx.className = "fix-btn small"; fx.innerHTML = `${ic("sparkles")}<span>Fix</span>`; fx.title = "Let AI propose a fix (you review it)";
      fx.onclick = () => fixError(d);
      el.firstChild.appendChild(fx);
    }
    list.appendChild(el);
  }
  box.onclick = (e) => {
    const a = e.target.closest("[data-ce]")?.dataset.ce;
    if (a === "pdf") hideCompileErrors();
    else if (a === "raw") { $("#log-panel").hidden = false; renderLog("raw"); }
    else if (a === "again") compile();
  };
  box.hidden = false;
  $("#pdf-empty").classList.add("under-errors");
}
function hideCompileErrors() {
  $("#compile-errors").hidden = true;
  $("#pdf-empty").classList.remove("under-errors");
  errorsRoot = null;
}

async function ensureTexPreview(t) {
  const root = await rootFor(t);
  if (!root) return;
  if (errorsRoot && norm(errorsRoot) !== norm(root)) hideCompileErrors();
  else if (!errorsRoot && lastResult && !lastResult.ok && lastPdfRoot && norm(lastPdfRoot) === norm(root)) showCompileErrors(lastResult, root);
  if (pdfShowing?.root && norm(pdfShowing.root) === norm(root) && hasPdf()) { lastPdfRoot = root; return; }
  const known = pdfByRoot.get(norm(root));
  if (known) {
    try {
      const bytes = await api.readBinary(known);
      stashPdfView();
      if (!(await loadPdf(new Uint8Array(bytes), { view: texView.get(norm(root)) }))) return;
      pdfShowing = { root };
      lastPdfRoot = root; lastPdfPath = known; $("#pdf-empty").hidden = true;
      return;
    } catch {}
  }
  stashPdfView();
  if (!clearPdf()) return;
  pdfShowing = null; $("#pdf-empty").hidden = !!pdfMod?.hasPdf(); lastPdfRoot = null; lastPdfPath = null;
  if (settings.compileOnOpen && settings.engine !== "overleaf") compile({ quiet: true });
}

async function forwardSync() {
  const t = activeTab();
  if (!t?.path || !lastPdfPath) return;
  try {
    const r = await api.synctexForward(lastPdfPath, t.path, cursorLine());
    if (r) showLocation(r.page, r.y, r.h);
    else status("No SyncTeX match for this line");
  } catch (e) { status(e.message, "err"); }
}

async function inverseSync(page, x, y) {
  if (!lastPdfPath || activeTab()?.kind === "pdf") return;
  try {
    const r = await api.synctexInverse(lastPdfPath, page, x, y);
    if (r) await openPath(r.file, r.line);
  } catch (e) { status(e.message, "err"); }
}

// ---------------- Overleaf link ----------------
export let link = null;
async function updateLink(path) {
  if (!path) return;
  try { link = await api.olLinkInfo(path); } catch { link = null; }
  $("#ol-tools").hidden = !link;
  if (link) { $("#ol-badge").textContent = "Overleaf: " + (link.name || link.projectId); $("#ol-badge").title = `${link.mode} sync · ${link.folder}`; }
  refreshOverleafPanel();
}
export async function olPull() {
  if (!link) return;
  await saveAll();
  status("Pulling from Overleaf…");
  try {
    const r = await api.olPull(link.folder);
    await reloadFromDisk(r.updated, false, "Overleaf pull");
    if (r.updated?.length) api.historyRecordDisk(r.updated, "Updated from Overleaf", "pull").catch(() => {});
    refreshTree();
    status(r.message, "ok");
    if (r.conflicts?.length) toast(`Conflicts kept locally; Overleaf versions saved next to them:\n${r.conflicts.map(basename).join(", ")}`, "err", 9000);
    else toast(r.message, "ok");
  } catch (e) { status("Pull failed", "err"); if (!(await handleSignInError(e))) toast(e.message, "err", 9000); }
}
export async function olPush() {
  if (!link) return;
  await saveAll();
  status("Pushing to Overleaf…");
  try {
    const r = await api.olPush(link.folder);
    if (r.updated?.length) { await reloadFromDisk(r.updated, false, "Overleaf pull"); refreshTree(); }
    status(r.message, r.conflicts?.length ? "err" : "ok"); toast(r.message, r.conflicts?.length ? "err" : "ok", r.conflicts?.length ? 9000 : 4200);
  } catch (e) { status("Push failed", "err"); if (!(await handleSignInError(e))) toast(e.message, "err", 9000); }
}
export function onLinked(l) { link = l; updateLink(l.folder); }

// ---------------- commands ----------------
async function cmdOpen() { const p = await api.pickOpenFile(); if (p) openPath(p); }
async function cmdFolder() { const p = await api.pickFolder(); if (p) { setFolder(p); settings.sidebar || updateSettings({ sidebar: true }); } }
const TEMPLATES = {
  md: "",
  tex: "\\documentclass{article}\n\\usepackage{amsmath}\n\n\\title{Untitled}\n\\author{}\n\n\\begin{document}\n\\maketitle\n\n\n\n\\end{document}\n",
  bib: "",
};
/** Starting text of new files, by extension. */
const NEW_TEXT = {
  md: "", txt: "", bib: "", tex: TEMPLATES.tex,
  csv: "Column A,Column B,Column C\n,,\n", tsv: "Column A\tColumn B\tColumn C\n\t\t\n",
  json: "{\n  \n}\n", xml: '<?xml version="1.0" encoding="UTF-8"?>\n<root>\n  \n</root>\n', yaml: "# YAML\nkey: value\n",
  html: '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>Untitled</title>\n  <style>\n    body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }\n  </style>\n</head>\n<body>\n  <h1>Untitled</h1>\n  <p>Start writing here.</p>\n</body>\n</html>\n',
  mmd: "flowchart TD\n    A[Start] --> B{Is it working?}\n    B -- Yes --> C[Great]\n    B -- No --> D[Fix it]\n    D --> B\n",
  ipynb: JSON.stringify({ cells: [{ cell_type: "markdown", metadata: {}, source: ["# Untitled notebook"] }, { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: [] }], metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" }, language_info: { name: "python" } }, nbformat: 4, nbformat_minor: 5 }, null, 1) + "\n",
};
const OFFICE_NEW = { docx: "Document", xlsx: "Workbook", pptx: "Presentation" };
/** A new, empty .docx/.xlsx/.pptx/.odt/.ods made in the file list gets a valid blank document. */
async function fillBlankOffice(p) {
  if (!/\.(docx|dotx|odt|rtf|xlsx|xltx|ods|pptx)$/i.test(p)) return;
  try { const { office } = await import("./office.js"); await office("office.blank", { out: p }); } catch (e) { toast(`${basename(p)} was created empty: ${e.message || e}`, "warn"); }
}
let untitledN = 0;
/** A free name like "Document 2.docx" in `dir`. */
async function freeName(dir, stem, ext) {
  for (let i = 1; i < 500; i++) {
    const name = `${stem}${i > 1 ? " " + i : ""}.${ext}`;
    const p = joinPath(dir, name);
    const info = await call("path_info", { path: p }).catch(() => null);
    if (!info?.exists) return p;
  }
  return joinPath(dir, `${stem} ${Date.now()}.${ext}`);
}
/** A new, unsaved tab with this text (OCR results, conversions). */
export async function openNewDoc(name, text, kind = "md") {
  const t = newTab({ text, kind });
  t.name = name;
  t.saved = ""; t.dirty = !!text;
  await activate(t.id);
  renderTabs();
  return t;
}
async function newFile(kind) {
  closeNewMenu();
  if (kind === "other" || kind === "folder") {
    const isFolder = kind === "folder";
    if (!folder && isFolder) return toast("Open a folder first (Open ▾ → Open folder…)", "warn");
    const name = (await ask({ title: isFolder ? "New folder" : "New file", text: isFolder ? `Folder name (in ${basename(folder)})` : folder ? `File name with its extension, e.g. notes.txt, script.py, data.csv — created in ${basename(folder)}` : "File name with its extension, e.g. notes.txt, script.py, data.csv", input: "" }))?.trim();
    if (!name) return;
    if (!folder) {
      const k = kindOf(name) === "pdf" ? "text" : kindOf(name);
      const t = newTab({ text: TEMPLATES[k] ?? "", kind: k });
      t.name = name;
      await activate(t.id); renderTabs();
      return;
    }
    try {
      const p = await call("fs_create", { root: folder, dir: folder, name, folder: isFolder });
      if (isFolder) expanded.add(p); else await fillBlankOffice(p);
      await refreshTree();
      if (!isFolder) await openPath(p);
      revealInTree(p, true);
    } catch (er) { toast(er.message || String(er), "err"); }
    return;
  }
  // a draw.io diagram: a real file in the open folder (or an unsaved tab without one)
  if (kind === "drawio") {
    const { blankDiagram } = await import("./drawio.js");
    if (!folder) {
      const t = newTab({ kind: "drawio", name: `Untitled-${++untitledN}.drawio` });
      t.newXml = blankDiagram();
      await activate(t.id); renderTabs();
      return;
    }
    const path = await freeName(folder, "Diagram", "drawio");
    try {
      await api.writeText(path, blankDiagram(), "utf8", 0);
      await refreshTree();
      await openPath(path);
      revealInTree(path, true);
    } catch (e) { toast(`Couldn't create ${basename(path)}: ${e.message || e}`, "err"); }
    return;
  }
  // Word, Excel and PowerPoint: a real (blank) file is made first, then opened
  if (OFFICE_NEW[kind]) {
    let path = folder ? await freeName(folder, OFFICE_NEW[kind], kind) : await api.pickSaveFile(`${OFFICE_NEW[kind]}.${kind}`, null);
    if (!path) return;
    const busy = loading(`Creating ${basename(path)}…`);
    try {
      const { office } = await import("./office.js");
      await office("office.blank", { out: path });
      if (folder) await refreshTree();
      await openPath(path);
      if (folder) revealInTree(path, true);
    } catch (e) { toast(`Couldn't create ${basename(path)}: ${e.message || e}`, "err"); }
    finally { busy.done(); }
    return;
  }
  const ext = kind === "yaml" ? "yaml" : kind;
  const name = `Untitled-${++untitledN}.${ext}`;
  const t = newTab({ text: NEW_TEXT[ext] ?? TEMPLATES[ext] ?? "", kind: kindOf(name), name });
  t.saved = ""; t.dirty = false;
  await activate(t.id);
  renderTabs();
  if (kind === "tex") gotoLine(11, 0, false);
}
function closeMenus() {
  for (const m of $$(".menu-wrap .menu")) m.hidden = true;
  for (const b of $$(".menu-wrap > button")) b.setAttribute("aria-expanded", "false");
}
const closeNewMenu = closeMenus;
function toggleMenu(btn, focusFirst = false) {
  const m = btn.parentElement.querySelector(".menu");
  const wasOpen = !m.hidden;
  closeMenus();
  if (wasOpen) return;
  m.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  if (focusFirst) m.querySelector("button").focus();
}
const toggleNewMenu = (focus) => toggleMenu($("#btn-new"), focus);
const MENU_ACTIONS = {
  "open-file": () => cmdOpen(),
  "open-folder": () => cmdFolder(),
  save: () => cmdSave(false),
  "save-as": () => cmdSave(true),
  "save-all": async () => { const n = tabs.filter((x) => x.dirty).length; await saveAll(); status(n ? `Saved ${n} file${n > 1 ? "s" : ""}` : "Everything is saved", "ok"); },
  "export-pdf": () => cmdExport(),
  "export-md": () => cmdExportMarkdown(),
  "convert-md": () => cmdExportMarkdown(true),
  "export-docx": () => cmdExportWord(),
  "pdf-tools": () => import("./pdftools.js").then((m) => m.openPdfTools(activeTab()?.kind === "pdf" ? activeTab().path : null)),
};
async function cmdExportWord() {
  stashActive();
  const t = activeTab();
  if (!t) return toast("Open a document first.", "", 3000);
  const o = await import("./office.js");
  if (t.kind === "doc") return o.exportDoc(t);
  if (t.kind === "sheet") return (await import("./sheet.js")).exportSheet(t);
  if (VIEW_KINDS.has(t.kind)) return toast("Use PDF tools → Convert for PDF files.", "", 4000);
  const fmt = await ask({ title: `Export ${t.name}`, text: "Save a copy as (math and citations come out as text; for the best PDF use Export as PDF):", vertical: true, buttons: [{ label: "Cancel", value: null }, { label: "Word document (.docx)", value: "docx" }, { label: "OpenDocument text (.odt)", value: "odt" }, { label: "Rich Text (.rtf)", value: "rtf" }, { label: "Web page (.html)", value: "html" }] });
  if (fmt) o.exportTextAs(t, fmt);
}
function openLibraryWindow() { import("./library.js").then((m) => m.openLibrary()); }
async function cmdExportMarkdown(pick = false) {
  stashActive();
  (await import("./export-md.js")).exportMarkdown(pick ? null : activeTab());
}
// ---------------- AutoSave (toolbar switch, like Word) ----------------
function initAutosave() {
  const cb = $("#autosave-cb");
  cb.checked = !!settings.autoSave;
  cb.onchange = async () => {
    updateSettings({ autoSave: cb.checked });
    status(cb.checked ? "AutoSave on — every change is saved as you work" : "AutoSave off", cb.checked ? "ok" : "");
    if (cb.checked) { for (const t of tabs) if (t.dirty && t.path) await saveTab(t); }
  };
}
let pdfAutoTimer = 0;
/** AutoSave for PDF edits: wait until nothing is being typed or dragged on the page. */
function schedulePdfAutosave() {
  clearTimeout(pdfAutoTimer);
  if (!settings.autoSave) return;
  pdfAutoTimer = setTimeout(async () => {
    const t = pdfShowing?.tab;
    if (!t?.dirty || !t.path || !settings.autoSave) return;
    const a = document.activeElement;
    if (a?.closest?.(".annotationEditorLayer, .q-textbox") && (a.isContentEditable || a.closest("[contenteditable=true]"))) return schedulePdfAutosave();
    if (document.querySelector("#pdf-wrap .q-dragging")) return schedulePdfAutosave();
    await savePdfTab(t, false, true);
  }, 2500);
}
async function cmdExport() {
  stashActive();
  const t = activeTab();
  if (!t) return toast("Open a Markdown or LaTeX file to export.", "", 3000);
  if (t.kind === "image") return (await import("./image.js")).exportImage(t);
  (await import("./export.js")).exportPdf(t);
}
function initMenus() {
  for (const wrap of $$(".menu-wrap")) {
    const btn = wrap.querySelector(":scope > button");
    const m = wrap.querySelector(".menu");
    btn.onclick = (e) => { e.stopPropagation(); toggleMenu(btn, e.detail === 0); };
    m.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      closeMenus();
      if (b.dataset.new) newFile(b.dataset.new);
      else MENU_ACTIONS[b.dataset.act]?.();
    });
    m.addEventListener("keydown", (e) => {
      const items = [...m.querySelectorAll("button")];
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === "Escape") { e.preventDefault(); closeMenus(); btn.focus(); }
    });
  }
  document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".menu-wrap")) closeMenus(); });
  // Esc closes an open menu even when it was opened with the mouse (focus still on its button)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !document.querySelector(".menu-wrap > .menu:not([hidden])")) return;
    e.preventDefault(); e.stopPropagation(); closeMenus();
  }, true);
  window.addEventListener("blur", closeMenus);
}
async function cmdSave(saveAs) {
  const t = activeTab();
  if (!t) return;
  if (t.kind === "pdf") {
    if (!t.dirty && !saveAs) return status(`${t.name} has no changes to save`, "ok");
    if (await saveTab(t, saveAs)) status(`Saved ${t.name}`, "ok");
    return;
  }
  const busy = ["doc", "sheet", "deck", "image"].includes(t.kind) ? loading(`Saving ${t.name}…`) : null;
  let ok = false;
  try { ok = await saveTab(t, saveAs); } finally { busy?.done(); }
  if (ok) status(`Saved ${t.name}`, "ok");
  if (ok && !saveAs && (t.kind === "tex" || t.kind === "bib") && settings.autoCompile !== "off") compile({ quiet: true });
}

document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  // Alt+C: cite a paper from the library at the cursor
  if (e.altKey && !mod && !e.shiftKey && (e.key === "c" || e.key === "C" || e.code === "KeyC")) {
    const t = activeTab();
    if (t && (t.kind === "tex" || t.kind === "md")) { e.preventDefault(); e.stopPropagation(); import("./cite.js").then((m) => m.openCitePopup(wantVisual(t) ? { insert: (key) => wys?.ctl.insertCitation?.([key]) } : {})); return; }
  }
  if (!mod) { if (e.key === "F5") { e.preventDefault(); compile(); } return; }
  const k = e.key.toLowerCase();
  const run = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); };
  if (k === "s" && e.altKey) return run(() => MENU_ACTIONS["save-all"]());
  if (k === "s" && e.shiftKey) return run(() => cmdSave(true));
  if (k === "e" && e.shiftKey) return run(cmdExport);
  if (k === "m" && e.shiftKey) return run(() => cmdExportMarkdown());
  if (k === "s") return run(() => cmdSave(false));
  if (k === "o" && e.shiftKey) return run(cmdFolder);
  if (k === "o") return run(cmdOpen);
  if (k === "n" && e.shiftKey) return run(() => toggleNewMenu(true));
  if (k === "n") return run(() => newFile("md"));
  if (k === "w") return run(() => activeId && closeTab(activeId));
  if (k === "tab") return run(() => nextTab(e.shiftKey ? -1 : 1));
  if (k === "enter") return run(() => compile());
  if (k === "\\") return run(() => updateSettings({ sidebar: !settings.sidebar }));
  if (k === ",") return run(openSettings);
  if (k === "p" && !e.shiftKey && activeTab()) return run(() => printTab(activeTab()));
  if (k === "j" && e.altKey) return run(forwardSync);
  if (k === "l" && !e.shiftKey) return run(() => toggleAIPanel());
  if (k === "l" && e.shiftKey) return run(openLibraryWindow);
  if (k === "." && !e.shiftKey) return run(() => {
    const v = getView(); const c = v.coordsAtPos(v.state.selection.main.head);
    openActionMenu(c ? c.left : 200, c ? c.bottom + 6 : 200);
  });
  if (k === "f" && (activeTab()?.kind === "pdf" || document.activeElement?.closest?.("#pdf-wrap"))) return run(openPdfFind);
  if (["1", "2", "3"].includes(k) && !e.altKey) return run(() => setView(["editor", "split", "preview"][+k - 1]));
}, true);

function pdfInitOptions() {
  return {
    onPageChange: (n, total) => { $("#pdf-page").value = n; $("#pdf-count").textContent = total; },
    onInverse: inverseSync,
    onFindResult: (mc, state) => {
      const c = $("#pdf-find-count");
      if (state === 1) c.textContent = "No matches";
      else if (mc && mc.total) c.textContent = `${mc.current} of ${mc.total}`;
      else if (mc) c.textContent = "";
    },
    onScale: () => { $("#pdf-zoom-pct").textContent = (pdfMod?.currentScalePct() ?? 100) + "%"; },
  };
}
function onPdfLoaded() {
  if (!$("#pdf-nav").hidden) renderPdfNav();
  $("#pdf-zoom-pct").textContent = (pdfMod?.currentScalePct() ?? 100) + "%";
}

// ---------------- PDF navigation panel & viewer choice ----------------
let navTab = "pages";
async function renderPdfNav() {
  for (const b of $$("#pdf-nav-tabs button")) b.classList.toggle("active", b.dataset.t === navTab);
  $("#pdf-thumbs").hidden = navTab !== "pages";
  $("#pdf-marks").hidden = navTab !== "marks";
  if (!pdfMod) return;
  if (navTab === "pages") return pdfMod.renderThumbnails($("#pdf-thumbs"));
  const box = $("#pdf-marks");
  const items = await getOutline();
  box.innerHTML = "";
  if (!items.length) { box.innerHTML = `<div class="empty-note">No bookmarks in this PDF.</div>`; return; }
  for (const it of items) {
    const el = document.createElement("div");
    el.className = "outline-item";
    el.style.paddingLeft = 8 + it.level * 12 + "px";
    el.textContent = it.title; el.title = it.title;
    el.onclick = () => (it.dest ? goToDest(it.dest) : it.url && api.openUrl(it.url));
    box.appendChild(el);
  }
}
function setPdfNav(show) {
  $("#pdf-nav").hidden = !show;
  $("#pdf-nav-btn").classList.toggle("on", show);
  if (show) renderPdfNav();
  if (show !== settings.pdfNav) updateSettings({ pdfNav: show });
}
/** Edge (WebView2's built-in) viewer for standalone PDFs: Edge's toolbar, print, rotate, save. */
function applyViewerKind(t) {
  const edge = t?.kind === "pdf" && settings.pdfViewer === "edge";
  $("#pdf-wrap").classList.toggle("edge-mode", edge);
  const fr = $("#pdf-native");
  fr.hidden = !edge;
  $("#pdf-container").hidden = edge;
  if (edge) {
    const src = fileSrc(t.path.replace(/\\/g, "/"));
    if (fr.dataset.src !== src) { fr.dataset.src = src; fr.src = src; }
  } else if (fr.dataset.src) { fr.removeAttribute("src"); delete fr.dataset.src; }
  $("#pdf-viewer-kind").hidden = t?.kind !== "pdf";
  $("#pdf-viewer-kind").value = settings.pdfViewer;
  // editing a PDF file (not a LaTeX preview, which is rebuilt on every compile)
  $("#pdf-edit").hidden = !(t?.kind === "pdf" && !edge);
  $("#doc-actions").hidden = t?.kind !== "doc";
  $("#pdf-pages-btn").hidden = t?.kind !== "pdf";
  $("#pdf-edit-save").hidden = !(t?.kind === "pdf" && t.dirty);
}

// ---------------- PDF editing ----------------
let pdfTool = "none";
function markPdfTool(tool) {
  pdfTool = tool;
  for (const b of $$("#pdf-edit [data-tool]")) b.classList.toggle("on", b.dataset.tool === tool);
  $("#pdf-wrap").classList.toggle("pdf-editing", tool !== "none");
}
function initPdfEdit() {
  $("#pdf-edit").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-tool]");
    if (!b) return;
    const m = await loadPdfMod();
    const tool = b.dataset.tool === pdfTool && b.dataset.tool !== "image" ? "none" : b.dataset.tool;
    markPdfTool(tool);
    await m.setEditTool(tool);
    if (tool === "text" || tool === "note") { fillFonts(); syncTextControls(m.textBoxes.currentStyle()); }
    applyPdfParams(m);
  });
  const params = () => { if (pdfMod) applyPdfParams(pdfMod); };
  $("#pdf-edit-color").addEventListener("input", params);
  $("#pdf-edit-size").addEventListener("change", params);
  $("#pdf-edit-font").addEventListener("change", params);
  for (const id of ["#pdf-edit-bold", "#pdf-edit-italic"]) $(id).addEventListener("click", (e) => { e.currentTarget.classList.toggle("on"); params(); });
  $("#pdf-edit-save").onclick = () => { const t = activeTab(); if (t?.kind === "pdf") saveTab(t); };
  $("#doc-export").onclick = () => { const t = activeTab(); if (t?.kind === "doc") import("./office.js").then((m) => m.exportDoc(t)); };
  $("#doc-edit-md").onclick = () => { const t = activeTab(); if (t?.kind === "doc") import("./office.js").then((m) => m.editAsMarkdown(t)); };
  $("#pdf-pages-btn").onclick = () => organizeOpenPdf();
  $("#btn-pdftools").onclick = () => { const t = activeTab(); import("./pdftools.js").then((m) => m.openPdfTools(t?.kind === "pdf" ? t.path : null)); };
  window.addEventListener("callio-tab-dirty", () => renderTabs());
  // Ctrl+V with a picture on the clipboard: put it on the PDF page
  document.addEventListener("paste", async (e) => {
    const t = activeTab();
    if (t?.kind !== "pdf" || settings.pdfViewer === "edge" || !pdfMod) return;
    if (e.target.closest?.("input, textarea, [contenteditable=true], .cm-editor")) return;
    if (pdfTool === "image") return; // the image tool takes the paste itself
    const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === "file" && /^image\//.test(i.type));
    if (!item) return;
    e.preventDefault(); e.stopPropagation();
    markPdfTool("image");
    if (await pdfMod.pasteImage(item.getAsFile())) status("Picture added — drag it into place; Esc when done", "ok");
  }, true);
}
let fontsFilled = false;
async function fillFonts() {
  if (fontsFilled) return;
  fontsFilled = true;
  const m = await loadPdfMod();
  const list = await m.textBoxes.fonts();
  const sel = $("#pdf-edit-font");
  const names = list.length ? list.map((f) => f.family) : ["Arial", "Times New Roman", "Calibri", "Segoe UI", "Georgia", "Consolas", "Courier New"];
  const cur = sel.value;
  sel.replaceChildren(...names.map((n) => { const o = new Option(n, n); o.style.fontFamily = `"${n.replace(/"/g, "")}"`; return o; }));
  sel.value = names.includes(cur) ? cur : names.includes("Arial") ? "Arial" : names[0];
}
function syncTextControls(st) {
  if (!st) return;
  const sel = $("#pdf-edit-font");
  if (![...sel.options].some((o) => o.value === st.font)) sel.add(new Option(st.font));
  sel.value = st.font;
  $("#pdf-edit-size").value = String(st.size);
  if ($("#pdf-edit-size").value !== String(st.size)) { $("#pdf-edit-size").add(new Option(String(st.size))); $("#pdf-edit-size").value = String(st.size); }
  $("#pdf-edit-color").value = st.color || "#1f2328";
  $("#pdf-edit-bold").classList.toggle("on", !!st.bold);
  $("#pdf-edit-italic").classList.toggle("on", !!st.italic);
}
function applyPdfParams(m) {
  const c = $("#pdf-edit-color").value, n = +$("#pdf-edit-size").value;
  if (pdfTool === "text" || pdfTool === "note" || !["draw", "highlight"].includes(pdfTool)) {
    m.textBoxes.setStyle({ font: $("#pdf-edit-font").value || "Arial", size: n, color: c, bold: $("#pdf-edit-bold").classList.contains("on"), italic: $("#pdf-edit-italic").classList.contains("on") });
  }
  if (pdfTool === "draw") { m.editParam("ink-color", c); m.editParam("ink-thickness", Math.max(1, Math.round(n / 4))); }
  if (pdfTool === "highlight") m.editParam("highlight-color", c);
}
// ---------------- page changes on an open PDF (undoable) ----------------
/** The open PDF's pages: reorder, rotate, duplicate, delete — then Apply. */
async function organizeOpenPdf() {
  const t = activeTab();
  if (t?.kind !== "pdf" || !pdfMod || pdfShowing?.tab !== t) return;
  const { bytes } = await pdfMod.saveEditedPdf({ commit: false });
  const m = await import("./pdftools.js");
  m.organizePages({ name: t.name, bytes, count: pageCount(), apply: (order) => pdfPagesOp(t, "Reorder pages", "pdf.organize", { order }) });
}
/** Run a PDF tool on the open PDF (as it is on screen) and show the result in the same tab. */
export async function pdfPagesOp(t, label, cmd, args) {
  const { office } = await import("./office.js");
  const { bytes } = await pdfMod.saveEditedPdf({ commit: false });
  const input = await call("office_temp", { name: "in-" + t.name });
  const output = await call("office_temp", { name: "out-" + t.name });
  await api.writeBinary(input, bytes, 0, false);
  await office(cmd, { ...args, input, output });
  const out = new Uint8Array(await api.readBinary(output));
  (t.pdfUndo ||= []).push({ label, bytes });
  t.pdfRedo = [];
  await showPdfBytes(t, out);
  status(`${label} — Save to keep it, Undo to take it back`, "ok");
}
async function showPdfBytes(t, bytes) {
  await loadPdf(bytes, { keep: true }, t);
  t.dirty = true;
  $("#pdf-edit-save").hidden = false;
  $("#st-words").textContent = `${pageCount()} page${pageCount() === 1 ? "" : "s"}`;
  renderTabs(); renderOutline();
  window.dispatchEvent(new Event("callio-undo"));
}
registerUndo("pdf", {
  list: (t) => ({ undo: (t.pdfUndo || []).map((x) => x.label).reverse(), redo: (t.pdfRedo || []).map((x) => x.label).reverse() }),
  step: async (t, n, redo) => {
    if (pdfShowing?.tab !== t) return;
    const from = redo ? (t.pdfRedo ||= []) : (t.pdfUndo ||= []);
    const to = redo ? (t.pdfUndo ||= []) : (t.pdfRedo ||= []);
    let target = null;
    for (let i = 0; i < n && from.length; i++) {
      const s = from.pop();
      const now = target ? target : (await pdfMod.saveEditedPdf({ commit: false })).bytes;
      to.push({ label: s.label, bytes: now });
      target = s.bytes;
    }
    if (target) await showPdfBytes(t, target);
  },
});

/** Save an edited PDF: pdf.js writes the edits as standard annotations. */
async function savePdfTab(t, saveAs, auto = false) {
  // one save at a time per PDF (AutoSave and Ctrl+S can meet)
  if (t._saving) { await t._saving.catch(() => {}); if (auto || !t.dirty) return !t.dirty; }
  t._saving = savePdfTabNow(t, saveAs, auto);
  try { return await t._saving; } finally { t._saving = null; }
}
async function savePdfTabNow(t, saveAs, auto) {
  if (!pdfMod || pdfShowing?.tab !== t) { toast(`${t.name}: its edits are no longer on screen, so there is nothing to save.`, "err", 6000); return false; }
  let path = t.path;
  if (saveAs) { path = await api.pickSaveFile(t.name, dirname(t.path)); if (!path) return false; }
  try {
    const { bytes, clean } = await pdfMod.saveEditedPdf({ commit: !auto });
    const same = path === t.path;
    let mtime;
    // AutoSave keeps one backup per session, not one per save
    const backup = !auto || !t._backedUp;
    try { mtime = await api.writeBinary(path, bytes, same ? t.mtime || 0 : 0, backup); t._backedUp = true; }
    catch (e) {
      if (e.message !== "CHANGED_ON_DISK") throw e;
      const r = await ask({ title: "PDF changed on disk", text: `${t.name} was changed by another program since you opened it. Overwrite it with your edited copy? (The current file is backed up first.)`, buttons: [{ label: "Cancel", value: null }, { label: "Overwrite", value: "y", primary: true }] });
      if (!r) return false;
      mtime = await api.writeBinary(path, bytes, 0, true);
    }
    if (!same) { t.path = path; t.name = basename(path); addRecent(path); }
    t.mtime = mtime; t.dirty = !clean;
    renderTabs();
    $("#pdf-edit-save").hidden = clean;
    if (!clean) schedulePdfAutosave(); // edited while saving: those edits go in the next save
    status(auto ? `AutoSaved ${t.name}` : `Saved ${t.name} (the previous version is kept in Callio's backups)`, "ok");
    return true;
  } catch (e) { toast(`Couldn't save the PDF: ${e.message}`, "err"); return false; }
}

// ---------------- zoom (Ctrl+wheel, touchpad pinch, Ctrl+= / Ctrl+- / Ctrl+0) ----------------
let zoomSaveTimer;
function zoomArea(target) {
  if (activeTab()?.kind === "pdf") return "pdf";
  if (target?.closest?.("#pdf-wrap")) return "pdf";
  if (target?.closest?.("#md-preview")) return "md";
  return "editor";
}
let lastPointerTarget = null;
function applyZoom(area, factor) {
  if (area === "pdf") return zoomBy(factor);
  const key = area === "md" ? "mdZoom" : "editorZoom";
  const z = Math.min(3, Math.max(area === "md" ? 0.2 : 0.5, (settings[key] || 1) * factor));
  if (area === "md") {
    // keep the reading position while the content scales
    const el = $("#md-preview");
    const ratio = el.scrollTop / Math.max(1, el.scrollHeight);
    settings.mdZoom = z;
    document.documentElement.style.setProperty("--md-zoom", z);
    if (mirror.mirroring()) mirror.setZoom(z);
    else { el.scrollTop = ratio * el.scrollHeight; mdMod?.relayoutPages(el, 120); }
    const lab = $("#md-toolbar .mdz-val"); if (lab) lab.textContent = Math.round(z * 100) + "%";
  } else {
    settings.editorZoom = z;
    document.documentElement.style.setProperty("--editor-size", (settings.fontSize * z).toFixed(2) + "px");
    getView()?.requestMeasure();
  }
  status(`${area === "md" ? "Preview" : "Editor"} zoom ${Math.round(z * 100)}%`);
  clearTimeout(zoomSaveTimer);
  zoomSaveTimer = setTimeout(() => updateSettings({}), 600);
}
/** Ctrl+wheel over the PDF pane but outside the pages (toolbar, margins): zoom the PDF. */
function zoomPdfAt(e) {
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  zoomBy(Math.exp(-dy * (Math.abs(dy) < 40 ? 0.008 : 0.0015)));
}
function resetZoom(area) {
  if (area === "pdf") return setZoom("page-width");
  applyZoom(area, 1 / (settings[area === "md" ? "mdZoom" : "editorZoom"] || 1));
}
function initMdToolbar() {
  const bar = $("#md-toolbar");
  bar.querySelector(".mdz-val").textContent = Math.round((settings.mdZoom || 1) * 100) + "%";
  bar.addEventListener("mousedown", (e) => e.preventDefault());
  bar.onclick = (e) => {
    const a = e.target.closest("button")?.dataset.mdz; if (!a) return;
    const z = settings.mdZoom || 1;
    if (a === "in") applyZoom("md", 1.1);
    else if (a === "out") applyZoom("md", 1 / 1.1);
    else if (a === "reset") applyZoom("md", 1 / z);
    else if (a === "fit") {
      // the editor's page (or a comfortable reading width) fills the pane
      const pv = $("#md-preview");
      const li = mirror.mirroring() ? wys?.ctl?.layoutInfo?.() : null;
      const w = li ? li.page.getBoundingClientRect().width : 860;
      applyZoom("md", Math.max(0.3, Math.min(3, (pv.clientWidth - 24) / w)) / z);
    } else if (a === "mirror") {
      updateSettings({ mirrorPreview: settings.mirrorPreview === false });
      updateMirror();
      if (!mirror.mirroring()) onDocChanged(true);
    }
  };
}
function initZoom() {
  try { initMdToolbar(); } catch (e) { console.warn(e); }
  document.addEventListener("pointermove", (e) => { lastPointerTarget = e.target; }, { passive: true });
  // Ctrl+wheel and touchpad pinch (both arrive as ctrl+wheel) zoom whatever is under the
  // pointer: editor, Markdown preview or PDF. The window itself never zooms.
  const onWheel = (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (e.target.closest?.("#pdf-container")) return; // PDF.js handler zooms around the pointer
    const area = zoomArea(e.target);
    if (area === "pdf") return zoomPdfAt(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    applyZoom(area, Math.exp(-dy * (Math.abs(dy) < 40 ? 0.008 : 0.0015)));
  };
  window.addEventListener("wheel", onWheel, { passive: false, capture: true });
  // Safari-style gesture events (some touchpads/drivers): treat like pinch
  let gs = 1;
  window.addEventListener("gesturestart", (e) => { e.preventDefault(); gs = 1; });
  window.addEventListener("gesturechange", (e) => { e.preventDefault(); const f = e.scale / gs; gs = e.scale; const area = zoomArea(e.target); area === "pdf" ? zoomBy(f) : applyZoom(area, f); });
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const area = zoomArea(document.activeElement?.closest?.("#pdf-wrap, #md-preview") ? document.activeElement : lastPointerTarget);
    if (e.key === "=" || e.key === "+") { e.preventDefault(); applyZoom(area, 1.1); }
    else if (e.key === "-") { e.preventDefault(); applyZoom(area, 1 / 1.1); }
    else if (e.key === "0") { e.preventDefault(); resetZoom(area); }
  }, true);
}

// ---------------- PDF find ----------------
function openPdfFind() {
  $("#pdf-find").hidden = false;
  const i = $("#pdf-find-input");
  i.focus(); i.select();
}
function closePdfFind() {
  $("#pdf-find").hidden = true;
  $("#pdf-find-count").textContent = "";
  pdfCloseFind();
}
function initPdfFind() {
  const i = $("#pdf-find-input");
  $("#pdf-find-btn").onclick = () => ($("#pdf-find").hidden ? openPdfFind() : closePdfFind());
  i.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); if (i.value) pdfFind(i.value, e.shiftKey); }
    else if (e.key === "Escape") { e.preventDefault(); closePdfFind(); $("#pdf-container").focus(); }
  });
  let t;
  i.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => i.value ? pdfFind(i.value) : closePdfFind(), 180); });
  $("#pdf-find-next").onclick = () => i.value && pdfFind(i.value, false);
  $("#pdf-find-prev").onclick = () => i.value && pdfFind(i.value, true);
}

// ---------------- splitters ----------------
function makeSplitter(el, onMove) {
  el.addEventListener("pointerdown", (e) => {
    el.setPointerCapture(e.pointerId);
    el.classList.add("drag");
    document.body.style.cursor = "col-resize";
    const move = (ev) => onMove(ev.clientX);
    const up = () => {
      el.releasePointerCapture(e.pointerId);
      el.classList.remove("drag");
      document.body.style.cursor = "";
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      updateSettings({});
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  });
}

// ---------------- settings dialog ----------------
import { openSettings, initSettings } from "./settings.js";

// ---------------- boot ----------------
async function boot() {
  try { const s = await api.loadSettings(); if (s) settings = { ...DEFAULTS, ...s }; } catch {}
  // 0.5: zooming out switches page layouts automatically — make it the default once
  if (!settings.layoutAutoV) { settings = { ...settings, pdfLayout: settings.pdfLayout === "continuous" ? "auto" : settings.pdfLayout, layoutAutoV: 1 }; }
  initEditor($("#editor"), {
    onChange: onEdit,
    onCursor: updateCursor,
    onScroll: () => { cancelAnimationFrame(window.__edsr); window.__edsr = requestAnimationFrame(() => syncFromSource(topVisibleLine())); },
  });

  initPdfFind();
  initPdfEdit();
  setKindGetter(() => activeTab()?.kind || "text");
  initFormatBar();
  if (import.meta.env?.DEV) window.__text = () => getView().state.doc.toString();
  if (import.meta.env?.DEV) window.__wys = () => wys;
  initAI();
  initInline();
  initWriting();
  initUndo();
  initHistory({
    activeTab,
    currentText: () => getView().state.doc.toString(),
    restore: async (t, text) => {
      if (activeTab() !== t) await activate(t.id);
      const v = getView();
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, userEvent: "input.restore" });
      await saveTab(t);
    },
  });
  initEngineUI();
  for (const opt of [["tectonic", "Tectonic"], ["latexmk", "latexmk"], ["pdflatex", "pdfLaTeX"], ["xelatex", "XeLaTeX"], ["lualatex", "LuaLaTeX"], ["overleaf", "Overleaf"]]) {
    const o = document.createElement("option"); o.value = opt[0]; o.textContent = opt[1]; $("#sel-engine").appendChild(o);
  }
  applySettings();
  initSettings();
  initOverleaf();
  renderRecent();
  renderTabs();
  setFolder(null);

  // toolbar
  $("#btn-sidebar").onclick = () => updateSettings({ sidebar: !settings.sidebar });
  initMenus();
  $("#w-open").onclick = cmdOpen;
  $("#w-folder").onclick = cmdFolder;
  $("#w-overleaf").onclick = () => { updateSettings({ sidebar: true }); showSide("overleaf"); };
  $("#w-assoc").onclick = (e) => { e.preventDefault(); openSettings("files"); };
  $("#btn-compile").onclick = () => compile();
  $("#sel-engine").onchange = (e) => updateSettings({ engine: e.target.value });
  $("#btn-settings").onclick = () => openSettings();
  $("#btn-ol-pull").onclick = olPull;
  $("#btn-ol-push").onclick = olPush;
  $("#btn-refresh-tree").onclick = refreshTree;
  for (const b of $$("#view-mode button")) b.onclick = () => setView(b.dataset.view);
  wireTabDrag();
  const showSide = (name) => {
    for (const b of $$(".side-tabs button")) b.classList.toggle("active", b.dataset.side === name);
    for (const s of ["files", "outline", "history", "overleaf"]) { const p = $("#side-" + s), was = p.hidden; p.hidden = s !== name; if (was && !p.hidden) enter(p, "fade", { duration: 150 }); }
    if (name === "history") refreshHistoryPanel();
    if (name === "outline") renderOutline();
    if (name === "overleaf") refreshOverleafPanel();
  };
  for (const b of $$(".side-tabs button")) b.onclick = () => showSide(b.dataset.side);

  // pdf toolbar
  $("#pdf-zoom").onchange = (e) => setZoom(e.target.value);
  $("#pdf-layout").value = settings.pdfLayout;
  $("#pdf-layout").onchange = (e) => { updateSettings({ pdfLayout: e.target.value }); pdfMod?.setLayout(e.target.value); };
  $("#pdf-nav-btn").onclick = () => setPdfNav($("#pdf-nav").hidden);
  for (const b of $$("#pdf-nav-tabs button")) b.onclick = () => { navTab = b.dataset.t; renderPdfNav(); };
  if (settings.pdfNav) { $("#pdf-nav").hidden = false; $("#pdf-nav-btn").classList.add("on"); }
  $("#pdf-viewer-kind").onchange = (e) => { updateSettings({ pdfViewer: e.target.value }); const t = activeTab(); if (t?.kind === "pdf") { releaseEditedPdf(null).then((ok) => { if (!ok) { updateSettings({ pdfViewer: "callio" }); e.target.value = "callio"; return; } pdfShowing = null; showPdfTab(t); }); } };
  initZoom();
  // answers to backend requests (PDF text for the AI, library, Claude Code) — listening is cheap
  const pdfPath = (p) => (/^([A-Za-z]:)?[\\/]/.test(p) || !folder ? p : `${folder}/${p}`);
  onRpc("pdf_text", async ({ path, from_page, to_page }) => {
    if (!/\.pdf$/i.test(path || "")) return "Not a PDF file.";
    const r = await (await loadPdfMod()).extractText(new Uint8Array(await api.readBinary(pdfPath(path))));
    const a = Math.max(1, from_page || 1), b = Math.min(r.pages.length, to_page || r.pages.length);
    const out = r.pages.slice(a - 1, b).map((t, i) => `--- page ${a + i} ---\n${t}`).join("\n");
    return `${r.numPages} pages${a > 1 || b < r.pages.length ? ` (showing ${a}–${b})` : ""}\n${out.length > 150000 ? out.slice(0, 150000) + "\n… (ask for a page range)" : out}`;
  });
  onRpc("pdf_page_image", async ({ path, page }) => {
    if (!/\.pdf$/i.test(path || "")) return "Not a PDF file.";
    return (await loadPdfMod()).renderPagePng(new Uint8Array(await api.readBinary(pdfPath(path))), page || 1);
  });
  // the AI's tools for Word documents, spreadsheets and PDFs
  for (const [name, fn] of [["office_read", "officeRead"], ["office_commands", "officeCommands"], ["word_edit", "wordEdit"], ["sheet_edit", "sheetEdit"], ["deck_edit", "deckEdit"], ["image_edit", "imageEdit"], ["pdf_tool", "pdfTool"]]) {
    onRpc(name, async (p) => { try { return await (await import("./office-ai.js"))[fn](p); } catch (e) { return { error: e.message || String(e) }; } });
  }
  onRpc("search_library", async (p) => (await import("./library.js")).aiSearch(p));
  onRpc("read_library_paper", async (p) => (await import("./library.js")).aiRead(p));
  onRpc("library_bibtex", async (p) => (await import("./library.js")).aiBibtex(p));
  setTimeout(() => initRpc(), 800);
  $("#pdf-zoom-in").onclick = () => zoomBy(1.15);
  $("#pdf-zoom-out").onclick = () => zoomBy(1 / 1.15);
  $("#pdf-page").onchange = (e) => goToPage(+e.target.value);
  $("#pdf-sync").onclick = forwardSync;
  $("#pdf-open-ext").onclick = () => lastPdfPath && api.openPath(lastPdfPath);
  $("#btn-logs").onclick = () => { $("#log-panel").hidden = !$("#log-panel").hidden; renderLog(currentLogFilter); };
  $("#log-close").onclick = () => ($("#log-panel").hidden = true);
  for (const b of $$("#log-filter button")) b.onclick = () => renderLog(b.dataset.f);

  // markdown preview interactions
  { // page view: re-flow pages when the pane resizes or images finish loading
    const el = $("#md-preview");
    let lastW = 0;
    new ResizeObserver(() => { const w = el.clientWidth; if (w && Math.abs(w - lastW) > 4) { lastW = w; mdMod?.relayoutPages(el); } }).observe(el);
    el.addEventListener("load", (e) => { if (e.target.tagName === "IMG" && el.classList.contains("md-paged")) mdMod?.relayoutPages(el, 250); }, true);
  }
  $("#md-preview").addEventListener("scroll", () => { cancelAnimationFrame(window.__mdsr); window.__mdsr = requestAnimationFrame(syncFromPreview); }, { passive: true });
  $("#md-preview").addEventListener("dblclick", (e) => { const l = mdMod?.lineAtElement(e.target); if (l) gotoLine(l); });
  $("#md-preview").addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href");
    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1));
      const target = [...$$("#md-preview h1,#md-preview h2,#md-preview h3,#md-preview h4,#md-preview h5,#md-preview h6")]
        .find((h) => h.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-") === id.toLowerCase());
      target?.scrollIntoView({ behavior: "smooth" });
    } else if (/^[a-z]+:/i.test(href) && !/^file:/i.test(href)) api.openUrl(href);
    else { const t = activeTab(); if (t?.path) openPath((dirname(t.path) + "/" + decodeURI(href.split("#")[0])).replace(/\\/g, "/")); }
  });

  // splitters
  makeSplitter($("#split-side"), (x) => { settings.sideWidth = Math.max(150, Math.min(520, x)); $("#sidebar").style.setProperty("--side-w", settings.sideWidth + "px"); });
  makeSplitter($("#split-ai"), (x) => {
    settings.aiPanelWidth = Math.max(280, Math.min(760, window.innerWidth - x));
    $("#ai-panel").style.width = settings.aiPanelWidth + "px";
  });
  $("#ai-panel").style.width = (settings.aiPanelWidth || 380) + "px";
  makeSplitter($("#split-preview"), (x) => {
    const pane = $("#editor-pane").getBoundingClientRect();
    const total = pane.width + $("#preview-pane").getBoundingClientRect().width;
    const r = 1 - Math.max(0.15, Math.min(0.85, (x - pane.left) / total));
    settings.previewRatio = r;
    setView("split", false);
  });

  // backend events
  listen("open-paths", (paths) => paths.forEach((p) => openPath(p)));
  // a newer Callio was started from another folder while this (older) one runs
  listen("newer-version", async ({ exe, version, args }) => {
    const r = await ask({ title: `Callio ${version} is available`, text: `You started a newer Callio (${version}) from:\n${exe}\n\nSwitch to it now? This window closes (you'll be asked about unsaved files first).`, buttons: [{ label: "Keep using this one", value: "keep" }, { label: `Switch to ${version}`, value: "switch", primary: true }] });
    if (r !== "switch") {
      const paths = (args || []).filter((a) => !a.startsWith("--"));
      for (const p of paths) await openPath(p).catch(() => {});
      return;
    }
    stashActive();
    const dirty = tabs.filter((t) => t.dirty);
    if (dirty.length) {
      const s = await ask({ title: "Unsaved changes", text: `${dirty.length} file(s) have unsaved changes.`, buttons: [{ label: "Cancel", value: null }, { label: "Discard", value: "quit" }, { label: "Save all & switch", value: "save", primary: true }] });
      if (!s) return;
      if (s === "save") { for (const t of dirty) if (!(await saveTab(t))) return; }
    }
    const open = tabs.filter((t) => t.path).map((t) => t.path);
    api.handoff([...new Set([...open, ...(args || [])])]).catch((e) => toast(e.message, "err"));
  });
  listen("compile-status", (msg) => status(msg));
  listen("tauri://drag-drop", (p) => {
    const paths = p?.paths || [];
    markDrop(null);
    // dropped on the open library window: add the PDFs / .bib files to the library
    if ($("#dlg-library")?.open) return import("./library.js").then((m) => m.addPaths(paths));
    // dropped on the Compare window: those are the files to compare
    if ($("#dlg-compare")?.open) return import("./compare.js").then((m) => m.onDrop(paths, p?.position));
    // dropped on the file list: copied into that folder
    if (explorerDrop(paths, p?.position)) return;
    paths.forEach((x) => openPath(x));
  });
  listen("tauri://drag-over", (p) => {
    if ($("#dlg-compare")?.open) return import("./compare.js").then((m) => m.onDragOver(p?.position));
    if (!$("#dlg-library")?.open) explorerHover(p?.position);
  });
  listen("tauri://drag-leave", () => markDrop(null));
  // the library (papers added from the Edge extension get their text indexed here)
  listen("library-changed", (e) => import("./library.js").then((m) => m.onLibraryChanged(e)));
  onRpc("library_pair", async ({ browser, origin }) => !!(await ask({ title: "Connect a browser extension?", text: `A browser extension wants to add papers to your Callio library.\n\nExtension: ${origin || "unknown"}\nIt says it is: ${browser || "—"}\n\nAllow it only if you just clicked “Connect” in Callio's “Save to Callio” extension. (Its id is shown in Edge → Extensions.)`, buttons: [{ label: "Don't allow", value: null }, { label: "Allow", value: "yes", primary: true }] })));
  $("#btn-library").onclick = openLibraryWindow;
  initAutosave();
  $("#btn-ocr").onclick = () => import("./ocr.js").then((m) => m.startOcr());
  $("#btn-compare").onclick = () => { stashActive(); const t = activeTab(); const textTab = t && !VIEW_KINDS.has(t.kind); import("./compare.js").then((m) => m.openCompare(t ? t.path || t.name : null, textTab ? t : null)); };
  initStructured();
  listen("close-requested", async () => {
    call("close_ack").catch(() => {});
    stashActive();
    const dirty = tabs.filter((t) => t.dirty);
    if (dirty.length) {
      const r = await ask({ title: "Unsaved changes", text: `${dirty.length} file(s) have unsaved changes.`, buttons: [
        { label: "Cancel", value: null }, { label: "Quit without saving", value: "quit" }, { label: "Save all & quit", value: "save", primary: true }] });
      if (!r) return;
      if (r === "save") { for (const t of dirty) if (!(await saveTab(t))) return; }
    }
    call("exit_app");
  });

  // show the (hidden) window as soon as the first frame is painted
  performance.mark("callio-init-done");
  requestAnimationFrame(() => requestAnimationFrame(() => { if (IS_TAURI) call("show_window").catch(() => {}); }));
  const paths = await api.startupPaths().catch(() => []);
  for (const p of paths) await openPath(p);
  if (!paths.length && !IS_TAURI) { setFolder("C:/demo"); await openPath("C:/demo/README.md"); }
}

boot();
