// PDF tools (the office engine, PdfCraft): organize pages with thumbnails, merge, split, extract,
// rotate, insert, N-up, crop, page numbers, header & footer, watermark, flatten, metadata,
// attachments, protect / unlock, redact (by area or by search), compress, repair, and conversions.
// Every tool writes a new file — the original is never changed — and opens the result.
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api, call } from "./api.js";
import { toast, status, ask, basename, dirname, openPath, folder } from "./main.js";
import { office } from "./office.js";
import { sortable } from "./sortable.js";
import { flip, enter } from "./motion.js";
import { ic } from "./icons.js";

pdfjsLib.GlobalWorkerOptions.workerSrc ||= workerUrl;

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const stem = (p) => basename(p).replace(/\.[^.]+$/, "");
const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const ICONS = {
  organize: `<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="9" rx="1"/><rect x="3" y="15" width="7" height="6" rx="1"/><path d="M14 18h7m-3-3 3 3-3 3"/>`,
  merge: `<path d="M8 6H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3M16 6h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-3M12 8v8m-4-4h8"/>`,
  split: `<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>`,
  select: `<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/><path d="M9 14l2 2 4-4"/>`,
  delete: `<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/>`,
  rotate: `<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>`,
  insert: `<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M12 11v6m-3-3h6"/>`,
  nup: `<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>`,
  crop: `<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>`,
  pageNumbers: `<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>`,
  headerFooter: `<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 17h8"/>`,
  watermark: `<path d="M12 22a7 7 0 0 0 7-7c0-4-7-13-7-13S5 11 5 15a7 7 0 0 0 7 7z"/>`,
  removeMarks: `<path d="M20 20H9L4 15a2 2 0 0 1 0-3l9-9a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-8 9"/><path d="m8 11 6 6"/>`,
  flatten: `<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>`,
  metadata: `<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>`,
  attach: `<path d="m21 11-8.6 8.6a5 5 0 0 1-7-7l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4L15.4 8"/>`,
  protect: `<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`,
  unlock: `<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.8-1.2"/>`,
  redact: `<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="6" y="9" width="8" height="2.5" fill="currentColor"/><path d="M6 15h12"/>`,
  compress: `<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>`,
  repair: `<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>`,
  images: `<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>`,
  toImages: `<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>`,
  toMd: `<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 15V9l3 3 3-3v6M16 9v6m-2-2 2 2 2-2"/>`,
  toWord: `<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="m8 11 1.5 6L12 12l2.5 5L16 11"/>`,
  fromOffice: `<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>`,
  compare: `<path d="M16 3h5v5M8 21H3v-5M21 3l-7 7M3 21l7-7"/>`,
  info: `<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>`,
};
const icon = (id) => `<svg class="pt-svg" viewBox="0 0 24 24">${ICONS[id] || ""}</svg>`;

