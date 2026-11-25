// Claude Code inside Callio's AI panel: runs the official `claude` tool headless in the project
// folder with the user's own Claude sign-in (Pro/Max plan), streams its work into the chat,
// asks permission questions in Callio, and shows every changed file as a diff with Undo.
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { unifiedMergeView } from "@codemirror/merge";
import { api, listen } from "./api.js";
import { settings, updateSettings, toast, ask, activeTab, getTabs, getLastCompile, compile, openPath, basename, dirname, folder, saveAll, reloadFromDisk, refreshTree } from "./main.js";
import { getSelectionInfo } from "./editor.js";
import { showDiffDialog } from "./history.js";
import { onRpc, onRpcCancel, initRpc, SELF } from "./rpc.js";
import { forClaude, fromClaude } from "./envs-core.js"; // [wsl]

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const norm = (p) => (p || "").replace(/\\/g, "/").toLowerCase();

export const CC_MODES = [
  ["default", "Ask before changes", "🛡"],
  ["acceptEdits", "Auto-accept file edits (asks before commands)", "✏️"],
  ["auto", "Auto — Claude Code checks each action, no questions", "⚡"],
  ["bypassPermissions", "Full access — never ask", "🚀"],
  ["plan", "Plan only (no changes)", "📋"],
];
export const isCC = (mv) => !!mv && mv.startsWith("claudecode|");

let status = null;
export async function ccStatus(refresh = false) {
  if (!status || refresh) { try { status = await api.ccStatus(); } catch (e) { status = { installed: false, error: e.message }; } }
  return status;
}

// ---------------- questions from Claude Code (MCP server → window) ----------------
let activeRun = null; // { el, toolsEl, autoEdits }
export const cards = new Map();

// [chat-core] a question that comes with a session handle belongs to that session's tab (cc-sessions.js)
let sessionHooks = null;
export function setSessionHooks(h) { sessionHooks = h; }
onRpc("permission", (params, rpc) => { if (params.session && sessionHooks) { sessionHooks.permission(params, rpc); return SELF; } permissionCard(rpc, params); return SELF; });
onRpc("editor_state", () => editorState());
onRpc("open_file", async (params) => { await openPath(fromClaude(params.path, folder), params.line || undefined); return `Opened ${params.path}`; });
onRpc("compile", () => compileForClaude());
onRpcCancel((rpc) => { sessionHooks?.answered?.(rpc, null); const c = cards.get(rpc); if (c) { c.classList.add("answered"); c.querySelector(".cc-perm-actions").innerHTML = "<small>No answer — declined</small>"; cards.delete(rpc); } });

function editorState() {
  const t = activeTab();
  const office = t && ["doc", "sheet", "pdf", "deck", "image"].includes(t.kind);
  const sel = office ? null : getSelectionInfo();
  const line = sel ? sel.doc.lineAt(sel.from).number : null;
  const errs = (getLastCompile()?.diagnostics || []).filter((d) => d.severity === "error").slice(0, 20);
  return {
    file: forClaude(t?.path || null, folder), line, kind: t?.kind || null,
    selection: sel && sel.to > sel.from ? sel.text.slice(0, 20000) : "",
    unsavedFiles: getTabs().filter((x) => x.dirty).map((x) => forClaude(x.path, folder) || x.name),
    openFiles: getTabs().map((x) => forClaude(x.path, folder)).filter(Boolean),
    compileErrors: errs.map((d) => ({ file: forClaude(d.file, folder), line: d.line, message: d.message })),
    ...(office ? { note: { doc: "A Word document: read it with office_read and change it with word_edit (never write the file directly).", sheet: "A spreadsheet: read it with office_read and change it with sheet_edit (never write the file directly).", pdf: "A PDF: read it with read_pdf / office_read and change it with pdf_tool.", deck: "A presentation: read it with office_read and change it with deck_edit (never write the file directly).", image: "A picture: read its edits with office_read and change it with image_edit (picture commands such as develop.set {values: {\"light.exposure\": 0.5}}, develop.auto, crop.aspect, mask.add…; never write the file directly)." }[t.kind] } : {}),
  };
}

