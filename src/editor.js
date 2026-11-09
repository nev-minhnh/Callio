import { EditorState, Compartment, EditorSelection, StateField, Annotation } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import { Tag } from "@lezer/highlight";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
  dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, undo as cmUndo, redo as cmRedo, undoDepth, redoDepth, isolateHistory } from "@codemirror/commands";
import {
  StreamLanguage, HighlightStyle, syntaxHighlighting, bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit,
} from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, snippetCompletion,
} from "@codemirror/autocomplete";
import { lintKeymap, setDiagnostics, linter, lintGutter } from "@codemirror/lint";
import { codeAids } from "./codeview.js";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { tags as t } from "@lezer/highlight";
import { unifiedMergeView, getChunks, getOriginalDoc } from "@codemirror/merge";

// ---------- languages & highlighting ----------
const texLang = StreamLanguage.define({
  ...stex,
  languageData: {
    commentTokens: { line: "%" },
    closeBrackets: { brackets: ["(", "[", "{"] },
    wordChars: "\\@",
  },
});

const texStyle = HighlightStyle.define([
  { tag: t.tagName, class: "tok-cmd" },
  { tag: t.keyword, class: "tok-math" },
  { tag: t.atom, class: "tok-string" },
  { tag: t.number, class: "tok-number" },
  { tag: t.comment, class: "tok-comment" },
  { tag: t.bracket, class: "tok-bracket" },
  { tag: t.invalid, class: "tok-keyword" },
  { tag: [t.string, t.standard(t.variableName)], class: "tok-string" },
]);

const mdStyle = HighlightStyle.define([
  { tag: t.heading1, class: "tok-heading tok-heading1" },
  { tag: t.heading2, class: "tok-heading tok-heading2" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], class: "tok-heading" },
  { tag: t.emphasis, class: "tok-emph" },
  { tag: t.strong, class: "tok-strong" },
  { tag: t.strikethrough, class: "tok-strike" },
  { tag: t.link, class: "tok-link" },
  { tag: t.url, class: "tok-url" },
  { tag: t.monospace, class: "tok-mono" },
  { tag: t.quote, class: "tok-quote" },
  { tag: [t.processingInstruction, t.contentSeparator, t.labelName], class: "tok-meta" },
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier], class: "tok-keyword" },
  { tag: [t.string, t.special(t.string), t.regexp], class: "tok-string" },
  { tag: [t.number, t.bool, t.null, t.atom], class: "tok-number" },
  { tag: [t.comment, t.lineComment, t.blockComment], class: "tok-comment" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.className, t.typeName, t.tagName], class: "tok-cmd" },
  { tag: [t.propertyName, t.attributeName], class: "tok-attr" },
  { tag: t.meta, class: "tok-meta" },
]);

export function kindOf(path) {
  const ext = (path || "").toLowerCase().split(".").pop();
  if (["md", "markdown", "mdown", "mkd", "txt"].includes(ext)) return ext === "txt" ? "text" : "md";
  if (["tex", "sty", "cls", "ltx", "dtx", "tikz"].includes(ext)) return "tex";
  if (ext === "bib") return "bib";
  if (ext === "pdf") return "pdf";
  // Word documents and spreadsheets: shown by the office engine
  if (["docx", "docm", "dotx", "dotm", "doc", "dot", "odt", "ott", "fodt", "rtf"].includes(ext)) return "doc";
  if (["xlsx", "xlsm", "xltx", "xltm", "xls", "xlsb", "ods"].includes(ext)) return "sheet";
  // delimited text: a table view over the text (saved as the same CSV/TSV)
  if (["csv", "tsv", "tab", "psv"].includes(ext)) return "csv";
  if (STRUCT[ext]) return STRUCT[ext];
  const base = (path || "").toLowerCase().split(/[\\/]/).pop();
  if (/^\.?(babelrc|eslintrc|prettierrc|jshintrc|swcrc)$/.test(base)) return "json";
  if (["pptx", "pptm", "ppsx", "ppsm", "potx", "potm", "odp"].includes(ext)) return "deck";
  // pictures and camera raw files: the photo editor
  if (IMAGE_EXT.includes(ext)) return "image";
  if (ext === "ipynb") return "ipynb";
  if (ext === "mmd" || ext === "mermaid") return "mermaid";
  return "text";
}

