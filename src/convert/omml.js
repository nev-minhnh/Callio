// Office Math (OMML) -> LaTeX, best effort. Shared by DOCX/PPTX converters.
import { kids, kid, attr } from "./util.js";

const SYM = {
  "α": "\\alpha", "β": "\\beta", "γ": "\\gamma", "δ": "\\delta", "ε": "\\epsilon", "ϵ": "\\epsilon", "ζ": "\\zeta", "η": "\\eta",
  "θ": "\\theta", "ϑ": "\\vartheta", "ι": "\\iota", "κ": "\\kappa", "λ": "\\lambda", "μ": "\\mu", "ν": "\\nu", "ξ": "\\xi",
  "π": "\\pi", "ϖ": "\\varpi", "ρ": "\\rho", "ϱ": "\\varrho", "σ": "\\sigma", "ς": "\\varsigma", "τ": "\\tau", "υ": "\\upsilon",
  "φ": "\\phi", "ϕ": "\\phi", "χ": "\\chi", "ψ": "\\psi", "ω": "\\omega", "Γ": "\\Gamma", "Δ": "\\Delta", "Θ": "\\Theta",
  "Λ": "\\Lambda", "Ξ": "\\Xi", "Π": "\\Pi", "Σ": "\\Sigma", "Υ": "\\Upsilon", "Φ": "\\Phi", "Ψ": "\\Psi", "Ω": "\\Omega",
  "∞": "\\infty", "±": "\\pm", "∓": "\\mp", "×": "\\times", "÷": "\\div", "·": "\\cdot", "⋅": "\\cdot", "∗": "\\ast",
  "≤": "\\leq", "≥": "\\geq", "≠": "\\neq", "≈": "\\approx", "≡": "\\equiv", "∼": "\\sim", "≃": "\\simeq", "≅": "\\cong",
  "∝": "\\propto", "≪": "\\ll", "≫": "\\gg", "∈": "\\in", "∉": "\\notin", "∋": "\\ni", "⊂": "\\subset", "⊃": "\\supset",
  "⊆": "\\subseteq", "⊇": "\\supseteq", "∪": "\\cup", "∩": "\\cap", "∅": "\\emptyset", "∀": "\\forall", "∃": "\\exists",
  "¬": "\\neg", "∧": "\\wedge", "∨": "\\vee", "→": "\\rightarrow", "←": "\\leftarrow", "↔": "\\leftrightarrow",
  "⇒": "\\Rightarrow", "⇐": "\\Leftarrow", "⇔": "\\Leftrightarrow", "↦": "\\mapsto", "∂": "\\partial", "∇": "\\nabla",
  "√": "\\surd", "∠": "\\angle", "°": "^{\\circ}", "′": "'", "″": "''", "…": "\\ldots", "⋯": "\\cdots", "⋮": "\\vdots",
  "⋱": "\\ddots", "ℝ": "\\mathbb{R}", "ℕ": "\\mathbb{N}", "ℤ": "\\mathbb{Z}", "ℚ": "\\mathbb{Q}", "ℂ": "\\mathbb{C}",
  "ℓ": "\\ell", "ℏ": "\\hbar", "⊥": "\\perp", "∥": "\\parallel", "⊕": "\\oplus", "⊗": "\\otimes", "∘": "\\circ",
  "⟨": "\\langle", "⟩": "\\rangle", "⌈": "\\lceil", "⌉": "\\rceil", "⌊": "\\lfloor", "⌋": "\\rfloor", "−": "-",
  "∑": "\\sum", "∏": "\\prod", "∫": "\\int", "∬": "\\iint", "∭": "\\iiint", "∮": "\\oint", "⋃": "\\bigcup", "⋂": "\\bigcap",
  "⁡": "", "⁢": "", "⁣": "", "​": "",
};
const NARY = { "∑": "\\sum", "∏": "\\prod", "∐": "\\coprod", "∫": "\\int", "∬": "\\iint", "∭": "\\iiint", "∮": "\\oint", "⋃": "\\bigcup", "⋂": "\\bigcap", "⋁": "\\bigvee", "⋀": "\\bigwedge" };
const ACC = { "̂": "\\hat", "^": "\\hat", "̃": "\\tilde", "~": "\\tilde", "̄": "\\bar", "¯": "\\bar", "̇": "\\dot", "̈": "\\ddot", "⃗": "\\vec", "→": "\\vec", "́": "\\acute", "̀": "\\grave", "̆": "\\breve", "̌": "\\check" };
const FUNCS = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "log", "ln", "lg", "exp", "lim", "max", "min", "sup", "inf", "det", "dim", "ker", "deg", "arg", "gcd", "Pr"]);
const DELIM = { "(": "(", ")": ")", "[": "[", "]": "]", "{": "\\{", "}": "\\}", "|": "|", "‖": "\\|", "∥": "\\|", "⟨": "\\langle", "⟩": "\\rangle", "⌈": "\\lceil", "⌉": "\\rceil", "⌊": "\\lfloor", "⌋": "\\rfloor", "": "." };

const val = (el, name) => attr(kid(el, name), "m:val");
const g = (s) => (s.length === 1 || /^\\[a-zA-Z]+$/.test(s) ? s : `{${s}}`);

function text(s) {
  let out = "";
  for (const ch of s) {
    if (SYM[ch] != null) out += SYM[ch] + (/^\\[a-zA-Z]+$/.test(SYM[ch]) ? " " : "");
    else if ("{}#%&_$".includes(ch)) out += "\\" + ch;
    else out += ch;
  }
  return out;
}

export function ommlToLatex(el) {
  return node(el).replace(/\s+/g, " ").replace(/ ([}^_)\],])/g, "$1").trim();
}

