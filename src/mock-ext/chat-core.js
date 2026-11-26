// Browser mock of the Claude Code session manager (chat-core): simulated `claude` processes that
// emit the same `cc-session` events as src-tauri/src/claude_code/session.rs. Dev and tests only.
//
// The script of an answer depends on the message text:
//   "agents"  → a todo list, two subagents (one finishes, one asks for permission), then an answer
//   "long"    → about eight steps of 700 ms each (time to queue / interrupt / take back)
//   anything else → a short answer in about a second
// Test hooks live on window.__ccMock (journals, sent lines, a crash simulation).
import { emit } from "../mock.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const uuid = () => "u" + Math.random().toString(16).slice(2, 10);
const FORCE = () => typeof window !== "undefined" && window.__ccForce;

const live = new Map(); // handle → session
const journals = new Map(); // handle → last journal object written
const rpcWaiters = new Map();
const rpcInfo = new Map(); // [remote] rpc → {handle, requestId, tool, input, toolUseId}: what the stdio `can_use_tool` request said
let rpcSeq = 9000, handleSeq = 0, idSeq = 0;
const maxPar = () => window.__ccMock?.maxParallel || 4;

if (typeof window !== "undefined") {
  window.__ccMock = Object.assign(window.__ccMock || {}, {
    journals, live, sent: [], controls: [], rpcWaiters,
    // [remote] what the real session manager would exchange with Claude Code over stdio
    controlRequests: [], controlResponses: [], cancels: [], autoAnswered: [], remoteError: null,
    /** The phone answers the oldest open question of a session: Claude Code sends control_cancel_request, the card closes here. */
    phoneAnswer(handle, allow = true) {
      const rpc = [...rpcInfo].find(([, i]) => i.handle === handle)?.[0];
      if (!rpc) return false;
      const i = rpcInfo.get(rpc); rpcInfo.delete(rpc);
      window.__ccMock.cancels.push(i.requestId);
      const w = rpcWaiters.get(rpc); rpcWaiters.delete(rpc);
      live.get(handle)?.rpcs.delete(rpc);
      emit("cc-rpc-cancel", { rpc, elsewhere: true }); // (broadcast: whichever window holds the card closes it)
      w?.({ allow, fromPhone: true });
      return true;
    },
    /** Something typed on the phone while Remote Control is on (the stdio echo of a user message Callio did not write). */
    phoneMessage(handle, text) {
      const s = live.get(handle);
      if (!s || !s.remoteWant) return false;
      const m = { uuid: uuid(), text, mode: "next", at: now() };
      ev(s, "phone_msg", { uuid: m.uuid, text, at: m.at });
      if (s.turn) s.pending.push(m); else { s.inbox.push(m); runTurn(s); }
      return true;
    },
    phoneInterrupt(handle) { const s = live.get(handle); if (!s) return false; s.abort = true; ev(s, "remote_interrupt"); return true; },
    /** What the idle check of the session manager does: it never closes a process while Remote Control is on. */
    idleClose(handle) { const s = live.get(handle); if (!s || s.turn || !s.proc || s.remoteWant) return false; s.proc = false; status(s, "idle"); return true; },
    /** The process was recycled (idle close, crash): the next message starts a new one and Remote Control is turned on again. */
    recycle(handle) { const s = live.get(handle); if (!s) return false; s.proc = false; if (s.remote) { s.remote = null; ev(s, "remote", remoteState(s)); } journal(s); return true; },
    /** Forget every live session without a clean end (what a power cut leaves behind). */
    crash() { for (const s of live.values()) s.abort = true; live.clear(); },
    seedJournal(j) { journals.set(j.handle, { cleanEnd: false, status: "running", queued: [], meta: {}, settings: {}, createdAt: now(), updatedAt: now(), ...j }); },
    stepMs: 700,
  });
}