export const IMAGE_EXT = ["jpg", "jpeg", "jpe", "jfif", "png", "tif", "tiff", "webp", "avif", "heic", "heif", "jxl", "bmp", "gif", "psd", "dng", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "rwl", "pef", "srw", "x3f", "3fr", "fff", "iiq", "erf", "mef", "mos", "kdc", "dcr"];
const STRUCT = Object.fromEntries([
  ...["json", "jsonc", "json5", "geojson", "webmanifest", "har", "jsonl", "ndjson", "code-workspace", "topojson", "jsonld"].map((e) => [e, "json"]),
  ...["xml", "svg", "xsd", "xsl", "xslt", "plist", "csproj", "vbproj", "fsproj", "vcxproj", "props", "targets", "config", "resx", "xaml", "axaml", "kml", "gpx", "rss", "atom", "wsdl", "pom", "fxml", "xlf", "xliff", "nuspec", "tmx", "graphml", "drawio", "storyboard", "xib", "opf", "ncx"].map((e) => [e, "xml"]),
  ["yaml", "yaml"], ["yml", "yaml"],
]);
/** Kinds edited as text in the source editor. */
export const TEXT_KINDS = new Set(["md", "tex", "bib", "text", "json", "xml", "yaml", "csv", "ipynb", "mermaid"]);

// ---------- CSV / TSV: each column in its own colour ----------
const colTags = Array.from({ length: 6 }, () => Tag.define());
const csvStyle = HighlightStyle.define(colTags.map((tag, i) => ({ tag, class: `tok-c${i}` })));
const csvLangs = new Map();
function csvLang(delim) {
  if (csvLangs.has(delim)) return csvLangs.get(delim);
  const lang = StreamLanguage.define({
    name: "csv",
    startState: () => ({ col: 0, q: false }),
    copyState: (s) => ({ ...s }),
    token(stream, st) {
      if (stream.sol() && !st.q) st.col = 0;
      if (st.q) {
        while (!stream.eol()) {
          const c = stream.next();
          if (c === '"') { if (stream.peek() === '"') stream.next(); else { st.q = false; break; } }
        }
        return `c${st.col % 6}`;
      }
      if (stream.peek() === delim) { stream.next(); st.col++; return "delim"; }
      if (stream.peek() === '"') { stream.next(); st.q = true; return `c${st.col % 6}`; }
      while (!stream.eol() && stream.peek() !== delim) stream.next();
      return `c${st.col % 6}`;
    },
    tokenTable: Object.fromEntries(colTags.map((t, i) => [`c${i}`, t]).concat([["delim", t.punctuation]])),
  });
  csvLangs.set(delim, lang);
  return lang;
}

function languageFor(kind, extra = {}) {
  if (kind === "md") return [markdown({ base: markdownLanguage, codeLanguages: languages }), syntaxHighlighting(mdStyle)];
  if (kind === "tex") return [texLang, syntaxHighlighting(texStyle)];
  if (kind === "bib") return [texLang, syntaxHighlighting(texStyle)];
  if (kind === "csv") return [csvLang(extra.delim || ","), syntaxHighlighting(csvStyle), syntaxHighlighting(mdStyle)];
  return [];
}

/** The syntax highlighting for a file name (JSON, XML, YAML, code…), loaded on demand. */
export async function loadLanguage(path) {
  const name = (path || "").split(/[\\/]/).pop();
  let desc = LanguageDescription.matchFilename(languages, name);
  const e = name.toLowerCase().split(".").pop();
  if (!desc && STRUCT[e]) desc = LanguageDescription.matchLanguageName(languages, STRUCT[e] === "json" ? "JSON" : STRUCT[e] === "xml" ? "XML" : "YAML");
  if (!desc || desc.name === "Markdown") return null;
  try { return [await desc.load(), syntaxHighlighting(mdStyle)]; } catch { return null; }
}
/** The CSV/TSV highlighting for a delimiter. */
export const csvLanguage = (delim) => languageFor("csv", { delim });
/** Effect that switches a state's language (see loadLanguage). */
export const languageEffect = (ext) => cLang.reconfigure(ext || []);

