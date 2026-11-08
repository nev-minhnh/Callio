// PDF -> Markdown via pdf.js text extraction + layout analysis (layout.js).
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { layoutPages, ocrPage } from "./layout.js";
import { ConvertError, checkAbort, tick } from "./util.js";

if (!pdfjsLib.GlobalWorkerOptions.workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const OPS = pdfjsLib.OPS;
const BOLD = /bold|black|heavy|semibold|demibold|demi\b|CMBX|CMB\d|SFBX|LMRomanDemi|\bMedi\b|-Medi|Medium(?!It)|[-,]B\b|Bd\b|-Bd|Heavy/i;
const ITALIC = /italic|oblique|CMTI|CMSL|SFTI|SFSL|-It\b|Ital|-Obl/i;
const MATH = /CMMI|CMSY|CMEX|MSAM|MSBM|Math|Symbol|STIXGeneral-Italic|rsfs|EUFM|EUSM|esint|wasy|txsy|txmi|pxsy|pxmi|LMMathItalic|LMMathSymbols|CambriaMath/i;
const MONO = /mono|courier|CMTT|SFTT|consolas|inconsolata|menlo|LMMono|beramono/i;

export async function convertPdf(ctx) {
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data: ctx.bytes.slice(), isEvalSupported: false, enableXfa: false, verbosity: 0, fontExtraProperties: true }).promise;
  } catch (e) {
    if (e?.name === "PasswordException") throw new ConvertError("This PDF is password-protected.");
    throw new ConvertError("Couldn't read the PDF: " + (e?.message || e));
  }
  const n = doc.numPages;
  const pages = [];
  const keepPages = new Map();
  try {
    for (let i = 1; i <= n; i++) {
      checkAbort(ctx.signal);
      ctx.progress(i - 1, n, `Page ${i} of ${n}`);
      const page = await doc.getPage(i);
      const info = await extractPage(page);
      if (info.scanned) {
        const pre = await scannedPage(ctx, page, i, info);
        if (pre && typeof pre === "object") {
          const op = ocrPage(pre, info.width / (pre.width || info.width));
          pages.push({ ...op, width: info.width, height: info.height });
        } else pages.push({ width: info.width, height: info.height, pre: pre || "" });
      } else pages.push(info);
      if (info.figures?.length && ctx.imageMode !== "placeholder") keepPages.set(i - 1, page);
      else page.cleanup();
      if (i % 4 === 0) await tick();
    }
    ctx.progress(n, n, "Layout");
    const figTokens = [];
    let md = layoutPages(pages, {
      figure: (p, idx, fig) => {
        if (ctx.imageMode === "placeholder" || !keepPages.has(p)) return "<!-- image -->";
        figTokens.push({ p, fig });
        return `\u0007FIG${figTokens.length - 1}\u0007`;
      },
    });
    if (figTokens.length) {
      const crops = await cropFigures(ctx, keepPages, pages, figTokens);
      md = md.replace(/\u0007FIG(\d+)\u0007/g, (_, k) => crops[+k] || "<!-- image -->");
    }
    if (!ctx.ocr && pages.every((p) => p.pre != null || !p.spans?.length)) ctx.warnings.push("No text layer found in this PDF.");
    return md;
  } finally {
    await (doc.destroy?.() ?? doc.loadingTask?.destroy?.());
  }
}

