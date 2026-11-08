// OpenDocument (ODT / ODS / ODP) -> Markdown
import { unzip, zipXml, kids, kid, desc, attr, renderInline, renderTable, normalizeGrid, joinBlocks, escapeLineStart, escapeMd, indent, mime, ConvertError } from "./util.js";
import { regions } from "./xlsx.js";

export async function convertOdf(ctx) {
  const files = await unzip(ctx.bytes);
  const content = zipXml(files, "content.xml");
  if (!content) throw new ConvertError("This doesn't look like an OpenDocument file (content.xml is missing).");
  const conv = new OdfConv(ctx, files, content);
  const body = desc(content, "body")[0];
  const text = kid(body, "text"), sheet = kid(body, "spreadsheet"), pres = kid(body, "presentation") || kid(body, "drawing");
  if (sheet) return conv.spreadsheet(sheet);
  if (pres) return conv.presentation(pres);
  if (text) return conv.render(conv.blocks(text)) + conv.renderNotes();
  return "";
}

class OdfConv {
  constructor(ctx, files, content) {
    this.ctx = ctx;
    this.files = files;
    this.text = new Map(); // style name -> {b,i,u,s,code}
    this.lists = new Map(); // list style name -> [ordered by level]
    this.parStyle = new Map(); // paragraph style -> parent / heading
    this.notes = [];
    for (const doc of [zipXml(files, "styles.xml"), content]) {
      if (!doc) continue;
      for (const s of desc(doc, "style")) {
        const name = attr(s, "style:name");
        const tp = kid(s, "text-properties");
        const parent = attr(s, "style:parent-style-name");
        const f = {
          b: /bold|[6-9]00/.test(attr(tp, "fo:font-weight") || ""),
          i: /italic|oblique/.test(attr(tp, "fo:font-style") || ""),
          u: !!attr(tp, "style:text-underline-style") && attr(tp, "style:text-underline-style") !== "none",
          s: !!attr(tp, "style:text-line-through-style") && attr(tp, "style:text-line-through-style") !== "none",
          code: /mono|courier|consolas/i.test(attr(tp, "style:font-name") || ""),
          sup: /^super/.test(attr(tp, "style:text-position") || ""),
          sub: /^sub/.test(attr(tp, "style:text-position") || ""),
          parent,
          display: attr(s, "style:display-name") || name,
        };
        this.text.set(name, f);
      }
      for (const ls of desc(doc, "list-style")) {
        const levels = [];
        for (const l of kids(ls)) levels[+(attr(l, "text:level") || 1) - 1] = l.localName === "list-level-style-number" && !!attr(l, "style:num-format");
        this.lists.set(attr(ls, "style:name"), levels);
      }
    }
  }

  fmt(styleName) {
    const f = { b: false, i: false, u: false, s: false, code: false, sup: false, sub: false };
    for (let s = this.text.get(styleName), n = 0; s && n < 10; s = this.text.get(s.parent), n++)
      for (const k of Object.keys(f)) f[k] ||= s[k];
    return f;
  }

