// Visual comparisons: the two files as they look, not as raw text.
//  · Document — Markdown / Word / PDF text drawn as a document, block by block side by side, with
//    the words that changed marked (struck through on the left, highlighted on the right).
//  · Table — spreadsheets as grids; changed cells show the old and the new value.
//  · Pages — PDF pages, Word pages and slides drawn exactly as they print, side by side, with the
//    spots that differ tinted.
import { ic } from "./icons.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---------------------------------------------------------------- diff helpers
/** Longest-common-subsequence edit script of two arrays of keys → [{op:"=",a,b}|{op:"-",a}|{op:"+",b}] */
export function diffSeq(A, B) {
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0;
  while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const a = A.slice(s, A.length - e), b = B.slice(s, B.length - e);
  const out = [];
  for (let i = 0; i < s; i++) out.push({ op: "=", a: i, b: i });
  const n = a.length, m = b.length;
  if (n * m > 25e6) {
    // very large: no alignment inside the changed middle
    for (let i = 0; i < n; i++) out.push({ op: "-", a: s + i });
    for (let j = 0; j < m; j++) out.push({ op: "+", b: s + j });
  } else if (n && m) {
    const W = m + 1;
    const L = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * W + j] = a[i] === b[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push({ op: "=", a: s + i, b: s + j }); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) out.push({ op: "-", a: s + i++ });
      else out.push({ op: "+", b: s + j++ });
    }
    while (i < n) out.push({ op: "-", a: s + i++ });
    while (j < m) out.push({ op: "+", b: s + j++ });
  } else {
    for (let i = 0; i < n; i++) out.push({ op: "-", a: s + i });
    for (let j = 0; j < m; j++) out.push({ op: "+", b: s + j });
  }
  for (let i = 0; i < e; i++) out.push({ op: "=", a: A.length - e + i, b: B.length - e + i });
  return out;
}

/** Group an edit script into rows: equal pairs, and changed hunks with deletions paired to insertions. */
function rowsOf(script, sim) {
  const rows = [];
  let dels = [], ins = [];
  const flush = () => {
    // pair similar blocks in order; the rest stand alone
    let j = 0;
    for (const d of dels) {
      let k = j;
      while (k < ins.length && sim(d, ins[k]) < 0.35) k++;
      if (k < ins.length && k - j <= 3) {
        for (; j < k; j++) rows.push({ kind: "add", b: ins[j] });
        rows.push({ kind: "chg", a: d, b: ins[j++] });
      } else rows.push({ kind: "del", a: d });
    }
    for (; j < ins.length; j++) rows.push({ kind: "add", b: ins[j] });
    dels = []; ins = [];
  };
  for (const s of script) {
    if (s.op === "=") { flush(); rows.push({ kind: "same", a: s.a, b: s.b }); }
    else if (s.op === "-") dels.push(s.a);
    else ins.push(s.b);
  }
  flush();
  return rows;
}

