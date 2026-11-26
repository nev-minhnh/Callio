// Remote Control: control a running Claude Code session of Callio from the Claude phone app
// (or claude.ai/code). It is switched on only when the author asks — the 📱 button beside the session
// tabs, or `/remote-control` · `/rc` in the chat — never by itself.
//
// The Rust side (claude_code/session.rs `cc_session_remote`) asks Claude Code to open the bridge and
// answers with the link (`connect_url`); this module keeps what the window shows about it:
//   - rt.remote = { on, connected, connectUrl, bridgeSessionId, busy, error, bridge }  (per session)
//   - the 📱 marker (tab, sessions list, tooltip) comes from `rcOn(rt)`
//   - a small panel under the tabs with the link (Copy · Open), a QR code, a note on how questions
//     work, and "Turn off remote control"
// Questions Claude Code asks show in Callio and on the phone at once; answering in one place closes the
// other (see session.rs `on_control_request` and claude-code.js `onRpcCancel`).
import { call } from "./api.js";
import { toast } from "./main.js";
import { addVi } from "./i18n.js";
import { ic } from "./icons.js";
import { L, esc } from "./activity.js";
import "./remote.css";

addVi({
  "Remote control": "Điều khiển từ xa", "Open on phone": "Mở trên điện thoại", "Turn off remote control": "Tắt điều khiển từ xa", "Turn on remote control": "Bật điều khiển từ xa",
  "Control this session from the Claude app on your phone": "Điều khiển phiên này từ ứng dụng Claude trên điện thoại",
  "📱 from the phone": "📱 từ điện thoại", "Copy link": "Sao chép liên kết", "Copied": "Đã sao chép", "Open": "Mở", "Connecting…": "Đang kết nối…",
  "Remote control is on": "Điều khiển từ xa đang bật", "Remote control is off": "Điều khiển từ xa đang tắt", "Reconnecting…": "Đang kết nối lại…",
  "Scan the code with your phone, or open the Claude app and pick this session under Code.": "Quét mã bằng điện thoại, hoặc mở ứng dụng Claude và chọn phiên này trong mục Code.",
  "Claude Code's questions appear here and on the phone. Answer in either place: the other one closes by itself.": "Câu hỏi của Claude Code hiện ở cả đây và trên điện thoại. Trả lời ở đâu cũng được: bên kia tự đóng.",
  "While it is on, the session stays open (it is not closed when idle) so the phone can write at any time.": "Khi đang bật, phiên được giữ mở (không đóng khi nhàn rỗi) để điện thoại nhắn bất cứ lúc nào.",
  "Close": "Đóng", "Remote control is on — this session stays open so the phone can write at any time": "Điều khiển từ xa đang bật — phiên được giữ mở để điện thoại nhắn bất cứ lúc nào",
  "Stopped from the phone": "Đã dừng từ điện thoại", "Answered on the phone": "Đã trả lời trên điện thoại", "Remote control couldn't start": "Không bật được điều khiển từ xa",
  "Turns Remote Control on or off for this session (control it from the Claude app on your phone)": "Bật hoặc tắt điều khiển từ xa cho phiên này (điều khiển từ ứng dụng Claude trên điện thoại)",
});

const $ = (s) => document.querySelector(s);

/** Slash commands handled by Callio itself (never sent to the model). */
export const RC_SLASH = [
  { name: "remote-control", description: "Control this Claude Code session from the Claude app on your phone (turns Remote Control on or off)" },
  { name: "rc", description: "Short for /remote-control" },
];
export const isRcCommand = (text) => /^\/(remote-control|rc)\s*$/i.test((text || "").trim());

export const rcOn = (rt) => !!rt?.remote?.on;

/** Tooltip of a tab with Remote Control on. */
export const rcTip = () => L("Remote control is on — this session stays open so the phone can write at any time", "Điều khiển từ xa đang bật — phiên được giữ mở để điện thoại nhắn bất cứ lúc nào");

/** What the backend says about Remote Control for a session ({on, connected, connectUrl, bridgeSessionId, …}). */
export function applyRemote(rt, e) {
  rt.remote = { ...(rt.remote || {}), on: !!e.on, connected: !!e.connected, connectUrl: e.connectUrl || null, bridgeSessionId: e.bridgeSessionId || null, error: e.on ? (e.connected ? null : rt.remote?.error || null) : null, busy: false };
  if (!rt.remote.on) rt.remote = { on: false };
}
export function remoteFailed(rt, error) {
  rt.remote = { ...(rt.remote || {}), on: !!rt.remote?.on, connected: false, error: String(error || ""), busy: false };
}
/** `system/bridge_state` from Claude Code: connected · ready · reconnecting · failed… */
export function applyBridge(rt, e) {
  if (!rt.remote?.on) return;
  rt.remote.bridge = e.state;
  if (e.state === "failed" || e.state === "policy_disabled") rt.remote.error = e.detail || L("Remote control lost its connection.", "Điều khiển từ xa mất kết nối.");
  else if (e.state === "connected" || e.state === "ready") rt.remote.error = null;
}

/** Turn Remote Control on or off for a session whose process handle exists. Throws with a readable message. */
export async function setRemote(rt, enabled, name) {
  rt.remote = { ...(rt.remote || {}), busy: true, error: null };
  try {
    const r = await call("cc_session_remote", { handle: rt.handle, enabled, name: name || null });
    applyRemote(rt, r || {});
    return r;
  } catch (e) {
    rt.remote = { ...(rt.remote || {}), on: enabled ? false : rt.remote?.on, busy: false, error: enabled ? String(e?.message || e) : null };
    throw e;
  }
}

