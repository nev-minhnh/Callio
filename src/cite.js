// Citing from the library: the Alt+C popup, inserting \cite{key} / [@key] at the cursor, adding
// the BibTeX entry to the document's .bib (creating references.bib and the bibliography commands
// when needed), LaTeX bibliography styles, and CSL formatting of Markdown citations.
import { api, call } from "./api.js";
import { settings, toast, activeTab, getTabs, basename, dirname, rootFor, saveTab, ask } from "./main.js";
import { getView } from "./editor.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const norm = (p) => (p || "").replace(/\\/g, "/").toLowerCase();
const join = (dir, f) => (dir.replace(/[\\/]+$/, "") + "/" + f).replace(/\\/g, "/");

// ---------------- the popup ----------------
let state = { items: [], sel: 0, open: false, seq: 0 };

let insertHook = null;
/** `opts.insert(key)`: put the citation somewhere other than the source editor (visual mode). */
export async function openCitePopup(opts = {}) {
  insertHook = opts.insert || null;
  const t = activeTab();
  if (!t || (t.kind !== "tex" && t.kind !== "md")) return toast("Open a LaTeX or Markdown draft to cite.", "", 2500);
  const lib = await import("./library.js");
  await lib.loadLibrary();
  const pop = $("#cite-pop");
  const v = getView();
  let c = insertHook ? null : v.coordsAtPos(v.state.selection.main.head);
  if (!c) { const r = getSelection()?.rangeCount ? getSelection().getRangeAt(0).getBoundingClientRect() : null; if (r && (r.top || r.left)) c = { left: r.left, top: r.top, bottom: r.bottom }; }
  const w = Math.min(560, innerWidth - 24);
  pop.style.width = w + "px";
  pop.style.left = Math.max(12, Math.min((c?.left ?? 200) - 20, innerWidth - w - 12)) + "px";
  const below = (c?.bottom ?? 200) + 6;
  pop.style.top = (below + 380 < innerHeight ? below : Math.max(12, (c?.top ?? 200) - 386)) + "px";
  pop.hidden = false;
  state.open = true;
  $("#cite-style").textContent = t.kind === "tex" ? `${settings.citeCommand || "\\cite"} · ${(settings.citeLatexStyle || "plain").replace("biblatex:", "biblatex ")}` : `[@key] · ${settings.citeCsl || "apa"}`;
  const q = $("#cite-q");
  q.value = "";
  q.focus();
  if (!q._wired) {
    q._wired = true;
    let tm;
    q.addEventListener("input", () => { clearTimeout(tm); tm = setTimeout(() => refresh(), 120); });
    q.addEventListener("keydown", onKey);
    q.addEventListener("blur", () => setTimeout(() => { if (!pop.contains(document.activeElement)) close(); }, 150));
  }
  refresh();
}
function close() {
  if (!state.open) return;
  state.open = false;
  $("#cite-pop").hidden = true;
  getView()?.focus();
}
function onKey(e) {
  // Left/Right keep moving inside the search text (the input handles them)
  if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
  else if (e.key === "PageDown") { e.preventDefault(); move(8); }
  else if (e.key === "PageUp") { e.preventDefault(); move(-8); }
  else if (e.key === "Enter") { e.preventDefault(); pick(state.sel); }
  else if (e.key === "Escape") { e.preventDefault(); close(); }
}
function move(d) {
  if (!state.items.length) return;
  state.sel = Math.max(0, Math.min(state.items.length - 1, state.sel + d));
  draw();
}
async function refresh() {
  const lib = await import("./library.js");
  const L = lib.getLibrary();
  const query = $("#cite-q").value.trim();
  const seq = ++state.seq;
  let items;
  if (!query) {
    // papers already cited in this draft first, then recently added
    const draft = activeTab()?.path || "";
    const cited = L.papers.filter((p) => (p.usedIn || []).some((d) => norm(d) === norm(draft)));
    const rest = L.papers.filter((p) => !cited.includes(p)).sort((a, b) => b.added - a.added);
    items = [...cited, ...rest].slice(0, 60).map((p) => ({ p, h: null }));
  } else {
    const hits = await call("lib_search", { query, collection: null, draft: null, limit: 60 }).catch(() => []);
    if (seq !== state.seq) return;
    items = hits.map((h) => ({ p: L.byId.get(h.id), h })).filter((x) => x.p);
  }
  state.items = items;
  state.sel = 0;
  draw();
}
function draw() {
  const box = $("#cite-list");
  if (!state.items.length) {
    box.innerHTML = `<div class="cite-empty">${$("#cite-q").value ? "No paper matches." : "Your library is empty — add papers with 📚 Library."}</div>`;
    return;
  }
  const q = $("#cite-q").value.trim();
  const words = q.replace(/"/g, "").split(/\s+/).filter((w) => w.length > 2).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const hl = (s) => (words.length ? esc(s).replace(new RegExp(`(${words.join("|")})`, "gi"), "<mark>$1</mark>") : esc(s));
  box.innerHTML = state.items.map(({ p, h }, i) => `<div class="cite-item${i === state.sel ? " sel" : ""}" data-i="${i}" role="option" aria-selected="${i === state.sel}">
    <div class="ci-title">${hl(p.title)}</div>
    <div class="ci-meta">${esc((p.authors || []).slice(0, 3).map((a) => a.split(",")[0]).join(", "))}${p.authors?.length > 3 ? " et al." : ""}${p.year ? ` · ${p.year}` : ""}${p.venue ? ` · ${esc(p.venue)}` : ""} <span class="ci-key">${esc(p.key)}</span></div>
    ${h?.snippet ? `<div class="ci-snip">${h.page ? `p. ${h.page}: ` : ""}${hl(h.snippet)}</div>` : ""}</div>`).join("");
  for (const el of box.querySelectorAll(".cite-item")) {
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.onclick = () => pick(+el.dataset.i);
  }
  box.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}
async function pick(i) {
  const it = state.items[i];
  if (!it) return;
  close();
  await citePaper(it.p);
}

// ---------------- inserting ----------------
/** Cite a library paper at the cursor of the active draft and make sure its reference exists. */
export async function citePaper(p) {
  const t = activeTab();
  if (!t || (t.kind !== "tex" && t.kind !== "md")) return toast("Open a LaTeX or Markdown draft first.", "", 2500);
  if (!t.path && !(await saveTab(t))) return;
  const info = await call("lib_cite", { id: p.id, draft: t.path });
  let key = info.key;
  try {
    const bib = t.kind === "tex" ? await ensureTexBibliography(t) : await ensureMdBibliography(t);
    if (bib) key = await ensureEntry(bib, info, key);
  } catch (e) { toast(`The reference couldn't be added to the .bib: ${e.message}`, "err", 8000); }
  // the user may have switched files while we were busy: never cite into another file
  if (activeTab() !== t) {
    await navigator.clipboard.writeText(t.kind === "tex" ? `\\cite{${key}}` : `[@${key}]`).catch(() => {});
    return toast(`You switched files — the citation for ${key} was copied instead. Paste it where you want it.`, "", 6000);
  }
  insertAtCursor(t, key);
  toast(`Cited ${key}`, "ok", 1800);
}

function insertAtCursor(t, key) {
  if (insertHook) { const h = insertHook; insertHook = null; return h(key); }
  const v = getView();
  const { from, to } = v.state.selection.main;
  const before = v.state.sliceDoc(Math.max(0, from - 200), from);
  let text;
  if (t.kind === "tex") {
    // inside an existing \cite{a,|} → add the key to it
    const m = /\\[a-zA-Z]*cite[a-zA-Z]*\*?(\[[^\]]*\]){0,2}\{([^{}]*)$/.exec(before);
    if (m) text = (m[2].trim() && !/,\s*$/.test(m[2]) ? "," : "") + key;
    else {
      const cmd = settings.citeCommand || "\\cite";
      const prev = before.slice(-1);
      text = (prev && /[\p{L}\p{N}.,;:)]/u.test(prev) && cmd !== "\\textcite" && cmd !== "\\citet" ? "~" : "") + `${cmd}{${key}}`;
    }
  } else {
    const m = /\[(@[^\]]*)$/.exec(before);
    text = m ? `; @${key}` : `[@${key}]`;
  }
  v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.cite" });
  v.focus();
}

