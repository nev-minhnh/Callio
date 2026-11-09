// AI assistant: providers & models, chat panel, selection actions with inline diffs,
// Fix-with-AI for compile errors, skills, citation checks.
import { createStreamer } from "./stream.js";
import { api, call, listen } from "./api.js";
import { settings, updateSettings, toast, status, ask, activeTab, getLastCompile, openPath, basename, dirname, folder, compile } from "./main.js";
import { getView, getSelectionInfo, startReview, endReview, isReviewing, setReviewHooks, setReviewLabel, project, gotoLine } from "./editor.js";
import { record as historyRecord } from "./history.js";
import { ic } from "./icons.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---------------- providers ----------------
export const PRESETS = [
  { id: "anthropic", name: "Claude (Anthropic)", kind: "anthropic", baseUrl: "https://api.anthropic.com", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", name: "ChatGPT (OpenAI)", kind: "openai", baseUrl: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "gemini", name: "Gemini (Google)", kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "perplexity", name: "Perplexity", kind: "openai", baseUrl: "https://api.perplexity.ai", noTools: true, keyUrl: "https://www.perplexity.ai/account/api/keys" },
  { id: "xai", name: "Grok (xAI)", kind: "openai", baseUrl: "https://api.x.ai/v1", keyUrl: "https://console.x.ai" },
  { id: "llamacpp", name: "llama.cpp (your server)", kind: "openai", baseUrl: "http://localhost:8080/v1", optionalKey: true },
  { id: "custom", name: "Custom (OpenAI-compatible)", kind: "openai", baseUrl: "", optionalKey: true },
];
const provCfg = (id) => ({ enabled: false, baseUrl: "", models: [], ...(settings.aiProviders?.[id] || {}) });
export function providerFor(id) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return null;
  const c = provCfg(id);
  return { id, kind: p.kind, baseUrl: c.baseUrl || p.baseUrl, noTools: !!p.noTools };
}
function setProv(id, patch) {
  updateSettings({ aiProviders: { ...(settings.aiProviders || {}), [id]: { ...provCfg(id), ...patch } } });
}
const enabledProviders = () => PRESETS.filter((p) => provCfg(p.id).enabled);
/** "provider|model" for a role ("chat" | "edit" | "inline"), falling back to chat, then the first model. */
export function modelFor(role) {
  const own = settings[`aiModel_${role}`];
  const v = own || settings.aiModel_chat;
  // Claude Code (the user's Claude plan) works for every AI function. Ghost-text completion
  // only uses it when picked for that role explicitly (it starts a process per suggestion).
  if (v?.startsWith("claudecode|") && settings.ccEnabled && (role !== "inline" || own)) return v;
  if (v && enabledProviders().some((p) => v.startsWith(p.id + "|"))) return v;
  for (const p of enabledProviders()) { const m = provCfg(p.id).models?.[0]; if (m) return `${p.id}|${m}`; }
  if (settings.ccEnabled && role !== "inline") return isCCModel(settings.aiModel_chat) ? settings.aiModel_chat : "claudecode|default";
  return null;
}
const isCCModel = (v) => !!v && v.startsWith("claudecode|");
/** Claude models Claude Code can run (full ids, newest first). */
export const CC_MODELS = [
  ["default", "Default"],
  ["claude-opus-5-5", "Opus 5.5"], ["claude-fable-5-1", "Fable 5.1"], ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-haiku-5-5", "Haiku 5.5"],
  ["claude-fable-5", "Fable 5"], ["claude-opus-5", "Opus 5"], ["claude-sonnet-5", "Sonnet 5"],
  ["claude-opus-4-8", "Opus 4.8"], ["claude-opus-4-7", "Opus 4.7"], ["claude-opus-4-6", "Opus 4.6"], ["claude-sonnet-4-6", "Sonnet 4.6"],
  ["claude-opus-4-5", "Opus 4.5"], ["claude-sonnet-4-5", "Sonnet 4.5"], ["claude-haiku-4-5", "Haiku 4.5"],
  ["claude-opus-4-1", "Opus 4.1"], ["claude-opus-4-0", "Opus 4"], ["claude-sonnet-4-0", "Sonnet 4"],
];
const CC_ALIAS = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", fable: "claude-fable-5-1" };
export const isClaudeModel = (v) => isCCModel(v) || (!!v && v.startsWith("anthropic|"));

/** Options for every enabled provider (+ Claude Code when on) into a <select>. */
export function fillModelOptions(sel, { claudeCode = false } = {}) {
  if (claudeCode && settings.ccEnabled) {
    const g = document.createElement("optgroup");
    g.label = "Claude Code (your Claude plan)";
    const custom = (settings.ccCustomModels || []).map((m) => [m, m]);
    for (const [m, l] of [...CC_MODELS, ...custom]) {
      const o = document.createElement("option"); o.value = `claudecode|${m}`; o.textContent = `Claude Code · ${l}`; g.appendChild(o);
    }
    const o = document.createElement("option"); o.value = "claudecode|__other"; o.textContent = "Claude Code · Other model id…"; g.appendChild(o);
    sel.appendChild(g);
  }
  for (const p of enabledProviders()) {
    const g = document.createElement("optgroup");
    g.label = p.name;
    for (const m of provCfg(p.id).models || []) {
      const o = document.createElement("option");
      o.value = `${p.id}|${m}`; o.textContent = m;
      g.appendChild(o);
    }
    if (g.childElementCount) sel.appendChild(g);
  }
}
/** Ask for a Claude Code model id that isn't listed. Returns "claudecode|id" or null. */
async function askCustomCCModel() {
  const id = (await ask({ title: "Claude Code model", text: "Enter a model id Claude Code accepts, e.g. claude-opus-4-5 (or an alias such as opus).", input: "" }))?.trim();
  if (!id) return null;
  if (!CC_MODELS.some(([m]) => m === id)) updateSettings({ ccCustomModels: [...new Set([...(settings.ccCustomModels || []), id])] });
  return `claudecode|${id}`;
}
const splitModel = (v) => { const i = v.indexOf("|"); return [v.slice(0, i), v.slice(i + 1)]; };

// ---------------- streaming requests ----------------
const handlers = new Map();
let listening = false;
async function ensureListener() {
  if (listening) return;
  listening = true;
  await listen("ai-event", (e) => handlers.get(e.id)?.(e));
}
let seq = 0;
/**
 * Run a request; `on(event)` receives streamed events. Resolves with the full text.
 * role: which model setting to use. opts: {system, messages, tools, web, maxTokens, temperature}
 */
export async function runAI(role, opts, on = () => {}) {
  const mv = opts.model || modelFor(role);
  if (!mv) throw new Error("NO_MODEL");
  const [pid, model] = splitModel(mv);
  const provider = pid === "claudecode" ? { id: "claudecode", kind: "claudecode", baseUrl: "", noTools: true } : providerFor(pid);
  const id = `${role}-${Date.now()}-${++seq}`;
  if (opts.idRef) opts.idRef.id = id;
  handlers.set(id, on);
  await ensureListener();
  const t = activeTab();
  try {
    return await api.aiChat({
      id, provider, model, system: opts.system || "", messages: opts.messages,
      tools: pid !== "claudecode" && !!opts.tools && settings.aiTools !== false, web: pid !== "claudecode" && !!opts.web,
      maxTokens: opts.maxTokens || null, temperature: opts.temperature ?? null,
      projectPath: folder || t?.path || null,
      searchBackend: searchBackendFor(), searchUrl: settings.aiSearchUrl || "",
      skills: opts.tools && settings.aiTools !== false ? skillRefs() : [],
      effort: opts.effort !== undefined ? opts.effort || null : role === "chat" ? (settings.aiEffort || null) : null,
      thinking: opts.thinking !== undefined ? !!opts.thinking : role === "chat" && settings.aiThinking !== false,
    }, id);
  } finally { handlers.delete(id); }
}
export const cancelAI = (id) => api.aiCancel(id);

async function needModel() {
  const r = await ask({ title: "Set up AI", text: "Turn on Claude Code (your Claude Pro/Max plan — no API key) or add an API key (Claude, ChatGPT, Gemini, Perplexity, Grok) or your llama.cpp server address in AI settings.", buttons: [{ label: "Later", value: null }, { label: "Open AI settings", value: "go", primary: true }] });
  if (r) openAISettings();
}
function openAISettings() { import("./settings.js").then((m) => m.openSettings("ai")); }

// ---------------- skills ----------------
let skillList = [];
const skillText = new Map();
export async function scanSkills() {
  try { skillList = await api.skillsScan(settings.skillFolders || [], settings.skillUseOwn !== false); } catch { skillList = []; }
  updateSkillChip();
  import("./ai-inline.js").then((m) => m.refreshAvoidWords(skillList.filter(isSkillOn)));
  return skillList;
}
const isSkillOn = (s) => !(settings.skillsDisabled || []).includes(s.id);
export const skills = () => skillList;
export async function skillContent(s) {
  if (!skillText.has(s.id)) { try { skillText.set(s.id, await api.skillsRead(s.path)); } catch { skillText.set(s.id, ""); } }
  return skillText.get(s.id);
}
/**
 * Writing guides (.md) go into the prompt in full. Installed skills (SKILL.md folders and
 * packages) are listed by name and description only, and the model loads one with the
 * `use_skill` tool when it needs it — so many installed skills don't make every request big.
 * `full` puts everything in full (for requests without tools, and for Claude Code).
 */
async function skillsPrompt(on = skillList.filter(isSkillOn), full = false) {
  if (!on.length) return "";
  let out = "\n\n# The author's writing guides and skills (follow them)\n";
  let budget = 150_000;
  const lazy = full ? [] : on.filter((s) => s.kind !== "guide");
  for (const s of on) {
    if (lazy.includes(s)) continue;
    const t = await skillContent(s);
    if (!t) continue;
    const part = `\n## ${s.name}\n${t.slice(0, Math.max(0, budget))}\n`;
    budget -= part.length;
    out += part;
    if (budget <= 0) { out += "\n[further guides omitted — too long]\n"; break; }
  }
  if (lazy.length) {
    out += "\n## Installed skills (call use_skill with the name to load one before a task it covers)\n";
    for (const s of lazy) out += `- ${s.name}: ${(s.description || "").replace(/\s+/g, " ").slice(0, 300)}\n`;
  }
  return out;
}
const skillRefs = () => skillList.filter(isSkillOn).filter((s) => s.kind !== "guide").map((s) => ({ name: s.name, path: s.path }));
/** Skills for Claude Code: the active ones, minus those already installed into Claude Code's own skills folder (it loads those itself). */
async function skillsForClaude() {
  if (!skillList.length) await scanSkills();
  let inst = [];
  try { inst = await api.skillsInstalled(); } catch {}
  const own = (await call("skills_own_dir")).replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
  const shared = new Set(inst.filter((i) => i.claudeCode).map((i) => `${own}/${i.folder.toLowerCase()}`));
  const on = skillList.filter(isSkillOn).filter((s) => !shared.has(s.path.replace(/\\/g, "/").toLowerCase().replace(/\/(skill\.md)?$/, "")));
  return skillsPrompt(on, true);
}
function updateSkillChip() {
  const n = skillList.filter(isSkillOn).length;
  const c = $("#ai-skill-chip");
  if (c) { c.textContent = n ? `🎓 ${n} skill${n > 1 ? "s" : ""}` : "No skills"; c.classList.toggle("off", !n); }
}
function openSkillsDialog() {
  const box = $("#skills-list");
  box.innerHTML = skillList.length ? "" : `<p class="empty-note">No skills found. Add folders in Settings → AI.</p>`;
  for (const s of skillList) {
    const row = document.createElement("label");
    row.className = "skill-row";
    row.innerHTML = `<input type="checkbox"><span><b></b><small></small></span>`;
    row.querySelector("input").checked = isSkillOn(s);
    row.querySelector("b").textContent = s.name;
    row.querySelector("small").textContent = `${s.source} · ${s.description || s.kind}`;
    row.querySelector("input").onchange = (e) => {
      const off = new Set(settings.skillsDisabled || []);
      e.target.checked ? off.delete(s.id) : off.add(s.id);
      updateSettings({ skillsDisabled: [...off] });
      updateSkillChip();
      import("./ai-inline.js").then((m) => m.refreshAvoidWords(skillList.filter(isSkillOn)));
    };
    box.appendChild(row);
  }
  $("#dlg-skills").showModal();
}