// ---------- checking JSON / XML / YAML as you type ----------
let checkName = () => "";
/** Who tells the checker the file name of the text being checked. */
export function setCheckName(f) { checkName = f; }
function structLinter(kind) {
  if (kind !== "json" && kind !== "xml" && kind !== "yaml") return [];
  return [
    lintGutter(),
    linter(async (view) => {
      const name = checkName() || `x.${kind}`;
      const text = view.state.doc.toString();
      if (text.length > 4_000_000) return [];
      const S = await import("./structured.js");
      const out = [];
      const len = view.state.doc.length;
      const at = (e, severity) => ({ from: Math.min(e.from, len), to: Math.min(Math.max(e.to, e.from + 1), len), severity, message: e.message, source: kind.toUpperCase() });
      try {
        const warn = (await S.validate(text, name)) || [];
        for (const w of warn) out.push(at(w, "warning"));
      } catch (e) {
        if (e instanceof S.ParseError) out.push(at(e, "error"));
      }
      lintHook(out);
      return out;
    }, { delay: 350 }),
  ];
}
let lintHook = () => {};
/** Called with the problems after each check (for the status bar). */
export function onLint(f) { lintHook = f; }

// ---------- LaTeX completion ----------
const TEX_CMDS = [
  ["\\section{${}}", "section"], ["\\subsection{${}}", "subsection"], ["\\subsubsection{${}}", "subsubsection"],
  ["\\paragraph{${}}", "paragraph"], ["\\chapter{${}}", "chapter"], ["\\part{${}}", "part"],
  ["\\textbf{${}}", "bold"], ["\\textit{${}}", "italic"], ["\\emph{${}}", "emphasis"], ["\\underline{${}}", "underline"],
  ["\\texttt{${}}", "monospace"], ["\\textsc{${}}", "small caps"], ["\\textsf{${}}", "sans"],
  ["\\label{${}}", "label"], ["\\ref{${}}", "reference"], ["\\eqref{${}}", "equation ref"], ["\\autoref{${}}", "auto ref"],
  ["\\cref{${}}", "cleveref"], ["\\pageref{${}}", "page ref"],
  ["\\cite{${}}", "citation"], ["\\citep{${}}", "natbib"], ["\\citet{${}}", "natbib"], ["\\parencite{${}}", "biblatex"], ["\\textcite{${}}", "biblatex"],
  ["\\footnote{${}}", "footnote"], ["\\url{${}}", "url"], ["\\href{${url}}{${text}}", "hyperlink"],
  ["\\includegraphics[width=${0.8}\\linewidth]{${}}", "image"], ["\\input{${}}", "input file"], ["\\include{${}}", "include file"],
  ["\\usepackage{${}}", "package"], ["\\usepackage[${}]{${}}", "package with options"], ["\\documentclass{${article}}", "class"],
  ["\\newcommand{\\${name}}{${}}", "define command"], ["\\renewcommand{\\${name}}{${}}", "redefine"],
  ["\\frac{${}}{${}}", "fraction"], ["\\dfrac{${}}{${}}", "fraction"], ["\\sqrt{${}}", "root"], ["\\sum_{${}}^{${}}", "sum"],
  ["\\prod_{${}}^{${}}", "product"], ["\\int_{${}}^{${}}", "integral"], ["\\lim_{${}}", "limit"], ["\\mathbb{${}}", "blackboard"],
  ["\\mathcal{${}}", "calligraphic"], ["\\mathbf{${}}", "math bold"], ["\\mathrm{${}}", "roman"], ["\\operatorname{${}}", "operator"],
  ["\\text{${}}", "text in math"], ["\\left(${}\\right)", "auto-size ()"], ["\\left[${}\\right]", "auto-size []"],
  ["\\hat{${}}", "hat"], ["\\bar{${}}", "bar"], ["\\tilde{${}}", "tilde"], ["\\vec{${}}", "vector"], ["\\dot{${}}", "dot"],
  ["\\caption{${}}", "caption"], ["\\centering", "center"], ["\\maketitle", "title"], ["\\tableofcontents", "toc"],
  ["\\item ", "item"], ["\\newpage", "new page"], ["\\clearpage", "clear page"], ["\\noindent", ""], ["\\hline", "table rule"],
  ["\\toprule", "booktabs"], ["\\midrule", "booktabs"], ["\\bottomrule", "booktabs"], ["\\bibliography{${}}", "bibtex"],
  ["\\bibliographystyle{${plain}}", "bibtex"], ["\\addbibresource{${}}", "biblatex"], ["\\printbibliography", "biblatex"],
  ["\\title{${}}", ""], ["\\author{${}}", ""], ["\\date{${\\today}}", ""], ["\\vspace{${}}", ""], ["\\hspace{${}}", ""],
];
const GREEK = "alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega".split(" ");
const SYMS = "infty partial nabla cdot cdots ldots times leq geq neq approx equiv sim propto in notin subset subseteq cup cap forall exists rightarrow leftarrow Rightarrow Leftrightarrow mapsto to pm mp quad qquad emptyset ell".split(" ");
const ENVS = ["equation", "equation*", "align", "align*", "gather", "multline", "figure", "figure*", "table", "tabular", "itemize",
  "enumerate", "description", "abstract", "theorem", "lemma", "proof", "definition", "center", "minipage", "verbatim",
  "lstlisting", "minted", "split", "cases", "matrix", "pmatrix", "bmatrix", "array", "subfigure", "algorithm", "algorithmic", "quote", "document", "frame", "thebibliography"];
