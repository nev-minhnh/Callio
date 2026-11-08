// LaTeX source -> Markdown. Not a TeX engine: a tolerant structural translator for common
// article/report/beamer-free documents (sections, emphasis, lists, math, floats, tables, cites, refs, footnotes).
import { decodeText, escapeMd, escapeLineStart, renderTable, fence, codeSpan, linkUrl } from "./util.js";

export async function convertLatex(ctx) {
  return new LatexConv(ctx).run(decodeText(ctx.bytes));
}

const VERB_ENVS = new Set(["verbatim", "verbatim*", "Verbatim", "BVerbatim", "lstlisting", "minted", "alltt", "comment", "filecontents", "filecontents*", "code", "sourcecode", "pythoncode"]);
const LIST_ENVS = new Set(["itemize", "enumerate", "description", "compactitem", "compactenum", "compactdesc", "inparaenum", "asparaenum", "asparaitem", "enumerate*", "itemize*", "description*", "tasks", "checklist", "outline"]);
const MATH_ENVS = { equation: "", "equation*": "", displaymath: "", math: "inline", dmath: "", "dmath*": "",
  align: "aligned", "align*": "aligned", flalign: "aligned", "flalign*": "aligned", alignat: "alignedat", "alignat*": "alignedat",
  eqnarray: "aligned", "eqnarray*": "aligned", gather: "gathered", "gather*": "gathered", multline: "gathered", "multline*": "gathered", subequations: "sub" };
const TABULAR = new Set(["tabular", "tabular*", "tabularx", "tabulary", "longtable", "longtable*", "supertabular", "xltabular", "tabu", "longtabu", "array", "NiceTabular", "tblr", "longtblr"]);
const FIG_ENVS = new Set(["figure", "figure*", "wrapfigure", "SCfigure", "subfigure", "minipage-figure", "sidewaysfigure"]);
const TAB_ENVS = new Set(["table", "table*", "wraptable", "sidewaystable", "SCtable"]);
const PICTURE = new Set(["tikzpicture", "pgfpicture", "picture", "forest", "tikzcd", "circuitikz", "axis", "pspicture", "overpic", "asy"]);
const QUOTE = new Set(["quote", "quotation", "verse", "displayquote"]);
const DROP_ENVS = new Set(["comment", "filecontents", "filecontents*", "thebibliography-skip"]);
const THEOREMS = { theorem: "Theorem", thm: "Theorem", lemma: "Lemma", lem: "Lemma", proposition: "Proposition", prop: "Proposition", corollary: "Corollary", cor: "Corollary",
  definition: "Definition", defn: "Definition", def: "Definition", remark: "Remark", rem: "Remark", example: "Example", ex: "Example", conjecture: "Conjecture",
  claim: "Claim", assumption: "Assumption", hypothesis: "Hypothesis", observation: "Observation", note: "Note", problem: "Problem", exercise: "Exercise", fact: "Fact", question: "Question" };
// environment argument signatures (o = optional [..], m = mandatory {..})
const ENV_ARGS = { tabular: "om", "tabular*": "mom", tabularx: "mom", tabulary: "mom", longtable: "om", "longtable*": "om", supertabular: "om", xltabular: "mom",
  tabu: "om", longtabu: "om", array: "om", NiceTabular: "om", tblr: "om", longtblr: "om", minipage: "oom", wrapfigure: "omom", wraptable: "omom", subfigure: "om", multicols: "mo", "multicols*": "mo",
  minted: "om", thebibliography: "m", alignat: "m", "alignat*": "m", spacing: "m", adjustbox: "m", otherlanguage: "m", tcolorbox: "o", figure: "o", "figure*": "o", table: "o", "table*": "o",
  lstlisting: "o", Verbatim: "o", itemize: "o", enumerate: "o", description: "o", theorem: "o", center: "", abstract: "", SCfigure: "o", sidewaysfigure: "o", sidewaystable: "o", subtable: "om", columns: "o", column: "m", frame: "o" };

const ACCENTS = { "'": "\u0301", "`": "\u0300", "^": "\u0302", '"': "\u0308", "~": "\u0303", "=": "\u0304", ".": "\u0307", c: "\u0327", v: "\u030C", u: "\u0306", H: "\u030B", k: "\u0328", r: "\u030A", d: "\u0323", b: "\u0331", t: "\u0361" };
const SYMBOLS = { LaTeX: "LaTeX", LaTeXe: "LaTeX2ε", TeX: "TeX", BibTeX: "BibTeX", XeTeX: "XeTeX", LuaTeX: "LuaTeX", ldots: "…", dots: "…", textellipsis: "…",
  textendash: "–", textemdash: "—", textquoteleft: "‘", textquoteright: "’", textquotedblleft: "“", textquotedblright: "”", ss: "ß", aa: "å", AA: "Å", ae: "æ", AE: "Æ",
  oe: "œ", OE: "Œ", o: "ø", O: "Ø", l: "ł", L: "Ł", i: "ı", j: "ȷ", copyright: "©", textcopyright: "©", textregistered: "®", texttrademark: "™", S: "§", P: "¶",
  dag: "†", ddag: "‡", textdagger: "†", textdaggerdbl: "‡", textbullet: "•", textdegree: "°", degree: "°", euro: "€", texteuro: "€", pounds: "£", textsterling: "£",
  textbackslash: "\\\\", textasciitilde: "~", textasciicircum: "^", textunderscore: "\\_", textless: "<", textgreater: ">", textbar: "|", textbraceleft: "{", textbraceright: "}",
  slash: "/", textperiodcentered: "·", textmu: "µ", checkmark: "✓", cmark: "✓", xmark: "✗", textpm: "±", texttimes: "×", textdiv: "÷", guillemotleft: "«", guillemotright: "»",
  quad: " ", qquad: " ", enspace: " ", thinspace: " ", space: " ", nobreakspace: " ", textvisiblespace: "␣", etal: "et al.", ie: "i.e.", eg: "e.g.", etc: "etc.", cf: "cf.", vs: "vs." };
const DROP0 = new Set(["centering", "raggedright", "raggedleft", "noindent", "indent", "small", "footnotesize", "scriptsize", "tiny", "large", "Large", "LARGE", "huge", "Huge", "normalsize",
  "selectfont", "protect", "relax", "hfill", "vfill", "hline", "smallskip", "medskip", "bigskip", "newpage", "clearpage", "cleardoublepage", "pagebreak", "linebreak", "nopagebreak",
  "frontmatter", "mainmatter", "backmatter", "tableofcontents", "listoffigures", "listoftables", "sloppy", "fussy", "null", "leavevmode", "strut", "allowbreak", "break", "nolinebreak",
  "toprule", "midrule", "bottomrule", "endhead", "endfirsthead", "endfoot", "endlastfoot", "noalign", "makeatletter", "makeatother", "printindex", "makeindex", "IEEEpeerreviewmaketitle",
  "onecolumn", "twocolumn", "balance", "FloatBarrier", "justify", "nocite-skip", "maketitlepage", "titlepage", "normalfont", "rmfamily", "sffamily", "ttfamily-skip", "upshape", "mdseries",
  "frenchspacing", "nonfrenchspacing", "unskip", "ignorespaces", "par-skip", "acknowledgments-skip", "IEEEoverridecommandlockouts", "hss", "vss", "displaystyle", "textstyle", "boldmath", "unboldmath", "sc", "scshape", "addlinespace", "ccsdesc-skip"]);