/** Read a file's text — from its open tab when it is open (so unsaved edits are kept). */
export async function readDoc(path) {
  const tab = getTabs().find((x) => x.path && norm(x.path) === norm(path));
  if (tab) return { text: tab === activeTab() ? getView().state.doc.toString() : tab.state.doc.toString(), tab };
  try { return { text: (await api.readText(path)).text, tab: null }; }
  catch (e) {
    // only a missing file counts as empty — anything else (locked, too big, offline) must stop us
    if (/os error 2\b|os error 3\b|not found|cannot find|no such file/i.test(e.message)) return { text: null, tab: null, missing: true };
    throw new Error(`couldn't read ${basename(path)} (${e.message})`);
  }
}
/** Write a file: through its tab when open (undo works, it's saved with the tab), else to disk. */
export async function writeDoc(path, text, label) {
  const tab = getTabs().find((x) => x.path && norm(x.path) === norm(path));
  if (tab) {
    if (tab === activeTab()) getView().dispatch({ changes: minimalChange(getView().state.doc.toString(), text) });
    else {
      tab.state = tab.state.update({ changes: minimalChange(tab.state.doc.toString(), text) }).state;
      tab.dirty = true;
    }
    return;
  }
  let old = null;
  try { old = await api.readText(path); }
  catch (e) { if (!/os error 2\b|os error 3\b|not found|cannot find|no such file/i.test(e.message)) throw e; }
  if (old) await api.historyRecord(path, old.text, `Before ${label}`, "manual");
  await api.writeText(path, text, old?.encoding || null, old?.mtime || null);
}