const words = (s) => s.match(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}]/gu) || [];
function similarity(x, y) {
  const a = new Set(x.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []), b = new Set(y.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  if (!a.size && !b.size) return x.trim() === y.trim() ? 1 : 0.5;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.max(a.size, b.size);
}

/** Character ranges of the words that differ: [rangesInX, rangesInY]. */
function wordRanges(x, y) {
  const A = words(x), B = words(y);
  const script = diffSeq(A, B);
  const ra = [], rb = [];
  const offA = [0], offB = [0];
  for (const w of A) offA.push(offA[offA.length - 1] + w.length);
  for (const w of B) offB.push(offB[offB.length - 1] + w.length);
  const push = (list, from, to) => { const last = list[list.length - 1]; if (last && last[1] >= from) last[1] = Math.max(last[1], to); else list.push([from, to]); };
  for (const s of script) {
    if (s.op === "-" && A[s.a].trim()) push(ra, offA[s.a], offA[s.a + 1]);
    if (s.op === "+" && B[s.b].trim()) push(rb, offB[s.b], offB[s.b + 1]);
  }
  // join neighbours split only by a space, so whole phrases are marked
  const join = (list, text) => list.reduce((o, r) => { const l = o[o.length - 1]; if (l && /^\s*$/.test(text.slice(l[1], r[0]))) l[1] = r[1]; else o.push([...r]); return o; }, []);
  return [join(ra, x), join(rb, y)];
}

/** Wrap the character ranges of el's text in <tag class=cls>. */
function markRanges(el, ranges, tag, cls) {
  if (!ranges.length) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let pos = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push([n, pos]); pos += n.data.length; }
  for (const [n, start] of nodes.reverse()) {
    const end = start + n.data.length;
    for (const [f, t] of [...ranges].reverse()) {
      if (t <= start || f >= end) continue;
      const a = Math.max(f, start) - start, b = Math.min(t, end) - start;
      if (b <= a) continue;
      const r = document.createRange();
      r.setStart(n, a); r.setEnd(n, b);
      const w = document.createElement(tag);
      w.className = cls;
      try { r.surroundContents(w); } catch { /* crosses an element: leave it */ }
    }
  }
}