const PACKAGES = ["amsmath", "amssymb", "amsthm", "graphicx", "hyperref", "cleveref", "geometry", "booktabs", "xcolor", "tikz",
  "pgfplots", "natbib", "biblatex", "babel", "inputenc", "fontenc", "lmodern", "microtype", "siunitx", "subcaption", "caption",
  "float", "listings", "minted", "algorithm2e", "algorithmicx", "algpseudocode", "enumitem", "multirow", "longtable", "tabularx", "url", "xspace", "csquotes", "mathtools", "bm", "physics"];

const cmdOptions = [
  ...TEX_CMDS.map(([tpl, detail]) => snippetCompletion(tpl, { label: tpl.replace(/\$\{[^}]*\}/g, "").replace(/\{\}|\[\]/g, (m) => m), detail, type: "function" })),
  ...GREEK.map((g) => ({ label: "\\" + g, type: "constant", detail: "greek" })),
  ...SYMS.map((s) => ({ label: "\\" + s, type: "constant", detail: "symbol" })),
  ...ENVS.map((e) => snippetCompletion(`\\begin{${e}}\n\t\${}\n\\end{${e}}`, { label: `\\begin{${e}}`, detail: "environment", type: "class", boost: -1 })),
];

export const project = { labels: [], citations: [], files: [] };

