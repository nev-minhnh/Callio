// Paper library window: browse and search papers (metadata + full text), collections, the drafts
// that cite them, add PDFs / DOIs / .bib files, pair the Edge extension. Loaded on first use.
import { api, call, listen } from "./api.js";
import { settings, updateSettings, toast, ask, openPath, activeTab, basename, dirname } from "./main.js";
import { dragOnto } from "./sortable.js";
import { ic } from "./icons.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const L = { papers: [], collections: [], dir: "", byId: new Map(), view: { kind: "all" }, hits: null, sel: null, q: "" };

export async function loadLibrary() {
  const r = await call("lib_list");
  L.papers = r.papers; L.collections = r.collections; L.dir = r.dir;
  L.byId = new Map(L.papers.map((p) => [p.id, p]));
  return L;
}
export const getLibrary = () => L;

// ---------------- full-text indexing (PDF.js in the window) ----------------
const queue = [];
let indexing = false;
export function queueText(ids) {
  for (const id of ids) if (!queue.includes(id)) queue.push(id);
  if (!indexing) runQueue();
}
async function runQueue() {
  indexing = true;
  const pdf = await import("./pdf.js");
  while (queue.length) {
    const id = queue.shift();
    try {
      const path = await call("lib_pdf_path", { id });
      if (!path) continue;
      status(`Indexing the text of ${L.byId.get(id)?.title?.slice(0, 50) || "a paper"}… (${queue.length} left)`);
      const r = await pdf.extractText(new Uint8Array(await api.readBinary(path)));
      await call("lib_set_text", { id, pages: r.pages });
      const p = L.byId.get(id);
      if (p) { p.text = true; p.pageCount = r.pages.length; }
      // a PDF without details: its DOI (or title) in the text gives them (Crossref)
      if (p && (!p.doi || !p.authors?.length || !p.title || p.title === "Untitled paper")) {
        const head = r.pages[0] || "";
        const m = /(?:doi(?:\.org)?[:/\s]*|https?:\/\/doi\.org\/)(10\.\d{4,9}\/[^\s"<>]+)/i.exec(head);
        // ACL Anthology file names are their DOIs: 2025.findings-naacl.239.pdf, P19-1001.pdf
        const fname = (path.split(/[\\/]/).pop() || "").replace(/\.pdf$/i, "");
        const acl = /^(\d{4}\.[a-z0-9]+(?:-[a-z0-9]+)*\.\d+|[A-Z]\d{2}-\d{4})$/i.test(fname) ? `10.18653/v1/${fname}` : null;
        const doi = p.doi || (m ? m[1].replace(/[.,;)\]]+$/, "") : acl);
        const title = (r.title && r.title.length > 10 && r.title.length < 300 ? r.title : null) || (r.info?.Title && r.info.Title.length > 12 ? r.info.Title : null) || head.split("\n").map((x) => x.trim()).find((x) => x.length > 15 && x.length < 250) || null;
        let found = false;
        try { found = await call("lib_enrich", { id, doi, title }); if (found) await loadLibrary(); } catch (e) { console.warn("details", e); }
        // still nothing: the AI reads the first pages and looks the document up on the internet
        if (!found && settings.libAiDetails !== false) {
          try { found = await findDetails(id, r.pages, { fileName: fname, info: r.info, titleGuess: title }); } catch (e) { console.warn("AI details", e); }
          if (found) await loadLibrary();
        }
        // nothing online: at least the title from the first page
        // (only a title that was guessed from the file name is replaced, never one you typed)
        const cur = L.byId.get(id) || p;
        if (!found && title && title !== cur.title && (!cur.title || cur.title === "Untitled paper" || cur.titleGuess)) await update(cur, { title, titleGuess: true });
        const q = L.byId.get(id);
        if (q && (!q.title || q.title === "Untitled paper") && r.info?.Title) await update(q, { title: r.info.Title });
      }
    } catch (e) { console.warn("index", id, e); }
    await new Promise((res) => (window.requestIdleCallback ? requestIdleCallback(res, { timeout: 500 }) : setTimeout(res, 50)));
  }
  indexing = false;
  status("");
  refreshAll();
}
// ---------------- details by AI + the web, for PDFs that have none ----------------
const norm = (t) => String(t || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function titleSim(a, b) {
  const A = new Set(norm(a).split(" ").filter((w) => w.length > 1)), B = new Set(norm(b).split(" ").filter((w) => w.length > 1));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return (2 * n) / (A.size + B.size);
}
function jsonIn(s) {
  s = String(s || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
const DETAILS_SHAPE = `{"title": "", "authors": ["Family, Given"], "year": 2024, "type": "article|inproceedings|incollection|book|phdthesis|mastersthesis|techreport|misc", "venue": "<journal, conference, school or institution>", "volume": "", "issue": "", "pages": "", "publisher": "", "doi": "", "arxiv": "", "url": "", "abstract": "", "query": "<a short web search query that would find this document>"}`;

/**
 * Find the bibliographic details of a library paper whose PDF had none: the AI reads its first
 * pages, the scholarly indexes (Crossref, Semantic Scholar, OpenAlex) and the web are searched,
 * and what is found fills the paper (a DOI found is checked against Crossref). Returns true when
 * details were found.
 */
export async function findDetails(id, pages, { fileName = "", info = null, titleGuess = "" } = {}) {
  const m = await import("./ai.js");
  const model = settings.aiModel_library || m.modelFor("summary") || m.modelFor("edit");
  if (!model) return false;
  const p = L.byId.get(id);
  const head = (pages || []).slice(0, 2).join("\n\n").slice(0, 7000);
  if (head.trim().length < 40 && !titleGuess) return false;
  status(`Finding the details of ${p?.title?.slice(0, 50) || fileName || "a paper"} with AI…`);
  // 1. what the first pages say
  const meta0 = jsonIn(await m.runAI("summary", {
    model, maxTokens: 2000, temperature: 0, effort: "low", thinking: false,
    system: `You read the first pages of a document (a paper, thesis, report, book chapter…) and extract its bibliographic details for a reference manager. Reply with JSON only, no prose:\n${DETAILS_SHAPE}\nUse only what the text shows; leave a field empty ("" or [] or null) when it isn't there. Authors as "Family, Given". Copy the abstract if there is one (at most 1500 characters). Never invent a DOI.`,
    messages: [{ role: "user", content: `File name: ${fileName}\nPDF properties: ${JSON.stringify(info || {}).slice(0, 400)}\n\nFirst pages:\n<<<\n${head}\n>>>` }],
  })) || {};
  const title = String(meta0.title || titleGuess || "").trim();
  if (!title) return false;
  // 2. the scholarly indexes, by title
  status(`Searching Crossref, Semantic Scholar and OpenAlex for “${title.slice(0, 60)}”…`);
  const engines = ["crossref", "semantic", "openalex"];
  const results = (await Promise.all(engines.map((e) => call("web_search_engine", { engine: e, query: title }).then((r) => r.map((h) => ({ ...h, engine: e }))).catch(() => [])))).flat();
  const firstFamily = norm(String((meta0.authors || [])[0] || "").split(",")[0]);
  const scored = results.map((h) => ({ h, s: titleSim(h.title, title) + (firstFamily && norm(h.meta).includes(firstFamily) ? 0.1 : 0) })).sort((a, b) => b.s - a.s);
  const best = scored[0]?.s >= 0.85 ? scored[0].h : null;
  let found = false;
  const doiOf = (u) => (/doi\.org\/(10\.[^\s?#]+)/i.exec(u || "") || [])[1] || "";
  if (best && doiOf(best.url)) {
    try { found = await call("lib_enrich", { id, doi: decodeURIComponent(doiOf(best.url)), title }); } catch { /* next */ }
  }
  let meta = meta0;
  if (!found && !best) {
    // 3. the web (and a second look by the AI at what it found)
    status(`Searching the web for “${title.slice(0, 60)}”…`);
    const q = String(meta0.query || title).slice(0, 200);
    const web = [...(await call("web_search_engine", { engine: "scholar", query: q }).catch(() => [])), ...(await call("web_search_engine", { engine: "google", query: q }).catch(() => []))].slice(0, 16);
    if (web.length) {
      const meta1 = jsonIn(await m.runAI("summary", {
        model, maxTokens: 2000, temperature: 0, effort: "low", thinking: false,
        system: `You complete a reference manager entry. You get the details read from a document's first pages and web search results about it. Reply with JSON only, no prose:\n${DETAILS_SHAPE}\nKeep what the document shows. Add details (venue, year, volume, pages, publisher, DOI, URL) only from a search result that is clearly this same document (same title and authors). Never invent anything; leave unknown fields empty.`,
        messages: [{ role: "user", content: `From the document:\n${JSON.stringify(meta0)}\n\nWeb search results:\n${web.map((h, i) => `[${i + 1}] ${h.title}\n${h.url}\n${h.meta || ""}\n${h.snippet || ""}`).join("\n\n")}` }],
      }));
      if (meta1?.title) meta = meta1;
      if (meta.doi && !found) { try { found = await call("lib_enrich", { id, doi: meta.doi, title }); } catch { /* keep the AI's */ } }
    }
  } else if (best && !found) {
    // an index knows it without a DOI (e.g. Semantic Scholar): its authors, year and venue
    const [au, yr, venue] = String(best.meta || "").split(" · ");
    meta = { ...meta0, title: meta0.title || best.title, year: meta0.year || (/^\d{4}$/.test(yr || "") ? +yr : null), venue: meta0.venue || (venue && !/^cited by/.test(venue) ? venue : ""), url: meta0.url || best.url, abstract: meta0.abstract || best.snippet || "" };
    if (!(meta0.authors || []).length && au && !/et al\.$/.test(au)) meta.authors = au.split(", ");
  }
  // 4. fill the paper (also after Crossref: the rest, and a real citation key)
  const clean = {
    title: String(meta.title || ""), authors: Array.isArray(meta.authors) ? meta.authors.map(String).filter(Boolean) : [],
    year: Number.isFinite(+meta.year) && +meta.year > 1000 ? Math.round(+meta.year) : null,
    type: /^(article|inproceedings|incollection|book|phdthesis|mastersthesis|techreport|misc)$/.test(meta.type || "") ? meta.type : "",
    venue: String(meta.venue || ""), volume: String(meta.volume || ""), issue: String(meta.issue || ""), pages: String(meta.pages || ""),
    publisher: String(meta.publisher || ""), doi: String(meta.doi || ""), arxiv: String(meta.arxiv || ""), url: String(meta.url || ""), abstract: String(meta.abstract || "").slice(0, 3000),
  };
  if (found) clean.doi = "";
  const np = await call("lib_fill", { id, meta: clean }).catch(() => null);
  const ok = found || !!(np && (np.authors?.length || np.year));
  if (ok) toast(`Found the details of “${(np?.title || title).slice(0, 70)}”`, "ok", 2500);
  return ok;
}

/** Find the details of every paper that has a PDF but no authors or year (the ⋯ menu). */
export async function findMissingDetails(ids = null) {
  await loadLibrary();
  const list = (ids ? ids.map((i) => L.byId.get(i)) : L.papers).filter((p) => p && p.pdf && (!p.authors?.length || !p.year || !p.title || p.title === "Untitled paper" || p.titleGuess));
  if (!list.length) { toast("Every paper with a PDF already has its details.", "ok", 2500); return; }
  const { loading } = await import("./loading.js");
  let stop = false;
  const ld = loading(`Finding details for ${list.length} paper${list.length === 1 ? "" : "s"}…`, { delay: 0, cancel: () => { stop = true; } });
  const pdf = await import("./pdf.js");
  let n = 0, got = 0;
  for (const p of list) {
    if (stop) break;
    ld.set(n / list.length, null, p.title?.slice(0, 70) || "");
    try {
      const path = await call("lib_pdf_path", { id: p.id });
      if (path) {
        const r = await pdf.extractText(new Uint8Array(await api.readBinary(path)), { maxPages: 3 }).catch(() => ({ pages: [] }));
        const fname = (path.split(/[\\/]/).pop() || "").replace(/\.pdf$/i, "");
        const head = r.pages?.[0] || "";
        const mm = /(?:doi(?:\.org)?[:/\s]*|https?:\/\/doi\.org\/)(10\.\d{4,9}\/[^\s"<>]+)/i.exec(head);
        const titleGuess = r.title || head.split("\n").map((x) => x.trim()).find((x) => x.length > 15 && x.length < 250) || "";
        let found = false;
        if (mm) found = await call("lib_enrich", { id: p.id, doi: mm[1].replace(/[.,;)\]]+$/, ""), title: titleGuess }).catch(() => false);
        if (!found) found = await findDetails(p.id, r.pages, { fileName: fname, info: r.info, titleGuess });
        if (found) got++;
      }
    } catch (e) { console.warn("details", p.id, e); }
    n++;
  }
  ld.done();
  await loadLibrary();
  refreshAll();
  status("");
  toast(stop ? `Stopped — details found for ${got} of ${n}` : `Details found for ${got} of ${list.length} paper${list.length === 1 ? "" : "s"}`, got ? "ok" : "", 4000);
}

/** Index every paper whose PDF text isn't in the index yet (after an update, or added elsewhere). */
export async function backfill() {
  await loadLibrary();
  queueText(L.papers.filter((p) => p.pdf && !p.text).map((p) => p.id));
}

function status(t) { const s = $("#lib-status"); if (s) s.textContent = t; }

// ---------------- window ----------------
let wired = false;
export async function openLibrary(opts = {}) {
  await loadLibrary();
  const dlg = $("#dlg-library");
  if (!wired) wire();
  if (opts.draft) L.view = { kind: "draft", id: opts.draft };
  renderNav();
  await search();
  if (!dlg.open) dlg.showModal();
  $("#lib-q").focus();
  backfill();
}

function wire() {
  wired = true;
  const dlg = $("#dlg-library");
  $("#lib-close").onclick = () => dlg.close();
  let t;
  $("#lib-q").addEventListener("input", () => { clearTimeout(t); t = setTimeout(search, 160); });
  $("#lib-q").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveSel(1); $("#lib-list").focus(); }
  });
  $("#lib-list").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveSel(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); }
    else if (e.key === "Enter" && L.sel) { e.preventDefault(); openPdf(L.byId.get(L.sel)); }
    else if (e.key === "Delete" && L.sel) { e.preventDefault(); remove([L.sel]); }
  });
  const addMenu = $("#lib-add").parentElement.querySelector(".menu");
  $("#lib-add").onclick = (e) => { e.stopPropagation(); addMenu.hidden = !addMenu.hidden; };
  dlg.addEventListener("click", (e) => { if (!e.target.closest("#lib-add")) addMenu.hidden = true; });
  addMenu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-lib]"); if (!b) return;
    addMenu.hidden = true;
    ({ pdf: addPdfs, id: addById, bib: importBib, ext: setupExtension, details: () => findMissingDetails() })[b.dataset.lib]?.();
  });
  // drag papers onto a collection
  dragOnto($("#lib-list"), {
    item: ".lib-item", targets: '.lib-nav-item[data-kind="col"]',
    label: (el) => el.querySelector(".li-title")?.textContent,
    accept: (t, el) => !L.byId.get(el.dataset.id)?.collections.includes(t.dataset.id),
    drop: async (el, t) => {
      const p = L.byId.get(el.dataset.id);
      if (p && !p.collections.includes(t.dataset.id)) { await update(p, { collections: [...p.collections, t.dataset.id] }); renderNav(); toast("Added to the collection", "ok", 1500); }
    },
  });
  // drop PDF files onto the window
  dlg.addEventListener("dragover", (e) => { e.preventDefault(); dlg.classList.add("drop"); });
  dlg.addEventListener("dragleave", () => dlg.classList.remove("drop"));
  dlg.addEventListener("drop", (e) => { e.preventDefault(); dlg.classList.remove("drop"); });
}

