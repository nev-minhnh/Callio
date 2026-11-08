// Layout analysis: positioned text (PDF glyph runs or OCR lines/words) -> Markdown.
// Reading order (multi-column, full-width bands), paragraphs, headings by relative size/weight,
// lists, de-hyphenation, simple tables from aligned columns, running header/footer removal,
// figure placeholders and footnotes. Coordinates: any unit, y grows downwards.
import { escapeMd, escapeLineStart, renderTable, joinBlocks } from "./util.js";

const GAP = 0.9; // horizontal gap (in font sizes) that splits a line into separate segments
const MARKER = /^([•◦▪▫‣∙●○■□◆◇►▸➢➤✓✔·*\-–—\u0080-\u009f\ue000-\uf8ff]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|\((?:[ivx]{1,4})\)|[ivx]{1,4}[.)]|\[\d{1,3}\])(?=\s|$)/;
const BULLET = /^[•◦▪▫‣∙●○■□◆◇►▸➢➤✓✔·*\-–—\u0080-\u009f\ue000-\uf8ff]$/;
const CAPTION = /^(fig(ure)?|table|tab|algorithm|listing|scheme|chart|plate|exhibit)\.?\s*[A-Z]?\d+(\.\d+)*[a-z]?\s*[.:|–—-]/i;
const NUMBERED = /^((\d{1,2})(\.\d{1,2}){0,4}\.?|[A-Z](\.\d{1,2}){1,3}\.?|[A-Z]\.|[IVX]{1,5}\.)\s+(\S.*)$/;
const NAMED = /^(abstract|references|bibliography|acknowledg(e)?ments?|introduction|conclusions?|related work|discussion|appendix|summary|methods?|results|background|keywords|index terms)\b[.:]?$/i;
const END_PUNCT = /[.!?:;]["”’)\]]?$/;

// pages: [{ width, height, spans: [{ text, x0, x1, y (baseline), size, bold, italic, math, mono }], figures?: [{x0,y0,x1,y1,kind}], pre?: string }]
// opts.figure(pageIndex, figIndex, fig) -> markdown for a figure (default "<!-- image -->")
export function layoutPages(pages, opts = {}) {
  const docPages = pages.map((p, i) => ({ ...p, index: i, lines: p.pre != null ? [] : buildLines(p.spans || []) }));
  const stats = docStats(docPages);
  removeMargins(docPages, stats);
  const blocks = [];
  for (const page of docPages) {
    if (page.pre != null) { blocks.push({ type: "raw", md: page.pre, page: page.index }); continue; }
    blocks.push(...pageBlocks(page, stats));
  }
  classify(blocks, stats, docPages);
  return render(blocks, stats, opts);
}

// OCR results -> Markdown. pages: [{ width, height, lines: [{ text, x, y, w, h, words?: [{ t, x, y, w, h }] }] }]
export function layoutToMarkdown(pages, opts = {}) {
  return layoutPages((pages || []).map((p) => ocrPage(p)), opts);
}

export function ocrPage(p, scale = 1) {
  const spans = [];
  let id = 0;
  for (const l of p.lines || []) {
    id++;
    // size ~ the line box height (ascender to descender); thresholds for OCR pages are more tolerant
    const wh = (l.words || []).map((w) => w.h).filter((h) => h > 0).sort((a, b) => a - b);
    const h0 = (wh.length ? Math.max(wh[wh.length - 1], l.h * 0.8) : l.h) || 10;
    const h = h0 * scale;
    // tops of line boxes (ascenders) are steadier than bottoms (descenders)
    const base = (l.y + h0 * 0.8) * scale;
    if (l.words?.length) {
      for (const w of l.words) {
        const t = (w.t ?? w.text ?? "").trim();
        if (t) spans.push({ text: t, x0: w.x * scale, x1: (w.x + w.w) * scale, y: base, size: h, lineId: id });
      }
    } else if ((l.text || "").trim()) spans.push({ text: l.text.trim(), x0: l.x * scale, x1: (l.x + l.w) * scale, y: base, size: h, lineId: id });
  }
  return { width: (p.width || 1000) * scale, height: (p.height || 1400) * scale, spans, ocr: true };
}

// ---------- lines ----------
function newLine(s) {
  const l = { text: "", x0: s.x0, x1: s.x1, y: s.y, size: s.size, chars: 0, bold: 0, italic: 0, math: 0, mono: 0, sizes: new Map(), spans: [] };
  addSpan(l, s, false);
  return l;
}
function addSpan(l, s, space) {
  const t = s.text;
  if (space && l.text && !/\s$/.test(l.text) && !/^\s/.test(t)) l.text += " ";
  l.text += t;
  const n = t.replace(/\s+/g, "").length;
  l.chars += n;
  if (s.bold) l.bold += n;
  if (s.italic) l.italic += n;
  if (s.math) l.math += n;
  if (s.mono) l.mono += n;
  const key = Math.round(s.size * 4) / 4;
  l.sizes.set(key, (l.sizes.get(key) || 0) + n);
  let best = l.size, bc = -1;
  for (const [k, c] of l.sizes) if (c > bc) { bc = c; best = k; }
  if (s.size > l.size * 1.15 && n > 0) l.y = s.y; // keep the main baseline, not a superscript's
  l.size = best || s.size;
  l.x0 = Math.min(l.x0, s.x0);
  l.x1 = Math.max(l.x1, s.x1);
  l.spans.push(s);
}
function finishLine(l) {
  l.text = l.text.replace(/\s+/g, " ").trim();
  l.top = l.y - l.size * 0.85;
  l.bottom = l.y + l.size * 0.25;
  l.boldFrac = l.chars ? l.bold / l.chars : 0;
  l.italicFrac = l.chars ? l.italic / l.chars : 0;
  l.mathFrac = l.chars ? l.math / l.chars : 0;
  return l;
}

export function buildLines(spans) {
  if (spans.length && spans[0].lineId != null) return buildGivenLines(spans);
  const lines = [];
  let cur = null;
  for (const s of spans) {
    if (!s.text || !s.text.trim()) { if (cur) cur.pendingSpace = true; continue; }
    if (cur) {
      const sz = Math.max(cur.size, s.size);
      const dy = Math.abs(s.y - cur.y);
      const differ = s.size < cur.size * 0.87 || cur.size < s.size * 0.87;
      const sameLine = dy < 0.35 * sz || (differ && dy < 0.62 * sz);
      const gap = s.x0 - cur.x1;
      if (sameLine && gap > -0.6 * sz && gap < GAP * sz) {
        addSpan(cur, s, cur.pendingSpace || gap > 0.12 * Math.min(cur.size, s.size));
        cur.pendingSpace = false;
        continue;
      }
    }
    cur = newLine(s);
    lines.push(cur);
  }
  // geometric merge for content streams that are out of order
  lines.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const out = [];
  const used = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    const a = lines[i];
    for (let j = i + 1; j < lines.length; j++) {
      const b = lines[j];
      if (b.y - a.y > 0.4 * a.size) break;
      if (used.has(j)) continue;
      const gap = b.x0 - a.x1;
      if (Math.abs(b.y - a.y) < 0.3 * Math.max(a.size, b.size) && gap > -0.3 * a.size && gap < 0.3 * a.size) {
        for (const s of b.spans) addSpan(a, s, gap > 0.12 * a.size);
        used.add(j);
      }
    }
    out.push(a);
  }
  return out.map(finishLine).filter((l) => l.text);
}

