// Writing suggestions (like Grammarly) and Translate, for the text editors (Markdown, LaTeX, plain
// text…). The author's own AI account does the work: spelling, grammar, punctuation, style and
// clarity issues come back as underlines; clicking one opens a card at the mouse with the fixes,
// and the card can switch the model, provider, effort and thinking, take an instruction and pick
// writing guides. Translate (right-click a selection) uses Google Translate by default, or any
// AI model that is set up.
import { StateField, StateEffect } from "@codemirror/state";
import { EditorView, Decoration } from "@codemirror/view";
import { getView, addEditorExtension } from "./editor.js";
import { call } from "./api.js";
import { settings, updateSettings, activeTab, status, toast } from "./main.js";
import { ic } from "./icons.js";
import { showContextMenu } from "./ctxmenu.js";

const ai = () => import("./ai.js");
const KINDS = { spelling: "Spelling", grammar: "Grammar", punctuation: "Punctuation", style: "Style", clarity: "Clarity", syntax: "Syntax", word: "Word choice", tone: "Tone" };
const TEXT_KINDS = new Set(["md", "tex", "text", "bib"]);

// ---------------- issues in the editor ----------------
const setIssues = StateEffect.define();
const marks = {};
const markFor = (k) => (marks[k] ||= Decoration.mark({ class: `wr-u wr-${k in KINDS ? k : "style"}` }));
const issuesField = StateField.define({
  create: () => [],
  update(list, tr) {
    let next = list;
    if (tr.docChanged) {
      next = next.filter((i) => !tr.changes.touchesRange(i.from, i.to)).map((i) => ({ ...i, from: tr.changes.mapPos(i.from, 1), to: tr.changes.mapPos(i.to, -1) })).filter((i) => i.to > i.from);
    }
    for (const e of tr.effects) if (e.is(setIssues)) next = e.value(next);
    return next;
  },
  provide: (f) => EditorView.decorations.from(f, (list) => Decoration.set([...list].sort((a, b) => a.from - b.from).map((i) => markFor(i.kind).range(i.from, i.to)), true)),
});
const issuesOf = (v = getView()) => v?.state.field(issuesField, false) || [];
const issueAt = (v, pos) => issuesOf(v).find((i) => pos >= i.from && pos <= i.to);

let hoverT = 0;
const handlers = EditorView.domEventHandlers({
  mousedown(e, v) {
    if (e.button !== 0) return false;
    const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
    const it = pos != null && issueAt(v, pos);
    if (it) setTimeout(() => openCard({ x: e.clientX, y: e.clientY }, it), 0);
    return false;
  },
  mousemove(e, v) {
    clearTimeout(hoverT);
    if (!e.target.closest?.(".wr-u")) return false;
    hoverT = setTimeout(() => {
      const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
      const it = pos != null && issueAt(v, pos);
      if (it && card?.issue !== it) openCard({ x: e.clientX, y: e.clientY }, it);
    }, 450);
    return false;
  },
  contextmenu(e, v) { editorMenu(e, v); return true; },
});
const edited = EditorView.updateListener.of((u) => { if (u.docChanged && u.transactions.some((t) => t.isUserEvent("input") || t.isUserEvent("delete"))) onEdited(); });
export function initWriting() {
  addEditorExtension((kind) => (TEXT_KINDS.has(kind) ? [issuesField, handlers, edited] : [EditorView.domEventHandlers({ contextmenu(e, v) { editorMenu(e, v); return true; } })]));
  const b = document.getElementById("btn-write");
  if (b) b.onclick = () => { const r = b.getBoundingClientRect(); openCard({ x: r.left, y: r.bottom - 14 }); };
}

// ---------------- checking ----------------
const ignored = new Set();
const checked = new Map(); // paragraph text → issues found (relative), so unchanged text isn't sent twice
let running = null;

