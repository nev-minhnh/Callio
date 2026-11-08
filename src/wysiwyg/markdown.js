// Markdown (GFM + math + footnotes + [@cite]) <-> ProseMirror document, round-trip safe.
// Parsing uses markdown-it with the same math plugin as the preview (src/md.js), so the
// editor reads a file the way the preview renders it.
import MarkdownIt from "markdown-it";
import mdKatex from "@vscode/markdown-it-katex";
import { schema } from "./schema.js";
import { serializeSeq, joinRecs } from "./roundtrip.js";

const S = schema.nodes, M = schema.marks;

// ---------------- markdown-it setup ----------------
const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
md.use(mdKatex.default || mdKatex, { enableBareBlocks: true, enableFencedBlocks: true });

// [^label]: footnote text   (one paragraph; longer ones are kept as raw source)
md.block.ruler.before("reference", "footnote_def", (state, startLine, endLine, silent) => {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const m = /^\[\^([^\]\s]+)\]:[ \t]?/.exec(state.src.slice(start, state.eMarks[startLine]));
  if (!m) return false;
  if (silent) return true;
  let next = startLine + 1;
  while (next < endLine && !state.isEmpty(next)) {
    const s = state.bMarks[next] + state.tShift[next];
    if (/^\[\^[^\]\s]+\]:/.test(state.src.slice(s, state.eMarks[next]))) break;
    next++;
  }
  // an indented paragraph after a blank line continues the footnote
  let complex = false;
  for (;;) {
    let k = next;
    while (k < endLine && state.isEmpty(k)) k++;
    if (k < endLine && k > next && state.sCount[k] - state.blkIndent >= 4) {
      complex = true;
      next = k;
      while (next < endLine && (state.isEmpty(next) || state.sCount[next] - state.blkIndent >= 4)) next++;
      while (next > k && state.isEmpty(next - 1)) next--;
    } else break;
  }
  if (complex) {
    const t = state.push("footnote_raw", "", 0);
    t.map = [startLine, next];
    t.block = true;
  } else {
    const o = state.push("footnote_def_open", "", 1);
    o.meta = { label: m[1] };
    o.map = [startLine, next];
    const inl = state.push("inline", "", 0);
    inl.content = state.src.slice(start + m[0].length, state.eMarks[next - 1]);
    inl.map = [startLine, next];
    inl.children = [];
    state.push("footnote_def_close", "", -1);
  }
  state.line = next;
  return true;
});

// [^label] footnote reference
md.inline.ruler.before("link", "footnote_ref", (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x5b || state.src.charCodeAt(state.pos + 1) !== 0x5e) return false;
  const m = /^\[\^([^\]\s]+)\]/.exec(state.src.slice(state.pos));
  if (!m) return false;
  if (!silent) state.push("footnote_ref", "", 0).meta = { label: m[1] };
  state.pos += m[0].length;
  return true;
});

// [@key], [see @key, p. 3; @other] citations (pandoc)
md.inline.ruler.before("link", "cite", (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x5b) return false;
  const m = /^\[([^\[\]\n]+)\]/.exec(state.src.slice(state.pos));
  if (!m || !/(^|[\s;])-?@[\p{L}\p{N}_]/u.test(m[1])) return false;
  const after = state.src[state.pos + m[0].length];
  if (after === "(" || after === "[") return false;
  if (!silent) state.push("cite", "", 0).content = m[0];
  state.pos += m[0].length;
  return true;
});

// remember reference-style links/images ([text][ref], [text][], [text]) so they're written back that way
function wrapLinkRule(name, offset) {
  const rule = md.inline.ruler.__rules__.find((r) => r.name === name);
  const orig = rule.fn;
  md.inline.ruler.at(name, (state, silent) => {
    const start = state.pos, n = state.tokens.length;
    const ok = orig(state, silent);
    if (ok && !silent) {
      const labelEnd = state.md.helpers.parseLinkLabel(state, start + offset, true);
      let tok = null; // (pending text is flushed first, so look past it)
      for (let k = n; k < state.tokens.length; k++) if (state.tokens[k].type === (name === "link" ? "link_open" : "image")) { tok = state.tokens[k]; break; }
      if (tok && labelEnd >= 0 && !(state.src[labelEnd + 1] === "(" && state.pos > labelEnd + 1)) {
        tok.meta = { ...(tok.meta || {}), ref: state.src.slice(labelEnd + 1, state.pos) };
      }
    }
    return ok;
  });
}
wrapLinkRule("link", 0);
wrapLinkRule("image", 1);

