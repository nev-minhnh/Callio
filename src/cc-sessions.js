// Claude Code sessions in the AI panel: live, parallel, steerable, observable.
//
// Every Claude Code chat is a tab. Behind a tab is one long-lived `claude` process (the Rust side,
// claude_code/session.rs) that reads messages while it works, so:
//   - the text box never locks: "Send next" (Enter) queues the message for after the step now
//     running, "Interrupt & send" (Ctrl+Enter) stops the step first, Stop (Esc) stops everything;
//   - several sessions run side by side; each tab keeps its own message list (a hidden
//     `.ai-messages` element) and its own chat state; events and permission questions are routed
//     to the tab they belong to;
//   - what the model and its subagents do shows in the activity strip / column (activity.js);
//   - a journal on disk (written by the Rust side) lets the sessions come back after a power cut.
// ai.js keeps the conversation (history, saved chats, project memory); this file keeps the
// sessions. The chat that is in view is ai.js's live `chat` object; the other tabs' chats are
// kept here and swapped in when picked.
import { call, listen } from "./api.js";
import { settings, updateSettings, toast, ask, basename } from "./main.js";
import * as host from "./host.js"; // [detach] the editor's files: this window's, or (chat window) the editor window's
const { reloadFromDisk, refreshTree } = host;
import { chatState, swapChat, freshChatState, resetChat, registerSessions, addMsg, loadSession, refreshAIContext, renderSessBar, ccUiFor } from "./ai.js";
import { ccRunIn, fromClaude } from "./envs-core.js"; // [wsl]
import { toolTitle, EDIT_TOOLS, renderChanges, errorHtml, permissionCard, cards, setSessionHooks, SYSTEM, contextPreamble, projectDir } from "./claude-code.js";
import { createStreamer } from "./stream.js";
import { initRpc } from "./rpc.js";
import { registerRestorer } from "./restore.js";
import { addVi } from "./i18n.js";
import { ic } from "./icons.js";
import * as act from "./activity.js";
import * as rc from "./remote.js"; // [remote]
import "./cc-sessions.css";

// this window's label: permission questions of its sessions come back here
const WIN = new URLSearchParams(location.search).get("win") || "main";

const $ = (s) => document.querySelector(s);
const { L, esc } = act;
const norm = (p) => (p || "").replace(/\\/g, "/").toLowerCase();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => ((Math.random() * 16) | 0).toString(16)));

const tabs = [];
let active = null;
const byHandle = new Map();
let inited = false, seq = 0, pendingMode = null;
let dom = {};

addVi({
  "Sessions": "Phiên", "New session": "Phiên mới", "Close session": "Đóng phiên", "All Claude Code sessions": "Tất cả phiên Claude Code", "Open sessions": "Phiên đang mở",
  "Queued —": "Đã xếp hàng —", "reads it after the step it is doing now:": "đọc sau bước đang chạy:", "Waiting for a free slot —": "Đang chờ đến lượt —", "starts when another session finishes:": "sẽ chạy khi có phiên khác xong:",
  "Take this message back": "Bỏ tin nhắn đã xếp hàng", "Send next": "Gửi tiếp", "Interrupt & send": "Ngắt & gửi", "Stop (Esc)": "Dừng (Esc)",
  "Add a request while the model works… (Enter: send next · Ctrl+Enter: interrupt & send)": "Thêm yêu cầu khi model đang chạy… (Enter: gửi tiếp · Ctrl+Enter: ngắt & gửi)",
  "The model reads it after the step it is doing now": "Model đọc sau khi xong bước đang chạy", "Stop the step that is running now, then do this": "Dừng ngay bước đang chạy rồi làm theo yêu cầu này",
  "Open the activity panel": "Mở bảng hoạt động", "Close the activity panel": "Đóng bảng hoạt động", "Collapse": "Thu gọn", "Activity": "Hoạt động",
  "Show activity as a column beside the chat": "Hiện hoạt động thành cột bên cạnh khung chat", "Show activity as a strip above the input": "Hiện hoạt động thành dải phía trên ô nhập",
  "New activity": "Có hoạt động mới", "Continue": "Tiếp tục", "Discard": "Bỏ", "Claude Code sessions": "Các phiên Claude Code",
  "Claude Code sessions at once": "Số phiên Claude Code chạy cùng lúc", "Close an idle session after (minutes)": "Đóng phiên nhàn rỗi sau (phút)", "Activity panel": "Bảng hoạt động",
  "A strip above the input": "Dải phía trên ô nhập", "A column beside the chat": "Cột bên cạnh khung chat",
  "Idle sessions are closed to free memory; the next message resumes them where they were.": "Phiên nhàn rỗi được đóng để giải phóng bộ nhớ; tin nhắn kế tiếp sẽ tiếp tục phiên từ chỗ cũ.",
  "This session was interrupted": "Phiên này bị gián đoạn", "Stop this session?": "Dừng phiên này?", "Cancel": "Hủy", "Stop and close": "Dừng và đóng",
  "Claude Code is still working in it. Closing the tab stops it.": "Claude Code vẫn đang làm việc trong phiên này. Đóng tab sẽ dừng phiên.",
  "No sessions yet.": "Chưa có phiên nào.",
});

// ---------------- state of one session ----------------
const newAct = () => ({ startedAt: Date.now(), endedAt: 0, tokens: 0, step: null, todos: [], agents: new Map() });
function makeRuntime(tab) {
  return {
    tab, handle: null, status: "idle", proc: false, claudeId: null, cwd: null, model: null, modelSeen: null,
    turnActive: false, serverQueue: [], queue: [], msgs: new Map(), ui0: null,
    seg: null, lastSeg: null, chain: Promise.resolve(), doneQueue: [], doneTimer: 0,
    toolParent: new Map(), perms: new Map(), transcript: [],
    act: newAct(), ui: { open: false, sel: null }, writing: false, writingTimer: 0, showActivity: false,
    stopRequested: false, autoEdits: false, lastResult: null, summary: null, lastError: "", limit: false, ranOnce: false,
    remote: null, // [remote] {on, connected, connectUrl, …}
  };
}
const busy = (rt) => !!rt && (rt.turnActive || rt.status === "queued");
const chatOf = (tab) => (tab === active ? chatState() : tab.chat);
const tabOf = (chat) => tabs.find((t) => chatOf(t) === chat);
const titleOf = (tab) => {
  const c = chatOf(tab);
  return c?.title || tab.pendingTitle || (c?.history?.find((m) => m.role === "user")?.content || "").replace(/\s+/g, " ").trim().slice(0, 40) || L("New chat", "Chat mới");
};
const modelOf = (rt) => rt?.modelSeen || rt?.model || (settings.aiModel_chat || "").split("|")[1] || "";

// ---------------- init ----------------
export async function initSessions() {
  if (inited) { renderAll(); return; }
  inited = true;
  const list = $("#ai-messages");
  list.classList.add("ai-messages");
  const tab = { id: `t${++seq}`, list, chat: null, rt: null, draft: "", unseen: false };
  list.dataset.session = tab.id;
  tabs.push(tab);
  active = tab;
  buildChrome();
  registerSessions({ sendMessage, newTab, toggleRemote, isBusy: () => busy(active?.rt), onReset, titleChanged, transcript: () => (active?.rt?.transcript || []).map((x) => ({ ...x })) });
  setSessionHooks({ permission: onPermission, answered: onPermAnswered });
  await initRpc();
  await listen("cc-session", onSession);
  registerRestorer({
    id: "cc-sessions", order: 30,
    describe: async () => { const n = (await unfinished()).length; return n ? L(`${n} Claude Code session${n === 1 ? "" : "s"} interrupted`, `${n} phiên Claude Code chạy dở`) : null; },
    restore: restoreAll,
    discard: async () => { await call("cc_journal_end", { handles: null }).catch(() => {}); },
  });
  setInterval(tick, 1000);
  renderAll();
}

function el(tag, cls, id) { const e = document.createElement(tag); if (cls) e.className = cls; if (id) e.id = id; return e; }

