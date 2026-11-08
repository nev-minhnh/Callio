// Version history UI: list of versions for the open file, diff against the current text,
// restore and naming. Versions are taken automatically on save, before AI edits, before
// Overleaf pulls and before restores.
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { unifiedMergeView } from "@codemirror/merge";
import { api } from "./api.js";
import { ask, toast } from "./main.js";
import { ic } from "./icons.js";

const $ = (s) => document.querySelector(s);
let ctx = { activeTab: () => null, currentText: () => "", restore: async () => {} };
export function initHistory(c) {
  ctx = { ...ctx, ...c };
  $("#ver-close").onclick = () => $("#dlg-version").close();
}

export async function record(t, text, label, kind = "save") {
  if (!t?.path || t.kind === "pdf") return;
  try { await api.historyRecord(t.path, text, label, kind); } catch {}
  if (!$("#side-history").hidden) refreshHistoryPanel();
}

const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function dayLabel(t) {
  const d = new Date(t), today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
const KIND_ICON = { save: "💾", ai: "✨", pull: "⤓", manual: "★", restore: "↺" };

export async function refreshHistoryPanel() {
  const box = $("#history-panel");
  if (!box) return;
  const t = ctx.activeTab();
  if (!t?.path || t.kind === "pdf") { box.innerHTML = `<div class="empty-note">Open a saved file to see its versions.</div>`; return; }
  let list = [];
  try { list = await api.historyList(t.path); } catch {}
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "hist-head";
  head.innerHTML = `<span></span><button class="small">${ic("star")}<span>Save a version…</span></button>`;
  head.firstChild.textContent = t.name;
  head.querySelector("button").onclick = async () => {
    const name = await ask({ title: "Save a version", text: "Give this version a name you'll recognise later (named versions are never deleted).", input: "" });
    if (name === null) return;
    await record(t, ctx.currentText(), name || "Named version", "manual");
    toast("Version saved", "ok", 2000);
  };
  box.appendChild(head);
  if (!list.length) {
    box.insertAdjacentHTML("beforeend", `<div class="empty-note">No versions yet. Callio keeps one every time you save, before AI edits and before Overleaf pulls.</div>`);
    return;
  }
  let lastDay = "";
  for (const v of list) {
    const day = dayLabel(v.t);
    if (day !== lastDay) {
      lastDay = day;
      const h = document.createElement("div");
      h.className = "hist-day"; h.textContent = day;
      box.appendChild(h);
    }
    const el = document.createElement("div");
    el.className = "hist-item" + (v.kind === "manual" ? " named" : "");
    el.innerHTML = `<span class="hi-ico"></span><span class="hi-main"><span class="hi-label"></span><span class="hi-meta"></span></span>`;
    el.querySelector(".hi-ico").textContent = KIND_ICON[v.kind] || "•";
    el.querySelector(".hi-label").textContent = v.label;
    el.querySelector(".hi-meta").textContent = `${fmtTime(v.t)} · ${(v.size / 1024).toFixed(1)} KB`;
    el.title = new Date(v.t).toLocaleString();
    el.onclick = () => openVersion(t, v);
    box.appendChild(el);
  }
}

let diffView = null;
async function openVersion(t, v) {
  let text;
  try { text = await api.historyGet(t.path, v.id); } catch (e) { return toast(e.message, "err"); }
  const current = ctx.currentText();
  const dlg = $("#dlg-version");
  $("#ver-title").textContent = `${t.name} — ${v.label}, ${new Date(v.t).toLocaleString()}`;
  diffView?.destroy();
  diffView = new EditorView({
    parent: $("#ver-diff"),
    state: EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(), EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false),
        unifiedMergeView({ original: current, mergeControls: false, highlightChanges: true, gutter: true, collapseUnchanged: { margin: 3, minSize: 8 } }),
      ],
    }),
  });
  $("#ver-copy").onclick = async () => { await navigator.clipboard.writeText(text); toast("Copied", "ok", 1500); };
  $("#ver-restore").onclick = async () => {
    dlg.close();
    await record(t, current, `Before restoring ${fmtTime(v.t)} version`, "restore");
    await ctx.restore(t, text);
    toast(`Restored the version from ${new Date(v.t).toLocaleString()}. The text you had is kept as a version too.`, "ok", 5000);
    refreshHistoryPanel();
  };
  $("#ver-name").onclick = async () => {
    const name = await ask({ title: "Name this version", input: v.kind === "manual" ? v.label : "" });
    if (name === null) return;
    await api.historyRename(t.path, v.id, name || v.label);
    refreshHistoryPanel();
    $("#ver-title").textContent = `${t.name} — ${name}`;
  };
  if (!dlg.open) dlg.showModal();
}

/** Diff dialog for any before/after pair (e.g. a file Claude Code changed). */
export function showDiffDialog({ title, before, after, legend, restoreLabel, onRestore }) {
  const dlg = $("#dlg-version");
  $("#ver-title").textContent = title;
  const lg = dlg.querySelector(".ver-legend");
  const oldLegend = lg.innerHTML;
  if (legend) lg.innerHTML = `<span class="lg-add"></span><span class="lg-del"></span>`, (lg.children[0].textContent = legend[0]), (lg.children[1].textContent = legend[1]);
  diffView?.destroy();
  diffView = new EditorView({
    parent: $("#ver-diff"),
    state: EditorState.create({
      doc: after,
      extensions: [
        lineNumbers(), EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false),
        unifiedMergeView({ original: before, mergeControls: false, highlightChanges: true, gutter: true, collapseUnchanged: { margin: 3, minSize: 8 } }),
      ],
    }),
  });
  const restore = $("#ver-restore"), name = $("#ver-name");
  const oldRestore = restore.textContent;
  restore.textContent = restoreLabel || "Restore";
  name.hidden = true;
  $("#ver-copy").onclick = async () => { await navigator.clipboard.writeText(before); toast("Copied the earlier text", "ok", 1500); };
  restore.onclick = async () => { dlg.close(); await onRestore?.(); };
  dlg.addEventListener("close", () => { restore.textContent = oldRestore; name.hidden = false; lg.innerHTML = oldLegend; }, { once: true });
  if (!dlg.open) dlg.showModal();
}
