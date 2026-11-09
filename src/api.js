// Thin bridge to the Rust backend. When running in a plain browser (vite dev),
// a small in-memory mock is used so the UI can be developed without Tauri.

const isTauri = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

let invokeImpl, listenImpl, convertImpl;

if (isTauri) {
  const core = await import("@tauri-apps/api/core");
  const event = await import("@tauri-apps/api/event");
  invokeImpl = core.invoke;
  convertImpl = core.convertFileSrc;
  listenImpl = event.listen;
} else {
  const mock = await import("./mock.js");
  invokeImpl = mock.invoke;
  listenImpl = mock.listen;
  convertImpl = (p) => (typeof p === "string" && p.startsWith("/") ? "/__fs?path=" + encodeURIComponent(p) : p);
}

export const IS_TAURI = isTauri;

// Any wait on the backend longer than half a second shows a thin moving line at the top of the
// window, so no button ever seems dead. Left out: dialogs waiting for you (picking a file or
// folder, signing in, printing) and long-running work with its own display.
const QUIET = /^(pick_[a-z_]+|ol_sign_in|lib_sign_in_pdf|print_file|define_english|translate_google|ai_chat|cc_run|cc_login|fs_watch|media_transcode|extract_with|launch_program|show_window|close_ack|exit_app|library_server|office_warm|web_search_engine)$/;
let busyN = 0, busyT = 0;
function busyLine(on) {
  let el = document.getElementById("busy-line");
  if (!el) { el = document.createElement("div"); el.id = "busy-line"; el.setAttribute("aria-hidden", "true"); document.body?.appendChild(el); }
  el.classList.toggle("on", on);
}
export async function call(cmd, args = {}) {
  const watch = !QUIET.test(cmd) && !(cmd === "office" && /^(word|deck)\.(key|type|click|pointer|state|render)$|^sheet\.(read|state)$/.test(args?.cmd || ""));
  if (watch && busyN++ === 0) busyT = setTimeout(() => busyLine(true), 500);
  try {
    return await invokeImpl(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e?.message || JSON.stringify(e));
  } finally {
    if (watch && --busyN === 0) { clearTimeout(busyT); busyLine(false); }
  }
}

export const listen = (name, cb) => listenImpl(name, (e) => cb(e.payload));
export const fileSrc = (p) => convertImpl(p);