function buildChrome() {
  const sess = $(".ai-sess");
  sess.classList.add("with-tabs");
  dom.tabs = el("div", "ai-tabs", "ai-tabs");
  sess.prepend(dom.tabs);
  // [remote] the 📱 button sits in the title row (the tabs row has no room to spare)
  dom.rc = el("button", "icon small cs-rc", "cc-rc");
  dom.rc.type = "button"; dom.rc.textContent = "📱";
  dom.rc.title = L("Control this session from the Claude app on your phone", "Điều khiển phiên này từ ứng dụng Claude trên điện thoại");
  dom.rc.setAttribute("aria-label", "Remote control");
  dom.rc.onclick = () => void remoteButton();
  $("#ai-sess-new")?.after(dom.rc);
  dom.pop = el("div", "cs-pop", "cc-sess-pop");
  dom.pop.hidden = true;
  sess.appendChild(dom.pop);
  const input = $(".ai-input");
  dom.strip = el("div", "ai-activity", "ai-activity");
  dom.queue = el("div", "ai-queue", "ai-queue");
  dom.strip.hidden = true; dom.queue.hidden = true;
  input.before(dom.strip, dom.queue);
  dom.col = el("aside", "ai-act-col", "ai-act-col");
  dom.col.hidden = true;
  dom.col.setAttribute("aria-label", "Activity");
  $("#ai-panel").after(dom.col);
  dom.now = el("button", "small", "ai-send-now");
  dom.now.type = "button";
  dom.now.hidden = true;
  dom.now.innerHTML = `${act.ICONS.bolt}<span>Interrupt & send</span>`;
  dom.now.title = "Stop the step that is running now, then do this";
  $("#ai-send").before(dom.now);
  dom.send = $("#ai-send");
  dom.sendHtml = dom.send.innerHTML;
  dom.stop = $("#ai-stop");
  dom.stopHtml = dom.stop.innerHTML;
  dom.text = $("#ai-text");
  dom.ph = dom.text.placeholder;

  dom.tabs.addEventListener("click", (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "list") return togglePop();
    if (a === "new") return void newTab();
    const t = tabs.find((x) => x.id === e.target.closest("[data-tab]")?.dataset.tab);
    if (!t) return;
    if (a === "close") { e.stopPropagation(); return void closeTab(t); }
    switchTo(t);
  });
  dom.tabs.addEventListener("keydown", (e) => {
    const t = tabs.find((x) => x.id === e.target.closest?.("[data-tab]")?.dataset.tab);
    if (t && (e.key === "Enter" || e.key === " ") && e.target.matches?.(".cs-tab")) { e.preventDefault(); switchTo(t); }
    if (t && (e.key === "ArrowRight" || e.key === "ArrowLeft") && e.target.matches?.(".cs-tab")) {
      const n = tabs[(tabs.indexOf(t) + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      switchTo(n); dom.tabs.querySelector(`[data-tab="${n.id}"]`)?.focus();
    }
  });
  dom.pop.addEventListener("click", onPopClick);
  document.addEventListener("pointerdown", (e) => { if (!dom.pop.hidden && !e.target.closest("#cc-sess-pop, .cs-list-btn")) dom.pop.hidden = true; });
  const onAct = (e) => {
    const b = e.target.closest("[data-a]");
    if (!b || !active?.rt) return;
    const rt = active.rt, a = b.dataset.a;
    if (a === "toggle") { rt.ui.open = !rt.ui.open; renderAll(true); }
    else if (a === "layout") setLayout(layout() === "strip" ? "column" : "strip");
    else if (a === "pick") { const k = b.dataset.key || null; rt.ui.sel = rt.ui.sel === k ? null : k; renderAll(true); }
    else if (a === "allow" || a === "deny") answerPerm(Number(b.dataset.rpc), a === "allow");
    else if (a === "full-log") { const ag = rt.act.agents.get(b.dataset.key); if (ag) act.showFullLog(ag); }
    else if (a === "stop-agent") { const ag = rt.act.agents.get(b.dataset.key); if (ag?.taskId) call("cc_session_stop_task", { handle: rt.handle, taskId: ag.taskId }).catch((er) => toast(er.message, "err")); }
  };
  dom.strip.addEventListener("click", onAct);
  dom.col.addEventListener("click", onAct);
  dom.queue.addEventListener("click", (e) => { const b = e.target.closest("[data-uuid]"); if (b) takeBack(b.dataset.uuid); });
  dom.now.onclick = () => { if (!dom.text.value.trim()) return; pendingMode = { mode: "now", at: Date.now() }; dom.send.click(); };
  // Ctrl+Enter = interrupt & send; Esc = stop (only while a Claude Code turn runs)
  const panel = $("#ai-panel");
  panel.addEventListener("keydown", (e) => {
    const rt = active?.rt;
    if (!busy(rt)) return;
    if (e.key === "Enter" && e.ctrlKey && e.target === dom.text) { e.preventDefault(); e.stopImmediatePropagation(); dom.now.click(); }
    else if (e.key === "Escape" && !e.defaultPrevented && $("#ai-slash")?.hidden !== false && !document.querySelector("dialog[open]") && !dom.pop.hidden === false) { e.preventDefault(); stopTab(active); }
  }, true);
  new ResizeObserver(() => { panel.style.setProperty("--ai-ph", panel.clientHeight + "px"); }).observe(panel);
}

const layout = () => (settings.activityLayout === "column" ? "column" : "strip");
function setLayout(l) { updateSettings({ activityLayout: l }); renderAll(true); }

// ---------------- tabs ----------------
export async function newTab() {
  const list = el("div", "ai-messages");
  list.hidden = true;
  const tab = { id: `t${++seq}`, list, chat: freshChatState(), rt: null, draft: "", unseen: false };
  list.dataset.session = tab.id;
  active.list.after(list);
  tabs.push(tab);
  switchTo(tab);
  resetChat();
  dom.text.focus();
  return tab;
}

function switchTo(tab) {
  if (tab === active) return;
  const prev = active;
  prev.draft = dom.text.value;
  prev.chat = swapChat(tab.chat);
  tab.chat = null;
  prev.list.hidden = true;
  prev.list.removeAttribute("id");
  tab.list.hidden = false;
  tab.list.id = "ai-messages";
  active = tab;
  tab.unseen = false;
  dom.text.value = tab.draft || "";
  renderSessBar();
  refreshAIContext();
  if (dom.pop) dom.pop.hidden = true;
  if (tab.rt) { act.hideToast($("#ai-panel")); }
  renderAll(true);
}

async function closeTab(tab) {
  const rt = tab.rt;
  if (busy(rt)) {
    const r = await ask({ title: "Stop this session?", text: "Claude Code is still working in it. Closing the tab stops it.", buttons: [{ label: "Cancel", value: null }, { label: "Stop and close", value: "go", primary: true }] });
    if (!r) return;
  }
  if (rt) await disposeRt(rt, true);
  if (tabs.length === 1) { resetChat(); return renderAll(true); }
  const i = tabs.indexOf(tab);
  if (tab === active) switchTo(tabs[i + 1] || tabs[i - 1]);
  tabs.splice(tabs.indexOf(tab), 1);
  tab.list.remove();
  renderAll(true);
}

/** End a tab's session (the process stops; the journal is kept as ended). */
async function disposeRt(rt, closing) {
  if (rt.handle) {
    declineAll(rt);
    announceEnded(rt, true);
    byHandle.delete(rt.handle);
    await call("cc_session_stop", { handle: rt.handle }).catch(() => {});
  }
  clearTimeout(rt.doneTimer);
  rt.tab.rt = null;
  if (!closing) { rt.seg = null; }
}

/** ai.js starts the chat in view over (folder changed, a saved chat was loaded): its session is over. */
function onReset() {
  const rt = active?.rt;
  if (rt) { disposeRt(rt, false); const c = chatState(); c.cc = { id: null }; }
  if (active) active.pendingTitle = "";
  renderAll(true);
}
function titleChanged(c) {
  const t = tabOf(c);
  if (t?.rt?.handle) call("cc_session_meta", { handle: t.rt.handle, meta: { chatSid: c.sid, project: c.project ?? "", title: c.title || "" } }).catch(() => {});
  renderAll();
}

// ---------------- sending ----------------
/**
 * Send one message of the chat in view to its Claude Code session. `text` is what the author typed
 * (shown in the chat), `prompt` what goes to the model; `ui` holds ai.js's chat helpers.
 */
export async function sendMessage(text, prompt, ui) {
  const tab = active, chat = chatState();
  const cwd = projectDir();
  if (!cwd) throw new Error("Open a project folder or a saved file first — Claude Code works inside a folder.");
  // Claude Code reads files from disk: save open edits first (each save keeps a version)
  await host.saveInside(cwd);
  const rt = (tab.rt ??= makeRuntime(tab));
  const model = (settings.aiModel_chat || "claudecode|default").split("|")[1];
  const skills = await ui.skillsForClaude();
  const label = (ui.shown || text).replace(/\s+/g, " ").slice(0, 50);
  const mode = pendingMode && Date.now() - pendingMode.at < 15000 ? pendingMode.mode : "next";
  pendingMode = null;
  tab.pendingTitle ||= label;
  const sshx = await import("./ssh.js").then((m) => m.sessionExtras(cwd)).catch(() => ({})); // [ssh] where it runs
  const patch = {
    model, permissionMode: settings.ccPermissionMode || "default", label, memory: ui.memory || "", systemAppend: SYSTEM + skills + (sshx.note ? "\n\n" + sshx.note : ""),
    effort: /haiku/.test(model) ? "" : (settings.aiEffort || ""), thinking: settings.aiThinking !== false,
    web: settings.aiWeb === false ? "off" : (settings.aiSearchEngine && settings.aiSearchEngine !== "auto" ? settings.aiSearchEngine : ""),
    maxParallel: +settings.ccMaxParallel || 4, idleMinutes: +settings.ccIdleMinutes || 30,
  };
  if (!rt.handle) await openHandle(rt, chat, cwd, model, patch, label, sshx);
  if (rt.model && rt.model !== model) rt.modelSeen = null; // switched: what the process said at start is stale
  rt.model = model;
  const m = { uuid: uid(), text, ui, delivered: false, mode };
  rt.msgs.set(m.uuid, m);
  rt.ui0 = ui;
  const wasBusy = busy(rt);
  if (!wasBusy) {
    // a new turn: the message and the start of the answer show at once
    rt.turnActive = true; rt.status = "starting"; rt.proc = rt.proc || false;
    startTurnAct(rt);
    deliver(rt, m);
  } else if (mode === "next") {
    rt.queue.push(m);
  }
  renderAll(true);
  try {
    const r = await call("cc_session_send", { handle: rt.handle, text: contextPreamble(ui.ctx) + prompt, mode, uuid: m.uuid, patch });
    if (mode === "now" || !wasBusy) deliver(rt, m);
    m.slot = r.state === "queued";
  } catch (e) {
    rt.queue = rt.queue.filter((x) => x !== m);
    rt.msgs.delete(m.uuid);
    if (!wasBusy) { rt.turnActive = false; rt.status = "idle"; rt.seg?.el.remove(); rt.seg = null; }
    renderAll(true);
    throw e;
  }
}

/** Start the backend session of a tab (its Claude Code process starts with the first message, or when Remote Control is turned on). */
async function openHandle(rt, chat, cwd, model, patch, label, sshx) {
  const r = await call("cc_session_start", { req: { cwd, runOn: sshx.runOn || null, model, permissionMode: patch.permissionMode, systemAppend: patch.systemAppend, label, effort: patch.effort || null, thinking: patch.thinking, web: patch.web || null, resumeId: chat.cc.id || null, window: WIN, maxParallel: patch.maxParallel, idleMinutes: patch.idleMinutes, runIn: ccRunIn(cwd), meta: { chatSid: chat.sid, project: chat.project ?? "", title: chat.title || label, win: WIN } } });
  rt.handle = r.handle; rt.cwd = cwd; rt.model = model;
  byHandle.set(rt.handle, rt);
}

function startTurnAct(rt) {
  const keep = new Map([...rt.act.agents].filter(([, a]) => a.status === "running" || a.status === "waiting"));
  rt.act = { ...newAct(), agents: keep, todos: rt.act.todos };
  rt.showActivity = true;
  rt.stopRequested = false;
  rt.lastResult = null;
  rt.ranOnce = true;
}

/** Take back a queued message (only while Claude Code has not read it). */
async function takeBack(uuid) {
  const rt = active?.rt;
  const m = rt?.msgs.get(uuid);
  if (!m || m.delivered) return;
  let ok = false;
  try { ok = await call("cc_session_cancel_queued", { handle: rt.handle, uuid }); } catch (e) { toast(e.message, "err"); }
  if (!ok) { toast(L("Claude Code has already read that message.", "Claude Code đã đọc tin nhắn đó rồi."), "", 3000); return; }
  rt.queue = rt.queue.filter((x) => x !== m);
  rt.msgs.delete(uuid);
  if (!dom.text.value.trim()) dom.text.value = m.text;
  renderAll(true);
}

async function stopTab(tab) {
  const rt = tab?.rt;
  if (!rt?.handle || !busy(rt)) return;
  rt.stopRequested = true;
  declineAll(rt);
  rt.queue = [];
  renderAll(true);
  try { await call("cc_session_interrupt", { handle: rt.handle }); } catch (e) { toast(e.message, "err"); }
}

/** Say no to every open question of a session (it was stopped or closed). */
function declineAll(rt) {
  for (const p of [...rt.perms.values()]) {
    const b = cards.get(p.rpc)?.querySelector(".cc-deny");
    if (b) b.click(); else call("cc_reply", { rpc: p.rpc, value: { allow: false, message: "Stopped by the user" } }).catch(() => {});
  }
  rt.perms.clear();
}

// ---------------- Remote Control (remote.js) ----------------
/** The session of a tab, started now if it has none yet (Remote Control can be switched on before the first message). */
async function ensureSession(tab) {
  const chat = chatOf(tab);
  const rt = (tab.rt ??= makeRuntime(tab));
  if (rt.handle) return rt;
  const cwd = projectDir();
  if (!cwd) throw new Error("Open a project folder or a saved file first — Claude Code works inside a folder.");
  await host.saveInside(cwd);
  const model = (settings.aiModel_chat || "claudecode|default").split("|")[1];
  const label = titleOf(tab);
  const ui = (await import("./ai.js")).ccUi(label);
  const skills = await ui.skillsForClaude();
  const sshx = await import("./ssh.js").then((m) => m.sessionExtras(cwd)).catch(() => ({})); // [ssh]
  const patch = {
    permissionMode: settings.ccPermissionMode || "default", systemAppend: SYSTEM + skills + (sshx.note ? "\n\n" + sshx.note : ""),
    effort: /haiku/.test(model) ? "" : (settings.aiEffort || ""), thinking: settings.aiThinking !== false,
    web: settings.aiWeb === false ? "off" : (settings.aiSearchEngine && settings.aiSearchEngine !== "auto" ? settings.aiSearchEngine : ""),
    maxParallel: +settings.ccMaxParallel || 4, idleMinutes: +settings.ccIdleMinutes || 30,
  };
  await openHandle(rt, chat, cwd, model, patch, label, sshx);
  return rt;
}

/** Turn Remote Control on (and show the link and QR code) or off for the session in view. Used by `/rc`. */
async function toggleRemote() {
  const tab = active;
  try {
    const rt = await ensureSession(tab);
    if (rc.rcOn(rt)) { await rc.setRemote(rt, false); rc.hideRemotePanel(); renderAll(true); toast(L("Remote control is off", "Điều khiển từ xa đang tắt"), "", 2500); return; }
    await enableRemote(rt);
  } catch (e) { toast(String(e?.message || e), "err", 7000); }
}
async function enableRemote(rt) {
  rc.showRemotePanel(rt, () => renderAll(true));
  const p = rc.setRemote(rt, true, titleOf(rt.tab));
  renderAll(true); rc.refreshRemotePanel(rt);
  try { await p; } catch (e) { rc.refreshRemotePanel(rt); renderAll(true); throw e; }
  renderAll(true); rc.refreshRemotePanel(rt);
}
/** The 📱 button beside the tabs: turn it on, or (when on) show the link again. */
async function remoteButton() {
  const rt = active?.rt;
  if (rc.remotePanelOpen()) return rc.hideRemotePanel();
  if (rt && rc.rcOn(rt)) { rc.showRemotePanel(rt, () => renderAll(true)); return; }
  try {
    const r = await ensureSession(active);
    await enableRemote(r);
  } catch (e) { toast(String(e?.message || e), "err", 7000); }
}

// ---------------- events from the backend ----------------
const H = {
  remote(rt, e) { rc.applyRemote(rt, e); rc.refreshRemotePanel(rt); renderAll(true); },
  remote_error(rt, e) { rc.remoteFailed(rt, e.error); rc.refreshRemotePanel(rt); renderAll(true); toast(`${L("Remote control couldn't start", "Không bật được điều khiển từ xa")}: ${e.error}`, "err", 7000); },
  bridge(rt, e) { rc.applyBridge(rt, e); rc.refreshRemotePanel(rt); renderAll(); },
  /** Typed on the phone: shown like the author's own message, with a label. */
  phone_msg(rt, e) {
    if (rt.msgs.has(e.uuid)) return;
    const c = chatOf(rt.tab);
    const ui = ccUiFor({ text: e.text, memText: "", memAt: { project: c?.project || "", session: c?.mem, file: "", model: modelOf(rt) }, skills: [] }, c?.ctx);
    const m = { uuid: e.uuid, text: e.text, ui, delivered: false, phone: true };
    rt.msgs.set(e.uuid, m);
    rt.ui0 = rt.ui0 || ui;
    if (!rt.turnActive) { rt.turnActive = true; rt.status = "running"; startTurnAct(rt); }
    deliver(rt, m);
  },
  /** Stopped from the phone. */
  remote_interrupt(rt) {
    rt.stopRequested = true;
    (rt.seg || rt.lastSeg)?.toolsEl.insertAdjacentHTML("beforeend", rc.phoneStopHtml());
  },
  status(rt, e) {
    const was = busy(rt);
    rt.status = e.status; rt.proc = !!e.proc; rt.turnActive = !!e.turnActive;
    if (e.claudeId) rt.claudeId = e.claudeId;
    rt.serverQueue = e.queued || [];
    if (rt.turnActive && !was) startTurnAct(rt);
    if (e.status === "error") rt.limit = /limit|quota|usage/i.test(rt.lastError || "");
    if (was && !busy(rt)) endTurn(rt);
    renderAll(true);
  },
  session_id(rt, e) {
    rt.claudeId = e.sessionId;
    const c = chatOf(rt.tab);
    if (c) c.cc = { id: e.sessionId };
  },
  init(rt, e) {
    rt.modelSeen = e.model || rt.modelSeen;
    const seg = rt.seg || rt.lastSeg;
    if (!seg) return;
    const callio = (e.mcp || []).find((s) => s.name === "callio");
    if (callio?.status && callio.status !== "connected") seg.toolsEl.insertAdjacentHTML("beforeend", `<div class="tool-chip err">Callio tools unavailable (${esc(callio.status)})</div>`);
    const asked = settings.ccPermissionMode || "default";
    if (asked === "auto" && e.permissionMode && e.permissionMode !== "auto") seg.toolsEl.insertAdjacentHTML("beforeend", `<div class="tool-chip warn" title="Auto mode needs Claude Code 2.1.233+ on Windows and a supported model (e.g. Opus 4.6+, Sonnet 4.6+). Update Claude Code, pick another model, or choose Full access.">⚡ Auto mode isn't available here — Claude Code will ask instead</div>`);
  },
  ev(rt, e) { onEv(rt, e.ev); },
  todos(rt, e) { rt.act.todos = Array.isArray(e.todos) ? e.todos : []; renderAll(); },
  step(rt, e) { rt.act.step = { tool: e.tool, arg: e.arg }; renderAll(); },
  tokens(rt, e) { rt.act.tokens = e.total || 0; },
  agent(rt, e) { onAgent(rt, e); renderAll(); },
  cmd(rt, e) {
    const m = rt.msgs.get(e.uuid);
    if (!m) return;
    if (e.state === "started" || e.state === "completed") deliver(rt, m);
    else if (e.state === "cancelled" || e.state === "discarded" || e.state === "refused") { rt.queue = rt.queue.filter((x) => x !== m); rt.msgs.delete(e.uuid); renderAll(true); }
  },
  result(rt, e) {
    rt.lastResult = e;
    rt.lastError = e.isError ? (e.errors || e.text || "") : "";
    rt.act.tokens = Math.max(rt.act.tokens, 0);
  },
  rate(rt, e) { quotaSoon(); if (e.info?.status === "rejected") rt.limit = true; },
  notice(rt, e) {
    const seg = rt.seg || rt.lastSeg;
    if (!seg) return;
    if (e.subtype === "compacting") seg.toolsEl.insertAdjacentHTML("beforeend", `<div class="tool-chip">${L("Compacting the conversation to free up room…", "Đang nén cuộc trò chuyện để lấy thêm chỗ…")}</div>`);
    else if (e.subtype === "compact") seg.toolsEl.insertAdjacentHTML("beforeend", `<div class="tool-chip">${L("Conversation compacted", "Đã nén cuộc trò chuyện")}${e.preTokens ? ` · ${act.fmtTok(e.preTokens)} → ${act.fmtTok(e.postTokens || 0)}` : ""}</div>`);
  },
  exit(rt, e) {
    if (!e.error) return;
    rt.lastError = e.error;
    rt.limit = /limit|quota|usage/i.test(e.error);
    const seg = rt.seg || rt.lastSeg || openSeg(rt, null);
    seg.error = e.error;
    seg.body.insertAdjacentHTML("beforeend", errorHtml(e.error));
    seg.body.querySelector(".cc-signin")?.addEventListener("click", () => import("./claude-code.js").then((m) => m.signIn()));
  },
  turn_done(rt, e) {
    rt.chain = rt.chain.then(() => applyTurnDone(rt, e)).catch((er) => console.warn("turn_done", er));
  },
};
function onSession(e) {
  if (buffering) { buffering.push(e); return; } // [detach] sessions are being taken over from another window
  const rt = byHandle.get(e.handle);
  if (!rt) return;
  if (e.seq) seen.set(e.handle, e.seq);
  try { H[e.kind]?.(rt, e); } catch (er) { console.warn("cc-session", e.kind, er); }
}

let quotaT = 0;
function quotaSoon() { clearTimeout(quotaT); quotaT = setTimeout(() => import("./cc-quota.js").then((m) => m.refreshQuota(true)).catch(() => {}), 1500); }

// ---------------- the chat: user messages and answer segments ----------------
/** The message is being worked on: its bubble shows and a fresh answer segment opens under it. */
function deliver(rt, m) {
  if (m.delivered) return;
  m.delivered = true;
  rt.queue = rt.queue.filter((x) => x !== m);
  const had = rt.seg;
  if (had) closeSeg(rt, false);
  addMsg("user", (m.phone ? rc.phoneLabel() + "<br>" : "") + esc(m.text).replace(/\n/g, "<br>"), rt.tab.list);
  rt.transcript.push({ role: "user", text: m.text });
  openSeg(rt, m);
  renderAll(true);
}

function openSeg(rt, m) {
  const ui = m?.ui || rt.ui0;
  const model = rt.modelSeen || rt.model || "default";
  const eff = settings.aiEffort && !/haiku/.test(model) ? ` · effort ${esc({ xhigh: "extra" }[settings.aiEffort] || settings.aiEffort)}` : "";
  const el2 = addMsg("assistant cc", `<div class="cc-badge">Claude Code<span class="cc-model">${model !== "default" ? ` · ${esc(model)}` : ""}</span>${eff} · ${esc(basename(rt.cwd || ""))}</div><div class="ai-tools"></div><div class="ai-body markdown-body"><span class="ai-typing">●●●</span></div><div class="cc-changes"></div>`, rt.tab.list);
  const body = el2.querySelector(".ai-body");
  const seg = { el: el2, toolsEl: el2.querySelector(".ai-tools"), body, changesEl: el2.querySelector(".cc-changes"), think: ui.thinkBox(el2), stream: createStreamer(body, ui.renderMd, rt.tab.list), full: "", streamed: false, toolEls: new Map(), toolFiles: new Map(), liveTags: new Map(), m, ui };
  rt.seg = seg;
  return seg;
}

/** The answer part is over (next message delivered, or the turn ended). Finishes the text, then reports it to ai.js. */
function closeSeg(rt, final) {
  const seg = rt.seg;
  if (!seg) return;
  rt.seg = null;
  rt.lastSeg = seg;
  if (rt.stopRequested && final !== false) seg.full += (seg.full ? "\n\n" : "") + "_Stopped._";
  rt.chain = rt.chain.then(async () => {
    seg.think.done();
    if (seg.full) { seg.stream.set(seg.full); await seg.stream.finish(); }
    seg.stream.stop();
    await seg.ui.settleMd(seg.body, seg.full || (seg.error ? "" : "_(done)_"), seg.stream.stick, rt.tab.list);
    if (rt.lastResult?.isError && final && !seg.error && !rt.stopRequested) { seg.body.insertAdjacentHTML("beforeend", errorHtml(rt.lastResult.errors || rt.lastResult.text)); seg.error = true; }
    seg.body.querySelector(".cc-signin")?.addEventListener("click", () => import("./claude-code.js").then((mm) => mm.signIn()));
    rt.transcript.push({ role: "assistant", text: seg.full });
    if (!seg.m) return;
    if (final) { rt.doneQueue.push(seg); armDone(rt); }
    else await seg.ui.done(chatOf(rt.tab), seg.full, { changed: [] });
  }).catch((er) => console.warn("closeSeg", er));
}

/** The last answer of a turn waits briefly for the list of changed files (turn_done) before it is recorded. */
function armDone(rt) {
  clearTimeout(rt.doneTimer);
  rt.doneTimer = setTimeout(() => { rt.chain = rt.chain.then(() => flushDone(rt, [])); }, 10000);
}
async function flushDone(rt, changed) {
  const q = rt.doneQueue.splice(0);
  clearTimeout(rt.doneTimer);
  for (let i = 0; i < q.length; i++) await q[i].ui.done(chatOf(rt.tab), q[i].full, { changed: i === q.length - 1 ? changed : [] });
}

async function applyTurnDone(rt, e) {
  const changed = e.changed || [];
  const seg = rt.lastSeg;
  if (e.files || e.added || e.removed) rt.summary = { files: e.files, added: e.added, removed: e.removed, at: Date.now() };
  if (seg && changed.length) {
    renderChanges(seg.changesEl, changed, rt.cwd || "");
    await reloadFromDisk(changed.map((c) => c.path), false, "Claude Code edit");
    if (changed.some((c) => c.status !== "modified")) refreshTree();
  }
  if (seg && e.snapshotPartial) { seg.changesEl.hidden = false; seg.changesEl.insertAdjacentHTML("beforeend", `<div class="note">This project is large: Callio could only keep copies of part of it before this answer.</div>`); }
  await flushDone(rt, changed);
  announceEnded(rt);
  renderAll(true);
}

/** The memory track listens for this to learn from a finished session. */
// `final`: the session itself is over (tab closed, new chat) — not just one answer finished.
function announceEnded(rt, final = false) {
  const c = chatOf(rt.tab);
  window.dispatchEvent(new CustomEvent("callio-cc-session-ended", { detail: { handle: rt.handle, sessionId: rt.claudeId || c?.cc?.id || null, project: c?.project || "", model: modelOf(rt), title: titleOf(rt.tab), final } }));
}

/** The transcript of a session (for project memory): [{role, text}]. */
export function getSessionTranscript(handle) { return (byHandle.get(handle)?.transcript || []).map((x) => ({ ...x })); }

function endTurn(rt) {
  rt.act.endedAt = Date.now();
  rt.turnActive = false;
  rt.writing = false;
  // messages still shown as queued were read: they were folded into the turn
  for (const m of [...rt.queue]) deliver(rt, m);
  closeSeg(rt, true);
  if (rt.tab !== active) rt.tab.unseen = true;
  quotaSoon();
}

function onEv(rt, ev) {
  if (ev.parent) return subEvent(rt, ev);
  let seg = rt.seg;
  if (!seg && ["text", "thinking", "assistant"].includes(ev.t)) seg = rt.seg = openSeg(rt, takeCont(rt));
  if (!seg) return;
  if (ev.t === "text") {
    seg.think.answer(); seg.streamed = true; seg.full += ev.text; seg.stream.set(seg.full);
    rt.writing = true; clearTimeout(rt.writingTimer); rt.writingTimer = setTimeout(() => { rt.writing = false; renderAll(); }, 1500);
    renderAll();
  } else if (ev.t === "thinking") seg.think.add(ev.text || "");
  else if (ev.t === "message_start") { if (seg.full && !seg.full.endsWith("\n\n")) seg.full += "\n\n"; }
  else if (ev.t === "assistant") {
    // the badge names the model that really answered (from the API), not the one asked for
    if (ev.model && ev.model !== "<synthetic>") {
      rt.modelSeen = ev.model;
      const b = seg.el.querySelector(".cc-badge .cc-model");
      if (b && b.textContent !== ` · ${ev.model}`) b.textContent = ` · ${ev.model}`;
    }
    if (!seg.streamed && ev.text) { seg.full += (seg.full ? "\n\n" : "") + ev.text; seg.stream.set(seg.full); }
    for (const tl of ev.tools || []) {
      rt.toolParent.set(tl.id, null);
      const [ico, title] = toolTitle(tl.name, tl.input);
      const chip = document.createElement("div");
      chip.className = "tool-chip";
      chip.innerHTML = `<span class="tc-state">⏳</span> ${ico} <span class="tc-title"></span>`;
      chip.querySelector(".tc-title").textContent = title;
      chip.title = JSON.stringify(tl.input, null, 1).slice(0, 1500);
      seg.toolsEl.appendChild(chip);
      seg.toolEls.set(tl.id, chip);
      const f = fromClaude(tl.input?.file_path || tl.input?.notebook_path, rt.cwd); // [wsl] Linux path → the window's
      if (f && EDIT_TOOLS.includes(tl.name)) seg.toolFiles.set(tl.id, f);
      const seen = f || fromClaude(tl.input?.path, rt.cwd);
      if (seen && (EDIT_TOOLS.includes(tl.name) || ["Read", "mcp__callio__read_pdf", "mcp__callio__view_pdf_page", "mcp__callio__open_file"].includes(tl.name))) { seg.ui.fileTag?.(seen, EDIT_TOOLS.includes(tl.name) ? "edit" : "read", true); seg.liveTags.set(tl.id, seen); }
      if (tl.name === "Task" || tl.name === "Agent") ensureAgentFromTool(rt, tl);
    }
  } else if (ev.t === "tool_results") {
    for (const r of ev.results) {
      const parent = rt.toolParent.get(r.id);
      if (parent) { subResult(rt, parent, r); continue; }
      const ag = rt.act.agents.get(r.id);
      if (ag && ag.status === "running" && !ag.background && !ag.taskSeen) { ag.status = r.isError ? "error" : "done"; ag.endedAt = Date.now(); }
      if (seg.liveTags.has(r.id)) { const p = seg.liveTags.get(r.id); seg.liveTags.delete(r.id); seg.ui.fileTag?.(p, seg.toolFiles.has(r.id) ? "edit" : "read", false); }
      const chip = seg.toolEls.get(r.id);
      if (chip) {
        chip.querySelector(".tc-state").textContent = r.isError ? "✗" : "✓";
        if (r.isError) { chip.classList.add("err"); chip.title = r.text; }
      }
      // show Claude's edit in the open tab right away
      if (!r.isError && seg.toolFiles.has(r.id)) reloadFromDisk([seg.toolFiles.get(r.id)], false, "Claude Code edit");
    }
  }
}

// ---------------- subagents ----------------
function newAgent(key) {
  return { key, taskId: null, type: "", model: "", description: "", prompt: "", status: "running", startedAt: Date.now(), endedAt: 0, tokens: 0, toolUses: 0, log: [], logById: new Map(), perm: null, background: false, taskSeen: false };
}
function agentFor(rt, key) {
  let a = rt.act.agents.get(key);
  if (!a) { a = newAgent(key); rt.act.agents.set(key, a); }
  return a;
}
function ensureAgentFromTool(rt, tl) {
  const a = agentFor(rt, tl.id);
  const i = tl.input || {};
  a.type = a.type || i.subagent_type || "";
  a.model = a.model || i.model || "";
  a.description = a.description || i.description || String(i.prompt || "").slice(0, 80);
  a.prompt = a.prompt || i.prompt || "";
  if (i.run_in_background) a.background = true;
  renderAll();
}
function onAgent(rt, e) {
  const key = e.toolUseId || [...rt.act.agents.values()].find((x) => x.taskId === e.taskId)?.key || e.taskId;
  if (!key) return;
  const a = agentFor(rt, key);
  if (e.taskId) { a.taskId = e.taskId; a.taskSeen = true; }
  if (e.subagentType && !a.type) a.type = e.subagentType;
  if (e.taskType && !a.type && e.taskType !== "local_agent") a.type = e.taskType === "local_bash" ? L("Shell", "Lệnh nền") : e.taskType;
  if (e.description) a.description = a.description || e.description;
  if (e.prompt && !a.prompt) a.prompt = e.prompt;
  if (e.background) a.background = true;
  const map = { completed: "done", failed: "error", killed: "stopped", stopped: "stopped" };
  if (e.phase === "progress" || e.phase === "end") {
    if (e.usage?.tokens) a.tokens = e.usage.tokens;
    if (e.usage?.toolUses) a.toolUses = e.usage.toolUses;
  }
  if (e.phase === "update" && e.patch) {
    if (e.patch.description) a.description = e.patch.description;
    if (e.patch.status && map[e.patch.status]) { a.status = map[e.patch.status]; a.endedAt = Date.now(); }
  }
  if (e.phase === "end") { a.status = map[e.status] || "done"; a.endedAt = Date.now(); if (e.summary && !a.log.length) a.log.push({ t: Date.now(), kind: "text", text: String(e.summary).slice(0, 300) }); }
}
/** A message or tool call that belongs to a subagent: it goes to that agent's log, not to the chat. */
function subEvent(rt, ev) {
  const a = agentFor(rt, ev.parent);
  // the model the subagent really runs on (from its messages) wins over the one its task asked for
  if (ev.model && ev.model !== "<synthetic>") a.model = ev.model;
  if (ev.t === "assistant") {
    const now = Date.now();
    if (ev.text) a.log.push({ t: now, kind: "text", text: ev.text.replace(/\s+/g, " ").slice(0, 200) });
    for (const tl of ev.tools || []) {
      rt.toolParent.set(tl.id, ev.parent);
      const [, title] = toolTitle(tl.name, tl.input);
      const entry = { t: now, kind: "tool", text: title, detail: JSON.stringify(tl.input).slice(0, 1500) };
      a.log.push(entry);
      a.logById.set(tl.id, entry);
      if (tl.name === "Task" || tl.name === "Agent") ensureAgentFromTool(rt, tl);
    }
    if (a.log.length > 400) a.log.splice(0, a.log.length - 400);
  } else if (ev.t === "tool_results") {
    for (const r of ev.results || []) subResult(rt, ev.parent, r);
  }
  renderAll();
}
function subResult(rt, parent, r) {
  const a = rt.act.agents.get(parent);
  const entry = a?.logById.get(r.id);
  if (entry && r.isError) entry.text += " ✗";
}

// ---------------- permission questions ----------------
function onPermission(params, rpc) {
  if (released.has(params.session)) return; // [detach] that session's chat is in another window now (it asks there)
  if (shownRpc.has(rpc)) return; // asked again after the chat moved: the card is already here
  shownRpc.add(rpc);
  const rt = byHandle.get(params.session);
  if (!rt) return void permissionCard(rpc, params);
  const parent = params.toolUseId ? rt.toolParent.get(params.toolUseId) || null : null;
  const p = { rpc, toolName: params.toolName, input: params.input || {}, agent: parent, toolUseId: params.toolUseId };
  rt.perms.set(rpc, p);
  const ag = parent && rt.act.agents.get(parent);
  if (ag) ag.status = "waiting";
  renderAll(true);
  if (rt.tab !== active || $("#ai-panel").hidden) notifyNeed(rt, p);
  const hostEl = rt.seg?.toolsEl || rt.lastSeg?.toolsEl || rt.tab.list;
  permissionCard(rpc, params, rt, hostEl, rt.tab === active).then((card) => {
    if (!card) { rt.perms.delete(rpc); if (ag && ag.status === "waiting") ag.status = "running"; renderAll(true); }
  });
}
function onPermAnswered(rpc) {
  shownRpc.delete(rpc);
  for (const rt of byHandle.values()) {
    const p = rt.perms.get(rpc);
    if (!p) continue;
    rt.perms.delete(rpc);
    const ag = p.agent && rt.act.agents.get(p.agent);
    if (ag && ag.status === "waiting") ag.status = "running";
    // answered (here or on the phone): the "needs you" toast goes with the question
    if (![...byHandle.values()].some((r) => r.perms.size)) act.hideToast($("#ai-panel"));
    renderAll(true);
  }
}
function answerPerm(rpc, allow) {
  const card = cards.get(rpc);
  const b = card?.querySelector(allow ? ".cc-allow" : ".cc-deny");
  if (b) b.click(); else call("cc_reply", { rpc, value: allow ? { allow: true } : { allow: false, message: "" } }).catch(() => {});
}
function notifyNeed(rt, p) {
  const what = p.toolName === "Bash" || p.toolName === "PowerShell" ? L("approve a command", "duyệt một lệnh") : L("approve a change", "duyệt một thay đổi");
  if ($("#ai-panel").hidden) return toast(`${titleOf(rt.tab)}: ${L("needs you to " + what.split(" ").slice(0).join(" "), "cần bạn " + what)}`, "", 6000);
  act.showToast($("#ai-panel"), { title: titleOf(rt.tab), text: L(`needs you to ${what}`, `cần bạn ${what}`), onOpen: () => openTab(rt.tab) });
}
function openTab(tab) { switchTo(tab); if (dom.pop) dom.pop.hidden = true; }

// ---------------- drawing ----------------
let raf = 0, again = false;
function renderAll(now) {
  if (!inited) return;
  if (now) { cancelAnimationFrame(raf); raf = 0; draw(); return; }
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; draw(); });
}
function shouldShow(rt) {
  if (!rt || !settings.ccEnabled) return false;
  if (busy(rt) || rt.ui.open) return true;
  return rt.act.endedAt && Date.now() - rt.act.endedAt < 6000;
}
function draw() {
  const on = !!settings.ccEnabled;
  $(".ai-sess")?.classList.toggle("with-tabs", on);
  dom.tabs.hidden = !on;
  const rt = active?.rt;
  dom.rc.hidden = !on;
  dom.rc.classList.toggle("on", rc.rcOn(rt));
  dom.rc.classList.toggle("busy", !!rt?.remote?.busy);
  if (rt) rt.showActivity = shouldShow(rt);
  const col = layout() === "column";
  act.renderStrip(dom.strip, col ? null : rt);
  act.renderColumn(dom.col, col && on ? rt : null);
  $("#ai-panel").classList.toggle("with-col", !dom.col.hidden);
  act.renderTabs(dom.tabs, {
    tabs, active, title: titleOf, vis: (t) => act.visualOf(t.rt), needs: (t) => !!t.rt?.perms.size, remote: (t) => rc.rcOn(t.rt), remoteTip: rc.rcTip,
    needCount: tabs.filter((t) => t.rt?.perms.size).length, canClose: true,
  });
  drawQueue();
  drawButtons();
  if (!dom.pop.hidden) drawPop();
  statusHook?.();
}
function tick() {
  const rt = active?.rt;
  if (rt && (rt.showActivity || shouldShow(rt))) renderAll();
}