function mult(m, n) {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}
function bboxOf(m, x0, y0, x1, y1) {
  const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

async function extractPage(page) {
  const [vx0, vy0, vx1, vy1] = page.view;
  const tc = await page.getTextContent({ includeMarkedContent: false });
  let ops = null;
  try { ops = await page.getOperatorList(); } catch { /* fonts/graphics unavailable: text only */ }
  // dominant text direction (0, 90, 180, 270 degrees)
  const dirChars = [0, 0, 0, 0];
  for (const it of tc.items) {
    if (!it.str) continue;
    const [a, b] = it.transform;
    dirChars[((Math.round(Math.atan2(b, a) / (Math.PI / 2)) % 4) + 4) % 4] += it.str.length;
  }
  const k = dirChars.indexOf(Math.max(...dirChars));
  // user space -> "view" space for direction k (x right, y down)
  const rot = (x, y) => (k === 0 ? [x - vx0, vy1 - y] : k === 1 ? [y - vy0, x - vx0] : k === 2 ? [vx1 - x, y - vy0] : [vy1 - y, vx1 - x]);
  const width = k % 2 ? vy1 - vy0 : vx1 - vx0;
  const height = k % 2 ? vx1 - vx0 : vy1 - vy0;
  const fontInfo = new Map();
  const font = (name) => {
    if (fontInfo.has(name)) return fontInfo.get(name);
    let f = { bold: false, italic: false, math: false, mono: false };
    try {
      if (page.commonObjs.has(name)) {
        const o = page.commonObjs.get(name);
        const nm = (o?.name || "") + " " + (o?.fallbackName || "");
        f = { bold: !!o?.bold || !!o?.black || BOLD.test(nm), italic: !!o?.italic || ITALIC.test(o?.name || ""), math: MATH.test(o?.name || ""), mono: !!o?.isMonospace || MONO.test(o?.name || "") };
      }
    } catch { /* ignore */ }
    const fam = tc.styles?.[name]?.fontFamily || "";
    if (/monospace/.test(fam)) f.mono = true;
    fontInfo.set(name, f);
    return f;
  };
  const spans = [];
  let textChars = 0;
  for (const it of tc.items) {
    if (it.str == null) continue;
    const [a, b, c, d, e, f] = it.transform;
    let dev = Math.atan2(b, a) - (k * Math.PI) / 2;
    dev = Math.atan2(Math.sin(dev), Math.cos(dev));
    if (Math.abs(dev) > 0.05) continue; // rotated or skewed text (margin stamps, rotated axis labels)
    const size = Math.hypot(c, d) || Math.hypot(a, b) || 10;
    const [x, y] = rot(e, f);
    const w = it.width || it.str.length * size * 0.5;
    if (!it.str.trim()) { spans.push({ text: " ", x0: x, x1: x + w, y, size }); continue; }
    if (x > width + 5 || x + w < -5 || y < -5 || y > height + 5) continue; // off-page
    const fi = font(it.fontName);
    textChars += it.str.trim().length;
    spans.push({ text: it.str, x0: x, x1: x + w, y, size, ...fi });
    if (it.hasEOL) spans.push({ text: " ", x0: x + w, x1: x + w, y, size });
  }
  // graphics: images and vector drawings
  const imgs = [];
  const paths = [];
  if (ops) {
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], args = ops.argsArray[i];
      switch (fn) {
        case OPS.save: stack.push(ctm); break;
        case OPS.restore: ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; break;
        case OPS.transform: ctm = mult(ctm, args); break;
        case OPS.paintFormXObjectBegin: stack.push(ctm); if (args?.[0]) ctm = mult(ctm, args[0]); break;
        case OPS.paintFormXObjectEnd: ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; break;
        case OPS.beginGroup: stack.push(ctm); if (args?.[0]?.matrix) ctm = mult(ctm, args[0].matrix); break;
        case OPS.endGroup: ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; break;
        case OPS.paintImageXObject: case OPS.paintInlineImageXObject: case OPS.paintImageXObjectRepeat: case OPS.paintImageMaskXObject:
          imgs.push({ box: bboxOf(ctm, 0, 0, 1, 1), mask: fn === OPS.paintImageMaskXObject }); break;
        case OPS.constructPath: {
          const mm = args?.[2];
          if (mm && mm.length >= 4 && isFinite(mm[0])) paths.push({ box: bboxOf(ctm, mm[0], mm[1], mm[2], mm[3]), fill: args[0] !== OPS.stroke && args[0] !== OPS.closeStroke && args[0] !== OPS.endPath });
          break;
        }
        case OPS.shadingFill: break;
        default: break;
      }
    }
  }
  const toView = (b) => {
    const p = rot(b[0], b[1]), q = rot(b[2], b[3]);
    return { x0: Math.min(p[0], q[0]), y0: Math.min(p[1], q[1]), x1: Math.max(p[0], q[0]), y1: Math.max(p[1], q[1]) };
  };
  const pageArea = width * height;
  const figures = [];
  let imageArea = 0;
  for (const im of imgs) {
    const r = clip(toView(im.box), width, height);
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    if (w <= 0 || h <= 0) continue;
    if (!im.mask) imageArea = Math.max(imageArea, w * h);
    if (w < 24 || h < 24 || w * h < 1200) continue;
    if (im.mask && w * h < 5000) continue;
    figures.push({ ...r, kind: "image" });
  }
  // vector figures: cluster drawn paths
  const boxes = [];
  for (const p of paths) {
    const r = clip(toView(p.box), width, height);
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    if (w < 0 || h < 0) continue;
    if (w * h > 0.6 * pageArea) continue; // page background / frame
    boxes.push({ ...r, thin: Math.min(w, h) < 1.6, n: 1, nonThin: Math.min(w, h) < 1.6 ? 0 : 1 });
  }
  if (boxes.length > 4000) boxes.length = 4000;
  const clusters = [];
  for (const b of boxes) {
    let target = null;
    for (const c of clusters) if (b.x0 < c.x1 + 5 && c.x0 < b.x1 + 5 && b.y0 < c.y1 + 5 && c.y0 < b.y1 + 5) { target = c; break; }
    if (target) { target.x0 = Math.min(target.x0, b.x0); target.y0 = Math.min(target.y0, b.y0); target.x1 = Math.max(target.x1, b.x1); target.y1 = Math.max(target.y1, b.y1); target.n++; target.nonThin += b.nonThin; }
    else clusters.push({ ...b });
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < clusters.length; i++) for (let j = clusters.length - 1; j > i; j--) {
      const a = clusters[i], b = clusters[j];
      if (b.x0 < a.x1 + 5 && a.x0 < b.x1 + 5 && b.y0 < a.y1 + 5 && a.y0 < b.y1 + 5) {
        clusters[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), n: a.n + b.n, nonThin: a.nonThin + b.nonThin };
        clusters.splice(j, 1);
      }
    }
  }
  for (const c of clusters) {
    const w = c.x1 - c.x0, h = c.y1 - c.y0;
    if (w >= 50 && h >= 35 && c.n >= 8 && c.nonThin >= 3 && w * h < 0.85 * pageArea) figures.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, kind: "vector" });
  }
  const scanned = textChars < 30 && (imageArea > 0.4 * pageArea || (textChars === 0 && (imgs.length > 0 || paths.length > 0)));
  return { width, height, spans, figures: scanned ? [] : figures, scanned, k, textChars };
}

