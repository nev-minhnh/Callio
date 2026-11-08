<p align="center"><img src="docs/logo.png" width="120" alt="Callio logo"></p>

<h1 align="center">Callio</h1>
<p align="center"><b><i>Callio – Shape your folio</i></b></p>

<p align="center">
<a href="https://github.com/nev-minhnh/Callio/actions/workflows/build.yml"><img alt="Build" src="https://github.com/nev-minhnh/Callio/actions/workflows/build.yml/badge.svg"></a>
<img alt="Windows 11" src="https://img.shields.io/badge/Windows-11-0f5c3c">
<img alt="License" src="https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-c9962e">
</p>

A lightweight editor for Windows 11: Markdown and LaTeX with a live preview, SyncTeX and two-way Overleaf sync, plus Word documents, spreadsheets, presentations, pictures and a full set of PDF tools. It is built with Rust (Tauri 2) and the WebView2 runtime that ships with Windows. The editor is one small executable (about 11 MB); documents, spreadsheets, presentations, pictures and PDF tools live in a second program, `callio-office.exe`, that starts only when you open one of those files.

*Callio was called **Proemia** (0.7 – 0.10) and **Quire** (up to 0.6.3). On first start it moves your settings, saved keys, paper library, history, TinyTeX and Overleaf links over, and replaces the old “Open with” entries. Then remove the old app through Windows Settings → Apps (or delete its portable folder) — not with its own *Uninstall* button, which would also erase the saved keys it shares.*

## Features

