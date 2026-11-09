// Callio's writing assistant, working the way Grammarly does (and the way Themisio's does):
//
// 1. Collect — every paragraph (Markdown / LaTeX / text, Word documents), text box on the slide
//    (presentations) or text cell (spreadsheets) is read; as you type or paste, only what changed
//    is sent again (as you type when "Check as you type" is on, otherwise with Check now).
// 2. Analyse — against four criteria: Correctness, Clarity, Engagement and Delivery, and the
//    writing goals you set (domain, formality, audience, intent, language variety).
// 3. Suggest — issues are underlined in the text (red: correctness; blue, green, purple: clarity,
//    engagement, delivery). Hover an underline for a card with the fix and a short explanation:
//    Accept, Dismiss, or Add to dictionary. The side panel lists them all.
// 4. Write with AI — compose from a prompt, rephrase (formal, friendly, concise…), ideas.
// 5. Report — an overall score (0–100), counts per criterion, the document's tone, an
//    originality check (web search), and a progress report; a personal dictionary.
//
// Right-click (or Ctrl+Alt+G / K / T / D): Check writing with AI, Ask AI…, Translate, Look up
// meaning. Double-click a word to translate it (Settings: off, Translate or Meaning).
import { StateField, StateEffect } from "@codemirror/state";
import { EditorView, Decoration } from "@codemirror/view";
import { getView, addEditorExtension } from "./editor.js";
import { call } from "./api.js";
import { settings, updateSettings, activeTab, status } from "./main.js";
import { ic } from "./icons.js";
import { showContextMenu } from "./ctxmenu.js";
import { openAssist, closeAssist, modelControls, pointer } from "./assist.js";

const ai = () => import("./ai.js");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const preview = (s, n) => { const t = String(s).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const TEXT_KINDS = new Set(["md", "tex", "text", "bib"]);

// ---------------------------------------------------------------- the four criteria
const CATS = [
  { id: "correctness", label: "Correctness", color: "#f03c45", weight: 4 },
  { id: "clarity", label: "Clarity", color: "#1a8cf8", weight: 2 },
  { id: "engagement", label: "Engagement", color: "#2bb86a", weight: 1 },
  { id: "delivery", label: "Delivery", color: "#8b5cf6", weight: 1.5 },
];
const cat = (id) => CATS.find((c) => c.id === id) || CATS[0];
const parseCat = (s) => { const v = String(s || "").trim().toLowerCase(); return v === "clarity" ? "clarity" : v === "engagement" ? "engagement" : v === "delivery" || v === "tone" ? "delivery" : "correctness"; };

const DOMAINS = ["General", "Academic", "Business", "Email", "Technical", "Creative", "Casual"];
const FORMALITY = ["Informal", "Neutral", "Formal"];
const AUDIENCE = ["General", "Knowledgeable", "Expert"];
const INTENT = ["Inform", "Describe", "Convince", "Tell a story"];
const VARIANTS = [["auto", "Same as the text"], ["en-US", "American English"], ["en-GB", "British English"], ["en-CA", "Canadian English"], ["en-AU", "Australian English"], ["en-IN", "Indian English"], ["vi", "Vietnamese"]];

function cfg() {
  const w = settings.writer || {};
  return {
    goals: { domain: "General", formality: "Neutral", audience: "General", intent: "Inform", variant: "auto", ...(w.goals || {}) },
    dictionary: w.dictionary || [],
    stats: { accepted: [0, 0, 0, 0], dismissed: 0, weeks: {}, ...(w.stats || {}) },
    auto: w.auto !== false,
    delay: Math.max(600, w.delay || 1500),
    enabled: w.enabled !== false,
    dblclick: w.dblclick || "translate",
  };
}
function saveCfg(patch) { updateSettings({ writer: { ...(settings.writer || {}), ...patch } }); }

function hashOf(text, goals) {
  let h = 2166136261 >>> 0;
  const s = text + "\u0001" + JSON.stringify(goals);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36) + ":" + s.length;
}
const words = (t) => (t.match(/\S+/g) || []).length;
function weekKey() {
  const d = new Date(); const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear(); const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- hosts (where the text lives)
function cmUnits(v) {
  const doc = v.state.doc;
  const out = [];
  let start = null, end = null, buf = [];
  const flush = () => { if (start != null) { const text = buf.join("\n"); if (text.trim().length >= 3) out.push({ key: { from: start }, text, from: start, to: end }); } start = null; buf = []; };
  for (let ln = 1; ln <= doc.lines && out.length < 3000; ln++) {
    const l = doc.line(ln);
    if (!l.text.trim()) { flush(); continue; }
    if (start == null) start = l.from;
    end = l.to; buf.push(l.text);
  }
  flush();
  return out;
}

const HOSTS = {
  text: {
    async units() { const v = getView(); return v ? { rev: v.state.doc.length + ":" + v.state.doc.toString().length + ":" + cmRev, units: cmUnits(v) } : { units: [] }; },
    async apply(unit, original, replacement) {
      const v = getView(); if (!v) throw new Error("No editor");
      const cur = cmUnits(v).find((u) => u.text === unit.text) || cmUnits(v).find((u) => u.from === unit.key.from);
      const i = cur ? cur.text.indexOf(original) : -1;
      if (i < 0) throw new Error("The text has changed since it was checked");
      v.dispatch({ changes: { from: cur.from + i, to: cur.from + i + original.length, insert: replacement }, userEvent: "input.ai" });
    },
    async focus(unit, original) {
      const v = getView(); if (!v) return;
      const cur = cmUnits(v).find((u) => u.text === unit.text); if (!cur) return;
      const i = Math.max(0, cur.text.indexOf(original));
      v.dispatch({ selection: { anchor: cur.from + i, head: cur.from + i + original.length }, effects: EditorView.scrollIntoView(cur.from + i, { y: "center" }) });
      v.focus();
    },
    async target() {
      const v = getView(); if (!v) return null;
      const { from, to } = v.state.selection.main;
      if (to > from) return { text: v.state.sliceDoc(from, to), selection: true, from, to };
      const u = cmUnits(v).find((x) => from >= x.from && from <= x.to);
      return u ? { text: u.text, selection: false, from: u.from, to: u.to } : null;
    },
    async replace(t, text) {
      const v = getView();
      if (v.state.sliceDoc(t.from, t.to) !== t.text) throw new Error("The text has changed since it was read");
      v.dispatch({ changes: { from: t.from, to: t.to, insert: text }, userEvent: "input.ai" });
    },
    async insert(text) {
      const v = getView(); const { to } = v.state.selection.main;
      v.dispatch({ changes: { from: to, insert: text }, selection: { anchor: to + text.length }, userEvent: "input.ai" });
    },
  },
  word: {
    async units() { const m = await import("./word.js"); return (await m.wordAI("units")) || { units: [] }; },
    async apply(unit, original, replacement) { const m = await import("./word.js"); await m.wordAI("apply", { block: unit.key.block, original, replacement }); },
    async focus(unit, original) { const m = await import("./word.js"); await m.wordAI("focus", { block: unit.key.block, original }); },
    async target() { const m = await import("./word.js"); return m.wordAI("target"); },
    async replace(t, text) { const m = await import("./word.js"); await m.wordAI("replace", { start: t.start, end: t.end, expect: t.text, text }); },
    async insert(text) { const m = await import("./word.js"); await m.wordAI("insert", { text }); },
  },
  deck: {
    async units() { const m = await import("./deck.js"); return (await m.deckAI("units")) || { units: [] }; },
    async apply(unit, original, replacement) { const m = await import("./deck.js"); await m.deckAI("apply", { shape: unit.key.shape, original, replacement }); },
    async focus(unit, original) { const m = await import("./deck.js"); await m.deckAI("focus", { shape: unit.key.shape, original }); },
    async target() { const m = await import("./deck.js"); return m.deckAI("target"); },
    async replace(t, text) { const m = await import("./deck.js"); await m.deckAI("replace", { target: t, text }); },
    async insert(text) { const m = await import("./deck.js"); await m.deckAI("insert", { text }); },
  },
  sheet: {
    async units() { const m = await import("./sheet.js"); return (await m.sheetAI("units")) || { units: [] }; },
    async apply(unit, original, replacement) { const m = await import("./sheet.js"); await m.sheetAI("apply", { cell: unit.key.cell, original, replacement }); },
    async focus(unit) { const m = await import("./sheet.js"); await m.sheetAI("focus", { cell: unit.key.cell }); },
    async target() { const m = await import("./sheet.js"); return m.sheetAI("target"); },
    async replace(t, text) { const m = await import("./sheet.js"); await m.sheetAI("replace", { target: t, text }); },
    async insert() { throw new Error("Pick a cell and use Replace instead."); },
  },
};
function hostKind(t = activeTab()) {
  if (!t) return null;
  if (t.kind === "doc" && t.wordId) return "word";
  if (t.kind === "deck") return "deck";
  if (t.kind === "sheet" && t.sheetId) return "sheet";
  if (TEXT_KINDS.has(t.kind) && getView()) return "text";
  return null;
}
// ---------------------------------------------------------------- what is on screen
const colNum = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
/** The units of `units` that are on screen now (only those are checked unless the whole document is asked for). */
async function onScreen(k, units) {
  if (k === "text") {
    const v = getView(); if (!v) return units;
    const r = v.scrollDOM.getBoundingClientRect();
    const a = v.posAtCoords({ x: r.left + 40, y: Math.max(r.top + 1, 0) }, false) ?? 0;
    const b = v.posAtCoords({ x: r.left + 40, y: Math.min(r.bottom - 1, innerHeight) }, false) ?? v.state.doc.length;
    return units.filter((u) => u.to >= a && u.from <= b);
  }
  if (k === "word") {
    const wm = await import("./word.js");
    const view = wm.wordView(); if (!view?.scroller) return units;
    const sr = view.scroller.getBoundingClientRect();
    // the part of each page on screen, in points
    const seen = new Map();
    view.pages.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const top = Math.max(r.top, sr.top), bot = Math.min(r.bottom, sr.bottom);
      if (bot > top) seen.set(i, [(top - r.top) / view.z, (bot - r.top) / view.z]);
    });
    return units.filter((u) => {
      if (!Array.isArray(u.at)) return false;
      const [p0, y0, p1, y1] = u.at;
      for (let p = p0; p <= p1; p++) {
        const s2 = seen.get(p); if (!s2) continue;
        const top = p === p0 ? y0 : 0, bot = p === p1 ? y1 : Infinity;
        if (bot >= s2[0] && top <= s2[1]) return true;
      }
      return false;
    });
  }
  if (k === "sheet") {
    const sm = await import("./sheet.js");
    const vis = sm.sheetVisible(); if (!vis) return units;
    return units.filter((u) => { const m = /^([A-Z]+)(\d+)$/.exec(u.key.cell || ""); if (!m) return false; const c = colNum(m[1]), r = +m[2] - 1; return r >= vis.r0 && r <= vis.r1 && c >= vis.c0 && c <= vis.c1; });
  }
  return units; // a slide: all of it is on screen
}

