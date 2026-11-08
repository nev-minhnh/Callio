// Compare two files (or two folders): pick them with the buttons, from the open tabs, or by
// dropping them from Explorer. Text, code, JSON, CSV… are compared line by line; Word documents,
// spreadsheets, presentations and PDFs by their text; pictures side by side with the
// differences lit up; other files byte by byte. Two files must be of the same type.
import { api, call } from "./api.js";
import { toast, status, basename, dirname, getTabs, openPath, reloadFromDisk, ask } from "./main.js";
import { enter } from "./motion.js";
import { ic } from "./icons.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const extOf = (p) => { const b = basename(p || ""); return b.includes(".") ? b.split(".").pop().toLowerCase() : ""; };

const TYPE_NAMES = {
  docx: "Word document", doc: "Word 97-2003 document", odt: "OpenDocument text", rtf: "Rich Text", xlsx: "Excel workbook", xls: "Excel 97-2003 workbook",
  ods: "OpenDocument spreadsheet", csv: "CSV (comma-separated) file", tsv: "TSV (tab-separated) file", pptx: "PowerPoint presentation", odp: "OpenDocument presentation",
  pdf: "PDF", md: "Markdown file", tex: "LaTeX file", json: "JSON file", xml: "XML file", yaml: "YAML file", yml: "YAML file", txt: "text file",
  png: "PNG picture", jpg: "JPEG picture", jpeg: "JPEG picture", gif: "GIF picture", webp: "WebP picture", bmp: "bitmap picture", svg: "SVG drawing",
  html: "web page", js: "JavaScript file", ts: "TypeScript file", py: "Python file", ipynb: "Jupyter notebook", bib: "BibTeX file", zip: "ZIP archive",
};
const typeName = (p) => { const e = extOf(p); return e ? `${TYPE_NAMES[e] || `.${e} file`} (.${e})` : "a file with no extension"; };
const WORD = /^(docx|docm|dotx|dotm|doc|odt|rtf)$/, SHEET = /^(xlsx|xlsm|xls|xlsb|ods)$/, DECK = /^(pptx|pptm|ppsx|potx|odp)$/, IMG = /^(png|jpe?g|gif|webp|bmp|ico|avif)$/;

const pick = { a: null, b: null }; // { path, isDir, tab? }

function dialog() {
  let d = $("#dlg-compare");
  if (d) return d;
  d = document.createElement("dialog");
  d.id = "dlg-compare";
  d.innerHTML = `
    <header class="dlg-head"><h2>${ic("compare")}<span>Compare two files</span></h2><button class="icon" data-a="close" title="Close">${ic("x")}</button></header>
    <div class="cmpk-body">
      ${["a", "b"].map((s) => `
      <div class="cmpk-slot" data-slot="${s}">
        <div class="cmpk-label">${s === "a" ? "Original (left)" : "Changed (right)"}</div>
        <div class="cmpk-drop" tabindex="0"><span class="cmpk-ico">${ic("pull")}</span><span class="cmpk-path">Drop a file or folder here</span></div>
        <div class="cmpk-btns">
          <button data-a="file" data-slot="${s}">${ic("file")}<span>File…</span></button>
          <button data-a="folder" data-slot="${s}">${ic("folder")}<span>Folder…</span></button>
          <select data-a="tab" data-slot="${s}" title="A file that is open in Callio (with its unsaved changes)"><option value="">Open tab…</option></select>
        </div>
      </div>`).join(`<button class="cmpk-swap icon" data-a="swap" title="Swap left and right">${ic("compare")}</button>`)}
    </div>
    <div class="cmpk-err" hidden></div>
    <footer class="dlg-foot">
      <label class="check" title="Lines that differ only in spaces at the end, or in line endings, count as the same"><input type="checkbox" id="cmp-ws" checked /> Ignore trailing spaces and line endings</label>
      <span class="tb-spacer"></span>
      <button data-a="close">Cancel</button>
      <button class="primary" data-a="go">Compare</button>
    </footer>`;
  document.body.appendChild(d);
  d.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-a]");
    if (!b || b.tagName === "SELECT") return;
    const a = b.dataset.a, s = b.dataset.slot;
    if (a === "close") d.close();
    else if (a === "file") { const p = await api.pickOpenFile(); if (p) await setSlot(s, p); }
    else if (a === "folder") { const p = await api.pickFolder(s === "a" ? "Original folder" : "Changed folder"); if (p) await setSlot(s, p); }
    else if (a === "swap") { [pick.a, pick.b] = [pick.b, pick.a]; paint(); }
    else if (a === "go") go();
  });
  d.addEventListener("change", async (e) => {
    const sel = e.target.closest('select[data-a="tab"]');
    if (!sel) return;
    const t = getTabs().find((x) => String(x.id) === sel.value);
    sel.value = "";
    if (t) await setSlot(sel.dataset.slot, t.path || t.name, t);
  });
  return d;
}