/** A paper was added or changed (e.g. from the Edge extension). */
/** Reload everything the library window shows (list, counts, the selected paper). */
async function refreshAll() {
  await loadLibrary();
  if (!$("#dlg-library").open) return;
  renderNav();
  await search();
  if (L.sel && L.byId.has(L.sel)) renderDetail();
}
export async function onLibraryChanged(e) {
  await refreshAll();
  if (e?.needsText) queueText([e.id]);
  if ($("#dlg-library").open) return;
  else if (e?.id && !e.silent) toast(`Added to your library: ${L.byId.get(e.id)?.title?.slice(0, 80) || "a paper"}`, "ok", 3500);
}

/** Files dropped on the window (Tauri gives paths). */
export async function addPaths(paths) {
  const pdfs = paths.filter((p) => /\.pdf$/i.test(p));
  const bibs = paths.filter((p) => /\.bib$/i.test(p));
  if (pdfs.length) {
    const open = $("#dlg-library").open;
    let ok = 0, failed = [];
    const run = async (c) => {
      for (const [i, p] of pdfs.entries()) {
        if (c) c.querySelector(".lb-step").textContent = `${basename(p)} (${i + 1} of ${pdfs.length})`;
        try { await addOne({ pdfPath: p, meta: {}, lookup: true, collection: L.view.kind === "col" ? L.view.id : null }); ok++; }
        catch (e) { failed.push(`${basename(p)}: ${e.message}`); }
      }
      if (c) showResult(c, failed.length ? (ok ? "partial" : false) : true, `<b>${ok} PDF${ok === 1 ? "" : "s"} added</b><p class="note">Their details are looked up from the DOI or title in each PDF while the text is indexed.</p>${failed.length ? `<ul class="lb-list">${failed.map((f) => `<li class="warn">${esc(f)}</li>`).join("")}</ul>` : ""}`);
    };
    if (open) await withProgress(`Adding ${pdfs.length} PDF${pdfs.length > 1 ? "s" : ""}`, run);
    else { await run(null); toast(`Added ${ok} PDF${ok === 1 ? "" : "s"} — indexing their text…`, failed.length ? "err" : "ok", 3500); }
  }
  for (const b of bibs) await importBib(b);
}

