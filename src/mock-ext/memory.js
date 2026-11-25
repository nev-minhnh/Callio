// Dev/test mock for the memory track: Obsidian detection and install, the vault (with the same
// folder rules as src-tauri/src/vaultscope.rs), MEMORY.md and notes, and data storage with its move.
// Tests steer it with window.__memMock = { scenario: "detected" | "missing", ... }.
import { invoke, emit } from "../mock.js";
import * as core from "../memory-core.js";

const M = (window.__memMock ||= { scenario: "detected", installDelay: 120, moveDelay: 120 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXE = "C:\\Users\\Minh\\AppData\\Local\\Programs\\Obsidian\\Obsidian.exe";
const sha = (s) => { let h = 5381; for (const c of String(s)) h = ((h << 5) + h + c.charCodeAt(0)) | 0; return "h" + (h >>> 0).toString(16); };
const norm = (p) => p.replace(/\\/g, "/");

// ---- the vault on "disk" ----
const vaults = { "D:/Notes/Research": new Map(), "C:/Users/Minh/Documents/Personal": new Map(), "D:/Notes/Callio Notes": new Map() };
const put = (v, rel, text) => vaults[v].set(rel, { text, mtime: Date.now() });
put("D:/Notes/Research", "Papers/gliner-notes.md", "# GLiNER notes\nSpan-based NER; zero-shot labels. See zaratiana2024gliner.\n");
put("D:/Notes/Research", "Papers/bert.md", "# BERT\nBidirectional encoder.\n");
put("D:/Notes/Research", "Thesis/outline.md", "# Thesis outline\n1. Extremist rhetoric categories\n2. NER extraction\n");
put("D:/Notes/Research", "Private/diary.md", "# Diary\nNot for the AI.\n");
put("D:/Notes/Research", "Inbox/todo.md", "# Todo\n");
put("D:/Notes/Research", ".obsidian/app.json", "{}");
const history = [];

// ---- the same rules as vaultscope.rs ----
function normalizeRel(rel) {
  const r = String(rel || "").trim().replace(/\\/g, "/");
  if (!r) throw new Error("Empty path");
  if (r.startsWith("/") || r.includes(":")) throw new Error("Only paths inside the vault are allowed");
  const out = [];
  for (const c of r.split("/")) {
    if (c === "" || c === ".") continue;
    if (c === "..") throw new Error("Paths can't go up out of a folder");
    if (/[. ]$/.test(c) || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(c.split(".")[0])) throw new Error("This name isn't allowed on Windows");
    if (c.toLowerCase() === ".obsidian") throw new Error("The .obsidian folder (settings and plugins) is off limits");
    out.push(c);
  }
  if (!out.length) throw new Error("Empty path");
  return out.join("/");
}
const cleanFolder = (f) => { try { return normalizeRel(String(f).replace(/^[/\\]+|[/\\]+$/g, "")).toLowerCase(); } catch { return null; } };
function scopeOf(o) {
  if (!o?.vaultPath) throw new Error("No Obsidian vault is connected (Settings › AI memory).");
  const cd = cleanFolder(o.callioDir || "Callio") || "callio";
  const withCd = (fs) => [...new Set([...(fs || []).map(cleanFolder).filter(Boolean), cd])];
  const read = o.read?.mode === "all" ? "all" : withCd(o.read?.folders);
  const wm = o.write?.mode || "callio";
  const write = wm === "all" ? "all" : wm === "none" ? "none" : wm === "folders" ? withCd(o.write?.folders) : [cd];
  return { vault: norm(o.vaultPath), cd, read, write };
}
const allows = (a, rel) => a === "all" || (a !== "none" && a.some((f) => rel.toLowerCase() === f || rel.toLowerCase().startsWith(f + "/")));
function checkRead(o, rel) { const s = scopeOf(o); const r = normalizeRel(rel); if (!allows(s.read, r)) throw new Error(`“${r}” is outside the folders Callio may read in this vault (Settings › AI memory › Permissions).`); return [s, r]; }
function checkWrite(o, rel) { const s = scopeOf(o); const r = normalizeRel(rel); if (s.write === "none") throw new Error("Callio isn't allowed to write in this vault (Settings › AI memory › Permissions)."); if (!allows(s.write, r)) throw new Error(`“${r}” is outside the folders Callio may write in this vault (Settings › AI memory › Permissions).`); return [s, r]; }
const cliAllows = (level, c) => {
  const READ = ["version", "help", "vault", "vaults", "search", "search:context", "read", "open", "file", "files", "folder", "folders", "tags", "links", "backlinks", "outline", "properties"];
  const WRITE = ["create", "append", "prepend", "daily", "daily:append", "property:set", "property:remove"];
  return level === "all" ? !!c : level === "write" ? READ.includes(c) || WRITE.includes(c) : READ.includes(c);
};

// ---- MEMORY.md and notes ----
const plain = new Map(); // abs path → {text, mtime}
async function cfg() { return (await invoke("load_settings")) || {}; }
const baseName = (p) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Project";
async function target(project, kind, date, title) {
  const st = await cfg(), o = st.obsidian;
  if (st.memoryStore === "obsidian" && o?.vaultPath) {
    const P = core.notePaths(o, project, date || "", title || "");
    const rel = kind === "session" ? P.session : P.project;
    let r; try { r = checkRead(o, rel); } catch { r = checkWrite(o, rel); }
    return { vault: true, o, rel: r[1], path: `${norm(o.vaultPath)}/${r[1]}` };
  }
  if (kind === "session") throw new Error("Session notes are only kept in an Obsidian vault.");
  const path = st.memoryMdLocation === "project" ? `${norm(project)}/MEMORY.md` : `C:/Users/Minh/AppData/Local/Callio/memory/${sha(norm(project).toLowerCase())}/MEMORY.md`;
  return { vault: false, path };
}
const store = (t) => (t.vault ? vaults[norm(t.o.vaultPath)] : null);
const readT = (t) => { const e = t.vault ? store(t)?.get(t.rel) : plain.get(t.path); return e ? { text: e.text, sha: sha(e.text) } : null; };
function writeT(t, text, expected, project) {
  const cur = readT(t);
  if (cur && expected != null && cur.sha !== expected) throw new Error(`CHANGED: ${t.rel || "MEMORY.md"} was changed on disk (for example in Obsidian) after Callio read it. Nothing was written.`);
  if (cur) history.push({ path: t.path, text: cur.text, label: "Before an AI memory update" });
  const e = { text, mtime: Date.now() };
  if (t.vault) { checkWrite(t.o, t.rel); (store(t) || new Map()).set(t.rel, e); } else plain.set(t.path, e);
  return sha(text);
}
M.files = plain; M.vaults = vaults; M.history = history;

// ---- storage ----
const GB = 1024 ** 3, MB = 1024 ** 2;
const CATS = [
  { id: "library", label: "Paper library", folders: ["library"], size: 3.2 * GB },
  { id: "versions", label: "Versions & backups", folders: ["history", "backups", "pdf-backups"], size: 820 * MB },
  { id: "memory", label: "AI memory & session journals", folders: ["memory", "cc-sessions"], size: 140 * MB },
  { id: "drafts", label: "Unsaved drafts", folders: ["drafts"], size: 4 * MB },
  { id: "csl", label: "Citation styles", folders: ["csl"], size: 22 * MB },
  { id: "tools", label: "Tools Callio installed", folders: ["bin", "TinyTeX", "tesseract", "tessdata", "downloads"], size: 1.9 * GB },
  { id: "skills", label: "Skills & Claude Code copies", folders: ["skills", "claude-code"], size: 310 * MB },
];
const SM = (M.storage ||= { dataDir: "C:\\Users\\Minh\\AppData\\Local\\dev.callio.editor", portable: false, problems: [], cleanup: [], portableOffer: false, noData: false, moved: {}, freeD: 410 * GB, freeC: 38 * GB, busy: null, fail: false });

export async function handle(cmd, a) {
  switch (cmd) {
    // ---------- Obsidian ----------
    case "obs_detect": {
      const installed = M.scenario !== "missing" || M.installed;
      return {
        installed, exe: installed ? EXE : null, dir: installed ? EXE.replace(/\\Obsidian\.exe$/, "") : null, version: installed ? "1.12.7" : null, running: !!M.running,
        vaults: installed || M.vaultsKnown ? [
          { id: "a1b2c3d4e5f60718", path: "D:\\Notes\\Research", name: "Research", ts: 1790000000000, open: true, exists: true },
          { id: "0f9e8d7c6b5a4938", path: "C:\\Users\\Minh\\Documents\\Personal", name: "Personal", ts: 1780000000000, open: false, exists: true },
        ] : [],
        cli: { exe: installed ? EXE.replace("Obsidian.exe", "Obsidian.com") : null },
        defaultVaultPath: "D:\\Notes\\Callio Notes",
      };
    }
    case "obs_vault_info": {
      const p = norm(a.path).toLowerCase();
      const sync = p.includes("onedrive") ? "onedrive" : p.includes("dropbox") ? "dropbox" : p.includes("/notes/research") ? (M.sync || "onedrive") : "unknown";
      return { exists: true, sync, hasCallio: !!M.hasCallio };
    }
    case "obs_cli_test": return M.cliOn ? { ok: true, version: "1.12.7" } : { ok: false, error: "The command line interface is off. In Obsidian: Settings → General → Command line interface." };
    case "obs_setup_vault": {
      const vi = !!a.vi, fn = core.folderNames(vi);
      M.setup = { path: a.path, vi, register: a.register };
      if (a.register && M.running) return { vaultId: null, needsClose: true, folderNames: fn, callioDir: a.callioDir || "Callio" };
      return { vaultId: a.register ? "c0ffee1234567890" : null, needsClose: false, folderNames: fn, callioDir: a.callioDir || "Callio" };
    }
    case "obs_install": {
      M.installCancel = false; M.installCalls = (M.installCalls || 0) + 1;
      const steps = [["download", "Downloading Obsidian 1.12.7…", "Downloaded Obsidian 1.12.7"], ["verify", "Checking the download…", "Checked: checksum and signature"], ["install", "Installing Obsidian for you only…", "Installed Obsidian 1.12.7"], ["vault", "Creating the vault and registering it with Obsidian…", "Vault created and registered"]];
      for (const [s, run, done] of steps) {
        emit("obs-install", { step: s, state: "run", pct: 0, text: run });
        for (const p of s === "download" ? [20, 55, 90] : [50]) { await sleep(M.installDelay); if (M.installCancel) { emit("obs-install", { step: s, state: "fail", text: "Cancelled" }); throw new Error("Cancelled"); } emit("obs-install", { step: s, state: "run", pct: p, text: run }); }
        if (M.failAt === s) { emit("obs-install", { step: s, state: "fail", text: "The download doesn't match the checksum GitHub published for it; it was deleted." }); throw new Error("The download doesn't match the checksum GitHub published for it; it was deleted."); }
        emit("obs-install", { step: s, state: "done", pct: 100, text: done });
      }
      M.installed = true; M.vaultsKnown = true;
      return { exe: EXE, version: "1.12.7", vaultPath: a.vaultPath, cliExe: EXE.replace("Obsidian.exe", "Obsidian.com"), vaultName: baseName(a.vaultPath), vaultId: M.running ? null : "c0ffee1234567890", needsClose: !!M.running, folderNames: core.folderNames(!!a.vi), callioDir: "Callio" };
    }
    case "obs_install_cancel": M.installCancel = true; return null;
    case "obs_open": M.opened = a.file || ""; return null;
    case "obs_cli": {
      const st = await cfg(), o = st.obsidian || {};
      const c = (a.args || []).find((x) => !x.includes("=") && !x.startsWith("-")) || "";
      if (!cliAllows(o.cliLevel || "read", c)) throw new Error(`“${c}” isn't allowed at the CLI level you chose (Settings › AI memory › Permissions).`);
      return { ok: true, stdout: "", stderr: "" };
    }
    // ---------- vault ----------
    case "vault_read": {
      const o = (await cfg()).obsidian; const [s, r] = checkRead(o, a.path);
      const e = vaults[s.vault]?.get(r); return e ? { exists: true, text: e.text, sha: sha(e.text), mtime: e.mtime } : { exists: false };
    }
    case "vault_write": {
      const o = (await cfg()).obsidian; const [s, r] = checkWrite(o, a.path);
      const cur = vaults[s.vault]?.get(r);
      if (cur && a.expectedSha != null && sha(cur.text) !== a.expectedSha) throw new Error(`CHANGED: ${r} was changed on disk (for example in Obsidian) after Callio read it. Nothing was written.`);
      if (cur) history.push({ path: `${s.vault}/${r}`, text: cur.text, label: "Before an AI memory update" });
      (vaults[s.vault] ||= new Map()).set(r, { text: a.text, mtime: Date.now() });
      return { sha: sha(a.text) };
    }
    case "vault_list": {
      const o = (await cfg()).obsidian; const s = scopeOf(o);
      const dir = a.dir ? normalizeRel(a.dir) : "";
      if (dir) checkRead(o, dir);
      const seen = new Map();
      for (const k of vaults[s.vault]?.keys() || []) {
        if (k.startsWith(".")) continue;
        if (dir && !k.startsWith(dir + "/")) continue;
        const rest = dir ? k.slice(dir.length + 1) : k; const name = rest.split("/")[0]; const isDir = rest.includes("/");
        const child = dir ? `${dir}/${name}` : name;
        if (allows(s.read, child) || (!dir && s.read !== "all" && s.read.some((f) => f.startsWith(child.toLowerCase())))) seen.set(name, { name, path: child, isDir });
      }
      return { entries: [...seen.values()] };
    }
    case "vault_search": {
      const o = (await cfg()).obsidian; const s = scopeOf(o);
      const words = String(a.query || "").toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const hits = [];
      for (const [k, e] of vaults[s.vault] || []) {
        if (k.startsWith(".") || !allows(s.read, k)) continue;
        const score = words.reduce((n, w) => n + (e.text.toLowerCase().includes(w) ? 1 : 0), 0);
        if (score) hits.push({ path: k, score, snippet: e.text.replace(/\s+/g, " ").slice(0, 160) });
      }
      return { hits: hits.sort((x, y) => y.score - x.score).slice(0, a.limit || 8) };
    }
    case "list_dir": {
      const p = norm(a.path || "");
      const root = Object.keys(vaults).find((v) => p.toLowerCase() === v.toLowerCase());
      if (!root) return undefined;
      const names = new Set(); for (const k of vaults[root].keys()) if (!k.startsWith(".") && k.includes("/")) names.add(k.split("/")[0]);
      return [...names].sort().map((n) => ({ path: `${root}/${n}`, name: n, isDir: true }));
    }
    // ---------- memory notes ----------
    case "memnotes_get": {
      const t = await target(a.project, a.kind || "project", a.date, a.title); const cur = readT(t);
      return { store: t.vault ? "obsidian" : "callio", path: t.path.replace(/\//g, "\\"), rel: t.rel || null, exists: !!cur, text: cur?.text ?? (a.kind === "session" ? "" : core.template(baseName(a.project), a.project, t.vault)), sha: cur?.sha ?? null };
    }
    case "memnotes_write": {
      const t = await target(a.project, a.kind || "project", a.date, a.title);
      let text = a.text; if (t.vault && (a.kind || "project") === "project" && !text.includes(`"${a.project.replace(/\\/g, "\\\\")}"`) && text.startsWith("---\n")) text = text.replace("projects:\n", `projects:\n  - "${a.project.replace(/\\/g, "\\\\")}"\n`);
      const s = writeT(t, text, a.expectedSha, a.project); return { sha: s, path: t.path };
    }
    case "memnotes_remember": {
      const t = await target(a.project, "project"); const cur = readT(t);
      const base = cur?.text ?? core.template(baseName(a.project), a.project, t.vault);
      const next = core.appendToSection(base, "Remember", a.text);
      if (cur && next === base) return { sha: cur.sha, unchanged: true };
      return { sha: writeT(t, next, cur?.sha, a.project), path: t.path };
    }
    case "memnotes_delete": {
      const t = await target(a.project, a.kind || "project", a.date, a.title); const cur = readT(t);
      if (!cur) return null;
      if (cur.sha !== a.expectedSha) throw new Error("CHANGED: the note was changed after Callio wrote it, so it was left alone.");
      history.push({ path: t.path, text: cur.text, label: "Before undoing an AI memory update" });
      if (t.vault) store(t).delete(t.rel); else plain.delete(t.path);
      return null;
    }
    case "memnotes_prompt": {
      let t; try { t = await target(a.project, "project"); } catch { return ""; }
      const cur = readT(t); if (!cur || !/^\s*- /m.test(core.stripFrontmatter(cur.text))) return "";
      return `# Project memory — ${t.vault ? "the project note in the author's Obsidian vault" : "MEMORY.md"}\nThe author's curated notes for this project. Use them as background.\n\n${core.cap(cur.text)}`;
    }
    case "ai_chat": {
      if (!a.req.id.startsWith("summary") || M.summaryText == null) return undefined;
      M.summaryReqs = (M.summaryReqs || 0) + 1; M.lastSummaryReq = a.req;
      emit("ai-event", { id: a.req.id, kind: "text", text: M.summaryText });
      emit("ai-event", { id: a.req.id, kind: "done" });
      return M.summaryText;
    }
    // ---------- storage ----------
    case "storage_status": return { dataDir: SM.dataDir, portable: SM.portable, problems: SM.problems, noData: SM.noData, cleanup: SM.cleanup, portableOffer: SM.portableOffer, defaultDir: "C:\\Users\\Minh\\AppData\\Local\\dev.callio.editor" };
    case "storage_info": return {
      dataDir: SM.dataDir, defaultDir: "C:\\Users\\Minh\\AppData\\Local\\dev.callio.editor", portable: SM.portable,
      categories: CATS.map((c) => ({ id: c.id, label: c.label, folders: c.folders, present: c.folders.slice(0, 1), size: c.size, where: SM.moved[c.id] || "C:", movable: true })),
      drives: [{ drive: "C:", free: SM.freeC, total: 237 * GB }, ...(Object.keys(SM.moved).length ? [{ drive: "D:", free: SM.freeD, total: 931 * GB }] : [])],
      stays: ["C:\\Users\\Minh\\AppData\\Roaming\\dev.callio.editor"],
    };
    case "storage_check_dest": {
      const need = CATS.filter((c) => a.ids.includes(c.id)).reduce((n, c) => n + c.size, 0);
      if (!a.dest || !/^[A-Za-z]:\\/.test(a.dest)) return { ok: false, error: "Choose a folder (a full path such as D:\\Callio data)." };
      if (SM.busy) return { ok: false, busy: SM.busy, error: SM.busy };
      if (need > SM.freeD) return { ok: false, need, free: SM.freeD, error: "There isn't enough free space on that drive for the selected data." };
      return { ok: true, need, free: SM.freeD, useExisting: M.useExisting || [] };
    }
    case "storage_move": {
      M.moveCancel = false; emit("callio-storage-moving", { moving: true }); M.moveEvents = (M.moveEvents || 0) + 1;
      const total = CATS.filter((c) => a.ids.includes(c.id)).reduce((n, c) => n + c.size, 0);
      for (const phase of ["copy", "verify"]) for (let i = 1; i <= 4; i++) {
        await sleep(M.moveDelay);
        if (M.moveCancel) { emit("callio-storage-moving", { moving: false }); throw new Error("Cancelled"); }
        if (SM.fail && phase === "verify" && i === 2) { emit("callio-storage-moving", { moving: false }); throw new Error("Verification failed: D:\\Callio data\\library\\x.pdf was not copied correctly."); }
        emit("callio-storage-progress", { phase, done: Math.round(total * (i / 4)) + (phase === "verify" ? total : 0), total: total * 2, files: i * 120, filesTotal: 480, file: phase === "copy" ? "paper-0042.pdf" : "paper-0100.pdf" });
      }
      for (const id of a.ids) SM.moved[id] = a.dest.slice(0, 2);
      SM.lastDest = a.dest; SM.lastIds = a.ids; SM.pendingCleanup = [a.dest];
      emit("callio-storage-moving", { moving: false });
      return { moved: a.ids, files: 480, bytes: total, restart: true, usedExisting: [] };
    }
    case "storage_cancel": M.moveCancel = true; return null;
    case "storage_restart": M.restarted = (M.restarted || 0) + 1; return null;
    case "storage_cleanup": { const n = SM.cleanup.length; M.cleanupAction = a.action; SM.cleanup = []; return a.action === "delete" ? 4.2 * GB : 0; }
    case "storage_use_folder": M.usedFolder = a.path; return null;
    case "storage_retry": M.retried = (M.retried || 0) + 1; if (M.driveBack) { SM.problems = []; M.restarted = (M.restarted || 0) + 1; } return !!M.driveBack;
    case "storage_open_without_data": SM.noData = true; M.openedWithoutData = true; return null;
    case "storage_portable_dismiss": SM.portableOffer = false; return null;
    case "pick_folder": if (window.__pickFolderQueue?.length) return window.__pickFolderQueue.shift(); return undefined;
  }
  return undefined;
}
