// What a file is, from its name: the category drives the badge shown before every file name
// (tree, tabs, recent files) and how a click opens it.
const CAT = {
  md: ["md", "markdown", "mdown", "mkd", "mdx", "rmd", "qmd"],
  tex: ["tex", "sty", "cls", "ltx", "dtx", "tikz", "bst"],
  bib: ["bib", "ris", "enw"],
  pdf: ["pdf"],
  doc: ["docx", "docm", "dotx", "dotm", "doc", "dot", "odt", "ott", "fodt", "rtf", "pages"],
  sheet: ["xlsx", "xlsm", "xltx", "xltm", "xls", "xlsb", "ods", "numbers"],
  deck: ["pptx", "pptm", "ppsx", "ppsm", "potx", "potm", "odp", "ppt", "pps", "key"],
  data: ["csv", "tsv", "tab", "psv", "json", "jsonc", "json5", "jsonl", "ndjson", "geojson", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "sql", "parquet", "sqlite", "db"],
  diagram: ["mmd", "mermaid", "drawio", "dio", "vsdx", "vsd", "vsdm", "vss", "vssx", "dot", "gv", "puml", "plantuml"],
  image: ["jpg", "jpeg", "jpe", "jfif", "png", "tif", "tiff", "webp", "avif", "heic", "heif", "jxl", "bmp", "gif", "psd", "svg", "ico", "dng", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "rwl", "pef", "srw", "x3f", "3fr", "fff", "iiq", "erf", "mef", "mos", "kdc", "dcr", "eps", "ai"],
  video: ["mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "flv", "mpg", "mpeg", "m2ts", "mts", "ts", "3gp", "3g2", "ogv", "vob", "asf", "f4v", "divx", "rm", "rmvb"],
  audio: ["mp3", "wav", "flac", "m4a", "aac", "ogg", "oga", "opus", "wma", "aiff", "aif", "alac", "ape", "amr", "mid", "midi", "weba", "wv", "dsf", "ac3", "dts", "mka"],
  archive: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "zst", "lz", "lzma", "cab", "iso", "img", "arj", "lzh", "z", "wim", "apk", "jar", "war", "nupkg", "vhd", "vhdx", "dmg"],
  exe: ["exe", "msi", "msix", "msixbundle", "appx", "appxbundle", "bat", "cmd", "com", "scr", "ps1", "vbs", "vbe", "js_", "wsf", "jse", "lnk", "url", "reg", "cpl", "hta", "pif", "application", "appref-ms", "jnlp"],
  code: ["py", "ipynb", "r", "jl", "m", "js", "mjs", "cjs", "ts", "tsx", "jsx", "c", "h", "cpp", "hpp", "cc", "cs", "java", "kt", "go", "rs", "rb", "php", "swift", "scala", "lua", "pl", "sh", "bash", "zsh", "ps1xml", "html", "htm", "css", "scss", "less", "vue", "svelte", "dart", "hs", "ml", "f90", "f", "asm", "cmake", "makefile", "gradle", "sas", "do", "stan"],
  text: ["txt", "log", "nfo", "readme", "license", "rst", "adoc", "org", "srt", "vtt", "ass", "sub", "diff", "patch"],
  font: ["ttf", "otf", "woff", "woff2", "eot"],
  book: ["epub", "mobi", "azw", "azw3", "djvu", "cbz", "cbr", "chm", "xps", "oxps"],
};
const BY_EXT = new Map();
for (const [cat, exts] of Object.entries(CAT)) for (const e of exts) if (!BY_EXT.has(e)) BY_EXT.set(e, cat);

/** The file's extension (lower case, "" when it has none). */
export function extOf(name) {
  const base = String(name || "").split(/[\\/]/).pop();
  // a draw.io picture (.drawio.svg / .drawio.png) is a diagram
  if (/\.drawio\.(svg|png|xml)$/i.test(base)) return "drawio";
  const i = base.lastIndexOf(".");
  return i > 0 && i < base.length - 1 ? base.slice(i + 1).toLowerCase() : "";
}

/** Category of a file name: md, tex, pdf, doc, sheet, deck, data, image, video, audio, archive, exe, code, text, … or "file". */
export function categoryOf(name) {
  const e = extOf(name);
  if (!e) {
    const b = String(name || "").split(/[\\/]/).pop().toLowerCase();
    if (/^(makefile|dockerfile|license|readme|changelog|copying|authors)$/.test(b)) return b === "makefile" || b === "dockerfile" ? "code" : "text";
    return "file";
  }
  return BY_EXT.get(e) || "file";
}

const SHORT = { markdown: "MD", jpeg: "JPG", tiff: "TIF", yaml: "YML", mermaid: "MMD", jsonc: "JSON", ndjson: "JSON", jsonl: "JSON", plantuml: "UML", msixbundle: "MSIX", appxbundle: "APPX" };
/** Short label for the badge: the extension in capitals (at most 4 letters). */
export function badgeOf(name) {
  const e = extOf(name);
  if (!e) return "";
  const s = SHORT[e] || e.toUpperCase();
  return s.length > 4 ? s.slice(0, 4) : s;
}

/** Badge markup put before a file name. */
export function fileBadge(name, isDir = false) {
  if (isDir) return `<span class="fb dir" aria-hidden="true"><svg class="ic"><use href="#ic-folder"/></svg></span>`;
  const b = badgeOf(name);
  const c = categoryOf(name);
  return b
    ? `<span class="fb ${c}${b.length > 3 ? " long" : ""}" aria-hidden="true">${b}</span>`
    : `<span class="fb file" aria-hidden="true"><svg class="ic"><use href="#ic-file"/></svg></span>`;
}

export const isArchive = (name) => categoryOf(name) === "archive";
export const isExecutable = (name) => categoryOf(name) === "exe";
export const isVideo = (name) => categoryOf(name) === "video";
export const isAudio = (name) => categoryOf(name) === "audio";
export const isMedia = (name) => isVideo(name) || isAudio(name);

/** Names hidden in the file tree: hidden and temporary files and folders. */
export function isHiddenName(name, isDir = false) {
  const n = String(name || "");
  const l = n.toLowerCase();
  if (n.startsWith(".") || n.startsWith("~") || n.startsWith("$") || n.endsWith("~")) return true;
  if (isDir) return ["node_modules", "__pycache__", "_minted", "svg-inkscape", "system volume information", "$recycle.bin"].includes(l);
  if (["thumbs.db", "ehthumbs.db", "desktop.ini", ".ds_store", "icon\r"].includes(l)) return true;
  return /\.(tmp|temp|swp|swo|crdownload|part|partial|download|pyc|pyo|class|o|obj|aux|fls|fdb_latexmk|synctex\.gz|synctex\(busy\)|toc|lof|lot|blg|bcf|run\.xml|xdv|nav|snm|vrb|callio-tmp)$/i.test(n) || /^~\$/.test(n);
}