// ---------------------------------------------------------------- Document view
/** Split Markdown into blocks that line up well (paragraphs, headings, each list item, tables, code). */
export function mdBlocks(text) {
  const out = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let cur = [], fence = null;
  const flush = () => { if (cur.length) out.push(cur.join("\n")); cur = []; };
  for (const l of lines) {
    if (fence) { cur.push(l); if (l.trim().startsWith(fence)) { fence = null; flush(); } continue; }
    const f = l.match(/^\s*(```+|~~~+)/);
    if (f) { flush(); fence = f[1]; cur.push(l); continue; }
    if (!l.trim()) { flush(); continue; }
    const isTable = /^\s*\|/.test(l), wasTable = cur.length && /^\s*\|/.test(cur[cur.length - 1]);
    if (/^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|---+\s*$|\*\*\*+\s*$)/.test(l) && !(isTable && wasTable)) { flush(); cur.push(l); if (/^\s{0,3}#{1,6}\s|^-{3,}\s*$/.test(l)) flush(); continue; }
    if (isTable !== !!wasTable && cur.length) flush();
    cur.push(l);
  }
  flush();
  return out;
}

/**
 * Side-by-side rendered comparison. A/B: Markdown text (or plain text when plain=true).
 * Returns {changes, el, next(dir)}.
 */
export async function documentView(body, A, B, { plain = false, fold = true, dir = "" } = {}) {
  const { mdToHtml } = await import("./md.js");
  const ba = plain ? A.split(/\n{2,}|\n(?=— page \d+ —)/) : mdBlocks(A);
  const bb = plain ? B.split(/\n{2,}|\n(?=— page \d+ —)/) : mdBlocks(B);
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const ka = ba.map(norm), kb = bb.map(norm);
  const rows = rowsOf(diffSeq(ka, kb), (i, j) => similarity(ka[i], kb[j]));
  const render = (src) => {
    const d = document.createElement("div");
    d.className = "dv-cell md-body";
    if (plain) { const p = document.createElement("p"); p.textContent = src; d.appendChild(p); }
    else d.innerHTML = mdToHtml(src, dir);
    return d;
  };
  const wrap = document.createElement("div");
  wrap.className = "dv-wrap";
  wrap.innerHTML = `<div class="dv-cols"><div class="dv-colhead">Left</div><div class="dv-colhead">Right</div></div>`;
  const grid = document.createElement("div");
  grid.className = "dv-grid";
  wrap.appendChild(grid);
  const changes = [];
  let i = 0;
  const addRow = (r) => {
    const row = document.createElement("div");
    row.className = `dv-row dv-${r.kind}`;
    const L = r.a != null ? render(ba[r.a]) : Object.assign(document.createElement("div"), { className: "dv-cell dv-gap" });
    const R = r.b != null ? render(bb[r.b]) : Object.assign(document.createElement("div"), { className: "dv-cell dv-gap" });
    if (r.kind === "chg") {
      const [ra, rb] = wordRanges(L.textContent, R.textContent);
      markRanges(L, ra, "del", "dw");
      markRanges(R, rb, "ins", "dw");
    }
    row.append(L, R);
    grid.appendChild(row);
    if (r.kind !== "same") changes.push(row);
  };
  while (i < rows.length) {
    if (rows[i].kind !== "same") { addRow(rows[i++]); continue; }
    let j = i;
    while (j < rows.length && rows[j].kind === "same") j++;
    const run = rows.slice(i, j);
    const keep = 2;
    if (fold && run.length > keep * 2 + 2) {
      const head = i === 0 ? [] : run.slice(0, keep), tail = j === rows.length ? [] : run.slice(-keep);
      head.forEach(addRow);
      const hidden = run.slice(head.length, run.length - tail.length);
      const bar = document.createElement("button");
      bar.className = "dv-fold";
      bar.innerHTML = `${ic("chevron-down")}<span>${hidden.length} unchanged block${hidden.length === 1 ? "" : "s"}</span>`;
      bar.onclick = () => {
        const frag = document.createDocumentFragment();
        const before = grid.childElementCount;
        hidden.forEach(addRow);
        // addRow appended at the end: move the new rows in place of the bar
        const added = [...grid.children].slice(before);
        added.forEach((n) => frag.appendChild(n));
        bar.replaceWith(frag);
      };
      grid.appendChild(bar);
      tail.forEach(addRow);
    } else run.forEach(addRow);
    i = j;
  }
  body.appendChild(wrap);
  // equal heights per row are given by the grid; images inside load lazily
  return { changes, el: wrap };
}

// ---------------------------------------------------------------- Table view (spreadsheets)
const colName = (i) => { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const cellText = (v) => (Array.isArray(v) ? String(v[0] ?? "") : v == null ? "" : String(v));
const cellFormula = (v) => (Array.isArray(v) ? v[1] : null);

/** sheetsA/B: [{name, rows:[[cell…]]}] */
export function gridView(body, sheetsA, sheetsB, { fold = true } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "gv-wrap";
  const names = [...new Set([...sheetsA.map((s) => s.name), ...sheetsB.map((s) => s.name)])];
  const changes = [];
  const tabs = document.createElement("div");
  tabs.className = "gv-tabs";
  wrap.appendChild(tabs);
  const host = document.createElement("div");
  host.className = "gv-host";
  wrap.appendChild(host);
  const stats = names.map((name) => {
    const a = sheetsA.find((s) => s.name === name), b = sheetsB.find((s) => s.name === name);
    return { name, a, b };
  });
  const show = (k) => {
    [...tabs.children].forEach((t, i) => t.classList.toggle("active", i === k));
    host.innerHTML = "";
    changes.length = 0;
    const { a, b, name } = stats[k];
    if (!a || !b) { host.innerHTML = `<div class="gv-only">${a ? "This sheet is only in the left file." : "This sheet is only in the right file."}</div>`; return; }
    const ra = a.rows || [], rb = b.rows || [];
    const key = (r) => (r || []).map(cellText).join("\u0001");
    const rows = rowsOf(diffSeq(ra.map(key), rb.map(key)), (i, j) => similarity(key(ra[i]).replace(/\u0001/g, " "), key(rb[j]).replace(/\u0001/g, " ")));
    const cols = Math.max(1, ...ra.map((r) => r?.length || 0), ...rb.map((r) => r?.length || 0));
    const t = document.createElement("table");
    t.className = "gv-table";
    t.innerHTML = `<thead><tr><th class="gv-rn">L</th><th class="gv-rn">R</th>${Array.from({ length: cols }, (_, i) => `<th>${colName(i)}</th>`).join("")}</tr></thead>`;
    const tb = document.createElement("tbody");
    const tr = (r) => {
      const row = document.createElement("tr");
      row.className = `gv-${r.kind}`;
      const A = r.a != null ? ra[r.a] || [] : null, B = r.b != null ? rb[r.b] || [] : null;
      let html = `<td class="gv-rn">${r.a != null ? r.a + 1 : ""}</td><td class="gv-rn">${r.b != null ? r.b + 1 : ""}</td>`;
      for (let c = 0; c < cols; c++) {
        const va = A ? cellText(A[c]) : "", vb = B ? cellText(B[c]) : "";
        const fa = A ? cellFormula(A[c]) : null, fb = B ? cellFormula(B[c]) : null;
        if (r.kind === "chg" && (va !== vb || fa !== fb)) {
          html += `<td class="gv-cell-chg" title="${esc(`Left: ${va}${fa ? ` (${fa})` : ""}\nRight: ${vb}${fb ? ` (${fb})` : ""}`)}">${va ? `<del>${esc(va)}</del>` : ""}<ins>${esc(vb) || "∅"}</ins></td>`;
        } else html += `<td>${esc(r.kind === "del" ? va : vb)}</td>`;
      }
      row.innerHTML = html;
      tb.appendChild(row);
      if (r.kind !== "same") changes.push(row);
    };
    let i = 0;
    while (i < rows.length) {
      if (rows[i].kind !== "same") { tr(rows[i++]); continue; }
      let j = i;
      while (j < rows.length && rows[j].kind === "same") j++;
      const run = rows.slice(i, j);
      if (fold && run.length > 8) {
        const head = i === 0 ? [] : run.slice(0, 2), tail = j === rows.length ? [] : run.slice(-2);
        head.forEach(tr);
        const hidden = run.slice(head.length, run.length - tail.length);
        const f = document.createElement("tr");
        f.className = "gv-fold";
        f.innerHTML = `<td colspan="${cols + 2}"><button class="dv-fold">${ic("chevron-down")}<span>${hidden.length} unchanged row${hidden.length === 1 ? "" : "s"}</span></button></td>`;
        f.querySelector("button").onclick = () => { const mark = f; const before = tb.childElementCount; hidden.forEach(tr); const added = [...tb.children].slice(before); added.forEach((n) => tb.insertBefore(n, mark)); mark.remove(); };
        tb.appendChild(f);
        tail.forEach(tr);
      } else run.forEach(tr);
      i = j;
    }
    t.appendChild(tb);
    host.appendChild(t);
  };
  stats.forEach((s, k) => {
    const b = document.createElement("button");
    b.className = "gv-tab";
    const same = s.a && s.b && JSON.stringify(s.a.rows) === JSON.stringify(s.b.rows);
    b.innerHTML = `<span>${esc(s.name)}</span>${!s.a || !s.b ? `<span class="gv-badge">${s.a ? "left only" : "right only"}</span>` : same ? "" : `<span class="gv-dot"></span>`}`;
    b.onclick = () => show(k);
    tabs.appendChild(b);
  });
  body.appendChild(wrap);
  const first = Math.max(0, stats.findIndex((s) => !s.a || !s.b || JSON.stringify(s.a.rows) !== JSON.stringify(s.b.rows)));
  show(first);
  return { changes, el: wrap, changedSheets: stats.filter((s) => !s.a || !s.b || JSON.stringify(s.a.rows) !== JSON.stringify(s.b.rows)).length };
}

// ---------------------------------------------------------------- Pages view
/**
 * srcA/srcB: { count, label: "Page"|"Slide", render(i, width) → Promise<HTMLImageElement|HTMLCanvasElement> , close() }
 * Pages are drawn lazily as they scroll into view; the right page shows the spots that differ.
 */
export function pagesView(body, srcA, srcB, { keysA, keysB } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "pg-wrap";
  // which page goes with which: by their text when known (an inserted slide doesn't shift the rest)
  let pairs;
  if (keysA?.length === srcA.count && keysB?.length === srcB.count) {
    const na = keysA.map((k) => k.replace(/\s+/g, " ").trim()), nb = keysB.map((k) => k.replace(/\s+/g, " ").trim());
    pairs = rowsOf(diffSeq(na, nb), (i, j) => similarity(na[i], nb[j])).map((r) => ({ a: r.a ?? null, b: r.b ?? null }));
  } else pairs = Array.from({ length: Math.max(srcA.count, srcB.count) }, (_, i) => ({ a: i < srcA.count ? i : null, b: i < srcB.count ? i : null }));
  const n = pairs.length;
  const bar = document.createElement("div");
  bar.className = "pg-bar";
  bar.innerHTML = `<label class="switch"><span>Show differences</span><input type="checkbox" checked><span class="knob"></span></label><span class="note">${srcA.count} ${srcA.label.toLowerCase()}${srcA.count === 1 ? "" : "s"} · ${srcB.count} ${srcB.label.toLowerCase()}${srcB.count === 1 ? "" : "s"}</span><span class="pg-sum note"></span>`;
  wrap.appendChild(bar);
  const list = document.createElement("div");
  list.className = "pg-list";
  wrap.appendChild(list);
  let showDiff = true, changed = 0, done = 0;
  bar.querySelector("input").onchange = (e) => { showDiff = e.target.checked; wrap.classList.toggle("no-diff", !showDiff); };
  const changes = [];
  const rows = [];
  for (let i = 0; i < n; i++) {
    const row = document.createElement("div");
    row.className = "pg-row";
    const p = pairs[i];
    const lab = p.a != null && p.b != null ? (p.a === p.b ? `${srcA.label} ${p.a + 1}` : `${srcA.label} ${p.a + 1} → ${p.b + 1}`) : p.a != null ? `${srcA.label} ${p.a + 1} (removed)` : `${srcA.label} ${p.b + 1} (new)`;
    row.innerHTML = `<div class="pg-label">${lab}<span class="pg-state"></span></div><div class="pg-pair"><div class="pg-side pg-a"></div><div class="pg-side pg-b"></div></div>`;
    list.appendChild(row);
    rows.push(row);
  }
  const width = () => Math.max(240, Math.min(900, (list.clientWidth - 60) / 2));
  const drawn = new Set();
  const draw = async (i) => {
    if (drawn.has(i)) return;
    drawn.add(i);
    const row = rows[i];
    const sa = row.querySelector(".pg-a"), sb = row.querySelector(".pg-b");
    sa.innerHTML = sb.innerHTML = `<div class="pg-wait"><span class="big-spinner"></span></div>`;
    const w = Math.round(width() * (devicePixelRatio || 1));
    const { a: ia, b: ib } = pairs[i];
    const [ca, cb] = await Promise.all([ia != null ? srcA.render(ia, w).catch(() => null) : null, ib != null ? srcB.render(ib, w).catch(() => null) : null]);
    sa.innerHTML = ""; sb.innerHTML = "";
    const frame = (img) => { const f = document.createElement("div"); f.className = "pg-frame"; img.style.width = Math.round(w / (devicePixelRatio || 1)) + "px"; f.appendChild(img); return f; };
    const fa = ca && frame(ca), fb = cb && frame(cb);
    if (fa) sa.appendChild(fa); else sa.innerHTML = `<div class="pg-missing">${ia != null ? `Couldn't draw this ${srcA.label.toLowerCase()}` : `Not in the left file`}</div>`;
    if (fb) sb.appendChild(fb); else sb.innerHTML = `<div class="pg-missing">${ib != null ? `Couldn't draw this ${srcB.label.toLowerCase()}` : `Not in the right file`}</div>`;
    let diff = !ca || !cb;
    if (ca && cb) {
      const ov = overlay(ca, cb);
      if (ov) { fb.appendChild(ov.canvas); diff = ov.share > 0.0004; if (diff) { const o2 = overlay(cb, ca); if (o2) fa.appendChild(o2.canvas); } }
    }
    row.classList.toggle("pg-changed", diff);
    row.querySelector(".pg-state").textContent = diff ? " · changed" : " · same";
    if (diff) { changed++; changes.push(row); changes.sort((x, y) => rows.indexOf(x) - rows.indexOf(y)); }
    done++;
    bar.querySelector(".pg-sum").textContent = done < n ? `${changed} changed so far (${done} of ${n} compared)` : `${changed} ${srcA.label.toLowerCase()}${changed === 1 ? "" : "s"} changed`;
  };
  const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) draw(rows.indexOf(e.target)); }, { root: null, rootMargin: "600px" });
  rows.forEach((r) => io.observe(r));
  body.appendChild(wrap);
  // compare every page in the background (a few at a time) so the summary is complete
  (async () => { for (let i = 0; i < n && wrap.isConnected; i++) { await draw(i); await new Promise((r) => setTimeout(r, 30)); } })();
  return { changes, el: wrap, destroy() { io.disconnect(); srcA.close?.(); srcB.close?.(); } };
}

/** Tinted overlay of where `b` differs from `a` (drawn over b). */
function overlay(a, b) {
  const W = 220;
  const toData = (img) => {
    const c = document.createElement("canvas");
    const h = Math.round((W * (img.naturalHeight || img.height)) / (img.naturalWidth || img.width)) || W;
    c.width = W; c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.fillStyle = "#fff"; g.fillRect(0, 0, W, h);
    g.drawImage(img, 0, 0, W, h);
    return g.getImageData(0, 0, W, h);
  };
  try {
    const da = toData(a), db = toData(b);
    const h = Math.min(da.height, db.height);
    const out = document.createElement("canvas");
    out.width = W; out.height = db.height;
    out.className = "pg-ov";
    const g = out.getContext("2d");
    const od = g.createImageData(W, db.height);
    let n = 0;
    for (let y = 0; y < db.height; y++) for (let x = 0; x < W; x++) {
      const k = (y * W + x) * 4;
      const d = y >= h ? 255 : Math.abs(da.data[k] - db.data[k]) + Math.abs(da.data[k + 1] - db.data[k + 1]) + Math.abs(da.data[k + 2] - db.data[k + 2]);
      if (d > 60) { od.data[k] = 255; od.data[k + 1] = 196; od.data[k + 2] = 0; od.data[k + 3] = 110; n++; }
    }
    g.putImageData(od, 0, 0);
    return { canvas: out, share: n / (W * db.height) };
  } catch { return null; }
}

/** A page source for a PDF file's bytes. */
export async function pdfSource(bytes) {
  const pdfjs = await import("pdfjs-dist");
  await import("./pdf.js"); // sets the worker
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false });
  const d = await task.promise;
  return {
    count: d.numPages, label: "Page",
    async render(i, w) {
      const page = await d.getPage(i + 1);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(4, w / base.width) });
      const c = document.createElement("canvas");
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, canvas: c, viewport: vp }).promise;
      c.className = "pg-img";
      return c;
    },
    close() { task.destroy(); },
  };
}

/** A page source for a Word document or a presentation (drawn by the office engine). */
export async function officeSource(path, kind) {
  const { office } = await import("./office.js");
  const r = await office(kind === "deck" ? "deck.open" : "word.open", { path });
  const id = r.id;
  const count = kind === "deck" ? r.state?.slides?.length || 0 : r.state?.pages?.length || 0;
  const ptW = kind === "deck" ? r.state?.w || 960 : r.state?.pages?.[0]?.[0] || 612;
  let chain = Promise.resolve();
  return {
    count, label: kind === "deck" ? "Slide" : "Page",
    render(i, w) {
      const p = chain.then(async () => {
        const out = kind === "deck" ? await office("deck.render", { id, slide: i, scale: w / ptW, edit: false }) : await office("word.render", { id, page: i, scale: Math.min(4, w / ptW) });
        const img = new Image();
        img.className = "pg-img";
        img.src = `data:image/png;base64,${out.png}`;
        await img.decode();
        return img;
      });
      chain = p.catch(() => {});
      return p;
    },
    close() { office(kind === "deck" ? "deck.close" : "word.close", { id }).catch(() => {}); },
  };
}