async function setSlot(s, path, tab = null) {
  let info = { exists: true, isDir: false };
  if (!tab || tab.path) { try { info = (await api.pathInfo(path)) || { exists: !!tab, isDir: false }; } catch {} }
  if (tab && !info.exists) info = { exists: true, isDir: false };
  if (!info.exists && !tab) { showErr(`${path} doesn't exist (any more).`); return; }
  pick[s] = { path, isDir: !!info.isDir, tab };
  hideErr();
  paint();
  // the other side empty and this is a file: offer the newest version of it from the history? no — keep it simple
}
function paint() {
  const d = dialog();
  for (const s of ["a", "b"]) {
    const slot = $(`.cmpk-slot[data-slot="${s}"]`, d), p = pick[s];
    slot.classList.toggle("set", !!p);
    $(".cmpk-ico", slot).innerHTML = ic(p ? (p.isDir ? "folder" : p.tab ? "file-text" : "file") : "pull");
    $(".cmpk-path", slot).innerHTML = p ? `<b>${esc(basename(p.path))}</b><small>${esc(p.tab && !p.tab.path ? "unsaved tab" : dirname(p.path))}${p.tab?.dirty ? " · with unsaved changes" : ""}</small>` : "Drop a file or folder here";
    const sel = $(`select[data-a="tab"]`, slot);
    sel.innerHTML = `<option value="">Open tab…</option>` + getTabs().filter((t) => t.path || t.state).map((t) => `<option value="${t.id}">${esc(t.name)}${t.dirty ? " •" : ""}</option>`).join("");
  }
}
function showErr(msg) { const e = $(".cmpk-err", dialog()); e.innerHTML = msg; const was = e.hidden; e.hidden = false; if (was) enter(e, "drop"); }
function hideErr() { const e = $(".cmpk-err", dialog()); e.hidden = true; }

/** Open the picker. `a`: a path to start with (the active file). */
export async function openCompare(a = null, tab = null) {
  const d = dialog();
  pick.a = null; pick.b = null;
  hideErr();
  if (a) await setSlot("a", a, tab);
  paint();
  d.showModal();
}

/** Files dropped from Explorer while the picker is open. */
export async function onDrop(paths, pos) {
  const d = dialog();
  if (!paths?.length) return;
  const dpr = window.devicePixelRatio || 1;
  const x = (pos?.x ?? -1) / dpr, y = (pos?.y ?? -1) / dpr;
  for (const el of d.querySelectorAll(".cmpk-drop")) el.classList.remove("over");
  if (paths.length >= 2) { await setSlot("a", paths[0]); await setSlot("b", paths[1]); return; }
  const slot = document.elementFromPoint(x, y)?.closest(".cmpk-slot")?.dataset.slot || (pick.a ? "b" : "a");
  await setSlot(slot, paths[0]);
}
export function onDragOver(pos) {
  const d = dialog(), dpr = window.devicePixelRatio || 1;
  const slot = document.elementFromPoint((pos?.x ?? -1) / dpr, (pos?.y ?? -1) / dpr)?.closest(".cmpk-slot");
  for (const el of d.querySelectorAll(".cmpk-slot")) el.classList.toggle("over", el === slot);
}