// OCR engines already segment lines: keep them, splitting only at wide word gaps (table cells)
function buildGivenLines(spans) {
  const groups = new Map();
  for (const s of spans) (groups.get(s.lineId) || groups.set(s.lineId, []).get(s.lineId)).push(s);
  const out = [];
  for (const g of groups.values()) {
    g.sort((a, b) => a.x0 - b.x0);
    let cur = null;
    for (const s of g) {
      if (cur && s.x0 - cur.x1 < 2.2 * s.size) addSpan(cur, s, true);
      else { cur = newLine(s); out.push(cur); }
    }
  }
  return out.map(finishLine).filter((l) => l.text);
}

// ---------- statistics ----------
function weightedMedian(pairs) {
  pairs = pairs.filter((p) => p[1] > 0).sort((a, b) => a[0] - b[0]);
  const total = pairs.reduce((a, p) => a + p[1], 0);
  let acc = 0;
  for (const [v, w] of pairs) { acc += w; if (acc >= total / 2) return v; }
  return pairs.length ? pairs[pairs.length - 1][0] : 10;
}
function docStats(pages) {
  const all = pages.flatMap((p) => p.lines);
  const body = weightedMedian(all.map((l) => [l.size, l.chars])) || 10;
  // line pitch relative to size, from consecutive lines of body size in the same column
  const ratios = [];
  for (const p of pages) {
    const ls = [...p.lines].sort((a, b) => a.x0 - b.x0 || a.y - b.y);
    const byCol = new Map();
    for (const l of ls) {
      if (Math.abs(l.size - body) > 0.1 * body) continue;
      const k = Math.round(l.x0 / (body * 2));
      (byCol.get(k) || byCol.set(k, []).get(k)).push(l);
    }
    for (const col of byCol.values()) {
      col.sort((a, b) => a.y - b.y);
      for (let i = 1; i < col.length; i++) {
        const r = (col[i].y - col[i - 1].y) / body;
        if (r > 0.9 && r < 2.2) ratios.push(r);
      }
    }
  }
  ratios.sort((a, b) => a - b);
  const pitch = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 1.2;
  return { body, pitch };
}

// ---------- running headers / footers ----------
function normKey(t) { return t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim(); }
const PAGENUM = /^(page\s*)?#(\s*(of|\/)\s*#)?$|^[-–—]\s*#\s*[-–—]$|^(x{0,3})(ix|iv|v?i{0,3})$|^#\s*\|.*|.*\|\s*#$/i;
function removeMargins(pages, stats) {
  const n = pages.length;
  const cand = [];
  const count = new Map();
  for (const p of pages) {
    if (!p.lines.length) continue;
    const H = p.height;
    const sorted = [...p.lines].sort((a, b) => a.y - b.y);
    const top = sorted.slice(0, 3).filter((l) => l.bottom < H * 0.13 || (l === sorted[0] && l.bottom < H * 0.25 && /^\W*\d+\W*$/.test(l.text)));
    const bot = sorted.slice(-3).filter((l) => l.top > H * 0.86 || (l === sorted[sorted.length - 1] && l.top > H * 0.75 && /^\W*\d+\W*$/.test(l.text)));
    const seen = new Set();
    const alone = (l) => !p.lines.some((o) => o !== l && Math.abs(o.y - l.y) < 0.5 * l.size);
    for (const l of [...top, ...bot]) {
      if (/^\W*\d+\W*$/.test(l.text) && !alone(l)) continue;
      const key = (l.y < H / 2 ? "T:" : "B:") + normKey(l.text);
      cand.push({ p, l, key, bare: normKey(l.text) });
      if (!seen.has(key)) { seen.add(key); count.set(key, (count.get(key) || 0) + 1); }
    }
  }
  const need = n >= 3 ? Math.max(2, Math.ceil(n * 0.3)) : 2;
  const drop = new Set();
  for (const c of cand) {
    if (n >= 2 && count.get(c.key) >= need) drop.add(c.l);
    else if (PAGENUM.test(c.bare) && c.bare.length <= 12) drop.add(c.l);
  }
  // lines repeated across pages that sit in the outer margins but weren't caught (e.g. arXiv stamps)
  for (const p of pages) p.lines = p.lines.filter((l) => !drop.has(l));
  void stats;
}

