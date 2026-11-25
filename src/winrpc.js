// Window-to-window messages: an editor window and its chat window (detach.js) ask each other for
// things and tell each other what changed.
//
// One envelope for both transports, so the logic on top is the same everywhere:
//   { id, from, to, t: "req" | "res" | "evt", method?, params?, ok?, value?, error? }
// In the app the envelope travels through the Rust relay (`win_send` → a `win-msg` event in the
// target window). In a plain browser (dev, tests) a BroadcastChannel carries it between pages.
import { call, listen, IS_TAURI } from "./api.js";
import { winLabel } from "./windows.js";

const reqHandlers = new Map();
const evtHandlers = new Map();
const waiting = new Map();
let seq = 0, started = false, bc = null;

/** Answer requests named `method`: fn(params, from) → value (or a promise). */
export const onRequest = (method, fn) => reqHandlers.set(method, fn);
/** React to events named `name`: fn(data, from). Several listeners are fine. */
export function onEvent(name, fn) {
  if (!evtHandlers.has(name)) evtHandlers.set(name, new Set());
  evtHandlers.get(name).add(fn);
  return () => evtHandlers.get(name)?.delete(fn);
}

async function send(env) {
  env.from = winLabel;
  if (IS_TAURI) {
    const ok = await call("win_send", { to: env.to, msg: env });
    if (!ok) throw new Error("The other window isn't open.");
  } else {
    bc.postMessage(env);
  }
}

async function receive(env) {
  if (!env || env.to !== winLabel) return;
  if (env.t === "res") {
    const w = waiting.get(env.id);
    if (!w) return;
    waiting.delete(env.id);
    clearTimeout(w.timer);
    if (env.ok) w.resolve(env.value); else w.reject(new Error(env.error || "The other window couldn't do that."));
  } else if (env.t === "req") {
    const h = reqHandlers.get(env.method);
    const res = { id: env.id, to: env.from, t: "res" };
    try {
      if (!h) throw new Error(`The window can't do "${env.method}".`);
      res.value = (await h(env.params || {}, env.from)) ?? null;
      res.ok = true;
    } catch (e) { res.ok = false; res.error = e?.message || String(e); }
    send(res).catch(() => {});
  } else if (env.t === "evt") {
    for (const fn of evtHandlers.get(env.method) || []) { try { fn(env.params, env.from); } catch (e) { console.warn("win event", env.method, e); } }
  }
}

/** Start listening (once). Cheap; every window that talks to another one calls it. */
export async function initWinRpc() {
  if (started) return;
  started = true;
  if (IS_TAURI) await listen("win-msg", receive);
  else { bc = new BroadcastChannel("callio-win"); bc.onmessage = (e) => receive(e.data); }
}

/** Ask another window to do something and wait for its answer. */
export async function request(to, method, params = {}, { timeout = 15000 } = {}) {
  await initWinRpc();
  const id = `${winLabel}:${++seq}:${Date.now().toString(36)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error("The other window didn't answer.")); }, timeout);
    waiting.set(id, { resolve, reject, timer });
    send({ id, to, t: "req", method, params }).catch((e) => { clearTimeout(timer); waiting.delete(id); reject(e); });
  });
}

/** Tell another window something (no answer). Quietly does nothing when it isn't open. */
export async function notify(to, name, data = {}) {
  await initWinRpc();
  try { await send({ id: `${winLabel}:${++seq}`, to, t: "evt", method: name, params: data }); } catch { /* not open */ }
}
