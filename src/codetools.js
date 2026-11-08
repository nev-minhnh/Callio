// The code bar (Beautify, Minify, Validate, indentation, folding) and the status bar's
// Indentation, Line ending and Encoding menus, like Notepad++ and VS Code.
import { ENCODINGS, encodingName, resolveEncoding, EOL_NAMES } from "./textenc.js";
import { enter } from "./motion.js";

let ctx = null; // { activeTab, getView, toast, status, ask, replaceText(t, text, label), reopen(t, enc), markMeta(t), stepFocus }
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function initCodeTools(c) {
  ctx = c;
  const bar = $("#code-bar");
  bar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-code]");
    if (!b) return;
    const a = b.dataset.code;
    if (a === "beautify") beautifyActive();
    else if (a === "minify") minifyActive();
    else if (a === "validate") validateActive(true);
    else if (a === "fold") foldAll(true);
    else if (a === "unfold") foldAll(false);
    else if (a === "indent") indentMenu(b);
  });
  $("#st-indent").onclick = (e) => indentMenu(e.currentTarget);
  $("#st-eol").onclick = (e) => eolMenu(e.currentTarget);
  $("#st-enc").onclick = (e) => encMenu(e.currentTarget);
  $("#st-check").onclick = () => { const p = lastProblem; if (p) ctx.goto(p.from); else validateActive(true); };
  document.addEventListener("keydown", (e) => {
    // Shift+Alt+F: beautify (as in VS Code)
    if (e.shiftKey && e.altKey && (e.key === "F" || e.key === "f") && ctx.activeTab() && hasFormatter(ctx.activeTab())) { e.preventDefault(); beautifyActive(); }
  });
}

let S = null;
const loadS = async () => (S ??= await import("./structured.js"));
const nameOf = (t) => t.path || t.name;
const hasFormatter = (t) => !!t && ["json", "xml", "yaml", "text"].includes(t.kind) && !!fmtKindSync(nameOf(t));
function fmtKindSync(name) {
  const e = (name || "").toLowerCase().split(".").pop();
  return /^(json|jsonc|json5|geojson|webmanifest|har|jsonl|ndjson|code-workspace|topojson|jsonld|xml|svg|xsd|xsl|xslt|plist|csproj|vbproj|fsproj|vcxproj|props|targets|config|resx|xaml|axaml|kml|gpx|rss|atom|wsdl|pom|fxml|xlf|xliff|nuspec|tmx|graphml|drawio|storyboard|xib|opf|ncx|yaml|yml|html|htm|vue|svelte|css|scss|less|js|mjs|cjs|jsx|ts|tsx|mts|cts)$/.test(e) || /(^|[\\/])\.?(babelrc|eslintrc|prettierrc)$/i.test(name || "");
}

/** Show the code bar and the status bar items for tab `t`. */
export function updateCodeTools(t) {
  const text = !!t && ["json", "xml", "yaml", "text", "csv", "md", "tex", "bib"].includes(t.kind);
  const bar = $("#code-bar");
  const showBar = !!t && hasFormatter(t);
  if (bar.hidden === showBar) { bar.hidden = !showBar; if (showBar) enter(bar, "drop", { duration: 140 }); }
  if (showBar) {
    const k = fmtKindSync(nameOf(t)) ? (t.kind === "text" ? "code" : t.kind) : "";
    const canMin = t.kind === "json" || t.kind === "xml";
    bar.querySelector('[data-code="minify"]').hidden = !canMin;
    bar.querySelector('[data-code="validate"]').hidden = !(t.kind === "json" || t.kind === "xml" || t.kind === "yaml");
    bar.querySelector(".cb-kind").textContent = { json: "JSON", xml: "XML", yaml: "YAML", code: "" }[k] ?? "";
  }
  for (const id of ["#st-indent", "#st-eol", "#st-enc"]) $(id).hidden = !text;
  $("#st-check").hidden = !(t && (t.kind === "json" || t.kind === "xml" || t.kind === "yaml"));
  if (!text) return;
  const ind = t.indent ?? ctx.defaultIndent();
  $("#st-indent").textContent = ind === "tab" ? "Tabs" : `Spaces: ${ind}`;
  $("#st-eol").textContent = { "\r\n": "CRLF", "\n": "LF", "\r": "CR" }[t.eol || "\n"];
  $("#st-eol").title = `Line endings: ${EOL_NAMES[t.eol || "\n"]} — click to change`;
  $("#st-enc").textContent = encodingName(t.encoding || "utf8");
  $("#st-enc").title = "Encoding — click to reopen with another encoding or convert";
  bar.querySelector('[data-code="indent"]').textContent = ind === "tab" ? "Indent: Tabs ▾" : `Indent: ${ind} ▾`;
}