/** The host for Ask / Translate on whatever is shown (the editor, a Word document, a slide…). */
export function currentHost() { const k = hostKind(); return k ? HOSTS[k] : null; }

// ---------------------------------------------------------------- state (one per open file)
const states = new Map();
function stateFor(t) {
  const key = t.path || t.id || t.name;
  let s = states.get(key);
  if (!s) { s = { units: [], checked: new Map(), pending: new Set(), dismissed: new Set(), tone: null, error: null, job: null, changedAt: 0, wanted: false, carry: null, rev: null }; states.set(key, s); }
  return s;
}
let W = null; // the state of the file shown
let kind = null;
let cmRev = 0;
const UI = { panel: false, tab: "suggestions", filter: null, expanded: null, prompt: "", goResult: null, goError: null, goBusy: false, orig: null, origBusy: false, origError: null, acceptedNow: [0, 0, 0, 0] };

function visible() {
  if (!W) return [];
  const c = cfg();
  const dict = new Set(c.dictionary.map((w) => w.toLowerCase()));
  const out = [];
  W.units.forEach((u, ui) => {
    for (const issue of W.checked.get(u.hash) || []) {
      if (W.dismissed.has(u.hash + "|" + issue.original) || dict.has(issue.original.trim().toLowerCase())) continue;
      if (!u.text.includes(issue.original)) continue;
      out.push({ unit: ui, issue });
    }
  });
  return out;
}
function score(shown) {
  if (!W) return null;
  const checked = W.units.filter((u) => W.checked.has(u.hash)).reduce((n, u) => n + words(u.text), 0);
  if (!checked) return null;
  const penalty = shown.reduce((n, s) => n + cat(s.issue.cat).weight, 0);
  const per100 = (penalty * 100) / Math.max(40, checked);
  return Math.round(Math.max(0, Math.min(100, 100 / (1 + per100 / 40))));
}

// ---------------------------------------------------------------- 1. collect
let collectT = 0, collecting = null;
function scheduleCollect(delay = 350) { clearTimeout(collectT); collectT = setTimeout(collect, delay); }
async function collect() {
  const t = activeTab();
  const k = hostKind(t);
  if (k !== kind || (t && W !== stateFor(t))) { kind = k; W = k && t ? stateFor(t) : null; }
  refreshButton();
  if (!W || !cfg().enabled) { drawMarks(); refreshPanel(); return; }
  if (collecting) { scheduleCollect(200); return; }
  const mine = W;
  collecting = (async () => {
    let r;
    try { r = await HOSTS[k].units(); } catch { return; }
    if (mine !== W || !r) return;
    const g = cfg().goals;
    const units = (r.units || []).map((u) => ({ key: u.key, text: u.text, at: u.at, from: u.from, to: u.to, hash: hashOf(u.text, g) }));
    // after an accepted suggestion, the paragraph's other suggestions carry over
    if (W.carry) {
      const { hash: oldHash, accepted, keyJson } = W.carry;
      const old = W.checked.get(oldHash);
      if (old) for (const u of units) if (JSON.stringify(u.key) === keyJson && !W.checked.has(u.hash)) W.checked.set(u.hash, old.filter((i) => i.original !== accepted && u.text.includes(i.original)));
      W.carry = null;
    }
    const before = new Set(W.units.map((u) => u.hash));
    if (units.some((u) => !before.has(u.hash))) W.changedAt = Date.now();
    W.units = units;
  })();
  try { await collecting; } finally { collecting = null; }
  maybeCheck();
  refreshAll();
}

