// "Export to Markdown": pure-JS, Docling-style document -> Markdown converters.
// Each format lives in its own module and is lazy-imported, so only what is used gets loaded.
import { ConvertError, cleanMarkdown, checkAbort, ImageSink, baseName } from "./util.js";

const CODE_LANGS = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx",
  py: "python", pyw: "python", r: "r", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
  scala: "scala", swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", fs: "fsharp", m: "matlab", jl: "julia", lua: "lua", pl: "perl", php: "php", sh: "bash",
  bash: "bash", zsh: "bash", fish: "fish", ps1: "powershell", bat: "batch", cmd: "batch", sql: "sql",
  json: "json", jsonc: "json", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini", cfg: "ini", conf: "ini",
  xml: "xml", svg: "xml", css: "css", scss: "scss", less: "less", vue: "vue", svelte: "svelte",
  dart: "dart", hs: "haskell", ml: "ocaml", ex: "elixir", exs: "elixir", erl: "erlang", clj: "clojure",
  lisp: "lisp", el: "lisp", scm: "scheme", vb: "vbnet", groovy: "groovy", gradle: "groovy", zig: "zig",
  nim: "nim", v: "verilog", sv: "systemverilog", vhd: "vhdl", vhdl: "vhdl", asm: "asm", s: "asm",
  makefile: "makefile", mk: "makefile", cmake: "cmake", dockerfile: "dockerfile", proto: "protobuf",
  graphql: "graphql", gql: "graphql", bib: "bibtex", sty: "latex", cls: "latex", diff: "diff", patch: "diff",
};

const FORMATS = {
  docx: ["docx", "dotx", "docm", "dotm"],
  xlsx: ["xlsx", "xlsm", "xltx", "xltm"],
  pptx: ["pptx", "pptm", "potx", "ppsx"],
  odf: ["odt", "ods", "odp", "ott", "ots", "otp"],
  html: ["html", "htm", "xhtml"],
  csv: ["csv", "tsv", "tab"],
  ipynb: ["ipynb"],
  latex: ["tex", "ltx", "latex"],
  pdf: ["pdf"],
  image: ["png", "jpg", "jpeg", "bmp", "tif", "tiff", "webp", "gif"],
  text: ["txt", "text", "md", "markdown", "mdown", "mkd", "rst", "log", "adoc", "org", ...Object.keys(CODE_LANGS)],
};
const LEGACY = { doc: "docx", xls: "xlsx", ppt: "pptx", rtf: "docx" };

export const CONVERTIBLE = [...new Set(Object.values(FORMATS).flat())];

export function formatOf(name) {
  const base = baseName(name).toLowerCase();
  if (base === "makefile" || base === "dockerfile") return "text";
  const ext = base.includes(".") ? base.split(".").pop() : "";
  for (const [k, list] of Object.entries(FORMATS)) if (list.includes(ext)) return k;
  return null;
}

export function canConvert(name) { return !!formatOf(name); }

function sniff(bytes) {
  const b = bytes;
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "pdf";
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return "ole";
  if (b[0] === 0x50 && b[1] === 0x4b) return "zip";
  if (b[0] === 0x7b && b[1] === 0x5c && b[2] === 0x72 && b[3] === 0x74) return "rtf";
  return null;
}

/**
 * Convert a document to Markdown.
 * @param {object} o
 * @param {string} o.name file name (extension selects the converter)
 * @param {Uint8Array} o.bytes file content
 * @param {(page:{canvas, blob, width, height, pageNumber}) => Promise<string|{width,height,lines}>} [o.ocr]
 *   may return Markdown/text, or a positioned-text page that is laid out like a PDF page
 * @param {"placeholder"|"embed"|"files"} [o.imageMode]
 * @param {(done:number, total:number, label?:string) => void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{markdown:string, images:{name:string, file:string, bytes:Uint8Array, mime:string}[], warnings:string[]}>}
 */
export async function toMarkdown({ name, bytes, ocr, imageMode = "placeholder", onProgress, signal } = {}) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes || []);
  name = baseName(name || "document");
  const ext = (name.toLowerCase().split(".").pop() || "");
  const warnings = [];
  const sig = sniff(bytes);
  if (LEGACY[ext] || sig === "ole" || (sig === "rtf" && ext !== "txt")) {
    const target = LEGACY[ext] || "docx/.xlsx/.pptx";
    throw new ConvertError(`“${name}” is a legacy binary ${ext ? "." + ext + " " : ""}file, which can't be converted directly. Open it in Word/Excel/PowerPoint (or LibreOffice) and save it as .${target}, then export again.`);
  }
  let fmt = formatOf(name);
  if (sig === "pdf") fmt = "pdf";
  if (!fmt) throw new ConvertError(`Unsupported file type: ${ext ? "." + ext : name}`);
  checkAbort(signal);
  const images = new ImageSink(imageMode, name);
  const ctx = { name, ext, bytes, ocr, images, warnings, signal, imageMode: images.mode, progress: (d, t, l) => onProgress?.(d, t, l), lang: CODE_LANGS[ext] || "" };
  let md;
  switch (fmt) {
    case "docx": md = await (await import("./docx.js")).convertDocx(ctx); break;
    case "xlsx": md = await (await import("./xlsx.js")).convertXlsx(ctx); break;
    case "pptx": md = await (await import("./pptx.js")).convertPptx(ctx); break;
    case "odf": md = await (await import("./odf.js")).convertOdf(ctx); break;
    case "html": md = await (await import("./html.js")).convertHtml(ctx); break;
    case "csv": md = await (await import("./csv.js")).convertCsv(ctx); break;
    case "ipynb": md = await (await import("./ipynb.js")).convertIpynb(ctx); break;
    case "latex": md = await (await import("./latex.js")).convertLatex(ctx); break;
    case "pdf": md = await (await import("./pdf.js")).convertPdf(ctx); break;
    case "image": md = await (await import("./image.js")).convertImage(ctx); break;
    default: md = await (await import("./text.js")).convertText(ctx);
  }
  checkAbort(signal);
  return { markdown: cleanMarkdown(md || ""), images: images.images, warnings: [...new Set(warnings)] };
}

export { ConvertError };

/**
 * Positioned text (e.g. OCR words/lines with pixel boxes, y down) -> Markdown, using the same
 * layout analysis as the PDF converter.
 * pages: [{ width, height, lines: [{ text, x, y, w, h, words?: [{ t, x, y, w, h }] }] }]
 */
export { layoutToMarkdown } from "./layout.js";
