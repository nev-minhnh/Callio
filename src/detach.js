// The AI chat in its own window, and back.
//
// Two windows work together: the editor window (it keeps the files, the selection and the compile
// result) and its chat window (the AI panel on its own: providers, Claude Code session tabs, activity,
// memory). The Claude Code processes live in Rust and just keep running; what moves is each window's
// picture of them (cc-sessions.js exportState / importState) and the question of which window
// answers their permission questions (cc_session_set_window).
//
//  pop out    editor: open the chat window → wait until its AI modules are up → settle and send the state
//             (chat.adopt) → chat applies it, tells Rust "this session's questions come to me" → editor
//             closes its panel and shows a thin rail instead.
//  attach     chat: tell the editor to keep events aside (chat.prepareAdopt) → settle and send the state
//             (chat.adopt) → editor applies it, takes the questions back → chat window closes.
//  while out  the chat window has no editor: host.js answers from a copy ("mirror") that the editor sends
//             whenever the tab list, selection or compile result change, and every action (open a file,
//             apply an edit, save, reload) is a request to the editor (winrpc.js, handlers below).
//
// If the other side does not answer, the sender takes its own state back, so nothing is lost.
import { call, listen } from "./api.js";
import { settings, toast, ask, basename } from "./main.js";
import { addVi } from "./i18n.js";
import { ic } from "./icons.js";
import * as rpc from "./winrpc.js";
import * as host from "./host.js";
import { winLabel, isChat, parentLabel } from "./windows.js";
import { htmlCache } from "./chat-view.js";
import "./detach.css";

const $ = (s) => document.querySelector(s);
const L = (en, vi) => (settings.uiLang === "vi" ? vi : en);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

addVi({
  "Pop out into its own window": "Tách ra cửa sổ riêng",
  "Pop out into its own window (Ctrl+Shift+L)": "Tách ra cửa sổ riêng (Ctrl+Shift+L)",
  "Attach": "Gắn lại",
  "Attach to the Callio window (Ctrl+Shift+D)": "Gắn lại vào cửa sổ Callio (Ctrl+Shift+D)",
  "Always on top": "Luôn ở trên cùng",
  "The AI panel is in its own window — click to attach it back": "Khung AI đang ở cửa sổ riêng — bấm để gắn lại",
  "Callio AI": "Callio AI",
  "Files, selection and compile results still come from the main Callio window; clicking a file name opens it there.": "Tệp, vùng chọn và kết quả biên dịch vẫn lấy từ cửa sổ Callio chính; bấm vào tên tệp sẽ mở nó ở đó.",
  "Hide this note": "Ẩn ghi chú này",
});

const chatLabelOf = (parent) => `chat-${parent}`;
const chatLabel = isChat ? winLabel : chatLabelOf(winLabel);
const editorLabel = isChat ? parentLabel : winLabel;

/** Pop out (editor window) or attach back (chat window); with the chat already out, bring it forward. */
export function toggleDetached() { return isChat ? attachBack() : out ? host.chatOut()?.focus() : popOut(); }

// ======================================================================================================
// the editor window
// ======================================================================================================
let out = false, busyPop = false, handlersOn = false, pushTimer = 0, sigTimer = 0, lastSig = "", expectedGone = false;

