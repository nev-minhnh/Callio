// Reading aids for code and structured files (JSON, XML, YAML…): indentation guides with the
// current block's guide lit up, the current block tinted, and brackets coloured by depth.
// Everything is computed for the visible lines only, so huge files stay smooth.
import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree, getIndentUnit } from "@codemirror/language";

const OPEN = new Set(["{", "[", "("]), CLOSE = new Set(["}", "]", ")"]);

function levelOf(text, tab, unit) {
  let w = 0, i = 0;
  for (; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32) w++;
    else if (c === 9) w += tab - (w % tab);
    else break;
  }
  return i === text.length ? -1 : Math.floor(w / unit); // -1: blank line
}

const styleCache = new Map();
function guideStyle(n, active, unit) {
  const key = `${n}|${active}|${unit}`;
  let s = styleCache.get(key);
  if (s) return s;
  const imgs = [], pos = [];
  for (let k = 0; k < n; k++) {
    const c = k === active ? "var(--guide-active)" : "var(--guide)";
    imgs.push(`linear-gradient(${c},${c})`);
    pos.push(`calc(var(--cm-pad, 6px) + ${k * unit}ch) 0`);
  }
  s = `background-image:${imgs.join(",")};background-position:${pos.join(",")};background-size:1px 100%;background-repeat:no-repeat`;
  styleCache.set(key, s);
  return s;
}

function guides(view) {
  const { state } = view;
  const tab = state.tabSize;
  const unit = Math.max(1, getIndentUnit(state));
  const doc = state.doc;
  const b = new RangeSetBuilder();
  if (!view.visibleRanges.length) return b.finish();
  const first = doc.lineAt(view.visibleRanges[0].from).number;
  const last = doc.lineAt(view.visibleRanges[view.visibleRanges.length - 1].to).number;
  const lv = (n) => levelOf(doc.line(n).text, tab, unit);
  // levels for the visible lines; blank lines take the smaller of their neighbours'
  const from = Math.max(1, first - 1), to = Math.min(doc.lines, last + 1);
  const levels = new Map();
  for (let n = from; n <= to; n++) levels.set(n, lv(n));
  const filled = (n) => {
    let l = levels.has(n) ? levels.get(n) : lv(n);
    if (l >= 0) return l;
    let up = -1, down = -1;
    for (let k = n - 1, g = 0; k >= 1 && g < 200; k--, g++) { const x = levels.has(k) ? levels.get(k) : lv(k); if (x >= 0) { up = x; break; } }
    for (let k = n + 1, g = 0; k <= doc.lines && g < 200; k++, g++) { const x = levels.has(k) ? levels.get(k) : lv(k); if (x >= 0) { down = x; break; } }
    return Math.max(0, Math.min(up, down));
  };
  // the current block: the lines under the cursor's line (if it opens one), or the block it is in
  const cur = doc.lineAt(state.selection.main.head).number;
  const cl = filled(cur);
  let aLevel = -1, aFrom = 0, aTo = -1;
  const nextNonBlank = (n) => { for (let k = n + 1; k <= doc.lines && k < n + 200; k++) { const x = lv(k); if (x >= 0) return x; } return -1; };
  if (nextNonBlank(cur) > cl) { aLevel = cl; aFrom = cur + 1; }
  else if (cl > 0) { aLevel = cl - 1; aFrom = cur; }
  if (aLevel >= 0) {
    let k = aFrom;
    for (let g = 0; k > 1 && g < 5000 && aFrom === cur; g++) { const x = lv(k - 1); if (x >= 0 && x <= aLevel) break; k--; }
    aFrom = k;
    aTo = aFrom;
    for (let g = 0; aTo < doc.lines && g < 5000; g++) { const x = lv(aTo + 1); if (x >= 0 && x <= aLevel) break; aTo++; }
    while (aTo > aFrom && lv(aTo) < 0) aTo--;
  }
  for (let n = first; n <= last; n++) {
    const l = filled(n);
    const inBlock = n >= aFrom && n <= aTo;
    if (l <= 0 && !inBlock) continue;
    const line = doc.line(n);
    const attrs = {};
    if (l > 0) attrs.style = guideStyle(l, inBlock ? aLevel : -1, unit);
    if (inBlock) attrs.class = "cm-activeBlock";
    b.add(line.from, line.from, Decoration.line({ attributes: attrs }));
  }
  return b.finish();
}

const guidePlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = guides(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged || u.selectionSet || u.geometryChanged) this.decorations = guides(u.view);
  }
}, { decorations: (v) => v.decorations });

// ---------- brackets coloured by depth ----------
const marks = [0, 1, 2].map((i) => Decoration.mark({ class: `cm-br${i}` }));
function brackets(view) {
  const b = new RangeSetBuilder();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter: (n) => {
        const name = n.name;
        if (!(OPEN.has(name) || CLOSE.has(name)) || n.to - n.from !== 1) return;
        // depth: how many bracketed nodes enclose this one
        let d = 0;
        for (let p = n.node.parent?.parent; p; p = p.parent) { const f = p.firstChild; if (f && OPEN.has(f.name)) d++; }
        b.add(n.from, n.to, marks[d % 3]);
      },
    });
  }
  return b.finish();
}
const bracketPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = brackets(view); }
  update(u) { if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = brackets(u.view); }
}, { decorations: (v) => v.decorations });

/** Guides + block highlight (any text), rainbow brackets (languages with a syntax tree). */
export function codeAids({ rainbow = true } = {}) {
  return [guidePlugin, rainbow ? bracketPlugin : []];
}
