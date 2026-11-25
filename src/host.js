// What the AI panel needs from the editor: the open tabs, the selection, the compile result, opening a
// file, applying an edit, reloading files after Claude Code changed them.
//
// In an editor window these are the editor's own functions (main.js / editor.js). In a chat window
// (the AI panel popped out into its own window, see detach.js) there is no editor: the same names
// answer from a copy of the editor window's state that it keeps up to date (the "mirror"), and
// every action is a request to the editor window (winrpc.js). ai.js, claude-code.js and
// cc-sessions.js import from here instead of from main.js / editor.js, so the same code runs in both.
import * as M from "./main.js";
import * as E from "./editor.js";
import { isChat, parentLabel } from "./windows.js";
import * as rpc from "./winrpc.js";

export const REMOTE = isChat;

// ---------------- the mirror (chat window) ----------------
/** What the editor window last told us. `docText` is only filled by syncDoc(): right before a message is sent. */
const mir = { folder: "", tabs: [], activeId: null, sel: null, head: 0, line: 1, docLen: 0, docText: null, docFor: null, diagnostics: [], citations: [], at: 0 };
export const mirror = () => mir;
export function setMirror(m) {
  const folderChanged = m.folder !== undefined && m.folder !== mir.folder;
  Object.assign(mir, m);
  mir.at = Date.now();
  if (folderChanged) window.dispatchEvent(new CustomEvent("callio-folder"));
}

const lineOf = (text, pos) => { let n = 1; for (let i = text.indexOf("\n"); i >= 0 && i < pos; i = text.indexOf("\n", i + 1)) n++; return n; };
/** Enough of CodeMirror's Text for the places ai.js and claude-code.js read the document. */
function fakeDoc() {
  const fresh = mir.docText != null && mir.docFor === mir.activeId;
  return {
    get length() { return fresh ? mir.docText.length : mir.docLen; },
    toString: () => (fresh ? mir.docText : ""),
    sliceString: (a, b) => (fresh ? mir.docText.slice(a, b) : ""),
    lineAt(pos) {
      if (fresh) return { number: lineOf(mir.docText, pos), from: 0, to: 0, text: "" };
      const s = mir.sel;
      return { number: s && pos === s.to ? s.lineTo : s && pos === s.from ? s.lineFrom : mir.line, from: 0, to: 0, text: "" };
    },
  };
}
function fakeView() {
  const s = mir.sel || { from: mir.head, to: mir.head, head: mir.head };
  return {
    state: { doc: fakeDoc(), selection: { main: { from: s.from, to: s.to, head: s.head ?? s.to } }, sliceDoc: (a, b) => (mir.sel && a === mir.sel.from && b === mir.sel.to ? mir.sel.text : (mir.docText || "").slice(a, b)) },
    focus: () => { rpc.request(parentLabel, "editor.focus").catch(() => {}); },
    dispatch: () => { throw new Error("This edit needs the editor window."); },
  };
}

/** Ask the editor window for everything a message needs (the document, the exact selection, the tabs). */
export async function syncDoc() {
  if (!REMOTE) return;
  try { setMirror(await rpc.request(parentLabel, "ctx.get", { doc: true })); } catch { /* the old copy is used */ }
}

// ---------------- the editor, as ai.js sees it ----------------
export const activeTab = () => (REMOTE ? mir.tabs.find((t) => t.id === mir.activeId) || null : M.activeTab());
export const getTabs = () => (REMOTE ? mir.tabs : M.getTabs());
export const getLastCompile = () => (REMOTE ? { diagnostics: mir.diagnostics } : M.getLastCompile());
export const getFolder = () => (REMOTE ? mir.folder || null : M.folder);
export const getView = () => (REMOTE ? fakeView() : E.getView());
export function getSelectionInfo() {
  if (!REMOTE) return E.getSelectionInfo();
  const s = mir.sel;
  return s ? { from: s.from, to: s.to, head: s.head ?? s.to, text: s.text, doc: fakeDoc() } : null;
}
export const project = REMOTE ? { get citations() { return mir.citations; }, labels: [], files: [] } : E.project;

export async function openPath(path, line, local) {
  if (!REMOTE) return M.openPath(path, line, local);
  await rpc.request(parentLabel, "editor.openPath", { path, line: line || null });
  return null;
}
export const compile = async (o) => (REMOTE ? rpc.request(parentLabel, "editor.compile", { quiet: !!o?.quiet }, { timeout: 180000 }) : M.compile(o));
/** Save the open edits of files inside `dir` (Claude Code reads files from disk). */
export async function saveInside(dir) {
  if (REMOTE) return rpc.request(parentLabel, "editor.saveInside", { dir }, { timeout: 60000 });
  const n = (p) => (p || "").replace(/\\/g, "/").toLowerCase();
  return M.saveAll((t) => !!t.path && n(t.path).startsWith(n(dir)));
}
export const reloadFromDisk = (paths, force, label) => (REMOTE ? rpc.request(parentLabel, "editor.reload", { paths, force: !!force, label: label || "" }, { timeout: 60000 }) : M.reloadFromDisk(paths, force, label));
export const refreshTree = () => (REMOTE ? rpc.request(parentLabel, "editor.refreshTree").catch(() => {}) : M.refreshTree());

/** Apply a suggestion to the open file as a reviewed diff (the editor window shows it and can undo it). */
export function applyEdit(a) {
  return REMOTE ? rpc.request(parentLabel, "editor.apply", a, { timeout: 30000 }) : null;
}
export function insertAtCursor(text, label) {
  return rpc.request(parentLabel, "editor.insert", { text, label }, { timeout: 30000 });
}
/** Settings dialogs, Library etc. live in the editor window. */
export const openInEditor = (what, arg) => rpc.request(parentLabel, "editor.open", { what, arg }).catch(() => {});

// ---------------- the editor window while its chat is out ----------------
/** detach.js sets this in an editor window while the chat window is open: { label, focus(), forward(method, params) }. */
let out = null;
export const setChatOut = (o) => { out = o; document.documentElement.classList.toggle("chat-detached", !!o); };
export const chatOut = () => out;
/** Cursor, selection or tabs changed in this editor window: tell the chat window (debounced there). */
let touch = null;
export const onContextTouched = (fn) => { touch = fn; };
export const contextTouched = () => touch?.();
