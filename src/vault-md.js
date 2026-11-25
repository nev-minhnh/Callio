// Obsidian-flavoured Markdown in the preview: [[wiki links]] and ![[embeds]], callouts, ==highlights==,
// %%comments%%, #tags, footnotes, task statuses, and the Properties header. The syntax is added to
// the preview's markdown-it as extra rules that only act when the render is for the vault's preview
// (`env.vault`); what needs the index (does the link resolve? what is inside the embed?) is filled
// in afterwards by `hydrate`, so rendering itself stays synchronous and fast.
import { fileSrc } from "./api.js";
import { V, vx, relOf, absOf, normHead } from "./vault-state.js";
import { activeTab } from "./main.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------------- callouts ----------------
const I = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  note: I('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>'),
  abstract: I('<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M12 11h4M12 16h4M8 11h.01M8 16h.01"/>'),
  info: I('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'),
  todo: I('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>'),
  tip: I('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>'),
  success: I('<path d="M20 6 9 17l-5-5"/>'),
  question: I('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>'),
  warning: I('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>'),
  failure: I('<path d="M18 6 6 18M6 6l12 12"/>'),
  danger: I('<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>'),
  bug: I('<path d="m8 2 1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6M12 20v-9M6 13H2M22 13h-4"/>'),
  example: I('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  quote: I('<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>'),
};
const ALIAS = { summary: "abstract", tldr: "abstract", hint: "tip", important: "tip", check: "success", done: "success", help: "question", faq: "question", caution: "warning", attention: "warning", fail: "failure", missing: "failure", error: "danger", cite: "quote" };
export const canonCallout = (t) => { const l = String(t).toLowerCase(); return ICONS[l] ? l : ALIAS[l] || "note"; };
const titleCase = (s) => s.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());