function all(el) { return kids(el).map(node).join(""); }
function sub(el, name) { const c = kid(el, name); return c ? all(c) : ""; }

function node(el) {
  switch (el.localName) {
    case "oMathPara": return kids(el, "oMath").map(node).join(" \\\\ ");
    case "oMath": case "e": case "num": case "den": case "deg": case "sub": case "sup": case "lim": case "fName": case "box": case "borderBox": case "phant":
      return all(el);
    case "r": {
      let t = kids(el, "t").map((x) => x.textContent).join("");
      const rpr = kid(el, "rPr");
      const plain = rpr && kid(rpr, "nor");
      if (plain || (t.length > 1 && /^[A-Za-z]+$/.test(t) && !FUNCS.has(t) && /[a-z]{3,}/.test(t) && rpr && val(rpr, "sty") === "p")) return `\\text{${t}}`;
      if (FUNCS.has(t)) return `\\${t} `;
      const sty = rpr ? val(rpr, "sty") : null;
      const scr = rpr ? val(rpr, "scr") : null;
      let s = text(t);
      if (scr === "double-struck") s = `\\mathbb{${s}}`;
      else if (scr === "script") s = `\\mathcal{${s}}`;
      else if (scr === "fraktur") s = `\\mathfrak{${s}}`;
      else if (sty === "b" || sty === "bi") s = `\\mathbf{${s}}`;
      return s;
    }
    case "f": {
      const type = val(kid(el, "fPr"), "type");
      const n = sub(el, "num"), d = sub(el, "den");
      if (type === "lin") return `${g(n)}/${g(d)}`;
      if (type === "noBar") return `\\genfrac{}{}{0pt}{}{${n}}{${d}}`;
      return `\\frac{${n}}{${d}}`;
    }
    case "sSup": return `${g(sub(el, "e"))}^{${sub(el, "sup")}}`;
    case "sSub": return `${g(sub(el, "e"))}_{${sub(el, "sub")}}`;
    case "sSubSup": return `${g(sub(el, "e"))}_{${sub(el, "sub")}}^{${sub(el, "sup")}}`;
    case "sPre": return `{}_{${sub(el, "sub")}}^{${sub(el, "sup")}}${g(sub(el, "e"))}`;
    case "rad": {
      const deg = sub(el, "deg");
      return deg ? `\\sqrt[${deg}]{${sub(el, "e")}}` : `\\sqrt{${sub(el, "e")}}`;
    }
    case "nary": {
      const pr = kid(el, "naryPr");
      const chr = val(pr, "chr") || "∫";
      let op = NARY[chr] || text(chr);
      const lo = sub(el, "sub"), hi = sub(el, "sup");
      if (lo) op += `_{${lo}}`;
      if (hi) op += `^{${hi}}`;
      return op + " " + sub(el, "e");
    }
    case "d": {
      const pr = kid(el, "dPr");
      const beg = val(pr, "begChr") ?? "(";
      const end = val(pr, "endChr") ?? ")";
      const sep = val(pr, "sepChr") ?? "|";
      const parts = kids(el, "e").map(all);
      const L = DELIM[beg] ?? text(beg), R = DELIM[end] ?? text(end);
      return `\\left${L}${parts.join(sep === "|" ? " \\mid " : text(sep))}\\right${R}`;
    }
    case "func": return `${sub(el, "fName").trim()} ${g(sub(el, "e"))}`;
    case "acc": {
      const chr = val(kid(el, "accPr"), "chr") || "̂";
      return `${ACC[chr] || "\\hat"}{${sub(el, "e")}}`;
    }
    case "bar": {
      const pos = val(kid(el, "barPr"), "pos");
      return pos === "bot" ? `\\underline{${sub(el, "e")}}` : `\\overline{${sub(el, "e")}}`;
    }
    case "groupChr": {
      const pr = kid(el, "groupChrPr");
      const chr = val(pr, "chr") || "⏟";
      const pos = val(pr, "pos") || "bot";
      if (chr === "⏞" || pos === "top") return `\\overbrace{${sub(el, "e")}}`;
      if (chr === "→") return `\\xrightarrow{${sub(el, "e")}}`;
      return `\\underbrace{${sub(el, "e")}}`;
    }
    case "limLow": {
      const e = sub(el, "e").trim();
      return `${/^\\(lim|max|min|sup|inf)/.test(e) ? e : `\\underset{${sub(el, "lim")}}{${e}}`}${/^\\(lim|max|min|sup|inf)/.test(e) ? `_{${sub(el, "lim")}}` : ""}`;
    }
    case "limUpp": return `\\overset{${sub(el, "lim")}}{${sub(el, "e")}}`;
    case "m": {
      const rows = kids(el, "mr").map((mr) => kids(mr, "e").map(all).join(" & "));
      return `\\begin{matrix}${rows.join(" \\\\ ")}\\end{matrix}`;
    }
    case "eqArr": return `\\begin{aligned}${kids(el, "e").map(all).join(" \\\\ ")}\\end{aligned}`;
    case "t": return text(el.textContent);
    case "ctrlPr": case "rPr": case "fPr": case "dPr": case "naryPr": case "accPr": case "barPr": case "sSupPr": case "sSubPr":
    case "sSubSupPr": case "radPr": case "funcPr": case "mPr": case "eqArrPr": case "limLowPr": case "limUpp Pr": case "groupChrPr":
    case "argPr": case "oMathParaPr": case "boxPr": case "borderBoxPr": case "sPrePr": case "phantPr": case "limUppPr":
      return "";
    default: return all(el);
  }
}