// ---------------- the tools ----------------
// fields: k, label, type (text | number | select | check | color | pages | files | file), def, opts, ph
const PAGES = { k: "pages", label: "Pages", type: "pages", def: "all", ph: "all — or 1-3, 7, odd, even, last" };
const TOOLS = [
  { cat: "Organize", id: "organize", icon: "organize", label: "Organize pages", desc: "Drag pages to reorder; rotate, duplicate or delete them; save as a new PDF.", custom: "organizer" },
  { cat: "Organize", id: "merge", icon: "merge", label: "Merge", desc: "Join several PDFs into one, in the order listed. Bookmarks are kept under each file's name.", noInput: true,
    fields: [{ k: "inputs", label: "Files (in order)", type: "files", exts: ["pdf"] }], suffix: "merged" },
  { cat: "Organize", id: "split", icon: "split", label: "Split", desc: "Cut the PDF into parts, saved into a folder.",
    fields: [{ k: "mode", label: "Split", type: "select", def: "every", opts: [["every", "Every N pages"], ["before", "Before these pages"]] },
      { k: "n", label: "N pages per part", type: "number", def: 1, show: (v) => v.mode === "every" },
      { k: "at", label: "Start a new part at pages", type: "text", ph: "e.g. 5, 12", show: (v) => v.mode === "before" }], folderOut: true },
  { cat: "Organize", id: "select", icon: "select", label: "Extract pages", desc: "A new PDF of just these pages, in this order (repeats allowed — e.g. 3,1,2 or 1,1,2).",
    fields: [{ ...PAGES, def: "" }], suffix: "pages" },
  { cat: "Organize", id: "delete", icon: "delete", label: "Delete pages", desc: "Remove these pages.", fields: [{ ...PAGES, def: "" }], suffix: "edited" },
  { cat: "Organize", id: "rotate", icon: "rotate", label: "Rotate", desc: "Turn pages clockwise.",
    fields: [PAGES, { k: "degrees", label: "Turn by", type: "select", def: "90", opts: [["90", "90° clockwise"], ["180", "180°"], ["270", "90° counter-clockwise"]], num: true }], suffix: "rotated" },
  { cat: "Organize", id: "insert", icon: "insert", label: "Insert pages", desc: "Insert another PDF's pages or blank pages.",
    fields: [{ k: "what", label: "Insert", type: "select", def: "file", opts: [["file", "Pages of another PDF"], ["blank", "Blank pages"]] },
      { k: "file", label: "PDF", type: "file", exts: ["pdf"], show: (v) => v.what === "file" },
      { k: "filePages", label: "Its pages", type: "text", def: "all", show: (v) => v.what === "file" },
      { k: "blank", label: "How many", type: "number", def: 1, show: (v) => v.what === "blank" },
      { k: "at", label: "Before page (0 = at the end)", type: "number", def: 0 }], suffix: "edited",
    args: (v) => { const a = { ...v }; if (v.what === "blank") delete a.file; delete a.what; return a; } },
  { cat: "Organize", id: "nup", icon: "nup", label: "Pages per sheet (N-up)", desc: "Put several pages on each sheet — handouts, booklet proofs.",
    fields: [{ k: "per", label: "Pages per sheet", type: "select", def: "2", opts: [["2", "2"], ["4", "4"], ["6", "6"], ["8", "8"], ["9", "9"], ["16", "16"]], num: true }, { k: "border", label: "Draw a frame around each page", type: "check", def: false }], suffix: "n-up" },
  { cat: "Organize", id: "crop", icon: "crop", label: "Crop margins", desc: "Trim the visible area of pages (in points; 72 pt = 1 inch).",
    fields: [PAGES, { k: "t", label: "Top", type: "number", def: 36 }, { k: "r", label: "Right", type: "number", def: 36 }, { k: "b", label: "Bottom", type: "number", def: 36 }, { k: "l", label: "Left", type: "number", def: 36 }], suffix: "cropped",
    args: (v) => ({ pages: v.pages, margins: [v.t, v.r, v.b, v.l] }) },

  { cat: "Edit", id: "pageNumbers", icon: "pageNumbers", label: "Page numbers", desc: "Number the pages. <<1>> is the page number, <<n>> the page count.",
    fields: [PAGES, { k: "format", label: "Text", type: "text", def: "Page <<1>> of <<n>>" },
      { k: "position", label: "Where", type: "select", def: "bc", opts: [["bc", "Bottom centre"], ["br", "Bottom right"], ["bl", "Bottom left"], ["tc", "Top centre"], ["tr", "Top right"], ["tl", "Top left"]] },
      { k: "start", label: "First number", type: "number", def: 1 }, { k: "size", label: "Size (pt)", type: "number", def: 10 }], suffix: "numbered" },
  { cat: "Edit", id: "headerFooter", icon: "headerFooter", label: "Header & footer", desc: "Text at the top and bottom of every page. <<1>> page, <<n>> pages.",
    fields: [PAGES, { k: "h0", label: "Header left", type: "text" }, { k: "h1", label: "Header centre", type: "text" }, { k: "h2", label: "Header right", type: "text" },
      { k: "f0", label: "Footer left", type: "text" }, { k: "f1", label: "Footer centre", type: "text", def: "<<1>>" }, { k: "f2", label: "Footer right", type: "text" },
      { k: "size", label: "Size (pt)", type: "number", def: 9 }, { k: "color", label: "Colour", type: "color", def: "#333333" }], suffix: "header",
    args: (v) => ({ pages: v.pages, text: [v.h0, v.h1, v.h2, v.f0, v.f1, v.f2].map((x) => x || ""), size: v.size, color: v.color }) },
  { cat: "Edit", id: "watermark", icon: "watermark", label: "Watermark", desc: "A text stamp across the pages (DRAFT, CONFIDENTIAL…).",
    fields: [PAGES, { k: "text", label: "Text", type: "text", def: "DRAFT" }, { k: "size", label: "Size (pt)", type: "number", def: 72 },
      { k: "color", label: "Colour", type: "color", def: "#999999" }, { k: "opacity", label: "Opacity (0–1)", type: "number", def: 0.25, step: 0.05 },
      { k: "rotation", label: "Angle (°)", type: "number", def: 45 }, { k: "behind", label: "Behind the page content", type: "check", def: false }], suffix: "watermarked" },
  { cat: "Edit", id: "removeMarks", icon: "removeMarks", label: "Remove watermarks", desc: "Remove watermarks, headers/footers and backgrounds that were added as marked content (by Callio, Acrobat and most tools).", fields: [PAGES], suffix: "clean" },
  { cat: "Edit", id: "flatten", icon: "flatten", label: "Flatten", desc: "Bake form fields and comments into the page, so they print the same everywhere and can't be changed.",
    fields: [PAGES, { k: "annots", label: "Comments & markup", type: "check", def: true }, { k: "fields", label: "Form fields", type: "check", def: true }], suffix: "flat" },
  { cat: "Edit", id: "metadata", icon: "metadata", label: "Properties", desc: "Title, author, subject and keywords shown by readers and search engines.", custom: "metadata", suffix: "edited" },
  { cat: "Edit", id: "attach", icon: "attach", label: "Attach files", desc: "Embed files (data, source, spreadsheets) inside the PDF.", fields: [{ k: "files", label: "Files", type: "files", exts: [] }], suffix: "attached" },

  { cat: "Security", id: "protect", icon: "protect", label: "Protect", desc: "Encrypt with AES-256. The open password is needed to read it; the owner password to change what's allowed.",
    fields: [{ k: "userPassword", label: "Password to open (empty = anyone can open)", type: "password" }, { k: "ownerPassword", label: "Owner password", type: "password" },
      { k: "print", label: "Allow printing", type: "check", def: true }, { k: "copy", label: "Allow copying text", type: "check", def: true },
      { k: "modify", label: "Allow editing", type: "check", def: false }, { k: "annotate", label: "Allow comments & forms", type: "check", def: true }, { k: "assemble", label: "Allow page changes", type: "check", def: false }], suffix: "protected",
    args: (v) => ({ userPassword: v.userPassword, ownerPassword: v.ownerPassword, allow: { print: v.print, printHigh: v.print, copy: v.copy, modify: v.modify, annotate: v.annotate, forms: v.annotate, assemble: v.assemble } }),
    check: (v) => (!v.userPassword && !v.ownerPassword ? "Give a password." : null) },
  { cat: "Security", id: "unlock", icon: "unlock", label: "Unlock", desc: "Save a copy without the password and restrictions (you need the password).", fields: [{ k: "password", label: "Password", type: "password" }], suffix: "unlocked" },
  { cat: "Security", id: "redact", icon: "redact", label: "Redact", desc: "Black out text for good — it is removed from the file, not just covered.", custom: "redact", suffix: "redacted" },

  { cat: "Optimize", id: "compress", icon: "compress", label: "Compress", desc: "Make the file smaller.",
    fields: [{ k: "level", label: "Level", type: "select", def: "standard", opts: [["lossless", "Lossless — same quality, tidier file"], ["standard", "Standard — pictures to 150 dpi"], ["screen", "Screen — pictures to 96 dpi"], ["smallest", "Smallest — strong picture compression"]] }], suffix: "small" },
  { cat: "Optimize", id: "repair", icon: "repair", label: "Repair", desc: "Rebuild a damaged PDF (broken cross-reference table, lost page tree).", fields: [], suffix: "repaired" },

  { cat: "Convert", id: "images", icon: "images", label: "Pictures → PDF", desc: "One page per picture (JPEG, PNG…), in the order listed.", noInput: true, fields: [{ k: "inputs", label: "Pictures", type: "files", exts: ["jpg", "jpeg", "png", "gif", "bmp", "tif", "tiff", "webp"] }], suffix: "pictures" },
  { cat: "Convert", id: "toImages", icon: "toImages", label: "PDF → pictures", desc: "Each page as a PNG or JPEG, saved into a folder.", custom: "toImages" },
  { cat: "Convert", id: "toMd", icon: "toMd", label: "PDF → Markdown", desc: "Text, headings, lists, tables and pictures as an editable Markdown document (scanned pages through OCR).", custom: "toMd" },
  { cat: "Convert", id: "toWord", icon: "toWord", label: "PDF → Word / OpenDocument", desc: "Through Markdown: text, headings, lists, tables and pictures — not the exact page layout.", custom: "toWord" },
  { cat: "Convert", id: "fromOffice", icon: "fromOffice", label: "Document → PDF", desc: "Word, OpenDocument, RTF, HTML, Markdown, text or a spreadsheet as a PDF with real text, links and bookmarks.", noInput: true, custom: "fromOffice" },
  { cat: "Convert", id: "compare", icon: "compare", label: "Compare two PDFs", desc: "The text of two versions side by side, with the changes marked.", custom: "compare" },
  { cat: "Convert", id: "info", icon: "info", label: "Inspect", desc: "Pages, sizes, version, encryption, properties and attachments.", custom: "info" },
];