/** Start answering the chat window: what it asks of the editor (open, apply, save…). Cheap; done when needed. */
export function initEditorSide() {
  if (handlersOn || isChat) return;
  handlersOn = true;
  rpc.initWinRpc();
  host.onContextTouched(() => { if (out) { clearTimeout(pushTimer); pushTimer = setTimeout(pushContext, 120); } });
  const M = () => import("./main.js");
  const focusMe = () => call("win_focus", { label: winLabel }).catch(() => {});
  rpc.onRequest("ctx.get", async ({ doc }) => snapshot(!!doc));
  rpc.onRequest("editor.focus", () => { focusMe(); return true; });
  rpc.onRequest("editor.openPath", async ({ path, line }) => { await (await M()).openPath(path, line || undefined); focusMe(); return true; });
  rpc.onRequest("editor.apply", async ({ from, to, text, label, expect }) => {
    const ai = await (await M()).ensureAI();
    focusMe();
    await ai.applyAtLocal(from, to, text, label, expect);
    return true;
  });
  rpc.onRequest("editor.insert", async ({ text, label }) => {
    const ai = await (await M()).ensureAI();
    const s = (await import("./editor.js")).getView()?.state.selection.main;
    if (!s) throw new Error("Open a file in the editor first.");
    focusMe();
    await ai.applyAtLocal(s.from, s.to, text, label);
    return true;
  });
  rpc.onRequest("editor.compile", async () => { const r = await (await M()).compileFresh(); pushContext(); return !!r; });
  rpc.onRequest("editor.saveInside", async ({ dir }) => { await host.saveInside(dir); return true; });
  rpc.onRequest("editor.reload", async ({ paths, force, label }) => { await host.reloadFromDisk(paths || [], !!force, label || undefined); pushContext(); return true; });
  rpc.onRequest("editor.refreshTree", async () => { await host.refreshTree(); return true; });
  rpc.onRequest("editor.open", async ({ what, arg }) => {
    if (what === "settings") { (await import("./settings.js")).openSettings(arg); focusMe(); }
    return true;
  });
  // the chat window is back in the editor
  rpc.onRequest("chat.prepareAdopt", async () => { const cs = await sessions(); cs.beginAdopt(); return true; });
  rpc.onRequest("chat.abortAdopt", async () => { const cs = await sessions(); cs.endAdopt(); return true; });
  rpc.onRequest("chat.adopt", async ({ snap, cache }) => {
    const cs = await sessions();
    htmlCache.load(cache);
    await cs.importState(snap);
    await routeQuestionsHere(cs.handles(), winLabel);
    await leaveOut();
    return true;
  });
  rpc.onEvent("chat.status", (st) => { railState = st || railState; drawRail(); });
  rpc.onEvent("chat.hello", (d) => { if (d?.restore && !out) enterOut(chatLabel, { quiet: true }); });
  listen("chat-gone", () => { if (out && !expectedGone) chatVanished(); });
}

async function sessions() {
  const M = await import("./main.js");
  await M.ensureAI();
  const cs = await import("./cc-sessions.js");
  await cs.initSessions();
  return cs;
}

async function routeQuestionsHere(handles, label) {
  await Promise.all(handles.map((h) => call("cc_session_set_window", { handle: h, label }).catch(() => {})));
}

async function popOut() {
  if (busyPop || isChat) return;
  busyPop = true;
  try {
    initEditorSide();
    const cs = await sessions();
    if (cs.summary().busyApi) return toast(L("An answer is being written. Wait for it (or stop it), then pop the chat out.", "Câu trả lời đang được viết. Hãy đợi (hoặc dừng nó) rồi mới tách khung chat ra."), "warn", 5000);
    let label;
    try { label = await call("win_chat_open"); } catch (e) { return toast(e.message, "err", 6000); }
    // wait until the chat window has its AI modules up and is keeping events aside
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try { ready = await rpc.request(label, "chat.ready", {}, { timeout: 600 }); } catch { await sleep(250); }
    }
    if (!ready) { call("win_chat_close").catch(() => {}); return toast(L("The AI window didn't start. Try again.", "Cửa sổ AI không khởi động được. Hãy thử lại."), "err", 6000); }
    const snap = await cs.exportState(); // from here the events wait in this window (cc-sessions.js)
    try {
      await rpc.request(label, "chat.adopt", { snap, cache: htmlCache.dump() }, { timeout: 30000 });
    } catch (e) {
      await cs.importState(snap); // the chat window did not take it: carry on here
      rpc.notify(label, "chat.close");
      return toast(L("Couldn't move the chat to its own window. It is still here.", "Không chuyển được khung chat sang cửa sổ riêng. Nó vẫn ở đây."), "err", 6000);
    }
    cs.endAdopt(true); // dropped: the other window has it all
    await enterOut(label);
  } finally { busyPop = false; }
}

let railState = { run: 0, need: 0 };
async function enterOut(label, { quiet } = {}) {
  initEditorSide();
  const ai = await (await import("./main.js")).ensureAI();
  ai.toggleAIPanel(false); // (before the panel is marked as out: it closes and the setting follows)
  out = true; expectedGone = false;
  host.setChatOut({
    label,
    focus: () => call("win_chat_focus").catch(() => {}),
    forward: (method, params) => rpc.request(label, `chat.${method}`, params).catch(() => {}),
  });
  drawRail();
  startContextPush();
  if (!quiet) pushContext(true);
}

/** The chat is back (or was never gone): the panel opens here again. */
async function leaveOut() {
  if (!out) return;
  out = false;
  clearInterval(sigTimer); clearTimeout(pushTimer);
  host.setChatOut(null);
  $("#dt-rail")?.remove();
  const ai = await (await import("./main.js")).ensureAI();
  ai.toggleAIPanel(true);
}