/** Only the changed middle part, so the cursor and undo history stay where they were. */
function minimalChange(a, b) {
  let s = 0;
  const max = Math.min(a.length, b.length);
  while (s < max && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  let e = 0;
  while (e < max - s && a.charCodeAt(a.length - 1 - e) === b.charCodeAt(b.length - 1 - e)) e++;
  return { from: s, to: a.length - e, insert: b.slice(s, b.length - e) };
}

const BIB_RE = /\\(?:bibliography|addbibresource|addglobalbib)\s*(?:\[[^\]]*\])?\{([^}]+)\}/g;

/** The .bib file of a LaTeX document (creating references.bib + the commands if there is none). */
async function ensureTexBibliography(t) {
  const root = (await rootFor(t)) || t.path;
  const dir = dirname(root);
  const { text: src } = await readDoc(root);
  if (src == null) throw new Error("couldn't read the main file");
  const files = [];
  for (const m of src.matchAll(BIB_RE)) for (const f of m[1].split(",")) files.push(f.trim());
  if (files.length) {
    const name = /\.bib$/i.test(files[0]) ? files[0] : files[0] + ".bib";
    const local = join(dir, name);
    if (!(await readDoc(local)).missing) return local;
    // not next to the document: TeX may find it elsewhere (a global bibliography)
    const global = await call("find_tex_file", { dir, name }).catch(() => null);
    if (global) {
      const r = await ask({ title: "Add the reference to your global bibliography?", text: `This document uses ${name}, which TeX finds at:\n${global}\n\nAdd the new reference there?`, buttons: [{ label: "Don't add", value: null }, { label: "Add it there", value: "yes", primary: true }] });
      return r ? global : null;
    }
    return local; // doesn't exist anywhere yet: create it next to the document
  }
  // no bibliography yet: add one with the chosen style
  const style = settings.citeLatexStyle || "plain";
  const bib = join(dir, "references.bib");
  let next = src;
  const usesBiblatex = /\\usepackage(\[[^\]]*\])?\{biblatex\}/.test(src);
  if (usesBiblatex || style.startsWith("biblatex:")) {
    if (!usesBiblatex) next = next.replace(/\\begin\{document\}/, `\\usepackage[style=${style.replace("biblatex:", "")},backend=biber]{biblatex}\n\\begin{document}`);
    next = next.replace(/\\begin\{document\}/, `\\addbibresource{references.bib}\n\\begin{document}`);
    next = next.replace(/\\end\{document\}/, `\\printbibliography\n\n\\end{document}`);
  } else {
    const natbib = /nat$|IEEEtranN|agsm|dcu|kluwer|harv|apalike|jss|rss|Science|naturemag|ACM-Reference|aaai-named|elsarticle-harv/.test(style);
    if (natbib && !/\\usepackage(\[[^\]]*\])?\{natbib\}/.test(src)) {
      const opt = /harv|agsm|dcu|kluwer|apalike|jss|rss|aaai-named/.test(style) ? "" : "[numbers]";
      next = next.replace(/\\begin\{document\}/, `\\usepackage${opt}{natbib}\n\\begin{document}`);
    }
    next = next.replace(/\\end\{document\}/, `\\bibliographystyle{${style}}\n\\bibliography{references}\n\n\\end{document}`);
  }
  if (next === src) throw new Error("the main file has no \\begin{document}…\\end{document}");
  await writeDoc(root, next, "adding the bibliography");
  toast(`Added references.bib and the bibliography (${style.replace("biblatex:", "biblatex ")}) to ${basename(root)}`, "ok", 5000);
  return bib;
}