function drawQueue() {
  const rt = active?.rt;
  const rows = rt ? rt.queue.filter((m) => !m.delivered) : [];
  dom.queue.hidden = !rows.length;
  const model = act.modelLabel(modelOf(rt), true);
  const slot = rt?.status === "queued";
  dom.queue.innerHTML = rows.map((m) => `<div class="cs-q" data-uuid="${m.uuid}">${ic("list")}<span>${slot ? "Waiting for a free slot —" : "Queued —"}</span>${slot ? "" : `<b data-noi18n>${esc(model)}</b>`}<span>${slot ? "starts when another session finishes:" : "reads it after the step it is doing now:"}</span><span class="cs-q-text" data-noi18n>“${esc(m.text.replace(/\s+/g, " ").slice(0, 160))}”</span><button type="button" class="icon small" data-uuid="${m.uuid}" title="Take this message back" aria-label="Take this message back">${ic("x")}</button></div>`).join("");
}

function drawButtons() {
  const rt = active?.rt;
  const cc = !!settings.ccEnabled && /^claudecode\|/.test(settings.aiModel_chat || "claudecode|default");
  const run = cc && busy(rt);
  dom.now.hidden = !run;
  dom.stop.hidden = !run && dom.stop.hidden;
  if (cc) {
    if (run) {
      dom.send.hidden = false; dom.stop.hidden = false;
      if (dom.send.dataset.cs !== "1") { dom.send.dataset.cs = "1"; dom.send.innerHTML = `${ic("arrow-right")}<span>Send next</span>`; dom.send.title = "The model reads it after the step it is doing now"; }
      dom.stop.innerHTML = `${act.ICONS.stop}<span>Stop</span>`; dom.stop.title = "Stop (Esc)";
      dom.text.placeholder = "Add a request while the model works… (Enter: send next · Ctrl+Enter: interrupt & send)";
      const c = chatState(); c.stop = () => stopTab(active);
    } else restoreButtons();
  } else restoreButtons();
}
function restoreButtons() {
  if (dom.send.dataset.cs === "1") { dom.send.dataset.cs = ""; dom.send.innerHTML = dom.sendHtml; dom.send.removeAttribute("title"); dom.stop.innerHTML = dom.stopHtml; dom.stop.removeAttribute("title"); dom.text.placeholder = dom.ph; dom.stop.hidden = true; const c = chatState(); if (c.stop) c.stop = null; }
}

