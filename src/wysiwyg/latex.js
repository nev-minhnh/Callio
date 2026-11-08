// LaTeX source <-> ProseMirror document (LyX-like), round-trip safe.
//
// The body is split into blocks: sections, paragraphs (split on blank lines), lists, quotes,
// display math, figures/tables, title/author lines, and everything we don't understand as
// raw source. Inside paragraphs, known markup (\textbf, \emph, $..$, \cite, \ref, \footnote,
// special characters) becomes rich text; unknown commands become raw chips that keep their
// source. Untouched blocks are always written back byte for byte (see roundtrip.js).
import { schema } from "./schema.js";
import { serializeSeq } from "./roundtrip.js";
import { keptMarks, marksToOpen } from "./markdown.js";

const S = schema.nodes, M = schema.marks;

// ---------------- scanning helpers ----------------
const isLetter = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isWs = (c) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
const eol = (s, i) => { const k = s.indexOf("\n", i); return k < 0 ? s.length : k; };

/** \name at i → { name, end } ; control symbols have a one-char name. */
function readCmd(s, i) {
  let j = i + 1;
  if (j < s.length && isLetter(s[j])) { while (j < s.length && isLetter(s[j])) j++; return { name: s.slice(i + 1, j), end: j }; }
  return { name: s[j] || "", end: Math.min(s.length, j + 1) };
}
/** s[i] === "{": index just past the matching "}", or -1. Skips escapes and comments. */
function matchBrace(s, i, limit = s.length) {
  let d = 0;
  for (let k = i; k < limit; k++) {
    const c = s[k];
    if (c === "\\") { k++; continue; }
    if (c === "%") { k = eol(s, k); continue; }
    if (c === "{") d++;
    else if (c === "}") { d--; if (d === 0) return k + 1; }
  }
  return -1;
}
/** s[i] === "[": index just past the matching "]" (braces nest), or -1. */
function matchBracket(s, i, limit = s.length) {
  for (let k = i + 1; k < limit; k++) {
    const c = s[k];
    if (c === "\\") { k++; continue; }
    if (c === "{") { const e = matchBrace(s, k, limit); if (e < 0) return -1; k = e - 1; continue; }
    if (c === "]") return k + 1;
    if (c === "\n" && /^\n[ \t]*\n/.test(s.slice(k, k + 40))) return -1;
  }
  return -1;
}
/** Skip [..] and {..} arguments right after j (no whitespace allowed between). */
function skipArgs(s, j, limit = s.length, max = 9) {
  for (let n = 0; n < max && j < limit; n++) {
    if (s[j] === "[") { const e = matchBracket(s, j, limit); if (e < 0) break; j = e; }
    else if (s[j] === "{") { const e = matchBrace(s, j, limit); if (e < 0) break; j = e; }
    else break;
  }
  return j;
}
const VERB_ENVS = new Set(["verbatim", "verbatim*", "Verbatim", "lstlisting", "minted", "comment", "BVerbatim", "LVerbatim", "alltt"]);

/** Environment name of "\begin{name}" at i, and the index after it. */
function readBegin(s, i) {
  const m = /^\\(begin|end)[ \t]*\{([^{}\n]*)\}/.exec(s.slice(i, i + 80));
  return m ? { kind: m[1], name: m[2].trim(), end: i + m[0].length } : null;
}
/**
 * From just after "\begin{name}", find its "\end{name}". → { endStart, end } or null.
 */
function findEnd(s, from, name, limit = s.length) {
  if (VERB_ENVS.has(name)) {
    const k = s.indexOf(`\\end{${name}}`, from);
    return k < 0 || k >= limit ? null : { endStart: k, end: k + name.length + 6 };
  }
  let depth = 1;
  for (let k = from; k < limit; k++) {
    const c = s[k];
    if (c === "%") { k = eol(s, k); continue; }
    if (c !== "\\") continue;
    if (s.startsWith("\\verb", k) && !isLetter(s[k + 5] || "")) {
      let q = k + 5;
      if (s[q] === "*") q++;
      const d = s[q];
      const e = d ? s.indexOf(d, q + 1) : -1;
      if (e > 0 && e < eol(s, q)) { k = e; continue; }
    }
    const b = s[k + 1] === "b" || s[k + 1] === "e" ? readBegin(s, k) : null;
    if (!b) { k++; continue; }
    if (b.kind === "begin" && VERB_ENVS.has(b.name)) {
      const e = findEnd(s, b.end, b.name, limit);
      if (!e) return null;
      k = e.end - 1;
      continue;
    }
    if (b.name === name) {
      depth += b.kind === "begin" ? 1 : -1;
      if (depth === 0) return { endStart: k, end: b.end };
    }
    k = b.end - 1;
  }
  return null;
}
/** Is position k (after optional leading spaces) the start of its line? */
const atLineStart = (s, k) => { let j = k - 1; while (j >= 0 && (s[j] === " " || s[j] === "\t")) j--; return j < 0 || s[j] === "\n"; };

