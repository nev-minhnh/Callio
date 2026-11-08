// Smooth AI answers. Tokens arrive in bursts; this shows them at an even pace (catching up fast
// when far behind), renders only what changed — finished paragraphs once, the paragraph being
// written each frame — fades new words in, and follows the bottom only while the reader is there.

const REDUCE = matchMedia("(prefers-reduced-motion: reduce)");
const FADE_MS = 260;

/**
 * @param {HTMLElement} body  where the answer goes
 * @param {(el: HTMLElement, text: string) => Promise<void>|void} render  Markdown → el
 * @param {HTMLElement} scroller  the scrolling list to keep at the bottom
 */
export function createStreamer(body, render, scroller) {
  let target = "";      // everything received
  let shown = 0;        // characters revealed so far (fractional)
  let stableEnd = 0;    // characters already rendered as finished blocks
  let raf = 0, last = 0, done = null;
  let stick = true;
  const stable = document.createElement("div");
  const tail = document.createElement("div");
  stable.className = "st-stable"; tail.className = "st-tail";
  let mounted = false;
  let segs = [];        // [{from, to, t}] in tail-text characters: when they appeared
  let tailLenPrev = 0;
  let renderBusy = false;

  const atBottom = () => !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  const onScroll = () => { stick = atBottom(); };
  scroller?.addEventListener("scroll", onScroll, { passive: true });

  function mount() {
    if (mounted) return;
    mounted = true;
    body.innerHTML = "";
    body.append(stable, tail);
  }

  /** Where finished blocks end: the last blank line outside a code fence or a $$ block. */
  function boundary(text) {
    let fence = null, math = false, cut = 0, i = 0;
    const lines = text.split("\n");
    for (let k = 0; k < lines.length - 1; k++) {
      const ln = lines[k];
      const t = ln.trimStart();
      const m = /^(`{3,}|~{3,})/.exec(t);
      if (m) { if (!fence) fence = m[1][0]; else if (t.startsWith(fence)) fence = null; }
      else if (!fence && t.startsWith("$$")) { if (!(t.length > 2 && t.trimEnd().endsWith("$$") && t.trim() !== "$$")) math = !math; }
      i += ln.length + 1;
      if (!fence && !math && ln.trim() === "" && k > 0) cut = i;
    }
    return cut;
  }

  async function paint(now) {
    if (renderBusy) return;
    renderBusy = true;
    try {
      const text = target.slice(0, Math.floor(shown));
      // finished blocks move to `stable` (rendered once, already visible: no fade)
      const b = boundary(text);
      if (b > stableEnd) {
        const chunk = document.createElement("div");
        chunk.className = "st-chunk";
        await render(chunk, text.slice(stableEnd, b));
        stable.appendChild(chunk);
        stableEnd = b;
        segs = []; tailLenPrev = 0;
      }
      // the paragraph being written: rendered each frame, new words fade in
      const t = text.slice(stableEnd);
      await render(tail, t);
      const len = tail.textContent.length;
      if (len > tailLenPrev) segs.push({ from: tailLenPrev, to: len, t: now });
      else if (len < tailLenPrev) segs = segs.filter((s) => s.to <= len);
      tailLenPrev = len;
      segs = segs.filter((s) => now - s.t < FADE_MS);
      if (!REDUCE.matches && segs.length) fadeRanges(tail, segs, now);
      if (stick && scroller) scroller.scrollTop = scroller.scrollHeight;
    } finally { renderBusy = false; }
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min(64, last ? now - last : 16);
    last = now;
    const behind = target.length - shown;
    if (behind > 0) {
      // even pace (~90 chars/s), faster the further behind; everything at once when finishing
      const rate = done ? Math.max(behind / 5, 6) : Math.max(1.5, behind / 14) * (dt / 16.7);
      shown = Math.min(target.length, shown + (REDUCE.matches ? behind : rate));
      paint(now);
    }
    if (shown < target.length) raf = requestAnimationFrame(frame);
    else if (done) { const d = done; done = null; d(); }
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };

  return {
    /** The whole answer so far (appended text keeps flowing; anything else starts over). */
    set(text) {
      mount();
      if (!text.startsWith(target.slice(0, Math.floor(shown)))) {
        // rewritten: start over without animation
        stable.innerHTML = ""; tail.innerHTML = ""; stableEnd = 0; segs = []; tailLenPrev = 0; shown = 0;
      }
      target = text;
      kick();
    },
    push(t) { this.set(target + t); },
    get text() { return target; },
    /** Reveal the rest quickly; resolves when all is shown. */
    finish() {
      return new Promise((res) => {
        if (shown >= target.length && !raf) return res();
        done = res;
        kick();
      });
    },
    stop() { cancelAnimationFrame(raf); raf = 0; scroller?.removeEventListener("scroll", onScroll); },
    get stick() { return stick; },
  };
}

/** Wrap the characters of `segs` (positions in el's text) in fading spans that continue their fade. */
function fadeRanges(el, segs, now) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(".katex, svg, .st-fade") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  let pos = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push([n, pos]); pos += n.length; }
  // from the end, so earlier offsets stay valid
  for (let i = nodes.length - 1; i >= 0; i--) {
    const [node, start] = nodes[i];
    const end = start + node.length;
    let head = node; // the part not yet looked at (newest segments come off its end)
    for (let k = segs.length - 1; k >= 0 && head; k--) {
      const s = segs[k];
      const a = Math.max(s.from, start), b = Math.min(s.to, end);
      if (a >= b) continue;
      if (b - start < head.length) head.splitText(b - start);
      let mid;
      if (a - start > 0) { mid = head.splitText(a - start); }
      else { mid = head; head = null; }
      const span = document.createElement("span");
      span.className = "st-fade";
      span.style.animationDelay = `-${Math.round(now - s.t)}ms`;
      mid.replaceWith(span);
      span.appendChild(mid);
    }
  }
}
