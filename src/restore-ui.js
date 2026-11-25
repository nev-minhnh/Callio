// "Callio closed unexpectedly. Reopen the previous session?"
//
// A marker file is written at start and removed by every normal exit (Rust: `session_marker_*`).
// Finding it at start means the last run was cut short, so once the window is ready ONE dialog
// lists what every feature can bring back (restore.js: each registers `describe/restore/discard`)
// and asks. Mở lại → every restore() in order; Không → every discard(). After a clean exit the
// dialog never appears.
//
// This file also registers the "tabs" restorer (order 10): it reopens the window's tabs and puts
// the unsaved drafts (drafts.js) back, and the "Restore drafts…" list. The file on disk is never
// overwritten: if it changed after the draft was made, the tab opens with the draft and you
// choose (keep the draft, keep the file, or compare); saving later still asks before replacing a
// file that changed.
import { call } from "./api.js";
import { ask, toast, openPath, openNewDoc, setFolder, activate, getTabs, activeTab, basename, dirname } from "./main.js";
import { getView, replaceDocAsStep } from "./editor.js";
import { registerRestorer, restorersList } from "./restore.js";
import { t as tr, addVi } from "./i18n.js";
import { startDrafts, windowLabel, listDrafts, deleteDraft, loadTabsState, hashText, adoptDraft } from "./drafts.js";

addVi({
  "Closed unexpectedly": "Đã tắt đột ngột",
  "Callio closed unexpectedly at": "Callio đã bị tắt đột ngột lúc",
  "Reopen the previous session?": "Mở lại session trước?",
  "Reopen": "Mở lại",
  "tab": "tab", "tabs": "tab", "with unsaved changes": "có thay đổi chưa lưu",
  "Restore drafts…": "Khôi phục nháp…", "Restore drafts": "Khôi phục nháp",
  "Unsaved drafts": "Nháp chưa lưu", "Untitled": "Chưa đặt tên",
  "There are no unsaved drafts.": "Không có bản nháp nào.",
  "Open": "Mở", "Delete": "Xoá", "Delete all": "Xoá tất cả", "Close": "Đóng",
  "File changed on disk": "Tệp đã đổi trên đĩa",
  "Keep my draft": "Giữ bản nháp", "Keep the file": "Giữ tệp trên đĩa", "Compare…": "So sánh…",
  "was changed on disk after this draft was saved. Callio never overwrites it: pick which version to work on.": "đã bị đổi trên đĩa sau khi bản nháp này được lưu. Callio không bao giờ ghi đè: hãy chọn phiên bản để làm tiếp.",
  "Draft restored": "Đã khôi phục bản nháp",
  "The file is gone; its draft was opened as a new document.": "Tệp không còn; bản nháp được mở thành tài liệu mới.",
});
const VIEW_ONLY = new Set(["pdf", "doc", "sheet", "deck", "image", "media", "drawio", "ipynb"]);

const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- putting a draft into a tab ----------------
/** Replace the open tab's text by the draft's, as one undoable step; the tab becomes unsaved. */
function applyDraft(d) {
  const v = getView();
  const spec = replaceDocAsStep(v.state, d.text, "Restored draft");
  if (spec) v.dispatch(spec);
}
/** The disk text of the open tab, and whether it differs from what the draft was based on. */
async function diskChanged(t, d) {
  const disk = t.saved ?? "";
  if (disk === d.text) return "same";
  if (d.baseHash != null) return hashText(disk) === d.baseHash ? "ok" : "changed";
  return (t.mtime || 0) > (d.baseMtime || 0) ? "changed" : "ok";
}

/**
 * Open a draft's file (or an untitled document) with the draft's text. `quiet` = no toast.
 * Returns the tab, or null when the reader chose the file on disk.
 */
export async function openDraft(d) {
  if (!d.path) {
    const n = await openNewDoc(d.name || tr("Untitled"), d.text, d.kind && !VIEW_ONLY.has(d.kind) ? d.kind : "md");
    adoptDraft(n, d);
    return n;
  }
  const t = await openPath(d.path, undefined, true);
  if (!t) { // the file is gone
    const n = await openNewDoc(basename(d.path), d.text, d.kind && !VIEW_ONLY.has(d.kind) ? d.kind : "md");
    adoptDraft(n, d);
    toast(tr("The file is gone; its draft was opened as a new document."), "warn", 6000);
    return n;
  }
  const st = await diskChanged(t, d);
  if (st === "same") return t;
  if (st === "changed") {
    const r = await ask({
      title: tr("File changed on disk"),
      text: `${basename(d.path)} ${tr("was changed on disk after this draft was saved. Callio never overwrites it: pick which version to work on.")}`,
      buttons: [{ label: tr("Keep the file"), value: "disk" }, { label: tr("Compare…"), value: "cmp" }, { label: tr("Keep my draft"), value: "draft", primary: true }],
    });
    if (r === "disk" || r === null) return t;
    applyDraft(d); adoptDraft(t, d);
    if (r === "cmp") import("./compare.js").then(async (m) => { await m.openCompare(t.path, t); await m.onDrop([t.path], null); });
    return t;
  }
  applyDraft(d); adoptDraft(t, d);
  return t;
}

