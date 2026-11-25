// One window per folder. Every window is a session with its own folder; a file that is not
// inside the window's folder opens in another window (see src-tauri/src/windows/route.rs for the
// rule). This module is the frontend half: it asks the backend where a file goes, keeps the
// backend's registry up to date, holds the per-window layer over the settings (panels, widths,
// view mode), applies settings changed in other windows, names the window, and registers the
// "reopen my windows" restorer.
//
// main.js gives it what it needs in initWindows(); nothing here imports main.js, so this small
// module loads first and is cheap in every window.
import { call, listen } from "./api.js";
import { addVi } from "./i18n.js";
import { registerRestorer } from "./restore.js";

const q = new URLSearchParams(location.search);
/** "main" for the first window, "w-2", "w-3"… for the others. */
export const winLabel = q.get("win") || "main";
export const isMain = winLabel === "main";
/** The AI chat popped out of an editor window (detach.js): this page shows only the AI panel. */
export const isChat = q.get("role") === "chat";
/** For a chat window, the editor window it belongs to. */
export const parentLabel = q.get("parent") || (isChat ? winLabel.replace(/^chat-/, "") : null);
export const winQuery = { open: q.get("open") || null, folder: q.get("folder") || null, restore: q.get("restore") === "1" };

/** What belongs to one window and never to the shared settings. Add future per-window keys here. */
export const PER_WINDOW = ["sidebar", "sidebarPinned", "sideWidth", "aiPanel", "aiPanelWidth", "view", "previewRatio"];
/** A new extra window: the file list hides at the left edge (hover to show), no AI panel. */
export const NEW_WINDOW_LAYOUT = { sidebar: true, sidebarPinned: false, aiPanel: false };

addVi({
  "Couldn't open a new window": "Không mở được cửa sổ mới",
  "Close the other Callio windows, then start the new version again.": "Hãy đóng các cửa sổ Callio khác, rồi khởi động lại bản mới.",
});

let ctx = null;

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
export const layoutOf = (settings) => pick(settings, PER_WINDOW);

/** Path comparison as Windows does it: `\` = `/`, no case. */
export const norm = (p) => (p || "").replace(/\\/g, "/").replace(/(?<=.)\/+$/, "").toLowerCase();
export function isInside(p, dir) {
  const a = norm(p), d = norm(dir);
  return !!d && (a === d || a.startsWith(d + "/"));
}

/** The settings this window works with: the shared ones, and (extra windows) its own layout over them. */
export async function bootSettings(shared) {
  if (isMain) return shared;
  let layout = null;
  try { layout = (await call("win_boot"))?.layout; } catch {}
  if (!layout || typeof layout !== "object" || !Object.keys(layout).length) layout = isChat ? { sidebar: false, aiPanel: true } : NEW_WINDOW_LAYOUT;
  if (isChat) layout = { ...layout, sidebar: false, aiPanel: true }; // [detach] a chat window is always its AI panel
  return { ...shared, ...layout };
}

/** What to send to the backend when saving: an extra window keeps its layout out of the shared file. */
export function saveArgs(settings) {
  if (isMain) return { settings, omit: null };
  const s = { ...settings };
  for (const k of PER_WINDOW) delete s[k];
  return { settings: s, omit: PER_WINDOW };
}

/** Settings were changed (and saved) in another window: take over everything but this window's layout. */
export function mergeReloaded(current, fresh) {
  return { ...current, ...fresh, ...layoutOf(current) };
}
export async function onSettingsChanged(from) {
  if (from === winLabel || !ctx) return;
  let fresh = null;
  try { fresh = await call("load_settings"); } catch {}
  if (fresh) ctx.applyReloaded((cur) => mergeReloaded(cur, fresh));
}

// ---------------------------------------------------------------- routing

/**
 * A file is about to open here. Returns true when another window took it (focused, opened it
 * there, or a new window was made) so the caller does nothing more. Files that belong here
 * (inside this window's folder, this window has no folder, already open here) return false
 * without asking the backend.
 */
export async function routeElsewhere(path, line) {
  if (!ctx) return false;
  const folder = ctx.folder();
  if (!folder || isInside(path, folder) || ctx.hasTab(path)) return false;
  try {
    const r = await call("win_route", { path, line: line || null, folder, files: ctx.files() });
    return !r.here;
  } catch (e) {
    ctx.toast(`Couldn't open a new window: ${e.message}`, "err");
    return false; // fall back: open it here
  }
}

/** Number of other Callio windows open. */
export async function otherWindows() {
  try { return (await call("win_list")).filter((w) => !w.me && w.role !== "chat").length; } catch { return 0; }
}

/** Close this window after the user settled unsaved files. The last window quits the app. */
export async function closeThisWindow() {
  try {
    if ((await call("win_close")) === "last") await call("exit_app");
  } catch { call("exit_app").catch(() => {}); }
}

// ---------------------------------------------------------------- registry reports

let reportTimer = 0;
/** Tell the backend what this window shows (folder, open files, layout), after things settle. */
export function reportSoon() {
  if (!ctx) return;
  clearTimeout(reportTimer);
  reportTimer = setTimeout(reportNow, 400);
}
export function reportNow() {
  clearTimeout(reportTimer);
  if (!ctx) return;
  call("win_report", { folder: ctx.folder() || null, files: ctx.files(), layout: isMain ? null : layoutOf(ctx.settings()) }).catch(() => {});
}

/** "<file> — <folder> — Callio": windows can be told apart in Alt+Tab. */
export function titleFor(tab, folder) {
  const parts = [];
  if (tab) parts.push(`${tab.dirty ? "● " : ""}${tab.name}`);
  if (folder) parts.push(folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder);
  parts.push("Callio");
  return parts.join(" — ");
}

// ---------------------------------------------------------------- start

/**
 * ctx: { folder(), files(), hasTab(path), settings(), openLocal(path, line), applyReloaded(fn), toast(msg, kind) }
 */
export function initWindows(c) {
  ctx = c;
  // another window (or a second launch) sent a file that belongs here: open it without asking again
  listen("win-open", ({ paths, line }) => (paths || []).forEach((p) => ctx.openLocal(p, line || undefined)));
  listen("settings-changed", ({ from } = {}) => onSettingsChanged(from));
  addEventListener("callio-folder", reportSoon);
  if (isMain) registerRestorer({
    id: "windows", order: 5,
    describe: async () => {
      const n = (await call("win_previous").catch(() => [])).length;
      return n ? (ctx.settings().uiLang === "vi" ? `${n} cửa sổ` : `${n} window${n > 1 ? "s" : ""}`) : null;
    },
    restore: async () => { await call("win_restore"); },
    discard: async () => { await call("win_discard_previous"); },
  });
}

/** Files this window starts with: its own folder and the file it was made for, then paths handed over meanwhile. */
export function startFiles(handedOver) {
  const first = isMain ? [] : [winQuery.open].filter(Boolean);
  return [...new Set([...first, ...handedOver])];
}