// ---------------- the markdown-it rules ----------------
let done = false;
export function install(md) {
  if (done) return;
  done = true;
  const on = (state) => !!state.env?.vault && !state.inlineMode;
  const onInline = (state) => !!state.env?.vault;

  // frontmatter → a placeholder block (the Properties header); the source lines stay as blank lines
  md.core.ruler.before("block", "vault_fm", (state) => {
    if (!on(state)) return;
    const m = /^﻿?---[ \t]*\r?\n([\s\S]*?\r?\n)(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(state.src);
    if (!m) { state.env.vaultFm = ""; return; }
    state.env.vaultFm = m[0];
    state.src = m[0].replace(/[^\n]/g, "").replace(/\n/g, "\n") + state.src.slice(m[0].length);
  });
  md.core.ruler.after("block", "vault_fm_tok", (state) => {
    if (!on(state) || state.env.noProps || state.env.vaultFm === undefined) return;
    const n = (state.env.vaultFm.match(/\n/g) || []).length;
    const tok = new state.Token("html_block", "", 0);
    tok.content = `<div class="vault-props" data-fm="${esc(state.env.vaultFm)}"></div>`;
    tok.map = [0, n]; tok.block = true;
    state.tokens.unshift(tok);
  });

  // %%comments%%: nothing is shown
  md.block.ruler.before("fence", "vault_comment", (state, startLine, endLine, silent) => {
    if (!on(state)) return false;
    const pos = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (state.src.charCodeAt(pos) !== 0x25 || state.src.charCodeAt(pos + 1) !== 0x25) return false;
    let line = startLine;
    let end = state.src.indexOf("%%", pos + 2);
    while (end < 0 || end > state.eMarks[line]) {
      if (end >= 0 && end <= state.eMarks[line]) break;
      line++;
      if (line >= endLine) return false;
      const s = state.bMarks[line];
      end = state.src.indexOf("%%", s);
      if (end >= 0 && end > state.eMarks[line]) end = -1;
      if (end >= 0) break;
    }
    if (end < 0) return false;
    // only when the comment is the whole of its lines
    if (state.src.slice(end + 2, state.eMarks[line]).trim()) return false;
    void max;
    if (silent) return true;
    state.line = line + 1;
    return true;
  });
  md.inline.ruler.before("emphasis", "vault_comment_inline", (state, silent) => {
    if (!onInline(state) || state.src.charCodeAt(state.pos) !== 0x25 || state.src.charCodeAt(state.pos + 1) !== 0x25) return false;
    const end = state.src.indexOf("%%", state.pos + 2);
    if (end < 0 || end >= state.posMax) return false;
    if (!silent) { /* hidden */ }
    state.pos = end + 2;
    return true;
  });

  // [[Note#Heading|alias]] and ![[embed]]
  md.inline.ruler.before("link", "vault_wikilink", (state, silent) => {
    if (!onInline(state)) return false;
    const src = state.src;
    let p = state.pos, embed = false;
    if (src[p] === "!" && src[p + 1] === "[") { embed = true; p++; }
    if (src[p] !== "[" || src[p + 1] !== "[") return false;
    const end = src.indexOf("]]", p + 2);
    if (end < 0 || end + 2 > state.posMax) return false;
    const inner = src.slice(p + 2, end);
    if (!inner.trim() || inner.includes("\n") || inner.includes("[[")) return false;
    if (!silent) {
      const parts = inner.replace(/\\\|/g, "|");
      const bar = parts.indexOf("|");
      const left = bar < 0 ? parts : parts.slice(0, bar), alias = bar < 0 ? "" : parts.slice(bar + 1).trim();
      const hash = left.indexOf("#");
      const target = (hash < 0 ? left : left.slice(0, hash)).trim(), sub = hash < 0 ? "" : left.slice(hash + 1).trim();
      const tok = state.push("vault_link", "", 0);
      tok.meta = { target, sub, alias, embed, raw: src.slice(state.pos, end + 2) };
    }
    state.pos = end + 2;
    return true;
  });
  md.renderer.rules.vault_link = (tokens, idx) => {
    const { target, sub, alias, embed, raw } = tokens[idx].meta;
    const attrs = `data-target="${esc(target)}" data-sub="${esc(sub)}" data-alias="${esc(alias)}"`;
    if (embed) return `<span class="vault-embed" ${attrs}>${esc(raw)}</span>`;
    const shown = alias || (target ? target + (sub ? " > " + sub.replace(/^\^/, "^") : "") : sub);
    return `<a class="wikilink" href="#" ${attrs}>${esc(shown)}</a>`;
  };

  // ==highlight==
  md.inline.ruler.before("emphasis", "vault_mark", (state, silent) => {
    if (!onInline(state) || state.src.charCodeAt(state.pos) !== 0x3d || state.src.charCodeAt(state.pos + 1) !== 0x3d) return false;
    const next = state.src[state.pos + 2];
    if (!next || /[\s=]/.test(next)) return false;
    const end = state.src.indexOf("==", state.pos + 2);
    if (end < 0 || end >= state.posMax || /\s/.test(state.src[end - 1])) return false;
    if (!silent) {
      state.push("vault_mark_open", "mark", 1);
      const oldMax = state.posMax;
      state.pos += 2; state.posMax = end;
      state.md.inline.tokenize(state);
      state.pos = end + 2; state.posMax = oldMax;
      state.push("vault_mark_close", "mark", -1);
    } else state.pos = end + 2;
    return true;
  });
  md.renderer.rules.vault_mark_open = () => "<mark>";
  md.renderer.rules.vault_mark_close = () => "</mark>";

  // #tags
  md.inline.ruler.before("emphasis", "vault_tag", (state, silent) => {
    if (!onInline(state) || state.src.charCodeAt(state.pos) !== 0x23) return false;
    const prev = state.pos ? state.src[state.pos - 1] : " ";
    if (!/[\s(]/.test(prev)) return false;
    const m = /^#([\p{L}\p{N}_/-]+)/u.exec(state.src.slice(state.pos, state.posMax));
    if (!m || /^\d+$/.test(m[1])) return false;
    if (!silent) { const tok = state.push("vault_tag", "", 0); tok.content = m[1].replace(/\/+$/, ""); }
    state.pos += 1 + m[1].replace(/\/+$/, "").length;
    return true;
  });
  md.renderer.rules.vault_tag = (tokens, idx) => `<a class="vault-tag" href="#" data-tag="${esc(tokens[idx].content)}">#${esc(tokens[idx].content)}</a>`;

  // footnotes: [^1] and [^1]: text
  md.block.ruler.before("reference", "vault_footnote_def", (state, startLine, endLine, silent) => {
    if (!on(state) || state.sCount[startLine] - state.blkIndent >= 4) return false;
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const m = /^\[\^([^\]\s]+)\]:[ \t]?/.exec(state.src.slice(start, state.eMarks[startLine]));
    if (!m) return false;
    if (silent) return true;
    let next = startLine + 1;
    while (next < endLine && !state.isEmpty(next) && !/^\[\^[^\]\s]+\]:/.test(state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]))) next++;
    const fn = (state.env.vaultFn ||= { defs: {}, order: [] });
    fn.defs[m[1]] = state.src.slice(start + m[0].length, state.eMarks[next - 1]).replace(/\n\s*/g, " ");
    state.line = next;
    return true;
  });
  md.inline.ruler.before("link", "vault_footnote_ref", (state, silent) => {
    if (!onInline(state) || state.src.charCodeAt(state.pos) !== 0x5b || state.src.charCodeAt(state.pos + 1) !== 0x5e) return false;
    const m = /^\[\^([^\]\s]+)\]/.exec(state.src.slice(state.pos, state.posMax));
    if (!m) return false;
    if (!silent) {
      const fn = (state.env.vaultFn ||= { defs: {}, order: [] });
      if (!fn.order.includes(m[1])) fn.order.push(m[1]);
      state.push("vault_fnref", "", 0).meta = { label: m[1], n: fn.order.indexOf(m[1]) + 1 };
    }
    state.pos += m[0].length;
    return true;
  });
  md.renderer.rules.vault_fnref = (tokens, idx) => { const { label, n } = tokens[idx].meta; return `<sup class="fn-ref"><a href="#fn-${esc(label)}" id="fnref-${esc(label)}" data-fn="${esc(label)}">${n}</a></sup>`; };
  md.core.ruler.push("vault_footnotes", (state) => {
    const fn = state.env.vaultFn;
    if (!on(state) || !fn?.order.length || fn.done) return;
    fn.done = true;
    const items = fn.order.filter((l) => fn.defs[l] !== undefined).map((l) => `<li id="fn-${esc(l)}">${state.md.renderInline(fn.defs[l], state.env)} <a class="fn-back" href="#fnref-${esc(l)}" data-fn="${esc(l)}" data-back="1">↩</a></li>`);
    if (!items.length) return;
    const tok = new state.Token("html_block", "", 0);
    tok.content = `<section class="footnotes"><hr><ol>${items.join("")}</ol></section>`;
    tok.block = true;
    state.tokens.push(tok);
  });

  // ^block-ids are not shown
  md.core.ruler.after("inline", "vault_blockid", (state) => {
    if (!on(state)) return;
    const re = /(^|\s)\^[A-Za-z0-9-]+\s*$/;
    for (const t of state.tokens) {
      if (t.type !== "inline" || !re.test(t.content)) continue;
      const last = t.children?.[t.children.length - 1];
      if (last?.type === "text") last.content = last.content.replace(re, "");
    }
  });

  // task statuses: - [/] half done, - [-] cancelled …
  md.core.ruler.before("tasks", "vault_tasks", (state) => {
    if (!on(state)) return;
    const toks = state.tokens;
    for (let i = 2; i < toks.length; i++) {
      const t = toks[i];
      if (t.type !== "inline" || toks[i - 1].type !== "paragraph_open" || toks[i - 2].type !== "list_item_open") continue;
      const m = /^\[([^\sxX\]])\]\s/.exec(t.content);
      if (!m) continue;
      const first = t.children[0];
      if (!first || first.type !== "text") continue;
      first.content = first.content.slice(m[0].length);
      const box = new state.Token("html_inline", "", 0);
      box.content = `<input type="checkbox" disabled data-task="${esc(m[1])}" class="task-x">`;
      t.children.unshift(box);
      toks[i - 2].attrJoin("class", "task-item");
      toks[i - 2].attrSet("data-task", m[1]);
    }
  });

  // callouts: > [!type]+ Title
  md.core.ruler.after("inline", "vault_callouts", (state) => {
    if (!on(state)) return;
    const toks = state.tokens;
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== "blockquote_open") continue;
      const p = toks[i + 1], inl = toks[i + 2];
      if (!p || p.type !== "paragraph_open" || !inl || inl.type !== "inline") continue;
      const m = /^\[!([\w-]+)\]([+-]?)[ \t]*([^\n]*)(?:\n([\s\S]*))?$/.exec(inl.content);
      if (!m) continue;
      let depth = 0, close = -1;
      for (let j = i; j < toks.length; j++) {
        if (toks[j].type === "blockquote_open") depth++;
        if (toks[j].type === "blockquote_close" && --depth === 0) { close = j; break; }
      }
      if (close < 0) continue;
      const type = m[1].toLowerCase();
      const titleSrc = m[3].trim() || titleCase(type);
      const titleToks = [];
      state.md.inline.parse(titleSrc, state.md, state.env, titleToks);
      const open = toks[i];
      open.type = "vault_callout_open"; open.tag = ""; open.meta = { type, fold: m[2], title: titleToks };
      toks[close].type = "vault_callout_close"; toks[close].tag = "";
      const rest = m[4];
      if (rest !== undefined && rest.trim()) {
        inl.content = rest; inl.children = [];
        state.md.inline.parse(rest, state.md, state.env, inl.children);
      } else {
        // the first line was all there was: drop its (now empty) paragraph
        toks.splice(i + 1, 3);
        close -= 3;
      }
    }
  });
  md.renderer.rules.vault_callout_open = (tokens, idx, o, env, self) => {
    const { type, fold, title } = tokens[idx].meta;
    const c = canonCallout(type);
    const head = `<span class="callout-icon">${ICONS[c]}</span><span class="callout-title-inner">${self.renderInline(title, o, env)}</span>`;
    if (fold) return `<details class="callout is-collapsible co-${c}" data-callout="${esc(type)}"${fold === "+" ? " open" : ""}><summary class="callout-title">${head}<span class="callout-fold"></span></summary><div class="callout-content">`;
    return `<div class="callout co-${c}" data-callout="${esc(type)}"><div class="callout-title">${head}</div><div class="callout-content">`;
  };
  // details needs its own closing tag
  md.renderer.rules.vault_callout_close = (tokens, idx) => {
    let depth = 0;
    for (let j = idx; j >= 0; j--) {
      if (tokens[j].type === "vault_callout_close") depth++;
      if (tokens[j].type === "vault_callout_open" && --depth === 0) return tokens[j].meta.fold ? "</div></details>" : "</div></div>";
    }
    return "</div></div>";
  };
}

