import MarkdownIt from "markdown-it";
import mdKatex from "@vscode/markdown-it-katex";
import katex from "katex";
import "katex/dist/katex.min.css";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import { fileSrc } from "./api.js";

// Memoise KaTeX: re-rendering every equation on each keystroke is the main cost.
const cache = new Map();
const memoKatex = {
  renderToString(tex, o) {
    const key = (o.displayMode ? "D" : "I") + tex;
    let html = cache.get(key);
    if (html === undefined) {
      html = katex.renderToString(tex, { ...o, throwOnError: true });
      if (cache.size > 4000) cache.clear();
      cache.set(key, html);
    }
    return html;
  },
};

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try { return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch {}
    }
    return "";
  },
});
md.use(mdKatex.default || mdKatex, { katex: memoKatex, enableFencedBlocks: true, enableBareBlocks: true, throwOnError: false });

// source line attributes for scroll sync
md.core.ruler.push("source_lines", (state) => {
  for (const tok of state.tokens) {
    if (tok.map && tok.nesting >= 0 && tok.block) tok.attrSet("data-line", String(tok.map[0] + 1));
  }
});

// task lists: "- [ ] x" / "- [x] x"
md.core.ruler.after("inline", "tasks", (state) => {
  const toks = state.tokens;
  for (let i = 2; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== "inline" || toks[i - 1].type !== "paragraph_open" || toks[i - 2].type !== "list_item_open") continue;
    const m = /^\[([ xX])\]\s/.exec(t.content);
    if (!m) continue;
    const first = t.children[0];
    if (!first || first.type !== "text") continue;
    first.content = first.content.slice(m[0].length);
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input type="checkbox" disabled${m[1] !== " " ? " checked" : ""}>`;
    t.children.unshift(box);
    toks[i - 2].attrJoin("class", "task-item");
  }
});

// Wide tables: fit the pane, and only scroll sideways if even fully wrapped they can't fit.
md.renderer.rules.table_open = (tokens, idx, o, env, self) => '<div class="table-wrap">' + self.renderToken(tokens, idx, o);
md.renderer.rules.table_close = (tokens, idx, o, env, self) => self.renderToken(tokens, idx, o) + "</div>";

// An HTML comment is invisible in the preview — except when the preview mirrors the visual
// editor, which shows it as a source box: the same box here keeps both sides line for line.
const escHtml = (x) => x.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const defaultHtmlBlock = md.renderer.rules.html_block;
md.renderer.rules.html_block = (tokens, idx, o, env, self) => {
  const t = tokens[idx];
  if (/^\s*<!--[\s\S]*?-->\s*$/.test(t.content) && t.map) {
    return `<div class="wy-raw kind-html md-comment" data-line="${t.map[0] + 1}"><div class="wy-raw-head"><span class="wy-raw-title">HTML</span></div><pre class="wy-raw-pre"><code>${escHtml(t.content.replace(/\n$/, ""))}</code></pre></div>`;
  }
  return defaultHtmlBlock ? defaultHtmlBlock(tokens, idx, o, env, self) : t.content;
};

let baseDir = "";
const isAbs = (u) => /^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(u);
function resolveLocal(src) {
  if (!src || isAbs(src)) return src;
  let clean = src.split("#")[0].split("?")[0];
  try { clean = decodeURI(clean); } catch { /* literal % */ }
  const p = /^([A-Za-z]:)?[\\/]/.test(clean) ? clean : baseDir + "/" + clean;
  return fileSrc(p.replace(/\\/g, "/"));
}
const defaultImage = md.renderer.rules.image;
md.renderer.rules.image = (tokens, idx, o, env, self) => {
  const t = tokens[idx];
  t.attrSet("src", resolveLocal(t.attrGet("src")));
  t.attrSet("loading", "lazy");
  return defaultImage(tokens, idx, o, env, self);
};

const stripLines = (s) => s.replace(/ data-line="\d+"/g, "");

/** Sanitized HTML for a piece of Markdown (notebook cells). */
export function mdToHtml(text, dir) {
  baseDir = dir || "";
  return DOMPurify.sanitize(md.render(text || ""), {
    ADD_ATTR: ["target", "loading"],
    FORBID_TAGS: ["style", "form", "iframe", "object", "embed", "base", "meta", "link"],
  });
}

/**
 * Render markdown into `container`, only touching top-level blocks that changed
 * so images and KaTeX output don't flicker while typing.
 */
export function renderMarkdown(container, text, dir) {
  const paged = container.classList.contains("md-paged");
  if (paged) unpage(container);
  baseDir = dir || "";
  // Markdown may contain raw HTML: sanitize so a hostile file can't run script.
  const html = DOMPurify.sanitize(md.render(text), {
    ADD_ATTR: ["target", "loading"],
    FORBID_TAGS: ["style", "form", "iframe", "object", "embed", "base", "meta", "link"],
  });
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const next = Array.from(tpl.content.children);
  const prev = Array.from(container.children);
  const nk = next.map((n) => stripLines(n.outerHTML));
  const pk = prev.map((n) => n._k);

  let s = 0;
  while (s < next.length && s < prev.length && nk[s] === pk[s]) s++;
  let e = 0;
  while (e < next.length - s && e < prev.length - s && nk[next.length - 1 - e] === pk[prev.length - 1 - e]) e++;

  const syncAttrs = (from, to) => {
    if (from.dataset.line) to.dataset.line = from.dataset.line;
    const a = from.querySelectorAll("[data-line]"), b = to.querySelectorAll("[data-line]");
    if (a.length === b.length) for (let i = 0; i < a.length; i++) b[i].dataset.line = a[i].dataset.line;
  };
  for (let i = 0; i < s; i++) syncAttrs(next[i], prev[i]);
  for (let i = 0; i < e; i++) syncAttrs(next[next.length - 1 - i], prev[prev.length - 1 - i]);

  const anchor = prev[prev.length - e] || null;
  for (let i = s; i < prev.length - e; i++) prev[i].remove();
  for (let i = s; i < next.length - e; i++) {
    next[i]._k = nk[i];
    container.insertBefore(next[i], anchor);
  }
  if (paged) layoutPages(container);
  // ```mermaid blocks: drawn as diagrams (the library loads on first use)
  if (container.querySelector("pre > code.language-mermaid")) import("./mermaid.js").then((m) => m.drawMermaidBlocks(container)).catch((er) => console.warn(er));
}

// ---------------- page view when zoomed out ----------------
// Zoomed out far enough that two pages fit side by side, the preview shows the document as
// pages: one column, then two side by side, then a grid — like the PDF viewer's "Auto".
const PAGE_W = 720, PAGE_H = 1018, PAGE_PAD = 56, PAGE_GAP = 20;
function unpage(container) {
  const pages = container.querySelectorAll(":scope > .md-page");
  if (!pages.length) return;
  const kids = [];
  pages.forEach((p) => kids.push(...p.children));
  container.replaceChildren(...kids);
}
/** Lay the preview out as pages if the zoom leaves room for two; returns whether it did. */
export function layoutPages(container) {
  if (!container || container.hidden) return false;
  if (container.classList.contains("mirror")) { unpage(container); container.classList.remove("md-paged"); return false; }
  const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--md-zoom")) || 1;
  const w = container.getBoundingClientRect().width;
  const fit = Math.floor((w / z - PAGE_GAP) / (PAGE_W + PAGE_GAP));
  const want = fit >= 2;
  const top = container.scrollTop / Math.max(1, container.scrollHeight);
  unpage(container);
  container.classList.toggle("md-paged", want);
  if (!want) { container.scrollTop = top * container.scrollHeight; return false; }
  container.classList.add("md-measure");
  const kids = [...container.children];
  if (!kids.length) { container.classList.remove("md-measure"); return true; }
  // offsets come back in this subtree's units: calibrate with the measured block width
  const unit = (kids[0].offsetWidth || PAGE_W - 2 * PAGE_PAD) / (PAGE_W - 2 * PAGE_PAD);
  const limit = (PAGE_H - 2 * PAGE_PAD) * unit;
  const groups = [[]];
  let start = kids[0].offsetTop;
  for (const k of kids) {
    const g = groups[groups.length - 1];
    const bottom = k.offsetTop + k.offsetHeight;
    if (g.length && bottom - start > limit) {
      // don't leave a heading alone at the bottom of a page
      const carry = [];
      while (g.length > 1 && /^H[1-6]$/.test(g[g.length - 1].tagName)) carry.unshift(g.pop());
      groups.push([...carry, k]);
      start = (carry[0] || k).offsetTop;
    } else g.push(k);
  }
  container.classList.remove("md-measure");
  const frag = document.createDocumentFragment();
  for (const g of groups) {
    const page = document.createElement("div");
    page.className = "md-page";
    page.append(...g);
    frag.append(page);
  }
  container.replaceChildren(frag);
  container.scrollTop = top * container.scrollHeight;
  return true;
}
let relayT = 0;
export function relayoutPages(container, delay = 150) {
  clearTimeout(relayT);
  relayT = setTimeout(() => layoutPages(container), delay);
}

/** Scroll preview so that source line `line` (fractional) is at the top. */
export function scrollPreviewToLine(container, line) {
  const t = previewTargetForLine(container, line);
  if (t != null) container.scrollTop = t;
}
/** The scrollTop that shows source line `line` (fractional) at the top of the preview. */
export function previewTargetForLine(container, line) {
  const els = container.querySelectorAll("[data-line]");
  if (!els.length) return null;
  let before = null, after = null;
  for (const el of els) {
    const l = +el.dataset.line;
    if (l <= line) before = el;
    else { after = el; break; }
  }
  const cTop = container.getBoundingClientRect().top - container.scrollTop;
  const y = (el) => el.getBoundingClientRect().top - cTop;
  let target;
  if (!before) target = 0;
  else if (!after) target = y(before);
  else {
    const l0 = +before.dataset.line, l1 = +after.dataset.line;
    const f = l1 > l0 ? (line - l0) / (l1 - l0) : 0;
    target = y(before) + f * (y(after) - y(before));
  }
  return Math.max(0, target - 12);
}

/** Line number of the block element under a click in the preview. */
export function lineAtElement(el) {
  const b = el.closest("[data-line]");
  return b ? +b.dataset.line : null;
}


// ---------------- export ----------------
const slugify = (s) => s.toLowerCase().trim().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-") || "section";

/**
 * Standalone HTML body for printing: local images as file:// URLs (full resolution, no lazy
 * loading), ids on headings, optional numbering and table of contents.
 * `hooks.citations(html)` may replace [@key] citations (Markdown + library).
 */
export function renderForExport(text, dir, { toc = true, number = false } = {}) {
  const prevResolve = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, o, env, self) => {
    const t = tokens[idx];
    const src = t.attrGet("src") || "";
    if (src && !isAbs(src)) {
      let clean = src.split("#")[0].split("?")[0];
      try { clean = decodeURI(clean); } catch { /* a literal % in the file name */ }
      const p = (/^([A-Za-z]:)?[\\/]/.test(clean) ? clean : (dir || "") + "/" + clean).replace(/\\/g, "/");
      t.attrSet("src", "file:///" + p.replace(/^\/+/, "").split("/").map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join("/"));
    }
    return defaultImage(tokens, idx, o, env, self);
  };
  let html;
  try { html = md.render(text); } finally { md.renderer.rules.image = prevResolve; }
  html = DOMPurify.sanitize(html, { ADD_ATTR: ["target"], FORBID_TAGS: ["style", "form", "iframe", "object", "embed", "base", "meta", "link", "script"], ALLOWED_URI_REGEXP: /^(?:(?:https?|file|mailto|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i });
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const el of tpl.content.querySelectorAll("[data-line]")) el.removeAttribute("data-line");
  const heads = [...tpl.content.querySelectorAll("h1,h2,h3,h4,h5,h6")];
  const used = new Set();
  const counters = [0, 0, 0, 0, 0, 0];
  const items = [];
  // documents with a single h1 title: number from h2
  const top = heads.filter((h) => h.tagName === "H1").length === 1 ? 2 : 1;
  for (const h of heads) {
    const level = +h.tagName[1];
    let id = slugify(h.textContent), base = id, n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id); h.id = id;
    if (number && level >= top) {
      counters[level - 1]++;
      for (let i = level; i < 6; i++) counters[i] = 0;
      const num = counters.slice(top - 1, level).join(".");
      h.insertAdjacentHTML("afterbegin", `<span class="hnum">${num}</span> `);
    }
    if (level >= top && level <= top + 2) items.push({ level: level - top, id, html: h.innerHTML });
  }
  let tocHtml = "";
  if (toc && items.length > 1) {
    tocHtml = `<nav class="toc"><h2 class="toc-title">Contents</h2><ul>` + items.map((i) => `<li class="toc-l${i.level}"><a href="#${i.id}">${i.html}</a></li>`).join("") + `</ul></nav>`;
  }
  const div = document.createElement("div");
  div.appendChild(tpl.content);
  const body = div.innerHTML;
  // put the table of contents after the document title, if there is one
  if (tocHtml && top === 2) {
    const i = body.indexOf("</h1>");
    if (i >= 0) return { html: body.slice(0, i + 5) + tocHtml + body.slice(i + 5), headings: items.length };
  }
  return { html: tocHtml + body, headings: items.length };
}
