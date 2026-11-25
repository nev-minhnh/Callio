// The chat list: stays fast in very long conversations and follows the bottom correctly.
//
// One "view" per scrolling list (`#ai-messages` today, one `.ai-messages` per session later;
// they are found by themselves). A view does three things:
//
//  1. FOLLOW. "Stuck to the bottom" changes only on what the reader does: wheel/touchpad up,
//     PageUp/ArrowUp/Home, dragging the scrollbar, touch drag, selecting upward, clicking a link
//     to an earlier message. Content growing (a slow frame, a tool card, KaTeX, an image) never
//     unsticks. While stuck, a ResizeObserver keeps the list at the bottom (it runs after layout,
//     before paint, so the view never trails the content); scrolled back to the end, or the ↓
//     button, sticks again. Each list remembers its own state.
//  2. VIRTUALISE. Only the newest ~30 messages and those within ~1.5 screens of the viewport are
//     real DOM; the others are replaced by placeholders of the same height (their element is kept
//     off-screen, so listeners survive; messages made from saved chats are rebuilt from the HTML
//     cache). Swaps keep the content under the same pixel. Old messages fold their heavy parts
//     (tool cards, thinking, diffs, logs) into one-line summaries that open on click.
//  3. CACHE. Finished answers are rendered once; their HTML is kept by a hash of the Markdown.
import "./chat-view.css";
import { t as tr, addVi } from "./i18n.js";

addVi({
  "Text effect": "Hiệu ứng chữ", "Smooth": "Mượt", "Fast": "Nhanh",
  "How the AI's answers appear": "Cách câu trả lời của AI hiện ra",
  "Scroll to the latest message": "Cuộn tới tin mới nhất",
  "Show the details": "Xem chi tiết", "1 tool call": "1 lệnh công cụ", "tool calls": "lệnh công cụ",
  "Permission request": "Yêu cầu quyền", "changed file": "tệp đã đổi", "changed files": "tệp đã đổi",
  "Changes": "Thay đổi", "Details": "Chi tiết", "Thinking": "Đang suy nghĩ",
});

const SEL = "#ai-messages, .ai-messages";
export const KEEP = 30;       // newest messages that are always real DOM
const NEAR = 1.5;             // screens around the viewport that are real DOM
const LIVE_MS = 30 * 60 * 1000;
const HEAVY = ".ai-tools, .ai-think, .cc-perm, .cc-changes, .cc-log, .cc-card, .cc-sub";

const views = new WeakMap();
const known = new Set();      // WeakRefs would do; lists are few
let panelObs = null, scanTimer = 0;

// ---------------- the HTML cache ----------------
function hash(s) { // cyrb53
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + ":" + s.length;
}
const cacheMap = new Map();
let cacheChars = 0;
/** Rendered HTML of finished messages, by Markdown text. Least recently used go first (~24 MB). */
export const htmlCache = {
  get(text) { const k = hash(text), v = cacheMap.get(k); if (v !== undefined) { cacheMap.delete(k); cacheMap.set(k, v); } return v; },
  set(text, html) {
    const k = hash(text);
    if (cacheMap.has(k)) cacheChars -= cacheMap.get(k).length;
    cacheMap.delete(k); cacheMap.set(k, html); cacheChars += html.length;
    while (cacheChars > 24e6 && cacheMap.size > 1) { const [k0, v0] = cacheMap.entries().next().value; cacheMap.delete(k0); cacheChars -= v0.length; }
  },
  renders: 0, // how many answers were rendered from Markdown (for tests and measuring)
  get size() { return cacheMap.size; },
  clear() { cacheMap.clear(); cacheChars = 0; },
};

// ---------------- folding heavy parts of old messages ----------------
const summaries = new WeakMap(); // summary button → the real element

