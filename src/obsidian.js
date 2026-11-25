// Settings › AI memory (Bộ nhớ AI): where the AI's memory lives (Callio's MEMORY.md or an Obsidian
// vault), Obsidian detection / install / connection, what Callio may read and write in the vault,
// and when session summaries are written. Everything is a section of Settings, no popup.
// The vault itself is only touched by Rust commands that enforce the permissions chosen here.
import "./obsidian.css";
import { call, api, listen } from "./api.js";
import { settings, updateSettings, toast } from "./main.js";
import { addVi, t, uiLang } from "./i18n.js";
import { ic } from "./icons.js";
import { folderNames } from "./memory-core.js";

addVi({
  "Where memory lives": "Nơi lưu trí nhớ",
  "Callio memory + MEMORY.md": "Bộ nhớ của Callio + MEMORY.md",
  "Writes and recalls past turns by itself, plus one short MEMORY.md for each project.": "Tự ghi và tự gợi lại các lượt cũ, cộng một tệp MEMORY.md gọn cho mỗi dự án.",
  "Obsidian vault": "Kho Obsidian",
  "The project note and a summary of each session live in the vault; open them with Obsidian.": "Ghi chú dự án và tóm tắt mỗi phiên nằm trong kho; mở xem được bằng Obsidian.",
  "Where MEMORY.md is kept": "Nơi đặt MEMORY.md",
  "In Callio's data folder (private)": "Trong thư mục dữ liệu của Callio (riêng tư)",
  "In the project folder (MEMORY.md)": "Trong thư mục dự án (MEMORY.md)",
  "Your projects are often Git repositories: the private location keeps notes out of them.": "Dự án của bạn thường là kho Git: chọn nơi riêng tư để ghi chú không lẫn vào đó.",
  "Connect a vault below to use Obsidian for memory.": "Hãy kết nối một kho bên dưới để dùng Obsidian làm nơi lưu trí nhớ.",
  "Obsidian": "Obsidian",
  "found {v} on this PC — filled in": "đã tìm thấy {v} trên máy — đã điền sẵn",
  "Install location": "Nơi cài",
  "Vault": "Kho",
  "Callio folder in the vault": "Thư mục của Callio trong kho",
  "Sync": "Đồng bộ",
  "Guessed from the vault's location": "Đoán từ vị trí kho",
  "detected": "phát hiện",
  "Unknown": "Không rõ",
  "Obsidian CLI": "CLI của Obsidian",
  "Adds the “Open in Obsidian” button and Obsidian's own search": "Thêm nút “Mở trong Obsidian” và bộ tìm của Obsidian",
  "Not tested yet": "Chưa kiểm tra",
  "Not switched on": "Chưa bật",
  "Switched on": "Đã bật",
  "Needs Obsidian 1.12.7 or newer": "Cần Obsidian 1.12.7 trở lên",
  "Skipped": "Đã bỏ qua",
  "Check": "Kiểm tra",
  "How to switch it on": "Hướng dẫn bật",
  "In Obsidian: Settings → General → Command line interface → switch it on. Then press Check here (the first command starts Obsidian).": "Trong Obsidian: Settings → General → Command line interface → bật lên. Rồi bấm Kiểm tra ở đây (lệnh đầu tiên sẽ khởi động Obsidian).",
  "Callio's permissions": "Quyền của Callio",
  "existing vault — only what you allow": "kho có sẵn — chỉ những gì bạn cho phép",
  "Read & search": "Đọc & tìm",
  "Selected folders": "Các thư mục chọn",
  "Whole vault": "Cả kho",
  "Write": "Ghi",
  "Only the Callio folder": "Chỉ thư mục Callio",
  "Nothing": "Không ghi gì",
  "Nothing to write": "Không ghi gì",
  "CLI commands": "Lệnh CLI",
  "Search, read, open notes": "Tìm, đọc, mở ghi chú",
  "More: create notes, edit properties": "Thêm: tạo ghi chú, sửa thuộc tính",
  "Everything, including running JavaScript": "Toàn bộ, kể cả chạy JavaScript",
  "Running JavaScript lets the AI do anything in Obsidian and your vault. Choose it only if you trust what you ask the AI to do.": "Chạy JavaScript cho phép AI làm bất cứ việc gì trong Obsidian và kho của bạn. Chỉ chọn khi bạn tin việc mình giao cho AI.",
  "Folders": "Thư mục",
  "Choose folders…": "Chọn thư mục…",
  "No folders found in this vault yet.": "Kho này chưa có thư mục nào.",
  "Connect to this vault": "Kết nối với kho này",
  "Not installed on this PC": "chưa cài trên máy",
  "Callio downloads the official build from Obsidian's GitHub, checks it, installs it for you only (no admin rights), creates a vault and registers it with Obsidian.": "Callio tải bản chính thức từ GitHub của Obsidian, kiểm tra chữ ký, cài cho riêng bạn (không cần quyền quản trị), tạo kho và đăng ký kho với Obsidian.",
  "Put the new vault in": "Đặt kho mới ở",
  "Choose…": "Chọn…",
  "Download Obsidian and check it": "Tải Obsidian và kiểm tra",
  "Downloaded Obsidian {v} · checked": "Tải Obsidian {v} · đã kiểm tra",
  "Install": "Cài đặt",
  "Create the vault and register it with Obsidian": "Tạo kho và đăng ký với Obsidian",
  "Switch on the CLI — one switch inside Obsidian (you can skip it)": "Bật CLI — bạn bấm một công tắc trong Obsidian (có thể bỏ qua)",
  "A vault created by Callio: Callio has full permissions — it reads and writes every folder and may use every CLI command. Every AI edit still saves the previous version and can be undone. Lower the permissions here at any time.": "Kho do Callio tạo: Callio có toàn quyền — đọc, ghi mọi thư mục, mọi lệnh CLI. Mỗi lần AI sửa vẫn lưu phiên bản trước và hoàn tác được. Hạ quyền ở đây bất cứ lúc nào.",
  "Every AI edit still saves the previous version and can be undone.": "Mỗi lần AI sửa vẫn lưu phiên bản trước và hoàn tác được.",
  "Use a vault I already have…": "Dùng kho tôi đã có…",
  "Install Obsidian": "Cài Obsidian",
  "Cancel": "Hủy",
  "Try again": "Thử lại",
  "Register now": "Đăng ký ngay",
  "Obsidian is running, so the vault couldn't be added to its list yet. Close Obsidian, then press Register now.": "Obsidian đang chạy nên chưa thêm được kho vào danh sách của nó. Hãy đóng Obsidian rồi bấm Đăng ký ngay.",
  "Switch on the CLI": "Bật CLI",
  "Open Obsidian on this vault, then switch on Settings → General → Command line interface. File access works without it; the CLI adds Obsidian's own search and the “Open in Obsidian” button.": "Mở Obsidian trên kho này, rồi bật Settings → General → Command line interface. Không bật cũng vẫn dùng được kho; CLI thêm bộ tìm của Obsidian và nút “Mở trong Obsidian”.",
  "Open Obsidian": "Mở Obsidian",
  "Skip": "Bỏ qua",
  "connected": "đã kết nối",
  "Vault folder": "Thư mục kho",
  "Open": "Mở",
  "Callio folder": "Thư mục Callio",
  "Permissions": "Quyền",
  "Edit permissions": "Sửa quyền",
  "Read: {r} · Write: {w} · CLI: {c}": "Đọc: {r} · Ghi: {w} · CLI: {c}",
  "search, read, open": "tìm, đọc, mở",
  "also create, edit properties": "thêm tạo, sửa thuộc tính",
  "everything": "toàn bộ",
  "the whole vault": "cả kho",
  "nothing": "không",
  "Created by Callio": "Do Callio tạo",
  "Existing vault": "Kho có sẵn",
  "“Open in Obsidian” button": "Nút “Mở trong Obsidian”",
  "Adds “Open in Obsidian” to the menu of notes inside the vault": "Thêm “Mở trong Obsidian” vào menu của ghi chú trong kho",
  "Open in Obsidian": "Mở trong Obsidian",
  "Disconnect": "Ngắt kết nối",
  "Check again": "Kiểm tra lại",
  "Change vault…": "Đổi kho…",
  "Save": "Lưu",
  "Session summaries": "Tóm tắt cuối phiên",
  "When a session ends": "Khi phiên kết thúc",
  "A small model proposes changes to the project note; you review the diff before anything is written": "Một mô hình nhỏ đề xuất sửa ghi chú dự án; bạn duyệt diff trước khi ghi",
  "Automatic — I review the diff": "Tự động — tôi duyệt diff",
  "Only when I type /memory update": "Chỉ khi tôi gõ /memory update",
  "Keep unsaved drafts when a session isn't reopened": "Giữ nháp chưa lưu khi không mở lại session",
  "7 days": "7 ngày",
  "Update the memory notes now": "Cập nhật ghi chú bộ nhớ ngay",
  "From the chat that is open (same as /memory update)": "Từ cuộc trò chuyện đang mở (giống /memory update)",
  "Update…": "Cập nhật…",
  "Undo the last update": "Hoàn tác lần cập nhật cuối",
  "Undo": "Hoàn tác",
  "Memory is off in Settings → AI.": "Bộ nhớ đang tắt trong Cài đặt → AI.",
  "Connected to {v}": "Đã kết nối với {v}",
  "Disconnected from the vault": "Đã ngắt kết nối với kho",
  "Couldn't connect: {e}": "Không kết nối được: {e}",
  "Install failed: {e}": "Cài đặt không thành công: {e}",
  "OneDrive": "OneDrive", "Dropbox": "Dropbox", "Google Drive": "Google Drive", "iCloud": "iCloud", "Git": "Git", "Obsidian Sync": "Obsidian Sync",
  "Memory": "Bộ nhớ",
  "Memory — AI memory": "Bộ nhớ AI",
  "AI memory": "Bộ nhớ AI",
  "Data storage": "Lưu trữ dữ liệu",
  "Update the memory notes…": "Cập nhật ghi chú bộ nhớ…",
});
const tr = (k, v = {}) => t(k).replace(/\{(\w+)\}/g, (_, n) => v[n] ?? "");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cmpVer = (a, b) => { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const SYNC = { onedrive: "OneDrive", dropbox: "Dropbox", gdrive: "Google Drive", icloud: "iCloud", git: "Git", "obsidian-sync": "Obsidian Sync" };
const slashEnd = (f) => (f.endsWith("/") ? f : f + "/");
const shortPath = (p) => { const parts = String(p).split(/[\\/]/); return parts.length > 5 ? "…\\" + parts.slice(-4).join("\\") : p; };

let ROOT = null;
const S = {
  det: null, loading: false,
  sel: 0, callioDir: "Callio/", info: null,           // detected vault choice
  draft: { readMode: "folders", readFolders: [], writeMode: "callio", writeFolders: [], cliLevel: "read" },
  picked: null,                                        // "use a vault I already have…"
  newPath: "", inst: null,                             // install
  folders: [], pickFor: null,                          // folder checklist
  edit: false, cliBusy: false, cliText: "", howto: false, want: null,
};

async function detect() {
  S.loading = true;
  try { S.det = await call("obs_detect"); } catch { S.det = { installed: false, vaults: [] }; }
  S.loading = false;
  if (!S.newPath) S.newPath = S.det.defaultVaultPath || "";
  S.sel = Math.min(S.sel, Math.max(0, vaultList().length - 1));
  await loadInfo();
}
function vaultList() { return S.picked ? [S.picked] : S.det?.vaults?.filter((v) => v.exists !== false) || []; }
async function loadInfo() {
  const v = vaultList()[S.sel];
  S.info = v ? await call("obs_vault_info", { path: v.path, calloDir: S.callioDir }).catch(() => null) : null;
}

export async function renderMemorySettings(root) {
  ROOT = root;
  if (!root.dataset.bound) { root.dataset.bound = "1"; root.addEventListener("click", onClick); root.addEventListener("change", onChange); root.addEventListener("input", onInput); }
  S.edit = false; S.pickFor = null;
  draw();
  await detect();
  draw();
}

// ---------------- drawing ----------------
const btn = (a, label, cls = "", extra = "") => `<button type="button" class="mem-cta ${cls}" data-a="${a}" ${extra}>${esc(t(label))}</button>`;
const sel = (name, opts, cur, extra = "") => `<select class="inp" data-f="${name}" ${extra}>${opts.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
const row = (label, ctl, small = "") => `<div class="sr"><span class="sr-l">${esc(t(label))}${small ? `<small>${esc(t(small))}</small>` : ""}</span><div class="sr-c">${ctl}</div></div>`;

function draw() {
  if (!ROOT) return;
  const o = settings.obsidian, conn = !!o?.vaultPath;
  const keep = ROOT.querySelector(".mem-folders")?.scrollTop || 0;
  ROOT.innerHTML = whereGroup(conn) + (conn ? connectedGroup(o) : S.inst || (S.det && !S.det.installed && !S.picked) ? missingGroup() : detectedGroup()) + summaryGroup();
  const f = ROOT.querySelector(".mem-folders"); if (f) f.scrollTop = keep;
}

function whereGroup(conn) {
  const store = conn && settings.memoryStore === "obsidian" ? "obsidian" : S.want === "obsidian" ? "obsidian" : "callio";
  const card = (id, title, desc) => `<button type="button" class="mem-card${store === id ? " on" : ""}" data-a="store" data-v="${id}" role="radio" aria-checked="${store === id}"><span class="mem-dot"></span><span><b>${esc(t(title))}</b><small>${esc(t(desc))}</small></span></button>`;
  return `<div class="sg"><h3 class="sg-h">${esc(t("Where memory lives"))}</h3>
    <div class="mem-cards" role="radiogroup">${card("callio", "Callio memory + MEMORY.md", "Writes and recalls past turns by itself, plus one short MEMORY.md for each project.")}${card("obsidian", "Obsidian vault", "The project note and a summary of each session live in the vault; open them with Obsidian.")}</div>
    ${store === "callio" ? row("Where MEMORY.md is kept", sel("memoryMdLocation", [["callio", t("In Callio's data folder (private)")], ["project", t("In the project folder (MEMORY.md)")]], settings.memoryMdLocation || "callio"), "Your projects are often Git repositories: the private location keeps notes out of them.") : ""}
    ${store === "obsidian" && !conn ? `<p class="note">${esc(t("Connect a vault below to use Obsidian for memory."))}</p>` : ""}</div>`;
}

function permControls(d, installedByCallio) {
  const showFolders = (k) => (d[k + "Mode"] === "folders" ? `<div class="sr"><span class="sr-l">${esc(t("Folders"))}</span><div class="sr-c" style="flex-direction:column;align-items:flex-end;gap:6px">
      <div class="mem-chips">${(d[k + "Folders"].length ? d[k + "Folders"] : []).map((f) => `<span class="mem-chip">${esc(slashEnd(f))}</span>`).join("")}</div>
      <button type="button" class="mem-cta sm" data-a="pickfolders" data-k="${k}">${esc(t("Choose folders…"))}</button></div></div>${S.pickFor === k ? folderList(k, d) : ""}` : "");
  return `${row("Read & search", sel("readMode", [["folders", t("Selected folders")], ["all", t("Whole vault")]], d.readMode))}${showFolders("read")}
    ${row("Write", sel("writeMode", [["callio", t("Only the Callio folder")], ["folders", t("Selected folders")], ...(installedByCallio || d.writeMode === "all" ? [["all", t("Whole vault")]] : []), ["none", t("Nothing")]], d.writeMode))}${showFolders("write")}
    ${row("CLI commands", sel("cliLevel", [["read", t("Search, read, open notes")], ["write", t("More: create notes, edit properties")], ["all", t("Everything, including running JavaScript")]], d.cliLevel))}
    ${d.cliLevel === "all" ? `<div class="mem-note warn" role="note">${esc(t("Running JavaScript lets the AI do anything in Obsidian and your vault. Choose it only if you trust what you ask the AI to do."))}</div>` : ""}`;
}
function folderList(k, d) {
  if (!S.folders.length) return `<p class="note">${esc(t("No folders found in this vault yet."))}</p>`;
  return `<div class="pick-list mem-folders" data-k="${k}">${S.folders.map((f) => `<label><input type="checkbox" data-f="folder" data-k="${k}" value="${esc(f)}"${d[k + "Folders"].some((x) => x.toLowerCase() === f.toLowerCase()) ? " checked" : ""}><span>${esc(slashEnd(f))}</span></label>`).join("")}</div>`;
}

function detectedGroup() {
  const det = S.det, list = vaultList(), v = list[S.sel];
  if (!det) return `<div class="sg"><h3 class="sg-h">Obsidian</h3><p class="note">…</p></div>`;
  const inst = det.installed;
  const cli = !det.cli?.exe && inst ? `<span class="mem-warn">${esc(t("Needs Obsidian 1.12.7 or newer"))}</span>` : `<span class="mem-warn">${esc(t("Not tested yet"))}</span>${btn("clitest", "Check", "sm", S.cliBusy ? "disabled" : "")}${btn("howto", "How to switch it on", "sm")}`;
  const sync = S.info?.sync && S.info.sync !== "unknown" ? `${esc(t(SYNC[S.info.sync]))} <span class="mem-auto">${esc(t("detected"))}</span>` : esc(t("Unknown"));
  return `<div class="sg"><h3 class="sg-h">Obsidian ${inst ? `<span class="mem-auto">${esc(tr("found {v} on this PC — filled in", { v: det.version || "" }))}</span>` : ""}</h3>
    ${inst ? row("Install location", `<span class="mem-path" title="${esc(det.dir)}">${esc(shortPath(det.dir))}</span>`) : ""}
    <div class="sr"><label class="sr-l" for="mem-vault">${esc(t("Vault"))}</label><div class="sr-c"><select id="mem-vault" class="inp" data-f="vault">${list.map((x, i) => `<option value="${i}"${i === S.sel ? " selected" : ""}>${esc(x.name)} — ${esc(shortPath(x.path))}</option>`).join("")}</select></div></div>
    <div class="sr"><label class="sr-l" for="mem-cd">${esc(t("Callio folder in the vault"))}</label><div class="sr-c"><input id="mem-cd" class="inp" data-f="callioDir" value="${esc(S.callioDir)}"></div></div>
    ${row("Sync", sync, "Guessed from the vault's location")}
    ${inst ? row("Obsidian CLI", cli, "Adds the “Open in Obsidian” button and Obsidian's own search") : ""}
    ${S.howto ? `<div class="mem-note">${esc(t("In Obsidian: Settings → General → Command line interface → switch it on. Then press Check here (the first command starts Obsidian)."))}</div>` : ""}
    ${S.cliText ? `<div class="mem-note ${S.cliOk ? "" : "warn"}">${esc(S.cliText)}</div>` : ""}
    <h3 class="sg-h" style="margin-top:14px">${esc(t("Callio's permissions"))} <span class="mem-sub">${esc(t("existing vault — only what you allow"))}</span></h3>
    ${permControls(S.draft, false)}
    <div class="mem-actions"><button type="button" class="mem-cta pri" data-a="connect"${v ? "" : " disabled"}>${esc(t("Connect to this vault"))}</button></div></div>`;
}

function stepRow(state, text, small = "") {
  const icon = state === "done" ? `<svg class="mem-ic mem-ok" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>` : state === "run" ? `<span class="mem-spin"></span>` : state === "fail" ? ic("x-circle", "mem-ic") : `<span class="mem-todo"></span>`;
  return `<div class="mem-step ${state}" data-state="${state}">${icon}<span>${esc(text)}${small ? `<small>${esc(small)}</small>` : ""}</span></div>`;
}
function barPct() {
  const i = S.inst; if (!i) return 0;
  const st = (k) => i.steps?.[k]?.state || "todo";
  const dl = st("verify") === "done" ? 1 : (i.steps.download?.pct || 0) / 100;
  return Math.min(100, Math.round(dl * 40 + (st("install") === "done" ? 30 : st("install") === "run" ? 15 : 0) + (st("vault") === "done" ? 30 : st("vault") === "run" ? 15 : 0)));
}
function missingGroup() {
  const i = S.inst, st = (k) => i?.steps?.[k]?.state || "todo", msg = (k) => i?.steps?.[k]?.text || "";
  const dl = st("verify") === "done" ? "done" : st("download") === "fail" || st("verify") === "fail" ? "fail" : st("download") === "run" || st("verify") === "run" ? "run" : st("download") === "done" ? "run" : "todo";
  const cli = i?.cliStep || "todo";
  const pct = barPct();
  return `<div class="sg"><h3 class="sg-h">Obsidian <span class="mem-sub">${esc(t("Not installed on this PC"))}</span></h3>
    <p class="note">${esc(t("Callio downloads the official build from Obsidian's GitHub, checks it, installs it for you only (no admin rights), creates a vault and registers it with Obsidian."))}</p>
    <div class="sr"><label class="sr-l" for="mem-newpath">${esc(t("Put the new vault in"))}</label><div class="sr-c"><input id="mem-newpath" class="inp" data-f="newPath" value="${esc(S.newPath)}"${i?.running ? " disabled" : ""}>${btn("choosenew", "Choose…", "sm", i?.running ? "disabled" : "")}</div></div>
    ${stepRow(dl, dl === "done" ? tr("Downloaded Obsidian {v} · checked", { v: i.version || "" }) : msg("verify") || msg("download") || t("Download Obsidian and check it"), dl === "fail" ? msg("verify") || msg("download") : "")}
    ${stepRow(st("install"), t("Install"), st("install") === "fail" ? msg("install") : "")}
    ${stepRow(st("vault"), t("Create the vault and register it with Obsidian"), st("vault") === "fail" ? msg("vault") : "")}
    ${stepRow(cli, t("Switch on the CLI — one switch inside Obsidian (you can skip it)"))}
    ${i ? `<div class="mem-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>` : ""}
    ${i?.error ? `<div class="mem-note err" role="alert">${esc(i.error)}</div>` : ""}
    <div class="mem-note" role="note">${esc(t("A vault created by Callio: Callio has full permissions — it reads and writes every folder and may use every CLI command. Every AI edit still saves the previous version and can be undone. Lower the permissions here at any time."))}</div>
    <div class="mem-actions split">${btn("useexisting", "Use a vault I already have…", "", i?.running ? "disabled" : "")}${i?.running ? btn("cancelinstall", "Cancel") : btn("install", i?.error ? "Try again" : "Install Obsidian", "pri")}</div></div>`;
}

const cliWord = (l) => t(l === "all" ? "everything" : l === "write" ? "also create, edit properties" : "search, read, open");
function permSummary(o) {
  const list = (m, fs, all) => (m === "all" ? t("the whole vault") : m === "none" ? t("nothing") : [...new Set([...(fs || []).map(slashEnd)])].join(", ") || slashEnd(o.callioDir || "Callio"));
  const r = list(o.read?.mode, [...(o.read?.folders || []), o.callioDir || "Callio"], true);
  const w = o.write?.mode === "callio" || !o.write ? slashEnd(o.callioDir || "Callio") : list(o.write.mode, [...(o.write.folders || []), o.callioDir || "Callio"]);
  return tr("Read: {r} · Write: {w} · CLI: {c}", { r, w, c: cliWord(o.cliLevel) });
}
function connectedGroup(o) {
  const cliState = o.cli === "on" ? `<span class="mem-ok">${esc(t("Switched on"))}</span>` : o.cli === "off" ? `<span class="mem-warn">${esc(t("Not switched on"))}</span>` : o.cli === "skipped" ? esc(t("Skipped")) : o.cli === "missing" ? `<span class="mem-warn">${esc(t("Needs Obsidian 1.12.7 or newer"))}</span>` : `<span class="mem-warn">${esc(t("Not tested yet"))}</span>`;
  const cliPending = (o.cli === "pending" || o.cli === "off") && o.exe;
  const d = S.edit ? S.draft : null;
  return `<div class="sg"><h3 class="sg-h">Obsidian <span class="mem-ok" style="text-transform:none;letter-spacing:0;font-weight:500">● ${esc(t("connected"))}</span></h3>
    ${row("Vault folder", `<span class="mem-path" title="${esc(o.vaultPath)}">${esc(o.vaultPath)}</span>${btn("openvault", "Open", "sm")}`)}
    ${row("Callio folder", `<span class="mem-path">${esc(slashEnd(o.callioDir || "Callio"))}</span>`)}
    ${row("Obsidian", `<span style="font-size:12.5px;color:var(--fg-2)">${esc(o.version || "—")} · CLI ${cliState}</span>${o.exe ? btn("clitest", "Check", "sm", S.cliBusy ? "disabled" : "") : ""}`)}
    ${S.cliText ? `<div class="mem-note ${S.cliOk ? "" : "warn"}">${esc(S.cliText)}</div>` : ""}
    ${S.regNeeded ? `<div class="mem-note warn" role="alert">${esc(t("Obsidian is running, so the vault couldn't be added to its list yet. Close Obsidian, then press Register now."))}<div class="mem-actions">${btn("register", "Register now", "sm")}</div></div>` : ""}
    ${cliPending ? `<div class="mem-note"><b>${esc(t("Switch on the CLI"))}</b><br>${esc(t("Open Obsidian on this vault, then switch on Settings → General → Command line interface. File access works without it; the CLI adds Obsidian's own search and the “Open in Obsidian” button."))}<div class="mem-actions">${btn("openobs", "Open Obsidian", "sm")}${btn("skipcli", "Skip", "sm")}</div></div>` : ""}
    ${row("Sync", o.sync && o.sync !== "unknown" ? `<span style="font-size:12.5px;color:var(--fg-2)">${esc(t(SYNC[o.sync]))}</span>` : `<span style="font-size:12.5px;color:var(--fg-2)">${esc(t("Unknown"))}</span>`)}
    ${row("Permissions", `<span class="mem-perm">${esc(permSummary(o))}</span>${S.edit ? "" : btn("editperms", "Edit permissions", "sm")}`, o.installedByCallio ? "Created by Callio" : "Existing vault")}
    ${o.installedByCallio && !S.edit ? `<div class="mem-note" role="note">${esc(t("Every AI edit still saves the previous version and can be undone."))}</div>` : ""}
    ${S.edit ? `${permControls(d, !!o.installedByCallio)}<div class="mem-actions">${btn("cancelperms", "Cancel")}${btn("saveperms", "Save", "pri")}</div>` : ""}
    <div class="sr"><label class="sr-l" for="mem-openbtn">${esc(t("“Open in Obsidian” button"))}<small>${esc(t("Adds “Open in Obsidian” to the menu of notes inside the vault"))}</small></label><div class="sr-c"><input id="mem-openbtn" type="checkbox" data-f="obsidianOpenButton"${settings.obsidianOpenButton !== false ? " checked" : ""}></div></div>
    <div class="mem-actions">${btn("disconnect", "Disconnect")}${btn("recheck", "Check again")}${btn("change", "Change vault…")}</div></div>`;
}

function summaryGroup() {
  return `<div class="sg"><h3 class="sg-h">${esc(t("Session summaries"))}</h3>
    ${row("When a session ends", sel("memorySummary", [["auto", t("Automatic — I review the diff")], ["manual", t("Only when I type /memory update")]], settings.memorySummary || "auto"), "A small model proposes changes to the project note; you review the diff before anything is written")}
    ${row("Keep unsaved drafts when a session isn't reopened", sel("drafts", [["7", t("7 days")]], "7", "disabled"))}
    ${row("Update the memory notes now", `${btn("updatenow", "Update…", "sm")}${btn("undo", "Undo", "sm")}`, "From the chat that is open (same as /memory update)")}</div>`;
}

// ---------------- actions ----------------
async function onChange(e) {
  const el = e.target, f = el.dataset.f;
  if (!f) return;
  if (f === "memoryMdLocation" || f === "memorySummary") updateSettings({ [f]: el.value });
  else if (f === "obsidianOpenButton") updateSettings({ obsidianOpenButton: el.checked });
  else if (f === "vault") { S.sel = +el.value; await loadInfo(); draw(); }
  else if (f === "readMode" || f === "writeMode" || f === "cliLevel") { S.draft[f] = el.value; if ((f === "readMode" || f === "writeMode") && el.value === "folders") await openFolders(f === "readMode" ? "read" : "write"); else draw(); }
  else if (f === "folder") {
    const k = el.dataset.k, list = S.draft[k + "Folders"], v = el.value;
    const i = list.findIndex((x) => x.toLowerCase() === v.toLowerCase());
    if (el.checked && i < 0) list.push(v); else if (!el.checked && i >= 0) list.splice(i, 1);
    draw();
  }
}
function onInput(e) {
  const f = e.target.dataset.f;
  if (f === "callioDir") S.callioDir = e.target.value;
  else if (f === "newPath") S.newPath = e.target.value;
}

async function openFolders(k) {
  const o = settings.obsidian, v = o?.vaultPath || vaultList()[S.sel]?.path;
  if (!v) return;
  let list = [];
  try { list = (await api.listDir(v)).filter((x) => x.isDir && !x.name.startsWith(".")).map((x) => x.name); } catch {}
  S.folders = list.sort((a, b) => a.localeCompare(b));
  S.pickFor = S.pickFor === k && !arguments[1] ? null : k;
  draw();
}

async function onClick(e) {
  const b = e.target.closest("[data-a]");
  if (!b || b.disabled) return;
  const a = b.dataset.a;
  const o = settings.obsidian;
  switch (a) {
    case "store": {
      const v = b.dataset.v;
      if (v === "obsidian" && !o?.vaultPath) { S.want = "obsidian"; draw(); break; }
      S.want = null;
      updateSettings({ memoryStore: v });
      draw();
      break;
    }
    case "howto": S.howto = !S.howto; draw(); break;
    case "pickfolders": S.pickFor === b.dataset.k ? (S.pickFor = null, draw()) : await openFolders(b.dataset.k); break;
    case "connect": await connect(false); break;
    case "choosenew": { const p = await api.pickFolder(t("Choose…")).catch(() => null); if (p) { S.newPath = p.replace(/[\\/]+$/, "") + "\\Callio Notes"; draw(); } break; }
    case "useexisting": {
      const p = await api.pickFolder(t("Use a vault I already have…")).catch(() => null);
      if (!p) break;
      S.picked = { id: "", path: p, name: p.split(/[\\/]/).filter(Boolean).pop() || p, exists: true }; S.sel = 0; S.inst = null;
      await loadInfo(); draw();
      break;
    }
    case "install": await install(); break;
    case "cancelinstall": call("obs_install_cancel").catch(() => {}); break;
    case "clitest": await cliTest(); break;
    case "openobs": call("obs_open", {}).catch((er) => toast(er.message, "err")); break;
    case "skipcli": updateSettings({ obsidian: { ...o, cli: "skipped" } }); draw(); break;
    case "openvault": call("obs_open", {}).catch(() => api.revealPath(o.vaultPath).catch((er) => toast(er.message, "err"))); break;
    case "editperms": {
      S.draft = { readMode: o.read?.mode || "folders", readFolders: [...(o.read?.folders || [])].filter((f) => f.toLowerCase() !== (o.callioDir || "Callio").replace(/\/$/, "").toLowerCase()), writeMode: o.write?.mode || "callio", writeFolders: [...(o.write?.folders || [])].filter((f) => f.toLowerCase() !== (o.callioDir || "Callio").replace(/\/$/, "").toLowerCase()), cliLevel: o.cliLevel || "read" };
      S.edit = true; S.pickFor = null; draw(); break;
    }
    case "cancelperms": S.edit = false; S.pickFor = null; draw(); break;
    case "saveperms": {
      const d = S.draft;
      updateSettings({ obsidian: { ...o, read: { mode: d.readMode, folders: d.readFolders }, write: { mode: d.writeMode, folders: d.writeFolders }, cliLevel: d.cliLevel } });
      flush(); S.edit = false; S.pickFor = null; draw(); break;
    }
    case "disconnect": updateSettings({ obsidian: null, memoryStore: "callio" }); flush(); S.picked = null; S.cliText = ""; toast(t("Disconnected from the vault"), "", 2500); await detect(); draw(); break;
    case "change": updateSettings({ obsidian: null, memoryStore: "callio" }); flush(); S.picked = null; S.cliText = ""; S.want = "obsidian"; await detect(); draw(); break;
    case "recheck": { S.cliText = ""; await detect(); if (o?.exe) await cliTest(); const d = S.det; if (d?.installed && o) updateSettings({ obsidian: { ...settings.obsidian, version: d.version, exe: d.exe } }); draw(); break; }
    case "register": {
      try { const r = await call("obs_setup_vault", { path: o.vaultPath, callioDir: o.callioDir, vi: uiLang() === "vi", register: true }); if (!r.needsClose) { S.regNeeded = false; if (r.vaultId) updateSettings({ obsidian: { ...o, vaultId: r.vaultId } }); } } catch (er) { toast(er.message, "err"); }
      draw(); break;
    }
    case "updatenow": import("./memory-notes.js").then((m) => m.updateFromChat()); break;
    case "undo": import("./memory-notes.js").then((m) => m.undoLast()); break;
  }
}

/** Permissions must reach the backend at once (it enforces them), not after the usual save delay. */
const flush = () => api.saveSettings(settings).catch(() => {});
function normDir(s) { const t0 = String(s || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""); return t0 || "Callio"; }

async function connect(full, extra = {}) {
  const v = extra.vault || vaultList()[S.sel];
  if (!v) return;
  const cd = normDir(S.callioDir);
  try {
    const r = await call("obs_setup_vault", { path: v.path, callioDir: cd, vi: uiLang() === "vi", register: false });
    const d = S.draft;
    const o = {
      exe: S.det?.exe || "", version: S.det?.version || "", cli: !S.det?.cli?.exe && S.det?.installed ? "missing" : "unknown",
      vaultPath: v.path, vaultName: v.name, vaultId: v.id || "", callioDir: cd, folderNames: r.folderNames || folderNames(uiLang() === "vi"),
      read: full ? { mode: "all", folders: [] } : { mode: d.readMode, folders: d.readFolders }, write: full ? { mode: "all", folders: [] } : { mode: d.writeMode, folders: d.writeFolders },
      cliLevel: full ? "all" : d.cliLevel, installedByCallio: !!full, sync: S.info?.sync || "unknown", ...extra.o,
    };
    updateSettings({ obsidian: o, memoryStore: "obsidian" }); flush();
    S.want = null; S.picked = null;
    toast(tr("Connected to {v}", { v: v.name }), "ok", 2500);
    draw();
  } catch (e) { toast(tr("Couldn't connect: {e}", { e: e.message }), "err", 5000); }
}

async function cliTest() {
  const o = settings.obsidian, exe = o?.exe || S.det?.exe, name = o?.vaultName || vaultList()[S.sel]?.name;
  if (!exe) return;
  S.cliBusy = true; S.cliText = ""; draw();
  try {
    const r = await call("obs_cli_test", { exe, vault: name });
    S.cliOk = !!r.ok; S.cliText = r.ok ? `${t("Switched on")} — Obsidian ${r.version || ""}`.trim() : r.error || t("Not switched on");
    if (o) updateSettings({ obsidian: { ...o, cli: r.ok ? "on" : "off" } });
  } catch (e) { S.cliOk = false; S.cliText = e.message; }
  S.cliBusy = false; draw();
}

// ---------------- installing Obsidian ----------------
async function install() {
  const vault = S.newPath.trim();
  if (!vault) return;
  S.inst = { running: true, steps: {}, error: "", version: "" };
  draw();
  const off = await listen("obs-install", (e) => {
    const i = S.inst; if (!i) return;
    const was = i.steps[e.step];
    i.steps[e.step] = { state: e.state, pct: e.pct ?? was?.pct, text: e.text };
    const m = /Obsidian (\d+\.\d+\.\d+)/.exec(e.text || ""); if (m) i.version = m[1];
    // progress ticks only move the bar (a full redraw would swallow a click on Cancel)
    if (was && was.state === e.state && was.text === e.text) { const bar = ROOT?.querySelector(".mem-bar i"); if (bar) bar.style.width = barPct() + "%"; return; }
    draw();
  });
  try {
    const r = await call("obs_install", { vaultPath: vault, vi: uiLang() === "vi" });
    S.inst.version = r.version || S.inst.version;
    const v = { id: r.vaultId || "", path: r.vaultPath, name: r.vaultName, exists: true };
    await detect();
    S.callioDir = r.callioDir || "Callio";
    await connect(true, { vault: v, o: { exe: r.exe, version: r.version, cli: r.cliExe ? "pending" : "missing", folderNames: r.folderNames } });
    if (r.needsClose) S.regNeeded = true;
    S.inst = null;
    draw();
  } catch (e) {
    if (S.inst) { S.inst.running = false; S.inst.error = e.message === "Cancelled" ? "" : tr("Install failed: {e}", { e: e.message }); if (e.message === "Cancelled") S.inst = null; }
    draw();
  } finally { off?.(); if (S.inst) S.inst.running = false; }
}

/** "Open in Obsidian" for a note inside the connected vault. */
export async function openInObsidian(absPath) {
  const o = settings.obsidian;
  if (!o?.vaultPath) return;
  const norm = (p) => p.replace(/\\/g, "/");
  const rel = norm(absPath).slice(norm(o.vaultPath).replace(/\/$/, "").length + 1);
  try { await call("obs_open", { file: rel }); } catch (e) { toast(e.message, "err"); }
}
