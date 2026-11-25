// The vault's user interface: the "Vault" panel in the left sidebar (backlinks, outgoing links,
// tags, a small local graph), the quick switcher (Ctrl+O), today's daily note, templates, the
// vault chip, and the rename flow that keeps links working (with a list of what changes, and Undo).
import { call, api } from "./api.js";
import { t } from "./i18n.js";
import { V, vx, relOf, absOf, norm, stemOf, dirOfRel, onVaultChange, emitVaultChange } from "./vault-state.js";
import { activeTab, openPath, toast, basename, dirname, reloadFromDisk, saveAll, getTabs, movePathTo } from "./main.js";
import { getView, replaceDocAsStep } from "./editor.js";

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

let panel = null, tabBtn = null, chip = null;
let curRel = "";
let tagOpen = new Set();
let secOpen = { backlinks: true, outgoing: true, tags: true, graph: false };

export function initVaultUI() {
  if (panel) return;
  // sidebar tab + panel
  const tabs = $(".side-tabs");
  tabBtn = el("button", null, t("Vault")); tabBtn.dataset.side = "vault"; tabBtn.hidden = true; tabBtn.id = "side-tab-vault";
  tabs.append(tabBtn);
  panel = el("div", "side-body"); panel.id = "side-vault"; panel.hidden = true;
  $("#side-overleaf").after(panel);
  tabBtn.onclick = () => (window.__showSide ? window.__showSide("vault") : null);
  buildPanel();
  // the chip next to the folder name
  chip = el("span", "vault-chip"); chip.id = "vault-chip"; chip.hidden = true;
  chip.innerHTML = `<span class="vc-l">${t("Obsidian vault")}</span><span class="vc-sep"> · </span><b class="vc-n"></b>`;
  chip.title = t("Obsidian vault");
  chip.onclick = () => window.__showSide?.("vault");
  $("#side-files .side-head").insertBefore(chip, $("#side-files .side-head").children[1] || null);
  window.addEventListener("callio-active", () => { if (V.on) refreshPanel(); });
  window.addEventListener("callio-vault-panel", () => refreshPanel());
  window.addEventListener("callio-vault-tag", (e) => { window.__showSide?.("vault"); openTag(e.detail); });
  onVaultChange(() => { if (V.on) refreshPanel(); });
  document.addEventListener("keydown", (e) => {
    if (!V.on) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "o") { e.preventDefault(); e.stopImmediatePropagation(); openSwitcher(); }
  }, true);
}

export function vaultChanged(what) {
  if (!panel) return;
  const on = what === "on" && V.on;
  tabBtn.hidden = !on; chip.hidden = !on;
  if (on) { $(".vc-n", chip).textContent = V.name; refreshPanel(); }
  else if (!panel.hidden) window.__showSide?.("files");
}

// ---------------- the panel ----------------
function buildPanel() {
  panel.innerHTML = `
    <div class="vp-actions">
      <button type="button" data-a="daily" class="vp-act primary">${t("Daily note")}</button>
      <button type="button" data-a="switch" class="vp-act">${t("Open note…")}</button>
      <button type="button" data-a="template" class="vp-act">${t("Insert template…")}</button>
    </div>
    <section class="vsec" data-sec="backlinks"><h4><span class="caret"></span>${t("Backlinks")}<span class="cnt"></span></h4><div class="vsec-body"></div></section>
    <section class="vsec" data-sec="outgoing"><h4><span class="caret"></span>${t("Outgoing links")}<span class="cnt"></span></h4><div class="vsec-body"></div></section>
    <section class="vsec" data-sec="tags"><h4><span class="caret"></span>${t("Tags")}<span class="cnt"></span></h4><div class="vsec-body"></div></section>
    <section class="vsec" data-sec="graph"><h4><span class="caret"></span>${t("Local graph")}<span class="cnt"></span></h4><div class="vsec-body"></div></section>`;
  panel.onclick = (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "daily") return openDaily();
    if (a === "switch") return openSwitcher();
    if (a === "template") return openSwitcher("template");
    const h = e.target.closest(".vsec > h4");
    if (h) { const s = h.parentElement.dataset.sec; secOpen[s] = !secOpen[s]; syncSections(); if (secOpen[s]) refreshPanel(); }
  };
  syncSections();
}
function syncSections() {
  for (const s of panel.querySelectorAll(".vsec")) { s.classList.toggle("closed", !secOpen[s.dataset.sec]); }
}
const body = (s) => $(`.vsec[data-sec="${s}"] .vsec-body`, panel);
const count = (s, n) => { $(`.vsec[data-sec="${s}"] .cnt`, panel).textContent = n == null ? "" : String(n); };