// ---------------------------------------------------------------- 2. analyse
function systemPrompt() {
  const c = cfg(); const g = c.goals;
  const variant = VARIANTS.find(([v]) => v === g.variant)?.[1] || "the text's own language";
  const uiLang = settings.uiLang === "en" ? "English" : "Vietnamese";
  let p = `You are Callio's writing assistant, an expert editor working like Grammarly. Review each numbered unit of the user's document against four criteria:
- correctness: spelling, grammar, punctuation, agreement, wrong or missing words (these are errors);
- clarity: wordy, vague or hard-to-follow phrasing, needless passive voice, overlong sentences — suggest a concise rewrite;
- engagement: repeated, flat or overused words and monotonous sentences — suggest livelier word choices (synonyms);
- delivery: tone and formality that miss the goals, hedging, impolite or overly casual phrasing.
Writing goals: domain ${g.domain}; formality ${g.formality}; audience ${g.audience}; intent ${g.intent}; language variety ${variant}.
Keep each unit's language (never translate) and the author's meaning. Do not flag what is correct and fits the goals. Never change LaTeX commands, citation keys, labels, math, code, URLs or Markdown syntax.
Reply with JSON only, no prose and no code fence:
{"issues": [{"unit": 1, "category": "correctness|clarity|engagement|delivery", "type": "spelling|grammar|punctuation|word choice|wordiness|passive voice|repetition|tone|…", "title": "<a short action in ${uiLang}, e.g. Correct the spelling>", "original": "<exact substring of that unit>", "replacement": "<its replacement; empty to delete>", "explanation": "<one short sentence in ${uiLang}>"}], "tone": "<the document's overall tone in 2–4 words, in ${uiLang}>", "tone_fits": true}
"original" is copied character for character from the unit and is as short as possible while unique in it. At most 8 issues per unit, most important first.`;
  if (c.dictionary.length) p += `\nNever flag these words (the author's dictionary): ${c.dictionary.join(", ")}.`;
  if (settings.aiInstructions?.trim()) p += `\n\nThe author's standing instructions:\n${settings.aiInstructions.trim()}`;
  return p;
}
function jsonIn(s) {
  s = String(s || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
function parseBatch(answer, batch) {
  const v = jsonIn(answer);
  if (!v) throw new Error("The model didn't answer in the expected form. Try again, or pick another model.");
  const by = batch.map(() => []);
  for (const i of v.issues || []) {
    const n = +i.unit;
    if (!(n >= 1 && n <= batch.length)) continue;
    const text = batch[n - 1].text;
    const original = String(i.original || ""), replacement = String(i.replacement ?? "");
    if (!original || original === replacement || !text.includes(original)) continue;
    const list = by[n - 1];
    if (list.some((x) => x.original === original) || list.length >= 8) continue;
    list.push({ cat: parseCat(i.category), kind: String(i.type || ""), title: String(i.title || ""), original, replacement, explanation: String(i.explanation || "") });
  }
  const tone = typeof v.tone === "string" && v.tone.trim() ? { tone: v.tone, fits: v.tone_fits !== false } : null;
  return { results: batch.map((b, k) => [b.hash, by[k]]), tone };
}
function writeModel() { return settings.aiModel_write || null; }

// scanning waits while the page scrolls, and starts 1 s after it stops
let lastScrollAt = 0, scrollT = 0;
function onScrolled() {
  lastScrollAt = Date.now();
  clearTimeout(scrollT);
  scrollT = setTimeout(() => { if (W && cfg().auto) maybeCheck(); }, 1000);
}

/**
 * Check what isn't checked yet: the whole document when it was asked for (W.wanted === "all"),
 * otherwise only the text on screen. What was checked and hasn't changed is never sent again.
 */
async function maybeCheck() {
  if (!W || W.job || W.paused) return;
  const c = cfg();
  const scope = W.wanted === "all" ? "all" : W.wanted === "visible" || c.auto ? "visible" : null;
  if (!scope) return;
  if (scope === "visible" && !W.wanted) {
    // as you type: after a pause; scrolling: 1 s after it stops
    const wait = Math.max(c.delay - (Date.now() - W.changedAt), 1000 - (Date.now() - lastScrollAt));
    if (wait > 0) { clearTimeout(W.autoT); W.autoT = setTimeout(maybeCheck, wait + 20); return; }
  }
  if (scope === "visible" && Date.now() - lastScrollAt < 1000) { clearTimeout(W.autoT); W.autoT = setTimeout(maybeCheck, 1020 - (Date.now() - lastScrollAt)); return; }
  const pool = scope === "all" ? W.units : await onScreen(kind, W.units);
  if (!W) return;
  const todo = [];
  let size = 0;
  for (const u of pool) {
    if (W.checked.has(u.hash) || W.pending.has(u.hash) || todo.some((x) => x.hash === u.hash)) continue;
    if (todo.length >= 24 || size + u.text.length >= 7000) break;
    todo.push(u); size += u.text.length;
  }
  if (!todo.length) { W.wanted = false; W.scope = null; refreshAll(); return; }
  const m = await ai();
  const model = writeModel() || m.modelFor("edit");
  if (!model) {
    // automatic checks stay quiet; an asked-for check says why nothing happens
    if (W.wanted) { W.error = "Sign in to an AI provider in Settings › AI first."; UI.panel = true; }
    W.wanted = false; refreshAll(); return;
  }
  const mine = W;
  mine.scope = scope;
  todo.forEach((u) => mine.pending.add(u.hash));
  mine.error = null;
  const numbered = todo.map((u, i) => `[${i + 1}] ${u.text}\n\n`).join("");
  const job = (mine.job = { started: Date.now(), idRef: {}, scope });
  refreshAll();
  try {
    const answer = await m.runAI("write", { model, idRef: job.idRef, system: systemPrompt(), messages: [{ role: "user", content: numbered }], maxTokens: 8000, effort: settings.writeEffort || null, thinking: !!settings.writeThinking });
    if (mine.job !== job) return;
    const b = parseBatch(answer, todo);
    for (const [h, list] of b.results) { mine.pending.delete(h); mine.checked.set(h, list); }
    if (b.tone) mine.tone = b.tone;
  } catch (e) {
    if (mine.job !== job) return;
    todo.forEach((u) => mine.pending.delete(u.hash));
    mine.wanted = false;
    mine.error = e.message === "NO_MODEL" ? "Sign in to an AI provider in Settings › AI first." : e.message || String(e);
    status(`Writing check: ${mine.error}`, "err");
  } finally {
    if (mine.job === job) mine.job = null;
  }
  refreshAll();
  if (mine === W && (mine.wanted || cfg().auto)) setTimeout(maybeCheck, 50);
}

function progressText() {
  if (!W) return "";
  const done = W.units.filter((u) => W.checked.has(u.hash)).length;
  return `${done} of ${W.units.length}`;
}
/** Pause: the request that is running is stopped (its paragraphs are checked again later),
 *  the whole-document check waits, and automatic checks don't start. */
export async function pauseChecking() {
  if (!W) return;
  W.pausedScope = W.job?.scope === "all" || W.wanted === "all" ? "all" : W.job || W.wanted ? "visible" : null;
  W.paused = true;
  const id = W.job?.idRef?.id;
  if (W.job) { W.units.forEach((u) => W.pending.delete(u.hash)); W.job = null; }
  W.wanted = false;
  clearTimeout(W.autoT);
  if (id) (await ai()).cancelAI(id).catch(() => {});
  status("Checking paused", "ok");
  refreshAll();
}
export function resumeChecking() {
  if (!W) return;
  W.paused = false;
  W.wanted = W.pausedScope || false;
  W.pausedScope = null;
  maybeCheck();
  refreshAll();
}

/** Check the text on screen now (the round button, Check page). */
export function checkVisible() {
  if (!hostKind()) return;
  collect().then(() => { if (W) { W.paused = false; if (W.wanted !== "all") W.wanted = "visible"; W.error = null; maybeCheck(); } refreshAll(); });
}

/** Open the panel and check the whole document (Check writing, Ctrl+Alt+G). */
export function checkNow() {
  const t = activeTab();
  if (!hostKind(t)) { status("The writing assistant works in Markdown, LaTeX and text files, Word documents, presentations and spreadsheets.", "err"); return; }
  UI.panel = true; UI.tab = "suggestions";
  collect().then(() => { if (W) { W.paused = false; W.wanted = "all"; W.error = null; maybeCheck(); } refreshAll(); });
}

// ---------------------------------------------------------------- 3. suggest: underlines
// Markdown / LaTeX / text: CodeMirror marks
const setMarks = StateEffect.define();
const markCache = {};
const markFor = (c) => (markCache[c] ||= Decoration.mark({ class: `wr-u wr-${c}` }));
const marksField = StateField.define({
  create: () => Decoration.none,
  update(d, tr) { d = d.map(tr.changes); for (const e of tr.effects) if (e.is(setMarks)) d = e.value; return d; },
  provide: (f) => EditorView.decorations.from(f),
});
addEditorExtension((k) => (TEXT_KINDS.has(k) ? [marksField, EditorView.updateListener.of((u) => { if (u.docChanged) { cmRev++; scheduleCollect(300); } })] : []));

let marksRaf = 0;
function drawMarks() { if (!marksRaf) marksRaf = requestAnimationFrame(() => { marksRaf = 0; drawMarksNow(); }); }
async function drawMarksNow() {
  const shown = W && cfg().enabled ? visible().slice(0, 150) : [];
  const v = getView();
  if (v && v.state.field(marksField, false) !== undefined) {
    const ranges = [];
    if (kind === "text") {
      const units = cmUnits(v);
      for (const s of shown) {
        const u = W.units[s.unit];
        const cur = units.find((x) => x.text === u.text);
        if (!cur) continue;
        const i = cur.text.indexOf(s.issue.original);
        if (i >= 0) ranges.push(markFor(s.issue.cat).range(cur.from + i, cur.from + i + s.issue.original.length));
      }
    }
    ranges.sort((a, b) => a.from - b.from);
    try { v.dispatch({ effects: setMarks.of(Decoration.set(ranges, true)) }); } catch { /* view gone */ }
  }
  // Word documents: lines drawn on the pages
  document.querySelectorAll(".wd-page .wr-layer").forEach((l) => (l.innerHTML = ""));
  if (kind === "word" && shown.length) {
    const wm = await import("./word.js");
    const view = wm.wordView();
    if (!view) return;
    const items = shown.map((s) => ({ block: W.units[s.unit].key.block, original: s.issue.original }));
    let rects;
    try { rects = await wm.wordAI("marks", { items }); } catch { return; }
    const v2 = wm.wordView(); if (!v2) return;
    const z = v2.z;
    shown.forEach((s, k) => {
      for (const [pg, x, y, w, h] of rects?.[k] || []) {
        const page = v2.pages[pg]; if (!page) continue;
        let layer = page.querySelector(".wr-layer");
        if (!layer) { layer = document.createElement("div"); layer.className = "wr-layer"; page.appendChild(layer); }
        const d = document.createElement("div");
        d.className = `wr-pm wr-${s.issue.cat}`;
        d.style.cssText = `left:${x * z}px;top:${y * z}px;width:${Math.max(3, w * z)}px;height:${h * z}px`;
        d._sh = s;
        layer.appendChild(d);
      }
    });
  }
}

// the card when the pointer rests on an underline
let card = null, cardLeftT = 0, hoverT = 0;
function closeCard() { clearTimeout(cardLeftT); card?.el.remove(); card = null; }
function shownAtCM(e) {
  const v = getView(); if (!v || kind !== "text") return null;
  const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }); if (pos == null) return null;
  const units = cmUnits(v);
  for (const s of visible()) {
    const u = W.units[s.unit]; const cur = units.find((x) => x.text === u.text); if (!cur) continue;
    const i = cur.text.indexOf(s.issue.original); if (i < 0) continue;
    if (pos >= cur.from + i && pos <= cur.from + i + s.issue.original.length) return s;
  }
  return null;
}
document.addEventListener("mousemove", (e) => {
  if (card?.el.contains(e.target)) { clearTimeout(cardLeftT); cardLeftT = 0; return; }
  const onMark = e.target.closest?.(".wr-u, .wr-pm");
  if (!onMark) {
    // pointer left the underline and the card: the card goes shortly after
    if (card && !cardLeftT) cardLeftT = setTimeout(closeCard, 350);
    clearTimeout(hoverT); hoverT = 0;
    return;
  }
  clearTimeout(cardLeftT); cardLeftT = 0;
  if (hoverT) return;
  hoverT = setTimeout(() => {
    hoverT = 0;
    const s = onMark._sh || shownAtCM(e);
    if (!s || (card && card.key === s.issue.original + s.unit)) return;
    const r = onMark.getBoundingClientRect();
    openCard(s, { x: Math.max(r.left, Math.min(e.clientX - 40, r.right)), y: r.bottom + 6 });
  }, 140);
}, { passive: true });
// Word: the lines are under the page's input layer, so find them by position
document.addEventListener("mousemove", (e) => {
  if (kind !== "word" || !W) return;
  const page = e.target.closest?.(".wd-page"); if (!page) return;
  for (const d of page.querySelectorAll(".wr-pm")) {
    const r = d.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 2 && e.clientY <= r.bottom + 3) {
      d.classList.add("hot");
      if (!card || card.key !== d._sh.issue.original + d._sh.unit) { clearTimeout(cardLeftT); cardLeftT = 0; clearTimeout(hoverT); hoverT = setTimeout(() => { hoverT = 0; openCard(d._sh, { x: Math.max(r.left, e.clientX - 40), y: r.bottom + 6 }); }, 140); }
      else { clearTimeout(cardLeftT); cardLeftT = 0; }
      return;
    } else d.classList.remove("hot");
  }
}, { passive: true });

