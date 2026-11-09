// Save ▾ → Export as Markdown (the open file) and → Convert a file to Markdown (any file):
// Word, Excel, PowerPoint, OpenDocument, PDF (scanned pages via OCR), LaTeX, notebooks,
// HTML, CSV, text and code. Pure JavaScript (src/convert), Docling-style output.
// Pictures are saved next to the Markdown in "<name>_files/".
import { api, call } from "./api.js";
import { settings, toast, status, ask, basename, dirname, openPath, openNewDoc, folder, getLastPdf } from "./main.js";

const stem = (n) => n.replace(/\.[^.]+$/, "");

async function convert(name, bytes, { ocr = true } = {}) {
  const conv = await import("./convert/index.js");
  const isPdf = /\.pdf$/i.test(name), isImg = /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i.test(name);
  let ocrFn;
  if (ocr && (isPdf || isImg)) {
    // scanned pages / pictures go to the OCR engine chosen in Settings → OCR, if one is ready
    const o = await import("./ocr.js");
    ocrFn = await o.pageOcr().catch(() => null);
  }
  status(`Converting ${name} to Markdown…`);
  const res = await conv.toMarkdown({ name, bytes, ocr: ocrFn || undefined, imageMode: "files", onProgress: (d, n, label) => status(label || `Converting… ${d}/${n}`) });
  return res;
}

/** Write the Markdown (and its pictures) and open it. Without a place to save: an unsaved tab. */
async function deliver(name, res, near) {
  const mdName = stem(name) + ".md";
  if (res.warnings?.length) console.info("convert warnings", res.warnings);
  const out = await api.pickSaveFile(mdName, near || folder);
  if (!out) {
    // still show it — pictures stay as placeholders until it's saved somewhere
    const md = res.images?.length ? res.markdown.replace(/!\[([^\]]*)\]\([^)]*_files\/[^)]*\)/g, "<!-- image -->") : res.markdown;
    await openNewDoc(mdName, md);
    return;
  }
  const dir = dirname(out), outStem = stem(basename(out));
  let md = res.markdown;
  if (res.images?.length) {
    const folderName = `${outStem}_files`;
    // the converter names them "<input stem>_files/…": point them at the chosen name
    md = md.replace(/\]\(([^)\s]*?)_files\//g, `](${encodeURI(folderName)}/`);
    for (const img of res.images) await api.writeBinary(`${dir}/${folderName}/${img.name.split("/").pop()}`, img.bytes, 0);
  }
  await api.writeText(out, md, "utf8", 0);
  await openPath(out);
  status(`Saved ${basename(out)}${res.images?.length ? ` and ${res.images.length} picture(s)` : ""}`, "ok");
  if (res.warnings?.length) toast(res.warnings.slice(0, 3).join("\n"), "", 7000);
}

// Word documents and spreadsheets go through the office engine: headings,
// lists, tables, footnotes, links, pictures and formatting come out as Markdown.
const OFFICE = /\.(docx|docm|dotx|dotm|doc|dot|odt|ott|fodt|rtf|xlsx|xlsm|xltx|xls|xlsb|ods)$/i;
async function viaOffice(path, near) {
  const out = await api.pickSaveFile(stem(basename(path)) + ".md", near || dirname(path));
  if (!out) return;
  status(`Converting ${basename(path)} to Markdown…`);
  const { office } = await import("./office.js");
  const r = await office("convert", { input: path, out });
  await openPath(out);
  status(`Saved ${basename(out)}${r.images ? ` and ${r.images} picture(s)` : ""}`, "ok");
}

export async function exportMarkdown(t) {
  try {
    if (t && (t.kind === "doc" || t.kind === "sheet")) return await viaOffice(t.path);
    if (!t) {
      const path = await api.pickConvertFile(folder);
      if (!path) return;
      if (OFFICE.test(path)) return await viaOffice(path);
      const bytes = new Uint8Array(await api.readBinary(path));
      return await deliver(basename(path), await convert(basename(path), bytes), dirname(path));
    }
    const near = t.path ? dirname(t.path) : folder;
    const name = t.path ? basename(t.path) : t.name;
    if (t.kind === "md") {
      // already Markdown: save a copy
      const out = await api.pickSaveFile(stem(name) + ".md", near);
      if (!out) return;
      await api.writeText(out, t.state.doc.toString(), "utf8", 0);
      return status(`Saved ${basename(out)}`, "ok");
    }
    if (t.kind === "pdf") {
      const bytes = new Uint8Array(await api.readBinary(t.path));
      return await deliver(name, await convert(name, bytes), near);
    }
    if (t.kind === "tex") {
      const pdf = getLastPdf()?.path;
      const r = await ask({ title: "Export LaTeX as Markdown", text: "Convert the LaTeX source (math kept as LaTeX, citations as [@key]) or the compiled PDF (what the reader sees)?", buttons: [{ label: "Cancel", value: null }, ...(pdf ? [{ label: "Compiled PDF", value: "pdf" }] : []), { label: "LaTeX source", value: "src", primary: true }] });
      if (!r) return;
      if (r === "pdf") return await deliver(name, await convert(basename(pdf), new Uint8Array(await api.readBinary(pdf)), { ocr: false }), near);
    }
    // everything else from the editor's current text (unsaved edits included)
    const bytes = new TextEncoder().encode(t.state.doc.toString());
    return await deliver(name, await convert(name, bytes), near);
  } catch (e) {
    status("Conversion failed", "err");
    toast(`Couldn't convert to Markdown: ${e.message}`, "err", 9000);
  }
}
