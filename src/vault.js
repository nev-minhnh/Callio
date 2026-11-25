// Obsidian vault mode. A folder that has `.obsidian/` inside (or sits in the vault connected
// under Settings › AI memory) is a vault: Callio then understands [[wiki links]], embeds, callouts,
// properties, tags and backlinks, and keeps every note plain Markdown that Obsidian opens as-is.
// This module detects the vault, keeps the note list in step with the disk, opens and creates
// notes from links, and stores pasted pictures; the panels, quick switcher and rename flow are in
// vault-ui.js, the editor parts in vault-cm.js, the preview in vault-md.js.
import "./vault.css";
import { call, api, listen } from "./api.js";
import { addVi, t } from "./i18n.js";
import { V, vx, relOf, absOf, norm, stemOf, dirOfRel, normHead, emitVaultChange } from "./vault-state.js";
import { settings, toast, ask, openPath, activeTab, basename, dirname, setMoveGuard, folder as getFolder } from "./main.js";
import { gotoLine, addEditorExtension, reapplyExtras } from "./editor.js";

addVi({
  "Obsidian vault": "Kho Obsidian",
  "Create the note “{n}”?": "Tạo ghi chú “{n}”?",
  "Create": "Tạo",
  "Cancel": "Hủy",
  "It will be created in {d}.": "Ghi chú sẽ được tạo trong {d}.",
  "the vault's top folder": "thư mục gốc của kho",
  "Couldn't create the note: {e}": "Không tạo được ghi chú: {e}",
  "Backlinks": "Liên kết ngược",
  "Outgoing links": "Liên kết đi",
  "Tags": "Thẻ",
  "Graph": "Đồ thị",
  "Vault": "Kho",
  "Daily note": "Ghi chú hằng ngày",
  "Open note…": "Mở ghi chú…",
  "Insert template…": "Chèn mẫu…",
  "Linked mentions": "Được liên kết",
  "Unlinked mentions": "Nhắc đến nhưng chưa liên kết",
  "Link": "Liên kết",
  "No notes link here yet.": "Chưa có ghi chú nào liên kết đến đây.",
  "No unlinked mentions.": "Không có chỗ nào nhắc đến mà chưa liên kết.",
  "This note has no links.": "Ghi chú này chưa có liên kết nào.",
  "No tags in this vault yet.": "Kho này chưa có thẻ nào.",
  "Open a note to see its links.": "Mở một ghi chú để xem liên kết.",
  "missing": "chưa có",
  "Search notes…": "Tìm ghi chú…",
  "Search templates…": "Tìm mẫu…",
  "Create “{n}”": "Tạo “{n}”",
  "No matching notes": "Không có ghi chú phù hợp",
  "No templates found": "Không thấy mẫu nào",
  "Properties": "Thuộc tính",
  "Add property": "Thêm thuộc tính",
  "Property name": "Tên thuộc tính",
  "Text": "Văn bản",
  "List": "Danh sách",
  "Number": "Số",
  "Checkbox": "Hộp chọn",
  "Date": "Ngày",
  "Date & time": "Ngày và giờ",
  "Source": "Mã nguồn",
  "Remove": "Xóa",
  "Add": "Thêm",
  "Update links?": "Cập nhật liên kết?",
  "Rename and update links": "Đổi tên và cập nhật liên kết",
  "Move and update links": "Di chuyển và cập nhật liên kết",
  "Rename only": "Chỉ đổi tên",
  "Move only": "Chỉ di chuyển",
  "{n} links in {m} notes point to what you are renaming. Update them so they keep working?": "{n} liên kết trong {m} ghi chú trỏ đến mục bạn đang đổi tên. Cập nhật để chúng vẫn dùng được?",
  "Updated {n} links in {m} notes": "Đã cập nhật {n} liên kết trong {m} ghi chú",
  "Links restored": "Đã khôi phục liên kết",
  "Some notes changed since and were left alone: {l}": "Vài ghi chú đã được sửa sau đó nên giữ nguyên: {l}",
  "Couldn't update the links: {e}": "Không cập nhật được liên kết: {e}",
  "Saved the picture in {p}": "Đã lưu ảnh vào {p}",
  "Couldn't save the picture: {e}": "Không lưu được ảnh: {e}",
  "Open in Obsidian": "Mở trong Obsidian",
  "Not in the vault": "Ngoài kho",
  "Today": "Hôm nay",
  "Local graph": "Đồ thị cục bộ",
  "Unresolved link": "Liên kết chưa có đích",
  "{n} notes": "{n} ghi chú",
});