// ---------------- the sessions list ----------------
function togglePop() {
  dom.pop.hidden = !dom.pop.hidden;
  dom.pop.style.top = `${dom.tabs.offsetTop + dom.tabs.offsetHeight + 2}px`; // just under the tabs, wherever the quota line above them leaves them
  if (!dom.pop.hidden) drawPop();
}
async function drawPop() {
  const rows = [];
  const live = new Set();
  for (const t of tabs) {
    const rt = t.rt;
    if (!rt?.handle || !rt.ranOnce) continue;
    live.add(rt.handle);
    const title = titleOf(t);
    const folder = basename(rt.cwd || "");
    const model = act.modelLabel(modelOf(rt));
    const ts = act.todoStats(rt);
    const first = [...rt.perms.values()][0];
    if (first) {
      const what = first.toolName === "Bash" || first.toolName === "PowerShell" ? first.input.command : first.input.file_path || first.toolName;
      const ag = first.agent && rt.act.agents.get(first.agent);
      rows.push({ group: "need", remote: rc.rcOn(rt), handle: rt.handle, title, vis: "need", line: `${esc(ag ? act.modelLabel(ag.model || "", true) || L("Subagent", "Subagent") : act.modelLabel(modelOf(rt), true))} ${L("wants to run", "muốn chạy")} <code class="mono" data-noi18n>${esc(String(what).split("\n")[0].slice(0, 80))}</code>`, folder, model, prog: null, meta: "", perm: first.rpc, actions: ["open", "deny", "allow"] });
    } else if (busy(rt)) {
      const n = act.runningAgents(rt);
      rows.push({ group: "run", remote: rc.rcOn(rt), handle: rt.handle, title, vis: act.visualOf(rt), line: `${act.stepHtml(rt)}${n ? ` · ${L(`${n} subagent${n === 1 ? "" : "s"}`, `${n} subagent`)}` : ""}`, folder, model, prog: ts.total ? { done: ts.done, total: ts.total } : null, meta: `${act.fmtDur(Date.now() - rt.act.startedAt)} · ${act.fmtTok(act.totalTok(rt))}`, actions: ["open"] });
    } else {
      const s = rt.summary;
      const fail = rt.status === "error";
      rows.push({ group: "done", remote: rc.rcOn(rt), handle: rt.handle, title, vis: fail ? "fail" : "done", line: fail ? `${L("Stopped by an error", "Dừng do lỗi")}${rt.lastError ? `: ${esc(String(rt.lastError).split("\n")[0].slice(0, 70))}` : ""}` : s ? `${L(`Changed ${s.files} file${s.files === 1 ? "" : "s"}`, `Sửa ${s.files} tệp`)} <span class="add">+${s.added}</span> <span class="del">−${s.removed}</span>` : L("Done", "Xong"), folder, model, prog: null, meta: act.ago(rt.act.endedAt || Date.now()), actions: fail ? ["open", "resume"] : s ? ["open", "changes"] : ["open"] });
    }
  }
  const sorted = ["need", "run", "done"].flatMap((g) => rows.filter((r) => r.group === g));
  dom.pop.innerHTML = "";
  act.renderList(dom.pop, sorted, { running: tabs.filter((t) => busy(t.rt)).length, max: +settings.ccMaxParallel || 4 });
  // sessions from earlier (closed tabs, a previous run of Callio): the journal knows them
  let journal = [];
  try { journal = await call("cc_journal_list"); } catch {}
  const old = journal.filter((j) => !live.has(j.handle) && !j.live && Date.now() - (j.updatedAt || 0) < 7 * 86400e3 && (j.meta?.title || j.label)).slice(0, 6);
  if (old.length && !dom.pop.hidden) {
    const frag = document.createElement("div");
    frag.innerHTML = act.renderOld(old);
    dom.pop.append(...frag.children);
  }
}
async function onPopClick(e) {
  const b = e.target.closest("[data-a]");
  if (!b) return;
  const a = b.dataset.a;
  const row = b.closest(".sess");
  const h = row?.dataset.h;
  const tab = tabs.find((t) => t.rt?.handle === h);
  if (a === "new") { dom.pop.hidden = true; return void newTab(); }
  if (a === "allow" || a === "deny") return answerPerm(Number(b.dataset.rpc), a === "allow");
  if (a === "open" && tab) return openTab(tab);
  if (a === "changes" && tab) { openTab(tab); setTimeout(() => (tab.rt.lastSeg?.changesEl || tab.list).scrollIntoView({ block: "center" }), 50); return; }
  if (a === "resume") {
    if (tab) { openTab(tab); dom.text.value = L("Continue where you stopped.", "Tiếp tục từ chỗ vừa dừng."); dom.send.click(); return; }
    const j = (await call("cc_journal_list")).find((x) => x.handle === row?.dataset.h);
    if (j) { dom.pop.hidden = true; await restoreTab(j); }
  }
}