// ---------------- prompts ----------------
function baseSystem() {
  const t = activeTab();
  const lang = t?.kind === "tex" || t?.kind === "bib" ? "LaTeX" : t?.kind === "md" ? "Markdown" : "text";
  const cites = project.citations.slice(0, 400);
  return `You are the writing assistant inside Callio, a ${lang} editor used for academic writing. Be precise and concise.
When you propose changes to the document, put the complete replacement text in one fenced code block (\`\`\`latex or \`\`\`markdown) so it can be applied as a reviewed diff.
Never invent references, DOIs, quotes, page numbers or results. Only cite BibTeX keys that exist in the project${cites.length ? ` (available keys: ${cites.join(", ")})` : ""}. If a new reference is needed, find it with search_papers, confirm it with verify_citation and give BibTeX from get_bibtex — or clearly say it is unverified.
Preserve LaTeX commands, labels, citations and math unless asked to change them.
Word documents, spreadsheets, presentations, pictures and PDFs: read them with office_read and change them with word_edit, sheet_edit, deck_edit, image_edit or pdf_tool — each change is one step the author can undo.`;
}

function excerptAround(doc, pos, max = 80_000) {
  const text = doc.toString();
  if (text.length <= max) return { text, partial: false };
  const half = max / 2;
  const a = Math.max(0, pos - half), b = Math.min(text.length, pos + half);
  return { text: (a > 0 ? "[…]\n" : "") + text.slice(a, b) + (b < text.length ? "\n[…]" : ""), partial: true };
}

// ---------------- chat panel ----------------
const newSid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const chat = { history: [], busyId: null, ctx: { file: true, sel: true, log: true }, attached: [], cc: { id: null }, ccReady: false, stop: null, mem: `s${Date.now().toString(36)}`, sid: newSid(), title: "", created: Date.now(), project: null };

// ---------------- files the AI is reading or editing (tags above the input) ----------------
const fileTags = new Map(); // norm path → { path, mode, live }
const nrm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
/** `mode`: "read" | "edit"; `live`: the tool is running now. Called by the chat and Claude Code. */
export function fileTag(path, mode = "read", live = true) {
  if (!path) return;
  let p = String(path);
  if (!/^([A-Za-z]:)?[\\/]/.test(p) && folder) p = folder.replace(/[\\/]$/, "") + "/" + p;
  const k = nrm(p);
  const cur = fileTags.get(k);
  fileTags.set(k, { path: p, mode: cur?.mode === "edit" ? "edit" : mode, live });
  renderFileTags();
}
export function fileTagsDone() { for (const v of fileTags.values()) v.live = false; renderFileTags(); }
function clearFileTags() { fileTags.clear(); renderFileTags(); }
function renderFileTags() {
  const box = $("#ai-files"); if (!box) return;
  box.hidden = !fileTags.size;
  box.innerHTML = fileTags.size ? `<span class="af-label">${[...fileTags.values()].some((v) => v.live) ? "Working on" : "Used"}</span>` + [...fileTags.values()].map((v) =>
    `<button class="af-tag ${v.mode}${v.live ? " live" : ""}" data-path="${esc(v.path)}" title="${esc(v.path)}${v.mode === "edit" ? " — being edited" : " — being read"}">${ic(v.mode === "edit" ? "pen" : "eye")}<span>${esc(v.path.split(/[\\/]/).pop())}</span></button>`).join("") : "";
  // the editor tabs of those files show it too
  for (const el of document.querySelectorAll("#tabs .tab")) {
    const live = [...fileTags.values()].find((v) => v.live && el.title && nrm(el.title) === nrm(v.path));
    el.classList.toggle("ai-live", !!live);
  }
}

// ---------------- conversations, saved per project folder ----------------
const sessProject = () => folder || "";
const sessWhen = (t) => new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
async function saveSession() {
  if (!chat.history.length) return;
  if (chat.project === null) chat.project = sessProject();
  if (!chat.title) {
    const first = chat.history.find((m) => m.role === "user")?.content || "";
    chat.title = String(first).replace(/\s+/g, " ").trim().slice(0, 70) || "Conversation";
  }
  const session = { v: 1, title: chat.title, created: chat.created, updated: Date.now(), model: modelFor("chat") || "", ccSession: chat.cc.id || "", mem: chat.mem, history: chat.history, summary: chat.summary || "", summaryUpTo: chat.summaryUpTo || 0 };
  try { await call("sess_put", { project: chat.project, id: chat.sid, session }); } catch (e) { console.warn("session save", e); }
  renderSessBar();
}
function renderSessBar() {
  const t = $("#ai-sess-title"); if (!t) return;
  t.textContent = chat.title || "New chat";
  const p = chat.project ?? sessProject();
  $("#ai-sess-proj").textContent = p ? basename(p) : "No folder";
  $("#ai-sess-proj").title = p ? `Conversations are saved with this folder: ${p}` : "Open a folder to keep conversations with that project";
}
async function listSessions(project = chat.project ?? sessProject()) {
  try { return await call("sess_list", { project }); } catch { return []; }
}
async function loadSession(id, project = chat.project ?? sessProject()) {
  if (chat.busyId) return toast("Wait for the current answer to finish.", "", 2500);
  let s;
  try { s = await call("sess_get", { project, id }); } catch (e) { return toast(e.message, "err"); }
  closeSessMenu();
  chat.sid = id; chat.project = project; chat.title = s.title || ""; chat.created = s.created || Date.now();
  chat.history = Array.isArray(s.history) ? s.history.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") : [];
  chat.summary = s.summary || ""; chat.summaryUpTo = s.summaryUpTo || 0;
  chat.mem = s.mem || chat.mem;
  // Claude Code keeps its own transcript: resume it when the chat model is Claude Code
  chat.cc = { id: s.ccSession && isCCModel(modelFor("chat")) ? s.ccSession : null };
  const box = $("#ai-messages");
  box.innerHTML = "";
  for (const m of chat.history) {
    if (m.role === "user") addMsg("user", esc(m.content).replace(/\n/g, "<br>"));
    else { const el = addMsg("assistant", `<div class="ai-body markdown-body"></div>`); await renderMd(el.querySelector(".ai-body"), m.content || "_(no answer)_"); }
  }
  const note = document.createElement("div");
  note.className = "ai-restored note";
  note.textContent = `Saved conversation · last used ${sessWhen(s.updated || s.created)}${s.ccSession ? (chat.cc.id ? " · Claude Code continues it" : " · switch the model to Claude Code to continue its session") : ""}`;
  box.prepend(note);
  box.scrollTop = box.scrollHeight;
  renderSessBar();
}
function closeSessMenu() { const m = $("#ai-sess-menu"); if (m) m.hidden = true; }
async function openSessMenu() {
  const menu = $("#ai-sess-menu");
  if (!menu.hidden) return closeSessMenu();
  const project = chat.project ?? sessProject();
  const list = await listSessions(project);
  menu.innerHTML = `<div class="sess-head">${esc(project ? basename(project) : "No folder")} <small>${list.length} conversation${list.length === 1 ? "" : "s"}</small></div>`
    + `<button class="sess-new">＋ New chat</button>`
    + (list.length ? list.map((x) => `<div class="sess-row${x.id === chat.sid ? " on" : ""}" data-id="${esc(x.id)}"><div class="sess-main"><div class="sess-title">${esc(x.title || "Conversation")}</div><small>${esc(sessWhen(x.updated || x.created))} · ${Math.ceil(x.count / 2)} message${x.count > 2 ? "s" : ""}</small></div><button class="icon small sess-ren" title="Rename">${ic("pen")}</button><button class="icon small sess-del" title="Delete">${ic("trash")}</button></div>`).join("") : `<p class="note">No saved conversations in this folder yet.</p>`);
  menu.hidden = false;
  menu.onclick = async (e) => {
    if (e.target.closest(".sess-new")) { closeSessMenu(); return newChat(); }
    const row = e.target.closest(".sess-row"); if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest(".sess-ren")) {
      const cur = list.find((x) => x.id === id);
      const name = await ask({ title: "Rename conversation", input: cur?.title || "" });
      if (!name?.trim()) return;
      if (id === chat.sid) { chat.title = name.trim().slice(0, 120); await saveSession(); }
      else { try { const s = await call("sess_get", { project, id }); s.title = name.trim().slice(0, 120); await call("sess_put", { project, id, session: s }); } catch (er) { toast(er.message, "err"); } }
      menu.hidden = true; return openSessMenu();
    }
    if (e.target.closest(".sess-del")) {
      if (!(await ask({ title: "Delete this conversation?", text: "It's removed from this folder's saved conversations. (What the project memory learned from it stays — clear that in Project memory.)", buttons: [{ label: "Cancel", value: null }, { label: "Delete", value: "y", primary: true }] }))) return;
      await call("sess_delete", { project, id }).catch((er) => toast(er.message, "err"));
      if (id === chat.sid) newChat(true);
      menu.hidden = true; return openSessMenu();
    }
    loadSession(id, project);
  };
}
/** The open folder changed: conversations belong to the folder, so start fresh there. */
function onProjectChanged() {
  const p = sessProject();
  if (chat.project === p || chat.busyId) return;
  if (!chat.history.length) { chat.project = p; renderSessBar(); return newChat(true); }
  newChat(true);
}

// ---------------- project memory (recalled with zero model calls) ----------------
const memOn = () => settings.aiMemory !== false;
function memProject() { const t = activeTab(); return folder || (t?.path ? dirname(t.path) : ""); }
async function memRecall(query, before = null) {
  const project = memProject();
  if (!memOn() || !project) return null;
  try { return await call("mem_recall", { project, query, session: chat.mem, budget: 6000, before }); } catch { return null; }
}
/** Keep a turn — under the project and conversation it was asked in (captured at send time). */
function memRecord(entries, project, session) {
  if (!memOn() || !project) return;
  call("mem_record", { project, session, entries }).catch(() => {});
}
/** Skills used in this project before, that aren't active now: their text, so they apply again. */
async function rememberedSkills(names) {
  if (!names?.length) return "";
  if (!skillList.length) await scanSkills();
  const want = skillList.filter((s) => names.includes(slug(s.name)) && !isSkillOn(s));
  return want.length ? (await skillsPrompt(want, true)).replace("# The author's writing guides and skills (follow them)", "# Skills the author used in this project before (follow them)") : "";
}

export function toggleAIPanel(force) {
  const panel = $("#ai-panel");
  const show = force ?? (panel.hidden || panel.classList.contains("out"));
  clearTimeout(panel._t);
  panel.classList.remove("in", "out");
  if (show) { const was = panel.hidden; panel.hidden = false; $("#split-ai").hidden = false; if (was) panel.classList.add("in"); }
  else if (!panel.hidden) {
    // slide out, then give the room back
    panel.classList.add("out");
    panel._t = setTimeout(() => { panel.classList.remove("out"); panel.hidden = true; $("#split-ai").hidden = true; }, 150);
  }
  $("#btn-ai").classList.toggle("on", show);
  if (show) { refreshModelSelect(); renderContext(); $("#ai-text").focus(); if (!skillList.length) scanSkills(); offerContinue(); }
  if (show !== !!settings.aiPanel) updateSettings({ aiPanel: show });
}

export function refreshModelSelect() {
  const sel = $("#ai-model");
  sel.innerHTML = "";
  // older settings used aliases (opus, sonnet…): show them as the model they mean today
  const cur = settings.aiModel_chat || "";
  if (isCCModel(cur) && CC_ALIAS[cur.slice(11)]) settings.aiModel_chat = `claudecode|${CC_ALIAS[cur.slice(11)]}`;
  fillModelOptions(sel, { claudeCode: true });
  if (!sel.childElementCount) { const o = document.createElement("option"); o.textContent = "Set up a model…"; o.value = ""; sel.appendChild(o); }
  sel.value = modelFor("chat") || "";
  const cc = isCCModel(sel.value);
  const eff = $("#ai-effort");
  eff.hidden = !isClaudeModel(sel.value) || /haiku/.test(sel.value);
  eff.value = settings.aiEffort || "";
  $("#ai-web").classList.toggle("on", settings.aiWeb !== false);
  $("#ai-web").hidden = false;
  $("#ai-web").title = cc ? "Let Claude Code use the internet (search and read pages)" : $("#ai-web").title;
  refreshEngineChip();
  const mode = $("#ai-mode");
  mode.hidden = !cc;
  if (cc) import("./claude-code.js").then((m) => { const c = m.modeChip(); mode.textContent = c.icon; mode.title = `Claude Code: ${c.label} (click to change)`; });
}

