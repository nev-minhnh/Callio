// "Callio AI" — the popup by the mouse for the text you point at: Ask AI (rewrite with a request
// and writing skills), Translate (Google Translate or any AI model) and Meaning (a dictionary
// for English words, the AI for anything else). Its header switches the provider and model,
// effort and thinking on the spot. Works in Markdown / LaTeX / text, Word documents,
// presentations, spreadsheets and any text selected in the preview.
//
// The popup opens where the mouse is. It closes with Esc, ✕ or a click elsewhere — and when the
// pointer leaves it, but only after it has been inside once (a popup that opened away from the
// pointer used to vanish before it could be read).
import { call } from "./api.js";
import { settings, updateSettings, status } from "./main.js";
import { ic } from "./icons.js";

const ai = () => import("./ai.js");
export const LANGS = [["auto", "Vietnamese ⇄ English"], ["vi", "Vietnamese"], ["en", "English"], ["zh-CN", "Chinese (Simplified)"], ["zh-TW", "Chinese (Traditional)"], ["ja", "Japanese"], ["ko", "Korean"], ["fr", "French"], ["de", "German"], ["es", "Spanish"], ["pt", "Portuguese"], ["ru", "Russian"], ["it", "Italian"], ["th", "Thai"], ["id", "Indonesian"], ["ar", "Arabic"], ["hi", "Hindi"]];
export const langName = (c) => LANGS.find((l) => l[0] === c)?.[1] || c;
export const EFFORTS = [["", "Model default"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra"], ["max", "Max"]];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const preview = (s, n) => { const t = String(s).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

// where the mouse is (the popup opens there)
export const pointer = { x: innerWidth / 2, y: innerHeight / 3 };
addEventListener("pointermove", (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true, capture: true });
addEventListener("pointerdown", (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true, capture: true });

/** Model, effort and thinking controls (shared with the writing panel). */
export async function modelControls({ value, onModel, effort, onEffort, thinking, onThinking, google = false, googleSelected = false }) {
  const m = await ai();
  const wrap = document.createElement("div");
  wrap.className = "as-models";
  const sel = document.createElement("select");
  sel.className = "as-model";
  sel.title = "Provider and model";
  if (google) {
    const o = document.createElement("option"); o.value = "google"; o.textContent = "Google Translate"; sel.appendChild(o);
  }
  m.fillModelOptions(sel, { claudeCode: true });
  sel.querySelectorAll('option[value="claudecode|__other"]').forEach((o) => o.remove());
  if (!sel.querySelector("option")) { const o = document.createElement("option"); o.value = ""; o.textContent = "No model — Settings › AI"; sel.appendChild(o); }
  sel.value = googleSelected ? "google" : value || m.modelFor("edit") || "";
  if (sel.selectedIndex < 0) sel.selectedIndex = 0;
  const eff = document.createElement("select");
  eff.className = "as-effort";
  eff.title = "Effort";
  eff.innerHTML = EFFORTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  eff.value = effort || "";
  const think = document.createElement("label");
  think.className = "as-think";
  think.title = "Let the model think first (slower, sometimes better)";
  think.innerHTML = `<input type="checkbox"${thinking ? " checked" : ""}><span>Thinking</span>`;
  const sync = () => { const ai = sel.value && sel.value !== "google"; eff.hidden = !ai; think.hidden = !ai; };
  sel.onchange = () => {
    if (!sel.value) { import("./settings.js").then((x) => x.openSettings("ai")); return; }
    sync(); onModel?.(sel.value);
  };
  eff.onchange = () => onEffort?.(eff.value);
  think.querySelector("input").onchange = (e) => onThinking?.(e.target.checked);
  sync();
  wrap.append(sel, eff, think);
  wrap.model = () => sel.value;
  return wrap;
}

let P = null; // the open popup: { el, mode, target, host, ... }

export function closeAssist() {
  if (!P) return;
  P.seq++;
  const el = P.el;
  el.classList.add("leaving");
  setTimeout(() => el.remove(), 140);
  P = null;
  document.removeEventListener("pointerdown", onAway, true);
  document.removeEventListener("keydown", onEsc, true);
  document.removeEventListener("pointermove", onMove, true);
}
function onAway(e) { if (P && !P.el.contains(e.target) && !e.target.closest?.(".ctx-menu")) closeAssist(); }
function onEsc(e) { if (e.key === "Escape" && P) { e.stopPropagation(); e.preventDefault(); closeAssist(); } }
function onMove(e) {
  if (!P) return;
  const r = P.el.getBoundingClientRect();
  // entered: the pointer really moved over it; leaving: a margin around it still counts as near
  if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) P.entered = true;
  const near = e.clientX >= r.left - 24 && e.clientX <= r.right + 24 && e.clientY >= r.top - 24 && e.clientY <= r.bottom + 24;
  if (near) { clearTimeout(P.awayT); P.awayT = 0; return; }
  // only once the pointer has been in it — and never while typing a request or dragging it
  const typing = P.mode === "ask" && (P.el.querySelector(".as-req")?.value.trim() || P.el.contains(document.activeElement));
  if (!P.entered || typing || P.dragging || document.querySelector(".ctx-menu") || P.el.querySelector("select:focus")) return;
  if (!P.awayT) P.awayT = setTimeout(() => { if (P && !P.dragging) closeAssist(); }, 600);
}

function place(el, at) {
  document.body.appendChild(el);
  const w = el.offsetWidth, h = el.offsetHeight;
  // just below and right of the pointer, kept on screen
  let x = at.x + 10, y = at.y + 14;
  if (x + w > innerWidth - 10) x = Math.max(10, at.x - w - 10);
  if (y + h > innerHeight - 10) y = Math.max(10, at.y - h - 12);
  el.style.left = x + "px";
  el.style.top = y + "px";
}

/**
 * Open the popup. host: { target() → {text, selection, …}|null, replace(target, text), insert(text) }
 * mode: "ask" | "translate" | "meaning".
 */
export async function openAssist(mode, host, { at = null, text = null } = {}) {
  closeAssist();
  let target = null;
  if (text != null) target = { text, selection: true };
  else { try { target = await host?.target?.(); } catch { target = null; } }
  if (!target?.text?.trim() && mode !== "ask") { status(mode === "translate" ? "Select the text to translate." : "Select a word or a phrase.", "err"); return; }
  const el = document.createElement("div");
  el.className = "as-pop";
  el.setAttribute("role", "dialog");
  el.innerHTML = `
    <div class="as-head"><span class="as-grip" title="Drag to move">${ic("sparkles")}<b>Callio AI</b></span>
      <div class="as-modes" role="tablist"><button data-m="ask">Ask AI</button><button data-m="translate">Translate</button><button data-m="meaning">Meaning</button></div>
      <span class="tb-spacer"></span><button class="icon small as-x" title="Close (Esc)">${ic("x")}</button></div>
    <div class="as-line as-ctl"></div>
    <div class="as-body"></div>`;
  P = { el, mode, target, host, seq: 0, entered: false, awayT: 0, dragging: false };
  el.querySelector(".as-x").onclick = closeAssist;
  for (const b of el.querySelectorAll(".as-modes button")) b.onclick = () => { if (P.mode !== b.dataset.m) { P.mode = b.dataset.m; render(); } };
  // drag by the title
  el.querySelector(".as-grip").onpointerdown = (e) => {
    const r = el.getBoundingClientRect(); const dx = e.clientX - r.left, dy = e.clientY - r.top;
    P.dragging = true; e.target.setPointerCapture(e.pointerId);
    const mv = (ev) => { el.style.left = Math.max(0, Math.min(innerWidth - 60, ev.clientX - dx)) + "px"; el.style.top = Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy)) + "px"; };
    const up = () => { if (P) P.dragging = false; removeEventListener("pointermove", mv); removeEventListener("pointerup", up); };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  };
  await render();
  place(el, at || { ...pointer });
  document.addEventListener("pointerdown", onAway, true);
  document.addEventListener("keydown", onEsc, true);
  document.addEventListener("pointermove", onMove, true);
}