// ---------------- tokens -> ProseMirror ----------------
const findClose = (toks, i) => {
  const t = toks[i], close = t.type.replace(/_open$/, "_close");
  for (let j = i + 1; j < toks.length; j++) if (toks[j].type === close && toks[j].level === t.level) return j;
  throw new Error("unclosed " + t.type);
};

function inlineNodes(tok, ctx) {
  const out = [];
  let marks = [];
  const hardSrc = /\\\n/.test(tok.content || "") ? "\\\n" : "  \n";
  const text = (s, extra) => { if (s) out.push(schema.text(s, extra ? extra.addToSet(marks) : marks)); };
  const add = (m) => { marks = m.addToSet(marks); };
  const drop = (type) => { marks = type.removeFromSet(marks); };
  for (const t of tok.children || []) {
    switch (t.type) {
      case "text": text(t.content); break;
      case "softbreak": text(" "); break;
      case "hardbreak": out.push(S.hard_break.create({ src: hardSrc }, null, marks)); break;
      case "code_inline":
        if (t.content) text(t.content, M.code.create({ open: t.markup }));
        else out.push(S.raw_inline.create({ src: t.markup + " " + t.markup, kind: "md" }, null, marks));
        break;
      case "strong_open": add(M.strong.create({ open: t.markup })); break;
      case "strong_close": drop(M.strong); break;
      case "em_open": add(M.em.create({ open: t.markup })); break;
      case "em_close": drop(M.em); break;
      case "s_open": add(M.strike.create({ open: t.markup })); break;
      case "s_close": drop(M.strike); break;
      case "link_open":
        add(M.link.create({
          href: t.attrGet("href") || "", title: t.attrGet("title"),
          kind: t.markup === "autolink" ? "autolink" : t.markup === "linkify" ? "linkify" : null,
          ref: t.meta?.ref ?? null,
        }));
        break;
      case "link_close": drop(M.link); break;
      case "image":
        out.push(S.image.create({ src: t.attrGet("src") || "", alt: t.content || "", title: t.attrGet("title"), ref: t.meta?.ref ?? null }, null, marks));
        break;
      case "html_inline": out.push(S.raw_inline.create({ src: t.content, kind: "html" }, null, marks)); break;
      case "math_inline": out.push(S.math_inline.create({ tex: t.content, open: "$", close: "$" }, null, marks)); break;
      case "math_inline_block": out.push(S.math_inline.create({ tex: t.content, open: "$$", close: "$$", display: true }, null, marks)); break;
      case "math_inline_bare_block": out.push(S.math_inline.create({ tex: t.content, open: "\n", close: "", display: true }, null, marks)); break;
      case "footnote_ref": out.push(S.footnote_ref.create({ label: t.meta.label }, null, marks)); break;
      case "cite": out.push(S.cite.create({ src: t.content }, null, marks)); break;
      default: throw new Error("inline token " + t.type);
    }
  }
  return out;
}

