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
let rpcSeq = 9000, handleSeq = 0, idSeq = 0;
const maxPar = () => window.__ccMock?.maxParallel || 4;

if (typeof window !== "undefined") {
  window.__ccMock = Object.assign(window.__ccMock || {}, {
    journals, live, sent: [], controls: [],
    /** Forget every live session without a clean end (what a power cut leaves behind). */
    crash() { for (const s of live.values()) s.abort = true; live.clear(); },
    seedJournal(j) { journals.set(j.handle, { cleanEnd: false, status: "running", queued: [], meta: {}, settings: {}, createdAt: now(), updatedAt: now(), ...j }); },
    stepMs: 700,
  });
}

function ev(s, kind, extra = {}) { emit("cc-session", { handle: s.handle, kind, ...extra }); }
function status(s, st) {
  s.status = st;
  ev(s, "status", { status: st, proc: s.proc, turnActive: s.turn, claudeId: s.claudeId, queued: s.pending.map((m) => ({ uuid: m.uuid, text: m.text, mode: m.mode, at: m.at, sent: true })), waiting: s.perms });
  journal(s);
}
function journal(s) {
  const clean = !s.turn && !s.pending.length && !s.restoredPending;
  journals.set(s.handle, { handle: s.handle, status: s.status, proc: s.proc, turnActive: s.turn, claudeId: s.claudeId, cwd: s.req.cwd, model: s.req.model, label: s.req.label, step: s.step, todos: s.todos, queued: s.pending.map((m) => ({ uuid: m.uuid, text: m.text, mode: m.mode, at: m.at, sent: true })), tokens: s.tokens, createdAt: s.created, updatedAt: now(), cleanEnd: s.ended ? true : clean, meta: s.meta, settings: { permissionMode: s.req.permissionMode, effort: s.req.effort, thinking: s.req.thinking, web: s.req.web } });
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
  const rpc = ++rpcSeq;
  s.perms++;
  status(s, "waiting");
  const v = await new Promise((res) => { rpcWaiters.set(rpc, res); s.rpcs.add(rpc); emit("cc-rpc", { rpc, method: "permission", params: { toolName, input, session: s.handle, toolUseId } }); });
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
  if (cmd === "cc_reply") { const w = rpcWaiters.get(a.rpc); if (!w) return undefined; rpcWaiters.delete(a.rpc); w(a.value); return null; }
  if (!/^cc_(session|journal)_/.test(cmd)) return undefined;
  const M = window.__ccMock;
  switch (cmd) {
    case "cc_session_start": {
      const req = a.req;
      const handle = req.handle || `cc-${++handleSeq}-${uuid()}`;
      const s = { handle, req, status: "idle", proc: false, turn: false, claudeId: req.resumeId || null, pending: [], inbox: [], perms: 0, rpcs: new Set(), todos: [], step: null, tokens: 0, created: now(), meta: req.meta || {}, abort: false, restoredPending: !!req.restored };
      live.set(handle, s);
      journal(s);
      return { handle };
    }
    case "cc_session_send": {
      const s = get(a.handle);
      const m = { uuid: a.uuid || uuid(), text: a.text, mode: a.mode, at: now() };
      M.sent.push({ handle: s.handle, text: a.text, mode: a.mode, patch: a.patch });
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
      s.abort = true; s.ended = now(); s.pending = []; s.inbox.length = 0;
      for (const r of s.rpcs) { rpcWaiters.get(r)?.({ allow: false }); rpcWaiters.delete(r); }
      s.status = "ended"; journal(s);
      live.delete(a.handle);
      return null;
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