let refreshSeq = 0;
export async function refreshPanel() {
  if (!V.on || !panel) return;
  const seq = ++refreshSeq;
  const tab = activeTab();
  const rel = tab?.path ? relOf(tab.path) : null;
  curRel = rel && /\.md$/i.test(rel) ? rel : "";
  const tasks = [];
  if (secOpen.backlinks) tasks.push(drawBacklinks(seq));
  if (secOpen.outgoing) tasks.push(drawOutgoing(seq));
  if (secOpen.tags) tasks.push(drawTags());
  if (secOpen.graph) tasks.push(drawGraph(seq));
  await Promise.all(tasks);
}

function noteLine(rel, ln, text, mention) {
  const r = el("div", "vline");
  r.append(el("span", "vl-n", String(ln)), el("span", "vl-t", text));
  r.onclick = async (e) => { e.stopPropagation(); await openPath(absOf(rel), ln, true); };
  if (mention) {
    const b = el("button", "vl-link", t("Link")); b.type = "button";
    b.onclick = async (e) => { e.stopPropagation(); await linkMention(rel, ln, mention); refreshPanel(); };
    r.append(b);
  }
  return r;
}
function group(n, lines, mention) {
  const g = el("div", "vgroup");
  const h = el("div", "vg-h"); h.append(el("span", "vg-n", n.name), el("span", "vg-c", String(lines.length)));
  h.title = n.rel;
  h.onclick = () => openPath(absOf(n.rel), lines[0]?.line, true);
  g.append(h);
  for (const l of lines) g.append(noteLine(n.rel, l.line, l.text, mention));
  return g;
}

async function drawBacklinks(seq) {
  const host = body("backlinks");
  if (!curRel) { host.replaceChildren(el("div", "vempty", t("Open a note to see its links."))); count("backlinks", null); return; }
  let r;
  try { r = await vx("vault_backlinks", { rel: curRel, unlinked: true }); } catch (e) { host.textContent = String(e.message || e); return; }
  if (seq !== refreshSeq) return;
  host.replaceChildren();
  const a = el("div", "vsub", t("Linked mentions"));
  a.append(el("span", "cnt", String(r.linked.length)));
  host.append(a);
  if (!r.linked.length) host.append(el("div", "vempty", t("No notes link here yet.")));
  for (const n of r.linked) host.append(group(n, n.lines));
  const u = el("div", "vsub", t("Unlinked mentions"));
  u.append(el("span", "cnt", String(r.unlinked.length)));
  host.append(u);
  if (!r.unlinked.length) host.append(el("div", "vempty", t("No unlinked mentions.")));
  for (const n of r.unlinked) host.append(group(n, n.lines, { name: stemOf(curRel), rel: curRel }));
  count("backlinks", r.linked.length);
}

