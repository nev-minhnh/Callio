// HTML -> Markdown (DOM walk). Also used for notebook HTML outputs.
import { decodeText, escapeMd, escapeLineStart, codeSpan, linkUrl, renderTable, fence, indent, fromBase64, joinBlocks } from "./util.js";

const DROP = new Set(["script", "style", "noscript", "template", "iframe", "object", "embed", "head", "meta", "link",
  "button", "input", "select", "textarea", "option", "canvas", "audio", "video", "map", "dialog", "base", "title"]);
const BLOCK = new Set(["p", "div", "section", "article", "main", "header", "footer", "aside", "nav", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "table", "pre", "blockquote", "hr", "figure", "figcaption", "dl", "dt", "dd", "address", "details", "summary",
  "form", "fieldset", "legend", "center", "body", "html", "hgroup", "caption", "thead", "tbody", "tfoot", "tr", "td", "th"]);
const BR = "\u0002";

export async function convertHtml(ctx) {
  return htmlToMarkdown(decodeText(ctx.bytes), ctx, true);
}

export function htmlToMarkdown(html, ctx, page = false) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let root = doc.body || doc.documentElement;
  if (page) {
    const main = doc.querySelector("main, [role=main]");
    const articles = doc.querySelectorAll("article");
    if (main) root = main;
    else if (articles.length === 1) root = articles[0];
    for (const el of root.querySelectorAll("nav, [role=navigation], [role=banner], [role=contentinfo], [role=search], [aria-hidden=true], [hidden], .sr-only, .visually-hidden"))
      el.remove();
    if (root === doc.body) {
      for (const el of root.querySelectorAll("header, footer, aside")) if (!el.closest("article, main") && !el.querySelector("h1")) el.remove();
    }
  }
  const title = page ? doc.querySelector("title")?.textContent.trim() : "";
  const conv = new HtmlConv(ctx);
  const blocks = conv.blocks(root);
  let md = joinBlocks(blocks);
  if (title && !/^#\s/m.test(md)) md = `# ${escapeMd(title)}\n\n${md}`;
  return md;
}

class HtmlConv {
  constructor(ctx) { this.ctx = ctx; }

  hidden(el) {
    const st = el.getAttribute?.("style") || "";
    return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(st);
  }

