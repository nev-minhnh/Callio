// AI memory, the curated layer: one MEMORY.md per project (or, with an Obsidian vault, a project
// note and a note per session). The AI proposes the new notes when a session ends (or on
// `/memory update`); the author reviews each file as a diff and accepts or rejects it. Nothing is
// written without that review except an explicit "remember" line. All file access is in Rust
// (src-tauri/src/memnotes.rs), which checks the vault scope and saves the previous version first.
import { call } from "./api.js";
import { settings, toast } from "./main.js";
import { addVi, t } from "./i18n.js";
import * as core from "./memory-core.js";

addVi({
  "Memory updated": "Đã cập nhật bộ nhớ",
  "Memory: nothing new to add from this session.": "Bộ nhớ: phiên này không có gì mới để thêm.",
  "Couldn't update the memory: {e}": "Không cập nhật được bộ nhớ: {e}",
  "The memory update is waiting: finish what you are doing and it will open for review.": "Bản cập nhật bộ nhớ đang chờ: xong việc đang làm là bạn sẽ duyệt được.",
  "Open a folder first: memory notes belong to a project.": "Hãy mở một thư mục trước: ghi chú bộ nhớ thuộc về một dự án.",
  "Choose a model for summaries in Settings → AI first.": "Hãy chọn mô hình cho tóm tắt trong Cài đặt → AI trước.",
  "Memory update undone": "Đã hoàn tác cập nhật bộ nhớ",
  "Nothing to undo.": "Không có gì để hoàn tác.",
  "Couldn't undo: {e}": "Không hoàn tác được: {e}",
  "Memory — project note": "Bộ nhớ — ghi chú dự án",
  "Memory — session note": "Bộ nhớ — ghi chú phiên",
  "Memory — MEMORY.md": "Bộ nhớ — MEMORY.md",
  "{name} changed on disk": "{name} đã đổi trên đĩa",
  "Added": "Thêm",
  "Removed": "Xóa",
  "Accept": "Chấp nhận",
  "Not added to the memory: {e}": "Chưa thêm vào bộ nhớ: {e}",
  "The AI is writing the memory update…": "AI đang soạn bản cập nhật bộ nhớ…",
});
const tr = (k, v = {}) => t(k).replace(/\{(\w+)\}/g, (_, n) => v[n] ?? "");
const memOn = () => settings.aiMemory !== false;
const base = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Project";
export const memoryStore = () => (settings.memoryStore === "obsidian" && settings.obsidian?.vaultPath ? "obsidian" : "callio");

// MEMORY.md / the project note (capped in Rust to ~4,000 characters): goes into the system prompt
export async function memoryPrompt(project) {
  if (!memOn() || !project) return "";
  try { return (await call("memnotes_prompt", { project })) || ""; } catch { return ""; }
}
// with a vault: what the vault says about this question (only folders the AI may read)
export async function vaultRecall(project, query) {
  if (!memOn() || !project || !query || memoryStore() !== "obsidian") return "";
  try {
    const r = await call("vault_search", { query, limit: 5 });
    const lines = (r.hits || []).map((h) => `- ${h.path}: ${String(h.snippet).replace(/\s+/g, " ").slice(0, 220)}`);
    return lines.length ? `# From the author's Obsidian vault (read-only notes)\n${lines.join("\n")}`.slice(0, 1800) : "";
  } catch { return ""; }
}
/** "Remember this" lines also go to the Remember section (explicit, so no review). */
export async function rememberLine(project, text) {
  if (!memOn() || !project || !text) return false;
  try { await call("memnotes_remember", { project, text }); return true; } catch (e) { toast(tr("Not added to the memory: {e}", { e: e.message }), "warn", 5000); return false; }
}

