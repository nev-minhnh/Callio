// Everything you can see about running Claude Code sessions, drawn from the state that
// cc-sessions.js keeps: the tab row, the activity strip above the input (and its panel that
// opens upward), the activity column (layout B), the sessions list and the "needs you" toast.
// This file only draws and reports clicks; it never talks to the backend.
//
// State it reads, per session `rt` (see cc-sessions.js):
//   rt.status        "idle" | "starting" | "running" | "waiting" | "queued" | "error" | "ended"
//   rt.act           { startedAt, endedAt, tokens, step:{tool,arg}, todos:[{content,status,activeForm}],
//                      agents: Map(key → agent) }
//   agent            { key, taskId, type, model, description, prompt, status: running|waiting|done|error|stopped,
//                      startedAt, endedAt, tokens, toolUses, log:[{t, kind, text, detail}], perm, background }
//   rt.perms         Map(rpc → { rpc, toolName, input, agent })
import { ic } from "./icons.js";
import { uiLang } from "./i18n.js";
import { CC_MODELS } from "./ai.js";

export const L = (en, vi) => (uiLang() === "vi" ? vi : en);
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const BOLT = `<svg class="ic" aria-hidden="true" viewBox="0 0 24 24"><path d="M13 4 6 14h6l-1 6 7-10h-6l1-6z"/></svg>`;
const STOP = `<svg class="ic" aria-hidden="true" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
const FLIP = `<svg class="ic" aria-hidden="true" viewBox="0 0 24 24"><path d="M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4"/></svg>`;
export const ICONS = { bolt: BOLT, stop: STOP };

// ---------------- small formatters ----------------
export function fmtDur(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}
export function fmtTok(n) {
  n = Math.round(n || 0);
  return n >= 100000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}
export function ago(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return L("just now", "vừa xong");
  if (m < 60) return L(`${m} min ago`, `${m} phút trước`);
  if (m < 48 * 60) return L(`${Math.round(m / 60)} h ago`, `${Math.round(m / 60)} giờ trước`);
  return L(`${Math.round(m / 1440)} d ago`, `${Math.round(m / 1440)} ngày trước`);
}

/** "Opus 5.5" for a model id; `short` gives just "Opus". */
export function modelLabel(id, short = false) {
  const id2 = String(id || "");
  const hit = CC_MODELS.find(([v]) => v === id2) || CC_MODELS.find(([v]) => id2 && v !== "default" && id2.startsWith(v));
  let name = hit ? hit[1] : /opus/i.test(id2) ? "Opus" : /sonnet/i.test(id2) ? "Sonnet" : /haiku/i.test(id2) ? "Haiku" : /fable/i.test(id2) ? "Fable" : id2 === "default" || !id2 ? "Claude" : id2;
  if (short) name = name.split(" ")[0];
  return name;
}

const VERB = {
  Bash: ["Running", "đang chạy"], PowerShell: ["Running", "đang chạy"], Read: ["Reading", "đang đọc"],
  Edit: ["Editing", "đang sửa"], MultiEdit: ["Editing", "đang sửa"], Write: ["Writing", "đang ghi"], NotebookEdit: ["Editing", "đang sửa"],
  Grep: ["Searching", "đang tìm"], Glob: ["Finding files", "đang tìm tệp"], WebSearch: ["Searching the web", "đang tìm trên web"], WebFetch: ["Reading the page", "đang đọc trang"],
  Task: ["Starting a subagent", "đang giao việc cho subagent"], Agent: ["Starting a subagent", "đang giao việc cho subagent"],
  Skill: ["Using a skill", "đang dùng kỹ năng"], TodoWrite: ["Updating the to-do list", "đang cập nhật danh sách việc"],
};
/** What the main agent is doing, as markup: a verb and (in code) what it works on. */
export function stepHtml(rt) {
  const st = rt.act.step;
  if (rt.status === "waiting") return `<span>${L("Waiting for you", "Đang chờ bạn")}</span>`;
  if (rt.status === "queued") return `<span>${L("Waiting for a free slot", "Đang chờ đến lượt")}</span>`;
  if (rt.status === "starting") return `<span>${L("Starting Claude Code…", "Đang khởi động Claude Code…")}</span>`;
  if (rt.status === "error") return `<span>${L("Stopped with an error", "Dừng do lỗi")}</span>`;
  if (rt.status === "idle" || rt.status === "ended") return `<span>${L("Done", "Xong")}</span>`;
  if (!st?.tool) return `<span>${rt.writing ? L("Writing the answer", "Đang viết câu trả lời") : L("Thinking…", "Đang suy nghĩ…")}</span>`;
  const v = VERB[st.tool] || (st.tool.startsWith("mcp__callio__") ? ["Using Callio:", "đang dùng Callio:"] : ["Using", "đang dùng"]);
  return `<span>${L(v[0], v[1])}</span> ${st.arg ? `<code class="mono" data-noi18n>${esc(st.arg)}</code>` : st.tool.startsWith("mcp__") || !VERB[st.tool] ? `<code class="mono" data-noi18n>${esc(st.tool.replace(/^mcp__callio__/, ""))}</code>` : ""}`;
}

export function todoStats(rt) {
  const t = rt.act.todos || [];
  const done = t.filter((x) => x.status === "completed").length;
  return { total: t.length, done, pct: t.length ? Math.round((done / t.length) * 100) : 0 };
}
const agentList = (rt) => [...rt.act.agents.values()];
export const totalTok = (rt) => (rt.act.tokens || 0) + [...rt.act.agents.values()].reduce((n, a) => n + (a.tokens || 0), 0);
export const runningAgents = (rt) => agentList(rt).filter((a) => a.status === "running" || a.status === "waiting").length;

/** The colour class of a session's dot. */
export function visualOf(rt) {
  if (!rt) return "idle";
  if (rt.status === "error") return "error";
  if (rt.perms?.size || rt.status === "waiting") return "need";
  if (rt.status === "running" || rt.status === "starting") return rt.writing ? "write" : "run";
  if (rt.status === "queued") return "queued";
  return "idle";
}

// ---------------- tab row ----------------
/**
 * @param {HTMLElement} el
 * @param {{tabs: any[], active: any, title: (t:any)=>string, vis: (t:any)=>string, needs: (t:any)=>boolean, needCount: number, canClose: boolean}} s
 */
export function renderTabs(el, s) {
  const need = s.needCount;
  el.innerHTML = `
    <button type="button" class="cs-list-btn" data-a="list" aria-haspopup="dialog" title="All Claude Code sessions">${ic("list")}<span>Sessions</span>${need ? `<b class="cs-badge">${L(`${need} need you`, `${need} cần bạn`)}</b>` : ""}</button>
    <div class="cs-tabs" role="tablist" aria-label="Open sessions">${s.tabs.map((t) => {
      const vis = s.vis(t);
      return `<div class="cs-tab ${t === s.active ? "on" : ""} v-${vis}" role="tab" aria-selected="${t === s.active}" data-tab="${t.id}" tabindex="${t === s.active ? 0 : -1}"><span class="cs-dot ${vis}"></span><span class="cs-tab-title" data-noi18n>${esc(s.title(t))}</span>${s.needs(t) ? `<b class="cs-need">${L("Needs you", "Cần bạn")}</b>` : ""}${t.unseen && t !== s.active ? `<i class="cs-unseen" title="New activity"></i>` : ""}<button type="button" class="cs-x" data-a="close" aria-label="Close session" title="Close session">${ic("x")}</button></div>`;
    }).join("")}</div>
    <button type="button" class="icon small cs-new" data-a="new" title="New session" aria-label="New session">${ic("plus")}</button>`;
}

// ---------------- the pieces of the panel ----------------
function dotFor(a) {
  if (a.status === "done") return `<span class="cs-ico ok">${ic("check")}</span>`;
  if (a.status === "error" || a.status === "stopped") return `<span class="cs-ico err">${ic("x")}</span>`;
  return `<span class="cs-dot ${a.status === "waiting" ? "need" : "run"}"></span>`;
}
const STATUS_WORD = {
  running: () => L("running", "đang chạy"), waiting: () => L("needs you", "chờ bạn duyệt"), done: () => L("done", "xong"),
  error: () => L("error", "lỗi"), stopped: () => L("stopped", "đã dừng"),
};
function agentTitle(a) {
  const base = a.type && a.type !== "local_agent" ? a.type : L("Subagent", "Subagent");
  return `${esc(base)}${a.model ? ` · ${esc(modelLabel(a.model, true))}` : ""}`;
}
const agentTime = (a, now) => fmtDur((a.endedAt || now) - a.startedAt);

function todosHtml(rt) {
  const t = rt.act.todos || [];
  if (!t.length) return "";
  return `<div class="act-todos">${t.map((x) => {
    const cls = x.status === "completed" ? "done" : x.status === "in_progress" ? "doing" : "todo";
    const icon = cls === "done" ? `<span class="cs-ico ok">${ic("check")}</span>` : cls === "doing" ? `<span class="cs-dot run small"></span>` : `<span class="cs-dot ring"></span>`;
    return `<div class="act-todo ${cls}">${icon}<span data-noi18n>${esc(cls === "doing" && x.activeForm ? x.activeForm : x.content)}</span></div>`;
  }).join("")}</div>`;
}

export function logHtml(a, now) {
  const rows = a.log.slice(-60);
  if (!rows.length) return `<div class="act-log mono"><div class="act-log-empty">${a.status === "running" ? L("Starting…", "Đang bắt đầu…") : L("No tool calls were reported for this subagent.", "Chưa có lệnh nào của subagent này được ghi lại.")}</div></div>`;
  return `<div class="act-log mono">${rows.map((r, i) => `<div class="${r.kind === "text" ? "txt" : ""}${i === rows.length - 1 && a.status === "running" ? " last" : ""}"><span class="t">${fmtDur(r.t - a.startedAt)}</span> <span data-noi18n>${esc(r.text)}</span>${i === rows.length - 1 && a.status === "running" ? ` <span class="caret">▍</span>` : ""}</div>`).join("")}</div>`;
}

function permInline(rt, a) {
  // an open question of this agent (or of the main agent when a == null)
  for (const p of rt.perms.values()) {
    if ((p.agent || null) !== (a ? a.key : null)) continue;
    const what = p.toolName === "Bash" || p.toolName === "PowerShell" ? p.input.command : p.input.file_path || p.input.notebook_path || p.input.url || p.input.pattern || JSON.stringify(p.input).slice(0, 120);
    const verb = p.toolName === "Bash" || p.toolName === "PowerShell" ? L("Wants to run", "Muốn chạy") : ["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(p.toolName) ? L("Wants to change", "Muốn sửa") : L("Wants to use", "Muốn dùng");
    return `<div class="act-perm"><span>${verb}</span><code class="mono" data-noi18n title="${esc(what)}">${esc(String(what).split("\n")[0].slice(0, 160))}</code><span class="grow"></span><button type="button" class="small" data-a="deny" data-rpc="${p.rpc}">${L("Deny", "Từ chối")}</button><button type="button" class="small primary" data-a="allow" data-rpc="${p.rpc}">${L("Allow", "Cho phép")}</button></div>`;
  }
  return "";
}

function mainRow(rt, now) {
  const mdl = modelLabel(rt.modelSeen || rt.model);
  const dot = `<span class="cs-dot ${visualOf(rt)}"></span>`;
  return `<div class="act-row main ${rt.perms.size ? "need" : ""}">${dot}<b data-noi18n>${esc(mdl)}</b><span class="act-sub">· ${L("main agent", "agent chính")}</span><span class="act-step">${stepHtml(rt)}</span><span class="act-meta"><span>${fmtDur((rt.act.endedAt || now) - rt.act.startedAt)}</span><span>${fmtTok(totalTok(rt))}</span></span>${permInline(rt, null)}</div>${todosHtml(rt)}`;
}

function agentRow(rt, a, sel, now) {
  const st = a.status;
  return `<button type="button" class="act-row sub ${st} ${sel ? "sel" : ""}" data-a="pick" data-key="${esc(a.key)}" aria-expanded="${sel}">${dotFor(a)}<b>${agentTitle(a)}</b><span class="act-desc" data-noi18n>${esc(a.description || "")}</span><span class="act-meta"><span class="st">${STATUS_WORD[st]?.() || st}</span><span>${agentTime(a, now)}</span><span>${a.tokens ? fmtTok(a.tokens) : ""}</span></span></button>${permInline(rt, a)}`;
}

// ---------------- layout A: strip + panel ----------------
/** Draws the strip (always, while the session works) and its panel (when `rt.ui.open`). */
export function renderStrip(el, rt, now = Date.now()) {
  if (!rt || !rt.showActivity) { el.hidden = true; el.innerHTML = ""; el._sig = ""; return; }
  el.hidden = false;
  const open = !!rt.ui.open;
  const ts = todoStats(rt);
  const n = runningAgents(rt);
  const total = agentList(rt).length;
  const elapsed = fmtDur((rt.act.endedAt || now) - rt.act.startedAt);
  const sig = JSON.stringify([open, rt.status, rt.writing, rt.act.step, ts, n, total, elapsed, fmtTok(totalTok(rt)), rt.ui.sel, [...rt.perms.keys()], uiLang(), open ? agentList(rt).map((a) => [a.status, a.tokens, a.log.length, a.endedAt, a.description]) : 0, open ? rt.act.todos : 0, open && rt.ui.sel ? 1 : 0]);
  if (sig === el._sig) return;
  el._sig = sig;
  const body = el.querySelector(".act-body"), logs = el.querySelector(".act-log");
  const keep = [body?.scrollTop ?? 0, logs?.scrollTop ?? 0, logs ? logs.scrollHeight - logs.scrollTop - logs.clientHeight < 12 : true];
  const sel = rt.ui.sel && rt.act.agents.get(rt.ui.sel);
  const rows = agentList(rt).map((a) => agentRow(rt, a, sel === a, now) + (sel === a ? logHtml(a, now) + `<div class="act-agent-actions">${a.status === "running" && a.taskId ? `<button type="button" class="small" data-a="stop-agent" data-key="${esc(a.key)}">${L("Stop subagent", "Dừng subagent")}</button>` : ""}<button type="button" class="small" data-a="full-log" data-key="${esc(a.key)}">${L("Open full log", "Mở nhật ký đầy đủ")}</button></div>` : "")).join("");
  const stripHtml = `<div class="act-strip ${visualOf(rt)}"><button type="button" class="act-main" data-a="toggle" aria-expanded="${open}" aria-label="${open ? L("Close the activity panel", "Đóng bảng hoạt động") : L("Open the activity panel", "Mở bảng hoạt động")}">
      <span class="cs-dot ${visualOf(rt)}"></span><b class="act-model" data-noi18n>${esc(modelLabel(rt.modelSeen || rt.model, true))}</b>
      <span class="act-step">${stepHtml(rt)}</span>
      ${total ? `<span class="act-chip">${n ? L(`${n} subagent${n === 1 ? "" : "s"}`, `${n} subagent`) : L(`${total} subagent${total === 1 ? "" : "s"} done`, `${total} subagent xong`)}</span>` : ""}
      ${ts.total ? `<span class="act-prog">${L(`${ts.done}/${ts.total} tasks`, `${ts.done}/${ts.total} việc`)}<i class="bar"><i style="width:${ts.pct}%"></i></i></span>` : ""}
      <span class="act-time">${elapsed}</span>${ic(open ? "chevron-down" : "chevron-down", open ? "" : "flip")}
    </button><button type="button" class="icon small act-flip" data-a="layout" title="Show activity as a column beside the chat" aria-label="Show activity as a column beside the chat">${FLIP}</button></div>`;
  const panel = open ? `<section class="act-panel" aria-label="Activity">
      <div class="act-head"><strong>${L("Activity", "Hoạt động")}</strong><span class="act-chip">${elapsed}</span><span class="act-chip">${L(`${fmtTok(totalTok(rt))} tokens`, `${fmtTok(totalTok(rt))} token`)}</span>${ts.total ? `<span class="act-prog">${L(`${ts.done}/${ts.total} tasks`, `${ts.done}/${ts.total} việc`)}<i class="bar"><i style="width:${ts.pct}%"></i></i></span>` : ""}<button type="button" class="icon small" data-a="toggle" aria-label="Collapse" title="Collapse">${ic("chevron-down")}</button></div>
      <div class="act-body">${mainRow(rt, now)}${rows}</div></section>` : "";
  el.innerHTML = panel + stripHtml;
  const nb = el.querySelector(".act-body"), nl = el.querySelector(".act-log");
  if (nb) nb.scrollTop = keep[0];
  if (nl) nl.scrollTop = keep[2] ? nl.scrollHeight : keep[1];
  el.querySelector(".act-panel .act-perm")?.scrollIntoView({ block: "nearest" });
}

// ---------------- layout B: the column ----------------
export function renderColumn(el, rt, now = Date.now()) {
  if (!rt || !rt.showActivity) { el.hidden = true; el.innerHTML = ""; el._sig = ""; return; }
  el.hidden = false;
  const ts = todoStats(rt);
  const sel = (rt.ui.sel && rt.act.agents.get(rt.ui.sel)) || null;
  const elapsed = fmtDur((rt.act.endedAt || now) - rt.act.startedAt);
  const sig = JSON.stringify([rt.status, rt.writing, rt.act.step, ts, elapsed, fmtTok(totalTok(rt)), rt.ui.sel, [...rt.perms.keys()], uiLang(), rt.act.todos, agentList(rt).map((a) => [a.key, a.status, a.tokens, a.log.length, a.endedAt]), sel && sel.log.length]);
  if (sig === el._sig) return;
  el._sig = sig;
  const logs = el.querySelector(".act-log");
  const keepLog = [logs?.scrollTop ?? 0, logs ? logs.scrollHeight - logs.scrollTop - logs.clientHeight < 12 : true];
  const nodes = agentList(rt).map((a) => `<button type="button" class="act-node ${a.status} ${sel === a ? "sel" : ""}" data-a="pick" data-key="${esc(a.key)}">
      <span class="row1">${dotFor(a)}<b>${agentTitle(a)}</b><span class="act-meta"><span class="st">${STATUS_WORD[a.status]?.() || a.status}</span><span>${agentTime(a, now)} · ${fmtTok(a.tokens)}</span></span></span><span class="sub" data-noi18n>${esc(a.description || "")}</span></button>${permInline(rt, a)}`).join("");
  el.innerHTML = `
    <div class="act-col-head"><div class="top"><strong>${L("Activity", "Hoạt động")}</strong><span class="act-chip">${elapsed}</span><span class="act-chip">${L(`${fmtTok(totalTok(rt))} tokens`, `${fmtTok(totalTok(rt))} token`)}</span><button type="button" class="icon small act-flip" data-a="layout" title="Show activity as a strip above the input" aria-label="Show activity as a strip above the input">${FLIP}</button></div>
      ${ts.total ? `<div class="act-prog wide">${L("Tasks", "Việc")} ${ts.done}/${ts.total}<i class="bar"><i style="width:${ts.pct}%"></i></i></div>` : ""}</div>
    <div class="act-tree"><button type="button" class="act-node main ${rt.perms.size ? "need" : ""} ${!sel ? "sel" : ""}" data-a="pick" data-key="">
      <span class="row1"><span class="cs-dot ${visualOf(rt)}"></span><b data-noi18n>${esc(modelLabel(rt.modelSeen || rt.model))}</b><span class="act-meta"><span>${fmtDur((rt.act.endedAt || now) - rt.act.startedAt)} · ${fmtTok(totalTok(rt))}</span></span></span><span class="sub">${stepHtml(rt)}</span></button>${permInline(rt, null)}
      ${todosHtml(rt)}
      <div class="act-children">${nodes}</div></div>
    ${sel ? `<div class="act-detail"><div class="act-detail-head"><b>${agentTitle(sel)}</b> <span class="act-sub">· ${L("task given by the main agent", "nhiệm vụ do agent chính giao")}</span><p data-noi18n>“${esc((sel.prompt || sel.description || "").slice(0, 600))}”</p></div>${logHtml(sel, now)}<div class="act-agent-actions">${sel.status === "running" && sel.taskId ? `<button type="button" class="small" data-a="stop-agent" data-key="${esc(sel.key)}">${L("Stop subagent", "Dừng subagent")}</button>` : ""}<button type="button" class="small" data-a="full-log" data-key="${esc(sel.key)}">${L("Open full log", "Mở nhật ký đầy đủ")}</button></div></div>` : `<div class="act-detail empty">${agentList(rt).length ? L("Pick a subagent to see what it is doing.", "Chọn một subagent để xem nó đang làm gì.") : L("No subagents yet.", "Chưa có subagent nào.")}</div>`}`;
  const nl = el.querySelector(".act-log");
  if (nl) nl.scrollTop = keepLog[1] ? nl.scrollHeight : keepLog[0];
}

// ---------------- full log dialog ----------------
export function showFullLog(a, onClose) {
  let d = document.getElementById("dlg-cc-log");
  if (!d) {
    d = document.createElement("dialog");
    d.id = "dlg-cc-log";
    d.className = "cs-dlg";
    d.innerHTML = `<div class="dlg-head"><h2></h2><button type="button" class="icon small" data-a="x" aria-label="Close">${ic("x")}</button></div><div class="cs-dlg-body"><p class="cs-dlg-task" data-noi18n></p><pre class="cs-dlg-log mono" data-noi18n></pre></div>`;
    d.addEventListener("click", (e) => { if (e.target.closest("[data-a=x]") || e.target === d) d.close(); });
    document.body.appendChild(d);
  }
  d.querySelector("h2").textContent = `${a.type && a.type !== "local_agent" ? a.type : "Subagent"}${a.model ? ` · ${modelLabel(a.model, true)}` : ""} — ${a.description || ""}`;
  d.querySelector(".cs-dlg-task").textContent = a.prompt || a.description || "";
  d.querySelector(".cs-dlg-log").textContent = a.log.map((r) => `${fmtDur(r.t - a.startedAt)}  ${r.text}${r.detail ? `\n        ${r.detail.replace(/\n/g, "\n        ")}` : ""}`).join("\n") || L("(nothing reported yet)", "(chưa có gì)");
  d.showModal();
}

// ---------------- sessions list ----------------
/**
 * rows: [{ group: "need"|"run"|"done", handle, title, vis, line (html), folder, model, prog:{done,total}|null,
 *          meta (time · tokens), perm: rpc|null, actions: ["open","deny","allow","changes","resume"] }]
 */
export function renderList(el, rows, info) {
  const groups = [["need", L("Needs you", "Cần bạn")], ["run", L("Running", "Đang chạy")], ["done", L("Recently finished", "Xong gần đây")]];
  const body = groups.map(([g, name]) => {
    const rs = rows.filter((r) => r.group === g);
    if (!rs.length) return "";
    return `<div class="grp ${g}">${name}</div>` + rs.map((r) => `<div class="sess ${g}" data-h="${esc(r.handle)}">
      ${r.vis === "done" ? `<span class="cs-ico ok">${ic("check")}</span>` : r.vis === "fail" ? `<span class="cs-ico err">${ic("x")}</span>` : `<span class="cs-dot ${r.vis}"></span>`}
      <div class="sess-main"><b data-noi18n>${esc(r.title)}</b><span class="small">${r.line}${r.folder ? ` · <span data-noi18n>${esc(r.folder)}/</span>` : ""}${r.model ? ` · <span data-noi18n>${esc(r.model)}</span>` : ""}</span></div>
      ${r.prog ? `<span class="act-prog">${r.prog.done}/${r.prog.total}<i class="bar"><i style="width:${Math.round((r.prog.done / r.prog.total) * 100)}%"></i></i></span>` : ""}
      ${r.meta ? `<span class="small meta">${esc(r.meta)}</span>` : ""}
      <span class="sess-actions">${r.actions.map((a) => ({
        open: `<button type="button" class="small" data-a="open">${L("Open", "Mở")}</button>`,
        deny: `<button type="button" class="small" data-a="deny" data-rpc="${r.perm}">${L("Deny", "Từ chối")}</button>`,
        allow: `<button type="button" class="small primary" data-a="allow" data-rpc="${r.perm}">${L("Allow", "Cho phép")}</button>`,
        changes: `<button type="button" class="small" data-a="changes">${L("View changes", "Xem thay đổi")}</button>`,
        resume: `<button type="button" class="small" data-a="resume">${L("Continue", "Chạy tiếp")}</button>`,
      })[a]).join("")}</span></div>`).join("");
  }).join("");
  el.innerHTML = `<div class="cs-list-head"><strong>${L("Claude Code sessions", "Các phiên Claude Code")}</strong><span class="small">${L(`${info.running} running · up to ${info.max} at once`, `${info.running} đang chạy · tối đa ${info.max} cùng lúc`)}</span><button type="button" class="small primary cs-list-new" data-a="new">${ic("plus")}${L("New session", "Phiên mới")}</button></div>${body || `<p class="empty-note">${L("No sessions yet.", "Chưa có phiên nào.")}</p>`}`;
}

// ---------------- toast ----------------
let toastTimer = 0;
export function showToast(host, { title, text, onOpen }) {
  let t = host.querySelector(".cs-toast");
  if (!t) { t = document.createElement("div"); t.className = "cs-toast"; t.setAttribute("role", "status"); host.appendChild(t); }
  t.innerHTML = `<span class="cs-dot need"></span><span><b data-noi18n>${esc(title)}</b> ${esc(text)}</span><button type="button" class="small">${L("Open", "Mở")}</button>`;
  t.querySelector("button").onclick = () => { t.remove(); onOpen(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 12000);
}
export function hideToast(host) { host.querySelector(".cs-toast")?.remove(); }

/** Sessions from earlier runs (their journals): rows with a "Continue" button. */
export function renderOld(list) {
  return `<div class="grp">${L("Earlier", "Trước đó")}</div>` + list.map((j) => `<div class="sess old" data-h="${esc(j.handle)}"><span class="cs-dot idle"></span><div class="sess-main"><b data-noi18n>${esc(j.meta?.title || j.label || "")}</b><span class="small">${ago(j.updatedAt || 0)}${j.cwd ? ` · <span data-noi18n>${esc(String(j.cwd).split(/[\\/]/).filter(Boolean).pop() || "")}/</span>` : ""}</span></div><span class="sess-actions"><button type="button" class="small" data-a="resume">${L("Continue", "Chạy tiếp")}</button></span></div>`).join("");
}
