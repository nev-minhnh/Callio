// One ProseMirror schema for both Markdown and LaTeX documents. Nodes carry, in their attrs,
// whatever source detail the parsers need to write a node back the way it was written
// (which emphasis marker, which \begin line, the table's column spec, ...).
// No DOM access here: the parsers and serializers also run under node for the tests.
import { Schema } from "prosemirror-model";

// atoms/odd nodes copy through the clipboard as <span data-wy="type" data-a='{json}'>
const dataDom = (tag, type, extra = {}) => (node) => [tag, { "data-wy": type, "data-a": JSON.stringify(node.attrs), ...extra }];
const dataParse = (tag, type) => [{
  tag: `${tag}[data-wy="${type}"]`,
  getAttrs: (dom) => { try { return JSON.parse(dom.getAttribute("data-a") || "{}"); } catch { return false; } },
}];
const leafText = (node) => node.attrs.text ?? node.attrs.src ?? "";

const cellAttrs = {
  colspan: { default: 1 },
  rowspan: { default: 1 },
  colwidth: { default: null },
  align: { default: null },
};
const cellGetAttrs = (dom) => {
  const al = (dom.style && dom.style.textAlign) || dom.getAttribute("align") || null;
  return {
    colspan: +(dom.getAttribute("colspan") || 1),
    rowspan: +(dom.getAttribute("rowspan") || 1),
    align: /^(left|center|right)$/.test(al || "") ? al : null,
  };
};
const cellDom = (tag) => (node) => {
  const a = {};
  if (node.attrs.colspan !== 1) a.colspan = node.attrs.colspan;
  if (node.attrs.rowspan !== 1) a.rowspan = node.attrs.rowspan;
  if (node.attrs.align) a.style = `text-align:${node.attrs.align}`;
  return [tag, a, 0];
};