// ---- search engine for the chat (toolbar: globe ▸ engine) ----
export const SEARCH_ENGINES = [
  { header: "Web" },
  ["google", "Google", "#4285f4", "G"], ["coccoc", "Cốc Cốc", "#0f9d58", "C"], ["bing", "Bing", "#0b8484", "B"], ["yahoo", "Yahoo!", "#6001d2", "Y"],
  ["yandex", "Yandex", "#fc3f1d", "Я"], ["duckduckgo", "DuckDuckGo", "#de5833", "D"], ["baidu", "Baidu", "#2932e1", "百"], ["naver", "Naver", "#03c75a", "N"],
  ["ecosia", "Ecosia", "#36acb8", "E"], ["brave", "Brave Search", "#fb542b", "b"], ["ask", "Ask.com", "#d1312b", "A"],
  { header: "Academic" },
  ["scholar", "Google Scholar", "#4285f4", "S"], ["semantic", "Semantic Scholar", "#1857b6", "S2"], ["openalex", "OpenAlex", "#c8371b", "OA"], ["arxiv", "arXiv", "#b31b1b", "χ"],
  ["pubmed", "PubMed", "#326599", "P"], ["europepmc", "Europe PMC", "#5a8e3a", "E"], ["crossref", "Crossref", "#3eb1c8", "CR"], ["dblp", "DBLP", "#004c7f", "db"],
];
const engineInfo = (id) => SEARCH_ENGINES.find((e) => Array.isArray(e) && e[0] === id);
const engineDot = (e) => `<span class="eng-dot" style="--c:${e[2]}">${e[3]}</span>`;
function searchBackendFor() {
  const e = settings.aiSearchEngine || "auto";
  if (e !== "auto") return "engine:" + e;
  const b = settings.aiSearchBackend;
  return b && b !== "none" ? b : "engine:auto";
}
function refreshEngineChip() {
  const b = $("#ai-engine");
  if (!b) return;
  const e = engineInfo(settings.aiSearchEngine || "auto");
  b.innerHTML = e ? `${engineDot(e)}<span class="eng-name">${e[1]}</span>${ic("chevron-down")}` : `<span class="eng-name">Auto</span>${ic("chevron-down")}`;
  b.title = e ? `The AI searches the web with ${e[1]} — click to choose another search engine` : "Web search: automatic (Claude and Claude Code use their own search, other models Google) — click to choose a search engine";
  b.hidden = $("#ai-web").hidden || settings.aiWeb === false;
}
function engineMenu(ev) {
  const cur = settings.aiSearchEngine || "auto";
  const pick = (id) => { updateSettings({ aiSearchEngine: id }); refreshEngineChip(); const e = engineInfo(id); toast(e ? `The AI will search with ${e[1]}` : "Search engine: automatic", "", 1800); };
  const items = [{ label: "Automatic", icon: "sparkles", checked: cur === "auto", action: () => pick("auto") }, "-"];
  for (const e of SEARCH_ENGINES) items.push(Array.isArray(e) ? { label: e[1], icon: engineDot(e), checked: cur === e[0], action: () => pick(e[0]) } : e);
  const r = ev.currentTarget.getBoundingClientRect();
  import("./ctxmenu.js").then((m) => m.showContextMenu({ clientX: r.left, clientY: r.bottom + 4 }, items));
}

function renderContext() {
  const box = $("#ai-context");
  const t = activeTab();
  const sel = getSelectionInfo();
  const errs = (getLastCompile()?.diagnostics || []).filter((d) => d.severity === "error");
  const chips = [];
  if (t && t.kind !== "pdf") chips.push(["file", `📄 ${t.name}`]);
  if (sel && sel.to > sel.from) chips.push(["sel", `✂ Selection (${sel.to - sel.from} chars)`]);
  if (errs.length && (t?.kind === "tex" || t?.kind === "bib")) chips.push(["log", `⚠ ${errs.length} compile error${errs.length > 1 ? "s" : ""}`]);
  box.innerHTML = "";
  for (const [k, label] of chips) {
    const b = document.createElement("button");
    b.className = "chip" + (chat.ctx[k] ? " on" : "");
    b.textContent = label;
    b.title = chat.ctx[k] ? "Included — click to leave out" : "Left out — click to include";
    b.onclick = () => { chat.ctx[k] = !chat.ctx[k]; renderContext(); };
    box.appendChild(b);
  }
  // files and folders added from the file list (right-click → Add to Chat)
  for (const a of chat.attached) {
    const b = document.createElement("span");
    b.className = "chip on ai-attach";
    b.title = a.path;
    b.append(`${a.isDir ? "📁" : "📎"} ${basename(a.path)}`);
    const x = document.createElement("button");
    x.className = "x"; x.innerHTML = ic("x"); x.title = "Remove from the chat";
    x.onclick = () => { chat.attached = chat.attached.filter((y) => y !== a); renderContext(); };
    b.appendChild(x);
    box.appendChild(b);
  }
}

/** Add a file or folder from the file list to the chat's context. */
export async function addToChat(path, isDir) {
  if (chat.attached.some((a) => a.path === path)) { toggleAIPanel(true); return; }
  const a = { path, isDir, text: null, list: null };
  try {
    if (isDir) a.list = (await api.listDir(path)).map((e) => e.name + (e.isDir ? "/" : "")).slice(0, 200);
    else if (!/\.(pdf|png|jpe?g|gif|webp|bmp|zip|docx?|xlsx?|pptx?|exe|dll)$/i.test(path)) {
      const r = await api.readText(path);
      a.text = r.text.length > 60000 ? r.text.slice(0, 60000) + "\n… (truncated)" : r.text;
    }
  } catch {}
  chat.attached.push(a);
  toggleAIPanel(true);
  renderContext();
}

function contextBlock() {
  const t = activeTab();
  const v = getView();
  let s = "";
  if (t && ["doc", "sheet", "pdf", "deck", "image"].includes(t.kind)) {
    s += `\n\n# Current file: ${t.path || t.name} — a ${({ doc: "Word document", sheet: "spreadsheet", pdf: "PDF", deck: "presentation", image: "picture" })[t.kind]}${t.dirty ? " with unsaved changes" : ""}. Read it with office_read and change it with ${({ doc: "word_edit", sheet: "sheet_edit", pdf: "pdf_tool", deck: "deck_edit", image: "image_edit" })[t.kind]} (the author sees the change and can undo it).`;
  } else if (t && chat.ctx.file) {
    const ex = excerptAround(v.state.doc, v.state.selection.main.head);
    s += `\n\n# Current file: ${t.name}${ex.partial ? " (excerpt around the cursor)" : ""}\n<file>\n${ex.text}\n</file>`;
  } else if (t) s += `\n\n# Current file: ${t.name} (content not shared)`;
  const sel = t && ["doc", "sheet", "pdf", "deck"].includes(t.kind) ? null : getSelectionInfo();
  if (sel && sel.to > sel.from && chat.ctx.sel) s += `\n\n# The user's current selection\n<selection>\n${sel.text}\n</selection>`;
  const errs = (getLastCompile()?.diagnostics || []).filter((d) => d.severity === "error").slice(0, 12);
  if (errs.length && chat.ctx.log && (t?.kind === "tex" || t?.kind === "bib")) {
    s += `\n\n# Latest compile errors\n` + errs.map((d) => `- ${d.file ? basename(d.file) : ""}:${d.line || "?"}: ${d.message}`).join("\n");
  }
  for (const a of chat.attached) {
    if (a.isDir) s += `\n\n# Folder the user added: ${a.path}\n${(a.list || []).join("\n")}`;
    else if (a.text != null) s += `\n\n# File the user added: ${a.path}\n<file>\n${a.text}\n</file>`;
    else s += `\n\n# File the user added: ${a.path} (read it with your tools if you need its content)`;
  }
  return s;
}

let mdLib = null;
async function renderMd(el, text) {
  mdLib ??= await import("./md.js");
  el.innerHTML = "";
  mdLib.renderMarkdown(el, text, activeTab()?.path ? dirname(activeTab().path) : "");
  // AI output never loads remote images by itself (a crafted image URL could leak text)
  for (const img of el.querySelectorAll("img")) {
    const src = img.getAttribute("src") || "";
    if (/^(https?:)?\/\//i.test(src)) {
      const a = document.createElement("a");
      a.href = "#"; a.dataset.url = src; a.textContent = `🖼 ${img.alt || "image"} (${src.slice(0, 60)})`;
      img.replaceWith(a);
    }
  }
}

/** The final render of a streamed answer, without a jump: same height kept while it swaps. */
async function settleMd(body, text, stick) {
  const box = $("#ai-messages");
  const h = body.offsetHeight;
  body.style.minHeight = h + "px";
  await renderMd(body, text);
  requestAnimationFrame(() => { body.style.minHeight = ""; if (stick) box.scrollTop = box.scrollHeight; });
}

function addMsg(role, html) {
  const box = $("#ai-messages");
  box.querySelector(".ai-empty")?.remove();
  const el = document.createElement("div");
  el.className = `ai-msg ${role}`;
  el.innerHTML = html || "";
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  return el;
}

/**
 * Live "Thinking…" box above an answer: thinking streams in as it arrives and the box folds
 * away when the answer starts.
 */
export function thinkBox(msgEl) {
  const d = document.createElement("details");
  d.className = "ai-think live";
  d.hidden = true; d.open = true;
  d.innerHTML = `<summary>Thinking…</summary><div class="think-text"></div>`;
  const body = msgEl.querySelector(".ai-body");
  body.before(d);
  const txt = d.querySelector(".think-text");
  let buf = "", raf = 0, t0 = 0, folded = false;
  const flush = () => { raf = 0; txt.textContent += buf; buf = ""; txt.scrollTop = txt.scrollHeight; };
  const secs = () => Math.max(1, Math.round((performance.now() - t0) / 1000));
  return {
    add(t) {
      if (!t) return;
      if (!t0) { t0 = performance.now(); d.hidden = false; msgEl.querySelector(".ai-typing")?.remove(); }
      if (folded) { // thinking again (e.g. after a tool call): show it live once more
        folded = false; d.open = true; d.classList.add("live");
        d.querySelector("summary").textContent = "Thinking…";
        txt.textContent += "\n\n";
      }
      buf += t;
      if (!raf) raf = requestAnimationFrame(flush);
    },
    /** the answer started: fold the thinking away (it can be reopened) */
    answer() {
      if (!t0 || folded) return;
      folded = true; flush();
      d.open = false; d.classList.remove("live");
      d.querySelector("summary").textContent = `Thought for ${secs()} s`;
    },
    done() { if (t0) { this.answer(); } },
  };
}

function decorateCode(el, selAtSend) {
  for (const pre of el.querySelectorAll("pre")) {
    const code = pre.textContent.replace(/\n$/, "");
    const bar = document.createElement("div");
    bar.className = "code-actions";
    const btn = (label, fn, primary) => { const b = document.createElement("button"); b.textContent = label; if (primary) b.className = "primary"; b.onclick = fn; bar.appendChild(b); };
    if (selAtSend && selAtSend.to > selAtSend.from) btn("Replace selection", () => applyAt(selAtSend.from, selAtSend.to, code, "Chat suggestion", selAtSend), true);
    btn("Insert at cursor", () => { const s = getView().state.selection.main; applyAt(s.from, s.to, code, "Chat suggestion"); });
    btn("Copy", async () => { await navigator.clipboard.writeText(code); toast("Copied", "ok", 1200); });
    pre.after(bar);
  }
}

/** Apply text as a reviewed diff (after recording a version for safety). */
async function applyAt(from, to, text, label, expect) {
  const t = activeTab();
  if (!t || t.kind === "pdf") return;
  const v = getView();
  if (expect && v.state.sliceDoc(from, to) !== expect.text) {
    // document changed since: find the original selection text again
    const i = v.state.doc.toString().indexOf(expect.text);
    if (i < 0) return toast("The text you selected has changed; select it again.", "err");
    from = i; to = i + expect.text.length;
  }
  await historyRecord(t, v.state.doc.toString(), `Before AI: ${label}`, "ai");
  setReviewLabel(`AI: ${label}`);
  startReview(from, to, text);
  v.focus();
}

