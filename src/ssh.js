// Remote servers over SSH: the always-on part (loaded when Callio has servers or linked folders).
// Holds the server list, the link list and their live state, the status-bar chip, the badges in the
// file tree, the "hold" of unsaved tabs and the choice of where Claude Code runs. The dialogs, the
// settings page and the sync panel are ssh-ui.js (loaded only when opened).
import "./ssh.css";
import { call, listen } from "./api.js";
import { addVi, uiLang } from "./i18n.js";
import { registerRestorer } from "./restore.js";
import { isMain } from "./windows.js";
import { settings, updateSettings, getTabs, folder } from "./main.js";

addVi({
  "Remote servers": "Máy chủ SSH",
  "Server sync data": "Dữ liệu đồng bộ máy chủ",
  "Synced": "Đã đồng bộ",
  "Syncing": "Đang đồng bộ",
  "Offline": "Mất kết nối",
  "Paused": "Tạm dừng",
  "Reconnecting…": "Đang kết nối lại…",
  "Connecting…": "Đang kết nối…",
  "Run on": "Chạy trên",
  "This computer": "Máy này",
  "Run on: ": "Chạy trên: ",
  "Offline — turn the VPN on": "Mất kết nối — hãy bật VPN",
  "Server link": "Liên kết máy chủ",
  "Install Claude Code on the server": "Cài Claude Code trên máy chủ",
  "Claude Code is not installed on this server. Callio runs it on this computer and uses the server through tools (run commands, read files).": "Máy chủ chưa có Claude Code. Callio chạy nó trên máy này và dùng máy chủ qua công cụ (chạy lệnh, đọc tệp).",
  "Claude Code runs on the server; its changes sync back to this folder.": "Claude Code chạy trên máy chủ; thay đổi được đồng bộ về thư mục này.",
  "Running…": "Đang chạy…",
  "Installed.": "Đã cài.",
  "Install failed — see the log.": "Cài không thành công — xem nhật ký.",
  "linked folders were syncing": "liên kết đồng bộ đang dở",
});

const state = { hosts: [], notes: [], sshDir: "", hostState: new Map(), status: new Map(), subs: new Set(), inited: false, held: new Map(), info: new Map() };
export const L = (en, vi) => (uiLang() === "vi" ? vi : en);
// Messages from the backend are English; the most common ones get a Vietnamese form here.
const VI_MSG = [
  [/^Could not connect to (.+)\. This server needs a VPN — turn the VPN on and try again\.$/, (m) => `Không kết nối được ${m[1]}. Máy chủ này cần VPN — hãy bật VPN rồi thử lại.`],
  [/^Match blocks in your ssh config are ignored.*$/, () => "Các khối Match trong ssh config bị bỏ qua (Callio chỉ đọc các khối Host)."],
  [/^Match (.+) was skipped \(Match blocks are not supported\)\.$/, (m) => `Đã bỏ qua Match ${m[1]} (chưa hỗ trợ khối Match).`],
];
export function msgText(e) {
  const t = String(e?.message || e);
  if (uiLang() !== "vi") return t;
  for (const [re, f] of VI_MSG) { const m = t.match(re); if (m) return f(m); }
  return t;
}

export const hosts = () => state.hosts;
export const hostById = (id) => state.hosts.find((h) => h.id === id) || null;
export const hostLabel = (id) => hostById(id)?.name || id;
export const notes = () => ({ notes: state.notes, sshDir: state.sshDir });
export const hostState = (id) => state.hostState.get(id) || { state: "off", reason: "" };
export const links = () => settings.sshLinks || [];
export const linkStatus = (id) => state.status.get(id) || null;
export function onChange(fn) { state.subs.add(fn); return () => state.subs.delete(fn); }
function changed() { for (const f of state.subs) { try { f(); } catch {} } paintChip(); paintBadges(); paintBar(); }

const norm = (p) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
export function linkFor(path) {
  const p = norm(path);
  let best = null;
  for (const l of links()) { const b = norm(l.local); if ((p === b || p.startsWith(b + "/")) && (!best || b.length > norm(best.local).length)) best = l; }
  return best;
}
export const relIn = (link, path) => path.replace(/\\/g, "/").slice(link.local.replace(/\\/g, "/").replace(/\/+$/, "").length + 1);

