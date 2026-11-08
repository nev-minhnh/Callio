// In-editor AI helpers: ghost-text completion (Tab to accept), "avoid" word underlines from
// style-guide skills, and the ✨ button that appears next to a selection.
import { StateField, StateEffect, Prec, RangeSetBuilder } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, ViewPlugin, keymap } from "@codemirror/view";
import { settings, activeTab } from "./main.js";
import { addEditorExtension, reapplyExtras, getView } from "./editor.js";
import { runAI, cancelAI, modelFor, skillContent, openActionMenu } from "./ai.js";

// ---------------- ghost text ----------------
const setGhost = StateEffect.define();
class GhostWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(o) { return o.text === this.text; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-ghost";
    s.textContent = this.text;
    s.title = "Tab to accept · Esc to dismiss";
    return s;
  }
  ignoreEvent() { return true; }
}
const ghostField = StateField.define({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value;
    if (tr.docChanged || tr.selection) return null;
    return v;
  },
  provide: (f) => EditorView.decorations.from(f, (g) => (g ? Decoration.set([Decoration.widget({ widget: new GhostWidget(g.text), side: 1 }).range(g.pos)]) : Decoration.none)),
});

function acceptGhost(view) {
  const g = view.state.field(ghostField, false);
  if (!g) return false;
  view.dispatch({ changes: { from: g.pos, insert: g.text }, selection: { anchor: g.pos + g.text.length }, userEvent: "input.complete" });
  return true;
}
function dismissGhost(view) {
  if (!view.state.field(ghostField, false)) return false;
  view.dispatch({ effects: setGhost.of(null) });
  return true;
}

const ghostPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.view = view; this.timer = null; this.req = null; }
  update(u) {
    const typed = u.transactions.some((tr) => tr.isUserEvent("input.type") || tr.isUserEvent("delete.backward"));
    if (u.docChanged || u.selectionSet) this.cancel();
    if (typed && u.docChanged) this.schedule();
  }
  cancel() {
    clearTimeout(this.timer);
    if (this.req) { cancelAI(this.req); this.req = null; }
  }
  schedule() {
    this.timer = setTimeout(() => this.request(), Math.max(200, settings.aiInlineDelay || 700));
  }
  async request() {
    const v = this.view;
    const sel = v.state.selection.main;
    if (!sel.empty || !modelFor("inline")) return;
    const pos = sel.head;
    const line = v.state.doc.lineAt(pos);
    // only at a natural point: end of line or before closing punctuation
    const after = line.text.slice(pos - line.from);
    if (after.trim() && !/^[\s)}\]$.,;:]*$/.test(after)) return;
    if (line.text.trim().length < 3) return;
    const doc = v.state.doc;
    const prefix = doc.sliceString(Math.max(0, pos - 2500), pos);
    const suffix = doc.sliceString(pos, Math.min(doc.length, pos + 600));
    const kind = activeTab()?.kind === "tex" ? "LaTeX" : "Markdown";
    const docVersion = v.state.doc;
    let got = "";
    const ref = {};
    const p = runAI("inline", {
      idRef: ref,
      system: `You are an autocomplete engine inside a ${kind} editor for academic writing. Continue the text exactly at <CURSOR>. Reply with ONLY the text to insert — no quotes, no explanations, no code fences. At most one sentence (or one line of LaTeX). Never invent citations or numbers. If nothing sensible fits, reply with nothing.`,
      messages: [{ role: "user", content: `${prefix}<CURSOR>${suffix}` }],
      maxTokens: 60, temperature: 0.2,
    }, (e) => { if (e.kind === "text") got += e.text; });
    this.req = ref.id;
    try {
      const text = (await p).replace(/^```\w*\n?|```$/g, "").replace(/<CURSOR>/g, "");
      this.req = null;
      if (v.state.doc !== docVersion || v.state.selection.main.head !== pos) return;
      let t = text.replace(/\s+$/, "");
      if (!t.trim()) return;
      // avoid doubling a space
      if (/\s$/.test(prefix) && /^\s/.test(t)) t = t.replace(/^\s+/, "");
      if (t.length > 300) t = t.slice(0, 300);
      v.dispatch({ effects: setGhost.of({ pos, text: t }) });
    } catch { /* stopped or failed silently: completion is best-effort */ }
  }
  destroy() { this.cancel(); }
});