function paragraphsIn(doc, from, to) {
  // blocks separated by blank lines, merged up to ~2500 characters
  const out = [];
  let start = null, end = null, size = 0;
  const flush = () => { if (start != null) out.push({ from: start, to: end }); start = null; size = 0; };
  for (let ln = doc.lineAt(from).number; ln <= doc.lineAt(to).number; ln++) {
    const l = doc.line(ln);
    if (!l.text.trim()) { if (size > 1200) flush(); else if (start != null) end = l.to; continue; }
    if (start == null) start = l.from;
    end = l.to;
    size += l.length;
    if (size > 2500) flush();
  }
  flush();
  return out;
}

function writingSystem(lang, guides, instruction) {
  return `You are a meticulous copy editor (like Grammarly) for a ${lang} document. Find real problems only: spelling, grammar, punctuation, word choice, clarity, style, tone${lang === "LaTeX" ? ", and LaTeX syntax mistakes (unbalanced braces, wrong commands)" : ""}. Work in the text's own language (Vietnamese, English, …).
Do NOT touch: LaTeX commands, citation keys, labels, math, code, URLs, Markdown syntax, proper names spelled on purpose.
Reply with ONLY a JSON array, no prose, no code fences. Each item:
{"quote": "<the exact text to change, copied character for character from the input, short (one word to one sentence) and unique>", "fix": ["<replacement>", "<optional second replacement>"], "kind": "spelling|grammar|punctuation|word|clarity|style|tone|syntax", "why": "<one short sentence>"}
Return [] when the text is fine. At most 25 items, most important first.${instruction ? `\nThe author also asks: ${instruction}` : ""}${guides ? `\n\nFollow the author's writing guides:\n${guides}` : ""}`;
}

function parseIssues(raw) {
  let s = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const a = s.indexOf("["), b = s.lastIndexOf("]");
  if (a < 0 || b < a) return [];
  try { const v = JSON.parse(s.slice(a, b + 1)); return Array.isArray(v) ? v : []; } catch { return []; }
}

async function guidesText() {
  const want = settings.writeSkills || [];
  if (!want.length) return "";
  const m = await ai();
  let out = "";
  for (const s of m.skills().filter((x) => want.includes(x.name))) {
    const t = await m.skillContent(s).catch(() => "");
    if (t) out += `\n## ${s.name}\n${t.slice(0, 20000)}\n`;
  }
  return out.slice(0, 60000);
}