export const nodes = {
  doc: { content: "block+" },
  paragraph: {
    group: "block", content: "inline*",
    parseDOM: [{ tag: "p" }],
    toDOM: () => ["p", 0],
  },
  heading: {
    group: "block", content: "inline*", defining: true,
    attrs: {
      level: { default: 1 },
      markup: { default: null }, // md: "#" or "=" / "-" (setext)
      cmd: { default: null }, // tex: section, subsection, ...
      star: { default: false },
      opt: { default: null }, // tex: "[short title]"
      label: { default: null }, // tex: \label after the title
      labelSep: { default: "" },
    },
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: "h" + level, attrs: { level } })),
    toDOM: (n) => ["h" + n.attrs.level, 0],
  },
  blockquote: {
    group: "block", content: "block+", defining: true,
    attrs: { open: { default: null }, close: { default: null } },
    parseDOM: [{ tag: "blockquote" }],
    toDOM: () => ["blockquote", 0],
  },
  tex_env: {
    group: "block", content: "block+", defining: true,
    attrs: { env: { default: "" }, open: { default: "" }, close: { default: "" } },
    parseDOM: dataParse("div", "tex_env"),
    toDOM: (n) => ["div", { "data-wy": "tex_env", "data-a": JSON.stringify(n.attrs) }, 0],
  },
  bullet_list: {
    group: "block", content: "list_item+",
    attrs: { bullet: { default: "-" }, tight: { default: true }, open: { default: null }, close: { default: null }, pre: { default: "" }, env: { default: null } },
    parseDOM: [{ tag: "ul" }],
    toDOM: () => ["ul", 0],
  },
  ordered_list: {
    group: "block", content: "list_item+",
    attrs: { start: { default: 1 }, delim: { default: "." }, lazy: { default: false }, tight: { default: true }, open: { default: null }, close: { default: null }, pre: { default: "" }, env: { default: null } },
    parseDOM: [{ tag: "ol", getAttrs: (d) => ({ start: d.hasAttribute("start") ? +d.getAttribute("start") : 1 }) }],
    toDOM: (n) => ["ol", n.attrs.start === 1 ? {} : { start: n.attrs.start }, 0],
  },
  list_item: {
    content: "block+", defining: true,
    attrs: { checked: { default: null }, label: { default: null } },
    parseDOM: [{
      tag: "li",
      getAttrs: (d) => {
        const cb = d.querySelector(":scope > input[type=checkbox], :scope > p > input[type=checkbox]");
        return { checked: cb ? cb.checked : null };
      },
    }],
    toDOM: () => ["li", 0],
  },
  code_block: {
    group: "block", content: "text*", marks: "", code: true, defining: true,
    attrs: { lang: { default: "" }, fence: { default: "```" }, indented: { default: false }, open: { default: null }, close: { default: null } },
    parseDOM: [{ tag: "pre", preserveWhitespace: "full", getAttrs: (d) => ({ lang: (/language-(\S+)/.exec(d.querySelector("code")?.className || "") || [])[1] || "" }) }],
    toDOM: () => ["pre", ["code", 0]],
  },
  // source we keep verbatim and edit as code: preamble, comments, unknown environments, HTML
  raw_block: {
    group: "block", content: "text*", marks: "", code: true, defining: true,
    attrs: { kind: { default: "raw" }, lang: { default: "" } },
    parseDOM: [{ tag: 'pre[data-wy="raw_block"]', preserveWhitespace: "full", getAttrs: (d) => { try { return JSON.parse(d.getAttribute("data-a")); } catch { return {}; } } }],
    toDOM: (n) => ["pre", { "data-wy": "raw_block", "data-a": JSON.stringify(n.attrs) }, ["code", 0]],
  },
  horizontal_rule: {
    group: "block", attrs: { markup: { default: "---" } },
    parseDOM: [{ tag: "hr" }],
    toDOM: () => ["hr"],
  },
  math_display: {
    group: "block", atom: true, selectable: true,
    attrs: { tex: { default: "" }, open: { default: "$$\n" }, close: { default: "\n$$" }, env: { default: null } },
    parseDOM: dataParse("div", "math_display"),
    toDOM: dataDom("div", "math_display"),
  },
  // \title{...}, \author{...}, \affiliation{...} in the body
  meta: {
    group: "block", content: "inline*", defining: true,
    attrs: { cmd: { default: "title" }, open: { default: "\\title{" }, close: { default: "}" } },
    parseDOM: dataParse("div", "meta"),
    toDOM: (n) => ["div", { "data-wy": "meta", "data-a": JSON.stringify(n.attrs) }, 0],
  },
  // \maketitle, \tableofcontents, \bibliography{..}, \input{..}, ...
  tex_cmd: {
    group: "block", atom: true, selectable: true,
    attrs: { src: { default: "" } },
    parseDOM: dataParse("div", "tex_cmd"),
    toDOM: dataDom("div", "tex_cmd"),
  },
  footnote_def: {
    group: "block", content: "inline*",
    attrs: { label: { default: "1" } },
    parseDOM: dataParse("div", "footnote_def"),
    toDOM: (n) => ["div", { "data-wy": "footnote_def", "data-a": JSON.stringify(n.attrs) }, 0],
  },
  // figure / table environments: the source around the parts we understand is a template
  float: {
    group: "block", content: "(figure_image | table | caption | raw_block)+", isolating: true, defining: true,
    attrs: { env: { default: "figure" }, parts: { default: [] }, label: { default: null } },
    parseDOM: dataParse("div", "float"),
    toDOM: (n) => ["div", { "data-wy": "float", "data-a": JSON.stringify(n.attrs) }, 0],
  },
  caption: {
    content: "inline*", defining: true,
    attrs: { open: { default: "\\caption{" }, close: { default: "}" } },
    parseDOM: [{ tag: "figcaption" }, { tag: "caption" }],
    toDOM: () => ["figcaption", 0],
  },
  figure_image: {
    atom: true, selectable: true,
    attrs: { cmd: { default: "\\includegraphics" }, opts: { default: "" }, path: { default: "" } },
    parseDOM: dataParse("div", "figure_image"),
    toDOM: dataDom("div", "figure_image"),
  },
  table: {
    group: "block", content: "table_row+", tableRole: "table", isolating: true,
    attrs: {
      open: { default: null }, close: { default: null }, post: { default: "" },
      spec: { default: null }, // tex: { pre, items:[{s,c}], end, post } of the column spec
      booktabs: { default: false },
    },
    parseDOM: [{ tag: "table" }],
    toDOM: () => ["table", ["tbody", 0]],
  },
  table_row: {
    content: "(table_cell | table_header)*", tableRole: "row",
    attrs: { pre: { default: "" }, end: { default: "\\\\" }, n: { default: null } },
    parseDOM: [{ tag: "tr" }],
    toDOM: () => ["tr", 0],
  },
  table_cell: {
    content: "inline*", tableRole: "cell", isolating: true, attrs: cellAttrs,
    parseDOM: [{ tag: "td", getAttrs: cellGetAttrs }],
    toDOM: cellDom("td"),
  },
  table_header: {
    content: "inline*", tableRole: "header_cell", isolating: true, attrs: cellAttrs,
    parseDOM: [{ tag: "th", getAttrs: cellGetAttrs }],
    toDOM: cellDom("th"),
  },

  // ---------- inline ----------
  text: { group: "inline" },
  hard_break: {
    inline: true, group: "inline", selectable: false,
    attrs: { src: { default: null } },
    parseDOM: [{ tag: "br" }],
    toDOM: () => ["br"],
    leafText: () => "\n",
  },
  image: {
    inline: true, group: "inline", draggable: true,
    attrs: { src: { default: "" }, alt: { default: "" }, title: { default: null }, ref: { default: null }, tex: { default: null } },
    parseDOM: [{ tag: "img[src]", getAttrs: (d) => ({ src: d.getAttribute("src"), alt: d.getAttribute("alt") || "", title: d.getAttribute("title") }) }],
    toDOM: (n) => ["img", { src: n.attrs.src, alt: n.attrs.alt, title: n.attrs.title }],
  },
  math_inline: {
    inline: true, group: "inline", atom: true,
    attrs: { tex: { default: "" }, open: { default: "$" }, close: { default: "$" }, display: { default: false } },
    parseDOM: [...dataParse("span", "math_inline"), {
      // KaTeX output copied from elsewhere
      tag: "span.katex",
      getAttrs: (d) => { const a = d.querySelector('annotation[encoding="application/x-tex"]'); return a ? { tex: a.textContent } : false; },
    }],
    toDOM: dataDom("span", "math_inline"),
    leafText: (n) => n.attrs.open + n.attrs.tex + n.attrs.close,
  },
  cite: {
    inline: true, group: "inline", atom: true,
    attrs: { src: { default: "" } },
    parseDOM: dataParse("span", "cite"), toDOM: dataDom("span", "cite"), leafText,
  },
  ref: {
    inline: true, group: "inline", atom: true,
    attrs: { src: { default: "" } },
    parseDOM: dataParse("span", "ref"), toDOM: dataDom("span", "ref"), leafText,
  },
  footnote_ref: {
    inline: true, group: "inline", atom: true,
    attrs: { label: { default: "1" } },
    parseDOM: dataParse("sup", "footnote_ref"), toDOM: dataDom("sup", "footnote_ref"),
    leafText: (n) => `[^${n.attrs.label}]`,
  },
  footnote: {
    inline: true, group: "inline", atom: true,
    attrs: { open: { default: "\\footnote{" }, body: { default: "" } },
    parseDOM: dataParse("sup", "footnote"), toDOM: dataDom("sup", "footnote"),
    leafText: () => "",
  },
  // unknown inline source (LaTeX commands, HTML tags, comments): shown as a chip, kept verbatim
  raw_inline: {
    inline: true, group: "inline", atom: true,
    attrs: { src: { default: "" }, kind: { default: "raw" } },
    parseDOM: dataParse("span", "raw_inline"), toDOM: dataDom("span", "raw_inline"), leafText,
  },
  // LaTeX glyphs written as markup: `` '' -- --- \ldots \'e ...
  sym: {
    inline: true, group: "inline", atom: true,
    attrs: { src: { default: "" }, text: { default: "" } },
    parseDOM: dataParse("span", "sym"), toDOM: dataDom("span", "sym"),
    leafText: (n) => n.attrs.text,
  },
};

