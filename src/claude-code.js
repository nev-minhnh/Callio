// Claude Code inside Callio's AI panel: runs the official `claude` tool headless in the project
// folder with the user's own Claude sign-in (Pro/Max plan), streams its work into the chat,
// asks permission questions in Callio, and shows every changed file as a diff with Undo.
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { unifiedMergeView } from "@codemirror/merge";
import { api, listen } from "./api.js";
import { settings, updateSettings, toast, ask, activeTab, getTabs, getLastCompile, compile, openPath, basename, dirname, folder, saveAll, reloadFromDisk, refreshTree } from "./main.js";
import { getSelectionInfo } from "./editor.js";
import { createStreamer } from "./stream.js";
import { showDiffDialog } from "./history.js";
import { onRpc, onRpcCancel, initRpc, SELF } from "./rpc.js";

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
const cards = new Map();

onRpc("permission", (params, rpc) => { permissionCard(rpc, params); return SELF; });
onRpc("editor_state", () => editorState());
onRpc("open_file", async (params) => { await openPath(params.path, params.line || undefined); return `Opened ${params.path}`; });
onRpc("compile", () => compileForClaude());
onRpcCancel((rpc) => { const c = cards.get(rpc); if (c) { c.classList.add("answered"); c.querySelector(".cc-perm-actions").innerHTML = "<small>No answer — declined</small>"; cards.delete(rpc); } });