function blockNodes(toks, i, end, ctx) {
  const out = [];
  while (i < end) {
    const t = toks[i];
    switch (t.type) {
      case "paragraph_open":
        out.push(S.paragraph.create(null, inlineNodes(toks[i + 1], ctx)));
        i += 3;
        break;
      case "heading_open":
        out.push(S.heading.create({ level: +t.tag.slice(1), markup: t.markup }, inlineNodes(toks[i + 1], ctx)));
        i += 3;
        break;
      case "blockquote_open": {
        const j = findClose(toks, i);
        const kids = blockNodes(toks, i + 1, j, ctx);
        out.push(S.blockquote.create(null, kids.length ? kids : [S.paragraph.create()]));
        i = j + 1;
        break;
      }
      case "bullet_list_open":
      case "ordered_list_open": {
        const j = findClose(toks, i);
        const items = [];
        let tight = true, first = null, nums = [];
        for (let k = i + 1; k < j;) {
          const it = toks[k];
          if (it.type !== "list_item_open") throw new Error("list content " + it.type);
          const e = findClose(toks, k);
          if (!first) first = it;
          nums.push(it.info);
          for (let q = k + 1; q < e; q++) if (toks[q].type === "paragraph_open" && toks[q].level === it.level + 1 && !toks[q].hidden) tight = false;
          // task list item: "[ ] " / "[x] " at the start of its first paragraph
          let checked = null;
          if (toks[k + 1]?.type === "paragraph_open" && toks[k + 2]?.type === "inline") {
            const c0 = toks[k + 2].children?.[0];
            const m = c0 && c0.type === "text" ? /^\[([ xX])\](?:[ \t]+|$)/.exec(c0.content) : null;
            if (m && (m[0].length < c0.content.length || toks[k + 2].children.length > 1 || /\s$/.test(m[0]) || true)) {
              checked = m[1] !== " ";
              c0.content = c0.content.slice(m[0].length);
            }
          }
          const kids = blockNodes(toks, k + 1, e, ctx);
          items.push(S.list_item.create({ checked }, kids.length ? kids : [S.paragraph.create()]));
          k = e + 1;
        }
        if (t.type === "bullet_list_open") out.push(S.bullet_list.create({ bullet: first?.markup || "-", tight }, items));
        else {
          const start = +(t.attrGet("start") || 1);
          const lazy = nums.length > 1 && nums.every((n) => n === nums[0]);
          out.push(S.ordered_list.create({ start, delim: first?.markup || ".", tight, lazy }, items));
        }
        i = j + 1;
        break;
      }
      case "fence": {
        const text = t.content.replace(/\n$/, "");
        out.push(S.code_block.create({ lang: t.info || "", fence: t.markup }, text ? schema.text(text) : null));
        i++;
        break;
      }
      case "code_block": {
        const text = t.content.replace(/\n$/, "");
        out.push(S.code_block.create({ indented: true }, text ? schema.text(text) : null));
        i++;
        break;
      }
      case "hr": out.push(S.horizontal_rule.create({ markup: t.markup })); i++; break;
      case "html_block": {
        const text = t.content.replace(/\n+$/, "");
        out.push(S.raw_block.create({ kind: "html", lang: "html" }, text ? schema.text(text) : null));
        i++;
        break;
      }
      case "math_block": {
        const src = ctx.slice ? ctx.slice(t.map) : null;
        out.push(mathBlock(t.content, src));
        i++;
        break;
      }
      case "table_open": {
        const j = findClose(toks, i);
        out.push(tableNode(toks, i + 1, j, ctx));
        i = j + 1;
        break;
      }
      case "footnote_def_open":
        out.push(S.footnote_def.create({ label: t.meta.label }, inlineNodes(toks[i + 1], ctx)));
        i += 3;
        break;
      default:
        throw new Error("block token " + t.type);
    }
  }
  return out;
}

function mathBlock(content, src) {
  let tex = content.replace(/\n$/, ""), open = "$$\n", close = "\n$$";
  if (src != null) {
    const o = /^\$\$[ \t]*\n?/.exec(src), c = /\n?[ \t]*\$\$$/.exec(src);
    if (o && c && o[0].length + c[0].length <= src.length) {
      open = o[0]; close = c[0];
      tex = src.slice(open.length, src.length - close.length);
    } else if (!o) { open = ""; close = ""; tex = src; }
  }
  return S.math_display.create({ tex, open, close });
}

function tableNode(toks, i, end, ctx) {
  const rows = [];
  for (; i < end; i++) {
    const t = toks[i];
    if (t.type !== "tr_open") continue;
    const cells = [];
    for (i++; toks[i].type !== "tr_close"; i++) {
      const c = toks[i];
      if (c.type !== "th_open" && c.type !== "td_open") continue;
      const al = /text-align:\s*(left|center|right)/.exec(c.attrGet("style") || "");
      const type = c.type === "th_open" ? S.table_header : S.table_cell;
      cells.push(type.create({ align: al ? al[1] : null }, inlineNodes(toks[i + 1], ctx)));
      i += 2;
    }
    rows.push(S.table_row.create(null, cells));
  }
  return S.table.create(null, rows);
}

// ---------------- parse ----------------
const lineStarts = (text) => {
  const a = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) a.push(i + 1);
  return a;
};
const rawMd = (src, kind = "md", lang = "markdown") => S.raw_block.create({ kind, lang }, src ? schema.text(src) : null);