async function go() {
  const { a, b } = pick;
  if (!a || !b) return showErr("Choose two files (or two folders) to compare.");
  if (a.isDir !== b.isDir) return showErr(`Compare a file with a file, or a folder with a folder.<br><b>${esc(basename(a.path))}</b> is a ${a.isDir ? "folder" : "file"}; <b>${esc(basename(b.path))}</b> is a ${b.isDir ? "folder" : "file"}.`);
  if (!a.isDir) {
    const ea = extOf(a.path), eb = extOf(b.path);
    const same = ea === eb || (["yaml", "yml"].includes(ea) && ["yaml", "yml"].includes(eb)) || (["jpg", "jpeg"].includes(ea) && ["jpg", "jpeg"].includes(eb)) || (["htm", "html"].includes(ea) && ["htm", "html"].includes(eb));
    if (!same) {
      await ask({
        title: "These files can't be compared",
        text: `Both files must have the same extension.\n\nLeft: ${basename(a.path)} — ${typeName(a.path)}\nRight: ${basename(b.path)} — ${typeName(b.path)}\n\nCallio compares files of one type (two .docx, two .json, two .png…) so the difference means something. To compare their content anyway, export one to the other's format first (for example Save ▾ → Export as Markdown on both).`,
        buttons: [{ label: "OK", value: "ok", primary: true }],
      });
      return;
    }
  }
  dialog().close();
  const ws = $("#cmp-ws").checked;
  if (a.isDir) return compareFolders(a.path, b.path, ws);
  return compareFiles(a, b, ws);
}

// ------------------------------------------------------------------ reading a side
const CACHE = new Map();
async function textOf(side) {
  const { path, tab } = side;
  const e = extOf(path);
  if (tab && tab.state && !/^(pdf|doc|sheet|deck)$/.test(tab.kind)) {
    const { getView } = await import("./editor.js");
    const { activeTab } = await import("./main.js");
    const st = activeTab() === tab ? getView().state : tab.state;
    return { text: st.doc.toString(), mode: "text", editable: false };
  }
  if (e === "pdf") {
    const r = await (await import("./pdf.js")).extractText(new Uint8Array(await api.readBinary(path)));
    return { text: r.pages.map((x, i) => `— page ${i + 1} —\n${x}`).join("\n"), mode: "text", note: "the text of each page" };
  }
  const { office } = await import("./office.js");
  if (WORD.test(e)) {
    const r = await office("doc.open", { path });
    try { return { text: (await office("doc.markdown", { id: r.id, stem: basename(path).replace(/\.[^.]+$/, "") })).markdown || "", mode: "text", lang: "x.md", note: "the document as Markdown (text, headings, lists, tables)" }; }
    finally { office("doc.close", { id: r.id }).catch(() => {}); }
  }
  if (SHEET.test(e)) {
    const r = await office("sheet.open", { path });
    try {
      let out = "";
      const sheets = r.book?.sheets || [{ name: "Sheet1" }];
      for (let i = 0; i < sheets.length; i++) {
        const s = await office("sheet.read", { id: r.id, sheet: i, range: null });
        out += `=== ${sheets[i].name} ===\n` + (s.rows || []).map((row, k) => `${k + 1}\t` + row.map((v) => (Array.isArray(v) ? `${v[0]} {${v[1]}}` : v ?? "")).join("\t")).join("\n") + "\n\n";
      }
      return { text: out, mode: "text", note: "every sheet, one row per line (formulas in {})" };
    } finally { office("sheet.close", { id: r.id }).catch(() => {}); }
  }
  if (DECK.test(e)) {
    const id = (await office("deck.open", { path })).id;
    try {
      const doc = await office("deck.text", { id });
      const parts = [];
      for (let i = 0; i < (doc.slides || []).length; i++) {
        const r = await office("deck.run", { id, cmd: "slide.inspect", params: { index: i } });
        const sl = r.result || r;
        const lines = [`— slide ${i + 1}${sl.title ? `: ${sl.title}` : ""}${sl.hidden ? " (hidden)" : ""} — layout ${sl.layout || "?"}`];
        for (const sh of sl.shapes || []) if (sh.text) lines.push(`[${sh.name || sh.kind}] ${sh.text}`);
        if (sl.notes) lines.push(`[notes] ${sl.notes}`);
        parts.push(lines.join("\n"));
      }
      return { text: parts.join("\n\n") + "\n", mode: "text", note: "the text of each slide (titles, shapes, notes)" };
    }
    finally { office("deck.close", { id }).catch(() => {}); }
  }
  if (IMG.test(e)) return { mode: "image", bytes: new Uint8Array(await api.readBinary(path)) };
  const info = await api.pathInfo(path).catch(() => ({ size: 0 }));
  if (info.size > 40 * 1024 * 1024) return { mode: "binary", bytes: null, size: info.size };
  const bytes = new Uint8Array(await api.readBinary(path));
  if (looksBinary(bytes)) return { mode: "binary", bytes, size: bytes.length };
  const r = await api.readText(path);
  return { text: r.text.replace(/\r\n?/g, "\n"), mode: "text", editable: true, encoding: r.encoding, eol: /\r\n/.test(r.text) ? "\r\n" : "\n", mtime: r.mtime };
}
function looksBinary(b) {
  const n = Math.min(b.length, 8000);
  if (b[0] === 0xff && b[1] === 0xfe || b[0] === 0xfe && b[1] === 0xff) return false; // UTF-16 text
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}