// ---------------- filling in what needs the index ----------------
const IMG = /\.(png|jpe?g|gif|svg|webp|avif|bmp)$/i, AUD = /\.(mp3|wav|ogg|m4a|flac|webm)$/i, VID = /\.(mp4|mkv|mov|ogv)$/i;
const fromRel = () => { const t = activeTab(); return (t?.path && relOf(t.path)) || ""; };

/** After a render: properties, link colours, embeds. Only elements not yet handled are touched. */
export async function hydrate(container, from = fromRel()) {
  if (!V.on) return;
  const props = [...container.querySelectorAll(".vault-props:not([data-h])")];
  const links = [...container.querySelectorAll("a.wikilink:not([data-h]), .vault-embed:not([data-h])")];
  for (const el of [...props, ...links]) el.dataset.h = "1";
  if (props.length) import("./vault-props.js").then((m) => { for (const el of props) m.mountPreviewProps(el); });
  if (!links.length) return;
  let res = [];
  try { res = await vx("vault_resolve_many", { from, links: links.map((l) => ({ target: l.dataset.target, sub: l.dataset.sub })) }); } catch (e) { console.warn(e); return; }
  const depth = +(container.dataset.vdepth || 0);
  await Promise.all(links.map((el, i) => {
    const r = res[i] || {};
    if (el.classList.contains("wikilink")) {
      el.classList.toggle("is-unresolved", !r.rel);
      el.classList.toggle("is-halfresolved", !!r.rel && !r.subOk);
      if (r.rel) { el.dataset.rel = r.rel; el.title = r.rel; } else el.title = "Unresolved link";
      return null;
    }
    return fillEmbed(el, r, from, depth);
  }));
}

