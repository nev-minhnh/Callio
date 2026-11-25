// The small, dependency-free part of the WSL / Docker support: recognising a WSL path and deciding
// where Claude Code and the LaTeX tools should run for a folder. Imported by api.js, cc-sessions.js and
// jupyter.js, so it must stay tiny and must not import main.js (the settings come in through bind()).
// The screens (settings page, folder dialog, status chip) are in envs.js, loaded when needed.

let getSettings = () => ({});
/** main.js hands over its settings getter once. */
export function bindEnvSettings(fn) { getSettings = fn; }

const norm = (p) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** `\\wsl.localhost\Ubuntu\home\u` (or `\\wsl$\…`) → { distro, linux }; null for any other path. */
export function wslParts(p) {
  const m = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]+([^\\/]+)((?:[\\/].*)?)$/i.exec(String(p || "").trim());
  if (!m) return null;
  const linux = "/" + m[2].split(/[\\/]+/).filter(Boolean).join("/");
  return { distro: m[1], linux };
}
export const isWslPath = (p) => !!wslParts(p);

/** The WSL path for a distro and a Linux path. */
export const wslUnc = (distro, linux) => `\\\\wsl.localhost\\${distro}${String(linux || "/").replace(/\//g, "\\").replace(/\\+$/, "")}`;

/** What was chosen for the folder `p` is in: { cc: "wsl"|"windows", tools: "wsl"|"windows" } (only what was set). */
export function folderPref(p) {
  const prefs = getSettings().envFolderPrefs || {};
  const k = norm(p);
  let best = "";
  for (const key of Object.keys(prefs)) if ((k === key || k.startsWith(key + "/")) && key.length > best.length) best = key;
  return best ? prefs[best] : {};
}

/** Where a Claude Code session for `cwd` runs: "windows" or "wsl:<distro>". */
export function ccRunIn(cwd) {
  const w = wslParts(cwd);
  const pref = folderPref(cwd);
  if (w) return pref.cc === "windows" ? "windows" : `wsl:${w.distro}`;
  // a Windows folder follows the global choice (Settings → AI → Claude Code)
  const g = getSettings().ccRunIn;
  return pref.cc === "windows" ? "windows" : typeof g === "string" && g.startsWith("wsl:") ? g : "windows";
}

/** Where LaTeX tools for the project at `root` run: null (Windows) or "wsl:<distro>". */
export function toolsIn(root) {
  const w = wslParts(root);
  if (!w) return null;
  return folderPref(root).tools === "wsl" ? `wsl:${w.distro}` : null;
}

// ---- paths on the way to and from Claude Code in WSL ----
// The MCP tools (editor_state, open_file, compile) speak the window's paths. A Claude Code that runs in
// WSL needs Linux paths, and gives them back, so they are translated at the edge.
const inWsl = (folder) => ccRunIn(folder).startsWith("wsl:");

/** A window path as the Claude Code of `folder` should see it (unchanged unless that Claude Code runs in WSL). */
export function forClaude(p, folder) {
  if (!p || !inWsl(folder)) return p;
  const w = wslParts(p);
  if (w) return w.linux;
  const m = /^([A-Za-z]):[\\/]*(.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`.replace(/\/$/, "") : p;
}

/** A path Claude Code (in WSL) gives back → the window's path. */
export function fromClaude(p, folder) {
  if (!p || !inWsl(folder)) return p;
  const m = /^\/mnt\/([a-z])(?:\/(.*))?$/.exec(p);
  if (m) return `${m[1].toUpperCase()}:\\${(m[2] || "").replace(/\//g, "\\")}`;
  const w = wslParts(folder) || (/^wsl:(.+)$/.exec(ccRunIn(folder)) && { distro: /^wsl:(.+)$/.exec(ccRunIn(folder))[1] });
  return p.startsWith("/") && w ? wslUnc(w.distro, p) : p;
}