const DEFAULT_CONFIG = { attachmentFolderPath: "/", newFileLocation: "root", newFileFolderPath: "", useMarkdownLinks: false, alwaysUpdateLinks: false, daily: { folder: "", format: "YYYY-MM-DD", template: "" }, templates: { folder: "" } };

let installed = false;
let refreshTimer = 0;
let detectSeq = 0;

export const inVault = () => V.on;

/** Called once at start-up (main.js): follows the window's folder. */
export function initVault() {
  window.addEventListener("callio-folder", (e) => detect(e.detail));
  window.addEventListener("callio-fs-changed", () => scheduleRefresh());
  window.addEventListener("callio-saved", (e) => onSaved(e.detail));
  window.addEventListener("focus", () => V.on && scheduleRefresh(300));
  detect(getFolder);
}

async function detect(folder) {
  const seq = ++detectSeq;
  let root = null, info = null;
  if (folder) {
    const cands = [folder];
    const conn = settings.obsidian?.vaultPath;
    if (conn && norm(folder).toLowerCase().startsWith(norm(conn).replace(/\/+$/, "").toLowerCase() + "/")) cands.push(conn);
    for (const c of cands) {
      try { const r = await call("vault_open", { args: { root: c } }); if (r?.isVault) { root = c; info = r; break; } } catch (e) { console.warn(e); }
      if (seq !== detectSeq) return;
    }
  }
  if (seq !== detectSeq) return;
  if (!root) return turnOff();
  V.root = root; V.name = info.name || basename(root); V.config = { ...DEFAULT_CONFIG, ...info.config };
  await loadNotes();
  if (seq !== detectSeq) return;
  await turnOn();
}

async function turnOn() {
  const was = V.on;
  V.on = true;
  document.documentElement.classList.add("vault-on");
  if (!installed) {
    installed = true;
    const [m, vm, cm] = await Promise.all([import("./md.js"), import("./vault-md.js"), import("./vault-cm.js")]);
    vm.install(m.mdParser);
    addEditorExtension((kind) => (V.on && kind === "md" ? cm.vaultExtension() : null));
    const ui = await import("./vault-ui.js");
    ui.initVaultUI();
    setMoveGuard((pairs) => import("./vault-ui.js").then((u) => u.guardMoves(pairs)));
  } else reapplyExtras();
  (await import("./vault-ui.js")).vaultChanged("on");
  if (!was) window.dispatchEvent(new CustomEvent("callio-vault", { detail: { on: true, root: V.root } }));
  rerenderPreview();
}

function turnOff() {
  if (!V.on && !V.root) return;
  V.on = false; V.root = ""; V.notes = []; V.files = []; V.tags = [];
  document.documentElement.classList.remove("vault-on");
  if (installed) { reapplyExtras(); import("./vault-ui.js").then((u) => u.vaultChanged("off")); }
  window.dispatchEvent(new CustomEvent("callio-vault", { detail: { on: false } }));
  rerenderPreview();
}

/** The preview was drawn without (or with) the vault rules: draw it again. */
function rerenderPreview() {
  window.dispatchEvent(new CustomEvent("callio-render-preview"));
}

export async function loadNotes() {
  const r = await vx("vault_notes");
  V.notes = r.notes; V.files = r.files;
  V.names = new Set([...r.notes.map((n) => n.name.toLowerCase()), ...r.files.map((f) => f.name.toLowerCase())]);
  V.paths = new Set([...r.notes.map((n) => n.rel.replace(/\.md$/i, "").toLowerCase()), ...r.files.map((f) => f.rel.toLowerCase())]);
  try { V.tags = await vx("vault_tags"); } catch { V.tags = []; }
}

function scheduleRefresh(ms = 500) {
  if (!V.on) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try { await vx("vault_sync"); await loadNotes(); emitVaultChange("notes"); } catch (e) { console.warn(e); }
  }, ms);
}

async function onSaved(path) {
  if (!V.on) return;
  const rel = relOf(path);
  if (!rel || !/\.md$/i.test(rel)) return;
  try {
    const text = (await api.readText(path)).text;
    await vx("vault_touch", { rel, text });
    scheduleRefresh(250);
  } catch { scheduleRefresh(250); }
}

// ---------------- opening and creating notes ----------------

/** Where a new note goes (Obsidian's "Default location for new notes"), as a folder path. */
export function newNoteFolder(fromRel = "") {
  const c = V.config;
  if (c.newFileLocation === "current") return dirOfRel(fromRel);
  if (c.newFileLocation === "folder") return String(c.newFileFolderPath || "").replace(/^\/+|\/+$/g, "");
  return "";
}