  inline(el, base = {}) {
    const segs = [];
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) { segs.push({ ...base, text: n.nodeValue.replace(/\s+/g, " ") }); continue; }
      if (n.nodeType !== 1) continue;
      switch (n.localName) {
        case "span": segs.push(...this.inline(n, { ...base, ...trueOnly(this.fmt(attr(n, "text:style-name"))) })); break;
        case "a": segs.push(...this.inline(n, { ...base, href: attr(n, "xlink:href") })); break;
        case "s": segs.push({ ...base, text: " ".repeat(+(attr(n, "text:c") || 1)) }); break;
        case "tab": segs.push({ text: " " }); break;
        case "line-break": segs.push({ raw: "\\\n" }); break;
        case "note": {
          const body = kid(n, "note-body");
          this.notes.push(body);
          segs.push({ raw: `[^${this.notes.length}]` });
          break;
        }
        case "frame": segs.push({ raw: this.frame(n) }); break;
        case "soft-page-break": case "bookmark": case "bookmark-start": case "bookmark-end": case "annotation": case "annotation-end": case "sequence-decls": break;
        default: segs.push(...this.inline(n, base));
      }
    }
    return segs;
  }

  frame(fr) {
    const img = kid(fr, "image");
    if (img) {
      const href = attr(img, "xlink:href") || "";
      const alt = kid(fr, "desc")?.textContent || kid(fr, "title")?.textContent || "";
      if (this.files[href]) return this.ctx.images.add(this.files[href], mime(href), alt, href);
      return "<!-- image -->";
    }
    const tb = kid(fr, "text-box");
    if (tb) return " " + this.render(this.blocks(tb)).replace(/\n+/g, " ") + " ";
    if (kid(fr, "object")) return "<!-- image -->";
    return "";
  }

  heading(styleName) {
    for (let s = this.text.get(styleName), n = 0; s && n < 10; s = this.text.get(s.parent), n++) {
      const m = /^Heading[ _](?:20_)?(\d)$/i.exec(s.display) || /^Heading_20_(\d)$/.exec(s.display);
      if (m) return +m[1];
      if (/^Title$/i.test(s.display)) return 0;
    }
    return null;
  }

  blocks(container, listCtx = null) {
    const out = [];
    for (const el of kids(container)) {
      switch (el.localName) {
        case "h": {
          const md = renderInline(this.inline(el)).trim();
          if (md) out.push({ type: "h", level: +(attr(el, "text:outline-level") || 1), md });
          break;
        }
        case "p": {
          const md = renderInline(this.inline(el)).replace(/[ \t]+/g, " ").trim();
          const h = this.heading(attr(el, "text:style-name"));
          if (!md) break;
          if (h === 0) out.push({ type: "h", level: 0, md });
          else out.push({ type: "p", md: escapeLineStart(md) });
          break;
        }
        case "list": out.push(...this.list(el, listCtx)); break;
        case "table": out.push({ type: "table", md: this.table(el) }); break;
        case "section": case "index-body": case "table-of-content": case "illustration-index": out.push(...this.blocks(el)); break;
        case "frame": out.push({ type: "p", md: this.frame(el) }); break;
        default: break;
      }
    }
    return out;
  }

  list(el, parent) {
    const style = attr(el, "text:style-name") || parent?.style;
    const depth = parent ? parent.depth + 1 : 0;
    const ordered = this.lists.get(style)?.[depth] || false;
    let n = 0;
    const out = [];
    for (const item of kids(el)) {
      if (item.localName !== "list-item" && item.localName !== "list-header") continue;
      n++;
      const inner = this.blocks(item, { style, depth });
      let first = true;
      for (const b of inner) {
        if (b.type === "li") { out.push(b); continue; }
        if (first) out.push({ type: "li", depth, md: b.md, marker: ordered ? `${n}.` : "-" });
        else out.push({ type: "li", depth, md: b.md, marker: null });
        first = false;
      }
    }
    return out;
  }

  table(tbl) {
    const rows = [];
    const addRows = (container) => {
      for (const el of kids(container)) {
        if (el.localName === "table-row") {
          const rep = Math.min(+(attr(el, "table:number-rows-repeated") || 1), 1000);
          const row = this.row(el);
          for (let i = 0; i < rep; i++) rows.push(row.map((c) => ({ ...c })));
        } else if (/^table-(header-)?rows$|^table-row-group$/.test(el.localName)) addRows(el);
      }
    };
    addRows(tbl);
    // trim empty trailing rows (spreadsheets repeat empty rows to 1M)
    const filled = (r) => r.some((c) => c.text);
    while (rows.length && !filled(rows[rows.length - 1])) rows.pop();
    return rows;
  }

  row(tr) {
    const row = [];
    for (const c of kids(tr)) {
      if (c.localName === "covered-table-cell") { row.push(null); continue; }
      if (c.localName !== "table-cell") continue;
      const rep = Math.min(+(attr(c, "table:number-columns-repeated") || 1), 200);
      const text = this.cellText(c);
      for (let i = 0; i < rep; i++) row.push({ text, colspan: +(attr(c, "table:number-columns-spanned") || 1), rowspan: +(attr(c, "table:number-rows-spanned") || 1) });
    }
    while (row.length && (!row[row.length - 1] || !row[row.length - 1].text)) row.pop();
    return row.filter((c) => c !== null);
  }

  cellText(c) {
    const type = attr(c, "office:value-type");
    const ps = kids(c, "p");
    const txt = ps.map((p) => renderInline(this.inline(p)).trim()).filter(Boolean).join("\n");
    if (txt) return txt;
    if (type === "float" || type === "percentage" || type === "currency") return attr(c, "office:value") || "";
    if (type === "date") return attr(c, "office:date-value") || "";
    if (type === "boolean") return (attr(c, "office:boolean-value") || "").toUpperCase();
    return "";
  }

  render(blocks) {
    const out = [];
    for (const b of blocks) {
      if (b.type === "h") out.push(b.level === 0 ? `# ${b.md}` : `${"#".repeat(Math.min(6, b.level + 1))} ${b.md}`);
      else if (b.type === "li") {
        if (b.marker) out.push({ md: indent(`${b.marker} ${b.md}`, 4 * b.depth), list: true });
        else out.push({ md: indent(b.md, 4 * b.depth + 4), list: true });
      } else if (b.type === "table") out.push(renderTable(b.md, { header: true }));
      else out.push(b.md);
    }
    return joinBlocks(out);
  }

  renderNotes() {
    if (!this.notes.length) return "";
    return "\n\n" + this.notes.map((b, i) => `[^${i + 1}]: ${this.render(this.blocks(b)).replace(/\n/g, "\n    ")}`).join("\n");
  }

  spreadsheet(sheet) {
    const out = [];
    for (const t of kids(sheet, "table")) {
      out.push(`## ${escapeMd(attr(t, "table:name") || "Sheet")}`);
      // place cells on a grid (merged ranges repeat their value, Docling style) and split into data regions
      const grid = normalizeGrid(this.table(t)).map((r) => r.map((c) => (c.span ? c.span.text : c.text) || ""));
      for (const region of regions(grid)) out.push(renderTable(region, { header: true }));
    }
    return out.join("\n\n");
  }

  presentation(pres) {
    const out = [];
    let n = 0;
    for (const page of kids(pres, "page")) {
      n++;
      let title = null;
      const blocks = [];
      const frames = kids(page).filter((f) => f.localName === "frame" || f.localName === "custom-shape" || f.localName === "g");
      const pos = (f) => parseFloat(attr(f, "svg:y") || "0") * 1000 + parseFloat(attr(f, "svg:x") || "0");
      frames.sort((a, b) => pos(a) - pos(b));
      for (const f of frames) {
        const cls = attr(f, "presentation:class");
        if (cls === "page-number" || cls === "footer" || cls === "date-time") continue;
        const tb = kid(f, "text-box") || (f.localName === "custom-shape" ? f : null);
        if (cls === "title" && tb && title == null) { title = tb.textContent.replace(/\s+/g, " ").trim(); continue; }
        if (tb) blocks.push(this.render(this.blocks(tb)));
        else if (kid(f, "table")) blocks.push(renderTable(this.table(kid(f, "table")), { header: true }));
        else if (kid(f, "image")) blocks.push(this.frame(f));
        else if (kid(f, "object")) blocks.push("<!-- image -->");
      }
      const parts = [`## ${title ? escapeLineStart(title) : `Slide ${n}`}`, joinBlocks(blocks)];
      const notes = kid(page, "notes");
      if (notes) {
        const md = desc(notes, "frame").filter((f) => attr(f, "presentation:class") === "notes").map((f) => this.render(this.blocks(kid(f, "text-box") || f))).join("\n\n").trim();
        if (md) parts.push(md.split("\n").map((l) => (l ? "> " + l : ">")).join("\n"));
      }
      out.push(joinBlocks(parts));
    }
    return out.join("\n\n");
  }
}

function trueOnly(f) { const o = {}; for (const k in f) if (f[k] === true) o[k] = true; return o; }
