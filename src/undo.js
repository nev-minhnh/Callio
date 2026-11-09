// Undo / Redo for every kind of tab, in the top toolbar: ↶ ▾ ↷ ▾. The ▾ lists the last 100
// steps (AI edits marked) and undoes or redoes several at once. Each kind of tab gives a provider:
//   list(t) → { undo: [label…], redo: [label…] } newest first;  step(t, n, redo) → undo/redo n steps.
// Text tabs use CodeMirror's history (with named steps), spreadsheets and Word
// documents the engine's, PDFs their own page/annotation history.
import { activeTab } from "./main.js";
import { undoList, undoSteps, getView } from "./editor.js";

const $ = (s) => document.querySelector(s);
const providers = new Map();
const MAX = 100;

export function registerUndo(kind, provider) { providers.set(kind, provider); }

// text tabs: the editor's state
const textProvider = {
  list: () => undoList(getView()?.state),
  step: (_t, n, redo) => undoSteps(n, redo),
};

function current() {
  const t = activeTab();
  if (!t) return null;
  return { t, p: providers.get(t.kind) || (["pdf", "doc", "sheet", "deck", "image"].includes(t.kind) ? null : textProvider) };
}

let lists = { undo: [], redo: [] };
let timer = 0;
/** Bring the buttons up to date (soon; many changes in a row cost one refresh). */
export function refreshUndo() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const c = current();
    try { lists = c?.p ? await c.p.list(c.t) : { undo: [], redo: [] }; } catch { lists = { undo: [], redo: [] }; }
    lists = { undo: (lists.undo || []).slice(0, MAX), redo: (lists.redo || []).slice(0, MAX) };
    const u = lists.undo.length, r = lists.redo.length;
    $("#btn-undo").disabled = !u; $("#btn-undo-list").disabled = !u;
    $("#btn-redo").disabled = !r; $("#btn-redo-list").disabled = !r;
    $("#btn-undo").title = u ? `Undo ${lists.undo[0]} (Ctrl+Z)` : "Nothing to undo";
    $("#btn-redo").title = r ? `Redo ${lists.redo[0]} (Ctrl+Y)` : "Nothing to redo";
  }, 60);
}

async function step(n, redo) {
  const c = current();
  if (!c?.p) return;
  await c.p.step(c.t, n, redo);
  refreshUndo();
}

function openMenu(redo, anchor) {
  closeMenu();
  const items = redo ? lists.redo : lists.undo;
  if (!items.length) return;
  const m = document.createElement("div");
  m.className = "undo-menu";
  m.innerHTML = `<div class="um-list">${items.map((l, i) => `<div class="um-item" data-i="${i}">${/^(AI|Claude)/.test(l) ? `<span class="um-ai">AI</span>` : ""}<span class="um-l"></span><span class="um-n">${i + 1}</span></div>`).join("")}</div><div class="um-foot">${redo ? "Redo" : "Undo"} 1 action</div>`;
  m.querySelectorAll(".um-l").forEach((el, i) => { el.textContent = items[i]; });
  const foot = m.querySelector(".um-foot");
  const hot = (k) => {
    m.querySelectorAll(".um-item").forEach((el, i) => el.classList.toggle("hot", i <= k));
    foot.textContent = `${redo ? "Redo" : "Undo"} ${k + 1} action${k ? "s" : ""}`;
  };
  m.addEventListener("mouseover", (e) => { const it = e.target.closest(".um-item"); if (it) hot(+it.dataset.i); });
  m.addEventListener("click", (e) => { const it = e.target.closest(".um-item"); if (!it) return; closeMenu(); step(+it.dataset.i + 1, redo); });
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left - 40, innerWidth - 310)) + "px";
  m.style.top = r.bottom + 4 + "px";
  hot(0);
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
}
function outside(e) { if (!e.target.closest(".undo-menu")) closeMenu(); }
function closeMenu() {
  document.querySelectorAll(".undo-menu:not(.out)").forEach((m) => { m.classList.add("out"); m.addEventListener("animationend", () => m.remove(), { once: true }); setTimeout(() => m.remove(), 200); });
  document.removeEventListener("pointerdown", outside, true);
}

export function initUndo() {
  // keep focus where it is (the editor, the grid, the page) when a button is clicked
  for (const id of ["#btn-undo", "#btn-redo", "#btn-undo-list", "#btn-redo-list"]) $(id).addEventListener("mousedown", (e) => e.preventDefault());
  $("#btn-undo").onclick = () => step(1, false);
  $("#btn-redo").onclick = () => step(1, true);
  $("#btn-undo-list").onclick = (e) => openMenu(false, e.currentTarget);
  $("#btn-redo-list").onclick = (e) => openMenu(true, e.currentTarget);
  window.addEventListener("callio-undo", refreshUndo);
  // PDFs have no text editor to take Ctrl+Z: the provider does
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    const t = activeTab();
    if (t?.kind !== "pdf" && t?.kind !== "image") return;
    if (e.target.closest?.("input, textarea, [contenteditable=true], .cm-editor, dialog")) return;
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) { e.preventDefault(); step(1, false); }
    else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); step(1, true); }
  });
  refreshUndo();
}