// ---------------- restore after a power cut ----------------
async function unfinished() {
  try {
    const list = (await call("cc_journal_list")).filter((j) => !j.cleanEnd && !j.live && !byHandle.has(j.handle));
    // [detach] sessions of a chat window belong to that window while it exists (it brings them back itself)
    const mine = (j) => !String(j.meta?.win || "").startsWith("chat-") || (host.REMOTE ? j.meta.win === WIN : !chatLabels.has(j.meta.win));
    return list.filter(mine);
  } catch { return []; }
}
let chatLabels = new Set();
async function restoreAll() {
  if (!host.REMOTE) { try { chatLabels = new Set((await call("win_list")).filter((w) => w.role === "chat").map((w) => w.label)); } catch {} }
  const list = await unfinished();
  for (const j of list) await restoreTab(j);
}
/** [detach] A restored chat window brings back its own interrupted sessions. */
export const restoreOwn = restoreAll;

/** A tab for an interrupted session: its saved conversation and a Continue button (never runs by itself). */
async function restoreTab(j) {
  const first = tabs.length === 1 && !tabs[0].rt && !chatState().history.length && !tabs[0].list.querySelector(".ai-msg");
  const tab = first ? active : await newTab();
  const meta = j.meta || {};
  if (meta.chatSid) { try { await loadSession(meta.chatSid, meta.project ?? ""); } catch {} }
  const chat = chatState();
  chat.cc = { id: j.claudeId || chat.cc?.id || null };
  chat.ccReady = true;
  tab.pendingTitle = j.label || meta.title || "";
  const rt = (tab.rt = makeRuntime(tab));
  rt.cwd = j.cwd; rt.model = j.model || null; rt.lastError = "";
  const s = j.settings || {};
  const r = await call("cc_session_start", { req: { handle: j.handle, cwd: j.cwd, model: j.model || null, permissionMode: s.permissionMode || settings.ccPermissionMode || "default", systemAppend: SYSTEM, label: j.label || "", effort: s.effort || null, thinking: s.thinking !== false, web: s.web || null, resumeId: j.claudeId || null, restored: true, window: WIN, meta, maxParallel: +settings.ccMaxParallel || 4, idleMinutes: +settings.ccIdleMinutes || 30, runIn: ccRunIn(j.cwd), remoteControl: j.remoteControl?.on ? j.remoteControl : null } });
  if (j.remoteControl?.on) rt.remote = { on: true, connected: false, connectUrl: j.remoteControl.connectUrl || null, bridgeSessionId: j.remoteControl.bridgeSessionId || null }; // [remote] the backend turns it on again with the new process
  rt.handle = r.handle;
  byHandle.set(rt.handle, rt);
  rt.status = "error"; rt.ranOnce = true; rt.act.endedAt = Date.now();
  const queued = (j.queued || []).map((q) => q.text).filter(Boolean);
  const stepEn = j.step?.tool ? `${j.step.tool}${j.step.arg ? ` ${j.step.arg}` : ""}` : "(unknown)";
  const card = document.createElement("div");
  card.className = "cc-resume";
  card.innerHTML = `<b>${L("This session was interrupted", "Phiên này bị gián đoạn")}</b><span class="note" data-noi18n>${esc(L(`Callio closed unexpectedly while it was working${j.step?.tool ? ` (${stepEn})` : ""}. Nothing runs until you continue.`, `Callio bị đóng đột ngột khi phiên đang làm việc${j.step?.tool ? ` (${stepEn})` : ""}. Sẽ không có gì chạy cho đến khi bạn bấm tiếp tục.`))}</span>${queued.length ? `<span class="note" data-noi18n>${esc(L(`${queued.length} message${queued.length === 1 ? "" : "s"} you sent had not been read yet; they are sent with it.`, `${queued.length} tin nhắn bạn đã gửi chưa được đọc; chúng sẽ được gửi kèm.`))}</span>` : ""}<span class="row"><button type="button" class="primary small cc-go">Continue</button><button type="button" class="small cc-drop">Discard</button></span>`;
  tab.list.appendChild(card);
  card.querySelector(".cc-go").onclick = async () => {
    card.remove();
    rt.status = "idle";
    const prompt = `The previous session was interrupted unexpectedly (power loss or crash) while: ${stepEn}. Check the current state of the files and of any command that was running, then continue the remaining to-do items.${queued.length ? "\n\n" + queued.join("\n\n") : ""}`;
    const shown = L("Continue the interrupted session", "Tiếp tục phiên bị gián đoạn") + (queued.length ? "\n\n" + queued.join("\n\n") : "");
    tab.draft = "";
    if (tab !== active) switchTo(tab);
    dom.text.value = "";
    await continueRestored(shown, prompt);
  };
  card.querySelector(".cc-drop").onclick = async () => { card.remove(); await disposeRt(rt, false); renderAll(true); };
  renderAll(true);
}
async function continueRestored(shown, prompt) {
  const ai = await import("./ai.js");
  const ui = ai.ccUi(shown);
  try { await sendMessage(shown, prompt, ui); } catch (e) { toast(e.message, "err", 6000); }
}