function issueBody(el, s, { inCard }) {
  const c = cat(s.issue.cat);
  el.innerHTML = `
    <div class="wr-kind"><span class="wr-dot" style="--c:${c.color}"></span><span style="color:${c.color}">${c.label}</span>${s.issue.kind ? `<span class="note">· ${esc(s.issue.kind)}</span>` : ""}</div>
    ${s.issue.title ? `<div class="wr-title">${esc(s.issue.title)}</div>` : ""}
    <div class="wr-fixline"><s class="wr-orig">${esc(s.issue.original)}</s><button class="wr-fix" title="Accept">${esc(s.issue.replacement || "(remove)")}</button></div>
    ${s.issue.explanation ? `<div class="wr-expl">${esc(s.issue.explanation)}</div>` : ""}
    <div class="wr-acts">${inCard ? "" : `<button class="small wr-accept">${ic("check")}<span>Accept</span></button>`}<button class="small wr-dismiss">${ic("eye-off")}<span>Dismiss</span></button>${!/\s/.test(s.issue.original.trim()) && s.issue.cat === "correctness" ? `<button class="small wr-learn">${ic("plus")}<span>Add to dictionary</span></button>` : ""}</div>`;
  el.querySelector(".wr-fix").onclick = () => accept(s);
  el.querySelector(".wr-accept")?.addEventListener("click", () => accept(s));
  el.querySelector(".wr-dismiss").onclick = () => dismiss(s);
  el.querySelector(".wr-learn")?.addEventListener("click", () => learn(s.issue.original));
}
function openCard(s, at) {
  closeCard();
  const el = document.createElement("div");
  el.className = "wr-card";
  const body = document.createElement("div");
  issueBody(body, s, { inCard: true });
  el.appendChild(body);
  if (!UI.panel) {
    const b = document.createElement("button");
    b.className = "small wr-openpanel"; b.textContent = "Open the writing panel";
    b.onclick = () => { closeCard(); UI.panel = true; refreshAll(); };
    el.appendChild(b);
  }
  document.body.appendChild(el);
  const w = el.offsetWidth, h = el.offsetHeight;
  let x = at.x, y = at.y;
  if (x + w > innerWidth - 10) x = innerWidth - w - 10;
  if (y + h > innerHeight - 10) y = Math.max(10, at.y - h - 34);
  el.style.left = Math.max(10, x) + "px"; el.style.top = y + "px";
  card = { el, key: s.issue.original + s.unit };
}

// ---------------------------------------------------------------- act
async function accept(s) {
  if (!W) return;
  const u = W.units[s.unit];
  if (!u) return;
  closeCard();
  try {
    W.carry = { hash: u.hash, accepted: s.issue.original, keyJson: JSON.stringify(u.key) };
    await HOSTS[kind].apply(u, s.issue.original, s.issue.replacement);
    const c = cfg(); const i = CATS.findIndex((x) => x.id === s.issue.cat);
    const stats = { ...c.stats, accepted: [...c.stats.accepted], weeks: { ...c.stats.weeks } };
    stats.accepted[i]++; stats.weeks[weekKey()] = (stats.weeks[weekKey()] || 0) + 1;
    UI.acceptedNow[i]++;
    saveCfg({ stats });
    scheduleCollect(60);
  } catch (e) { W.carry = null; status(`Couldn't apply the suggestion: ${e.message || e}`, "err"); }
}
function dismiss(s) {
  const u = W?.units[s.unit]; if (!u) return;
  W.dismissed.add(u.hash + "|" + s.issue.original);
  const c = cfg(); saveCfg({ stats: { ...c.stats, dismissed: c.stats.dismissed + 1 } });
  closeCard(); refreshAll();
}
function learn(word) {
  const w = word.trim(); const c = cfg();
  if (w && !c.dictionary.some((d) => d.toLowerCase() === w.toLowerCase())) { saveCfg({ dictionary: [...c.dictionary, w] }); status(`“${w}” added to your dictionary`, "ok"); }
  closeCard(); refreshAll();
}