/** The chat window went away without attaching back (it was killed): its sessions can't be shown anywhere. */
async function chatVanished() {
  out = false;
  clearInterval(sigTimer); clearTimeout(pushTimer);
  host.setChatOut(null);
  $("#dt-rail")?.remove();
  try {
    const list = await call("cc_session_list");
    for (const s of list) if (s.window === chatLabel) await call("cc_session_stop", { handle: s.handle }).catch(() => {});
  } catch { /* nothing to stop */ }
  toast(L("The AI window closed unexpectedly. Its Claude Code sessions were stopped; your conversations are saved.", "Cửa sổ AI đóng đột ngột. Các phiên Claude Code của nó đã dừng; cuộc trò chuyện vẫn được lưu."), "warn", 8000);
  (await (await import("./main.js")).ensureAI()).toggleAIPanel(true);
}

/** The editor window is closing: the chat window goes with it (asks first when a turn is running). */
export async function confirmClose() {
  if (!out) return true;
  let st = null;
  try { st = await rpc.request(chatLabel, "chat.query", {}, { timeout: 3000 }); } catch { /* not answering: close it anyway */ }
  if (st?.busy) {
    const r = await ask({ title: L("The AI is still working", "AI vẫn đang làm việc"), text: L("Closing this window also closes the AI window and stops what it is doing.", "Đóng cửa sổ này cũng đóng cửa sổ AI và dừng việc nó đang làm."), buttons: [{ label: L("Cancel", "Hủy"), value: null }, { label: L("Close and stop", "Đóng và dừng"), value: "go", primary: true }] });
    if (!r) return false;
  }
  expectedGone = true;
  try { await rpc.request(chatLabel, "chat.shutdown", {}, { timeout: 8000 }); } catch { /* it will be closed with this window */ }
  out = false;
  clearInterval(sigTimer);
  host.setChatOut(null);
  return true;
}

/** Whether the chat is out and how many sessions need attention (for the window title and tests). */
export const isOut = () => out;

// ---------------- the rail (the editor shows this where the panel was) ----------------
function drawRail() {
  if (!out) return;
  let rail = $("#dt-rail");
  if (!rail) {
    rail = document.createElement("div");
    rail.id = "dt-rail";
    $("#main").appendChild(rail);
    rail.addEventListener("click", (e) => { if (e.target.closest("#dt-attach")) toggleDetached(); else if (e.target.closest(".dt-dot")) host.chatOut()?.focus(); });
  }
  const { run, need } = railState;
  rail.innerHTML = `<button id="dt-attach" class="dt-btn" title="${esc(L("The AI panel is in its own window — click to attach it back", "Khung AI đang ở cửa sổ riêng — bấm để gắn lại"))}" aria-label="${esc(L("Attach the AI panel back to Callio", "Gắn khung AI lại vào Callio"))}">${ic("attach")}</button>`
    + (run ? `<span class="dt-dot run" role="img" title="${esc(L(`${run} session${run === 1 ? "" : "s"} running`, `${run} phiên đang chạy`))}" aria-label="${esc(L(`${run} running`, `${run} đang chạy`))}"></span>` : "")
    + (need ? `<span class="dt-dot need" role="img" title="${esc(L(`${need} session${need === 1 ? "" : "s"} need you`, `${need} phiên cần bạn`))}" aria-label="${esc(L(`${need} need you`, `${need} cần bạn`))}"></span>` : "");
}