/** Turn the first plain mention on a line into [[link]]. */
async function linkMention(srcRel, ln, target) {
  const abs = absOf(srcRel);
  const open = getTabs().find((x) => x.path && norm(x.path) === norm(abs));
  const names = [target.name, ...(V.notes.find((n) => n.rel === target.rel)?.aliases || [])].sort((a, b) => b.length - a.length);
  const edit = (text) => {
    const lines = text.split("\n");
    const line = lines[ln - 1] ?? "";
    for (const nm of names) {
      const re = new RegExp("(^|[^\\p{L}\\p{N}\\[|])(" + nm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")(?![\\p{L}\\p{N}\\]])", "iu");
      const m = re.exec(line);
      if (!m) continue;
      const link = m[2] === stemOf(target.rel) ? `[[${m[2]}]]` : `[[${stemOf(target.rel)}|${m[2]}]]`;
      lines[ln - 1] = line.slice(0, m.index + m[1].length) + link + line.slice(m.index + m[1].length + m[2].length);
      return lines.join("\n");
    }
    return null;
  };
  try {
    if (open && open.id === (activeTab()?.id)) {
      const v = getView(); const next = edit(v.state.doc.toString());
      if (next) { const spec = replaceDocAsStep(v.state, next, "Link a mention"); if (spec) v.dispatch(spec); }
      return;
    }
    const cur = (await api.readText(abs)).text;
    const next = edit(cur);
    if (!next) return;
    await api.historyRecordDisk([abs], "Before linking a mention", "save").catch(() => {});
    await api.writeText(abs, next, null, 0);
    await reloadFromDisk([abs], false);
    await vx("vault_touch", { rel: srcRel, text: next });
  } catch (e) { toast(e.message || String(e), "err"); }
}

async function drawOutgoing(seq) {
  const host = body("outgoing");
  if (!curRel) { host.replaceChildren(el("div", "vempty", t("Open a note to see its links."))); count("outgoing", null); return; }
  let r;
  try { r = await vx("vault_outgoing", { rel: curRel }); } catch (e) { host.textContent = String(e.message || e); return; }
  if (seq !== refreshSeq) return;
  host.replaceChildren();
  const seen = new Set();
  const rows = r.filter((l) => { const k = (l.rel || l.target) + "#" + l.sub + (l.embed ? "!" : ""); if (seen.has(k) || (!l.target && !l.sub)) return false; seen.add(k); return true; });
  if (!rows.length) host.append(el("div", "vempty", t("This note has no links.")));
  for (const l of rows) {
    const row = el("div", "vout" + (l.rel ? "" : " missing"));
    row.append(el("span", "vo-n", l.rel ? stemOf(l.rel) + (l.sub ? " > " + l.sub : "") : l.target || l.sub));
    if (!l.rel) row.append(el("span", "vo-m", t("missing")));
    else if (l.embed) row.append(el("span", "vo-m", "↳"));
    row.title = l.rel || t("Unresolved link");
    row.onclick = async () => { const m = await import("./vault.js"); m.openLink({ target: l.target, sub: l.sub, md: l.md }, curRel); };
    host.append(row);
  }
  count("outgoing", rows.length);
}

// ---- tags ----
function tagTree() {
  const root = { kids: new Map(), n: 0, path: "" };
  for (const { tag, count: c } of V.tags) {
    const parts = tag.split("/");
    let node = root;
    parts.forEach((p, i) => {
      if (!node.kids.has(p)) node.kids.set(p, { kids: new Map(), n: 0, path: parts.slice(0, i + 1).join("/") });
      node = node.kids.get(p);
      if (i === parts.length - 1) node.n = c;
    });
  }
  return root;
}
async function drawTags() {
  const host = body("tags");
  host.replaceChildren();
  if (!V.tags.length) { host.append(el("div", "vempty", t("No tags in this vault yet."))); count("tags", null); return; }
  const walk = (node, depth, into) => {
    for (const [name, k] of [...node.kids].sort((a, b) => a[0].localeCompare(b[0]))) {
      const row = el("div", "vtag-row"); row.style.paddingLeft = 4 + depth * 12 + "px"; row.dataset.tag = k.path;
      const open = tagOpen.has(k.path);
      row.append(el("span", "vt-c", k.kids.size ? (open ? "▾" : "▸") : ""), el("span", "vt-n", "#" + name), el("span", "vt-k", String(k.n)));
      row.onclick = () => { if (tagOpen.has(k.path)) tagOpen.delete(k.path); else tagOpen.add(k.path); drawTags(); };
      into.append(row);
      if (open) {
        walk(k, depth + 1, into);
        const res = el("div", "vtag-res"); res.style.paddingLeft = 16 + depth * 12 + "px"; res.dataset.for = k.path;
        into.append(res);
        vx("vault_tag_notes", { tag: k.path }).then((ns) => { for (const n of ns) { const r = el("div", "vtag-note", n.name); r.title = n.rel; r.onclick = (e) => { e.stopPropagation(); openPath(absOf(n.rel), undefined, true); }; res.append(r); } });
      }
    }
  };
  walk(tagTree(), 0, host);
  count("tags", V.tags.length);
}
function openTag(tag) {
  const parts = String(tag).split("/");
  for (let i = 1; i <= parts.length; i++) tagOpen.add(parts.slice(0, i).join("/"));
  secOpen.tags = true; syncSections(); drawTags();
}