// ---------------- the "tabs" restorer ----------------
async function tabsInfo() {
  const win = await windowLabel();
  const state = await loadTabsState();
  const drafts = await call("draft_list", { window: win }).catch(() => []);
  return { state, drafts };
}
registerRestorer({
  id: "tabs", order: 10,
  async describe() {
    const { state, drafts } = await tabsInfo();
    const keys = new Set((state?.tabs || []).map((x) => x.key));
    for (const d of drafts) keys.add(d.key);
    if (!keys.size) return null;
    const n = keys.size;
    return `${n} ${tr(n === 1 ? "tab" : "tabs")}${drafts.length ? `, ${drafts.length} ${tr("with unsaved changes")}` : ""}`;
  },
  async restore() {
    const { state, drafts } = await tabsInfo();
    const byKey = new Map(drafts.map((d) => [d.key, d]));
    if (state?.folder) { try { setFolder(state.folder); } catch {} }
    const order = [...(state?.tabs || [])];
    for (const d of drafts) if (!order.some((x) => x.key === d.key)) order.push({ key: d.key, path: d.path, name: d.name, kind: d.kind, dirty: true });
    const opened = new Map();
    for (const e of order) {
      const d = byKey.get(e.key);
      let t = null;
      try { t = d ? await openDraft(d) : e.path ? await openPath(e.path, undefined, true) : null; } catch (err) { console.warn("restore tab", err); }
      if (t) { opened.set(e.key, t); if (e.pinned) t.pinned = true; }
    }
    const act = opened.get(state?.active);
    if (act) await activate(act.id);
    else if (opened.size) await activate([...opened.values()].pop().id);
  },
  // "No": the tabs are not reopened; drafts stay for 7 days (see "Restore drafts…")
  async discard() { await call("tabs_state_delete", { window: await windowLabel() }).catch(() => {}); },
});

// ---------------- the start-up dialog ----------------
async function windowReady() {
  for (let i = 0; i < 160 && !performance.getEntriesByName("callio-init-done").length; i++) await nap(50);
  await nap(900); // files opened from the command line settle first
}
/** Begin the run: marker, purge old drafts, start saving, and ask once after an unclean exit. */
export async function initRestoreUI() {
  const win = await windowLabel();
  call("draft_purge", { maxAgeMs: 7 * 24 * 3600 * 1000 }).catch(() => {});
  if (win !== "main") {
    // other windows never ask: the main window's answer recreated them with ?restore=1, and then
    // each one brings back its own tabs and drafts
    if (new URLSearchParams(location.search).get("restore") === "1") {
      try { await windowReady(); await restorersList().find((r) => r.id === "tabs")?.restore(); }
      catch (e) { console.warn("restore tabs", e); }
    }
    return startDrafts();
  }
  let m;
  try { m = await call("session_marker_begin"); } catch { return startDrafts(); }
  // Saving starts only after the question is answered: the tab list written by this new run
  // must not replace the one the dialog is about to bring back.
  if (!m?.unclean) return startDrafts();
  try {
    await windowReady();
    const lines = [];
    for (const r of restorersList()) { try { const l = await r.describe?.(); if (l) lines.push(l); } catch {} }
    if (!lines.length) return;
    const text = `${tr("Callio closed unexpectedly at")} ${m.at ? hhmm(m.at) : "—"}. ${tr("Reopen the previous session?")}\n\n${lines.map((l) => "• " + l).join("\n")}`;
    const a = await ask({ title: tr("Closed unexpectedly"), text, buttons: [{ label: "No", value: "no" }, { label: "Reopen", value: "yes", primary: true }] });
    for (const r of restorersList()) {
      try { if (a === "yes") await r.restore(); else await r.discard?.(); }
      catch (e) { toast(`${r.id}: ${e.message || e}`, "err", 6000); }
    }
  } finally { startDrafts(); }
}

// ---------------- the list of drafts ----------------
function row(d, dlg, reload) {
  const el = document.createElement("div");
  el.className = "dr-row";
  const folderName = d.path ? dirname(d.path) : tr("Untitled");
  el.innerHTML = `<div class="dr-main"><b class="dr-name" data-noi18n></b><small class="dr-dir" data-noi18n></small><small class="dr-time" data-noi18n></small></div><button class="small primary dr-open">Open</button><button class="small dr-del">Delete</button>`;
  el.querySelector(".dr-name").textContent = d.name || basename(d.path || "") || tr("Untitled");
  el.querySelector(".dr-dir").textContent = folderName;
  el.querySelector(".dr-time").textContent = new Date(d.savedAt || 0).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  el.querySelector(".dr-open").onclick = async () => { dlg.close(); await openDraft(d); };
  el.querySelector(".dr-del").onclick = async () => { await deleteDraft(d); reload(); };
  return el;
}
/** "Restore drafts…": every unsaved draft (all windows) with Open and Delete. */
export async function openDraftsList() {
  let dlg = document.getElementById("dlg-drafts");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "dlg-drafts";
    dlg.innerHTML = `<header class="dlg-head"><h2>Unsaved drafts</h2></header><div class="dlg-body col dr-list"></div><footer class="dlg-foot"><button class="dr-all">Delete all</button><button class="primary dr-close">Close</button></footer>`;
    document.body.appendChild(dlg);
    dlg.querySelector(".dr-close").onclick = () => dlg.close();
  }
  const list = dlg.querySelector(".dr-list");
  const reload = async () => {
    const drafts = await listDrafts(true);
    list.replaceChildren();
    if (!drafts.length) { const p = document.createElement("p"); p.className = "note"; p.textContent = tr("There are no unsaved drafts."); list.appendChild(p); }
    for (const d of drafts) list.appendChild(row(d, dlg, reload));
    dlg.querySelector(".dr-all").hidden = !drafts.length;
    dlg.querySelector(".dr-all").onclick = async () => { for (const d of drafts) await deleteDraft(d); reload(); };
  };
  await reload();
  if (!dlg.open) dlg.showModal();
}
