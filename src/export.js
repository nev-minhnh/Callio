// Export as PDF. Markdown → self-contained HTML → Microsoft Edge prints it (bookmarks from
// headings, clickable links, selectable text, images at full resolution). LaTeX → the compiled
// PDF (compiling first if needed), with a check that it has bookmarks.
import { api, call } from "./api.js";
import { settings, updateSettings, toast, status, ask, basename, dirname, compileFresh, rootFor, saveTab } from "./main.js";

const $ = (s) => document.querySelector(s);

/** Show the dialog; resolves with the options, or null if cancelled. */
function dialog(kind, note) {
  const dlg = $("#dlg-export");
  $("#exp-note").textContent = note;
  $("#exp-md-opts").hidden = kind !== "md" && kind !== "text";
  for (const el of document.querySelectorAll(".exp-md-only")) el.hidden = kind !== "md";
  $("#exp-lines-row").hidden = kind !== "text";
  $("#exp-lines").checked = !!settings.exportLines;
  $("#exp-size").value = settings.exportSize || "A4";
  $("#exp-margin").value = settings.exportMargin || "18mm 16mm";
  $("#exp-toc").checked = settings.exportToc !== false;
  $("#exp-num").checked = !!settings.exportNumber;
  $("#exp-open").checked = settings.exportOpen !== false;
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); resolve(v); };
    $("#exp-close").onclick = $("#exp-cancel").onclick = () => done(null);
    $("#exp-go").onclick = () => {
      const o = { size: $("#exp-size").value, margin: $("#exp-margin").value, toc: $("#exp-toc").checked, number: $("#exp-num").checked, open: $("#exp-open").checked, lines: $("#exp-lines").checked };
      updateSettings({ exportSize: o.size, exportMargin: o.margin, exportToc: o.toc, exportNumber: o.number, exportOpen: o.open, exportLines: o.lines });
      done(o);
    };
    dlg.addEventListener("cancel", () => resolve(null), { once: true });
    dlg.showModal();
  });
}

const pdfName = (p) => basename(p).replace(/\.[^.]+$/, "") + ".pdf";

export async function exportPdf(t) {
  if (t.kind === "md") return exportMarkdown(t);
  if (t.kind === "tex") return exportTex(t);
  if (t.kind === "ipynb") return exportNotebook(t);
  if (t.kind === "pdf") {
    const out = await api.pickSaveFile(basename(t.path), dirname(t.path));
    if (out) { await call("export_copy_pdf", { src: t.path, out }); toast(`Saved ${basename(out)}`, "ok", 3000); }
    return;
  }
  return exportText(t);
}

