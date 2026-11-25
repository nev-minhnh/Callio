// Smooth AI answers. Tokens arrive in bursts; this shows them as whole words, at an even pace,
// each word fading in on the compositor (CSS animation: opacity + a blur that clears), so words
// overlap into a soft wave instead of popping.
//
// How it stays cheap and calm:
//  - The DOM of what is being written is append-only. Words already shown are never re-rendered
//    or replaced while they fade. The block being written (paragraph, heading, list item, quote)
//    is built live from the Markdown source with a tiny incremental parser: **bold**, *italic*,
//    `code` and [links](…) already look right, so the real Markdown render that replaces the
//    block once it is complete shows the same text in the same place.
//  - When a block is complete and its words finished fading, it is rendered properly once and
//    swapped in place (finished blocks are never touched again). Code blocks appear line by line
//    and are highlighted when they close; $$ math shows its source dimmed until it closes.
//  - Pace: a velocity (words per second) that eases toward whatever keeps ~0.35 s of text
//    buffered, so bursty or sparse tokens become a steady flow; after the answer has fully
//    arrived the rest is revealed faster.
//  - Fade spans are unwrapped as soon as their animation ends (one delegated listener).
//  - It never scrolls: the follower in chat-view.js keeps the list at the bottom.
import "./stream.css";
import { settings } from "./main.js";

const REDUCE = matchMedia("(prefers-reduced-motion: reduce)");

