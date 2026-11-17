// Claude plan usage in the AI panel, next to the conversation's name: the 5-hour window, the
// weekly window and the per-model weekly windows (Fable…), each as a small meter with its
// percentage. The numbers are the ones Claude Code's own /usage screen shows: Callio asks Claude
// Code for them (cc_usage — no model is called, so asking costs no quota, and Callio never
// touches the sign-in). They are read when the panel opens, after every Claude Code answer and
// once a minute while the panel is in view; the time left until each window resets is redrawn
// every minute too. Click the meters to read them again now.
import { call } from "./api.js";
import { settings } from "./main.js";

let el = null, data = null, at = 0, busy = false, error = null, timer = 0;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function host() {
  if (el) return el;
  el = document.createElement("button");
  el.id = "ai-quota";
  el.type = "button";
  el.hidden = true;
  el.onclick = () => refreshQuota(true);
  const row = $(".ai-sess"), before = $("#ai-sess-new");
  if (row) row.insertBefore(el, before);
  return el;
}

const panelShown = () => { const p = $("#ai-panel"); return !!p && !p.hidden && !p.classList.contains("out"); };
const wanted = () => !!settings.ccEnabled && settings.ccQuota !== false;

function left(iso) {
  const t = Date.parse(iso || "");
  if (!t) return "";
  const m = Math.max(0, Math.round((t - Date.now()) / 60000));
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h ${m % 60} min`;
  return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
}
const when = (iso) => { const t = Date.parse(iso || ""); return t ? new Date(t).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : ""; };

/** The windows to show: 5 hours, the week, then each per-model weekly window (Fable first). */
function windows() {
  const r = data?.rate_limits;
  if (!r) return [];
  const out = [];
  const add = (key, label, long, w) => { if (w && w.utilization != null) out.push({ key, label, long, pct: Math.max(0, Math.min(100, Math.round(w.utilization))), resets: w.resets_at }); };
  add("5h", "5h", "5-hour limit", r.five_hour);
  add("week", "Week", "Weekly limit (all models)", r.seven_day);
  const scoped = [...(r.model_scoped || [])].sort((a, b) => (/fable/i.test(b.display_name) ? 1 : 0) - (/fable/i.test(a.display_name) ? 1 : 0));
  for (const m of scoped) add(`m-${m.display_name}`, m.display_name, `Weekly limit (${m.display_name})`, m);
  // older answers name the per-model windows one by one
  if (!scoped.length) { add("opus", "Opus", "Weekly limit (Opus)", r.seven_day_opus); add("sonnet", "Sonnet", "Weekly limit (Sonnet)", r.seven_day_sonnet); }
  return out;
}

function draw() {
  host();
  if (!wanted() || (data && data.rate_limits_available === false)) { el.hidden = true; return; }
  const ws = windows();
  if (!ws.length) {
    // nothing yet: say so only while asking or after a failure
    el.hidden = !(busy || error);
    el.className = busy ? "busy" : "err";
    el.innerHTML = busy ? `<span class="q-note">Reading usage…</span>` : `<span class="q-note">Usage unavailable</span>`;
    el.title = error ? `${error} — click to try again` : "";
    return;
  }
  el.hidden = false;
  el.className = busy ? "busy" : "";
  el.innerHTML = ws.map((w) => `<span class="q-w ${w.pct >= 90 ? "hot" : w.pct >= 70 ? "warm" : "ok"}"><span class="q-l">${esc(w.label)}</span><span class="q-bar"><i style="width:${w.pct}%"></i></span><b>${w.pct}%</b></span>`).join("");
  const lines = ws.map((w) => `${w.long}: ${w.pct}% used${w.resets ? ` · resets in ${left(w.resets)} (${when(w.resets)})` : ""}`);
  const age = Math.round((Date.now() - at) / 60000);
  el.title = `${lines.join("\n")}\n${age < 1 ? "Read just now" : `Read ${age} min ago`} from Claude Code · click to read again`;
}

/** Read the usage now (when `force`, even if it was read a moment ago). */
export async function refreshQuota(force = false) {
  host();
  if (!wanted()) { draw(); return; }
  if (busy || (!force && Date.now() - at < 20000)) return;
  busy = true; draw();
  try {
    data = await call("cc_usage");
    error = null;
    at = Date.now();
  } catch (e) {
    error = String(e?.message || e);
    if (force) data = data || null;
  }
  busy = false; draw();
}

/** Start the once-a-minute update (reads only while the AI panel is in view). */
export function initQuota() {
  host();
  clearInterval(timer);
  timer = setInterval(() => {
    if (!panelShown() || document.hidden || !wanted()) return;
    draw(); // the time left until reset
    refreshQuota();
  }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && panelShown()) refreshQuota(); });
  if (panelShown()) refreshQuota();
}