function texCompletions(ctx) {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  let m;
  // argument completions: \ref{..., \cite{a,b...
  if ((m = /\\([a-zA-Z]*(?:ref|cite[a-z]*|Cite[a-z]*))(?:\[[^\]]*\])*\{([^}]*?)$/.exec(before))) {
    const isCite = /cite/i.test(m[1]);
    const word = /[^,{\s]*$/.exec(m[2])[0];
    const list = isCite ? project.citations : project.labels;
    return { from: ctx.pos - word.length, options: list.map((l) => ({ label: l, type: isCite ? "text" : "variable" })), validFor: /^[^,}\s]*$/ };
  }
  if ((m = /\\(?:begin|end)\{([^}]*)$/.exec(before))) {
    return { from: ctx.pos - m[1].length, options: ENVS.map((e) => ({ label: e, type: "class" })), validFor: /^[\w*]*$/ };
  }
  if ((m = /\\usepackage(?:\[[^\]]*\])?\{([^}]*)$/.exec(before))) {
    const word = /[^,{\s]*$/.exec(m[1])[0];
    return { from: ctx.pos - word.length, options: PACKAGES.map((p) => ({ label: p, type: "namespace" })), validFor: /^[\w-]*$/ };
  }
  if ((m = /\\(?:input|include|includegraphics|addbibresource|bibliography|subfile)(?:\[[^\]]*\])?\{([^}]*)$/.exec(before))) {
    return { from: ctx.pos - m[1].length, options: project.files.map((f) => ({ label: f, type: "text" })), validFor: /^[^}]*$/ };
  }
  const w = ctx.matchBefore(/\\[a-zA-Z]*/);
  if (!w || (w.from === w.to && !ctx.explicit)) return null;
  return { from: w.from, options: cmdOptions, validFor: /^\\[a-zA-Z]*$/ };
}

// ---------- formatting helpers ----------
function wrapWith(view, before, after) {
  const tr = view.state.changeByRange((r) => {
    const text = view.state.sliceDoc(r.from, r.to);
    return {
      changes: { from: r.from, to: r.to, insert: before + text + after },
      range: r.empty ? EditorSelection.cursor(r.from + before.length) : EditorSelection.range(r.from + before.length, r.to + before.length),
    };
  });
  view.dispatch(tr, { scrollIntoView: true, userEvent: "input" });
  return true;
}
function fmtKeymap(kind) {
  if (kind === "md") return [
    { key: "Mod-b", run: (v) => wrapWith(v, "**", "**") },
    { key: "Mod-i", run: (v) => wrapWith(v, "*", "*") },
    { key: "Mod-k", run: (v) => wrapWith(v, "[", "](url)") },
    { key: "Mod-e", run: (v) => wrapWith(v, "`", "`") },
  ];
  if (kind === "tex") return [
    { key: "Mod-b", run: (v) => wrapWith(v, "\\textbf{", "}") },
    { key: "Mod-i", run: (v) => wrapWith(v, "\\textit{", "}") },
    { key: "Mod-e", run: (v) => wrapWith(v, "\\emph{", "}") },
    { key: "Mod-m", run: (v) => wrapWith(v, "$", "$") },
  ];
  return [];
}

// ---------- editor ----------
const cLang = new Compartment(), cWrap = new Compartment(), cNums = new Compartment(), cSpell = new Compartment(),
  cTab = new Compartment(), cFmt = new Compartment(), cComplete = new Compartment(), cReview = new Compartment(),
  cExtra = new Compartment();