// commands whose arguments are dropped: name -> signature
const DROPARGS = { usepackage: "om", RequirePackage: "om", documentclass: "om", setlength: "mm", addtolength: "mm", setcounter: "mm", addtocounter: "mm", stepcounter: "m", refstepcounter: "m",
  vspace: "m", hspace: "m", vskip: "", hskip: "", pagestyle: "m", thispagestyle: "m", pagenumbering: "m", bibliographystyle: "m", graphicspath: "m", addbibresource: "om", hypersetup: "m",
  geometry: "m", captionsetup: "om", definecolor: "mmm", color: "om", fontsize: "mm", linespread: "m", setmainfont: "om", setsansfont: "om", setmonofont: "om", newgeometry: "m", theoremstyle: "m",
  numberwithin: "mm", setcitestyle: "m", lstset: "m", tikzset: "m", usetikzlibrary: "m", pgfplotsset: "m", newcounter: "mo", phantom: "m", hphantom: "m", vphantom: "m", rule: "omm",
  includepdf: "om", nocite: "m", newlength: "m", settowidth: "mm", setstretch: "m", renewenvironment: "mmm", newfloat: "mmm", floatname: "mm", DeclareGraphicsExtensions: "m",
  urlstyle: "m", bibpunct: "omm", pdfinfo: "m", acmConference: "omm", acmYear: "m", acmDOI: "m", acmISBN: "m", acmPrice: "m", copyrightyear: "m", setcopyright: "m", ccsdesc: "om",
  received: "om", setuptodonotes: "m", allowdisplaybreaks: "o", crefname: "mmm", Crefname: "mmm", newacronym: "omm", setbeamertemplate: "mm", usetheme: "om", usecolortheme: "om",
  enlargethispage: "m", addcontentsline: "mmm", markboth: "mm", markright: "m", titleformat: "mmmmm", titlespacing: "mmmm", pretitle: "m", posttitle: "m", preauthor: "m",
  postauthor: "m", ref_skip: "", newsavebox: "m", sbox: "mm", savebox: "mm", usebox: "m", mathcode: "", catcode: "", IEEEspecialpapernotice: "m", vfil: "", baselineskip: "",
  keywords_skip: "", label: "m", index: "m", glossary: "m", hyphenation: "m", resetcounter: "m", newcolumntype: "mom", arraystretch: "", extracolsep: "m", tabcolsep: "", cline: "m",
  cmidrule: "m", rowcolor: "om", cellcolor: "om", columncolor: "om", hhline: "m", specialrule: "mmm", arrayrulecolor: "m" };

class LatexConv {
  constructor(ctx) {
    this.ctx = ctx;
    this.store = []; // block placeholders
    this.verb = []; // stashed verbatim material
    this.macros = new Map();
    this.envMacros = new Map();
    this.labels = new Map();
    this.footnotes = [];
    this.counters = { part: 0, chapter: 0, section: 0, subsection: 0, subsubsection: 0, figure: 0, table: 0, equation: 0, footnote: 0, theorem: {} };
    this.theorems = { ...Object.fromEntries(Object.entries(THEOREMS).map(([k, v]) => [k, { title: v, counter: k, numbered: true }])) };
    this.last = null; // what \label refers to
    this.appendix = false;
    this.hasChapters = false;
    this.float = null;
    this.titleEmitted = false;
    this.meta = {};
  }

