# Changelog

## 0.22.0

- **Remote Control for Claude Code sessions.** Press the 📱 button in the session row (or type `/remote-control` or `/rc` in the chat) and the session can be continued from the Claude app on your phone or at claude.ai/code. A small panel shows the link (Copy · Open) and a QR code; "Tắt điều khiển từ xa" / "Turn off remote control" ends it. It is never switched on by itself, and it needs Claude Code signed in with your Claude account (not an API key); otherwise Callio says what to do.
- Things typed on the phone appear in the transcript like your own messages, labelled "📱 từ điện thoại" / "📱 from the phone", and stopping a turn from the phone shows it as stopped. A 📱 marks the session on its tab and in the sessions list; while it is on, the session is kept open (not closed when idle) so the phone can write at any time. Remote Control survives idle restarts, a chat pop-out and a crash recovery: the phone keeps the same conversation.
- **Approval questions are answered in either place.** They follow your "When Claude Code wants to change files or run commands" setting (Full access asks nobody, Auto asks only what Claude Code's auto mode escalates, Ask asks every time) and show on the phone as well as in Callio. Answer in one place and the card closes in the other, together with its "Cần bạn" toast, badge and the Allow/Deny in the activity strip and sessions list. Callio now receives these questions straight from Claude Code instead of through its own MCP tool; Callio's own tools stay auto-allowed.
- The plan-usage meters (5h · Week · Fable) now have a line of their own, directly above the sessions row, in the AI panel and in the chat window.

## 0.21.1

- Claude Code chat: the line above each answer now names the model that actually wrote it, as reported by Claude Code, and follows a model switch made in the middle of a session. Before, it could keep showing the model the session started with, or the one picked in the menu before Claude Code had switched. Subagents in the activity strip and column likewise show the model they really run on, not only the one their task asked for.

## 0.21.0

### AI chat in its own window
- **AI chat in its own window.** "Tách ra cửa sổ riêng" / "Pop out" (button in the AI panel toolbar, the ⋯ menu, or Ctrl+Shift+L while the cursor is in the AI panel) moves the whole AI panel into a separate window, titled "Callio — AI · <folder>". Put it on a second monitor; its size and place are remembered for each editor window.
- Running Claude Code sessions keep running while you pop the chat out or attach it back: nothing is restarted, no message is lost or doubled, and an approval question that arrives during the move is shown again in the new place.
- The chat window is the full AI panel for its editor window. The current selection and file stay in context and update as you move the cursor; "Add to chat", file links, Apply / diff / Undo, Insert at cursor and compile results all go to the editor window, which opens the file and shows the diff there. Permission questions from Claude Code appear in the window the session belongs to.
- "Gắn lại" / "Attach back" (Ctrl+Shift+D) or simply closing the chat window puts the chat back into the editor window with the panel open. While the chat is out the editor shows a slim rail with an attach button and dots for running / needs-you sessions, and its AI button focuses the chat window. Closing the editor window closes its chat window too (and asks first if a turn is running).
- A pin button keeps the chat window on top of the other windows.
- After an unexpected exit, Callio restores the chat window next to its editor window.

### Obsidian vault mode
- Open a folder that contains `.obsidian/` (or the vault connected in Settings) and Callio switches to vault mode: an "Obsidian vault · name" chip, `.obsidian` and the trash folder hidden, and nothing is ever written into `.obsidian/`. Callio reads `app.json` (attachment folder, where new notes go, Markdown vs wiki links, "always update links"), `daily-notes.json` and `templates.json`.
- Wiki links of every form (`[[Note]]`, `[[Folder/Note]]`, `[[Note#Heading]]`, `[[Note#^block]]`, `[[Note|alias]]`, `![[embed]]`) resolve the way Obsidian does (shortest unique path, aliases for search). Ctrl+click in the editor, or a click in the preview, opens the note and jumps to the heading or block; a link to a missing note asks before creating it. Hovering a link shows a preview card.
- Autocomplete for `[[`, `[[Note#`, `[[Note#^`, `![[` (notes and files) and `#tags`; with "Use Markdown links" on, Callio inserts `[text](path)` instead.
- Preview renders callouts (including foldable `[!note]-` / `+`), note, image, PDF (`#page=N`), audio and video embeds, `==highlights==`, `%%comments%%`, task statuses, footnotes, math and Mermaid.
- Properties: the YAML front matter becomes a typed form (text, number, checkbox, date, list chips) in the preview header and in the visual editor; add, rename and remove properties. Only the lines you edit change — the rest of the YAML stays byte for byte.
- Paste or drop an image: it is saved in the vault's attachment folder as `Pasted image YYYYMMDDHHmmss.png` and `![[…]]` is inserted.
- Renaming or moving a note or folder lists the links that will change, updates them in one step and shows an Undo that puts every note back (only notes you haven't edited since).
- New "Vault" side panel: backlinks (linked and unlinked mentions with a "Link" button), outgoing links, a tags tree with counts (click to list the notes), and a small local graph. Daily note button (creates it from your template), Insert template, and a quick switcher on Ctrl+O.
- AI: the assistant sees the open note's links and backlinks (only folders it is allowed to read), and the MCP server gains `vault_backlinks`, `vault_resolve` and `vault_tags`.

## 0.20.0

- Remote servers over SSH (Settings → Remote servers / Máy chủ SSH): Callio reads the Host entries of your ~/.ssh/config and lets you add servers of its own. Sign-in by ssh-agent, key file (passphrase asked once, optionally remembered), password or a keyboard-interactive code (OTP / 2-step). Passwords and passphrases live in Windows Credential Manager only. "Test" shows the server's system and whether it has Python, jupyter_server, rsync and Claude Code. Servers flagged "needs VPN" say so when they can't be reached.
- Host keys are checked against ~/.ssh/known_hosts (hashed entries too). An unknown key shows its SHA256 fingerprint and is saved only when you trust it; a CHANGED key stops the connection with a warning and no "continue anyway".
- One connection per server is shared by sync, Jupyter and the AI, with keep-alive and automatic reconnect. A status-bar chip shows connected / reconnecting / off.
- Linked folders with two-way sync: link a folder on this computer to a folder on the server (remote folder browser included; two-way, upload-only or download-only). Changes are noticed locally by the file watcher and on the server by polling, and copied atomically with the modified time kept and the hash verified. .git, .venv, __pycache__, node_modules, .ipynb_checkpoints and similar are left out, you can add .gitignore-style patterns, and files of 10 MB or more are not synced unless you allow them one by one (large allowed files resume after a dropped connection).
- Nothing is silently overwritten: if both sides changed, notebooks are merged cell by cell (by cell id), text files with a clean three-way merge, and anything else keeps both versions (the server's copy is saved as "name (server).ext") with Compare / Keep mine / Take the server's / Keep both. Deletions only propagate when the other side is unchanged; local deletions go to the Recycle Bin, remote ones to .callio-trash on the server. A mass deletion is held back until you confirm.
- Sync panel from the status chip: per-link state, waiting uploads/downloads, conflicts, large files not synced, Pause / Resume / Sync now. File tree badges: ↑ waiting to upload, ↓ waiting to download, ⚠ conflict, ⊘ left out. A file with unsaved edits in a tab is held back until you save.
- Jupyter on the server: the kernel picker has a "SSH server · name" group. Callio finds the Pythons on the server, installs jupyter_server + ipykernel on request, starts a Jupyter server there through an SSH tunnel (the token never appears on the server's command line) and uses the linked folder as the kernel's working directory. "Connect to a Jupyter already running on the server…" forwards an existing server by URL + token.
- Claude Code with a server: in the AI panel, "Run on" chooses This computer or the server. If Claude Code is installed on the server it runs there on the linked folder (Callio's tools stay reachable through a reverse tunnel, config files are private and removed afterwards) and its edits sync back; otherwise it runs here and gets new tools — run a command on the server (asks like Bash), read a file, list a folder, sync status / sync now — and is told the folder is mirrored there. Claude Code can be installed on the server with one click.

## 0.19.0

- Work inside WSL2: File → Open WSL folder… (and a welcome-page button) browses your distros, starts a stopped one, and opens a folder of the distro as the project. A status chip shows the distro. Files keep their line endings and, on save, their Linux permissions (the executable bit); the tree stays fresh by polling every 2 s because \\wsl.localhost does not deliver change events.
- LaTeX for a WSL folder can be compiled with latexmk/tectonic inside the distro (toolbar choice "Windows / WSL", remembered per folder).
- Jupyter: kernel picker has "WSL · distro" and "Docker · container" groups. Callio finds Pythons in the distro or container, can install jupyter_server + ipykernel, or create a .venv. Docker containers need a published port (-p 8888:8888).
- Claude Code can run inside WSL (Settings → AI → Claude Code → Run in, or per folder): paths are translated both ways, Callio's MCP tools stay reachable (127.0.0.1 in mirrored networking; in NAT mode a small token-protected forwarder on the WSL gateway address), one-click install of Claude Code in the distro, and a sign-in button.
- Settings → Environments (Môi trường): WSL distros and Docker containers with state, Start/Stop, tool check (python, jupyter, latexmk, claude), and open-folder shortcuts.

## 0.18.0

This release brings together what was planned as 0.16 (chat), 0.16.1 (memory and data settings), 0.17 (windows) and 0.18 (Jupyter).

### Claude Code chat: live sessions
- Claude Code chats are now sessions in tabs: run several at once, each with its own conversation, status dot and a "Cần bạn" / "Needs you" badge when it waits for an approval.
- The text box no longer locks while Claude Code works. Enter queues your message ("Send next"; the model reads it after the step it is doing), Ctrl+Enter stops the current step and sends it ("Interrupt & send"), Esc or Stop ends the turn. A queued message shows as a dashed row you can take back with ✕ until Claude Code has read it.
- New activity strip above the input (and an optional column beside the chat, switch with ⇔): what the model is doing now, the to-do list, running time, tokens, and every subagent with its own live log and inline Allow / Deny.
- Sessions list with groups (Needs you / Running / Recently finished), a toast when a background session needs you, and a quota refresh after every turn.
- Sessions survive a power cut: after an unexpected close Callio offers to bring them back; each shows a "Tiếp tục" / "Continue" button and nothing runs until you press it.
- Settings → AI → Claude Code: sessions at once (1–8), close idle sessions after N minutes, activity layout (strip or column).

### Chat: fast, follows the answer, smooth text, nothing lost after a crash
- Chat: long chats open instantly; old messages leave the page (placeholders) and come back from an HTML cache, with no jumps while scrolling.
- Chat: auto-scroll follows the answer only while you are at the bottom; any scroll up (wheel, keys, touch, drag, selection) stops it, and a round ↓ button (with a count of new messages) brings you back.
- Chat: new smoother streaming text effect (words fade in with a soft blur); Settings > Interface > Text effect: Smooth / Fast / Off.
- Chat: fixed the interface-translation pass walking the whole chat on every streamed token.
- Restore: after an unexpected exit Callio offers to reopen the previous tabs, with unsaved changes kept as drafts (Open > Restore drafts… lists them; drafts older than 7 days are deleted).

### AI memory and Obsidian
- **AI memory notes: MEMORY.md or an Obsidian vault.** Besides remembering every conversation, Callio now keeps one short, curated note per project with six fixed sections: *Goals*, *Decisions*, *Conventions*, *In progress*, *Open questions* and *Remember*. It lives in Callio's own data folder (private, so it never ends up in your Git history) or, if you prefer, in `<project>/MEMORY.md` — Settings → **AI memory** → *Where MEMORY.md is kept*.
  - The note (cut to about 4,000 characters, newest lines first) is added to the system prompt of every new session — in the appended system prompt for Claude Code, so it survives context compaction — and to the system message of API chats.
  - When a Claude Code session ends, a small model proposes the new note. You see a diff and accept or reject it; nothing is written without that. Accepted changes save the previous version first (it is in the file's history) and `/memory undo` takes the last update back. Choose *Only when I type /memory update* in Settings → AI memory to do it by hand; the Project memory window has an *Update the memory notes…* button too.
  - `/remember …` and the pin button also add the line to the *Remember* section (they are explicit, so there is no review).
  - If the note was changed on disk meanwhile (say, in Obsidian), Callio never overwrites it: you get the diff against what is there now.
- **Obsidian vault as the AI's memory.** Settings → AI memory → *Obsidian vault* keeps a project note in `Callio/Projects/` and one note per session in `Callio/Sessions/` (`YYYY-MM-DD <title>.md`, with the summary, files changed, decisions and a `[[Project]]` link); verbatim transcripts never go into the vault. If Callio was in Vietnamese when you set the vault up, the folders are `Dự án` and `Phiên`.
  - Claude Code gets three read-only tools, `memory_note`, `vault_search` and `vault_read`, and recall also searches the vault — only in the folders you allowed.
  - **What Callio may do is yours to choose.** For a vault you already have: *Read & search* — selected folders (default: `Callio/` and the ones you pick) or the whole vault; *Write* — only `Callio/` (default), selected folders, or nothing; *CLI* — search/read/open (default), also create notes and edit properties, or everything including running JavaScript (with a warning). The limits are enforced in Callio's backend, not only hidden in the settings; the `.obsidian` folder is always off limits.
  - **Obsidian found on this PC?** Callio fills in the install path and version, lists your vaults (the last opened is preselected), guesses the sync tool (OneDrive, Dropbox, Google Drive, iCloud, Git, Obsidian Sync) and shows whether the Obsidian command line is switched on — only when you press *Check*, because the first CLI command starts Obsidian.
  - **Not installed?** *Install Obsidian* downloads the official installer from Obsidian's GitHub, checks its checksum and signature, installs it for you only (no admin rights), creates a vault (default `D:\Notes\Callio Notes`, or Documents when there is no D:), registers it with Obsidian and walks you through the one switch for the command line. A vault Callio creates gets full permissions; every AI edit still saves the previous version and can be undone, and you can lower the permissions any time.
  - *Open in Obsidian* in the tab menu of notes inside the vault (switch it off in Settings → AI memory).

### Data storage
- **Move Callio's data to another drive.** Settings → **Data storage** shows where the data is and how big each part is — paper library, versions & backups, AI memory & session journals, unsaved drafts, citation styles, installed tools, skills & Claude Code copies — with a tick box per row and *Select all*. *Move to…* checks the free space, pauses what Callio writes (and refuses while a Claude Code session is running), copies with a progress bar, verifies every file (count, size, sha256), switches over and restarts. If anything fails Callio keeps using the old place and says why. The old copies are deleted only after you agree, on the next start.
  - A `data` folder next to `Callio.exe` makes Callio portable; the first portable start offers to move your data there.
  - If the data drive is missing at start (unplugged, BitLocker locked) Callio says so and offers *Try again*, *Choose another place* or *Open without my data* — it never creates an empty library somewhere else.
  - Stays on C: the location file, saved keys (Windows Credential Manager) and Claude Code's own data. The web view cache can't be moved.

### Windows
- **One window per folder.** Every Callio window is a session with its own folder. A file that is not inside the window's folder now opens in another window instead of changing this window's file list: if another window already has the file open, that window comes to the front on that tab; else if another window's folder holds it, it opens there; else a **new window** opens with the file's folder. This covers everything that opens a file — File ▸ Open, the recent list, drag and drop, links, search results, the AI chat's file links, Compare, Explorer's *Open with* and a second launch. Files inside the window's folder (or any file, in a window with no folder yet) open where you are. Open Folder still replaces the current window's folder.
  - Clicking a tab no longer switches the file list to that file's folder (0.14.1): a window's tabs always belong to its own list.
  - A new window starts with the file list hidden behind the rainbow line at the left edge (move the mouse there to show it; pin to keep it) and the AI panel closed. Panels, their widths and the view mode are **per window**: changing them in one window never changes another. Every other setting applies live in all windows.
  - The title bar reads "file — folder — Callio", so windows can be told apart in Alt+Tab. Closing a window with unsaved files asks first; closing the last window quits; closing the first window while others are open keeps Callio running. A second launch hands its files to the right window.
  - Lighter windows: in a new window the AI panel, writing assistant and inline suggestions load only when you open them, viewers are loaded only for kinds of files you open, and a window minimised for 30 seconds asks WebView2 to give memory back (restored the moment you return).
  - After Callio closes unexpectedly, *Reopen the previous session?* also brings back your windows (folder, size, position, panels) — each one restores its own tabs.

### Jupyter notebooks
- **Run notebooks.** `.ipynb` cells now run: Shift+Enter, Ctrl+Enter, Run all, interrupt and restart, with live streaming output, rich results (images, HTML, LaTeX, tables, errors with colour), progress bars, `input()` prompts, Tab completion and Shift+Tab help. Outputs are saved into the notebook like Jupyter does.
- **Local kernels with no setup in Callio.** Callio finds your Python (.venv, conda, the `py` launcher, PATH), starts a hidden Jupyter server on demand, and stops it when idle. Missing `jupyter_server` / `ipykernel` can be installed from the kernel picker. Callio does not bundle Python.
- **Remote Jupyter servers.** Connect by URL and token (the token is kept in Windows Credential Manager). Self-signed HTTPS servers can be trusted by pinning their certificate. Attach to running kernels or start new ones.
- **Claude Code can use the notebook.** New tools list, read, edit, insert and run cells; running asks for permission first.
- **AI in notebooks.** Ask AI about a cell (it sees the last error), and apply suggested cell edits through a reviewable diff with undo.
- **Settings.** New Jupyter group: default Python, idle shutdown, output line limit, trust HTML output.

## 0.15.0

- **Claude plan usage in the AI panel.** With Claude Code turned on, the row under the chat toolbar (next to the conversation's name) shows the **5-hour** limit, the **weekly** limit and the per-model weekly limits (**Fable**…), each as a small meter with its percentage — green, amber from 70 %, red from 90 %. Hover for when each one resets; click to read them again.
  - The numbers are the ones Claude Code's own `/usage` screen shows. Callio asks Claude Code for them (its `get_usage` request): no model is called, so it costs no quota, and Callio never touches your sign-in.
  - They are read when the panel opens, after every Claude Code answer, and once a minute while the panel is in view (not while Callio is minimised or the panel is closed).
  - Turn it off in Settings → AI → Providers → Claude Code → *Show plan usage in the AI panel*.

## 0.14.2

- Writing assistant: pressing *Check page* (or anything that redraws the panel quickly) no longer stacks extra rows of model / effort / Thinking controls — there is always exactly one. The same is fixed in the Ask AI / Translate / Meaning popup when switching modes quickly.

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