// ---------------------------------------------------------------- the round button
let btn = null;
function refreshButton() {
  const k = hostKind();
  const on = !!k && cfg().enabled && !UI.panel;
  if (!btn) {
    btn = document.createElement("button");
    btn.className = "wr-btn";
    btn.title = "Writing assistant (Ctrl+Alt+G checks the document)";
    btn.onclick = () => { UI.panel = true; refreshAll(); checkVisible(); };
    document.body.appendChild(btn);
  }
  btn.hidden = !on;
  if (!on) return;
  // bottom right of the document area
  const sel = { word: "#word-view", deck: "#deck-view", sheet: "#sheet-view, #xlsx-view", text: "#editor-pane" }[k];
  const area = [...document.querySelectorAll(sel)].find((x) => x.offsetWidth > 0) || document.querySelector("#main") || document.body;
  const r = area.getBoundingClientRect();
  const lift = k === "sheet" ? 92 : 46;
  btn.style.left = Math.round(Math.min(innerWidth, r.right) - 40 - 26) + "px";
  btn.style.top = Math.round(Math.min(innerHeight, r.bottom) - 40 - lift) + "px";
  const shown = visible();
  const worst = CATS.find((c) => shown.some((s) => s.issue.cat === c.id));
  btn.style.setProperty("--ring", worst ? worst.color : "var(--gold, #ddb04e)");
  btn.classList.toggle("busy", !!W?.job);
  btn.innerHTML = shown.length ? `<span>${Math.min(99, shown.length)}</span>` : ic("sparkles");
}
addEventListener("resize", () => refreshButton());

