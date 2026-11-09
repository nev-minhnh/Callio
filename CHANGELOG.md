# Changelog

## 0.14.1

- **The file list follows the tab you click.** When the tab's file is outside the folder shown, the list switches to that file's folder; when it is inside, the file is highlighted. Only one file name is ever highlighted — the active tab's.
- **File badges are now just the extension in bold colour** (no box), with a clearly different, bright colour for each kind of file: Word, Markdown, LaTeX, Excel, PowerPoint, PDF, BibTeX, data, diagrams (now also Visio .vsdx), pictures, video, audio, code, archives, programs…
- **Writing assistant: Stop checking** is always shown. While it is on, *Check page* and *Whole document* stay available — pressing either turns checking back on and checks right away (*Whole document* greys out only once the whole document has been checked). *Pause / Resume* disappear while checking is stopped, since nothing is running. The model, effort, thinking and *Auto check* stay usable: they are settings, not checks.
- **Hide the side panel with the pin button** (top right of the panel). Hidden, a thin rainbow line marks the left edge; move the mouse onto it and the panel slides in over the document, and it slides away when the mouse leaves it. Press the pin again to keep it in place.
- **Writing assistant: “Stop checking” switch**, always shown in the panel. While it is on, nothing is sent to the AI — not *Check page*, not scrolling, not *Whole document* (also from the right-click menu or Ctrl+Alt+G); *Check page*, *Whole document* and *Pause* are greyed out, and a check that was running is cancelled. Suggestions already found stay.

## 0.14.0