let evSeq = 0; // like the real events: a number that only grows (detach.js uses it to hand a session to another window)
function ev(s, kind, extra = {}) { emit("cc-session", { handle: s.handle, kind, seq: ++evSeq, ...extra }); }
function status(s, st) {
  s.status = st;
  ev(s, "status", { status: st, proc: s.proc, turnActive: s.turn, claudeId: s.claudeId, queued: s.pending.map((m) => ({ uuid: m.uuid, text: m.text, mode: m.mode, at: m.at, sent: true })), waiting: s.perms });
  journal(s);
}
function journal(s) {
  const clean = !s.turn && !s.pending.length && !s.restoredPending;
  journals.set(s.handle, { handle: s.handle, status: s.status, proc: s.proc, turnActive: s.turn, claudeId: s.claudeId, cwd: s.req.cwd, model: s.req.model, label: s.req.label, step: s.step, todos: s.todos, queued: s.pending.map((m) => ({ uuid: m.uuid, text: m.text, mode: m.mode, at: m.at, sent: true })), tokens: s.tokens, createdAt: s.created, updatedAt: now(), cleanEnd: s.ended ? true : clean, meta: s.meta, settings: { permissionMode: s.req.permissionMode, effort: s.req.effort, thinking: s.req.thinking, web: s.req.web }, remoteControl: remoteState(s) });
}
function remoteState(s) { return { on: !!s.remoteWant, connected: !!s.remote, bridgeSessionId: s.bridgeId || null, connectUrl: s.remote?.connectUrl || null, environmentId: s.remote ? "env_mock" : null }; }
/** Which tool calls Claude Code asks about, by permission mode (what the real one decides before it sends can_use_tool). */
function needsAsk(mode, tool, input) {
  const escalated = /rm -rf|# escalated/.test(input?.command || "");
  if (mode === "bypassPermissions") return false;
  if (mode === "auto") return escalated;
  if (mode === "acceptEdits") return !["Edit", "MultiEdit", "Write"].includes(tool);
  return true;
}
const assistant = (s, parent, text, tools = []) => ev(s, "ev", { ev: { t: "assistant", text, tools, model: "claude-opus-5-5", parent: parent || null } });
const results = (s, parent, rs) => ev(s, "ev", { ev: { t: "tool_results", results: rs, parent: parent || null } });
async function say(s, text) {
  ev(s, "ev", { ev: { t: "message_start" } });
  for (const w of text.match(/.{1,10}/gs) || []) { if (s.abort) return; ev(s, "ev", { ev: { t: "text", text: w } }); await sleep(25); }
}
function step(s, tool, arg, id) {
  s.step = { tool, arg };
  ev(s, "step", { tool, arg, toolUseId: id });
  s.tokens += 800;
  ev(s, "tokens", { total: s.tokens });
}
async function pause(s, ms) {
  const end = now() + ms;
  while (now() < end) { if (s.abort) return false; await sleep(30); }
  return !s.abort;
}
async function ask(s, toolName, input, parent, toolUseId) {
  if (!needsAsk(s.req.permissionMode || "default", toolName, input)) { window.__ccMock.autoAnswered.push({ handle: s.handle, tool: toolName }); return { allow: true, auto: true }; }
  const rpc = ++rpcSeq;
  const requestId = "req-" + rpc;
  rpcInfo.set(rpc, { handle: s.handle, requestId, tool: toolName, input, toolUseId });
  window.__ccMock.controlRequests.push({ handle: s.handle, request_id: requestId, request: { subtype: "can_use_tool", tool_name: toolName, input, tool_use_id: toolUseId, agent_id: parent || undefined } });
  s.perms++;
  status(s, "waiting");
  const v = await new Promise((res) => { rpcWaiters.set(rpc, res); s.rpcs.add(rpc); (window.__mockRpcEmit || emit)("cc-rpc", { rpc, method: "permission", params: { toolName, input, session: s.handle, toolUseId } }); });
  s.rpcs.delete(rpc);
  s.perms--;
  if (!s.perms) status(s, "running");
  return v;
}