let view = null;
// ---------- named undo steps (the Undo ▾ list) ----------
/** A name for the undo step a transaction makes ("AI: Improve writing", "Reloaded from disk"…). */
export const stepLabel = Annotation.define();
function labelOf(tr) {
  const named = tr.annotation(stepLabel);
  if (named) return named;
  if (tr.isUserEvent("input.ai")) return "AI edit";
  if (tr.isUserEvent("input.paste")) return "Paste";
  if (tr.isUserEvent("input.drop")) return "Drop";
  if (tr.isUserEvent("input.complete")) return "Autocomplete";
  if (tr.isUserEvent("input.type.compose") || tr.isUserEvent("input.type")) return "Typing";
  if (tr.isUserEvent("input")) return "Typing";
  if (tr.isUserEvent("delete.cut")) return "Cut";
  if (tr.isUserEvent("delete")) return "Delete";
  if (tr.isUserEvent("move")) return "Move text";
  return "Edit";
}
const AI_RE = /^AI\b|Claude/;
/** Labels parallel to CodeMirror's undo and redo stacks (newest last). */
const stepNames = StateField.define({
  create: () => ({ undo: [], redo: [] }),
  update(v, tr) {
    const d0 = undoDepth(tr.startState), d1 = undoDepth(tr.state);
    const r0 = redoDepth(tr.startState), r1 = redoDepth(tr.state);
    if (d0 === d1 && r0 === r1 && !tr.docChanged) return v;
    let undo = v.undo, redo = v.redo;
    if (tr.isUserEvent("undo")) {
      const n = Math.max(0, d0 - d1);
      redo = [...redo, ...undo.slice(undo.length - n).reverse()];
      undo = undo.slice(0, undo.length - n);
    } else if (tr.isUserEvent("redo")) {
      const n = Math.max(0, d1 - d0);
      undo = [...undo, ...redo.slice(redo.length - n).reverse()];
      redo = redo.slice(0, redo.length - n);
    } else if (d1 > d0) {
      const l = labelOf(tr);
      undo = [...undo, ...Array(d1 - d0).fill(l)];
    } else if (tr.docChanged && AI_RE.test(tr.annotation(stepLabel) || "") && undo.length) {
      undo = [...undo.slice(0, -1), tr.annotation(stepLabel)];
    }
    // keep them the same length as the stacks (old steps fall off, a new edit clears redo)
    if (undo.length > d1) undo = undo.slice(undo.length - d1);
    while (undo.length < d1) undo = ["Edit", ...undo];
    if (redo.length > r1) redo = redo.slice(redo.length - r1);
    while (redo.length < r1) redo = ["Edit", ...redo];
    return { undo, redo };
  },
});
/** Undo/redo list of a state: newest first. */
export function undoList(state) {
  const v = state?.field(stepNames, false);
  if (!v) return { undo: [], redo: [] };
  return { undo: [...v.undo].reverse(), redo: [...v.redo].reverse() };
}
/** Undo (or redo) the newest `n` steps in the editor. */
export function undoSteps(n, redo = false, keepFocus = false) {
  if (!view) return;
  for (let i = 0; i < n; i++) if (!(redo ? cmRedo(view) : cmUndo(view))) break;
  if (!keepFocus) view.focus();
}
/** A whole-text replacement as one named, undoable step (only the part that differs changes). */
export function replaceDocAsStep(state, text, label) {
  const old = state.doc.toString();
  if (old === text) return null;
  let a = 0;
  const max = Math.min(old.length, text.length);
  while (a < max && old.charCodeAt(a) === text.charCodeAt(a)) a++;
  let b = 0;
  while (b < max - a && old.charCodeAt(old.length - 1 - b) === text.charCodeAt(text.length - 1 - b)) b++;
  return { changes: { from: a, to: old.length - b, insert: text.slice(a, text.length - b) }, annotations: [stepLabel.of(label), isolateHistory.of("full")] };
}

let hooks = { onChange: () => {}, onCursor: () => {}, onScroll: () => {}, onSave: () => {} };
let opts = { wordWrap: true, lineNumbers: true, spellcheck: false, tabSize: 2 };

function baseExtensions(kind, extra = {}) {
  return [
    cNums.of(opts.lineNumbers ? [lineNumbers(), foldGutter()] : []),
    highlightActiveLineGutter(), highlightSpecialChars(), history(), stepNames, drawSelection(), dropCursor(),
    EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(),
    rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
    cComplete.of(kind === "tex" ? autocompletion({ override: [texCompletions], activateOnTyping: true, icons: false }) : autocompletion({ icons: false })),
    cLang.of(languageFor(kind, extra)),
    kind === "md" || kind === "tex" || kind === "bib" ? [] : codeAids({ rainbow: kind !== "csv" }),
    structLinter(kind),
    cWrap.of(opts.wordWrap ? EditorView.lineWrapping : []),
    // plain-text files always wrap, like Notepad with Word Wrap on
    kind === "text" ? EditorView.lineWrapping : [],
    cSpell.of(EditorView.contentAttributes.of({ spellcheck: opts.spellcheck ? "true" : "false", autocorrect: "off", autocapitalize: "off" })),
    cTab.of(tabExt()),
    cFmt.of(keymap.of(fmtKeymap(kind))),
    cReview.of([]),
    cExtra.of(extraExtensions(kind)),
    keymap.of([
      ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap,
      ...completionKeymap, ...lintKeymap, indentWithTab,
    ]),
    EditorView.updateListener.of((u) => {
      if (reviewing && (u.docChanged || u.transactions.some((tr) => tr.effects.length))) checkReview(u.view);
      if (u.docChanged) hooks.onChange(u);
      if (u.selectionSet || u.docChanged) hooks.onCursor(u.state);
      if (u.transactions.length && (u.docChanged || u.transactions.some((tr) => tr.isUserEvent("undo") || tr.isUserEvent("redo")))) window.dispatchEvent(new Event("callio-undo"));
    }),
    EditorView.domEventHandlers({ scroll: () => hooks.onScroll() }),
  ];
}