// ---------------- vocabulary ----------------
const SECTION = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };
const META = new Set(["title", "subtitle", "author", "date", "affiliation", "address", "institute", "ead", "email", "keywords", "thanks", "dedication", "titlerunning", "authorrunning", "orcid", "cortext", "tnotetext", "fntext", "corref", "shorttitle", "shortauthors"]);
const BLOCK_CMDS = new Set([
  "maketitle", "tableofcontents", "listoffigures", "listoftables", "newpage", "clearpage", "cleardoublepage", "pagebreak",
  "appendix", "bibliography", "bibliographystyle", "printbibliography", "addbibresource", "input", "include", "includeonly",
  "newcommand", "renewcommand", "providecommand", "DeclareMathOperator", "def", "let", "newtheorem", "setlength", "setcounter",
  "addtocounter", "usepackage", "graphicspath", "hypersetup", "pagestyle", "thispagestyle", "onecolumn", "twocolumn",
  "frontmatter", "mainmatter", "backmatter", "bigskip", "medskip", "smallskip", "vfill", "FloatBarrier", "balance",
  "nocite", "IEEEpeerreviewmaketitle", "IEEEoverridecommandlockouts", "printindex", "makeindex", "linenumbers", "doublespacing",
  "singlespacing", "onehalfspacing", "newgeometry", "restoregeometry", "centering", "acknowledgments", "acknowledgements",
  "printnomenclature", "glsaddall", "printglossaries", "endinput", "newline", "vspace", "addcontentsline", "noindent",
]);
const MATH_ENVS = new Set(["equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "flalign", "flalign*", "alignat", "alignat*", "eqnarray", "eqnarray*", "displaymath", "math", "dmath", "dmath*", "subequations"]);
const LIST_ENVS = new Set(["itemize", "enumerate", "description", "compactitem", "compactenum", "inparaenum", "asparaenum", "outline"]);
const QUOTE_ENVS = new Set(["quote", "quotation", "verse"]);
const CONTAINER_ENVS = new Set(["abstract", "frontmatter", "keyword", "keywords", "center", "flushleft", "flushright", "proof", "acknowledgments", "acknowledgements", "acknowledgment", "highlights", "theorem", "lemma", "corollary", "proposition", "definition", "remark", "example", "claim", "conjecture", "assumption", "note", "notation", "observation", "fact", "exercise", "problem", "solution", "hypothesis", "IEEEkeywords", "graphicalabstract", "multicols", "small", "footnotesize"]);
const FLOAT_ENVS = new Set(["figure", "figure*", "table", "table*", "wrapfigure", "wraptable", "sidewaystable", "sidewaysfigure", "SCfigure"]);
const TABULAR_ENVS = new Set(["tabular", "tabular*", "tabularx", "tabulary"]);
const CODE_ENVS = new Set(["verbatim", "verbatim*", "Verbatim", "lstlisting", "minted", "BVerbatim", "LVerbatim", "alltt"]);
const CITE = /^([a-zA-Z]*cite[a-zA-Z]*|Cite[a-zA-Z]*|footfullcite|fullcite)$/;
const REF = new Set(["ref", "eqref", "autoref", "Autoref", "cref", "Cref", "pageref", "nameref", "vref", "Vref", "labelcref", "cpageref", "Cpageref", "crefrange", "subref", "label"]);
const MARK_CMDS = {
  textbf: "strong", textit: "em", emph: "em", textsl: "em", underline: "underline", uline: "underline",
  texttt: "code", textsc: "smallcaps", sout: "strike", st: "strike", xout: "strike",
  textsuperscript: "sup", textsubscript: "sub",
};
const DECLS = { bf: "strong", bfseries: "strong", it: "em", itshape: "em", em: "em", sl: "em", slshape: "em", sc: "smallcaps", scshape: "smallcaps", tt: "code", ttfamily: "code" };
const SYM_WORDS = {
  ldots: "…", dots: "…", textellipsis: "…", LaTeX: "LaTeX", TeX: "TeX", LaTeXe: "LaTeX2ε", BibTeX: "BibTeX", today: "today",
  S: "§", P: "¶", copyright: "©", textcopyright: "©", textregistered: "®", texttrademark: "™", dag: "†", ddag: "‡",
  textdagger: "†", textdaggerdbl: "‡", textdegree: "°", pounds: "£", textsterling: "£", euro: "€", texteuro: "€",
  textendash: "–", textemdash: "—", textquotedblleft: "“", textquotedblright: "”", textquoteleft: "‘", textquoteright: "’",
  textbullet: "•", textperiodcentered: "·", textless: "<", textgreater: ">", textbar: "|", i: "ı", j: "ȷ", ss: "ß",
  ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", aa: "å", AA: "Å", o: "ø", O: "Ø", l: "ł", L: "Ł", quad: "\u2003", qquad: "\u2003\u2003",
  enspace: "\u2002", thinspace: "\u2009", nobreakspace: "\u00a0", textunderscore: "_", textsection: "§", textparagraph: "¶",
  textasciigrave: "`", slash: "/", textellipsis: "…", eg: "e.g.", ie: "i.e.", etal: "et al.", xspace: "", sep: " · ",
};
const SYM_CHARS = { ",": "\u2009", ";": "\u2005", ":": "\u2005", "!": "", " ": " ", "\n": " ", "\t": " ", "/": "", "@": "", "-": "\u00ad" };
const ESC_CHARS = new Set(["%", "&", "_", "#", "$", "{", "}"]);
const TEXT_WORDS = { textbackslash: "\\", textasciitilde: "~", textasciicircum: "^" };
const ACCENTS = { "'": "\u0301", "`": "\u0300", "^": "\u0302", '"': "\u0308", "~": "\u0303", "=": "\u0304", ".": "\u0307", c: "\u0327", v: "\u030C", u: "\u0306", H: "\u030B", r: "\u030A", k: "\u0328", b: "\u0331", d: "\u0323" };

// ---------------- inline parsing ----------------
class TexError extends Error {}

/** Parse s[a..b) as inline content. */
export function parseInlineTex(s, a = 0, b = s.length) {
  const out = [];
  run(s, a, b, [], out);
  return out;
}

function run(s, a, b, marks, out) {
  let buf = "";
  const flush = () => { if (buf) { out.push(schema.text(buf, marks)); buf = ""; } };
  const atom = (type, attrs) => { flush(); out.push(type.create(attrs, null, marks)); };
  let i = a;
  while (i < b) {
    const c = s[i];
    if (isWs(c)) {
      let j = i;
      while (j < b && isWs(s[j])) j++;
      if (/\n[ \t\r]*\n/.test(s.slice(i, j))) throw new TexError("paragraph break inside inline content");
      buf += " ";
      i = j;
      continue;
    }
    if (c === "%") {
      let j = Math.min(eol(s, i), b);
      if (j < b && s[j] === "\n") { j++; while (j < b && (s[j] === " " || s[j] === "\t")) j++; }
      atom(S.raw_inline, { src: s.slice(i, j), kind: "comment" });
      i = j;
      continue;
    }
    if (c === "~") { buf += "\u00a0"; i++; continue; }
    if (c === "`") {
      if (s[i + 1] === "`") { atom(S.sym, { src: "``", text: "“" }); i += 2; } else { atom(S.sym, { src: "`", text: "‘" }); i++; }
      continue;
    }
    if (c === "'" && s[i + 1] === "'") { atom(S.sym, { src: "''", text: "”" }); i += 2; continue; }
    if (c === "-" && s[i + 1] === "-") {
      if (s[i + 2] === "-") { atom(S.sym, { src: "---", text: "—" }); i += 3; } else { atom(S.sym, { src: "--", text: "–" }); i += 2; }
      continue;
    }
    if (c === "&" || c === "#" || c === "^" || c === "_") { atom(S.raw_inline, { src: c, kind: "special" }); i++; continue; }
    if (c === "}") throw new TexError("unbalanced }");
    if (c === "$") {
      if (s[i + 1] === "$") {
        const e = s.indexOf("$$", i + 2);
        if (e < 0 || e >= b) throw new TexError("unclosed $$");
        atom(S.math_inline, { tex: s.slice(i + 2, e), open: "$$", close: "$$", display: true });
        i = e + 2;
      } else {
        let e = i + 1;
        for (; e < b; e++) { if (s[e] === "\\") { e++; continue; } if (s[e] === "$") break; }
        if (e >= b) throw new TexError("unclosed $");
        const tex = s.slice(i + 1, e);
        if (/\n[ \t]*\n/.test(tex)) throw new TexError("blank line in math");
        atom(S.math_inline, { tex, open: "$", close: "$" });
        i = e + 1;
      }
      continue;
    }
    if (c === "{") {
      const e = matchBrace(s, i, b);
      if (e < 0) throw new TexError("unclosed {");
      const m = /^\{\\([a-zA-Z]+)(?![a-zA-Z])(\s*|\{\})/.exec(s.slice(i, Math.min(e, i + 40)));
      if (m && DECLS[m[1]]) {
        flush();
        const mk = M[DECLS[m[1]]].create({ open: m[0] });
        run(s, i + m[0].length, e - 1, mk.addToSet(marks), out);
      } else atom(S.raw_inline, { src: s.slice(i, e), kind: "group" });
      i = e;
      continue;
    }
    if (c !== "\\") { buf += c; i++; continue; }

    // ----- commands -----
    const { name, end } = readCmd(s, i);
    let j = end;
    if (name.length === 1 && !isLetter(name)) {
      if (ESC_CHARS.has(name)) { buf += name; i = j; continue; }
      if (name === "\\") {
        if (s[j] === "*") j++;
        if (s[j] === "[") { const e = matchBracket(s, j, b); if (e > 0) j = e; }
        // the line break's trailing whitespace belongs to it (no leading space on the next line)
        let q = j;
        while (q < b && (s[q] === " " || s[q] === "\t")) q++;
        if (s[q] === "\n" && !/^\n[ \t]*\n/.test(s.slice(q, q + 40))) { q++; while (q < b && (s[q] === " " || s[q] === "\t")) q++; j = q; }
        else if (q > j && s[q] !== "[" && s[q] !== "*") j = q;
        atom(S.hard_break, { src: s.slice(i, j) });
        i = j;
        continue;
      }
      if (name === "(" || name === "[") {
        const close = name === "(" ? "\\)" : "\\]";
        const e = s.indexOf(close, j);
        if (e < 0 || e >= b) throw new TexError("unclosed math");
        atom(S.math_inline, { tex: s.slice(j, e), open: "\\" + name, close, display: name === "[" });
        i = e + 2;
        continue;
      }
      if (ACCENTS[name]) {
        const acc = accent(s, i, j, name, b);
        if (acc) { atom(S.sym, acc); i = i + acc.src.length; continue; }
      }
      if (name in SYM_CHARS) { atom(S.sym, { src: s.slice(i, j), text: SYM_CHARS[name] }); i = j; continue; }
      atom(S.raw_inline, { src: s.slice(i, j), kind: "raw" });
      i = j;
      continue;
    }
    if (ACCENTS[name] && name.length === 1 && s[j] === "{") {
      const acc = accent(s, i, j, name, b);
      if (acc) { atom(S.sym, acc); i = i + acc.src.length; continue; }
    }
    if (TEXT_WORDS[name]) {
      if (s.startsWith("{}", j)) j += 2;
      buf += TEXT_WORDS[name];
      i = j;
      continue;
    }
    if (SYM_WORDS[name] !== undefined && s[j] !== "[" && !(s[j] === "{" && s[j + 1] !== "}")) {
      if (s.startsWith("{}", j)) j += 2;
      atom(S.sym, { src: s.slice(i, j), text: SYM_WORDS[name] });
      i = j;
      continue;
    }
    const mk = MARK_CMDS[name];
    if (mk && s[j] === "{") {
      const e = matchBrace(s, j, b);
      if (e < 0) throw new TexError("unclosed argument");
      flush();
      const mark = M[mk].create({ open: s.slice(i, j + 1) });
      if (e - 1 > j + 1) run(s, j + 1, e - 1, mark.addToSet(marks), out);
      else atom(S.raw_inline, { src: s.slice(i, e), kind: "raw" });
      i = e;
      continue;
    }
    if (name === "url" && s[j] === "{") {
      const e = matchBrace(s, j, b);
      if (e < 0) throw new TexError("unclosed \\url");
      const url = s.slice(j + 1, e - 1);
      flush();
      if (url) out.push(schema.text(url, M.link.create({ href: url, kind: "url" }).addToSet(marks)));
      else out.push(S.raw_inline.create({ src: s.slice(i, e) }, null, marks));
      i = e;
      continue;
    }
    if (name === "href" && s[j] === "{") {
      const e1 = matchBrace(s, j, b);
      if (e1 > 0 && s[e1] === "{") {
        const e2 = matchBrace(s, e1, b);
        if (e2 > 0 && e2 - 1 > e1 + 1) {
          flush();
          const link = M.link.create({ href: s.slice(j + 1, e1 - 1), kind: "href" });
          run(s, e1 + 1, e2 - 1, link.addToSet(marks), out);
          i = e2;
          continue;
        }
      }
    }
    if (CITE.test(name) || REF.has(name)) {
      let q = j;
      if (s[q] === "*") q++;
      while (s[q] === "[") { const e = matchBracket(s, q, b); if (e < 0) break; q = e; }
      if (s[q] === "{") {
        const e = matchBrace(s, q, b);
        if (e > 0) { atom(CITE.test(name) ? S.cite : S.ref, { src: s.slice(i, e) }); i = e; continue; }
      }
    }
    if (name === "footnote") {
      let q = j;
      if (s[q] === "[") { const e = matchBracket(s, q, b); if (e > 0) q = e; }
      if (s[q] === "{") {
        const e = matchBrace(s, q, b);
        if (e > 0) { atom(S.footnote, { open: s.slice(i, q + 1), body: s.slice(q + 1, e - 1) }); i = e; continue; }
      }
    }
    if (name === "includegraphics") {
      const e = skipArgs(s, j[0] === "*" ? j + 1 : j, b);
      const m = /\{([^{}]*)\}$/.exec(s.slice(i, e));
      atom(S.image, { tex: s.slice(i, e), src: m ? m[1].trim() : "", alt: "" });
      i = e;
      continue;
    }
    if (name === "verb" || name === "lstinline") {
      let q = j;
      if (s[q] === "*") q++;
      if (name === "lstinline" && s[q] === "[") { const e = matchBracket(s, q, b); if (e > 0) q = e; }
      const d = s[q];
      const e = d === "{" ? matchBrace(s, q, b) : s.indexOf(d, q + 1) + 1;
      if (e > 0 && e <= b) { atom(S.raw_inline, { src: s.slice(i, e), kind: "verb" }); i = e; continue; }
      throw new TexError("bad \\verb");
    }
    if (name === "begin") {
      const bg = readBegin(s, i);
      const f = bg && findEnd(s, bg.end, bg.name, b);
      if (!f) throw new TexError("unclosed environment");
      atom(S.raw_inline, { src: s.slice(i, f.end), kind: "env" });
      i = f.end;
      continue;
    }
    // anything else: the command with its arguments, kept as source
    let q = j;
    if (s[q] === "*") q++;
    q = skipArgs(s, q, b);
    atom(S.raw_inline, { src: s.slice(i, q), kind: "raw" });
    i = q;
  }
  flush();
}

function accent(s, i, j, name, b) {
  // \'e  \'{e}  \"{\i}  \c{c}  \v s ...
  let base = null, k = j;
  if (s[k] === "{") {
    const e = matchBrace(s, k, b);
    if (e < 0) return null;
    const inner = s.slice(k + 1, e - 1).trim();
    if (/^[A-Za-z]$/.test(inner)) base = inner;
    else if (inner === "\\i") base = "ı";
    else if (inner === "\\j") base = "ȷ";
    else if (inner === "") base = "";
    else return null;
    k = e;
  } else if (isLetter(name)) {
    if (s[k] !== " " || !isLetter(s[k + 1] || "") || isLetter(s[k + 2] || "")) return null;
    base = s[k + 1];
    k += 2;
  } else if (isLetter(s[k] || "")) { base = s[k]; k++; }
  else return null;
  const text = base === "ı" || base === "ȷ" ? base + ACCENTS[name] : (base + ACCENTS[name]).normalize("NFC");
  return { src: s.slice(i, k), text: base === "" ? ACCENTS[name].trim() : text };
}

// ---------------- block parsing ----------------
function rawBlock(src, kind = "raw") {
  return S.raw_block.create({ kind, lang: "latex" }, src ? schema.text(src) : null);
}

/**
 * Parse s[from..to) into blocks. → { recs: [{node, src, sep}], tail }
 */
function parseBody(s, from, to, ctx) {
  const recs = [];
  let pos = from;
  for (;;) {
    let ws = pos;
    while (ws < to && isWs(s[ws])) ws++;
    if (ws >= to) break;
    let r = null;
    try { r = blockAt(s, ws, to, ctx); } catch (e) { if (!(e instanceof TexError) && !(e instanceof RangeError)) console.warn("[wysiwyg] tex block", e); r = null; }
    if (r) { try { r.node.check(); } catch { r = null; } }
    if (!r || r.end <= ws) r = rawUntilBlank(s, ws, to);
    recs.push({ node: r.node, src: s.slice(ws, r.end), sep: s.slice(pos, ws) });
    pos = r.end;
  }
  return { recs, tail: s.slice(pos, to) };
}
function rawUntilBlank(s, i, to) {
  const m = /\n[ \t\r]*\n/g;
  m.lastIndex = i;
  const r = m.exec(s);
  let end = r && r.index < to ? r.index : to;
  while (end > i && isWs(s[end - 1])) end--;
  return { node: rawBlock(s.slice(i, end), s[i] === "%" ? "comment" : "raw"), end };
}
const trimEnd = (s, i, end) => { while (end > i && isWs(s[end - 1])) end--; return end; };

/** A command line that stands alone: \cmd + args, then only spaces/comment to the end of line. */
function standalone(s, k, to) {
  const { name, end } = readCmd(s, k);
  let j = end;
  if (s[j] === "*") j++;
  if (name === "def") { const b = s.indexOf("{", j); if (b < 0) return -1; const e = matchBrace(s, b, to); return e < 0 ? -1 : e; }
  if (name === "let" || name === "newline") return eol(s, j);
  j = skipArgs(s, j, to);
  let q = j;
  while (q < to && (s[q] === " " || s[q] === "\t")) q++;
  if (q >= to || s[q] === "\n" || s[q] === "\r" || s[q] === "%") return j;
  return -1;
}

function isBoundary(s, k, to, ctx) {
  if (s[k] === "$" && s[k + 1] === "$") return true;
  if (s[k] !== "\\") return false;
  const { name } = readCmd(s, k);
  if (name === "begin") { const b = readBegin(s, k); return !!b && b.name !== "math"; }
  if (name === "end" || name === "[" || name === "item") return true;
  if (name in SECTION) return true;
  if ((BLOCK_CMDS.has(name) && name !== "noindent" && name !== "newline" && name !== "vspace" && name !== "centering") || META.has(name)) return standalone(s, k, to) > 0;
  if (name === "iffalse") return true;
  return false;
}

/** End of the paragraph starting at i. */
function paragraphEnd(s, i, to, ctx) {
  let depth = 0, firstBlank = -1;
  for (let j = i; j < to; j++) {
    const c = s[j];
    if (c === "\\") {
      if (s.startsWith("\\verb", j) && !isLetter(s[j + 5] || "")) {
        let q = j + 5; if (s[q] === "*") q++;
        const e = s.indexOf(s[q], q + 1);
        if (e > 0 && e < eol(s, q)) { j = e; continue; }
      }
      j++;
      continue;
    }
    if (c === "%") { j = eol(s, j) - 1; continue; }
    if (c === "{") depth++;
    else if (c === "}") { if (depth > 0) depth--; }
    else if (c === "\n") {
      let k = j + 1;
      while (k < to && (s[k] === " " || s[k] === "\t" || s[k] === "\r")) k++;
      if (k >= to) return trimEnd(s, i, j);
      if (s[k] === "\n") {
        if (depth === 0) return trimEnd(s, i, j);
        if (firstBlank < 0) firstBlank = j;
        if (j - i > 20000) return trimEnd(s, i, firstBlank);
        continue;
      }
      if (depth === 0 && isBoundary(s, k, to, ctx)) return trimEnd(s, i, j);
    }
  }
  if (depth > 0 && firstBlank >= 0) return trimEnd(s, i, firstBlank);
  return trimEnd(s, i, to);
}

function headingLevel(cmd, ctx) {
  const n = SECTION[cmd];
  return Math.max(1, Math.min(6, ctx.hasChapter ? n || 1 : n - 1 || 1));
}

function blockAt(s, i, to, ctx) {
  const c = s[i];
  if (c === "%") {
    let end = eol(s, i);
    for (;;) {
      let k = end + 1;
      while (k < to && (s[k] === " " || s[k] === "\t")) k++;
      if (k < to && s[k] === "%") end = eol(s, k); else break;
    }
    end = Math.min(end, to);
    return { node: rawBlock(s.slice(i, trimEnd(s, i, end)), "comment"), end: trimEnd(s, i, end) };
  }
  if (c === "$" && s[i + 1] === "$") {
    const e = s.indexOf("$$", i + 2);
    if (e < 0 || e + 2 > to) return null;
    return { node: S.math_display.create({ tex: s.slice(i + 2, e), open: "$$", close: "$$", env: "$$" }), end: e + 2 };
  }
  if (c === "\\") {
    const { name, end } = readCmd(s, i);
    if (name === "[") {
      const e = s.indexOf("\\]", end);
      if (e < 0 || e + 2 > to) return null;
      return { node: S.math_display.create({ tex: s.slice(end, e), open: "\\[", close: "\\]", env: "\\[" }), end: e + 2 };
    }
    if (name === "begin") return envBlock(s, i, to, ctx);
    if (name === "iffalse") {
      const k = s.indexOf("\\fi", end);
      if (k < 0 || k + 3 > to) return null;
      return { node: rawBlock(s.slice(i, k + 3), "comment"), end: k + 3 };
    }
    if (name in SECTION) return heading(s, i, end, to, name, ctx);
    if (META.has(name)) {
      const r = meta(s, i, end, to, name);
      if (r) return r;
    }
    if (BLOCK_CMDS.has(name)) {
      const e = standalone(s, i, to);
      if (e > 0 && name !== "noindent" && name !== "centering" && (name !== "vspace" || true)) {
        if (name !== "noindent" && name !== "newline") return { node: S.tex_cmd.create({ src: s.slice(i, e) }), end: e };
      }
    }
  }
  return paragraph(s, i, to, ctx);
}

function paragraph(s, i, to, ctx) {
  const end = paragraphEnd(s, i, to, ctx);
  if (end <= i) return null;
  const kids = parseInlineTex(s, i, end);
  return { node: S.paragraph.create(null, kids), end };
}

function heading(s, i, j, to, cmd, ctx) {
  let star = false, opt = null;
  if (s[j] === "*") { star = true; j++; }
  if (s[j] === "[") { const e = matchBracket(s, j, to); if (e < 0) return null; opt = s.slice(j, e); j = e; }
  if (s[j] !== "{") return null;
  const e = matchBrace(s, j, to);
  if (e < 0) return null;
  const kids = parseInlineTex(s, j + 1, e - 1);
  let end = e, label = null, labelSep = "";
  const m = /^[ \t]*\n?[ \t]*\\label\{/.exec(s.slice(e, e + 200));
  if (m) {
    const le = matchBrace(s, e + m[0].length - 1, to);
    if (le > 0) {
      const lab = s.slice(e + m[0].length, le - 1);
      if (!/[{}\\%]/.test(lab)) { label = lab; labelSep = m[0].slice(0, -"\\label{".length); end = le; }
    }
  }
  return { node: S.heading.create({ level: headingLevel(cmd, ctx), cmd, star, opt, label, labelSep }, kids), end };
}

function meta(s, i, j, to, cmd) {
  let q = j;
  if (s[q] === "*") q++;
  while (s[q] === "[") { const e = matchBracket(s, q, to); if (e < 0) return null; q = e; }
  if (s[q] !== "{") return null;
  const e = matchBrace(s, q, to);
  if (e < 0) return null;
  const inner = s.slice(q + 1, e - 1);
  // key=value affiliations and the like read better as a source chip
  if (/=/.test(inner) && /\{/.test(inner)) return { node: S.tex_cmd.create({ src: s.slice(i, e) }), end: e };
  try {
    const kids = parseInlineTex(s, q + 1, e - 1);
    return { node: S.meta.create({ cmd, open: s.slice(i, q + 1), close: "}" }, kids), end: e };
  } catch {
    return { node: S.tex_cmd.create({ src: s.slice(i, e) }), end: e };
  }
}

function envBlock(s, i, to, ctx) {
  const bg = readBegin(s, i);
  if (!bg || bg.kind !== "begin") return null;
  const name = bg.name;
  const f = findEnd(s, bg.end, name, to);
  if (!f) return null;
  const { endStart, end } = f;
  const src = s.slice(i, end);
  try {
    if (MATH_ENVS.has(name) && name !== "subequations") {
      let k = bg.end;
      if (name.startsWith("alignat") && s[k] === "{") k = matchBrace(s, k, to);
      return { node: S.math_display.create({ env: name, open: s.slice(i, k), close: s.slice(endStart, end), tex: s.slice(k, endStart) }), end };
    }
    if (LIST_ENVS.has(name)) return { node: listEnv(s, i, bg, endStart, end, name, ctx), end };
    if (CODE_ENVS.has(name)) return { node: codeEnv(s, i, bg, endStart, end, name), end };
    if (name === "comment") return { node: rawBlock(src, "comment"), end };
    if (FLOAT_ENVS.has(name) || TABULAR_ENVS.has(name) || ((name === "center" || name === "adjustbox") && /\\begin\{tabular|\\includegraphics/.test(s.slice(bg.end, endStart)))) {
      const node = floatEnv(s, i, bg, endStart, end, name, ctx);
      if (node) return { node, end };
      return { node: rawBlock(src, "env"), end };
    }
    if (QUOTE_ENVS.has(name) || CONTAINER_ENVS.has(name) || ctx.theorems.has(name) || ctx.theorems.has(name.replace(/\*$/, ""))) {
      let k = bg.end;
      if (s[k] === "[") { const e = matchBracket(s, k, endStart); if (e > 0) k = e; }
      if (name === "multicols" && s[k] === "{") k = matchBrace(s, k, endStart);
      const { recs } = parseBody(s, k, endStart, ctx);
      const kids = recs.map((r) => r.node);
      const attrs = { open: s.slice(i, k), close: s.slice(endStart, end) };
      const content = kids.length ? kids : [S.paragraph.create()];
      if (QUOTE_ENVS.has(name)) return { node: S.blockquote.create(attrs, content), end };
      return { node: S.tex_env.create({ ...attrs, env: name }, content), end };
    }
  } catch (e) {
    if (!(e instanceof TexError)) console.warn("[wysiwyg] tex env", name, e);
  }
  return { node: rawBlock(src, "env"), end };
}

function codeEnv(s, i, bg, endStart, end, name) {
  let k = bg.end;
  let lang = "";
  if (s[k] === "[") {
    const e = matchBracket(s, k, endStart);
    if (e > 0) { const m = /language\s*=\s*\{?([\w+#-]+)/i.exec(s.slice(k, e)); if (m) lang = m[1].toLowerCase(); k = e; }
  }
  if (name === "minted" && s[k] === "{") { const e = matchBrace(s, k, endStart); if (e > 0) { lang = s.slice(k + 1, e - 1); k = e; } }
  let q = k;
  while (q < endStart && (s[q] === " " || s[q] === "\t")) q++;
  if (s[q] === "\n") k = q + 1;
  let c = endStart;
  while (c > k && (s[c - 1] === " " || s[c - 1] === "\t")) c--;
  if (c > k && s[c - 1] === "\n") c--; else c = endStart;
  const body = s.slice(k, c);
  return S.code_block.create({ lang, open: s.slice(i, k), close: s.slice(c, end) }, body ? schema.text(body) : null);
}

/** Positions of the top-level \item commands in s[a..b). */
function itemPositions(s, a, b) {
  const pos = [];
  for (let k = a; k < b; k++) {
    const c = s[k];
    if (c === "%") { k = eol(s, k); continue; }
    if (c === "{") { const e = matchBrace(s, k, b); if (e < 0) throw new TexError("unbalanced"); k = e - 1; continue; }
    if (c !== "\\") continue;
    if (s.startsWith("\\item", k) && !isLetter(s[k + 5] || "")) { pos.push(k); k += 4; continue; }
    if (s.startsWith("\\begin", k)) {
      const bg = readBegin(s, k);
      if (bg) { const f = findEnd(s, bg.end, bg.name, b); if (!f) throw new TexError("unclosed"); k = f.end - 1; continue; }
    }
    if (s.startsWith("\\verb", k)) { const { end } = readCmd(s, k); const d = s[end]; const e = d ? s.indexOf(d, end + 1) : -1; if (e > 0) { k = e; continue; } }
    k++;
  }
  return pos;
}

function listEnv(s, i, bg, endStart, end, name, ctx) {
  let k = bg.end;
  if (s[k] === "[") { const e = matchBracket(s, k, endStart); if (e > 0) k = e; }
  const items = itemPositions(s, k, endStart);
  if (!items.length) throw new TexError("list without items");
  const pre = s.slice(k, items[0]).trim();
  if (pre && !/^(%[^\n]*\n?\s*)+$/.test(pre + "\n")) throw new TexError("text before first item");
  const nodes = items.map((p, n) => {
    const stop = n + 1 < items.length ? items[n + 1] : endStart;
    let j = p + 5, label = null;
    let q = j;
    while (q < stop && (s[q] === " " || s[q] === "\t")) q++;
    if (s[q] === "[") { const e = matchBracket(s, q, stop); if (e > 0) { label = s.slice(q + 1, e - 1); j = e; } }
    const { recs } = parseBody(s, j, stop, ctx);
    const kids = recs.map((r) => r.node);
    return S.list_item.create({ label }, kids.length ? kids : [S.paragraph.create()]);
  });
  const attrs = { open: s.slice(i, k), close: s.slice(endStart, end), env: name, pre };
  return name === "enumerate" || name === "compactenum" || name === "inparaenum" || name === "asparaenum" ? S.ordered_list.create(attrs, nodes) : S.bullet_list.create(attrs, nodes);
}

// ---------- tables ----------
const RULE_RE = /^(?:\s+|%[^\n]*(?:\n|$)|\\(?:hline|toprule|midrule|bottomrule|morecmidrules|endhead|endfirsthead|endfoot|endlastfoot)(?![a-zA-Z])|\\(?:cline|cmidrule|addlinespace|specialrule|hhline|rowcolor|cdashline|arrayrulecolor)(?![a-zA-Z])(?:\([^)]*\))?(?:\s*\[[^\]]*\])?(?:\s*\{[^{}]*\})*(?:\([^)]*\))?)/;

/** Column spec "@{}l|c|p{3cm}" → { items: [{s, c}], end } */
export function parseSpec(spec) {
  // expand *{n}{...}
  for (let guard = 0; /\*\s*\{/.test(spec) && guard < 10; guard++) {
    const k = spec.search(/\*\s*\{/);
    const b1 = spec.indexOf("{", k), e1 = matchBrace(spec, b1);
    if (e1 < 0 || spec[e1] !== "{") throw new TexError("bad spec");
    const e2 = matchBrace(spec, e1);
    if (e2 < 0) throw new TexError("bad spec");
    const n = parseInt(spec.slice(b1 + 1, e1 - 1), 10);
    if (!(n >= 0 && n < 100)) throw new TexError("bad spec");
    spec = spec.slice(0, k) + spec.slice(e1 + 1, e2 - 1).repeat(n) + spec.slice(e2);
  }
  const items = [];
  let sep = "", pre = "";
  for (let k = 0; k < spec.length;) {
    const ch = spec[k];
    if (isWs(ch) || ch === "|" || ch === ":" || ch === ";") { sep += ch; k++; continue; }
    if (ch === "@" || ch === "!") {
      if (spec[k + 1] !== "{") throw new TexError("bad spec");
      const e = matchBrace(spec, k + 1);
      if (e < 0) throw new TexError("bad spec");
      sep += spec.slice(k, e); k = e; continue;
    }
    if (ch === ">") {
      const e = matchBrace(spec, k + 1);
      if (e < 0) throw new TexError("bad spec");
      pre += spec.slice(k, e); k = e; continue;
    }
    if (ch === "<") {
      const e = matchBrace(spec, k + 1);
      if (e < 0 || !items.length) throw new TexError("bad spec");
      items[items.length - 1].c += spec.slice(k, e); k = e; continue;
    }
    if (isLetter(ch)) {
      let e = k + 1;
      if (spec[e] === "[") { const q = matchBracket(spec, e); if (q > 0) e = q; }
      while (spec[e] === "{") { const q = matchBrace(spec, e); if (q < 0) throw new TexError("bad spec"); e = q; }
      items.push({ s: sep, c: pre + spec.slice(k, e) });
      sep = ""; pre = ""; k = e; continue;
    }
    throw new TexError("bad spec char " + ch);
  }
  return { items, end: sep };
}
export const specString = (sp) => sp.items.map((it) => it.s + it.c).join("") + sp.end;
const ALIGN_OF = { l: "left", c: "center", r: "right" };
export const colAlign = (c) => ALIGN_OF[c.replace(/^>\{[^{}]*\}/, "")] || null;

/** Split s[a..b) at top-level separators (& within a row, \\ between rows). */
function splitTop(s, a, b, kind) {
  const parts = [];
  let start = a;
  for (let k = a; k < b; k++) {
    const c = s[k];
    if (c === "%") { k = eol(s, k); continue; }
    if (c === "{") { const e = matchBrace(s, k, b); if (e < 0) throw new TexError("unbalanced"); k = e - 1; continue; }
    if (c === "$") { // math may contain & or \\ (e.g. in an array)
      let e = k + 1;
      for (; e < b; e++) { if (s[e] === "\\") { e++; continue; } if (s[e] === "$") break; }
      k = e;
      continue;
    }
    if (c === "\\") {
      if (kind === "row" && (s[k + 1] === "\\" || s.startsWith("\\tabularnewline", k))) {
        let e = s[k + 1] === "\\" ? k + 2 : k + 15;
        if (s[e] === "*") e++;
        let q = e;
        while (q < b && (s[q] === " " || s[q] === "\t")) q++;
        if (s[q] === "[") { const m = matchBracket(s, q, b); if (m > 0) e = m; }
        parts.push({ a: start, b: k, sep: s.slice(k, e) });
        start = e;
        k = e - 1;
        continue;
      }
      if (s.startsWith("\\begin", k)) {
        const bg = readBegin(s, k);
        if (bg) { const f = findEnd(s, bg.end, bg.name, b); if (!f) throw new TexError("unclosed"); k = f.end - 1; continue; }
      }
      k++;
      continue;
    }
    if (kind === "cell" && c === "&") { parts.push({ a: start, b: k, sep: "&" }); start = k + 1; }
  }
  parts.push({ a: start, b, sep: null });
  return parts;
}

function tabular(s, i, ctx) {
  const bg = readBegin(s, i);
  if (!bg || !TABULAR_ENVS.has(bg.name)) throw new TexError("not a tabular");
  const name = bg.name;
  const f = findEnd(s, bg.end, name, s.length);
  if (!f) throw new TexError("unclosed tabular");
  let k = bg.end;
  if (name !== "tabular") { if (s[k] !== "{") throw new TexError("width"); k = matchBrace(s, k); }
  if (s[k] === "[") k = matchBracket(s, k);
  if (k < 0 || s[k] !== "{") throw new TexError("no spec");
  const specEnd = matchBrace(s, k);
  if (specEnd < 0) throw new TexError("bad spec");
  const specSrc = s.slice(k + 1, specEnd - 1);
  const sp = parseSpec(specSrc);
  sp.pre = s.slice(i, k + 1);
  sp.orig = specSrc;
  const ncols = sp.items.length;
  if (!ncols) throw new TexError("no columns");
  const body = s.slice(specEnd, f.endStart);
  if (/\\(multicolumn|multirow|cellcolor|diagbox|makecell|hline\s*\\hline|cline|parbox|shortstack|vline)/.test(body)) throw new TexError("complex table");
  const chunks = splitTop(s, specEnd, f.endStart, "row");
  const rows = [];
  let post = "";
  chunks.forEach((ch, n) => {
    // leading rules / comments
    let q = ch.a;
    for (;;) {
      const m = RULE_RE.exec(s.slice(q, ch.b));
      if (!m || !m[0]) break;
      q += m[0].length;
    }
    const pre = s.slice(ch.a, q).trim();
    const isLast = n === chunks.length - 1;
    if (isLast && !s.slice(q, ch.b).trim()) { post = pre; return; }
    const cells = splitTop(s, q, ch.b, "cell");
    if (cells.length > ncols) throw new TexError("too many cells");
    const nodes = [];
    for (let c = 0; c < ncols; c++) {
      const cell = cells[c];
      let kids = [];
      if (cell) {
        let a = cell.a, b = cell.b;
        while (a < b && isWs(s[a])) a++;
        b = trimEnd(s, a, b);
        kids = parseInlineTex(s, a, b);
      }
      nodes.push({ kids, align: colAlign(sp.items[c].c) });
    }
    rows.push({ pre, end: ch.sep || "", n: cells.length, cells: nodes });
  });
  if (!rows.length) throw new TexError("empty table");
  const header = rows.length >= 2 && /\\(midrule|hline)/.test(rows[1].pre);
  const pmRows = rows.map((r, n) => S.table_row.create({ pre: r.pre, end: r.end, n: r.n },
    r.cells.map((c) => (header && n === 0 ? S.table_header : S.table_cell).create({ align: c.align }, c.kids))));
  const node = S.table.create({
    open: s.slice(i, specEnd), close: s.slice(f.endStart, f.end), post, spec: { pre: sp.pre, items: sp.items, end: sp.end, orig: sp.orig },
    booktabs: /\\(toprule|midrule|bottomrule)/.test(body),
  }, pmRows);
  return { node, end: f.end };
}

const FLOAT_HIDDEN = new Set(["centering", "small", "footnotesize", "scriptsize", "tiny", "normalsize", "large", "Large", "raggedright", "raggedleft",
  "hfill", "vfill", "hspace", "vspace", "setlength", "renewcommand", "captionsetup", "par", "medskip", "smallskip", "bigskip", "noindent",
  "FloatBarrier", "rowcolors", "sffamily", "rmfamily", "quad", "qquad", "linewidth", "arraystretch", "tabcolsep", "def", "newline", "vskip", "hskip",
  "smallbreak", "medbreak", "bigbreak", "relax", "protect", "belowcaptionskip", "abovecaptionskip"]);

/** figure/table environment → float node, or null if it's not simple enough. */
function floatEnv(s, i, bg, endStart, end, name, ctx) {
  const parts = [];
  const kids = [];
  let label = null;
  let lit = "";
  const slot = (node) => { parts.push(lit); lit = ""; parts.push({ slot: node.type.name }); kids.push(node); };
  if (TABULAR_ENVS.has(name)) {
    const t = tabular(s, i, ctx);
    return S.float.create({ env: name, parts: ["", { slot: "table" }, ""], label: null }, [t.node]);
  }
  let k = bg.end;
  if (s[k] === "[") { const e = matchBracket(s, k, endStart); if (e > 0) k = e; }
  if ((name === "wrapfigure" || name === "wraptable") && s[k] === "{") { k = matchBrace(s, k, endStart); if (s[k] === "{") k = matchBrace(s, k, endStart); }
  if (name === "adjustbox" && s[k] === "{") k = matchBrace(s, k, endStart);
  if (k < 0) return null;
  lit = s.slice(i, k);
  const walk = (a, b) => {
    let q = a;
    while (q < b) {
      const c = s[q];
      if (isWs(c)) { lit += c; q++; continue; }
      if (c === "%") { const e = Math.min(eol(s, q), b); lit += s.slice(q, e); q = e; continue; }
      if (c === "\\") {
        const { name: cmd, end: ce } = readCmd(s, q);
        if (cmd === "caption") {
          let j = ce;
          if (s[j] === "*") j++;
          if (s[j] === "[") { const e = matchBracket(s, j, b); if (e < 0) return false; j = e; }
          if (s[j] !== "{") return false;
          const e = matchBrace(s, j, b);
          if (e < 0) return false;
          slot(S.caption.create({ open: s.slice(q, j + 1), close: "}" }, parseInlineTex(s, j + 1, e - 1)));
          q = e;
          continue;
        }
        if (cmd === "label" && label === null && s[ce] === "{") {
          const e = matchBrace(s, ce, b);
          const lab = e > 0 ? s.slice(ce + 1, e - 1) : "";
          if (e > 0 && !/[{}\\%]/.test(lab)) {
            label = lab;
            parts.push(lit); lit = ""; parts.push({ label: true });
            q = e;
            continue;
          }
        }
        if (cmd === "includegraphics") {
          let j = ce;
          if (s[j] === "*") j++;
          let opts = "";
          if (s[j] === "[") { const e = matchBracket(s, j, b); if (e < 0) return false; opts = s.slice(j, e); j = e; }
          if (s[j] !== "{") return false;
          const e = matchBrace(s, j, b);
          if (e < 0) return false;
          slot(S.figure_image.create({ cmd: s.slice(q, ce) + (s[ce] === "*" ? "*" : ""), opts, path: s.slice(j + 1, e - 1).trim() }));
          q = e;
          continue;
        }
        if (cmd === "begin") {
          const b2 = readBegin(s, q);
          const f = b2 && findEnd(s, b2.end, b2.name, b);
          if (!f) return false;
          if (TABULAR_ENVS.has(b2.name)) {
            let t = null;
            try { t = tabular(s, q, ctx); } catch (e) { if (!(e instanceof TexError)) throw e; }
            slot(t ? t.node : rawBlock(s.slice(q, f.end), "env"));
            q = f.end;
            continue;
          }
          if (b2.name === "center" || b2.name === "adjustbox" || b2.name === "small" || b2.name === "footnotesize") {
            let j = b2.end;
            if (b2.name === "adjustbox" && s[j] === "{") j = matchBrace(s, j, b);
            lit += s.slice(q, j);
            if (walk(j, f.endStart) === false) return false;
            lit += s.slice(f.endStart, f.end);
            q = f.end;
            continue;
          }
          slot(rawBlock(s.slice(q, f.end), "env"));
          q = f.end;
          continue;
        }
        if (cmd === "resizebox" || cmd === "scalebox" || cmd === "adjustbox" || cmd === "makebox") {
          // the box's last argument holds the content
          let j = ce;
          if (s[j] === "*") j++;
          let lastOpen = -1, lastEnd = -1;
          for (let n = 0; n < 4 && (s[j] === "{" || s[j] === "["); n++) {
            const e = s[j] === "{" ? matchBrace(s, j, b) : matchBracket(s, j, b);
            if (e < 0) return false;
            if (s[j] === "{") { lastOpen = j; lastEnd = e; }
            j = e;
          }
          if (lastOpen < 0) return false;
          lit += s.slice(q, lastOpen + 1);
          if (walk(lastOpen + 1, lastEnd - 1) === false) return false;
          lit += "}";
          q = lastEnd;
          continue;
        }
        if (FLOAT_HIDDEN.has(cmd)) {
          let j = ce;
          if (s[j] === "*") j++;
          if (cmd === "renewcommand" || cmd === "def") j = skipArgs(s, j, b, 3);
          else if (cmd === "setlength") { j = skipArgs(s, j, b, 2); }
          else j = skipArgs(s, j, b, 2);
          lit += s.slice(q, j);
          q = j;
          continue;
        }
        // anything else in the float: a visible raw part
        let j = ce;
        if (s[j] === "*") j++;
        j = skipArgs(s, j, b);
        slot(rawBlock(s.slice(q, j), "raw"));
        q = j;
        continue;
      }
      // stray text: keep it visible, up to the end of the line
      let e = Math.min(eol(s, q), b);
      const bs = s.slice(q, e).search(/\\(caption|label|includegraphics|begin)\b/);
      if (bs > 0) e = q + bs;
      while (e > q && isWs(s[e - 1])) e--;
      slot(rawBlock(s.slice(q, e), "raw"));
      q = e;
    }
    return true;
  };
  if (walk(k, endStart) === false) return null;
  lit += s.slice(endStart, end);
  parts.push(lit);
  if (!kids.some((n) => n.type !== S.raw_block)) return null;
  return S.float.create({ env: name, parts, label }, kids);
}

// ---------------- document ----------------
function findOutsideComment(s, needle, from = 0, last = false) {
  let k = last ? s.lastIndexOf(needle) : s.indexOf(needle, from);
  while (k >= 0) {
    const ls = s.lastIndexOf("\n", k - 1) + 1;
    const line = s.slice(ls, k);
    let commented = false;
    for (let q = 0; q < line.length; q++) { if (line[q] === "\\") { q++; continue; } if (line[q] === "%") { commented = true; break; } }
    if (!commented && (!last || k >= from)) return k;
    k = last ? s.lastIndexOf(needle, k - 1) : s.indexOf(needle, k + 1);
    if (last && k < from) return -1;
  }
  return -1;
}

/** \title{...} etc. from the preamble, for the \maketitle card. */
export function texMeta(pre) {
  const out = {};
  for (const key of ["title", "author", "date"]) {
    const re = new RegExp(`\\\\${key}\\s*(\\[[^\\]]*\\])?\\s*\\{`, "g");
    let m;
    while ((m = re.exec(pre))) {
      const ls = pre.lastIndexOf("\n", m.index) + 1;
      if (/(^|[^\\])%/.test(pre.slice(ls, m.index))) continue;
      const b = m.index + m[0].length - 1;
      const e = matchBrace(pre, b);
      if (e > 0) out[key] = (out[key] ? out[key] + " · " : "") + pre.slice(b + 1, e - 1);
    }
  }
  return out;
}

/** Brace groups right after position i (skipping [..] options): their contents. */
function groupsAfter(s, i, n) {
  const out = [];
  let j = i;
  while (out.length < n && j < s.length) {
    while (j < s.length && isWs(s[j])) j++;
    if (s[j] === "[") { const e = matchBracket(s, j); if (e < 0) break; out.push({ opt: s.slice(j + 1, e - 1) }); j = e; continue; }
    if (s[j] !== "{") break;
    const e = matchBrace(s, j);
    if (e < 0) break;
    out.push(s.slice(j + 1, e - 1));
    j = e;
  }
  return out;
}

export function makeCtx(pre, all) {
  pre = pre || "";
  const noComments = pre.replace(/(^|[^\\])%.*$/gm, "$1");
  // \newtheorem{name}[counter]{Title}[within], elsarticle \newproof / \newdefinition, \declaretheorem
  const theorems = new Map();
  for (const m of noComments.matchAll(/\\(newtheorem|newproof|newdefinition|spnewtheorem|declaretheorem)(\*?)/g)) {
    const g = groupsAfter(noComments, m.index + m[0].length, 4);
    const names = g.filter((x) => typeof x === "string");
    const opts = g.filter((x) => typeof x !== "string");
    const name = names[0] && names[0].trim();
    if (!name) continue;
    let title = names[1] || name.replace(/^./, (c) => c.toUpperCase());
    if (m[1] === "declaretheorem") { const t = /title\s*=\s*\{?([^,}]+)/.exec(opts[0]?.opt || ""); title = t ? t[1] : name.replace(/^./, (c) => c.toUpperCase()); }
    const sharedWith = g[1] && typeof g[1] !== "string" ? g[1].opt.trim() : null;
    theorems.set(name, { title: title.trim(), counter: sharedWith || name, numbered: !m[2] && m[1] !== "newproof" });
  }
  // math macros for KaTeX: \newcommand{\R}{\mathbb{R}}, \def\x{..}, \DeclareMathOperator{\op}{op}
  const macros = {};
  for (const m of noComments.matchAll(/\\(?:re)?newcommand\*?\s*\{?\s*(\\[a-zA-Z@]+)\s*\}?\s*(?:\[(\d)\])?\s*(?:\[[^\]]*\])?\s*\{/g)) {
    const b = m.index + m[0].length - 1, e = matchBrace(noComments, b);
    if (e > 0) macros[m[1]] = noComments.slice(b + 1, e - 1);
  }
  for (const m of noComments.matchAll(/\\def\s*(\\[a-zA-Z@]+)\s*\{/g)) {
    const b = m.index + m[0].length - 1, e = matchBrace(noComments, b);
    if (e > 0) macros[m[1]] = noComments.slice(b + 1, e - 1);
  }
  for (const m of noComments.matchAll(/\\DeclareMathOperator(\*?)\s*\{\s*(\\[a-zA-Z]+)\s*\}\s*\{/g)) {
    const b = m.index + m[0].length - 1, e = matchBrace(noComments, b);
    if (e > 0) macros[m[2]] = `\\operatorname${m[1]}{${noComments.slice(b + 1, e - 1)}}`;
  }
  const gp = /\\graphicspath\s*\{((?:\s*\{[^{}]*\})+)\s*\}/.exec(noComments);
  const graphicsPaths = gp ? [...gp[1].matchAll(/\{([^{}]*)\}/g)].map((x) => x[1]) : [];
  const hasChapter = /\\documentclass(\[[^\]]*\])?\{(book|report|memoir|scrbook|scrreprt|thesis)/.test(pre) || /^\s*\\chapter\*?\{/m.test(all || "");
  const cls = (/\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/.exec(noComments) || [])[1] || "";
  const packages = [...noComments.matchAll(/\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g)].flatMap((x) => x[1].split(",").map((p) => p.trim()));
  return { theorems, macros, graphicsPaths, hasChapter, cls, packages };
}

export function parseLatex(input) {
  const crlf = /\r\n/.test(input) && !/(^|[^\r])\n/.test(input);
  const text = crlf ? input.replace(/\r\n/g, "\n") : input;
  const b = findOutsideComment(text, "\\begin{document}");
  let rt, kids;
  if (b >= 0) {
    const head = text.slice(0, b);
    const hs = head.replace(/\s+$/, "");
    const bodyStart = b + "\\begin{document}".length;
    let e = findOutsideComment(text, "\\end{document}", bodyStart, true);
    if (e < 0) e = text.length;
    const ctx = makeCtx(hs, text);
    const { recs, tail } = parseBody(text, bodyStart, e, ctx);
    rt = { kind: "tex", hasDoc: true, preamble: hs, headWs: head.slice(hs.length), recs, bodyTail: tail, tail: text.slice(e), crlf, ctx, meta: texMeta(hs) };
    kids = [S.raw_block.create({ kind: "preamble", lang: "latex" }, hs ? schema.text(hs) : null), ...recs.map((r) => r.node)];
  } else {
    const ctx = makeCtx("", text);
    const { recs, tail } = parseBody(text, 0, text.length, ctx);
    rt = { kind: "tex", hasDoc: false, recs, bodyTail: tail, tail: "", crlf, ctx, meta: {} };
    kids = recs.map((r) => r.node);
  }
  if (!kids.length) kids = [S.paragraph.create()];
  return { doc: S.doc.create(null, kids), rt };
}

export function parseLatexFragment(text, ctx = makeCtx("", text)) {
  return parseBody(text, 0, text.length, ctx).recs.map((r) => r.node);
}

// ---------------- serialize ----------------
export function escTex(s) {
  return s.replace(/[\\{}%&#$_~^\u00a0]/g, (c) => {
    switch (c) {
      case "\\": return "\\textbackslash{}";
      case "~": return "\\textasciitilde{}";
      case "^": return "\\textasciicircum{}";
      case "\u00a0": return "~";
      default: return "\\" + c;
    }
  });
}
const DEFAULT_OPEN = { strong: "\\textbf{", em: "\\emph{", underline: "\\underline{", strike: "\\sout{", smallcaps: "\\textsc{", code: "\\texttt{", sup: "\\textsuperscript{", sub: "\\textsubscript{" };
function texMarkOpen(m) {
  if (m.type === M.link) return m.attrs.kind === "url" ? "\\url{" : `\\href{${m.attrs.href.replace(/([%#])/g, (c, x, k, str) => (str[k - 1] === "\\" ? c : "\\" + c))}}{`;
  return m.attrs.open || DEFAULT_OPEN[m.type.name] || "{";
}

/** Inline content of a textblock as LaTeX. */
export function inlineTex(parent) {
  let out = "";
  const active = [];
  const kids = [];
  parent.forEach((c) => kids.push(c));
  kids.forEach((child, idx) => {
    const ms = child.marks;
    const keep = keptMarks(active, ms);
    while (active.length > keep) { active.pop(); out += "}"; }
    for (const m of marksToOpen(active, ms, kids, idx)) { out += texMarkOpen(m); active.push(m); }
    if (child.isText) {
      const url = ms.some((m) => m.type === M.link && m.attrs.kind === "url");
      out += url ? child.text : escTex(child.text);
      return;
    }
    const a = child.attrs;
    switch (child.type.name) {
      case "hard_break": out += a.src && a.src.startsWith("\\") ? a.src : "\\\\"; break;
      case "math_inline": out += a.open === "$" || a.open === "$$" || a.open.startsWith("\\") ? a.open + a.tex + a.close : "$" + a.tex + "$"; break;
      case "cite": out += a.src.startsWith("\\") ? a.src : `\\cite{${a.src.replace(/[[\]@\s]/g, "").replace(/;/g, ",")}}`; break;
      case "ref": case "sym": out += a.src; break;
      case "raw_inline": out += a.src; break;
      case "footnote": out += a.open + a.body + "}"; break;
      case "footnote_ref": out += "\\footnote{}"; break;
      case "image": out += a.tex || `\\includegraphics{${a.src}}`; break;
      default: out += escTex(child.textContent);
    }
  });
  while (active.length) { active.pop(); out += "}"; }
  return out;
}

export const LEVEL_CMDS = ["", "section", "subsection", "subsubsection", "paragraph", "subparagraph", "subparagraph"];
export const LEVEL_CMDS_CH = ["", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"];

function childrenTex(node, ctx) {
  let out = "", prev = null;
  node.forEach((c) => {
    const t = blockTex(c, ctx);
    if (t == null) return;
    if (prev) out += prev.type === S.paragraph && c.type === S.paragraph ? "\n\n" : "\n";
    out += t;
    prev = c;
  });
  return out;
}

function tableTex(node) {
  const a = node.attrs;
  let ncols = 0;
  node.forEach((r) => { ncols = Math.max(ncols, r.childCount); });
  const aligns = [];
  for (let c = 0; c < ncols; c++) aligns.push(node.firstChild.childCount > c ? node.firstChild.child(c).attrs.align : null);
  // column spec: keep it unless columns were added/removed or an l/c/r column changed alignment
  let sp = a.spec ? { ...a.spec, items: a.spec.items.map((x) => ({ ...x })) } : null;
  if (!sp) sp = { pre: "\\begin{tabular}{", items: [], end: "", orig: null };
  const bar = sp.items.length > 1 && sp.items.slice(1).every((x) => /\|/.test(x.s));
  while (sp.items.length < ncols) sp.items.push({ s: bar ? "|" : "", c: "l" });
  if (sp.items.length > ncols) sp.items.length = ncols;
  sp.items.forEach((it, c) => {
    const m = /^(>\{[^{}]*\})?([lcr])$/.exec(it.c);
    const want = aligns[c] === "center" ? "c" : aligns[c] === "right" ? "r" : aligns[c] === "left" ? "l" : null;
    if (m && want && m[2] !== want) it.c = (m[1] || "") + want;
  });
  const spec = specString(sp);
  const open = a.open && spec === sp.orig ? a.open : sp.pre + spec + "}";
  const close = a.close || "\\end{tabular}";
  const rows = [];
  node.forEach((row, _, r) => {
    const cells = [];
    row.forEach((cell) => cells.push(inlineTex(cell)));
    let n = cells.length;
    const keepN = row.attrs.n != null ? row.attrs.n : n;
    while (n > keepN && n > 1 && !cells[n - 1]) n--;
    let end = row.attrs.end;
    if (end == null || (end === "" && r < node.childCount - 1)) end = "\\\\";
    const pre = row.attrs.pre ? row.attrs.pre + "\n  " : "";
    rows.push("  " + pre + cells.slice(0, n).join(" & ") + (end ? " " + end : ""));
  });
  return open + "\n" + rows.join("\n") + (a.post ? "\n  " + a.post : "") + "\n" + close;
}

function floatTex(node, ctx) {
  const a = node.attrs;
  const queue = {};
  node.forEach((c) => { (queue[c.type.name] ||= []).push(c); });
  const used = new Set();
  let out = "";
  const parts = a.parts && a.parts.length ? a.parts : [`\\begin{${a.env}}`, "\n"];
  let lastLitIdx = parts.length - 1;
  while (lastLitIdx >= 0 && typeof parts[lastLitIdx] !== "string") lastLitIdx--;
  parts.forEach((p, idx) => {
    if (idx === lastLitIdx) {
      // children with no slot of their own go before the closing text
      node.forEach((c) => { if (!used.has(c)) { const t = blockTex(c, ctx); if (t != null) out += (out.endsWith("\n") ? "  " : "\n  ") + t + "\n"; used.add(c); } });
    }
    if (typeof p === "string") { out += p; return; }
    if (p.label) { if (a.label != null) out += `\\label{${a.label}}`; return; }
    const q = queue[p.slot];
    const c = q && q.shift();
    if (c) { used.add(c); const t = blockTex(c, ctx); if (t != null) out += t; }
  });
  return out;
}

/** A block as LaTeX (null: nothing to write). */
export function blockTex(node, ctx = {}) {
  const a = node.attrs;
  switch (node.type.name) {
    case "paragraph": { const t = inlineTex(node); return t ? t : null; }
    case "heading": {
      const cmd = a.cmd || (ctx.hasChapter ? LEVEL_CMDS_CH : LEVEL_CMDS)[a.level] || "paragraph";
      return `\\${cmd}${a.star ? "*" : ""}${a.opt || ""}{${inlineTex(node)}}` + (a.label != null ? (a.labelSep || "") + `\\label{${a.label}}` : "");
    }
    case "meta": return a.open + inlineTex(node) + a.close;
    case "blockquote": return (a.open || "\\begin{quote}") + "\n" + childrenTex(node, ctx) + "\n" + (a.close || "\\end{quote}");
    case "tex_env": return a.open + "\n" + childrenTex(node, ctx) + "\n" + a.close;
    case "bullet_list": case "ordered_list": {
      const env = node.type === S.ordered_list ? "enumerate" : "itemize";
      let out = a.open || `\\begin{${env}}`;
      if (a.pre) out += "\n" + a.pre;
      node.forEach((item) => {
        const body = childrenTex(item, ctx);
        out += "\n  \\item" + (item.attrs.label != null ? `[${item.attrs.label}]` : "") + (body ? " " + body : "");
      });
      return out + "\n" + (a.close || `\\end{${env}}`);
    }
    case "code_block": {
      if (a.open) return a.open + node.textContent + a.close;
      return "\\begin{verbatim}\n" + node.textContent + "\n\\end{verbatim}";
    }
    case "raw_block": return node.textContent;
    case "math_display": {
      if (a.open && (a.open.startsWith("\\") || a.open === "$$")) return a.open + a.tex + a.close;
      return "\\[\n" + a.tex.trim() + "\n\\]";
    }
    case "tex_cmd": return a.src;
    case "float": return floatTex(node, ctx);
    case "caption": return (a.open || "\\caption{") + inlineTex(node) + (a.close || "}");
    case "figure_image": return (a.cmd || "\\includegraphics") + (a.opts || "") + `{${a.path}}`;
    case "table": return tableTex(node);
    case "horizontal_rule": return "\\noindent\\rule{\\linewidth}{0.4pt}";
    case "footnote_def": return "% footnote " + a.label + ": " + inlineTex(node);
    default: return escTex(node.textContent);
  }
}

export function texFormat(rt) {
  const ctx = rt.ctx;
  return {
    fresh: (node) => blockTex(node, ctx),
    mergeable: (node) => node.type !== S.code_block && node.type !== S.raw_block && node.type !== S.math_display && node.type !== S.tex_cmd,
    verify(text, node) {
      const back = parseLatexFragment(text, ctx);
      return back.length === 1 && blockTex(back[0], ctx) === blockTex(node, ctx);
    },
  };
}

export function serializeLatex(doc, rt) {
  const kids = [];
  doc.forEach((c) => kids.push(c));
  let out;
  const fmt = texFormat(rt);
  if (rt.hasDoc) {
    let pre = rt.preamble;
    if (kids[0] && kids[0].type === S.raw_block && kids[0].attrs.kind === "preamble") pre = kids.shift().textContent;
    const seq = serializeSeq(kids, rt.recs, fmt, "\n\n", "\n");
    const tail = rt.recs.length || !seq || rt.bodyTail.startsWith("\n") ? rt.bodyTail : "\n" + rt.bodyTail;
    out = pre + rt.headWs + "\\begin{document}" + seq + tail + rt.tail;
  } else {
    out = serializeSeq(kids, rt.recs, fmt, "\n\n", "") + rt.bodyTail;
  }
  return rt.crlf ? out.replace(/\n/g, "\r\n") : out;
}