async function fillEmbed(el, r, from, depth) {
  const { target, sub, alias } = el.dataset;
  if (!r.rel) { el.className = "vault-embed vault-embed-missing"; el.textContent = target + (sub ? "#" + sub : ""); el.title = "Unresolved link"; return; }
  const abs = absOf(r.rel), name = r.rel.split("/").pop();
  if (IMG.test(name)) {
    const img = document.createElement("img");
    img.src = fileSrc(abs); img.alt = alias && !/^\d+(x\d+)?$/.test(alias) ? alias : name; img.loading = "lazy";
    const sz = /^(\d+)(?:x(\d+))?$/.exec(alias || "");
    if (sz) { img.width = +sz[1]; if (sz[2]) img.height = +sz[2]; }
    el.replaceChildren(img); el.classList.add("vault-embed-img");
    return;
  }
  if (/\.pdf$/i.test(name)) {
    const page = /page=(\d+)/.exec(sub)?.[1];
    el.classList.add("vault-embed-pdf");
    const head = document.createElement("div"); head.className = "ve-head"; head.textContent = name + (page ? ` · p. ${page}` : "");
    const fr = document.createElement("iframe"); fr.src = fileSrc(abs) + (page ? `#page=${page}` : ""); fr.loading = "lazy"; fr.title = name;
    el.replaceChildren(head, fr);
    return;
  }
  if (AUD.test(name) || VID.test(name)) {
    const m = document.createElement(AUD.test(name) ? "audio" : "video"); m.controls = true; m.src = fileSrc(abs);
    el.replaceChildren(m); return;
  }
  if (!r.isNote) { const a = document.createElement("a"); a.className = "wikilink"; a.dataset.target = target; a.href = "#"; a.textContent = name; el.replaceChildren(a); return; }
  // another note (or part of one): its text, drawn the same way, a few levels deep at most
  const chain = (el.closest(".vault-embed-note")?.dataset.chain || "") + "|" + r.rel + "#" + sub;
  if (depth >= 3 || (el.closest(".vault-embed-note")?.dataset.chain || "").split("|").includes(r.rel + "#" + sub)) {
    el.className = "vault-embed vault-embed-note vault-embed-loop"; el.textContent = "↻ " + name; return;
  }
  const data = await vx("vault_embed", { target, sub, from });
  el.className = "vault-embed vault-embed-note"; el.dataset.chain = chain; el.dataset.rel = r.rel;
  const head = document.createElement("a"); head.className = "ve-title wikilink"; head.href = "#"; head.dataset.target = r.rel.replace(/\.md$/i, ""); head.dataset.sub = sub; head.dataset.h = "1"; head.dataset.rel = r.rel;
  head.textContent = name.replace(/\.md$/i, "") + (sub ? " > " + sub : "");
  const body = document.createElement("div"); body.className = "ve-body markdown-body";
  if (!data.found) body.textContent = "…";
  else {
    const { mdToHtml } = await import("./md.js");
    const dir = absOf(r.rel).replace(/[\\/][^\\/]*$/, "");
    body.innerHTML = mdToHtml(data.text, dir, { vault: true, noProps: true });
    body.dataset.vdepth = String(depth + 1);
    await hydrate(body, r.rel);
  }
  el.replaceChildren(head, body);
}