// ---------------- servers ----------------
/** Send the stored servers to the backend, which merges them with ~/.ssh/config and returns the list. */
export async function pushHosts() {
  const r = await call("ssh_set_hosts", { stored: settings.sshHosts || [] });
  state.hosts = r.hosts || []; state.notes = r.notes || []; state.sshDir = r.sshDir || "";
  for (const s of r.states || []) state.hostState.set(s.id, s);
  changed();
  return r;
}
export async function saveHosts(stored) { updateSettings({ sshHosts: stored }); return pushHosts(); }
export async function saveLinks(list) { updateSettings({ sshLinks: list }); changed(); }

export async function startLink(l) {
  try { const st = await call("ssh_sync_start", { link: l }); if (st) state.status.set(l.id, st); }
  catch (e) { state.status.set(l.id, { state: "error", error: String(e?.message || e), up: 0, down: 0, conflicts: [], skipped: [], pending: [], transfers: [], log: [] }); }
  changed();
}
export async function stopLink(id, forget) { await call("ssh_sync_stop", { id, forget: !!forget }).catch(() => {}); state.status.delete(id); changed(); }

// ---------------- status chip ----------------
let chip = null;
function ensureChip() {
  if (chip) return chip;
  const bar = document.querySelector("#statusbar");
  if (!bar) return null;
  chip = document.createElement("button");
  chip.id = "st-ssh"; chip.className = "st-btn ssh-chip"; chip.hidden = true; chip.type = "button";
  bar.insertBefore(chip, document.querySelector("#st-words") || null);
  chip.onclick = () => import("./ssh-ui.js").then((m) => m.togglePanel(chip));
  return chip;
}
/** One line for the chip: the link that needs the most attention. */
export function summary() {
  const ls = links();
  if (!ls.length) return null;
  let best = null, rank = -1;
  for (const l of ls) {
    const st = linkStatus(l.id), hs = hostState(l.host);
    let r = 0, kind = "ok";
    if (st?.conflicts?.length) { r = 5; kind = "conflict"; }
    else if (hs.state === "off" || st?.state === "offline" || st?.state === "error") { r = 4; kind = "offline"; }
    else if (hs.state === "reconnecting" || hs.state === "connecting") { r = 3; kind = "reconnect"; }
    else if (st?.state === "paused" || l.paused) { r = 2; kind = "paused"; }
    else if (st && (st.state === "syncing" || st.up || st.down)) { r = 1; kind = "busy"; }
    if (r > rank) { rank = r; best = { l, st, kind, hs }; }
  }
  return best && { ...best, extra: ls.length - 1 };
}
function paintChip() {
  const c = ensureChip(); if (!c) return;
  const s = summary();
  c.hidden = !s;
  if (!s) return;
  const { l, st, kind, hs } = s, h = hostLabel(l.host), host = hostById(l.host);
  let txt = "";
  if (kind === "conflict") txt = `⚠ ${st.conflicts.length}`;
  else if (kind === "offline") txt = host?.needsVpn ? L("Offline — turn the VPN on", "Mất kết nối — hãy bật VPN") : L("Offline", "Mất kết nối");
  else if (kind === "reconnect") txt = L("Reconnecting…", "Đang kết nối lại…");
  else if (kind === "paused") txt = L("Paused", "Tạm dừng");
  else if (kind === "busy") txt = `${st.up ? "↑" + st.up : ""}${st.up && st.down ? " " : ""}${st.down ? "↓" + st.down : ""}` || L("Syncing", "Đang đồng bộ");
  else txt = L("Synced", "Đã đồng bộ");
  c.className = `st-btn ssh-chip k-${kind}`;
  c.innerHTML = `<i class="ssh-dot"></i><span class="ssh-h"></span><span class="ssh-t"></span>`;
  c.querySelector(".ssh-h").textContent = h + (s.extra ? ` +${s.extra}` : "");
  c.querySelector(".ssh-t").textContent = txt;
  c.title = `${h} · ${l.remote}` + (hs.reason ? `\n${hs.reason}` : "") + (st?.error ? `\n${st.error}` : "");
}