// ---------------- what the chat window sees of the editor ----------------
const TEXTLESS = new Set(["doc", "sheet", "pdf", "deck", "image", "media", "drawio", "ipynb"]);
async function snapshot(full) {
  const M = await import("./main.js");
  const E = await import("./editor.js");
  const tabs = M.getTabs().map((t) => ({ id: t.id, path: t.path || "", name: t.name, kind: t.kind, dirty: !!t.dirty }));
  const t = M.activeTab();
  const v = t && !TEXTLESS.has(t.kind) ? E.getView() : null;
  const s = { folder: M.folder || "", tabs, activeId: t ? t.id : null, sel: null, head: 0, line: 1, docLen: 0, diagnostics: [], citations: [] };
  if (v) {
    const m = v.state.selection.main, doc = v.state.doc;
    s.head = m.head; s.docLen = doc.length; s.line = doc.lineAt(m.head).number;
    if (m.to > m.from) s.sel = { from: m.from, to: m.to, head: m.head, text: v.state.sliceDoc(m.from, Math.min(m.to, m.from + 200000)), lineFrom: doc.lineAt(m.from).number, lineTo: doc.lineAt(m.to).number };
    if (full) { s.docText = doc.length <= 2e6 ? doc.toString() : doc.sliceString(Math.max(0, m.head - 1e6), m.head + 1e6); s.docFor = t.id; }
  } else if (full) { s.docText = null; s.docFor = t ? t.id : null; }
  s.diagnostics = (M.getLastCompile()?.diagnostics || []).slice(0, 80).map((d) => ({ severity: d.severity, file: d.file || "", line: d.line || 0, message: String(d.message || "").slice(0, 400) }));
  s.citations = (E.project.citations || []).slice(0, 400);
  return s;
}
function startContextPush() {
  clearInterval(sigTimer);
  sigTimer = setInterval(() => pushContext(), 1000);
}
async function pushContext(force) {
  if (!out) return;
  let s;
  try { s = await snapshot(false); } catch { return; }
  const sig = JSON.stringify([s.folder, s.tabs, s.activeId, s.sel && [s.sel.from, s.sel.to, s.sel.text.length], s.head, s.docLen, s.diagnostics.length, s.citations.length]);
  if (!force && sig === lastSig) return;
  lastSig = sig;
  rpc.notify(chatLabel, "ctx", s);
}

// ======================================================================================================
// the chat window
// ======================================================================================================
let cs = null, ai = null, attaching = false;
const tStatus = { t: 0 };

/** Start the AI panel in a chat window (main.js boot calls this instead of ensureAI). */
export async function bootChat() {
  document.documentElement.classList.add("role-chat");
  await rpc.initWinRpc();
  // the first picture of the editor window (tabs, selection…), so the first chips are right
  try { host.setMirror(await rpc.request(editorLabel, "ctx.get", {}, { timeout: 4000 })); } catch { /* the editor window will push it */ }
  ai = await import("./ai.js");
  ai.initAI();
  import("./cc-quota.js").then((m) => m.initQuota());
  cs = await import("./cc-sessions.js");
  await cs.initSessions();
  buildHead();
  ai.toggleAIPanel(true);
  cs.setStatusHook(() => { clearTimeout(tStatus.t); tStatus.t = setTimeout(reportStatus, 300); });
  wireChat();
  updateTitle();
  addEventListener("callio-folder", updateTitle);
  window.__detach = { attachBack, state: () => ({ attaching }) };
}

function updateTitle() {
  const f = host.getFolder();
  const name = f ? basename(f.replace(/[\\/]+$/, "")) || f : "";
  const chip = $("#dt-folder");
  if (chip) { chip.textContent = name ? `${name}/` : ""; chip.title = f || ""; chip.hidden = !name; }
  call("set_title", { title: `Callio — AI${name ? ` · ${name}` : ""}` }).catch(() => {});
  document.title = `Callio — AI${name ? ` · ${name}` : ""}`;
}

function buildHead() {
  const panel = $("#ai-panel");
  const head = document.createElement("div");
  head.id = "dt-head";
  head.innerHTML = `<span class="dt-ic">${ic("sparkles")}</span><b>Callio AI</b><span id="dt-folder" class="dt-chip" hidden></span><span class="tb-spacer"></span>`
    + `<button id="dt-pin" class="icon small" type="button" aria-pressed="false" title="Always on top">${ic("pin")}</button>`
    + `<button id="dt-attach-btn" class="small" type="button" title="Attach to the Callio window (Ctrl+Shift+D)">${ic("attach")}<span>Attach</span></button>`;
  panel.prepend(head);
  const note = document.createElement("div");
  note.id = "dt-note";
  note.innerHTML = `<span>Files, selection and compile results still come from the main Callio window; clicking a file name opens it there.</span><button class="icon small" type="button" title="Hide this note" aria-label="Hide this note">${ic("x")}</button>`;
  let hidden = false;
  try { hidden = localStorage.getItem("callio.dtNoteHidden") === "1"; } catch { /* no storage */ }
  note.hidden = hidden;
  head.after(note);
  note.querySelector("button").onclick = () => { note.hidden = true; try { localStorage.setItem("callio.dtNoteHidden", "1"); } catch { /* no storage */ } };
  $("#dt-attach-btn").onclick = () => attachBack();
  const pin = $("#dt-pin");
  let on = false;
  try { on = localStorage.getItem("callio.dtPin") === "1"; } catch { /* no storage */ }
  const setPin = (v) => { on = v; pin.setAttribute("aria-pressed", String(v)); pin.classList.toggle("on", v); call("win_chat_pin", { on: v }).catch(() => {}); try { localStorage.setItem("callio.dtPin", v ? "1" : "0"); } catch { /* no storage */ } };
  pin.onclick = () => setPin(!on);
  if (on) setPin(true);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "D" || e.key === "d" || e.key === "L" || e.key === "l")) { e.preventDefault(); e.stopPropagation(); attachBack(); }
  }, true);
}