export function initEditor(parent, h) {
  hooks = { ...hooks, ...h };
  view = new EditorView({ parent, state: EditorState.create({ doc: "" }) });
  return view;
}

/** extra: { delim } for CSV/TSV. */
export function createState(text, kind, extra) {
  return EditorState.create({ doc: text, extensions: baseExtensions(kind, extra) });
}

export function getView() { return view; }

export function setState(state) { view.setState(state); }

export function applyOptions(o) {
  opts = { ...opts, ...o };
  if (!view) return;
  view.dispatch({ effects: optionEffects() });
}
export function optionEffects() {
  return [
    cWrap.reconfigure(opts.wordWrap ? EditorView.lineWrapping : []),
    cNums.reconfigure(opts.lineNumbers ? [lineNumbers(), foldGutter()] : []),
    cSpell.reconfigure(EditorView.contentAttributes.of({ spellcheck: opts.spellcheck ? "true" : "false", autocorrect: "off", autocapitalize: "off" })),
    cTab.reconfigure(tabExt()),
  ];
}
/** Bring a stored (inactive) state up to date with current options; `indent`: the tab's own. */
export function refreshStateOptions(state, indent) {
  tabIndent = indent ?? null;
  return state.update({ effects: optionEffects() }).state;
}
// the indentation of the file being edited: 2, 4 or "tab" (null: the setting)
let tabIndent = null;
function tabExt() {
  const u = tabIndent ?? opts.tabSize;
  return [EditorState.tabSize.of(u === "tab" ? opts.tabSize : +u || opts.tabSize), indentUnit.of(u === "tab" ? "\t" : " ".repeat(+u || opts.tabSize))];
}
/** Use `indent` (2, 4, "tab") in the editor now. */
export function setIndent(indent) {
  tabIndent = indent ?? null;
  view?.dispatch({ effects: cTab.reconfigure(tabExt()) });
}

export function gotoLine(line, col = 0, flash = true) {
  if (!view) return;
  const doc = view.state.doc;
  const ln = doc.line(Math.max(1, Math.min(line, doc.lines)));
  const pos = Math.min(ln.from + col, ln.to);
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  view.focus();
  if (flash) {
    requestAnimationFrame(() => {
      const dom = view.domAtPos(ln.from).node;
      const el = dom.nodeType === 1 ? dom.closest?.(".cm-line") : dom.parentElement?.closest(".cm-line");
      if (el) { el.classList.remove("flash-line"); void el.offsetWidth; el.classList.add("flash-line"); }
    });
  }
}

export function showDiagnostics(state, diags) {
  const doc = state.doc;
  const list = diags.filter((d) => d.line > 0 && d.line <= doc.lines).map((d) => {
    const l = doc.line(d.line);
    return { from: l.from, to: l.to, severity: d.severity === "error" ? "error" : "warning", message: d.message, source: "LaTeX" };
  });
  return state.update(setDiagnostics(state, list)).state;
}

export function topVisibleLine() {
  if (!view) return 1;
  const rect = view.scrollDOM.getBoundingClientRect();
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop + 4);
  void rect;
  const line = view.state.doc.lineAt(block.from).number;
  // fractional progress within that line block for smoother sync
  const frac = (view.scrollDOM.scrollTop - block.top) / Math.max(1, block.height);
  return line + Math.max(0, Math.min(1, frac));
}