  // returns array of block strings
  blocks(node) {
    const out = [];
    let buf = [];
    const flush = () => {
      const t = finishInline(buf.join(""));
      if (t) out.push(t);
      buf = [];
    };
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) { buf.push(escapeMd(n.nodeValue.replace(/[\t\n\r ]+/g, " "))); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.localName;
      if (DROP.has(tag) || this.hidden(n)) continue;
      if (tag === "math" && n.getAttribute("display") === "block") {
        flush();
        const tex = n.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
        out.push(tex ? `$$\n${cleanTex(tex)}\n$$` : escapeMd(n.textContent));
        continue;
      }
      if (!BLOCK.has(tag)) { buf.push(this.inline(n)); continue; }
      flush();
      out.push(...this.block(n));
    }
    flush();
    return out.filter((b) => b && b.trim());
  }

  block(el) {
    const tag = el.localName;
    if (/^h[1-6]$/.test(tag)) {
      const t = finishInline(this.inlineChildren(el)).replace(/\\\n/g, " ");
      return t ? ["#".repeat(+tag[1]) + " " + t] : [];
    }
    if (tag === "ul" || tag === "ol") return [this.list(el)];
    if (tag === "table") return this.table(el);
    if (tag === "pre") {
      const code = el.querySelector("code") || el;
      const cls = (code.className || "") + " " + (el.className || "");
      const m = /(?:language|lang|highlight-source|brush:?)-?\s*([\w+#-]+)/.exec(cls);
      return [fence(code.textContent.replace(/\n$/, ""), m ? m[1] : "")];
    }
    if (tag === "blockquote") {
      const inner = joinBlocks(this.blocks(el));
      return inner ? [inner.split("\n").map((l) => (l ? "> " + l : ">")).join("\n")] : [];
    }
    if (tag === "hr") return ["---"];
    if (tag === "dl") {
      const out = [];
      for (const c of el.children) {
        if (c.localName === "dt") out.push(`**${finishInline(this.inlineChildren(c))}**`);
        else if (c.localName === "dd") out.push(...this.blocks(c));
      }
      return out;
    }
    if (tag === "figure") return this.blocks(el);
    return this.blocks(el);
  }

  list(el, depth = 0) {
    const ordered = el.localName === "ol";
    let n = ordered ? parseInt(el.getAttribute("start") || "1", 10) || 1 : 0;
    const lines = [];
    for (const li of el.children) {
      if (li.localName !== "li") {
        if (li.localName === "ul" || li.localName === "ol") lines.push(indent(this.list(li), 4));
        continue;
      }
      const marker = ordered ? `${n++}.` : "-";
      const parts = [];
      let inl = [];
      const flushInl = () => { const t = finishInline(inl.join("")); if (t) parts.push({ t, list: false }); inl = []; };
      for (let c = li.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { inl.push(escapeMd(c.nodeValue.replace(/[\t\n\r ]+/g, " "))); continue; }
        if (c.nodeType !== 1 || DROP.has(c.localName)) continue;
        if (c.localName === "ul" || c.localName === "ol") { flushInl(); parts.push({ t: this.list(c), list: true }); }
        else if (BLOCK.has(c.localName)) { flushInl(); for (const b of this.block(c)) parts.push({ t: b, list: false }); }
        else inl.push(this.inline(c));
      }
      flushInl();
      if (!parts.length) { lines.push(marker); continue; }
      const pad = 4;
      let s = marker + " " + (parts[0].list ? "\n" + indent(parts[0].t, pad) : indentRest(parts[0].t, pad));
      for (let i = 1; i < parts.length; i++) s += (parts[i].list ? "\n" : "\n\n") + indent(parts[i].t, pad);
      lines.push(s);
    }
    return lines.join("\n");
  }

  table(el) {
    const rows = [];
    let hasHead = false;
    const trs = Array.from(el.querySelectorAll("tr")).filter((tr) => tr.closest("table") === el);
    let caption = el.querySelector("caption");
    if (caption && caption.closest("table") !== el) caption = null;
    for (const tr of trs) {
      const row = [];
      for (const td of tr.children) {
        if (td.localName !== "td" && td.localName !== "th") continue;
        const blocks = this.blocks(td);
        const complex = blocks.length > 1 || blocks.some((b) => /^(\s*[-*]\s|\s*\d+\.\s|```|\||<table)/m.test(b));
        const text = blocks.join("\n");
        row.push({
          text, header: td.localName === "th",
          colspan: +td.getAttribute("colspan") || 1, rowspan: +td.getAttribute("rowspan") || 1,
          block: complex, html: complex ? cleanHtml(td) : undefined,
        });
      }
      if (row.length) rows.push(row);
      if (tr.parentElement?.localName === "thead" || (rows.length === 1 && row.every((c) => c.header))) hasHead = true;
    }
    if (!rows.length) return [];
    const out = [];
    if (caption) out.push(finishInline(this.inlineChildren(caption)));
    out.push(renderTable(rows, { header: true }));
    void hasHead;
    return out;
  }

  inlineChildren(el) {
    let s = "";
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) s += escapeMd(n.nodeValue.replace(/[\t\n\r ]+/g, " "));
      else if (n.nodeType === 1 && !DROP.has(n.localName) && !this.hidden(n)) s += this.inline(n);
    }
    return s;
  }

  inline(el) {
    const tag = el.localName;
    if (DROP.has(tag) || this.hidden(el)) return "";
    switch (tag) {
      case "br": return BR;
      case "wbr": return "";
      case "img": return " " + this.image(el) + " ";
      case "svg": return " <!-- image --> ";
      case "code": case "kbd": case "samp": case "tt": return codeSpan(el.textContent.replace(/\s+/g, " "));
      case "strong": case "b": return wrap(this.inlineChildren(el), "**");
      case "em": case "i": case "cite": case "dfn": case "var": return wrap(this.inlineChildren(el), "*");
      case "del": case "s": case "strike": return wrap(this.inlineChildren(el), "~~");
      case "u": case "ins": return wrapTag(this.inlineChildren(el), "u");
      case "sup": return wrapTag(this.inlineChildren(el), "sup");
      case "sub": return wrapTag(this.inlineChildren(el), "sub");
      case "mark": return this.inlineChildren(el);
      case "q": return "“" + this.inlineChildren(el) + "”";
      case "math": {
        const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
        return tex ? (el.getAttribute("display") === "block" ? `$$${cleanTex(tex)}$$` : `$${cleanTex(tex)}$`) : escapeMd(el.textContent);
      }
      case "a": {
        const inner = this.inlineChildren(el);
        const href = el.getAttribute("href");
        if (!href || href.startsWith("javascript:")) return inner;
        if (!inner.trim()) return "";
        return wrapFn(inner, (x) => `[${x}](${linkUrl(href)})`);
      }
      default:
        if (el.classList?.contains("katex")) {
          const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
          if (tex) return `$${tex.trim()}$`;
        }
        return this.inlineChildren(el);
    }
  }

  image(el) {
    const src = el.getAttribute("src") || el.getAttribute("data-src") || "";
    const alt = el.getAttribute("alt") || "";
    const sink = this.ctx.images;
    if (!src || sink.mode === "placeholder") return "<!-- image -->";
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
    if (m) {
      try {
        const bytes = m[2] ? fromBase64(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3]));
        return sink.add(bytes, m[1], alt);
      } catch { return "<!-- image -->"; }
    }
    return `![${alt.replace(/[\[\]]/g, "")}](${linkUrl(src)})`;
  }
}

function cleanTex(t) { return t.replace(/\\label\{[^}]*\}/g, "").trim(); }
function wrap(inner, mark) { return wrapFn(inner, (x) => mark + x + mark); }
function wrapTag(inner, t) { return wrapFn(inner, (x) => `<${t}>${x}</${t}>`); }
function wrapFn(inner, fn) {
  const m = /^([\s\u0002]*)([\s\S]*?)([\s\u0002]*)$/.exec(inner);
  if (!m[2]) return inner;
  return m[1] + fn(m[2]) + m[3];
}
function finishInline(s) {
  s = s.replace(/ {2,}/g, " ").replace(/ *\u0002 */g, BR).trim();
  s = s.replace(/^\u0002+|\u0002+$/g, "").trim();
  if (!s) return "";
  return s.split(BR).map((l) => escapeLineStart(l.trim())).join("\\\n");
}
function indentRest(t, n) {
  const [first, ...rest] = t.split("\n");
  return [first, ...rest.map((l) => (l ? " ".repeat(n) + l : l))].join("\n");
}
function cleanHtml(el) {
  const c = el.cloneNode(true);
  for (const x of c.querySelectorAll("script,style")) x.remove();
  for (const x of [c, ...c.querySelectorAll("*")]) {
    for (const a of [...x.attributes]) if (!["href", "src", "alt", "colspan", "rowspan"].includes(a.name)) x.removeAttribute(a.name);
  }
  return c.innerHTML.replace(/\s+/g, " ").trim();
}