function reportStatus() {
  if (!cs) return;
  const { run, need } = cs.summary();
  rpc.notify(editorLabel, "chat.status", { run, need });
}

function wireChat() {
  rpc.onRequest("chat.ready", () => true);
  // the editor window sends its state (pop out)
  rpc.onRequest("chat.adopt", async ({ snap, cache }) => {
    htmlCache.load(cache);
    await cs.importState(snap);
    await routeQuestionsHere(cs.handles(), winLabel);
    reportStatus();
    updateTitle();
    return true;
  });
  rpc.onRequest("chat.query", () => ({ busy: cs.anyBusy() || cs.summary().busyApi }));
  rpc.onRequest("chat.shutdown", async () => { await cs.stopAll(); setTimeout(() => call("win_chat_close").catch(() => {}), 50); return true; });
  rpc.onRequest("chat.attach", () => { attachBack(); return true; });
  rpc.onRequest("chat.addToChat", async ({ path, isDir }) => { await ai.addToChat(path, isDir); call("win_focus", { label: winLabel }).catch(() => {}); return true; });
  rpc.onEvent("chat.close", () => call("win_chat_close").catch(() => {}));
  rpc.onEvent("ctx", (m) => { host.setMirror(m); ai.refreshAIContext(); });
  listen("chat-close-requested", () => attachBack(true));
  // tell the editor window we exist (it re-enters "chat is out" when this window was brought back after a crash)
  const restore = new URLSearchParams(location.search).get("restore") === "1";
  rpc.notify(editorLabel, "chat.hello", { restore });
  if (restore) {
    cs.endAdopt();
    cs.restoreOwn().catch((e) => console.warn("restore chat", e));
  }
}

/**
 * Put the chat back into the editor window and close this one. `fromClose`: the window's close button.
 * Settles the tabs, hands them over, and only then closes; if the editor does not take them the chat stays.
 */
export async function attachBack(fromClose) {
  if (!isChat || attaching) return;
  attaching = true;
  const keepOpen = async () => { call("close_ack").catch(() => {}); };
  try {
    if (cs.summary().busyApi) {
      const r = await ask({ title: L("An answer is being written", "Câu trả lời đang được viết"), text: L("Attaching the chat to the Callio window stops it. Stop it and attach?", "Gắn khung chat lại sẽ dừng nó. Dừng và gắn lại?"), buttons: [{ label: L("Cancel", "Hủy"), value: null }, { label: L("Stop and attach", "Dừng và gắn lại"), value: "go", primary: true }] });
      if (!r) return keepOpen();
      $("#ai-stop")?.click();
      for (let i = 0; i < 40 && cs.summary().busyApi; i++) await sleep(100);
      if (cs.summary().busyApi) { toast(L("It didn't stop yet. Try again in a moment.", "Chưa dừng được. Hãy thử lại sau giây lát."), "warn", 4000); return keepOpen(); }
    }
    try { await rpc.request(editorLabel, "chat.prepareAdopt", {}, { timeout: 4000 }); }
    catch {
      // the editor window isn't there: nothing to attach to
      const r = await ask({ title: L("The Callio window isn't open", "Cửa sổ Callio không còn mở"), text: L("Close the AI window and stop its Claude Code sessions?", "Đóng cửa sổ AI và dừng các phiên Claude Code của nó?"), buttons: [{ label: L("Cancel", "Hủy"), value: null }, { label: L("Close and stop", "Đóng và dừng"), value: "go", primary: true }] });
      if (!r) return keepOpen();
      await cs.stopAll();
      return void call("win_chat_close");
    }
    const snap = await cs.exportState();
    try {
      await rpc.request(editorLabel, "chat.adopt", { snap, cache: htmlCache.dump() }, { timeout: 30000 });
    } catch (e) {
      await cs.importState(snap); // the editor did not take it: stay
      rpc.request(editorLabel, "chat.abortAdopt").catch(() => {});
      toast(L("Couldn't attach the chat to the Callio window. It stays here.", "Không gắn lại được khung chat vào cửa sổ Callio. Nó vẫn ở đây."), "err", 6000);
      return keepOpen();
    }
    cs.endAdopt(true);
    await call("win_chat_close");
  } finally { attaching = false; }
}