/** One message's worth of work. Checks `s.abort` between steps. */
async function work(s, m) {
  const ms = window.__ccMock.stepMs;
  const t = m.text;
  if (/agents/i.test(t)) {
    const todos = [["Read the spec", "completed"], ["Review in parallel", "in_progress"], ["Write the summary", "pending"]].map(([content, st]) => ({ content, status: st, activeForm: content.replace(/^Read/, "Reading") }));
    s.todos = todos; ev(s, "todos", { todos });
    assistant(s, null, "", [{ id: "td", name: "TodoWrite", input: { todos } }]); step(s, "TodoWrite", "", "td");
    await say(s, "I'll review this in parallel with two subagents.");
    const ids = [["ag1", "task-1", "Explore", "claude-sonnet-5-5", "Find every use of the old name"], ["ag2", "task-2", "general-purpose", "claude-haiku-5-5", "Rewrite the config file"]];
    for (const [tu, task, type, model, description] of ids) {
      assistant(s, null, "", [{ id: tu, name: "Task", input: { subagent_type: type, model, description, prompt: description + " — be thorough." } }]);
      ev(s, "agent", { phase: "start", taskId: task, toolUseId: tu, description, subagentType: type, prompt: description + " — be thorough.", taskType: "local_agent", background: false });
    }
    step(s, "Task", "", "ag1");
    // subagent 1 works and finishes
    for (let i = 0; i < 4 && !s.abort; i++) {
      assistant(s, "ag1", "", [{ id: "a1t" + i, name: "Grep", input: { pattern: "oldName" + i, path: "src" } }]);
      ev(s, "agent", { phase: "progress", taskId: "task-1", toolUseId: "ag1", description: ids[0][4], usage: { tokens: 1200 * (i + 1), toolUses: i + 1, durationMs: 800 * (i + 1) } });
      await pause(s, ms / 2);
      results(s, "ag1", [{ id: "a1t" + i, isError: false, text: "3 matches" }]);
    }
    if (s.abort) return;
    ev(s, "agent", { phase: "end", taskId: "task-1", toolUseId: "ag1", status: "completed", summary: "Found 9 uses in 4 files", usage: { tokens: 5200, toolUses: 4, durationMs: 3600 } });
    results(s, null, [{ id: "ag1", isError: false, text: "Found 9 uses" }]);
    // subagent 2 asks permission
    assistant(s, "ag2", "", [{ id: "a2b", name: "Bash", input: { command: "npm test -- --run" } }]);
    ev(s, "agent", { phase: "progress", taskId: "task-2", toolUseId: "ag2", description: ids[1][4], usage: { tokens: 900, toolUses: 1, durationMs: 700 } });
    const ans = await ask(s, "Bash", { command: "npm test -- --run" }, "ag2", "a2b");
    if (s.abort) return;
    const ok = ans && ans.allow;
    results(s, "ag2", [{ id: "a2b", isError: !ok, text: ok ? "12 passed" : "denied" }]);
    ev(s, "agent", { phase: "end", taskId: "task-2", toolUseId: "ag2", status: ok ? "completed" : "failed", summary: ok ? "Config rewritten" : "Command denied", usage: { tokens: 2600, toolUses: 2, durationMs: 2100 } });
    results(s, null, [{ id: "ag2", isError: !ok, text: "done" }]);
    s.todos = todos.map((x) => ({ ...x, status: "completed" })); ev(s, "todos", { todos: s.todos });
    await say(s, ok ? "\n\nBoth subagents finished. Nine uses were renamed and the tests pass." : "\n\nThe second subagent was not allowed to run the tests.");
    return;
  }
  if (/perm/i.test(t)) {
    // one edit, one ordinary command, one risky command: which of them ask depends on the permission mode
    const calls = [["Edit", { file_path: `${s.req.cwd}/a.md`, old_string: "x", new_string: "y" }], ["Bash", { command: "npm test" }], ["Bash", { command: "rm -rf build/ # escalated" }]];
    const out = [];
    for (const [tool, input] of calls) {
      const id = "P" + (idSeq++);
      assistant(s, null, "", [{ id, name: tool, input }]); step(s, tool, tool === "Bash" ? input.command : "a.md", id);
      const ans = await ask(s, tool, input, null, id);
      if (s.abort) return;
      out.push(ans?.allow ? "allowed" : "denied");
      results(s, null, [{ id, isError: !ans?.allow, text: ans?.allow ? "ok" : "denied" }]);
    }
    await say(s, `Done: ${out.join(", ")}.`);
    return;
  }
  if (/long/i.test(t)) {
    await say(s, "Working through the list step by step.");
    for (let i = 1; i <= 8; i++) {
      if (s.abort) return;
      const id = "L" + (idSeq++);
      assistant(s, null, "", [{ id, name: "Read", input: { file_path: `${s.req.cwd}/part-${i}.md` } }]);
      step(s, "Read", `part-${i}.md`, id);
      if (!(await pause(s, ms))) return;
      results(s, null, [{ id, isError: false, text: "ok" }]);
      // a "next" message is read after the step that is running now
      if (s.pending.some((p) => p.mode === "next")) return fold(s);
    }
    await say(s, "\n\nAll eight parts are done.");
    return;
  }
  await say(s, "Here is a short answer.");
  step(s, "Read", "notes.md", "r" + idSeq);
  await pause(s, ms / 2);
  if (s.pending.length) return fold(s);
  await say(s, " And it is done.");
}