// ---------- per page ----------
function modeTol(vals, tol) {
  if (!vals.length) return 0;
  vals = [...vals].sort((a, b) => a - b);
  let best = vals[0], bc = 0, j = 0;
  for (let i = 0; i < vals.length; i++) {
    while (vals[i] - vals[j] > tol) j++;
    if (i - j + 1 > bc) { bc = i - j + 1; best = vals[j + Math.floor((i - j) / 2)]; }
  }
  return best;
}
function pct(vals, q) {
  if (!vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

function absorbFigures(page, stats) {
  const figs = (page.figures || []).map((f) => ({ ...f }));
  if (!figs.length) return [];
  const body = stats.body;
  const keep = [];
  for (const f of figs) {
    const inside = [];
    const grow = (l) => {
      const cx = (l.x0 + l.x1) / 2, cy = (l.top + l.bottom) / 2;
      return cx > f.x0 - 2 && cx < f.x1 + 2 && cy > f.y0 - 2 && cy < f.y1 + 2;
    };
    for (const l of page.lines) {
      if (l.fig || CAPTION.test(l.text)) continue;
      if (grow(l) && !(l.chars > 90 && l.x1 - l.x0 > 0.8 * (f.x1 - f.x0) && f.kind !== "image")) inside.push(l);
    }
    const chars = inside.reduce((a, l) => a + l.chars, 0);
    const area = (f.x1 - f.x0) * (f.y1 - f.y0);
    // a "figure" full of text is a framed box or a shaded table, not a picture
    if (f.kind === "vector" && chars > Math.max(250, area / (body * body) * 0.9)) continue;
    for (const l of inside) l.fig = f;
    // axis labels / legends just outside a vector drawing
    if (f.kind === "vector") {
      for (let pass = 0; pass < 2; pass++) {
        for (const l of page.lines) {
          if (l.fig || CAPTION.test(l.text)) continue;
          const near = l.x1 > f.x0 - 4 && l.x0 < f.x1 + 4 && l.bottom > f.y0 - 9 && l.top < f.y1 + 9;
          const nearSide = l.top < f.y1 && l.bottom > f.y0 && l.x1 > f.x0 - 30 && l.x0 < f.x1 + 30 && l.chars < 12;
          const small = l.size < 0.9 * body || (l.chars <= 25 && !END_PUNCT.test(l.text));
          if ((near || nearSide) && small && l.chars <= 40) {
            l.fig = f;
            f.x0 = Math.min(f.x0, l.x0); f.x1 = Math.max(f.x1, l.x1); f.y0 = Math.min(f.y0, l.top); f.y1 = Math.max(f.y1, l.bottom);
          }
        }
      }
    }
    keep.push(f);
  }
  // merge overlapping figures
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < keep.length && !merged; i++) for (let j = i + 1; j < keep.length; j++) {
      const a = keep[i], b = keep[j];
      if (a.x0 < b.x1 + 3 && b.x0 < a.x1 + 3 && a.y0 < b.y1 + 3 && b.y0 < a.y1 + 3) {
        keep[i] = { ...a, x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), kind: a.kind === "image" || b.kind === "image" ? "image" : "vector" };
        for (const l of page.lines) if (l.fig === a || l.fig === b) l.fig = keep[i];
        keep.splice(j, 1);
        merged = true;
        break;
      }
    }
  }
  page.lines = page.lines.filter((l) => !l.fig);
  return keep;
}