  run(src) {
    src = src.replace(/\r\n?/g, "\n");
    src = this.stashVerbatim(src);
    src = stripComments(src);
    src = this.extractMacros(src);
    src = this.expandMacros(src);
    const bi = src.indexOf("\\begin{document}");
    const pre = bi >= 0 ? src.slice(0, bi) : "";
    let body = bi >= 0 ? src.slice(bi + 16) : src;
    const ei = body.lastIndexOf("\\end{document}");
    if (ei >= 0) body = body.slice(0, ei);
    if (bi < 0 && /\\documentclass/.test(src)) {
      // no document env: drop everything up to the last preamble command
      body = body.replace(/^[\s\S]*\\documentclass(\[[^\]]*\])?\{[^}]*\}/, "");
    }
    this.hasChapters = /\\chapter\*?\s*[{[]/.test(body);
    for (const k of ["title", "author", "date", "subtitle"]) {
      const v = findCommandArg(pre + "\n" + body, k);
      if (v != null) this.meta[k] = v;
    }
    body = body.replace(/\\(title|author|date|subtitle)\s*(\[[^\]]*\])?\s*(?=\{)/g, (m) => m.replace("\\", "\\@drop"));
    if (this.meta.title && !/\\maketitle/.test(body)) body = "\\maketitle\n" + body;
    let md = this.block(body);
    md = this.restore(md);
    if (this.footnotes.length) md += "\n\n" + this.footnotes.map((f, i) => `[^${i + 1}]: ${this.restore(f).replace(/\n/g, "\n    ")}`).join("\n");
    md = md.replace(/\u0003REF:(\w*):([^\u0003]*)\u0003/g, (_, kind, keys) => keys.split(",").map((k) => this.ref(kind, k.trim())).join(", "));
    md = md.replace(/\u0004(\d+)\u0004/g, (_, i) => this.verb[+i].raw);
    return md;
  }

  // ---------- preprocessing ----------
  stashVerbatim(src) {
    // environments whose body is raw
    src = src.replace(/\\begin\{(verbatim\*?|Verbatim|BVerbatim|lstlisting|minted|alltt|comment|filecontents\*?|code|sourcecode)\}([\s\S]*?)\\end\{\1\}/g, (m, env, inner) => {
      let opts = "", lang = "";
      let body = inner;
      if (env === "minted") {
        const mm = /^\s*(\[[^\]]*\])?\s*\{([^}]*)\}/.exec(body);
        if (mm) { lang = mm[2]; body = body.slice(mm[0].length); }
      } else {
        const mo = /^\s*\[([^\]]*)\]/.exec(body);
        if (mo && env !== "verbatim") { opts = mo[1]; body = body.slice(mo[0].length); }
        const ml = /language\s*=\s*\{?([\w+#-]+)/i.exec(opts);
        if (ml) lang = ml[1].toLowerCase();
      }
      body = body.replace(/^[ \t]*\n/, "").replace(/\n[ \t]*$/, "");
      this.verb.push({ kind: env === "comment" || env.startsWith("filecontents") ? "drop" : "block", raw: body, lang });
      return `\u0004${this.verb.length - 1}\u0004`;
    });
    // \verb|x|, \lstinline|x| / {x}, \mintinline{lang}{x}
    src = src.replace(/\\(?:verb\*?|lstinline(?:\[[^\]]*\])?)([^\sa-zA-Z{])([\s\S]*?)\1|\\lstinline(?:\[[^\]]*\])?\{([^}]*)\}|\\mintinline(?:\[[^\]]*\])?\{[^}]*\}\{([^}]*)\}/g, (m, d, a, b, c) => {
      this.verb.push({ kind: "inline", raw: codeSpan(a ?? b ?? c ?? "") });
      return `\u0004${this.verb.length - 1}\u0004`;
    });
    return src;
  }

  extractMacros(src) {
    let out = "";
    let i = 0;
    const re = /\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|def|gdef|newenvironment|newtheorem|let)(\*?)/g;
    let m;
    while ((m = re.exec(src))) {
      if (/[a-zA-Z]/.test(src[re.lastIndex] || "") && m[1] !== "def" && m[1] !== "gdef" && m[1] !== "let") continue;
      out += src.slice(i, m.index);
      let p = re.lastIndex;
      const kind = m[1];
      try {
        if (kind === "newtheorem") {
          const [env, p1] = readArg(src, p); p = p1;
          let [shared, p2] = readOpt(src, p); p = p2;
          const [title, p3] = readArg(src, p); p = p3;
          const [, p4] = readOpt(src, p); p = p4;
          this.theorems[env.trim()] = { title: title.trim(), counter: (shared || env).trim(), numbered: !m[2] };
        } else if (kind === "newenvironment") {
          const [name, p1] = readArg(src, p); p = p1;
          const [n, p2] = readOpt(src, p); p = p2;
          const [, p3] = readOpt(src, p); p = p3;
          const [begin, p4] = readArg(src, p); p = p4;
          const [end, p5] = readArg(src, p); p = p5;
          if (!+n) this.envMacros.set(name.trim(), { begin, end });
        } else if (kind === "let") {
          const mm = /^\s*(\\[a-zA-Z@]+)\s*=?\s*(\\[a-zA-Z@]+|.)/.exec(src.slice(p));
          if (mm) { p += mm[0].length; if (mm[1] !== mm[2]) this.macros.set(mm[1].slice(1), { n: 0, body: mm[2] }); }
        } else if (kind === "def" || kind === "gdef") {
          const mm = /^\s*\\([a-zA-Z@]+)((?:#\d)*)\s*/.exec(src.slice(p));
          if (!mm) { out += m[0]; i = p; continue; }
          p += mm[0].length;
          const [body, p1] = readGroup(src, p); p = p1;
          this.macros.set(mm[1], { n: (mm[2].match(/#/g) || []).length, body });
        } else if (kind === "DeclareMathOperator") {
          const [name, p1] = readArg(src, p); p = p1;
          const [body, p2] = readArg(src, p); p = p2;
          this.macros.set(name.trim().replace(/^\\/, ""), { n: 0, body: `\\operatorname${m[2]}{${body}}` });
        } else {
          const [name, p1] = readArg(src, p); p = p1;
          const [n, p2] = readOpt(src, p); p = p2;
          const [dflt, p3] = readOpt(src, p); p = p3;
          const [body, p4] = readArg(src, p); p = p4;
          const nm = name.trim().replace(/^\\/, "");
          if (kind !== "providecommand" || !this.macros.has(nm)) this.macros.set(nm, { n: +n || 0, dflt, body });
        }
      } catch { /* malformed definition: keep scanning */ }
      i = p;
      re.lastIndex = p;
    }
    return out + src.slice(i);
  }

  expandMacros(src) {
    if (!this.macros.size && !this.envMacros.size) return src;
    for (const [name, { begin, end }] of this.envMacros) {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      src = src.replace(new RegExp(`\\\\begin\\{${esc}\\}`, "g"), () => begin).replace(new RegExp(`\\\\end\\{${esc}\\}`, "g"), () => end);
    }
    if (!this.macros.size) return src;
    let budget = 50000;
    let out = "";
    let i = 0;
    let s = src;
    while (i < s.length) {
      const j = s.indexOf("\\", i);
      if (j < 0) { out += s.slice(i); break; }
      out += s.slice(i, j);
      const mm = /^\\([a-zA-Z@]+)/.exec(s.slice(j, j + 64));
      if (!mm) { out += s.slice(j, j + 2); i = j + 2; continue; }
      const def = this.macros.get(mm[1]);
      if (!def || budget-- <= 0) { out += mm[0]; i = j + mm[0].length; continue; }
      let p = j + mm[0].length;
      const args = [];
      try {
        for (let k = 0; k < def.n; k++) {
          if (k === 0 && def.dflt != null) {
            const [o, p1] = readOpt(s, p);
            args.push(o ?? def.dflt); p = p1;
          } else { const [a, p1] = readArg(s, p); args.push(a); p = p1; }
        }
      } catch { out += mm[0]; i = j + mm[0].length; continue; }
      let body = def.body.replace(/#(\d)/g, (_, d) => args[+d - 1] ?? "");
      // avoid gluing letters onto a following command name
      if (def.n === 0 && /^\\[a-zA-Z@]+$/.test(body) && /[a-zA-Z]/.test(s[p] || "")) body += " ";
      s = body + s.slice(p);
      i = 0;
      // keep the already-emitted prefix in `out`; continue scanning the substituted text
    }
    return out;
  }

  // ---------- block assembly ----------
  put(md) { this.store.push(md); return `\n\n\u0001${this.store.length - 1}\u0001\n\n`; }

  restore(md) {
    for (let n = 0; n < 20 && md.includes("\u0001"); n++) {
      md = md.replace(/^([ \t>]*)\u0001(\d+)\u0001[ \t]*$/gm, (_, pad, i) => this.store[+i].split("\n").map((l, k) => (k === 0 ? pad + l : l ? pad + l : pad.includes(">") ? pad.trimEnd() : l)).join("\n"));
      md = md.replace(/\u0001(\d+)\u0001/g, (_, i) => this.store[+i]);
    }
    return md;
  }

  // convert LaTeX to normalized Markdown (may contain block placeholders)
  block(src) {
    const stream = this.conv(src);
    return stream
      .split(/\n[ \t]*\n/)
      .map((p) => p.replace(/[ \t\n]+/g, " ").trim())
      .filter(Boolean)
      .map((p) => {
        if (/^(\u0001\d+\u0001\s*)+$/.test(p)) return p.split(/\s+/).join("\n\n");
        p = p.replace(/(\*\*?)([^*\n]*?[.,:;!?)])\1(?=[\p{L}\p{N}])/gu, (m, mk, inner) => (/^\S/.test(inner) ? `${mk}${inner.slice(0, -1)}${mk}${inner.slice(-1)}` : m));
        return escapeLineStart(p.replace(/ ?\u0002 ?/g, "\u0002").replace(/^\u0002+|\u0002+$/g, "")).replace(/\u0002+/g, "\\\n");
      })
      .join("\n\n");
  }

  inline(src) {
    return this.restore(this.block(src)).replace(/\\\n/g, " ").replace(/\n\n+/g, " ").trim();
  }

  // ---------- core scanner ----------
  conv(s) {
    let out = "";
    let i = 0;
    const n = s.length;
    while (i < n) {
      const ch = s[i];
      if (ch === "\\") {
        const r = this.command(s, i);
        out += r[0];
        i = r[1];
        continue;
      }
      if (ch === "{") {
        const [g, e] = readGroup(s, i);
        out += this.group(g);
        i = e;
        continue;
      }
      if (ch === "}") { i++; continue; }
      if (ch === "$") {
        const display = s[i + 1] === "$";
        const close = display ? findUnescaped(s, "$$", i + 2) : findUnescaped(s, "$", i + 1);
        if (close < 0) { out += "\\$"; i++; continue; }
        const body = s.slice(i + (display ? 2 : 1), close);
        out += display ? this.displayMath(body, "") : this.inlineMath(body);
        i = close + (display ? 2 : 1);
        continue;
      }
      if (ch === "\u0004") {
        const e = s.indexOf("\u0004", i + 1);
        const v = this.verb[+s.slice(i + 1, e)];
        if (v.kind === "block") out += this.put(fence(v.raw, v.lang));
        else if (v.kind === "inline") out += s.slice(i, e + 1);
        i = e + 1;
        continue;
      }
      if (ch === "~") { out += " "; i++; continue; }
      if (ch === "&") { out += " "; i++; continue; }
      let j = i;
      while (j < n && !"\\{}$~&\u0004".includes(s[j])) j++;
      out += text(s.slice(i, j));
      i = j;
    }
    return out;
  }

  group(g) {
    // font declarations inside a group: {\bf ...}, {\em ...}, {\it ...}, {\tt ...}
    const m = /^\s*\\(bf|bfseries|it|itshape|em|sl|slshape|tt|ttfamily|sc|scshape|sf|rm|small|footnotesize|large|Large|tiny|scriptsize|huge|normalsize)\b\s*/.exec(g);
    if (m) {
      const rest = g.slice(m[0].length);
      const kind = m[1];
      if (/^(bf|bfseries)$/.test(kind)) return wrap(this.conv(rest), "**");
      if (/^(it|itshape|em|sl|slshape)$/.test(kind)) return wrap(this.conv(rest), "*");
      if (/^(tt|ttfamily)$/.test(kind)) return wrapCode(this.inline(rest));
      return this.conv(rest);
    }
    return this.conv(g);
  }

  inlineMath(body) {
    body = cleanMath(body);
    if (!body.trim()) return "";
    return `$${body.trim()}$`;
  }

  displayMath(body, env) {
    const labels = [];
    let tag = null;
    body = body.replace(/\\label\s*\{([^}]*)\}/g, (_, l) => { labels.push(l); return ""; });
    const starred = env.endsWith("*") || env === "" || env === "displaymath";
    const numbered = !starred || env === "equation";
    const wrapEnv = MATH_ENVS[env] ?? "";
    if (env === "equation" || env === "dmath") {
      this.counters.equation++;
      tag = this.counters.equation;
      for (const l of labels) this.labels.set(l, { kind: "eq", text: `${tag}` });
    } else if (wrapEnv && numbered && env !== "") {
      // multi-line: number each row not marked \nonumber
      const rows = splitTop(body, "\\\\");
      const nums = [];
      rows.forEach((r) => {
        if (/\\(nonumber|notag)\b/.test(r)) return;
        this.counters.equation++;
        nums.push(this.counters.equation);
        const lm = /\\label\s*\{([^}]*)\}/.exec(r);
        if (lm) this.labels.set(lm[1], { kind: "eq", text: `${this.counters.equation}` });
      });
      // labels were removed above; re-scan the original rows for their positions
      const rowsWithLabels = splitTop(body, "\\\\");
      void rowsWithLabels;
      if (labels.length && nums.length === 1) tag = nums[0];
      labels.forEach((l, k) => { if (!this.labels.has(l)) this.labels.set(l, { kind: "eq", text: `${nums[k] ?? nums[nums.length - 1] ?? ""}` }); });
    }
    body = cleanMath(body).replace(/\\(nonumber|notag)\b/g, "").trim();
    if (env.startsWith("eqnarray")) body = body.replace(/&\s*(=|<|>|\\leq?|\\geq?|\\approx|\\equiv|\\sim)\s*&/g, "&$1 ");
    if (env.startsWith("multline")) body = body.replace(/\\shoveleft|\\shoveright/g, "");
    if (wrapEnv && wrapEnv !== "sub") {
      if (wrapEnv === "alignedat") {
        const [nCols, p] = readArg(body, 0);
        body = `\\begin{alignedat}{${nCols}}${body.slice(p)}\\end{alignedat}`;
      } else body = `\\begin{${wrapEnv}}\n${body}\n\\end{${wrapEnv}}`;
    }
    if (!body.trim()) return "";
    if (tag != null && labels.length) body += ` \\tag{${tag}}`;
    return this.put(`$$\n${body}\n$$`);
  }

  ref(kind, key) {
    const l = this.labels.get(key);
    if (!l) return `[${key}]`;
    const name = { sec: "Section", fig: "Figure", tab: "Table", eq: "Equation", thm: "", item: "Item", ch: "Chapter", app: "Appendix", fn: "Footnote" }[l.kind] ?? "";
    if (kind === "eq") return `(${l.text})`;
    if (kind === "auto" || kind === "Cref") {
      const nm = l.kind === "thm" ? l.name : name;
      if (l.kind === "eq") return `${nm} (${l.text})`;
      return `${nm ? nm + " " : ""}${l.text}`;
    }
    if (kind === "cref") {
      const nm = (l.kind === "thm" ? l.name : name).toLowerCase();
      if (l.kind === "eq") return `eq. (${l.text})`;
      return `${nm ? nm + " " : ""}${l.text}`;
    }
    if (kind === "name") return l.title || l.text;
    return l.text;
  }

  sectionNumber(level) {
    const c = this.counters;
    const top = this.appendix ? (x) => String.fromCharCode(64 + x) : (x) => String(x);
    if (this.hasChapters) {
      const parts = [top(c.chapter), c.section, c.subsection, c.subsubsection];
      return parts.slice(0, level).join(".");
    }
    const parts = [top(c.section), c.subsection, c.subsubsection];
    return parts.slice(0, level).join(".");
  }

  // ---------- commands ----------
  command(s, i) {
    const m = /^\\([a-zA-Z@]+)(\*?)|^\\(.)/s.exec(s.slice(i, i + 80));
    if (!m) return ["", i + 1];
    const name = m[1] || m[3];
    const star = !!m[2];
    let p = i + m[0].length;
    const arg = () => { const [a, e] = readArg(s, p); p = e; return a; };
    const opt = () => { const [a, e] = readOpt(s, p); p = e; return a; };
    const done = (out) => [out, p];
    if (!m[1]) {
      // control symbols
      const c = m[3];
      if (c === "\\") { opt(); return done("\u0002"); }
      if ("%&#_{}$".includes(c)) return done(c === "_" ? "\\_" : c === "$" ? "\\$" : c === "#" ? "#" : c);
      if (c === " " || c === "\n" || c === "," || c === ";" || c === ":" || c === ">") return done(" ");
      if (c === "!" || c === "-" || c === "/" || c === "@" || c === "+") return done("");
      if (c === "[") { const e = findUnescaped(s, "\\]", p); if (e < 0) return done(""); const body = s.slice(p, e); p = e + 2; return done(this.displayMath(body, "")); }
      if (c === "(") { const e = findUnescaped(s, "\\)", p); if (e < 0) return done(""); const body = s.slice(p, e); p = e + 2; return done(this.inlineMath(body)); }
      if (c === "]" || c === ")") return done("");
      if (ACCENTS[c]) { const a = arg(); return done(accent(a, c)); }
      return done("");
    }
    if (m[1].length === 1 && "cvuHkrdbt".includes(name) && !star) {
      // letter accents like \c{c}, \v{s} (only when followed by an argument)
      if (/^\s*\{/.test(s.slice(p)) || /^ [a-zA-Z]/.test(s.slice(p))) { const a = arg(); return done(accent(a, name)); }
    }
    switch (name) {
      case "@droptitle": case "@dropauthor": case "@dropdate": case "@dropsubtitle": opt(); arg(); return done("");
      case "begin": return this.environment(s, i, p);
      case "end": arg(); return done("");
      case "item": opt(); return done(" ");
      case "par": return done("\n\n");
      case "newline": case "linebreak": case "break": opt(); return done(name === "newline" ? "\u0002" : "");
      // sectioning
      case "part": case "chapter": case "section": case "subsection": case "subsubsection": {
        opt();
        const title = arg();
        const base = this.meta.title ? 2 : 1;
        const depth = { part: -1, chapter: 0, section: 1, subsection: 2, subsubsection: 3 }[name] - (this.hasChapters ? 0 : 1);
        const level = Math.max(1, Math.min(6, base + Math.max(0, depth)));
        if (!star && name !== "part") {
          const c = this.counters;
          if (name === "chapter") { c.chapter++; c.section = c.subsection = c.subsubsection = 0; }
          if (name === "section") { c.section++; c.subsection = c.subsubsection = 0; }
          if (name === "subsection") { c.subsection++; c.subsubsection = 0; }
          if (name === "subsubsection") c.subsubsection++;
          const lvl = { chapter: 1, section: this.hasChapters ? 2 : 1, subsection: this.hasChapters ? 3 : 2, subsubsection: this.hasChapters ? 4 : 3 }[name];
          const last = { kind: this.appendix && lvl === 1 ? "app" : name === "chapter" ? "ch" : "sec", text: this.sectionNumber(lvl), title: "" };
          this.last = last;
          const t = this.inline(title);
          last.title = t;
          return done(this.put(`${"#".repeat(level)} ${t}`));
        }
        return done(this.put(`${"#".repeat(level)} ${this.inline(title)}`));
      }
      case "paragraph": case "subparagraph": {
        opt();
        const t = this.inline(arg());
        return done(`\n\n**${t.replace(/[.:]$/, "")}.** `);
      }
      case "appendix": this.appendix = true; this.counters.section = 0; this.counters.chapter = 0; return done("");
      case "maketitle": return done(this.titleBlock());
      case "label": { const l = arg().trim(); if (this.last) this.labels.set(l, this.last); return done(""); }
      case "caption": case "captionof": {
        if (name === "captionof") arg();
        const short = opt();
        void short;
        const c = arg();
        if (this.float) { this.float.caption = c; return done(""); }
        return done(this.put(this.inline(c)));
      }
      case "subcaption": arg(); return done("");
      // formatting
      case "textbf": case "mathbf": case "bm": case "boldsymbol": case "textmd-skip": return done(wrap(this.conv(arg()), "**"));
      case "textit": case "emph": case "textsl": case "mathit": case "textem": return done(wrap(this.conv(arg()), "*"));
      case "texttt": case "path": case "code": return done(wrapCode(this.inline(arg())));
      case "url": case "nolinkurl": { const u = arg().trim(); return done(name === "url" ? `<${u}>` : codeSpan(u)); }
      case "href": { const u = arg().trim(); const t = this.inline(arg()); return done(t ? `[${t}](${linkUrl(u)})` : `<${u}>`); }
      case "underline": case "uline": case "uuline": return done(wrapTag(this.conv(arg()), "u"));
      case "sout": case "st": case "xout": case "cancel": return done(wrap(this.conv(arg()), "~~"));
      case "textsuperscript": return done(wrapTag(this.conv(arg()), "sup"));
      case "textsubscript": return done(wrapTag(this.conv(arg()), "sub"));
      case "enquote": case "textquote": return done("“" + this.conv(arg()) + "”");
      case "textsc": case "textrm": case "textsf": case "textup": case "textnormal": case "textmd": case "mbox": case "hbox": case "text": case "fbox": case "framebox":
      case "textlf": case "ensuremath": case "mathrm": case "IEEEauthorblockN": case "IEEEauthorblockA": case "affil": case "affiliation": case "institute": case "email": case "orcid-skip":
      case "noindent-skip": case "acro": case "gls": case "Gls": case "glspl": case "ac": case "acs": case "acl": case "acf": case "acrshort": case "acrlong": case "acrfull":
      case "titlebox": case "keywordsname": case "textlatin": case "foreignlanguage": case "hyperlink": case "hypertarget": case "hl": case "textls": case "MakeUppercase": case "MakeLowercase": case "uppercase": case "lowercase":
        if (name === "makebox" || name === "framebox") { opt(); opt(); }
        if (name === "foreignlanguage" || name === "hyperlink" || name === "hypertarget") { opt(); arg(); }
        {
          const a = arg();
          let r = this.conv(a);
          if (name === "MakeUppercase" || name === "uppercase") r = r.toUpperCase();
          if (name === "MakeLowercase" || name === "lowercase") r = r.toLowerCase();
          return done(r);
        }
      case "makebox": opt(); opt(); return done(this.conv(arg()));
      case "textcolor": case "colorbox": opt(); arg(); return done(this.conv(arg()));
      case "fcolorbox": arg(); arg(); return done(this.conv(arg()));
      case "hyperref": opt(); return done(this.conv(arg()));
      case "resizebox": case "scalebox": case "rotatebox": case "raisebox": case "parbox": case "adjustbox":
        if (name === "parbox") { opt(); opt(); opt(); arg(); }
        else if (name === "resizebox") { arg(); arg(); }
        else if (name === "raisebox") { arg(); opt(); opt(); }
        else { opt(); arg(); }
        return done(this.conv(arg()));
      case "multicolumn": arg(); arg(); return done(this.conv(arg()));
      case "multirow": arg(); opt(); arg(); opt(); return done(this.conv(arg()));
      case "thanks": case "footnote": case "footnotetext": case "tablefootnote": {
        opt();
        const t = this.block(arg());
        this.footnotes.push(t);
        return done(`[^${this.footnotes.length}]`);
      }
      case "footnotemark": opt(); return done("");
      // references and citations
      case "ref": case "eqref": case "autoref": case "cref": case "Cref": case "vref": case "pageref": case "nameref": case "subref": case "Autoref": case "cpageref": case "labelcref": {
        const keys = arg();
        const kind = { eqref: "eq", autoref: "auto", Autoref: "auto", cref: "cref", Cref: "Cref", vref: "auto", nameref: "name" }[name] || "";
        if (name === "pageref" || name === "cpageref") return done(`[${keys}]`);
        return done(`\u0003REF:${kind}:${keys}\u0003`);
      }
      case "cite": case "citep": case "citet": case "citealp": case "citealt": case "citeauthor": case "citeyear": case "citeyearpar": case "parencite": case "textcite":
      case "autocite": case "footcite": case "Cite": case "Citep": case "Citet": case "cites": case "smartcite": case "supercite": case "citenum": case "Textcite": case "Parencite": case "Autocite": case "fullcite": {
        const o1 = opt(); const o2 = opt();
        const keys = arg().split(",").map((k) => k.trim()).filter(Boolean);
        const pre = o2 != null ? o1 : null, post = o2 != null ? o2 : o1;
        const textual = /^(citet|textcite|Citet|Textcite|citeauthor)$/.test(name);
        const noauth = name === "citeyear" || name === "citeyearpar";
        const list = keys.map((k) => `${noauth ? "-" : ""}@${k}`);
        if (textual) return done(list.join("; ") + (post ? ` [${this.inline(post)}]` : ""));
        let body = list.join("; ");
        if (pre) body = `${this.inline(pre)} ${body}`;
        if (post) body += `, ${this.inline(post)}`;
        return done(`[${body}]`);
      }
      case "nocite": arg(); return done("");
      case "bibliography": case "printbibliography": {
        if (name === "bibliography") {
          const f = arg();
          this.ctx.warnings.push(`Bibliography (${f.split(",").map((x) => x.trim().replace(/(\.bib)?$/, ".bib")).join(", ")}) not included; citations are kept as [@key].`);
        } else opt();
        const level = this.meta.title ? 2 : 1;
        return done(this.put(`${"#".repeat(level)} References`));
      }
      case "input": case "include": case "subfile": case "import": case "subimport": case "includeonly": case "InputIfFileExists": {
        let f = arg();
        if (name === "import" || name === "subimport") f += arg();
        if (name === "includeonly") return done("");
        this.ctx.warnings.push(`\\${name}{${f}} was not inlined; convert that file separately.`);
        return done(this.put(`<!-- \\${name}{${f.trim()}} not included -->`));
      }
      case "includegraphics": case "includesvg": case "includestandalone": case "epsfig": case "psfig": case "epsfbox": {
        opt();
        const f = arg().trim().replace(/^file=/, "");
        return done(this.image(f));
      }
      case "today": return done(new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }));
      case "and": case "AND": case "And": return done("\u0002");
      case "keywords": case "IEEEkeywords": return done(this.put(`**Keywords:** ${this.inline(arg())}`));
      case "acknowledgments": case "acknowledgements": return done(this.put(`${"#".repeat(this.meta.title ? 2 : 1)} Acknowledgments`));
      case "item_": return done("");
      case "verb": return done("");
      case "hspace": case "vspace": { opt(); const a = arg(); return done(/^\s*\\(fill|stretch)/.test(a) || name === "vspace" ? "" : " "); }
      case "bibitem": opt(); arg(); return done("");
      case "newblock": return done(" ");
      case "frac": case "dfrac": case "tfrac": { const a = this.inline(arg()), b = this.inline(arg()); return done(`${a}/${b}`); }
      default: break;
    }
    if (SYMBOLS[name] != null) {
      // a following {} or "\ " just terminates the macro name
      if (s.slice(p, p + 2) === "{}") p += 2;
      return done(SYMBOLS[name]);
    }
    if (DROP0.has(name)) return done("");
    if (DROPARGS[name] != null) {
      for (const k of DROPARGS[name]) { if (k === "o") opt(); else arg(); }
      return done("");
    }
    if (THEOREMS[name] || this.theorems[name]) return done("");
    // unknown command: drop it and an optional argument; following groups' content is kept
    if (/^[ \t]*\[/.test(s.slice(p, p + 20))) opt();
    return done("");
  }

  image(path) {
    const fig = this.float;
    if (this.ctx.imageMode === "placeholder") return this.put("<!-- image -->");
    const alt = fig?.caption ? this.inline(fig.caption) : "";
    if (!this._imgWarned) { this.ctx.warnings.push("Images referenced by the LaTeX source are linked by path, not embedded."); this._imgWarned = true; }
    return this.put(`![${alt.replace(/[\[\]]/g, "")}](${linkUrl(path)})`);
  }

  titleBlock() {
    if (this.titleEmitted || !this.meta.title) return "";
    this.titleEmitted = true;
    const parts = [];
    parts.push(`# ${this.inline(this.meta.title.replace(/\\\\/g, " "))}`);
    if (this.meta.subtitle) parts.push(`*${this.inline(this.meta.subtitle)}*`);
    if (this.meta.author) {
      const authors = splitTop(this.meta.author, "\\and").map((a) => this.inline(a.replace(/\\\\(\[[^\]]*\])?/g, ", ")).replace(/(,\s*)+/g, ", ").replace(/^,\s*|,\s*$/g, "").replace(/\s+/g, " ").replace(/\s+,/g, ",").trim()).filter(Boolean);
      if (authors.length) parts.push(authors.join("\\\n"));
    }
    if (this.meta.date != null) {
      const d = this.inline(this.meta.date);
      if (d) parts.push(d);
    }
    return parts.map((x) => this.put(x)).join("");
  }

  // ---------- environments ----------
  environment(s, start, p) {
    const [name0, p1] = readArg(s, p);
    const name = name0.trim();
    const end = findEnd(s, name, p1);
    let inner = s.slice(p1, end.start);
    const after = end.end;
    // environment arguments
    const sig = ENV_ARGS[name] ?? (this.theorems[name] ? "o" : "");
    const args = [];
    let q = 0;
    for (const k of sig) {
      if (k === "o") { const [a, e] = readOpt(inner, q); args.push(a); q = e; }
      else { const [a, e] = readArg(inner, q); args.push(a); q = e; }
    }
    inner = inner.slice(q);
    const ret = (out) => [out, after];
    if (DROP_ENVS.has(name)) return ret("");
    if (name === "document") return ret(this.conv(inner));
    if (name === "abstract") {
      const level = this.meta.title ? 2 : 1;
      return ret(this.put(`${"#".repeat(level)} Abstract`) + this.put(this.block(inner)));
    }
    if (LIST_ENVS.has(name)) return ret(this.put(this.list(name, inner)));
    if (MATH_ENVS[name] != null) {
      if (name === "math") return ret(this.inlineMath(inner));
      if (name === "subequations") return ret(this.conv(inner));
      return ret(this.displayMath(inner, name));
    }
    if (TABULAR.has(name)) {
      if (name === "array") return ret(this.inlineMath(`\\begin{array}{${args[1] || ""}}${inner}\\end{array}`));
      return ret(this.tabular(inner, name));
    }
    if (FIG_ENVS.has(name) || TAB_ENVS.has(name) || name === "subtable" || name === "algorithm" || name === "listing") {
      const isTab = TAB_ENVS.has(name) || name === "subtable";
      const kind = isTab ? "table" : name === "algorithm" ? "algorithm" : name === "listing" ? "listing" : "figure";
      const sub = name === "subfigure" || name === "subtable";
      const prev = this.float;
      let n = null;
      if (!sub) {
        this.counters[kind] = (this.counters[kind] || 0) + 1;
        n = this.counters[kind];
      }
      // pre-scan the caption so images can use it as alt text
      const capRaw = findCommandArg(inner, "caption");
      this.float = { kind, n, caption: capRaw };
      const prevLast = this.last;
      this.last = { kind: isTab ? "tab" : kind === "figure" ? "fig" : "sec", text: sub ? `${prev?.n ?? ""}` : `${n}` };
      let body;
      if (PICTURE_IN(inner)) body = this.put("<!-- image -->") + this.conv(stripPictures(inner));
      else body = this.conv(inner);
      const cap = this.float.caption;
      this.float = prev;
      if (sub) this.last = prevLast;
      const label = { figure: "Figure", table: "Table", algorithm: "Algorithm", listing: "Listing" }[kind];
      const capMd = cap != null ? (sub ? this.inline(cap) : `${label} ${n}: ${this.inline(cap)}`) : "";
      return ret((capMd ? this.put(capMd) : "") + body);
    }
    if (PICTURE.has(name)) return ret(this.put("<!-- image -->"));
    if (QUOTE.has(name)) {
      const md = this.restore(this.block(inner));
      return ret(this.put(md.split("\n").map((l) => (l ? "> " + l : ">")).join("\n")));
    }
    if (name === "proof") {
      const title = args[0] != null ? this.inline(args[0]) : "Proof";
      const md = this.block(inner);
      return ret(this.put(`*${title}.* ${md} ∎`.replace(/\n\n/, "\n\n")));
    }
    if (this.theorems[name]) {
      const th = this.theorems[name];
      let label = th.title;
      if (th.numbered) {
        const c = this.counters.theorem;
        c[th.counter] = (c[th.counter] || 0) + 1;
        label += ` ${c[th.counter]}`;
        this.last = { kind: "thm", name: th.title, text: `${c[th.counter]}` };
      }
      const note = args[0] != null ? ` (${this.inline(args[0])})` : "";
      const md = this.block(inner);
      return ret(this.put(`**${label}${note}.** ${md}`));
    }
    if (name === "thebibliography") {
      const items = splitItems(inner, "bibitem");
      const level = this.meta.title ? 2 : 1;
      const lines = items.items.map((it, k) => {
        const [o, e1] = readOpt(it, 0);
        const [key, e2] = readArg(it, e1);
        void o;
        this.labels.set("cite:" + key.trim(), { kind: "", text: `${k + 1}` });
        return `${k + 1}. ${this.inline(it.slice(e2))}`;
      });
      return ret(this.put(`${"#".repeat(level)} References`) + this.put(lines.join("\n")));
    }
    if (name === "algorithmic" || name === "algorithmic*" || name === "algpseudocode") {
      const code = inner.replace(/\\(State|Statex|STATE|Require|Ensure|REQUIRE|ENSURE|Return|RETURN|Comment)\b\s*/g, (m, c) => (/Require|REQUIRE/.test(c) ? "\nRequire: " : /Ensure|ENSURE/.test(c) ? "\nEnsure: " : /Return|RETURN/.test(c) ? "\nreturn " : /Comment/.test(c) ? " // " : "\n"))
        .replace(/\\(If|IF|ElsIf|ELSIF|While|WHILE|For|FOR|ForAll|FORALL|Function|Procedure)\s*\{([^}]*)\}(\{[^}]*\})?/g, (m, c, a, b) => `\n${c.toLowerCase()} ${a}${b ? " " + b.slice(1, -1) : ""}`)
        .replace(/\\(Else|ELSE)\b/g, "\nelse").replace(/\\(EndIf|ENDIF|EndWhile|ENDWHILE|EndFor|ENDFOR|EndFunction|EndProcedure)\b/g, (m, c) => "\nend " + c.replace(/^End/i, "").toLowerCase())
        .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
      return ret(this.put(fence(code, "")));
    }
    if (name === "acknowledgments" || name === "acknowledgements" || name === "acks") {
      const level = this.meta.title ? 2 : 1;
      return ret(this.put(`${"#".repeat(level)} Acknowledgments`) + this.put(this.block(inner)));
    }
    if (name === "keywords" || name === "IEEEkeywords") return ret(this.put(`**Keywords:** ${this.inline(inner)}`));
    if (name === "frame") {
      const t = /^\s*\{([^}]*)\}/.exec(inner);
      return ret((t ? this.put(`## ${this.inline(t[1])}`) : "") + this.conv(t ? inner.slice(t[0].length) : inner));
    }
    // generic container (center, minipage, multicols, flushleft, ...)
    return ret(this.conv(inner));
  }

  list(name, inner) {
    const { pre, items } = splitItems(inner, "item");
    void pre;
    const ordered = /enum/.test(name);
    const desc = /desc/.test(name);
    const lines = [];
    let n = 0;
    for (const it of items) {
      n++;
      const [label, e] = readOpt(it, 0);
      const prevLast = this.last;
      if (ordered) this.last = { kind: "item", text: `${n}` };
      let body = this.restore(this.block(it.slice(label != null ? e : 0))).replace(/\n\n(?=(?:[-*+]|\d+\.) )/g, "\n");
      this.last = ordered ? prevLast : this.last;
      let marker = ordered ? `${n}.` : "-";
      if (label != null) {
        const l = this.inline(label);
        if (desc) body = `**${l}** ${body}`;
        else if (!ordered) body = `${l} ${body}`;
      }
      const pad = " ".repeat(marker.length + 1);
      const ls = body.split("\n");
      lines.push(`${marker} ${ls[0]}` + ls.slice(1).map((l) => "\n" + (l ? pad + l : "")).join(""));
    }
    return lines.join("\n");
  }

  tabular(inner, name) {
    let body = inner
      .replace(/\\(hline|toprule|midrule|bottomrule|endhead|endfirsthead|endfoot|endlastfoot|addlinespace|tabularnewline-skip|hdashline|firsthline|lasthline|centering)\b(\[[^\]]*\])?/g, "")
      .replace(/\\(cline|cmidrule|rowcolor|cellcolor|hhline|arrayrulecolor)\s*(\([^)]*\))?\s*(\[[^\]]*\])?\s*\{[^}]*\}/g, "")
      .replace(/\\specialrule\s*\{[^}]*\}\s*\{[^}]*\}\s*\{[^}]*\}/g, "")
      .replace(/\\tabularnewline\b/g, "\\\\");
    if (name.startsWith("longtable") || name === "xltabular") {
      // captions inside longtable
      const cap = findCommandArg(body, "caption");
      if (cap != null) {
        body = removeCommand(body, "caption");
        this.counters.table++;
        const md = `Table ${this.counters.table}: ${this.inline(cap)}`;
        return this.put(md) + this.tabularBody(body);
      }
    }
    return this.tabularBody(body);
  }

  tabularBody(body) {
    const rows = [];
    for (let row of splitTop(body, "\\\\")) {
      row = row.replace(/^\s*\[[^\]]*\]/, "");
      if (!row.trim()) continue;
      const cells = splitTop(row, "&").map((c) => {
        const mm = /^\s*\\multicolumn\s*\{(\d+)\}/.exec(c);
        const span = mm ? +mm[1] : 1;
        return { text: this.inline(c), colspan: span };
      });
      rows.push(cells);
    }
    if (!rows.length) return "";
    return this.put(renderTable(rows, { header: true }));
  }
}