// ---------------- dialog ----------------
let current = null; // input PDF path
let tool = TOOLS[0];
let dlg;

export async function openPdfTools(path, toolId) {
  dlg ||= build();
  current = path || current;
  if (toolId) tool = TOOLS.find((t) => t.id === toolId) || tool;
  await showFile();
  pick(tool);
  if (!dlg.open) dlg.showModal();
}

function build() {
  const d = document.createElement("dialog");
  d.id = "dlg-pdftools";
  const cats = [...new Set(TOOLS.map((t) => t.cat))];
  d.innerHTML = `<header class="dlg-head"><h2>PDF tools</h2>
      <div class="pt-file"><span class="pt-name">No PDF chosen</span><button type="button" class="pt-pick">Choose PDF…</button></div>
      <button class="icon pt-close" title="Close">${ic("x")}</button></header>
    <div class="pt-body">
      <nav class="pt-nav">${cats.map((c) => `<div class="pt-cat">${c}</div>` + TOOLS.filter((t) => t.cat === c).map((t) => `<button type="button" data-t="${t.id}"><span class="pt-ic">${icon(t.icon)}</span><span class="pt-lb">${esc(t.label)}</span></button>`).join("")).join("")}</nav>
      <section class="pt-main"><h3 class="pt-title"></h3><p class="pt-desc note"></p><div class="pt-form"></div></section>
    </div>
    <footer class="dlg-foot"><span class="pt-msg note"></span><button type="button" class="pt-cancel">Close</button><button type="button" class="primary pt-go">Save as…</button></footer>`;
  document.body.appendChild(d);
  $(".pt-close", d).onclick = $(".pt-cancel", d).onclick = () => d.close();
  $(".pt-nav", d).onclick = (e) => { const b = e.target.closest("button[data-t]"); if (b) pick(TOOLS.find((t) => t.id === b.dataset.t)); };
  $(".pt-pick", d).onclick = async () => {
    const f = await call("pick_files", { name: "PDF", exts: ["pdf"] });
    if (f?.[0]) { current = f[0]; await showFile(); pick(tool); }
  };
  $(".pt-go", d).onclick = () => go();
  d.addEventListener("close", () => { organizer?.destroy(); organizer = null; });
  return d;
}

let info = null;
async function showFile() {
  info = null;
  $(".pt-name", dlg).textContent = current ? basename(current) : "No PDF chosen";
  $(".pt-name", dlg).title = current || "";
  if (!current) return;
  try {
    info = await office("pdf.info", { input: current });
    $(".pt-name", dlg).textContent = `${basename(current)} · ${info.pages} page${info.pages === 1 ? "" : "s"}${info.encrypted ? " · 🔒" : ""}`;
  } catch (e) { $(".pt-name", dlg).textContent = `${basename(current)} — ${e.message}`; }
}

let msgTarget = null;
const msg = (t, kind = "") => { const m = msgTarget || $(".pt-msg", dlg); m.textContent = t; m.className = `pt-msg note ${kind}`; };

function pick(t) {
  tool = t;
  organizer?.destroy(); organizer = null;
  dlg.querySelectorAll(".pt-nav button").forEach((b) => b.classList.toggle("on", b.dataset.t === t.id));
  $(".pt-title", dlg).textContent = t.label;
  $(".pt-desc", dlg).textContent = t.desc;
  const form = $(".pt-form", dlg);
  form.innerHTML = "";
  msg("");
  const go = $(".pt-go", dlg);
  go.hidden = false;
  go.textContent = t.folderOut || t.id === "toImages" ? "Save into folder…" : t.id === "info" ? "Refresh" : t.id === "compare" ? "Compare" : "Save as…";
  if (!t.noInput && !current) {
    form.innerHTML = `<div class="pt-empty">Choose a PDF to work on.<br><button type="button" class="primary">Choose PDF…</button></div>`;
    $("button", form).onclick = () => $(".pt-pick", dlg).click();
    go.hidden = true;
    return;
  }
  if (t.custom) return CUSTOM[t.custom](form, t);
  renderFields(form, t.fields || []);
}