function findGutters(lines, body) {
  if (lines.length < 8) return [];
  const left = pct(lines.map((l) => l.x0), 0.02), right = pct(lines.map((l) => l.x1), 0.98);
  const width = right - left;
  if (width <= body * 10) return [];
  const narrow = lines.filter((l) => l.x1 - l.x0 < 0.7 * width);
  const bins = Math.ceil(width) + 1;
  const step = Math.max(1, width / 2000);
  const nb = Math.ceil(width / step) + 1;
  const cov = new Uint16Array(nb);
  for (const l of narrow) for (let x = Math.max(0, Math.floor((l.x0 - left) / step)); x <= Math.min(nb - 1, Math.ceil((l.x1 - left) / step)); x++) cov[x]++;
  void bins;
  const gaps = [];
  let start = -1;
  let maxCov = 0;
  for (let x = 0; x < nb; x++) maxCov = Math.max(maxCov, cov[x]);
  // lines that cross the gutter (centered titles, wide captions) are tolerated; validated below
  const thr = Math.max(0, Math.floor(maxCov * 0.12));
  for (let x = 0; x < nb; x++) {
    if (cov[x] <= thr) { if (start < 0) start = x; }
    else if (start >= 0) {
      const g0 = left + start * step, g1 = left + x * step;
      if (g1 - g0 >= Math.max(0.6 * body, 4) && g0 > left + 0.15 * width && g1 < right - 0.15 * width) gaps.push({ x0: g0, x1: g1 });
      start = -1;
    }
  }
  const total = lines.reduce((a, l) => a + l.chars, 0);
  const valid = [];
  for (const g of gaps) {
    const L = lines.filter((l) => l.x1 <= g.x0 + 1), R = lines.filter((l) => l.x0 >= g.x1 - 1);
    const C = lines.filter((l) => l.x0 < g.x0 && l.x1 > g.x1);
    const lc = L.reduce((a, l) => a + l.chars, 0), rc = R.reduce((a, l) => a + l.chars, 0), cc = C.reduce((a, l) => a + l.chars, 0);
    if (L.length < 4 || R.length < 4) continue;
    if (lc < 0.05 * total || rc < 0.05 * total || cc > 0.5 * total) continue;
    const lw = weightedMedian(L.map((l) => [l.x1 - l.x0, l.chars])), rw = weightedMedian(R.map((l) => [l.x1 - l.x0, l.chars]));
    const lLeft = pct(L.map((l) => l.x0), 0.1), rRight = pct(R.map((l) => l.x1), 0.9);
    if (lw < 0.55 * (g.x0 - lLeft) || rw < 0.55 * (rRight - g.x1)) continue;
    valid.push({ ...g, score: Math.min(lc, rc) });
  }
  // keep non-adjacent gutters (columns must be wide)
  valid.sort((a, b) => b.score - a.score);
  const chosen = [];
  for (const g of valid) if (chosen.every((c) => Math.abs((c.x0 + c.x1) / 2 - (g.x0 + g.x1) / 2) > 0.2 * width)) chosen.push(g);
  return chosen.sort((a, b) => a.x0 - b.x0).slice(0, 3);
}

function pageBlocks(page, stats) {
  const body = stats.body;
  const figs = absorbFigures(page, stats);
  let gutters = findGutters(page.lines, body);
  if (gutters.length) {
    // split lines that run across a gutter (glyph runs glued together across columns)
    const split = [];
    for (const l of page.lines) {
      const g = gutters.find((g) => l.x0 < g.x0 && l.x1 > g.x1);
      if (!g) { split.push(l); continue; }
      const mid = (g.x0 + g.x1) / 2;
      const L = l.spans.filter((s) => (s.x0 + s.x1) / 2 < mid), R = l.spans.filter((s) => (s.x0 + s.x1) / 2 >= mid);
      const lEnd = Math.max(...L.map((s) => s.x1)), rStart = Math.min(...R.map((s) => s.x0));
      if (L.length && R.length && rStart - lEnd > 0.4 * l.size) {
        for (const part of [L, R]) {
          const nl = newLine(part[0]);
          for (const s of part.slice(1)) addSpan(nl, s, s.x0 - nl.x1 > 0.12 * s.size);
          split.push(finishLine(nl));
        }
      } else split.push(l);
    }
    page.lines = split;
    gutters = findGutters(page.lines, body);
  }
  const lines = page.lines;
  const colOf = (x0, x1) => {
    for (const g of gutters) if (x0 < g.x0 - 1 && x1 > g.x1 + 1) return -1; // spans a gutter
    const cx = (x0 + x1) / 2;
    let c = 0;
    for (const g of gutters) if (cx > (g.x0 + g.x1) / 2) c++;
    return c;
  };
  const elems = [];
  for (const l of lines) elems.push({ kind: "line", l, top: l.top, y: l.y, col: colOf(l.x0, l.x1) });
  figs.forEach((f, i) => elems.push({ kind: "fig", f, idx: i, top: f.y0, y: f.y0, col: colOf(f.x0, f.x1) }));
  elems.sort((a, b) => a.y - b.y || (a.kind === "line" && b.kind === "line" ? a.l.x0 - b.l.x0 : 0));
  // column metrics
  const ncol = gutters.length + 1;
  const cols = [];
  const colMetrics = (ls) => {
    const bodyLs = ls.filter((l) => Math.abs(l.size - body) < 0.15 * body);
    const src = bodyLs.length >= 3 ? bodyLs : ls;
    const left = modeTol(src.map((l) => l.x0), 0.4 * body);
    const right = Math.max(pct(src.map((l) => l.x1), 0.9), left + body);
    return { left, right };
  };
  if (ncol > 1) {
    // centered material above the start of the column bodies (author blocks) spans the page
    let start = Infinity;
    for (let c = 0; c < ncol; c++) {
      const ls = elems.filter((e) => e.kind === "line" && e.col === c).map((e) => e.l);
      const { left } = colMetrics(ls);
      const first = ls.filter((l) => Math.abs(l.x0 - left) < body && Math.abs(l.size - body) < 0.2 * body).sort((a, b) => a.y - b.y)[0];
      if (first) start = Math.min(start, first.top);
    }
    for (const e of elems) {
      if (e.kind !== "line" || e.col < 0 || e.l.bottom > start - 2 * body) continue;
      const { left } = colMetrics(elems.filter((x) => x.kind === "line" && x.col === e.col).map((x) => x.l));
      if (e.l.x0 > left + body) e.col = -1;
    }
  }
  for (let c = -1; c < ncol; c++) {
    const ls = c === -1 && ncol > 1 ? lines : elems.filter((e) => e.kind === "line" && e.col === c).map((e) => e.l);
    const bodyLs = ls.filter((l) => Math.abs(l.size - body) < 0.15 * body);
    const src = bodyLs.length >= 3 ? bodyLs : ls;
    const left = c === -1 && ncol > 1 ? pct(ls.map((l) => l.x0), 0.02) : modeTol(src.map((l) => l.x0), 0.4 * body);
    const right = c === -1 && ncol > 1 ? pct(ls.map((l) => l.x1), 0.98) : Math.max(pct(src.map((l) => l.x1), 0.9), left + body);
    const justified = src.filter((l) => l.x1 > right - body).length / Math.max(1, src.length);
    cols[c + 1] = { left, right, width: right - left, ragged: justified < 0.4 };
  }
  // bands: spanning elements separate column flows
  const chunks = [];
  let band = [];
  const flush = () => {
    for (let c = 0; c < ncol; c++) {
      const part = band.filter((e) => e.col === c);
      if (part.length) chunks.push({ col: c, elems: part });
    }
    band = [];
  };
  for (const e of elems) {
    if (e.col === -1 && ncol > 1) { flush(); chunks.push({ col: -1, elems: [e] }); }
    else band.push(e);
  }
  flush();
  // merge consecutive spanning chunks
  const merged = [];
  for (const ch of chunks) {
    const prev = merged[merged.length - 1];
    if (prev && prev.col === -1 && ch.col === -1) prev.elems.push(...ch.elems);
    else merged.push(ch);
  }
  const blocks = [];
  for (const ch of merged) {
    const col = ncol > 1 ? cols[ch.col + 1] : cols[1];
    const bs = chunkBlocks(ch.elems, col, stats, page);
    if (bs.length) {
      bs[0].chunkFirst = true;
      const body = bs.filter((b) => !b.footnote);
      (body[body.length - 1] || bs[bs.length - 1]).chunkLast = true;
    }
    blocks.push(...bs);
  }
  return blocks;
}

