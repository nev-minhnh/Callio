// Browser mock of the chat window plumbing (detach). In the browser there are no real windows: the
// editor page is `/?win=main`, its chat window a second page `/?win=chat-main&role=chat&parent=main`
// (opened by win_chat_open with window.open, or by the test). The pages talk to each other with the
// same envelopes as the real app (src/winrpc.js, over a BroadcastChannel here), and the chat page
// borrows the first page's mock backend: every command it makes goes to that page over another
// channel, and the backend events (cc-session, permission questions…) are sent back, so both pages
// see one set of Claude Code sessions, like two windows of one process.
// Test hooks: window.__detachMock = { log, registry, open }.
import { invoke, listen, emit } from "../mock.js";

const q = new URLSearchParams(location.search);
const LABEL = q.get("win") || "main";
const IS_CHAT = q.get("role") === "chat";
const EVENTS = ["cc-session", "cc-rpc-cancel", "ai-event", "cc-event", "settings-changed", "compile-status", "install-progress", "chat-gone"];
const LOCAL = /^(win_(chat_[a-z]+|boot|report|list|focus|close|previous|restore|discard_previous|route)|set_title|startup_paths|show_window|close_ack|exit_app)$/;

const state = (window.__detachMock = window.__detachMock || { log: [], registry: [], pendingRpc: new Map(), open: null });
const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("callio-mockrust") : null;
const log = (o) => state.log.push({ at: Date.now(), page: LABEL, ...o });

if (bc && IS_CHAT) {
  // the chat page: ask the first page's backend, listen to its events
  let n = 0;
  const waiting = new Map();
  bc.onmessage = (e) => {
    const m = e.data;
    if (m.t === "ret" && m.to === LABEL) { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); m.ok ? w.res(m.value) : w.rej(m.error); } }
    else if (m.t === "evt" && (!m.to || m.to === LABEL)) {
      if (m.name === "mock-close") { log({ ev: "closed", label: LABEL }); bc.postMessage({ t: "closed", label: LABEL }); setTimeout(() => window.close(), 50); }
      else emit(m.name, m.payload);
    }
  };
  window.__mockForward = (cmd, a, opts) => {
    if (LOCAL.test(cmd) || opts) return null;
    const id = `${LABEL}:${++n}`;
    return new Promise((res, rej) => {
      waiting.set(id, { res: (value) => res({ value }), rej });
      bc.postMessage({ t: "call", id, from: LABEL, cmd, a });
    });
  };
} else if (bc) {
  // the first page: serve the chat page's commands and forward the backend's events
  bc.onmessage = async (e) => {
    const m = e.data;
    if (m.t === "call") {
      try { bc.postMessage({ t: "ret", id: m.id, to: m.from, ok: true, value: (await invoke(m.cmd, m.a)) ?? null }); }
      catch (er) { bc.postMessage({ t: "ret", id: m.id, to: m.from, ok: false, error: String(er?.message || er) }); }
    } else if (m.t === "closed") {
      log({ ev: "chat-closed", label: m.label });
      state.registry = state.registry.filter((w) => w.label !== m.label);
      if (window.__mockWins) window.__mockWins = window.__mockWins.filter((w) => w.label !== m.label);
      emit("chat-gone", { label: m.label });
    }
  };
  // (mock.js is still being evaluated when this file loads: wait until its listeners exist)
  setTimeout(() => { for (const name of EVENTS) listen(name, (e) => { if (name !== "chat-gone") bc.postMessage({ t: "evt", name, payload: e.payload }); }); }, 0);
  // a permission question goes to the window that owns the session (like the real MCP server does)
  window.__mockRpcEmit = (name, payload) => {
    const s = window.__ccMock?.live.get(payload.params?.session);
    const to = s?.req.window || LABEL;
    state.pendingRpc.set(payload.rpc, payload);
    log({ ev: "rpc", rpc: payload.rpc, to });
    if (to === LABEL) emit(name, payload); else bc.postMessage({ t: "evt", name, payload, to });
  };
}

export async function handle(cmd, a) {
  switch (cmd) {
    case "win_chat_open": {
      const label = `chat-${LABEL}`;
      if (!state.registry.some((w) => w.label === label)) {
        state.registry.push({ label, role: "chat", parent: LABEL, bounds: [820, 80, 460, 780] });
        (window.__mockWins ||= []).push({ label, role: "chat", folder: null, files: [], parent: LABEL });
        const url = `/?win=${label}&role=chat&parent=${LABEL}`;
        log({ ev: "open", label, url });
        if (state.open) state.open(url); else window.open(url, "_blank", "popup,width=460,height=780");
      }
      return label;
    }
    case "win_chat_close": {
      if (IS_CHAT) { log({ ev: "closed", label: LABEL }); bc?.postMessage({ t: "closed", label: LABEL }); setTimeout(() => window.close(), 50); return null; }
      const label = `chat-${LABEL}`;
      bc?.postMessage({ t: "evt", name: "mock-close", payload: null, to: label });
      return null;
    }
    case "win_chat_focus": log({ ev: "focus-chat" }); return true;
    case "win_chat_pin": log({ ev: "pin", on: a.on }); return null;
    case "win_focus": log({ ev: "focus", label: a.label }); return null;
    case "set_title": log({ ev: "title", title: a.title }); (window.__titles ||= []).push(a.title); return null;
    case "close_ack": return null;
    case "cc_session_set_window": {
      const s = window.__ccMock?.live.get(a.handle);
      if (!s) throw "This session isn't open any more";
      if (state.delaySetWindow) await new Promise((r) => setTimeout(r, state.delaySetWindow)); // test hook: a slow hand-over
      s.req.window = a.label; s.meta = { ...s.meta, win: a.label };
      log({ ev: "set-window", handle: a.handle, label: a.label });
      // the questions still open are asked again, in the new window
      for (const [rpc, p] of [...state.pendingRpc]) {
        if (!window.__ccMock.rpcWaiters.has(rpc)) { state.pendingRpc.delete(rpc); continue; }
        if (p.params?.session !== a.handle) continue;
        log({ ev: "rpc-reemit", rpc, to: a.label });
        if (a.label === LABEL) emit("cc-rpc", p); else bc?.postMessage({ t: "evt", name: "cc-rpc", payload: p, to: a.label });
      }
      return null;
    }
    case "win_restore": {
      for (const w of window.__mockPrev || []) if (w.role === "chat") {
        const url = `/?win=${w.label}&role=chat&parent=${w.parent || "main"}&restore=1`;
        state.registry.push({ label: w.label, role: "chat", parent: w.parent || "main", bounds: w.bounds || null });
        (window.__mockWins ||= []).push({ label: w.label, role: "chat", folder: null, files: [], parent: w.parent || "main" });
        log({ ev: "restore-chat", url });
        if (state.open) state.open(url); else window.open(url, "_blank", "popup,width=460,height=780");
      }
      return undefined; // the windows mock counts and logs
    }
    default: return undefined;
  }
}