- **Editor**: CodeMirror 6 with syntax highlighting, multiple tabs, search and replace (Ctrl+F), multi-cursor, bracket matching, folding, and optional Windows spell check.
- **LaTeX autocomplete**: commands, environments, packages, `\ref{}` labels, `\cite{}` keys from your `.bib` files, and file names for `\input`/`\includegraphics`.
- **Markdown preview**: live, scroll-synced, with KaTeX math (`$…$`, `$$…$$`), tables, task lists, syntax-highlighted code and local images. Print or save as PDF with Ctrl+P.
- **Scrolling together**: in split view the editor (source or visual) and the preview glide together smoothly, whichever side you scroll. For LaTeX the whole SyncTeX map is read once per compile and the PDF moves continuously between lines — across page breaks too — instead of jumping page by page. With the **visual editor on a Markdown file**, the preview *matches the editor*: the same text width and typography, and every paragraph, heading, list and table at exactly the same height on both sides (⇆ *Match editor* in the preview's toolbar, which also has zoom and *Fit*) — by line for Markdown and through SyncTeX for LaTeX — and after a recompile the PDF stays where you are instead of jumping to page 1 (Settings → Editor → *Scroll the editor and the preview together*).
- **LaTeX preview**: Overleaf-style. Ctrl+Enter or Ctrl+S compiles and the PDF opens alongside the source.
  - Errors and warnings appear in a clickable log panel and as squiggles in the editor.
  - Main-file detection supports `% !TEX root = main.tex`.
  - **SyncTeX**: Ctrl+Alt+J jumps from the source to the PDF; double-clicking the PDF jumps back to the source.
- **PDF reader**: the **Auto** layout (default) shows one page, then two side by side, then a grid as you zoom out — the Markdown preview does the same, turning into pages when you zoom out far enough. Other layouts: single page, **two pages side by side**, two pages with cover, grid, horizontal and one page at a time. A **navigation panel** shows page thumbnails and bookmarks. You can also switch a PDF tab to the **Edge viewer** (Edge's own toolbar: print, rotate, save). Open any `.pdf` (Open ▾, the file tree, drag-and-drop or *Open with*). It has smooth scrolling, Ctrl+wheel zoom anchored at the pointer, Ctrl+F search with highlighted matches, bookmarks in the Outline tab, and text selection. Each PDF tab remembers its zoom and position.
- **One-click engines with progress**: Settings → LaTeX shows each engine's status. **Install** downloads, unpacks and checks it, with a live progress bar (download speed, time left, unpack progress). Installs can run in the background or be cancelled. Compiling with an engine that isn't installed offers to install it.
  - *Tectonic*: about 30 MB.
  - *TinyTeX* (TeX Live): latexmk, pdfLaTeX, XeLaTeX and LuaLaTeX, installed for your user only. Missing LaTeX packages are installed automatically while compiling.
- **Engines** (choose in Settings → LaTeX):
  - **Tectonic**: downloaded on first use, no TeX installation needed.
  - **latexmk**, **pdfLaTeX**, **XeLaTeX**, **LuaLaTeX**: from TinyTeX installed by Callio, or your own MiKTeX or TeX Live.
  - **Overleaf servers**: pushes your changes, compiles on Overleaf, and shows the PDF.
- **Overleaf integration**:
  - **Git sync** (official): needs an Overleaf Git token, which requires a premium or institutional plan, plus Git for Windows.
  - **Web sync** (unofficial, works on free plans): uses your browser session cookie. You can browse your projects, download them, then Pull and Push.
  - Pulls are conflict-safe. In web mode, if the same file changed on both sides, Overleaf's version is saved next to yours as `name.overleaf.tex`. That file is held back from Push until you merge the two versions and delete the `.overleaf` copy. In Git mode, Git merges the changes, and Callio refuses to sync while `<<<<<<<` conflict markers remain.
  - Callio never silently overwrites a file that changed on disk after you opened it, whether another program or a sync changed it; it asks first.
  - Credentials are stored in **Windows Credential Manager**, never in plain text.
- **Visual editing** (Markdown and LaTeX), like Word or LyX: click **👁 Visual** above the editor and write in a document page with a ribbon — paragraph styles, bold/italic/underline, lists and check boxes, links, pictures and figures with captions, **Word-style tables** (pick the size on a grid, ⊕ handles to add rows and columns, Tab between cells, right-click to insert/delete/align), math and numbered equations (KaTeX; click to edit the LaTeX), footnotes and citations (Alt+C cites from your library). In LaTeX the preamble is a collapsible *Document settings* block, sections/figures/tables/equations are numbered, and anything Callio can't show visually (TikZ, algorithms, unusual commands) stays as editable source. Parts you don't touch are written back exactly as they were, so the LaTeX/Markdown stays yours. **</> Source** switches back; both views stay in sync.
- **Jupyter notebooks** (`.ipynb`): view cells with their outputs (text, tables, images, plots, errors), edit cell text (click a code cell, double-click a text cell; Esc or Shift+Enter to finish), add, move, delete and change cells, clear outputs, or edit the JSON alongside. Code is never run. Saved exactly the way Jupyter writes notebooks.
- **PDF editing**: in a PDF tab, add **text boxes** and **sticky notes** in any font installed on Windows (size, bold, italic, colour), **drawings/signatures**, **highlights** and **images** (or just **Ctrl+V** a picture you copied), and fill in PDF forms. *Save* (or AutoSave) writes them into the PDF as standard annotations — the chosen font is embedded, so every reader shows them the same — and Callio's text boxes stay editable when you open the PDF again. The previous file is kept in Callio's backups for 30 days.
- **AutoSave**: the switch in the toolbar (like Word) saves every change as you work — text files, notebooks and PDF annotations.
- **OCR** (🔤 in the toolbar): turns a scanned PDF or a picture into an editable Markdown document, then Save it or export it as PDF/Markdown. As in Docling, pages that already contain text keep it; only pictures of text are recognised (or force OCR on every page / a page range). Engines, no Python needed: **Windows OCR** (built into Windows; Settings → OCR downloads its language packs), **Tesseract** (downloaded from Settings → OCR, with extra languages such as Vietnamese), **Claude Code** (your Claude plan; pick the model and effort in the OCR window), the **Claude API** or the **Gemini API** (pick the model in the OCR window — the list comes from your key; keys entered in Settings → OCR are kept in Windows Credential Manager; the last three send the page images to that service).
- **Export as Markdown** (Save ▾): converts the open file — or any file via *Convert a file to Markdown…* — the way Docling does, in plain JavaScript: **PDF** (reading order with columns, headings, lists, tables, running headers removed, scanned pages through OCR), **Word**, **Excel**, **PowerPoint**, **OpenDocument**, **LaTeX** source or its compiled PDF, notebooks, HTML, CSV, text and code. Pictures are saved next to the Markdown in a `name_files` folder.
- **File list** (like VS Code): right-click a file, a folder or the empty space for *New File…* (any extension), *New Folder…*, *Cut / Copy / Paste* (Ctrl+X/C/V), *Duplicate*, *Rename* (F2), *Delete* (to the Recycle Bin), *Reveal in File Explorer*, *Open in Terminal*, *Find in Folder…* (Shift+Alt+F), *Add to Chat* and *Copy Path / Copy Relative Path*. **Drag** files and folders onto a folder to move them (hold Ctrl to copy); Ctrl-click picks several. Files **dragged in from Windows Explorer** are copied into the folder you drop them on. Open tabs follow their files when they move or are renamed. *New ▾ → Other file…* creates a file with any extension.
- **Word documents** (`.docx`, legacy 97–2003 `.doc`, `.odt`, `.rtf`) open **fully editable**, like Word: click into the pages and type; styles, fonts, sizes, bold/italic/underline, colours, highlight, lists, alignment, line spacing, find & replace, tables, pictures, links, headers and footers, page numbers, footnotes, table of contents, equations, margins, orientation, page size, columns and breaks — and *Search every Word command…* (Alt+Q) reaches all of WordCraft's commands. Ctrl+S saves (the previous file is backed up; `.doc` saves as `.docx`). **Export ▾** saves a copy as PDF (real text, links and bookmarks), Word, OpenDocument, RTF, HTML, Markdown, LaTeX or plain text. Built on [WordCraft](https://github.com/storytold/wordcraft).
- **Markdown and LaTeX → Word**: Save ▾ → *Export as Word / OpenDocument…* turns the open `.md`, `.tex`, `.html` or `.txt` into `.docx`, `.odt`, `.rtf` or `.html` (headings, lists, tables, math, footnotes, pictures).
- **Spreadsheets** (`.xlsx`/`.xlsm` natively — styles, themes, formulas including dynamic arrays, tables, conditional formats, validation, comments, hyperlinks, charts, pictures, sparklines, pivot tables and print settings round-trip; `.csv` and `.tsv`; legacy `.xls` with values, formulas and number formats; `.xlsb` and `.ods` data with their saved values): a fast grid with frozen panes, merged cells, conditional-format bars and icons, charts, floating pictures and pictures inside cells, a formula bar, sheet tabs, zoom, and Count / Sum / Average of the selection. Edit cells and formulas (they recalculate), bold/italic/colours/alignment/wrap/merge/number formats/borders, AutoSum, sort, insert and delete rows/columns, undo/redo. **Export ▾**: `.xlsx`, CSV, PDF or Markdown. Built on [GridCraft](https://github.com/storytold/gridcraft).
- **PDF tools** (🧰 *PDF tools* in the toolbar, next to OCR): **organize pages** visually (thumbnails: drag to reorder, rotate, duplicate, delete), merge, split, extract, delete, rotate, insert pages or blanks, pages per sheet (N-up), crop; **page numbers**, header & footer, **watermark**, remove watermarks, flatten forms and comments, properties, attach files; **protect** (AES-256 with permissions), unlock, **redact** (search words, e-mails, phone numbers, IDs, dates — the text is removed from the file, not just covered); **compress**, repair; pictures → PDF, PDF → pictures, PDF → Markdown, PDF → Word, any document → PDF, **compare** two PDFs, inspect. Every tool writes a new file; the original is never changed. Built on [PdfCraft](https://github.com/storytold/pdfcraft).
- **PowerPoint presentations** (`.pptx`, `.ppsx`, `.potx`, `.odp`): slide thumbnails (click, drag to reorder, right-click for New / Duplicate / Delete / Section), the slide to edit in place (click and drag shapes, resize and rotate, double-click to type), speaker notes below. New Slide with layouts, sections, fonts and paragraphs, Shapes, Text Box, Picture, Arrange, Quick Styles, Shape Fill / Outline / Effects, themes and variants, transitions, animations, tables, charts, SmartArt, video and audio — every DeckCraft command is on the ribbon. Ctrl+S saves (backup kept); Export as PDF, pictures, outline or GIF. Built on [DeckCraft](https://github.com/storytold/deckcraft).
- **Office ribbons**: Word documents, spreadsheets and presentations get the full Office-style ribbon — Home laid out like Word, Excel and PowerPoint (galleries, split buttons, colour pickers), and every other tab (Insert, Draw, Design, Layout, References, Mailings, Review, View, Page Layout, Formulas, Data, Transitions, Animations, Slide Show…) built from the engine's own command catalogue, so every command WordCraft, GridCraft and DeckCraft have is a click away. The icons are the ones those apps draw. *Search every command…* (Alt+Q) finds any of them; commands that need values ask for them.
- **Undo / Redo for everything** (↶ ↷ in the toolbar, Ctrl+Z / Ctrl+Y): text, Markdown and LaTeX, Word documents, spreadsheets, presentations, pictures and PDF page changes. The ▾ next to each lists the last 100 actions — AI edits are marked — and undoes or redoes several at once.
- **The AI can edit every format**: the AI panel and Claude Code read and change Word documents, spreadsheets and PDFs too (tools `office_read`, `word_edit`, `sheet_edit`, `deck_edit`, `image_edit`, `pdf_tool`). A file open in a tab is changed there, unsaved, as one *AI: …* step in its Undo list; a file that isn't open is saved after a backup.
- **PDF pages**: *▦ Pages* in a PDF tab shows every page as a thumbnail — drag to reorder, rotate, duplicate, delete, then Apply (Undo takes it back, Save writes it).
- **Everything → Markdown**: Word, OpenDocument, RTF, HTML, spreadsheets (every sheet as a table), PDF, LaTeX, notebooks and more convert to Markdown with headings, lists, tables, footnotes, links, formatting and pictures kept.
- **JSON, XML and YAML**: syntax highlighting, brackets coloured by depth, indentation guides with the current block lit up, folding, and a live check as you type (errors underlined, *✓ Valid JSON* or the first problem in the status bar — click to go there). **✨ Beautify** (Shift+Alt+F), **Minify** and **Validate** above the editor; numbers, strings and comments are kept exactly as written. The preview is a **tree** you can fold, search and click to jump to the source (right-click copies the JSONPath); in Split view the tree and the text scroll together. Beautify also works on HTML, CSS and JavaScript/TypeScript.
- **Indentation, line endings, encodings** (status bar, like Notepad++): *Spaces: 2* → indent with 2 or 4 spaces or tabs, or convert the whole file; *CRLF / LF / CR* → Windows, Unix or old Mac line endings (each file keeps its own when saved); *UTF-8* → reopen as ANSI, UTF-8, UTF-8-BOM, UTF-16 BE/LE or any character set (Vietnamese Windows-1258, Western, Central European, Cyrillic, Greek, Turkish, Hebrew, Arabic, Baltic, Thai, Chinese GBK/Big5, Japanese Shift-JIS, Korean…), or *Convert to* another encoding when saving. Files that aren't UTF-8 open in your Windows code page instead of garbled text.
- **CSV and TSV** open as an editable **table** (Split shows the text beside it, rows and columns in matching colours; Editor shows only the text): click or type into cells (Enter, Tab, arrows, F2), **＋ Row / ＋ Column**, delete rows and columns, sort by a column, drag row numbers or column titles to move them, resize columns (double-click the edge to fit), copy and paste blocks to and from Excel, filter rows, header row on or off, comma / semicolon / tab / pipe. Every change is one Undo step and the file is **saved as the same CSV/TSV** — untouched rows keep their exact text and quoting. Very large files (100,000+ rows) scroll smoothly. In Split view the table and the text scroll together. Export as Markdown (a table), PDF (a table) or Word.
- **⇆ Compare** (toolbar): pick two files — browse, choose open tabs (unsaved changes included) or **drop them from Explorer** — and see them side by side or inline, with the changes highlighted, ↑↓ to step through them (F7), unchanged parts folded, and *copy a change across* then *Save right* for text files. Works for every type: text, code, JSON, CSV, Markdown, LaTeX; Word documents (as Markdown), spreadsheets (every sheet), presentations (every slide's text and notes) and PDFs (their text); pictures (side by side, swipe, or the differing pixels lit up); anything else byte by byte. Two **folders** list what changed, what is only on one side and what is the same; click a file to see its changes. Files must have the same extension — otherwise Callio says which types they are.
- **Pictures and photos** (JPEG, PNG, TIFF, WebP, AVIF, HEIC, JPEG XL, BMP, GIF, PSD and camera raw files — CR2/CR3, NEF, ARW, RAF, ORF, RW2, DNG…) open in a **photo editor** with a full ribbon like Lightroom's: **Home** (Auto, Black & White, White Balance and its picker, HDR, rotate, flip, straighten, upright, crop with aspect ratios, presets, profiles, copy / paste settings, before / after, zoom, Save, Export), **Crop & Geometry**, **Masking** (brush, linear and radial gradients, colour and luminance ranges, invert, duplicate), **Retouch** (heal, clone, fill, find dust spots, red eye), **Adjust**, **Before / After** and **All Commands**. The panel on the right has a live histogram (with clipping) and every adjustment — Light, Tone Curve (drag points; master, red, green, blue), Color, Color Mixer (hue / saturation / luminance), Black & White mix, Color Grading, Effects, Vignette, Grain, Detail, Lens corrections, Transform, Profile and Calibration — with each section switchable on and off; double-click a slider's name to reset it. Dragging a slider updates the picture while you drag (a draft render in about 15 ms), and zooming in renders the part on screen at full sharpness. Every change is one Undo step (Ctrl+Z / Ctrl+Y). Edits are non-destructive until you **Save** (Ctrl+S writes the edited picture over the file; the previous file is kept in Callio's backups) or **Export** a copy as JPEG, PNG, 16-bit TIFF, WebP, AVIF or JPEG XL. Camera raw files are never changed: their edits go into an `.xmp` sidecar, or Save as JPEG / TIFF. Shortcuts: R crop, W white balance, Q heal, M gradient, B brush, `[` `]` brush size, `\` before / after, Z zoom, V black & white, Shift+A auto. The AI can edit pictures too (`image_edit`). Built on [LightCraft](https://github.com/storytold/lightcraft).
- **Any text file**: everything else opens as plain text (like Notepad), always word-wrapped, with syntax highlighting for code.
- **Open with / double-click**: Callio registers itself for `.md .markdown .tex .ltx .sty .cls .bib`, Word documents (`.docx .doc .odt .rtf`), spreadsheets (`.xlsx .xlsm .xls .xlsb .ods`), tables (`.csv .tsv`) and presentations (`.pptx .ppsx .potx .odp`), either through the installer or through Settings → File types for the portable exe. If another file is double-clicked while Callio is running, it opens in a new tab in the existing window.

## AI assistant

- **Providers**: Claude (Anthropic), ChatGPT (OpenAI), Gemini, Perplexity, Grok (xAI), your own **llama.cpp** server, or any OpenAI-compatible endpoint. Set them up in Settings → AI, load each provider's model list, and pick a model for chat, for rewrites and for inline completion separately. Keys go in Windows Credential Manager.
- **Chat panel** (✨ AI, Ctrl+L): the current file, your selection and compile errors are added as context (toggle them with the chips). Code blocks get *Replace selection* and *Insert at cursor*.
- **Live thinking**: answers stream token by token, and the model's thinking streams above the answer while it works (Claude via API or Claude Code, and reasoning models such as llama.cpp/DeepSeek). It folds away into *Thought for N s* when the answer starts. Turn it off in Settings → AI.
- **Effort** (Claude models): the selector next to the model — Low, Medium, High, Extra, Max. Higher is more thorough but slower and uses limits faster.
- **"/" in the chat box**: type `/` to pick a skill or command. `/skill-name your request` makes that skill drive this message; with Claude Code its own skills and commands (`~/.claude/skills`, `~/.claude/commands`, and the project's `.claude` folder) run natively. Built-in commands: `/new`, `/clear`, `/compile`, `/verify-bib`, `/skills`.
- **Selection actions** (the ✨ button next to a selection, or Ctrl+.): improve, fix grammar, make concise, expand, formal, paraphrase, apply my style guides, translate, convert to LaTeX, or a custom instruction.
- **Fix with AI**: every compile error in the log has a ✨ Fix button.
- **Every AI edit is a reviewable diff**, with Accept or Reject per change or for all, and Callio saves a version of the file first.
- **Inline completion** (optional, Settings → AI): ghost text while you type; Tab accepts, Esc dismisses. A fast local model on llama.cpp works well here.
- **Internet and citations**: the AI can search papers (OpenAlex), verify citations (Crossref, OpenAlex) and fetch BibTeX from doi.org without any key. Claude and Perplexity also search the web; for other models you can add Brave, Tavily or your own SearXNG server. The AI is told never to invent references.
- **Citation check**: see below — your library, Crossref and OpenAlex, optionally Perplexity.
- **Your whole folder**: the AI can list, read (including PDFs) and search every file and subfolder of the folder you opened.
- **Skills**: point Callio at folders of skills (`SKILL.md` folders, `.skill` packages or plain `.md` style guides). Turn each one on or off. Style guides go into the AI's instructions in full; installed skills are listed by name and the AI loads one when a task needs it, so many skills don't slow every request. Words from "avoid" lists (e.g. `*vocab-avoid.md`) are underlined in the editor.
- **Install skills from GitHub**: Settings → AI → Skills → paste a link to a public repository (`https://github.com/owner/repo`, `owner/repo`, or a link to one skill's folder or its `SKILL.md`) and click **Install**. One skill installs straight away; for a repository with several, tick the ones you want. Skills are saved in Callio's skills folder and, if *Also give them to Claude Code* is ticked, in Claude Code's `~/.claude/skills` too. *Check for updates* re-downloads them; ✕ removes them from both places. Callio never overwrites a skill folder it didn't install.

## Paper library (like Zotero, built in)

Open it with **📚 Library** (Ctrl+Shift+L).

- **Add papers like Zotero**: *+ Add* → paste a **DOI**, a DOI link, an arXiv id, the paper's **web page** or its **PDF link** — Callio reads the page's citation details, Crossref and arXiv, and fetches the PDF (from the publisher's page, ACL Anthology, arXiv, OpenAlex, Semantic Scholar…). A card in the middle of the library shows each step and then clearly what was found: details ✓, PDF ✓ (and from where), or what's missing. If the PDF needs a sign-in (paywall, institutional access), click *Sign in to …*: a window opens on the publisher's site; sign in, open the PDF there, and Callio saves it — the sign-in is kept for the next papers from that site, and you're asked again when it expires. Dropped or picked PDF files get their details automatically: from an ACL Anthology / arXiv file name, a DOI printed on the first page, or the title on the first page (matched in Crossref and Semantic Scholar) — the authors, venue, pages, publisher and DOI are filled in, never guessed. A paper without a PDF has *Find PDF online* too. Also: import a `.bib`, or save from **Microsoft Edge** with the extension.
- **Edge extension** (*+ Add → Edge extension*): one-time setup — Edge → Extensions → turn on *Developer mode* → *Load unpacked* → choose the folder Callio shows. Then click *Save to Callio* (or Alt+Q) on any paper page or PDF: it reads the page's citation details and downloads the PDF with your own browser sign-in, so paywalled papers you can open are stored too. The first time, click *Connect* and confirm in Callio. A right-click *Save linked PDF to Callio* works on PDF links.
- **Full-text search**: every PDF's text is indexed in the background (on your PC; no cloud). Search titles, authors, abstracts and the words inside the papers; results show the matching passage and page. Use "quotes" for a phrase. Double-click opens the PDF at that page.
- **Collections** (nested; drag papers onto one), tags and notes. **Drafts that cite papers** lists every draft you cited from, and each paper shows the drafts it's cited in — so you can find later which papers went into which draft. A collection can also be linked to drafts.
- **Cite with Alt+C** in a LaTeX or Markdown draft: a search box opens at the cursor (searches titles, authors and full text). ↑/↓ move through the results, ←/→ move inside the search text, Enter (or a click) inserts the citation at the cursor — `\cite{key}` (or the command you choose) in LaTeX, `[@key]` in Markdown — and adds the BibTeX entry to the document's `.bib`. If the document has no bibliography yet, Callio creates `references.bib` and adds `\bibliographystyle`/`\bibliography` (or biblatex's `\addbibresource`/`\printbibliography`). Citing inside an existing `\cite{…}` adds the key to it; an entry already in the `.bib` (same key or DOI) is reused.
- **Citation styles** (Settings → Library): LaTeX — BibTeX/natbib `.bst` styles and biblatex styles (plus any other by name), with *Apply to the open document*. Markdown — every style in the official CSL repository (over 10,000: APA, IEEE, Nature, Chicago, Vancouver, each journal's own…), searchable; citations and the reference list are formatted in the preview and in PDF export (put a *References* heading where the list should go).
- The AI and Claude Code can search and read your library and take BibTeX from it.

## Export to PDF

*Save ▾ → Export as PDF…* or Ctrl+Shift+E — for every kind of file.

- **Markdown** is printed by Microsoft Edge: headings become PDF **bookmarks**, links stay clickable, text stays selectable, math is typeset, and **images are embedded at their full original resolution**. Options: page size, margins, a linked table of contents, numbered headings.
- **Text and code files** (.txt, .py, .json, .bib…) are printed wrapped, with syntax colours and optional line numbers; **notebooks** with their outputs.
- **LaTeX**: the compiled PDF is exported exactly as LaTeX produced it — bookmarks, links, index and images untouched (LaTeX embeds images without recompressing them). If the document has no `hyperref`, Callio offers to add it so the PDF gets bookmarks.

## Citation check

AI panel → ⋯ → *Verify citations in .bib*: each entry is checked against your **library first**, then Crossref and OpenAlex. Doubtful entries can be re-checked with **Perplexity's academic search** or **Perplexity Deep Research** (needs a Perplexity API key; a Pro plan includes monthly API credit).

## Saved conversations

While the AI works, tags above the input show the files it is reading (👁) or editing (✎); click one to open it.

AI conversations are saved with the **folder** you have open, so each folder is its own project. The bar under the model list shows the current conversation and folder: open it to switch to an earlier conversation, rename or delete one, or start a **new chat** (＋). New chats list the recent conversations of that folder. A Claude Code conversation continues where it left off when you reopen it.

## Project memory

The AI remembers your work per project folder, so you don't have to explain the context, your preferences or which skills to use again. Every conversation is kept verbatim on your PC; when you ask something, Callio recalls the relevant earlier exchanges — by matching words, names, citation keys, labels and file names, and following links between them — and adds them to the prompt. Recalling and storing use **no AI calls and no extra tokens** (inspired by the Zero-Mem paper). Skills you used with `/` in a project are applied again there. `/remember …` pins a fact or decision; `/memory` shows what's remembered and lets you forget any of it. With Claude Code, the chat offers to continue your last conversation in that folder. Turn it off in Settings → AI.

## Claude Code (use your Claude Pro or Max plan)

Choose a **Claude Code** model in the AI panel's model list (or in Settings → AI → Models → Chat panel) — Default, Opus 5.5, Fable 5.1, Sonnet 5.5, Haiku 5.5 and earlier versions back to Opus/Sonnet 4, or *Other model id…*. Pick the effort next to it to have Anthropic's official Claude Code work on your project from inside Callio — no API key, no terminal.

- **Setup**: Settings → AI → Claude Code → *Install Claude Code* (Anthropic's installer, for your user only), then *Sign in…* (a window opens and your browser confirms your Claude account). Tick *Use Claude Code in the AI panel*.
- It runs in your project folder and can read, search and edit files, run commands and search the web. Its answer, the tools it uses (✓/✗) and its questions stream into the chat. Follow-up messages continue the same conversation; ⋯ → *New chat* starts a fresh one.
- **Permissions** (the 🛡 button next to the model): *Ask before changes* shows each edit as a diff, or each command, with **Allow / Allow all edits / Deny** (you can say why you denied it); *Auto-accept file edits* (still asks before commands); **⚡ Auto** — Claude Code's own safety check approves each action without asking (needs a recent Claude Code and a model that supports it; if not, the chat says it fell back to asking); **🚀 Full access** — never asks (a one-time warning first); or *Plan only* (no changes).
- **Safety net**: Callio saves your open files before each answer and keeps every project file it changes as a version. Afterwards the chat lists *Files changed by Claude Code* with **Show changes** (a diff) and **Undo**. Open tabs update as Claude edits.
- Claude Code can use Callio directly: it sees which file and selection you have open, **compiles** your LaTeX in Callio and reads the errors, and opens files for you.
- Your style guides and skills are passed along; skills installed from GitHub with *Also give them to Claude Code* are loaded by Claude Code itself.
- Usage counts toward your plan's limits, shared with claude.ai. Callio never sees your Claude password or tokens; the sign-in belongs to Claude Code. Installing [Git for Windows](https://git-scm.com/download/win) lets Claude Code use its Bash tool (it uses PowerShell otherwise).

## Version history

Callio keeps versions of each file automatically: on every save, before any AI edit, after Overleaf pulls and before restores. Open **History** in the sidebar to see them by day, compare any version with the current text, restore it, or give it a name (named versions are never removed). Recent versions are all kept; older ones thin out to hourly, then daily. Nothing to install, nothing to learn.

## Install

- **Installer**: run `Callio_0.11.0_x64-setup.exe`. It installs per-user (no admin rights needed) and registers the file types.
- **Portable**: unzip the portable folder anywhere and run `Callio.exe` (keep `callio-office.exe` next to it for documents, spreadsheets and PDF tools). It registers itself in *Open with* on first launch.

To make Callio the **default** for `.md` and `.tex`, right-click a file and choose *Open with → Choose another app → Callio*, then tick **Always**. Alternatively, go to Settings → File types → *Open Windows Default apps*. Windows 11 doesn't let apps set themselves as the default, so this step is yours.

## Updating to a new version

- **Installed with the setup .exe**: close Callio, then run the new `Callio_x.y.z_x64-setup.exe`. It replaces the old version in place. Your settings, recent files, Overleaf links and saved credentials are kept, and the file types are registered again automatically.
- **Portable**: just start the new `Callio.exe`, wherever you unzipped it. If an older Callio is still running, the new one offers to close it (it asks about unsaved files) and start instead. If it finds an older portable copy, it offers to **update that copy in place** (your shortcuts and *Open with* keep working) or to use the new folder from then on. From 0.5 on, a newer copy started while Callio runs offers to switch to it. Settings live in `%APPDATA%\dev.callio.editor`, not next to the exe, so nothing is lost.
- Settings → About shows the version you are running.

## Uninstall

Settings → About → **Uninstall Callio…** removes everything Callio put on the PC: the *Open with* and default-app entries, saved keys, tokens and sign-ins in Credential Manager, settings, AI memory and conversations, version history, the paper library, the TinyTeX it installed, the skills it copied into Claude Code, and the program itself (it runs the uninstaller, or deletes the portable files). Type UNINSTALL to confirm. Your own documents are never touched; Claude Code itself and the Edge extension stay (remove the extension in Edge → Extensions).

## Overleaf setup

1. **Git token**: on Overleaf, go to Account Settings → Git integration → Generate token, then paste it into Callio → Settings → Overleaf.
2. **Sign in** (for the project list, web sync and Overleaf compiles): Settings → Overleaf → **Sign in to Overleaf**, then use email, Google, ORCID or your institution in the window that opens. Callio keeps the session fresh and renews it by itself when it expires; you only sign in again if Overleaf actually logs you out. A manual cookie field is still under *Advanced*.
3. In the sidebar's **Overleaf** tab, click *Load my projects* and then a project, or paste a project URL. Callio downloads (or git-clones) the project into a folder you choose and links it.
4. Use **⤓ Pull** and **⤒ Push** in the toolbar. You can also set the engine to *Overleaf*, which pushes and compiles on Overleaf in one step.

For self-hosted Overleaf, set the server URL in Settings. Web sync works with Community Edition; Git sync works with Server Pro.

The web API is the same private API the Overleaf website uses. It works today, but it isn't an official integration, so an Overleaf update may break it. Git sync is the official path.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Ctrl+S / Ctrl+Shift+S | Save / Save as (Save compiles LaTeX, if enabled) |
| Ctrl+Enter or F5 | Compile |
| Ctrl+Shift+E | Export as PDF |
| Ctrl+Shift+M | Export as Markdown |
| F2 / Del / Ctrl+X, C, V (file list) | Rename / Delete to Recycle Bin / Cut, copy, paste |
| Shift+Alt+F / Shift+Alt+R / Shift+Alt+C (file list) | Find in folder / Reveal in Explorer / Copy path |
| Ctrl+V (PDF tab) | Paste a picture onto the page |
| Ctrl+Shift+L | Paper library |
| Alt+C | Cite a paper from the library at the cursor |
| Ctrl+Alt+J | Jump from source to PDF (SyncTeX) |
| Double-click PDF | Jump from PDF to source |
| Ctrl+O / Ctrl+Shift+O | Open file / folder (also in the Open ▾ menu) |
| Ctrl+F (in a PDF) | Find in PDF |
| Ctrl+wheel / touchpad pinch, Ctrl+= / Ctrl+- / Ctrl+0 | Zoom whatever is under the pointer: the editor, the Markdown preview, a PDF tab or the LaTeX PDF preview (the window itself never zooms) |
| Ctrl+L | AI panel |
| Ctrl+. | AI actions for the selection |
| Ctrl+N / Ctrl+Shift+N | New Markdown file / New menu (Markdown, LaTeX, BibTeX) |
| Ctrl+W, Ctrl+Tab | Close, next tab |
| Ctrl+1 / 2 / 3 | Editor / split / preview |
| Ctrl+\ | Toggle sidebar |
| Ctrl+B / Ctrl+I | Bold / italic (Markdown or LaTeX) |
| Esc / Shift+Enter (notebook) | Finish editing a cell |
| Ctrl+, | Settings |

## Building from source

Every push to `main` is built on GitHub Actions (`.github/workflows/build.yml`, a Windows runner). The run's artifacts are the two release zips — the portable folder and the installer — and the same run publishes them as the GitHub release `vX.Y.Z` of the version in `package.json` (a new version number makes a new release).

To build on your own Windows PC you need Rust (stable), Node.js 20+ and the MSVC build tools:

```powershell
npm ci
cargo build --release --manifest-path office/Cargo.toml          # the office engine
mkdir office\bin; copy office\target\release\callio-office.exe office\bin\
npx tauri build --bundles nsis   # → src-tauri\target\release\Callio.exe and bundle\nsis\*.exe
npx tauri dev                    # hot-reload development
```

From Linux, `./build-windows.sh` cross-builds the same thing with mingw-w64 and NSIS. Run `npm run dev` to try the interface in a normal browser; it uses a mock backend from `src/mock.js`.

## Layout

```
src/                 frontend (vanilla JS + Vite)
  main.js            app shell: tabs, file tree, compile, preview, shortcuts
  editor.js          CodeMirror setup, LaTeX completion
  md.js              Markdown → HTML (markdown-it, KaTeX, DOMPurify)
  pdf.js             PDF.js viewer, SyncTeX marker
  overleaf.js        Overleaf sidebar
  settings.js        settings dialog
  ai.js, ai-inline.js  AI chat, actions, inline completion, skills
  claude-code.js     Claude Code in the AI panel (permission cards, changed files)
  history.js         version history UI
  office.js          Word documents (through the office engine)
  sheet.js           spreadsheet grid
  pdftools.js        PDF tools dialog
  deck.js            presentations
  ribbon.js          the Office ribbon (ribbon-icons.json: the Craft apps' icons as SVG)
  undo.js            Undo / Redo and the 100-step lists
src-tauri/src/       backend (Rust)
  ai/                providers, tools, citation checks, skills, skills_github.rs (install from GitHub)
  claude_code/       runs the claude CLI headless; mcp.rs = Callio's local MCP server for it
  history.rs         local version history
  compile.rs         engines, root detection, log parser, Tectonic download
  synctex.rs         SyncTeX forward/inverse search
  overleaf/          git.rs (Git sync), web.rs (web API), mod.rs (pull/push/compile)
  assoc.rs           Windows file associations (HKCU)
  fsops.rs           files, dialogs
  settings.rs        settings + Windows Credential Manager
  office.rs          starts and talks to callio-office.exe
office/              callio-office: WordCraft, GridCraft, DeckCraft and PdfCraft behind a JSON-lines protocol
```

## Security notes

- Markdown HTML is sanitized (DOMPurify), and the window runs under a strict Content-Security-Policy. A hostile `.md` file can't run script.
- Shell escape is off by default. Turn it on only for documents you trust.
- Git tokens are passed to git through environment-scoped config, not the command line, and are never written to `.git/config`.
- Claude Code talks to Callio through an MCP server bound to 127.0.0.1 on a random port, protected by a random token that changes every time Callio starts. Requests from web pages are refused.
- Skills from GitHub are unpacked with path checks (no `..`, no links, size limits) into their own folders.

## Credits

Word documents, spreadsheets, presentations and PDF tools are built on WordCraft, GridCraft, DeckCraft and PdfCraft from the ArtCraft Crafting Apps (storytold, MIT OR Apache-2.0), including their ribbon icons, exported to SVG. The photo editor is built on [LightCraft](https://github.com/storytold/lightcraft) (storytold, MIT OR Apache-2.0).

## License

Callio is free and open source, dual-licensed under either of

- the **MIT license** ([LICENSE-MIT](LICENSE-MIT)), or
- the **Apache License, Version 2.0** ([LICENSE-APACHE](LICENSE-APACHE)),

at your option. Unless you explicitly state otherwise, any contribution you intentionally submit for inclusion in Callio, as defined in the Apache-2.0 license, is dual-licensed as above, without any additional terms or conditions. Third-party components and their licenses are listed in [NOTICE](NOTICE).