// ---------------- conversation window ----------------
// The model sees the newest messages up to a token budget (about 12k tokens), older long answers
// shortened. Messages that slide out stay reachable: memory recall may bring them back (no
// tokens spent), and a long chat gets one short summary, made once by the summary model.
const HIST_TOKENS = 12000;
const tokensOf = (s) => Math.ceil(String(s || "").length / 3.6);
function historyWindow(hist) {
  const out = [];
  let used = 0, dropped = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    const m = hist[i];
    const recent = hist.length - i <= 4;
    let content = m.content;
    // older long answers keep their start and end
    if (!recent && m.role === "assistant" && content.length > 2400) content = content.slice(0, 1500) + "\n… [shortened] …\n" + content.slice(-600);
    const t = tokensOf(content);
    if (out.length >= 2 && used + t > HIST_TOKENS) { dropped = i + 1; break; }
    out.unshift({ role: m.role, content });
    used += t;
  }
  // a conversation must start with the author's message
  while (out.length && out[0].role !== "user") { out.shift(); dropped++; }
  const oldestAt = dropped ? hist[dropped]?.at || null : null;
  return { messages: out, dropped, oldestAt };
}
async function ensureSummary(hist, dropped) {
  // once enough has slid out of the window, summarise it once (and again only much later)
  if (dropped < 6 || (chat.summary && chat.summaryUpTo >= dropped - 8)) return chat.summary || "";
  const model = settings.aiModel_summary || null;
  if (!model && !modelFor("summary")) return chat.summary || "";
  const part = hist.slice(0, dropped).map((m) => `${m.role === "user" ? "Author" : "Assistant"}: ${m.content.slice(0, 3000)}`).join("\n\n").slice(-60000);
  try {
    const text = await runAI("summary", { system: "Summarise this conversation between an author and their writing assistant in at most 12 short bullet points: decisions, facts, file names, open questions. No preamble.", messages: [{ role: "user", content: part }], maxTokens: 700, temperature: 0.2 });
    if (text?.trim()) { chat.summary = text.trim(); chat.summaryUpTo = dropped; }
  } catch {}
  return chat.summary || "";
}
/** The per-turn part (current file, selection, memory, summary): sent with the newest message, after the cached part. */
function turnContext(memText, summary) {
  let s = contextBlock();
  if (summary) s += `\n\n# Earlier in this conversation (summary)\n${summary}`;
  if (memText) s += `\n\n${memText.trim()}`;
  return s.trim();
}

async function send(textArg) {
  const input = $("#ai-text");
  const text = (textArg ?? input.value).trim();
  if (!text || chat.busyId) return;
  closeSlash();
  const slash = await resolveSlash(text);
  if (slash?.builtin) { input.value = ""; return slash.builtin(); }
  if (!modelFor("chat")) return needModel();
  if (isCCModel(modelFor("chat"))) return sendCC(text, slash);
  input.value = "";
  chat.busyId = "chat"; // set before any await: a second send or a folder change waits
  clearFileTags();
  const sidAtSend = chat.sid, hist = chat.history;
  const selAtSend = getSelectionInfo();
  const fileAtSend = activeTab()?.path || "", modelAtSend = modelFor("chat") || "";
  addMsg("user", esc(text).replace(/\n/g, "<br>"));
  hist.push({ role: "user", content: text, at: Date.now() });
  const el = addMsg("assistant", `<div class="ai-tools"></div><div class="ai-body markdown-body"><span class="ai-typing">●●●</span></div><div class="ai-sources"></div>`);
  const body = el.querySelector(".ai-body"), toolsEl = el.querySelector(".ai-tools"), srcEl = el.querySelector(".ai-sources");
  let full = "";
  const think = thinkBox(el);
  const stream = createStreamer(body, renderMd, $("#ai-messages"));
  const memAt = { project: memProject(), session: chat.mem };
  $("#ai-send").hidden = true; $("#ai-stop").hidden = false;
  try {
    const win = historyWindow(hist);
    const [mem, summary] = await Promise.all([memRecall(text, win.oldestAt), ensureSummary(hist, win.dropped)]);
    // stable first (cached by the provider), per-turn context last
    let system = baseSystem() + (await skillsPrompt()) + (mem ? await rememberedSkills(mem.skills) : "");
    const messages = win.messages;
    const ctxText = turnContext(mem?.text || "", summary);
    if (slash?.skill) {
      // "/skill-name …": this turn follows that skill in full
      const content = await slash.content();
      system += `\n\n# The author asked you to use the skill “${slash.skill.name}” for this message — follow it\n${content.slice(0, 150_000)}`;
      messages[messages.length - 1] = { role: "user", content: slash.rest || `Use the “${slash.skill.name}” skill on my current selection or file.` };
    }
    if (ctxText) messages[messages.length - 1] = { role: "user", content: `<context>\n${ctxText}\n</context>\n\n${messages[messages.length - 1].content}` };
    const result = runAI("chat", { system, messages, tools: true, web: settings.aiWeb !== false }, (e) => {
      if (e.kind === "text") { think.answer(); full += e.text; stream.set(full); }
      else if (e.kind === "thinking") think.add(e.text || "");
      else if (e.kind === "tool") {
        toolsEl.insertAdjacentHTML("beforeend", `<div class="tool-chip">⏳ ${esc(e.text)}</div>`);
        const inp = e.data?.input || {};
        const f = inp.path || inp.file || inp.file_path;
        if (f && /file|pdf|read|edit|write/i.test(e.data?.name || "")) fileTag(f, /edit|write|replace/i.test(e.data?.name || "") ? "edit" : "read", true);
      }
      else if (e.kind === "tool_done") { const last = toolsEl.lastElementChild; if (last) last.innerHTML = last.innerHTML.replace("⏳", "✓") + ` <small>${esc(e.text || "")}</small>`; fileTagsDone(); }
      else if (e.kind === "sources") {
        srcEl.innerHTML = `<div class="src-title">Sources</div>` + (e.data || []).slice(0, 10).map((s) => `<a href="#" data-url="${esc(s.url)}">${esc(s.title || s.url)}</a>`).join("");
      }
    });
    full = await result;
    hist.push({ role: "assistant", content: full, at: Date.now() });
    memRecord([{ role: "user", text, file: fileAtSend, model: modelAtSend, skills: slash?.skill ? [slug(slash.skill.name)] : [] }, { role: "assistant", text: full, model: modelAtSend }], memAt.project, memAt.session);
    if (chat.sid === sidAtSend) saveSession();
    think.done();
    if (full) { stream.set(full); await stream.finish(); }
    stream.stop();
    await settleMd(body, full || "_(no answer)_", stream.stick);
    decorateCode(body, selAtSend);
  } catch (e) {
    if (hist[hist.length - 1]?.role === "user") hist.pop();
    if (e.message === "NO_MODEL") { el.remove(); return needModel(); }
    body.innerHTML = `<div class="ai-error">${esc(e.message)}</div>`;
  } finally {
    chat.busyId = null;
    $("#ai-send").hidden = false; $("#ai-stop").hidden = true;
    fileTagsDone();
    setTimeout(onProjectChanged);
  }
}

async function sendCC(text, slash) {
  chat.busyId = "cc";
  clearFileTags();
  const sidAtSend = chat.sid, hist = chat.history;
  try {
    const cc = await import("./claude-code.js");
    if (!chat.ccReady) { chat.ccReady = await cc.ensureReady(); if (!chat.ccReady) return; }
    $("#ai-text").value = "";
    addMsg("user", esc(text).replace(/\n/g, "<br>"));
    $("#ai-send").hidden = true; $("#ai-stop").hidden = false;
    const scroll = () => { const b = $("#ai-messages"); b.scrollTop = b.scrollHeight; };
    // a Callio-only skill picked with "/": hand its instructions to Claude Code with the message
    let prompt = text;
    if (slash?.skill && !slash.native) prompt = `Use this skill (“${slash.skill.name}”) for my request:\n<skill>\n${(await slash.content()).slice(0, 100_000)}\n</skill>\n\n${slash.rest || "Apply it to my current selection or file."}`;
    const memAt = { project: memProject(), session: chat.mem, file: activeTab()?.path || "", model: modelFor("chat") || "" };
    const mem = await memRecall(text);
    const memText = (mem ? await rememberedSkills(mem.skills) : "") + (mem?.text ? `\n\n${mem.text}` : "");
    if (chat.attached.length) prompt += `\n\n(Files and folders I added for context — read them as needed:\n${chat.attached.map((a) => `- ${a.path}${a.isDir ? " (folder)" : ""}`).join("\n")})`;
    const ui = { addMsg, renderMd, settleMd, scroll, ctx: chat.ctx, session: chat.cc, setStop: (fn) => { chat.stop = fn; }, skillsForClaude, thinkBox, shown: text, memory: memText, fileTag };
    const full = await cc.runTurn(prompt, ui);
    hist.push({ role: "user", content: text }, { role: "assistant", content: full || "" });
    const model = memAt.model;
    memRecord([{ role: "user", text, file: memAt.file, model, skills: slash?.skill ? [slug(slash.skill.name)] : [] }, { role: "assistant", text: full || "", model, changed: (ui.result?.changed || []).map((c) => c.path) }], memAt.project, memAt.session);
    if (chat.cc.id && memOn() && memAt.project) call("mem_set_cc", { project: memAt.project, session: chat.cc.id, model }).catch(() => {});
    if (chat.sid === sidAtSend) saveSession();
  } catch (e) {
    chat.ccReady = false;
    const msg = e.message === "CLAUDE_MISSING" ? "Claude Code isn't installed — see AI settings → Claude Code." : e.message;
    addMsg("assistant", `<div class="ai-error">${esc(msg)}</div>`);
  } finally {
    chat.busyId = null; chat.stop = null;
    $("#ai-send").hidden = false; $("#ai-stop").hidden = true;
    fileTagsDone();
    setTimeout(onProjectChanged); // the folder may have changed while answering
  }
}

