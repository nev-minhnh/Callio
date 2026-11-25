// Settings › Data storage (Lưu trữ dữ liệu): what Callio keeps on this PC, how big each part is,
// and moving it to another drive. The move (copy → verify → pointer → restart → delete old copies
// only after you agree) is done by src-tauri/src/storage.rs. At start this module also shows the
// dialogs for a missing data drive, leftovers of an earlier move, and the portable-mode offer.
import "./obsidian.css";
import { call, api, listen } from "./api.js";
import { settings, ask, toast } from "./main.js";
import { addVi, t } from "./i18n.js";

addVi({
  "Data folder": "Thư mục dữ liệu",
  "Where Callio keeps its data": "Nơi Callio giữ dữ liệu",
  "Open": "Mở",
  "Portable mode: the data folder sits next to Callio.exe.": "Chế độ di động: thư mục dữ liệu nằm cạnh Callio.exe.",
  "{d} — {f} free of {n}": "{d} — còn trống {f} trên {n}",
  "What is stored": "Đang lưu những gì",
  "Select all": "Chọn tất cả",
  "Paper library": "Thư viện bài báo",
  "Versions & backups": "Phiên bản & bản sao lưu",
  "AI memory & session journals": "Bộ nhớ AI & nhật ký phiên",
  "Unsaved drafts": "Nháp chưa lưu",
  "Citation styles": "Kiểu trích dẫn",
  "Tools Callio installed": "Công cụ Callio đã cài",
  "Skills & Claude Code copies": "Skill & bản sao Claude Code",
  "Move to…": "Chuyển sang…",
  "Choose a folder for the data you ticked": "Chọn thư mục cho dữ liệu bạn đã đánh dấu",
  "Move to this folder": "Chuyển sang thư mục này",
  "Selected": "Đã chọn",
  "Needs {n} · {f} free there": "Cần {n} · còn trống {f} ở đó",
  "These folders already have data there and are used as they are (not overwritten): {l}": "Các thư mục này đã có dữ liệu ở đó và sẽ được dùng nguyên trạng (không ghi đè): {l}",
  "Callio pauses what it writes, copies the data, checks every file (count, size, sha256), then asks you to restart. The old copies stay until you agree to delete them.": "Callio tạm dừng việc ghi, sao chép dữ liệu, kiểm tra từng tệp (số lượng, dung lượng, sha256) rồi đề nghị khởi động lại. Bản cũ được giữ cho đến khi bạn đồng ý xóa.",
  "Copying…": "Đang sao chép…",
  "Checking…": "Đang kiểm tra…",
  "{a} of {b} files": "{a}/{b} tệp",
  "Moved and checked.": "Đã chuyển và kiểm tra xong.",
  "Restart Callio to use the new location. The old copies are only deleted after you agree, on the next start.": "Hãy khởi động lại Callio để dùng vị trí mới. Bản cũ chỉ bị xóa sau khi bạn đồng ý, ở lần mở tiếp theo.",
  "Restart now": "Khởi động lại ngay",
  "Later": "Để sau",
  "The move didn't finish: {e}": "Việc chuyển chưa xong: {e}",
  "Callio keeps using the current location; nothing was changed.": "Callio vẫn dùng vị trí hiện tại; chưa có gì thay đổi.",
  "Start moving": "Bắt đầu chuyển",
  "Cancel": "Hủy",
  "Stays on this PC (C:)": "Vẫn ở ổ C:",
  "The pointer to the data location, your saved passwords and keys (Windows Credential Manager) and Claude Code's own data stay where they are.": "Tệp trỏ tới vị trí dữ liệu, mật khẩu và khóa đã lưu (Windows Credential Manager) và dữ liệu riêng của Claude Code vẫn ở chỗ cũ.",
  "The web view cache can't be moved: Windows decides where it lives when the window opens.": "Bộ nhớ đệm của khung web không chuyển được: Windows quyết định vị trí khi cửa sổ mở.",
  "Nothing is ticked.": "Chưa đánh dấu mục nào.",
  "Your data folder isn't available": "Không tìm thấy thư mục dữ liệu",
  "Callio keeps its data in:\n{p}\n\nThat drive may be unplugged or locked (BitLocker). Callio won't create an empty library somewhere else.": "Callio lưu dữ liệu ở:\n{p}\n\nỔ đĩa đó có thể đang rút ra hoặc bị khóa (BitLocker). Callio sẽ không tự tạo thư viện trống ở nơi khác.",
  "Try again": "Thử lại",
  "Choose another place": "Chọn chỗ khác",
  "Open without my data": "Mở tạm không có dữ liệu",
  "That location is still missing.": "Vị trí đó vẫn chưa có.",
  "Opened without your data. Nothing is saved to the missing drive.": "Đã mở tạm không có dữ liệu. Không có gì được ghi vào ổ đang thiếu.",
  "Choose the new data folder": "Chọn thư mục dữ liệu mới",
  "Delete the old copies?": "Xóa các bản cũ?",
  "Your data was moved and checked. These old copies are still on the old drive:\n{l}\n\nCallio now uses the new location. Delete the old copies to free the space?": "Dữ liệu đã được chuyển và kiểm tra. Các bản cũ này vẫn còn trên ổ cũ:\n{l}\n\nCallio đang dùng vị trí mới. Xóa bản cũ để lấy lại dung lượng?",
  "Keep them": "Giữ lại",
  "Delete old copies": "Xóa bản cũ",
  "Deleted the old copies": "Đã xóa các bản cũ",
  "Move your data next to Callio?": "Chuyển dữ liệu về cạnh Callio?",
  "This copy of Callio is portable (it has a data folder next to it), but your library and settings are still in AppData. Move them into the data folder?": "Bản Callio này là bản di động (có thư mục data cạnh nó), nhưng thư viện và dữ liệu của bạn vẫn nằm trong AppData. Chuyển vào thư mục data?",
  "Move them": "Chuyển",
  "Not now": "Chưa",
  "Don't ask again": "Đừng hỏi lại",
});
const tr = (k, v = {}) => t(k).replace(/\{(\w+)\}/g, (_, n) => v[n] ?? "");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export function fmtSize(n) {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

let ROOT = null;
const S = { info: null, sel: new Set(), phase: "idle", dest: "", check: null, prog: null, result: null, error: "" };

export async function renderStorageSettings(root) {
  ROOT = root;
  if (!root.dataset.bound) { root.dataset.bound = "1"; root.addEventListener("click", onClick); root.addEventListener("change", onChange); }
  draw();
  if (S.phase === "idle" || S.phase === "done") { try { S.info = await call("storage_info"); } catch (e) { toast(e.message, "err"); } draw(); }
}

function draw() {
  if (!ROOT) return;
  const i = S.info;
  if (!i) { ROOT.innerHTML = `<div class="sg"><h3 class="sg-h">${esc(t("Data folder"))}</h3><p class="note">…</p></div>`; return; }
  const all = i.categories.length > 0 && i.categories.every((c) => S.sel.has(c.id));
  const some = S.sel.size > 0 && !all;
  const total = i.categories.reduce((n, c) => n + c.size, 0);
  const busy = S.phase === "moving";
  ROOT.innerHTML = `
  <div class="sg"><h3 class="sg-h">${esc(t("Data folder"))}</h3>
    <div class="sr"><span class="sr-l">${esc(t("Where Callio keeps its data"))}</span><div class="sr-c"><span class="mem-path" title="${esc(i.dataDir)}">${esc(i.dataDir)}</span><button type="button" class="mem-cta sm" data-a="reveal">${esc(t("Open"))}</button></div></div>
    ${i.portable ? `<p class="note">${esc(t("Portable mode: the data folder sits next to Callio.exe."))}</p>` : ""}
    <div class="st-drives">${(i.drives || []).map((d) => `<span>${esc(tr("{d} — {f} free of {n}", { d: d.drive, f: fmtSize(d.free), n: fmtSize(d.total) }))}</span>`).join("")}</div></div>
  <div class="sg"><h3 class="sg-h">${esc(t("What is stored"))}</h3>
    <div class="st-head"><label><input type="checkbox" id="st-all" data-a="all"${all ? " checked" : ""}${busy ? " disabled" : ""}><b>${esc(t("Select all"))}</b></label><span class="st-size">${esc(fmtSize(total))}</span><span class="st-where"></span></div>
    ${i.categories.map((c) => `<div class="st-row"><input type="checkbox" id="st-${esc(c.id)}" data-a="cat" value="${esc(c.id)}"${S.sel.has(c.id) ? " checked" : ""}${busy ? " disabled" : ""}><label class="st-name" for="st-${esc(c.id)}">${esc(t(c.label))}<small>${esc(c.folders.join(", "))}</small></label><span class="st-size">${esc(fmtSize(c.size))}</span><span class="st-where">${esc(c.where || "")}</span></div>`).join("")}
    ${flow()}
    ${S.phase === "idle" || S.phase === "done" ? `<div class="mem-actions"><button type="button" class="mem-cta pri" data-a="pickdest"${S.sel.size ? "" : " disabled"}>${esc(t("Move to…"))}</button></div>` : ""}</div>
  <div class="sg"><h3 class="sg-h">${esc(t("Stays on this PC (C:)"))}</h3>
    <p class="note">${esc(t("The pointer to the data location, your saved passwords and keys (Windows Credential Manager) and Claude Code's own data stay where they are."))}</p>
    <p class="note">${esc(t("The web view cache can't be moved: Windows decides where it lives when the window opens."))}</p></div>`;
  const a = ROOT.querySelector("#st-all"); if (a) a.indeterminate = some;
}

function flow() {
  const p = S.phase;
  if (p === "confirm") {
    const c = S.check, picked = S.info.categories.filter((x) => S.sel.has(x.id));
    return `<div class="mem-note" data-phase="confirm"><b>${esc(S.dest)}</b>
      <div class="st-sum"><span>${esc(t("Selected"))}: ${esc(picked.map((x) => t(x.label)).join(", "))}</span></div>
      ${c?.need != null ? `<div class="st-sum"><span>${esc(tr("Needs {n} · {f} free there", { n: fmtSize(c.need), f: fmtSize(c.free) }))}</span></div>` : ""}
      ${c?.useExisting?.length ? `<div class="st-sum"><span>${esc(tr("These folders already have data there and are used as they are (not overwritten): {l}", { l: c.useExisting.join(", ") }))}</span></div>` : ""}
      ${c && !c.ok ? `<div class="mem-err" role="alert">${esc(c.error || "")}</div>` : `<p class="note">${esc(t("Callio pauses what it writes, copies the data, checks every file (count, size, sha256), then asks you to restart. The old copies stay until you agree to delete them."))}</p>`}
      <div class="mem-actions"><button type="button" class="mem-cta" data-a="cancelconfirm">${esc(t("Cancel"))}</button><button type="button" class="mem-cta pri" data-a="start"${c?.ok ? "" : " disabled"}>${esc(t("Start moving"))}</button></div></div>`;
  }
  if (p === "moving") {
    const g = S.prog || { phase: "copy", done: 0, total: 1, files: 0, filesTotal: 0 };
    const pct = g.total ? Math.min(100, Math.round((g.done / g.total) * 100)) : 0;
    return `<div class="st-prog" data-phase="moving"><div class="mem-step run"><span class="mem-spin"></span><span>${esc(t(g.phase === "verify" ? "Checking…" : "Copying…"))}<small>${esc(g.file || "")} · ${esc(tr("{a} of {b} files", { a: g.files, b: g.filesTotal }))}</small></span></div>
      <div class="mem-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
      <div class="mem-actions"><button type="button" class="mem-cta" data-a="cancelmove">${esc(t("Cancel"))}</button></div></div>`;
  }
  if (p === "done") {
    return `<div class="mem-note" data-phase="done"><b class="mem-ok">${esc(t("Moved and checked."))}</b><br>${esc(t("Restart Callio to use the new location. The old copies are only deleted after you agree, on the next start."))}
      <div class="mem-actions"><button type="button" class="mem-cta" data-a="later">${esc(t("Later"))}</button><button type="button" class="mem-cta pri" data-a="restart">${esc(t("Restart now"))}</button></div></div>`;
  }
  if (p === "error") {
    return `<div class="mem-note err" role="alert" data-phase="error"><b>${esc(tr("The move didn't finish: {e}", { e: S.error }))}</b><br>${esc(t("Callio keeps using the current location; nothing was changed."))}<div class="mem-actions"><button type="button" class="mem-cta" data-a="later">${esc(t("Cancel"))}</button></div></div>`;
  }
  return "";
}

function onChange(e) {
  const el = e.target, a = el.dataset.a;
  if (a === "all") { S.sel = el.checked ? new Set(S.info.categories.map((c) => c.id)) : new Set(); draw(); }
  else if (a === "cat") { el.checked ? S.sel.add(el.value) : S.sel.delete(el.value); draw(); }
}

async function onClick(e) {
  const b = e.target.closest("button[data-a]");
  if (!b || b.disabled) return;
  switch (b.dataset.a) {
    case "reveal": api.revealPath(S.info.dataDir).catch((er) => toast(er.message, "err")); break;
    case "pickdest": {
      const p = await api.pickFolder(t("Choose a folder for the data you ticked")).catch(() => null);
      if (!p) break;
      S.dest = p; S.phase = "confirm"; S.check = null; draw();
      S.check = await call("storage_check_dest", { dest: p, ids: [...S.sel] }).catch((er) => ({ ok: false, error: er.message }));
      draw(); break;
    }
    case "cancelconfirm": case "later": S.phase = "idle"; try { S.info = await call("storage_info"); } catch {} draw(); break;
    case "start": await startMove(S.dest, [...S.sel]); break;
    case "cancelmove": call("storage_cancel").catch(() => {}); break;
    case "restart": call("storage_restart").catch((er) => toast(er.message, "err")); break;
  }
}

async function startMove(dest, ids) {
  S.phase = "moving"; S.prog = null; draw();
  const off = await listen("callio-storage-progress", (p) => {
    const was = S.prog; S.prog = p;
    if (!ROOT || S.phase !== "moving") return;
    // only the bar and the file line move while a phase runs (a full redraw would swallow a click on Cancel)
    const bar = ROOT.querySelector(".st-prog .mem-bar i"), small = ROOT.querySelector(".st-prog small");
    if (was && was.phase === p.phase && bar && small) { bar.style.width = (p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0) + "%"; small.textContent = `${p.file || ""} · ${tr("{a} of {b} files", { a: p.files, b: p.filesTotal })}`; } else draw();
  });
  try {
    S.result = await call("storage_move", { dest, ids });
    S.phase = "done";
  } catch (e) { S.phase = e.message === "Cancelled" ? "idle" : "error"; S.error = e.message; }
  finally { off?.(); }
  draw();
  return S.phase === "done";
}

// ---------------- at start ----------------
export async function initStorage() {
  let st;
  try { st = await call("storage_status"); } catch { return; }
  if (st.problems?.length && !st.noData) await missingDrive(st);
  else {
    if (st.cleanup?.length) await offerCleanup(st);
    if (st.portableOffer) await offerPortable(st);
  }
}
async function missingDrive(st) {
  for (;;) {
    const r = await ask({ title: t("Your data folder isn't available"), text: tr("Callio keeps its data in:\n{p}\n\nThat drive may be unplugged or locked (BitLocker). Callio won't create an empty library somewhere else.", { p: st.problems.map((p) => p.path).join("\n") }), vertical: true,
      buttons: [{ label: t("Try again"), value: "retry", primary: true }, { label: t("Choose another place"), value: "other" }, { label: t("Open without my data"), value: "none" }] });
    if (r === "retry") { const ok = await call("storage_retry").catch(() => false); if (!ok) toast(t("That location is still missing."), "warn", 3000); else return; continue; }
    if (r === "other") {
      const p = await api.pickFolder(t("Choose the new data folder")).catch(() => null);
      if (!p) continue;
      try { await call("storage_use_folder", { path: p }); await call("storage_restart"); return; } catch (e) { toast(e.message, "err"); continue; }
    }
    await call("storage_open_without_data").catch(() => {});
    toast(t("Opened without your data. Nothing is saved to the missing drive."), "warn", 5000);
    return;
  }
}
async function offerCleanup(st) {
  const r = await ask({ title: t("Delete the old copies?"), text: tr("Your data was moved and checked. These old copies are still on the old drive:\n{l}\n\nCallio now uses the new location. Delete the old copies to free the space?", { l: st.cleanup.map((c) => c.path).join("\n") }),
    vertical: true, buttons: [{ label: t("Delete old copies"), value: "delete", primary: true }, { label: t("Keep them"), value: "keep" }, { label: t("Later"), value: null }] });
  if (r === "delete" || r === "keep") {
    try { await call("storage_cleanup", { action: r }); if (r === "delete") toast(t("Deleted the old copies"), "ok", 3000); } catch (e) { toast(e.message, "err"); }
  }
}
async function offerPortable(st) {
  const r = await ask({ title: t("Move your data next to Callio?"), text: t("This copy of Callio is portable (it has a data folder next to it), but your library and settings are still in AppData. Move them into the data folder?"),
    buttons: [{ label: t("Not now"), value: null }, { label: t("Don't ask again"), value: "never" }, { label: t("Move them"), value: "move", primary: true }] });
  if (r === "never") return call("storage_portable_dismiss").catch(() => {});
  if (r !== "move") return;
  const ids = ["library", "versions", "memory", "drafts", "csl", "tools", "skills"];
  try { await call("storage_move", { dest: st.dataDir, ids }); await call("storage_portable_dismiss"); toast(t("Moved and checked."), "ok", 4000); } catch (e) { toast(tr("The move didn't finish: {e}", { e: e.message }), "err", 6000); }
}