// ---------------- file tree badges ----------------
let badgeQueued = false;
const BADGE = { up: ["↑", "Waiting to upload"], down: ["↓", "Waiting to download"], conflict: ["⚠", "Changed on both sides — open the sync panel"], skip: ["⊘", "Large file — not synced"], "delete-local": ["↓", "Will be removed here"], "delete-remote": ["↑", "Will be removed on the server"] };
function marks() {
  const m = new Map();
  for (const l of links()) {
    const st = linkStatus(l.id); if (!st) continue;
    const base = norm(l.local);
    const put = (rel, kind) => m.set(base + "/" + rel.toLowerCase(), kind);
    for (const s of st.skipped || []) put(s.rel, "skip");
    for (const p of st.pending || []) put(p.rel, p.dir === "conflict" ? "conflict" : p.dir);
    for (const c of st.conflicts || []) put(c.rel, "conflict");
  }
  return m;
}
function paintBadges() {
  if (badgeQueued) return;
  badgeQueued = true;
  requestAnimationFrame(() => {
    badgeQueued = false;
    const tree = document.querySelector("#tree"); if (!tree) return;
    const m = marks();
    const dirs = new Set();
    for (const [p, k] of m) if (k === "conflict") { let d = p; while ((d = d.slice(0, d.lastIndexOf("/"))) && d.length > 1) dirs.add(d); }
    for (const el of tree.querySelectorAll(".tree-item")) {
      const p = norm(el.dataset.path);
      const k = m.get(p) || (dirs.has(p) ? "conflict" : "");
      const cur = el.querySelector(":scope > .ssh-badge");
      if (!k) { cur?.remove(); continue; }
      if (cur?.dataset.k === k) continue;
      cur?.remove();
      const b = document.createElement("span");
      b.className = `ssh-badge k-${k}`; b.dataset.k = k; b.textContent = BADGE[k][0]; b.title = L(BADGE[k][1], BADGE[k][1]);
      el.appendChild(b);
    }
  });
}
function watchTree() {
  const tree = document.querySelector("#tree"); if (!tree) return;
  new MutationObserver(() => { if (!badgeQueued) paintBadges(); }).observe(tree, { childList: true, subtree: true });
}

// ---------------- unsaved tabs hold the sync ----------------
function holdTick() {
  if (!isMain) return;
  for (const l of links()) {
    const base = norm(l.local) + "/";
    const rels = getTabs().filter((t) => t.dirty && t.path && norm(t.path).startsWith(base)).map((t) => relIn(l, t.path)).sort();
    const key = rels.join("\n");
    if ((state.held.get(l.id) ?? "") === key) continue;
    state.held.set(l.id, key);
    call("ssh_sync_hold", { id: l.id, rels }).catch(() => {});
  }
}

// ---------------- where Claude Code runs ----------------
let bar = null;
function paintBar() {
  const panel = document.querySelector("#ai-panel .ai-input"); if (!panel) return;
  const link = folder ? linkFor(folder) : null;
  if (!link) { bar?.remove(); bar = null; return; }
  if (!bar) {
    bar = document.createElement("div"); bar.id = "ssh-runon"; bar.className = "ssh-runon";
    panel.before(bar);
  }
  const cur = settings.sshRunOn?.[link.id] === "ssh" ? "ssh" : "local";
  const key = `${link.id}|${cur}|${hostLabel(link.host)}|${state.info.get(link.host)?.installed}`;
  if (bar.dataset.key === key) return;
  bar.dataset.key = key;
  const info = state.info.get(link.host);
  bar.innerHTML = `<label>${L("Run on", "Chạy trên")}: <select><option value="local">${L("This computer", "Máy này")}</option><option value="ssh"></option></select></label><span class="ssh-hint"></span><button type="button" class="small ssh-inst" hidden></button>`;
  const sel = bar.querySelector("select");
  sel.options[1].textContent = hostLabel(link.host);
  sel.value = cur;
  sel.onchange = async () => {
    updateSettings({ sshRunOn: { ...(settings.sshRunOn || {}), [link.id]: sel.value } });
    if (sel.value === "ssh") await refreshInfo(link.host);
    bar.dataset.key = ""; paintBar();
  };
  const hint = bar.querySelector(".ssh-hint"), inst = bar.querySelector(".ssh-inst");
  if (cur === "ssh") {
    if (!info) refreshInfo(link.host).then(() => { bar.dataset.key = ""; paintBar(); });
    else if (info.installed) hint.textContent = L("Claude Code runs on the server; its changes sync back to this folder.", "Claude Code chạy trên máy chủ; thay đổi được đồng bộ về thư mục này.");
    else {
      hint.textContent = L("Claude Code is not installed on this server. Callio runs it on this computer and uses the server through tools (run commands, read files).", "Máy chủ chưa có Claude Code. Callio chạy nó trên máy này và dùng máy chủ qua công cụ (chạy lệnh, đọc tệp).");
      inst.hidden = false; inst.textContent = L("Install Claude Code on the server", "Cài Claude Code trên máy chủ");
      inst.title = info.installCommand;
      inst.onclick = () => import("./ssh-ui.js").then((m) => m.installClaude(link.host, info.installCommand)).then(async () => { await refreshInfo(link.host); bar.dataset.key = ""; paintBar(); });
    }
  }
}
async function refreshInfo(host) {
  try { state.info.set(host, await call("ssh_claude_info", { host })); } catch (e) { state.info.set(host, { installed: false, path: "", installCommand: "", error: String(e?.message || e) }); }
  return state.info.get(host);
}
/** For cc-sessions: where this session runs, and a note for the system prompt. */
export async function sessionExtras(cwd) {
  const link = linkFor(cwd);
  if (!link) return {};
  if (settings.sshRunOn?.[link.id] !== "ssh") return {};
  const info = state.info.get(link.host) || (await refreshInfo(link.host));
  if (info.installed) return { runOn: `ssh:${link.host}` };
  const note = await call("ssh_prompt_note", { dir: cwd }).catch(() => "");
  return { note };
}