// ---------------- settings ----------------
export function renderSessionSettings(box) {
  const anchor = box.querySelector("#cc-mode")?.closest("label");
  if (!anchor || box.querySelector("#cc-parallel")) return;
  const wrap = document.createElement("div");
  wrap.innerHTML = `<label>Claude Code sessions at once <input id="cc-parallel" type="number" min="1" max="8" name="ccMaxParallel"></label>
    <label>Close an idle session after (minutes) <input id="cc-idle" type="number" min="1" max="1440" name="ccIdleMinutes"></label>
    <p class="note">Idle sessions are closed to free memory; the next message resumes them where they were.</p>
    <label>Activity panel <select id="cc-layout" name="activityLayout"><option value="strip">A strip above the input</option><option value="column">A column beside the chat</option></select></label>`;
  anchor.after(...wrap.children);
  const par = box.querySelector("#cc-parallel"), idle = box.querySelector("#cc-idle"), lay = box.querySelector("#cc-layout");
  par.value = +settings.ccMaxParallel || 4; idle.value = +settings.ccIdleMinutes || 30; lay.value = layout();
  par.onchange = () => { par.value = Math.max(1, Math.min(8, +par.value || 4)); updateSettings({ ccMaxParallel: +par.value }); };
  idle.onchange = () => { idle.value = Math.max(1, Math.min(1440, +idle.value || 30)); updateSettings({ ccIdleMinutes: +idle.value }); };
  lay.onchange = () => setLayout(lay.value);
}