// ---------- helpers ----------
function PICTURE_IN(s) { return /\\begin\{(tikzpicture|pgfpicture|picture|forest|tikzcd|circuitikz|pspicture)\}|\\input\{[^}]*\.(tikz|pgf|pdf_tex)\}/.test(s) && !/\\includegraphics/.test(s); }
function stripPictures(s) {
  return s.replace(/\\begin\{(tikzpicture|pgfpicture|picture|forest|tikzcd|circuitikz|pspicture)\}[\s\S]*?\\end\{\1\}/g, "").replace(/\\input\{[^}]*\.(tikz|pgf|pdf_tex)\}/g, "");
}

function text(t) {
  return escapeMd(
    t.replace(/---/g, "—").replace(/--/g, "–").replace(/``/g, "“").replace(/''/g, "”").replace(/`/g, "‘").replace(/,,/g, "„").replace(/<</g, "«").replace(/>>/g, "»"),
  ).replace(/\\\$/g, "\\$");
}

function wrap(inner, mark) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  if (!m[2]) return inner;
  return m[1] + mark + m[2] + mark + m[3];
}
function wrapTag(inner, t) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  if (!m[2]) return inner;
  return `${m[1]}<${t}>${m[2]}</${t}>${m[3]}`;
}
function wrapCode(md) {
  // un-escape markdown escapes inside code
  const raw = md.replace(/\\([\\*_`$[\]<#])/g, "$1").replace(/&lt;/g, "<");
  return raw ? codeSpan(raw) : "";
}

function accent(a, c) {
  let base = a.trim().replace(/^\\([ij])$/, (_, x) => (x === "i" ? "ı" : "ȷ"));
  if (base === "ı" && c !== ".") base = "i";
  if (!base) return ACCENTS[c] === "\u0303" ? "~" : "";
  return (base[0] + ACCENTS[c] + base.slice(1)).normalize("NFC");
}

function cleanMath(m) {
  return m.replace(/\\label\s*\{[^}]*\}/g, "").replace(/\u0004(\d+)\u0004/g, "").replace(/(^|[^\\])%[^\n]*/g, "$1").trim();
}

export function stripComments(src) {
  const out = [];
  for (const line of src.split("\n")) {
    let cut = -1;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "\\") { i++; continue; }
      if (line[i] === "%") { cut = i; break; }
    }
    if (cut < 0) out.push(line + "\n");
    // a comment eats the rest of the line including the newline (TeX semantics)
    else out.push(line.slice(0, cut));
  }
  return out.join("");
}