// ---------------- adding, with a progress card in the middle of the library ----------------
function busyCard() {
  const dlg = $("#dlg-library");
  let c = dlg.querySelector(".lib-busy");
  if (!c) { c = document.createElement("div"); c.className = "lib-busy"; dlg.appendChild(c); }
  return c;
}
function showBusy(title) {
  const c = busyCard();
  c.innerHTML = `<div class="lb-card"><div class="lb-spin"></div><b class="lb-title"></b><div class="lb-step note">Starting…</div></div>`;
  c.querySelector(".lb-title").textContent = title;
  c.hidden = false;
  return c;
}
function showResult(c, ok, html, actions = []) {
  c.innerHTML = `<div class="lb-card ${ok ? "ok" : "fail"}"><div class="lb-icon">${ok === "partial" ? "⚠" : ok ? "✓" : "✕"}</div>${html}<div class="lb-actions"></div></div>`;
  const box = c.querySelector(".lb-actions");
  for (const a of [...actions, { label: "OK", primary: !actions.length, run: () => { c.hidden = true; refreshAll(); } }]) {
    const b = document.createElement("button");
    b.className = "small" + (a.primary ? " primary" : "");
    b.textContent = a.label;
    b.onclick = a.run;
    box.appendChild(b);
  }
  box.querySelector(".primary")?.focus();
}
let progressUn = null;
async function withProgress(title, fn) {
  const c = showBusy(title);
  progressUn ||= await listen("library-add-progress", (e) => { const s = busyCard().querySelector(".lb-step"); if (s) s.textContent = e.step; });
  try { return await fn(c); } catch (e) { showResult(c, false, `<b>Couldn't add the paper</b><p class="note">${esc(e.message)}</p>`); return null; }
}
function resultHtml(r) {
  const p = L.byId.get(r.id) || {};
  const authors = (p.authors || []).slice(0, 4).join("; ") + ((p.authors || []).length > 4 ? " et al." : "");
  const pdf = r.pdf ? `<li class="good">PDF saved${r.pdfSource ? ` (from ${esc(r.pdfSource)})` : ""} — its text is being indexed</li>`
    : p.pdf ? `<li class="good">PDF already in your library</li>`
    : r.login ? `<li class="warn">🔒 ${esc(hostOf(r.login))} didn't hand out the PDF — it probably needs you to sign in (or your institution's access)</li>`
    : `<li class="warn">No free PDF found — drop the PDF on this window, or sign in to the publisher</li>`;
  const meta = r.hasMeta ? `<li class="good">Details found${p.doi ? ` · DOI ${esc(p.doi)}` : ""}</li>` : `<li class="warn">Few details found — they're filled in from the PDF's DOI or title when possible; edit them on the right</li>`;
  return `<b>${r.duplicate ? "Already in your library — updated" : "Added to your library"}</b><div class="lb-paper">${esc(p.title || r.title)}</div>${authors ? `<div class="note">${esc(authors)}${p.year ? ` · ${p.year}` : ""}${p.venue ? ` · ${esc(p.venue)}` : ""}</div>` : ""}<ul class="lb-list">${meta}${pdf}</ul>`;
}
const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };

/** Sign in to the publisher in a Callio window; the PDF is saved as soon as it opens there. */
async function signInForPdf(id, url, c) {
  c = c || showBusy("Getting the PDF");
  c.hidden = false;
  c.innerHTML = `<div class="lb-card"><div class="lb-spin"></div><b>Sign in to ${esc(hostOf(url))}</b><div class="note">A window opened. Sign in (your institution's login works too), then open the paper's PDF there — Callio saves it automatically and remembers the sign-in for next time.</div><div class="lb-actions"><button class="small lb-cancel">Cancel</button></div></div>`;
  let un;
  const done = new Promise((res) => { listen("library-pdf-login", (e) => { if (e.id === id) res(e); }).then((u) => { un = u; }); });
  c.querySelector(".lb-cancel").onclick = () => { c.hidden = true; call("lib_sign_in_pdf_close").catch(() => {}); };
  try { await call("lib_sign_in_pdf", { id, url }); } catch (e) { un?.(); return showResult(c, false, `<b>Couldn't open the sign-in window</b><p class="note">${esc(e.message)}</p>`); }
  const r = await done;
  try { un?.(); } catch {}
  await refreshAll();
  if (r.ok) { queueText([id]); showResult(c, true, `<b>PDF saved</b><div class="lb-paper">${esc(L.byId.get(id)?.title || "")}</div><p class="note">The sign-in to ${esc(hostOf(url))} is kept for the next papers from there.</p>`); }
  else showResult(c, false, `<b>No PDF yet</b><p class="note">${esc(r.message)}</p>`, [{ label: "Try again", primary: true, run: () => signInForPdf(id, url, c) }]);
}

async function addOne(req, c) {
  const r = await call("lib_add", { req });
  await loadLibrary();
  if (r.needsText) queueText([r.id]);
  return r;
}