const ghostExt = [ghostField, ghostPlugin, Prec.highest(keymap.of([{ key: "Tab", run: acceptGhost }, { key: "Escape", run: dismissGhost }]))];

// ---------------- avoid words ----------------
let avoidRe = null;
let avoidSource = new Map(); // lowercase word → guide name
const avoidMark = (w) => Decoration.mark({ class: "cm-avoid", attributes: { title: `Style guide (${avoidSource.get(w.toLowerCase()) || "skills"}): avoid “${w}”` } });

function parseAvoid(text) {
  const words = new Set();
  for (let line of text.split("\n")) {
    line = line.trim();
    let m;
    if ((m = /^[-*+]\s+(.+)$/.exec(line)) || (m = /^\|\s*([^|]+?)\s*\|/.exec(line)) || (m = /^\d+\.\s+(.+)$/.exec(line))) {
      let w = m[1].replace(/[*_`"“”‘’]/g, "").split(/\s+[—–-]\s+|\s*[:→=(]|\s+->\s+|\s+instead\b/i)[0].trim();
      for (const part of w.split(/\s*[,/;]\s*/)) {
        const p = part.trim();
        if (p && p.length <= 30 && p.split(" ").length <= 3 && /^[\p{L}][\p{L}\s'-]*$/u.test(p) && !/^(word|avoid|use|instead|phrase|term|example)s?$/i.test(p)) words.add(p.toLowerCase());
      }
    }
  }
  return [...words];
}

export async function refreshAvoidWords(activeSkills) {
  avoidSource = new Map();
  const words = [];
  for (const s of activeSkills || []) {
    if (!/avoid|banned|forbidden|vocab/i.test(s.name + " " + s.path)) continue;
    const t = await skillContent(s);
    for (const w of parseAvoid(t || "")) { if (!avoidSource.has(w)) { avoidSource.set(w, s.name); words.push(w); } }
  }
  words.sort((a, b) => b.length - a.length);
  avoidRe = words.length ? new RegExp(`\\b(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")).join("|")})\\b`, "gi") : null;
  reapplyExtras();
}

const avoidPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view); }
  build(view) {
    const b = new RangeSetBuilder();
    if (!avoidRe) return b.finish();
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.doc.sliceString(from, to);
      avoidRe.lastIndex = 0;
      let m;
      while ((m = avoidRe.exec(text))) b.add(from + m.index, from + m.index + m[0].length, avoidMark(m[0]));
    }
    return b.finish();
  }
}, { decorations: (v) => v.decorations });

// ---------------- ✨ button near a selection ----------------
const selButton = ViewPlugin.fromClass(class {
  constructor(view) { this.view = view; this.btn = document.getElementById("ai-sel-btn"); }
  update(u) {
    if (!u.selectionSet && !u.geometryChanged && !u.docChanged) return;
    const sel = u.state.selection.main;
    if (sel.empty || sel.to - sel.from < 3 || !u.view.hasFocus) { this.btn.hidden = true; return; }
    u.view.requestMeasure({
      read: (v) => v.coordsAtPos(sel.head),
      write: (c) => {
        if (!c) { this.btn.hidden = true; return; }
        this.btn.style.left = Math.min(c.right + 8, innerWidth - 40) + "px";
        this.btn.style.top = Math.max(c.top - 30, 40) + "px";
        this.btn.hidden = false;
      },
    });
  }
  destroy() { this.btn.hidden = true; }
});

// ---------------- registration ----------------
export function initInline() {
  addEditorExtension((kind) => {
    if (kind !== "md" && kind !== "tex") return null;
    const ext = [selButton];
    if (settings.aiInlineEnabled) ext.push(ghostExt);
    if (settings.avoidLint !== false) ext.push(avoidPlugin);
    return ext;
  });
  const btn = document.getElementById("ai-sel-btn");
  btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
  btn.onclick = () => { const r = btn.getBoundingClientRect(); btn.hidden = true; openActionMenu(r.left, r.bottom + 4); };
  getView()?.dom.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== btn) btn.hidden = true; }, 150), true);
}
export function settingsChanged() { reapplyExtras(); }
