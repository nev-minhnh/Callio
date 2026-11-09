// Packs the draw.io web app (github.com/jgraph/drawio, Apache-2.0, src/main/webapp) into one
// zip that Callio serves to its diagram editor (src-tauri/src/drawio.rs). Only what the editor
// needs at run time goes in — the same files the draw.io desktop app leaves out (sources, Java,
// source maps) are left out here, plus the cloud-integration bundles and the interface
// languages Callio doesn't offer (English and Vietnamese are kept).
//   node scripts/build-drawio.mjs <path to drawio/src/main/webapp> <out.zip>
import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { zipSync } from "fflate";

const [root, out] = process.argv.slice(2);
if (!root || !out) { console.error("usage: build-drawio.mjs <webapp> <out.zip>"); process.exit(2); }
const SKIP = [
  /^WEB-INF\//, /^js\/diagramly\//, /^js\/grapheditor\//, /^mxgraph\/src\//, /^mxgraph\/mxClient\.js$/,
  /\.map$/, /^js\/integrate\.min\.js$/, /^js\/viewer\.min\.js$/, /^connect\//, /^(teams|onedrive3|vsdxImporter)\.html$/,
  /^service-worker\.js$/, /^workbox-[^/]*\.js$/, /^monday-app-association\.json$/, /^resources\/(README|CONTRIBUTING)\.md$/,
];
const KEEP_LANG = new Set(["dia.txt", "dia_vi.txt"]);
const files = {};
let n = 0, bytes = 0;
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(root, p).split(sep).join("/");
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (SKIP.some((re) => re.test(rel))) continue;
    if (/^resources\/dia_?[^/]*\.txt$/.test(rel) && !KEEP_LANG.has(rel.slice(10))) continue;
    const data = readFileSync(p);
    // already-compressed files are stored as they are
    files[rel] = [data, { level: /\.(png|jpe?g|gif|webp|woff2?|zip|ico)$/i.test(rel) ? 0 : 9 }];
    n++; bytes += data.length;
  }
})(root);
const zip = zipSync(files);
writeFileSync(out, zip);
console.log(`draw.io: ${n} files, ${(bytes / 1048576).toFixed(1)} MB → ${out} (${(zip.length / 1048576).toFixed(1)} MB)`);