/** Check the document (or `from…to`); progress in the status bar, results as underlines. */
export async function checkWriting({ from, to, quiet = false } = {}) {
  const v = getView();
  const t = activeTab();
  if (!v || !t || !TEXT_KINDS.has(t.kind)) { if (!quiet) toast("Writing suggestions work in Markdown, LaTeX and text files.", "", 3000); return; }
  const m = await ai();
  const model = settings.aiModel_write || m.modelFor("edit");
  if (!model) { if (!quiet) toast("Set up an AI model first (Settings → AI).", "", 3500); return; }
  if (running) running.cancelled = true;
  const job = (running = { cancelled: false });
  const doc = v.state.doc;
  const a = from ?? 0, b = to ?? doc.length;
  const paras = paragraphsIn(doc, a, b).filter((p) => doc.sliceString(p.from, p.to).trim().length > 3);
  const lang = t.kind === "tex" || t.kind === "bib" ? "LaTeX" : t.kind === "md" ? "Markdown" : "plain text";
  const guides = await guidesText();
  const system = writingSystem(lang, guides, settings.writeInstruction || "");
  let found = 0, done = 0;
  const { loading } = await import("./loading.js");
  const ld = quiet ? null : loading("Checking the writing…", { delay: 0, detail: `${paras.length} paragraph${paras.length === 1 ? "" : "s"}`, cancel: () => { job.cancelled = true; } });
  try {
    // two at a time: quick, without flooding the provider
    const queue = [...paras];
    const worker = async () => {
      while (queue.length && !job.cancelled) {
        const p = queue.shift();
        const text = v.state.doc.sliceString(p.from, p.to);
        const key = model + "|" + (settings.writeInstruction || "") + "|" + text;
        let list = checked.get(key);
        if (!list) {
          const raw = await m.runAI("write", { model, system, messages: [{ role: "user", content: text }], temperature: 0.1, maxTokens: 2000, effort: settings.writeEffort || null, thinking: !!settings.writeThinking });
          list = parseIssues(raw);
          checked.set(key, list);
          if (checked.size > 400) checked.delete(checked.keys().next().value);
        }
        if (job.cancelled) return;
        // place each quote in the paragraph as it is now
        const cur = getView();
        if (!cur) return;
        const now = cur.state.doc.sliceString(p.from, Math.min(p.to, cur.state.doc.length));
        if (now !== text) continue; // edited meanwhile: the next check catches it
        const add = [];
        let at = 0;
        for (const it of list) {
          const q = String(it.quote || "");
          if (!q || ignored.has(q + "|" + it.why)) continue;
          let i = now.indexOf(q, at);
          if (i < 0) i = now.indexOf(q);
          if (i < 0) continue;
          at = i + q.length;
          const fixes = (Array.isArray(it.fix) ? it.fix : [it.fix]).map(String).filter((f) => f !== q).slice(0, 3);
          if (!fixes.length && !it.why) continue;
          add.push({ from: p.from + i, to: p.from + i + q.length, quote: q, fixes, kind: String(it.kind || "style").toLowerCase(), why: String(it.why || "") });
        }
        found += add.length;
        cur.dispatch({ effects: setIssues.of((old) => [...old.filter((o) => o.to <= p.from || o.from >= p.to), ...add]) });
        done++;
        ld?.set(done / paras.length, null, `${done} of ${paras.length} · ${found} suggestion${found === 1 ? "" : "s"}`);
        updateBadge();
      }
    };
    await Promise.all([worker(), worker()]);
    if (!quiet && !job.cancelled) status(found ? `${found} writing suggestion${found === 1 ? "" : "s"} — click an underline` : "No writing problems found", "ok");
  } catch (e) {
    if (!quiet) status(`Writing check failed: ${e.message === "NO_MODEL" ? "set up an AI model first" : e.message}`, "err");
  } finally { ld?.done(); if (running === job) running = null; updateBadge(); }
}

// check as you type: the paragraph you left, after a pause
let autoT = 0;
export function onEdited() {
  if (!settings.writeAuto) return;
  clearTimeout(autoT);
  autoT = setTimeout(() => {
    const v = getView(); const t = activeTab();
    if (!v || !t || !TEXT_KINDS.has(t.kind)) return;
    const head = v.state.selection.main.head;
    const [p] = paragraphsIn(v.state.doc, head, head);
    if (p) checkWriting({ from: p.from, to: p.to, quiet: true });
  }, 2500);
}

function updateBadge() {
  const n = issuesOf().length;
  const b = document.querySelector("#btn-write .wr-count");
  if (b) { b.textContent = n || ""; b.hidden = !n; }
}

// ---------------- the card at the mouse ----------------
let card = null;
function closeCard() { card?.el.remove(); card = null; document.removeEventListener("pointerdown", awayCard, true); document.removeEventListener("keydown", escCard, true); }
function awayCard(e) { if (card && !card.el.contains(e.target) && !e.target.closest?.(".wr-u")) closeCard(); }
function escCard(e) { if (e.key === "Escape" && card) { e.stopPropagation(); closeCard(); } }