export const marks = {
  link: {
    attrs: { href: { default: "" }, title: { default: null }, kind: { default: null }, ref: { default: null } },
    inclusive: false,
    parseDOM: [{ tag: "a[href]", getAttrs: (d) => ({ href: d.getAttribute("href"), title: d.getAttribute("title") }) }],
    toDOM: (m) => ["a", { href: m.attrs.href, title: m.attrs.title, rel: "noopener" }, 0],
  },
  strong: {
    attrs: { open: { default: null } },
    parseDOM: [{ tag: "b" }, { tag: "strong" }, { style: "font-weight", getAttrs: (v) => /^(bold(er)?|[6-9]\d{2})$/.test(v) && null }],
    toDOM: () => ["strong", 0],
  },
  em: {
    attrs: { open: { default: null } },
    parseDOM: [{ tag: "i" }, { tag: "em" }, { style: "font-style=italic" }],
    toDOM: () => ["em", 0],
  },
  underline: {
    attrs: { open: { default: null } },
    parseDOM: [{ tag: "u" }, { style: "text-decoration=underline" }],
    toDOM: () => ["u", 0],
  },
  strike: {
    attrs: { open: { default: null } },
    parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }, { style: "text-decoration=line-through" }],
    toDOM: () => ["s", 0],
  },
  smallcaps: {
    attrs: { open: { default: null } },
    parseDOM: [{ style: "font-variant=small-caps" }],
    toDOM: () => ["span", { class: "wy-sc" }, 0],
  },
  sup: {
    attrs: { open: { default: null } },
    excludes: "sub",
    parseDOM: [{ tag: "sup:not([data-wy])" }],
    toDOM: () => ["sup", 0],
  },
  sub: {
    attrs: { open: { default: null } },
    excludes: "sup",
    parseDOM: [{ tag: "sub" }],
    toDOM: () => ["sub", 0],
  },
  code: {
    attrs: { open: { default: null } },
    parseDOM: [{ tag: "code" }],
    toDOM: () => ["code", 0],
  },
};

export const schema = new Schema({ nodes, marks });

/** Every top-level-ish block type that holds inline content directly. */
export const TEXTBLOCKS = new Set(["paragraph", "heading", "meta", "footnote_def", "caption", "table_cell", "table_header"]);