// ---- local graph ----
async function drawGraph(seq) {
  const host = body("graph");
  host.replaceChildren();
  if (!curRel) { host.append(el("div", "vempty", t("Open a note to see its links."))); return; }
  let g;
  try { g = await vx("vault_graph", { rel: curRel, depth: 2 }); } catch { return; }
  if (seq !== refreshSeq) return;
  const cv = el("canvas", "vgraph"); cv.width = 520; cv.height = 360; cv.setAttribute("aria-label", t("Local graph"));
  host.append(cv);
  const ctx = cv.getContext("2d");
  const cs = getComputedStyle(document.documentElement);
  const col = (n, d) => cs.getPropertyValue(n).trim() || d;
  // distance rings: the note in the middle, its neighbours around it, then theirs
  const dist = new Map([[curRel, 0]]);
  const adj = new Map(g.nodes.map((n) => [n.rel, []]));
  for (const [a, b] of g.edges) { adj.get(a)?.push(b); adj.get(b)?.push(a); }
  const q = [curRel];
  while (q.length) { const n = q.shift(); for (const m of adj.get(n) || []) if (!dist.has(m)) { dist.set(m, dist.get(n) + 1); q.push(m); } }
  const ring = [[], [], []];
  for (const n of g.nodes) ring[Math.min(2, dist.get(n.rel) ?? 2)].push(n);
  const pos = new Map();
  const cx = 260, cy = 180;
  ring.forEach((list, d) => list.forEach((n, i) => {
    if (d === 0) return pos.set(n.rel, [cx, cy]);
    const r = d === 1 ? 95 : 160, a = (i / list.length) * Math.PI * 2 + (d === 2 ? 0.3 : 0);
    pos.set(n.rel, [cx + Math.cos(a) * r * 1.35, cy + Math.sin(a) * r * 0.95]);
  }));
  const hits = [];
  ctx.clearRect(0, 0, 520, 360);
  ctx.strokeStyle = col("--border", "#8884"); ctx.lineWidth = 1;
  for (const [a, b] of g.edges) { const p = pos.get(a), q2 = pos.get(b); if (!p || !q2) continue; ctx.beginPath(); ctx.moveTo(...p); ctx.lineTo(...q2); ctx.stroke(); }
  ctx.font = "12px system-ui, sans-serif"; ctx.textAlign = "center";
  for (const n of g.nodes) {
    const [x, y] = pos.get(n.rel); const me = n.rel === curRel;
    ctx.fillStyle = me ? col("--accent", "#4c8dff") : col("--fg-3", "#889");
    ctx.beginPath(); ctx.arc(x, y, me ? 7 : 5, 0, 7); ctx.fill();
    ctx.fillStyle = col("--fg", "#222"); ctx.fillText(n.name.length > 22 ? n.name.slice(0, 21) + "…" : n.name, x, y + (me ? 20 : 17));
    hits.push({ x, y, rel: n.rel });
  }
  const at = (e) => { const r = cv.getBoundingClientRect(); const x = (e.clientX - r.left) * 520 / r.width, y = (e.clientY - r.top) * 360 / r.height; return hits.find((h) => Math.hypot(h.x - x, h.y - y) < 12); };
  cv.onmousemove = (e) => { cv.style.cursor = at(e) ? "pointer" : "default"; };
  cv.onclick = (e) => { const h = at(e); if (h && h.rel !== curRel) openPath(absOf(h.rel), undefined, true); };
  count("graph", g.nodes.length);
}

