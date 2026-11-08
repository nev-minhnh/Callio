// The preview of JSON, YAML and XML files: a tree you can fold, search and click (the source
// editor jumps to the clicked item). Large lists open a page at a time.
import { enter, cascade } from "./motion.js";
import { ic } from "./icons.js";

const PAGE = 200;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** io: { onPick(from), lineCol(pos) } */
export function mountTree(host, io) {
  host.innerHTML = `
    <div class="tv-bar">
      <button data-a="expand" title="Open every level">${ic("unfold")}<span>Expand all</span></button>
      <button data-a="collapse" title="Close every level">${ic("fold")}<span>Collapse all</span></button>
      <input class="tv-find" type="search" placeholder="Find keys and values…" />
      <span class="tb-spacer"></span>
      <span class="tv-info"></span>
    </div>
    <div class="tv-err" hidden></div>
    <div class="tv-body" tabindex="0"></div>`;
  const $ = (s) => host.querySelector(s);
  const body = $(".tv-body"), errEl = $(".tv-err");
  let tree = null, open = new Set(), query = "", lastText = null, kind = "json", lastKey = null;
  const nodes = new Map(); // path → node
  let seq = 0;

  const pathOf = (parent, key) => (typeof key === "number" ? `${parent}[${key}]` : /^[A-Za-z_$][\w$]*$/.test(String(key)) ? `${parent}.${key}` : `${parent}[${JSON.stringify(String(key))}]`);
  function count(n) { return n.children ? n.children.length : 0; }
  function summary(n) {
    if (n.type === "array") return `[${count(n)}]`;
    if (n.type === "object") return `{${count(n)}}`;
    if (n.type === "element") { const a = n.children.filter((c) => c.type === "attr").length, k = count(n) - a; return k ? `<${k}>` : ""; }
    return "";
  }
  function valueHtml(n) {
    if (n.type === "string") return `<span class="tv-s">${esc(kind === "json" || kind === "yaml" ? JSON.stringify(n.value) : n.value).slice(0, 2000)}</span>`;
    if (n.type === "attr") return `<span class="tv-s">"${esc(n.value)}"</span>`;
    if (n.type === "number") return `<span class="tv-n">${esc(n.raw ?? n.value)}</span>`;
    if (n.type === "boolean") return `<span class="tv-b">${esc(n.raw ?? String(n.value))}</span>`;
    if (n.type === "null") return `<span class="tv-null">null</span>`;
    if (n.type === "comment") return `<span class="tv-c">&lt;!-- ${esc(n.value).slice(0, 300)} --&gt;</span>`;
    return "";
  }
  const matches = (n) => {
    if (!query) return false;
    const q = query.toLowerCase();
    return String(n.key ?? "").toLowerCase().includes(q) || (n.value != null && String(n.value).toLowerCase().includes(q));
  };
  const subtreeMatches = (n) => matches(n) || (n.children || []).some(subtreeMatches);

  // `path`: where the node is (child indexes, unique); `jp`: its JSONPath / XPath-like name
  function rowHtml(n, path, depth, jp = "") {
    const id = ++seq;
    nodes.set(String(id), { n, path, depth, jp });
    const kids = n.children && n.children.length;
    const isOpen = kids && (open.has(path) || (query && subtreeMatches(n)));
    const key = n.key === null || n.key === undefined ? "" : typeof n.key === "number" ? `<span class="tv-i">${n.key}</span>` : `<span class="tv-k${n.type === "attr" ? " attr" : n.type === "element" ? " el" : ""}">${esc(n.key)}</span>`;
    let h = `<div class="tv-row${matches(n) ? " hit" : ""}" data-id="${id}" style="--d:${depth}">`;
    h += kids ? `<span class="tv-tw${isOpen ? " open" : ""}"></span>` : `<span class="tv-tw none"></span>`;
    h += key + (key && !kids && n.type !== "comment" ? `<span class="tv-colon">:</span> ` : " ") + (kids ? `<span class="tv-sum">${summary(n)}</span>` : "") + valueHtml(n);
    h += `</div>`;
    if (isOpen) h += `<div class="tv-kids" data-of="${id}">${kidsHtml(n, path, depth + 1, PAGE, jp)}</div>`;
    return h;
  }
  function kidsHtml(n, path, depth, limit, jp = "") {
    let h = "";
    const list = n.children;
    const shown = query ? list.filter(subtreeMatches) : list;
    for (let i = 0; i < Math.min(limit, shown.length); i++) { const c = shown[i]; h += rowHtml(c, `${path}/${list.indexOf(c)}`, depth, kind === "xml" ? `${jp}/${c.key}` : pathOf(jp, c.key)); }
    if (shown.length > limit) h += `<div class="tv-more" data-path="${esc(path)}" data-limit="${limit}" style="--d:${depth}">Show ${Math.min(PAGE, shown.length - limit)} more of ${shown.length - limit}…</div>`;
    return h;
  }
  function paint() {
    nodes.clear(); seq = 0;
    const top = body.scrollTop;
    body.innerHTML = tree ? rowHtml(tree, "", 0, kind === "xml" ? "/" + (tree.key || "") : "$") : "";
    body.scrollTop = top;
  }
  function openDefault(n, path, depth) {
    if (!n.children || depth > 1) return;
    open.add(path);
    if (n.children.length <= 50) n.children.forEach((c, i) => openDefault(c, `${path}/${i}`, depth + 1));
  }

  body.addEventListener("click", (e) => {
    const more = e.target.closest(".tv-more");
    if (more) {
      const row = more.parentElement.previousElementSibling;
      const info = nodes.get(row?.dataset.id);
      if (!info) return;
      const limit = +more.dataset.limit + PAGE;
      more.parentElement.innerHTML = kidsHtml(info.n, info.path, info.depth + 1, limit, info.jp);
      return;
    }
    const row = e.target.closest(".tv-row");
    if (!row) return;
    const info = nodes.get(row.dataset.id);
    if (!info) return;
    body.querySelector(".tv-row.on")?.classList.remove("on");
    row.classList.add("on");
    if (e.target.closest(".tv-tw") || (e.detail === 2 && info.n.children)) return toggle(row, info);
    if (info.n.from != null) io.onPick?.(info.n.from);
  });
  body.addEventListener("dblclick", (e) => { const row = e.target.closest(".tv-row"); const info = row && nodes.get(row.dataset.id); if (info?.n.children) toggle(row, info); });
  function toggle(row, info) {
    const tw = row.querySelector(".tv-tw");
    if (!info.n.children?.length) return;
    if (open.has(info.path)) {
      open.delete(info.path);
      tw.classList.remove("open");
      const k = row.nextElementSibling;
      if (k?.classList.contains("tv-kids")) k.remove();
    } else {
      open.add(info.path);
      tw.classList.add("open");
      const k = document.createElement("div");
      k.className = "tv-kids";
      k.innerHTML = kidsHtml(info.n, info.path, info.depth + 1, PAGE, info.jp);
      row.after(k);
      cascade(k.children);
    }
  }
  body.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".tv-row"); const info = row && nodes.get(row.dataset.id);
    if (!info) return;
    e.preventDefault();
    const p = info.jp;
    const v = info.n.children ? null : info.n.value;
    navigator.clipboard?.writeText(e.shiftKey && v != null ? String(v) : p).catch(() => {});
    io.toast?.(`Copied ${e.shiftKey && v != null ? "the value" : p}`);
  });
  host.querySelector(".tv-bar").addEventListener("click", (e) => {
    const a = e.target.closest("button")?.dataset.a;
    if (a === "expand") { const walk = (n, p) => { if (n.children?.length) { open.add(p); n.children.forEach((c, i) => walk(c, `${p}/${i}`)); } }; if (tree) walk(tree, ""); paint(); }
    if (a === "collapse") { open.clear(); if (tree) open.add(""); paint(); }
  });
  let ft = 0;
  $(".tv-find").addEventListener("input", (e) => { clearTimeout(ft); ft = setTimeout(() => { query = e.target.value.trim(); paint(); }, 150); });

  // ---------- split view: scrolling together with the source ----------
  let rowsCache = null;
  const rows = () => {
    if (rowsCache) return rowsCache;
    rowsCache = [];
    for (const el of body.querySelectorAll(".tv-row")) { const i = nodes.get(el.dataset.id); if (i && i.n.from != null) rowsCache.push({ el, from: i.n.from }); }
    rowsCache.sort((a, b) => a.from - b.from || a.el.offsetTop - b.el.offsetTop);
    return rowsCache;
  };
  new MutationObserver(() => { rowsCache = null; }).observe(body, { childList: true, subtree: true });
  body.addEventListener("scroll", () => io.onScroll?.(), { passive: true });

  return {
    scroller: body,
    /** The scrollTop that puts source offset `pos` (what the editor shows at its top) at the top. */
    topForOffset(pos, nextPos) {
      const list = rows();
      if (!list.length) return 0;
      let lo = 0, hi = list.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (list[m].from <= pos) lo = m; else hi = m - 1; }
      const a = list[lo], b = list[lo + 1];
      const y0 = a.el.offsetTop, y1 = b ? b.el.offsetTop : y0 + a.el.offsetHeight;
      const f = b && b.from > a.from ? Math.max(0, Math.min(1, (pos - a.from) / (b.from - a.from))) : 0;
      void nextPos;
      return y0 + f * Math.max(0, y1 - y0) - 6;
    },
    /** The source offset at the tree's top edge (between the rows around it). */
    topOffset() {
      const list = rows();
      if (!list.length) return 0;
      const top = body.scrollTop + 6;
      // rows in screen order for this
      const byY = list.slice().sort((x, y) => x.el.offsetTop - y.el.offsetTop);
      let i = 0;
      while (i < byY.length - 1 && byY[i + 1].el.offsetTop <= top) i++;
      const a = byY[i], b = byY[i + 1];
      const h = b ? b.el.offsetTop - a.el.offsetTop : a.el.offsetHeight;
      const f = h > 0 ? Math.max(0, Math.min(1, (top - a.el.offsetTop) / h)) : 0;
      return b && b.from > a.from ? a.from + f * (b.from - a.from) : a.from;
    },
    /** Show `text`; `kind`: json | yaml | xml; `build(text)` → tree (throws ParseError). */
    async update(text, k, build, key) {
      if (key !== lastKey) { lastKey = key; tree = null; open = new Set(); lastText = null; body.innerHTML = ""; errEl.hidden = true; $(".tv-find").value = ""; query = ""; }
      if (text === lastText && k === kind) return;
      lastText = text; kind = k;
      const first = !tree;
      try {
        const t = await build(text);
        if (lastText !== text) return;
        tree = t;
        errEl.hidden = true;
        if (first) { open.clear(); openDefault(tree, "", 0); }
        const n = (function c(x) { return 1 + (x.children || []).reduce((a, y) => a + c(y), 0); })(tree);
        $(".tv-info").textContent = `${n.toLocaleString()} items`;
        paint();
        if (first) enter(body, "fade", { duration: 160 });
      } catch (e) {
        if (lastText !== text) return;
        const lc = e.from != null && io.lineCol ? io.lineCol(e.from) : null;
        errEl.innerHTML = `<b>⚠ ${esc(e.message || String(e))}</b>${lc ? ` <a href="#" data-pos="${e.from}">line ${lc.line}, column ${lc.col}</a>` : ""}${tree ? `<span class="note"> — showing the last valid version</span>` : ""}`;
        const was = errEl.hidden;
        errEl.hidden = false;
        if (was) enter(errEl, "drop");
        errEl.querySelector("a")?.addEventListener("click", (ev) => { ev.preventDefault(); io.onPick?.(+ev.target.dataset.pos); });
        body.classList.toggle("stale", !!tree);
        return;
      }
      body.classList.remove("stale");
    },
    destroy() { host.innerHTML = ""; },
  };
}