async function compileForClaude() {
  // show Claude's edits in the editor first, so compile's save doesn't write stale text
  await reloadFromDisk(getTabs().filter((t) => t.path && !t.dirty).map((t) => t.path));
  const t = activeTab();
  if (!t || (t.kind !== "tex" && t.kind !== "bib")) {
    const tex = getTabs().find((x) => x.kind === "tex");
    if (tex) await openPath(tex.path);
  }
  const prev = getLastCompile();
  await compile({ quiet: true });
  for (let i = 0; i < 1200 && getLastCompile() === prev; i++) await new Promise((r) => setTimeout(r, 100));
  const r = getLastCompile();
  if (!r || r === prev) return "Couldn't compile: open the project's main .tex file in Callio first.";
  const d = r.diagnostics || [];
  const fmt = (x) => `${x.file ? forClaude(x.file, folder) : ""}:${x.line || "?"}: ${x.message}`;
  return {
    ok: !!r.ok, engine: r.engine, pdf: forClaude(r.pdf, folder),
    errors: d.filter((x) => x.severity === "error").slice(0, 40).map(fmt),
    warnings: d.filter((x) => x.severity === "warning").slice(0, 40).map(fmt),
    warningCount: d.filter((x) => x.severity === "warning").length,
  };
}

export const EDIT_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];
export function toolTitle(name, input = {}) {
  const f = input.file_path || input.notebook_path || input.path;
  switch (name) {
    case "Edit": case "MultiEdit": return ["✏️", `Edit ${basename(f)}`];
    case "Write": return ["📝", `Write ${basename(f)}`];
    case "Read": return ["📖", `Read ${basename(f)}`];
    case "Glob": return ["🗂", `Find files ${input.pattern || ""}`];
    case "Grep": return ["🔎", `Search “${input.pattern || ""}”`];
    case "Bash": case "PowerShell": return ["💻", `Run: ${input.description || input.command || ""}`];
    case "WebSearch": return ["🌐", `Web search “${input.query || ""}”`];
    case "mcp__callio__web_search": return ["🌐", `Web search “${input.query || ""}”`];
    case "WebFetch": return ["🌐", `Read ${input.url || ""}`];
    case "Task": case "Agent": return ["🤖", `Sub-agent: ${input.description || ""}`];
    case "TodoWrite": return ["☑️", "Update to-do list"];
    case "Skill": return ["🎓", `Use skill ${input.skill || input.name || ""}`];
    default:
      if (name?.startsWith("mcp__callio__")) return ["🪶", { editor_state: "Look at the editor", compile: "Compile in Callio", open_file: `Open ${basename(input.path)}` }[name.slice(12)] || name];
      return ["🔧", name];
  }
}

function diffEditor(parent, before, after) {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: after,
      extensions: [EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false),
        unifiedMergeView({ original: before, mergeControls: false, highlightChanges: true, gutter: false, collapseUnchanged: { margin: 2, minSize: 6 } })],
    }),
  });
}

/**
 * The permission card. `run` ({cwd, autoEdits}) and `hostEl` (where the card goes) are given by a
 * session tab; the old per-turn runs use the active run. Returns the card (null when auto-allowed).
 */