// ---------------- the transcript of a finished session ----------------
const TRANSCRIPTS = import.meta.glob("./cc-sessions.js"); // exists once chat-core is merged
async function transcriptOf(handle) {
  try {
    const load = TRANSCRIPTS["./cc-sessions.js"];
    const m = load && (await load());
    const r = m?.getSessionTranscript && handle != null ? await m.getSessionTranscript(handle) : null;
    if (r) return normalizeTranscript(r);
  } catch {}
  return "";
}
function normalizeTranscript(r) {
  if (typeof r === "string") return r;
  const arr = Array.isArray(r) ? r : r.messages || r.turns || [];
  return arr.map((x) => `${/user|author/i.test(x.role || x.who || "") ? "Author" : "Assistant"}: ${typeof x.text === "string" ? x.text : typeof x.content === "string" ? x.content : JSON.stringify(x.content ?? "")}`).join("\n\n");
}
async function chatTranscript() {
  try { const m = await import("./ai.js"); return m.chatTranscript?.() || ""; } catch { return ""; }
}

// ---------------- proposing, reviewing, writing ----------------
const SYSTEM = (vault) => `You keep the author's project memory note up to date. You are given the current note and the transcript of a work session. Reply with exactly these parts, each starting on its own line with its marker:
===PROJECT===
the full updated note in Markdown: first line "# <project name>", then these sections in this order, each as "## <name>": ${core.SECTIONS.join(", ")}. Short bullet lines. Keep every line that is still true, add only what this session established, remove only what it made obsolete. Never invent facts, results, file names or citations. Do not touch the lines under Remember.
${vault ? "===SESSION===\nthe session note body: \"## Summary\" (2 to 4 sentences), \"## Files changed\" (bullets, only files named in the transcript), \"## Decisions\" (bullets). Nothing else." : ""}
Write in the language the author used in the transcript. No other text.`;

function parseProposal(out) {
  const m = /===PROJECT===\s*([\s\S]*?)(?:===SESSION===\s*([\s\S]*))?$/.exec(out || "");
  const strip = (s) => (s || "").replace(/^```(?:markdown|md)?\s*\n/, "").replace(/\n```\s*$/, "").trim();
  return { project: strip(m?.[1]), session: strip(m?.[2]) };
}
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function whenIdle() {
  return new Promise((res) => {
    let n = 0;
    const tick = () => { if (!document.querySelector("dialog[open]") || ++n > 300) res(); else { if (n === 1) toast(tr("The memory update is waiting: finish what you are doing and it will open for review."), "", 3500); setTimeout(tick, 1000); } };
    tick();
  });
}

function review({ title, before, after }) {
  return new Promise(async (res) => {
    const { showDiffDialog } = await import("./history.js");
    let accepted = false;
    const dlg = document.querySelector("#dlg-version");
    dlg.addEventListener("close", () => setTimeout(() => res(accepted)), { once: true });
    showDiffDialog({ title, before, after, legend: [tr("Added"), tr("Removed")], restoreLabel: tr("Accept"), onRestore: () => { accepted = true; } });
  });
}

let last = []; // what the last accepted update wrote, to undo it
let updating = false;

/** Review each changed file; write the accepted ones. Returns what was written. */
async function applyFiles(project, files) {
  const done = [];
  for (const f of files) {
    let cur = await call("memnotes_get", { project, kind: f.kind, date: f.date, title: f.title });
    if (cur.text === f.after) continue;
    let before = cur.text, ok = await review({ title: f.label, before, after: f.after });
    if (!ok) continue;
    for (let tries = 0; tries < 2; tries++) {
      try {
        const w = await call("memnotes_write", { project, kind: f.kind, date: f.date, title: f.title, text: f.after, expectedSha: cur.sha ?? "" });
        done.push({ ...f, prev: { exists: cur.exists, text: cur.text }, sha: w.sha });
        break;
      } catch (e) {
        if (!/^CHANGED/.test(e.message) || tries) { toast(tr("Couldn't update the memory: {e}", { e: e.message }), "err", 6000); break; }
        // edited elsewhere (Obsidian…) since it was read: never overwrite; show the diff against what is there now
        cur = await call("memnotes_get", { project, kind: f.kind, date: f.date, title: f.title });
        if (!(await review({ title: tr("{name} changed on disk", { name: f.label }), before: cur.text, after: f.after }))) break;
      }
    }
  }
  return done;
}

/**
 * Ask the small model for the new notes and let the author review them.
 * @param {{project: string, transcript: string, title?: string, model?: string}} s
 */
