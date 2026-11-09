// "Convert to Word / Markdown to edit" for PDFs (file list, tab menu, PDF tools): the result is
// written next to the PDF (a free name, nothing is overwritten) and opened for editing.
import { api, call } from "./api.js";
import { status, basename, dirname, openPath, refreshTree, folder } from "./main.js";
import { loading } from "./loading.js";

const stem = (n) => n.replace(/\.[^.]+$/, "");
const join = (dir, name) => dir.replace(/[\\/]+$/, "") + (dir.includes("\\") ? "\\" : "/") + name;

async function freePath(dir, base, ext) {
  for (let i = 1; i < 500; i++) {
    const p = join(dir, `${base}${i > 1 ? ` (${i})` : ""}.${ext}`);
    const info = await call("path_info", { path: p }).catch(() => null);
    if (!info?.exists) return p;
  }
  return join(dir, `${base}-${Date.now()}.${ext}`);
}

async function pdfMarkdown(path, imageMode, ld) {
  const conv = await import("./convert/index.js");
  ld.set(null, `Reading ${basename(path)}…`);
  const bytes = new Uint8Array(await api.readBinary(path));
  let ocr;
  try { ocr = await (await import("./ocr.js")).pageOcr(); } catch {}
  return conv.toMarkdown({
    name: basename(path), bytes, ocr: ocr || undefined, imageMode,
    onProgress: (d, n, label) => ld.set(n ? d / n : null, `Converting ${basename(path)}…`, label || `Page ${d} of ${n}`),
  });
}

/** PDF → Word (.docx, with its pictures and tables), opened for editing. */
export async function pdfToWord(path, fmt = "docx", { open = true } = {}) {
  const ld = loading(`Converting ${basename(path)} to Word…`, { delay: 0 });
  try {
    const res = await pdfMarkdown(path, "embed", ld);
    ld.set(0.95, "Building the Word document…", "");
    const { office } = await import("./office.js");
    const out = await freePath(dirname(path), stem(basename(path)), fmt);
    const r = await office("doc.fromText", { text: res.markdown, kind: "md", dir: dirname(path) });
    try { await office("doc.save", { id: r.id, out }); }
    finally { office("doc.close", { id: r.id }).catch(() => {}); }
    ld.done();
    status(`Converted to ${basename(out)}`, "ok");
    if (folder) refreshTree();
    if (open) await openPath(out);
    return out;
  } catch (e) {
    ld.done();
    status(`Couldn't convert ${basename(path)} to Word: ${e.message || e}`, "err");
    return null;
  }
}

/** PDF → Markdown (pictures in "<name>_files/"), opened for editing. */
export async function pdfToMarkdown(path, { open = true } = {}) {
  const ld = loading(`Converting ${basename(path)} to Markdown…`, { delay: 0 });
  try {
    const res = await pdfMarkdown(path, "files", ld);
    const out = await freePath(dirname(path), stem(basename(path)), "md");
    let md = res.markdown;
    if (res.images?.length) {
      const folderName = `${stem(basename(out))}_files`;
      md = md.replace(/\]\(([^)\s]*?)_files\//g, `](${encodeURI(folderName)}/`);
      let k = 0;
      for (const img of res.images) {
        ld.set(++k / res.images.length, "Saving the pictures…", `${k} of ${res.images.length}`);
        await api.writeBinary(join(join(dirname(out), folderName), img.name.split("/").pop()), img.bytes, 0, false);
      }
    }
    await api.writeText(out, md, "utf8", 0);
    ld.done();
    status(`Converted to ${basename(out)}${res.images?.length ? ` (${res.images.length} picture${res.images.length > 1 ? "s" : ""})` : ""}`, "ok");
    if (folder) refreshTree();
    if (open) await openPath(out);
    return out;
  } catch (e) {
    ld.done();
    status(`Couldn't convert ${basename(path)} to Markdown: ${e.message || e}`, "err");
    return null;
  }
}