function rowsOf(elems, body) {
  const rows = [];
  for (const e of elems) {
    if (e.kind === "fig") { rows.push({ fig: e }); continue; }
    const prev = rows[rows.length - 1];
    if (prev && !prev.fig && Math.abs(e.l.y - prev.y) < 0.4 * Math.max(prev.size, e.l.size, body * 0.5)) {
      prev.segs.push(e.l);
      prev.segs.sort((a, b) => a.x0 - b.x0);
    } else rows.push({ segs: [e.l], y: e.l.y, size: e.l.size });
  }
  for (const r of rows) {
    if (r.fig) continue;
    // a lone list marker followed by its text is one segment
    const segs = [];
    for (const s of r.segs) {
      const p = segs[segs.length - 1];
      if (p && ((MARKER.test(p.text) && p.text.length <= 5 && !p.text.includes(" ")) || (/^(\d{1,2}(\.\d{1,2}){0,4}\.?|[A-Z](\.\d{1,2}){1,3}\.?|[A-Z]\.|[IVX]{1,5}\.)$/.test(p.text) && s.x0 - p.x1 < 3 * s.size && /^[A-Za-z]/.test(s.text))))
        segs[segs.length - 1] = joinSegs([p, s]);
      else segs.push(s);
    }
    r.segs = segs;
    r.line = segs.length === 1 ? segs[0] : joinSegs(segs);
  }
  return rows;
}
function joinSegs(segs) {
  const l = { ...segs[0], text: segs.map((s) => s.text).join(" "), x0: Math.min(...segs.map((s) => s.x0)), x1: Math.max(...segs.map((s) => s.x1)) };
  const chars = segs.reduce((a, s) => a + s.chars, 0);
  l.chars = chars;
  l.boldFrac = chars ? segs.reduce((a, s) => a + s.boldFrac * s.chars, 0) / chars : 0;
  l.italicFrac = chars ? segs.reduce((a, s) => a + s.italicFrac * s.chars, 0) / chars : 0;
  l.mathFrac = chars ? segs.reduce((a, s) => a + s.mathFrac * s.chars, 0) / chars : 0;
  l.size = segs.reduce((a, s) => (s.chars > a.c ? { c: s.chars, s: s.size } : a), { c: -1, s: segs[0].size }).s;
  l.top = Math.min(...segs.map((s) => s.top)); l.bottom = Math.max(...segs.map((s) => s.bottom));
  return l;
}