// ------------------------------------------------------------------ the result window
function resultDialog() {
  let d = $("#dlg-diff");
  if (d) return d;
  d = document.createElement("dialog");
  d.id = "dlg-diff";
  d.innerHTML = `
    <header class="dlg-head">
      <button class="icon dfx-back" title="Back to the folder comparison" hidden>${ic("arrow-left")}</button>
      <h2><span class="dfx-a"></span> <span class="dfx-arrow">${ic("compare")}</span> <span class="dfx-b"></span></h2>
      <span class="dfx-sum"></span>
      <span class="tb-spacer"></span>
      <div class="dfx-tools">
        <button data-a="prev" title="Previous change (Shift+F7)">${ic("arrow-up")}</button>
        <button data-a="next" title="Next change (F7)">${ic("arrow-down")}</button>
        <div class="seg"><button data-a="side" class="active" title="Side by side">Side by side</button><button data-a="inline" title="One column, changes inline">Inline</button></div>
        <button data-a="fold" class="toggle on" title="Hide the lines that are the same">${ic("fold")}<span>Hide same</span></button>
        <button data-a="save" class="primary" hidden title="Save the right file with the changes you copied into it">Save right</button>
      </div>
      <button class="icon" data-a="close" title="Close (Esc)">${ic("x")}</button>
    </header>
    <div class="dfx-note"></div>
    <div class="dfx-body"></div>`;
  document.body.appendChild(d);
  return d;
}