async function render() {
  const p = P; if (!p) return;
  p.seq++;
  const el = p.el;
  for (const b of el.querySelectorAll(".as-modes button")) b.classList.toggle("on", b.dataset.m === p.mode);
  const ctl = el.querySelector(".as-ctl");
  ctl.innerHTML = "";
  const body = el.querySelector(".as-body");
  body.innerHTML = "";
  const what = document.createElement("div");
  what.className = "as-what";
  what.textContent = p.target?.text ? `${p.target.selection ? "Selection" : "Paragraph"}: ${preview(p.target.text, 110)}` : "No text yet: AI writes new text to insert.";
  if (p.mode === "translate") {
    const engine = settings.translateEngine || "google";
    const c = await modelControls({
      google: true, googleSelected: engine === "google", value: engine,
      effort: settings.assistEffort, thinking: !!settings.assistThinking,
      onModel: (v) => { updateSettings({ translateEngine: v }); run(); }, onEffort: (v) => updateSettings({ assistEffort: v }), onThinking: (v) => updateSettings({ assistThinking: v }),
    });
    const to = document.createElement("select");
    to.className = "as-to"; to.title = "Translate into";
    to.innerHTML = LANGS.map(([c2, n]) => `<option value="${c2}">${n}</option>`).join("");
    to.value = settings.translateTo || "auto";
    to.onchange = () => { updateSettings({ translateTo: to.value }); run(); };
    ctl.append(c, to);
    body.append(what);
    body.insertAdjacentHTML("beforeend", `<div class="as-out" aria-live="polite"></div><div class="as-note note"></div><div class="as-row"></div>`);
    run();
  } else if (p.mode === "meaning") {
    const c = await modelControls({ value: settings.assistModel, effort: settings.assistEffort, thinking: !!settings.assistThinking, onModel: (v) => { updateSettings({ assistModel: v }); run(); }, onEffort: (v) => updateSettings({ assistEffort: v }), onThinking: (v) => updateSettings({ assistThinking: v }) });
    ctl.append(c);
    body.append(what);
    body.insertAdjacentHTML("beforeend", `<div class="as-out"></div><div class="as-note note"></div><div class="as-row"></div>`);
    run();
  } else {
    const c = await modelControls({ value: settings.assistModel, effort: settings.assistEffort, thinking: !!settings.assistThinking, onModel: (v) => updateSettings({ assistModel: v }), onEffort: (v) => updateSettings({ assistEffort: v }), onThinking: (v) => updateSettings({ assistThinking: v }) });
    ctl.append(c);
    body.append(what);
    body.insertAdjacentHTML("beforeend", `
      <textarea class="as-req" rows="2" placeholder="What should AI do? e.g. make it more formal, shorter, fix the tone, continue this paragraph…"></textarea>
      <div class="as-quick">${["Fix grammar", "More formal", "Shorter", "Clearer", "Friendlier"].map((q) => `<button class="chip">${q}</button>`).join("")}</div>
      <div class="as-line"><div class="menu-wrap"><button class="small as-skills">${ic("library")}<span>Skills</span></button></div><span class="tb-spacer"></span><button class="small primary as-send" title="Ctrl+Enter">${ic("sparkles")}<span>Send</span></button></div>
      <div class="as-out" hidden></div><div class="as-note note"></div><div class="as-row"></div>`);
    const req = body.querySelector(".as-req");
    req.value = p.request || "";
    req.oninput = () => { p.request = req.value; };
    req.onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); } };
    body.querySelectorAll(".as-quick .chip").forEach((b) => (b.onclick = () => { req.value = p.request = b.textContent; run(); }));
    body.querySelector(".as-send").onclick = () => run();
    const sk = body.querySelector(".as-skills");
    const label = () => { const n = (settings.assistSkills || []).length; sk.querySelector("span").textContent = n ? `Skills (${n})` : "Skills"; };
    label();
    sk.onclick = async (e) => {
      const m = await ai();
      const on = new Set(settings.assistSkills || []);
      const list = m.skills();
      const items = list.length ? list.slice(0, 40).map((s) => ({ label: s.name, checked: on.has(s.name), action: () => { on.has(s.name) ? on.delete(s.name) : on.add(s.name); updateSettings({ assistSkills: [...on] }); label(); } })) : [{ label: "No skills yet — add them in Settings › AI › Skills", disabled: true }];
      const r = sk.getBoundingClientRect();
      (await import("./ctxmenu.js")).showContextMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {} }, items);
    };
    setTimeout(() => req.focus(), 30);
  }
}

