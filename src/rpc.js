// Requests from the backend to the window ("cc-rpc"): Claude Code's questions and tools,
// PDF text for the AI, library lookups. Handlers return the answer, or SELF when they reply
// later on their own (e.g. a permission card waiting for the user).
import { api, listen } from "./api.js";

export const SELF = Symbol("self-reply");
const handlers = new Map();
let cancelFn = null;
export const onRpc = (method, fn) => handlers.set(method, fn);
export const onRpcCancel = (fn) => { cancelFn = fn; };

let started = false;
export async function initRpc() {
  if (started) return;
  started = true;
  await listen("cc-rpc", async ({ rpc, method, params }) => {
    if (!handlers.has(method)) await import("./claude-code.js"); // registers Claude Code's handlers
    const h = handlers.get(method);
    try {
      const v = h ? await h(params || {}, rpc) : "Unknown request";
      if (v !== SELF) api.ccReply(rpc, v ?? null);
    } catch (e) { api.ccReply(rpc, `Callio error: ${e.message}`); }
  });
  await listen("cc-rpc-cancel", ({ rpc }) => cancelFn?.(rpc));
}
