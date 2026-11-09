# Changelog

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