function editorState() {
  const t = activeTab();
  const office = t && ["doc", "sheet", "pdf", "deck", "image"].includes(t.kind);
  const sel = office ? null : getSelectionInfo();
  const line = sel ? sel.doc.lineAt(sel.from).number : null;
  const errs = (getLastCompile()?.diagnostics || []).filter((d) => d.severity === "error").slice(0, 20);
  return {
    file: t?.path || null, line, kind: t?.kind || null,
    selection: sel && sel.to > sel.from ? sel.text.slice(0, 20000) : "",
    unsavedFiles: getTabs().filter((x) => x.dirty).map((x) => x.path || x.name),
    openFiles: getTabs().map((x) => x.path).filter(Boolean),
    compileErrors: errs.map((d) => ({ file: d.file, line: d.line, message: d.message })),
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
  const fmt = (x) => `${x.file ? x.file : ""}:${x.line || "?"}: ${x.message}`;
  return {
    ok: !!r.ok, engine: r.engine, pdf: r.pdf,
    errors: d.filter((x) => x.severity === "error").slice(0, 40).map(fmt),
    warnings: d.filter((x) => x.severity === "warning").slice(0, 40).map(fmt),
    warningCount: d.filter((x) => x.severity === "warning").length,
  };
}

const EDIT_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];
function toolTitle(name, input = {}) {
  const f = input.file_path || input.notebook_path || input.path;
  switch (name) {
    case "Edit": case "MultiEdit": return ["✏️", `Edit ${basename(f)}`];
    case "Write": return ["📝", `Write ${basename(f)}`];
    case "Read": return ["📖", `Read ${basename(f)}`];
    case "Glob": return ["🗂", `Find files ${input.pattern || ""}`];
    case "Grep": return ["🔎", `Search “${input.pattern || ""}”`];
    case "Bash": case "PowerShell": return ["💻", `Run: ${input.description || input.command || ""}`];
    case "WebSearch": return ["🌐", `Web search “${input.query || ""}”`];
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

async function permissionCard(rpc, { toolName, input }) {
  // "Allow all edits" earlier in this answer — only for files inside the project folder
  const target = input.file_path || input.notebook_path || "";
  const inProject = !!target && !!activeRun?.cwd && norm(target).startsWith(norm(activeRun.cwd).replace(/\/?$/, "/")) && !/(^|\/)\.\.(\/|$)/.test(norm(target));
  if (activeRun?.autoEdits && EDIT_TOOLS.includes(toolName) && inProject) return api.ccReply(rpc, { allow: true });
  const host = activeRun?.el.querySelector(".ai-tools") || $("#ai-messages");
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
    card.classList.add("answered");
    card.querySelector(".cc-perm-actions").innerHTML = `<small>${esc(label)}</small>`;
    card.querySelector(".cc-perm-body").hidden = true;
    api.ccReply(rpc, value);
  };
  card.querySelector(".cc-allow").onclick = () => done({ allow: true }, "Allowed");
  card.querySelector(".cc-allow-all")?.addEventListener("click", () => { if (activeRun) activeRun.autoEdits = true; done({ allow: true }, "Allowed (and further edits in this answer)"); });
  card.querySelector(".cc-deny").onclick = () => done({ allow: false, message: card.querySelector(".cc-deny-why").value.trim() }, "Denied");
  card.querySelector(".cc-deny-why").addEventListener("keydown", (e) => { if (e.key === "Enter") card.querySelector(".cc-deny").click(); });
  cards.set(rpc, card);
  host.appendChild(card);
  $("#ai-messages").scrollTop = $("#ai-messages").scrollHeight;
  card.querySelector(".cc-allow").focus({ preventScroll: true });
  // bring the window's attention to the question
  if (document.hidden) toast("Claude Code is waiting for your answer", "", 5000);
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

function contextPreamble(ctx) {
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

const SYSTEM = `You are working inside Callio, the LaTeX/Markdown editor the author is using for academic writing, on their own project (the working directory).
- Edit files directly with your tools. Callio saves a version of every file before your turn and shows the author a diff with Undo afterwards.
- After changing .tex or .bib files, use the mcp__callio__compile tool to compile in Callio and fix any errors you caused.
- Use mcp__callio__editor_state when you need to know what the author is looking at.
- To read a PDF use mcp__callio__read_pdf (its text, by page) and mcp__callio__view_pdf_page (a page as an image, for figures and tables). Don't use pdftoppm, Python or other tools for PDFs.
- The author keeps a paper library in Callio: search it with mcp__callio__search_library, read papers with mcp__callio__read_library_paper, and take BibTeX from mcp__callio__library_bibtex. Prefer those papers and keys when citing.
- Never invent references, DOIs, quotes, numbers or results. Only cite BibTeX keys that exist in the project's .bib files; if a new reference is needed, find it on the web, verify it, and say clearly when something is unverified.
- Preserve LaTeX commands, labels, citations and math unless asked to change them. Keep answers concise.`;

/**
 * Run one Claude Code turn in the chat. `ui` gives the chat helpers from ai.js.
 * Returns the final text (or throws).
 */
export async function runTurn(text, ui) {
  const st = await ccStatus();
  if (!st.installed) throw new Error("CLAUDE_MISSING");
  const cwd = projectDir();
  if (!cwd) throw new Error("Open a project folder or a saved file first — Claude Code works inside a folder.");
  await ensureListeners();
  // Claude Code reads files from disk: save open edits first (each save keeps a version)
  await saveAll((t) => !!t.path && norm(t.path).startsWith(norm(cwd)));

  const mv = settings.aiModel_chat || "claudecode|default";
  const model = mv.split("|")[1];
  const id = `cc-${Date.now()}`;
  const el = ui.addMsg("assistant cc", `<div class="cc-badge">Claude Code${model !== "default" ? ` · ${esc(model)}` : ""}${settings.aiEffort && !/haiku/.test(model) ? ` · effort ${esc({ xhigh: "extra" }[settings.aiEffort] || settings.aiEffort)}` : ""} · ${esc(basename(cwd))}</div><div class="ai-tools"></div><div class="ai-body markdown-body"><span class="ai-typing">●●●</span></div><div class="cc-changes"></div>`);
  const toolsEl = el.querySelector(".ai-tools"), body = el.querySelector(".ai-body"), changesEl = el.querySelector(".cc-changes");
  activeRun = { el, autoEdits: false, id, cwd };
  ui.setStop(() => api.ccCancel(id));

  let full = "", streamed = false;
  const think = ui.thinkBox(el);
  const toolEls = new Map(), toolFiles = new Map(), liveTags = new Map();
  const stream = createStreamer(body, ui.renderMd, document.querySelector("#ai-messages"));
  const render = () => stream.set(full);
  runHandlers.set(id, (ev) => {
    if (ev.t === "text") { think.answer(); streamed = true; full += ev.text; render(); }
    else if (ev.t === "thinking") think.add(ev.text || "");
    else if (ev.t === "message_start") { if (full && !full.endsWith("\n\n")) full += "\n\n"; }
    else if (ev.t === "assistant") {
      if (!streamed && ev.text && !ev.sub) { full += (full ? "\n\n" : "") + ev.text; render(); }
      for (const tl of ev.tools || []) {
        const [ico, title] = toolTitle(tl.name, tl.input);
        const chip = document.createElement("div");
        chip.className = "tool-chip" + (ev.sub ? " sub" : "");
        chip.innerHTML = `<span class="tc-state">⏳</span> ${ico} <span class="tc-title"></span>`;
        chip.querySelector(".tc-title").textContent = title;
        chip.title = JSON.stringify(tl.input, null, 1).slice(0, 1500);
        toolsEl.appendChild(chip);
        toolEls.set(tl.id, chip);
        const f = tl.input?.file_path || tl.input?.notebook_path;
        if (f && EDIT_TOOLS.includes(tl.name)) toolFiles.set(tl.id, f);
        const seen = f || tl.input?.path;
        if (seen && (EDIT_TOOLS.includes(tl.name) || ["Read", "mcp__callio__read_pdf", "mcp__callio__view_pdf_page", "mcp__callio__open_file"].includes(tl.name))) { ui.fileTag?.(seen, EDIT_TOOLS.includes(tl.name) ? "edit" : "read", true); liveTags.set(tl.id, seen); }
      }
      ui.scroll();
    } else if (ev.t === "tool_results") {
      for (const r of ev.results) {
        if (liveTags.has(r.id)) { const p = liveTags.get(r.id); liveTags.delete(r.id); ui.fileTag?.(p, toolFiles.has(r.id) ? "edit" : "read", false); }
        const chip = toolEls.get(r.id);
        if (chip) {
          chip.querySelector(".tc-state").textContent = r.isError ? "✗" : "✓";
          if (r.isError) { chip.classList.add("err"); chip.title = r.text; }
        }
        // show Claude's edit in the open tab right away
        if (!r.isError && toolFiles.has(r.id)) reloadFromDisk([toolFiles.get(r.id)], false, "Claude Code edit");
      }
    } else if (ev.t === "init") {
      const callio = (ev.mcp || []).find((s) => s.name === "callio");
      if (callio && callio.status && callio.status !== "connected") toolsEl.insertAdjacentHTML("beforeend", `<div class="tool-chip err">Callio tools unavailable (${esc(callio.status)})</div>`);
      // auto mode needs a recent Claude Code and model: otherwise Claude Code falls back to asking
      const asked = settings.ccPermissionMode || "default";
      if (asked === "auto" && ev.permissionMode && ev.permissionMode !== "auto") toolsEl.insertAdjacentHTML("beforeend", `<div class="tool-chip warn" title="Auto mode needs Claude Code 2.1.233+ on Windows and a supported model (e.g. Opus 4.6+, Sonnet 4.6+). Update Claude Code, pick another model, or choose Full access.">⚡ Auto mode isn't available here — Claude Code will ask instead</div>`);
    }
  });

  const skills = await ui.skillsForClaude();
  const label = (ui.shown || text).replace(/\s+/g, " ").slice(0, 50);
  let res;
  try {
    res = await api.ccRun({
      id, prompt: contextPreamble(ui.ctx) + text, sessionId: ui.session.id || null, model,
      cwd, permissionMode: settings.ccPermissionMode || "default", systemAppend: SYSTEM + skills + (ui.memory || ""), label,
      effort: /haiku/.test(model) ? null : (settings.aiEffort || null), thinking: settings.aiThinking !== false,
    });
  } finally {
    runHandlers.delete(id);
    activeRun = null;
    for (const [rpc, c] of cards) if (el.contains(c)) { c.remove(); cards.delete(rpc); }
  }
  ui.result = res;
  if (res.sessionId) ui.session.id = res.sessionId;
  if (!full && res.result) full = res.result;
  if (res.cancelled) full += (full ? "\n\n" : "") + "_Stopped._";
  if (full) { stream.set(full); await stream.finish(); }
  stream.stop();
  await (ui.settleMd || ui.renderMd)(body, full || (res.isError ? "" : "_(done)_"), stream.stick);
  think.done();
  if (res.isError && !res.cancelled) body.insertAdjacentHTML("beforeend", errorHtml(res.error));
  renderChanges(changesEl, res.changed || [], cwd);
  if (res.snapshotPartial && (res.changed || []).length === 0) changesEl.hidden = true;
  if (res.snapshotPartial) changesEl.insertAdjacentHTML("beforeend", `<div class="note">This project is large: Callio could only keep copies of part of it before this answer.</div>`), (changesEl.hidden = false);
  if ((res.changed || []).length) {
    await reloadFromDisk(res.changed.map((c) => c.path), false, "Claude Code edit");
    if (res.changed.some((c) => c.status !== "modified")) refreshTree();
  }
  const errBtn = body.querySelector(".cc-signin");
  if (errBtn) errBtn.onclick = () => signIn();
  return full;
}

function errorHtml(msg = "") {
  const auth = /log ?in|sign ?in|auth|credential|401|api key|oauth|subscription/i.test(msg);
  const limit = /limit|quota|429|usage/i.test(msg);
  return `<div class="ai-error">${esc(msg || "Claude Code stopped with an error.")}${auth ? `<div><button class="small cc-signin">Sign in to Claude Code</button></div>` : ""}${limit ? `<div class="note">Claude Code shares your plan's usage limits with claude.ai.</div>` : ""}</div>`;
}

function renderChanges(box, changed, cwd) {
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

export async function renderCCSettings() {
  const box = $("#cc-settings");
  if (!box) return;
  box.innerHTML = `<p class="note">Checking Claude Code…</p>`;
  const s = await ccStatus(true);
  const authLabel = s.loggedIn ? ({ "claude.ai": "your Claude plan", oauth_token: "a Claude token", api_key: "an API key", third_party: "a cloud provider" }[s.auth?.authMethod] || "signed in") : "not signed in";
  const who = s.auth?.email || s.auth?.account?.email || "";
  box.innerHTML = `
    <label class="check"><input type="checkbox" id="cc-enable" ${settings.ccEnabled ? "checked" : ""}> Use Claude Code in the AI panel (works with a Claude Pro or Max plan, no API key)</label>
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
  box.querySelector("#cc-enable").onchange = (e) => {
    updateSettings({ ccEnabled: e.target.checked, ...(e.target.checked && !settings.aiModel_chat ? { aiModel_chat: "claudecode|default" } : {}) });
    import("./ai.js").then((m) => { m.refreshModelSelect(); m.refreshRoleSelects(); });
  };
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
