// Word documents (.docx, .doc, .odt, .rtf) through the office engine (WordCraft): shown as their
// pages (real text — select, find, copy), exported to PDF / Word / OpenDocument / RTF / HTML /
// Markdown / LaTeX, or opened as Markdown to edit. Spreadsheets live in sheet.js, PDF tools in
// pdftools.js; all three talk to callio-office.exe through `office()`.
import { call } from "./api.js";
import { toast, status, ask, basename, dirname, openPath, openNewDoc, folder } from "./main.js";
import { api } from "./api.js";

export const DOC_EXT = ["docx", "docm", "dotx", "dotm", "doc", "dot", "odt", "ott", "fodt", "rtf"];
export const DECK_EXT = ["pptx", "pptm", "ppsx", "ppsm", "potx", "potm", "odp"];
export const SHEET_EXT = ["xlsx", "xlsm", "xltx", "xltm", "xls", "xlsb", "ods", "csv", "tsv"];
export const extOf = (p) => (p || "").toLowerCase().split(".").pop();

/** Ask the office engine. A password-protected file asks for its password once. */
export async function office(cmd, args = {}, { password = true } = {}) {
  try {
    return await call("office", { cmd, args });
  } catch (e) {
    const m = e.message || String(e);
    if (password && m.startsWith("PASSWORD:") && (args.path !== undefined || args.input !== undefined)) {
      const name = basename(args.path || args.input || "");
      const pw = await ask({ title: "Password", text: `${name} is protected. Its password:`, input: "", password: true });
      if (pw == null) throw new Error("Cancelled");
      return office(cmd, { ...args, password: pw }, { password: true });
    }
    throw new Error(m.replace(/^PASSWORD:\s*/, ""));
  }
}

// ---------------- documents ----------------
/** Open (or reopen) the document of tab `t` in the engine and render its pages to a PDF. */
export async function renderDoc(t, { reopen = false } = {}) {
  status(`Opening ${t.name}…`);
  if (!t.officeId || reopen) {
    const r = await office("doc.open", { path: t.path });
    t.officeId = r.id;
    t.docInfo = r.info;
  }
  const out = await call("office_temp", { name: basename(t.path) + ".pdf" });
  try {
    await office("doc.pdf", { id: t.officeId, out });
  } catch (e) {
    if (/closed/.test(e.message) && !reopen) return renderDoc(t, { reopen: true });
    throw e;
  }
  t.render = out;
  status(`${t.name}: ${t.docInfo?.words ?? "?"} words`, "ok");
  return out;
}

export async function closeDoc(t) {
  if (t.officeId) office("doc.close", { id: t.officeId }).catch(() => {});
  if (t.wordId) office("word.close", { id: t.wordId }).catch(() => {});
  if (t.sheetId) office("sheet.close", { id: t.sheetId }).catch(() => {});
}

const FORMATS = [
  ["pdf", "PDF (real text, links, bookmarks)"],
  ["docx", "Word document (.docx)"],
  ["odt", "OpenDocument text (.odt)"],
  ["rtf", "Rich Text (.rtf)"],
  ["html", "Web page (.html)"],
  ["md", "Markdown (.md, pictures alongside)"],
  ["tex", "LaTeX (.tex)"],
  ["txt", "Plain text (.txt)"],
];

/** Save a document tab as another format (the original file is never changed). */
export async function exportDoc(t, fmt) {
  if (!fmt) {
    fmt = await ask({ title: `Export ${t.name}`, text: "Save a copy as:", buttons: [{ label: "Cancel", value: null }, ...FORMATS.map(([v, l]) => ({ label: l, value: v }))], vertical: true });
    if (!fmt) return;
  }
  const stem = basename(t.path).replace(/\.[^.]+$/, "");
  const out = await api.pickSaveFile(`${stem}.${fmt}`, dirname(t.path));
  if (!out) return;
  try {
    status(`Saving ${basename(out)}…`);
    // the document as it is now in the editor (unsaved changes included)
    if (t.wordId) await office("word.save", { id: t.wordId, out });
    else {
      if (!t.officeId) await renderDoc(t);
      await office("doc.save", { id: t.officeId, out });
    }
    status(`Saved ${basename(out)}`, "ok");
    toast(`Saved ${basename(out)}`, "ok", 3000);
    if (fmt === "md" || fmt === "tex" || fmt === "html" || fmt === "txt") await openPath(out);
  } catch (e) { status("Export failed", "err"); toast(`Couldn't save ${basename(out)}: ${e.message}`, "err", 8000); }
}

/** The document as Markdown in a new tab (pictures saved next to it once it's saved). */
export async function editAsMarkdown(t) {
  try {
    const stem = basename(t.path).replace(/\.[^.]+$/, "");
    const near = dirname(t.path);
    const out = await api.pickSaveFile(`${stem}.md`, near);
    if (!out) return;
    if (t.wordId) await office("word.save", { id: t.wordId, out });
    else {
      if (!t.officeId) await renderDoc(t);
      await office("doc.save", { id: t.officeId, out });
    }
    await openPath(out);
  } catch (e) { toast(`Couldn't convert ${t.name}: ${e.message}`, "err", 8000); }
}

/** Markdown / LaTeX / HTML text from the editor → Word, OpenDocument, RTF (or PDF via WordCraft). */
export async function exportTextAs(t, fmt) {
  const kind = t.kind === "tex" ? "tex" : t.kind === "md" ? "md" : (extOf(t.path || t.name) === "html" ? "html" : "txt");
  const stem = basename(t.path || t.name).replace(/\.[^.]+$/, "");
  const out = await api.pickSaveFile(`${stem}.${fmt}`, t.path ? dirname(t.path) : folder);
  if (!out) return;
  try {
    status(`Saving ${basename(out)}…`);
    let text = t.state.doc.toString(), k = kind;
    // a CSV/TSV becomes a Word table
    if (t.kind === "csv") { text = (await import("./csvtable.js")).toMarkdownTable(text, t.delim || ","); k = "md"; }
    const r = await office("doc.fromText", { text, kind: k, dir: t.path ? dirname(t.path) : null });
    await office("doc.save", { id: r.id, out });
    office("doc.close", { id: r.id }).catch(() => {});
    status(`Saved ${basename(out)}`, "ok");
    toast(`Saved ${basename(out)}`, "ok", 3000);
  } catch (e) { status("Export failed", "err"); toast(`Couldn't save ${basename(out)}: ${e.message}`, "err", 8000); }
}

/** Any document or spreadsheet file → Markdown (used by "Convert a file to Markdown"). */
export async function convertFileToMarkdown(path, out) {
  return office("convert", { input: path, out });
}