async function modelControls(role, effortKey, thinkKey) {
  const m = await ai();
  const wrap = document.createElement("div");
  wrap.className = "wr-models";
  const sel = document.createElement("select");
  sel.className = "wr-model";
  sel.title = "Provider and model";
  m.fillModelOptions(sel, { claudeCode: true });
  if (role === "translate") {
    const g = document.createElement("optgroup"); g.label = "Translation services";
    const o = document.createElement("option"); o.value = "google"; o.textContent = "Google Translate"; g.appendChild(o);
    sel.prepend(g);
  }
  [...sel.querySelectorAll('option[value="claudecode|__other"]')].forEach((o) => o.remove());
  const key = `aiModel_${role}`;
  if (role !== "translate" && !sel.querySelector("option")) {
    const o = document.createElement("option"); o.value = ""; o.textContent = "Set up an AI model…"; sel.appendChild(o);
  }
  sel.value = settings[key] || (role === "translate" ? "google" : m.modelFor("edit") || "");
  if (!sel.value && sel.options.length) sel.selectedIndex = 0;
  const eff = document.createElement("select");
  eff.className = "wr-effort";
  eff.title = "Effort (Claude models)";
  eff.innerHTML = `<option value="">Effort: default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra</option>`;
  eff.value = settings[effortKey] || "";
  const think = document.createElement("label");
  think.className = "switch wr-think";
  think.title = "Let the model think first (slower, sometimes better)";
  think.innerHTML = `<span>Thinking</span><input type="checkbox"${settings[thinkKey] ? " checked" : ""}><span class="knob"></span>`;
  const sync = () => {
    const v = sel.value;
    const isAi = v && v !== "google";
    eff.hidden = !isAi || !m.isClaudeModel(v) || /haiku/.test(v);
    think.hidden = !isAi;
  };
  sel.onchange = () => { if (!sel.value) { import("./settings.js").then((x) => x.openSettings("ai")); return; } updateSettings({ [key]: sel.value }); sync(); };
  eff.onchange = () => updateSettings({ [effortKey]: eff.value });
  think.querySelector("input").onchange = (e) => updateSettings({ [thinkKey]: e.target.checked });
  sync();
  wrap.append(sel, eff, think);
  return wrap;
}

function place(el, at) {
  document.body.appendChild(el);
  const w = el.offsetWidth, h = el.offsetHeight;
  let x = at.x + 4, y = at.y + 18;
  if (x + w > innerWidth - 10) x = innerWidth - w - 10;
  if (y + h > innerHeight - 10) y = Math.max(10, at.y - h - 10);
  el.style.left = Math.max(10, x) + "px";
  el.style.top = y + "px";
}