// ---------------- plain text, code, BibTeX… ----------------
const escHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
async function exportText(t) {
  const o = await dialog("text", "The text is printed as it is, wrapped to the page, with line numbers if you like.");
  if (!o) return;
  const name = t.path || t.name;
  const out = await api.pickSaveFile(pdfName(name), t.path ? dirname(t.path) : null);
  if (!out) return;
  status("Exporting PDF…");
  try {
    const text = t.state.doc.toString();
    const ext = (name.split(".").pop() || "").toLowerCase();
    let body;
    if (t.kind === "csv") {
      // a table, the first row as titles when the table view shows it so
      const { parseCsv } = await import("./csvtable.js");
      const { rows, width } = parseCsv(text, t.delim || ",");
      const cell = (v, tag) => `<${tag}>${escHtml(v ?? "").replace(/\n/g, "<br>")}</${tag}>`;
      const head = t.csvHeader && rows.length ? `<thead><tr>${Array.from({ length: width }, (_, i) => cell(rows[0].cells[i], "th")).join("")}</tr></thead>` : "";
      const bodyRows = (t.csvHeader ? rows.slice(1) : rows).map((r) => `<tr>${Array.from({ length: width }, (_, i) => cell(r.cells[i], "td")).join("")}</tr>`).join("");
      body = `<table class="csv">${head}<tbody>${bodyRows}</tbody></table>`;
    } else {
    const hl = await import("highlight.js/lib/common").then((m) => m.default).catch(() => null);
    const lang = hl && ext && hl.getLanguage(ext) ? ext : null;
    const code = lang ? hl.highlight(text, { language: lang, ignoreIllegals: true }).value : escHtml(text);
    if (o.lines) {
      const lines = code.split("\n");
      body = `<table class="code-lines">${lines.map((l, i) => `<tr><td class="ln">${i + 1}</td><td class="lc">${l || " "}</td></tr>`).join("")}</table>`;
    } else body = `<pre class="plain">${code}</pre>`;
    }
    const title = basename(name);
    const css = await hlCss();
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title><style>
${css}
@page { size: ${o.size}; margin: ${o.margin}; }
body { margin: 0; color: #1f2328; font: 10pt/1.45 Consolas, "Cascadia Mono", "DejaVu Sans Mono", monospace; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
h1.file { font: 600 11pt "Segoe UI", system-ui, sans-serif; margin: 0 0 10px; padding-bottom: 6px; border-bottom: 1px solid #ccc; }
pre.plain { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
table.code-lines { border-collapse: collapse; width: 100%; }
td.ln { color: #8b949e; text-align: right; padding-right: 10px; vertical-align: top; user-select: none; width: 1%; white-space: nowrap; }
td.lc { white-space: pre-wrap; overflow-wrap: anywhere; }
tr { break-inside: avoid; }
table.csv { border-collapse: collapse; font: 9pt/1.35 "Segoe UI", system-ui, sans-serif; }
table.csv th, table.csv td { border: 1px solid #c8ccd0; padding: 3px 6px; vertical-align: top; text-align: left; }
table.csv th { background: #eef1f4; font-weight: 600; }
table.csv thead { display: table-header-group; }
</style></head><body><h1 class="file">${escHtml(title)}</h1>${body}</body></html>`;
    await call("export_html_pdf", { html, out });
    status(`Exported ${basename(out)}`, "ok");
    if (o.open) api.openPath(out); else toast(`Saved ${basename(out)}`, "ok", 3000);
  } catch (e) { status("Export failed", "err"); toast(`Export failed: ${e.message}`, "err", 8000); }
}
async function hlCss() {
  let out = "";
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const r of rules) if (/\.hljs/.test(r.selectorText || "")) out += r.cssText + "\n";
  }
  // print in light colours whatever the app theme
  return out.replace(/:root\[data-theme="dark"\][^{]*\{[^}]*\}/g, "");
}

// ---------------- Jupyter notebook ----------------
async function exportNotebook(t) {
  const o = await dialog("md", "Cells are printed with their outputs (text, tables, images); headings become bookmarks.");
  if (!o) return;
  const out = await api.pickSaveFile(pdfName(t.path || t.name), t.path ? dirname(t.path) : null);
  if (!out) return;
  status("Exporting PDF…");
  try {
    const nb = await import("./notebook.js");
    const md = await import("./md.js");
    const body = await nb.notebookHtml(t.state.doc.toString(), t.path ? dirname(t.path) : "", md);
    const doc = await buildDocument(body, basename(t.path || t.name).replace(/\.[^.]+$/, ""), o);
    await call("export_html_pdf", { html: doc, out });
    status(`Exported ${basename(out)}`, "ok");
    if (o.open) api.openPath(out); else toast(`Saved ${basename(out)}`, "ok", 3000);
  } catch (e) { status("Export failed", "err"); toast(`Export failed: ${e.message}`, "err", 8000); }
}

// ---------------- Markdown ----------------
async function exportMarkdown(t) {
  const o = await dialog("md", "Headings become PDF bookmarks, links stay clickable and images keep their full resolution.");
  if (!o) return;
  if (t.dirty && t.path) await saveTab(t);
  const out = await api.pickSaveFile(pdfName(t.path || t.name), t.path ? dirname(t.path) : null);
  if (!out) return;
  status("Exporting PDF…");
  try {
    const md = await import("./md.js");
    const text = t.state.doc.toString();
    const dir = t.path ? dirname(t.path) : "";
    let { html } = md.renderForExport(text, dir, { toc: o.toc, number: o.number });
    // citations ([@key]) with the chosen style, when the library module is loaded
    try { html = await (await import("./cite.js")).renderCitationsHtml(html, text, t); } catch (e) { if (!/not available/.test(e.message)) console.warn(e); }
    const doc = await buildDocument(html, basename(t.path || t.name).replace(/\.[^.]+$/, ""), o);
    await call("export_html_pdf", { html: doc, out });
    status(`Exported ${basename(out)}`, "ok");
    if (o.open) api.openPath(out);
    else toast(`Saved ${basename(out)}`, "ok", 3000);
  } catch (e) {
    status("Export failed", "err");
    toast(`Export failed: ${e.message}`, "err", 8000);
  }
}

let cssCache = null;
/** The preview's CSS (Markdown, KaTeX, code highlighting) with KaTeX fonts inlined. */
async function exportCss() {
  if (cssCache) return cssCache;
  const parts = [];
  let lightVars = "";
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const r of rules) {
      const txt = r.cssText;
      if (!lightVars && r.selectorText === ":root") { lightVars = txt; continue; }
      if (r instanceof CSSFontFaceRule) {
        if (/KaTeX/.test(txt)) parts.push(await inlineFonts(txt, sheet.href || location.href));
        continue;
      }
      if (/\.markdown-body|\.katex|\.hljs|\.table-wrap/.test(r.selectorText || "") || (r.media && /markdown-body|katex|hljs/.test(txt))) parts.push(txt);
    }
  }
  cssCache = lightVars + "\n" + parts.join("\n");
  return cssCache;
}
async function inlineFonts(txt, base) {
  const urls = [...txt.matchAll(/url\(["']?([^"')]+\.woff2)["']?\)/g)].map((m) => m[1]);
  for (const u of urls) {
    try {
      const b = await (await fetch(new URL(u, base))).blob();
      const data = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
      txt = txt.split(u).join(data);
    } catch {}
  }
  // only the woff2 source is needed
  return txt.replace(/,\s*url\([^)]*\.(woff|ttf)[^)]*\)\s*format\([^)]*\)/g, "");
}

async function buildDocument(body, title, o) {
  const css = await exportCss();
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
${css}
@page { size: ${o.size}; margin: ${o.margin}; }
html, body { background: #fff; margin: 0; }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.markdown-body { max-width: none !important; padding: 0 !important; zoom: 1 !important; font-size: 11pt; color: #1f2328; background: #fff; }
.markdown-body img { max-width: 100%; height: auto; image-rendering: auto; break-inside: avoid; }
.markdown-body pre, .markdown-body blockquote, .markdown-body .katex-display, .markdown-body tr, .markdown-body figure { break-inside: avoid; }
.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 { break-after: avoid; }
.markdown-body .table-wrap { overflow: visible !important; }
.markdown-body pre { white-space: pre-wrap; word-break: break-word; }
.markdown-body a { color: #0b57d0; }
.toc { break-after: page; margin: 0 0 1em; }
.toc ul { list-style: none; padding: 0; margin: 0; }
.toc li { margin: .25em 0; }
.toc .toc-l1 { padding-left: 1.4em; } .toc .toc-l2 { padding-left: 2.8em; font-size: .95em; }
.toc a { color: inherit; text-decoration: none; }
.hnum { color: #57606a; margin-right: .35em; }
</style></head><body><article class="markdown-body">${body}</article></body></html>`;
}

// ---------------- LaTeX ----------------
const LOADS_HYPERREF = /\\documentclass(\[[^\]]*\])?\{(beamer|acmart|elsarticle|lipics-v2021|lipics|aastex\d*|amsbook)\}/;

async function exportTex(t) {
  const root = await rootFor(t);
  if (!root) return toast("Couldn't find the main .tex file.", "err");
  const o = await dialog("tex", "The compiled PDF is exported as it is: its bookmarks, links, index and images are kept exactly as LaTeX produced them.");
  if (!o) return;
  const { readDoc, writeDoc } = await import("./cite.js");
  // bookmarks need hyperref (or bookmark); offer to add it
  try {
    const { text: src } = await readDoc(root);
    if (src && !/\\usepackage(\[[^\]]*\])?\{[^}]*\b(hyperref|bookmark)\b/.test(src) && !LOADS_HYPERREF.test(src) && /\\begin\{document\}/.test(src) && /\\(section|chapter)\b/.test(src)) {
      const r = await ask({ title: "Add PDF bookmarks?", text: "This document doesn't load hyperref, so its PDF has no bookmarks (the side menu) and no clickable references. Callio can add \\usepackage{hyperref} to the preamble (a version is saved first).", buttons: [{ label: "Export as it is", value: "no" }, { label: "Add hyperref", value: "yes", primary: true }] });
      if (r === null) return;
      if (r === "yes") {
        const line = "\\usepackage[hidelinks,bookmarksnumbered]{hyperref}\n";
        // hyperref goes before cleveref, otherwise last in the preamble
        const m = /\\usepackage(\[[^\]]*\])?\{cleveref\}/.exec(src);
        const next = m ? src.slice(0, m.index) + line + src.slice(m.index) : src.replace(/\\begin\{document\}/, line + "\\begin{document}");
        await writeDoc(root, next, "adding hyperref");
      }
    }
  } catch (e) { return toast(e.message, "err", 6000); }
  // always export a PDF compiled from what is in the editor now
  status("Compiling before export…");
  const res = await compileFresh();
  if (!res?.pdf) return toast("The document didn't compile, so there is no PDF to export. See the log (Ctrl+Enter).", "err", 7000);
  const errs = (res.diagnostics || []).filter((d) => d.severity === "error").length;
  if (!res.ok || errs) {
    const r = await ask({ title: "Compiled with errors", text: `LaTeX reported ${errs || "some"} error(s); the PDF may be incomplete. Export it anyway?`, buttons: [{ label: "Cancel", value: null }, { label: "Export anyway", value: "y", primary: true }] });
    if (!r) return;
  }
  const out = await api.pickSaveFile(pdfName(root), dirname(root));
  if (!out) return;
  try {
    await call("export_copy_pdf", { src: res.pdf, out });
    status(`Exported ${basename(out)}`, "ok");
    if (o.open) api.openPath(out); else toast(`Saved ${basename(out)}`, "ok", 3000);
  } catch (e) { toast(e.message, "err", 6000); }
}