export const api = {
  startupPaths: () => call("startup_paths"),
  readText: (path, encoding) => call("read_text", { path, encoding: encoding || null }),
  systemAnsi: () => call("system_ansi"),
  pathInfo: (path) => call("path_info", { path }),
  compareDirs: (a, b) => call("compare_dirs", { a, b }),
  writeText: (path, text, encoding, expectedMtime) => call("write_text", { path, text, encoding: encoding || null, expectedMtime: expectedMtime || null }),
  listDir: (path) => call("list_dir", { path }),
  pickOpenFile: () => call("pick_open_file"),
  pickImage: (dir) => call("pick_image", { dir: dir || null }),
  pickConvertFile: (dir) => call("pick_convert_file", { dir: dir || null }),
  pickFolder: (title) => call("pick_folder", { title: title || null }),
  pickSaveFile: (defaultName, dir) => call("pick_save_file", { defaultName, dir: dir || null }),
  loadSettings: () => call("load_settings"),
  saveSettings: (settings) => call("save_settings", { settings }),
  getSecret: (key) => call("get_secret", { key }),
  setSecret: (key, value) => call("set_secret", { key, value }),
  findRoot: (path) => call("find_root", { path }),
  compile: (root, engine) => call("compile", { root, engine }),
  readBinary: (path) => call("read_binary", { path }),
  fileMtime: (path) => call("file_mtime", { path }),
  renamePath: (from, name, root) => call("rename_path", { from, name, root }),
  /** A command that takes raw bytes plus headers (OCR images). */
  rawCall: async (cmd, bytes, headers) => {
    try { return await invokeImpl(cmd, bytes, { headers }); }
    catch (e) { throw new Error(typeof e === "string" ? e : e?.message || JSON.stringify(e)); }
  },
  /** Raw bytes, no JSON/base64 round trip. */
  writeBinary: async (path, bytes, mtime = 0, backup = true) => {
    const hex = [...new TextEncoder().encode(path)].map((b) => b.toString(16).padStart(2, "0")).join("");
    try { return await invokeImpl("write_binary", bytes, { headers: { "x-path": hex, "x-mtime": String(mtime || 0), "x-backup": backup ? "1" : "0" } }); }
    catch (e) { throw new Error(typeof e === "string" ? e : e?.message || JSON.stringify(e)); }
  },
  synctexForward: (pdf, file, line) => call("synctex_forward", { pdf, file, line }),
  synctexInverse: (pdf, page, x, y) => call("synctex_inverse", { pdf, page, x, y }),
  scanProject: (root) => call("scan_project", { root }),
  detectEngines: () => call("detect_engines"),
  installEngine: (kind) => call("install_engine", { kind }),
  cancelInstall: () => call("cancel_install"),
  removeEngine: (kind) => call("remove_engine", { kind }),
  assocStatus: () => call("assoc_status"),
  assocRegister: () => call("assoc_register"),
  assocUnregister: () => call("assoc_unregister"),
  openDefaultApps: () => call("open_default_apps"),
  openUrl: (url) => call("open_url", { url }),
  openPath: (path) => call("open_path", { path }),
  revealPath: (path) => call("reveal_path", { path }),
  appInfo: () => call("app_info"),
  uninstallInfo: () => call("uninstall_info"),
  uninstallEverything: (opts) => call("uninstall_everything", { opts }),
  handoff: (files) => call("handoff", { files }),
  historyRecord: (path, text, label, kind) => call("history_record", { path, text, label, kind }),
  historyRecordDisk: (paths, label, kind) => call("history_record_disk", { paths, label, kind }),
  historyList: (path) => call("history_list", { path }),
  historyGet: (path, id) => call("history_get", { path, id }),
  historyRename: (path, id, label) => call("history_rename", { path, id, label }),
  aiChat: (req) => call("ai_chat", { req }),
  aiCancel: (id) => call("ai_cancel", { id }),
  aiListModels: (provider) => call("ai_list_models", { provider }),
  verifyBib: (path, onlyKeys, deep) => call("verify_bib", { path, onlyKeys: onlyKeys || null, deep: deep || null }),
  skillsScan: (folders, includeOwn) => call("skills_scan", { folders, includeOwn }),
  skillsRead: (path) => call("skills_read", { path }),
  skillsGithubInspect: (url) => call("skills_github_inspect", { url }),
  skillsGithubInstall: (url, paths, claudeCode) => call("skills_github_install", { url, paths: paths || null, claudeCode: !!claudeCode }),
  skillsInstalled: () => call("skills_installed"),
  skillsUpdate: (folder) => call("skills_update", { folder: folder || null }),
  skillsRemove: (folder) => call("skills_remove", { folder }),
  // Claude Code
  ccStatus: () => call("cc_status"),
  ccInstall: () => call("cc_install"),
  ccLogin: () => call("cc_login"),
  ccLogout: () => call("cc_logout"),
  ccRun: (req) => call("cc_run", { req }),
  ccCancel: (id) => call("cc_cancel", { id }),
  ccReply: (rpc, value) => call("cc_reply", { rpc, value }),
  ccRestore: (path, backup, expectedSha, force) => call("cc_restore", { path, backup, expectedSha: expectedSha || null, force: !!force }),
  // Overleaf
  olTest: () => call("ol_test"),
  olSignIn: () => call("ol_sign_in"),
  olSignOut: () => call("ol_sign_out"),
  olListProjects: () => call("ol_list_projects"),
  olClone: (projectId, name, parent) => call("ol_clone", { projectId, name, parent }),
  olLink: (folder, projectId, name) => call("ol_link", { folder, projectId, name }),
  olUnlink: (folder) => call("ol_unlink", { folder }),
  olLinkInfo: (path) => call("ol_link_info", { path }),
  olPull: (folder) => call("ol_pull", { folder }),
  olPush: (folder) => call("ol_push", { folder }),
};
