// OCR: scanned PDFs and pictures → editable Markdown, then Save / Export as PDF or Markdown.
// Like Docling: pages that already have text keep it; pages that are pictures go to the OCR
// engine; the result is laid out as Markdown (reading order, columns, headings, lists, tables).
// Engines (no Python): Windows OCR (built in), Tesseract (downloaded on request),
// Claude Code (your Claude plan), Claude API, Gemini API.
import { api, call, listen } from "./api.js";
import { settings, updateSettings, toast, status, ask, activeTab, basename, dirname, openNewDoc, folder } from "./main.js";
import { ic } from "./icons.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export const ENGINES = {
  windows: { label: "Windows OCR (built in)", local: true },
  tesseract: { label: "Tesseract (download once)", local: true },
  claudecode: { label: "Claude Code (your Claude plan)", local: false },
  anthropic: { label: "Claude API (Anthropic key)", local: false },
  gemini: { label: "Gemini API (Google key)", local: false },
};
const TESS_LANGS = [["eng", "English"], ["vie", "Vietnamese"], ["fra", "French"], ["deu", "German"], ["spa", "Spanish"], ["ita", "Italian"], ["por", "Portuguese"], ["nld", "Dutch"], ["rus", "Russian"], ["ara", "Arabic"], ["hin", "Hindi"], ["jpn", "Japanese"], ["kor", "Korean"], ["chi_sim", "Chinese (simplified)"], ["chi_tra", "Chinese (traditional)"], ["tha", "Thai"], ["ind", "Indonesian"], ["tur", "Turkish"], ["pol", "Polish"], ["ukr", "Ukrainian"], ["equ", "Math / equations"]];

let info = null;
async function engines(refresh = false) {
  if (!info || refresh) { try { info = await call("ocr_engines"); } catch { info = null; } }
  return info || { windows: false, windowsLanguages: [], tesseract: null, tesseractLanguages: [], claudeCode: false, anthropicKey: false, geminiKey: false };
}
const engineOk = (e, i) => ({ windows: i.windows, tesseract: !!i.tesseract, claudecode: i.claudeCode, anthropic: i.anthropicKey, gemini: i.geminiKey })[e];
function defaultEngine(i) {
  const pref = settings.ocrEngine;
  if (pref && engineOk(pref, i)) return pref;
  return ["windows", "tesseract", "claudecode", "anthropic", "gemini"].find((e) => engineOk(e, i)) || "windows";
}