- **draw.io diagrams.** `.drawio`, `.dio`, `.drawio.svg` and `.drawio.png` files open in the full draw.io editor — its menus (File, Edit, View, Arrange, Extras, Help), toolbar, shape libraries and *More Shapes*, format panel, pages, layers, layouts, templates, find, math and export (PNG, JPEG, WebP, SVG, PDF, HTML, XML, animated GIF…). Everything runs from the copy shipped with Callio (`drawio.zip`, next to Callio.exe); nothing comes from the internet. Ctrl+S (or draw.io's *Save*) saves the file; unsaved changes show ● on the tab; *Export as…* asks where to save; Print and PDF open a print preview inside the editor (choose *Save as PDF* in the print dialog), and web links open in your browser. **New ▾ → draw.io diagram** makes a new one. draw.io follows Callio's theme and language.
- **Settings, redesigned.** Every page uses the same layout: titled groups, one row per setting with its name on the left and its control on the right, and switches for on/off settings.
  - **AI** has four tabs — *Providers*, *Models*, *Internet*, *Skills*.
  - **Providers** is a scrolling list (Claude Code is now one of them, at the top) with the chosen provider's settings under it, instead of every provider always expanded.
  - **Models** are grouped by AI function: *Chat and agents*, *Writing* (writing assistant, rewrites / Ask AI / Fix with AI, inline completion), *Translation and dictionary*, *Research and library* (summaries, paper details — now its own choice).
  - **Skills**: installed skills are a scrolling list with a filter.
- **Vietnamese interface everywhere**: menus, ribbons, dialogs, messages, the writing assistant, the library, the photo editor, Compare and the new settings (about 2,100 phrases), and draw.io in Vietnamese too.

## 0.13.0

- **Vietnamese interface.** Settings → Editor → *Language*: English or Tiếng Việt (Vietnamese is chosen on first start when Windows is in Vietnamese). It switches at once, without restarting — menus, toolbars, dialogs, panels, tooltips and messages; your documents, file names and AI answers are never changed. The writing assistant's explanations follow the same language.
- **Writing assistant controls:** *Check page* (the text on screen), *Whole document*, **Pause / Resume** the check that is running (nothing is lost — it goes on from where it stopped), and an **Auto check** switch to start or stop checking the screen automatically.
- **Reorder open tabs by dragging them.** Pinned tabs stay together at the front.
- **HTML files**: *Editor* (source with highlighting), *Preview* (drawn as a browser draws it, with its pictures and styles from its folder; scripts don't run), *Split* (both, the preview following as you type) and **Visual edit** — type straight into the page with a small format bar (paragraph style, bold, italic, underline, strikethrough, lists, links, pictures, clear formatting, undo/redo). Only the `<body>` is rewritten, so the `<head>`, styles and scripts stay as you wrote them. *New ▾ → HTML page*.

## 0.12.3

- The thin moving line at the top no longer runs while a dialog waits for you (opening a file or folder, Save As, signing in, printing) — it only shows while Callio itself is working.

## 0.12.2

- **Writing assistant: click a suggestion to go to it.** The passage scrolls to the middle of the screen, is selected and flashes, so you can read it in context; nothing changes until you press the fix or *Accept*.
- **Only the text on screen is checked** (automatically, after you stop typing — and 1 s after you stop scrolling; nothing is sent while you scroll). Text that was already checked and hasn't changed is never sent again. *Whole document* (or Ctrl+Alt+G, or right-click → *Check writing with AI*) checks everything, only when you ask. *Check page* checks the text on screen now.
- The document makes room for the writing panel instead of going under it.

## 0.12.1

- **Writing assistant, like Grammarly — now in Word documents, presentations and spreadsheets too** (as well as Markdown, LaTeX and text). A round button at the bottom right shows the number of suggestions; its panel has an overall score (0–100), four criteria — **Correctness, Clarity, Engagement, Delivery** — with colour-coded underlines, the document's tone, and tabs for **Suggestions**, **Goals** (domain, formality, audience, intent, English variety, personal dictionary, check as you type), **Write** (compose, rephrase, ideas), **Report** (words, sentences, reading time, most used words, your progress by week) and **Originality** (distinctive sentences searched on the web). Hover an underline for a card: Accept, Dismiss, Add to dictionary. The panel picks the provider and model, effort and thinking.
- **Callio AI popup** at the mouse: **Ask AI** (a request, quick actions, writing skills), **Translate** (Google Translate or any AI model; Vietnamese ⇄ English or any language) and **Meaning** (a dictionary for English words, the AI for anything else), each with model, effort and thinking. Right-click → *Check writing with AI*, *Ask AI…*, *Translate*, *Look up meaning* (Ctrl+Alt+G / K / T / D); double-click a word to translate it (or look it up — Goals tab). The popup now opens where the mouse is and only closes after the pointer has been over it, so it no longer disappears before it can be read.
- **Web search engine for Claude Code too**: the 🌐 and the engine chip now show for Claude Code models; with an engine picked, Claude Code searches with it (Callio's `web_search` tool) instead of its own search.
- **Library: details for PDFs that have none.** When an imported PDF has no DOI Crossref knows, the AI reads its first pages, Crossref, Semantic Scholar, OpenAlex, Google Scholar and the web are searched, and the paper gets its title, authors, year, venue, pages, DOI and abstract — and a real citation key, so it can be cited with the shortcut. *Add ▾ → Find missing details with AI* does it for every paper still missing them; each paper also has *Find details with AI*. (Settings → AI to turn it off.)

## 0.12.0

- **AI writing suggestions, like Grammarly**: spelling, grammar, punctuation, word choice, clarity and style are underlined as you write (Markdown, LaTeX, text). Click an underline for a card at the mouse with the fixes; Ignore, *Fix all*, next/previous. The card switches provider, model, effort and thinking, takes a request (“more formal”, “shorter”) and lets you pick writing guides (skills). *As I type* checks the paragraph you just wrote. Ctrl+Alt+G or **Suggestions** in the format bar.
- **Translate**: select text, right-click → Translate. Google Translate by default, or any AI model you've set up (with effort and thinking); Replace, Insert below or Copy. Works in the editor, the preview, PDFs and the chat.
- **Web search in the AI chat with the engine you choose**, next to the globe: Google, Cốc Cốc, Bing, Yahoo!, Yandex, DuckDuckGo, Baidu, Naver, Ecosia, Brave Search, Ask.com, and for papers Google Scholar, Semantic Scholar, OpenAlex, arXiv, PubMed, Europe PMC, Crossref and DBLP. Engines are read from their own results pages, like in your browser; no key needed.
- **Compare, visually**: Word and Markdown files side by side as documents with the changed words marked; spreadsheets and CSV as tables with changed cells; PDFs, Word pages and slides as they print, with the differences tinted (slides and pages are paired by their content, so an inserted slide doesn't shift the rest). The text view is still there; its “unchanged lines” bar no longer glares in dark mode.
- **PDF → Word / Markdown** from the file list and the tab menu, with much better results: pictures kept, tables that continue in the next column joined, bold and italic, hyphenation, titles over several lines, no false list items.
- **Tab menu** like Notepad++: Close, *Close multiple tabs* (all but this, all but pinned, to the left, to the right, unchanged), Pin tab, Save, Save As, Print, the PDF converters, Open in default app / Explorer / Terminal, Reveal in file list, Copy path, Rename.
- **File list**: an icon with the type before every file, nothing greyed out, guide lines, the folder itself on top, temp and hidden files (~$…, .tmp, Thumbs.db…) left out, and changes on disk show up at once. Switching tabs selects the file in the list.
- **New ▾** lists every kind of file Callio makes (Markdown, text, LaTeX, BibTeX, CSV, TSV, JSON, XML, YAML, Mermaid, notebook, Word, Excel, PowerPoint); **Save ▾** redone (Save, Save As, Save All, Export).
- **Mermaid** diagrams: `.mmd` files and ```mermaid blocks are drawn in the preview; ask the AI to create or change a diagram; save it as SVG or PNG.
- **Pictures open in a light viewer** (zoom, pan, rotate the view, next/previous in the folder); switch on **Edit** for the photo editor.
- **Audio and video player**: play, seek, speed, loop, volume, picture-in-picture, full screen, subtitles; formats Windows can't play are converted with FFmpeg when it's installed.
- **Archives** ask before extracting and let you pick the extractor installed on your PC (7-Zip, WinRAR, Bandizip, PeaZip, NanaZip, Windows). **Programs** (.exe, .msi…) ask before they start, outside Callio.
- **Every wait shows progress**: a loading card for opening, converting and saving large files, a thin line at the top for anything else that takes a moment; every save, conversion and export says whether it worked.
- **Typing in Word, Excel and PowerPoint feels instant**: the letters appear right away, while the page catches up.
- **AI chat**: prompt caching (the stable parts first), a history window of about 12,000 tokens with a one-time summary of older turns (model set in Settings → AI), recall of earlier turns in the same chat, and `/brief` for a summary of the project and the open file.
- Bigger app icon in the taskbar; the office engine is warmed up in the background after start.

## 0.11.0 — Callio

- **New name: Callio** — *Callio – Shape your folio*. New logo and icons. Settings, saved keys, library, history, TinyTeX, Overleaf links and “Open with” entries move over from Proemia (and Quire) on first start.
- **New look** in the logo's forest green and gold, light and dark: the title bar, tabs, sidebar, menus, dialogs and a redesigned Settings window (section icons, cards, an About page with the logo).
- **One icon set** everywhere (toolbar, format bar, code tools, PDF viewer, compare, PDF tools, notebooks, tables, pictures): same size, stroke and baseline, no more emoji that sit too high or too low.
- **Menus**: one font size and row height, shortcuts lined up on the right; Esc closes a menu opened with the mouse.
- **Smoother motion**: tab, sidebar and settings indicators slide, panels fade in, and Windows' *reduce motion* setting is respected.
- Narrow windows keep the toolbar on one row (labels move into the tooltips).
- Built on GitHub Actions; source on GitHub under MIT OR Apache-2.0.

## 0.10.0 (Proemia)

- Photo editor: a full ribbon, histogram, every adjustment panel, masks, retouching, crop and geometry; Save, Export, `.xmp` sidecars for raw files.
- Split view keeps CSV/TSV tables and JSON/XML/YAML trees scrolled with the text.

## 0.9.0 (Proemia)

- JSON, XML and YAML: beautify, minify, validate, coloured brackets, folding and a tree view; indentation, line endings and encodings in the status bar.
- CSV/TSV open as an editable table; Compare for two files or folders.