// ---------------------------------------------------------------- the panel
let panel = null;
function refreshAll() { refreshButton(); drawMarks(); refreshPanel(); updateFmtBadge(); }
function updateFmtBadge() {
  const b = document.querySelector("#btn-write .wr-count");
  const n = W ? visible().length : 0;
  if (b) { b.textContent = n || ""; b.hidden = !n; }
}
function refreshPanel() {
  // the document makes room for the panel instead of going under it
  document.body.classList.toggle("wr-open", !!(UI.panel && hostKind()));
  if (!UI.panel || !hostKind()) { if (panel) { panel.classList.remove("open"); const p = panel; setTimeout(() => { if (!UI.panel) p.hidden = true; }, 200); } return; }
  if (!panel) {
    panel = document.createElement("aside");
    panel.className = "wr-panel";
    panel.setAttribute("aria-label", "Writing assistant");
    document.body.appendChild(panel);
  }
  panel.hidden = false;
  requestAnimationFrame(() => panel.classList.add("open"));
  const shown = visible();
  const sc = score(shown);
  const checkedN = W ? W.units.filter((u) => W.checked.has(u.hash)).length : 0;
  const keepScroll = panel.querySelector(".wr-tabbody")?.scrollTop || 0;
  const focusPrompt = document.activeElement?.classList.contains("wr-prompt");
  const ring = (() => {
    if (sc == null) return `<svg viewBox="0 0 52 52" class="wr-ring"><circle cx="26" cy="26" r="22" class="bg"/><text x="26" y="31">—</text></svg>`;
    const f = sc / 100, col = sc >= 85 ? "#2bb86a" : sc >= 60 ? "var(--gold, #ddb04e)" : "#f03c45";
    const L = 2 * Math.PI * 22;
    return `<svg viewBox="0 0 52 52" class="wr-ring"><circle cx="26" cy="26" r="22" class="bg"/><circle cx="26" cy="26" r="22" class="fg" style="stroke:${col};stroke-dasharray:${L * f} ${L}"/><text x="26" y="31">${sc}</text></svg>`;
  })();
  panel.innerHTML = `
    <div class="wr-ph"><b>Writing assistant</b><span class="tb-spacer"></span><button class="icon small wr-close" title="Close">${ic("x")}</button></div>
    <div class="wr-top">
      <div class="wr-scorerow">${ring}<div class="wr-sc-t"><b>Overall score</b><span class="note">${shown.length} suggestion${shown.length === 1 ? "" : "s"} · ${checkedN} of ${W?.units.length || 0} checked</span></div></div>
      <div class="wr-checks">
        <button class="small primary wr-check" title="Check the text on screen (what was checked and hasn't changed isn't sent again)"${W?.job || W?.paused ? " disabled" : ""}>${ic("search")}<span>Check page</span></button>
        <button class="small wr-check-all" title="Check the whole document"${W?.job?.scope === "all" || W?.paused ? " disabled" : ""}>${ic("list-checks")}<span>Whole document</span></button>
        ${W?.paused ? `<button class="small wr-resume" title="Go on checking from where it stopped">${ic("play")}<span>Resume</span></button>` : `<button class="small wr-pause" title="Pause the check that is running (and automatic checks) — nothing is lost"${W?.job || W?.wanted ? "" : " disabled"}>${ic("pause")}<span>Pause</span></button>`}
      </div>
      <div class="wr-status">${W?.job ? `<span class="wr-spin"></span><span class="note">${W.job.scope === "all" ? `Checking the whole document… ${progressText()}` : "Checking the text on screen…"}</span>` : W?.paused ? `<span class="note">Paused${W.pausedScope === "all" ? ` — whole document, ${progressText()}` : ""}</span>` : `<span class="note">${cfg().auto ? "The text on screen is checked as you read." : "Automatic checking is off."}</span>`}
        <span class="tb-spacer"></span><label class="switch wr-autosw" title="Start or stop checking the text on screen automatically (after you stop typing, and 1 s after you stop scrolling)"><span>Auto check</span><input type="checkbox"${cfg().auto ? " checked" : ""}><span class="knob"></span></label></div>
      <div class="wr-model-line"></div>
      <div class="wr-tiles">${CATS.map((c) => { const n = shown.filter((s) => s.issue.cat === c.id).length; return `<button class="wr-tile${UI.filter === c.id ? " on" : ""}" data-c="${c.id}" style="--c:${c.color}" title="Show only ${c.label}"><b style="${n ? `color:${c.color}` : ""}">${n}</b><span>${c.label}</span></button>`; }).join("")}</div>
      ${W?.tone ? `<div class="wr-tone" style="color:${W.tone.fits ? "#2bb86a" : "#8b5cf6"}">Tone: ${esc(W.tone.tone)} — ${W.tone.fits ? "fits your goals" : "doesn't quite fit your goals"}</div>` : ""}
      <div class="wr-tabs">${[["suggestions", "Suggestions"], ["goals", "Goals"], ["write", "Write"], ["report", "Report"], ["originality", "Originality"]].map(([id, l]) => `<button data-t="${id}" class="${UI.tab === id ? "on" : ""}">${l}</button>`).join("")}</div>
    </div>
    <div class="wr-tabbody"></div>`;
  panel.querySelector(".wr-close").onclick = () => { UI.panel = false; refreshAll(); };
  panel.querySelector(".wr-check")?.addEventListener("click", () => checkVisible());
  panel.querySelector(".wr-check-all")?.addEventListener("click", () => checkNow());
  panel.querySelector(".wr-pause")?.addEventListener("click", () => pauseChecking());
  panel.querySelector(".wr-resume")?.addEventListener("click", () => resumeChecking());
  panel.querySelector(".wr-autosw input")?.addEventListener("change", (e) => { saveCfg({ auto: e.target.checked }); status(e.target.checked ? "Automatic checking started" : "Automatic checking stopped", "ok"); if (e.target.checked && W && !W.paused) maybeCheck(); refreshAll(); });
  panel.querySelectorAll(".wr-tile").forEach((b) => (b.onclick = () => { UI.filter = UI.filter === b.dataset.c ? null : b.dataset.c; UI.tab = "suggestions"; refreshPanel(); }));
  panel.querySelectorAll(".wr-tabs button").forEach((b) => (b.onclick = () => { UI.tab = b.dataset.t; refreshPanel(); }));
  modelControls({ value: writeModel(), effort: settings.writeEffort, thinking: !!settings.writeThinking, onModel: (v) => { updateSettings({ aiModel_write: v }); }, onEffort: (v) => updateSettings({ writeEffort: v }), onThinking: (v) => updateSettings({ writeThinking: v }) }).then((c) => panel.querySelector(".wr-model-line")?.appendChild(c));
  const body = panel.querySelector(".wr-tabbody");
  if (UI.tab === "suggestions") suggestionsTab(body, shown);
  else if (UI.tab === "goals") goalsTab(body);
  else if (UI.tab === "write") writeTab(body);
  else if (UI.tab === "report") reportTab(body, shown, sc);
  else originalityTab(body);
  body.scrollTop = keepScroll;
  if (focusPrompt) panel.querySelector(".wr-prompt")?.focus();
}

/** Take the reader to a suggestion: scroll the passage to the middle, select and flash it.
 *  Nothing is changed — Accept is a separate click. */
async function goTo(s) {
  const u = W?.units[s.unit]; if (!u) return;
  try { await HOSTS[kind].focus(u, s.issue.original); } catch { /* still try to scroll */ }
  if (kind === "word") {
    const wm = await import("./word.js");
    const rects = await wm.wordAI("marks", { items: [{ block: u.key.block, original: s.issue.original }] }).catch(() => null);
    const view = wm.wordView();
    const r = rects?.[0]?.[0];
    if (view && r) {
      const [pg, x, y, w, h] = r;
      const page = view.pages[pg];
      const sc = view.scroller;
      const pr = page.getBoundingClientRect(), sr = sc.getBoundingClientRect();
      sc.scrollTo({ top: sc.scrollTop + (pr.top - sr.top) + y * view.z - sc.clientHeight / 2 + (h * view.z) / 2, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      const f = document.createElement("div");
      f.className = "wr-flash";
      f.style.cssText = `left:${x * view.z - 3}px;top:${y * view.z - 2}px;width:${w * view.z + 6}px;height:${h * view.z + 4}px`;
      page.appendChild(f);
      setTimeout(() => f.remove(), 1800);
    }
  } else if (kind === "text") {
    const v = getView();
    requestAnimationFrame(() => { const mk = [...(v?.contentDOM.querySelectorAll(".wr-u") || [])].find((e) => e.textContent === s.issue.original); if (mk) { mk.classList.remove("wr-flashing"); void mk.offsetWidth; mk.classList.add("wr-flashing"); } });
  }
}

function suggestionsTab(body, shown) {
  if (W?.error) body.insertAdjacentHTML("beforeend", `<div class="wr-err">${esc(W.error)}</div>`);
  const list = shown.filter((s) => !UI.filter || s.issue.cat === UI.filter);
  if (!list.length) {
    const all = W && W.units.length && W.units.every((u) => W.checked.has(u.hash));
    const msg = W?.job ? (W.job.scope === "all" ? "Checking the whole document…" : "Checking the text on screen…") : all ? "No suggestions — your writing looks great." : !W?.units.length ? "Start writing, and suggestions show up here." : "No suggestions on the part checked so far. The text on screen is checked as you read (Check page); Whole document checks everything.";
    body.insertAdjacentHTML("beforeend", `<div class="wr-empty">${all && !W?.job ? ic("check-circle") : ic("sparkles")}<span>${msg}</span></div>`);
    return;
  }
  for (const s of list.slice(0, 300)) {
    const u = W.units[s.unit];
    const id = u.hash + "|" + s.issue.original;
    const open = UI.expanded === id;
    const c = cat(s.issue.cat);
    const el = document.createElement("div");
    el.className = "wr-item" + (open ? " open" : "");
    el.style.setProperty("--c", c.color);
    if (open) issueBody(el, s, { inCard: false });
    else {
      el.innerHTML = `<div class="wr-line1"><span class="wr-dot" style="--c:${c.color}"></span><s>${esc(preview(s.issue.original, 26))}</s><span class="note">→</span><b>${esc(s.issue.replacement ? preview(s.issue.replacement, 30) : "∅")}</b></div><div class="note">${esc(s.issue.title || s.issue.kind)}</div>`;
      el.onclick = () => { UI.expanded = id; refreshPanel(); goTo(s); };
    }
    body.appendChild(el);
  }
}

function goalsTab(body) {
  const c = cfg();
  const g = c.goals;
  const group = (label, key, opts) => `<div class="wr-g"><b>${label}</b><div class="wr-chips">${opts.map((o) => `<button class="chip${g[key] === o ? " on" : ""}" data-k="${key}" data-v="${esc(o)}">${o}</button>`).join("")}</div></div>`;
  body.innerHTML = `<p class="note">Set goals to get suggestions that fit what you're writing.</p>
    ${group("Domain", "domain", DOMAINS)}${group("Formality", "formality", FORMALITY)}${group("Audience", "audience", AUDIENCE)}${group("Intent", "intent", INTENT)}
    <div class="wr-g"><b>Language variety</b><select class="wr-variant">${VARIANTS.map(([v, l]) => `<option value="${v}"${g.variant === v ? " selected" : ""}>${l}</option>`).join("")}</select></div>
    <div class="wr-g"><label class="check"><input type="checkbox" class="wr-auto"${c.auto ? " checked" : ""}> Check the text on screen automatically <span class="note">(after you stop typing, and 1 s after you stop scrolling; text already checked isn't sent again)</span></label>
      <label class="wr-delay">Pause before checking <input type="number" min="0.6" max="10" step="0.1" value="${(c.delay / 1000).toFixed(1)}"> s</label>
      <label>Double-click a word <select class="wr-dbl"><option value="translate">Translate it</option><option value="meaning">Look up its meaning</option><option value="off">Nothing</option></select></label></div>
    <div class="wr-g"><b>Personal dictionary</b><p class="note">Words here are never flagged. Add them from a suggestion card.</p><div class="wr-chips">${c.dictionary.map((w, i) => `<button class="chip wr-dw" data-i="${i}" title="Remove">${esc(w)} ×</button>`).join("") || `<span class="note">(empty)</span>`}</div></div>`;
  body.querySelector(".wr-dbl").value = c.dblclick;
  body.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => {
    saveCfg({ goals: { ...g, [b.dataset.k]: b.dataset.v } });
    rehash();
  }));
  body.querySelector(".wr-variant").onchange = (e) => { saveCfg({ goals: { ...g, variant: e.target.value } }); rehash(); };
  body.querySelector(".wr-auto").onchange = (e) => { saveCfg({ auto: e.target.checked }); if (e.target.checked) maybeCheck(); };
  body.querySelector(".wr-delay input").onchange = (e) => saveCfg({ delay: Math.round(Math.max(0.6, +e.target.value || 1.5) * 1000) });
  body.querySelector(".wr-dbl").onchange = (e) => saveCfg({ dblclick: e.target.value });
  body.querySelectorAll(".wr-dw").forEach((b) => (b.onclick = () => { const d = [...c.dictionary]; d.splice(+b.dataset.i, 1); saveCfg({ dictionary: d }); refreshAll(); }));
}
/** New goals: everything is checked again against them. */
function rehash() { if (W) { W.units = []; W.wanted = "visible"; } collect(); }

function writeTab(body) {
  body.innerHTML = `<p class="note">Compose, rewrite or brainstorm with AI. Works on the selection (or the paragraph at the cursor).</p>
    <div class="wr-chips">${[["More formal", "Rewrite it in a more formal, professional tone."], ["Friendlier", "Rewrite it in a warmer, friendlier tone."], ["Concise", "Make it more concise without losing meaning."], ["Expand", "Expand it with more detail and supporting points."], ["Simplify", "Rewrite it in simpler words and shorter sentences."], ["Improve it", "Improve its clarity, flow and word choice."], ["Ideas", "Brainstorm 8 ideas, angles or titles related to it, as a list."], ["Summarise", "Summarise it in a few sentences."]].map(([l, i]) => `<button class="chip" data-i="${esc(i)}">${l}</button>`).join("")}</div>
    <textarea class="wr-prompt" rows="3" placeholder="Or tell AI what to write, e.g. Write an email asking for a deadline extension…"></textarea>
    <div class="wr-row">${UI.goBusy ? `<span class="wr-spin"></span><span>Writing…</span>` : `<button class="small primary wr-gen">${ic("sparkles")}<span>Generate</span></button>`}</div>
    ${UI.goError ? `<div class="wr-err">${esc(UI.goError)}</div>` : ""}
    ${UI.goResult != null ? `<div class="wr-result"></div><div class="wr-row"><button class="small wr-ins">${ic("plus")}<span>Insert</span></button><button class="small wr-rep">${ic("check")}<span>Replace selection</span></button><button class="small wr-cp">${ic("copy")}<span>Copy</span></button></div>` : ""}`;
  const pr = body.querySelector(".wr-prompt");
  pr.value = UI.prompt;
  pr.oninput = () => (UI.prompt = pr.value);
  pr.onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); generate(pr.value.trim()); } };
  body.querySelectorAll(".chip[data-i]").forEach((b) => (b.onclick = () => generate(b.dataset.i)));
  body.querySelector(".wr-gen")?.addEventListener("click", () => generate(pr.value.trim()));
  if (UI.goResult != null) {
    body.querySelector(".wr-result").textContent = UI.goResult;
    body.querySelector(".wr-ins").onclick = async () => { try { await HOSTS[kind].insert(UI.goResult); status("Text inserted", "ok"); } catch (e) { status(e.message || String(e), "err"); } };
    body.querySelector(".wr-rep").onclick = async () => { try { const t = await HOSTS[kind].target(); if (!t) throw new Error("Select the text to replace."); await HOSTS[kind].replace(t, UI.goResult); status("Text replaced", "ok"); } catch (e) { status(e.message || String(e), "err"); } };
    body.querySelector(".wr-cp").onclick = () => navigator.clipboard.writeText(UI.goResult).then(() => status("Copied to the clipboard", "ok"));
  }
}
async function generate(instruction) {
  if (!instruction || UI.goBusy) return;
  const m = await ai();
  const model = writeModel() || m.modelFor("edit");
  if (!model) { UI.goError = "Sign in to an AI provider in Settings › AI first."; refreshPanel(); return; }
  const target = (await HOSTS[kind]?.target().catch(() => null))?.text || "";
  const g = cfg().goals;
  let system = `You are a skilled writing assistant inside a document editor (like GrammarlyGO). Do what the user asks. Reply with the resulting text only — no preamble, no quotes, no explanation. Keep the text's language unless asked otherwise.\nWriting goals: domain ${g.domain}, formality ${g.formality}, audience ${g.audience}, intent ${g.intent}.`;
  if (settings.aiInstructions?.trim()) system += `\n\nThe author's standing instructions:\n${settings.aiInstructions.trim()}`;
  const prompt = target.trim() ? `${instruction}\n\nText:\n<<<\n${target}\n>>>` : instruction;
  UI.goBusy = true; UI.goError = null; UI.goResult = null; refreshPanel();
  try { UI.goResult = String(await m.runAI("write", { model, system, messages: [{ role: "user", content: prompt }], effort: settings.writeEffort || null, thinking: !!settings.writeThinking })).trim(); }
  catch (e) { UI.goError = e.message === "NO_MODEL" ? "Sign in to an AI provider in Settings › AI first." : e.message || String(e); }
  finally { UI.goBusy = false; refreshPanel(); }
}

const STOP = new Set("the a an and or of to in on for is are was were be it this that with as at by i we you he she they not but from have has will can và là của các những một cho với trong được có không này đã để khi thì về người như từ đến cũng".split(" "));
function reportTab(body, shown, sc) {
  const text = (W?.units || []).map((u) => u.text).join("\n");
  const list = (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []);
  const n = list.length;
  const sentences = Math.max(1, text.split(/[.!?\n]/).filter((x) => x.trim().split(/\s+/).filter(Boolean).length).length);
  const uniq = new Set(list).size;
  const c = cfg();
  const freq = new Map();
  for (const w of list) if ([...w].length > 2 && !STOP.has(w) && !/^\d+$/.test(w)) freq.set(w, (freq.get(w) || 0) + 1);
  const top = [...freq].filter(([, k]) => k > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10);
  const thisWeek = c.stats.weeks[weekKey()] || 0;
  const total = c.stats.accepted.reduce((a, b) => a + b, 0);
  const weeks = Object.entries(c.stats.weeks).sort().slice(-8);
  const max = Math.max(1, ...weeks.map(([, v]) => v));
  body.innerHTML = `<b>This document</b>
    <table class="wr-rep">${[["Overall score", sc ?? "—"], ["Words", n], ["Sentences", sentences], ["Average sentence length", (n / sentences).toFixed(1)], ["Reading time", `${Math.max(1, Math.ceil(n / 230))} min`], ["Unique words", `${n ? Math.round((uniq * 100) / n) : 0}%`]].map(([k, v]) => `<tr><td>${k}</td><td><b>${v}</b></td></tr>`).join("")}
    ${CATS.map((x) => `<tr><td>${x.label}</td><td style="color:${x.color}"><b>${shown.filter((s) => s.issue.cat === x.id).length}</b></td></tr>`).join("")}</table>
    ${top.length ? `<b>Most used words</b><p>${top.map(([w, k]) => `${esc(w)} (${k})`).join(", ")}</p>` : ""}
    <b>Your progress</b><p>${thisWeek} suggestions accepted this week, ${total} in all</p>
    <p class="note">${CATS.map((x, i) => `${x.label}: ${c.stats.accepted[i] || 0}`).join(" · ")} · ${c.stats.dismissed} dismissed</p>
    ${weeks.length > 1 ? `<div class="wr-weeks">${weeks.map(([w, v]) => `<div><span class="note">${w}</span><i style="width:${Math.max(2, (160 * v) / max)}px"></i><span>${v}</span></div>`).join("")}</div>` : ""}`;
}

function originalityTab(body) {
  body.innerHTML = `<p class="note">Searches the web for passages of this document that appear elsewhere (each distinctive sentence is searched, in quotes, with the search engine picked in the AI chat — Google unless you chose another web engine).</p>
    <div class="wr-row">${UI.origBusy ? `<span class="wr-spin"></span><span>Searching the web… ${UI.origBusy}</span>` : `<button class="small primary wr-orig-go"${W?.units.length ? "" : " disabled"}>${ic("search")}<span>Check originality</span></button>`}</div>
    ${UI.origError ? `<div class="wr-err">${esc(UI.origError)}</div>` : ""}<div class="wr-orig-res"></div>`;
  body.querySelector(".wr-orig-go")?.addEventListener("click", originality);
  if (UI.orig) {
    const r = UI.orig;
    const box = body.querySelector(".wr-orig-res");
    box.innerHTML = `<div class="wr-pct" style="color:${r.pct >= 90 ? "#2bb86a" : "#f03c45"}">${r.pct}% original</div><p class="note">${r.checked} sentence${r.checked === 1 ? "" : "s"} searched</p>`;
    if (!r.matches.length) box.insertAdjacentHTML("beforeend", "<p>No matching text found online.</p>");
    for (const m of r.matches) {
      const d = document.createElement("div"); d.className = "wr-item";
      d.innerHTML = `<i>“${esc(m.quote)}”</i><a href="#" class="wr-link"></a>`;
      const a = d.querySelector("a"); a.textContent = m.title || m.url; a.title = m.url;
      a.onclick = (e) => { e.preventDefault(); call("open_url", { url: m.url }).catch(() => window.open(m.url)); };
      box.appendChild(d);
    }
  }
}
async function originality() {
  if (!W || UI.origBusy) return;
  const text = W.units.map((u) => u.text).join("\n");
  const sentences = [...new Set(text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 10))].sort((a, b) => b.length - a.length).slice(0, 8);
  if (!sentences.length) { UI.origError = "There are no sentences long enough to search."; refreshPanel(); return; }
  const e0 = settings.aiSearchEngine;
  const engine = e0 && !["auto", "scholar", "semantic", "openalex", "arxiv", "pubmed", "europepmc", "crossref", "dblp"].includes(e0) ? e0 : "google";
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  UI.origError = null; UI.orig = null;
  const matches = [];
  let found = 0;
  for (let i = 0; i < sentences.length; i++) {
    UI.origBusy = `${i + 1} of ${sentences.length}`; refreshPanel();
    const s = sentences[i];
    const q = s.split(/\s+/).slice(0, 24).join(" ");
    let hits = [];
    try { hits = await call("web_search_engine", { engine, query: `"${q}"` }); } catch (e) { UI.origError = e.message || String(e); }
    // a hit whose snippet carries 8 words in a row of the sentence
    const ws = norm(s).split(" ");
    const grams = new Set(); for (let k = 0; k + 8 <= ws.length; k++) grams.add(ws.slice(k, k + 8).join(" "));
    const hit = (hits || []).find((h) => { const sn = norm(`${h.title} ${h.snippet}`); for (const g of grams) if (sn.includes(g)) return true; return false; });
    if (hit) { found++; matches.push({ quote: s, url: hit.url, title: hit.title }); }
  }
  UI.origBusy = false;
  UI.orig = { pct: Math.round(100 - (found * 100) / sentences.length), checked: sentences.length, matches };
  refreshPanel();
}