// ---------------- dates (a subset of the moment.js tokens Obsidian uses) ----------------
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const p2 = (n) => String(n).padStart(2, "0");
export function formatDate(d, fmt) {
  const ord = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
  const week = (() => { const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() + 4 - day); return Math.ceil(((x - Date.UTC(x.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7); })();
  const map = {
    YYYY: d.getFullYear(), YY: String(d.getFullYear()).slice(2), MMMM: MONTHS[d.getMonth()], MMM: MONTHS[d.getMonth()].slice(0, 3), MM: p2(d.getMonth() + 1), M: d.getMonth() + 1,
    DD: p2(d.getDate()), Do: ord(d.getDate()), D: d.getDate(), dddd: DAYS[d.getDay()], ddd: DAYS[d.getDay()].slice(0, 3), dd: DAYS[d.getDay()].slice(0, 2), d: d.getDay(),
    HH: p2(d.getHours()), H: d.getHours(), hh: p2(d.getHours() % 12 || 12), h: d.getHours() % 12 || 12, mm: p2(d.getMinutes()), m: d.getMinutes(), ss: p2(d.getSeconds()), s: d.getSeconds(),
    A: d.getHours() < 12 ? "AM" : "PM", a: d.getHours() < 12 ? "am" : "pm", WW: p2(week), W: week, Q: Math.floor(d.getMonth() / 3) + 1,
  };
  return String(fmt).replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|Do|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|A|a|WW|W|Q/g, (m, lit) => (lit !== undefined ? lit : String(map[m])));
}

/** Fill {{title}}, {{date}}, {{time}}, {{date:FORMAT}}, {{time:FORMAT}} in a template. */
export function applyTemplate(text, { title, date = new Date() }) {
  const tp = V.config.templates || {};
  return text.replace(/\{\{\s*(title|date|time)\s*(?::\s*([^}]+?))?\s*\}\}/g, (m, k, f) => {
    if (k === "title") return title;
    if (k === "date") return formatDate(date, f || tp.dateFormat || "YYYY-MM-DD");
    return formatDate(date, f || tp.timeFormat || "HH:mm");
  });
}

// ---------------- daily note and templates ----------------
export async function openDaily(date = new Date()) {
  const m = await import("./vault.js");
  const d = V.config.daily || {};
  const name = formatDate(date, d.format || "YYYY-MM-DD");
  const folder = String(d.folder || "").replace(/^\/+|\/+$/g, "");
  const rel = (folder ? folder + "/" : "") + name + ".md";
  const existing = V.notes.find((n) => n.rel.toLowerCase() === rel.toLowerCase());
  if (existing) return m.openRel(existing.rel);
  let text = "";
  const tpl = String(d.template || "").replace(/^\/+/, "");
  if (tpl) {
    try { text = (await api.readText(absOf(/\.md$/i.test(tpl) ? tpl : tpl + ".md"))).text; } catch { text = ""; }
  }
  const made = await m.createNote(rel, applyTemplate(text, { title: name, date }));
  await m.openRel(made);
}

async function insertTemplate(rel) {
  const v = getView();
  const tab = activeTab();
  if (!tab || tab.kind !== "md") return toast(t("Open a note first"), "warn");
  const text = (await api.readText(absOf(rel))).text;
  const title = tab.name.replace(/\.md$/i, "");
  v.dispatch(v.state.replaceSelection(applyTemplate(text, { title })), { userEvent: "input.paste", scrollIntoView: true });
  v.focus();
}