/** The .bib of a Markdown draft: `bibliography:` in its front matter (added when missing). */
async function ensureMdBibliography(t) {
  const v = getView();
  const doc = v.state.doc.toString();
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(doc);
  const m = fm && /^bibliography:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(fm[1]);
  if (m) return join(dirname(t.path), m[1].trim());
  if (fm) {
    const end = fm.index + fm[0].lastIndexOf("---");
    v.dispatch({ changes: { from: end, insert: "bibliography: references.bib\n" } });
  } else v.dispatch({ changes: { from: 0, insert: `---\nbibliography: references.bib\n---\n\n` } });
  return join(dirname(t.path), "references.bib");
}

/** Make sure the .bib has this paper; returns the key to cite (an existing entry with the same DOI wins). */
async function ensureEntry(bibPath, info, key) {
  const { text } = await readDoc(bibPath);
  const cur = text ?? "";
  const entries = parseBib(cur);
  const same = (e) => (info.doi && e.fields.doi && e.fields.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase() === info.doi.toLowerCase())
    || simpleTitle(e.fields.title) === simpleTitle(info.title);
  const existing = entries.find((e) => e.key === key);
  if (existing) {
    if (same(existing)) return key;
    // that key is taken by a different paper in this .bib: use a free one
    let k2 = key, n = 0;
    const taken = new Set(entries.map((e) => e.key));
    while (taken.has(k2)) k2 = key + String.fromCharCode(98 + n++);
    info = { ...info, bibtex: info.bibtex.replace(/^(@\w+\{)[^,]+,/, `$1${k2},`) };
    key = k2;
  }
  const dup = entries.find((e) => same(e) && e.fields.title);
  if (dup) return dup.key;
  if (info.doi) {
    const doiRe = new RegExp(`@\\w+\\s*\\{\\s*([^,\\s]+)\\s*,[^@]*?doi\\s*=\\s*[{"]\\s*(https?://(dx\\.)?doi\\.org/)?${info.doi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[}"]`, "i");
    const m = doiRe.exec(cur);
    if (m) return m[1];
  }
  const next = (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + (cur ? "\n" : "") + info.bibtex;
  await writeDoc(bibPath, next, "adding a reference");
  if (text == null) toast(`Created ${basename(bibPath)}`, "ok", 2500);
  return key;
}

const simpleTitle = (t) => (t || "").toLowerCase().replace(/[{}\\]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Set the bibliography style of the open LaTeX document. */
export async function applyLatexStyle(style) {
  const t = activeTab();
  if (!t || t.kind !== "tex") return toast("Open the LaTeX document first.", "", 2500);
  const root = (await rootFor(t)) || t.path;
  const { text: src } = await readDoc(root);
  if (src == null) return;
  let next = src;
  if (style.startsWith("biblatex:")) {
    const s = style.slice(9);
    if (/\\usepackage\[[^\]]*\]\{biblatex\}/.test(src)) {
      next = /\\usepackage\[[^\]]*\bstyle=/.test(src) ? src.replace(/(\\usepackage\[[^\]]*?)\bstyle=[\w-]+/, `$1style=${s}`) : src.replace(/\\usepackage\[([^\]]*)\]\{biblatex\}/, `\\usepackage[style=${s},$1]{biblatex}`);
    } else if (/\\usepackage\{biblatex\}/.test(src)) next = src.replace(/\\usepackage\{biblatex\}/, `\\usepackage[style=${s}]{biblatex}`);
    else return toast("This document uses BibTeX, not biblatex — choose a BibTeX style, or switch it to biblatex first.", "", 6000);
  } else {
    if (/\\usepackage(\[[^\]]*\])?\{biblatex\}/.test(src)) return toast("This document uses biblatex — choose a biblatex style.", "", 5000);
    if (/\\bibliographystyle\{[^}]*\}/.test(src)) next = src.replace(/\\bibliographystyle\{[^}]*\}/, `\\bibliographystyle{${style}}`);
    else if (/\\bibliography\{/.test(src)) next = src.replace(/\\bibliography\{/, `\\bibliographystyle{${style}}\n\\bibliography{`);
    else return toast("This document has no \\bibliography yet — cite a paper with Alt+C and it is added with this style.", "", 6000);
  }
  if (next === src) return toast(`Already using ${style}`, "", 2000);
  await writeDoc(root, next, "changing the bibliography style");
  toast(`Bibliography style set to ${style.replace("biblatex:", "")} — recompile to see it`, "ok", 4000);
}