function renderFields(form, fields) {
  const vals = {};
  for (const f of fields) vals[f.k] = f.def ?? (f.type === "check" ? false : f.type === "files" ? [] : "");
  form._vals = vals; form._fields = fields;
  const draw = () => {
    form.innerHTML = "";
    for (const f of fields) {
      if (f.show && !f.show(vals)) continue;
      const row = document.createElement("label");
      row.className = `pt-row pt-${f.type}`;
      if (f.type === "check") {
        row.innerHTML = `<input type="checkbox" ${vals[f.k] ? "checked" : ""}> <span>${esc(f.label)}</span>`;
        $("input", row).onchange = (e) => { vals[f.k] = e.target.checked; };
      } else if (f.type === "select") {
        row.innerHTML = `<span>${esc(f.label)}</span><select>${f.opts.map(([v, l]) => `<option value="${v}" ${String(vals[f.k]) === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
        $("select", row).onchange = (e) => { vals[f.k] = e.target.value; if (fields.some((x) => x.show)) draw(); };
      } else if (f.type === "files") {
        row.innerHTML = `<span>${esc(f.label)}</span><div class="pt-list"></div><div class="pt-list-btns"><button type="button" class="pt-add">Add files…</button>${f.exts.includes("pdf") && current ? `<button type="button" class="pt-add-cur">Add ${esc(basename(current))}</button>` : ""}</div>`;
        const list = $(".pt-list", row);
        const paint = () => {
          list.innerHTML = vals[f.k].length ? vals[f.k].map((p, i) => `<div class="pt-li" data-i="${i}" data-k="${esc(p)}#${i}"><span class="pt-grip">${ic("grip")}</span><span class="pt-li-name" title="${esc(p)}">${esc(basename(p))}</span><button type="button" data-up="${i}" title="Move up">${ic("arrow-up")}</button><button type="button" data-down="${i}" title="Move down">${ic("arrow-down")}</button><button type="button" data-rm="${i}" title="Remove">${ic("x")}</button></div>`).join("") : `<div class="note">No files yet.</div>`;
        };
        paint();
        list.onclick = (e) => {
          const b = e.target.closest("button"); if (!b) return; e.preventDefault();
          const a = vals[f.k];
          if (b.dataset.rm) a.splice(+b.dataset.rm, 1);
          if (b.dataset.up && +b.dataset.up > 0) { const i = +b.dataset.up; [a[i - 1], a[i]] = [a[i], a[i - 1]]; }
          if (b.dataset.down && +b.dataset.down < a.length - 1) { const i = +b.dataset.down; [a[i + 1], a[i]] = [a[i], a[i + 1]]; }
          paint();
        };
        sortable(list, {
          item: ".pt-li", axis: "y",
          drop: (el, to) => { const a = vals[f.k], from = +el.dataset.i; const [x] = a.splice(from, 1); a.splice(to > from ? to - 1 : to, 0, x); paint(); enter(list.children[to > from ? to - 1 : to], "pop"); },
        });
        $(".pt-add", row).onclick = async (e) => { e.preventDefault(); const got = await call("pick_files", { name: f.label, exts: f.exts }); if (got?.length) { vals[f.k].push(...got); paint(); } };
        const cur = $(".pt-add-cur", row); if (cur) cur.onclick = (e) => { e.preventDefault(); vals[f.k].push(current); paint(); };
      } else if (f.type === "file") {
        row.innerHTML = `<span>${esc(f.label)}</span><div class="pt-fileval"><span class="note">${vals[f.k] ? esc(basename(vals[f.k])) : "none"}</span><button type="button">Choose…</button></div>`;
        $("button", row).onclick = async (e) => { e.preventDefault(); const got = await call("pick_files", { name: f.label, exts: f.exts }); if (got?.[0]) { vals[f.k] = got[0]; draw(); } };
      } else {
        const type = f.type === "number" ? "number" : f.type === "color" ? "color" : f.type === "password" ? "password" : "text";
        row.innerHTML = `<span>${esc(f.label)}</span><input type="${type}" ${f.step ? `step="${f.step}"` : ""} placeholder="${esc(f.ph || "")}" value="${esc(vals[f.k])}">`;
        $("input", row).oninput = (e) => { vals[f.k] = f.type === "number" ? Number(e.target.value) : e.target.value; };
      }
      form.appendChild(row);
    }
  };
  draw();
}

function values(form) {
  const v = { ...form._vals };
  for (const f of form._fields || []) {
    if (f.show && !f.show(v)) delete v[f.k];
    else if (f.num) v[f.k] = Number(v[f.k]);
  }
  return v;
}

async function saveTarget(suffix, ext = "pdf") {
  const base = current ? `${stem(current)}-${suffix}.${ext}` : `${suffix}.${ext}`;
  return api.pickSaveFile(base, current ? dirname(current) : folder);
}

async function busy(label, fn) {
  const go = $(".pt-go", dlg);
  go.disabled = true;
  msg(label);
  status(label);
  try { return await fn(); }
  catch (e) { msg(e.message, "err"); status("PDF tool failed", "err"); throw e; }
  finally { go.disabled = false; }
}

async function finish(r, out) {
  const parts = [];
  if (r?.pages) parts.push(`${r.pages} page${r.pages === 1 ? "" : "s"}`);
  if (r?.bytes) parts.push(fmtBytes(r.bytes));
  if (r?.before && r?.bytes) parts.push(`was ${fmtBytes(r.before)}`);
  const text = `Saved ${basename(out)}${parts.length ? ` (${parts.join(", ")})` : ""}`;
  msg(text, "ok");
  status(text, "ok");
  toast(text, "ok", 3500);
  dlg.close();
  await openPath(out);
}

async function go() {
  if (tool.custom && CUSTOM_GO[tool.custom]) return CUSTOM_GO[tool.custom]().catch((e) => e.message !== "Cancelled" && toast(e.message, "err", 8000));
  const form = $(".pt-form", dlg);
  const v = values(form);
  const bad = tool.check?.(v);
  if (bad) return msg(bad, "err");
  const args = tool.args ? tool.args(v) : v;
  try {
    if (tool.folderOut) {
      const dir = await api.pickFolder("Folder for the parts");
      if (!dir) return;
      const r = await busy("Splitting…", () => office(`pdf.${tool.id}`, { ...args, input: current, outDir: dir, stem: stem(current) }));
      const n = r.outputs?.length || 0;
      msg(`Saved ${n} part${n === 1 ? "" : "s"} in ${basename(dir)}`, "ok");
      toast(`Saved ${n} parts in ${dir}`, "ok", 5000);
      return;
    }
    const out = await saveTarget(tool.suffix || tool.id);
    if (!out) return;
    if (current && out.toLowerCase() === current.toLowerCase()) return msg("Pick a new name — the original is kept as it is.", "err");
    const r = await busy(`${tool.label}…`, () => office(`pdf.${tool.id}`, { ...args, input: tool.noInput ? undefined : current, output: out }));
    await finish(r, out);
  } catch (e) { if (e.message !== "Cancelled") toast(`${tool.label}: ${e.message}`, "err", 8000); }
}

// ---------------- pdf.js helpers ----------------
async function loadPdfJs(path) {
  const bytes = new Uint8Array(await api.readBinary(path));
  const task = pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false });
  const doc = await task.promise;
  doc.__task = task;
  return doc;
}
const release = (doc) => { try { doc?.__task?.destroy(); } catch {} };

