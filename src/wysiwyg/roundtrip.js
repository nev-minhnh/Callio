// Round-trip safety for the visual editor.
//
// Parsing records, for every top-level block, its node and the exact source it came from,
// plus the whitespace before it. Writing back:
//   - a block whose node is unchanged (same object, or deep-equal after an undo) is written
//     as its original source, byte for byte;
//   - an edited block is written fresh by the format's serializer, then "merged" with its old
//     source so unchanged words keep their old whitespace (hard-wrapped lines, indentation);
//     the merge is only kept when parsing it back gives the same thing as the fresh text;
//   - whitespace between blocks is kept as it was.
// So untouched parts of a file never change, and an edit only rewrites what it touched.

/** Split into alternating runs of whitespace / non-whitespace. */
function tokens(s) {
  return s.match(/\s+|[^\s]+/g) || [];
}
// whitespace runs compare equal unless one is a paragraph break and the other isn't
const wsClass = (t) => (/^\s/.test(t) ? (/\n[^\S\n]*\n/.test(t) ? "\u0001P" : "\u0001S") : t);

/**
 * Myers diff over two arrays of comparable strings. Returns a list of [op, i, j] with
 * op = 0 equal (a[i] == b[j]), 1 insert b[j], -1 delete a[i]; or null if too different.
 */
function diff(a, b, maxD = 1500) {
  const n = a.length, m = b.length, max = n + m;
  if (max > 60000) return null;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] keeps only the diagonals d could reach, as a full-size view for simple indexing
  const trace = [];
  let found = -1;
  outer: for (let d = 0; d <= Math.min(max, maxD); d++) {
    const lo = Math.max(0, off - d - 1), hi = Math.min(v.length, off + d + 2);
    const snap = v.slice(lo, hi);
    trace.push({ lo, snap });
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break outer; }
    }
  }
  if (found < 0) return null;
  // backtrack
  const ops = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const { lo, snap } = trace[d];
    const at = (kk) => snap[off + kk - lo];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && at(k - 1) < at(k + 1))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = at(prevK), prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; ops.push([0, x, y]); }
    if (x === prevX) { y--; ops.push([1, x, y]); }
    else { x--; ops.push([-1, x, y]); }
  }
  while (x > 0 && y > 0) { x--; y--; ops.push([0, x, y]); }
  return ops.reverse();
}

/**
 * `fresh` with the whitespace of `orig` wherever the two agree word for word.
 */
export function mergeWhitespace(orig, fresh) {
  if (orig === fresh) return orig;
  const A = tokens(orig), B = tokens(fresh);
  const a = A.map(wsClass), b = B.map(wsClass);
  // common prefix/suffix first: diffs are usually tiny
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  if (p > 0 && /^\s/.test(A[p - 1])) p--; // leave the whitespace to the diff (see below)
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const ops = diff(a.slice(p, a.length - s), b.slice(p, b.length - s));
  if (!ops) return fresh;
  // Whitespace belongs to the token after it: when a run of inserted (or deleted) tokens ends
  // in whitespace of the same kind as the matched whitespace just before the run, match that
  // later whitespace instead, so the old indentation stays with the line that had it.
  const isWs = (t) => /^\s/.test(t);
  for (let i = 0; i < ops.length; i++) {
    const [op, x, y] = ops[i];
    if (op !== 0 || !isWs(A[p + x])) continue;
    let j = i + 1;
    const kind = ops[j] && ops[j][0];
    if (kind !== 1 && kind !== -1) continue;
    while (j + 1 < ops.length && ops[j + 1][0] === kind) j++;
    const last = ops[j];
    if (kind === 1 && isWs(B[p + last[2]]) && wsClass(B[p + last[2]]) === wsClass(A[p + x])) {
      ops[i] = [1, x, y];
      ops[j] = [0, x, last[2]];
    } else if (kind === -1 && isWs(A[p + last[1]]) && wsClass(A[p + last[1]]) === wsClass(A[p + x])) {
      ops[i] = [-1, x, y];
      ops[j] = [0, last[1], y];
    }
    i = j;
  }
  let out = A.slice(0, p).join("");
  // new lines get the indentation of the line before them
  const nl = (t) => (t.match(/\n/g) || []).length;
  let lastNl = null;
  for (let k = p - 1; k >= 0 && lastNl == null; k--) if (/\n/.test(A[k]) && /^\s/.test(A[k])) lastNl = A[k];
  for (const [op, i, j] of ops) {
    if (op === 0) {
      const t = A[p + i];
      if (/^\s/.test(t) && /\n/.test(t)) lastNl = t;
      out += t;
    } else if (op === 1) {
      const t = B[p + j];
      out += /^\s/.test(t) && lastNl && nl(t) > 0 && nl(t) === nl(lastNl) ? lastNl : t;
    }
  }
  out += A.slice(A.length - s).join("");
  return out;
}