/**
 * Parse Markdown. Returns { doc, rt } — rt is what serializeMarkdown needs to write the
 * untouched parts back exactly.
 */
export function parseMarkdown(input) {
  const crlf = /\r\n/.test(input) && !/(^|[^\r])\n/.test(input);
  const text = crlf ? input.replace(/\r\n/g, "\n") : input;
  const env = {};
  let recs, suffix;
  try {
    ({ recs, suffix } = parseBlocksMd(text, env));
    if (joinRecs(recs) + suffix !== text) throw new Error("parse does not cover the input");
  } catch (e) {
    console.warn("[wysiwyg] markdown kept as source:", e);
    const lead = /^\s*/.exec(text)[0], trail = /\s*$/.exec(text.slice(lead.length))[0];
    const body = text.slice(lead.length, text.length - trail.length);
    recs = body ? [{ node: rawMd(body), src: body, sep: lead }] : [];
    suffix = body ? trail : text;
  }
  const kids = recs.map((r) => r.node);
  const doc = S.doc.create(null, kids.length ? kids : [S.paragraph.create()]);
  return { doc, rt: { kind: "md", recs, suffix, crlf, env } };
}

function parseBlocksMd(text, env) {
  const starts = lineStarts(text);
  const nLines = starts.length;
  const lineEnd = (l) => (l + 1 < nLines ? starts[l + 1] - 1 : text.length);
  let mdText = text;
  const blocks = [];
  // YAML front matter
  const fm = /^---[ \t]*\n/.exec(text);
  if (fm) {
    for (let l = 1; l < nLines; l++) {
      const line = text.slice(starts[l], lineEnd(l));
      if (/^(---|\.\.\.)[ \t]*$/.test(line)) {
        blocks.push({ l0: 0, l1: l + 1, node: null, kind: "frontmatter" });
        mdText = text.slice(0, lineEnd(l)).replace(/[^\n]/g, "") + text.slice(lineEnd(l));
        break;
      }
    }
  }
  const toks = md.parse(mdText, env);
  const slice = (map) => text.slice(starts[map[0]], lineEnd(map[1] - 1)).replace(/\s+$/, "");
  const ctx = { env, slice };
  for (let i = 0; i < toks.length;) {
    const t = toks[i];
    let j = i;
    if (t.nesting === 1) j = findClose(toks, i);
    if (!t.map) { i = j + 1; continue; }
    blocks.push({ l0: t.map[0], l1: t.map[1], toks: [i, j + 1] });
    i = j + 1;
  }
  const recs = [];
  let pos = 0;
  const pushRaw = (a, b) => {
    // non-blank text between blocks (link reference definitions...): keep as raw source
    const seg = text.slice(a, b);
    const lead = /^\s*/.exec(seg)[0];
    const body = seg.slice(lead.length).replace(/\s+$/, "");
    if (!body) return;
    recs.push({ node: rawMd(body), src: body, sep: lead });
    pos = a + lead.length + body.length;
  };
  for (const b of blocks) {
    const start = starts[b.l0];
    let end = lineEnd(b.l1 - 1);
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (start < pos) throw new Error("overlapping blocks");
    pushRaw(pos, start);
    const src = text.slice(start, end);
    let node;
    if (b.kind === "frontmatter") node = S.raw_block.create({ kind: "frontmatter", lang: "yaml" }, schema.text(src));
    else {
      try {
        const nodes = blockNodes(toks, b.toks[0], b.toks[1], ctx);
        if (nodes.length !== 1) throw new Error("block count");
        node = nodes[0];
        node.check();
      } catch (e) {
        node = rawMd(src);
      }
    }
    recs.push({ node, src, sep: text.slice(pos, start) });
    pos = end;
  }
  pushRaw(pos, text.length);
  return { recs, suffix: text.slice(pos) };
}

/** Parse a piece of Markdown into block nodes (for paste and for checking merges). */
export function parseMarkdownFragment(text, env = {}) {
  const toks = md.parse(text, env);
  const starts = lineStarts(text);
  const lineEnd = (l) => (l + 1 < starts.length ? starts[l + 1] - 1 : text.length);
  return blockNodes(toks, 0, toks.length, { env, slice: (map) => text.slice(starts[map[0]], lineEnd(map[1] - 1)).replace(/\s+$/, "") });
}