/** Test and debugging aid (the UI never calls it). */
export function debugState() {
  return { buffering: buffering ? buffering.length : null, seen: Object.fromEntries(seen), tabs: tabs.map((t) => ({ id: t.id, active: t === active, handle: t.rt?.handle || null, status: t.rt?.status || null, perms: t.rt ? [...t.rt.perms.keys()] : [], queue: t.rt?.queue.length || 0, agents: t.rt ? [...t.rt.act.agents.values()].map((a) => ({ key: a.key, status: a.status, type: a.type, log: a.log.length })) : [] })) };
}

// ======================================================================================================
// [detach] The AI chat moves between windows (detach.js). The Claude Code processes live in Rust and keep
// running; what moves is this window's picture of them: the tabs (conversation, draft), and for each
// session its state (status, to-do list, subagents, queued messages…). The window that takes over
//   1. starts buffering `cc-session` events (they carry a growing `seq`),
//   2. receives the state from the other window, which settles its answers first (what a running
//      answer has written so far is finished and recorded; the rest of it continues in a new block),
//   3. applies the buffered events newer than what the state already covers,
//   4. asks Rust to send the session's permission questions to its window (cc_session_set_window, which
//      also asks the ones still open again).
// Messages already drawn are rebuilt from the saved conversation (the HTML cache makes it instant).
// ======================================================================================================
let buffering = host.REMOTE ? [] : null;      // events kept aside while sessions are being taken over
const seen = new Map();                       // handle → the last event number applied here
const released = new Set();                   // sessions that moved to another window: events and questions are not ours
const shownRpc = new Set();                   // permission questions that already have a card here
let statusHook = null;
/** Called (often) whenever the sessions' state is drawn: detach.js reports counts to the editor window. */
export const setStatusHook = (fn) => { statusHook = fn; };
/** Continuation of an answer that began in the other window: the next answer block belongs to it. */
const takeCont = (rt) => { const m = rt.contM || null; rt.contM = null; return m; };

/** Start keeping events aside (an editor window about to receive the chat back). */
export function beginAdopt() { buffering = buffering || []; }
/** Stop keeping events aside: apply them (nothing was handed over), or `drop` them (the other window has it all). */
export function endAdopt(drop) { const b = buffering || []; buffering = null; if (!drop) for (const e of b) onSession(e); }

/** Counts for the editor window's rail: how many sessions run, how many need the author. */
export function summary() {
  const run = tabs.filter((t) => busy(t.rt)).length;
  const need = tabs.filter((t) => t.rt?.perms.size).length;
  return { run, need, tabs: tabs.length, busyApi: tabs.some((t) => chatOf(t)?.busyId) };
}
/** True while a Claude Code turn runs in any tab (the window asks before closing). */
export const anyBusy = () => tabs.some((t) => busy(t.rt));

