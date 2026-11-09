// Browser-only mock backend for UI development and testing (not used in the app).
const files = new Map([
  ["C:/demo/README.md", `# Callio demo

Some **bold** text, \`code\` and math $e^{i\\pi} + 1 = 0$.

$$
\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}
$$

- [x] Markdown preview
- [ ] LaTeX

\`\`\`rust
fn main() { println!("hi"); }
\`\`\`

| # | Location | Current | Proposed | Category | Severity |
|---|---|---|---|---|---|
| C1 | L202 | \`\\citet{mendelsohn2023framework} cross-cultural hate typology\` | Delete the clause. The paper does not exist: its DOI belongs to another dataset. Remove the entry from the \`.bib\` too. | citation | critical |
| C2 | L175, L205 | "Bourgeade et al. (2024) pioneered entity-level extraction by fine-tuning SpanBERT on 5,019 Twitter posts" | Tell me the source of this description; until verified write \`\\citeneeded{entity-level hate span extraction baseline}\` | citation | critical |
`],
  ["C:/demo/main.tex", `\\documentclass{article}
\\usepackage{amsmath}
\\title{Demo}
\\begin{document}
\\maketitle
\\section{Introduction}\\label{sec:intro}
Hello, world! See Section~\\ref{sec:intro} and \\cite{knuth}.
\\begin{equation}
  E = mc^2
\\end{equation}
\\subsection{More}
Text.
\\end{document}
`],
  ["C:/demo/paper.pdf", ""],
  ["C:/demo/analysis.ipynb", "{\n \"cells\": [\n  {\n   \"cell_type\": \"markdown\",\n   \"id\": \"a1\",\n   \"metadata\": {},\n   \"source\": [\n    \"# Analysis\\n\",\n    \"Some **notes** and math $x^2$.\"\n   ]\n  },\n  {\n   \"cell_type\": \"code\",\n   \"execution_count\": 1,\n   \"id\": \"a2\",\n   \"metadata\": {},\n   \"outputs\": [\n    {\n     \"name\": \"stdout\",\n     \"output_type\": \"stream\",\n     \"text\": [\n      \"hello\\n\",\n      \"world\\n\"\n     ]\n    }\n   ],\n   \"source\": [\n    \"import pandas as pd\\n\",\n    \"print('hello')\\n\",\n    \"print('world')\"\n   ]\n  },\n  {\n   \"cell_type\": \"code\",\n   \"execution_count\": 2,\n   \"id\": \"a3\",\n   \"metadata\": {},\n   \"outputs\": [\n    {\n     \"data\": {\n      \"text/html\": [\n       \"<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>\"\n      ],\n      \"text/plain\": [\n       \"   a  b\\n\",\n       \"0  1  2\"\n      ]\n     },\n     \"execution_count\": 2,\n     \"metadata\": {},\n     \"output_type\": \"execute_result\"\n    }\n   ],\n   \"source\": [\n    \"df = pd.DataFrame({'a':[1],'b':[2]})\\n\",\n    \"df\"\n   ]\n  },\n  {\n   \"cell_type\": \"code\",\n   \"execution_count\": 3,\n   \"id\": \"a4\",\n   \"metadata\": {},\n   \"outputs\": [\n    {\n     \"data\": {\n      \"image/png\": \"iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFklEQVR42mNk+M9Qz0AEYBxVSF+FAP0gCAEcJ0xNAAAAAElFTkSuQmCC\",\n      \"text/plain\": [\n       \"<Figure>\"\n      ]\n     },\n     \"metadata\": {},\n     \"output_type\": \"display_data\"\n    }\n   ],\n   \"source\": [\n    \"plt.plot([1,2,3])\"\n   ]\n  },\n  {\n   \"cell_type\": \"code\",\n   \"execution_count\": 4,\n   \"id\": \"a5\",\n   \"metadata\": {},\n   \"outputs\": [\n    {\n     \"ename\": \"ZeroDivisionError\",\n     \"evalue\": \"division by zero\",\n     \"output_type\": \"error\",\n     \"traceback\": [\n      \"\\u001b[31mZeroDivisionError\\u001b[0m Traceback\",\n      \"1/0\"\n     ]\n    }\n   ],\n   \"source\": [\n    \"1/0\"\n   ]\n  }\n ],\n \"metadata\": {\n  \"kernelspec\": {\n   \"display_name\": \"Python 3\",\n   \"language\": \"python\",\n   \"name\": \"python3\"\n  },\n  \"language_info\": {\n   \"name\": \"python\"\n  }\n },\n \"nbformat\": 4,\n \"nbformat_minor\": 5\n}\n"],
  ["C:/demo/writing_references/34675515-TheAnhTang-JulianGarcia-Non_atomic_Games_on_Bounded_Intervals_long_name.md", "# Long name"],
  ["C:/demo/paper2.tex", "\\documentclass[review]{elsarticle}\n\\usepackage{amsmath,graphicx,booktabs}\n\\usepackage{todonotes}\n\\journal{Information Processing \\& Management}\n\\begin{document}\n\\begin{frontmatter}\n\\title{Automated Extraction and Detection of Hate Speech Categories across Social Media Platforms using Named Entity Recognition}\n\\author{Huu Minh Nguyen\\textsuperscript{1}, Thanh Thi Nguyen\\textsuperscript{1,2}, Carsten Rudolph\\textsuperscript{1}}\n%\\cortext[cor1]{Corresponding author}\n\\address{$^1$Faculty of Information Technology, Monash University, Clayton, 3800, VIC, Australia}\n\\address{$^2$School of Science, Technology and Engineering, University of the Sunshine Coast, Moreton Bay, 4502, QLD, Australia}\n\\begin{abstract}\nHate speech detection systems typically assign a single label to a whole post, which hides \\emph{what} is targeted and \\emph{how}. We extract span-level categories with GLiNER and compare it with fine-tuned BERT taggers.\n\\end{abstract}\n\\begin{keyword}\nhate speech \\sep named entity recognition \\sep GLiNER \\sep span extraction\n\\end{keyword}\n\\end{frontmatter}\n\n\\section{Introduction}\\label{sec:intro}\nOnline hate speech remains a persistent problem~\\cite{kennedy2022introducing,mathew2021hatexplain}. Prior work in Table~\\ref{tab:datasets} focuses on post-level labels.\\todo{Add 2024 survey}\n\n\\subsection{Statistical n-gram scoring}\\label{subsec_statistical_ngram}\nWe extract distinctive hate-related n-grams by combining Pointwise Mutual Information (PMI), Term Frequency--Inverse Document Frequency (\\tfidf) and raw frequency.\n\\begin{equation}\\label{eq:pmi}\n\\mathrm{PMI}(g) = \\log\\left(\\frac{P(g \\mid \\text{hate})}{P(g \\mid \\text{corpus})}\\right),\n\\end{equation}\nwhere $P(g\\mid\\text{hate})$ is the probability of $g$ appearing in hate-labelled documents.\n\n\\begin{figure}[t]\n\\centering\n\\includegraphics[width=0.8\\linewidth]{fig5.pdf}\n\\caption{Distribution of the GHC's top-level labels across the eight protected-characteristic categories.}\\label{fig:ghc_labels}\n\\end{figure}\n\n\\begin{table*}[t]\n\\centering\n\\caption{Datasets used in this study with their sizes, platforms and label sets.}\\label{tab:datasets}\n\\begin{tabular}{llrrl}\n\\toprule\nDataset & Platform & Posts & Hateful & Label set \\\\\n\\midrule\nGHC & Gab & 27,665 & 2,366 & HD, CV, VO + 8 target groups \\\\\nHateXplain & Twitter/Gab & 20,148 & 5,935 & hate, offensive, normal + rationales \\\\\n\\bottomrule\n\\end{tabular}\n\\end{table*}\n\n\\begin{itemize}\n\\item First item with a long sentence that should wrap across lines in the visual editor page.\n\\item Second item.\n\\end{itemize}\n\\end{document}\n"],
  ["C:/demo/ocr.md", "<!-- OCR of Screenshot 2026-11-02 180136.png (Claude Code (your Claude plan)). Check and correct it, then Save, or Save \u25be \u2192 Export as PDF / Markdown. -->\n\n# GPT-NER: Named Entity Recognition via Large Language Models\n\nShuhe Wang, Xiaofei Sun, Xiaoya Li, Rongbin Ouyang, Fei Wu, Tianwei Zhang, Jiwei Li, Guoyin Wang, Chen Guo\n\n## Abstract\n\nDespite the fact that large-scale Language Models (LLM) have achieved SOTA performances on a variety of NLP tasks, its performance on NER is still significantly below supervised baselines. This is due to the gap between the two tasks the NER and LLMs: the former is a sequence labeling task in nature while the latter is a text-generation model. In this paper, we propose GPT-NER to resolve this issue. GPT-NER bridges the gap by transforming the sequence labeling task to a generation task that can be easily adapted by LLMs e.g., the task of finding location entities in the input text \"Columbus is a city\" is transformed to generate the text sequence \"@@Columbus## is a city\", where special tokens @@## marks the entity to extract. To efficiently address the *hallucination* issue of LLMs.\n\n**Anthology ID:** 2025.findings-naacl.239\n\n**Volume:** Findings of the Association for Computational Linguistics: NAACL 2025\n\n**Month:** April\n\n**Year:** 2025\n\n- First item that is fairly long and wraps onto a second line when the pane is narrow enough\n- Second item\n- [x] Done task\n\n| Model | F1 | Notes |\n|---|---|---|\n| GPT-NER | 90.9 | few-shot with self-verification and kNN demonstrations |\n| BERT | 92.4 | supervised |\n\n$$\nE = mc^2 + \\int_0^1 x\\,dx\n$$\n\n```python\ndef f(x):\n    return x * 2\n```\n\n> A quote that is also reasonably long so it wraps across lines in the narrow pane of the split view.\n\nFinal paragraph with `inline code` and a [link](https://example.com).\n\n## Section 0\n\nParagraph 0 lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur \n\n## Section 1\n\nParagraph 1 lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur \n\n## Section 2\n\nParagraph 2 lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur \n\n## Section 3\n\nParagraph 3 lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur \n\n## Section 4\n\nParagraph 4 lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur \n\n## Section 5\n\nParagraph 5 lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur \n\n## Section 6\n\nParagraph 6 lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur \n\n## Section 7\n\nParagraph 7 lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur \n\n## Section 8\n\nParagraph 8 lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur \n\n## Section 9\n\nParagraph 9 lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur \n\n## Section 10\n\nParagraph 10 lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur \n\n## Section 11\n\nParagraph 11 lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur lorem ipsum dolor sit amet consectetur "],
  ["C:/demo/t.tex", "\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n\\section{Section 1}\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\n\\begin{equation}\nE=mc^2\n\\end{equation}\n\n\\section{Section 2}\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\n\\begin{equation}\nE=mc^2\n\\end{equation}\n\n\\section{Section 3}\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\n\\begin{figure}[t]\n\\centering\n\\rule{0.6\\linewidth}{4cm}\n\\caption{A figure.}\n\\end{figure}\n\n\\begin{equation}\nE=mc^2\n\\end{equation}\n\n\\section{Section 4}\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\n\\begin{equation}\nE=mc^2\n\\end{equation}\n\n\\section{Section 5}\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\n\\begin{equation}\nE=mc^2\n\\end{equation}\n\n\\section{Section 6}\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\n\\begin{figure}[t]\n\\centering\n\\rule{0.6\\linewidth}{4cm}\n\\caption{A figure.}\n\\end{figure}\n\n\\begin{equation}\nE=mc^2\n\\end{equation}\n\n\\section{Section 7}\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\n\\begin{equation}\nE=mc^2\n\\end{equation}\n\n\\section{Section 8}\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n\n\\begin{equation}\nE=mc^2\n\\end{equation}\n\\end{document}\n"],
  ["C:/demo/refs.bib", `@book{knuth, title={The TeXbook}, author={Knuth}, year={1984}}`],
]);
let settings = null;
const secrets = {};