// ---------------------------------------------------------------- right-click, keys, double-click
function domSelectionHost(text) {
  return { target: async () => ({ text, selection: true }) };
}
async function aiMenu(e, k) {
  const host = k ? HOSTS[k] : null;
  const sel = String(getSelection() || "").trim();
  const items = [];
  // on an underline: its fix first
  const s = k === "text" ? shownAtCM(e) : null;
  if (s) {
    items.push({ header: cat(s.issue.cat).label }, { label: s.issue.replacement || "(remove)", icon: "check", action: () => accept(s) }, { label: "Dismiss", icon: "eye-off", action: () => dismiss(s) }, "-");
  }
  if (k === "text") {
    const v = getView(); const r = v.state.selection.main; const has = r.to > r.from;
    items.push(
      { label: "Cut", key: "Ctrl+X", disabled: !has, action: () => { navigator.clipboard.writeText(v.state.sliceDoc(r.from, r.to)); v.dispatch({ changes: { from: r.from, to: r.to, insert: "" }, userEvent: "delete.cut" }); } },
      { label: "Copy", key: "Ctrl+C", icon: "copy", disabled: !has, action: () => navigator.clipboard.writeText(v.state.sliceDoc(r.from, r.to)) },
      { label: "Paste", key: "Ctrl+V", action: async () => { const t = await navigator.clipboard.readText().catch(() => ""); if (t) v.dispatch(v.state.replaceSelection(t)); } },
      "-",
    );
  } else if (!k && sel) {
    items.push({ label: "Copy", key: "Ctrl+C", icon: "copy", action: () => navigator.clipboard.writeText(sel) }, "-");
  }
  const h = host || (sel ? domSelectionHost(sel) : null);
  if (!h) return false;
  if (host && cfg().enabled) items.push({ label: "Check writing with AI", key: "Ctrl+Alt+G", icon: "wand", action: checkNow }, { label: "Ask AI…", key: "Ctrl+Alt+K", icon: "sparkles", action: () => openAssist("ask", h, { at: { x: e.clientX, y: e.clientY } }) });
  items.push(
    { label: "Translate", key: "Ctrl+Alt+T", icon: "globe", action: () => openAssist("translate", h, { at: { x: e.clientX, y: e.clientY } }) },
    { label: "Look up meaning", key: "Ctrl+Alt+D", icon: "search", action: () => openAssist("meaning", h, { at: { x: e.clientX, y: e.clientY } }) },
  );
  if (k === "text") { const v = getView(); items.push("-", { label: "Select All", key: "Ctrl+A", action: () => v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } }) }); }
  showContextMenu(e, items);
  return true;
}