// ---------------- settings (Settings → OCR) ----------------
const WIN_LANGS = [["en-US", "English (US)"], ["en-GB", "English (UK)"], ["vi-VN", "Vietnamese"], ["fr-FR", "French"], ["de-DE", "German"], ["es-ES", "Spanish"], ["it-IT", "Italian"], ["pt-BR", "Portuguese"], ["nl-NL", "Dutch"], ["ru-RU", "Russian"], ["ar-SA", "Arabic"], ["ja-JP", "Japanese"], ["ko-KR", "Korean"], ["zh-CN", "Chinese (simplified)"], ["zh-TW", "Chinese (traditional)"], ["pl-PL", "Polish"], ["tr-TR", "Turkish"]];
const EFFORTS = [["", "Default effort"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Max"]];

export async function renderOcrSettings(box) {
  if (!box) return;
  box.innerHTML = `<p class="note">Loading OCR engines…</p>`;
  const i = await engines(true);
  const { CC_MODELS } = await import("./ai.js");
  const tessLangs = new Set(i.tesseractLanguages);
  // Windows may name them with a script (zh-Hans-CN): compare language + region
  const tagKey = (l) => l.toLowerCase().split("-").filter((x, i) => i === 0 || x.length !== 4).join("-");
  const winHave = new Set(i.windowsLanguages.map(tagKey));
  const ccModel = settings.ocrModelClaudeCode || "default";
  const ccList = [...CC_MODELS, ...(settings.ccCustomModels || []).map((m) => [m, m])];
  if (!ccList.some(([m]) => m === ccModel)) ccList.push([ccModel, ccModel]);
  const keyRow = (name, has, ph, link) => `<label>API key <span class="ocr-key"><input type="password" data-key="${name}" placeholder="${has ? "•••••••• saved — type to replace" : ph}" autocomplete="off"><button type="button" class="small" data-savekey="${name}">Save</button>${has ? `<button type="button" class="small" data-delkey="${name}">Remove</button>` : ""}</span></label><p class="note">Kept in Windows Credential Manager. <a href="#" data-url="${link}">Get a key</a></p>`;
  box.innerHTML = `
    <h3>OCR</h3>
    <p class="note">Turns scanned PDFs and pictures into editable text (toolbar → 🔤 OCR). Like Docling, pages that already contain text keep it and only pictures of text are recognised. Everything runs on this PC except the Claude and Gemini engines, which send the page images to that service.</p>
    <label>Default engine <select name="ocrEngine">${Object.entries(ENGINES).map(([k, v]) => `<option value="${k}"${(settings.ocrEngine || defaultEngine(i)) === k ? " selected" : ""}>${v.label}${engineOk(k, i) ? "" : " — not set up"}</option>`).join("")}</select></label>
    <div class="ocr-cards">
      <div class="ocr-card"><div class="ocr-card-head"><b>Windows OCR</b> <span class="badge ${i.windows && i.windowsLanguages.length ? "ok" : "warn"}">${i.windows ? (i.windowsLanguages.length ? "ready" : "no language") : "not available"}</span></div>
        <p class="note">${i.windows ? `Built into Windows. Languages: ${esc(i.windowsLanguages.join(", ") || "none yet — download one below")}.` : esc(i.windowsError ? `Windows OCR couldn't start: ${i.windowsError}` : "Built into Windows 10 and 11.")}</p>
        <label>Download a language <span class="ocr-key"><select class="ocr-winlang">${WIN_LANGS.map(([c, n]) => `<option value="${c}"${winHave.has(tagKey(c)) ? " disabled" : ""}>${n}${winHave.has(tagKey(c)) ? " ✓" : ""}</option>`).join("")}</select><button type="button" class="small primary ocr-wininstall">Download</button></span></label>
        <p class="note">Windows asks for administrator permission. Or: <a href="#" data-url="ms-settings:regionlanguage">Language settings</a> · <a href="#" class="ocr-recheck">Check again</a></p>
        <div class="ocr-progress ocr-winprog note"></div></div>
      <div class="ocr-card"><div class="ocr-card-head"><b>Tesseract</b> <span class="badge ${i.tesseract ? "ok" : "warn"}">${i.tesseract ? "installed" : "not installed"}</span></div>
        <p class="note">${i.tesseract ? esc(i.tesseract) : "Open-source OCR with 100+ languages (about 50 MB; Windows asks for administrator permission once)."}</p>
        ${i.tesseract ? `<div class="ocr-langs">${TESS_LANGS.map(([c, n]) => `<label class="chk"><input type="checkbox" data-tlang="${c}"${tessLangs.has(c) ? " checked disabled" : ""}> ${n}</label>`).join("")}</div><button type="button" class="small primary ocr-getlangs">Download ticked languages</button>` : `<button type="button" class="small primary ocr-install">Download Tesseract</button>`}
        <div class="ocr-progress ocr-tessprog note"></div></div>
      <div class="ocr-card"><div class="ocr-card-head"><b>Claude Code</b> <span class="badge ${i.claudeCode ? "ok" : "warn"}">${i.claudeCode ? "ready" : "not installed"}</span></div>
        <p class="note">Uses your Claude Pro/Max plan (set it up in Settings → AI → Claude Code). Best for hard layouts, tables and formulas.</p>
        <label>Model <select name="ocrModelClaudeCode">${ccList.map(([m, l]) => `<option value="${esc(m)}"${m === ccModel ? " selected" : ""}>${esc(l)}</option>`).join("")}<option value="__other">Other model id…</option></select></label>
        <label>Effort <select name="ocrEffortClaudeCode">${EFFORTS.map(([v, l]) => `<option value="${v}"${(settings.ocrEffortClaudeCode || "") === v ? " selected" : ""}>${l}</option>`).join("")}</select></label></div>
      <div class="ocr-card"><div class="ocr-card-head"><b>Claude API</b> <span class="badge ${i.anthropicKey ? "ok" : "warn"}">${i.anthropicKey ? "key saved" : "no key"}</span></div>
        ${keyRow("ai-key-anthropic", i.anthropicKey, "sk-ant-…", "https://console.anthropic.com/settings/keys")}
        <label>Model <input name="ocrModelAnthropic" type="text" value="${esc(settings.ocrModelAnthropic || "claude-sonnet-5-5")}"></label></div>
      <div class="ocr-card"><div class="ocr-card-head"><b>Gemini API</b> <span class="badge ${i.geminiKey ? "ok" : "warn"}">${i.geminiKey ? "key saved" : "no key"}</span></div>
        ${keyRow("ai-key-gemini", i.geminiKey, "Google AI Studio key (AIza…)", "https://aistudio.google.com/apikey")}
        <label>Model <input name="ocrModelGemini" type="text" value="${esc(settings.ocrModelGemini || "gemini-2.5-flash")}"></label></div>
    </div>
    <p class="note">The Claude and Gemini keys are shared with Settings → AI.</p>`;
  box.onchange = async (e) => {
    const el = e.target;
    if (el.name === "ocrModelClaudeCode" && el.value === "__other") {
      e.stopPropagation();
      const id = (await ask({ title: "Claude Code model", text: "Enter a model id Claude Code accepts, e.g. claude-opus-4-5 (or an alias such as opus).", input: "" }))?.trim();
      if (id) { updateSettings({ ocrModelClaudeCode: id, ccCustomModels: [...new Set([...(settings.ccCustomModels || []), id])] }); }
      return renderOcrSettings(box);
    }
    if (el.name?.startsWith("ocr")) updateSettings({ [el.name]: el.value.trim() });
  };
  box.onkeydown = (e) => { if (e.key === "Enter" && e.target.dataset?.key) { e.preventDefault(); box.querySelector(`[data-savekey="${e.target.dataset.key}"]`)?.click(); } };
  box.onclick = async (e) => {
    const t = e.target;
    if (t.closest(".ocr-recheck")) { e.preventDefault(); return renderOcrSettings(box); }
    const save = t.closest("[data-savekey]"), del = t.closest("[data-delkey]");
    if (save || del) {
      e.preventDefault();
      const name = (save || del).dataset.savekey || (save || del).dataset.delkey;
      const v = save ? box.querySelector(`[data-key="${name}"]`).value.trim() : "";
      if (save && !v) return toast("Paste the key first", "warn");
      try { await api.setSecret(name, v); toast(save ? "Key saved in Windows Credential Manager" : "Key removed", "ok"); } catch (er) { toast(er.message, "err", 8000); }
      return renderOcrSettings(box);
    }
    if (t.closest(".ocr-wininstall")) {
      e.preventDefault();
      const tag = box.querySelector(".ocr-winlang").value, prog = box.querySelector(".ocr-winprog");
      prog.innerHTML = `<span class="spin small"></span> Downloading the ${esc(tag)} OCR pack from Windows Update (a minute or two)…`;
      t.disabled = true;
      try { await call("ocr_windows_language", { tag }); toast(`Windows OCR: ${tag} added`, "ok"); } catch (er) { toast(er.message, "err", 9000); }
      return renderOcrSettings(box);
    }
    const install = t.closest(".ocr-install"), langs = t.closest(".ocr-getlangs");
    if (!install && !langs) return;
    e.preventDefault();
    const prog = box.querySelector(".ocr-tessprog");
    const un = await listen("install-progress", (p) => { if (p.kind === "tesseract") prog.textContent = p.label; });
    try {
      if (install) { prog.textContent = "Starting…"; await call("ocr_install_tesseract"); toast("Tesseract installed", "ok"); }
      else for (const cb of box.querySelectorAll("[data-tlang]:checked:not(:disabled)")) { prog.textContent = `Downloading ${cb.dataset.tlang}…`; await call("ocr_tesseract_language", { lang: cb.dataset.tlang }); }
    } catch (er) { toast(er.message, "err", 8000); }
    try { un?.(); } catch {}
    renderOcrSettings(box);
  };
}

// ---------------- running ----------------
async function pdfjs() {
  const lib = await import("pdfjs-dist");
  if (!lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  return lib;
}
const toPng = (canvas) => new Promise((r) => canvas.toBlob(async (b) => r(new Uint8Array(await b.arrayBuffer())), "image/png"));
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };

async function imageToCanvas(bytes, name) {
  const type = /\.png$/i.test(name) ? "image/png" : /\.(jpe?g)$/i.test(name) ? "image/jpeg" : /\.gif$/i.test(name) ? "image/gif" : /\.webp$/i.test(name) ? "image/webp" : /\.bmp$/i.test(name) ? "image/bmp" : "image/png";
  const bmp = await createImageBitmap(new Blob([bytes], { type }));
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0);
  return c;
}

/** Page images → per page: positioned lines (local engines) or Markdown (models). */
async function recognise(engine, canvases, opt) {
  const pngs = [];
  for (const c of canvases) pngs.push(await toPng(c));
  if (engine === "windows" || engine === "tesseract") {
    const parts = [];
    for (const p of pngs) { const n = new Uint8Array(4); new DataView(n.buffer).setUint32(0, p.length, true); parts.push(n, p); }
    const body = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0; for (const p of parts) { body.set(p, o); o += p.length; }
    const hex = [...new TextEncoder().encode(opt.lang || "")].map((b) => b.toString(16).padStart(2, "0")).join("");
    const pages = await api.rawCall("ocr_local", body, { "x-engine": engine, "x-langs": hex, "x-job": opt.job || "" });
    return (Array.isArray(pages) ? pages : [pages]).map((p) => ({ width: p.width, height: p.height, lines: (p.lines || []).map(lineBox).filter((l) => l.text?.trim()) }));
  }
  if (engine === "claudecode") {
    const md = await call("ocr_claude_code", { pagesBase64: pngs.map(b64), model: settings.ocrModelClaudeCode || null, effort: settings.ocrEffortClaudeCode || null, hint: opt.lang || null, job: opt.job || null });
    const parts = md.split(/<!--\s*page\s*\d+\s*-->/i).map((s) => s.trim()).filter(Boolean);
    return pngs.map((_, i) => clean(parts[i] ?? (i === 0 ? md : "")));
  }
  const out = [];
  for (const p of pngs) {
    if (opt.signal?.aborted) throw new Error("Cancelled");
    const model = engine === "anthropic" ? settings.ocrModelAnthropic || "claude-sonnet-5-5" : settings.ocrModelGemini || "gemini-2.5-flash";
    out.push(clean(await call("ocr_vision", { provider: engine, model, pngBase64: b64(p), hint: opt.lang || null })));
  }
  return out;
}
const clean = (md) => String(md || "").replace(/^\s*```(?:markdown|md)?\s*\n/, "").replace(/\n```\s*$/, "").trim();
/** Windows OCR gives words; a line's box is the union of its words. */
function lineBox(l) {
  if (l.x != null) return l;
  const ws = l.words || [];
  if (!ws.length) return { text: l.text, x: 0, y: 0, w: 0, h: 0, words: [] };
  const x = Math.min(...ws.map((w) => w.x)), y = Math.min(...ws.map((w) => w.y));
  const x2 = Math.max(...ws.map((w) => w.x + w.w)), y2 = Math.max(...ws.map((w) => w.y + w.h));
  return { text: l.text, x, y, w: x2 - x, h: y2 - y, words: ws };
}
async function layoutMd(pages) {
  const conv = await import("./convert/index.js");
  if (conv.layoutToMarkdown) return conv.layoutToMarkdown(pages);
  return pages.map((p) => p.lines.map((l) => l.text).join("\n")).join("\n\n");
}

/** OCR a file. mode "auto": text pages keep their text (Docling); "force": OCR every page. */
export async function ocrFile(o) {
  // one job id per run: "Stop" kills the engine process at once (Rust side), not just between pages
  const job = `ocr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const onAbort = () => call("ocr_cancel", { job }).catch(() => {});
  o.signal?.addEventListener("abort", onAbort);
  try { return await ocrRun({ ...o, job }); }
  catch (e) { if (o.signal?.aborted) throw new Error("Cancelled"); throw e; }
  finally { o.signal?.removeEventListener("abort", onAbort); call("ocr_job_end", { job }).catch(() => {}); }
}
async function ocrRun({ name, bytes, engine, lang: lang0, mode = "auto", pages: range, onProgress, signal, job }) {
  const lang = lang0 || "";
  const isPdf = /\.pdf$/i.test(name);
  if (!isPdf) {
    onProgress?.(0, 1, "Recognising the picture…");
    const r = await recognise(engine, [await imageToCanvas(bytes, name)], { lang, job, signal });
    return typeof r[0] === "string" ? r[0] : await layoutMd([r[0]]);
  }
  const conv = await import("./convert/index.js");
  if (mode === "auto" && !String(range || "").trim()) {
    const ocr = async (page) => {
      if (signal?.aborted) throw new Error("Cancelled");
      const canvas = page.canvas || (page.blob ? await imageToCanvas(new Uint8Array(await page.blob.arrayBuffer()), "p.png") : null);
      if (!canvas) return "";
      onProgress?.(page.pageNumber || 0, 0, `Recognising page ${page.pageNumber || ""}…`);
      return (await recognise(engine, [canvas], { lang, job, signal }))[0];
    };
    const res = await conv.toMarkdown({ name, bytes: bytes.slice(), ocr, imageMode: "placeholder", onProgress, signal });
    return res.markdown;
  }
  // every page (or a range): render and OCR (local engines and Claude Code in batches of 4)
  const lib = await pdfjs();
  const task = lib.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const doc = await task.promise;
  const list = pageList(range, doc.numPages);
  const out = [];
  const batch = engine === "windows" || engine === "tesseract" || engine === "claudecode" ? 4 : 1;
  try {
    for (let i = 0; i < list.length; i += batch) {
      if (signal?.aborted) throw new Error("Cancelled");
      const canvases = [];
      for (const n of list.slice(i, i + batch)) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.min(4, 2400 / Math.max(base.width, base.height)) }); // about 220–300 dpi
        const c = document.createElement("canvas");
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        canvases.push(c);
      }
      const last = list[Math.min(i + batch, list.length) - 1];
      onProgress?.(i, list.length, `Recognising page${last !== list[i] ? `s ${list[i]}–${last}` : ` ${last}`} of ${doc.numPages}…`);
      out.push(...(await recognise(engine, canvases, { lang, job, signal })));
    }
  } finally { task.destroy(); }
  onProgress?.(list.length, list.length, "Laying out the text…");
  const md = out.every((p) => typeof p !== "string") ? [await layoutMd(out)] : await Promise.all(out.map((p) => (typeof p === "string" ? p : layoutMd([p]))));
  return md.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