function summaryText(el) {
  if (el.matches(".ai-tools")) { const n = el.children.length; return n === 1 ? tr("1 tool call") : `${n} ${tr("tool calls")}`; }
  if (el.matches(".ai-think")) return el.querySelector("summary")?.textContent.replace(/\s*●+$/, "") || tr("Thinking");
  if (el.matches(".cc-perm")) return el.querySelector(".cc-perm-head b")?.textContent.slice(0, 80) || tr("Permission request");
  if (el.matches(".cc-changes")) { const n = el.querySelectorAll(".cc-ch").length; return n ? `${n} ${tr(n === 1 ? "changed file" : "changed files")}` : tr("Changes"); }
  if (el.matches(".cc-log")) return tr("Output");
  return tr("Details");
}
/** Replace the heavy parts of an old message by one-line summaries; the parts are kept for a click. */
export function collapseHeavy(msg) {
  let changed = false;
  for (const el of [...msg.querySelectorAll(HEAVY)]) {
    if (el.closest(".cv-folded") || el.hidden || (el.parentElement && el.parentElement.closest(HEAVY))) continue;
    const b = document.createElement("button");
    b.type = "button"; b.className = "cv-sum";
    b.innerHTML = `<span class="cv-sum-i" aria-hidden="true">▸</span><span class="cv-sum-t"></span>`;
    b.querySelector(".cv-sum-t").textContent = summaryText(el);
    b.title = tr("Show the details");
    summaries.set(b, el);
    el.replaceWith(b);
    changed = true;
  }
  return changed;
}
function expandSummary(b) {
  const el = summaries.get(b);
  if (!el) return;
  b.replaceWith(el);
  summaries.delete(b);
}