function clip(r, W, H) {
  return { x0: Math.max(0, r.x0), y0: Math.max(0, r.y0), x1: Math.min(W, r.x1), y1: Math.min(H, r.y1) };
}

function makeCanvas(w, h) {
  if (typeof document !== "undefined") return Object.assign(document.createElement("canvas"), { width: w, height: h });
  return new OffscreenCanvas(w, h);
}
function canvasBlob(canvas, type = "image/png") {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type });
  return new Promise((res) => canvas.toBlob(res, type));
}

async function renderPage(page, scale) {
  const vp = page.getViewport({ scale });
  const canvas = makeCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: g, canvas, viewport: vp }).promise;
  return { canvas, vp };
}

async function scannedPage(ctx, page, num, info) {
  if (!ctx.ocr) {
    ctx.warnings.push(`Page ${num} appears to be scanned (no text layer); OCR is not available, so it was left as an image placeholder.`);
    return `<!-- image -->\n\n<!-- page ${num}: scanned page, no text extracted -->`;
  }
  ctx.progress(num - 1, null, `OCR page ${num}`);
  const { canvas } = await renderPage(page, 200 / 72);
  const blob = await canvasBlob(canvas);
  let res;
  try { res = await ctx.ocr({ canvas, blob, width: canvas.width, height: canvas.height, pageNumber: num }); }
  catch (e) { ctx.warnings.push(`OCR failed on page ${num}: ${e?.message || e}`); res = ""; }
  void info;
  if (res && typeof res === "object" && Array.isArray(res.lines)) return res;
  return String(res || "").trim();
}

async function cropFigures(ctx, keepPages, pages, tokens) {
  const out = [];
  const byPage = new Map();
  tokens.forEach((t, i) => (byPage.get(t.p) || byPage.set(t.p, []).get(t.p)).push(i));
  for (const [p, idxs] of byPage) {
    checkAbort(ctx.signal);
    const page = keepPages.get(p);
    const info = pages[p];
    try {
      const scale = 2;
      const { canvas } = await renderPage(page, scale);
      // view coords -> canvas pixels: the rendered page honours /Rotate, our view honours text direction
      const vp = page.getViewport({ scale });
      const [vx0, vy0, vx1, vy1] = page.view;
      const k = info.k || 0;
      const unrot = (x, y) => (k === 0 ? [x + vx0, vy1 - y] : k === 1 ? [y + vx0, x + vy0] : k === 2 ? [vx1 - x, y + vy0] : [vx1 - y, vy1 - x]);
      for (const i of idxs) {
        const f = tokens[i].fig;
        const pts = [[f.x0 - 2, f.y0 - 2], [f.x1 + 2, f.y1 + 2]].map(([x, y]) => vp.convertToViewportPoint(...unrot(x, y)));
        const x0 = Math.max(0, Math.floor(Math.min(pts[0][0], pts[1][0]))), y0 = Math.max(0, Math.floor(Math.min(pts[0][1], pts[1][1])));
        const x1 = Math.min(canvas.width, Math.ceil(Math.max(pts[0][0], pts[1][0]))), y1 = Math.min(canvas.height, Math.ceil(Math.max(pts[0][1], pts[1][1])));
        if (x1 - x0 < 4 || y1 - y0 < 4) { out[i] = "<!-- image -->"; continue; }
        const c = makeCanvas(x1 - x0, y1 - y0);
        c.getContext("2d").drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
        const blob = await canvasBlob(c);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        out[i] = ctx.images.add(bytes, "image/png", "");
      }
    } catch (e) {
      ctx.warnings.push(`Couldn't extract figures on page ${p + 1}: ${e?.message || e}`);
    } finally {
      page.cleanup();
    }
  }
  return out;
}