// ---------------- the panel ----------------
let pop = null, popRt = null, onChange = () => {};
const qrCache = new Map();

async function qr(url) {
  if (!url) return "";
  if (qrCache.has(url)) return qrCache.get(url);
  let svg = "";
  try { svg = await call("cc_qr_svg", { text: url }); } catch { svg = ""; }
  qrCache.set(url, svg);
  return svg;
}

function build() {
  if (pop) return pop;
  pop = document.createElement("div");
  pop.id = "rc-pop";
  pop.className = "rc-pop";
  pop.hidden = true;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Remote control");
  ($(".ai-sess") || $("#ai-panel")).appendChild(pop);
  pop.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    const rt = popRt;
    if (!a || !rt) return;
    if (a === "close") return hideRemotePanel();
    if (a === "copy") {
      try { await navigator.clipboard.writeText(rt.remote?.connectUrl || ""); } catch { /* no clipboard: the link is selectable */ }
      const b = e.target.closest("button"); const t = b.textContent; b.textContent = L("Copied", "Đã sao chép"); setTimeout(() => { b.textContent = t; }, 1500);
    } else if (a === "open") call("open_url", { url: rt.remote?.connectUrl }).catch((er) => toast(er.message, "err"));
    else if (a === "off") {
      try { await setRemote(rt, false); } catch (er) { toast(String(er?.message || er), "err", 6000); }
      hideRemotePanel(); onChange();
    }
  });
  document.addEventListener("pointerdown", (e) => { if (pop && !pop.hidden && !e.target.closest("#rc-pop, .cs-rc")) hideRemotePanel(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pop && !pop.hidden) { e.stopPropagation(); hideRemotePanel(); } }, true);
  return pop;
}

export function hideRemotePanel() { if (pop) pop.hidden = true; popRt = null; }
export const remotePanelOpen = () => !!pop && !pop.hidden;

/** Draw (or redraw) the panel for a session. */
export async function drawRemotePanel(rt) {
  if (!pop || pop.hidden || popRt !== rt) return;
  const r = rt.remote || {};
  const url = r.connectUrl || "";
  const svg = r.on && url ? await qr(url) : "";
  if (pop.hidden || popRt !== rt) return;
  const status = r.busy ? L("Connecting…", "Đang kết nối…") : r.on ? (r.connected === false || r.bridge === "reconnecting" ? L("Reconnecting…", "Đang kết nối lại…") : L("Remote control is on", "Điều khiển từ xa đang bật")) : L("Remote control is off", "Điều khiển từ xa đang tắt");
  pop.innerHTML = `<div class="rc-head"><span class="rc-ico">📱</span><b>${L("Remote control", "Điều khiển từ xa")}</b><span class="rc-status ${r.on && r.connected ? "ok" : r.error ? "err" : ""}">${status}</span><button type="button" class="icon small" data-a="close" aria-label="${L("Close", "Đóng")}" title="${L("Close", "Đóng")}">${ic("x")}</button></div>
    ${r.error ? `<div class="rc-error" data-noi18n>${esc(r.error)}</div>` : ""}
    ${r.on && url ? `<div class="rc-body"><div class="rc-qr" aria-label="QR">${svg}</div><div class="rc-side"><input class="rc-url mono" readonly value="${esc(url)}" data-noi18n aria-label="Link"><div class="rc-btns"><button type="button" class="small" data-a="copy">${L("Copy link", "Sao chép liên kết")}</button><button type="button" class="small" data-a="open">${L("Open", "Mở")}</button></div></div></div>
    <p class="rc-note">${L("Scan the code with your phone, or open the Claude app and pick this session under Code.", "Quét mã bằng điện thoại, hoặc mở ứng dụng Claude và chọn phiên này trong mục Code.")}</p>
    <p class="rc-note">${L("Claude Code's questions appear here and on the phone. Answer in either place: the other one closes by itself.", "Câu hỏi của Claude Code hiện ở cả đây và trên điện thoại. Trả lời ở đâu cũng được: bên kia tự đóng.")}</p>
    <p class="rc-note">${L("While it is on, the session stays open (it is not closed when idle) so the phone can write at any time.", "Khi đang bật, phiên được giữ mở (không đóng khi nhàn rỗi) để điện thoại nhắn bất cứ lúc nào.")}</p>` : ""}
    <div class="rc-foot">${r.on ? `<button type="button" class="small" data-a="off">${L("Turn off remote control", "Tắt điều khiển từ xa")}</button>` : ""}</div>`;
}

/** Show the panel under the session tabs for `rt`; `after` runs when the author turns it off there. */
export function showRemotePanel(rt, after) {
  build();
  popRt = rt; onChange = after || (() => {});
  pop.hidden = false;
  drawRemotePanel(rt);
}

/** Redraw the panel if it shows this session (an event changed its state). */
export function refreshRemotePanel(rt) { if (popRt === rt) drawRemotePanel(rt); }

/** The label above a message typed on the phone. */
export const phoneLabel = () => `<span class="rc-from">${L("📱 from the phone", "📱 từ điện thoại")}</span>`;
export const phoneStopHtml = () => `<div class="tool-chip">${L("📱 Stopped from the phone", "📱 Đã dừng từ điện thoại")}</div>`;