let current = null; // { a, b, A, B, mv, mode }
async function compareFiles(a, b, ws, fromFolder = null) {
  const d = resultDialog();
  $(".dfx-a", d).textContent = basename(a.path); $(".dfx-a", d).title = a.path;
  $(".dfx-b", d).textContent = basename(b.path); $(".dfx-b", d).title = b.path;
  $(".dfx-back", d).hidden = !fromFolder;
  $(".dfx-back", d).onclick = () => fromFolder && showFolder(fromFolder);
  const body = $(".dfx-body", d);
  body.innerHTML = `<div class="dfx-loading"><span class="big-spinner"></span> Reading the files…</div>`;
  $(".dfx-sum", d).textContent = ""; $(".dfx-note", d).textContent = "";
  $(".dfx-tools", d).hidden = true;
  if (!d.open) d.showModal();
  status("Comparing…");
  let A, B;
  try { [A, B] = await Promise.all([textOf(a), textOf(b)]); }
  catch (e) { body.innerHTML = `<div class="dfx-empty">⚠ Couldn't read the files: ${esc(e.message || e)}</div>`; status(""); return; }
  status("");
  current = { a, b, A, B, ws };
  if (A.mode === "image" && B.mode === "image") return showImages(d, A, B, a, b);
  if (A.mode === "binary" || B.mode === "binary") return showBinary(d, A, B);
  $(".dfx-note", d).textContent = A.note ? `Comparing ${A.note}.` : "";
  $(".dfx-tools", d).hidden = false;
  await showText(d, "side");
}