export async function permissionCard(rpc, { toolName, input }, run = activeRun, hostEl = null, focus = true) {
  // "Allow all edits" earlier in this answer — only for files inside the project folder
  const target = input.file_path || input.notebook_path || "";
  const inProject = !!target && !!run?.cwd && norm(target).startsWith(norm(run.cwd).replace(/\/?$/, "/")) && !/(^|\/)\.\.(\/|$)/.test(norm(target));
  if (run?.autoEdits && EDIT_TOOLS.includes(toolName) && inProject) { api.ccReply(rpc, { allow: true }); return null; }
  const host = hostEl || run?.el?.querySelector(".ai-tools") || $("#ai-messages");
  const card = document.createElement("div");
  card.className = "cc-perm";
  const [ico, title] = toolTitle(toolName, input);
  card.innerHTML = `<div class="cc-perm-head">${ico} <b></b><small>Claude Code asks</small></div><div class="cc-perm-body"></div>
    <div class="cc-perm-actions"><input class="cc-deny-why" type="text" placeholder="Reason / what to do instead (optional)"><button class="small cc-deny">Deny</button>${EDIT_TOOLS.includes(toolName) && inProject ? `<button class="small cc-allow-all" title="Don't ask again for edits to files in this project during this answer">Allow all edits</button>` : ""}<button class="small primary cc-allow">Allow</button></div>`;
  card.querySelector("b").textContent = title;
  const body = card.querySelector(".cc-perm-body");
  const f = input.file_path;
  let views = [];
  if (toolName === "Edit") {
    views.push(diffEditor(body, input.old_string || "", input.new_string || ""));
  } else if (toolName === "MultiEdit") {
    for (const e of input.edits || []) views.push(diffEditor(body, e.old_string || "", e.new_string || ""));
  } else if (toolName === "Write") {
    let old = "";
    try { old = (await api.readText(f)).text; } catch { body.insertAdjacentHTML("beforeend", `<div class="note">New file: ${esc(f)}</div>`); }
    views.push(diffEditor(body, old, input.content || ""));
  } else if (toolName === "Bash" || toolName === "PowerShell") {
    body.innerHTML = `${input.description ? `<div class="note">${esc(input.description)}</div>` : ""}<pre class="cc-cmd"></pre>`;
    body.querySelector("pre").textContent = input.command || "";
  } else {
    const pre = document.createElement("pre");
    pre.className = "cc-cmd";
    pre.textContent = JSON.stringify(input, null, 2).slice(0, 4000);
    body.appendChild(pre);
  }
  if (f) body.insertAdjacentHTML("afterbegin", `<div class="cc-file mono">${esc(f)}${EDIT_TOOLS.includes(toolName) && !inProject ? ` <b class="cc-outside">— outside your project folder</b>` : ""}</div>`);
  const done = (value, label) => {
    cards.delete(rpc);
    views.forEach((v) => v.destroy());
    sessionHooks?.answered?.(rpc, value);
    card.classList.add("answered");
    card.querySelector(".cc-perm-actions").innerHTML = `<small>${esc(label)}</small>`;
    card.querySelector(".cc-perm-body").hidden = true;
    api.ccReply(rpc, value);
  };
  card.querySelector(".cc-allow").onclick = () => done({ allow: true }, "Allowed");
  card.querySelector(".cc-allow-all")?.addEventListener("click", () => { if (run) run.autoEdits = true; done({ allow: true }, "Allowed (and further edits in this answer)"); });
  card.querySelector(".cc-deny").onclick = () => done({ allow: false, message: card.querySelector(".cc-deny-why").value.trim() }, "Denied");
  card.querySelector(".cc-deny-why").addEventListener("keydown", (e) => { if (e.key === "Enter") card.querySelector(".cc-deny").click(); });
  cards.set(rpc, card);
  host.appendChild(card);
  if (focus) card.querySelector(".cc-allow").focus({ preventScroll: true });
  // bring the window's attention to the question
  if (document.hidden) toast("Claude Code is waiting for your answer", "", 5000);
  return card;
}

let listening = false;
async function ensureListeners() {
  if (listening) return;
  listening = true;
  await initRpc();
  await listen("cc-event", ({ id, ev }) => runHandlers.get(id)?.(ev));
}
const runHandlers = new Map();

// ---------------- a chat turn ----------------
export function projectDir() {
  const t = activeTab();
  return folder || (t?.path ? dirname(t.path) : null);
}

export function contextPreamble(ctx) {
  const t = activeTab();
  const parts = [];
  if (t?.path) {
    const sel = getSelectionInfo();
    const line = sel ? sel.doc.lineAt(sel.head ?? sel.from).number : null;
    if (ctx.file) parts.push(`The author is looking at ${t.path}${line ? ` (line ${line})` : ""}.`);
    if (ctx.sel && sel && sel.to > sel.from) parts.push(`Their current selection (lines ${sel.doc.lineAt(sel.from).number}–${sel.doc.lineAt(sel.to).number}):\n<selection>\n${sel.text.slice(0, 30000)}\n</selection>`);
  }
  const errs = (getLastCompile()?.diagnostics || []).filter((d) => d.severity === "error").slice(0, 12);
  if (ctx.log && errs.length) parts.push(`Latest compile errors:\n` + errs.map((d) => `- ${d.file || ""}:${d.line || "?"}: ${d.message}`).join("\n"));
  return parts.length ? `<callio-context>\n${parts.join("\n\n")}\n</callio-context>\n\n` : "";
}