const nlCount = (t) => (t.match(/\n/g) || []).length;
const keyOf = (node) => node.type.name + "\u0000" + node.textContent;

/**
 * Write a sequence of nodes (the document's top-level blocks) back to source.
 * recs: [{ node, src, sep }] from parsing; fmt: { fresh(node) → text|null, mergeable(node), verify(text, node) }.
 */
export function serializeSeq(children, recs, fmt, defaultSep = "\n\n", firstSep = "") {
  const n = children.length;
  const byNode = new Map();
  recs.forEach((r, i) => byNode.set(r.node, i));
  let byKey = null;
  const match = new Int32Array(n).fill(-1);
  let last = -1;
  for (let i = 0; i < n; i++) {
    const c = children[i];
    let m = byNode.get(c);
    if (m === undefined || m <= last) {
      m = undefined;
      if (!byKey) {
        byKey = new Map();
        recs.forEach((r, j) => { const k = keyOf(r.node); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(j); });
      }
      const cand = byKey.get(keyOf(c));
      if (cand) for (const j of cand) if (j > last && recs[j].node.eq(c)) { m = j; break; }
    }
    if (m !== undefined && m > last) { match[i] = m; last = m; }
  }
  let out = "";
  let prevRec = -1;
  for (let i = 0; i < n;) {
    if (match[i] >= 0) {
      const r = recs[match[i]];
      let sep = r.sep;
      // a block was deleted before this one: keep the stronger of the two separators
      if (match[i] > prevRec + 1) { const d = recs[prevRec + 1].sep; if (nlCount(d) > nlCount(sep)) sep = d; }
      out += (out === "" ? (recs[0] ? recs[0].sep : firstSep) : sep) + r.src;
      prevRec = match[i];
      i++;
      continue;
    }
    let j = i;
    while (j < n && match[j] < 0) j++;
    const recEnd = j < n ? match[j] : recs.length;
    for (let k = 0; i + k < j; k++) {
      const ri = prevRec + 1 + k;
      const r = ri < recEnd ? recs[ri] : null;
      const child = children[i + k];
      const text = freshWithMerge(child, r && r.node.type === child.type ? r : null, fmt);
      if (text == null) continue; // nothing to write (an empty paragraph)
      const sep = out === "" ? (recs[0] ? recs[0].sep : firstSep) : r ? r.sep : defaultSep;
      out += sep + text;
    }
    prevRec = recEnd - 1;
    i = j;
  }
  return out;
}

export function freshWithMerge(node, pred, fmt) {
  const F = fmt.fresh(node);
  if (F == null || !pred || !fmt.mergeable(node)) return F;
  const M = mergeWhitespace(pred.src, F);
  if (M === F) return F;
  try { if (fmt.verify(M, node)) return M; } catch { /* fall back to the fresh text */ }
  return F;
}

/** Concatenate parse records back to text (to check a parse covers its input exactly). */
export function joinRecs(recs) {
  let s = "";
  for (const r of recs) s += r.sep + r.src;
  return s;
}