async function renderPage(doc, n, width, rotate = 0) {
  const page = await doc.getPage(n);
  const v0 = page.getViewport({ scale: 1, rotation: (page.rotate + rotate) % 360 });
  const vp = page.getViewport({ scale: width / v0.width, rotation: (page.rotate + rotate) % 360 });
  const c = document.createElement("canvas");
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  await page.render({ canvasContext: c.getContext("2d"), viewport: vp, canvas: c }).promise;
  return c;
}

// ---------------- custom tools ----------------
let organizer = null;
const CUSTOM = {
  organizer(form) {
    form.innerHTML = `<div class="pt-org-bar"><button type="button" data-a="rotL">${ic("rotate-ccw")}<span>Rotate left</span></button><button type="button" data-a="rotR">${ic("rotate-cw")}<span>Rotate right</span></button><button type="button" data-a="dup">${ic("copy")}<span>Duplicate</span></button><button type="button" data-a="del">${ic("trash")}<span>Delete</span></button><button type="button" data-a="rev">${ic("sort-desc")}<span>Reverse all</span></button><button type="button" data-a="reset">${ic("history")}<span>Start over</span></button><span class="note pt-org-sel"></span></div><div class="pt-grid" tabindex="0"></div><p class="note">Click to select (Ctrl / Shift for more), drag to move. Delete removes the selected pages.</p>`;
    organizer = makeOrganizer($(".pt-grid", form), $(".pt-org-bar", form), { count: info?.pages || 0, load: () => loadPdfJs(current) });
  },
  metadata(form) {
    const keys = [["Title", "Title"], ["Author", "Author"], ["Subject", "Subject"], ["Keywords", "Keywords"], ["Creator", "Created with"]];
    renderFields(form, keys.map(([k, l]) => ({ k, label: l, type: "text", def: info?.info?.[k] || "" })));
  },
  redact(form) {
    form.innerHTML = `<div class="pt-red-find">
        <label class="pt-row"><span>Find</span><input type="text" class="pt-red-q" placeholder="words or phrases to black out"></label>
        <div class="pt-red-presets"><span class="note">Or find:</span>
          <button type="button" data-p="email">E-mail addresses</button><button type="button" data-p="phone">Phone numbers</button>
          <button type="button" data-p="url">Web links</button><button type="button" data-p="num">Long numbers (IDs, accounts)</button><button type="button" data-p="date">Dates</button></div>
        <label class="pt-check"><input type="checkbox" class="pt-red-case"> Match case</label>
        <label class="pt-check"><input type="checkbox" class="pt-red-re"> Regular expression</label>
        <button type="button" class="pt-red-search">Find</button></div>
      <div class="pt-red-hits note">Search for text, then save: every match is removed from the file and covered with a black box.</div>
      <div class="pt-red-list"></div>`;
    const PRE = {
      email: "[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+",
      phone: "\\+?\\d[\\d ().-]{7,}\\d",
      url: "https?://\\S+|www\\.\\S+",
      num: "\\b\\d[\\d -]{6,}\\d\\b",
      date: "\\b\\d{1,4}[./-]\\d{1,2}[./-]\\d{1,4}\\b",
    };
    form._areas = [];
    const run = async (re) => {
      const hits = await findText(current, re);
      form._areas = hits;
      const pages = new Set(hits.map((h) => h.page));
      $(".pt-red-hits", form).textContent = hits.length ? `${hits.length} match${hits.length === 1 ? "" : "es"} on ${pages.size} page${pages.size === 1 ? "" : "s"} — uncheck any to keep.` : "Nothing found.";
      $(".pt-red-list", form).innerHTML = hits.slice(0, 500).map((h, i) => `<label class="pt-check"><input type="checkbox" checked data-i="${i}"> p.${h.page + 1}: <b>${esc(h.text)}</b></label>`).join("");
    };
    $(".pt-red-list", form).onchange = (e) => { const i = e.target.dataset.i; if (i != null) form._areas[i].off = !e.target.checked; };
    const search = () => {
      const q = $(".pt-red-q", form).value.trim(); if (!q) return;
      const flags = $(".pt-red-case", form).checked ? "g" : "gi";
      try {
        const src = $(".pt-red-re", form).checked ? q : q.split(/\s*[,;\n]\s*/).filter(Boolean).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
        run(new RegExp(src, flags)).catch((e) => msg(e.message, "err"));
      } catch (e) { msg(`Not a valid expression: ${e.message}`, "err"); }
    };
    $(".pt-red-search", form).onclick = search;
    $(".pt-red-q", form).onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } };
    $(".pt-red-presets", form).onclick = (e) => { const b = e.target.closest("button[data-p]"); if (b) run(new RegExp(PRE[b.dataset.p], "g")).catch((er) => msg(er.message, "err")); };
  },
  toImages(form) {
    renderFields(form, [PAGES, { k: "fmt", label: "Format", type: "select", def: "png", opts: [["png", "PNG (sharp, larger)"], ["jpeg", "JPEG (photos, smaller)"]] }, { k: "dpi", label: "Resolution (dpi)", type: "number", def: 150 }]);
  },
  toMd(form) { form.innerHTML = `<p>The Markdown opens in a new tab; pictures are saved next to it in a <code>_files</code> folder.</p>`; },
  toWord(form) { renderFields(form, [{ k: "fmt", label: "Save as", type: "select", def: "docx", opts: [["docx", "Word (.docx)"], ["odt", "OpenDocument (.odt)"], ["rtf", "Rich Text (.rtf)"], ["html", "Web page (.html)"]] }]); },
  fromOffice(form) { renderFields(form, [{ k: "input", label: "Document", type: "file", exts: ["docx", "docm", "doc", "odt", "rtf", "html", "htm", "md", "txt", "tex", "xlsx", "xlsm", "xls", "xlsb", "ods", "csv", "tsv"] }]); },
  compare(form) { renderFields(form, [{ k: "other", label: `Compare ${current ? basename(current) : "this PDF"} with`, type: "file", exts: ["pdf"] }]); },
  async info(form) {
    $(".pt-go", dlg).hidden = true;
    if (!info) { form.innerHTML = `<p class="note">Couldn't read this PDF.</p>`; return; }
    const sizes = info.sizes || [];
    const uniq = [...new Set(sizes.map(([w, h]) => `${Math.round(w)} × ${Math.round(h)} pt (${(w / 72 * 25.4).toFixed(0)} × ${(h / 72 * 25.4).toFixed(0)} mm)`))];
    const rows = [["Pages", info.pages], ["PDF version", info.version], ["Encrypted", info.encrypted ? "yes" : "no"], ["Page size" + (uniq.length > 1 ? "s" : ""), uniq.slice(0, 6).join("<br>")],
      ...Object.entries(info.info || {}).map(([k, v]) => [{ CreationDate: "Created", ModDate: "Modified", Creator: "Made with", Producer: "PDF made by" }[k] || k, esc(pdfDate(v))]), ["Attachments", (info.attachments || []).map(esc).join(", ") || "none"]];
    form.innerHTML = `<table class="pt-info">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table>`;
  },
};

