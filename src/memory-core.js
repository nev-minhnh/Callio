// The curated memory notes (MEMORY.md / an Obsidian project note): pure helpers with no imports,
// the same rules as src-tauri/src/notes_core.rs (which does the real reading, capping and
// writing). Used to check the AI's proposal before the author reviews it, and by the dev mock.
export const SECTIONS = ["Goals", "Decisions", "Conventions", "In progress", "Open questions", "Remember"];
export const PROMPT_CAP = 4000;

export function template(name, projectPath, vault) {
  const fm = vault ? `---\nprojects:\n  - "${projectPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\ntags: [callio, project]\n---\n` : "";
  return fm + `# ${vault ? name : "Memory — " + name}\n` + SECTIONS.map((h) => `\n## ${h}\n`).join("");
}

export function stripFrontmatter(t) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(t);
  return m ? t.slice(m[0].length) : t;
}
export function frontmatterOf(t) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(t);
  return m ? m[0] : "";
}

/** Append "- line" to a section (created if missing); the same line is never added twice. */
export function appendToSection(text, section, line) {
  line = String(line).trim().replace(/\n/g, " ");
  if (!line) return text;
  const item = `- ${line}`;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const head = `## ${section}`;
  const at = lines.findIndex((l) => l.trimEnd().toLowerCase() === head.toLowerCase());
  if (at < 0) return text.trimEnd() + `\n\n${head}\n${item}\n`;
  let end = lines.findIndex((l, i) => i > at && /^#{1,2} /.test(l));
  if (end < 0) end = lines.length;
  if (lines.slice(at + 1, end).some((l) => l.trim() === item)) return text;
  let ins = end;
  while (ins > at + 1 && !lines[ins - 1].trim()) ins--;
  lines.splice(ins, 0, item);
  if (ins + 1 < lines.length && lines[ins + 1].startsWith("## ")) lines.splice(ins + 1, 0, "");
  return lines.join("\n") + "\n";
}

/** The note cut to `max` characters for the prompt: each section keeps its newest (last) lines. */
export function cap(text, max = PROMPT_CAP) {
  text = stripFrontmatter(text).trim();
  if ([...text].length <= max) return text;
  const pre = [], secs = [];
  for (const l of text.split("\n")) {
    if (l.startsWith("## ")) secs.push([l, []]);
    else if (secs.length) { if (l.trim()) secs.at(-1)[1].push(l); }
    else if (l.trim()) pre.push(l);
  }
  const fixed = pre.reduce((n, l) => n + [...l].length + 1, 0) + secs.reduce((n, [h]) => n + [...h].length + 2, 0) + 40;
  let budget = Math.max(0, max - fixed);
  const need = (ls) => ls.reduce((n, l) => n + [...l].length + 1, 0);
  const order = secs.map((_, i) => i).sort((a, b) => need(secs[a][1]) - need(secs[b][1]));
  const alloc = secs.map(() => 0);
  order.forEach((i, k) => { const share = Math.floor(budget / Math.max(1, secs.length - k)); alloc[i] = Math.min(need(secs[i][1]), share); budget -= alloc[i]; });
  let out = pre.join("\n");
  secs.forEach(([h, ls], i) => {
    out += `\n\n${h}\n`;
    const keep = []; let used = 0, cut = false;
    for (const l of [...ls].reverse()) { const n = [...l].length + 1; if (used + n > alloc[i]) { cut = true; break; } used += n; keep.unshift(l); }
    if (cut) out += "- … (older lines left out)\n";
    out += keep.join("\n");
  });
  out = out.trim();
  return [...out].length > max ? [...out].slice(0, max - 1).join("") + "…" : out;
}

/** Every fixed section present (missing ones appended), whatever the model wrote. */
export function ensureSections(text) {
  let out = text.trimEnd() + "\n";
  for (const h of SECTIONS) if (!new RegExp(`^## ${h}\\s*$`, "im").test(out)) out += `\n## ${h}\n`;
  return out;
}

export function sanitizeTitle(s) {
  const t = String(s || "").replace(/[\u0000-\u001f\\/:*?"<>|#^[\]]/g, " ").split(/\s+/).filter(Boolean).join(" ");
  return [...t].slice(0, 80).join("").trim().replace(/^\.+|\.+$/g, "").trim();
}
export const projectNoteName = (name) => `${sanitizeTitle(name) || "Project"}.md`;
export const sessionNoteName = (date, title) => `${date} ${sanitizeTitle(title) || "Session"}.md`;
/** Names of the folders inside the Callio folder: Vietnamese when the UI was Vietnamese at set-up. */
export const folderNames = (vi) => (vi ? { projects: "Dự án", sessions: "Phiên" } : { projects: "Projects", sessions: "Sessions" });

/** The path pieces (vault-relative) for a project note and a session note. */
export function notePaths(o, project, date, title) {
  const cd = (o.callioDir || "Callio").replace(/^\/+|\/+$/g, "");
  const base = project.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Project";
  return { project: `${cd}/${o.folderNames?.projects || "Projects"}/${projectNoteName(base)}`, session: `${cd}/${o.folderNames?.sessions || "Sessions"}/${sessionNoteName(date, title)}`, name: base };
}