function pageList(range, n) {
  if (!range || !String(range).trim()) return Array.from({ length: n }, (_, i) => i + 1);
  const out = new Set();
  for (const part of String(range).split(",")) {
    const m = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = Math.max(1, +m[1]), b = Math.min(n, +(m[2] || m[1]));
    for (let k = a; k <= b; k++) out.add(k);
  }
  return [...out].sort((x, y) => x - y);
}

/** The default engine as a converter callback (scanned PDF pages, pictures), or null if none is ready. */
export async function pageOcr() {
  const i = await engines();
  const engine = settings.ocrEngine && engineOk(settings.ocrEngine, i) ? settings.ocrEngine : ["windows", "tesseract"].find((e) => engineOk(e, i));
  if (!engine) return null;
  const lang = settings[`ocrLang_${engine}`] || "";
  return async (page) => {
    const canvas = page.canvas || (page.blob ? await imageToCanvas(new Uint8Array(await page.blob.arrayBuffer()), "p.png") : null);
    return canvas ? (await recognise(engine, [canvas], { lang }))[0] : "";
  };
}

// ---------------- the dialog (toolbar → 🔤 OCR) ----------------
let running = null;
export async function startOcr() {
  if (running) return toast("OCR is already running.", "", 2500);
  const t = activeTab();
  let path = t?.kind === "pdf" ? t.path : null;
  if (!path) {
    path = await api.pickImage(t?.path ? dirname(t.path) : folder);
    if (!path) return;
  }
  const name = basename(path);
  if (!/\.(pdf|png|jpe?g|gif|bmp|webp)$/i.test(name)) return toast("OCR works on PDFs and pictures (PNG, JPG, GIF, BMP, WebP).", "err", 5000);
  const dlg = ensureDialog();
  const i = await engines(true);
  const sel = dlg.querySelector("#ocr-engine"), langSel = dlg.querySelector("#ocr-lang");
  dlg.querySelector(".ocr-file").textContent = name;
  dlg.querySelector(".ocr-pdf-only").hidden = !/\.pdf$/i.test(name);
  sel.innerHTML = Object.entries(ENGINES).map(([k, v]) => `<option value="${k}"${k === defaultEngine(i) ? " selected" : ""}>${v.label}${engineOk(k, i) ? "" : " — not set up"}</option>`).join("");
  const fillLangs = () => {
    const e = sel.value;
    let opts;
    if (e === "windows") opts = i.windowsLanguages.map((l) => [l, l]);
    else if (e === "tesseract") {
      opts = i.tesseractLanguages.map((l) => [l, (TESS_LANGS.find((x) => x[0] === l) || [l, l])[1]]);
      const both = i.tesseractLanguages.filter((l) => l === "eng" || l === "vie");
      if (both.length === 2) opts.unshift(["eng+vie", "English + Vietnamese"]);
    } else opts = [["", "Any (detected by the model)"], ["English", "English"], ["Vietnamese", "Vietnamese"]];
    const saved = settings[`ocrLang_${e}`];
    langSel.innerHTML = (opts.length ? opts : [["", "Default"]]).map(([v, n]) => `<option value="${esc(v)}"${v === saved ? " selected" : ""}>${esc(n)}</option>`).join("");
    dlg.querySelector(".ocr-cloud-note").hidden = ENGINES[e].local;
    dlg.querySelector(".ocr-setup-note").hidden = !!engineOk(e, i);
  };
  sel.onchange = () => { fillLangs(); fillModels(); };
  fillLangs();
  // AI engines: pick the model (and Claude Code's effort) right here
  const modelSel = dlg.querySelector("#ocr-model"), effSel = dlg.querySelector("#ocr-effort");
  const MODEL_KEY = { claudecode: "ocrModelClaudeCode", anthropic: "ocrModelAnthropic", gemini: "ocrModelGemini" };
  const fillModels = async () => {
    const e = sel.value, key = MODEL_KEY[e];
    dlg.querySelector(".ocr-ai-row").hidden = !key;
    if (!key) return;
    dlg.querySelector(".ocr-effort-wrap").hidden = e !== "claudecode";
    effSel.innerHTML = EFFORTS.map(([v, l]) => `<option value="${v}"${(settings.ocrEffortClaudeCode || "") === v ? " selected" : ""}>${l}</option>`).join("");
    const cur = settings[key] || (e === "claudecode" ? "default" : e === "anthropic" ? "claude-sonnet-5-5" : "gemini-2.5-flash");
    const put = (list) => {
      if (sel.value !== e) return;
      if (!list.some(([m]) => m === cur)) list.push([cur, cur]);
      modelSel.innerHTML = list.map(([m, l]) => `<option value="${esc(m)}"${m === cur ? " selected" : ""}>${esc(l)}</option>`).join("") + `<option value="__other">Other model id…</option>`;
      modelSel.dataset.prev = cur;
    };
    const custom = (settings[`${key}Custom`] || []).map((m) => [m, m]);
    if (e === "claudecode") return put([...(await import("./ai.js")).CC_MODELS, ...(settings.ccCustomModels || []).map((m) => [m, m])]);
    const fallback = e === "anthropic"
      ? [["claude-opus-5-5", "Claude Opus 5.5"], ["claude-sonnet-5-5", "Claude Sonnet 5.5"], ["claude-haiku-5-5", "Claude Haiku 5.5"]]
      : [["gemini-2.5-pro", "Gemini 2.5 Pro"], ["gemini-2.5-flash", "Gemini 2.5 Flash"], ["gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite"]];
    put([...fallback, ...custom]);
    // the models this key can use, from the provider itself
    if (!engineOk(e, i)) return;
    try {
      const { providerFor } = await import("./ai.js");
      const ms = (await api.aiListModels(providerFor(e))).filter((m) => (e === "gemini" ? /gemini/i.test(m.id) && !/embed|tts|image|live|audio/i.test(m.id) : /claude/i.test(m.id)));
      if (ms.length) put([...ms.map((m) => [m.id, m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id]).reverse(), ...custom]);
    } catch (er) { console.warn("models", er); }
  };
  modelSel.onchange = async () => {
    const key = MODEL_KEY[sel.value];
    if (modelSel.value !== "__other") return updateSettings({ [key]: modelSel.value });
    const id = (await ask({ title: "Model id", text: "Enter the model id to use for OCR.", input: "" }))?.trim();
    if (!id) { modelSel.value = modelSel.dataset.prev; return; }
    if (sel.value === "claudecode") updateSettings({ [key]: id, ccCustomModels: [...new Set([...(settings.ccCustomModels || []), id])] });
    else updateSettings({ [key]: id, [`${key}Custom`]: [...new Set([...(settings[`${key}Custom`] || []), id])] });
    fillModels();
  };
  effSel.onchange = () => updateSettings({ ocrEffortClaudeCode: effSel.value });
  fillModels();
  const prog = dlg.querySelector(".ocr-prog"), go = dlg.querySelector("#ocr-go");
  prog.textContent = ""; go.disabled = false;
  dlg.querySelector("#ocr-setup").onclick = (e) => { e.preventDefault(); dlg.close(); import("./settings.js").then((m) => m.openSettings("ocr")); };
  dlg.querySelector("#ocr-cancel").onclick = () => { if (running) { running.abort(); prog.textContent = "Stopping…"; } else dlg.close(); };
  dlg.onclose = () => { if (running) running.abort(); };
  go.onclick = async () => {
    const engine = sel.value, lang = langSel.value, mode = dlg.querySelector("#ocr-mode").value, pages = dlg.querySelector("#ocr-pages").value;
    if (!engineOk(engine, i)) { dlg.close(); return import("./settings.js").then((m) => m.openSettings("ocr")); }
    updateSettings({ ocrEngine: engine, [`ocrLang_${engine}`]: lang });
    go.disabled = true;
    running = new AbortController();
    prog.innerHTML = `<span class="spin"></span> Starting…`;
    try {
      const bytes = new Uint8Array(await api.readBinary(path));
      const md = await ocrFile({ name, bytes, engine, lang, mode, pages, signal: running.signal, onProgress: (d, n, label) => { const txt = label || `Page ${d} of ${n}…`; prog.innerHTML = `<span class="spin"></span> ${esc(txt)}`; status(txt); } });
      dlg.close();
      const title = name.replace(/\.[^.]+$/, "") + " (OCR).md";
      await openNewDoc(title, `<!-- OCR of ${name} (${ENGINES[engine].label}). Check and correct it, then Save, or Save ▾ → Export as PDF / Markdown. -->\n\n` + md);
      status(`OCR done — “${title}” is open to edit`, "ok");
    } catch (e) {
      prog.textContent = e.message === "Cancelled" ? "Stopped." : "";
      if (e.message !== "Cancelled") toast(`OCR failed: ${e.message}`, "err", 9000);
      go.disabled = false;
    } finally { running = null; }
  };
  dlg.showModal();
}