export const SYSTEM = `You are working inside Callio, the LaTeX/Markdown editor the author is using for academic writing, on their own project (the working directory).
- Edit files directly with your tools. Callio saves a version of every file before your turn and shows the author a diff with Undo afterwards.
- After changing .tex or .bib files, use the mcp__callio__compile tool to compile in Callio and fix any errors you caused.
- Use mcp__callio__editor_state when you need to know what the author is looking at.
- To read a PDF use mcp__callio__read_pdf (its text, by page) and mcp__callio__view_pdf_page (a page as an image, for figures and tables). Don't use pdftoppm, Python or other tools for PDFs.
- The author keeps a paper library in Callio: search it with mcp__callio__search_library, read papers with mcp__callio__read_library_paper, and take BibTeX from mcp__callio__library_bibtex. Prefer those papers and keys when citing.
- Never invent references, DOIs, quotes, numbers or results. Only cite BibTeX keys that exist in the project's .bib files; if a new reference is needed, find it on the web, verify it, and say clearly when something is unverified.
- Preserve LaTeX commands, labels, citations and math unless asked to change them. Keep answers concise.`;

export function errorHtml(msg = "") {
  msg = String(msg || "").replace(/^CLAUDE_MISSING_WSL:(.+)$/, (m, d) => `Claude Code isn't installed in WSL (${d}) — install it in AI settings → Claude Code → Run Claude Code in.`); // [wsl]
  const auth = /log ?in|sign ?in|auth|credential|401|api key|oauth|subscription/i.test(msg);
  const limit = /limit|quota|429|usage/i.test(msg);
  return `<div class="ai-error">${esc(msg || "Claude Code stopped with an error.")}${auth ? `<div><button class="small cc-signin">Sign in to Claude Code</button></div>` : ""}${limit ? `<div class="note">Claude Code shares your plan's usage limits with claude.ai.</div>` : ""}</div>`;
}

export function renderChanges(box, changed, cwd) {
  if (!changed.length) { box.hidden = true; return; }
  box.hidden = false;
  const rel = (p) => { const n = p.replace(/\\/g, "/"), c = cwd.replace(/\\/g, "/") + "/"; return n.toLowerCase().startsWith(c.toLowerCase()) ? n.slice(c.length) : basename(p); };
  box.innerHTML = `<div class="cc-ch-title">Files changed by Claude Code</div>`;
  for (const c of changed) {
    const row = document.createElement("div");
    row.className = `cc-ch ${c.status}`;
    row.innerHTML = `<span class="cc-ch-st">${{ modified: "M", added: "A", deleted: "D" }[c.status]}</span><a href="#" class="cc-ch-name"></a><span class="tb-spacer"></span>${c.beforeVersion ? `<button class="small cc-diff">Show changes</button>` : ""}${c.backup ? `<button class="small cc-undo">${c.status === "deleted" ? "Restore" : "Undo"}</button>` : ""}`;
    row.querySelector(".cc-ch-name").textContent = rel(c.path);
    row.querySelector(".cc-ch-name").onclick = (e) => { e.preventDefault(); if (c.status !== "deleted") openPath(c.path); };
    row.querySelector(".cc-diff")?.addEventListener("click", () => showChange(c));
    row.querySelector(".cc-undo")?.addEventListener("click", () => undoChange(c, row));
    row._change = c;
    box.appendChild(row);
  }
}