/** Open the suggestions card at `at` (mouse point) — for an issue, or the general panel. */
export async function openCard(at, issue = null) {
  closeCard();
  const el = document.createElement("div");
  el.className = "wr-card";
  el.setAttribute("role", "dialog");
  const m = await ai();
  const n = issuesOf().length;
  el.innerHTML = `
    <div class="wr-head">${ic("wand")}<b>Writing suggestions</b><span class="note">${n ? `${n} in this file` : ""}</span><span class="tb-spacer"></span><button class="icon small wr-x" title="Close (Esc)">${ic("x")}</button></div>
    ${issue ? `<div class="wr-issue"><span class="wr-kind wr-k-${issue.kind}">${KINDS[issue.kind] || "Suggestion"}</span><div class="wr-why"></div><div class="wr-from"><s></s></div><div class="wr-fixes"></div>
      <div class="wr-row"><button class="small wr-ignore">${ic("eye-off")}<span>Ignore</span></button><button class="small wr-all" title="Apply every suggestion of this kind">${ic("check")}<span>Fix all ${KINDS[issue.kind] ? KINDS[issue.kind].toLowerCase() : ""}</span></button><span class="tb-spacer"></span><button class="icon small wr-prev" title="Previous">${ic("arrow-up")}</button><button class="icon small wr-next" title="Next">${ic("arrow-down")}</button></div></div>` : ""}
    <div class="wr-tools">
      <div class="wr-line wr-model-line"></div>
      <div class="wr-line"><input class="wr-ask" placeholder="Ask for a change… (e.g. more formal, shorter, British spelling)" value=""><button class="small primary wr-go" title="Rewrite the selection or this paragraph">${ic("sparkles")}<span>Rewrite</span></button></div>
      <div class="wr-line wr-skills"></div>
      <div class="wr-line"><button class="small wr-check-p">${ic("search")}<span>Check paragraph</span></button><button class="small wr-check-d">${ic("list-checks")}<span>Check document</span></button><span class="tb-spacer"></span><label class="switch wr-auto" title="Check the paragraph you were writing after a short pause (uses the AI model)"><span>As I type</span><input type="checkbox"${settings.writeAuto ? " checked" : ""}><span class="knob"></span></label></div>
    </div>`;
  el.querySelector(".wr-model-line").appendChild(await modelControls("write", "writeEffort", "writeThinking"));
  // writing guides (skills) to follow
  const sk = el.querySelector(".wr-skills");
  const list = m.skills();
  if (list.length) {
    sk.innerHTML = `<span class="note">Guides:</span>`;
    const on = new Set(settings.writeSkills || []);
    for (const s of list.slice(0, 12)) {
      const b = document.createElement("button");
      b.className = "chip" + (on.has(s.name) ? " on" : "");
      b.textContent = s.name;
      b.title = on.has(s.name) ? "Followed — click to stop" : "Click to follow this guide";
      b.onclick = () => { on.has(s.name) ? on.delete(s.name) : on.add(s.name); updateSettings({ writeSkills: [...on] }); b.classList.toggle("on"); checked.clear(); };
      sk.appendChild(b);
    }
  } else sk.remove();
  if (issue) {
    el.querySelector(".wr-why").textContent = issue.why;
    el.querySelector(".wr-from s").textContent = issue.quote;
    const fx = el.querySelector(".wr-fixes");
    for (const f of issue.fixes) {
      const b = document.createElement("button");
      b.className = "wr-fix";
      b.textContent = f || "(remove)";
      b.onclick = () => { apply(issue, f); nextIssue(issue, 1, true); };
      fx.appendChild(b);
    }
    el.querySelector(".wr-ignore").onclick = () => { ignored.add(issue.quote + "|" + issue.why); removeIssue(issue); nextIssue(issue, 1, true); };
    el.querySelector(".wr-all").onclick = () => { const all = issuesOf().filter((i) => i.kind === issue.kind && i.fixes.length).sort((a, b) => b.from - a.from); for (const i of all) apply(i, i.fixes[0]); status(`Applied ${all.length} suggestion${all.length === 1 ? "" : "s"}`, "ok"); closeCard(); };
    el.querySelector(".wr-prev").onclick = () => nextIssue(issue, -1);
    el.querySelector(".wr-next").onclick = () => nextIssue(issue, 1);
  }
  el.querySelector(".wr-x").onclick = closeCard;
  el.querySelector(".wr-check-p").onclick = () => { const v = getView(); const h = v.state.selection.main; const [p] = paragraphsIn(v.state.doc, h.from, h.to); closeCard(); if (p) checkWriting({ from: p.from, to: p.to }); };
  el.querySelector(".wr-check-d").onclick = () => { closeCard(); checkWriting(); };
  el.querySelector(".wr-auto input").onchange = (e) => updateSettings({ writeAuto: e.target.checked });
  const ask = el.querySelector(".wr-ask");
  const go = async () => {
    const instr = ask.value.trim();
    if (!instr) return ask.focus();
    const v = getView();
    let { from, to } = v.state.selection.main;
    if (from === to) { const [p] = paragraphsIn(v.state.doc, from, from); if (p) { from = p.from; to = p.to; v.dispatch({ selection: { anchor: from, head: to } }); } }
    closeCard();
    const g = await guidesText();
    (await ai()).runAction("custom", instr + (g ? `\n\nFollow these writing guides:\n${g}` : ""));
  };
  el.querySelector(".wr-go").onclick = go;
  ask.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } };
  place(el, at);
  card = { el, issue };
  document.addEventListener("pointerdown", awayCard, true);
  document.addEventListener("keydown", escCard, true);
}