async function showText(d, layout) {
  const { A, B, a, b, ws } = current;
  const body = $(".dfx-body", d);
  const [{ MergeView, unifiedMergeView }, { EditorView, lineNumbers, highlightActiveLineGutter }, { EditorState }, ed] = await Promise.all([
    import("@codemirror/merge"), import("@codemirror/view"), import("@codemirror/state"), import("./editor.js"),
  ]);
  const lang = (await ed.loadLanguage(A.lang || a.path)) || [];
  const norm = (s) => (ws ? s.replace(/[ \t]+$/gm, "") : s);
  const ta = norm(A.text), tb = norm(B.text);
  const canSave = !!(B.editable && b.path && !b.tab && !ws);
  const ro = [EditorState.readOnly.of(true), EditorView.editable.of(false)];
  const base = [lineNumbers(), highlightActiveLineGutter(), EditorView.lineWrapping, lang];
  current.mv?.destroy?.();
  body.innerHTML = "";
  const fold = $('[data-a="fold"]', d).classList.contains("on");
  const collapse = fold ? { margin: 3, minSize: 6 } : undefined;
  let mv;
  if (layout === "inline") {
    mv = new EditorView({ parent: body, state: EditorState.create({ doc: tb, extensions: [...base, ...ro, unifiedMergeView({ original: ta, mergeControls: false, highlightChanges: true, gutter: true, collapseUnchanged: collapse })] }) });
    mv.chunksOf = async () => (await import("@codemirror/merge")).getChunks(mv.state)?.chunks || [];
    mv.scroller = mv.scrollDOM;
  } else {
    mv = new MergeView({
      a: { doc: ta, extensions: [...base, ...ro] },
      b: { doc: tb, extensions: [...base, ...(canSave ? [EditorView.updateListener.of((u) => { if (u.docChanged) $('[data-a="save"]', d).hidden = false; })] : ro)] },
      parent: body, collapseUnchanged: collapse, gutter: true, highlightChanges: true,
      revertControls: canSave ? "a-to-b" : undefined,
    });
    mv.chunksOf = async () => mv.chunks || [];
    mv.scroller = body.querySelector(".cm-mergeView") || body;
  }
  current.mv = mv; current.layout = layout;
  const chunks = await mv.chunksOf();
  const sum = (() => {
    let add = 0, del = 0;
    for (const c of chunks) { add += lines(tb, c.fromB, c.toB); del += lines(ta, c.fromA, c.toA); }
    return { add, del };
  })();
  $(".dfx-sum", d).innerHTML = chunks.length
    ? `<span class="dfx-n">${chunks.length} change${chunks.length === 1 ? "" : "s"}</span> <span class="dfx-add">+${sum.add}</span> <span class="dfx-del">−${sum.del}</span>`
    : `<span class="dfx-same">✓ No differences${ws ? " (ignoring trailing spaces)" : ""}</span>`;
  $('[data-a="save"]', d).hidden = true;
  $('[data-a="side"]', d).classList.toggle("active", layout === "side");
  $('[data-a="inline"]', d).classList.toggle("active", layout === "inline");
  current.at = -1;
  enter(body.firstElementChild, "fade", { duration: 160 });
  if (chunks.length) requestAnimationFrame(() => jump(1));
}
function lines(text, from, to) { if (to <= from) return 0; let n = 1; for (let i = from; i < to - 1 && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; }

async function jump(dir) {
  const mv = current?.mv;
  if (!mv) return;
  const chunks = await mv.chunksOf();
  if (!chunks.length) return;
  current.at = (current.at + dir + chunks.length) % chunks.length;
  const c = chunks[current.at];
  const view = current.layout === "inline" ? mv : mv.b;
  const pos = Math.min(c.fromB, view.state.doc.length);
  view.dispatch({ selection: { anchor: pos }, effects: (await import("@codemirror/view")).EditorView.scrollIntoView(pos, { y: "center" }) });
  $(".dfx-sum .dfx-n", resultDialog()) && ($(".dfx-sum .dfx-n", resultDialog()).textContent = `change ${current.at + 1} of ${chunks.length}`);
}

function showImages(d, A, B, a, b) {
  const body = $(".dfx-body", d);
  const ua = URL.createObjectURL(new Blob([A.bytes])), ub = URL.createObjectURL(new Blob([B.bytes]));
  body.innerHTML = `
    <div class="dfi-bar"><div class="seg"><button data-v="side" class="active">Side by side</button><button data-v="swipe">Swipe</button><button data-v="diff">Differences</button></div><span class="dfi-info"></span></div>
    <div class="dfi-view"></div>`;
  const view = $(".dfi-view", body), info = $(".dfi-info", body);
  const ia = new Image(), ib = new Image();
  ia.src = ua; ib.src = ub;
  Promise.all([ia.decode().catch(() => {}), ib.decode().catch(() => {})]).then(() => {
    info.textContent = `${ia.naturalWidth}×${ia.naturalHeight} → ${ib.naturalWidth}×${ib.naturalHeight}`;
    let px = null;
    const mode = (v) => {
      for (const x of body.querySelectorAll(".dfi-bar button")) x.classList.toggle("active", x.dataset.v === v);
      if (v === "side") view.innerHTML = `<div class="dfi-side"><figure><img src="${ua}"><figcaption>${esc(basename(a.path))}</figcaption></figure><figure><img src="${ub}"><figcaption>${esc(basename(b.path))}</figcaption></figure></div>`;
      if (v === "swipe") {
        view.innerHTML = `<div class="dfi-swipe"><img src="${ua}"><div class="dfi-top"><img src="${ub}"></div><input type="range" min="0" max="100" value="50"></div>`;
        const top = $(".dfi-top", view), r = $("input", view);
        const set = () => { top.style.clipPath = `inset(0 0 0 ${r.value}%)`; };
        r.oninput = set; set();
      }
      if (v === "diff") {
        const w = Math.max(ia.naturalWidth, ib.naturalWidth), h = Math.max(ia.naturalHeight, ib.naturalHeight);
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, w, h);
        g.clearRect(0, 0, w, h); g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, w, h);
        const out = g.createImageData(w, h);
        let n = 0;
        for (let i = 0; i < da.data.length; i += 4) {
          const diff = Math.abs(da.data[i] - db.data[i]) + Math.abs(da.data[i + 1] - db.data[i + 1]) + Math.abs(da.data[i + 2] - db.data[i + 2]) + Math.abs(da.data[i + 3] - db.data[i + 3]);
          const grey = (db.data[i] + db.data[i + 1] + db.data[i + 2]) / 3;
          if (diff > 24) { n++; out.data[i] = 255; out.data[i + 1] = 40; out.data[i + 2] = 80; out.data[i + 3] = 255; }
          else { out.data[i] = out.data[i + 1] = out.data[i + 2] = 200 + grey / 5; out.data[i + 3] = 255; }
        }
        g.putImageData(out, 0, 0);
        px = n;
        view.innerHTML = "";
        c.className = "dfi-canvas";
        view.appendChild(c);
        info.textContent = `${ia.naturalWidth}×${ia.naturalHeight} → ${ib.naturalWidth}×${ib.naturalHeight} · ${n ? `${n.toLocaleString()} pixels differ (${((n / (w * h)) * 100).toFixed(2)}%)` : "identical pixels"}`;
      }
    };
    body.querySelector(".dfi-bar").onclick = (e) => { const v = e.target.closest("button")?.dataset.v; if (v) mode(v); };
    mode("side");
    const same = A.bytes.length === B.bytes.length && A.bytes.every((x, i) => x === B.bytes[i]);
    $(".dfx-sum", d).innerHTML = same ? `<span class="dfx-same">✓ The files are identical</span>` : `<span class="dfx-n">The pictures differ</span>`;
    void px;
  });
}