/** Messages queued with "next" are read now, and their requests handled in the same turn. */
async function fold(s) {
  const take = s.pending.filter((p) => p.mode === "next");
  s.pending = s.pending.filter((p) => !take.includes(p));
  for (const m of take) { ev(s, "cmd", { uuid: m.uuid, state: "started" }); }
  status(s, "running");
  await say(s, `\n\nAlso doing: ${take.map((m) => m.text).join(" / ")}.`);
}

async function runTurn(s) {
  if (s.turn) return;
  s.turn = true; s.abort = false; s.interrupted = false;
  s.proc = true; s.tokens = 0;
  if (!s.claudeId) { s.claudeId = "sess-" + (++idSeq); ev(s, "session_id", { sessionId: s.claudeId }); }
  ev(s, "init", { model: "claude-opus-5-5", permissionMode: "default", mcp: [{ name: "callio", status: "connected" }] });
  status(s, "running");
  while (s.inbox.length && !s.abort) {
    const m = s.inbox.shift();
    ev(s, "cmd", { uuid: m.uuid, state: "started" });
    await work(s, m);
    if (s.abort) break;
    // messages sent while it was busy but not yet read
    while (s.pending.length && !s.abort) { const m2 = s.pending.shift(); s.inbox.push(m2); }
  }
  s.step = null;
  s.turn = false;
  s.proc = true;
  const stopped = s.abort;
  s.abort = false;
  ev(s, "result", { isError: false, subtype: stopped ? "error_during_execution" : "success", text: "", errors: "", numTurns: 1, tokens: s.tokens });
  ev(s, "rate", { info: { status: "allowed" } });
  status(s, s.pending.length || s.inbox.length ? "running" : "idle");
  ev(s, "turn_done", { changed: [], snapshotPartial: false, tokens: s.tokens, durationMs: 1000, files: s.todos.length ? 2 : 0, added: s.todos.length ? 14 : 0, removed: s.todos.length ? 3 : 0 });
  if (s.inbox.length) runTurn(s);
  for (const w of live.values()) if (w.waitSlot && running() < maxPar()) { w.waitSlot = false; w.inbox.push(...w.pending.splice(0)); runTurn(w); }
}

