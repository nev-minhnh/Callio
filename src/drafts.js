// Unsaved text tabs and the tab list, written to disk every ~3 s (and when the window loses
// focus or is hidden) so that a power cut or crash loses at most a few seconds of typing.
//
// - One file per dirty text tab (Markdown, LaTeX, plain text, code, HTML, CSV, JSON…), keyed by
//   the window's label and the file path (or an id for an untitled tab). The file on disk is never
//   touched. A draft is deleted when its tab is saved or closed. (Word / Excel / PowerPoint, PDF
//   and notebook tabs have their own editors; their unsaved changes are not drafted.)
// - The list of the window's tabs (paths, order, active tab, pinned, view mode, folder) goes to
//   `session/<window>.json`, for "reopen the previous session".
// Every window uses its own label, so several windows each restore their own tabs.
import { call, IS_TAURI } from "./api.js";
import { getTabs, activeTab, settings, folder } from "./main.js";
import { getView } from "./editor.js";

const NO_DRAFT = new Set(["pdf", "doc", "sheet", "deck", "image", "media", "drawio", "ipynb"]);
const norm = (p) => (p || "").replace(/\\/g, "/").toLowerCase();

let label = "main";
let labelP = null;
/** This window's label ("main" in the browser). */
export function windowLabel() {
  labelP ??= (async () => {
    if (IS_TAURI) { try { label = (await import("@tauri-apps/api/window")).getCurrentWindow().label || "main"; } catch {} }
    return label;
  })();
  return labelP;
}

/** A short hash of a text (to tell whether the file on disk changed since a draft was made). */
export function hashText(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
/** The draft key of a tab: its path, or a stable id for an untitled tab. */
export function draftKey(t) {
  if (t.draftKeyOverride) return t.draftKeyOverride;
  if (t.path) return "p-" + hashText(norm(t.path));
  t.draftId ??= "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return "u-" + t.draftId;
}
/** A restored tab takes over its draft: from now on the draft follows the tab (updated, and removed when saved or closed). */
export function adoptDraft(t, d) {
  t.draftKeyOverride = d.key;
  written.add(d.key);
}
export const keyForPath = (path) => "p-" + hashText(norm(path));

const isTextTab = (t) => !NO_DRAFT.has(t.kind);
/** The current document of a tab (the editor's for the active tab, else the one kept for it). */
function docOf(t) {
  if (t.id === activeTab()?.id) { const v = getView(); if (v) return v.state.doc; }
  return t.state?.doc ?? null;
}

const lastDoc = new Map();    // draft key → the document last written (to skip unchanged tabs)
const written = new Set();    // keys this run wrote: only these are deleted when the tab is clean/closed
let lastState = "";
let busy = false;

/** Write what changed since the last time. Safe to call often. */
export async function flushDrafts() {
  if (busy) return;
  busy = true;
  try {
    const win = await windowLabel();
    const tabs = getTabs();
    const live = new Set();
    for (const t of tabs) {
      if (!isTextTab(t)) continue;
      const key = draftKey(t);
      const doc = docOf(t);
      if (t.dirty && doc) {
        live.add(key);
        if (lastDoc.get(key) === doc) continue;
        lastDoc.set(key, doc);
        const text = doc.toString();
        await call("draft_save", { window: win, key, draft: {
          windowLabel: win, path: t.path || null, untitledId: t.path ? null : t.draftId, name: t.name, kind: t.kind,
          text, baseMtime: t.mtime || 0, baseHash: t.saved != null ? hashText(t.saved) : null, encoding: t.encoding || "utf8", eol: t.eol || "\n", savedAt: Date.now(),
        } });
        written.add(key);
      }
    }
    // saved or closed since: its draft goes
    for (const key of [...written]) {
      if (live.has(key)) continue;
      written.delete(key); lastDoc.delete(key);
      await call("draft_delete", { window: win, key });
    }
    // the tab list
    const state = {
      v: 1, savedAt: Date.now(), folder: folder || null, view: settings.view || null, active: activeTab() ? draftKey(activeTab()) : null,
      tabs: tabs.filter((t) => t.path || (isTextTab(t) && t.dirty)).map((t) => ({ key: draftKey(t), path: t.path || null, name: t.name, kind: t.kind, pinned: !!t.pinned, dirty: !!t.dirty })),
    };
    const sig = JSON.stringify({ ...state, savedAt: 0 });
    if (sig !== lastState) { lastState = sig; await call("tabs_state_save", { window: win, state }); }
  } catch (e) { console.warn("drafts", e); }
  finally { busy = false; }
}

/** A normal exit: nothing is left to restore for this window. */
export async function clearWindow() {
  const win = await windowLabel();
  await call("draft_delete", { window: win, key: "" }).catch(() => {});
  await call("tabs_state_delete", { window: win }).catch(() => {});
}

/** All drafts (every window), newest first. */
export async function listDrafts(all = true) {
  const win = await windowLabel();
  const list = await call("draft_list", { window: all ? null : win }).catch(() => []);
  return list.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}
export async function deleteDraft(d) { await call("draft_delete", { window: d.window, key: d.key }).catch(() => {}); }
export async function loadTabsState() { return call("tabs_state_load", { window: await windowLabel() }).catch(() => null); }

let started = false;
/** Start the periodic save. */
export function startDrafts() {
  if (started) return;
  started = true;
  setInterval(() => { if (!document.hidden) flushDrafts(); }, 3000);
  setInterval(() => call("session_marker_touch").catch(() => {}), 20000);
  addEventListener("blur", flushDrafts);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushDrafts(); });
  if (import.meta.env?.DEV) window.__drafts = { flush: flushDrafts };
}