// Text effect presets. Rates are words per second; times in ms.
const FX = {
  smooth: { buffer: 0.35, tau: 240, minRate: 3, startRate: 7, maxRate: 160, finishIn: 0.7, finishMin: 14, hold: 760, cls: "st-w" },
  fast:   { buffer: 0.18, tau: 110, minRate: 8, startRate: 16, maxRate: 260, finishIn: 0.3, finishMin: 30, hold: 380, cls: "st-w st-fast" },
  off:    null,
};
/** The text effect now: "smooth", "fast" or "off" (also when the system asks for less motion). */
export function streamFxMode() {
  if (REDUCE.matches) return "off";
  const m = settings?.streamFx;
  return m === "fast" || m === "off" ? m : "smooth";
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+/;
const LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+/;
const RULE = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const WORD = /([ \t]*)(\S+)([ \t]*)/y;
const SPACE = (c) => c === "" || c === " " || c === "\n" || c === "\t";
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const words = (s) => (s.match(/\S+/g) || []).length;
const CLEAN = { strong: false, em: false, del: false, code: false, link: false, skip: false };

/**
 * @param {HTMLElement} body  where the answer goes
 * @param {(el: HTMLElement, text: string) => Promise<void>|void} render  Markdown → el
 * @param {HTMLElement} scroller  the scrolling list (its follower keeps it at the bottom)
 */
export function createStreamer(body, render, scroller) {
  let target = "";        // everything received
  let rd = 0;             // characters of `target` shown so far
  let recv = 0, scanned = 0, prevSp = true; // words received (counted as the text arrives)
  let done = 0;           // words shown
  let vel = 0, credit = 0, last = 0, raf = 0, timer = 0;
  let final = false, finalized = false, stopped = false, mounted = false;
  let classified = -1;    // offset of the line start already looked at
  let cur = null;         // the open block
  let blankAt = -1;       // a blank line inside a list: the list may go on
  let queue = [];         // closed blocks waiting to be rendered properly
  let swapping = false;
  let fx = null;
  let frameK = 0;         // words added in this frame (for the small stagger)
  const finishers = [];
  const S = { ...CLEAN };
  let key = "", cont = null, lastCh = "\n";

  // ---------- setup ----------
  const onEnd = (e) => {
    if (e.animationName !== "st-o") return;
    const sp = e.target;
    if (sp?.classList?.contains("st-w")) unwrap(sp);
  };
  function mount() {
    if (mounted) return;
    mounted = true;
    body.replaceChildren();
    body.dataset.st = "1";
    body.addEventListener("animationend", onEnd);
  }
  function resolveFx() {
    fx = FX[streamFxMode()];
    if (fx && !vel) vel = fx.startRate;
  }
  function reset() {
    body.replaceChildren();
    target = ""; rd = 0; recv = 0; scanned = 0; prevSp = true; done = 0; credit = 0; vel = 0;
    cur = null; blankAt = -1; queue = []; classified = -1; finalized = false;
    key = ""; cont = null; lastCh = "\n"; Object.assign(S, CLEAN);
  }
  /** Spend `cost` of the reveal credit (always allowed when the effect is off). */
  const pay = (cost) => { if (!fx) return true; if (credit < cost) return false; credit -= cost; return true; };

  // ---------- incremental word count ----------
  function countNew() {
    for (let i = scanned; i < target.length; i++) {
      const c = target.charCodeAt(i);
      const sp = c === 32 || c === 10 || c === 9;
      if (!sp && prevSp) recv++;
      prevSp = sp;
    }
    scanned = target.length;
  }

  // ---------- blocks ----------
  function newBlock(kind, tag, start, now) {
    const wrap = document.createElement("div");
    wrap.className = "st-block";
    const el = document.createElement(tag);
    wrap.appendChild(el);
    body.appendChild(wrap);
    cur = { kind, wrap, el, root: el, start, lastAdd: now, fence: "", list: null, ordered: false };
    key = ""; cont = null; Object.assign(S, CLEAN);
    return cur;
  }
  function closeBlock(now, end = rd) {
    if (!cur) return;
    const b = cur; cur = null; blankAt = -1; key = ""; cont = null;
    if (b.kind === "rule") return;
    queue.push({ wrap: b.wrap, start: b.start, end: Math.min(end, target.length), ready: b.lastAdd + (fx ? fx.hold : 0) });
  }
  async function drain(now) {
    if (swapping) return;
    swapping = true;
    try {
      while (queue.length && now >= queue[0].ready) {
        const b = queue.shift();
        if (!body.contains(b.wrap)) continue;
        const tmp = document.createElement("div");
        try { await render(tmp, target.slice(b.start, b.end)); } catch { continue; }
        if (!body.contains(b.wrap)) continue;
        b.wrap.replaceChildren(...tmp.childNodes);
        b.wrap.dataset.done = "1";
      }
    } finally { swapping = false; }
  }

  // ---------- adding text ----------
  function unwrap(sp) {
    if (!sp.parentNode) return;
    const t = sp.firstChild;
    sp.replaceWith(...sp.childNodes);
    const prev = t?.previousSibling;
    if (t && t.nodeType === 3 && prev && prev.nodeType === 3) { prev.appendData(t.data); t.remove(); }
  }
  /** The element new text goes into for the current emphasis state. */
  function container() {
    const k = (S.link ? "a" : "") + (S.strong ? "s" : "") + (S.em ? "e" : "") + (S.del ? "d" : "") + (S.code ? "c" : "");
    if (cont && k === key) return cont;
    key = k;
    let el = cur.el;
    const nest = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; el.appendChild(n); el = n; };
    if (S.link) nest("span", "st-a");
    if (S.strong) nest("strong");
    if (S.em) nest("em");
    if (S.del) nest("del");
    if (S.code) nest("code");
    cont = el;
    return el;
  }
  function plain(el, text) {
    const l = el.lastChild;
    if (l && l.nodeType === 3) l.appendData(text); else el.appendChild(document.createTextNode(text));
  }
  function put(text, now) {
    if (!text) return;
    const el = container();
    cur.lastAdd = now;
    // far behind (a whole answer arrived at once): only the last words fade
    if (!fx || recv - done > 14 + frameK) { plain(el, text); return; }
    const sp = document.createElement("span");
    sp.className = fx.cls;
    sp.textContent = text;
    if (frameK > 0) sp.style.animationDelay = Math.min(frameK, 8) * 26 + "ms";
    frameK++;
    el.appendChild(sp);
  }
  /** One word (with its trailing spaces) of Markdown source → text with emphasis applied. */
  function emit(unit, at, now) {
    let buf = "";
    const flush = () => { if (buf) { put(buf, now); buf = ""; } };
    const n = unit.length;
    for (let i = 0; i < n; i++) {
      const c = unit[i];
      const pos = at + i;
      if (S.skip) { if (c === ")") S.skip = false; lastCh = c; continue; }
      if (S.code) { if (c === "`") { flush(); S.code = false; } else buf += c; lastCh = c; continue; }
      if (c === "\\" && i + 1 < n && /[\\`*_{}[\]()#+\-.!~|>$]/.test(unit[i + 1])) { buf += unit[++i]; lastCh = unit[i]; continue; }
      if (c === "`") {
        const nl = target.indexOf("\n", pos), cl = target.indexOf("`", pos + 1);
        if (cl >= 0 && (nl < 0 || cl < nl)) { flush(); S.code = true; lastCh = c; continue; }
      } else if (c === "*" || c === "_" || c === "~") {
        let run = 1; while (unit[i + run] === c) run++;
        const prev = i > 0 ? unit[i - 1] : lastCh;
        const next = i + run < n ? unit[i + run] : (target[pos + run] ?? " ");
        const k = c === "~" ? (run >= 2 ? "del" : null) : run >= 3 ? "both" : run === 2 ? "strong" : "em";
        let hit = false;
        if (k) {
          const on = k === "both" ? S.strong && S.em : S[k];
          if (on) {
            if (!SPACE(prev) && (c !== "_" || !/\w/.test(next))) { flush(); if (k === "both") S.strong = S.em = false; else S[k] = false; hit = true; }
          } else if (!SPACE(next) && (c !== "_" || !/\w/.test(prev || " "))) {
            const nl = target.indexOf("\n", pos), cl = target.indexOf(c.repeat(Math.min(run, 2)), pos + run);
            if (cl >= 0 && (nl < 0 || cl < nl)) { flush(); if (k === "both") S.strong = S.em = true; else S[k] = true; hit = true; }
          }
        }
        if (hit) { i += run - 1; lastCh = c; continue; }
        buf += c.repeat(run); i += run - 1; lastCh = c; continue;
      } else if (c === "[" && !S.link) {
        const nl = target.indexOf("\n", pos);
        if (/^\[[^\]\n]*\]\(/.test(target.slice(pos, nl < 0 ? target.length : nl))) { flush(); S.link = true; lastCh = c; continue; }
      } else if (c === "]" && S.link) {
        flush(); S.link = false;
        if (unit[i + 1] === "(") { const j = unit.indexOf(")", i + 2); if (j >= 0) i = j; else { S.skip = true; i = n; } }
        lastCh = c; continue;
      }
      buf += c; lastCh = c;
    }
    flush();
  }
  function addLine(text, now, cls) {
    cur.lastAdd = now;
    const span = document.createElement("span");
    span.className = cls + (fx ? " st-ln-in" : "");
    span.textContent = text + "\n";
    cur.el.appendChild(span);
  }

  // ---------- the reveal loop ----------
  /** Look at the line starting at `rd`: decide which block it belongs to. */
  function lineStart(now) {
    const nl = target.indexOf("\n", rd);
    const complete = nl >= 0 || final;
    const line = target.slice(rd, nl >= 0 ? nl : target.length);
    const next = nl >= 0 ? nl + 1 : target.length;

    if (cur && (cur.kind === "code" || cur.kind === "math")) {
      if (!complete) return false;
      if (cur.kind === "code") {
        const m = FENCE_CLOSE.exec(line);
        if (m && m[1][0] === cur.fence[0] && m[1].length >= cur.fence.length) { done += 1; rd = next; closeBlock(now, next); return true; }
      } else if (line.trim() === "$$" || (line.trimEnd().endsWith("$$") && line.trim().length > 2)) {
        if (line.trim() !== "$$") addLine(line, now, "st-line st-mathsrc");
        done += words(line); rd = next; closeBlock(now, next); return true;
      }
      const w = words(line);
      if (!pay(Math.min(w, 4))) return false;
      done += w;
      addLine(line, now, cur.kind === "math" ? "st-line st-mathsrc" : "st-line");
      rd = next;
      return true;
    }

    // wait until the first word is whole, so "-", "#", "1." and fences are recognised
    if (!complete && !/\S\s/.test(line)) return false;

    if (line.trim() === "") {
      if (cur && cur.kind === "li") { if (blankAt < 0) blankAt = rd; rd = next; return true; }
      if (cur) closeBlock(now, rd);
      rd = next;
      return true;
    }

    // a list goes on past a blank line only with another item or an indented line
    if (blankAt >= 0 && cur && !(LIST.test(line) || /^( {2,}|\t)\S/.test(line))) closeBlock(now, blankAt);
    const startOf = rd;
    let m;

    if ((m = FENCE_OPEN.exec(line))) {
      if (!complete) return false;
      closeBlock(now);
      const b = newBlock("code", "pre", startOf, now);
      b.fence = m[1]; b.el = document.createElement("code"); b.root.appendChild(b.el);
      b.wrap.classList.add("st-codeblock");
      done += 1; rd = next;
      return true;
    }
    if (/^\s*\$\$/.test(line)) {
      const one = line.trim().length > 2 && line.trimEnd().endsWith("$$");
      if (!complete && !one) return false;
      closeBlock(now);
      const b = newBlock("math", "div", startOf, now);
      b.root.className = "st-math";
      if (one) { addLine(line, now, "st-line st-mathsrc"); done += words(line); rd = next; closeBlock(now, next); }
      else { done += 1; rd = next; }
      return true;
    }
    if (RULE.test(line) && !LIST.test(line)) {
      closeBlock(now);
      const b = newBlock("rule", "hr", startOf, now);
      b.wrap.dataset.done = "1";
      closeBlock(now);
      done += words(line); rd = next;
      return true;
    }
    if ((m = HEADING.exec(line))) {
      closeBlock(now);
      newBlock("h", "h" + m[1].length, startOf, now);
      classified = rd + m[0].length;
      done += 1; rd += m[0].length;
      return true;
    }
    if ((m = LIST.exec(line))) {
      const ordered = /\d/.test(m[2]);
      if (!cur || cur.kind !== "li" || cur.ordered !== ordered) {
        closeBlock(now);
        const b = newBlock("li", ordered ? "ol" : "ul", startOf, now);
        b.ordered = ordered; b.list = b.root;
        if (ordered) { const n = parseInt(m[2], 10); if (n !== 1) b.list.setAttribute("start", String(n)); }
      }
      blankAt = -1;
      const li = document.createElement("li");
      cur.list.appendChild(li);
      cur.el = li; key = ""; cont = null; Object.assign(S, CLEAN);
      classified = rd + m[0].length;
      done += 1; rd += m[0].length;
      return true;
    }
    if (QUOTE.test(line)) {
      if (!cur || cur.kind !== "q") {
        closeBlock(now);
        const b = newBlock("q", "blockquote", startOf, now);
        b.el = document.createElement("p"); b.root.appendChild(b.el);
      } else if (!SPACE(lastCh)) plain(cur.el, " ");
      m = QUOTE.exec(line);
      classified = rd + m[0].length;
      done += 1; rd += m[0].length;
      return true;
    }
    if (/^\s*\|/.test(line)) {
      // table rows appear as whole lines; the table is built when it ends
      if (!complete) return false;
      if (!cur || cur.kind !== "raw") { closeBlock(now); const b = newBlock("raw", "div", startOf, now); b.root.className = "st-raw"; }
      const w = words(line);
      if (!pay(Math.min(w, 4))) return false;
      done += w;
      addLine(line, now, "st-line");
      rd = next;
      return true;
    }
    // ordinary text
    if (cur && (cur.kind === "raw" || cur.kind === "h")) closeBlock(now);
    if (!cur) newBlock("p", "p", startOf, now);
    else if (!SPACE(lastCh)) { plain(cur.el, " "); lastCh = " "; }
    const ind = /^[ \t]*/.exec(line)[0].length;
    classified = rd + ind;
    rd += ind;
    return true;
  }

  /** Show the next word (or line break) of the current line. */
  function inLine(now) {
    if (target.charCodeAt(rd) === 10) {
      rd++; lastCh = "\n";
      if (cur && cur.kind === "h") closeBlock(now, rd);
      return true;
    }
    WORD.lastIndex = rd;
    const m = WORD.exec(target);
    if (!m) {
      // only spaces up to the end of the line
      const nl = target.indexOf("\n", rd);
      if (nl < 0 && !final) return false;
      rd = nl < 0 ? target.length : nl;
      return true;
    }
    const end = rd + m[0].length;
    if (end === target.length && !final && m[3] === "") return false; // the word may still grow
    if (!pay(1)) return false;
    if (!cur) newBlock("p", "p", rd, now);
    emit(m[0], rd, now);
    lastCh = m[0][m[0].length - 1];
    rd = end; done++;
    return true;
  }
  function step(now) {
    if (rd >= target.length) return false;
    const atStart = rd === 0 || target.charCodeAt(rd - 1) === 10;
    if (atStart && classified !== rd) return lineStart(now);
    return inLine(now);
  }

  function frame(now) {
    raf = 0; clearTimeout(timer); timer = 0;
    if (stopped) return;
    const t0 = performance.now();
    resolveFx();
    const dt = Math.min(100, last ? now - last : 16);
    last = now;
    countNew();
    if (fx) {
      const buffer = Math.max(0, recv - done);
      const want = final ? Math.max(fx.finishMin, buffer / fx.finishIn) : clamp(buffer / fx.buffer, fx.minRate, fx.maxRate);
      vel += (want - vel) * (1 - Math.exp(-dt / fx.tau));
      credit = Math.min(credit + vel * dt / 1000, 40);
    }
    frameK = 0;
    let guard = 0;
    while (step(now)) { if ((++guard & 31) === 0 && performance.now() - t0 > 6) break; }
    if (final && !finalized && rd >= target.length) { closeBlock(now); finalized = true; }
    if (queue.length) drain(now);
    const probe = globalThis.__streamProbe;
    if (probe) probe.push(performance.now() - t0);
    if (rd < target.length || queue.length || swapping || (final && !finalized)) schedule();
    else if (final) for (const r of finishers.splice(0)) r();
  }
  function schedule() {
    if (raf || stopped) return;
    raf = requestAnimationFrame(frame);
    // a hidden or minimised window runs no animation frames: carry on from a timer
    timer = setTimeout(() => { if (raf) { cancelAnimationFrame(raf); frame(performance.now()); } }, 250);
  }

  return {
    /** The whole answer so far (appended text keeps flowing; anything else starts over). */
    set(text) {
      mount();
      if (text.includes("\r")) text = text.replace(/\r\n?/g, "\n");
      if (text.length < rd || !text.startsWith(target.slice(0, rd))) reset();
      target = text;
      if (final && text.length > scanned) { final = false; finalized = false; }
      resolveFx();
      countNew();
      schedule();
    },
    push(t) { this.set(target + t); },
    get text() { return target; },
    /** The answer is complete: show the rest a bit faster. Resolves when everything is shown and rendered. */
    finish() {
      mount();
      final = true;
      return new Promise((res) => {
        if (stopped) return res();
        finishers.push(res);
        schedule();
      });
    },
    /** Clean up (the answer is shown, or the run was cancelled). */
    stop() {
      stopped = true;
      cancelAnimationFrame(raf); raf = 0; clearTimeout(timer);
      body.removeEventListener("animationend", onEnd);
      for (const sp of body.querySelectorAll(".st-w")) unwrap(sp);
      for (const r of finishers.splice(0)) r();
    },
    /** True while the list follows the bottom (the reader has not scrolled away). */
    get stick() { return scroller?._cv ? scroller._cv.stuck : true; },
  };
}

if (import.meta.env?.DEV) window.__stream = { createStreamer };