function skipWs(s, i) {
  while (i < s.length && /[ \t\n]/.test(s[i])) {
    if (s[i] === "\n" && /^\n[ \t]*\n/.test(s.slice(i, i + 50))) break; // don't cross a paragraph break
    i++;
  }
  return i;
}

export function readGroup(s, i) {
  if (s[i] !== "{") throw new Error("expected {");
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") { j++; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return [s.slice(i + 1, j), j + 1]; }
  }
  return [s.slice(i + 1), s.length];
}

export function readArg(s, i) {
  const j = skipWs(s, i);
  if (s[j] === "{") return readGroup(s, j);
  if (s[j] === "\\") {
    const m = /^\\([a-zA-Z@]+|.)/s.exec(s.slice(j, j + 64));
    return [m[0], j + m[0].length];
  }
  if (j >= s.length) return ["", j];
  return [s[j], j + 1];
}

export function readOpt(s, i) {
  const j = skipWs(s, i);
  if (s[j] !== "[") return [null, i];
  let depth = 0, bd = 0;
  for (let k = j; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") { k++; continue; }
    if (c === "{") bd++;
    else if (c === "}") bd--;
    else if (bd === 0 && c === "[") depth++;
    else if (bd === 0 && c === "]") { depth--; if (depth === 0) return [s.slice(j + 1, k), k + 1]; }
  }
  return [null, i];
}