function newChat(silent) {
  if (chat.busyId && !silent) return toast("Wait for the current answer to finish.", "", 2500);
  chat.history = []; chat.summary = ""; chat.summaryUpTo = 0;
  chat.attached = [];
  chat.cc = { id: null };
  chat.mem = `s${Date.now().toString(36)}`;
  chat.sid = newSid(); chat.title = ""; chat.created = Date.now(); chat.project = sessProject();
  $("#ai-messages").innerHTML = `<div class="ai-empty"><b>New chat</b><p>Your document and selection are included as context (see the chips below). Conversations are saved with ${chat.project ? `the folder <b>${esc(basename(chat.project))}</b>` : "no folder (open a folder to keep them with a project)"}.${memOn() ? " What you worked on in this project before is remembered and recalled when it's relevant." : ""}</p><div class="sess-recent"></div></div>`;
  renderSessBar();
  showRecent();
  offerContinue();
}
async function showRecent() {
  const box = $("#ai-messages .sess-recent"); if (!box) return;
  const project = chat.project;
  const list = (await listSessions(project)).slice(0, 5);
  if (!list.length || project !== chat.project || !box.isConnected) return;
  box.innerHTML = `<div class="src-title">Recent conversations here</div>` + list.map((x) => `<button class="sess-pick" data-id="${esc(x.id)}">${esc(x.title || "Conversation")}<small>${esc(sessWhen(x.updated || x.created))}</small></button>`).join("");
  box.onclick = (e) => { const b = e.target.closest(".sess-pick"); if (b) loadSession(b.dataset.id, project); };
}
/** With Claude Code: offer to continue the last conversation in this project. */
async function offerContinue() {
  if (!isCCModel(modelFor("chat")) || chat.cc.id || !memOn() || !memProject()) return;
  let r;
  try { r = await call("mem_list", { project: memProject() }); } catch { return; }
  const m = r?.meta;
  if (!m?.ccSession) return;
  const box = $("#ai-messages .ai-empty");
  if (!box || box.querySelector(".cc-continue")) return;
  const b = document.createElement("button");
  b.className = "small cc-continue";
  b.textContent = `↺ Continue the Claude Code conversation from ${new Date(m.ccSessionAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
  b.onclick = () => { chat.cc.id = m.ccSession; b.replaceWith(Object.assign(document.createElement("p"), { className: "note", textContent: "Continuing — Claude Code remembers that conversation." })); $("#ai-text").focus(); };
  box.appendChild(b);
}
async function openMemoryDialog() {
  const project = memProject();
  if (!project) return toast("Open a project folder first.", "", 2500);
  const dlg = $("#dlg-memory");
  const draw = async () => {
    const r = await call("mem_list", { project });
    $("#mem-sum").textContent = `${basename(project)} — ${r.turns} remembered message${r.turns === 1 ? "" : "s"} in ${r.sessions} conversation${r.sessions === 1 ? "" : "s"}${memOn() ? "" : " (memory is off in Settings → AI)"}`;
    const pins = $("#mem-pins");
    pins.innerHTML = r.pins.length ? "" : `<div class="note">Nothing pinned. Type <code>/remember …</code> in the chat to pin a fact, preference or decision.</div>`;
    for (const p of r.pins) {
      const row = document.createElement("div");
      row.className = "folder-row";
      row.innerHTML = `<span></span><button class="icon small" title="Forget">${ic("x")}</button>`;
      row.querySelector("span").textContent = p.text;
      row.querySelector("button").onclick = async () => { await call("mem_forget", { project, id: p.id }); draw(); };
      pins.appendChild(row);
    }
    const rec = $("#mem-recent");
    rec.innerHTML = "";
    for (const t of r.recent.slice(0, 60)) {
      const row = document.createElement("div");
      row.className = `mem-row ${t.role}`;
      row.innerHTML = `<small></small><span></span><button class="icon small" title="Forget this message">${ic("x")}</button>`;
      row.querySelector("small").textContent = new Date(t.t).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) + (t.role === "user" ? " · you" : " · AI");
      row.querySelector("span").textContent = t.text.slice(0, 300);
      row.querySelector("button").onclick = async () => { await call("mem_forget", { project, id: t.id }); draw(); };
      rec.appendChild(row);
    }
  };
  $("#mem-close").onclick = () => dlg.close();
  $("#mem-add").onclick = async () => { const v = await ask({ title: "Remember", text: "A fact, preference or decision for this project (e.g. “British spelling; the target journal is CSF”).", input: "" }); if (v?.trim()) { await call("mem_pin", { project, text: v.trim() }); draw(); } };
  $("#mem-wipe").onclick = async () => { if (await ask({ title: "Forget everything for this project?", text: "All remembered conversations and pinned notes for this folder are deleted.", buttons: [{ label: "Cancel", value: null }, { label: "Forget everything", value: "y", primary: true }] })) { await call("mem_forget", { project, id: null }); chat.cc.id = null; draw(); } };
  await draw();
  if (!dlg.open) dlg.showModal();
}

// ---------------- "/" skills and commands in the chat box ----------------
const BUILTINS = [
  { name: "new", description: "Start a new chat", run: () => newChat() },
  { name: "clear", description: "Clear the chat (same as /new)", run: () => newChat() },
  { name: "compile", description: "Compile the LaTeX project", run: () => compile() },
  { name: "verify-bib", description: "Check every reference in a .bib file against Crossref/OpenAlex", run: () => verifyBib() },
  { name: "skills", description: "Choose which skills are active", run: async () => { await scanSkills(); openSkillsDialog(); } },
  { name: "remember", description: "Pin a fact, preference or decision for this project (/remember …)", run: null },
  { name: "memory", description: "See or forget what is remembered about this project", run: () => openMemoryDialog() },
  { name: "brief", description: "A short overview of this project: what it is, what was decided, what's open (made on request only)", run: () => brief() },
  { name: "library", description: "Open the paper library", run: () => import("./library.js").then((m) => m.openLibrary()) },
  { name: "cite", description: "Cite a paper from the library at the cursor (Alt+C)", run: () => import("./cite.js").then((m) => m.openCitePopup()) },
];
/** /brief: an overview of the project from its files and remembered conversations — one AI call, only when asked. */
async function brief() {
  const project = memProject();
  if (!project) return toast("Open a folder first: /brief describes the project in it.", "", 3500);
  if (!modelFor("summary")) return needModel();
  addMsg("user", "/brief");
  const el = addMsg("assistant", `<div class="ai-body markdown-body"><span class="ai-typing">●●●</span></div>`);
  const body = el.querySelector(".ai-body");
  try {
    const mem = await call("mem_list", { project }).catch(() => null);
    let files = [];
    try { files = (await api.listDir(project)).filter((x) => !x.name.startsWith(".")).map((x) => (x.isDir ? x.name + "/" : x.name)).slice(0, 120); } catch {}
    const pins = (mem?.pins || []).map((p) => `- ${p.text}`).join("\n");
    const turns = (mem?.recent || []).slice(0, 160).reverse().map((t) => `${t.role === "user" ? "Author" : "Assistant"} (${new Date(t.t).toISOString().slice(0, 10)}${t.file ? ", " + basename(t.file) : ""}): ${String(t.text).slice(0, 400)}`).join("\n");
    const t = activeTab();
    const doc = t && !["pdf", "doc", "sheet", "deck", "image", "media"].includes(t.kind) ? getView().state.doc.toString().slice(0, 6000) : "";
    const user = `Project folder: ${basename(project)}\nFiles: ${files.join(", ")}\n\nPinned notes:\n${pins || "(none)"}\n\nRecent conversations (newest last):\n${turns || "(none)"}${doc ? `\n\nStart of the open file ${t.name}:\n${doc}` : ""}`;
    let full = "";
    full = await runAI("summary", { system: "Write a brief of this writing/research project for its author, in Markdown: **What it is** (2 sentences), **Where it stands**, **Decisions so far**, **Open questions / next steps** (bullets). Only use what is given; don't invent results or references.", messages: [{ role: "user", content: user }], maxTokens: 900, temperature: 0.2 }, (e) => { if (e.kind === "text") { full += e.text; renderMd(body, full); } });
    await renderMd(body, full || "_(no answer)_");
    chat.history.push({ role: "user", content: "/brief", at: Date.now() }, { role: "assistant", content: full, at: Date.now() });
    saveSession();
  } catch (e) {
    if (e.message === "NO_MODEL") return needModel();
    body.textContent = `Couldn't make the brief: ${e.message}`;
  }
}
const slug = (n) => n.trim().replace(/\s+/g, "-");
let ccSkillCache = { t: 0, cwd: "", list: [] };
async function ccSkillList() {
  const t = activeTab();
  const cwd = folder || (t?.path ? dirname(t.path) : "");
  if (Date.now() - ccSkillCache.t < 30_000 && ccSkillCache.cwd === cwd) return ccSkillCache.list;
  let list = [];
  try { list = await call("cc_skills", { cwd: cwd || null }); } catch {}
  ccSkillCache = { t: Date.now(), cwd, list };
  return list;
}
/** Everything "/" can call: commands, Callio's skills, and (for Claude Code) its own skills. */
async function slashItems() {
  if (!skillList.length) await scanSkills();
  const cc = isCCModel(modelFor("chat"));
  const items = BUILTINS.map((b) => ({ name: b.name, description: b.description, badge: "command", builtin: b.run || (() => {}) }));
  const seen = new Set(items.map((i) => i.name.toLowerCase()));
  const ccList = settings.ccEnabled ? await ccSkillList() : [];
  const add = (i) => { const k = i.name.toLowerCase(); if (!seen.has(k)) { seen.add(k); items.push(i); } };
  // with Claude Code, its own skills run natively; otherwise Callio's copy is preferred
  const callio = skillList.map((sk) => ({ name: slug(sk.name), description: sk.description || "", badge: isSkillOn(sk) ? "skill" : "skill (off)", skill: sk }));
  const native = ccList.map((c) => ({ name: c.name, description: c.description || "", badge: c.kind === "command" ? "Claude Code command" : "Claude Code skill", cc: c }));
  for (const i of cc ? [...native, ...callio] : [...callio, ...native]) add(i);
  return items;
}
/** "/name rest" → what to do with it (null: an ordinary message). */
async function resolveSlash(text) {
  const m = /^\/([\w:.\-]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return null;
  const it = (await slashItems()).find((i) => i.name.toLowerCase() === m[1].toLowerCase());
  if (!it) return null;
  const rest = (m[2] || "").trim();
  if (it.name === "remember") return { builtin: async () => {
    const project = memProject();
    if (!rest) return openMemoryDialog();
    if (!project) return toast("Open a project folder first.", "", 2500);
    await call("mem_pin", { project, text: rest });
    addMsg("assistant", `<div class="note">📌 Remembered for this project: ${esc(rest)}</div>`);
  } };
  if (it.builtin) return { builtin: it.builtin };
  const cc = isCCModel(modelFor("chat"));
  if (it.cc) return { native: cc, rest, skill: { name: it.name }, content: () => call("skills_read", { path: it.cc.path }).catch(() => "") };
  return { native: false, rest, skill: it.skill, content: async () => (await skillContent(it.skill)) || "" };
}

let slashSel = 0, slashShown = [];
function closeSlash() { $("#ai-slash").hidden = true; slashShown = []; }
const slashOpen = () => !$("#ai-slash").hidden && slashShown.length > 0;
async function updateSlash() {
  const input = $("#ai-text");
  const v = input.value;
  const m = /^\/([\w:.\-]*)$/.exec(v.slice(0, input.selectionStart));
  if (!m || /\s/.test(v.slice(0, input.selectionStart))) return closeSlash();
  const q = m[1].toLowerCase();
  const all = await slashItems();
  if (input.value !== v) return; // typed on meanwhile
  const starts = all.filter((i) => i.name.toLowerCase().startsWith(q));
  const contains = all.filter((i) => !i.name.toLowerCase().startsWith(q) && (i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)));
  slashShown = [...starts, ...contains].slice(0, 60);
  slashSel = 0;
  renderSlash();
}
function renderSlash() {
  const box = $("#ai-slash");
  if (!slashShown.length) { box.hidden = false; box.innerHTML = `<div class="slash-empty">No matching skill or command — Enter sends it as typed.</div>`; return; }
  box.hidden = false;
  box.innerHTML = "";
  slashShown.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "slash-item" + (i === slashSel ? " sel" : "");
    row.setAttribute("role", "option");
    row.innerHTML = `<span class="slash-name"></span><span class="slash-badge"></span><span class="slash-desc"></span>`;
    row.querySelector(".slash-name").textContent = "/" + it.name;
    row.querySelector(".slash-badge").textContent = it.badge;
    row.querySelector(".slash-desc").textContent = it.description.replace(/\s+/g, " ").slice(0, 140);
    row.addEventListener("mousedown", (e) => { e.preventDefault(); pickSlash(i); });
    box.appendChild(row);
  });
  box.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}
function pickSlash(i) {
  const it = slashShown[i];
  if (!it) return;
  const input = $("#ai-text");
  const after = input.value.slice(input.selectionStart).replace(/^\S*/, "").replace(/^\s*/, "");
  input.value = `/${it.name} ${after}`;
  const pos = it.name.length + 2;
  input.setSelectionRange(pos, pos);
  closeSlash();
  input.focus();
  if (it.builtin && it.name !== "remember") send();
}
/** Keys while the "/" list is open; true when handled. */
function slashKey(e) {
  if (!slashOpen()) return false;
  if (e.key === "ArrowDown") { slashSel = (slashSel + 1) % slashShown.length; renderSlash(); }
  else if (e.key === "ArrowUp") { slashSel = (slashSel - 1 + slashShown.length) % slashShown.length; renderSlash(); }
  else if (e.key === "Enter" || e.key === "Tab") pickSlash(slashSel);
  else if (e.key === "Escape") closeSlash();
  else return false;
  e.preventDefault();
  return true;
}

// ---------------- quick actions on a selection ----------------
export const ACTIONS = [
  { id: "improve", label: "Improve writing", prompt: "Improve clarity, flow and academic tone. Keep the meaning, citations, labels, math and LaTeX commands intact." },
  { id: "grammar", label: "Fix grammar & spelling", prompt: "Fix grammar, spelling and punctuation only. Change as little as possible." },
  { id: "concise", label: "Make concise", prompt: "Make this more concise without losing content." },
  { id: "expand", label: "Expand", prompt: "Expand with more explanation in the same style. Do not invent facts, numbers or citations." },
  { id: "formal", label: "More formal / academic", prompt: "Rewrite in a more formal academic register." },
  { id: "paraphrase", label: "Paraphrase", prompt: "Paraphrase so it reads differently while keeping the meaning." },
  { id: "style", label: "Apply my style guides", prompt: "Revise this to follow the author's writing guides (in your instructions) exactly.", skills: true },
  { id: "english", label: "Translate to English", prompt: "Translate into natural academic English." },
  { id: "latex", label: "Convert to LaTeX", prompt: "Convert into clean LaTeX (tables → tabular with booktabs, lists → itemize/enumerate, math → proper environments)." },
  { id: "custom", label: "Custom instruction…" },
  { id: "explain", label: "Ask about it in chat", chat: true },
];