export async function proposeUpdate(s) {
  if (updating) return;
  if (!s.project) return toast(tr("Open a folder first: memory notes belong to a project."), "", 3500);
  if (!s.transcript?.trim()) return toast(tr("Memory: nothing new to add from this session."), "", 3000);
  const { runAI, modelFor } = await import("./ai.js");
  if (!modelFor("summary")) return toast(tr("Choose a model for summaries in Settings → AI first."), "warn", 4500);
  updating = true;
  try {
    const vault = memoryStore() === "obsidian";
    const date = today(), title = (s.title || "").trim() || "Session";
    const cur = await call("memnotes_get", { project: s.project, kind: "project" });
    const user = `Project: ${base(s.project)}\n\nCurrent note:\n"""\n${core.stripFrontmatter(cur.text)}\n"""\n\nSession "${title}"${s.model ? ` (model ${s.model})` : ""}:\n"""\n${s.transcript.slice(-24000)}\n"""`;
    toast(tr("The AI is writing the memory update…"), "", 2500);
    const out = await runAI("summary", { system: SYSTEM(vault), messages: [{ role: "user", content: user }], maxTokens: 3000, thinking: false, tools: false });
    const p = parseProposal(out);
    if (!p.project) return toast(tr("Memory: nothing new to add from this session."), "", 3000);
    const files = [{ kind: "project", label: tr(vault ? "Memory — project note" : "Memory — MEMORY.md"), after: core.frontmatterOf(cur.text) + core.ensureSections(p.project) }];
    if (vault && p.session) {
      const pname = core.projectNoteName(base(s.project)).replace(/\.md$/, "");
      const fm = `---\ndate: ${date}\nproject: "[[${pname}]]"\n${s.model ? `model: ${s.model}\n` : ""}tags: [callio, session]\n---\n`;
      files.push({ kind: "session", date, title, label: tr("Memory — session note"), after: `${fm}# ${title}\n\nProject: [[${pname}]]\n\n${p.session}\n` });
    }
    await whenIdle();
    const done = await applyFiles(s.project, files);
    if (done.length) { last = done.map((d) => ({ ...d, project: s.project })); toast(tr("Memory updated"), "ok", 2500); }
  } catch (e) {
    if (e.message !== "NO_MODEL") toast(tr("Couldn't update the memory: {e}", { e: e.message }), "err", 6000);
  } finally { updating = false; }
}

/** `/memory update` and the buttons: from the chat that is open now. */
export async function updateFromChat() {
  const project = await currentProject();
  await proposeUpdate({ project, transcript: await chatTranscript(), title: await chatTitle() });
}
async function currentProject() { try { return (await import("./ai.js")).memoryProject?.() || ""; } catch { return ""; } }
async function chatTitle() { try { return (await import("./ai.js")).chatTitle?.() || ""; } catch { return ""; } }

export async function undoLast() {
  if (!last.length) return toast(tr("Nothing to undo."), "", 2500);
  try {
    for (const f of [...last].reverse()) {
      if (f.prev.exists) await call("memnotes_write", { project: f.project, kind: f.kind, date: f.date, title: f.title, text: f.prev.text, expectedSha: f.sha });
      else await call("memnotes_delete", { project: f.project, kind: f.kind, date: f.date, title: f.title, expectedSha: f.sha });
    }
    last = [];
    toast(tr("Memory update undone"), "ok", 2500);
  } catch (e) { toast(tr("Couldn't undo: {e}", { e: e.message }), "err", 5000); }
}
export const hasUndo = () => last.length > 0;

// ---------------- when a Claude Code session ends ----------------
export function initMemoryNotes() {
  window.addEventListener("callio-cc-session-ended", async (ev) => {
    const d = ev.detail || {};
    // propose once per session, when it is over — not after every answer
    if (!memOn() || settings.memorySummary === "manual" || !d.project || d.final === false) return;
    const transcript = (await transcriptOf(d.handle)) || (await chatTranscript());
    proposeUpdate({ project: d.project, transcript, title: d.title, model: d.model });
  });
}
