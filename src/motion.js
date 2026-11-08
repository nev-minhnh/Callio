// Small motion helpers: things appear, leave and move instead of popping. Everything respects
// the system's "reduce motion" setting and never delays the work itself.

const REDUCE = matchMedia("(prefers-reduced-motion: reduce)");
export const reduced = () => REDUCE.matches || document.documentElement.dataset.motion === "off";
export const EASE = "cubic-bezier(.2, .8, .2, 1)";
export const EASE_IN = "cubic-bezier(.4, 0, 1, 1)";

const KINDS = {
  fade: [{ opacity: 0 }, { opacity: 1 }],
  rise: [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
  drop: [{ opacity: 0, transform: "translateY(-4px) scale(.98)" }, { opacity: 1, transform: "none" }],
  pop: [{ opacity: 0, transform: "scale(.96)" }, { opacity: 1, transform: "none" }],
  left: [{ opacity: 0, transform: "translateX(-8px)" }, { opacity: 1, transform: "none" }],
  right: [{ opacity: 0, transform: "translateX(12px)" }, { opacity: 1, transform: "none" }],
};

/** Animate `el` in. Returns the Animation (or null). */
export function enter(el, kind = "rise", { duration = 180, delay = 0 } = {}) {
  if (!el || reduced() || !el.animate) return null;
  return el.animate(KINDS[kind] || KINDS.rise, { duration, delay, easing: EASE, fill: "backwards" });
}

/** Animate `el` out, then remove it (or run `then`). Resolves when done. */
export function leave(el, kind = "fade", { duration = 140, remove = true, then } = {}) {
  const finish = () => { if (then) then(); else if (remove) el.remove(); };
  if (!el || reduced() || !el.animate || !el.isConnected) { finish(); return Promise.resolve(); }
  el.style.pointerEvents = "none";
  const a = el.animate([...(KINDS[kind] || KINDS.fade)].reverse(), { duration, easing: EASE_IN, fill: "forwards" });
  return a.finished.catch(() => {}).then(() => { el.style.pointerEvents = ""; finish(); a.cancel?.(); });
}

/** Show or hide an element that uses the `hidden` attribute, animated. */
export function toggle(el, show, kind = "drop") {
  if (!el) return;
  if (show) { if (el.hidden) { el.hidden = false; enter(el, kind); } }
  else if (!el.hidden) leave(el, kind, { duration: 120, then: () => { el.hidden = true; } });
}

/**
 * FLIP: remember where the children matching `sel` are (by `key(el)`), run `mutate` (which may
 * re-render them), then slide each one from where it was to where it is now. New ones fade in.
 */
export async function flip(container, sel, key, mutate, { duration = 220 } = {}) {
  if (reduced() || !container) { await mutate(); return; }
  const before = new Map();
  for (const el of container.querySelectorAll(sel)) before.set(key(el), el.getBoundingClientRect());
  await mutate();
  for (const el of container.querySelectorAll(sel)) {
    const k = key(el), r0 = before.get(k);
    if (!r0) { enter(el, "pop", { duration: 160 }); continue; }
    const r1 = el.getBoundingClientRect();
    const dx = r0.left - r1.left, dy = r0.top - r1.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration, easing: EASE });
  }
}

/** Swap an element's content with a quick cross-fade (the content changes at the low point). */
export function swap(el, change, { duration = 120 } = {}) {
  if (!el || reduced()) { change(); return; }
  el.getAnimations?.().forEach((a) => a.cancel());
  change();
  el.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: duration + 60, easing: EASE });
}

/** Expand children just added under a tree node, a little staggered. */
export function cascade(els, { step = 12, max = 14 } = {}) {
  if (reduced()) return;
  [...els].slice(0, max).forEach((el, i) => enter(el, "left", { duration: 170, delay: i * step }));
}

/** Decode an image off the main thread before showing it; resolves either way. */
export async function decoded(img) {
  try { await img.decode(); } catch { /* shown as is */ }
}

/** Set `img.src` without a flash: decode the new picture first, then swap it in. */
export function setImage(img, src) {
  if (!img || img.src === src) return Promise.resolve();
  const n = new Image();
  n.src = src;
  const tok = (img.__tok = (img.__tok || 0) + 1);
  return n.decode().catch(() => {}).then(() => { if (img.__tok === tok) img.src = src; });
}

/** A view that just changed: a short fade from half to full, so the switch doesn't flash. */
export function settle(el) {
  if (!el || reduced() || el.hidden || !el.offsetParent) return;
  el.animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: 170, easing: EASE });
}

/** A new tab grows into the tab bar. */
export function tabIn(el) {
  if (!el?.isConnected || reduced()) return;
  const w = el.getBoundingClientRect().width;
  el.animate([{ maxWidth: "0px", opacity: 0, paddingLeft: "0px", paddingRight: "0px" }, { maxWidth: w + "px", opacity: 1 }], { duration: 180, easing: EASE });
}

/** A closing tab shrinks away; resolves when it's gone. */
export function tabOut(el) {
  if (!el?.isConnected || reduced()) return Promise.resolve();
  const w = el.getBoundingClientRect().width;
  el.style.pointerEvents = "none";
  return el.animate([{ maxWidth: w + "px", opacity: 1 }, { maxWidth: "0px", opacity: 0, paddingLeft: "0px", paddingRight: "0px" }], { duration: 150, easing: EASE_IN, fill: "forwards" }).finished.catch(() => {});
}