function findUnescaped(s, tok, from) {
  for (let i = from; i <= s.length - tok.length; i++) {
    if (s[i] === "\\" && !(tok[0] === "\\" && s.startsWith(tok, i))) { i++; continue; }
    if (s.startsWith(tok, i)) return i;
  }
  return -1;
}

function findEnd(s, name, from) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\\\(begin|end)\\s*\\{${esc}\\}`, "g");
  re.lastIndex = from;
  let depth = 1, m;
  while ((m = re.exec(s))) {
    if (m[1] === "begin") depth++;
    else if (--depth === 0) return { start: m.index, end: m.index + m[0].length };
  }
  return { start: s.length, end: s.length };
}

// split at a top-level separator (outside braces and nested environments)
export function splitTop(s, sep) {
  const parts = [];
  let depth = 0, env = 0, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      if (s.startsWith("\\begin", i) && !/[a-zA-Z]/.test(s[i + 6] || "")) env++;
      else if (s.startsWith("\\end", i) && !/[a-zA-Z]/.test(s[i + 4] || "")) env--;
      else if (depth === 0 && env === 0 && sep.startsWith("\\") && s.startsWith(sep, i) && !(sep.length > 2 && /[a-zA-Z]/.test(s[i + sep.length] || ""))) {
        parts.push(s.slice(last, i));
        i += sep.length - 1;
        last = i + 1;
        continue;
      }
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0 && env === 0 && !sep.startsWith("\\") && s.startsWith(sep, i)) {
      parts.push(s.slice(last, i));
      last = i + sep.length;
    }
  }
  parts.push(s.slice(last));
  return parts;
}

function splitItems(s, cmd) {
  const re = new RegExp(`\\\\${cmd}(?![a-zA-Z])`, "g");
  const items = [];
  let depth = 0, env = 0, last = -1, pre = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      if (s.startsWith("\\begin", i) && !/[a-zA-Z]/.test(s[i + 6] || "")) env++;
      else if (s.startsWith("\\end", i) && !/[a-zA-Z]/.test(s[i + 4] || "")) env--;
      else if (depth === 0 && env === 0) {
        re.lastIndex = i;
        const m = re.exec(s);
        if (m && m.index === i) {
          if (last < 0) pre = s.slice(0, i); else items.push(s.slice(last, i));
          last = i + m[0].length;
          i = last - 1;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  if (last >= 0) items.push(s.slice(last));
  else pre = s;
  return { pre, items };
}

function findCommandArg(s, name) {
  const re = new RegExp(`\\\\${name}\\*?(?![a-zA-Z])`, "g");
  let m, val = null;
  while ((m = re.exec(s))) {
    let p = m.index + m[0].length;
    const [, p1] = readOpt(s, p); p = p1;
    const j = skipWs(s, p);
    if (s[j] !== "{") continue;
    const [a] = readGroup(s, j);
    val = a;
    if (name !== "caption") break; // first \title etc.; last \caption at top level is used below
    break;
  }
  return val;
}

function removeCommand(s, name) {
  const re = new RegExp(`\\\\${name}\\*?(?![a-zA-Z])`);
  const m = re.exec(s);
  if (!m) return s;
  let p = m.index + m[0].length;
  const [, p1] = readOpt(s, p); p = p1;
  const j = skipWs(s, p);
  if (s[j] !== "{") return s;
  const [, e] = readGroup(s, j);
  return s.slice(0, m.index) + s.slice(e);
}