const CUSTOM_GO = {
  async organizer() {
    const order = organizer.order();
    if (!order.length) return msg("No pages left.", "err");
    const out = await saveTarget("organized");
    if (!out) return;
    const r = await busy("Saving pages…", () => office("pdf.organize", { input: current, output: out, order }));
    await finish(r, out);
  },
  async metadata() {
    const form = $(".pt-form", dlg);
    const v = values(form);
    const out = await saveTarget("edited");
    if (!out) return;
    const r = await busy("Saving…", () => office("pdf.metadata", { input: current, output: out, info: v }));
    await finish(r, out);
  },
  async redact() {
    const form = $(".pt-form", dlg);
    const areas = (form._areas || []).filter((a) => !a.off).map(({ page, rect }) => ({ page, rect }));
    if (!areas.length) return msg("Find something to black out first.", "err");
    const ok = await ask({ title: "Redact", text: `Remove ${areas.length} match${areas.length === 1 ? "" : "es"} for good? This saves a new file; the original stays as it is.`, buttons: [{ label: "Cancel", value: null }, { label: "Redact", value: "ok", primary: true }] });
    if (!ok) return;
    const out = await saveTarget("redacted");
    if (!out) return;
    const r = await busy("Redacting…", () => office("pdf.redact", { input: current, output: out, areas }));
    await finish(r, out);
  },
  async toImages() {
    const v = values($(".pt-form", dlg));
    const dir = await api.pickFolder("Folder for the pictures");
    if (!dir) return;
    await busy("Rendering pages…", async () => {
      const doc = await loadPdfJs(current);
      const pages = parsePages(v.pages, doc.numPages);
      const dpi = Math.min(600, Math.max(36, v.dpi || 150));
      const ext = v.fmt === "jpeg" ? "jpg" : "png";
      const w = String(doc.numPages).length;
      for (const [i, n] of pages.entries()) {
        msg(`Page ${i + 1} of ${pages.length}…`);
        const page = await doc.getPage(n);
        const vp1 = page.getViewport({ scale: 1 });
        const c = await renderPage(doc, n, vp1.width * dpi / 72);
        const blob = await new Promise((res) => c.toBlob(res, v.fmt === "jpeg" ? "image/jpeg" : "image/png", 0.9));
        await api.writeBinary(`${dir}/${stem(current)}-${String(n).padStart(w, "0")}.${ext}`, new Uint8Array(await blob.arrayBuffer()), 0, false);
      }
      release(doc);
      msg(`Saved ${pages.length} picture${pages.length === 1 ? "" : "s"} in ${basename(dir)}`, "ok");
      toast(`Saved ${pages.length} pictures in ${dir}`, "ok", 5000);
    });
  },
  async toMd() {
    dlg.close();
    const { exportMarkdown } = await import("./export-md.js");
    await exportMarkdown({ kind: "pdf", path: current, name: basename(current) });
  },
  async toWord() {
    const v = values($(".pt-form", dlg));
    const out = await saveTarget("converted", v.fmt).then((p) => p);
    if (!out) return;
    await busy("Converting…", async () => {
      const conv = await import("./convert/index.js");
      const bytes = new Uint8Array(await api.readBinary(current));
      const res = await conv.toMarkdown({ name: basename(current), bytes, imageMode: "inline", onProgress: (d, n, label) => msg(label || `Reading… ${d}/${n}`) });
      const r = await office("doc.fromText", { text: res.markdown, kind: "md", dir: dirname(current) });
      await office("doc.save", { id: r.id, out });
      office("doc.close", { id: r.id }).catch(() => {});
    });
    msg(`Saved ${basename(out)}`, "ok");
    toast(`Saved ${basename(out)}`, "ok", 3500);
    dlg.close();
    if (v.fmt === "html") await openPath(out);
  },
  async fromOffice() {
    const v = values($(".pt-form", dlg));
    if (!v.input) return msg("Choose a document first.", "err");
    const out = await api.pickSaveFile(`${stem(v.input)}.pdf`, dirname(v.input));
    if (!out) return;
    const r = await busy("Making the PDF…", () => office("convert", { input: v.input, out }));
    await finish(r, out);
  },
  async compare() {
    const v = values($(".pt-form", dlg));
    if (!v.other) return msg("Choose the other PDF first.", "err");
    const [a, b] = await busy("Reading both PDFs…", () => Promise.all([pdfText(current), pdfText(v.other)]));
    msg("");
    dlg.close();
    showCompare(basename(current), a, basename(v.other), b);
  },
};

/** D:20261102183147+07'00' → 2026-11-02 18:31 */
function pdfDate(v) {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(v || "");
  return m ? `${m[1]}-${m[2] || "01"}-${m[3] || "01"}${m[4] ? ` ${m[4]}:${m[5] || "00"}` : ""}` : v;
}