async function beforeText(c) { return api.historyGet(c.path, c.beforeVersion); }
async function showChange(c) {
  const before = await beforeText(c);
  let after = "";
  try { after = (await api.readText(c.path)).text; } catch {}
  showDiffDialog({
    title: `${basename(c.path)} — changes by Claude Code`,
    before, after, legend: ["Green: added by Claude Code", "Red: removed by Claude Code"],
    restoreLabel: c.status === "deleted" ? "Restore the file" : "Undo these changes",
    onRestore: () => undoChange(c, [...document.querySelectorAll(".cc-ch")].find((r) => r._change === c)),
  });
}
async function undoChange(c, row) {
  const tab = getTabs().find((t) => t.path && norm(t.path) === norm(c.path));
  if (tab?.dirty) return toast(`${basename(c.path)} has unsaved edits in the editor — save or close it first.`, "err", 5000);
  if (!c.backup) return toast("No saved copy of this file", "err");
  try {
    try { await api.ccRestore(c.path, c.backup, c.afterSha, false); }
    catch (e) {
      if (e.message !== "CHANGED_SINCE") throw e;
      const r = await ask({ title: "File changed since", text: `${basename(c.path)} was changed after Claude Code's answer. Undo anyway? What is there now is kept as a version.`, buttons: [{ label: "Cancel", value: null }, { label: "Undo anyway", value: "go", primary: true }] });
      if (!r) return;
      await api.ccRestore(c.path, c.backup, null, true);
    }
    await reloadFromDisk([c.path], true, "Undo Claude Code edit");
    if (c.status === "deleted") refreshTree();
    toast(`${basename(c.path)} restored`, "ok", 2500);
    if (row) { row.classList.add("undone"); row.querySelector(".cc-undo")?.remove(); }
  } catch (e) { toast(`Couldn't undo: ${e.message}`, "err"); }
}

// ---------------- setup: install, sign in ----------------
export async function signIn() {
  try { await api.ccLogin(); } catch (e) { return toast(e.message, "err"); }
  toast("Finish signing in in the window that opened (it uses your browser).", "", 7000);
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = await ccStatus(true);
    if (s.loggedIn) { toast("Claude Code is signed in", "ok", 3000); renderCCSettings(); return true; }
  }
  return false;
}

