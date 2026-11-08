// Drag to reorder with the mouse (or pen / touch) — pointer events, not HTML drag-and-drop:
// in the desktop window the native file drop handler owns HTML drag-and-drop, so the browser
// shows a "not allowed" cursor and the drop never comes. A picture of the dragged item follows
// the pointer, a bar shows where it will land, and the list scrolls near its edges.

import { reduced, EASE } from "./motion.js";

// inside a modal dialog, only the dialog's own top layer is visible
const layer = (box) => box.closest("dialog[open]") || document.body;

/**
 * @param {HTMLElement} box   the list (or grid)
 * @param {object} o
 *   item: selector of the items; axis: "y" (list) | "x" | "grid";
 *   ignore: selector of parts that don't start a drag (buttons…);
 *   count(el): how many items move with `el` (shown as a badge);
 *   drop(fromEl, to): `to` = insertion index among all items (before removing the dragged ones).
 */
export function sortable(box, o) {
  const axis = o.axis || "y";
  const ignore = o.ignore || "button, input, select, textarea, a";
  let st = null;
  box.addEventListener("dragstart", (e) => { if (e.target.closest?.(o.item)) e.preventDefault(); });

  box.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || st) return;
    const el = e.target.closest(o.item);
    if (!el || !box.contains(el) || e.target.closest(ignore)) return;
    st = { el, x0: e.clientX, y0: e.clientY, id: e.pointerId, on: false };
  });
  const scroller = () => { for (let p = box; p; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowY + s.overflowX) && (p.scrollHeight > p.clientHeight || p.scrollWidth > p.clientWidth)) return p; } return box; };

  function begin(e) {
    st.on = true;
    st.sc = scroller();
    const r = st.el.getBoundingClientRect();
    st.dx = e.clientX - r.left; st.dy = e.clientY - r.top;
    const g = st.el.cloneNode(true);
    g.classList.add("srt-ghost");
    g.style.cssText += `;position:fixed;left:0;top:0;width:${r.width}px;height:${r.height}px;margin:0;pointer-events:none;z-index:9999`;
    const n = o.count?.(st.el) || 1;
    if (n > 1) { const b = document.createElement("span"); b.className = "srt-badge"; b.textContent = n; g.appendChild(b); }
    layer(box).appendChild(g);
    st.ghost = g;
    st.bar = document.createElement("div");
    st.bar.className = "srt-bar " + (axis === "y" ? "h" : "v");
    layer(box).appendChild(st.bar);
    st.moving = o.moving ? o.moving(st.el) : [st.el];
    st.moving.forEach((m) => m.classList.add("srt-src"));
    document.body.classList.add("srt-active");
    try { box.setPointerCapture(e.pointerId); } catch {}
    getSelection()?.removeAllRanges();
    if (!reduced()) g.animate([{ transform: ghostAt(e, 1) }, { transform: ghostAt(e, 1.04) }], { duration: 120, easing: EASE });
  }
  const ghostAt = (e, s = 1.04) => `translate(${e.clientX - st.dx}px, ${e.clientY - st.dy}px) scale(${s}) rotate(${axis === "y" ? 0 : 1.2}deg)`;

  function target(x, y) {
    const items = [...box.querySelectorAll(o.item)];
    let best = null, bd = Infinity;
    items.forEach((it, i) => {
      const r = it.getBoundingClientRect();
      const cx = Math.max(r.left, Math.min(x, r.right)), cy = Math.max(r.top, Math.min(y, r.bottom));
      const d = (axis === "y" ? 0 : (cx - x) ** 2) + (axis === "x" ? 0 : (cy - y) ** 2) + (axis === "y" ? (cx - x) ** 2 * 0.01 : 0);
      if (d < bd) { bd = d; best = { i, r }; }
    });
    if (!best) return { to: 0, bar: null };
    const { i, r } = best;
    const after = axis === "y" ? y > r.top + r.height / 2 : x > r.left + r.width / 2;
    const bar = axis === "y"
      ? { x: r.left, y: (after ? r.bottom : r.top) - 1.5, w: r.width, h: 3 }
      : { x: (after ? r.right : r.left) - 1.5, y: r.top, w: 3, h: r.height };
    return { to: i + (after ? 1 : 0), bar };
  }

  let raf = 0, last = null;
  function tick() {
    raf = 0;
    if (!st?.on || !last) return;
    const e = last;
    st.ghost.style.transform = ghostAt(e);
    const t = target(e.clientX, e.clientY);
    st.to = t.to;
    if (t.bar) Object.assign(st.bar.style, { transform: `translate(${t.bar.x}px, ${t.bar.y}px)`, width: t.bar.w + "px", height: t.bar.h + "px", opacity: 1 });
    // scroll near the edges
    const sr = st.sc.getBoundingClientRect(), edge = 40;
    let v = 0;
    if (e.clientY < sr.top + edge) v = -(sr.top + edge - e.clientY);
    else if (e.clientY > sr.bottom - edge) v = e.clientY - (sr.bottom - edge);
    if (v) { st.sc.scrollTop += Math.max(-24, Math.min(24, v / 2)); raf = requestAnimationFrame(tick); }
  }
  box.addEventListener("pointermove", (e) => {
    if (!st || e.pointerId !== st.id) return;
    if (!st.on) {
      if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) < 5) return;
      begin(e);
    }
    e.preventDefault();
    last = e;
    if (!raf) raf = requestAnimationFrame(tick);
  });
  const end = async (e, cancel) => {
    if (!st || (e && e.pointerId !== st.id)) return;
    const s = st; st = null; last = null;
    cancelAnimationFrame(raf); raf = 0;
    if (!s.on) return;
    document.body.classList.remove("srt-active");
    s.moving.forEach((m) => m.classList.remove("srt-src"));
    s.bar.remove();
    // swallow the click that follows the drag
    const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    window.addEventListener("click", eat, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", eat, { capture: true }), 0);
    const g = s.ghost;
    if (!reduced()) g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120 }).finished.then(() => g.remove(), () => g.remove());
    else g.remove();
    if (!cancel && s.to != null) await o.drop(s.el, s.to);
  };
  box.addEventListener("pointerup", (e) => end(e, false));
  box.addEventListener("pointercancel", (e) => end(e, true));
  box.addEventListener("keydown", (e) => { if (e.key === "Escape" && st?.on) { e.stopPropagation(); end(null, true); } });
}