function parsePages(spec, count) {
  const s = String(spec || "all").trim().toLowerCase();
  if (!s || s === "all") return Array.from({ length: count }, (_, i) => i + 1);
  const out = [];
  for (const part of s.split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
    if (part === "odd") { for (let i = 1; i <= count; i += 2) out.push(i); continue; }
    if (part === "even") { for (let i = 2; i <= count; i += 2) out.push(i); continue; }
    const num = (t) => (t === "last" || t === "z" ? count : parseInt(t, 10));
    const [x, y] = part.includes("-") ? part.split("-").map((t) => t.trim()) : [part, part];
    let a = x ? num(x) : 1, b = y ? num(y) : count;
    if (!(a >= 1 && b >= 1 && a <= count && b <= count)) throw new Error(`Pages run from 1 to ${count}: “${part}” is outside`);
    if (a <= b) for (let i = a; i <= b; i++) out.push(i); else for (let i = a; i >= b; i--) out.push(i);
  }
  return out;
}

/** Every match of `re` in the PDF's text: {page (0-based), text, rect [x0,y0,x1,y1] in PDF points}. */
async function findText(path, re) {
  const doc = await loadPdfJs(path);
  const hits = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    // one string per page with each character mapped back to its text item
    let text = "";
    const map = [];
    for (const it of tc.items) {
      if (!("str" in it)) continue;
      for (let k = 0; k < it.str.length; k++) map.push([it, k]);
      text += it.str;
      map.push(null); text += it.hasEOL ? "\n" : " ";
    }
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (!m[0]) { re.lastIndex++; continue; }
      // a match may span several items: one box per item
      const byItem = new Map();
      for (let i = m.index; i < m.index + m[0].length; i++) {
        const e = map[i]; if (!e) continue;
        const [it, k] = e;
        const r = byItem.get(it) || [k, k];
        r[0] = Math.min(r[0], k); r[1] = Math.max(r[1], k);
        byItem.set(it, r);
      }
      for (const [it, [k0, k1]] of byItem) {
        const [a, b, c, d, e, f] = it.transform;
        const len = it.str.length || 1;
        const w = it.width || Math.hypot(a, b) * len * 0.5;
        const h = it.height || Math.hypot(c, d);
        // horizontal text (the common case): the share of the item's width these characters take
        const x0 = e + (w * k0) / len, x1 = e + (w * (k1 + 1)) / len;
        hits.push({ page: n - 1, text: m[0], rect: [x0 - 0.5, f - h * 0.25, x1 + 0.5, f + h * 0.95] });
      }
    }
  }
  release(doc);
  return hits;
}

async function pdfText(path) {
  const doc = await loadPdfJs(path);
  let out = "";
  for (let n = 1; n <= doc.numPages; n++) {
    const tc = await (await doc.getPage(n)).getTextContent();
    out += `— page ${n} —\n`;
    let line = "";
    for (const it of tc.items) { if (!("str" in it)) continue; line += it.str; if (it.hasEOL) { out += line.trimEnd() + "\n"; line = ""; } }
    if (line) out += line.trimEnd() + "\n";
  }
  release(doc);
  return out;
}

async function showCompare(nameA, a, nameB, b) {
  const { MergeView } = await import("@codemirror/merge");
  const { EditorView, lineNumbers } = await import("@codemirror/view");
  const { EditorState } = await import("@codemirror/state");
  let d = $("#dlg-pdfcompare");
  if (!d) {
    d = document.createElement("dialog");
    d.id = "dlg-pdfcompare";
    d.innerHTML = `<header class="dlg-head"><h2>${ic("compare")} <span class="cmp-a"></span> <span class="dfx-arrow">${ic("compare")}</span> <span class="cmp-b"></span></h2><span class="note cmp-sum"></span><button class="icon" title="Close">${ic("x")}</button></header><div class="cmp-body"></div>`;
    document.body.appendChild(d);
    $("button", d).onclick = () => d.close();
  }
  $(".cmp-a", d).textContent = nameA; $(".cmp-b", d).textContent = nameB;
  const body = $(".cmp-body", d);
  body.innerHTML = "";
  const ext = [lineNumbers(), EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false)];
  const mv = new MergeView({ a: { doc: a, extensions: ext }, b: { doc: b, extensions: ext }, parent: body, collapseUnchanged: { margin: 3, minSize: 6 }, gutter: true });
  const chunks = mv.chunks?.length ?? 0;
  $(".cmp-sum", d).textContent = chunks ? `${chunks} change${chunks === 1 ? "" : "s"}` : "No differences in the text";
  d.showModal();
}