// ---------------- the quick switcher ----------------
let sw = null;
export async function openSwitcher(mode = "notes") {
  if (!V.on) return;
  sw?.close();
  const { fuzzy } = await import("./vault-cm.js");
  const dlg = el("div", "vsw-back");
  const box = el("div", "vsw"); box.setAttribute("role", "dialog");
  const inp = el("input", "vsw-in"); inp.placeholder = mode === "template" ? t("Search templates…") : t("Search notes…"); inp.setAttribute("aria-label", inp.placeholder);
  const list = el("div", "vsw-list"); list.setAttribute("role", "listbox");
  box.append(inp, list); dlg.append(box); document.body.append(dlg);
  let items = [], sel = 0;
  const tfolder = String(V.config.templates?.folder || "").replace(/^\/+|\/+$/g, "").toLowerCase();
  const pool = () => mode === "template" ? V.notes.filter((n) => tfolder && n.rel.toLowerCase().startsWith(tfolder + "/")) : V.notes;
  const draw = () => {
    const q = inp.value.trim();
    const hits = [];
    for (const n of pool()) {
      const s1 = fuzzy(q, n.name), s2 = fuzzy(q, n.rel) * 0.5;
      if (s1 || s2) hits.push({ n, sc: Math.max(s1, s2) });
      if (q && mode !== "template") for (const a of n.aliases) { const s3 = fuzzy(q, a); if (s3) hits.push({ n, alias: a, sc: s3 * 0.9 }); }
    }
    hits.sort((a, b) => b.sc - a.sc || a.n.name.localeCompare(b.n.name));
    items = hits.slice(0, 40).map((h) => ({ rel: h.n.rel, name: h.alias || h.n.name, sub: h.alias ? "→ " + h.n.name : h.n.rel.includes("/") ? dirOfRel(h.n.rel) : "" }));
    if (q && mode !== "template" && !hits.some((h) => h.n.name.toLowerCase() === q.toLowerCase())) items.push({ create: q, name: t("Create “{n}”").replace("{n}", q), sub: "" });
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.replaceChildren();
    if (!items.length) list.append(el("div", "vsw-none", mode === "template" ? t("No templates found") : t("No matching notes")));
    items.forEach((it, i) => {
      const r = el("div", "vsw-item" + (i === sel ? " sel" : "")); r.setAttribute("role", "option");
      r.append(el("span", "vsw-n", it.name), el("span", "vsw-s", it.sub));
      r.onmousemove = () => { sel = i; mark(); };
      r.onclick = () => go(it);
      list.append(r);
    });
  };
  const mark = () => { [...list.children].forEach((c, i) => c.classList.toggle("sel", i === sel)); list.children[sel]?.scrollIntoView({ block: "nearest" }); };
  const close = () => { dlg.remove(); sw = null; };
  const go = async (it) => {
    close();
    if (!it) return;
    if (mode === "template") return insertTemplate(it.rel);
    const m = await import("./vault.js");
    if (it.create) return m.openLink({ target: it.create }, curRel);
    m.openRel(it.rel);
  };
  inp.oninput = () => { sel = 0; draw(); };
  inp.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); mark(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
    else if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); go(items[sel]); }
  };
  dlg.onmousedown = (e) => { if (e.target === dlg) close(); };
  sw = { close };
  draw(); inp.focus();
}

// ---------------- rename and move: keep links working ----------------
const keep = { last: null }; // the last link update, for Undo

/**
 * Called by the file tree before a rename or move: `pairs` is [[fromPath, toPath]]. Shows what
 * would change, and returns {ok, done}: `done()` rewrites the links once the files have moved.
 */
export async function guardMoves(pairs) {
  const none = { ok: true, done: async () => {} };
  if (!V.on) return none;
  const moves = pairs.map(([a, b]) => [relOf(a), relOf(b)]).filter(([a, b]) => a && b && a !== b);
  if (!moves.length) return none;
  let plans = [];
  try {
    for (const [from, to] of moves) {
      const p = await vx("vault_rename_plan", { from, to });
      if (p.count) plans.push({ from, to, ...p });
    }
  } catch (e) { console.warn(e); return none; }
  if (!plans.length) return none;
  const links = plans.reduce((n, p) => n + p.count, 0);
  const files = new Set(plans.flatMap((p) => p.files.map((f) => f.rel))).size;
  const isMove = moves.some(([a, b]) => dirOfRel(a) !== dirOfRel(b)) && moves.every(([a, b]) => stemOf(a) === stemOf(b));
  const always = !!V.config.alwaysUpdateLinks;
  const choice = await linkDialog(plans, links, files, isMove, always);
  if (!choice) return { ok: false, done: async () => {} };
  if (choice === "skip") return none;
  return {
    ok: true,
    done: async () => {
      // unsaved edits in the notes about to change are saved first
      const paths = new Set(plans.flatMap((p) => p.files.map((f) => norm(absOf(f.rel)).toLowerCase())));
      await saveAll((tab) => tab.path && paths.has(norm(tab.path).toLowerCase()));
      const ops = [];
      const changed = [];
      try {
        for (const p of plans) {
          const r = await call("vault_rename_apply", { args: { root: V.root, from: p.from, to: p.to, files: p.files } });
          ops.push({ opId: r.opId, from: p.from, to: p.to }); changed.push(...r.changed);
        }
      } catch (e) {
        toast(t("Couldn't update the links: {e}").replace("{e}", String(e.message || e).replace(/^CHANGED: /, "")), "err", 9000);
        return;
      }
      keep.last = { ops, moves };
      await reloadFromDisk(changed.map(absOf), true, "Links updated");
      emitVaultChange("links");
      undoToast(links, files);
    },
  };
}