function detectTables(rows, stats) {
  const body = stats.body;
  const tables = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.fig || r.segs.length < 2 || r.line.mathFrac > 0.3) { i++; continue; }
    let j = i + 1, singles = 0, lastMulti = i;
    while (j < rows.length) {
      const q = rows[j];
      if (q.fig) break;
      const gap = q.y - rows[j - 1].y;
      if (gap > 3 * stats.pitch * Math.max(q.size, body)) break;
      if (q.segs.length >= 2 && q.line.mathFrac <= 0.3) { singles = 0; lastMulti = j; }
      else if (++singles > 1) break;
      j++;
    }
    // wrapped cell text below the last row
    let end = lastMulti;
    while (end + 1 < rows.length && end - lastMulti < 2) {
      const q = rows[end + 1];
      if (q.fig || q.segs.length !== 1 || q.y - rows[end].y > 1.4 * stats.pitch * q.size || q.line.x0 <= r.segs[0].x1) break;
      end++;
    }
    const run = rows.slice(i, end + 1);
    const multi = run.filter((x) => x.segs.length >= 2).length;
    if (run.length >= 3 && multi >= 3 && multi / (lastMulti - i + 1) >= 0.6) {
      const t = buildTable(run, body);
      if (t) { tables.push({ start: i, end, md: t }); i = end + 1; continue; }
    }
    i++;
  }
  return tables;
}

function buildTable(run, body) {
  // column intervals from the most common multi-segment row shape
  const freq = new Map();
  for (const r of run) if (r.segs.length >= 2) freq.set(r.segs.length, (freq.get(r.segs.length) || 0) + 1);
  const shape = [...freq].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  const basis = run.filter((r) => r.segs.length === shape).flatMap((r) => r.segs.map((s) => [s.x0, s.x1]));
  basis.sort((a, b) => a[0] - b[0]);
  const cols = [];
  for (const [a, b] of basis) {
    const c = cols[cols.length - 1];
    if (c && a < c[1] + 0.2 * body) c[1] = Math.max(c[1], b);
    else cols.push([a, b]);
  }
  if (cols.length < 2) return null;
  // first column made only of list markers -> it's a list, not a table
  const firsts = run.map((r) => r.segs[0].text);
  if (firsts.every((t) => MARKER.test(t) && t.length <= 5)) return null;
  const grid = [];
  let prevY = null;
  for (const r of run) {
    const cells = cols.map(() => []);
    for (const s of r.segs) {
      let best = 0, bo = -Infinity;
      cols.forEach(([a, b], k) => {
        const ov = Math.min(b, s.x1) - Math.max(a, s.x0);
        const d = ov > 0 ? ov : -Math.min(Math.abs(s.x0 - b), Math.abs(a - s.x1));
        if (d > bo) { bo = d; best = k; }
      });
      cells[best].push(s.text);
    }
    const row = cells.map((c) => c.join(" "));
    const prev = grid[grid.length - 1];
    const filled = row.filter(Boolean).length;
    // wrapped cell text: continuation row without a first-column value, tight below the previous row
    if (prev && !row[0] && filled < prev.filter(Boolean).length && prevY != null && r.y - prevY < 1.35 * r.size * 1.2) {
      row.forEach((t, k) => { if (t) prev[k] = prev[k] ? prev[k] + " " + t : t; });
    } else grid.push(row);
    prevY = r.y;
  }
  // two columns of running prose are not a table
  const longCols = cols.filter((_, k) => {
    const cells = grid.map((r) => r[k]).filter(Boolean);
    return cells.length && cells.reduce((a, t) => a + t.length, 0) / cells.length > 38;
  }).length;
  if (longCols >= 2) return null;
  const aligned = grid.filter((r) => r.filter(Boolean).length >= 2).length;
  if (aligned < 2 || aligned / grid.length < 0.5) return null;
  return grid.map((r) => r.map((t) => escapeMd(t)));
}

function chunkBlocks(elems, col, stats, page) {
  const body = stats.body;
  const rows = rowsOf(elems, body);
  const tables = detectTables(rows, stats);
  const tableAt = new Map(tables.map((t) => [t.start, t]));
  const blocks = [];
  let cur = null;
  const centered = (l) => l.x0 > col.left + 3 * l.size && l.x1 < col.right - 3 * l.size && Math.abs((l.x0 + l.x1) / 2 - (col.left + col.right) / 2) < 2.5 * l.size;
  const close = () => { if (cur) blocks.push(cur); cur = null; };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (tableAt.has(i)) {
      close();
      const t = tableAt.get(i);
      blocks.push({ type: "table", rows: t.md, page: page.index, size: body, top: rows[i].line.top });
      i = t.end;
      continue;
    }
    if (r.fig) { close(); blocks.push({ type: "figure", fig: r.fig.f, idx: r.fig.idx, page: page.index, top: r.fig.f.y0 }); continue; }
    const l = r.line;
    if (cur) {
      const p = cur.lines[cur.lines.length - 1];
      const sz = Math.max(p.size, l.size);
      const gap = l.y - p.y;
      const limit = stats.pitch * sz * 1.38;
      const isList = MARKER.test(cur.lines[0].text);
      let split = false;
      if (gap > limit || gap < -0.5 * sz) split = true;
      else if (Math.abs(l.size - p.size) > (page.ocr ? 0.25 : 0.1) * sz) split = true;
      else if ((p.boldFrac > 0.8) !== (l.boldFrac > 0.8) && (p.chars < 80 || l.chars < 80)) split = true;
      else if (MARKER.test(l.text) && (l.x0 <= cur.lines[0].x0 + 1.2 * l.size || isList)) split = true;
      else if (!isList && l.x0 - col.left > 0.6 * l.size && l.x0 - col.left < 5 * l.size && Math.abs(p.x0 - col.left) < 0.6 * l.size && !centered(l)) split = true;
      else if (centered(l) !== centered(p)) split = true;
      else if (p.x1 < col.right - Math.max(3 * p.size, (col.ragged ? 0.3 : 0.12) * col.width) && END_PUNCT.test(p.text) && !centered(p)) split = true;
      else if (cur.lines.length === 1 && isHeadingLike(p, stats) && !isHeadingLike(l, stats)) split = true;
      if (!split) { cur.lines.push(l); if (r.segs.length > 1) cur.multiSeg = true; continue; }
      close();
    }
    cur = { type: "text", ocr: !!page.ocr, lines: [l], page: page.index, top: l.top, colLeft: col.left, colWidth: col.width, multiSeg: false };
    if (r.segs.length > 1) cur.multiSeg = true;
  }
  close();
  for (const b of blocks) if (b.type === "text") finishBlock(b);
  // footnotes: small text at the bottom of the column
  let lastBody = -Infinity;
  for (const b of blocks) if (b.type === "text" && b.size > 0.9 * body) lastBody = Math.max(lastBody, b.top);
  for (const b of blocks) {
    if (b.type === "text" && b.size <= 0.88 * body && b.top > lastBody && b.top > page.height * 0.55 && /^(\d{1,2}|[*∗†‡§¶])\s?\S/.test(b.text) && !CAPTION.test(b.text)) b.footnote = true;
  }
  return blocks;
}