function showBinary(d, A, B) {
  const body = $(".dfx-body", d);
  const a = A.bytes, b = B.bytes;
  let first = -1;
  if (a && b) { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) { first = i; break; } if (first < 0 && a.length !== b.length) first = n; }
  const same = a && b && first < 0;
  const hex = (u, from) => { if (!u) return ""; let s = ""; for (let r = 0; r < 8; r++) { const o = from + r * 16; if (o >= u.length) break; const row = [...u.slice(o, o + 16)]; s += o.toString(16).padStart(8, "0") + "  " + row.map((x) => x.toString(16).padStart(2, "0")).join(" ").padEnd(48) + "  " + row.map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : ".")).join("") + "\n"; } return s; };
  const at = Math.max(0, (first >> 4 << 4) - 32);
  body.innerHTML = `<div class="dfx-bin">
    <p>${same ? "✓ The two files are byte-for-byte identical." : `The files differ${first >= 0 ? ` from byte ${first.toLocaleString()} (0x${first.toString(16)})` : ""}.`}</p>
    <table><tr><th></th><th>Size</th></tr><tr><td>${esc(basename(current.a.path))}</td><td>${(A.size ?? a?.length ?? 0).toLocaleString()} bytes</td></tr><tr><td>${esc(basename(current.b.path))}</td><td>${(B.size ?? b?.length ?? 0).toLocaleString()} bytes</td></tr></table>
    ${!same && a && b ? `<div class="dfx-hex"><pre>${esc(hex(a, at))}</pre><pre>${esc(hex(b, at))}</pre></div>` : ""}
    <p class="note">These files aren't text, so they're compared byte by byte.</p></div>`;
  $(".dfx-sum", d).innerHTML = same ? `<span class="dfx-same">✓ Identical</span>` : `<span class="dfx-n">Different</span>`;
}