/**
 * Drag an item onto a target elsewhere (a paper onto a collection), with pointer events.
 * o: { item, targets (selector, searched in the whole document), accept(target, el), drop(el, target) }
 */
export function dragOnto(box, o) {
  let st = null;
  box.addEventListener("dragstart", (e) => { if (e.target.closest?.(o.item)) e.preventDefault(); });
  box.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const el = e.target.closest(o.item);
    if (!el || e.target.closest("button, input, a")) return;
    st = { el, x0: e.clientX, y0: e.clientY, id: e.pointerId, on: false, over: null };
  });
  box.addEventListener("pointermove", (e) => {
    if (!st || e.pointerId !== st.id) return;
    if (!st.on) {
      if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) < 6) return;
      st.on = true;
      const g = document.createElement("div");
      g.className = "srt-chip";
      g.textContent = (o.label?.(st.el) || st.el.textContent || "").trim().slice(0, 60);
      layer(box).appendChild(g);
      st.ghost = g;
      document.body.classList.add("srt-active");
      try { box.setPointerCapture(e.pointerId); } catch {}
      getSelection()?.removeAllRanges();
    }
    e.preventDefault();
    st.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`;
    const t = document.elementFromPoint(e.clientX, e.clientY)?.closest(o.targets);
    const ok = t && (!o.accept || o.accept(t, st.el)) ? t : null;
    if (ok !== st.over) { st.over?.classList.remove("drop"); ok?.classList.add("drop"); st.over = ok; }
  });
  const end = (e, cancel) => {
    if (!st || e.pointerId !== st.id) return;
    const s = st; st = null;
    if (!s.on) return;
    document.body.classList.remove("srt-active");
    s.over?.classList.remove("drop");
    s.ghost.remove();
    const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    window.addEventListener("click", eat, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", eat, { capture: true }), 0);
    if (!cancel && s.over) o.drop(s.el, s.over);
  };
  box.addEventListener("pointerup", (e) => end(e, false));
  box.addEventListener("pointercancel", (e) => end(e, true));
}