function isHeadingLike(l, stats) {
  return (l.size >= stats.body * 1.15 || l.boldFrac > 0.8) && l.chars < 120;
}

function finishBlock(b) {
  let text = "";
  for (const l of b.lines) {
    const t = l.text;
    if (!text) { text = t; continue; }
    if (/[A-Za-zÀ-ÿ][-‐­]$/.test(text) && /^[a-zà-ÿ]/.test(t)) text = text.slice(0, -1) + t;
    else if (/­$/.test(text)) text = text.slice(0, -1) + t;
    else text += " " + t;
  }
  b.text = text.replace(/­/g, "").replace(/\s+/g, " ").trim();
  const chars = b.lines.reduce((a, l) => a + l.chars, 0) || 1;
  b.chars = chars;
  b.size = weightedMedian(b.lines.map((l) => [l.size, l.chars])) || b.lines[0].size;
  b.boldFrac = b.lines.reduce((a, l) => a + l.boldFrac * l.chars, 0) / chars;
  b.mathFrac = b.lines.reduce((a, l) => a + l.mathFrac * l.chars, 0) / chars;
  b.x0 = Math.min(...b.lines.map((l) => l.x0));
  b.x1 = Math.max(...b.lines.map((l) => l.x1));
}

// ---------- classification ----------
function classify(blocks, stats, pages) {
  const body = stats.body;
  // title: largest text near the top of the first page with text
  const firstPage = blocks.find((b) => b.type === "text")?.page;
  let title = null;
  for (const b of blocks) {
    if (b.type !== "text" || b.page !== firstPage) continue;
    const H = pages[b.page].height;
    if (b.top > H * 0.45 || b.size < body * 1.3 || b.chars > 250 || NUMBERED.test(b.text) || NAMED.test(b.text)) continue;
    if (!title || b.size > title.size) title = b;
  }
  if (title) title.type = "title";
  for (const b of blocks) {
    if (b.type !== "text") continue;
    const t = b.text;
    if (b.footnote) { b.type = "footnote"; continue; }
    if (CAPTION.test(t)) { b.type = "caption"; continue; }
    if (b.mathFrac >= 0.3 && b.chars < 400) { b.type = "formula"; continue; }
    if (isHeading(b, stats)) { b.type = "h"; continue; }
    // OCR engines often read "•" as "e", "o" or "°"
    if (b.ocr && /^[eo°«]\s+[A-Z]/.test(t)) b.text = "•" + t.slice(1);
    const m = MARKER.exec(b.text);
    if (m && b.text.length > m[0].length + 1) {
      b.type = "li";
      b.marker = m[1];
      b.text = b.text.slice(m[0].length).trim();
      continue;
    }
    if (isHeading(b, stats)) { b.type = "h"; continue; }
    b.type = "p";
  }
  // stacked limits / indices around a formula (small fragments) belong to it
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type !== "formula") continue;
    for (const j of [i - 1, i + 1]) {
      const o = blocks[j];
      if (o && o.page === b.page && (o.type === "p" || o.type === "h") && o.chars <= 12 && o.size < body * 0.95 && Math.abs(o.top - b.top) < body * 4) o.type = "formula-part";
    }
  }
  // heading levels
  const heads = blocks.filter((b) => b.type === "h");
  const numberedSizes = new Map();
  for (const h of heads) {
    const m = NUMBERED.exec(h.text);
    if (m && /^\d/.test(m[1])) {
      const depth = m[1].replace(/\.$/, "").split(".").length;
      h.level = Math.min(6, depth + 1);
      numberedSizes.set(Math.round(h.size * 2) / 2, h.level);
    } else if (m && /^[A-Z](\.\d+)*\.?$/.test(m[1])) {
      h.level = Math.min(6, m[1].replace(/\.$/, "").split(".").length + 1);
    } else if (m && /^[IVX]+\.$/.test(m[1])) h.level = 2;
  }
  const unnumbered = heads.filter((h) => h.level == null);
  const sizes = [...new Set(unnumbered.map((h) => Math.round(h.size * 2) / 2))].sort((a, b) => b - a);
  for (const h of unnumbered) {
    const key = Math.round(h.size * 2) / 2;
    if (numberedSizes.has(key)) h.level = numberedSizes.get(key);
    else if (NAMED.test(h.text) || numberedSizes.size === 0) h.level = Math.min(4, 2 + sizes.indexOf(key));
    else {
      // between known numbered levels: nearest by size
      let best = 2, bd = Infinity;
      for (const [s, lv] of numberedSizes) if (Math.abs(s - key) < bd) { bd = Math.abs(s - key); best = lv; }
      h.level = best;
    }
    if (NAMED.test(h.text)) h.level = 2;
  }
}