function apply(issue, text) {
  const v = getView();
  if (!v) return;
  const cur = issuesOf(v).find((i) => i.quote === issue.quote && i.why === issue.why && Math.abs(i.from - issue.from) < 4) || issue;
  if (v.state.sliceDoc(cur.from, cur.to) !== issue.quote) return;
  v.dispatch({ changes: { from: cur.from, to: cur.to, insert: text }, userEvent: "input.ai", effects: setIssues.of((l) => l.filter((i) => i !== cur)) });
  updateBadge();
}
function removeIssue(issue) { const v = getView(); v?.dispatch({ effects: setIssues.of((l) => l.filter((i) => i !== issue)) }); updateBadge(); }
function nextIssue(from, dir, afterChange = false) {
  const v = getView();
  const list = [...issuesOf(v)].sort((a, b) => a.from - b.from);
  if (!list.length) { closeCard(); return; }
  let i = list.findIndex((x) => (dir > 0 ? x.from >= from.from + (afterChange ? 0 : 1) : x.from < from.from));
  if (dir < 0) i = list.map((x) => x.from < from.from).lastIndexOf(true);
  const next = list[(i + list.length) % list.length] || list[0];
  v.dispatch({ effects: EditorView.scrollIntoView(next.from, { y: "center" }) });
  requestAnimationFrame(() => {
    const c = v.coordsAtPos(next.from);
    if (c) openCard({ x: c.left, y: c.top }, next);
  });
}

/** The panel at the caret (Ctrl+Alt+G or the toolbar button). */
export function openPanelAtCaret() {
  const v = getView();
  const c = v?.coordsAtPos(v.state.selection.main.head);
  openCard(c ? { x: c.left, y: c.top } : { x: innerWidth / 2 - 180, y: 120 });
}

// ---------------- translate ----------------
const LANGS = [["vi", "Vietnamese"], ["en", "English"], ["zh-CN", "Chinese (Simplified)"], ["zh-TW", "Chinese (Traditional)"], ["ja", "Japanese"], ["ko", "Korean"], ["fr", "French"], ["de", "German"], ["es", "Spanish"], ["pt", "Portuguese"], ["ru", "Russian"], ["it", "Italian"], ["th", "Thai"], ["id", "Indonesian"], ["ar", "Arabic"], ["hi", "Hindi"]];
const langName = (c) => LANGS.find((l) => l[0] === c)?.[1] || c;

export async function translateSelection(to, at) {
  const v = getView();
  if (!v) return;
  const { from, to: end } = v.state.selection.main;
  const text = v.state.sliceDoc(from, end);
  if (!text.trim()) return toast("Select the text to translate first.", "", 2500);
  const c = v.coordsAtPos(end);
  return translateText(text, {
    to, at: at || (c ? { x: c.left, y: c.bottom } : null),
    replace: (result) => { const cv = getView(); if (cv.state.sliceDoc(from, end) === text) cv.dispatch({ changes: { from, to: end, insert: result }, userEvent: "input.translate" }); },
    insert: (result) => { const cv = getView(); const line = cv.state.doc.lineAt(end); cv.dispatch({ changes: { from: line.to, insert: "\n\n" + result }, userEvent: "input.translate" }); },
  });
}