// ---------------- visual page organizer ----------------
function makeOrganizer(grid, bar, src) {
  let pages = []; // {src (1-based), rot, id}
  let sel = new Set();
  let anchor = -1;
  let doc = null;
  let dead = false;
  const thumbs = new Map(); // `${src}` → canvas data url
  let uid = 1;
  const reset = () => { pages = Array.from({ length: src.count }, (_, i) => ({ src: i + 1, rot: 0, id: uid++ })); sel.clear(); paint(); };
  const paint = () => {
    grid.innerHTML = pages.map((p, i) => `<div class="pt-pg${sel.has(p.id) ? " on" : ""}" data-i="${i}" data-k="${p.id}"><div class="pt-thumb" style="--rot:${p.rot}deg">${thumbs.has(p.src) ? `<img src="${thumbs.get(p.src)}" alt="">` : `<span class="note">…</span>`}</div><span class="pt-pgn">${i + 1}${p.src !== i + 1 ? ` <small>(p.${p.src})</small>` : ""}</span><button type="button" class="pt-pg-rot" title="Rotate">${ic("rotate-cw")}</button><button type="button" class="pt-pg-del" title="Delete">${ic("x")}</button></div>`).join("");
    $(".pt-org-sel", bar).textContent = `${pages.length} page${pages.length === 1 ? "" : "s"}${sel.size ? ` · ${sel.size} selected` : ""}`;
  };
  const selected = () => (sel.size ? pages.filter((p) => sel.has(p.id)) : []);
  const act = (a) => {
    const s = selected();
    if (a === "reset") return reset();
    if (a === "rev") pages.reverse();
    if (!s.length && a !== "rev") return msg("Select pages first.", "err");
    if (a === "rotL" || a === "rotR") s.forEach((p) => (p.rot = (p.rot + (a === "rotR" ? 90 : 270)) % 360));
    if (a === "del") { pages = pages.filter((p) => !sel.has(p.id)); sel.clear(); }
    if (a === "dup") { const out = []; for (const p of pages) { out.push(p); if (sel.has(p.id)) out.push({ ...p, id: uid++ }); } pages = out; }
    msg(""); paint();
  };
  bar.onclick = (e) => { const b = e.target.closest("button[data-a]"); if (b) act(b.dataset.a); };
  grid.onclick = (e) => {
    const el = e.target.closest(".pt-pg"); if (!el) { sel.clear(); return paint(); }
    const i = +el.dataset.i, p = pages[i];
    if (e.target.closest(".pt-pg-rot")) { p.rot = (p.rot + 90) % 360; return paint(); }
    if (e.target.closest(".pt-pg-del")) { pages.splice(i, 1); sel.delete(p.id); return paint(); }
    if (e.shiftKey && anchor >= 0) { const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)]; for (let k = a; k <= b; k++) sel.add(pages[k].id); }
    else if (e.ctrlKey || e.metaKey) { sel.has(p.id) ? sel.delete(p.id) : sel.add(p.id); anchor = i; }
    else { sel = new Set([p.id]); anchor = i; }
    paint();
  };
  grid.onkeydown = (e) => {
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); act("del"); }
    if ((e.ctrlKey || e.metaKey) && e.key === "a") { e.preventDefault(); sel = new Set(pages.map((p) => p.id)); paint(); }
  };
  const dragSet = (el) => { const p = pages[+el.dataset.i]; return sel.has(p.id) ? new Set(sel) : new Set([p.id]); };
  sortable(grid, {
    item: ".pt-pg", axis: "grid", ignore: "button",
    count: (el) => dragSet(el).size,
    moving: (el) => { const d = dragSet(el); return [...grid.querySelectorAll(".pt-pg")].filter((x) => d.has(pages[+x.dataset.i].id)); },
    drop: (el, to) => {
      const drag = dragSet(el);
      const moving = pages.filter((p) => drag.has(p.id));
      const before = pages.slice(0, to).filter((p) => !drag.has(p.id));
      const after = pages.slice(to).filter((p) => !drag.has(p.id));
      return flip(grid, ".pt-pg", (x) => x.dataset.k, () => { pages = [...before, ...moving, ...after]; paint(); });
    },
  });
  reset();
  // thumbnails, a few at a time
  (async () => {
    try {
      doc = await src.load();
      for (let n = 1; n <= doc.numPages && !dead; n++) {
        const c = await renderPage(doc, n, 150);
        thumbs.set(n, c.toDataURL("image/jpeg", 0.75));
        grid.querySelectorAll(".pt-pg").forEach((el) => {
          const p = pages[+el.dataset.i];
          if (p?.src === n) $(".pt-thumb", el).innerHTML = `<img src="${thumbs.get(n)}" alt="">`;
        });
      }
    } catch (e) { msg(`Couldn't draw the pages: ${e.message}`, "err"); }
  })();
  return {
    order: () => pages.map((p) => ({ page: p.src - 1, rotate: p.rot })),
    destroy: () => { dead = true; release(doc); },
  };
}

// ---------------- the page organizer on an open PDF tab ----------------
/**
 * Reorder, rotate, duplicate and delete the pages of the PDF in tab `t`, in place: `bytes` is the
 * document as shown (annotations included); `apply(order)` gets [{page, rotate}] when the person
 * clicks Apply (it becomes one step of the tab's Undo list).
 */
export function organizePages({ name, bytes, count, apply }) {
  let d = document.querySelector("#dlg-pdfpages");
  if (!d) {
    d = document.createElement("dialog");
    d.id = "dlg-pdfpages";
    d.innerHTML = `<header class="dlg-head"><h2>Pages — <span class="pp-name"></span></h2><button class="icon pp-x" title="Close">${ic("x")}</button></header>
      <div class="pp-body"><div class="pt-org-bar"><button type="button" data-a="rotL">${ic("rotate-ccw")}<span>Rotate left</span></button><button type="button" data-a="rotR">${ic("rotate-cw")}<span>Rotate right</span></button><button type="button" data-a="dup">${ic("copy")}<span>Duplicate</span></button><button type="button" data-a="del">${ic("trash")}<span>Delete</span></button><button type="button" data-a="rev">${ic("sort-desc")}<span>Reverse all</span></button><button type="button" data-a="reset">${ic("history")}<span>Start over</span></button><span class="note pt-org-sel"></span></div>
      <div class="pt-grid pp-grid" tabindex="0"></div><p class="note">Drag pages to put them in a new order. Click to select (Ctrl / Shift for more); Delete removes the selected pages. Apply changes the open PDF — Save writes it, and Undo takes it back.</p></div>
      <footer class="dlg-foot"><span class="pt-msg note"></span><button type="button" class="pp-cancel">Cancel</button><button type="button" class="primary pp-apply">Apply</button></footer>`;
    document.body.appendChild(d);
  }
  d.querySelector(".pp-name").textContent = name;
  let org = null;
  const close = () => { org?.destroy(); org = null; msgTarget = null; d.close(); };
  d.querySelector(".pp-x").onclick = d.querySelector(".pp-cancel").onclick = close;
  d.onclose = () => { org?.destroy(); org = null; msgTarget = null; };
  msgTarget = d.querySelector(".pt-msg");
  msgTarget.textContent = "";
  const grid = d.querySelector(".pp-grid"), bar = d.querySelector(".pt-org-bar");
  org = makeOrganizer(grid, bar, { count, load: async () => { const task = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }); const doc = await task.promise; doc.__task = task; return doc; } });
  d.querySelector(".pp-apply").onclick = async () => {
    const order = org.order();
    if (!order.length) return msg("No pages left.", "err");
    const same = order.length === count && order.every((o, i) => o.page === i && !o.rotate);
    if (same) return close();
    d.querySelector(".pp-apply").disabled = true;
    try { await apply(order); close(); }
    catch (e) { msg(e.message, "err"); }
    finally { d.querySelector(".pp-apply").disabled = false; }
  };
  d.showModal();
  grid.focus();
}