/** Create a note (empty or with `text`), never over an existing file; returns its vault path. */
export async function createNote(rel, text = "") {
  const free = await vx("vault_unique", { rel });
  await api.writeText(absOf(free), text, null, 0);
  await vx("vault_touch", { rel: free, text });
  await loadNotes();
  emitVaultChange("notes");
  import("./main.js").then((m) => m.refreshTree());
  return free;
}

/** Open what a link points at. `link`: {target, sub, md}; `fromRel`: the note it is written in. */
export async function openLink(link, fromRel = "") {
  const r = await vx("vault_resolve", { target: link.target || "", sub: link.sub || "", from: fromRel, md: !!link.md });
  if (!r.rel) return offerCreate(link, fromRel);
  await openRel(r.rel, link.sub, r.isNote);
}

export async function openRel(rel, sub = "", isNote = /\.md$/i.test(rel)) {
  await openPath(absOf(rel), undefined, true);
  if (sub && isNote) setTimeout(() => jumpTo(rel, sub), 60);
}

/** Put the cursor on a heading or ^block of the open note. */
export async function jumpTo(rel, sub) {
  try {
    if (sub.startsWith("^")) {
      const id = sub.slice(1).toLowerCase();
      const b = (await vx("vault_blocks", { rel })).find((x) => x.id.toLowerCase() === id);
      if (b) gotoLine(b.line);
    } else {
      const last = sub.split("#").pop();
      const h = (await vx("vault_headings", { rel })).find((x) => normHead(x.text) === normHead(last));
      if (h) gotoLine(h.line);
    }
  } catch (e) { console.warn(e); }
}

async function offerCreate(link, fromRel) {
  const raw = String(link.target || "").trim();
  if (!raw) return;
  const hasDir = raw.includes("/");
  const nm = raw.split("/").pop().replace(/\.md$/i, "");
  const dir = hasDir ? raw.split("/").slice(0, -1).join("/") : newNoteFolder(fromRel);
  const where = dir || t("the vault's top folder");
  const ok = await ask({ title: t("Create the note “{n}”?").replace("{n}", nm), text: t("It will be created in {d}.").replace("{d}", where), buttons: [{ label: t("Cancel"), value: null }, { label: t("Create"), value: "yes", primary: true }] });
  if (!ok) return;
  try {
    const rel = await createNote((dir ? dir + "/" : "") + nm + ".md");
    await openRel(rel);
  } catch (e) { toast(t("Couldn't create the note: {e}").replace("{e}", e.message || e), "err"); }
}

// ---------------- pictures: paste and drop ----------------

/** Where an attachment of the note `fromRel` goes, from the vault's "Default location for new attachments". */
export function attachmentFolder(fromRel) {
  const p = String(V.config.attachmentFolderPath || "/");
  if (p === "/" || p === "") return "";
  if (p === "./") return dirOfRel(fromRel);
  if (p.startsWith("./")) return [dirOfRel(fromRel), p.slice(2).replace(/^\/+|\/+$/g, "")].filter(Boolean).join("/");
  return p.replace(/^\/+|\/+$/g, "");
}

const pad = (n) => String(n).padStart(2, "0");
const stamp = () => { const d = new Date(); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; };

/** Save picture bytes next to the vault's other attachments; returns the text to insert. */
export async function saveAttachment(bytes, ext, fromRel, wantedName) {
  const dir = attachmentFolder(fromRel);
  const name = wantedName || `Pasted image ${stamp()}.${ext}`;
  const rel = await vx("vault_unique", { rel: (dir ? dir + "/" : "") + name });
  await api.writeBinary(absOf(rel), bytes, 0, false);
  await vx("vault_touch", { rel, text: "" }).catch(() => {});
  scheduleRefresh(200);
  toast(t("Saved the picture in {p}").replace("{p}", dir || t("the vault's top folder")), "ok", 2600);
  const file = rel.split("/").pop();
  if (V.config.useMarkdownLinks) {
    const from = dirOfRel(fromRel);
    return `![](${encodeURI(relFrom(from, rel))})`;
  }
  // the shortest link that still finds the picture
  return `![[${await vx("vault_link_text", { rel }).catch(() => file)}]]`;
}
function relFrom(dir, to) {
  const a = dir ? dir.split("/") : [], b = to.split("/");
  let i = 0;
  while (i < a.length && i + 1 < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
}

export { stemOf };