export async function installClaude(logEl) {
  const un = await listen("cc-install", (line) => { if (logEl) { logEl.hidden = false; logEl.textContent += line.replace(/\x1b\[[0-9;]*m/g, "") + "\n"; logEl.scrollTop = logEl.scrollHeight; } });
  try {
    await api.ccInstall();
    toast("Claude Code installed", "ok", 3000);
  } catch (e) { toast(e.message, "err", 8000); }
  finally { un?.(); }
  await ccStatus(true);
}

let ccChanged = null;
export async function renderCCSettings(changed) {
  if (changed) ccChanged = changed;
  const box = $("#cc-settings");
  if (!box) return;
  box.innerHTML = `<p class="note">Checking Claude Code…</p>`;
  const s = await ccStatus(true);
  const authLabel = s.loggedIn ? ({ "claude.ai": "your Claude plan", oauth_token: "a Claude token", api_key: "an API key", third_party: "a cloud provider" }[s.auth?.authMethod] || "signed in") : "not signed in";
  const who = s.auth?.email || s.auth?.account?.email || "";
  box.innerHTML = `
    <label class="check"><input type="checkbox" id="cc-enable" ${settings.ccEnabled ? "checked" : ""}> Use Claude Code (works with a Claude Pro or Max plan, no API key)</label>
    <label class="check"><input type="checkbox" id="cc-quota" ${settings.ccQuota !== false ? "checked" : ""}> Show plan usage in the AI panel (5-hour, weekly and per-model limits; costs no quota)</label>
    <div class="cc-status ${s.installed && s.loggedIn ? "ok" : ""}">
      ${!s.installed ? `<span>Claude Code isn't installed.</span><button type="button" class="primary small" id="cc-install">Install Claude Code</button>`
        : `<span>Claude Code ${esc((s.version || "").replace(/\s*\(.*\)/, ""))} — ${s.loggedIn ? "signed in with " : ""}<b>${esc(authLabel)}</b>${who ? ` (${esc(who)})` : ""}</span>
           ${s.loggedIn ? `<button type="button" class="small" id="cc-logout">Sign out</button>` : `<button type="button" class="primary small" id="cc-login">Sign in…</button>`}
           <button type="button" class="small" id="cc-refresh">Refresh</button>`}
    </div>
    <pre id="cc-install-log" class="cc-log" hidden></pre>
    <label>When Claude Code wants to change files or run commands
      <select id="cc-mode">${CC_MODES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
    <p class="note">Callio runs Anthropic's official Claude Code in your project folder with your own sign-in; Callio never sees your password or tokens. Usage counts toward your plan's limits (shared with claude.ai). Every file is saved as a version before each answer, and changed files are shown as diffs with Undo.
    ${s.installed && !s.gitBash ? " Optional: install <a href=\"#\" data-url=\"https://git-scm.com/download/win\">Git for Windows</a> so Claude Code can use its Bash tool (it uses PowerShell otherwise)." : ""}</p>`;
  box.querySelector("#cc-quota").onchange = (e) => { updateSettings({ ccQuota: e.target.checked }); import("./cc-quota.js").then((m) => m.refreshQuota(true)); };
  box.querySelector("#cc-enable").onchange = (e) => {
    updateSettings({ ccEnabled: e.target.checked, ...(e.target.checked && !settings.aiModel_chat ? { aiModel_chat: "claudecode|default" } : {}) });
    import("./ai.js").then((m) => { m.refreshModelSelect(); m.refreshRoleSelects(); });
    ccChanged?.();
    import("./cc-quota.js").then((m) => m.refreshQuota(true));
    if (e.target.checked) import("./cc-sessions.js").then((m) => m.initSessions());
  };
  import("./cc-sessions.js").then((m) => m.renderSessionSettings(box));
  import("./envs.js").then((m) => m.renderCCEnv(box)); // [wsl] where Claude Code runs
  box.querySelector("#cc-mode").value = settings.ccPermissionMode || "default";
  box.querySelector("#cc-mode").onchange = async (e) => {
    if (!(await confirmMode(e.target.value))) { e.target.value = settings.ccPermissionMode || "default"; return; }
    updateSettings({ ccPermissionMode: e.target.value }); import("./ai.js").then((m) => m.refreshModelSelect());
  };
  box.querySelector("#cc-install")?.addEventListener("click", async (e) => {
    e.target.disabled = true; e.target.textContent = "Installing…";
    await installClaude(box.querySelector("#cc-install-log"));
    renderCCSettings();
  });
  box.querySelector("#cc-login")?.addEventListener("click", () => signIn());
  box.querySelector("#cc-logout")?.addEventListener("click", async () => { await api.ccLogout().catch((e) => toast(e.message, "err")); renderCCSettings(); });
  box.querySelector("#cc-refresh")?.addEventListener("click", () => renderCCSettings());
}

/** First use from the chat: offer to install / sign in. Returns true when ready. */
export async function ensureReady() {
  let s = await ccStatus(true);
  if (!s.installed) {
    const r = await ask({ title: "Install Claude Code?", text: "Callio uses Anthropic's official Claude Code for this. It installs for your user only (about 1 minute) and then you sign in with your Claude account.", buttons: [{ label: "Cancel", value: null }, { label: "Install", value: "go", primary: true }] });
    if (!r) return false;
    toast("Installing Claude Code…", "", 60000);
    await installClaude(null);
    s = await ccStatus(true);
    if (!s.installed) return false;
  }
  if (!s.loggedIn) {
    const r = await ask({ title: "Sign in to Claude Code", text: "Sign in once with your Claude account (Pro or Max plan). A window opens and your browser asks you to confirm.", buttons: [{ label: "Cancel", value: null }, { label: "Sign in", value: "go", primary: true }] });
    if (!r) return false;
    return await signIn();
  }
  return true;
}

export function modeChip() {
  const m = CC_MODES.find((x) => x[0] === (settings.ccPermissionMode || "default")) || CC_MODES[0];
  return { icon: m[2], label: m[1] };
}
/** Full access runs commands without asking: say so once. */
async function confirmMode(mode) {
  if (mode !== "bypassPermissions" || settings.ccBypassOk) return true;
  const r = await ask({ title: "Full access for Claude Code?", text: "Claude Code will edit files and run commands in your project without asking you first (it still refuses a few dangerous actions). Every changed file still shows as a diff with Undo afterwards.\n\nTip: “Auto” mode is the safer choice — Claude Code reviews each action itself and blocks risky ones, without asking you.", buttons: [{ label: "Cancel", value: null }, { label: "Use full access", value: "ok", primary: true }] });
  if (r) updateSettings({ ccBypassOk: true });
  return !!r;
}
export async function cycleMode() {
  const i = CC_MODES.findIndex((x) => x[0] === (settings.ccPermissionMode || "default"));
  let next = CC_MODES[(i + 1) % CC_MODES.length];
  if (!(await confirmMode(next[0]))) next = CC_MODES[(i + 2) % CC_MODES.length];
  updateSettings({ ccPermissionMode: next[0] });
  toast(`Claude Code: ${next[1]}`, "", 1800);
}