// ---------- problems (from the editor's checker) ----------
let lastProblem = null;
export function showProblems(list) {
  const t = ctx.activeTab();
  if (!t || !(t.kind === "json" || t.kind === "xml" || t.kind === "yaml")) return;
  const el = $("#st-check");
  const errs = list.filter((d) => d.severity === "error"), warns = list.filter((d) => d.severity !== "error");
  lastProblem = errs[0] || warns[0] || null;
  el.className = errs.length ? "bad" : warns.length ? "warn" : "ok";
  el.textContent = errs.length ? `⛔ ${errs[0].message.slice(0, 60)}` : warns.length ? `⚠ ${warns.length} warning${warns.length > 1 ? "s" : ""}` : `✓ Valid ${t.kind.toUpperCase()}`;
  el.title = lastProblem ? `${lastProblem.message} — click to go there` : `The ${t.kind.toUpperCase()} is well-formed`;
}

// ---------- beautify / minify / validate ----------
async function beautifyActive() {
  const t = ctx.activeTab();
  if (!t) return;
  const s = await loadS();
  const text = ctx.text(t);
  const indent = t.indent ?? ctx.defaultIndent();
  try {
    const out = await s.beautify(text, nameOf(t), { indent });
    if (out === text) return ctx.status("Already formatted", "ok");
    ctx.replaceText(t, out, "Beautify");
    ctx.status(`Formatted with ${indent === "tab" ? "tabs" : `${indent} spaces`}`, "ok");
  } catch (e) { problem(e, t, "Can't beautify"); }
}
async function minifyActive() {
  const t = ctx.activeTab();
  if (!t) return;
  const s = await loadS();
  try {
    const text = ctx.text(t);
    const out = s.minify(text, nameOf(t));
    ctx.replaceText(t, out, "Minify");
    ctx.status(`Minified: ${text.length.toLocaleString()} → ${out.length.toLocaleString()} characters`, "ok");
  } catch (e) { problem(e, t, "Can't minify"); }
}
async function validateActive(loud) {
  const t = ctx.activeTab();
  if (!t) return;
  const s = await loadS();
  const text = ctx.text(t);
  try {
    const w = (await s.validate(text, nameOf(t))) || [];
    const kind = (t.kind === "text" ? "file" : t.kind.toUpperCase());
    if (loud) ctx.toast(w.length ? `✓ Valid ${kind}, with ${w.length} warning${w.length > 1 ? "s" : ""}: ${w[0].message}` : `✓ Valid ${kind}`, "ok", 3500);
    if (w.length) ctx.goto(w[0].from);
  } catch (e) { problem(e, t, `Not valid ${t.kind.toUpperCase()}`); }
}
function problem(e, t, title) {
  if (e?.from == null) return ctx.toast(`${title}: ${e?.message || e}`, "err", 6000);
  const lc = S.lineCol(ctx.text(t), e.from);
  ctx.toast(`${title} — line ${lc.line}, column ${lc.col}: ${e.message}`, "err", 7000);
  ctx.goto(e.from, e.to);
}
async function foldAll(fold) {
  const { foldAll: fa, unfoldAll: ua } = await import("@codemirror/language");
  const v = ctx.getView();
  (fold ? fa : ua)(v);
  v.focus();
}