function ensureDialog() {
  let d = $("#dlg-ocr");
  if (d) return d;
  d = document.createElement("dialog");
  d.id = "dlg-ocr";
  d.innerHTML = `<form method="dialog">
    <header class="dlg-head"><h2>${ic("ocr")}<span>OCR — <span class="ocr-file"></span></span></h2><button class="icon" value="close">${ic("x")}</button></header>
    <div class="dlg-body ocr-body">
      <label>Engine <select id="ocr-engine"></select></label>
      <p class="note ocr-setup-note" hidden>This engine isn't set up yet — <a href="#" id="ocr-setup">open OCR settings</a> to download or connect it.</p>
      <div class="ocr-ai-row" hidden>
        <label>Model <select id="ocr-model"></select></label>
        <label class="ocr-effort-wrap">Effort <select id="ocr-effort"></select></label>
      </div>
      <label>Language <select id="ocr-lang"></select></label>
      <div class="ocr-pdf-only">
        <label>Recognise <select id="ocr-mode"><option value="auto">Only pages that are pictures (keep text the PDF already has)</option><option value="force">Every page (force OCR)</option></select></label>
        <label>Pages <input id="ocr-pages" type="text" placeholder="all — or e.g. 1-3, 7"></label>
      </div>
      <p class="note ocr-cloud-note" hidden>The page images are sent to this service.</p>
      <p class="note">The text opens as a Markdown document you can edit; then Save it, or Save ▾ → Export as PDF / Markdown.</p>
      <div class="ocr-prog note"></div>
    </div>
    <footer class="dlg-foot"><button type="button" id="ocr-cancel">Cancel</button><button type="button" id="ocr-go" class="primary">Recognise</button></footer>
  </form>`;
  document.body.appendChild(d);
  return d;
}