let actionBusy = null;
let fillRolesRef = null;
/** Re-fill the model lists in Settings → AI (after Claude Code is turned on or off). */
export const refreshRoleSelects = () => fillRolesRef?.();
export async function runAction(id, custom) {
  const a = ACTIONS.find((x) => x.id === id);
  const t = activeTab();
  const sel = getSelectionInfo();
  if (!t || t.kind === "pdf" || !sel || sel.to === sel.from) return toast("Select some text first.", "", 2500);
  if (a.chat) { toggleAIPanel(true); $("#ai-text").value = "Explain this:"; $("#ai-text").focus(); return; }
  let instruction = a.prompt;
  if (id === "custom") {
    instruction = custom ?? (await ask({ title: "Tell the AI what to do", text: "It will rewrite the selected text; you then review the changes.", input: "" }));
    if (!instruction) return;
  }
  if (!modelFor("edit")) return needModel();
  const lang = t.kind === "tex" ? "LaTeX" : t.kind === "md" ? "Markdown" : "text";
  const doc = sel.doc.toString();
  const before = doc.slice(Math.max(0, sel.from - 1500), sel.from), after = doc.slice(sel.to, sel.to + 600);
  const system = baseSystem() + (a?.skills || id === "custom" ? await skillsPrompt(undefined, true) : "") +
    `\n\nYou are editing part of a ${lang} document. Reply with ONLY the replacement for the selected text — no explanations, no quotes, no code fences. Keep the surrounding format so it drops straight in.`;
  const user = `Instruction: ${instruction}\n\nContext before (do not repeat):\n<before>${before}</before>\n\nText to rewrite:\n<selected>${sel.text}</selected>\n\nContext after (do not repeat):\n<after>${after}</after>`;
  showWorking(`AI: ${a?.label || "Custom"}…`);
  try {
    let out = await runAI("edit", { system, messages: [{ role: "user", content: user }], temperature: 0.3 }, (e) => { if (e.kind === "text") workingProgress(e.text.length); });
    out = stripFences(out);
    if (!out.trim()) throw new Error("The model returned nothing");
    // keep the original trailing/leading whitespace shape
    const lead = sel.text.match(/^\s*/)[0], trail = sel.text.match(/\s*$/)[0];
    await applyAt(sel.from, sel.to, lead + out.trim() + trail, a?.label || instruction.slice(0, 40), sel);
  } catch (e) {
    if (e.message === "NO_MODEL") return needModel();
    if (!/Stopped/.test(e.message)) toast(`AI: ${e.message}`, "err", 8000);
  } finally { hideWorking(); }
}

/** Write or change the open Mermaid diagram from a description (a reviewable change). */
export async function aiMermaid() {
  const t = activeTab();
  if (!t || (t.kind !== "mermaid" && t.kind !== "md")) return toast("Open a Mermaid (.mmd) file or a Markdown file first.", "", 3000);
  const doc = getView().state.doc.toString();
  const current = t.kind === "mermaid" ? doc : "";
  const want = await ask({ title: current.trim() ? "Change the diagram" : "Generate a diagram", text: current.trim() ? "What should change? (e.g. “add a review step after Draft”, “make it left to right”)" : "Describe the diagram (flowchart, sequence, class, state, ER, Gantt, mind map, timeline…)", input: "" });
  if (!want?.trim()) return;
  if (!modelFor("edit")) return needModel();
  const system = `You write Mermaid diagrams (mermaid.js v11 syntax). Reply with ONLY the Mermaid source — no explanations, no code fences. Use short, clear labels; quote labels that contain punctuation.`;
  const user = current.trim() ? `Current diagram:\n${current}\n\nChange: ${want}` : `Diagram to draw: ${want}`;
  showWorking(current.trim() ? "AI: changing the diagram…" : "AI: drawing the diagram…");
  try {
    let out = stripFences(await runAI("edit", { system, messages: [{ role: "user", content: user }], temperature: 0.2 }, (e) => { if (e.kind === "text") workingProgress(e.text.length); }));
    out = out.replace(/^\s*```(?:mermaid)?\s*|\s*```\s*$/g, "").trim() + "\n";
    // the diagram must draw before it goes in
    try { (await import("./mermaid.js")).renderMermaid(out); } catch {}
    if (t.kind === "mermaid") await applyAt(0, doc.length, out, "AI diagram", { doc: getView().state.doc, from: 0, to: doc.length, text: doc });
    else {
      const pos = getView().state.selection.main.head;
      await applyAt(pos, pos, "\n```mermaid\n" + out + "```\n", "AI diagram", null);
    }
  } catch (e) {
    if (e.message === "NO_MODEL") return needModel();
    if (!/Stopped/.test(e.message)) toast(`AI: ${e.message}`, "err", 8000);
  } finally { hideWorking(); }
}

function stripFences(s) {
  const m = /^\s*```[a-zA-Z]*\n([\s\S]*?)\n?```\s*$/.exec(s);
  return m ? m[1] : s.replace(/^<selected>|<\/selected>$/g, "");
}

// floating "AI working" indicator with Stop
let workChars = 0;
function showWorking(label) {
  workChars = 0;
  const w = $("#ai-working");
  w.querySelector("span").textContent = label;
  w.hidden = false;
}
function workingProgress(n) { workChars += n; $("#ai-working small").textContent = workChars ? `${workChars} chars` : ""; }
function hideWorking() { $("#ai-working").hidden = true; }

// selection menu (Ctrl+. or the ✨ button that appears near a selection)
export function openActionMenu(x, y) {
  const m = $("#ai-actions");
  m.innerHTML = ACTIONS.map((a) => `<button data-act="${a.id}">${esc(a.label)}</button>`).join("");
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
  m.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
  m.querySelector("button").focus();
}

// ---------------- Fix with AI ----------------
export async function fixError(d) {
  if (!d.file) return;
  if (!modelFor("edit")) return needModel();
  const t = await openPath(d.file, d.line || 1);
  if (!t) return;
  const v = getView();
  const doc = v.state.doc;
  const line = Math.max(1, Math.min(d.line || 1, doc.lines));
  const a = Math.max(1, line - 12), b = Math.min(doc.lines, line + 12);
  const numbered = [];
  for (let i = a; i <= b; i++) numbered.push(`${String(i).padStart(4)}| ${doc.line(i).text}`);
  const full = doc.toString();
  const preambleEnd = full.indexOf("\\begin{document}");
  const preamble = preambleEnd > 0 ? full.slice(0, preambleEnd).split("\n").slice(0, 120).join("\n") : "";
  const system = baseSystem() + `\n\nYou fix LaTeX compile errors. Reply with ONLY the corrected text of lines ${a}–${b} (without the line numbers), nothing else. Make the smallest change that fixes the error; if the fix belongs elsewhere (e.g. a missing \\usepackage in the preamble), still reply with lines ${a}–${b} unchanged and put a one-line LaTeX comment starting with "% CALLIO-NOTE:" at the top explaining what to change.`;
  const user = `Error${d.line ? ` at line ${d.line}` : ""}: ${d.message}\n\n${preamble ? `Preamble:\n<preamble>\n${preamble}\n</preamble>\n\n` : ""}Lines ${a}–${b}:\n<lines>\n${numbered.join("\n")}\n</lines>`;
  showWorking("AI: fixing the error…");
  try {
    let out = stripFences(await runAI("edit", { system, messages: [{ role: "user", content: user }], temperature: 0.1 }, (e) => { if (e.kind === "text") workingProgress(e.text.length); }));
    out = out.replace(/^\s*\d+\|\s?/gm, "").replace(/\n$/, "");
    const note = /^% CALLIO-NOTE:(.*)$/m.exec(out);
    if (note) { toast(`AI: ${note[1].trim()}`, "", 10000); out = out.replace(/^% CALLIO-NOTE:.*\n?/m, ""); }
    const from = doc.line(a).from, to = doc.line(b).to;
    if (out === doc.sliceString(from, to)) return toast("The AI didn't change these lines.", "", 4000);
    await historyRecord(t, full, "Before AI: fix error", "ai");
    setReviewLabel("AI: fix error");
    startReview(from, to, out);
  } catch (e) {
    if (e.message === "NO_MODEL") return needModel();
    if (!/Stopped/.test(e.message)) toast(`AI: ${e.message}`, "err", 8000);
  } finally { hideWorking(); }
}

// ---------------- citation check (.bib) ----------------
export async function verifyBib(path) {
  if (!path) {
    const bibs = project.files.filter((f) => f.endsWith(".bib"));
    const root = folder || (activeTab()?.path ? dirname(activeTab().path) : null);
    if (activeTab()?.kind === "bib") path = activeTab().path;
    else if (bibs.length === 1 && root) path = `${root}/${bibs[0]}`;
    else if (bibs.length > 1 && root) {
      const pick = await ask({ title: "Which .bib file?", buttons: [{ label: "Cancel", value: null }, ...bibs.slice(0, 4).map((b) => ({ label: b, value: b }))] });
      if (!pick) return;
      path = `${root}/${pick}`;
    } else return toast("Open a .bib file (or a project with one) first.", "err");
  }
  const dlg = $("#dlg-bib");
  $("#bib-deep").value = settings.bibDeep || "";
  $("#bib-deep").onchange = (e) => updateSettings({ bibDeep: e.target.value });
  $("#bib-rerun").onclick = () => verifyBib(path);
  $("#bib-title").textContent = `Citation check — ${basename(path)}`;
  $("#bib-list").innerHTML = "";
  $("#bib-summary").textContent = "Checking each entry against Crossref and OpenAlex…";
  const bar = $("#bib-bar"); bar.removeAttribute("value"); bar.hidden = false;
  if (!dlg.open) dlg.showModal();
  $("#bib-rerun").disabled = true;
  const un = await listen("bib-progress", (p) => { if (p.total) { bar.max = p.total; bar.value = p.done; $("#bib-summary").textContent = `Checked ${p.done} of ${p.total}${p.key ? ` · ${p.key}` : ""}${p.deep ? " · asking Perplexity…" : ""}`; } });
  try {
    const res = await api.verifyBib(path, null, settings.bibDeep || null);
    const counts = { verified: 0, check: 0, problem: 0, skipped: 0 };
    res.sort((a, b) => ["problem", "check", "skipped", "verified"].indexOf(a.level) - ["problem", "check", "skipped", "verified"].indexOf(b.level));
    const list = $("#bib-list");
    for (const r of res) {
      counts[r.level]++;
      const el = document.createElement("div");
      el.className = `bib-row ${r.level}`;
      const f = r.found;
      const lib = r.library, dv = r.deep?.verdict;
      el.innerHTML = `<span class="bib-badge"></span><div class="bib-main"><div><b class="bib-key"></b> <span class="bib-t"></span></div><div class="bib-msg"></div>${f ? `<div class="bib-found">Found: <i></i>${f.doi ? ` · <a href="#" data-url="https://doi.org/${esc(f.doi)}">doi:${esc(f.doi)}</a>` : ""}</div>` : ""}${lib ? `<div class="bib-found">📚 Library: <a href="#" class="bib-lib">${esc(lib.title)}</a>${lib.year ? ` (${lib.year})` : ""}${lib.pdf ? " · PDF" : ""}</div>` : ""}${dv && (dv.title || dv.doi) ? `<div class="bib-found">Perplexity: <i>${esc(dv.title || "")}</i>${dv.year ? ` (${esc(dv.year)})` : ""}${dv.doi ? ` · <a href="#" data-url="https://doi.org/${esc(dv.doi)}">doi:${esc(dv.doi)}</a>` : ""}</div>` : ""}${r.deep?.sources?.length ? `<div class="bib-found">Sources: ${r.deep.sources.map((s) => `<a href="#" data-url="${esc(s.url)}">${esc((s.title || s.url).slice(0, 60))}</a>`).join(" · ")}</div>` : ""}</div>`;
      el.querySelector(".bib-lib")?.addEventListener("click", async (e) => { e.preventDefault(); dlg.close(); const m = await import("./library.js"); await m.loadLibrary(); m.openPdf(m.getLibrary().byId.get(lib.id)); });
      el.querySelector(".bib-badge").textContent = { verified: "✓", check: "?", problem: "✗", skipped: "–" }[r.level];
      el.querySelector(".bib-key").textContent = r.key;
      el.querySelector(".bib-t").textContent = r.title;
      el.querySelector(".bib-msg").textContent = r.message;
      if (f) el.querySelector(".bib-found i").textContent = `${f.title || ""} (${f.year || "?"})${f.authors ? " — " + f.authors : ""}`;
      el.querySelector(".bib-key").onclick = () => { dlg.close(); openPath(path, r.line); };
      list.appendChild(el);
    }
    $("#bib-summary").textContent = `${counts.problem} problem(s), ${counts.check} to check, ${counts.verified} verified, ${counts.skipped} skipped`;
  } catch (e) {
    $("#bib-summary").textContent = e.message;
  } finally { un?.(); bar.hidden = true; $("#bib-rerun").disabled = false; }
}