// ---------------- hover cards ----------------
let card = null, cardTimer = 0, cardFor = null;
export function hideCard() { clearTimeout(cardTimer); card?.remove(); card = null; cardFor = null; }

/** The preview of a link as an element (a note's start or section, a picture), or null. */
export async function previewElement({ target, sub = "" }, from = fromRel()) {
  const [r] = await vx("vault_resolve_many", { from, links: [{ target, sub }] });
  if (!r?.rel) return null;
  const box = document.createElement("div");
  box.className = "vault-card-body markdown-body";
  const name = r.rel.split("/").pop();
  if (IMG.test(name)) { const img = document.createElement("img"); img.src = fileSrc(absOf(r.rel)); box.appendChild(img); return { el: box, rel: r.rel }; }
  if (!r.isNote) { box.textContent = r.rel; return { el: box, rel: r.rel }; }
  const data = await vx("vault_embed", { target, sub, from });
  const { mdToHtml } = await import("./md.js");
  const text = (data.text || "").split("\n").slice(0, 40).join("\n").slice(0, 2400);
  box.innerHTML = mdToHtml(text, absOf(r.rel).replace(/[\\/][^\\/]*$/, ""), { vault: true, noProps: true });
  box.dataset.vdepth = "2";
  await hydrate(box, r.rel);
  return { el: box, rel: r.rel };
}