// ---------------- serialize ----------------
const wide = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1F300}-\u{1FAFF}]/u;
const strWidth = (s) => { let w = 0; for (const ch of s) w += wide.test(ch) ? 2 : 1; return w; };

const isPunct = (c) => /[!-/:-@[-`{-~]/.test(c);
function escText(s, o) {
  if (o.light) {
    // only what can't be left alone
    s = s.replace(/\\(?=[!-/:-@[-`{-~])/g, "\\\\");
  } else {
    let r = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i], p = s[i - 1] || (i === 0 ? o.before || " " : " "), n = s[i + 1] || o.after || " ";
      if (c === "\\") r += isPunct(n) || i === s.length - 1 ? "\\\\" : "\\";
      else if (c === "`" || c === "*" || c === "[" || c === "$" || (c === "]" && o.link)) r += "\\" + c;
      else if (c === "_") r += /[\p{L}\p{N}]/u.test(p) && /[\p{L}\p{N}]/u.test(n) ? "_" : "\\_";
      else if (c === "<") r += /[A-Za-z/!?]/.test(n) ? "\\<" : "<";
      else if (c === "~") r += n === "~" || p === "~" ? "\\~" : "~";
      else if (c === "&") r += /^&(#\d+|#x[\da-f]+|\w+);/i.test(s.slice(i)) ? "\\&" : "&";
      else r += c;
    }
    s = r;
  }
  if (o.table) s = s.replace(/\|/g, "\\|");
  return s;
}

function markOpen(m) {
  switch (m.type.name) {
    case "strong": return m.attrs.open === "__" ? "__" : "**";
    case "em": return m.attrs.open === "_" ? "_" : "*";
    case "strike": return "~~";
    case "underline": return "<u>";
    case "smallcaps": return '<span style="font-variant:small-caps">';
    case "sup": return "<sup>";
    case "sub": return "<sub>";
    case "link": return m.attrs.kind === "autolink" ? "<" : m.attrs.kind === "linkify" ? "" : "[";
    default: return "";
  }
}
function markClose(m) {
  switch (m.type.name) {
    case "strong": return m.attrs.open === "__" ? "__" : "**";
    case "em": return m.attrs.open === "_" ? "_" : "*";
    case "strike": return "~~";
    case "underline": return "</u>";
    case "smallcaps": return "</span>";
    case "sup": return "</sup>";
    case "sub": return "</sub>";
    case "link": {
      const a = m.attrs;
      if (a.kind === "autolink") return ">";
      if (a.kind === "linkify") return "";
      if (a.ref != null) return "]" + a.ref;
      const href = /[\s()<>]/.test(a.href) ? `<${a.href.replace(/[<>]/g, (c) => encodeURI(c))}>` : a.href;
      return `](${href}${a.title ? ` "${a.title.replace(/"/g, '\\"')}"` : ""})`;
    }
    default: return "";
  }
}
const rawLink = (marks) => marks.some((m) => m.type === M.link && (m.attrs.kind === "autolink" || m.attrs.kind === "linkify"));