/** Translate `text` in a card at `at`; replace/insert are offered when given. */
export async function translateText(text, { to, at, replace, insert } = {}) {
  closeCard();
  const el = document.createElement("div");
  el.className = "wr-card tr-card";
  el.innerHTML = `
    <div class="wr-head">${ic("globe")}<b>Translate</b><span class="tb-spacer"></span><button class="icon small wr-x" title="Close (Esc)">${ic("x")}</button></div>
    <div class="wr-line"><select class="tr-to" title="Translate into">${LANGS.map(([c, n]) => `<option value="${c}">${n}</option>`).join("")}</select></div>
    <div class="wr-line wr-model-line"></div>
    <div class="tr-out" aria-live="polite"></div>
    <div class="wr-row"><button class="small primary tr-rep">${ic("check")}<span>Replace</span></button><button class="small tr-ins">${ic("plus")}<span>Insert below</span></button><button class="small tr-copy">${ic("copy")}<span>Copy</span></button><span class="tb-spacer"></span><span class="note tr-from"></span></div>`;
  el.querySelector(".wr-model-line").appendChild(await modelControls("translate", "translateEffort", "translateThinking"));
  const toSel = el.querySelector(".tr-to");
  toSel.value = to || settings.translateTo || "vi";
  const out = el.querySelector(".tr-out");
  let result = "", seq = 0;
  const run = async () => {
    const my = ++seq;
    const target = toSel.value;
    updateSettings({ translateTo: target });
    out.innerHTML = `<div class="tr-wait"><span class="ld-spin"><span></span><span></span><span></span></span>Translating into ${langName(target)}…</div>`;
    el.querySelectorAll(".wr-row button").forEach((b) => (b.disabled = true));
    const engine = settings.aiModel_translate || "google";
    try {
      if (engine === "google") {
        const r = await call("translate_google", { text, to: target, from: null });
        if (my !== seq) return;
        result = r?.text || "";
        el.querySelector(".tr-from").textContent = r?.from ? `from ${langName(r.from)} · Google` : "Google Translate";
      } else {
        const m = await ai();
        result = "";
        const r = await m.runAI("translate", { model: engine, system: `Translate the user's text into ${langName(target)}. Keep the meaning, tone, formatting, line breaks, Markdown/LaTeX markup, citations and math exactly. Reply with ONLY the translation.`, messages: [{ role: "user", content: text }], temperature: 0.2, effort: settings.translateEffort || null, thinking: !!settings.translateThinking }, (e) => { if (e.kind === "text" && my === seq) { result += e.text; out.textContent = result; } });
        if (my !== seq) return;
        result = String(r || result).replace(/^```[a-z]*\n|\n```$/g, "");
        el.querySelector(".tr-from").textContent = engine.split("|").pop();
      }
      out.textContent = result;
      el.querySelectorAll(".wr-row button").forEach((b) => (b.disabled = false));
    } catch (e) {
      if (my !== seq) return;
      out.innerHTML = `<div class="tr-err"></div>`;
      out.firstChild.textContent = `Couldn't translate: ${e.message === "NO_MODEL" ? "set up an AI model first" : e.message || e}`;
    }
  };
  toSel.onchange = run;
  el.querySelector(".wr-model").addEventListener("change", run);
  el.querySelector(".wr-x").onclick = closeCard;
  const rep = el.querySelector(".tr-rep"), ins = el.querySelector(".tr-ins");
  if (replace) rep.onclick = () => { replace(result); status("Replaced with the translation", "ok"); closeCard(); }; else rep.remove();
  if (insert) ins.onclick = () => { insert(result); status("Translation inserted", "ok"); closeCard(); }; else ins.remove();
  el.querySelector(".tr-copy").onclick = () => navigator.clipboard.writeText(result).then(() => status("Translation copied", "ok"));
  if (!replace) el.querySelector(".tr-copy").classList.add("primary");
  place(el, at || { x: innerWidth / 2 - 200, y: 140 });
  card = { el, issue: null };
  document.addEventListener("pointerdown", awayCard, true);
  document.addEventListener("keydown", escCard, true);
  run();
}