const plain = (o) => JSON.parse(JSON.stringify(o ?? null));
function exportAct(a) {
  return {
    startedAt: a.startedAt, endedAt: a.endedAt, tokens: a.tokens, step: a.step, todos: plain(a.todos),
    agents: [...a.agents.values()].map((g) => ({ ...plain({ ...g, logById: undefined }), logById: [...g.logById].map(([id, e]) => [id, g.log.indexOf(e)]) })),
  };
}
function importAct(d) {
  const a = { startedAt: d.startedAt, endedAt: d.endedAt, tokens: d.tokens, step: d.step, todos: d.todos || [], agents: new Map() };
  for (const g of d.agents || []) {
    const { logById, ...rest } = g;
    const ag = { ...rest, logById: new Map() };
    for (const [id, i] of logById || []) if (ag.log[i]) ag.logById.set(id, ag.log[i]);
    a.agents.set(ag.key, ag);
  }
  return a;
}
const msgOut = (m) => ({ uuid: m.uuid, text: m.text, mode: m.mode, slot: !!m.slot, desc: m.ui?.desc || null });
function exportRt(rt) {
  return {
    handle: rt.handle, status: rt.status, proc: rt.proc, claudeId: rt.claudeId, cwd: rt.cwd, model: rt.model, modelSeen: rt.modelSeen,
    turnActive: rt.turnActive, serverQueue: plain(rt.serverQueue), transcript: plain(rt.transcript), act: exportAct(rt.act),
    queue: rt.queue.filter((m) => !m.delivered).map(msgOut), pendingNow: [...rt.msgs.values()].filter((m) => !m.delivered && !rt.queue.includes(m)).map(msgOut),
    ui: { open: !!rt.ui.open, sel: rt.ui.sel || null }, showActivity: rt.showActivity, stopRequested: rt.stopRequested, autoEdits: rt.autoEdits,
    lastResult: plain(rt.lastResult), summary: plain(rt.summary), lastError: rt.lastError, limit: rt.limit, ranOnce: rt.ranOnce, remote: plain(rt.remote),
    ui0: rt.ui0?.desc || null, toolParent: [...rt.toolParent], seq: seen.get(rt.handle) || 0,
    // an answer is being written: the next block of it carries on in the new window
    cont: !!(rt.turnActive && (rt.ui0?.desc || rt.lastSeg?.m?.ui?.desc)), contDesc: rt.lastSeg?.m?.ui?.desc || rt.ui0?.desc || null,
  };
}
const cloneChat = (c) => plain({ history: c.history, summary: c.summary || "", summaryUpTo: c.summaryUpTo || 0, ctx: c.ctx, attached: c.attached, cc: c.cc, ccReady: c.ccReady, mem: c.mem, sid: c.sid, title: c.title, created: c.created, project: c.project });

/**
 * Settle every tab and describe it for another window. After this the window no longer owns the
 * sessions (`released`): call it only when the other window is ready to take them (importState).
 * Throws "BUSY_API" when an answer from an API provider is being written (that cannot move).
 */
export async function exportState({ release = true } = {}) {
  if (tabs.some((t) => chatOf(t)?.busyId)) throw new Error("BUSY_API");
  buffering = buffering || []; // from now on events wait: the window that takes over applies them, or we do if it does not
  for (const t of tabs) if (t.rt?.seg) closeSeg(t.rt, false);
  for (let round = 0; round < 3; round++) await Promise.all(tabs.map((t) => t.rt?.chain));
  for (const t of tabs) if (t.rt) await flushDone(t.rt, []);
  const snap = { v: 1, active: Math.max(0, tabs.indexOf(active)), tabs: [] };
  for (const t of tabs) {
    snap.tabs.push({ draft: t === active ? dom.text.value : t.draft || "", unseen: !!t.unseen, pendingTitle: t.pendingTitle || "", chat: cloneChat(chatOf(t)), rt: t.rt?.handle ? exportRt(t.rt) : null });
  }
  if (release) clearTabs();
  return snap;
}

/** The sessions of this window moved: forget them (the processes keep running) and show an empty chat. */
function clearTabs() {
  for (const t of tabs) {
    const rt = t.rt;
    if (!rt) continue;
    if (rt.handle) { released.add(rt.handle); byHandle.delete(rt.handle); }
    for (const rpc of rt.perms.keys()) { cards.get(rpc)?.remove(); cards.delete(rpc); shownRpc.delete(rpc); }
    clearTimeout(rt.doneTimer); clearTimeout(rt.writingTimer);
    t.rt = null;
  }
  for (const t of tabs.slice(1)) t.list.remove();
  tabs.length = 1;
  active = tabs[0];
  active.rt = null; active.chat = null; active.draft = ""; active.unseen = false; active.pendingTitle = "";
  $$all(".ai-messages").forEach((l) => { if (l !== active.list) l.remove(); });
  active.list.hidden = false; active.list.id = "ai-messages";
  dom.text.value = "";
  resetChat();
  renderAll(true);
}
const $$all = (s) => [...document.querySelectorAll(s)];

/** Take over the tabs another window described (exportState). Applies the events kept aside while waiting. */
export async function importState(snap) {
  const ai = await import("./ai.js");
  const anchor = document.getElementById("ai-messages") || active.list;
  for (const t of tabs) { if (t.rt?.handle) { byHandle.delete(t.rt.handle); } clearTimeout(t.rt?.doneTimer); }
  for (const l of $$all(".ai-messages")) if (l !== anchor) l.remove();
  anchor.innerHTML = "";
  tabs.length = 0;
  const made = [];
  for (let i = 0; i < snap.tabs.length; i++) {
    const d = snap.tabs[i];
    const isActive = i === snap.active;
    const list = isActive ? anchor : el("div", "ai-messages");
    list.classList.add("ai-messages");
    const tab = { id: `t${++seq}`, list, chat: null, rt: null, draft: d.draft || "", unseen: !!d.unseen, pendingTitle: d.pendingTitle || "" };
    list.dataset.session = tab.id;
    const c = { ...freshChatState(d.chat.project), ...d.chat, busyId: null, stop: null };
    tab.chat = c;
    tabs.push(tab);
    made.push([tab, d]);
  }
  // order in the page: the active list stays where #ai-messages is, the others follow it (hidden)
  let after = anchor;
  for (const [tab] of made) if (tab.list !== anchor) { tab.list.hidden = true; tab.list.removeAttribute("id"); after.after(tab.list); after = tab.list; }
  active = made[snap.active]?.[0] || tabs[0];
  anchor.hidden = false; anchor.id = "ai-messages";
  swapChat(active.chat); active.chat = null;
  for (const [tab, d] of made) {
    await ai.rebuildMessages(tab.list, chatOf(tab));
    if (d.rt?.handle) importRt(tab, d.rt, ai);
  }
  dom.text.value = active.draft || "";
  renderSessBar();
  refreshAIContext();
  // events that arrived while the state was on its way: only those newer than the state covers
  const kept = buffering || [];
  buffering = null;
  for (const e of kept) if (e.handle && byHandle.has(e.handle) && (!e.seq || e.seq > (seen.get(e.handle) || 0))) onSession(e);
  renderAll(true);
}

function importRt(tab, d, ai) {
  const rt = makeRuntime(tab);
  tab.rt = rt;
  const c = chatOf(tab);
  Object.assign(rt, {
    handle: d.handle, status: d.status, proc: d.proc, claudeId: d.claudeId, cwd: d.cwd, model: d.model, modelSeen: d.modelSeen, turnActive: d.turnActive,
    serverQueue: d.serverQueue || [], transcript: d.transcript || [], act: importAct(d.act), ui: { open: !!d.ui?.open, sel: d.ui?.sel || null },
    showActivity: d.showActivity, stopRequested: d.stopRequested, autoEdits: d.autoEdits, lastResult: d.lastResult, summary: d.summary, lastError: d.lastError || "",
    limit: !!d.limit, ranOnce: d.ranOnce, toolParent: new Map(d.toolParent || []), remote: d.remote || null,
  });
  const mk = (m) => ({ uuid: m.uuid, text: m.text, mode: m.mode, delivered: false, slot: !!m.slot, ui: m.desc ? ai.ccUiFor(m.desc, c.ctx) : rt.ui0 });
  if (d.ui0) rt.ui0 = ai.ccUiFor(d.ui0, c.ctx);
  for (const m of d.queue || []) { const x = mk(m); rt.msgs.set(x.uuid, x); rt.queue.push(x); }
  for (const m of d.pendingNow || []) { const x = mk(m); rt.msgs.set(x.uuid, x); }
  if (d.cont && d.contDesc) {
    const ui = ai.ccUiFor(d.contDesc, c.ctx, true);
    rt.ui0 = rt.ui0 || ui;
    rt.contM = { uuid: uid(), text: d.contDesc.text, ui, delivered: true };
  }
  byHandle.set(rt.handle, rt);
  released.delete(rt.handle);
  seen.set(rt.handle, d.seq || 0);
}

/** The handles of every session this window runs (detach.js asks Rust to route their questions here). */
export const handles = () => tabs.map((t) => t.rt?.handle).filter(Boolean);

/** Stop every session of this window (the window is closing for good). */
export async function stopAll() {
  for (const t of [...tabs]) if (t.rt) await disposeRt(t.rt, true);
}
