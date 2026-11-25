// The visual (ProseMirror) editor in a vault: [[wiki links]] and #tags are coloured like in the
// source editor, and Ctrl+click on a link opens it. Nothing is rewritten: the text stays as typed.
import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { V, looksResolved } from "./vault-state.js";

const WIKI = /(!?)\[\[([^\]\n]+)\]\]/g;
const TAG = /(^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;
const parts = (inner) => {
  const s = inner.replace(/\\\|/g, "|"), bar = s.indexOf("|"), left = bar < 0 ? s : s.slice(0, bar), hash = left.indexOf("#");
  return { target: (hash < 0 ? left : left.slice(0, hash)).trim(), sub: hash < 0 ? "" : left.slice(hash + 1).trim() };
};

function scan(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (node.type.spec.code || !node.isTextblock) return !node.type.spec.code;
    const text = node.textContent;
    if (!text.includes("[[") && !text.includes("#")) return false;
    let m;
    WIKI.lastIndex = 0;
    while ((m = WIKI.exec(text))) {
      const from = pos + 1 + m.index;
      const { target } = parts(m[2]);
      out.push(Decoration.inline(from, from + m[0].length, { class: "wy-wikilink" + (m[1] ? " embed" : "") + (looksResolved(target) ? "" : " missing"), "data-wl": m[2] }));
    }
    TAG.lastIndex = 0;
    while ((m = TAG.exec(text))) { const a = pos + 1 + m.index + m[1].length; out.push(Decoration.inline(a, a + 1 + m[2].length, { class: "wy-vtag" })); }
    return false;
  });
  return DecorationSet.create(doc, out);
}

export function vaultPmPlugin() {
  return new Plugin({
    state: {
      init: (_, { doc }) => (V.on ? scan(doc) : DecorationSet.empty),
      apply: (tr, old) => (tr.docChanged && V.on && tr.doc.content.size < 600000 ? scan(tr.doc) : old.map(tr.mapping, tr.doc)),
    },
    props: {
      decorations(state) { return this.getState(state); },
      handleDOMEvents: {
        mousedown(view, e) {
          if (!V.on || !(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
          const el = e.target.closest?.(".wy-wikilink");
          if (!el) return false;
          e.preventDefault();
          const { target, sub } = parts(el.dataset.wl || "");
          import("./main.js").then(async (mn) => {
            const { relOf } = await import("./vault-state.js");
            const t = mn.activeTab();
            (await import("./vault.js")).openLink({ target, sub }, (t?.path && relOf(t.path)) || "");
          });
          return true;
        },
      },
    },
  });
}