function isHeading(b, stats) {
  const t = b.text;
  const body = stats.body;
  if (b.lines.length > 3 || b.chars > 150 || b.chars < 2 || b.multiSeg) return false;
  if (/^[\d\s.,%$€£()+\-–—]+$/.test(t)) return false; // numbers
  if (b.mathFrac > 0.4) return false;
  const ratio = b.size / body;
  const bold = b.boldFrac > 0.75;
  const numbered = NUMBERED.exec(t);
  const endsSentence = /[.,;]$/.test(t) && !/\.\.\.$/.test(t);
  if (NAMED.test(t) && b.lines.length === 1 && (bold || ratio >= 1.05 || /^[A-Z\s]+$/.test(t) || b.x0 > b.colLeft + 2 * b.size)) return true;
  if (b.ocr && (ratio < 1.25 || b.chars > 100)) return !!(numbered && ratio >= 1.02 && b.lines.length === 1 && !endsSentence && b.chars < 80);
  if (ratio >= 1.15 && !endsSentence && b.lines.length <= 3) return true;
  if (bold && ratio >= 0.95 && b.lines.length <= 2 && !endsSentence && (numbered || b.chars <= 80)) return true;
  if (numbered && ratio >= 0.95 && b.lines.length <= 2) {
    const rest = numbered[numbered.length - 1];
    const letters = rest.replace(/[^A-Za-z]/g, "");
    if (letters.length >= 3 && letters === letters.toUpperCase() && !endsSentence) return true; // small caps "I. INTRODUCTION"
  }
  return false;
}

// ---------- rendering ----------
function render(blocks, stats, opts) {
  const out = [];
  let pendingNotes = [];
  let notesPage = -1;
  let last = null;
  const flushNotes = () => { for (const n of pendingNotes) out.push(n); pendingNotes = []; };
  const listBase = { x: null };
  for (const b of blocks) {
    if (b.type === "footnote") { pendingNotes.push(escapeLineStart(escapeMd(b.text.replace(/^(\d{1,2}|[*∗†‡§¶])(?=[A-Z])/, "$1 ")))); notesPage = b.page; continue; }
    if (b.type === "p" && last && last.type === "p" && canContinue(last, b)) {
      const hy = /[A-Za-zÀ-ÿ][-‐]$/.test(last.text) && /^[a-zà-ÿ]/.test(b.text);
      last.text = hy ? last.text.slice(0, -1) + b.text : last.text + " " + b.text;
      last.chunkLast = b.chunkLast;
      last.md = escapeLineStart(escapeMd(last.text));
      out[out.length - 1] = last.md;
      continue;
    }
    if (pendingNotes.length && b.page > notesPage) flushNotes();
    let md;
    switch (b.type) {
      case "raw": md = b.md; break;
      case "title": md = "# " + escapeMd(b.text); break;
      case "h": md = "#".repeat(b.level || 2) + " " + escapeMd(b.text); break;
      case "li": {
        if (!last || last.type !== "li") listBase.x = b.x0;
        listBase.x = Math.min(listBase.x, b.x0);
        const level = Math.max(0, Math.min(4, Math.round((b.x0 - listBase.x) / (1.5 * b.size))));
        const ordered = /^\d{1,3}[.)]$/.test(b.marker);
        const marker = ordered ? b.marker.replace(")", ".") : "-";
        const keep = !ordered && !BULLET.test(b.marker) ? b.marker + " " : "";
        md = { md: " ".repeat(4 * level) + marker + " " + escapeMd(keep + b.text), list: true };
        break;
      }
      case "table": md = renderTable(b.rows, { header: true }); break;
      case "figure": md = opts.figure ? opts.figure(b.page, b.idx, b.fig) : "<!-- image -->"; break;
      case "formula":
        if (last && last.type === "formula" && last.page === b.page) continue;
        md = opts.formula ? opts.formula(b) : "<!-- formula-not-decoded -->"; break;
      case "formula-part": continue;
      default: md = escapeLineStart(escapeMd(b.text));
    }
    // Docling puts a figure's caption before the picture
    if (b.type === "caption" && last && last.type === "figure" && out.length) {
      const fig = out.pop();
      out.push(md, fig);
      b.md = md;
      last = { ...b, type: "figure-captioned" };
      continue;
    }
    out.push(md);
    b.md = md;
    last = b;
  }
  flushNotes();
  return joinBlocks(out);
}

function canContinue(q, p) {
  if (!q.chunkLast || !p.chunkFirst) return false;
  if (Math.abs(q.size - p.size) > 0.12 * Math.max(q.size, p.size)) return false;
  if (END_PUNCT.test(q.text)) return false;
  return /^[a-zà-ÿ(]/.test(p.text) || /[A-Za-z][-‐]$/.test(q.text) || /[,]$/.test(q.text);
}