async function skillsText(names) {
  if (!names?.length) return "";
  const m = await ai();
  let out = "";
  for (const s of m.skills().filter((x) => names.includes(x.name))) {
    const t = await m.skillContent(s).catch(() => "");
    if (t) out += `\n\n## Writing skill: ${s.name}\n${t.slice(0, 20000)}`;
  }
  return out.slice(0, 60000);
}

async function run() {
  const p = P; if (!p) return;
  const my = ++p.seq;
  const body = p.el.querySelector(".as-body");
  const out = body.querySelector(".as-out"), note = body.querySelector(".as-note"), row = body.querySelector(".as-row");
  const text = p.target?.text || "";
  const m = await ai();
  const started = Date.now();
  const label = p.mode === "translate" ? "Translating…" : p.mode === "meaning" ? "Looking up…" : "Writing…";
  out.hidden = false;
  out.innerHTML = `<div class="as-wait"><span class="ld-spin"><span></span><span></span><span></span></span><span class="as-wait-t">${label}</span><button class="small as-cancel">Cancel</button></div>`;
  const tick = setInterval(() => { const t = out.querySelector(".as-wait-t"); if (t) t.textContent = `${label} ${Math.round((Date.now() - started) / 1000)} s`; else clearInterval(tick); }, 1000);
  const idRef = {};
  out.querySelector(".as-cancel").onclick = () => { p.seq++; clearInterval(tick); if (idRef.id) m.cancelAI(idRef.id).catch(() => {}); out.innerHTML = ""; note.textContent = "Stopped."; };
  note.textContent = ""; row.innerHTML = "";
  let answer = "";
  const show = (t) => { if (my === p.seq) { out.textContent = t; } };
  try {
    if (p.mode === "translate") {
      const to = settings.translateTo || "auto";
      const engine = settings.translateEngine || "google";
      if (engine === "google") {
        let r = await call("translate_google", { text, to: to === "auto" ? "vi" : to, from: null });
        if (to === "auto" && /^vi/.test(r?.from || "")) r = await call("translate_google", { text, to: "en", from: null });
        answer = r?.text || "";
        if (my === p.seq && r?.from) note.textContent = `Detected language: ${langName(r.from) || r.from} · Google Translate`;
      } else {
        const into = to === "auto" ? "English if the text is in Vietnamese, otherwise Vietnamese" : langName(to);
        answer = await m.runAI("translate", { model: engine, idRef, system: `You are a professional translator. Translate the user's text into ${into}. Keep the meaning, tone, formatting and line breaks (and any Markdown or LaTeX markup, citations and math). Reply with the translation only.${settings.aiInstructions ? `\n\nThe author's standing instructions:\n${settings.aiInstructions}` : ""}`, messages: [{ role: "user", content: text }], effort: settings.assistEffort || null, thinking: !!settings.assistThinking }, (e) => { if (e.kind === "text") show((answer += e.text)); });
      }
    } else if (p.mode === "meaning") {
      const word = text.trim();
      let done = false;
      if (/^[A-Za-z'-]+$/.test(word)) {
        try { answer = await call("define_english", { word }); done = true; if (my === p.seq) note.textContent = "Source: Free Dictionary (dictionaryapi.dev)"; } catch { /* the AI then */ }
      }
      if (!done) {
        const model = settings.assistModel || m.modelFor("edit");
        if (!model) throw new Error("No dictionary entry — sign in to an AI provider in Settings › AI to look up any word.");
        const ctx = p.target?.context || "";
        answer = await m.runAI("edit", { model, idRef, system: `You are a concise dictionary. Explain the meaning of the word or phrase the user gives, as used in its context. Answer in ${settings.uiLang === "en" ? "English" : "Vietnamese"}: the meaning(s) with part of speech, pronunciation if useful, 2–5 synonyms, and one short example. Plain text.`, messages: [{ role: "user", content: `Word or phrase: ${word}\nContext: ${ctx || word}` }], effort: settings.assistEffort || null, thinking: false }, (e) => { if (e.kind === "text") show((answer += e.text)); });
      }
    } else {
      const request = (p.request || "").trim();
      if (!request) { clearInterval(tick); out.hidden = true; return; }
      const model = settings.assistModel || m.modelFor("edit");
      if (!model) throw new Error("Sign in to an AI provider in Settings › AI first.");
      let system = "You are a skilled writing assistant inside a document editor. Do what the user asks with their text. Reply with the resulting text only — no preamble, no quotes, no explanation, no Markdown unless the text already uses it. Keep the text's language unless the user asks otherwise.";
      if (settings.aiInstructions) system += `\n\nThe author's standing instructions:\n${settings.aiInstructions}`;
      system += await skillsText(settings.assistSkills);
      const prompt = text.trim() ? `Request: ${request}\n\nText:\n<<<\n${text}\n>>>` : `Request: ${request}\n\n(There is no text yet: write the text to insert.)`;
      answer = await m.runAI("edit", { model, idRef, system, messages: [{ role: "user", content: prompt }], effort: settings.assistEffort || null, thinking: !!settings.assistThinking }, (e) => { if (e.kind === "text") show((answer += e.text)); });
    }
  } catch (e) {
    clearInterval(tick);
    if (my !== p.seq) return;
    const msg = e.message === "NO_MODEL" ? "Sign in to an AI provider in Settings › AI first." : e.message || String(e);
    out.innerHTML = `<div class="as-err"></div><button class="small as-retry">Try again</button>`;
    out.querySelector(".as-err").textContent = msg;
    out.querySelector(".as-retry").onclick = run;
    return;
  }
  clearInterval(tick);
  if (my !== p.seq) return;
  answer = String(answer || "").replace(/^```[a-z]*\n|\n```\s*$/g, "").trim();
  out.textContent = answer;
  if (p.target?.text && p.mode !== "meaning" && p.host?.replace) {
    const b = document.createElement("button"); b.className = "small primary"; b.innerHTML = `${ic("check")}<span>Replace</span>`;
    b.onclick = async () => { try { await p.host.replace(p.target, answer); status("Replaced", "ok"); closeAssist(); } catch (e) { status(`Couldn't replace: ${e.message || e}`, "err"); } };
    row.appendChild(b);
  }
  if (p.mode === "ask" && p.host?.insert) {
    const b = document.createElement("button"); b.className = "small"; b.innerHTML = `${ic("plus")}<span>Insert</span>`; b.title = "After the selection or at the cursor";
    b.onclick = async () => { try { await p.host.insert(answer); status("Text inserted", "ok"); closeAssist(); } catch (e) { status(`Couldn't insert: ${e.message || e}`, "err"); } };
    row.appendChild(b);
  }
  const c = document.createElement("button"); c.className = "small"; c.innerHTML = `${ic("copy")}<span>Copy</span>`;
  c.onclick = () => navigator.clipboard.writeText(answer).then(() => status("Copied to the clipboard", "ok"));
  row.appendChild(c);
}
