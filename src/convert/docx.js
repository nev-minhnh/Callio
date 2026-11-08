// DOCX (WordprocessingML) -> Markdown
import { unzip, zipXml, readRels, kids, kid, desc, attr, renderInline, renderTable, joinBlocks, indent, escapeMd, escapeLineStart, mime, ConvertError, checkAbort } from "./util.js";
import { ommlToLatex } from "./omml.js";

const on = (el) => {
  if (!el) return false;
  const v = attr(el, "w:val");
  return v == null || !(v === "0" || v === "false" || v === "none" || v === "off");
};
const wval = (el) => attr(el, "w:val");

export async function convertDocx(ctx) {
  const files = await unzip(ctx.bytes);
  let docPath = "word/document.xml";
  const ct = zipXml(files, "[Content_Types].xml");
  if (ct) for (const o of desc(ct, "Override")) if (/wordprocessingml\.(document|template)\.main/.test(o.getAttribute("ContentType") || "")) docPath = o.getAttribute("PartName").replace(/^\//, "");
  const doc = zipXml(files, docPath);
  if (!doc) throw new ConvertError("This doesn't look like a Word document (word/document.xml is missing).");
  const conv = new DocxConv(ctx, files, docPath);
  conv.loadStyles();
  conv.loadNumbering();
  conv.loadNotes();
  const body = desc(doc, "body")[0];
  const blocks = conv.blockList(body);
  const md = conv.render(blocks);
  return md + conv.renderNotes();
}

class DocxConv {
  constructor(ctx, files, docPath) {
    this.ctx = ctx;
    this.files = files;
    this.docPath = docPath;
    this.rels = readRels(files, docPath);
    this.styles = new Map();
    this.numbering = { abstract: new Map(), nums: new Map() };
    this.counters = new Map();
    this.notes = { footnote: new Map(), endnote: new Map() };
    this.usedNotes = [];
    this.hasTitle = false;
  }

  loadStyles() {
    const doc = zipXml(this.files, "word/styles.xml");
    if (!doc) return;
    for (const s of desc(doc, "style")) {
      const id = attr(s, "w:styleId");
      const ppr = kid(s, "pPr");
      const rpr = kid(s, "rPr");
      const numPr = kid(ppr, "numPr");
      this.styles.set(id, {
        id,
        type: attr(s, "w:type"),
        name: (wval(kid(s, "name")) || id || "").toLowerCase(),
        basedOn: wval(kid(s, "basedOn")),
        outline: kid(ppr, "outlineLvl") ? +wval(kid(ppr, "outlineLvl")) : null,
        numId: numPr ? wval(kid(numPr, "numId")) : null,
        ilvl: numPr && kid(numPr, "ilvl") ? +wval(kid(numPr, "ilvl")) : null,
        b: rpr ? (kid(rpr, "b") ? on(kid(rpr, "b")) : null) : null,
        i: rpr ? (kid(rpr, "i") ? on(kid(rpr, "i")) : null) : null,
        mono: rpr ? isMono(kid(rpr, "rFonts")) : false,
      });
    }
  }
  style(id) { return id ? this.styles.get(id) : null; }
  // walk basedOn chain for a property
  styleProp(id, prop) {
    for (let s = this.style(id), n = 0; s && n < 20; s = this.style(s.basedOn), n++) if (s[prop] != null && s[prop] !== false) return s[prop];
    return null;
  }

  loadNumbering() {
    const doc = zipXml(this.files, "word/numbering.xml");
    if (!doc) return;
    for (const a of desc(doc, "abstractNum")) {
      const levels = [];
      for (const l of kids(a, "lvl")) {
        levels[+attr(l, "w:ilvl")] = {
          fmt: wval(kid(l, "numFmt")) || "decimal",
          text: wval(kid(l, "lvlText")) || "",
          start: kid(l, "start") ? +wval(kid(l, "start")) : 1,
        };
      }
      this.numbering.abstract.set(attr(a, "w:abstractNumId"), { levels, link: wval(kid(a, "numStyleLink")) });
    }
    for (const n of desc(doc, "num")) {
      const overrides = {};
      for (const o of kids(n, "lvlOverride")) {
        const so = kid(o, "startOverride");
        if (so) overrides[+attr(o, "w:ilvl")] = +wval(so);
      }
      this.numbering.nums.set(attr(n, "w:numId"), { abs: wval(kid(n, "abstractNumId")), overrides });
    }
  }
  level(numId, ilvl) {
    const num = this.numbering.nums.get(numId);
    if (!num) return null;
    let abs = this.numbering.abstract.get(num.abs);
    if (abs && !abs.levels.length && abs.link) {
      const st = [...this.styles.values()].find((s) => s.id === abs.link);
      const n2 = st?.numId && this.numbering.nums.get(st.numId);
      if (n2) abs = this.numbering.abstract.get(n2.abs);
    }
    const lvl = abs?.levels[ilvl];
    if (!lvl) return null;
    return { ...lvl, start: num.overrides[ilvl] ?? lvl.start };
  }

  loadNotes() {
    for (const kind of ["footnote", "endnote"]) {
      const doc = zipXml(this.files, `word/${kind}s.xml`);
      if (!doc) continue;
      for (const n of desc(doc, kind)) {
        const id = attr(n, "w:id");
        const type = attr(n, "w:type");
        if (type === "separator" || type === "continuationSeparator" || type === "continuationNotice") continue;
        this.notes[kind].set(id, n);
      }
    }
  }

  // ---- blocks ----
  // block: { type: "p"|"h"|"li"|"table"|"raw", md, level, ordered, num }
  blockList(container) {
    const out = [];
    for (const el of kids(container)) {
      checkAbort(this.ctx.signal);
      switch (el.localName) {
        case "p": out.push(...this.paragraph(el)); break;
        case "tbl": out.push({ type: "table", md: this.table(el) }); break;
        case "sdt": out.push(...this.blockList(kid(el, "sdtContent"))); break;
        case "customXml": case "ins": case "smartTag": out.push(...this.blockList(el)); break;
        case "oMathPara": out.push({ type: "raw", md: `$$\n${ommlToLatex(el)}\n$$` }); break;
        default: break;
      }
    }
    return out;
  }

  paragraph(p) {
    const ppr = kid(p, "pPr");
    const styleId = wval(kid(ppr, "pStyle"));
    const st = this.style(styleId);
    const sname = st?.name || (styleId || "").toLowerCase();
    const extra = [];
    const segs = this.runs(p, extra);
    let md = renderInline(segs).replace(/[ \t]+/g, " ").replace(/ ?\u0002 ?/g, "\u0002").trim();
    md = md.replace(/^\u0002+|\u0002+$/g, "");
    const out = [];
    // heading?
    let hlevel = null;
    if (/^title$/.test(sname)) hlevel = 0;
    else if (/^subtitle$/.test(sname)) hlevel = -1;
    else {
      const m = /^heading\s*(\d)$/.exec(sname) || /^heading(\d)$/i.exec(styleId || "");
      if (m) hlevel = +m[1];
      else {
        const ol = kid(ppr, "outlineLvl") ? +wval(kid(ppr, "outlineLvl")) : this.styleProp(styleId, "outline");
        if (ol != null && ol < 9) hlevel = ol + 1;
      }
    }
    // list?
    const numPr = kid(ppr, "numPr");
    let numId = numPr ? wval(kid(numPr, "numId")) : null;
    let ilvl = numPr && kid(numPr, "ilvl") ? +wval(kid(numPr, "ilvl")) : null;
    if (numId == null) numId = this.styleProp(styleId, "numId");
    if (ilvl == null) {
      // "List Bullet 2"-style paragraphs often use a separate numbering whose level 0 is indented
      const byName = /^list[a-z ]*\s(\d)$/.test(sname) ? +/(\d)$/.exec(sname)[1] - 1 : 0;
      ilvl = Math.max(this.styleProp(styleId, "ilvl") ?? 0, byName);
    }
    const lvl = numId && numId !== "0" ? this.level(numId, ilvl) || this.level(numId, 0) : null;

    if (md) {
      if (hlevel === 0 || hlevel === -1) {
        if (hlevel === 0) this.hasTitle = true;
        out.push({ type: "h", level: hlevel, md: md.replace(/\u0002/g, " ") });
      } else if (hlevel != null && !lvl) {
        out.push({ type: "h", level: hlevel, md: md.replace(/\u0002/g, " ") });
      } else if (lvl && lvl.fmt !== "none") {
        const ordered = lvl.fmt !== "bullet";
        const n = this.count(numId, ilvl, lvl.start);
        const marker = ordered ? `${n}.` : "-";
        if (hlevel != null) out.push({ type: "h", level: hlevel, md: md.replace(/\u0002/g, " ") });
        else out.push({ type: "li", level: ilvl, ordered, marker, md: md.replace(/\u0002/g, "\\\n") });
      } else {
        const code = st && (this.styleProp(styleId, "mono") || /code|source|preformat|plain text/.test(sname));
        if (code) out.push({ type: "code", md: plainText(segs) });
        else if (/quote/.test(sname)) out.push({ type: "quote", md: escapeLineStart(md).replace(/\u0002/g, "\\\n") });
        else out.push({ type: "p", md: escapeLineStart(md).replace(/\u0002/g, "\\\n") });
      }
    }
    out.push(...extra);
    return out;
  }

  count(numId, ilvl, start) {
    // Word continues numbering across paragraphs sharing a numId; deeper levels restart after a shallower item
    const key = numId;
    let c = this.counters.get(key);
    if (!c) { c = []; this.counters.set(key, c); }
    for (let i = ilvl + 1; i < c.length; i++) c[i] = undefined;
    c[ilvl] = c[ilvl] == null ? start : c[ilvl] + 1;
    return c[ilvl];
  }

  // collect inline segments from a paragraph (or hyperlink etc.)
  runs(el, extra, link = null, state = { field: null, fieldStack: [] }) {
    const segs = [];
    for (const c of kids(el)) {
      switch (c.localName) {
        case "r": segs.push(...this.run(c, extra, link, state)); break;
        case "hyperlink": {
          const rid = attr(c, "r:id");
          let href = rid ? this.rels.get(rid)?.target : null;
          const anchor = attr(c, "w:anchor");
          if (!href && anchor) href = "#" + anchor;
          else if (href && anchor) href += "#" + anchor;
          segs.push(...this.runs(c, extra, href || link, state));
          break;
        }
        case "ins": case "smartTag": case "customXml": case "fldSimple": case "bdo": case "dir":
          if (c.localName === "fldSimple") {
            const m = /HYPERLINK\s+"([^"]+)"/.exec(attr(c, "w:instr") || "");
            segs.push(...this.runs(c, extra, m ? m[1] : link, state));
          } else segs.push(...this.runs(c, extra, link, state));
          break;
        case "sdt": segs.push(...this.runs(kid(c, "sdtContent"), extra, link, state)); break;
        case "oMath": segs.push({ raw: `$${ommlToLatex(c)}$` }); break;
        case "oMathPara": segs.push({ raw: `\u0002$$${ommlToLatex(c)}$$\u0002` }); break;
        default: break;
      }
    }
    return segs;
  }

  run(r, extra, link, state) {
    const rpr = kid(r, "rPr");
    const cs = wval(kid(rpr, "rStyle"));
    const cst = this.style(cs);
    const fmt = {
      b: kid(rpr, "b") ? on(kid(rpr, "b")) : !!cst && this.styleProp(cs, "b") === true,
      i: kid(rpr, "i") ? on(kid(rpr, "i")) : !!cst && this.styleProp(cs, "i") === true,
      s: on(kid(rpr, "strike")) || on(kid(rpr, "dstrike")),
      u: kid(rpr, "u") ? on(kid(rpr, "u")) && !link : false,
      code: isMono(kid(rpr, "rFonts")) || (cst && /code|verbatim/.test(cst.name)),
    };
    const va = wval(kid(rpr, "vertAlign"));
    if (va === "superscript") fmt.sup = true;
    if (va === "subscript") fmt.sub = true;
    if (kid(rpr, "vanish") && on(kid(rpr, "vanish"))) return [];
    const segs = [];
    const href = state.field?.href ?? link;
    for (const c of kids(r)) {
      const name = c.localName;
      if (name === "fldChar") {
        const t = attr(c, "w:fldCharType");
        if (t === "begin") { state.fieldStack.push(state.field); state.field = { instr: "", inResult: false, href: null }; }
        else if (t === "separate" && state.field) {
          state.field.inResult = true;
          const m = /HYPERLINK\s+(?:\\l\s+)?"([^"]+)"/.exec(state.field.instr);
          if (m) state.field.href = /\\l/.test(state.field.instr) ? "#" + m[1] : m[1];
        } else if (t === "end") state.field = state.fieldStack.pop() || null;
        continue;
      }
      if (name === "instrText") { if (state.field) state.field.instr += c.textContent; continue; }
      if (state.field && !state.field.inResult) continue; // field instructions are not content
      const curHref = state.field?.href ?? link;
      switch (name) {
        case "t": segs.push({ ...fmt, text: c.textContent, href: curHref }); break;
        case "tab": case "ptab": segs.push({ text: " ", href: curHref }); break;
        case "br": case "cr":
          if (attr(c, "w:type") !== "page" && attr(c, "w:type") !== "column") segs.push({ raw: "\u0002" });
          else segs.push({ text: " " });
          break;
        case "noBreakHyphen": segs.push({ ...fmt, text: "-" }); break;
        case "sym": {
          const code = parseInt(attr(c, "w:char") || "0", 16);
          if (code) segs.push({ text: String.fromCharCode(code >= 0xf000 ? code - 0xf000 : code) });
          break;
        }
        case "drawing": case "pict": case "object": {
          const img = this.image(c);
          if (img) segs.push({ raw: img, href: curHref });
          for (const tx of desc(c, "txbxContent")) extra.push(...this.blockList(tx));
          break;
        }
        case "footnoteReference": case "endnoteReference": {
          const kind = name === "footnoteReference" ? "footnote" : "endnote";
          const id = attr(c, "w:id");
          let idx = this.usedNotes.findIndex((n) => n.kind === kind && n.id === id);
          if (idx < 0) { this.usedNotes.push({ kind, id }); idx = this.usedNotes.length - 1; }
          segs.push({ raw: `[^${idx + 1}]` });
          break;
        }
        default: break;
      }
    }
    void href;
    return segs;
  }

  image(el) {
    const blip = desc(el, "blip")[0];
    let rid = blip ? attr(blip, "r:embed") || attr(blip, "r:link") : null;
    if (!rid) {
      const vimg = desc(el, "imagedata")[0];
      rid = vimg ? attr(vimg, "r:id") : null;
    }
    const docPr = desc(el, "docPr")[0];
    const alt = docPr ? attr(docPr, "descr") || attr(docPr, "title") || "" : "";
    if (!rid) {
      // charts, smart art, shapes: placeholder only when not a text box
      if (desc(el, "chart").length) return "<!-- image -->";
      return null;
    }
    const rel = this.rels.get(rid);
    if (!rel || rel.external) return this.ctx.images.mode === "placeholder" || !rel ? "<!-- image -->" : `![${alt}](${rel.target})`;
    const bytes = this.files[rel.target];
    return this.ctx.images.add(bytes, mime(rel.target), alt, rel.target);
  }

  // ---- tables ----
  table(tbl) {
    const rows = [];
    const vmerge = []; // column -> origin cell for vertical merges
    let header = false;
    for (const tr of kids(tbl, "tr")) {
      const trPr = kid(tr, "trPr");
      if (rows.length === 0 && kid(trPr, "tblHeader")) header = true;
      const row = [];
      let col = 0;
      const cells = [];
      for (const c of kids(tr)) {
        if (c.localName === "tc") cells.push(c);
        else if (c.localName === "sdt") cells.push(...desc(c, "tc"));
      }
      const gridBefore = trPr && kid(trPr, "gridBefore") ? +wval(kid(trPr, "gridBefore")) : 0;
      for (let i = 0; i < gridBefore; i++) { row.push({ text: "" }); col++; }
      for (const tc of cells) {
        const tcPr = kid(tc, "tcPr");
        const span = tcPr && kid(tcPr, "gridSpan") ? +wval(kid(tcPr, "gridSpan")) || 1 : 1;
        const vm = tcPr ? kid(tcPr, "vMerge") : null;
        if (vm && wval(vm) !== "restart") {
          const origin = vmerge[col];
          if (origin) { origin.rowspan = (origin.rowspan || 1) + 1; col += span; row.push(null); continue; }
        }
        const blocks = this.blockList(tc);
        const complex = blocks.some((b) => b.type === "li" || b.type === "table" || b.type === "code" || b.type === "raw");
        const cell = { text: complex ? this.render(blocks) : blocks.map((b) => b.md.replace(/\\\n/g, "\n")).join("\n"), colspan: span, block: complex };
        if (vm) vmerge[col] = cell; else vmerge[col] = null;
        for (let k = 1; k < span; k++) vmerge[col + k] = null;
        row.push(cell);
        col += span;
      }
      rows.push(row);
    }
    // null entries mark positions covered by a vertical merge; normalizeGrid fills them from rowspans
    return renderTable(rows.map((r) => r.filter((c) => c !== null)), { header: true });
  }

  // ---- render ----
  render(blocks) {
    const out = [];
    const shift = this.hasTitle ? 1 : 0;
    let listStack = null;
    for (const b of blocks) {
      if (b.type === "li") {
        const md = indent(`${b.marker} ${hang(b.md, b.marker.length + 1)}`, 4 * Math.min(b.level, 8)).replace(/^ +/, (s) => s);
        out.push({ md, list: true });
        listStack = true;
        continue;
      }
      listStack = null;
      if (b.type === "h") {
        if (b.level === 0) out.push(`# ${b.md}`);
        else if (b.level === -1) out.push(`${b.md}`);
        else out.push(`${"#".repeat(Math.min(6, b.level + shift))} ${b.md}`);
      } else if (b.type === "code") out.push("```\n" + b.md + "\n```");
      else if (b.type === "quote") out.push("> " + b.md.replace(/\n/g, "\n> "));
      else out.push(b.md);
    }
    void listStack;
    // merge consecutive code paragraphs into one fence
    return joinBlocks(out).replace(/```\n\n```\n/g, "");
  }

  renderNotes() {
    if (!this.usedNotes.length) return "";
    const lines = [];
    // notes may reference other notes; iterate by index as the list grows
    for (let i = 0; i < this.usedNotes.length; i++) {
      const { kind, id } = this.usedNotes[i];
      const el = this.notes[kind].get(id);
      if (!el) continue;
      const md = this.render(this.blockList(el)).trim();
      lines.push(`[^${i + 1}]: ${md.replace(/\n/g, "\n    ")}`);
    }
    return "\n\n" + lines.join("\n");
  }
}

function hang(md, n) { return md.split("\n").map((l, i) => (i && l ? " ".repeat(n) + l : l)).join("\n"); }
function isMono(fonts) {
  if (!fonts) return false;
  const f = (attr(fonts, "w:ascii") || attr(fonts, "w:hAnsi") || "").toLowerCase();
  return /courier|consolas|mono|menlo|lucida console|source code|fira code|cascadia/.test(f);
}
function plainText(segs) { return segs.map((s) => (s.raw === "\u0002" ? "\n" : s.raw || s.text || "")).join(""); }
void escapeMd;
