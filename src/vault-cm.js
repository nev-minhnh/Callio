// The Markdown source editor in a vault: colours for [[links]], #tags, ==highlights==, %%comments%%
// and callouts; completion after `[[` (notes, aliases, then headings and ^blocks) and after `#`
// (tags); Ctrl+click opens a link; a hover card previews it; pasted or dropped pictures go to the
// vault's attachment folder.
import { Decoration, ViewPlugin, EditorView, hoverTooltip } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { V, vx, relOf, absOf, linkTextFor, looksResolved, normHead, stemOf } from "./vault-state.js";
import { activeTab } from "./main.js";

const WIKI = /(!?)\[\[([^\]\n]+)\]\]/g;
const TAG = /(^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;
const fromRel = () => { const t = activeTab(); return (t?.path && relOf(t.path)) || ""; };

const mark = (c, attrs) => Decoration.mark({ class: c, attributes: attrs });
const D = {
  link: mark("cm-wikilink"), missing: mark("cm-wikilink cm-wikilink-missing"), embed: mark("cm-wikilink cm-wikilink-embed"),
  br: mark("cm-wl-br"), tag: mark("cm-vtag"), hl: mark("cm-vhl"), comment: mark("cm-vcomment"),
};

/** `[[Note#Head|alias]]` → its parts. */
export function parseWiki(inner) {
  const s = inner.replace(/\\\|/g, "|");
  const bar = s.indexOf("|");
  const left = bar < 0 ? s : s.slice(0, bar), alias = bar < 0 ? "" : s.slice(bar + 1);
  const hash = left.indexOf("#");
  return { target: (hash < 0 ? left : left.slice(0, hash)).trim(), sub: hash < 0 ? "" : left.slice(hash + 1).trim(), alias };
}

function calloutLines(doc, n, cache) {
  // is line n part of a callout (a quote block whose first line is "> [!type]")?
  if (cache.has(n)) return cache.get(n);
  let k = n;
  while (k > 1 && /^\s{0,3}>/.test(doc.line(k - 1).text) && n - k < 200) k--;
  const m = /^\s{0,3}>\s*\[!([\w-]+)\]([+-]?)/.exec(doc.line(k).text);
  const out = m ? { type: m[1].toLowerCase(), head: k === n } : null;
  cache.set(n, out);
  return out;
}

function build(view) {
  const doc = view.state.doc;
  const cache = new Map();
  const items = [];
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const text = line.text;
      if (/^\s{0,3}>/.test(text)) {
        const c = calloutLines(doc, line.number, cache);
        if (c) items.push([line.from, line.from, Decoration.line({ class: `cm-callout ${c.head ? "cm-callout-head" : ""} cm-co-${c.type}` })]);
      }
      let m;
      WIKI.lastIndex = 0;
      while ((m = WIKI.exec(text))) {
        const a = line.from + m.index, z = a + m[0].length, open = m[1] ? 3 : 2;
        const { target } = parseWiki(m[2]);
        items.push([a, z, m[1] ? D.embed : looksResolved(target) ? D.link : D.missing]);
        items.push([a, a + open, D.br], [z - 2, z, D.br]);
      }
      TAG.lastIndex = 0;
      while ((m = TAG.exec(text))) {
        if (/^\s{0,3}#{1,6}\s/.test(text)) break;
        const a = line.from + m.index + m[1].length;
        items.push([a, a + 1 + m[2].length, D.tag]);
      }
      for (const [re, deco] of [[/==(?=\S)(.+?)(?<=\S)==/g, D.hl], [/%%.+?%%/g, D.comment]]) {
        re.lastIndex = 0;
        while ((m = re.exec(text))) items.push([line.from + m.index, line.from + m.index + m[0].length, deco]);
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(items.map(([a, z, d]) => d.range(a, z)), true);
}

const decorations = ViewPlugin.fromClass(class {
  constructor(view) { this.deco = build(view); this.v = V.notes.length; }
  update(u) { if (u.docChanged || u.viewportChanged || this.v !== V.notes.length) { this.deco = build(u.view); this.v = V.notes.length; } }
}, { decorations: (p) => p.deco });

/** The wiki link under document position `pos`, if any. */
function linkAt(state, pos) {
  const line = state.doc.lineAt(pos);
  WIKI.lastIndex = 0;
  let m;
  while ((m = WIKI.exec(line.text))) {
    const a = line.from + m.index, z = a + m[0].length;
    if (pos >= a && pos <= z) return { ...parseWiki(m[2]), from: a, to: z, embed: !!m[1] };
  }
  // [text](Note.md) too
  const MD = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;
  while ((m = MD.exec(line.text))) {
    const a = line.from + m.index, z = a + m[0].length;
    if (pos >= a && pos <= z && !/^[a-z][a-z0-9+.-]*:/i.test(m[1])) {
      let u = m[1].trim().replace(/^<|>$/g, ""); try { u = decodeURI(u); } catch { /* literal % */ }
      const h = u.indexOf("#");
      return { target: h < 0 ? u : u.slice(0, h), sub: h < 0 ? "" : u.slice(h + 1), md: true, from: a, to: z };
    }
  }
  return null;
}

const clicks = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (!V.on || !(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) return false;
    const l = linkAt(view.state, pos);
    if (!l) return false;
    e.preventDefault();
    import("./vault.js").then((m) => m.openLink(l, fromRel()));
    return true;
  },
  paste(e, view) {
    const f = [...(e.clipboardData?.files || [])].find((x) => /^image\//.test(x.type));
    if (!V.on || !f) return false;
    e.preventDefault();
    insertPicture(view, f);
    return true;
  },
  drop(e, view) {
    const f = [...(e.dataTransfer?.files || [])].find((x) => /^image\//.test(x.type));
    if (!V.on || !f) return false;
    e.preventDefault();
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos != null) view.dispatch({ selection: { anchor: pos } });
    insertPicture(view, f);
    return true;
  },
});

/** Save a picture file into the vault's attachment folder and write the link where the cursor is. */
export async function insertPicture(view, file) {
  const ext = (file.name && /\.(\w+)$/.exec(file.name)?.[1]) || (file.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/\+.*/, "");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const m = await import("./vault.js");
  const named = file.name && !/^image\.\w+$/i.test(file.name) ? file.name : null;
  try {
    const text = await m.saveAttachment(bytes, ext, fromRel(), named);
    view.dispatch(view.state.replaceSelection(text), { userEvent: "input.paste", scrollIntoView: true });
  } catch (e) {
    (await import("./main.js")).toast(`Couldn't save the picture: ${e.message || e}`, "err");
  }
}

// ---------------- hover card ----------------
const hover = hoverTooltip(async (view, pos) => {
  if (!V.on) return null;
  const l = linkAt(view.state, pos);
  if (!l || l.embed) return null;
  const { previewElement } = await import("./vault-md.js");
  const b = await previewElement(l, fromRel()).catch(() => null);
  if (!b) return null;
  return {
    pos: l.from, end: l.to, above: false,
    create() {
      const dom = document.createElement("div");
      dom.className = "vault-card";
      const t = document.createElement("div"); t.className = "vault-card-title"; t.textContent = stemOf(b.rel);
      dom.append(t, b.el);
      return { dom };
    },
  };
}, { hoverTime: 450 });

// ---------------- completion ----------------
/** Rough fuzzy score: higher is better; 0 = no match. */
export function fuzzy(q, s) {
  if (!q) return 1;
  q = q.toLowerCase(); s = s.toLowerCase();
  const at = s.indexOf(q);
  if (at === 0) return 1000 - s.length;
  if (at > 0) return 700 - at - s.length / 10;
  let i = 0, score = 0, last = -2;
  for (let k = 0; k < s.length && i < q.length; k++) {
    if (s[k] === q[i]) { score += (k === last + 1 ? 6 : 2) + (k === 0 || /[\s/_-]/.test(s[k - 1]) ? 4 : 0); last = k; i++; }
  }
  return i === q.length ? 100 + score - s.length / 20 : 0;
}

async function wikiCompletions(ctx, m) {
  const embed = !!m[1], q = m[2];
  const cfg = V.config;
  const hash = q.indexOf("#");
  const markdownLinks = !!cfg.useMarkdownLinks;
  const lineStart = ctx.pos - q.length - 2 - (embed ? 1 : 0);
  const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
  const closeTo = after === "]]" ? ctx.pos + 2 : ctx.pos;
  if (hash >= 0) {
    const note = q.slice(0, hash), rest = q.slice(hash + 1);
    let rel = fromRel();
    if (note.trim()) {
      const r = await vx("vault_resolve", { target: note.trim(), from: fromRel() });
      rel = r.rel || V.notes.find((n) => n.aliases.some((a) => a.toLowerCase() === note.trim().toLowerCase()))?.rel;
    }
    if (!rel || !/\.md$/i.test(rel)) return null;
    if (rest.startsWith("^")) {
      const blocks = await vx("vault_blocks", { rel });
      return { from: ctx.pos - rest.length + 1, to: closeTo, options: blocks.map((b) => ({ label: b.id, detail: b.text, type: "text", apply: (v, c, from, to) => v.dispatch({ changes: { from, to: Math.max(to, closeTo), insert: b.id + "]]" }, selection: { anchor: from + b.id.length + 2 } }) })), filter: false };
    }
    const heads = await vx("vault_headings", { rel });
    const opts = heads.filter((h) => fuzzy(rest, h.text)).sort((a, b) => fuzzy(rest, b.text) - fuzzy(rest, a.text)).map((h) => ({ label: h.text, detail: "H" + h.level, type: "text", apply: (v, c, from, to) => v.dispatch({ changes: { from, to: Math.max(to, closeTo), insert: h.text + "]]" }, selection: { anchor: from + h.text.length + 2 } }) }));
    return { from: ctx.pos - rest.length, to: closeTo, options: opts, filter: false };
  }
  const pool = [];
  for (const n of V.notes) {
    const sc = fuzzy(q, n.name) || fuzzy(q, n.rel) * 0.6;
    if (sc) pool.push({ sc: sc + 1, rel: n.rel, name: n.name });
    for (const a of n.aliases) { const s2 = fuzzy(q, a); if (s2 && q) pool.push({ sc: s2 * 0.9, rel: n.rel, name: n.name, alias: a }); }
  }
  if (embed) for (const f of V.files) { const sc = fuzzy(q, f.name); if (sc) pool.push({ sc, rel: f.rel, name: f.name, file: true }); }
  pool.sort((a, b) => b.sc - a.sc || a.name.localeCompare(b.name));
  const options = pool.slice(0, 60).map((p) => {
    const folder = p.rel.includes("/") ? p.rel.slice(0, p.rel.lastIndexOf("/")) : "";
    return {
      label: p.alias || p.name, detail: p.alias ? `→ ${p.name}` : folder, type: p.file ? "variable" : "text",
      apply(v, c, from, to) {
        const link = linkTextFor(p.rel);
        let ins, cursor;
        if (markdownLinks) {
          const text = p.alias || p.name;
          ins = `${embed ? "!" : ""}[${p.file ? "" : text}](${encodeURI(p.rel).replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
          v.dispatch({ changes: { from: lineStart, to: Math.max(to, closeTo), insert: ins }, selection: { anchor: lineStart + ins.length }, userEvent: "input.complete" });
          return;
        }
        ins = link + (p.alias ? `|${p.alias}` : "") + "]]";
        cursor = from + ins.length;
        v.dispatch({ changes: { from, to: Math.max(to, closeTo), insert: ins }, selection: { anchor: cursor }, userEvent: "input.complete" });
      },
    };
  });
  return { from: ctx.pos - q.length, to: closeTo, options, filter: false };
}

async function vaultSource(ctx) {
  if (!V.on) return null;
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  let m = /(!?)\[\[([^\]|\n]*)$/.exec(before);
  if (m) return wikiCompletions(ctx, m);
  m = /(^|[\s(])#([\p{L}\p{N}_/-]*)$/u.exec(before);
  if (m && !/^\s{0,3}#{1,6}\s/.test(before)) {
    const q = m[2];
    if (!q && !ctx.explicit) return null;
    const opts = V.tags.filter((t) => fuzzy(q, t.tag)).sort((a, b) => fuzzy(q, b.tag) - fuzzy(q, a.tag) || b.count - a.count).slice(0, 40).map((t) => ({ label: t.tag, detail: String(t.count), type: "keyword" }));
    return { from: ctx.pos - q.length, options: opts, filter: false };
  }
  return null;
}

const completion = EditorState.languageData.of(() => [{ autocomplete: vaultSource }]);

const theme = EditorView.baseTheme({
  ".cm-wikilink": { color: "var(--accent)", textDecoration: "none", cursor: "text" },
  ".cm-wikilink-missing": { opacity: ".72", textDecoration: "underline dotted" },
  ".cm-wikilink-embed": { color: "var(--gold, var(--accent))" },
  ".cm-wl-br": { opacity: ".45" },
  ".cm-vtag": { color: "var(--accent)", background: "var(--accent-soft)", borderRadius: "8px", padding: "0 3px" },
  ".cm-vhl": { background: "color-mix(in srgb, #f5c542 38%, transparent)", borderRadius: "2px" },
  ".cm-vcomment": { opacity: ".5", fontStyle: "italic" },
});

/** All the editor parts for a Markdown note in a vault. */
export function vaultExtension() {
  return [decorations, clicks, hover, completion, theme];
}
export { absOf };