// ---------------- settings page ----------------
// Four tabs: Providers (a list — Claude Code and the API providers — with the chosen one's
// settings under it), Models (one model per AI function, grouped), Internet and Skills.
let aiTab = "providers", provSel = null;
const ROLE_GROUPS = [
  ["Chat and agents", "The AI panel, Claude Code and the tools it runs.", [["chat", "Chat panel"]], ["aiEffort", "aiThinking", "aiMemory"]],
  ["Writing", "The writing assistant, rewrites and completion as you type.", [["write", "Writing assistant (grammar, style, tone)"], ["edit", "Rewrites, Ask AI and Fix with AI"], ["inline", "Inline completion"]], ["aiInlineEnabled", "aiInlineDelay"]],
  ["Translation and dictionary", "The Translate and Look up popups (right-click, double-click).", [["translate", "Translation (AI)"]], []],
  ["Research and library", "Summaries of long chats and the details of papers in your library.", [["summary", "Summaries (long chats, /brief) — a small, cheap model is enough"], ["library", "Paper details (library)"]], ["libAiDetails"]],
];
const PLAIN = {
  aiEffort: () => `<label>Effort for Claude models <select name="aiEffort"><option value="">Model default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra</option><option value="max">Max — 4× or more usage</option></select></label>`,
  aiThinking: () => `<label class="check"><input type="checkbox" name="aiThinking" ${settings.aiThinking !== false ? "checked" : ""}> Show the model's thinking live while it works</label>`,
  aiMemory: () => `<label class="check"><input type="checkbox" name="aiMemory" ${settings.aiMemory !== false ? "checked" : ""}> Remember conversations per project folder (/memory to see or forget)</label>`,
  aiInlineEnabled: () => `<label class="check"><input type="checkbox" name="aiInlineEnabled" ${settings.aiInlineEnabled ? "checked" : ""}> Inline completion while typing (ghost text, Tab to accept)</label>`,
  aiInlineDelay: () => `<label>Inline completion delay (ms) <input type="number" name="aiInlineDelay" min="200" max="5000" value="${settings.aiInlineDelay || 700}"></label>`,
  libAiDetails: () => `<label class="check"><input type="checkbox" name="libAiDetails" ${settings.libAiDetails !== false ? "checked" : ""}> Find missing paper details with AI and the internet</label>`,
};
function provMeta(id) {
  if (id === "claudecode") return settings.ccEnabled ? "On" : "Off";
  const c = provCfg(id);
  if (!c.enabled) return "Off";
  return c.models?.length ? `On · ${c.models.length} models` : "On";
}
const provOn = (id) => (id === "claudecode" ? !!settings.ccEnabled : !!provCfg(id).enabled);

export function renderAISettings() {
  const box = $("#ai-settings");
  const searchKeyName = `search-key-${settings.aiSearchBackend || "none"}`;
  const rows = [{ id: "claudecode", name: "Claude Code", sub: "Your Claude Pro or Max plan — no API key" }, ...PRESETS.map((p) => ({ id: p.id, name: p.name, sub: p.optionalKey ? "Your own server" : "API key" }))];
  if (!provSel || !rows.some((r) => r.id === provSel)) provSel = rows.find((r) => provOn(r.id))?.id || "claudecode";
  box.innerHTML = `
    <div class="set-tabs" role="tablist">
      ${[["providers", "Providers"], ["models", "Models"], ["internet", "Internet"], ["skills", "Skills"]].map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" class="${aiTab === k ? "on" : ""}">${l}</button>`).join("")}
    </div>
    <div class="ai-pane" data-pane="providers" ${aiTab === "providers" ? "" : "hidden"}>
      <p class="note set-intro">Choose a provider to set it up. Keys are stored in Windows Credential Manager; requests go directly from your PC to the provider.</p>
      <div class="pick-list prov-pick" role="listbox">${rows.map((r) => `
        <button type="button" class="pl-row${r.id === provSel ? " on" : ""}" data-p="${r.id}" role="option" aria-selected="${r.id === provSel}">
          <span class="pl-dot ${provOn(r.id) ? "ok" : ""}"></span><span class="pl-main"><b>${esc(r.name)}</b><small>${esc(r.sub)}</small></span><span class="pl-meta">${esc(provMeta(r.id))}</span>${ic("chevron-right")}
        </button>`).join("")}
      </div>
      <div class="prov-detail"></div>
    </div>
    <div class="ai-pane" data-pane="models" ${aiTab === "models" ? "" : "hidden"}>
      <p class="note set-intro">Pick the model each AI function uses. “Same as chat” follows the Chat panel model.</p>
      ${ROLE_GROUPS.map(([title, note, roles, extra]) => `
        <div class="sg"><h3 class="set-h sg-h">${title}</h3><p class="note">${note}</p>
          ${roles.map(([r, l]) => `<label>${l} <select class="m-role" data-role="${r}"></select></label>`).join("")}
          ${extra.map((k) => PLAIN[k]()).join("")}
        </div>`).join("")}
    </div>
    <div class="ai-pane" data-pane="internet" ${aiTab === "internet" ? "" : "hidden"}>
      <div class="sg"><h3 class="set-h sg-h">Internet access</h3>
        <label class="check"><input type="checkbox" name="aiWeb" ${settings.aiWeb !== false ? "checked" : ""}> Let the AI use the internet (search papers, verify citations, read pages)</label>
        <p class="note">Pick the search engine (Google, Cốc Cốc, Bing, DuckDuckGo, Google Scholar, Semantic Scholar, arXiv, PubMed…) from the chat's toolbar, next to the globe. Engines are read from their own results pages, like in your browser; no key is needed.</p>
      </div>
      <div class="sg"><h3 class="set-h sg-h">Automatic search</h3>
        <p class="note">Used when the chat's engine is set to Automatic.</p>
        <label>Automatic web search uses
          <select name="aiSearchBackend">
            <option value="none">The model's own search (Claude), otherwise Google</option>
            <option value="brave">Brave Search API</option>
            <option value="tavily">Tavily</option>
            <option value="searxng">SearXNG (your server)</option>
          </select></label>
        <label class="s-url" ${settings.aiSearchBackend === "searxng" ? "" : "hidden"}>SearXNG URL <input name="aiSearchUrl" type="text" value="${esc(settings.aiSearchUrl || "")}" placeholder="http://localhost:8888"></label>
        <label class="s-key" ${["brave", "tavily"].includes(settings.aiSearchBackend) ? "" : "hidden"}>Search API key <input id="search-key" type="password" autocomplete="off"></label>
        <p class="note">Paper search and citation checks (OpenAlex, Crossref, doi.org) are free and need no key.</p>
      </div>
    </div>
    <div class="ai-pane" data-pane="skills" ${aiTab === "skills" ? "" : "hidden"}>
      <div class="sg"><h3 class="set-h sg-h">Skill folders</h3>
        <label class="check"><input type="checkbox" name="skillUseOwn" ${settings.skillUseOwn !== false ? "checked" : ""}> Use Callio's own skills folder</label>
        <div id="skill-folders" class="pick-list compact"></div>
        <div class="row"><button type="button" id="open-own-skills">Open Callio's skills folder</button><button type="button" id="add-skill-folder">Add a skills folder…</button><button type="button" id="choose-skills" class="primary">Choose active skills…</button></div>
        <label class="check"><input type="checkbox" name="avoidLint" ${settings.avoidLint !== false ? "checked" : ""}> Underline words from "avoid" lists in my skills (e.g. *vocab-avoid.md)</label>
      </div>
      <div class="sg"><h3 class="set-h sg-h">Install from GitHub</h3>
        <div class="gh-install">
          <label class="wide">Repository or skill folder <input id="gh-url" type="search" spellcheck="false" placeholder="https://github.com/owner/repo — or a link to one skill's folder"></label>
          <div class="row"><button type="button" id="gh-find" class="primary">Install</button>
            <label class="check" data-row="0"><input type="checkbox" name="skillsShareClaude" ${settings.skillsShareClaude !== false ? "checked" : ""}> Also give them to Claude Code</label></div>
          <div id="gh-found"></div>
        </div>
      </div>
      <div class="sg"><div id="skills-installed"></div></div>
    </div>`;
  // tabs
  for (const b of box.querySelectorAll(".set-tabs button")) b.onclick = () => {
    aiTab = b.dataset.tab;
    for (const x of box.querySelectorAll(".set-tabs button")) x.classList.toggle("on", x === b);
    for (const p of box.querySelectorAll(".ai-pane")) p.hidden = p.dataset.pane !== aiTab;
  };
  // providers: the list and the chosen one's settings
  const showProv = (id) => {
    provSel = id;
    for (const r of box.querySelectorAll(".pl-row")) { r.classList.toggle("on", r.dataset.p === id); r.setAttribute("aria-selected", r.dataset.p === id); }
    renderProvDetail(box.querySelector(".prov-detail"), id, () => {
      const r = box.querySelector(`.pl-row[data-p="${id}"]`);
      r.querySelector(".pl-dot").classList.toggle("ok", provOn(id));
      r.querySelector(".pl-meta").textContent = provMeta(id);
      fillRoles(); refreshModelSelect();
    });
  };
  for (const r of box.querySelectorAll(".pl-row")) r.onclick = () => showProv(r.dataset.p);
  const fillRoles = (fillRolesRef = () => {
    for (const s of box.querySelectorAll(".m-role")) {
      const role = s.dataset.role, chatRole = role === "chat";
      s.innerHTML = chatRole ? "" : `<option value="">${role === "library" ? "Same as summaries" : `Same as chat${role === "inline" && isCCModel(modelFor("chat")) ? " (off with Claude Code — pick one to use it)" : ""}`}</option>`;
      // Claude Code works for every role (completion only when picked for it explicitly)
      fillModelOptions(s, { claudeCode: true });
      if (chatRole && !s.childElementCount) s.innerHTML = `<option value="">Turn on Claude Code or a provider first</option>`;
      s.value = settings[`aiModel_${role}`] || (chatRole ? modelFor("chat") || "" : "");
      if (s.selectedIndex < 0) s.value = chatRole ? (modelFor("chat") || "") : "";
      s.onchange = async () => {
        let v = s.value;
        if (v === "claudecode|__other") { v = await askCustomCCModel(); if (!v) { s.value = settings[`aiModel_${role}`] || ""; return; } }
        updateSettings({ [`aiModel_${role}`]: v });
        fillRoles(); refreshModelSelect();
      };
    }
  });
  fillRoles();
  showProv(provSel);
  // plain settings
  for (const inp of box.querySelectorAll("input[name], select[name]")) {
    if (inp.tagName === "SELECT") inp.value = settings[inp.name] || (inp.name === "aiEffort" ? "" : "none");
    inp.onchange = () => {
      const v = inp.type === "checkbox" ? inp.checked : inp.type === "number" ? +inp.value : inp.value;
      updateSettings({ [inp.name]: v });
      if (inp.name === "aiSearchBackend") renderAISettings();
      if (inp.name === "aiInlineEnabled" || inp.name === "avoidLint") import("./ai-inline.js").then((m) => m.settingsChanged());
      if (inp.name === "skillUseOwn") scanSkills();
      if (inp.name === "aiWeb" || inp.name === "aiEffort") refreshModelSelect();
    };
  }
  const sk = box.querySelector("#search-key");
  if (sk) { api.getSecret(searchKeyName).then((k) => { if (k) sk.value = k; }); sk.onchange = () => api.setSecret(searchKeyName, sk.value.trim()); }
  // skills folders
  const sf = box.querySelector("#skill-folders");
  for (const f of settings.skillFolders || []) {
    const row = document.createElement("div");
    row.className = "folder-row";
    row.innerHTML = `${ic("folder")}<span class="mono"></span><button type="button" class="icon small" title="Remove">${ic("x")}</button>`;
    row.querySelector("span").textContent = f;
    row.querySelector("button").onclick = () => { updateSettings({ skillFolders: (settings.skillFolders || []).filter((x) => x !== f) }); renderAISettings(); scanSkills(); };
    sf.appendChild(row);
  }
  sf.hidden = !(settings.skillFolders || []).length;
  box.querySelector("#add-skill-folder").onclick = async () => {
    const p = await api.pickFolder("Choose a folder with skills or style guides");
    if (!p) return;
    updateSettings({ skillFolders: [...new Set([...(settings.skillFolders || []), p])] });
    renderAISettings();
    const list = await scanSkills();
    toast(`${list.length} skill(s) found`, "ok", 2500);
  };
  box.querySelector("#choose-skills").onclick = async () => { await scanSkills(); openSkillsDialog(); };
  renderGithubSkills(box);
  box.querySelector("#open-own-skills").onclick = async (e) => { e.preventDefault(); api.openPath(await call("skills_own_dir")); };
}

/** The settings of one provider, under the list. */
function renderProvDetail(el, id, changed) {
  if (id === "claudecode") {
    el.innerHTML = `<div class="sg prov-card"><h3 class="set-h sg-h">Claude Code</h3><div id="cc-settings"></div></div>`;
    import("./claude-code.js").then((m) => m.renderCCSettings(changed));
    return;
  }
  const p = PRESETS.find((x) => x.id === id);
  const c = provCfg(id);
  el.innerHTML = `
    <div class="sg prov-card"><h3 class="set-h sg-h">${esc(p.name)}</h3>
      <label class="check"><input type="checkbox" class="p-en" ${c.enabled ? "checked" : ""}> Use ${esc(p.name)}</label>
      <label>API key${p.optionalKey ? " (optional)" : ""} <input class="p-key" type="password" autocomplete="off" placeholder="${p.keyUrl ? "Paste key" : "Leave empty if your server has no key"}"></label>
      <label>Base URL <input class="p-url" type="text" value="${esc(c.baseUrl || p.baseUrl)}" placeholder="https://…/v1"></label>
      <label>Add a model by name <input class="p-addmodel" type="text" placeholder="A model id the list doesn't show"></label>
      <div class="row">
        <button type="button" class="p-models primary">Load models</button>
        ${p.keyUrl ? `<button type="button" class="p-getkey" data-url="${p.keyUrl}">Get a key ↗</button>` : ""}
        <span class="p-status note">${(c.models || []).length ? `${c.models.length} models` : ""}</span>
      </div>
      ${(c.models || []).length ? `<details class="adv"><summary>Models (${c.models.length})</summary><div class="pick-list compact p-mlist">${c.models.map((m) => `<div class="folder-row"><span class="mono">${esc(m)}</span></div>`).join("")}</div></details>` : ""}
    </div>`;
  api.getSecret(`ai-key-${id}`).then((k) => { if (k) el.querySelector(".p-key").value = k; }).catch(() => {});
  el.querySelector(".p-en").onchange = (e) => { setProv(id, { enabled: e.target.checked }); changed(); };
  el.querySelector(".p-url").onchange = (e) => setProv(id, { baseUrl: e.target.value.trim() });
  el.querySelector(".p-key").onchange = async (e) => { await api.setSecret(`ai-key-${id}`, e.target.value.trim()); toast("Key saved", "ok", 1500); };
  el.querySelector(".p-getkey")?.addEventListener("click", (e) => api.openUrl(e.currentTarget.dataset.url));
  el.querySelector(".p-models").onclick = async () => {
    const st = el.querySelector(".p-status");
    st.textContent = "Loading…"; st.className = "p-status note";
    try {
      const ms = await api.aiListModels(providerFor(id));
      setProv(id, { enabled: true, models: ms.map((m) => m.id) });
      changed(); renderProvDetail(el, id, changed);
      el.querySelector(".p-status").textContent = `${ms.length} models`; el.querySelector(".p-status").className = "p-status note ok";
    } catch (e) { st.textContent = e.message; st.className = "p-status note err"; }
  };
  el.querySelector(".p-addmodel").onchange = (e) => {
    const m = e.target.value.trim(); if (!m) return;
    setProv(id, { enabled: true, models: [...new Set([m, ...(provCfg(id).models || [])])] });
    changed(); renderProvDetail(el, id, changed);
  };
}

// ---------------- skills from GitHub ----------------
function renderGithubSkills(box) {
  const url = box.querySelector("#gh-url"), found = box.querySelector("#gh-found"), btn = box.querySelector("#gh-find");
  const share = () => settings.skillsShareClaude !== false;
  const done = async (r) => {
    const parts = [];
    if (r.installed.length) parts.push(`installed ${r.installed.join(", ")}`);
    if (r.updated.length) parts.push(`updated ${r.updated.join(", ")}`);
    if (r.unchanged.length) parts.push(`${r.unchanged.join(", ")} already up to date`);
    toast(parts.join(" · ") || "Done", "ok", 4000);
    if (r.failed?.length) toast(`Not installed: ${r.failed.join("; ")}`, "err", 8000);
    found.innerHTML = ""; url.value = "";
    await scanSkills();
    renderInstalled();
  };
  const go = async () => {
    const link = url.value.trim();
    if (!link) return url.focus();
    btn.disabled = true; btn.textContent = "Looking…";
    found.innerHTML = "";
    try {
      const r = await api.skillsGithubInspect(link);
      if (r.skills.length === 1) {
        btn.textContent = "Installing…";
        return await done(await api.skillsGithubInstall(link, [r.skills[0].path], share()));
      }
      found.innerHTML = `<div class="note">${r.skills.length} skills in ${esc(r.source)} — choose which to install:</div><div class="gh-list"></div>
        <div class="row"><button type="button" class="small" id="gh-all">Select all</button><button type="button" class="small" id="gh-none">None</button><span class="tb-spacer"></span><button type="button" class="primary small" id="gh-install">Install selected</button></div>`;
      const list = found.querySelector(".gh-list");
      for (const s of r.skills) {
        const row = document.createElement("label");
        row.className = "skill-row";
        row.innerHTML = `<input type="checkbox" checked><span><b></b><small></small></span>`;
        row.querySelector("input").value = s.path;
        row.querySelector("b").textContent = s.name;
        row.querySelector("small").textContent = (s.description || s.path).slice(0, 220);
        list.appendChild(row);
      }
      found.querySelector("#gh-all").onclick = () => list.querySelectorAll("input").forEach((i) => (i.checked = true));
      found.querySelector("#gh-none").onclick = () => list.querySelectorAll("input").forEach((i) => (i.checked = false));
      found.querySelector("#gh-install").onclick = async (e) => {
        const paths = [...list.querySelectorAll("input:checked")].map((i) => i.value);
        if (!paths.length) return toast("Choose at least one skill", "", 2000);
        e.target.disabled = true; e.target.textContent = "Installing…";
        try { await done(await api.skillsGithubInstall(link, paths, share())); }
        catch (err) { toast(err.message, "err", 6000); e.target.disabled = false; e.target.textContent = "Install selected"; }
      };
    } catch (e) { found.innerHTML = `<div class="note err"></div>`; found.firstChild.textContent = e.message; }
    finally { btn.disabled = false; btn.textContent = "Install"; }
  };
  btn.onclick = go;
  url.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
  renderInstalled();
}

async function renderInstalled() {
  const box = $("#skills-installed");
  if (!box) return;
  let list = [];
  try { list = await api.skillsInstalled(); } catch {}
  if (!list.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<h3 class="set-h sg-h">Installed from GitHub <small class="note">${list.length}</small></h3><div class="inst-head">${list.length > 6 ? `<input type="search" id="sk-filter" placeholder="Filter installed skills…">` : "<span></span>"}<button type="button" class="small" id="sk-update-all">Check for updates</button></div><div class="pick-list inst-list"></div>`;
  const listEl = box.querySelector(".inst-list");
  const filter = box.querySelector("#sk-filter");
  if (filter) filter.oninput = () => { const q = filter.value.trim().toLowerCase(); for (const r of listEl.children) r.hidden = !!q && !r.textContent.toLowerCase().includes(q); };
  for (const s of list) {
    const row = document.createElement("div");
    row.className = "folder-row inst-row";
    row.innerHTML = `<span><b></b> <small class="note"></small></span><button type="button" class="small sk-up" title="Download the latest version">Update</button><button type="button" class="icon small sk-rm" title="Remove">${ic("x")}</button>`;
    row.querySelector("b").textContent = s.name;
    row.querySelector("small").textContent = `${s.repo}${s.path ? "/" + s.path : ""}${s.claudeCode ? " · also in Claude Code" : ""}`;
    row.querySelector(".sk-up").onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = "…";
      try { const r = await api.skillsUpdate(s.folder); toast(r.updated.length ? `${s.name} updated` : `${s.name} is up to date`, "ok", 2500); scanSkills(); }
      catch (err) { toast(err.message, "err", 5000); }
      e.target.disabled = false; e.target.textContent = "Update";
    };
    row.querySelector(".sk-rm").onclick = async () => {
      const ok = await ask({ title: `Remove ${s.name}?`, text: s.claudeCode ? "It is removed from Callio and from Claude Code." : "", buttons: [{ label: "Cancel", value: null }, { label: "Remove", value: "go", primary: true }] });
      if (!ok) return;
      try { await api.skillsRemove(s.folder); } catch (err) { toast(err.message, "err"); }
      await scanSkills(); renderInstalled();
    };
    listEl.appendChild(row);
  }
  box.querySelector("#sk-update-all").onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = "Checking…";
    try { const r = await api.skillsUpdate(); toast(r.updated.length ? `Updated: ${r.updated.join(", ")}` : "All skills are up to date", "ok", 4000); await scanSkills(); }
    catch (err) { toast(err.message, "err", 6000); }
    e.target.disabled = false; e.target.textContent = "Check for updates";
  };
}

