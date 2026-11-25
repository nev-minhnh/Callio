// What every vault module shares: is this window in vault mode, where is the vault, and the
// small lookups (paths, note names) the editor, the preview and the panels all need.
// Kept tiny and free of other imports so md.js and the visual editor can load it at no cost.
import { call } from "./api.js";

export const V = {
  on: false,
  root: "",
  name: "",
  config: {},
  notes: [], // [{rel, name, aliases, mtime}]
  files: [], // other files: [{rel, name}]
  tags: [], // [{tag, count}]
  names: new Set(), // lowercase stems / file names, for colouring links before they are resolved
  paths: new Set(), // lowercase vault paths without ".md"
};

export const norm = (p) => String(p || "").replace(/\\/g, "/");
/** The path of `abs` inside the vault ("Notes/A.md"), or null if it is outside. */
export function relOf(abs) {
  const r = norm(V.root).replace(/\/+$/, ""), a = norm(abs);
  return V.root && a.toLowerCase().startsWith(r.toLowerCase() + "/") ? a.slice(r.length + 1) : null;
}
/** The full path of a vault path, with the separators the vault was opened with. */
export function absOf(rel) {
  const back = V.root.includes("\\");
  const base = V.root.replace(/[\\/]+$/, "");
  return base + (back ? "\\" : "/") + (back ? String(rel).replace(/\//g, "\\") : rel);
}
export const stemOf = (rel) => { const n = rel.split("/").pop(); return /\.md$/i.test(n) ? n.slice(0, -3) : n; };
export const dirOfRel = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

/** A vault command; `root` is added for you. */
export const vx = (cmd, args = {}) => call(cmd, { args: { root: V.root, ...args } });

/** Heading text the way links compare it: case and punctuation don't matter. */
export const normHead = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The text that finds `rel` among all notes: the name, or the shortest folder path that is unique. */
export function linkTextFor(rel) {
  const md = /\.md$/i.test(rel);
  const strip = (p) => (md ? p.replace(/\.md$/i, "") : p);
  const parts = rel.split("/");
  const last = parts[parts.length - 1].toLowerCase();
  const same = [...V.notes.map((n) => n.rel), ...V.files.map((f) => f.rel)].filter((r) => r.split("/").pop().toLowerCase() === last);
  if (same.length <= 1) return strip(parts[parts.length - 1]);
  for (let n = 1; n <= parts.length; n++) {
    const tail = "/" + parts.slice(parts.length - n).join("/").toLowerCase();
    if (same.filter((r) => ("/" + r.toLowerCase()).endsWith(tail)).length === 1) return strip(parts.slice(parts.length - n).join("/"));
  }
  return strip(rel);
}

/** Does this link target probably point at something? (a quick guess for colouring; Rust decides) */
export function looksResolved(target) {
  let t = String(target || "").trim().toLowerCase().replace(/\\/g, "/");
  if (!t) return true;
  t = t.replace(/\.md$/, "");
  if (t.includes("/")) return V.paths.has(t) || [...V.paths].some((p) => p.endsWith("/" + t));
  return V.names.has(t);
}

const listeners = new Set();
/** Run `f` whenever the vault's notes, tags or links changed. */
export function onVaultChange(f) { listeners.add(f); return () => listeners.delete(f); }
export function emitVaultChange(what = "notes") { for (const f of listeners) { try { f(what); } catch (e) { console.warn(e); } } }