// ---------------- start ----------------
export async function initSsh() {
  if (state.inited) return;
  state.inited = true;
  watchTree();
  await listen("ssh-state", (e) => { const p = e.payload || e; state.hostState.set(p.id, p); changed(); });
  await listen("ssh-sync", (e) => { const p = e.payload || e; state.status.set(p.id, p.status); changed(); });
  await listen("ssh-ask", (e) => import("./ssh-ui.js").then((m) => m.answerAsk(e.payload || e)));
  await listen("ssh-alert", (e) => import("./ssh-ui.js").then((m) => m.showAlert(e.payload || e)));
  await pushHosts().catch(() => {});
  if (isMain) for (const l of links()) await startLink(l);
  setInterval(holdTick, 1500);
  setInterval(() => { if (document.visibilityState === "visible") paintBar(); }, 2500);
  registerRestorer({
    id: "ssh", order: 40,
    describe: () => { const n = (settings.sshOpen || []).length; return n ? `${n} ${L("linked folders were syncing", "liên kết đồng bộ đang dở")}` : null; },
    restore: async () => { for (const id of settings.sshOpen || []) call("ssh_sync_now", { id }).catch(() => {}); },
    discard: () => { updateSettings({ sshOpen: [] }); },
  });
  let lastOpen = "";
  onChange(() => {
    const open = links().filter((l) => { const s = linkStatus(l.id); return s && (s.state === "syncing" || s.up || s.down); }).map((l) => l.id);
    const k = open.join(",");
    if (k !== lastOpen) { lastOpen = k; updateSettings({ sshOpen: open }); }
  });
  changed();
}