const listeners = {};
let cancel = false;
export async function listen(name, cb) {
  (listeners[name] ||= []).push(cb);
  return () => { listeners[name] = listeners[name].filter((x) => x !== cb); };
}
const emit = (name, payload) => (listeners[name] || []).forEach((cb) => cb({ payload }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let installed = { tectonic: false, tinytex: false };
const hist = {};

const libPapers = [
  { id: "p1", key: "vaswani2017attention", title: "Attention Is All You Need", authors: ["Vaswani, Ashish", "Shazeer, Noam", "Parmar, Niki"], year: 2017, type: "inproceedings", venue: "Advances in Neural Information Processing Systems", volume: "30", issue: "", pages: "5998-6008", publisher: "", doi: "", arxiv: "1706.03762", url: "https://arxiv.org/abs/1706.03762", abstract: "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.", tags: ["transformers"], collections: ["c1"], notes: "", added: 1, modified: 1, pdf: true, text: true, pageCount: 15, usedIn: ["C:/demo/main.tex"] },
  { id: "p2", key: "devlin2019bert", title: "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding", authors: ["Devlin, Jacob", "Chang, Ming-Wei"], year: 2019, type: "inproceedings", venue: "NAACL", volume: "", issue: "", pages: "4171-4186", publisher: "ACL", doi: "10.18653/v1/N19-1423", arxiv: "", url: "", abstract: "We introduce BERT.", tags: [], collections: [], notes: "", added: 2, modified: 2, pdf: true, text: false, pageCount: 0, usedIn: [] },
  { id: "p3", key: "zaratiana2024gliner", title: "GLiNER: Generalist Model for Named Entity Recognition using Bidirectional Transformer", authors: ["Zaratiana, Urchade"], year: 2024, type: "inproceedings", venue: "NAACL", volume: "", issue: "", pages: "", publisher: "", doi: "10.18653/v1/2024.naacl-long.300", arxiv: "", url: "", abstract: "Named Entity Recognition (NER) is essential.", tags: ["ner"], collections: ["c1"], notes: "", added: 3, modified: 3, pdf: false, text: false, pageCount: 0, usedIn: [] },
];
const libCols = [{ id: "c1", name: "Thesis — NER", parent: null, drafts: [] }];
const bibOf = (p) => `@${p.type}{${p.key},\n  title = {{${p.title}}},\n  author = {${p.authors.join(" and ")}},\n  year = {${p.year}}${p.doi ? `,\n  doi = {${p.doi}}` : ""}\n}\n`;
let lastReq = null;
const memPins = [], memTraces = [], memMeta = { project: "C:/demo", ccSession: "old-session", ccSessionAt: Date.now() - 86400000 };
let ccInstalled = false, ccSeq = 0, ghInstalled = [];
const ccReplies = new Map();

export async function invoke(cmd, a, opts) {
  await new Promise((r) => setTimeout(r, 30));
  // the dev bridge (vite.config.js): the real office engine and real files under /
  const real = (p) => typeof p === "string" && p.startsWith("/");
  if (cmd === "write_binary" && opts?.headers?.["x-path"]) {
    const p = new TextDecoder().decode(new Uint8Array(opts.headers["x-path"].match(/../g).map((h) => parseInt(h, 16))));
    if (real(p)) { await fetch("/__fs?path=" + encodeURIComponent(p), { method: "POST", body: a }); return Date.now(); }
  }
  if (cmd === "write_text" && real(a.path)) { const { encodeText } = await import("./textenc.js"); await fetch("/__fs?path=" + encodeURIComponent(a.path), { method: "POST", body: encodeText(a.text, a.encoding) }); return Date.now(); }
  if (cmd === "read_text" && real(a.path)) {
    const r = await fetch("/__fs?path=" + encodeURIComponent(a.path)); if (!r.ok) throw await r.text();
    const { decodeBytes } = await import("./textenc.js");
    const [text, encoding] = decodeBytes(new Uint8Array(await r.arrayBuffer()), a.encoding, "windows-1252");
    return { text, mtime: 1, encoding };
  }
  if (cmd === "system_ansi") return "windows-1252";
  if (cmd === "list_dir" && real(a.path)) { const r = await fetch("/__ls?path=" + encodeURIComponent(a.path)); if (!r.ok) throw await r.text(); return await r.json(); }
  if (cmd === "path_info" && real(a.path)) return await (await fetch("/__stat?path=" + encodeURIComponent(a.path))).json();
  if (cmd === "compare_dirs") return await (await fetch(`/__cmpdir?a=${encodeURIComponent(a.a)}&b=${encodeURIComponent(a.b)}`)).json();
  if (cmd === "file_mtime" && real(a.path)) return 1;
  if (cmd === "office") { const v = await (await fetch("/__office", { method: "POST", body: JSON.stringify(a) })).json(); if (!v.ok) throw v.error; return v.result; }
  if (cmd === "office_temp") return `/tmp/callio-office-dev/${Date.now()}-${a.name}`;
  if (cmd === "office_available") return true;
  if (cmd === "pick_files") return window.__pickFiles?.shift?.() || [];
  if (cmd === "read_binary" && real(a.path)) { const r = await fetch("/__fs?path=" + encodeURIComponent(a.path)); if (!r.ok) throw await r.text(); return await r.arrayBuffer(); }
  if (cmd === "pick_save_file" && window.__saveDir) return `${window.__saveDir}/${a.defaultName}`;
  if (cmd === "pick_folder" && window.__saveDir) return window.__saveDir;
  switch (cmd) {
    case "startup_paths": return [];
    case "cc_status": return { installed: ccInstalled, path: "C:/Users/me/.local/bin/claude.exe", version: "2.1.314 (Claude Code)", loggedIn: ccInstalled, auth: { loggedIn: ccInstalled, authMethod: "claude.ai", email: "minh@example.com" }, gitBash: false };
    case "cc_install": for (const l of ["Setting up Claude Code...", "Downloading 2.1.314", "✔ Claude Code successfully installed!"]) { emit("cc-install", l); await sleep(200); } ccInstalled = true; return null;
    case "cc_login": case "cc_logout": return null;
    case "cc_skills": return [{ name: "academic-paper-writing", description: "Write and revise papers in the house voice", path: "C:/Users/me/.claude/skills/academic-paper-writing/SKILL.md", source: "personal", kind: "skill" }, { name: "review", description: "Review the current changes", path: "C:/Users/me/.claude/commands/review.md", source: "personal", kind: "command" }];
    case "mock_last_req": return lastReq;
    case "export_html_pdf": window.__exportHtml = a.html; window.__exportOut = a.out; return 1;
    case "export_copy_pdf": window.__exportCopy = [a.src, a.out]; return 1;
    case "mem_recall": return { text: memPins.length || memTraces.length ? "# Memory of this project\n" + memPins.map((p) => "- " + p.text).join("\n") : "", skills: ["julian-style-guide"], turns: memTraces.length, meta: memMeta };
    case "mem_record": memTraces.push(...a.entries.map((e, i) => ({ ...e, id: "t" + Date.now() + i, t: Date.now(), session: a.session }))); return null;
    case "mem_pin": { const p = { id: "p" + Date.now(), t: Date.now(), text: a.text }; memPins.push(p); return p; }
    case "rename_path": { const to = a.from.replace(/[^/\\]+$/, a.name); if (files.has(a.from)) { files.set(to, files.get(a.from)); files.delete(a.from); } return to; }
    case "ocr_engines": return { windows: true, windowsLanguages: ["en-US", "vi"], tesseract: null, tesseractLanguages: [], claudeCode: true, anthropicKey: false, geminiKey: true };
    case "ocr_local": return [{ width: 1000, height: 1400, lines: [{ text: "1. Introduction", words: [{ t: "1.", x: 100, y: 100, w: 30, h: 40 }, { t: "Introduction", x: 140, y: 100, w: 300, h: 40 }] }, { text: "Scanned text line one of the page", words: [{ t: "Scanned text line one of the page", x: 100, y: 180, w: 700, h: 24 }] }, { text: "continues here.", words: [{ t: "continues here.", x: 100, y: 212, w: 300, h: 24 }] }] }];
    case "ocr_vision": return "# Page\n\nRecognised by a model.";
    case "write_binary": window.__savedPdf = a; return 2;
    case "file_mtime": return 1;
    case "pick_convert_file": return "C:/demo/paper.pdf";
    case "pick_image": return "C:/demo/figs/plot.png";
    case "sess_list": return Object.entries(window.__sess ||= {}).filter(([k]) => k.startsWith(a.project + "|")).map(([k, v]) => ({ id: k.split("|")[1], title: v.title, created: v.created, updated: v.updated, count: v.history.length, model: v.model })).sort((x, y) => y.updated - x.updated);
    case "sess_get": { const v = (window.__sess ||= {})[a.project + "|" + a.id]; if (!v) throw new Error("That conversation no longer exists"); return JSON.parse(JSON.stringify(v)); }
    case "sess_put": (window.__sess ||= {})[a.project + "|" + a.id] = JSON.parse(JSON.stringify(a.session)); return null;
    case "sess_delete": delete (window.__sess ||= {})[a.project + "|" + a.id]; return null;
    case "mem_list": return { pins: memPins, recent: [...memTraces].reverse(), turns: memTraces.length, sessions: new Set(memTraces.map((t) => t.session)).size, meta: memMeta };
    case "mem_forget": if (!a.id) { memPins.length = 0; memTraces.length = 0; } else { const i = memPins.findIndex((p) => p.id === a.id); if (i >= 0) memPins.splice(i, 1); } return null;
    case "mem_set_cc": Object.assign(memMeta, { ccSession: a.session, ccSessionAt: Date.now(), ccModel: a.model }); return null;
    case "lib_list": return { papers: libPapers, collections: libCols, dir: "C:/Callio/library" };
    case "lib_search": { const q = a.query.toLowerCase(); return libPapers.filter((p) => (p.title + p.authors.join(" ") + p.abstract).toLowerCase().includes(q.split(" ")[0])).map((p) => ({ id: p.id, score: 1, snippet: p.id === "p1" ? "…the Transformer, based solely on attention mechanisms…" : "", page: p.id === "p1" ? 2 : null })); }
    case "lib_cite": { const p = libPapers.find((x) => x.id === a.id); if (a.draft && !p.usedIn.includes(a.draft)) p.usedIn.push(a.draft); return { key: p.key, bibtex: bibOf(p), doi: p.doi }; }
    case "lib_bibtex": return a.ids.map((id) => bibOf(libPapers.find((x) => x.id === id))).join("\n");
    case "lib_update": { const p = libPapers.find((x) => x.id === a.id); Object.assign(p, a.patch); return p; }
    case "lib_pdf_path": return "C:/demo/paper.pdf";
    case "lib_save_collection": { const c = { ...a.collection, id: a.collection.id || "c" + Date.now() }; const i = libCols.findIndex((x) => x.id === c.id); i >= 0 ? (libCols[i] = c) : libCols.push(c); return c; }
    case "lib_set_text": return null;
    case "lib_extension_dir": return "C:/Users/me/AppData/Local/dev.callio.editor/edge-extension";
    case "lib_add": { const p = { ...libPapers[0], ...a.req.meta, id: "p" + Date.now(), key: "new" + Date.now() % 1000, title: a.req.meta.title || "New paper", authors: a.req.meta.authors || [], collections: [], usedIn: [], added: Date.now() }; libPapers.push(p); emit("library-add-progress", { step: "Reading aclanthology.org…" }); await new Promise((r) => setTimeout(r, 700)); emit("library-add-progress", { step: "Looking for the PDF…" }); await new Promise((r) => setTimeout(r, 700)); return { id: p.id, title: p.title, duplicate: false, pdf: false, needsText: false, hasMeta: true, login: "https://dl.acm.org/doi/pdf/10.1145/1234" }; }
    case "csl_fetch": throw "offline in mock";
    case "cc_restore": files.set(a.path, a.backup.slice(2)); return null;
    case "cc_reply": ccReplies.get(a.rpc)?.(a.value); return null;
    case "cc_cancel": cancel = true; for (const f of ccReplies.values()) f({ allow: false }); return null;
    case "cc_run": {
      cancel = false;
      const id = a.req.id, ev = (e) => emit("cc-event", { id, ev: e });
      ev({ t: "init", model: "claude-opus", sessionId: "s1", mcp: [{ name: "callio", status: "connected" }] });
      lastReq = a.req;
      if (a.req.thinking) for (const w of "Let me look at the greeting first, then make a small edit.".match(/.{1,8}/gs)) { ev({ t: "thinking", text: w }); await sleep(40); }
      for (const w of "I'll fix the typo in the introduction.".match(/.{1,8}/gs)) { ev({ t: "text", text: w }); await sleep(30); }
      ev({ t: "assistant", text: "", tools: [{ id: "t1", name: "Read", input: { file_path: "C:/demo/main.tex" } }], sub: false });
      await sleep(200);
      ev({ t: "tool_results", results: [{ id: "t1", isError: false, text: "ok" }] });
      const input = { file_path: "C:/demo/main.tex", old_string: "Hello, world!", new_string: "Hello, wonderful world!" };
      ev({ t: "assistant", text: "", tools: [{ id: "t2", name: "Edit", input }], sub: false });
      const ans = await new Promise((res) => { const rpc = ++ccSeq; ccReplies.set(rpc, (v) => { ccReplies.delete(rpc); res(v); }); emit("cc-rpc", { rpc, method: "permission", params: { toolName: "Edit", input } }); });
      if (cancel) return { cancelled: true, changed: [], sessionId: "s1", result: "" };
      const before = files.get("C:/demo/main.tex");
      if (ans.allow) { files.set("C:/demo/main.tex", before.replace(input.old_string, input.new_string)); (hist["C:/demo/main.tex"] ||= []).unshift({ id: "vcc", t: Date.now(), sha: "y", label: "Before Claude Code", kind: "ai", size: 1, text: before }); }
      ev({ t: "tool_results", results: [{ id: "t2", isError: !ans.allow, text: ans.allow ? "edited" : "denied" }] });
      ev({ t: "message_start" });
      for (const w of (ans.allow ? "Done — I changed the greeting." : "OK, I left the file unchanged.").match(/.{1,8}/gs)) { ev({ t: "text", text: w }); await sleep(30); }
      return { sessionId: "s1", result: "Done", isError: false, cancelled: false, changed: ans.allow ? [{ path: "C:/demo/main.tex", status: "modified", beforeVersion: "vcc", backup: "B:" + before, afterSha: "a1" }] : [] };
    }
    case "skills_github_inspect": await sleep(400); if (!/github\.com|^[\w.-]+\/[\w.-]+$/.test(a.url)) throw "That isn't a GitHub link (expected https://github.com/owner/repo…)";
      return a.url.includes("/tree/") ? { source: "anthropics/skills", reference: "main", skills: [{ path: "skills/pdf", name: "pdf", description: "PDF tools", files: 9, bytes: 50000 }] }
        : { source: "anthropics/skills", reference: "HEAD", skills: [["docx", "Create and edit Word documents"], ["pdf", "PDF tools"], ["xlsx", "Spreadsheets"], ["skill-creator", "Create new skills"]].map(([n, d]) => ({ path: "skills/" + n, name: n, description: d, files: 5, bytes: 10000 })) };
    case "skills_github_install": await sleep(500); for (const p of a.paths) { const n = p.split("/").pop(); if (!ghInstalled.some((x) => x.folder === n)) ghInstalled.push({ name: n, folder: n, url: a.url, repo: "anthropics/skills", reference: "HEAD", path: p, hash: "h", installedAt: 1, claudeCode: a.claudeCode }); }
      return { installed: a.paths.map((p) => p.split("/").pop()), updated: [], unchanged: [] };
    case "skills_installed": return ghInstalled;
    case "skills_update": await sleep(400); return { installed: [], updated: [], unchanged: ghInstalled.map((x) => x.name) };
    case "skills_remove": ghInstalled = ghInstalled.filter((x) => x.folder !== a.folder); return null;
    case "ai_list_models": return [{ id: "claude-sonnet-5-5", name: "Claude Sonnet" }, { id: "claude-haiku-5-5", name: "Claude Haiku" }];
    case "ai_cancel": cancel = true; return null;
    case "ai_chat": {
      cancel = false;
      const r = a.req;
      const isEdit = r.id.startsWith("edit");
      const isInline = r.id.startsWith("inline");
      let text;
      if (r.id.startsWith("write")) {
        const src = r.messages[0].content; const out = [];
        if (/teh/.test(src)) out.push({ quote: "teh", fix: ["the"], kind: "spelling", why: "Misspelled word." });
        if (/is very important/.test(src)) out.push({ quote: "is very important", fix: ["matters", "is essential"], kind: "style", why: "Wordy; a stronger verb reads better." });
        if (/they was/.test(src)) out.push({ quote: "they was", fix: ["they were"], kind: "grammar", why: "Subject–verb agreement." });
        text = JSON.stringify(out);
      } else if (r.id.startsWith("translate")) text = "Bản dịch: " + r.messages[0].content;
      else if (isInline) text = " and the results are consistent across seeds.";
      else if (isEdit) text = "Hello, world! As shown in Section~\\ref{sec:intro}, we cite \\cite{knuth}.";
      else {
        if (r.thinking) for (const w of "The user wants a tighter intro. I should keep the label and citation, cut filler words, and keep it to one sentence.".match(/.{1,10}/gs)) { emit("ai-event", { id: r.id, kind: "thinking", text: w }); await sleep(40); }
        lastReq = r; window.__lastReq = r;
        emit("ai-event", { id: r.id, kind: "tool", text: "Searching papers: “attention is all you need”" });
        await sleep(300);
        emit("ai-event", { id: r.id, kind: "tool_done", text: "5 result(s)" });
        text = "Here is a tighter version of your opening:\n\n```latex\n\\section{Introduction}\\label{sec:intro}\nWe study X.\n```\n\nThe key change is **conciseness**.";
      }
      let out = "";
      for (const piece of text.match(/.{1,12}/gs)) {
        if (cancel) { emit("ai-event", { id: r.id, kind: "error", text: "Stopped" }); throw "Stopped"; }
        out += piece;
        emit("ai-event", { id: r.id, kind: "text", text: piece });
        await sleep(25);
      }
      emit("ai-event", { id: r.id, kind: "done" });
      return out;
    }
    case "skills_scan": return [
      { id: "s1", name: "julian-style-guide", description: "House style for papers", path: "C:/style/julian-style-guide.md", kind: "guide", size: 1200, source: "C:/style" },
      { id: "s2", name: "julian-vocab-avoid", description: "Words to avoid", path: "C:/style/julian-vocab-avoid.md", kind: "guide", size: 300, source: "C:/style" },
    ];
    case "skills_read": return a.path.includes("avoid") ? "# Avoid\n- utilize → use\n- world — never\n- leverage\n" : "# Style\nUse British spelling.";
    case "skills_own_dir": return "C:/Callio/skills";
    case "verify_bib": {
      for (let i = 0; i <= 3; i++) { emit("bib-progress", { done: i, total: 3, key: "k" + i }); await sleep(150); }
      return [
        { key: "knuth", line: 1, title: "The TeXbook", level: "verified", message: "DOI and title match", found: { title: "The TeXbook", year: 1984, authors: "Donald Knuth", doi: "10.5555/x" } },
        { key: "mendelsohn2023framework", line: 5, title: "A framework for cross-cultural hate typology", level: "problem", message: "DOI 10.18653/v1/2023.acl-long.1 belongs to a different work: “CATS: A Pragmatic Chinese Answer-to-Sequence Dataset”", found: { title: "CATS: A Pragmatic Chinese Answer-to-Sequence Dataset", year: 2023, doi: "10.18653/v1/2023.acl-long.1" } },
        { key: "bourgeade2024", line: 9, title: "Entity-level hate span extraction", level: "check", message: "Only a similar title was found (62% match)" },
      ];
    }
    case "history_record": { (hist[a.path] ||= []).unshift({ id: "v" + Date.now(), t: Date.now(), sha: "x", label: a.label, kind: a.kind, size: a.text.length, text: a.text }); return null; }
    case "history_record_disk": return null;
    case "history_list": return (hist[a.path] || []).map(({ text, ...v }) => v);
    case "history_get": return (hist[a.path] || []).find((v) => v.id === a.id)?.text ?? "";
    case "history_rename": { const v = (hist[a.path] || []).find((v) => v.id === a.id); if (v) { v.label = a.label; v.kind = "manual"; } return null; }
    case "install_engine": {
      cancel = false;
      const total = a.kind === "tinytex" ? 73_700_000 : 30_000_000;
      for (let d = 0; d <= total; d += total / 40) {
        if (cancel) throw "Cancelled";
        emit("install-progress", { kind: a.kind, phase: "download", label: `Downloading — ${(d / 1048576).toFixed(1)} MB of ${(total / 1048576).toFixed(1)} MB`, done: d, total });
        await sleep(40);
      }
      for (let d = 0; d <= 287; d += 12) { emit("install-progress", { kind: a.kind, phase: "extract", label: `Unpacking — ${d} MB of 287 MB`, done: d, total: 287 }); await sleep(30); }
      emit("install-progress", { kind: a.kind, phase: "setup", label: "Checking pdfLaTeX…", done: 0, total: 0 });
      await sleep(500);
      installed[a.kind] = true;
      return { version: a.kind === "tinytex" ? "TeX Live 2026" : "0.15.0", path: "C:/x" };
    }
    case "cancel_install": cancel = true; return null;
    case "remove_engine": installed[a.kind] = false; return null;
    case "read_text": {
      if (!files.has(a.path)) throw "File not found: " + a.path;
      return { text: files.get(a.path), mtime: 0, encoding: "utf8" };
    }
    case "write_text": files.set(a.path, a.text); return 0;
    case "fs_create": { const p = a.dir + "/" + a.name; if ([...files.keys()].some((k) => k === p || k.startsWith(p + "/"))) throw `${a.name} already exists here`; files.set(a.folder ? p + "/.keep" : p, ""); return p; }
    case "fs_move": { const out = await invoke("fs_copy_or_move", { ...a, mv: true }); return { moved: a.paths.map((p, i) => [p, out[i]]), error: null }; }
    case "fs_copy": case "fs_copy_or_move": {
      const out = [];
      for (const src of a.paths) {
        const name = src.split("/").pop();
        let to = a.dest + "/" + name;
        if (!a.mv) { let i = 0; while ([...files.keys()].some((k) => k === to || k.startsWith(to + "/"))) to = a.dest + "/" + name.replace(/(\.[^.]+)?$/, ` (copy${++i > 1 ? " " + i : ""})$1`); }
        else if ([...files.keys()].some((k) => k === to || k.startsWith(to + "/"))) throw `${name} already exists`;
        for (const k of [...files.keys()]) if (k === src || k.startsWith(src + "/")) { files.set(to + k.slice(src.length), files.get(k)); if (a.mv) files.delete(k); }

        out.push(to);
      }
      return out;
    }
    case "fs_duplicate": return (await invoke("fs_copy", { paths: [a.path], dest: a.path.replace(/\/[^/]+$/, "") }))[0];
    case "fs_trash": for (const p of a.paths) for (const k of [...files.keys()]) if (k === p || k.startsWith(p + "/")) files.delete(k); return null;
    case "fs_find": { const hits = []; for (const [p, t] of files) if (p.startsWith(a.dir + "/")) String(t).split("\n").forEach((l, i) => { if (l.toLowerCase().includes(a.query.toLowerCase())) hits.push({ path: p, line: i + 1, col: 0, text: l.trim() }); }); return hits; }
    case "open_terminal": return null;
    case "translate_google": await sleep(300); return { text: `[${a.to}] ${a.text}`, from: "en" };
    case "web_search_engine": return [{ title: `Result for ${a.query}`, url: "https://example.org/", snippet: "A sample result.", meta: "" }];
    case "list_extractors": return [{ id: "7zip", name: "7-Zip", exe: "7zG.exe", direct: true }, { id: "tar", name: "Windows (built in)", exe: "tar.exe", direct: true }, { id: "explorer", name: "File Explorer (open the archive)", exe: "explorer.exe", direct: false }];
    case "extract_with": return { dest: a.archive.replace(/\.[^.]+$/, ""), finished: true };
    case "launch_program": return null;
    case "print_file": throw new Error("no print verb");
    case "media_ffmpeg": return "";
    case "fs_watch": return null;
    case "list_dir": {
      const out = [];
      const seen = new Set();
      for (const p of files.keys()) {
        if (!p.startsWith(a.path + "/")) continue;
        const rest = p.slice(a.path.length + 1);
        const name = rest.split("/")[0];
        if (seen.has(name) || name.startsWith(".")) continue;
        seen.add(name);
        out.push({ name, path: a.path + "/" + name, isDir: rest.includes("/") });
      }
      return out;
    }
    case "pick_open_file": return "C:/demo/main.tex";
    case "pick_folder": return "C:/demo";
    case "pick_save_file": return "C:/demo/" + a.defaultName;
    case "open_path": return null;
    case "load_settings": return settings;
    case "save_settings": settings = a.settings; return null;
    case "get_secret": return secrets[a.key] || null;
    case "set_secret": secrets[a.key] = a.value; return null;
    case "find_root": return "C:/demo/main.tex";
    case "scan_project": return { labels: ["sec:intro", "eq:1"], citations: ["knuth"], files: ["main.tex", "refs.bib"] };
    case "read_binary": return await (await fetch("/__sample.pdf")).arrayBuffer();
    case "synctex_forward": return { page: Math.max(1, Math.min(12, Math.ceil(a.line / 2))), x: 133, y: 148, w: 300, h: 12 };
    case "synctex_inverse": return { file: "C:/demo/main.tex", line: Math.min(14, a.page * 2) };
    case "synctex_lines": return window.__mockLines || [];
    case "compile": if (window.__mockOk) return { ok: true, pdf: "C:/demo/t.pdf", engine: "tectonic", durationMs: 500, log: "", diagnostics: [] };
      if ((a.engine || "tectonic") === "tectonic" && !installed.tectonic) throw "ENGINE_MISSING:tectonic:Tectonic isn't installed yet.";
      if (["latexmk", "pdflatex", "xelatex", "lualatex"].includes(a.engine) && !installed.tinytex) throw `ENGINE_MISSING:tinytex:${a.engine} isn't installed.`;
      return {
      ok: false, pdf: "C:/demo/main.pdf", engine: a.engine || "tectonic", durationMs: 812,
      log: "This is a mock log.\n! Undefined control sequence.\nl.7 \\foo",
      diagnostics: [
        { severity: "error", file: "C:/demo/main.tex", line: 7, message: "Undefined control sequence." },
        { severity: "warning", file: "C:/demo/main.tex", line: 9, message: "Reference `eq:1' undefined." },
      ],
    };
    case "detect_engines": return { tectonic: installed.tectonic ? "C:/q/bin/tectonic.exe" : null, tectonicManaged: installed.tectonic, latexmk: installed.tinytex ? "C:/q/TinyTeX/bin/windows/latexmk.exe" : null, pdflatex: installed.tinytex ? "x" : null, xelatex: installed.tinytex ? "x" : null, lualatex: installed.tinytex ? "x" : null, texSource: installed.tinytex ? "tinytex" : null, tinytexVersion: installed.tinytex ? "TeX Live 2026" : null, git: "git" };
    case "assoc_status": return { registered: false, exe: "C:/Program Files/Callio/callio.exe", extensions: [".md", ".markdown", ".tex", ".bib", ".sty", ".cls"] };
    case "app_info": return { version: "0.1.0-mock", settingsPath: "%APPDATA%/Callio/settings.json" };
    case "ol_link_info": return null;
    case "ol_list_projects": return [{ id: "abc123", name: "Thesis", lastUpdated: "2026-10-01T10:00:00Z", owner: "me" }];
    case "ol_test": return { ok: true, user: "minh@example.com", projects: 1 };
    default: return null;
  }
}