// ---------------- init ----------------
export function initAI() {
  $("#btn-ai").onclick = () => toggleAIPanel();
  $("#ai-sess-btn").onclick = (e) => { e.stopPropagation(); openSessMenu(); };
  $("#ai-files").onclick = (e) => { const b = e.target.closest(".af-tag"); if (b) openPath(b.dataset.path); };
  $("#ai-sess-new").onclick = () => { closeSessMenu(); newChat(); };
  document.addEventListener("click", (e) => { if (!e.target.closest("#ai-sess-menu, #ai-sess-btn, #dlg-prompt")) closeSessMenu(); });
  window.addEventListener("callio-folder", onProjectChanged);
  chat.project = sessProject();
  renderSessBar();
  $("#ai-close").onclick = () => toggleAIPanel(false);
  $("#ai-send").onclick = () => send();
  $("#ai-stop").onclick = () => { if (chat.stop) return chat.stop(); for (const id of handlers.keys()) if (id.startsWith("chat")) cancelAI(id); };
  $("#ai-mode").onclick = () => import("./claude-code.js").then((m) => { m.cycleMode(); refreshModelSelect(); });
  $("#ai-text").addEventListener("keydown", (e) => {
    if (slashKey(e)) return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  $("#ai-text").addEventListener("input", () => updateSlash());
  $("#ai-text").addEventListener("blur", () => setTimeout(closeSlash, 150));
  $("#ai-effort").onchange = (e) => updateSettings({ aiEffort: e.target.value });
  $("#ai-model").onchange = async (e) => {
    let v = e.target.value;
    if (!v) return openAISettings();
    if (v === "claudecode|__other") { v = await askCustomCCModel(); if (!v) return refreshModelSelect(); }
    // switching between Claude Code and another model starts Claude Code's side fresh
    if (isCCModel(v) !== isCCModel(settings.aiModel_chat)) chat.cc = { id: null };
    updateSettings({ aiModel_chat: v });
    refreshModelSelect(); refreshRoleSelects();
    offerContinue();
  };
  $("#ai-engine").onclick = engineMenu;
  $("#ai-web").onclick = () => { updateSettings({ aiWeb: settings.aiWeb === false }); refreshModelSelect(); toast(settings.aiWeb !== false ? "AI may use the internet" : "AI internet access off", "", 1800); };
  $("#ai-skill-chip").onclick = async () => { await scanSkills(); openSkillsDialog(); };
  $("#skills-close").onclick = () => $("#dlg-skills").close();
  $("#bib-close").onclick = () => $("#dlg-bib").close();
  document.addEventListener("click", (e) => {
    const a = e.target.closest("#ai-panel a[data-url], #dlg-bib a[data-url], #ai-settings a[data-url]");
    if (a) { e.preventDefault(); api.openUrl(a.dataset.url); }
  });
  const more = $("#ai-more").parentElement.querySelector(".menu");
  more.addEventListener("click", (e) => {
    const b = e.target.closest("[data-ai]"); if (!b) return;
    more.hidden = true;
    ({ new: newChat, "verify-bib": () => verifyBib(), skills: async () => { await scanSkills(); openSkillsDialog(); }, memory: openMemoryDialog, settings: openAISettings })[b.dataset.ai]?.();
  });
  // selection action menu
  const am = $("#ai-actions");
  am.addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (b) { am.hidden = true; runAction(b.dataset.act); } });
  am.addEventListener("keydown", (e) => {
    const items = [...am.querySelectorAll("button")]; const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === "Escape") { am.hidden = true; getView()?.focus(); }
  });
  document.addEventListener("pointerdown", (e) => { if (!e.target.closest("#ai-actions, #ai-sel-btn")) am.hidden = true; });
  $("#ai-working button").onclick = () => { for (const id of handlers.keys()) if (id.startsWith("edit")) cancelAI(id); };
  // review bar
  setReviewHooks({
    onChange: (n) => { const b = $("#review-bar"); b.hidden = n === 0; b.querySelector("span").textContent = `AI suggestion — ${n} change${n === 1 ? "" : "s"} to review`; },
    onEnd: (accepted) => { $("#review-bar").hidden = true; status(accepted ? "AI changes kept" : "AI changes discarded", accepted ? "ok" : ""); },
  });
  $("#review-accept").onclick = () => endReview(true);
  $("#review-reject").onclick = () => endReview(false);
  if (settings.aiPanel) toggleAIPanel(true);
  // skills are scanned lazily (first use), not at startup
  setTimeout(() => scanSkills(), 3000);
}

export { renderContext as refreshAIContext };