async function addPdfs() {
  const p = await api.pickOpenFile();
  if (!p) return;
  await addPaths([p]);
  renderNav(); search();
}
async function addById() {
  const v = await ask({ title: "Add a paper", text: "Paste a DOI (10.…), a DOI link, an arXiv id, the paper's web page or its PDF link. Like Zotero, Callio fetches the details and the PDF; if the PDF needs a sign-in, it lets you sign in once.", input: "" });
  if (!v?.trim()) return;
  let s = v.trim().replace(/^doi:\s*/i, "");
  const meta = {};
  let pdfUrl = null, pageUrl = null;
  const doiLink = /^https?:\/\/(?:dx\.)?doi\.org\/(10\.\S+)$/i.exec(s);
  if (doiLink) s = decodeURIComponent(doiLink[1]);
  if (/^10\.\d{4,9}\//.test(s)) meta.doi = s;
  else if (/^(arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i.test(s)) meta.arxiv = s.replace(/^arxiv:/i, "");
  else if (/^https?:\/\//.test(s)) { if (/\.pdf(\?|#|$)/i.test(s) || /arxiv\.org\/pdf\/|\/pdf\//i.test(s)) pdfUrl = s; else pageUrl = s; }
  else meta.title = s;
  if (meta.arxiv) pdfUrl = `https://arxiv.org/pdf/${meta.arxiv}`;
  await withProgress("Adding the paper", async (c) => {
    const r = await addOne({ meta, pdfUrl, pageUrl, lookup: true, collection: L.view.kind === "col" ? L.view.id : null }, c);
    L.sel = r.id; await refreshAll();
    const actions = r.login ? [{ label: `Sign in to ${hostOf(r.login)}`, primary: true, run: () => signInForPdf(r.id, r.login, c) }] : [];
    showResult(c, r.pdf || L.byId.get(r.id)?.pdf ? (r.hasMeta ? true : "partial") : "partial", resultHtml(r), actions);
    return r;
  });
}
async function importBib(path) {
  const p = typeof path === "string" ? path : await api.pickOpenFile();
  if (!p) return;
  if (!/\.bib$/i.test(p)) return toast("Choose a .bib file", "err");
  const n = await call("lib_import_bib", { path: p, collection: L.view.kind === "col" ? L.view.id : null }).catch((e) => toast(e.message, "err"));
  if (n !== undefined) toast(`Imported ${n} entr${n === 1 ? "y" : "ies"} from ${basename(p)}`, "ok", 3500);
  await loadLibrary(); renderNav(); search();
}

export async function setupExtension() {
  const dir = await call("lib_extension_dir");
  const r = await ask({
    title: "Save papers from Microsoft Edge",
    text: `Callio's Edge extension adds the paper you're reading — details and PDF, using your browser sign-in — to this library.\n\nOne-time setup:\n1. In Edge's Extensions page that opens, turn on "Developer mode" (bottom-left).\n2. Click "Load unpacked" and choose this folder:\n${dir}\n3. Pin "Save to Callio", open a paper and click it (or press Alt+Q). The first time, click Connect and confirm in Callio.`,
    buttons: [{ label: "Close", value: null }, { label: "Show the folder", value: "folder" }, { label: "Open Edge extensions", value: "edge", primary: true }],
  });
  if (r === "folder") api.revealPath(dir + "/manifest.json");
  if (r === "edge") { call("lib_open_edge_extensions").catch((e) => toast(e.message, "err")); api.revealPath(dir + "/manifest.json"); }
}

// ---------------- navigation ----------------
function draftsIndex() {
  const m = new Map();
  for (const p of L.papers) for (const d of p.usedIn || []) m.set(d, (m.get(d) || 0) + 1);
  for (const c of L.collections) for (const d of c.drafts || []) if (!m.has(d)) m.set(d, 0);
  return [...m.entries()].sort((a, b) => basename(a[0]).localeCompare(basename(b[0])));
}
function renderNav() {
  const nav = $("#lib-nav");
  const v = L.view;
  const item = (kind, id, label, n, extra = "") => `<button class="lib-nav-item${v.kind === kind && (v.id || "") === (id || "") ? " on" : ""}" data-kind="${kind}" data-id="${esc(id || "")}" ${extra}><span>${label}</span><small>${n ?? ""}</small></button>`;
  const cols = [...L.collections].sort((a, b) => a.name.localeCompare(b.name));
  const tree = (parent, depth) => cols.filter((c) => (c.parent || null) === parent).map((c) =>
    item("col", c.id, `${"&nbsp;".repeat(depth * 3)}📁 ${esc(c.name)}`, L.papers.filter((p) => p.collections.includes(c.id)).length, `title="${esc(c.name)}${c.drafts?.length ? " — drafts: " + c.drafts.map(basename).join(", ") : ""}"`) + tree(c.id, depth + 1)).join("");
  nav.innerHTML = item("all", "", "📚 All papers", L.papers.length) + item("unfiled", "", "📄 Not in a collection", L.papers.filter((p) => !p.collections.length).length) + item("nopdf", "", "⚠ Without PDF", L.papers.filter((p) => !p.pdf).length) +
    `<div class="lib-nav-h">Collections <button class="icon small" id="lib-newcol" title="New collection">＋</button></div>` + (tree(null, 0) || `<div class="note pad">No collections yet</div>`) +
    `<div class="lib-nav-h">Drafts that cite papers</div>` + (draftsIndex().map(([d, n]) => item("draft", d, `✎ ${esc(basename(d))}`, n, `title="${esc(d)}"`)).join("") || `<div class="note pad">Papers you cite with Alt+C link here</div>`);
  for (const b of nav.querySelectorAll(".lib-nav-item")) {
    b.onclick = () => { L.view = { kind: b.dataset.kind, id: b.dataset.id || null }; renderNav(); search(); };
    if (b.dataset.kind === "col") b.oncontextmenu = (e) => { e.preventDefault(); collectionMenu(L.collections.find((c) => c.id === b.dataset.id)); };
  }
  $("#lib-newcol").onclick = async () => {
    const name = await ask({ title: "New collection", input: "" });
    if (!name?.trim()) return;
    const parent = L.view.kind === "col" ? L.view.id : null;
    const c = await call("lib_save_collection", { collection: { id: "", name: name.trim(), parent, drafts: [] } });
    await loadLibrary(); L.view = { kind: "col", id: c.id }; renderNav(); search();
  };
}

async function collectionMenu(c) {
  const r = await ask({ title: `Collection “${c.name}”`, text: c.drafts?.length ? `Linked drafts: ${c.drafts.map(basename).join(", ")}` : "", buttons: [{ label: "Cancel", value: null }, { label: "Delete", value: "del" }, { label: "Link the open draft", value: "link" }, { label: "Rename…", value: "ren", primary: true }] });
  if (r === "ren") { const n = await ask({ title: "Rename collection", input: c.name }); if (n?.trim()) await call("lib_save_collection", { collection: { ...c, name: n.trim() } }); }
  if (r === "link") { const t = activeTab(); if (t?.path) await call("lib_save_collection", { collection: { ...c, drafts: [...new Set([...(c.drafts || []), t.path])] } }); else toast("Open the draft first", "", 2500); }
  if (r === "del" && (await ask({ title: `Delete “${c.name}”?`, text: "The papers stay in your library.", buttons: [{ label: "Cancel", value: null }, { label: "Delete", value: "y", primary: true }] }))) {
    await call("lib_delete_collection", { id: c.id }); L.view = { kind: "all" };
  }
  await loadLibrary(); renderNav(); search();
}

// ---------------- list ----------------
async function search() {
  const q = $("#lib-q").value.trim();
  L.q = q;
  const v = L.view;
  if (q) {
    status("Searching…");
    try { L.hits = await call("lib_search", { query: q, collection: v.kind === "col" ? v.id : null, draft: v.kind === "draft" ? v.id : null, limit: 200 }); }
    catch (e) { L.hits = []; toast(e.message, "err"); }
    status(`${L.hits.length} result${L.hits.length === 1 ? "" : "s"}`);
  } else { L.hits = null; status(""); }
  renderList();
}
function visible() {
  const v = L.view;
  const inView = (p) => v.kind === "all" || (v.kind === "col" && p.collections.includes(v.id)) || (v.kind === "unfiled" && !p.collections.length) || (v.kind === "nopdf" && !p.pdf) || (v.kind === "draft" && (p.usedIn || []).some((d) => d.toLowerCase() === v.id.toLowerCase()));
  if (L.hits) return L.hits.map((h) => ({ p: L.byId.get(h.id), h })).filter((x) => x.p && inView(x.p));
  return L.papers.filter(inView).sort((a, b) => b.added - a.added).map((p) => ({ p, h: null }));
}
const authorsShort = (a) => !a?.length ? "" : a.length === 1 ? a[0].split(",")[0] : a.length === 2 ? `${a[0].split(",")[0]} & ${a[1].split(",")[0]}` : `${a[0].split(",")[0]} et al.`;
function highlight(text, q) {
  let h = esc(text);
  const words = q.replace(/"/g, "").split(/\s+/).filter((w) => w.length > 2).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length) h = h.replace(new RegExp(`(${words.join("|")})`, "gi"), "<mark>$1</mark>");
  return h;
}
function renderList() {
  const box = $("#lib-list");
  const items = visible();
  if (!items.length) {
    box.innerHTML = `<div class="lib-empty">${L.papers.length ? (L.q ? "Nothing matches." : "No papers here yet.") : `<b>Your library is empty</b><p>Drop PDF files here, use <b>+ Add</b>, or save papers from Edge with the extension.</p><button class="primary small" id="lib-ext2">Set up the Edge extension</button>`}</div>`;
    $("#lib-ext2")?.addEventListener("click", setupExtension);
    renderDetail();
    return;
  }
  box.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const { p, h } of items.slice(0, 500)) {
    const el = document.createElement("div");
    el.className = "lib-item" + (p.id === L.sel ? " sel" : "");
    el.dataset.id = p.id;
    el.innerHTML = `<div class="li-title">${L.q ? highlight(p.title, L.q) : esc(p.title)}</div>
      <div class="li-meta">${esc(authorsShort(p.authors))}${p.year ? ` · ${p.year}` : ""}${p.venue ? ` · <i>${esc(p.venue)}</i>` : ""}</div>
      ${h?.snippet ? `<div class="li-snip">${h.page ? `<span class="li-page">p. ${h.page}</span> ` : ""}${highlight(h.snippet, L.q)}</div>` : ""}
      <div class="li-badges">${p.pdf ? `<span class="b">PDF</span>` : `<span class="b off">no PDF</span>`}${p.pdf && !p.text ? `<span class="b off">indexing…</span>` : ""}${p.usedIn?.length ? `<span class="b cite" title="${esc(p.usedIn.join("\n"))}">cited in ${p.usedIn.length}</span>` : ""}<span class="b key">${esc(p.key)}</span></div>`;
    el.onclick = () => { L.sel = p.id; for (const x of box.querySelectorAll(".sel")) x.classList.remove("sel"); el.classList.add("sel"); renderDetail(h); };
    el.ondblclick = () => openPdf(p, h?.page);
    frag.appendChild(el);
  }
  box.appendChild(frag);
  if (!L.sel || !items.some((x) => x.p.id === L.sel)) L.sel = items[0].p.id;
  box.querySelector(`[data-id="${CSS.escape(L.sel)}"]`)?.classList.add("sel");
  renderDetail(items.find((x) => x.p.id === L.sel)?.h);
}
function moveSel(d) {
  const items = visible();
  if (!items.length) return;
  let i = items.findIndex((x) => x.p.id === L.sel);
  i = Math.max(0, Math.min(items.length - 1, i + d));
  L.sel = items[i].p.id;
  const box = $("#lib-list");
  for (const x of box.querySelectorAll(".sel")) x.classList.remove("sel");
  const el = box.querySelector(`[data-id="${CSS.escape(L.sel)}"]`);
  el?.classList.add("sel"); el?.scrollIntoView({ block: "nearest" });
  renderDetail(items[i].h);
}

// ---------------- details ----------------
async function update(p, patch) {
  try {
    const np = await call("lib_update", { id: p.id, patch });
    Object.assign(p, np);
    L.byId.set(p.id, p);
    return p;
  } catch (e) { toast(e.message, "err", 5000); return null; }
}
function renderDetail(hit) {
  const box = $("#lib-detail");
  const p = L.byId.get(L.sel);
  if (!p) { box.innerHTML = ""; return; }
  const field = (k, label, val, opts = "") => `<label>${label}<input data-f="${k}" value="${esc(val ?? "")}" ${opts}></label>`;
  box.innerHTML = `
    <div class="ld-actions">
      <button class="primary small" id="ld-open" ${p.pdf ? "" : "disabled"}>Open PDF${hit?.page ? ` (p. ${hit.page})` : ""}</button>
      <button class="small" id="ld-cite" title="Insert a citation at the cursor in the open draft and add the reference">Cite in draft</button>
      <button class="small" id="ld-bib">Copy BibTeX</button>
      ${p.pdf ? `<button class="small" id="ld-ai" title="The AI reads the first pages and looks the paper up on the internet (Crossref, Semantic Scholar, OpenAlex, Google Scholar…), then fills the empty fields">${ic("sparkles")}<span>Find details with AI</span></button>` : ""}
      ${p.pdf ? "" : `<button class="small" id="ld-find">Find PDF online</button><button class="small" id="ld-attach">Attach PDF…</button>`}
      <button class="small icon" id="ld-del" title="Remove from library">${ic("trash")}</button>
    </div>
    <label>Title<textarea data-f="title" rows="3">${esc(p.title)}</textarea></label>
    <label>Authors <small>(one per line, “Family, Given”)</small><textarea data-f="authors" rows="${Math.min(6, Math.max(2, p.authors.length))}">${esc(p.authors.join("\n"))}</textarea></label>
    <div class="row">${field("year", "Year", p.year, 'inputmode="numeric" class="narrow"')}${field("key", "Citation key", p.key, 'spellcheck="false"')}</div>
    ${field("venue", "Journal / conference", p.venue)}
    <div class="row">${field("volume", "Volume", p.volume, 'class="narrow"')}${field("issue", "Issue", p.issue, 'class="narrow"')}${field("pages", "Pages", p.pages)}</div>
    <div class="row">${field("doi", "DOI", p.doi, 'spellcheck="false"')}<label>Type<select data-f="type">${["article", "inproceedings", "book", "incollection", "phdthesis", "mastersthesis", "techreport", "misc"].map((t) => `<option ${t === (p.type || "article") ? "selected" : ""}>${t}</option>`).join("")}</select></label></div>
    ${field("url", "Link", p.url, 'spellcheck="false"')}
    <label>Tags <small>(comma-separated)</small><input data-f="tags" value="${esc(p.tags.join(", "))}"></label>
    <div class="ld-cols"><span class="note">Collections:</span> ${L.collections.map((c) => `<label class="chip-check"><input type="checkbox" data-col="${c.id}" ${p.collections.includes(c.id) ? "checked" : ""}> ${esc(c.name)}</label>`).join("") || `<span class="note">none yet — create one on the left</span>`}</div>
    <label>Notes<textarea data-f="notes" rows="3">${esc(p.notes)}</textarea></label>
    ${p.abstract ? `<details class="ld-abs"><summary>Abstract</summary><p>${esc(p.abstract)}</p></details>` : ""}
    ${p.usedIn?.length ? `<div class="ld-used"><span class="note">Cited in:</span>${p.usedIn.map((d) => `<a href="#" data-draft="${esc(d)}" title="${esc(d)}">${esc(basename(d))}</a>`).join("")}</div>` : ""}
    <div class="note">${p.pdf ? `${p.pageCount || "?"} pages${p.text ? " · text indexed" : " · indexing…"}` : "No PDF stored"} · added ${new Date(p.added).toLocaleDateString()}</div>`;
  for (const el of box.querySelectorAll("[data-f]")) {
    el.onchange = async () => {
      const k = el.dataset.f;
      let v = el.value;
      if (k === "authors") v = v.split("\n").map((s) => s.trim()).filter(Boolean);
      else if (k === "tags") v = v.split(",").map((s) => s.trim()).filter(Boolean);
      else if (k === "year") v = v.trim() ? parseInt(v, 10) || null : null;
      if (await update(p, { [k]: v })) { status("Saved"); if (["title", "authors", "year", "venue", "key"].includes(k)) renderListKeepScroll(); }
      else renderDetail(hit);
    };
  }
  for (const c of box.querySelectorAll("[data-col]")) c.onchange = async () => {
    const set = new Set(p.collections);
    c.checked ? set.add(c.dataset.col) : set.delete(c.dataset.col);
    await update(p, { collections: [...set] }); renderNav();
  };
  for (const a of box.querySelectorAll("[data-draft]")) a.onclick = (e) => { e.preventDefault(); $("#dlg-library").close(); openPath(a.dataset.draft); };
  $("#ld-open").onclick = () => openPdf(p, hit?.page);
  $("#ld-cite").onclick = async () => { $("#dlg-library").close(); (await import("./cite.js")).citePaper(p); };
  $("#ld-ai")?.addEventListener("click", async (e) => { const b = e.currentTarget; b.disabled = true; b.classList.add("is-busy"); try { await findMissingDetails([p.id]); } finally { b.disabled = false; b.classList.remove("is-busy"); } });
  $("#ld-bib").onclick = async () => { await navigator.clipboard.writeText(await call("lib_bibtex", { ids: [p.id] })); toast("BibTeX copied", "ok", 1500); };
  $("#ld-attach")?.addEventListener("click", async () => {
    const f = await api.pickOpenFile();
    if (!f) return;
    const r = await addOne({ meta: { ...p, title: p.title }, pdfPath: f, lookup: false }).catch((e) => { toast(e.message, "err", 6000); return null; });
    if (r) { await loadLibrary(); renderList(); }
  });
  $("#ld-find")?.addEventListener("click", () => withProgress("Finding the PDF", async (c) => {
    const r = await addOne({ meta: { doi: p.doi, arxiv: p.arxiv, title: p.title, url: p.url }, pageUrl: p.url || null, lookup: true });
    await refreshAll();
    const actions = r.login ? [{ label: `Sign in to ${hostOf(r.login)}`, primary: true, run: () => signInForPdf(r.id, r.login, c) }] : [];
    showResult(c, r.pdf ? true : "partial", resultHtml(r), actions);
  }));
  $("#ld-del").onclick = () => remove([p.id]);
}
function renderListKeepScroll() { const b = $("#lib-list"); const y = b.scrollTop; renderList(); b.scrollTop = y; }

async function remove(ids) {
  const p = L.byId.get(ids[0]);
  if (!(await ask({ title: "Remove from library?", text: `“${p?.title}” and its stored PDF are removed from Callio's library. Your drafts are not changed.`, buttons: [{ label: "Cancel", value: null }, { label: "Remove", value: "y", primary: true }] }))) return;
  await call("lib_delete", { ids });
  L.sel = null;
  await loadLibrary(); renderNav(); search();
}

export async function openPdf(p, page) {
  if (!p?.pdf) return toast("This paper has no PDF stored.", "", 2500);
  const path = await call("lib_pdf_path", { id: p.id });
  if (!path) return toast("The PDF file is missing.", "err");
  $("#dlg-library").close();
  await openPath(path);
  if (page) setTimeout(async () => (await import("./pdf.js")).goToPage(page), 400);
}

// ---------------- settings page ----------------
export const LATEX_STYLES = {
  "BibTeX / natbib (\\bibliographystyle)": ["plain", "unsrt", "alpha", "abbrv", "acm", "apalike", "ieeetr", "siam", "plainnat", "unsrtnat", "abbrvnat", "IEEEtran", "IEEEtranN", "apacite", "apa", "chicago", "agsm", "dcu", "kluwer", "ama", "vancouver", "naturemag", "Science", "apsrev4-2", "aipnum4-2", "elsarticle-num", "elsarticle-harv", "elsarticle-num-names", "splncs04", "spbasic", "spmpsci", "spphys", "sn-mathphys", "sn-basic", "ACM-Reference-Format", "aaai", "aaai-named", "named", "plainurl", "unsrturl", "mla", "harvard", "jss", "rss", "amsplain", "amsalpha"],
  "biblatex (style=…)": ["numeric", "numeric-comp", "numeric-verb", "alphabetic", "alphabetic-verb", "authoryear", "authoryear-comp", "authoryear-ibid", "authoryear-icomp", "authortitle", "authortitle-comp", "authortitle-ibid", "verbose", "verbose-ibid", "verbose-note", "reading", "draft", "apa", "ieee", "ieee-alphabetic", "chicago-authordate", "chicago-notes", "mla", "nature", "science", "phys", "chem-acs", "chem-angew", "chem-rsc", "chem-biochem", "musuos", "nejm", "vancouver", "lncs", "bwl-FU", "oxyear", "oxnum", "oxalph", "ext-authoryear", "ext-numeric", "ext-alphabetic", "archaeologie", "philosophy-modern", "philosophy-classic", "geschichtsfrkl", "historian", "windycity", "sbl", "dw"],
};
export const CITE_COMMANDS = ["\\cite", "\\citep", "\\citet", "\\parencite", "\\textcite", "\\autocite", "\\footcite", "\\citeauthor"];

export async function renderLibrarySettings() {
  const box = $("#lib-settings");
  const latexStyle = settings.citeLatexStyle || "plain";
  box.innerHTML = `
    <h3 class="set-h">Citations in LaTeX</h3>
    <label>Bibliography style (new documents, and “Apply” for the open one)
      <select id="ls-latex">${Object.entries(LATEX_STYLES).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((s) => `<option value="${g.startsWith("biblatex") ? "biblatex:" : ""}${s}">${s}</option>`).join("")}</optgroup>`).join("")}<option value="__other">Other…</option></select></label>
    <label>Citation command <select id="ls-cmd">${CITE_COMMANDS.map((c) => `<option>${esc(c)}</option>`).join("")}</select></label>
    <div class="row"><button type="button" id="ls-apply">Apply the style to the open document</button></div>
    <h3 class="set-h">Citations in Markdown</h3>
    <p class="note">Write <code>[@key]</code> (Alt+C inserts it). The preview and PDF export format citations and the reference list with a CSL style — every style in the official CSL repository (over 10,000).</p>
    <label>Style <input id="ls-csl-q" type="search" placeholder="Search styles (APA, IEEE, Nature, Chicago, a journal name…)"></label>
    <div id="ls-csl-list" class="csl-list"></div>
    <p class="note">Selected: <b id="ls-csl-cur"></b></p>
    <h3 class="set-h">Browser extension</h3>
    <p class="note">Save papers from Microsoft Edge (details + PDF, with your browser sign-in).</p>
    <div class="row"><button type="button" id="ls-ext">Set up the Edge extension…</button><button type="button" id="ls-open">Open the library</button></div>`;
  const sel = $("#ls-latex");
  sel.value = latexStyle;
  if (sel.selectedIndex < 0) { const o = document.createElement("option"); o.value = o.textContent = latexStyle; sel.prepend(o); sel.value = latexStyle; }
  sel.onchange = async () => {
    let v = sel.value;
    if (v === "__other") { v = (await ask({ title: "Bibliography style", text: "A .bst name (e.g. plainnat) or biblatex:style (e.g. biblatex:apa).", input: "" }))?.trim(); if (!v) { sel.value = latexStyle; return; } }
    updateSettings({ citeLatexStyle: v });
  };
  $("#ls-cmd").value = settings.citeCommand || "\\cite";
  $("#ls-cmd").onchange = (e) => updateSettings({ citeCommand: e.target.value });
  $("#ls-apply").onclick = async () => (await import("./cite.js")).applyLatexStyle(settings.citeLatexStyle || "plain");
  $("#ls-ext").onclick = setupExtension;
  $("#ls-open").onclick = () => { $("#dlg-settings").close(); openLibrary(); };
  // CSL picker (list loaded on demand)
  const cur = settings.citeCsl || "apa";
  const styles = (await import("./csl-styles.json")).default;
  const title = (id) => styles.find((s) => s[0] === id)?.[1] || id;
  $("#ls-csl-cur").textContent = title(cur);
  const draw = () => {
    const q = $("#ls-csl-q").value.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const list = (q ? styles.filter((s) => words.every((w) => s[1].toLowerCase().includes(w) || s[0].includes(w))) : styles.filter((s) => !s[3])).slice(0, 200);
    $("#ls-csl-list").innerHTML = list.map((s) => `<button type="button" class="csl-item${s[0] === (settings.citeCsl || "apa") ? " on" : ""}" data-id="${esc(s[0])}"><span>${esc(s[1])}</span><small>${esc(s[2] || "")}</small></button>`).join("") || `<div class="note pad">No style matches.</div>`;
    for (const b of $("#ls-csl-list").querySelectorAll(".csl-item")) b.onclick = () => { updateSettings({ citeCsl: b.dataset.id }); $("#ls-csl-cur").textContent = title(b.dataset.id); draw(); };
  };
  $("#ls-csl-q").oninput = draw;
  draw();
}

// ---------------- for the AI (chat tools and Claude Code) ----------------
const fmtAuthors = (a) => (a || []).slice(0, 4).map((x) => x.split(",")[0]).join(", ") + ((a || []).length > 4 ? " et al." : "");
export async function aiSearch({ query, limit }) {
  await loadLibrary();
  if (!L.papers.length) return "The author's library is empty.";
  const hits = await call("lib_search", { query: String(query || ""), collection: null, draft: null, limit: Math.min(30, limit || 10) });
  if (!hits.length) return `No paper in the library matches “${query}”.`;
  return hits.map((h) => {
    const p = L.byId.get(h.id);
    return `[${p.key}] ${p.title} — ${fmtAuthors(p.authors)}${p.year ? ` (${p.year})` : ""}${p.venue ? `, ${p.venue}` : ""}${p.doi ? `, doi:${p.doi}` : ""}${p.pdf ? "" : " [no PDF]"}${h.snippet ? `\n    ${h.page ? `p. ${h.page}: ` : ""}${h.snippet}` : ""}`;
  }).join("\n");
}
function byKey(k) {
  const key = String(k || "").trim().replace(/^@/, "");
  return L.papers.find((p) => p.key === key) || L.papers.find((p) => p.key.toLowerCase() === key.toLowerCase()) || L.byId.get(key);
}
export async function aiRead({ key, from_page, to_page }) {
  await loadLibrary();
  const p = byKey(key);
  if (!p) return `No paper with key “${key}” in the library.`;
  if (!p.text) return `“${p.title}” has ${p.pdf ? "a PDF whose text isn't indexed yet" : "no PDF"}.${p.abstract ? `\nAbstract: ${p.abstract}` : ""}`;
  const t = await call("lib_text", { id: p.id, from: from_page || null, to: to_page || null });
  return `${p.title} (${p.key})\n${t.length > 120000 ? t.slice(0, 120000) + "\n… (ask for a page range)" : t}`;
}
export async function aiBibtex({ keys }) {
  await loadLibrary();
  const ps = String(keys || "").split(/[,\s]+/).map(byKey).filter(Boolean);
  if (!ps.length) return "None of those keys are in the library.";
  return call("lib_bibtex", { ids: ps.map((p) => p.id) });
}