export function initWriting() {
  // the editor: our menu instead of the browser's
  addEditorExtension((k) => [EditorView.domEventHandlers({ contextmenu(e) { e.preventDefault(); aiMenu(e, TEXT_KINDS.has(k) ? "text" : null).then((ok) => { if (!ok) aiMenu(e, null); }); return true; } })]);
  // Word documents and slides ask for it
  addEventListener("callio-ai-menu", (ev) => { const { event, kind: k } = ev.detail; aiMenu(event, k); });
  // text selected anywhere else (the preview, a PDF, the chat)
  document.addEventListener("contextmenu", (e) => {
    if (e.defaultPrevented || e.target.closest?.(".cm-editor, input, textarea, select, .tree-item, .tab, [contenteditable=true], .wd-scroll, .dk-stage")) return;
    if (!String(getSelection() || "").trim()) return;
    e.preventDefault();
    aiMenu(e, null);
  });
  // double-click a word: translate it (or its meaning)
  const dbl = (e, k) => {
    const mode = cfg().dblclick;
    if (mode === "off") return;
    const t = activeTab();
    if (k === "text" && !TEXT_KINDS.has(t?.kind)) return;
    const at = { x: e.clientX, y: e.clientY };
    setTimeout(async () => {
      let text = "";
      if (k === "text") { const v = getView(); const r = v?.state.selection.main; if (r && r.to > r.from) text = v.state.sliceDoc(r.from, r.to); }
      else if (k === "word") { const tg = await HOSTS.word.target().catch(() => null); if (tg?.selection) text = tg.text; }
      else text = String(getSelection() || "");
      text = text.trim();
      if (!text || text.length > 60 || /\n/.test(text) || !/\p{L}/u.test(text)) return;
      openAssist(mode, k ? HOSTS[k] : domSelectionHost(text), { at, ...(k ? {} : { text }) });
    }, k === "word" ? 120 : 30);
  };
  addEditorExtension((k) => (TEXT_KINDS.has(k) ? [EditorView.domEventHandlers({ dblclick(e) { dbl(e, "text"); return false; } })] : []));
  addEventListener("callio-ai-dblclick", (ev) => dbl(ev.detail.event, ev.detail.kind));
  document.addEventListener("dblclick", (e) => { if (e.target.closest?.("#preview, .md-body, .pdf-page, .textLayer, #ai-panel .msg")) dbl(e, null); });
  // keys
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || !e.altKey || e.shiftKey) return;
    const key = e.key.toLowerCase();
    if (!["g", "k", "t", "d"].includes(key)) return;
    const k = hostKind();
    const sel = String(getSelection() || "").trim();
    const h = k ? HOSTS[k] : sel ? domSelectionHost(sel) : null;
    if (!h) return;
    e.preventDefault();
    if (key === "g") checkNow();
    else openAssist(key === "k" ? "ask" : key === "t" ? "translate" : "meaning", h);
  }, true);
  // the toolbar button
  const b = document.getElementById("btn-write");
  if (b) b.onclick = () => { UI.panel = !UI.panel; if (UI.panel) checkNow(); else refreshAll(); };
  // follow the documents
  addEventListener("callio-doc-changed", () => scheduleCollect(400));
  // scrolling: no checks while it moves; the text on screen is checked 1 s after it stops
  document.addEventListener("scroll", (e) => { if (W && e.target?.closest?.(".cm-scroller, .wd-scroll, .sh-scroll, #word-view, #sheet-view")) onScrolled(); }, { capture: true, passive: true });
  document.addEventListener("wheel", (e) => { if (W && e.target?.closest?.(".cm-editor, .wd-scroll, .sh-scroll, #deck-view")) onScrolled(); }, { capture: true, passive: true });
  addEventListener("callio-tab-switched", () => { closeCard(); closeAssist(); scheduleCollect(60); });
  setInterval(() => { const t = activeTab(); const k = hostKind(t); if (k !== kind || (k && t && W !== stateFor(t))) scheduleCollect(0); else if (k) refreshButton(); }, 700);
  scheduleCollect(800);
}