function codeSpan(text) {
  let n = 1;
  for (const m of text.match(/`+/g) || []) n = Math.max(n, m.length + 1);
  const f = "`".repeat(n);
  const pad = /^`|`$/.test(text) || (/^ .* $/.test(text) && text.trim()) ? " " : "";
  return f + pad + text + pad + f;
}

/** How many of the open marks (outermost first) can stay open for a node with marks `ms`. */
/** Same mark for writing purposes (\\textbf{ vs {\\bf, ** vs __ don't matter). */
export const sameMark = (a, b) => a.type === b.type && (a.type.name !== "link" || (a.attrs.href === b.attrs.href && a.attrs.kind === b.attrs.kind && a.attrs.ref === b.attrs.ref));
export function keptMarks(active, ms) {
  let keep = 0;
  while (keep < active.length && ms.some((m) => sameMark(m, active[keep]))) keep++;
  return keep;
}
/** Marks to open for kids[idx], outermost first: the one that runs longest goes outside. */
export function marksToOpen(active, ms, kids, idx, innermost) {
  const open = ms.filter((m) => !active.some((a) => sameMark(a, m)));
  if (open.length < 2) return open;
  const run = (m) => { let n = 0; for (let k = idx; k < kids.length && kids[k].marks.some((x) => sameMark(x, m)); k++) n++; return n; };
  const len = new Map(open.map((m) => [m, run(m)]));
  return open.sort((a, b) => len.get(b) - len.get(a) || (innermost && (innermost(a) - innermost(b))) || a.type.rank - b.type.rank);
}

const PUNCT = /[!-/:-@[-`{-~\p{P}\p{S}]/u, ALNUM = /[\p{L}\p{N}]/u;
const EMPH = new Set(["strong", "em", "strike"]);
/**
 * CommonMark can't close emphasis between punctuation and a letter ("**0.**68") or open it
 * between a letter and punctuation ("a**.b**"): move such punctuation outside the mark.
 */
function fixFlanking(parent) {
  const kids = [];
  parent.forEach((c) => kids.push(c));
  if (!kids.some((k) => k.isText && k.marks.some((m) => EMPH.has(m.type.name)))) return kids;
  // flatten to characters with marks, adjust, regroup
  const chars = [];
  for (const k of kids) {
    if (k.isText) for (const ch of k.text) chars.push({ ch, marks: k.marks });
    else chars.push({ node: k, marks: k.marks });
  }
  const has = (c, t) => c && c.marks.some((m) => m.type === t);
  // atoms start/end with punctuation in Markdown ($…$, [@…], ![…])
  const chOf = (c) => (c ? (c.ch != null ? c.ch : c.node.type === S.hard_break ? " " : "$") : " ");
  const punct = (c) => c && PUNCT.test(chOf(c));
  for (const t of [M.strong, M.em, M.strike]) {
    for (let i = 0; i < chars.length; i++) {
      // end of a run of t
      if (has(chars[i], t) && !has(chars[i + 1], t) && punct(chars[i]) && ALNUM.test(chOf(chars[i + 1]))) {
        let k = i;
        while (k >= 0 && has(chars[k], t) && punct(chars[k])) { chars[k] = { ...chars[k], marks: t.removeFromSet(chars[k].marks) }; k--; }
      }
      // start of a run of t
      if (has(chars[i], t) && !has(chars[i - 1], t) && punct(chars[i]) && ALNUM.test(chOf(chars[i - 1]))) {
        let k = i;
        while (k < chars.length && has(chars[k], t) && punct(chars[k])) { chars[k] = { ...chars[k], marks: t.removeFromSet(chars[k].marks) }; k++; }
      }
    }
  }
  const out = [];
  let buf = "", bufMarks = null;
  const flush = () => { if (buf) out.push(schema.text(buf, bufMarks)); buf = ""; };
  for (const c of chars) {
    if (c.node) { flush(); out.push(c.node.mark(c.marks)); continue; }
    if (bufMarks && !(c.marks.length === bufMarks.length && c.marks.every((m, i) => m.eq(bufMarks[i])))) flush();
    bufMarks = c.marks;
    buf += c.ch;
  }
  flush();
  return out;
}

/** Inline content of a textblock as Markdown. */
export function inlineMd(parent, o = {}) {
  let out = "";
  const active = [];
  const closeTo = (k) => {
    let trail = "";
    if (active.length > k) { const m = /[ \t]+$/.exec(out); if (m) { trail = m[0]; out = out.slice(0, -trail.length); } }
    while (active.length > k) out += markClose(active.pop());
    out += trail;
  };
  const kids = fixFlanking(parent);
  kids.forEach((child, idx) => {
    const ms = child.marks.filter((m) => m.type !== M.code);
    const keep = keptMarks(active, ms);
    closeTo(keep);
    let text = child.isText ? child.text : null;
    const open = marksToOpen(active, ms, kids, idx, (m) => m.type === M.link && m.attrs.ref != null);
    if (open.length && text) {
      const lead = /^[ \t]+/.exec(text);
      if (lead) { out += lead[0]; text = text.slice(lead[0].length); }
    }
    for (const m of open) {
      let o = markOpen(m);
      // "*a***" + "*b*" would merge into one delimiter run: switch to _ when that's allowed
      if ((m.type === M.em || m.type === M.strong) && o[0] === "*" && out.endsWith("*")) {
        const alt = m.type === M.em ? M.em.create({ open: "_" }) : M.strong.create({ open: "__" });
        o = markOpen(alt);
        out += o; active.push(alt); continue;
      }
      out += o; active.push(m);
    }
    if (child.isText) {
      if (child.marks.some((m) => m.type === M.code)) out += o.table ? codeSpan(text).replace(/\|/g, "\\|") : codeSpan(text);
      else if (rawLink(child.marks)) out += text;
      else {
        const prev = kids[idx - 1], next = kids[idx + 1];
        out += escText(text, { ...o, link: child.marks.some((m) => m.type === M.link), before: prev?.isText ? prev.text.slice(-1) : " ", after: next?.isText ? next.text[0] : " " });
      }
      return;
    }
    const a = child.attrs;
    switch (child.type.name) {
      case "hard_break": out += a.src || "\\\n"; break;
      case "image": {
        const src = /[\s()<>]/.test(a.src) ? `<${a.src}>` : a.src;
        out += a.ref != null ? `![${a.alt}]${a.ref}` : `![${a.alt.replace(/[[\]]/g, "\\$&")}](${src}${a.title ? ` "${a.title.replace(/"/g, '\\"')}"` : ""})`;
        break;
      }
      case "math_inline": {
        // $ can't open right after a letter/digit or close right before one: keep a space there
        const next = kids[idx + 1];
        const pre = a.open === "$" && /[\w\d$]$/.test(out) ? " " : "";
        const post = a.close === "$" && next && next.isText && /^[\w\d]/.test(next.text) ? " " : "";
        out += pre + a.open + a.tex + a.close + post;
        break;
      }
      case "footnote_ref": out += `[^${a.label}]`; break;
      case "cite": case "raw_inline": out += a.src; break;
      case "ref": out += a.src; break;
      case "sym": out += a.text; break;
      case "footnote": out += `^[${a.body}]`; break;
      default: out += child.textContent;
    }
  });
  closeTo(0);
  return out;
}

function lineStartEscape(s) {
  return s.replace(/^(\s{0,3})(#{1,6}(?=\s|$)|>|[-+*](?=\s|$)|=+\s*$|(\d+)([.)])(?=\s|$))/, (m, sp, all, num, d) => (num ? sp + num + "\\" + d : sp + "\\" + all));
}

function fenceFor(text, ch = "`", min = 3) {
  let n = min;
  for (const m of text.match(new RegExp(`^[ \\t]*${ch === "`" ? "`" : "~"}{3,}`, "gm")) || []) n = Math.max(n, m.trim().length + 1);
  return ch.repeat(n);
}

/** A block node as Markdown (no trailing newline); null for nothing (an empty paragraph). */
export function blockMd(node, o = {}) {
  const a = node.attrs;
  switch (node.type.name) {
    case "paragraph": {
      const t = inlineMd(node, o);
      if (!t && o.top) return null;
      return o.light ? t : lineStartEscape(t);
    }
    case "heading": {
      const t = inlineMd(node, o);
      if ((a.markup === "=" || a.markup === "-") && a.level <= 2 && t) return t + "\n" + (a.level === 1 ? "=" : "-").repeat(Math.max(3, strWidth(t)));
      return "#".repeat(Math.min(6, a.level)) + (t ? " " + t : "");
    }
    case "blockquote": {
      const body = childrenMd(node, "\n\n", o);
      return body.split("\n").map((l) => (l ? "> " + l : ">")).join("\n");
    }
    case "bullet_list": case "ordered_list": {
      const ordered = node.type.name === "ordered_list";
      const items = [];
      node.forEach((item, _, i) => {
        const marker = ordered ? `${a.lazy ? a.start : a.start + i}${a.delim || "."}` : a.bullet || "-";
        const task = item.attrs.checked != null ? `[${item.attrs.checked ? "x" : " "}] ` : "";
        const body = childrenMd(item, a.tight ? "\n" : "\n\n", o);
        const ind = " ".repeat(marker.length + 1);
        const lines = body.split("\n");
        lines[0] = (marker + " " + task + lines[0]).replace(/\s+$/, "");
        for (let k = 1; k < lines.length; k++) lines[k] = lines[k] ? ind + lines[k] : "";
        items.push(lines.join("\n"));
      });
      return items.join(a.tight ? "\n" : "\n\n");
    }
    case "code_block": {
      const text = node.textContent;
      if (a.indented) return text.split("\n").map((l) => (l ? "    " + l : "")).join("\n");
      const f = fenceFor(text, (a.fence || "`")[0] === "~" ? "~" : "`", Math.max(3, (a.fence || "```").length));
      return f + (a.lang || "") + "\n" + text + "\n" + f;
    }
    case "raw_block": return node.textContent;
    case "horizontal_rule": return a.markup && a.markup.length >= 3 ? a.markup : "---";
    case "math_display": return a.open + a.tex + a.close;
    case "table": return tableMd(node, o);
    case "footnote_def": return `[^${a.label}]: ` + inlineMd(node, o);
    case "meta": case "caption": return inlineMd(node, o);
    case "tex_cmd": return "`" + a.src + "`";
    case "float": case "tex_env": return childrenMd(node, "\n\n", o);
    case "figure_image": return `![](${a.path})`;
    default: return node.textContent;
  }
}
function childrenMd(node, sep, o) {
  const parts = [];
  node.forEach((c) => {
    const t = blockMd(c, { ...o, top: false });
    if (t != null) parts.push(t);
  });
  return parts.join(sep);
}

function tableMd(node, o) {
  const rows = [];
  let cols = 0;
  node.forEach((row) => {
    const r = [];
    row.forEach((cell) => r.push(inlineMd(cell, { ...o, table: true }).replace(/\n/g, " ")));
    cols = Math.max(cols, r.length);
    rows.push(r);
  });
  const aligns = [];
  const first = node.firstChild;
  for (let c = 0; c < cols; c++) aligns.push(first && c < first.childCount ? first.child(c).attrs.align : null);
  const w = aligns.map((al, c) => Math.max(al === "center" ? 5 : al ? 4 : 3, ...rows.map((r) => strWidth(r[c] || ""))));
  const pad = (s, width, al) => {
    const gap = width - strWidth(s);
    if (al === "right") return " ".repeat(gap) + s;
    if (al === "center") return " ".repeat(gap >> 1) + s + " ".repeat(gap - (gap >> 1));
    return s + " ".repeat(gap);
  };
  const line = (r) => "| " + w.map((width, c) => pad(r[c] || "", width, aligns[c])).join(" | ") + " |";
  const delim = "| " + w.map((width, c) => {
    const al = aligns[c];
    if (al === "center") return ":" + "-".repeat(width - 2) + ":";
    if (al === "left") return ":" + "-".repeat(width - 1);
    if (al === "right") return "-".repeat(width - 1) + ":";
    return "-".repeat(width);
  }).join(" | ") + " |";
  const out = [line(rows[0] || []), delim];
  for (let i = 1; i < rows.length; i++) out.push(line(rows[i]));
  return out.join("\n");
}

// ---------------- the round-trip format ----------------
/** Canonical text of a node: two nodes mean the same Markdown iff these are equal. */
const canon = (node) => blockMd(node, {});

export function mdFormat(rt) {
  const fmt = {
    fresh(node) {
      // light escaping first; keep it if it reads back as the same thing
      const full = blockMd(node, { top: true });
      if (full == null) return null;
      const light = blockMd(node, { top: true, light: true });
      if (light !== full && light != null) {
        try {
          const back = parseMarkdownFragment(light, rt.env);
          if (back.length === 1 && canon(back[0]) === canon(node)) return light;
        } catch { /* use the escaped text */ }
      }
      return full;
    },
    mergeable: (node) => node.type !== S.table && node.type !== S.code_block && node.type !== S.raw_block && node.type !== S.math_display,
    verify(text, node) {
      const back = parseMarkdownFragment(text, rt.env);
      return back.length === 1 && canon(back[0]) === canon(node);
    },
  };
  return fmt;
}

export function serializeMarkdown(doc, rt) {
  const kids = [];
  doc.forEach((c) => kids.push(c));
  let out = serializeSeq(kids, rt.recs, mdFormat(rt), "\n\n") + rt.suffix;
  // a file that ended with a newline keeps ending with one
  if (!rt.suffix && rt.recs.length === 0 && out && !out.endsWith("\n")) out += "\n";
  return rt.crlf ? out.replace(/\n/g, "\r\n") : out;
}