function showCardAt(anchorRect, built) {
  hideCard();
  card = document.createElement("div");
  card.className = "vault-card";
  const t = document.createElement("div"); t.className = "vault-card-title"; t.textContent = built.rel.split("/").pop().replace(/\.md$/i, "");
  card.append(t, built.el);
  document.body.appendChild(card);
  const w = card.offsetWidth, h = card.offsetHeight;
  card.style.left = Math.max(8, Math.min(anchorRect.left, innerWidth - w - 8)) + "px";
  card.style.top = (anchorRect.bottom + 6 + h > innerHeight ? Math.max(8, anchorRect.top - h - 6) : anchorRect.bottom + 6) + "px";
  card.onmouseleave = hideCard;
}

/** Click and hover behaviour of the preview pane (wired once). */
export function wirePreview(container) {
  if (container._vaultWired) return;
  container._vaultWired = true;
  container.addEventListener("click", (e) => {
    if (!V.on) return;
    const a = e.target.closest("a");
    if (!a) return;
    // decide and stop the event at once (the preview's own click handler must not also run)
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    const fn = a.dataset.fn;
    if (fn) { stop(); container.querySelector("#" + CSS.escape((a.dataset.back ? "fnref-" : "fn-") + fn))?.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
    if (a.classList.contains("vault-tag")) { stop(); window.dispatchEvent(new CustomEvent("callio-vault-tag", { detail: a.dataset.tag })); return; }
    if (a.classList.contains("wikilink")) {
      stop();
      if (a.dataset.rel && a.classList.contains("ve-title")) return void import("./vault.js").then((m) => m.openRel(a.dataset.rel, a.dataset.sub));
      return void import("./vault.js").then((m) => m.openLink({ target: a.dataset.target, sub: a.dataset.sub }, fromRel()));
    }
    const href = a.getAttribute("href") || "";
    if (href && !href.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("//")) {
      stop();
      let u = href; try { u = decodeURI(href); } catch { /* literal % */ }
      const h = u.indexOf("#");
      import("./vault.js").then((m) => m.openLink({ target: h < 0 ? u : u.slice(0, h), sub: h < 0 ? "" : u.slice(h + 1), md: true }, fromRel()));
    }
  }, true);
  container.addEventListener("mouseover", (e) => {
    const a = e.target.closest?.("a.wikilink:not(.ve-title)");
    if (!a || !V.on || a === cardFor) return;
    clearTimeout(cardTimer);
    cardTimer = setTimeout(async () => {
      cardFor = a;
      try { const b = await previewElement({ target: a.dataset.target, sub: a.dataset.sub }); if (b && cardFor === a) showCardAt(a.getBoundingClientRect(), b); } catch (er) { console.warn(er); }
    }, 450);
  });
  container.addEventListener("mouseout", (e) => {
    const a = e.target.closest?.("a.wikilink");
    if (!a) return;
    clearTimeout(cardTimer);
    setTimeout(() => { if (card && !card.matches(":hover") && !a.matches(":hover")) hideCard(); }, 250);
  });
}

export { normHead };