// ---------------- right-click in the editor ----------------
function editorMenu(e, v) {
  const sel = v.state.selection.main;
  const has = sel.to > sel.from;
  const t = activeTab();
  const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
  const it = pos != null && issueAt(v, pos);
  const at = { x: e.clientX, y: e.clientY };
  const items = [];
  if (it) {
    items.push({ header: KINDS[it.kind] || "Suggestion" });
    for (const f of it.fixes.slice(0, 3)) items.push({ label: f || "(remove)", icon: "check", action: () => apply(it, f) });
    items.push({ label: "Ignore", icon: "eye-off", action: () => { ignored.add(it.quote + "|" + it.why); removeIssue(it); } }, "-");
  }
  items.push(
    { label: "Cut", key: "Ctrl+X", icon: "minify", disabled: !has, action: () => { navigator.clipboard.writeText(v.state.sliceDoc(sel.from, sel.to)); v.dispatch({ changes: { from: sel.from, to: sel.to, insert: "" }, userEvent: "delete.cut" }); } },
    { label: "Copy", key: "Ctrl+C", icon: "copy", disabled: !has, action: () => navigator.clipboard.writeText(v.state.sliceDoc(sel.from, sel.to)) },
    { label: "Paste", key: "Ctrl+V", icon: "file-text", action: async () => { const txt = await navigator.clipboard.readText().catch(() => ""); if (txt) v.dispatch(v.state.replaceSelection(txt)); } },
    "-",
    { label: "Translate", icon: "globe", disabled: !has, sub: [
      { label: `Into ${langName(settings.translateTo || "vi")}`, key: "Ctrl+Alt+T", action: () => translateSelection(settings.translateTo || "vi", at) },
      "-",
      ...LANGS.filter(([c]) => c !== (settings.translateTo || "vi")).slice(0, 10).map(([c, n]) => ({ label: n, action: () => translateSelection(c, at) })),
    ] },
  );
  if (t && TEXT_KINDS.has(t.kind)) {
    items.push(
      { label: "Writing suggestions…", key: "Ctrl+Alt+G", icon: "wand", action: () => openCard(at) },
      { label: "Check this paragraph", icon: "search", action: () => { const [p] = paragraphsIn(v.state.doc, sel.from, sel.to); if (p) checkWriting({ from: p.from, to: p.to }); } },
    );
    items.push({ label: "AI", icon: "sparkles", disabled: !has, sub: [] });
    ai().then(() => {}); // warm up
  }
  items.push("-", { label: "Select All", key: "Ctrl+A", action: () => v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } }) });
  // the AI rewrite actions (filled in once ai.js is loaded)
  const aiItem = items.find((x) => x && x.label === "AI");
  if (aiItem) {
    import("./ai.js").then((m) => {
      aiItem.sub = m.ACTIONS.filter((a) => !a.chat).map((a) => ({ label: a.label + (a.id === "custom" ? "" : ""), action: () => m.runAction(a.id) }));
      showContextMenu(e, items);
    });
    return;
  }
  showContextMenu(e, items);
}

// keyboard
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || !e.altKey) return;
  const k = e.key.toLowerCase();
  const t = activeTab();
  if (!t || !getView()?.hasFocus) return;
  if (k === "g" && TEXT_KINDS.has(t.kind)) { e.preventDefault(); openPanelAtCaret(); }
  if (k === "t") { e.preventDefault(); translateSelection(settings.translateTo || "vi"); }
}, true);

// right-click on selected text elsewhere (the preview, PDF text, the chat…): Copy and Translate
document.addEventListener("contextmenu", (e) => {
  if (e.defaultPrevented || e.target.closest?.(".cm-editor, input, textarea, select, .tree-item, .tab, [contenteditable=true]")) return;
  const text = String(getSelection() || "").trim();
  if (!text) return;
  const at = { x: e.clientX, y: e.clientY };
  const cur = settings.translateTo || "vi";
  showContextMenu(e, [
    { label: "Copy", key: "Ctrl+C", icon: "copy", action: () => navigator.clipboard.writeText(text).then(() => status("Copied", "ok")) },
    { label: "Translate", icon: "globe", sub: [
      { label: `Into ${langName(cur)}`, action: () => translateText(text, { to: cur, at }) },
      "-",
      ...LANGS.filter(([c]) => c !== cur).slice(0, 10).map(([c, n]) => ({ label: n, action: () => translateText(text, { to: c, at }) })),
    ] },
  ]);
});