// ---------------- kernels on a server (the picker group in jupyter.js) ----------------
const pyCache = new Map();
async function pythons(host, root, force) {
  const c = pyCache.get(host);
  if (!force && c && Date.now() - c.at < 60000) return c.list;
  const list = await call("ssh_py_list", { host, remoteRoot: root || null });
  pyCache.set(host, { list, at: Date.now() });
  return list;
}
const dirIn = (link, dir) => (dir && norm(dir).startsWith(norm(link.local)) ? relIn(link, dir.replace(/\\/g, "/") + "/x").replace(/\/?x$/, "").replace(/\/+$/, "") : "");
async function rootFor(host, link) {
  if (link) return link.remote;
  return (await call("ssh_list_dir", { host, path: null })).path;
}
/** The kernel a notebook in a linked folder starts with: the server's own Python, when it is reachable now. */
export async function defaultKernel(dir) {
  const link = dir ? linkFor(dir) : null;
  if (!link || hostState(link.host).state !== "connected") return null;
  const list = await pythons(link.host, link.remote);
  const ok = list.find((i) => i.hasServer && i.hasKernel);
  return ok ? { kind: "ssh", host: link.host, python: ok.path, remoteRoot: link.remote, spec: "python3", label: `${hostLabel(link.host)} · ${ok.label}` } : null;
}
export async function startServerJupyter(choice, dir) {
  const link = dir ? linkFor(dir) : null;
  if (choice.url) return call("ssh_jp_forward", { host: choice.host, url: choice.url, token: choice.token || null });
  const root = choice.remoteRoot || (await rootFor(choice.host, link));
  return call("ssh_jp_start", { host: choice.host, python: choice.python, remoteRoot: root, nbDir: link && link.host === choice.host ? dirIn(link, dir) : "", idleMin: null });
}
export async function pickerHtml(dir, esc) {
  const ids = new Set(), here = dir ? linkFor(dir) : null;
  if (here) ids.add(here.host);
  for (const l of links()) ids.add(l.host);
  for (const h of state.hosts) if (hostState(h.id).state === "connected") ids.add(h.id);
  let h = "";
  for (const id of ids) {
    if (!hostById(id)) continue;
    const name = hostLabel(id);
    h += `<h4 class="ssh-ph">${esc(L("SSH server", "Máy chủ SSH"))} · ${esc(name)}</h4>`;
    if (hostState(id).state !== "connected") { h += `<button class="jp-row" data-act="ssh-connect" data-host="${esc(id)}"><span class="jp-dot none"></span><span class="jp-rn">${esc(L("Connect to " + name + "…", "Kết nối " + name + "…"))}</span></button>`; continue; }
    let list = [];
    try { list = await pythons(id, (links().find((l) => l.host === id) || {}).remote); } catch (e) { h += `<div class="jp-note err">${esc(String(e?.message || e))}</div>`; continue; }
    list.forEach((i, k) => {
      if (i.hasServer && i.hasKernel) h += `<button class="jp-row" data-act="ssh-py" data-host="${esc(id)}" data-k="${k}" title="${esc(i.path)}"><span class="jp-dot none"></span><span class="jp-rn">${esc(i.label)}</span><small>${esc(i.path)}</small></button>`;
      else h += `<div class="jp-row bad"><span class="jp-dot none"></span><span class="jp-rn">${esc(i.label)}</span><span class="jp-miss"><span>${esc(L("missing", "thiếu"))}</span> <code>${esc(i.missing.join(", "))}</code></span><button class="small" data-act="ssh-install" data-host="${esc(id)}" data-k="${k}">${esc(L("Install", "Cài đặt"))}</button></div>`;
    });
    if (!list.length) h += `<div class="jp-note">${esc(L("No Python found on the server.", "Không tìm thấy Python trên máy chủ."))}</div>`;
    h += `<button class="jp-row add" data-act="ssh-fwd" data-host="${esc(id)}"><span class="jp-rn">${esc(L("Connect to a Jupyter already running on the server…", "Kết nối Jupyter có sẵn trên máy chủ…"))}</span></button>`;
  }
  return h;
}
export async function pickerClick(a, b, p, finish, repaint, dir) {
  const host = b.dataset.host, link = dir ? linkFor(dir) : null;
  const py = () => (pyCache.get(host)?.list || [])[+b.dataset.k];
  try {
    if (a === "ssh-connect") { await call("ssh_connect", { host }); pyCache.delete(host); return repaint(); }
    if (a === "ssh-py") { const i = py(); return finish({ kind: "ssh", host, python: i.path, remoteRoot: await rootFor(host, link && link.host === host ? link : (links().find((l) => l.host === host) || null)), spec: "python3", label: `${hostLabel(host)} · ${i.label}` }); }
    if (a === "ssh-fwd") {
      const { ask } = await import("./main.js");
      const url = await ask({ title: L("Jupyter already running on the server", "Jupyter có sẵn trên máy chủ"), text: L("Paste its address, for example http://localhost:8888/?token=…", "Dán địa chỉ của nó, ví dụ http://localhost:8888/?token=…"), input: "" });
      if (!url) return;
      return finish({ kind: "ssh", host, url: url.trim(), spec: "python3", label: `${hostLabel(host)} · Jupyter` });
    }
    if (a === "ssh-install") {
      const i = py(), id = "pip" + Math.random().toString(36).slice(2, 8), row = b.closest(".jp-row");
      b.disabled = true;
      const un = await listen("jp-log", (e) => { const q = e.payload || e; if (q.id === id && q.line) row.querySelector(".jp-miss").textContent = q.line.slice(0, 60); });
      try { await call("ssh_pip_install", { host, python: i.path, id }); } finally { un?.(); }
      pyCache.delete(host); return repaint();
    }
  } catch (e) { const { toast } = await import("./main.js"); toast(msgText(e), "err", 8000); }
}