// ------------------------------------------------------------------ folders
let folderState = null;
async function compareFolders(a, b, ws) {
  const d = resultDialog();
  $(".dfx-a", d).textContent = basename(a) + "/"; $(".dfx-b", d).textContent = basename(b) + "/";
  $(".dfx-tools", d).hidden = true; $(".dfx-back", d).hidden = true; $(".dfx-note", d).textContent = "";
  const body = $(".dfx-body", d);
  body.innerHTML = `<div class="dfx-loading"><span class="big-spinner"></span> Comparing the folders…</div>`;
  if (!d.open) d.showModal();
  let list;
  try { list = await api.compareDirs(a, b); } catch (e) { body.innerHTML = `<div class="dfx-empty">⚠ ${esc(e.message || e)}</div>`; return; }
  folderState = { a, b, ws, list, show: new Set(["changed", "left", "right"]) };
  showFolder(folderState);
}
function showFolder(st) {
  const d = resultDialog();
  const body = $(".dfx-body", d);
  $(".dfx-a", d).textContent = basename(st.a) + "/"; $(".dfx-b", d).textContent = basename(st.b) + "/";
  $(".dfx-tools", d).hidden = true; $(".dfx-back", d).hidden = true; $(".dfx-note", d).textContent = "";
  const n = (s) => st.list.filter((x) => x.state === s).length;
  $(".dfx-sum", d).innerHTML = n("changed") + n("left") + n("right") ? `<span class="dfx-n">${n("changed")} changed</span> <span class="dfx-del">${n("left")} only left</span> <span class="dfx-add">${n("right")} only right</span>` : `<span class="dfx-same">✓ The folders have the same files</span>`;
  const label = { changed: "Changed", left: "Only in left", right: "Only in right", same: "Same" };
  body.innerHTML = `<div class="dff-bar">${["changed", "left", "right", "same"].map((s) => `<label class="check"><input type="checkbox" data-s="${s}" ${st.show.has(s) ? "checked" : ""}/> <span class="dff-dot ${s}"></span>${label[s]} (${n(s)})</label>`).join("")}</div>
    <div class="dff-list">${st.list.filter((x) => st.show.has(x.state)).slice(0, 5000).map((x) => `<div class="dff-row ${x.state}" data-rel="${esc(x.rel)}" title="${x.state === "changed" ? "Show the differences" : ""}"><span class="dff-dot ${x.state}"></span><span class="dff-rel">${esc(x.rel)}</span><span class="dff-size">${x.state === "right" ? "" : fmtSize(x.sizeA)}</span><span class="dff-size">${x.state === "left" ? "" : fmtSize(x.sizeB)}</span></div>`).join("") || `<div class="dfx-empty">Nothing to show</div>`}</div>`;
  body.querySelector(".dff-bar").onchange = (e) => { const s = e.target.dataset.s; if (e.target.checked) st.show.add(s); else st.show.delete(s); showFolder(st); };
  body.querySelector(".dff-list").onclick = (e) => {
    const row = e.target.closest(".dff-row");
    if (!row) return;
    const rel = row.dataset.rel, sep = st.a.includes("\\") ? "\\" : "/";
    const pa = st.a.replace(/[\\/]+$/, "") + sep + rel.replace(/\//g, sep), pb = st.b.replace(/[\\/]+$/, "") + sep + rel.replace(/\//g, sep);
    if (row.classList.contains("changed") || row.classList.contains("same")) compareFiles({ path: pa, isDir: false }, { path: pb, isDir: false }, st.ws, st);
    else openPath(row.classList.contains("left") ? pa : pb);
  };
}
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// tools in the result window
document.addEventListener("click", async (e) => {
  const d = $("#dlg-diff");
  if (!d || !d.contains(e.target)) return;
  const a = e.target.closest("[data-a]")?.dataset.a;
  if (a === "close") d.close();
  if (!current) return;
  if (a === "next") jump(1);
  if (a === "prev") jump(-1);
  if (a === "side" || a === "inline") showText(d, a);
  if (a === "fold") { e.target.closest("button").classList.toggle("on"); showText(d, current.layout); }
  if (a === "save") saveRight();
});
document.addEventListener("keydown", (e) => {
  const d = $("#dlg-diff");
  if (!d?.open || !current?.mv) return;
  if (e.key === "F7") { e.preventDefault(); jump(e.shiftKey ? -1 : 1); }
});

async function saveRight() {
  const { b, B, mv } = current;
  if (!mv?.b) return;
  const text = mv.b.state.doc.toString();
  const ok = await ask({ title: "Save the right file?", text: `Save the changes you copied into ${basename(b.path)}?`, buttons: [{ label: "Cancel", value: null }, { label: "Save", value: "ok", primary: true }] });
  if (!ok) return;
  try {
    await api.writeText(b.path, B.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text, B.encoding, B.mtime);
    await reloadFromDisk([b.path], false, "Changes copied in Compare");
    $('[data-a="save"]', resultDialog()).hidden = true;
    toast(`Saved ${basename(b.path)}`, "ok", 2500);
  } catch (e) { toast(`Couldn't save: ${e.message}`, "err"); }
}
void call;