// ---------------- CSL (Markdown) ----------------
let CSL = null;
const styleCache = new Map();
const BUNDLED = import.meta.glob("./csl/*.csl", { query: "?raw", import: "default" });
async function styleXml(id) {
  if (styleCache.has(id)) return styleCache.get(id);
  let xml;
  const local = BUNDLED[`./csl/${id}.csl`];
  if (local) xml = await local();
  else {
    const list = (await import("./csl-styles.json")).default;
    const row = list.find((s) => s[0] === id);
    xml = await call("csl_fetch", { kind: "style", name: row?.[3] || id }); // a dependent style formats like its parent
  }
  styleCache.set(id, xml);
  return xml;
}
let enLocale = null;
async function localeXml(lang) {
  if (!lang || lang === "en-US") return (enLocale ??= (await import("./csl/locales-en-US.xml?raw")).default);
  try { return await call("csl_fetch", { kind: "locale", name: lang }); } catch { return localeXml("en-US"); }
}

/** BibTeX entries → CSL-JSON items (the common fields). */
function bibToCsl(entries) {
  const type = { article: "article-journal", inproceedings: "paper-conference", conference: "paper-conference", book: "book", incollection: "chapter", inbook: "chapter", phdthesis: "thesis", mastersthesis: "thesis", techreport: "report", misc: "document", online: "webpage" };
  const clean = (s) => (s || "").replace(/[{}]/g, "").replace(/\\&/g, "&").replace(/\\%/g, "%").replace(/\\_/g, "_").replace(/--/g, "–").trim();
  const names = (s) => (s || "").split(/\s+and\s+/).map((n) => n.trim()).filter(Boolean).map((n) => {
    if (n.includes(",")) { const [family, given] = n.split(",").map((x) => x.trim()); return { family, given }; }
    const parts = n.split(/\s+/);
    return parts.length > 1 ? { family: parts.pop(), given: parts.join(" ") } : { literal: n };
  });
  const out = {};
  for (const e of entries) {
    const f = e.fields;
    const item = { id: e.key, type: type[e.kind] || "article-journal", title: clean(f.title) };
    if (f.author) item.author = names(clean(f.author));
    if (f.editor) item.editor = names(clean(f.editor));
    if (f.year) item.issued = { "date-parts": [[parseInt(f.year, 10)]] };
    const venue = f.journal || f.booktitle || f.howpublished || f.school || f.institution;
    if (venue) item["container-title"] = clean(venue);
    for (const [k, c] of [["volume", "volume"], ["number", "issue"], ["pages", "page"], ["publisher", "publisher"], ["doi", "DOI"], ["url", "URL"]]) if (f[k]) item[c] = clean(f[k]);
    out[e.key] = item;
  }
  return out;
}
/** Small BibTeX parser (nested braces and quotes). */
export function parseBib(text) {
  const out = [];
  const re = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g;
  let m;
  while ((m = re.exec(text))) {
    const kind = m[1].toLowerCase();
    let i = re.lastIndex, depth = 1;
    const start = i;
    while (i < text.length && depth > 0) { if (text[i] === "{") depth++; else if (text[i] === "}") depth--; i++; }
    re.lastIndex = i;
    if (["comment", "string", "preamble"].includes(kind)) continue;
    const body = text.slice(start, i - 1);
    const fields = {};
    const fre = /(\w+)\s*=\s*/g;
    let fm;
    while ((fm = fre.exec(body))) {
      let j = fre.lastIndex, val = "";
      if (body[j] === "{") { let d = 0; const s = j; do { if (body[j] === "{") d++; else if (body[j] === "}") d--; j++; } while (j < body.length && d > 0); val = body.slice(s + 1, j - 1); }
      else if (body[j] === '"') { const s = ++j; while (j < body.length && body[j] !== '"') j++; val = body.slice(s, j); j++; }
      else { const s = j; while (j < body.length && body[j] !== ",") j++; val = body.slice(s, j).trim(); }
      fields[fm[1].toLowerCase()] = val;
      fre.lastIndex = j;
    }
    out.push({ kind, key: m[2], fields });
  }
  return out;
}