function running() { return [...live.values()].filter((x) => x.turn).length; }
function get(h) { const s = live.get(h); if (!s) throw "This session isn't open any more"; return s; }

export async function handle(cmd, a) {
  if (cmd === "cc_status" && FORCE()) return { installed: true, path: "C:/Users/me/.local/bin/claude.exe", version: "2.1.332 (Claude Code)", loggedIn: true, auth: { loggedIn: true, authMethod: "claude.ai", email: "me@example.com" }, gitBash: true };
  if (cmd === "cc_qr_svg") return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" shape-rendering="crispEdges"><rect width="21" height="21" fill="#fff"/><path fill="#000" d="M1 1h7v7H1zM13 1h7v7h-7zM1 13h7v7H1zM10 10h2v2h-2zM14 12h3v3h-3zM10 16h3v3h-3z"/></svg>`;
  if (cmd === "cc_reply") {
    const w = rpcWaiters.get(a.rpc); if (!w) return undefined; rpcWaiters.delete(a.rpc);
    const i = rpcInfo.get(a.rpc); rpcInfo.delete(a.rpc);
    if (i) {
      // what session.rs writes back to Claude Code (perm_body)
      const v = a.value || {};
      const body = v.allow === true ? { behavior: "allow", updatedInput: i.input } : { behavior: "deny", message: v.message ? `The author declined: ${v.message}` : "The author declined this action." };
      if (i.toolUseId) body.toolUseID = i.toolUseId;
      window.__ccMock.controlResponses.push({ handle: i.handle, request_id: i.requestId, response: body });
    }
    w(a.value); return null;
  }
  if (!/^cc_(session|journal)_/.test(cmd)) return undefined;
  const M = window.__ccMock;
  switch (cmd) {
    case "cc_session_start": {
      const req = a.req;
      const handle = req.handle || `cc-${++handleSeq}-${uuid()}`;
      const s = { handle, req, status: "idle", proc: false, turn: false, claudeId: req.resumeId || null, pending: [], inbox: [], perms: 0, rpcs: new Set(), todos: [], step: null, tokens: 0, created: now(), meta: req.meta || {}, abort: false, restoredPending: !!req.restored, remoteWant: !!req.remoteControl?.on, bridgeId: req.remoteControl?.bridgeSessionId || null, remote: null };
      live.set(handle, s);
      journal(s);
      // [remote] it was on when the app stopped: the process starts at once and turns it on again
      if (s.remoteWant) setTimeout(() => { s.proc = true; M.controls.push({ handle, control: "remote_control", enabled: true, reattach_session_id: s.bridgeId }); s.remote = { connectUrl: `https://claude.ai/code/session_${s.bridgeId}` }; ev(s, "remote", remoteState(s)); journal(s); }, 80);
      return { handle };
    }
    case "cc_session_send": {
      const s = get(a.handle);
      const m = { uuid: a.uuid || uuid(), text: a.text, mode: a.mode, at: now() };
      M.sent.push({ handle: s.handle, text: a.text, mode: a.mode, patch: a.patch });
      if (a.patch?.permissionMode) { if (a.patch.permissionMode !== s.req.permissionMode) M.controls.push({ handle: s.handle, control: "set_permission_mode", mode: a.patch.permissionMode }); s.req.permissionMode = a.patch.permissionMode; }
      // a new process after a recycle: Remote Control is turned on again, attached to the same phone conversation
      if (!s.proc && s.remoteWant) { s.proc = true; M.controls.push({ handle: s.handle, control: "remote_control", enabled: true, reattach_session_id: s.bridgeId || null }); s.remote = { connectUrl: s.remote?.connectUrl || `https://claude.ai/code/session_${s.bridgeId}` }; ev(s, "remote", remoteState(s)); }
      s.restoredPending = false;
      if (!s.turn) {
        if (running() >= maxPar()) { s.pending.push(m); s.waitSlot = true; status(s, "queued"); return { uuid: m.uuid, state: "queued" }; }
        s.inbox.push(m);
        runTurn(s);
        return { uuid: m.uuid, state: "sent" };
      }
      if (a.mode === "now") {
        s.abort = true; M.controls.push({ handle: s.handle, control: "interrupt" });
        s.inbox.length = 0; s.pending = s.pending.filter((p) => p.mode !== "now");
        s.inbox.push(m);
        const wait = async () => { while (s.turn) await sleep(20); runTurn(s); };
        wait();
        return { uuid: m.uuid, state: "sent" };
      }
      s.pending.push(m);
      journal(s);
      status(s, s.status);
      return { uuid: m.uuid, state: "sent" };
    }
    case "cc_session_cancel_queued": {
      const s = get(a.handle);
      const i = s.pending.findIndex((p) => p.uuid === a.uuid);
      if (i < 0) return false;
      s.pending.splice(i, 1);
      M.controls.push({ handle: s.handle, control: "cancel_async_message", uuid: a.uuid });
      ev(s, "cmd", { uuid: a.uuid, state: "cancelled" });
      status(s, s.status);
      return true;
    }
    case "cc_session_interrupt": {
      const s = get(a.handle);
      M.controls.push({ handle: s.handle, control: "interrupt" });
      s.abort = true; s.pending = []; s.inbox.length = 0;
      for (const r of s.rpcs) { rpcWaiters.get(r)?.({ allow: false }); rpcWaiters.delete(r); }
      return null;
    }
    case "cc_session_stop": {
      const s = live.get(a.handle);
      if (!s) return null;
      if (s.remoteWant) { M.controls.push({ handle: s.handle, control: "remote_control", enabled: false, name: null }); s.remoteWant = false; s.remote = null; }
      s.abort = true; s.ended = now(); s.pending = []; s.inbox.length = 0;
      for (const r of s.rpcs) { rpcWaiters.get(r)?.({ allow: false }); rpcWaiters.delete(r); }
      s.status = "ended"; journal(s);
      live.delete(a.handle);
      return null;
    }
    case "cc_session_remote": {
      const s = get(a.handle);
      M.controls.push({ handle: s.handle, control: "remote_control", enabled: !!a.enabled, name: a.name || null, reattach_session_id: a.enabled ? s.bridgeId || null : null });
      if (!a.enabled) { s.remote = null; s.remoteWant = false; s.bridgeId = null; ev(s, "remote", remoteState(s)); journal(s); return remoteState(s); }
      await sleep(M.remoteDelay || 150);
      if (M.remoteError) throw new Error(M.remoteError);
      s.proc = true;
      s.bridgeId = s.bridgeId || "bridge_" + uuid();
      s.remote = { connectUrl: `https://claude.ai/code/session_${s.bridgeId}` };
      s.remoteWant = true;
      ev(s, "remote", remoteState(s)); journal(s);
      return remoteState(s);
    }
    case "cc_session_stop_task": return null;
    case "cc_session_state": { const s = get(a.handle); return { handle: s.handle, status: s.status, claudeId: s.claudeId }; }
    case "cc_session_list": return [...live.values()].map((s) => ({ handle: s.handle, status: s.status }));
    case "cc_session_meta": { const s = live.get(a.handle); if (s) { s.meta = { ...s.meta, ...a.meta }; journal(s); } return null; }
    case "cc_journal_list": return [...journals.values()].map((j) => ({ ...j, live: live.has(j.handle) })).sort((x, y) => y.updatedAt - x.updatedAt);
    case "cc_journal_end": {
      let n = 0;
      for (const j of journals.values()) if (!j.cleanEnd && !live.has(j.handle) && (!a.handles || a.handles.includes(j.handle))) { j.cleanEnd = true; j.status = "ended"; j.queued = []; n++; }
      return n;
    }
    default: return undefined;
  }
}
