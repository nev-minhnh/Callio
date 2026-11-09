// Waiting, made visible: a small popup with an animation (and a progress bar when the work can
// say how far it is) for anything that takes more than a moment — opening a large file,
// converting, exporting, starting an engine. Short waits never flash: the popup appears only
// after `delay` ms, and once shown stays at least 300 ms so it doesn't flicker.
let host = null;
const jobs = new Map();
let seq = 0;

function ensureHost() {
  if (host) return host;
  host = document.createElement("div");
  host.id = "loading-host";
  host.setAttribute("aria-live", "polite");
  document.body.appendChild(host);
  return host;
}

/**
 * Show a loading popup. Returns { set(fraction|null, text?), text(t), done() }.
 * opts: { delay = 250 ms, cancel: () => void (adds a Cancel button), detail: second line }
 */
export function loading(text, opts = {}) {
  const id = ++seq;
  const delay = opts.delay ?? 250;
  const job = { id, text, frac: null, detail: opts.detail || "", el: null, shownAt: 0, timer: null, closed: false };
  jobs.set(id, job);
  const show = () => {
    if (job.closed || job.el) return;
    const h = ensureHost();
    const el = document.createElement("div");
    el.className = "ld-card";
    el.innerHTML = `<div class="ld-spin" aria-hidden="true"><span></span><span></span><span></span></div><div class="ld-body"><div class="ld-text"></div><div class="ld-detail"></div><div class="ld-bar"><i></i></div></div>${opts.cancel ? `<button class="small ld-cancel">Cancel</button>` : ""}`;
    el.querySelector(".ld-text").textContent = job.text;
    el.querySelector(".ld-detail").textContent = job.detail;
    if (opts.cancel) el.querySelector(".ld-cancel").onclick = () => { try { opts.cancel(); } finally { api.done(); } };
    h.appendChild(el);
    job.el = el;
    job.shownAt = performance.now();
    paint();
  };
  const paint = () => {
    if (!job.el) return;
    const bar = job.el.querySelector(".ld-bar");
    bar.classList.toggle("indet", job.frac == null);
    if (job.frac != null) bar.firstChild.style.width = `${Math.round(Math.max(0, Math.min(1, job.frac)) * 100)}%`;
    job.el.querySelector(".ld-text").textContent = job.text;
    const d = job.el.querySelector(".ld-detail");
    d.textContent = job.detail;
    d.hidden = !job.detail;
  };
  job.timer = delay > 0 ? setTimeout(show, delay) : (show(), null);
  const api = {
    /** fraction 0…1, or null for "working…" */
    set(frac, text, detail) { job.frac = frac; if (text) job.text = text; if (detail != null) job.detail = detail; paint(); return api; },
    text(t, detail) { job.text = t; if (detail != null) job.detail = detail; paint(); return api; },
    done() {
      if (job.closed) return;
      job.closed = true;
      clearTimeout(job.timer);
      jobs.delete(id);
      const el = job.el;
      if (!el) return;
      const wait = Math.max(0, 300 - (performance.now() - job.shownAt));
      setTimeout(() => {
        el.classList.add("out");
        setTimeout(() => el.remove(), 180);
      }, wait);
    },
  };
  return api;
}

/** Run `fn(progress)` with a loading popup; progress(fraction, text?) updates it. */
export async function withLoading(text, fn, opts = {}) {
  const l = loading(text, opts);
  try { return await fn((f, t, d) => l.set(f, t, d)); }
  finally { l.done(); }
}

/** Mark a button busy (spinner, disabled) while `promise` runs. */
export async function busyButton(btn, promise) {
  if (!btn) return promise;
  btn.classList.add("is-busy");
  btn.disabled = true;
  try { return await promise; }
  finally { btn.classList.remove("is-busy"); btn.disabled = false; }
}