/**
 * Format [@key] citations in rendered Markdown HTML with the chosen CSL style, and add the
 * reference list (under a "References"/"Bibliography" heading, or at the end).
 */
export async function renderCitationsHtml(html, source, t) {
  if (!/\[@[^\]]+\]/.test(source || "")) return html;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  const bibName = fm && /^bibliography:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(fm[1])?.[1];
  const dir = t?.path ? dirname(t.path) : "";
  let entries = [];
  if (bibName && dir) { const { text } = await readDoc(join(dir, bibName.trim())); if (text) entries = parseBib(text); }
  const items = bibToCsl(entries);
  // keys that are only in the library still format
  try {
    const lib = await import("./library.js");
    const L = lib.getLibrary().papers.length ? lib.getLibrary() : await lib.loadLibrary();
    const missing = L.papers.filter((p) => !items[p.key] && source.includes("@" + p.key));
    if (missing.length) Object.assign(items, bibToCsl(parseBib(await call("lib_bibtex", { ids: missing.map((p) => p.id) }))));
  } catch {}
  const styleId = (fm && /^csl:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(fm[1])?.[1]?.replace(/\.csl$/, "")) || settings.citeCsl || "apa";
  CSL ??= (await import("citeproc")).default;
  const xml = await styleXml(styleId);
  const lang = /default-locale="([^"]+)"/.exec(xml)?.[1] || "en-US";
  const loc = await localeXml(lang);
  const engine = new CSL.Engine({ retrieveLocale: () => loc, retrieveItem: (id) => items[id] }, xml);
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (/\[@/.test(walker.currentNode.nodeValue) && !walker.currentNode.parentElement?.closest("code,pre")) nodes.push(walker.currentNode);
  const done = [];
  for (const node of nodes) {
    const parts = node.nodeValue.split(/(\[@[^\]]+\])/g);
    if (parts.length < 2) continue;
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      const m = /^\[(@[^\]]+)\]$/.exec(part);
      const keys = m ? m[1].split(/\s*;\s*/).map((k) => k.replace(/^@/, "").trim().split(/[\s,]/)[0]).filter((k) => items[k]) : [];
      if (!keys.length) { frag.appendChild(document.createTextNode(part)); continue; }
      const cit = { citationItems: keys.map((id) => ({ id })), properties: { noteIndex: done.length + 1 } };
      let out;
      try {
        const res = engine.processCitationCluster(cit, done.map((c, i) => [c.citationID, i + 1]), []);
        out = res[1].find((x) => x[2] === cit.citationID)?.[1] ?? res[1].slice(-1)[0][1];
      } catch { out = esc(part); }
      done.push(cit);
      const span = document.createElement("span");
      span.className = "csl-cite";
      span.innerHTML = out;
      frag.appendChild(span);
    }
    node.replaceWith(frag);
  }
  const bib = engine.makeBibliography();
  if (bib) {
    const refs = document.createElement("div");
    refs.className = "csl-bib";
    refs.innerHTML = bib[1].join("");
    const head = [...tpl.content.querySelectorAll("h1,h2,h3")].find((h) => /^(references|bibliography|works cited|literature|tài liệu tham khảo)$/i.test(h.textContent.trim()));
    if (head) head.after(refs);
    else { const h = document.createElement("h2"); h.textContent = "References"; tpl.content.append(h, refs); }
  }
  const d = document.createElement("div");
  d.appendChild(tpl.content);
  return d.innerHTML;
}