// ---------- menus ----------
function popMenu(anchor, items, { up = true } = {}) {
  document.querySelector(".pmenu.st")?.remove();
  const m = document.createElement("div");
  m.className = "pmenu st";
  const build = (list, el) => {
    for (const it of list) {
      if (!it) { el.appendChild(document.createElement("hr")); continue; }
      const b = document.createElement("button");
      b.innerHTML = `<span class="pm-dot">${it.checked ? "•" : ""}</span><span>${esc(it.label)}</span>${it.sub ? `<span class="pm-arrow">›</span>` : it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ""}`;
      b.disabled = !!it.disabled;
      if (it.sub) {
        b.classList.add("has-sub");
        const sub = document.createElement("div");
        sub.className = "pmenu sub";
        build(it.sub, sub);
        b.appendChild(sub);
        b.onmouseenter = () => {
          sub.style.display = "block";
          const r = b.getBoundingClientRect(), sr = sub.getBoundingClientRect();
          // keep going the way the parent opened (left when it had to), as long as it fits
          const parentLeft = el.dataset.dir === "left";
          const left = r.right + sr.width > innerWidth || (parentLeft && r.left - sr.width > 0);
          sub.dataset.dir = left ? "left" : "right";
          sub.style.left = (left ? -sr.width : r.width) + "px";
          sub.style.top = Math.min(0, innerHeight - r.top - sr.height - 8) + "px";
        };
        b.onmouseleave = () => { sub.style.display = ""; };
      } else b.onclick = (e) => { e.stopPropagation(); close(); it.run(); };
      el.appendChild(b);
    }
  };
  build(items, m);
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect(), mr = m.getBoundingClientRect();
  m.style.left = Math.max(6, Math.min(r.left, innerWidth - mr.width - 6)) + "px";
  m.style.top = (up ? Math.max(6, r.top - mr.height - 4) : r.bottom + 4) + "px";
  const close = () => { m.remove(); removeEventListener("pointerdown", out, true); removeEventListener("keydown", key, true); };
  const out = (e) => { if (!m.contains(e.target) && e.target !== anchor) close(); };
  const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  addEventListener("pointerdown", out, true);
  addEventListener("keydown", key, true);
}

function indentMenu(anchor) {
  const t = ctx.activeTab();
  if (!t) return;
  const cur = t.indent ?? ctx.defaultIndent();
  const use = (v) => () => { t.indent = v; ctx.applyIndent(t); updateCodeTools(t); };
  const conv = (v) => async () => {
    const s = await loadS();
    const text = ctx.text(t);
    const from = s.guessIndent(text) || cur;
    const out = s.reindent(text, from, v);
    t.indent = v; ctx.applyIndent(t);
    if (out !== text) ctx.replaceText(t, out, `Indentation → ${v === "tab" ? "tabs" : v + " spaces"}`);
    updateCodeTools(t);
  };
  popMenu(anchor, [
    { label: "Indent using 2 spaces", checked: cur === 2 || cur === "2", run: use(2) },
    { label: "Indent using 4 spaces", checked: cur === 4 || cur === "4", run: use(4) },
    { label: "Indent using tabs", checked: cur === "tab", run: use("tab") },
    null,
    { label: "Convert indentation to 2 spaces", run: conv(2) },
    { label: "Convert indentation to 4 spaces", run: conv(4) },
    { label: "Convert indentation to tabs", run: conv("tab") },
    null,
    { label: "Detect from the file", run: async () => { const s = await loadS(); const g = s.guessIndent(ctx.text(t)); t.indent = g ?? null; ctx.applyIndent(t); updateCodeTools(t); ctx.status(g ? `This file is indented with ${g === "tab" ? "tabs" : g + " spaces"}` : "No indentation found; using the setting", "ok"); } },
  ], { up: anchor.closest("#statusbar") != null });
}

function eolMenu(anchor) {
  const t = ctx.activeTab();
  if (!t) return;
  const cur = t.eol || "\n";
  popMenu(anchor, Object.entries(EOL_NAMES).map(([v, label]) => ({
    label, checked: v === cur, disabled: v === cur,
    run: () => { t.eol = v; ctx.markMeta(t, `Line endings → ${label}`); updateCodeTools(t); },
  })));
}

function encMenu(anchor) {
  const t = ctx.activeTab();
  if (!t) return;
  const cur = t.encoding || "utf8";
  const reopen = (enc) => () => ctx.reopen(t, resolveEncoding(enc));
  const convert = (enc, label) => () => { t.encoding = resolveEncoding(enc); ctx.markMeta(t, `Encoding → ${label}`); updateCodeTools(t); };
  const isCur = (k) => resolveEncoding(k) === cur || (k === "utf8" && cur === "utf8");
  popMenu(anchor, [
    ...ENCODINGS.main.map(([k, n]) => ({ label: n, checked: isCur(k), run: reopen(k) })),
    { label: "Character sets", sub: ENCODINGS.sets.map(([group, list]) => ({ label: group, sub: list.map(([k, n]) => ({ label: n, checked: k === cur, run: reopen(k) })) })) },
    null,
    ...ENCODINGS.main.map(([k, n]) => ({ label: `Convert to ${n}`, run: convert(k, n) })),
  ]);
}