// ---------------- one view per list ----------------
class View {
  constructor(el) {
    this.el = el; el._cv = this;
    this.stuck = true; this.top = 0; this.lastTop = 0; this.newMsgs = 0; this.grew = false;
    this.entries = [];            // the messages, in order
    this.of = new WeakMap();      // element or placeholder → entry
    this.real = new Set();        // entries whose element is in the page
    this.pointer = false; this.sbDrag = false; this.smooth = false; this.down = 0; this.hidden = !el.clientHeight;
    this.passRaf = 0; this.touchY = 0;
    this.stats = { passes: 0, restored: 0, detached: 0 };
    el.classList.add("cv-list");
    el.setAttribute("tabindex", el.getAttribute("tabindex") ?? "-1");

    this.ro = new ResizeObserver((l) => this.onResize(l));
    this.mo = new MutationObserver((l) => this.onMutate(l));
    this.ro.observe(el);
    this.mo.observe(el, { childList: true });
    for (const c of el.children) this.adopt(c);

    el.addEventListener("scroll", () => this.onScroll(), { passive: true });
    // the reader's intent: scrolling up (only counts when there is something above to scroll to)
    // Scrolling down is intent too: only a scroll the reader asked for may stick again (a late
    // scroll event from the follower's own earlier scroll must not undo a wheel-up).
    el.addEventListener("wheel", (e) => {
      if (e.deltaY < 0 && el.scrollTop > 0 && !this.innerScrolls(e.target)) this.unstick();
      else if (e.deltaY > 0) this.down = performance.now();
    }, { passive: true });
    el.addEventListener("touchstart", (e) => { this.touchY = e.touches[0]?.clientY ?? 0; }, { passive: true });
    el.addEventListener("touchmove", (e) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y > this.touchY + 3 && el.scrollTop > 0) this.unstick(); else if (y < this.touchY - 3) this.down = performance.now();
      this.touchY = y;
    }, { passive: true });
    el.addEventListener("keydown", (e) => {
      if (e.target.closest?.("input, textarea, select, [contenteditable=true], .cm-editor")) return;
      if ((e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home") && el.scrollTop > 0) this.unstick();
      else if (e.key === "End" || e.key === "PageDown" || e.key === "ArrowDown" || e.key === " ") this.down = performance.now();
    });
    el.addEventListener("pointerdown", (e) => {
      this.pointer = true;
      if (e.target === el) this.sbDrag = true; // the scrollbar (or empty space) itself
    }, { passive: true });
    const up = () => { this.pointer = false; this.sbDrag = false; };
    addEventListener("pointerup", up, true); addEventListener("pointercancel", up, true); addEventListener("blur", up);
    el.addEventListener("click", (e) => {
      const a = e.target.closest?.('a[href^="#"]');
      if (a && !a.dataset.url) this.unstick();
      const s = e.target.closest?.(".cv-sum");
      if (s) expandSummary(s);
    });
    el.addEventListener("scrollend", () => { this.smooth = false; });

    this.fab = document.createElement("button");
    this.fab.type = "button"; this.fab.className = "cv-fab"; this.fab.hidden = true;
    this.fab.setAttribute("aria-label", "Scroll to the latest message");
    this.fab.title = "Scroll to the latest message";
    this.fab.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg><span class="cv-n" hidden></span>`;
    this.fab.addEventListener("click", () => this.stickToBottom(true));
    el.after(this.fab);
    const op = el.offsetParent;
    if (op && op !== document.body && getComputedStyle(op).position === "static") op.style.position = "relative";
    this.fitFab();
  }

  // ----- follow -----
  innerScrolls(t) {
    for (let n = t; n && n !== this.el; n = n.parentElement) {
      if (n.scrollTop > 0 && n.scrollHeight > n.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(n).overflowY)) return true;
    }
    return false;
  }
  unstick() {
    if (!this.stuck) return;
    this.stuck = false; this.smooth = false;
    this.top = this.el.scrollTop; this.newMsgs = 0; this.grew = false;
    this.updateFab();
  }
  stick() {
    if (this.stuck) return;
    this.stuck = true; this.newMsgs = 0; this.grew = false;
    this.updateFab();
    this.follow();
  }
  /** Keep the bottom in view (only while stuck). Called after layout, so one read per frame. */
  follow() {
    if (!this.stuck || this.hidden) return;
    const el = this.el;
    if (this.smooth) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  }
  stickToBottom(smooth = false) {
    this.stuck = true; this.newMsgs = 0; this.grew = false;
    this.updateFab();
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.smooth = smooth && !reduce;
    this.follow();
    if (!this.smooth) requestAnimationFrame(() => this.follow());
  }
  onScroll() {
    const el = this.el;
    if (this.hidden || !el.clientHeight) return;
    const top = el.scrollTop, dist = el.scrollHeight - el.clientHeight - top;
    if (this.stuck) {
      // only the reader's own drags count (the wheel, keys and touch are handled where they happen)
      if ((this.pointer && top < this.lastTop - 0.5 && dist > 4) || (this.sbDrag && dist > 4)) this.unstick();
    } else if (dist <= 4 && (this.pointer || performance.now() - this.down < 1500)) this.stick();
    this.lastTop = top;
    if (!this.stuck) this.top = top;
    this.schedulePass();
    this.updateFab();
  }

  // ----- the ↓ button -----
  updateFab() {
    const show = !this.stuck && (this.newMsgs > 0 || this.grew) && !this.hidden;
    if (this.fab.hidden === !show && !show) return;
    this.fab.hidden = !show;
    const n = this.fab.querySelector(".cv-n");
    n.hidden = !(this.newMsgs > 0);
    n.textContent = this.newMsgs > 99 ? "99+" : String(this.newMsgs);
    this.fab.setAttribute("aria-label", this.newMsgs ? `${this.newMsgs} new — scroll to the latest message` : "Scroll to the latest message");
  }
  fitFab() {
    const el = this.el, op = el.offsetParent;
    if (!op || !el.clientHeight) return;
    this.fab.style.left = el.offsetLeft + el.offsetWidth / 2 + "px";
    this.fab.style.bottom = Math.max(0, op.clientHeight - (el.offsetTop + el.offsetHeight)) + 14 + "px";
  }

  // ----- messages -----
  adopt(node) {
    if (node.nodeType !== 1) return null;
    if (!node.classList.contains("ai-msg")) { this.ro.observe(node); return null; }
    if (this.of.has(node)) return this.of.get(node);
    const en = { node, ph: null, h: 0, make: null };
    this.of.set(node, en);
    // keep the entries in page order
    let at = 0;
    for (let p = node.previousElementSibling; p; p = p.previousElementSibling) { const pe = this.of.get(p); if (pe) { at = this.entries.indexOf(pe) + 1; break; } }
    this.entries.splice(at, 0, en);
    this.real.add(en);
    this.ro.observe(node);
    return en;
  }
  drop(en) {
    const i = this.entries.indexOf(en);
    if (i >= 0) this.entries.splice(i, 1);
    this.real.delete(en);
    if (en.node) { this.ro.unobserve(en.node); this.of.delete(en.node); }
    if (en.ph) this.of.delete(en.ph);
  }
  onMutate(list) {
    let added = false;
    for (const m of list) {
      for (const n of m.removedNodes) {
        const en = this.of.get(n);
        if (en && (en.ph === n || (!en.ph && en.node === n))) this.drop(en);
        else if (n.nodeType === 1) this.ro.unobserve(n);
      }
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1 || n.classList.contains("ai-msg-ph")) continue;
        const had = this.of.has(n);
        const en = this.adopt(n);
        if (en && !had) { added = true; if (!this.stuck) this.newMsgs++; }
      }
    }
    if (added || list.length) { if (this.stuck) this.nudge(); else this.updateFab(); this.schedulePass(); }
  }
  /** Something was added or changed: scroll once per frame (after layout, via the observer). */
  nudge() { if (this.stuck) requestAnimationFrame(() => this.follow()); }
  onResize(list) {
    const el = this.el;
    for (const r of list) {
      if (r.target === el) {
        if (el.clientHeight) {
          this.fitFab();
          if (!this.hidden && this.stuck) this.follow(); // the list itself got taller or shorter
          if (this.hidden) { this.hidden = false; if (this.stuck) { this.follow(); requestAnimationFrame(() => { if (this.stuck) this.follow(); }); } else el.scrollTop = this.top; }
        } else this.hidden = true;
        continue;
      }
      const en = this.of.get(r.target);
      const h = r.borderBoxSize?.[0]?.blockSize ?? r.contentRect.height;
      if (!en) continue;
      if (this.stuck) { en.h = h; continue; }
      // a message above the viewport changed height: keep what the reader sees where it is
      if (en.h && h !== en.h && en.node.offsetTop + en.h <= el.scrollTop + 1) { el.scrollTop += h - en.h; this.top = el.scrollTop; }
      else if (en.h && h > en.h) { this.grew = true; }
      en.h = h;
    }
    if (this.stuck) this.follow(); else this.updateFab();
    this.schedulePass();
  }

  // ----- virtualise -----
  schedulePass() { if (!this.passRaf && this.entries.length > KEEP) this.passRaf = requestAnimationFrame(() => { this.passRaf = 0; this.pass(); }); }
  nodeOf(en) { return en.ph || en.node; }
  /** The first entry whose bottom edge is below `y` (entries are in page order). */
  firstBelow(y) {
    let a = 0, b = this.entries.length - 1, r = this.entries.length;
    while (a <= b) {
      const m = (a + b) >> 1, n = this.nodeOf(this.entries[m]);
      if (n && n.offsetTop + n.offsetHeight >= y) { r = m; b = m - 1; } else a = m + 1;
    }
    return r;
  }
  pinned(en) {
    const n = en.node;
    if (!n) return false;
    if (n.dataset.live && Date.now() - +n.dataset.live < LIVE_MS) return true;
    if (n.contains(document.activeElement) && document.activeElement !== document.body) return true;
    const s = getSelection();
    if (s && !s.isCollapsed && (n.contains(s.anchorNode) || n.contains(s.focusNode))) return true;
    return false;
  }
  pass() {
    const el = this.el, H = el.clientHeight, n = this.entries.length;
    if (!H || this.hidden || n <= KEEP) return;
    this.stats.passes++;
    const top = el.scrollTop, lo = top - NEAR * H, hi = top + H + NEAR * H;
    const first = this.firstBelow(lo), vis = this.firstBelow(top);
    let lastIn = first;
    while (lastIn + 1 < n) { const nd = this.nodeOf(this.entries[lastIn + 1]); if (nd && nd.offsetTop <= hi) lastIn++; else break; }
    // The anchor: the first real message at or below the top edge. Whatever is swapped above it
    // (a placeholder's guess replaced by the real height) is cancelled by moving scrollTop.
    let anchorEn = null;
    for (let i = vis; i < n; i++) { const en = this.entries[i]; if (en.node && !en.ph) { anchorEn = en; break; } }
    const anchorBefore = anchorEn ? anchorEn.node.offsetTop - top : 0;
    let changed = false, budget = 4;
    // bring placeholders near the viewport back (nearest first)
    const want = [];
    for (let i = first; i <= lastIn && i < n; i++) if (this.entries[i].ph) want.push(i);
    want.sort((a, b) => Math.abs(a - vis) - Math.abs(b - vis));
    const t0 = performance.now();
    for (const i of want) {
      if (budget-- <= 0 || performance.now() - t0 > 6) { this.passRaf = requestAnimationFrame(() => { this.passRaf = 0; this.pass(); }); break; }
      this.restore(this.entries[i]); changed = true;
    }
    // far, old, finished messages leave the page
    const keepFrom = n - KEEP;
    let off = 6;
    for (const en of this.real) {
      const i = this.entries.indexOf(en);
      if (i < 0 || i >= keepFrom || (i >= first - 2 && i <= lastIn + 2)) continue;
      if (off <= 0) break;
      const nd = en.node;
      if (!nd || this.pinned(en)) continue;
      const farTop = nd.offsetTop + nd.offsetHeight < lo - H * 0.5, farBot = nd.offsetTop > hi + H * 0.5;
      if (!farTop && !farBot) continue;
      if (!en.folded) { en.folded = true; if (collapseHeavy(nd)) { off--; changed = true; continue; } } // detach after the new height is measured
      this.detach(en); off--; changed = true;
    }
    if (changed && anchorEn && !this.stuck && anchorEn.node.isConnected) {
      const d = (anchorEn.node.offsetTop - el.scrollTop) - anchorBefore;
      if (d) { el.scrollTop += d; this.top = el.scrollTop; }
    }
    if (changed && this.stuck) this.follow(); // estimated heights became real ones: stay at the bottom
  }
  restore(en) {
    if (!en.ph) return;
    if (!en.node) en.node = en.make();
    en.node.classList.add("cv-restored");
    en.ph.replaceWith(en.node);
    this.of.delete(en.ph); this.of.set(en.node, en);
    en.ph = null; en.h = 0; // the real height comes with the observer's first report; the pass keeps the anchor
    this.mo.takeRecords();
    this.real.add(en); this.ro.observe(en.node);
    this.stats.restored++;
  }
  detach(en) {
    const nd = en.node;
    if (!nd || en.ph) return;
    const h = en.h || nd.offsetHeight;
    const ph = document.createElement("div");
    ph.className = "ai-msg-ph" + (nd.classList.contains("user") ? " user" : "");
    ph.style.height = h + "px";
    ph.setAttribute("aria-hidden", "true");
    nd.replaceWith(ph);
    this.ro.unobserve(nd);
    this.of.set(ph, en);
    en.ph = ph; en.h = h;
    if (en.make) { this.of.delete(nd); en.node = null; } // can be rebuilt from the HTML cache
    this.real.delete(en);
    this.mo.takeRecords();
    this.stats.detached++;
  }

  // ----- loading a saved chat -----
  /**
   * Replace the list's messages by `items` ([{ role, text }]): only the newest KEEP are built
   * now (`build(item)` → a message element); the rest are placeholders, built when scrolled to.
   */
  loadHistory(items, build, est) {
    const el = this.el;
    this.mo.takeRecords();
    for (const en of this.entries) { if (en.node) this.ro.unobserve(en.node); }
    this.entries = []; this.real = new Set(); this.of = new WeakMap();
    for (const c of [...el.children]) c.remove();
    const frag = document.createDocumentFragment();
    const n = items.length;
    const width = Math.max(120, (el.clientWidth || 340) - 24);
    items.forEach((item, i) => {
      const en = { node: null, ph: null, h: 0, make: () => build(item), item };
      if (i >= n - KEEP) { en.node = build(item); frag.appendChild(en.node); this.of.set(en.node, en); this.real.add(en); }
      else {
        en.h = est ? est(item, width) : 80;
        en.ph = document.createElement("div");
        en.ph.className = "ai-msg-ph" + (item.role === "user" ? " user" : "");
        en.ph.style.height = en.h + "px"; en.ph.setAttribute("aria-hidden", "true");
        frag.appendChild(en.ph); this.of.set(en.ph, en);
      }
      this.entries.push(en);
    });
    el.appendChild(frag);
    for (const en of this.real) this.ro.observe(en.node);
    this.mo.takeRecords();
    this.newMsgs = 0; this.grew = false;
    this.stickToBottom(false);
    this.schedulePass();
  }
  /** Find messages containing `q` (also in placeholders: the text is searched, not the page). */
  find(q) {
    q = q.toLowerCase();
    const out = [];
    this.entries.forEach((en, i) => {
      const text = en.item ? en.item.text : (en.node ? en.node.textContent : "");
      if (text && text.toLowerCase().includes(q)) out.push(i);
    });
    return out;
  }
  /** Restore message `i` and scroll it into view (the reader asked for it: no longer following). */
  reveal(i) {
    const en = this.entries[i];
    if (!en) return null;
    this.unstick();
    if (en.ph) this.restore(en);
    en.node.scrollIntoView({ block: "center" });
    this.top = this.el.scrollTop;
    return en.node;
  }
}

// ---------------- finding the lists ----------------
/** The view of a list (made on first use). */
export function chatView(el) {
  if (!el) return null;
  let v = views.get(el);
  if (!v) { v = new View(el); views.set(el, v); known.add(el); }
  return v;
}
export const viewOf = (el) => views.get(el) || null;
function scan() {
  for (const el of document.querySelectorAll(SEL)) chatView(el);
}
/** Start finding every chat list by itself (now, and as sessions create more of them). */
export function initChatView() {
  scan();
  const panel = document.getElementById("ai-panel");
  if (panel && !panelObs) {
    panelObs = new MutationObserver(scan);
    panelObs.observe(panel, { childList: true });
    for (const el of known) if (el.parentElement && el.parentElement !== panel) panelObs.observe(el.parentElement, { childList: true });
    // a list added deeper, or shown again: look now and then while the panel is open
    scanTimer = setInterval(() => { if (!panel.hidden) { scan(); for (const el of known) if (el.parentElement) panelObs.observe(el.parentElement, { childList: true }); } }, 1500);
  }
}

// ---------------- what the chat code calls ----------------
/** The reader sent a message or pressed ↓: follow the bottom again. */
export function stickToBottom(el, smooth = false) { chatView(el)?.stickToBottom(smooth); }
/** Ask for a scroll to the bottom on the next frame (only has an effect while following). */
export function nudge(el) { chatView(el)?.nudge(); }
export function isStuck(el) { return views.get(el)?.stuck ?? true; }
/** The message is being written: never take it out of the page. */
export function markLive(msg) { if (msg) msg.dataset.live = String(Date.now()); }
export function markDone(msg) { if (msg) delete msg.dataset.live; }
export function loadHistory(el, items, build, est) { return chatView(el).loadHistory(items, build, est); }
export function findInChat(el, q) { return chatView(el).find(q); }
export function revealInChat(el, i) { return chatView(el).reveal(i); }
/** A rough height for a message not built yet (text length and the list's width). */
export function estimateHeight(item, width) {
  const per = Math.max(10, Math.floor(width / (item.role === "user" ? 7.4 : 7.1)));
  let lines = 0, paras = 0;
  for (const l of String(item.text || "").split("\n")) { lines += Math.max(1, Math.ceil(l.length / per)); paras++; }
  return item.role === "user" ? 16 + lines * 19 : 6 + lines * 21 + Math.min(paras, 40) * 4;
}

if (import.meta.env?.DEV) window.__chatView = { collapseHeavy, htmlCache, KEEP, views: () => [...known].map(viewOf) };