/** Scroll so source line `line` (fractional) is at the top, without moving the cursor. */
export function scrollToLine(line) {
  if (!view) return;
  const n = Math.max(1, Math.min(view.state.doc.lines, Math.floor(line)));
  const l = view.state.doc.line(n);
  const block = view.lineBlockAt(l.from);
  view.scrollDOM.scrollTop = block.top + (line - n) * block.height;
}

/** The scrollTop that puts source line `line` (fractional) at the top. */
export function editorLineTop(line) {
  if (!view) return null;
  const n = Math.max(1, Math.min(view.state.doc.lines, Math.floor(line)));
  const block = view.lineBlockAt(view.state.doc.line(n).from);
  return block.top + (line - n) * block.height;
}

export function cursorLine() {
  if (!view) return 1;
  return view.state.doc.lineAt(view.state.selection.main.head).number;
}

// ---------- extra extensions supplied by other modules (AI ghost text, lint) ----------
let extraFactories = [];
function extraExtensions(kind) { return extraFactories.map((f) => f(kind)).filter(Boolean); }
/** Register an extension factory (kind → extension) applied to every editor state. */
export function addEditorExtension(factory) {
  extraFactories.push(factory);
  view?.dispatch({ effects: cExtra.reconfigure(extraExtensions(currentKind())) });
}
export function reapplyExtras() {
  view?.dispatch({ effects: cExtra.reconfigure(extraExtensions(currentKind())) });
}
export function refreshExtraExtensions(state, kind) {
  return state.update({ effects: cExtra.reconfigure(extraExtensions(kind)) }).state;
}
let kindGetter = () => "text";
export function setKindGetter(f) { kindGetter = f; }
const currentKind = () => kindGetter();

// ---------- reviewing AI changes as an inline diff ----------
let reviewing = false;
let reviewLabel = null;
/** The name the next AI suggestion gets in the Undo list. */
export function setReviewLabel(l) { reviewLabel = l; }
let reviewHooks = { onChange: () => {}, onEnd: () => {} };
export function setReviewHooks(h) { reviewHooks = { ...reviewHooks, ...h }; }

/**
 * Replace [from, to) with `text` and show the change as an inline diff whose chunks can be
 * accepted or rejected one by one (buttons appear on each changed block).
 */
export function startReview(from, to, text) {
  const v = view;
  if (reviewing) endReview(true);
  const original = v.state.doc;
  v.dispatch({ effects: cReview.reconfigure(unifiedMergeView({ original, mergeControls: true, highlightChanges: true, gutter: true, syntaxHighlightDeletions: true })) });
  v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from }, scrollIntoView: true, userEvent: "input.ai", annotations: [stepLabel.of(reviewLabel || "AI edit"), isolateHistory.of("full")] });
  reviewLabel = null;
  reviewing = true;
  checkReview(v);
}
export function reviewCount() {
  if (!reviewing || !view) return 0;
  return getChunks(view.state)?.chunks.length ?? 0;
}
function checkReview(v) {
  const n = getChunks(v.state)?.chunks.length ?? 0;
  reviewHooks.onChange(n);
  if (n === 0) queueMicrotask(() => endReview(true));
}
/** accept=true keeps the AI text, false restores the original. */
export function endReview(accept) {
  if (!reviewing || !view) return;
  reviewing = false;
  if (!accept) {
    const orig = getOriginalDoc(view.state);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: orig }, userEvent: "input.ai", annotations: stepLabel.of("Discard AI suggestion") });
  }
  view.dispatch({ effects: cReview.reconfigure([]) });
  reviewHooks.onEnd(accept);
}
export const isReviewing = () => reviewing;

export function getSelectionInfo() {
  if (!view) return null;
  const { from, to } = view.state.selection.main;
  return { from, to, text: view.state.sliceDoc(from, to), doc: view.state.doc };
}