function linkDialog(plans, links, files, isMove, always) {
  return new Promise((resolve) => {
    const back = el("div", "vsw-back");
    const box = el("div", "vlk"); box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
    box.append(el("h3", null, t("Update links?")));
    box.append(el("p", null, t("{n} links in {m} notes point to what you are renaming. Update them so they keep working?").replace("{n}", links).replace("{m}", files)));
    const list = el("div", "vlk-list");
    for (const p of plans) for (const f of p.files) {
      const g = el("div", "vlk-file"); g.append(el("div", "vlk-name", f.rel));
      for (const e of f.edits.slice(0, 4)) {
        const l = el("div", "vlk-edit");
        l.append(el("span", "vlk-ln", String(e.line)), el("del", null, e.old), el("ins", null, e.new));
        g.append(l);
      }
      if (f.edits.length > 4) g.append(el("div", "vlk-more", `+ ${f.edits.length - 4}`));
      list.append(g);
    }
    box.append(list);
    const foot = el("div", "vlk-foot");
    const cancel = el("button", null, t("Cancel")); const skip = el("button", null, t(isMove ? "Move only" : "Rename only"));
    const upd = el("button", "primary", t(isMove ? "Move and update links" : "Rename and update links"));
    for (const b of [cancel, skip, upd]) b.type = "button";
    const end = (v) => { back.remove(); resolve(v); };
    cancel.onclick = () => end(null); skip.onclick = () => end("skip"); upd.onclick = () => end("update");
    foot.append(cancel, skip, upd); box.append(foot); back.append(box); document.body.append(back);
    back.onkeydown = (e) => { if (e.key === "Escape") { e.stopPropagation(); end(null); } };
    (always ? upd : skip).focus();
  });
}

function undoToast(links, files) {
  const box = $("#toasts");
  const el0 = el("div", "toast ok vault-undo");
  el0.append(el("span", "toast-msg", t("Updated {n} links in {m} notes").replace("{n}", links).replace("{m}", files)));
  const b = el("button", "toast-act", t("Undo")); b.type = "button";
  b.onclick = async () => { el0.remove(); await undoLinks(); };
  el0.append(b);
  box.append(el0);
  setTimeout(() => el0.remove(), 15000);
}

/** Undo the last link update: the notes get their old text back (unless edited since) and the files move back. */
export async function undoLinks() {
  const k = keep.last;
  if (!k) return;
  keep.last = null;
  const skipped = [], restored = [];
  for (const o of [...k.ops].reverse()) {
    try {
      const r = await call("vault_undo", { args: { root: V.root, opId: o.opId } });
      skipped.push(...r.skipped); restored.push(...r.restored);
    } catch (e) { toast(String(e.message || e), "err"); }
  }
  for (const [from, to] of [...k.moves].reverse()) { try { await movePathTo(absOf(to), absOf(from)); } catch (e) { toast(String(e.message || e), "err"); } }
  await reloadFromDisk(restored.map(absOf), true, "Links restored");
  await vx("vault_sync");
  const m = await import("./vault.js"); await m.loadNotes(); emitVaultChange("links");
  toast(t("Links restored"), "ok", 2600);
  if (skipped.length) toast(t("Some notes changed since and were left alone: {l}").replace("{l}", skipped.join(", ")), "warn", 8000);
}
export { basename, dirname };