/**
 * Live preview: format [@key] citations in the Markdown preview and show the reference list.
 * Re-runs over every citation each time, so numbering stays right while you edit.
 */
export async function formatPreview(container, source, t) {
  if (!/\[@[^\]]+\]/.test(source)) { container.querySelector("#csl-refs")?.remove(); return; }
  // wrap raw [@…] text once; formatted spans keep their keys in data-cite
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (/\[@/.test(walker.currentNode.nodeValue) && !walker.currentNode.parentElement?.closest("code,pre,.csl-cite")) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const parts = node.nodeValue.split(/(\[@[^\]]+\])/g);
    if (parts.length < 2) continue;
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      const m = /^\[(@[^\]]+)\]$/.exec(part);
      if (!m) { frag.appendChild(document.createTextNode(part)); continue; }
      const span = document.createElement("span");
      span.className = "csl-cite";
      span.dataset.cite = m[1].split(/\s*;\s*/).map((k) => k.replace(/^@/, "").trim().split(/[\s,]/)[0]).join(";");
      span.dataset.raw = part;
      span.textContent = part;
      frag.appendChild(span);
    }
    node.replaceWith(frag);
  }
  const spans = [...container.querySelectorAll(".csl-cite[data-cite]")];
  if (!spans.length) return;
  // build the same HTML through renderCitationsHtml on a tiny document of the citations
  const probe = spans.map((s, i) => `<p data-i="${i}">${esc(s.dataset.raw)}</p>`).join("");
  const refsHead = [...container.querySelectorAll("h1,h2,h3")].some((h) => /^(references|bibliography|works cited|literature)$/i.test(h.textContent.trim()));
  let out;
  try { out = await renderCitationsHtml(probe + (refsHead ? "<h2>References</h2>" : ""), source, t); } catch (e) { console.warn(e); return; }
  const tpl = document.createElement("template");
  tpl.innerHTML = out;
  for (const p of tpl.content.querySelectorAll("p[data-i]")) {
    const s = spans[+p.dataset.i];
    const html = p.querySelector(".csl-cite")?.innerHTML ?? p.innerHTML;
    if (s && s.innerHTML !== html) s.innerHTML = html;
  }
  const bib = tpl.content.querySelector(".csl-bib");
  let refs = container.querySelector("#csl-refs");
  if (!bib) { refs?.remove(); return; }
  if (!refs) { refs = document.createElement("div"); refs.id = "csl-refs"; }
  const head = [...container.querySelectorAll("h1,h2,h3")].find((h) => /^(references|bibliography|works cited|literature)$/i.test(h.textContent.trim()));
  refs.innerHTML = (head ? "" : "<h2>References</h2>") + bib.outerHTML;
  if (head) { if (head.nextSibling !== refs) head.after(refs); }
  else if (refs.parentElement !== container || container.lastElementChild !== refs) container.appendChild(refs);
}
