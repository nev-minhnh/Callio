// Running notebooks: kernels on this computer (the author's own Python) and on a Jupyter
// server by URL + token. Everything goes through one client in the backend (Jupyter Server REST +
// the kernel channels WebSocket); this file speaks the Jupyter messaging protocol over it,
// writes outputs into the notebook exactly as Jupyter does, and draws the toolbar, the kernel
// picker and the "connect to a server" dialog. Loaded the first time a notebook opens.
import "./jupyter.css";
import { api, call, listen } from "./api.js";
import { addVi } from "./i18n.js";
import { registerRestorer } from "./restore.js";
import { onRpc } from "./rpc.js";
import { settings, updateSettings, toast, getTabs, tabText } from "./main.js";
import { ic } from "./icons.js";
import { liveNotebook, liveNotebooks, ansiHtml, stripAnsi, src, lines, parse } from "./notebook.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const uid = () => (crypto.randomUUID?.() || Math.random().toString(16).slice(2) + Date.now().toString(16)).replace(/-/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (cmd, args) => call(cmd, args);

addVi({
  "On this computer": "Môi trường trên máy", "Jupyter servers": "Máy chủ Jupyter", "Running kernels": "Kernel đang chạy",
  "Connect to a Jupyter server…": "Kết nối máy chủ Jupyter…", "Looking for Python…": "Đang tìm Python…",
  "missing": "thiếu", "Install packages": "Cài gói còn thiếu", "Installing…": "Đang cài…", "Close": "Đóng",
  "No Python with Jupyter found on this computer.": "Không tìm thấy Python có Jupyter trên máy.",
  "Run cell": "Chạy ô", "Run all": "Chạy tất cả", "Interrupt": "Ngắt", "Restart": "Khởi động lại",
  "Run cells above": "Chạy các ô phía trên", "Run cell and below": "Chạy ô này và phía dưới", "Restart and run all": "Khởi động lại và chạy tất cả",
  "Clear all outputs": "Xóa mọi kết quả", "Shut down kernel": "Tắt kernel", "Select kernel": "Chọn kernel",
  "idle": "rảnh", "running": "đang chạy", "starting…": "đang khởi động…", "stopped": "đã dừng", "disconnected": "mất kết nối",
  "Restart kernel": "Khởi động lại kernel", "not started": "chưa chạy",
  "Show all": "Hiện tất cả", "Ask AI to write this cell": "Nhờ AI viết ô này",
  "Shift+Enter run · Esc then A/B add a cell": "Shift+Enter chạy · Esc rồi A/B thêm ô",
  "Connect to a Jupyter server": "Kết nối máy chủ Jupyter", "Address": "Địa chỉ", "Token": "Mã token", "Name": "Tên",
  "Test": "Thử kết nối", "Save": "Lưu", "Cancel": "Hủy", "Trust this certificate": "Tin chứng chỉ này",
  "Attach": "Gắn vào", "Remove": "Xóa", "Edit": "Sửa", "Jupyter": "Jupyter",
  "Default Python interpreter (empty = Auto)": "Python mặc định (để trống = Tự động)",
  "Stop the local Jupyter server after (minutes without kernels, 0 = never)": "Tắt máy chủ Jupyter cục bộ sau (phút không có kernel, 0 = không tắt)",
  "Collapse outputs longer than (lines)": "Thu gọn kết quả dài hơn (dòng)",
  "Show HTML outputs (tables, rich display; scripts never run)": "Hiện kết quả HTML (bảng, hiển thị giàu; không bao giờ chạy script)",
  "Run cell (Ctrl+Enter)": "Chạy ô (Ctrl+Enter)", "Run all (Ctrl+Shift+Enter)": "Chạy tất cả (Ctrl+Shift+Enter)", "Interrupt (I, I)": "Ngắt ô đang chạy (I, I)",
  "Restart the kernel (0, 0)": "Khởi động lại kernel (0, 0)", "Choose where this notebook runs": "Chọn nơi notebook này chạy",
  "More: run above / below, restart and run all, clear outputs": "Thêm: chạy phía trên / dưới, khởi động lại và chạy tất cả, xóa kết quả",
  "Name of the server": "Tên máy chủ", "running on": "chạy trên", "Another kernel is running for this notebook.": "Notebook này đang có kernel khác chạy.",
});

// ---------------- helpers shared with the tests ----------------
/** Split a pasted Jupyter address into the server's base URL and the token (…/lab?token=…). */
export function parseServerUrl(input) {
  let s = String(input || "").trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "http://" + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const token = u.searchParams.get("token") || "";
  const path = u.pathname.replace(/\/(lab|tree|notebooks|edit|doc|api|terminals|consoles|voila|retro|nbclassic)(\/.*)?$/, "").replace(/\/+$/, "");
  return { baseUrl: u.origin + path + "/", token };
}

const servers = () => settings.jupyterServers || [];
const jmap = () => settings.jupyterMap || {};
function setMap(key, patch) {
  const m = { ...jmap() };
  if (patch === null) delete m[key]; else m[key] = { ...(m[key] || {}), ...patch };
  updateSettings({ jupyterMap: m });
}
const saveServers = (list) => updateSettings({ jupyterServers: list });
const winRoot = () => (/Windows/i.test(navigator.userAgent) ? "C:\\" : "/");

// ---------------- sessions: one kernel connection per notebook ----------------
const sessions = new Map(); // notebook key → session
const byWs = new Map();     // websocket key → session

function getSession(key) {
  let s = sessions.get(key);
  if (!s) {
    s = { key, ws: "ws" + uid().slice(0, 16), conn: null, choice: null, kernelId: null, spec: "", label: "", state: "none", progress: "", runs: new Map(), byMsg: new Map(), waiters: new Map(), displays: new Map(), info: null, stdin: null, retry: 0, closing: false, starting: null };
    sessions.set(key, s);
  }
  return s;
}
/** For tests and the status line: what the notebook's kernel session is doing. */
export const sessionInfo = (key) => { const s = sessions.get(key); return s && { state: s.state, kernelId: s.kernelId, runs: [...s.runs.keys()], byMsg: s.byMsg.size, label: s.label }; };
const hostOf = (s) => liveNotebook(s.key)?.host || null;
const alive = (s) => s.kernelId && !["none", "dead"].includes(s.state);

const STATES = { starting: "starting…", idle: "idle", busy: "running", dead: "stopped", disconnected: "disconnected", none: "" };
function setState(s, st) {
  if (s.state === st) return;
  s.state = st;
  repaintBars(s);
}
function repaintBars(s) { const h = hostOf(s); if (h?.visible()) exts.get(h.key)?.paintBar(); }

const exts = new Map(); // notebook key → ext (the thing notebook.js drives)

let wired = false;
async function wire() {
  if (wired) return;
  wired = true;
  await listen("jp-msg", ({ key, msg }) => { const s = byWs.get(key); if (s) onMsg(s, msg); });
  await listen("jp-ws", ({ key, state }) => { const s = byWs.get(key); if (s && state === "closed") onWsClosed(s); });
  await listen("jp-progress", ({ id, text }) => { for (const s of sessions.values()) if (s.starting && s.state === "starting") { s.progress = text; repaintBars(s); } });
  await listen("jp-server-gone", ({ id }) => { for (const s of sessions.values()) if (s.conn?.id === id) { s.kernelId = null; setState(s, "dead"); endRuns(s); } });
  J("jp_set_idle", { minutes: settings.jupyterIdleMin ?? 10 }).catch(() => {});
  setInterval(tick, 500);
}

function tick() {
  for (const c of liveNotebooks()) {
    if (!c.host.visible()) continue;
    for (const t of c.host.el.querySelectorAll(".nb-time.live")) t.textContent = fmt(Date.now() - +t.dataset.t0);
  }
}
const fmt = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`);

// ---------------- messaging ----------------
async function send(s, type, content, { channel = "shell", parent = {}, id } = {}) {
  const msgId = id || uid();
  const msg = { header: { msg_id: msgId, session: s.ws, username: "callio", date: new Date().toISOString(), msg_type: type, version: "5.3" }, parent_header: parent, metadata: {}, content, buffers: [], channel };
  await J("jp_ws_send", { key: s.ws, msg });
  return msgId;
}
/** Send a request and wait for its reply (shell channel). */
function request(s, type, content, ms = 8000) {
  return new Promise(async (resolve, reject) => {
    const id = uid();
    const t = setTimeout(() => { s.waiters.delete(id); reject(new Error("The kernel did not answer")); }, ms);
    s.waiters.set(id, (m) => { clearTimeout(t); resolve(m); }); // before sending: the answer can be quick
    try { await send(s, type, content, { id }); } catch (e) { clearTimeout(t); s.waiters.delete(id); reject(e); }
  });
}

function onMsg(s, msg) {
  try { onMsg1(s, msg); } catch (e) { console.error("jupyter message", e); }
}
function onMsg1(s, msg) {
  const type = msg.header?.msg_type || msg.msg_type;
  const pid = msg.parent_header?.msg_id;
  const c = msg.content || {};
  if (pid && s.waiters.has(pid) && msg.channel === "shell") { const w = s.waiters.get(pid); s.waiters.delete(pid); w(msg); }
  if (type === "status") {
    const st = c.execution_state;
    const r0 = pid ? s.byMsg.get(pid) : null;
    setState(s, st === "restarting" || st === "autorestarting" ? "starting" : st === "dead" ? "dead" : st);
    if (st === "dead") endRuns(s);
    if (r0 && st === "idle") { r0.idle = true; if (r0.replied) completeRun(s, r0); }
    return;
  }
  if (type === "kernel_info_reply") { s.info = c; return; }
  if (type === "update_display_data") { updateDisplay(s, c); return; }
  const run = pid ? s.byMsg.get(pid) : null;
  if (!run) return;
  const h = hostOf(s);
  const f = h?.findCell(run.cellId);
  const cell = f?.c;
  const paint = () => { h?.paintCell(run.cellId); h?.commitSoon(); };
  switch (type) {
    case "execute_input":
      run.state = "running"; run.t0 = Date.now(); s.displays.clear();
      if (cell) {
        cell.outputs = []; cell.execution_count = c.execution_count ?? null;
        cell.metadata = { ...(cell.metadata || {}), execution: { "iopub.execute_input": msg.header?.date || new Date().toISOString() } };
        h.paintCell(run.cellId); h.commitSoon();
      }
      break;
    case "stream": if (cell) { prepOut(s, run, cell); appendStream(cell, c.name || "stdout", c.text || ""); paint(); } break;
    case "display_data": case "execute_result": {
      if (!cell) break;
      prepOut(s, run, cell);
      const out = type === "display_data" ? { output_type: "display_data", data: c.data || {}, metadata: c.metadata || {} } : { output_type: "execute_result", data: c.data || {}, metadata: c.metadata || {}, execution_count: c.execution_count ?? null };
      cell.outputs.push(out);
      const did = c.transient?.display_id;
      if (did) { const l = s.displays.get(did) || []; l.push({ cellId: run.cellId, out }); s.displays.set(did, l); }
      paint(); break;
    }
    case "error": if (cell) { prepOut(s, run, cell); cell.outputs.push({ output_type: "error", ename: c.ename || "Error", evalue: c.evalue || "", traceback: c.traceback || [] }); paint(); } break;
    case "clear_output":
      if (cell) { if (c.wait) run.clear = true; else { cell.outputs = []; s.displays.clear(); paint(); } }
      break;
    case "input_request": askInput(s, run, msg); break;
    case "execute_reply":
      // the reply and the outputs travel on different channels: wait for the kernel's "idle" for this
      // request (or 1.5 s) so no output is lost
      run.reply = { c, msg }; run.replied = true;
      applyReply(s, run);
      if (run.idle) completeRun(s, run); else setTimeout(() => completeRun(s, run), 1500);
      break;
  }
}
/** Output about to be added: honours clear_output(wait=True). */
function prepOut(s, run, cell) {
  cell.outputs ??= [];
  if (run.clear) { cell.outputs = []; run.clear = false; }
}
function appendStream(cell, name, text) {
  const outs = cell.outputs;
  let last = outs[outs.length - 1];
  if (!(last && last.output_type === "stream" && last.name === name)) { last = { name, output_type: "stream", text: [] }; outs.push(last); }
  let arr = Array.isArray(last.text) ? last.text : lines(String(last.text || ""));
  if (/[\r\b]/.test(text)) {
    // progress bars: keep only what a terminal would show
    const joined = arr.join(""), cut = joined.lastIndexOf("\n") + 1;
    const tail = overwrite(joined.slice(cut) + text);
    arr = lines(joined.slice(0, cut) + tail);
  } else {
    if (arr.length && !arr[arr.length - 1].endsWith("\n")) {
      const first = text.match(/^[^\n]*\n?/)[0];
      arr[arr.length - 1] += first; text = text.slice(first.length);
    }
    if (text) arr.push(...lines(text));
  }
  last.text = arr;
}
function overwrite(s) {
  return s.split("\n").map((line) => {
    if (!/[\r\b]/.test(line)) return line;
    const cur = []; let pos = 0;
    for (const ch of line) { if (ch === "\r") pos = 0; else if (ch === "\b") pos = Math.max(0, pos - 1); else cur[pos++] = ch; }
    return cur.join("");
  }).join("\n");
}
function updateDisplay(s, c) {
  const did = c.transient?.display_id;
  const l = did && s.displays.get(did);
  if (!l) return;
  const h = hostOf(s);
  for (const { cellId, out } of l) { out.data = c.data || {}; out.metadata = c.metadata || {}; h?.paintCell(cellId); }
  h?.commitSoon();
}

/** The reply sets the execution count and the finish time (a cell aborted behind a failed one is left alone). */
function applyReply(s, run) {
  const { c, msg } = run.reply;
  const f = hostOf(s)?.findCell(run.cellId);
  if (f && c.status !== "aborted") {
    if (c.execution_count != null) f.c.execution_count = c.execution_count;
    f.c.metadata = { ...(f.c.metadata || {}), execution: { ...(f.c.metadata?.execution || {}), "shell.execute_reply": msg.header?.date || new Date().toISOString() } };
  }
  run.status = c.status || "ok";
}
function completeRun(s, run) {
  if (run.finished) return;
  run.finished = true;
  s.byMsg.delete(run.msgId);
  if (s.runs.get(run.cellId) === run) s.runs.delete(run.cellId);
  const h = hostOf(s);
  h?.paintCell(run.cellId);
  h?.commitSoon();
  closeStdin(s, run.cellId);
  run.done?.(run);
  if (!s.runs.size) repaintBars(s);
}
function endRuns(s) {
  const h = hostOf(s);
  for (const run of [...s.runs.values()]) { s.runs.delete(run.cellId); s.byMsg.delete(run.msgId); h?.paintCell(run.cellId); run.status = "dead"; run.finished = true; run.done?.(run); }
  s.stdin = null;
}

// ---------------- input() ----------------
function askInput(s, run, msg) {
  s.stdin = { cellId: run.cellId, msg, prompt: msg.content?.prompt || "", password: !!msg.content?.password };
  const h = hostOf(s);
  if (h?.visible()) showStdin(s, h);
}
function showStdin(s, h) {
  const st = s.stdin;
  if (!st) return;
  const f = h.findCell(st.cellId);
  const cellEl = f && h.el.querySelector(`.nb-cell[data-i="${f.i}"]`);
  if (!cellEl || cellEl.querySelector(":scope > .nb-stdin")) return;
  const box = document.createElement("div");
  box.className = "nb-stdin";
  box.innerHTML = `<label><span class="nb-stdin-p"></span><input type="${st.password ? "password" : "text"}" autocomplete="off" spellcheck="false" aria-label="Input for the running cell"></label>`;
  box.querySelector(".nb-stdin-p").textContent = st.prompt;
  cellEl.appendChild(box);
  const inp = box.querySelector("input");
  inp.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") { e.stopPropagation(); return; }
    e.preventDefault(); e.stopPropagation();
    const value = inp.value;
    s.stdin = null;
    box.innerHTML = `<span class="nb-stdin-p"></span><span class="nb-stdin-v"></span>`;
    box.querySelector(".nb-stdin-p").textContent = st.prompt;
    box.querySelector(".nb-stdin-v").textContent = st.password ? "••••••" : value;
    box.classList.add("done");
    try { await send(s, "input_reply", { value, status: "ok" }, { channel: "stdin", parent: st.msg.header }); } catch (err) { toast(err.message, "err"); }
  });
  inp.focus();
}
function closeStdin(s, cellId) {
  if (s.stdin?.cellId === cellId) s.stdin = null;
  const h = hostOf(s);
  const f = h?.findCell(cellId);
  const cellEl = f && h.visible() ? h.el.querySelector(`.nb-cell[data-i="${f.i}"]`) : null;
  cellEl?.querySelector(":scope > .nb-stdin:not(.done)")?.remove();
}

// ---------------- kernels ----------------
const connOf = (conn) => ({ id: conn.id, kind: conn.kind, baseUrl: conn.baseUrl || "", fingerprint: conn.fingerprint || null });
const rest = (conn, method, path, body, timeoutS) => J("jp_rest", { conn: connOf(conn), method, path, body: body ?? null, timeoutS: timeoutS || null });

async function interpreters(dir, force) {
  const k = dir || "";
  const c = interpreters.cache;
  if (!force && c && c.dir === k && Date.now() - c.at < 60000) return c.list;
  const list = await J("jp_interpreters", { dir: k });
  interpreters.cache = { dir: k, list, at: Date.now() };
  return list;
}

/** Start a kernel for the notebook with the chosen environment / server. */
async function startWith(host, choice) {
  const s = getSession(host.key);
  await shutdownKernel(s, { quiet: true });
  s.choice = choice; s.label = choice.label || ""; s.spec = choice.spec || "python3"; s.progress = "";
  s.closing = false;
  setState(s, "starting");
  let conn, kernelPath = null;
  try {
    if (choice.kind === "local") {
      s.starting = { connId: null };
      const dir = host.dir || winRoot();
      const info = await J("jp_local_start", { python: choice.python, dir });
      conn = { id: info.id, kind: "local", baseUrl: info.baseUrl };
      kernelPath = info.kernelPath;
    } else if (choice.kind === "wsl" || choice.kind === "docker") {
      // [wsl] a server started inside a WSL distro or a Docker container
      s.starting = { connId: null };
      const info = await J("envs_jp_start", { env: choice.env, python: choice.python, dir: host.dir || "" });
      conn = { id: info.id, kind: info.kind, baseUrl: info.baseUrl };
      kernelPath = info.kernelPath;
    } else {
      const sv = servers().find((x) => x.id === choice.serverId);
      if (!sv) throw new Error("This server was removed. Pick another kernel.");
      conn = { id: sv.id, kind: "url", baseUrl: sv.baseUrl, fingerprint: sv.fingerprint || null };
    }
    s.starting = { connId: conn.id };
    // the spec must exist on the server; otherwise use the server's default
    let spec = s.spec;
    let specs = null;
    try { specs = await rest(conn, "GET", "/api/kernelspecs", null, 15); } catch (e) { if (choice.kind === "url") throw e; }
    if (specs && !specs.kernelspecs?.[spec]) spec = specs.default || Object.keys(specs.kernelspecs || {})[0] || spec;
    const display = specs?.kernelspecs?.[spec]?.spec?.display_name || spec;
    const k = await rest(conn, "POST", "/api/kernels", { name: spec, ...(kernelPath != null ? { path: kernelPath } : {}) }, 60);
    s.conn = conn; s.spec = spec;
    if (choice.kind === "url") s.label = `${servers().find((x) => x.id === choice.serverId)?.name || "server"} · ${spec}`;
    s.specInfo = { display_name: display, language: specs?.kernelspecs?.[spec]?.spec?.language || "python", name: spec };
    await connectWs(s, k.id);
    s.starting = null;
    setMap(host.key, { choice: { ...choice, spec }, conn, kernelId: k.id, active: true, stale: false, label: s.label });
    rememberKernelspec(host, s);
    return s;
  } catch (e) {
    s.starting = null;
    setState(s, "none");
    s.kernelId = null;
    throw e;
  }
}
function rememberKernelspec(host, s) {
  const nb = host.nb;
  if (!nb || !s.specInfo) return;
  const cur = nb.metadata?.kernelspec;
  if (cur && cur.name === s.specInfo.name && cur.display_name === s.specInfo.display_name) return;
  nb.metadata = { ...(nb.metadata || {}), kernelspec: { display_name: s.specInfo.display_name, language: s.specInfo.language, name: s.specInfo.name } };
  host.commit();
}

async function connectWs(s, kernelId) {
  s.kernelId = kernelId;
  // a fresh key per connection: the "closed" event of an earlier socket must not be taken for this one
  byWs.delete(s.ws);
  s.ws = "ws" + uid().slice(0, 16);
  byWs.set(s.ws, s);
  await J("jp_ws_open", { conn: connOf(s.conn), kernel: kernelId, key: s.ws });
  s.retry = 0;
  try {
    const r = await request(s, "kernel_info_request", {}, 30000);
    s.info = r.content;
  } catch { /* the first status message will tell */ }
  if (s.state === "starting" || s.state === "disconnected") setState(s, "idle");
}

async function onWsClosed(s) {
  if (s.closing || !s.kernelId) return;
  setState(s, "disconnected");
  // the server and kernel may still be there: try again a few times, then check the kernel
  while (!s.closing && s.retry < 6) {
    await sleep(Math.min(16000, 1000 * 2 ** s.retry++));
    if (s.closing) return;
    try {
      const k = await rest(s.conn, "GET", `/api/kernels/${s.kernelId}`, null, 8);
      await connectWs(s, k.id);
      if (k.execution_state && s.state === "idle") setState(s, k.execution_state === "busy" ? "busy" : "idle");
      return;
    } catch (e) {
      if (/HTTP 404/.test(e.message)) break;
    }
  }
  if (!s.closing) { s.kernelId = null; setState(s, "dead"); endRuns(s); setMap(s.key, { active: false }); }
}

async function shutdownKernel(s, { quiet } = {}) {
  s.closing = true;
  const id = s.kernelId, conn = s.conn;
  if (s.ws) { J("jp_ws_close", { key: s.ws }).catch(() => {}); byWs.delete(s.ws); }
  endRuns(s);
  s.kernelId = null;
  if (id && conn) { try { await rest(conn, "DELETE", `/api/kernels/${id}`, null, 15); } catch (e) { if (!quiet && !/HTTP 404/.test(e.message)) toast(e.message, "err"); } }
  s.conn = null; s.state = "none"; s.info = null;
  setMap(s.key, { active: false, kernelId: null });
  repaintBars(s);
}

/** Works out which kernel to use when the notebook has none yet (remembered, default, or ask). */
async function chooseDefault(host) {
  const saved = jmap()[host.key]?.choice;
  if (saved && (saved.kind === "local" || saved.kind === "wsl" || saved.kind === "docker" || servers().some((x) => x.id === saved.serverId))) return saved;
  const dir = host.dir || "";
  // [wsl] a notebook that lives in a WSL distro runs in that distro when it has a usable Python
  if (/^[\\/]{2}wsl(\.localhost|\$)[\\/]/i.test(dir)) { const pick = await import("./envs-jupyter.js").then((m) => m.defaultEnvChoice(host, settings)).catch(() => null); if (pick) return pick; }
  const list = await interpreters(dir);
  const usable = list.filter((i) => i.hasServer && i.hasKernel);
  const want = settings.jupyterDefaultPython;
  const pick = (want && usable.find((i) => i.path.toLowerCase() === want.toLowerCase())) || usable[0];
  if (pick) return { kind: "local", python: pick.path, spec: host.nb?.metadata?.kernelspec?.name || "python3", label: pick.label };
  return null;
}

/** The notebook's kernel, starting one if needed; null when the author backs out. */
async function ensureKernel(host) {
  const s = getSession(host.key);
  if (alive(s)) return s;
  if (s.state === "disconnected") { toast("The kernel connection was lost. Wait a moment or pick the kernel again.", "err"); return null; }
  if (s.startingP) return s.startingP;
  s.startingP = (async () => {
    try {
      let choice = await chooseDefault(host);
      if (!choice) {
        toast("No Python with Jupyter found. Pick an environment or connect to a server.", "", 5000);
        choice = await openPicker(host, { need: true });
        if (!choice) return null;
      }
      return await startWith(host, choice);
    } catch (e) { toast(e.message || String(e), "err", 8000); return null; }
    finally { s.startingP = null; }
  })();
  return s.startingP;
}

async function restartKernel(host) {
  const s = getSession(host.key);
  if (!alive(s)) return ensureKernel(host);
  endRuns(s);
  setState(s, "starting");
  try {
    await rest(s.conn, "POST", `/api/kernels/${s.kernelId}/restart`, null, 60);
    // wait until the new kernel answers
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const k = await rest(s.conn, "GET", `/api/kernels/${s.kernelId}`, null, 8).catch(() => null);
      if (k && k.execution_state !== "starting" && k.execution_state !== "restarting") break;
    }
    try { const r = await request(s, "kernel_info_request", {}, 20000); s.info = r.content; } catch {}
    setState(s, "idle");
  } catch (e) { toast(e.message, "err"); setState(s, "dead"); }
  return s;
}

async function interruptKernel(host) {
  const s = getSession(host.key);
  if (!alive(s)) return;
  try { await rest(s.conn, "POST", `/api/kernels/${s.kernelId}/interrupt`, null, 15); } catch (e) { toast(e.message, "err"); }
}

// ---------------- running cells ----------------
/** Run code cells (by id) in order; resolves when the last one has finished. */
async function runCells(host, ids) {
  const nb = host.nb;
  if (!nb) return [];
  host.sync();
  host.ensureIds();
  const s = await ensureKernel(host);
  if (!s) return [];
  noteLanguage(host, s);
  const runs = [];
  const todo = ids.map((id) => host.findCell(id)).filter((f) => f && f.c.cell_type === "code");
  // queued first, so every cell shows [*] at once
  for (const { c } of todo) {
    if (s.runs.has(c.id)) continue;
    const run = { cellId: c.id, msgId: null, state: "queued", t0: Date.now(), clear: false, done: null };
    run.promise = new Promise((r) => { run.done = r; });
    s.runs.set(c.id, run); runs.push(run);
    host.paintCell(c.id);
  }
  repaintBars(s);
  for (const run of runs) {
    const f = host.findCell(run.cellId);
    if (!f) { s.runs.delete(run.cellId); run.done(run); continue; }
    const code = src(f.c.source);
    if (!code.trim()) { // nothing to run: Jupyter leaves such a cell empty
      s.runs.delete(run.cellId); f.c.outputs = []; f.c.execution_count = null; host.paintCell(run.cellId); run.done(run); continue;
    }
    try {
      run.msgId = uid();
      s.byMsg.set(run.msgId, run); // before sending: the first messages can be quick
      await send(s, "execute_request", { code, silent: false, store_history: true, user_expressions: {}, allow_stdin: true, stop_on_error: true }, { id: run.msgId });
    } catch (e) {
      s.byMsg.delete(run.msgId); s.runs.delete(run.cellId); host.paintCell(run.cellId); run.finished = true; run.done(run);
      toast(e.message || "Could not send the cell to the kernel", "err");
    }
  }
  await Promise.all(runs.map((r) => r.promise));
  host.commit();
  return runs;
}
function noteLanguage(host, s) {
  const li = s.info?.language_info;
  const nb = host.nb;
  if (!li || !nb) return;
  const cur = nb.metadata?.language_info;
  if (cur && cur.name === li.name && cur.version === li.version) return;
  nb.metadata = { ...(nb.metadata || {}), language_info: li };
}

// ---------------- toolbar ----------------
const DOT = { idle: "idle", busy: "busy", starting: "starting", dead: "dead", disconnected: "dead", none: "none" };
function chipLabel(host, s) {
  if (s.label) return s.label;
  const m = jmap()[host.key];
  if (m?.label) return m.label;
  return host.nb?.metadata?.kernelspec?.display_name || "";
}
function barHtml(host) {
  const s = getSession(host.key);
  const lbl = chipLabel(host, s);
  const stale = !alive(s) && s.state !== "starting" && jmap()[host.key]?.stale;
  const st = ["idle", "busy", "starting", "disconnected", "dead"].includes(s.state) ? STATES[s.state] : "not started";
  const remote = s.conn?.kind === "url" || (!s.conn && jmap()[host.key]?.choice?.kind === "url");
  const busy = s.runs.size > 0;
  const prog = s.state === "starting" && s.progress ? ` title="${esc(s.progress)}"` : "";
  return `<button class="small jp-b" data-jp="run" title="Run cell (Ctrl+Enter)">${ic("play")}<span>Run cell</span></button>
    <button class="small jp-b" data-jp="runall" title="Run all (Ctrl+Shift+Enter)">${ic("play-circle")}<span>Run all</span></button>
    <button class="small jp-b" data-jp="interrupt" title="Interrupt (I, I)"${busy ? "" : " disabled"}>${ic("pause")}<span>Interrupt</span></button>
    <button class="small jp-b" data-jp="restart" title="Restart the kernel (0, 0)">${ic("rotate-cw")}<span>Restart</span></button>
    <button class="icon small jp-b" data-jp="more" title="More: run above / below, restart and run all, clear outputs" aria-haspopup="menu">${ic("more")}</button>
    <span class="jp-gap"></span>
    <button class="jp-chip${remote ? " remote" : ""}" data-jp="kernel" aria-haspopup="listbox" title="Choose where this notebook runs"${prog}>
      <span class="jp-dot ${DOT[s.state] || "none"}"></span><span class="jp-name">${lbl ? esc(lbl) : "Select kernel"}</span><span class="jp-st">${esc(st)}</span>${ic("chevron-down")}</button>
    ${stale ? `<button class="small jp-b" data-jp="start" title="The kernel stopped when Callio closed. Start it again; no cell runs by itself.">${ic("refresh")}<span>Restart kernel</span></button>` : ""}`;
}

export function attach(host) {
  wire();
  const s0 = getSession(host.key);
  const ext = {
    cellRun: (c) => (c.id ? getSession(host.key).runs.get(c.id) || null : null),
    elapsed(c) {
      const e = c.metadata?.execution;
      const a = e?.["iopub.execute_input"], b = e?.["shell.execute_reply"];
      if (!a || !b) return null;
      const d = Date.parse(b) - Date.parse(a);
      return Number.isFinite(d) && d >= 0 ? d : null;
    },
    paintBar() {
      const slot = host.el.querySelector(".jp-tb");
      if (!slot || !host.visible()) return;
      slot.innerHTML = barHtml(host);
      slot.onclick = (e) => {
        const b = e.target.closest("[data-jp]");
        if (!b || b.disabled) return;
        const a = b.dataset.jp;
        if (a === "run") ext.run([host.nb?.cells[host.selected()]?.id].filter(Boolean), true);
        else if (a === "runall") ext.runAll();
        else if (a === "interrupt") ext.interrupt();
        else if (a === "restart") ext.restart();
        else if (a === "kernel") openPicker(host, { anchor: b });
        else if (a === "more") openMore(host, b, ext);
        else if (a === "start") startFromMemory(host);
      };
      const s = getSession(host.key);
      if (s.stdin) showStdin(s, host);
    },
    selected() {},
    async run(ids, byToolbar) {
      if (byToolbar) host.ensureIds();
      if (byToolbar && host.nb) { const c = host.nb.cells[host.selected()]; ids = c ? [c.id] : []; }
      return runCells(host, ids);
    },
    async runAll() { host.ensureIds(); return runCells(host, host.nb.cells.filter((c) => c.cell_type === "code").map((c) => c.id)); },
    async runRange(from, to) { host.ensureIds(); return runCells(host, host.nb.cells.slice(from, to).filter((c) => c.cell_type === "code").map((c) => c.id)); },
    async restart() { await restartKernel(host); },
    async restartRunAll() { const s = await restartKernel(host); if (s) await ext.runAll(); },
    interrupt: () => interruptKernel(host),
    async shutdown() { await shutdownKernel(getSession(host.key)); },
    clearOutputs() {
      const nb = host.nb;
      if (!nb) return;
      for (const c of nb.cells) if (c.cell_type === "code") { c.outputs = []; c.execution_count = null; if (c.metadata?.execution) { const m = { ...c.metadata }; delete m.execution; c.metadata = m; } }
      host.commit(); host.repaintAll();
    },
    askAI: (i) => askAI(host, i),
    tab: (ta, i, shift) => completeOrInspect(host, ta, shift),
    popupOpen: () => !!popup,
    popupKey: (e, ta) => popupKey(e, ta),
    closePopup,
    dispose() { exts.delete(host.key); },
  };
  exts.set(host.key, ext);
  reattachIfPossible(host);
  void s0;
  return ext;
}

async function startFromMemory(host) {
  const choice = jmap()[host.key]?.choice;
  if (!choice) return openPicker(host, {});
  try { await startWith(host, choice); } catch (e) { toast(e.message || String(e), "err", 8000); }
}

/** A remote kernel that is still there gets re-attached when the notebook opens (and after a restart of Callio). */
async function reattachIfPossible(host) {
  const s = getSession(host.key);
  const m = jmap()[host.key];
  if (alive(s) || s.starting || s.startingP || !m?.active || !m.kernelId || m.conn?.kind !== "url") { repaintBars(s); return; }
  s.reattaching = true;
  try {
    const k = await rest(m.conn, "GET", `/api/kernels/${m.kernelId}`, null, 8);
    s.conn = m.conn; s.choice = m.choice; s.label = m.label || ""; s.spec = k.name || m.choice?.spec || ""; s.closing = false;
    await connectWs(s, k.id);
    setState(s, k.execution_state === "busy" ? "busy" : "idle");
  } catch (e) {
    if (/HTTP 404/.test(e.message)) setMap(host.key, { active: false, kernelId: null, stale: true });
  } finally { s.reattaching = false; repaintBars(s); }
}

// ---------------- popovers ----------------
let pop = null;
function closePop() { pop?.remove(); pop = null; document.removeEventListener("mousedown", popAway, true); document.removeEventListener("keydown", popEsc, true); }
const popAway = (e) => { if (pop && !pop.contains(e.target) && !e.target.closest("[data-jp=kernel],[data-jp=more]")) closePop(); };
const popEsc = (e) => { if (e.key === "Escape") { e.stopPropagation(); closePop(); } };
function openPop(anchor, cls) {
  closePop();
  pop = document.createElement("div");
  pop.className = "jp-pop " + (cls || "");
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = r.bottom + 4 + "px";
  pop.style.right = Math.max(8, window.innerWidth - r.right) + "px";
  document.addEventListener("mousedown", popAway, true);
  document.addEventListener("keydown", popEsc, true);
  return pop;
}

function openMore(host, anchor, ext) {
  const p = openPop(anchor, "menu");
  const sel = host.selected();
  const items = [
    ["Run cells above", () => ext.runRange(0, sel)],
    ["Run cell and below", () => ext.runRange(sel, host.cellCount())],
    ["Restart and run all", () => ext.restartRunAll()],
    ["Clear all outputs", () => ext.clearOutputs()],
    ["Shut down kernel", () => ext.shutdown()],
  ];
  p.innerHTML = items.map((it, i) => `<button class="jp-item" data-i="${i}">${it[0]}</button>`).join("");
  p.onclick = (e) => { const b = e.target.closest("[data-i]"); if (!b) return; closePop(); items[+b.dataset.i][1](); };
}

/** The kernel picker. Resolves with the choice when `need` is set (the run was waiting for it). */
function openPicker(host, { anchor, need } = {}) {
  anchor = anchor || host.el.querySelector("[data-jp=kernel]") || host.el;
  const p = openPop(anchor, "picker");
  p.setAttribute("role", "listbox");
  return new Promise((resolve) => {
    let done = false;
    const finish = (choice) => { if (done) return; done = true; closePop(); resolve(choice || null); if (choice && !need) switchTo(host, choice); };
    const obs = new MutationObserver(() => { if (!p.isConnected) { obs.disconnect(); finish(null); } });
    obs.observe(document.body, { childList: true });
    p.innerHTML = `<div class="jp-note">Looking for Python…</div>`;
    paintPicker(host, p, finish);
  });
}
async function switchTo(host, choice) {
  try { await startWith(host, choice); } catch (e) { toast(e.message || String(e), "err", 8000); }
}

async function paintPicker(host, p, finish, force) {
  const dir = host.dir || "";
  let list = [];
  try { list = await interpreters(dir, force); } catch (e) { list = []; }
  if (!p.isConnected) return;
  const s = getSession(host.key);
  const locals = await J("jp_local_list").catch(() => []);
  const ok = list.filter((i) => i.hasServer && i.hasKernel), bad = list.filter((i) => !(i.hasServer && i.hasKernel));
  const cur = s.choice?.kind === "local" ? s.choice.python : null;
  let h = `<h4>On this computer</h4>`;
  h += ok.map((i) => `<button class="jp-row${i.path === cur && alive(s) ? " cur" : ""}" data-act="local" data-path="${esc(i.path)}" title="${esc(i.path)}"><span class="jp-dot ${i.path === cur && alive(s) ? DOT[s.state] : "none"}"></span><span class="jp-rn">${esc(i.label)}</span><small>${esc(i.path)}</small></button>`).join("");
  h += bad.map((i, k) => `<div class="jp-row bad"><span class="jp-dot none"></span><span class="jp-rn">${esc(i.label)}</span><span class="jp-miss"><span>missing</span> <code>${esc(i.missing.join(", "))}</code></span><button class="small" data-act="install" data-k="${k}">Install packages</button></div>`).join("");
  if (!list.length) h += `<div class="jp-note">No Python with Jupyter found on this computer.</div>`;
  // other kernelspecs of servers that are already running (R, Julia…)
  for (const l of locals) {
    try {
      const sp = await rest({ id: l.id, kind: "local" }, "GET", "/api/kernelspecs", null, 6);
      for (const [name, v] of Object.entries(sp.kernelspecs || {})) {
        if (name === "python3") continue;
        h += `<button class="jp-row sub" data-act="local" data-path="${esc(l.python)}" data-spec="${esc(name)}"><span class="jp-dot none"></span><span class="jp-rn">${esc(v.spec?.display_name || name)}</span><small>${esc(l.python)}</small></button>`;
      }
    } catch {}
  }
  h += `<div class="jp-envs"></div>`; // [wsl] groups "WSL · distro" and "Docker · container" are filled in below
  h += `<h4>Jupyter servers</h4>`;
  h += servers().map((sv) => `<div class="jp-srv" data-id="${esc(sv.id)}"><button class="jp-row" data-act="server" data-id="${esc(sv.id)}" title="${esc(sv.baseUrl)}">${ic("globe")}<span class="jp-rn">${esc(sv.name)}</span><small>${esc(sv.baseUrl)}</small></button><button class="icon small" data-act="edit" data-id="${esc(sv.id)}" title="Edit">${ic("pen")}</button><button class="icon small" data-act="remove" data-id="${esc(sv.id)}" title="Remove">${ic("x")}</button><div class="jp-specs" hidden></div></div>`).join("");
  h += `<button class="jp-row add" data-act="connect">${ic("plus")}<span class="jp-rn">Connect to a Jupyter server…</span></button>`;
  if (alive(s)) h += `<h4>Running kernels</h4><div class="jp-kernels"><div class="jp-note">…</div></div>`;
  p.innerHTML = h;
  import("./envs-jupyter.js").then((m) => m.mountEnvGroups(host, p, finish, s.choice)); // [wsl]
  if (alive(s)) fillKernels(host, p, finish);
  p.onclick = async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const a = b.dataset.act;
    if (a === "local") {
      const i = list.find((x) => x.path === b.dataset.path);
      return finish({ kind: "local", python: b.dataset.path, spec: b.dataset.spec || host.nb?.metadata?.kernelspec?.name || "python3", label: i?.label || b.querySelector(".jp-rn")?.textContent || "Python" });
    }
    if (a === "install") return installPackages(p, bad[+b.dataset.k], host, finish);
    if (a === "connect") { closePop(); const sv = await connectDialog(); if (sv) openPicker(host, { need: false }); return; }
    if (a === "edit") { closePop(); const sv = await connectDialog(servers().find((x) => x.id === b.dataset.id)); if (sv) openPicker(host, {}); return; }
    if (a === "remove") {
      const sv = servers().find((x) => x.id === b.dataset.id);
      if (!sv) return;
      saveServers(servers().filter((x) => x.id !== sv.id));
      api.setSecret(`callio-jupyter-${sv.id}`, "").catch(() => {});
      return paintPicker(host, p, finish);
    }
    if (a === "server") return expandServer(host, p, b.dataset.id, finish);
    if (a === "spec") {
      const sv = servers().find((x) => x.id === b.dataset.id);
      return finish({ kind: "url", serverId: sv.id, spec: b.dataset.spec, label: `${sv.name} · ${b.dataset.spec}` });
    }
    if (a === "attach") return attachKernel(host, b.dataset.id).then(() => finish(null));
    if (a === "kill") { try { await rest(getSession(host.key).conn, "DELETE", `/api/kernels/${b.dataset.id}`, null, 15); } catch (er) { toast(er.message, "err"); } return fillKernels(host, p, finish); }
  };
}

async function expandServer(host, p, id, finish) {
  const box = p.querySelector(`.jp-srv[data-id="${CSS.escape(id)}"] .jp-specs`);
  if (!box) return;
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="jp-note">…</div>`;
  const sv = servers().find((x) => x.id === id);
  try {
    const sp = await rest({ id: sv.id, kind: "url", baseUrl: sv.baseUrl, fingerprint: sv.fingerprint }, "GET", "/api/kernelspecs", null, 10);
    box.innerHTML = Object.entries(sp.kernelspecs || {}).map(([n, v]) => `<button class="jp-row sub" data-act="spec" data-id="${esc(id)}" data-spec="${esc(n)}"><span class="jp-dot none"></span><span class="jp-rn">${esc(sv.name)} · ${esc(n)}</span><small>${esc(v.spec?.display_name || "")}</small></button>`).join("") || `<div class="jp-note">No kernels on this server.</div>`;
  } catch (e) { box.innerHTML = `<div class="jp-note err"></div>`; box.firstChild.textContent = e.message; }
}

async function fillKernels(host, p, finish) {
  const box = p.querySelector(".jp-kernels");
  const s = getSession(host.key);
  if (!box || !s.conn) return;
  try {
    const ks = await rest(s.conn, "GET", "/api/kernels", null, 8);
    box.innerHTML = ks.map((k) => `<div class="jp-krow"><span class="jp-dot ${DOT[k.execution_state] || "none"}"></span><span class="jp-rn">${esc(k.name)} · ${esc(k.id.slice(0, 8))}${k.id === s.kernelId ? " ★" : ""}</span>${k.id === s.kernelId ? "" : `<button class="small" data-act="attach" data-id="${esc(k.id)}">Attach</button>`}<button class="icon small" data-act="kill" data-id="${esc(k.id)}" title="Shut down kernel">${ic("x")}</button></div>`).join("") || `<div class="jp-note">–</div>`;
  } catch { box.innerHTML = ""; }
}
async function attachKernel(host, kernelId) {
  const s = getSession(host.key);
  const conn = s.conn;
  if (!conn) return;
  const choice = s.choice;
  await shutdownKernel(s, { quiet: true });
  s.conn = conn; s.choice = choice; s.closing = false;
  try { const k = await rest(conn, "GET", `/api/kernels/${kernelId}`, null, 10); s.spec = k.name; await connectWs(s, k.id); setMap(host.key, { choice, conn, kernelId: k.id, active: true, label: s.label }); setState(s, "idle"); }
  catch (e) { toast(e.message, "err"); }
}

async function installPackages(p, interp, host, finish) {
  if (!interp) return;
  const id = "pip" + uid().slice(0, 8);
  const row = [...p.querySelectorAll(".jp-row.bad")].find((r) => r.querySelector(".jp-rn")?.textContent === interp.label);
  const log = document.createElement("div");
  log.className = "jp-logbox";
  log.innerHTML = `<div class="jp-logh"><b>Installing…</b><code></code></div><pre class="jp-log" tabindex="0"></pre><button class="small" data-act="close-log">Close</button>`;
  log.querySelector("code").textContent = `${interp.path} -m pip install jupyter_server ipykernel`;
  (row || p).after(log);
  const pre = log.querySelector("pre");
  const off = await listen("jp-log", (e) => {
    if (e.id !== id) return;
    if (e.line != null) { pre.textContent += e.line + "\n"; pre.scrollTop = pre.scrollHeight; }
    if (e.done) { off?.(); log.querySelector("b").textContent = e.code === 0 ? "Done" : `Failed (exit code ${e.code})`; if (e.code === 0) setTimeout(() => paintPicker(host, p, finish, true), 600); }
  });
  log.querySelector("[data-act=close-log]").onclick = () => log.remove();
  J("jp_pip_install", { python: interp.path, id }).catch((e) => { pre.textContent += String(e.message || e) + "\n"; });
}

// ---------------- connect to a server (URL + token) ----------------
/** Dialog: address, token, name; Test; trust a self-signed certificate. Resolves with the saved server or null. */
function connectDialog(existing) {
  return new Promise(async (resolve) => {
    const d = document.createElement("dialog");
    d.className = "jp-dlg";
    d.innerHTML = `<form method="dialog"><h3>Connect to a Jupyter server</h3>
      <label>Address <input name="url" type="text" placeholder="http://host:8888 or a pasted …/lab?token=… link" autocomplete="off" spellcheck="false"></label>
      <label>Token <input name="token" type="password" autocomplete="off" spellcheck="false"></label>
      <label>Name <input name="name" type="text" autocomplete="off"></label>
      <div class="jp-result" aria-live="polite"></div>
      <div class="jp-cert" hidden><p></p><code></code><button type="button" class="small" data-x="trust">Trust this certificate</button></div>
      <div class="jp-btns"><button type="button" data-x="cancel">Cancel</button><button type="button" data-x="test">Test</button><button type="button" class="primary" data-x="save">Save</button></div></form>`;
    document.body.appendChild(d);
    const f = (n) => d.querySelector(`[name=${n}]`);
    let fingerprint = existing?.fingerprint || "";
    let tested = null;
    f("url").value = existing?.baseUrl || "";
    f("name").value = existing?.name || "";
    if (existing) { try { f("token").value = (await api.getSecret(`callio-jupyter-${existing.id}`)) || ""; } catch {} }
    const result = d.querySelector(".jp-result"), certBox = d.querySelector(".jp-cert");
    const say = (t, cls) => { result.className = "jp-result " + (cls || ""); result.textContent = t; };
    // a pasted …/lab?token=… link is split into address and token right away
    f("url").addEventListener("input", () => {
      const v = f("url").value;
      if (/[?&]token=/.test(v)) { const r = parseServerUrl(v); if (r) { f("url").value = r.baseUrl; if (r.token) f("token").value = r.token; } }
    });
    const read = () => {
      const r = parseServerUrl(f("url").value);
      return r ? { baseUrl: r.baseUrl, token: f("token").value.trim() || r.token } : null;
    };
    async function test() {
      const r = read();
      if (!r) { say("Enter the server's address, like http://host:8888", "err"); return null; }
      say("…");
      certBox.hidden = true;
      try {
        const v = await J("jp_test", { url: r.baseUrl, token: r.token, fingerprint: fingerprint || null });
        if (v.cert) {
          certBox.hidden = false;
          certBox.querySelector("p").textContent = "This server's certificate is not from a trusted authority (it may be self-signed). If you know this server, you can trust exactly this certificate:";
          certBox.querySelector("code").textContent = "SHA-256 " + v.cert.fingerprint.match(/.{2}/g).join(":");
          certBox.dataset.fp = v.cert.fingerprint;
          say("Not connected: certificate not trusted.", "err");
          return null;
        }
        const names = Object.values(v.kernelspecs?.kernelspecs || {}).map((k) => k.spec?.display_name || k.name);
        say(`Connected. Jupyter Server ${v.version || ""}. Kernels: ${names.join(", ") || "none"}`, "ok");
        tested = { baseUrl: v.baseUrl || r.baseUrl, token: r.token };
        if (!f("name").value) f("name").value = new URL(r.baseUrl).host;
        return tested;
      } catch (e) { say(e.message || String(e), "err"); return null; }
    }
    d.addEventListener("click", async (e) => {
      const x = e.target.closest("[data-x]")?.dataset.x;
      if (x === "cancel") { d.close(); }
      else if (x === "trust") { fingerprint = certBox.dataset.fp; certBox.hidden = true; await test(); }
      else if (x === "test") await test();
      else if (x === "save") {
        const t = tested || (await test());
        if (!t) return;
        const id = existing?.id || "srv" + uid().slice(0, 10);
        try { await api.setSecret(`callio-jupyter-${id}`, t.token); } catch (er) { say("Could not save the token in Windows Credential Manager: " + er.message, "err"); return; }
        const sv = { id, name: f("name").value.trim() || new URL(t.baseUrl).host, baseUrl: t.baseUrl, ...(fingerprint ? { fingerprint } : {}) };
        saveServers([...servers().filter((x2) => x2.id !== id), sv]);
        d.dataset.saved = JSON.stringify(sv);
        d.close();
      }
    });
    d.addEventListener("close", () => { const sv = d.dataset.saved ? JSON.parse(d.dataset.saved) : null; d.remove(); resolve(sv); });
    d.addEventListener("input", () => { tested = null; });
    d.showModal();
    f("url").focus();
  });
}

// ---------------- completion and help (Tab, Shift+Tab) ----------------
let popup = null;
function closePopup() { popup?.el.remove(); popup = null; }
const cpIndex = (str, cp) => { let i = 0, n = 0; while (i < str.length && n < cp) { i += str.codePointAt(i) > 0xffff ? 2 : 1; n++; } return i; };
const cpCount = (str) => [...str].length;

/** Tab: complete the word before the cursor (kernel), or indent when there is nothing to complete. */
function completeOrInspect(host, ta, shift) {
  const s = getSession(host.key);
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos);
  if (!shift && (!/[\w.\])]$/.test(before) || ta.selectionEnd !== pos)) return false;
  if (!alive(s)) return false;
  const code = ta.value, cp = cpCount(before);
  (async () => {
    try {
      if (shift) {
        const r = await request(s, "inspect_request", { code, cursor_pos: cp, detail_level: 0 }, 6000);
        const t = r.content?.found ? r.content.data?.["text/plain"] : "";
        if (t) showPopup(ta, [], t);
        return;
      }
      const r = await request(s, "complete_request", { code, cursor_pos: cp }, 6000);
      const m = r.content?.matches || [];
      if (!m.length) return;
      const a = cpIndex(code, r.content.cursor_start), b = cpIndex(code, r.content.cursor_end);
      if (m.length === 1) { ta.setRangeText(m[0], a, b, "end"); ta.dispatchEvent(new Event("input")); return; }
      const common = m.reduce((x, y) => { let i = 0; while (i < x.length && x[i] === y[i]) i++; return x.slice(0, i); });
      if (common.length > b - a) { ta.setRangeText(common, a, b, "end"); ta.dispatchEvent(new Event("input")); }
      showPopup(ta, m.slice(0, 200), "", { a, b: a + common.length > b ? a + common.length : b });
    } catch { /* kernel busy or gone: the key does nothing */ }
  })();
  return true;
}
function showPopup(ta, items, help, range) {
  closePopup();
  const el = document.createElement("div");
  el.className = "jp-comp";
  if (help) el.innerHTML = `<pre class="jp-help">${ansiHtml(help.slice(0, 6000))}</pre>`;
  else el.innerHTML = items.map((m, i) => `<div class="jp-ci${i === 0 ? " on" : ""}" data-i="${i}"></div>`).join("");
  if (!help) el.querySelectorAll(".jp-ci").forEach((d, i) => { d.textContent = items[i]; });
  const r = ta.getBoundingClientRect();
  el.style.left = Math.max(8, r.left) + "px";
  el.style.top = Math.min(window.innerHeight - 180, r.bottom + 2) + "px";
  document.body.appendChild(el);
  popup = { el, items, i: 0, range, ta, help: !!help };
  el.onmousedown = (e) => { e.preventDefault(); const d = e.target.closest(".jp-ci"); if (d) acceptPopup(+d.dataset.i); };
}
function acceptPopup(i) {
  const p = popup;
  if (!p || p.help) return closePopup();
  const { ta, range } = p;
  ta.setRangeText(p.items[i], range.a, Math.max(range.b, ta.selectionStart), "end");
  ta.dispatchEvent(new Event("input"));
  closePopup(); ta.focus();
}
function popupKey(e) {
  if (!popup) return false;
  const p = popup;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePopup(); return true; }
  if (p.help) { closePopup(); return false; }
  const move = (d) => { p.i = (p.i + d + p.items.length) % p.items.length; p.el.querySelectorAll(".jp-ci").forEach((x, i) => x.classList.toggle("on", i === p.i)); p.el.querySelector(".on")?.scrollIntoView({ block: "nearest" }); };
  if (e.key === "ArrowDown") { e.preventDefault(); move(1); return true; }
  if (e.key === "ArrowUp") { e.preventDefault(); move(-1); return true; }
  if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acceptPopup(p.i); return true; }
  closePopup();
  return false;
}

// ---------------- "Ask AI to write this cell" ----------------
const clip = (t, n) => (t.length > n ? t.slice(0, n) + "\n…" : t);
function outText(c, n = 1500) {
  const parts = [];
  for (const o of c.outputs || []) {
    if (o.output_type === "stream") parts.push(stripAnsi(src(o.text)));
    else if (o.output_type === "error") parts.push(stripAnsi((o.traceback || []).join("\n")) || `${o.ename}: ${o.evalue}`);
    else if (o.data?.["text/plain"]) parts.push(stripAnsi(src(o.data["text/plain"])));
    else if (o.data?.["image/png"] || o.data?.["image/jpeg"]) parts.push("[image]");
  }
  const t = parts.join("\n").trim();
  return t.length > n ? "…" + t.slice(-n) : t;
}
async function askAI(host, i) {
  const nb = host.nb;
  const c = nb?.cells[i];
  if (!c) return;
  host.ensureIds();
  const lang = nb.metadata?.language_info?.name || nb.metadata?.kernelspec?.language || "python";
  const cellText = (x) => `${x.cell_type === "markdown" ? "[markdown] " : ""}${clip(src(x.source), 1200)}`;
  let ctx = `# Jupyter notebook cell to write\nNotebook: ${host.path || "(unsaved notebook)"} · language ${lang} · cell id ${c.id} (position ${i + 1} of ${nb.cells.length})\nThe cell's current source:\n<cell>\n${src(c.source)}\n</cell>`;
  const nbs = [[i - 2, "Two cells before"], [i - 1, "Cell before"], [i + 1, "Cell after"]].filter(([k]) => nb.cells[k]);
  for (const [k, label] of nbs) ctx += `\n\n${label}:\n<cell>\n${cellText(nb.cells[k])}\n</cell>`;
  const own = outText(c);
  let lastErr = "";
  // the latest error anywhere in the notebook (the cell's own output is added above)
  for (let k = nb.cells.length - 1; k >= 0 && !lastErr; k--) for (const o of nb.cells[k].outputs || []) if (o.output_type === "error") lastErr = `${o.ename}: ${o.evalue}\n${clip(stripAnsi((o.traceback || []).join("\n")), 1500)}`;
  if (own) ctx += `\n\nThis cell's latest output (truncated):\n<output>\n${own}\n</output>`;
  if (lastErr && !own.includes("Error")) ctx += `\n\nThe latest error above it:\n<output>\n${lastErr}\n</output>`;
  ctx += `\n\nAnswer with the complete new source of this cell in one fenced code block; the author applies it to the cell and sees a diff first.`;
  const ai = await import("./ai.js");
  exts.get(host.key).lastAI = ctx; // (read by the tests)
  ai.setExtraContext({
    text: ctx, label: `Apply to cell [${c.execution_count ?? " "}]`,
    apply: (code) => reviewCellEdit(host, c.id, code, "AI: write cell"),
  });
  ai.toggleAIPanel(true);
  const input = document.querySelector("#ai-text");
  if (input) {
    if (!input.value.trim()) input.value = `Write this notebook cell (id ${c.id} in ${host.path || "this notebook"}): `;
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  }
}
/** Show the proposed source as a diff; Apply puts it into the cell (one Undo step, version saved first). */
export async function reviewCellEdit(host, cellId, code, label) {
  const f = host.findCell(cellId);
  if (!f) return toast("That cell is gone.", "err");
  const { showDiffDialog } = await import("./history.js");
  const before = src(f.c.source);
  showDiffDialog({
    title: `${label} — cell ${f.i + 1}`, before, after: code.replace(/\n$/, ""),
    restoreLabel: "Apply to cell",
    onRestore: async () => { await applyCellEdit(host, cellId, code.replace(/\n$/, ""), label); },
  });
}
async function applyCellEdit(host, cellId, source, label) {
  const f = host.findCell(cellId);
  if (!f) throw new Error("That cell is gone.");
  const tab = getTabs().find((t) => t.path && samePath(t.path, host.path));
  if (tab) { try { const { record } = await import("./history.js"); await record(tab, tabText(tab), `Before AI: ${label}`, "ai"); } catch {} }
  host.setSource(f.i, source);
  host.select(f.i, { focus: false });
}

// ---------------- Claude Code's notebook tools ----------------
const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
const samePath = (a, b) => norm(a) === norm(b);
function openNotebook(path) { return liveNotebooks().find((c) => samePath(c.path, path)) || null; }
async function loadForTool(path, { forEdit } = {}) {
  let c = openNotebook(path);
  if (!c && forEdit) {
    const { openPath } = await import("./main.js");
    await openPath(path, undefined, true); // here: this window answers the tool
    for (let i = 0; i < 40 && !(c = openNotebook(path)); i++) await sleep(150);
    if (!c) throw new Error("Could not open the notebook in Callio. Open it there first.");
  }
  if (c) { c.sync(); return { host: c.host, nb: c.host.nb, open: true }; }
  const r = await api.readText(path);
  return { host: null, nb: parse(r.text), open: false };
}
const first = (s) => src(s).split("\n")[0].slice(0, 90);
function cellOut(c, withImages) {
  const lines2 = [], images = [];
  for (const o of c.outputs || []) {
    if (o.output_type === "stream") lines2.push(stripAnsi(src(o.text)).trimEnd());
    else if (o.output_type === "error") lines2.push(stripAnsi((o.traceback || []).join("\n")) || `${o.ename}: ${o.evalue}`);
    else {
      const d = o.data || {};
      const img = d["image/png"] ? ["image/png", d["image/png"]] : d["image/jpeg"] ? ["image/jpeg", d["image/jpeg"]] : null;
      if (img) {
        const data = src(img[1]).replace(/\s/g, "");
        let dim = "";
        if (img[0] === "image/png" && data.length > 40) { try { const b = atob(data.slice(0, 40)); const u32 = (k) => ((b.charCodeAt(k) << 24) | (b.charCodeAt(k + 1) << 16) | (b.charCodeAt(k + 2) << 8) | b.charCodeAt(k + 3)) >>> 0; dim = ` ${u32(16)}x${u32(20)}`; } catch {} }
        lines2.push(`[image${dim}]`);
        if (withImages && images.length < 4) images.push({ data, mimeType: img[0] });
      } else if (d["text/plain"]) lines2.push(stripAnsi(src(d["text/plain"])).trimEnd());
      else if (d["text/html"]) lines2.push(src(d["text/html"]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000));
      else lines2.push(`[${Object.keys(d).join(", ")}]`);
    }
  }
  const text = lines2.join("\n");
  return { text: text.length > 20000 ? text.slice(0, 20000) + "\n… (cut)" : text, images };
}
function pickCell(nb, p) {
  if (p.id) { const i = nb.cells.findIndex((c) => c.id === p.id); if (i >= 0) return i; }
  if (Number.isInteger(p.index) && nb.cells[p.index]) return p.index;
  return -1;
}
export async function rpc(name, p) {
  const path = p.path;
  if (!/\.ipynb$/i.test(path || "")) return { error: "Not a notebook (.ipynb) path." };
  try {
    if (name === "nb_list_cells") {
      const { nb } = await loadForTool(path);
      return nb.cells.map((c, i) => `${i} | ${c.id || "-"} | ${c.cell_type} | ${c.cell_type === "code" ? `[${c.execution_count ?? " "}]` : ""} | ${first(c.source)}`).join("\n") || "(no cells)";
    }
    if (name === "nb_read_cell") {
      const { nb } = await loadForTool(path);
      const i = pickCell(nb, p);
      if (i < 0) return { error: "No such cell. Use nb_list_cells to see the ids." };
      const c = nb.cells[i];
      const o = cellOut(c, false);
      return `Cell ${i} (id ${c.id || "-"}, ${c.cell_type}${c.cell_type === "code" ? `, [${c.execution_count ?? " "}]` : ""})\n--- source ---\n${src(c.source)}\n--- outputs ---\n${o.text || "(none)"}`;
    }
    if (name === "nb_kernel_state") {
      const c = openNotebook(path);
      const s = c ? getSession(c.key) : null;
      if (!s || !s.kernelId) return { path, open: !!c, state: "none", note: "No kernel is running for this notebook. The author can pick one with the kernel chip above the cells." };
      return { path, state: s.state, kernel: s.spec, where: s.label, kind: s.conn?.kind, running_cells: [...s.runs.keys()], queued: s.runs.size };
    }
    if (name === "nb_edit_cell" || name === "nb_insert_cell") {
      const { host } = await loadForTool(path, { forEdit: true });
      host.ensureIds();
      if (name === "nb_edit_cell") {
        const f = host.findCell(p.id);
        if (!f) return { error: "No cell with that id." };
        if (f.c.cell_type === "code" && getSession(host.key).runs.has(f.c.id)) return { error: "That cell is running. Interrupt it first." };
        await applyCellEdit(host, p.id, String(p.source ?? ""), "edit cell");
        return `Edited cell ${f.i} (${p.id}). The author can undo it with Ctrl+Z in the notebook tab.`;
      }
      let at = 0;
      if (p.after_id) { const f = host.findCell(p.after_id); if (!f) return { error: "No cell with that id (after_id)." }; at = f.i + 1; }
      const tab = getTabs().find((t) => t.path && samePath(t.path, host.path));
      if (tab) { try { const { record } = await import("./history.js"); await record(tab, tabText(tab), "Before AI: insert cell", "ai"); } catch {} }
      const cell = host.insertAt(at, p.type === "markdown" ? "markdown" : "code", String(p.source ?? ""));
      return `Inserted a ${p.type} cell at position ${at} (id ${cell?.id || "-"}).`;
    }
    if (name === "nb_run_cell") {
      const c = openNotebook(path);
      if (!c) return { error: "The notebook is not open in Callio, so it has no kernel. Ask the author to open it and pick a kernel." };
      const s = getSession(c.key);
      if (!alive(s)) return { error: "This notebook has no running kernel. Ask the author to start one with the kernel chip." };
      const f = c.host.findCell(p.id);
      if (!f || f.c.cell_type !== "code") return { error: "No code cell with that id." };
      const limit = Math.max(5, Math.min(3600, p.timeout_s || 120)) * 1000;
      const done = c.ext.run([p.id]);
      const r = await Promise.race([done.then(() => "done"), sleep(limit).then(() => "timeout")]);
      const g = c.host.findCell(p.id);
      const o = cellOut(g.c, true);
      return { text: `${r === "timeout" ? `Still running after ${limit / 1000} s (the cell keeps running); output so far:\n` : ""}Cell ${g.i} [${g.c.execution_count ?? " "}]\n${o.text || "(no output)"}`, images: o.images };
    }
  } catch (e) { return { error: e.message || String(e) }; }
  return { error: "Unknown notebook tool" };
}
let rpcDone = false;
export function registerRpc() {
  if (rpcDone) return; rpcDone = true;
  for (const n of ["nb_list_cells", "nb_read_cell", "nb_edit_cell", "nb_insert_cell", "nb_run_cell", "nb_kernel_state"]) onRpc(n, (p) => rpc(n, p));
}

// ---------------- after a crash: bring kernels back ----------------
registerRestorer({
  id: "jupyter", order: 40,
  describe: () => {
    const n = Object.values(jmap()).filter((m) => m.active).length;
    if (!n) return null;
    return settings.uiLang === "vi" ? `${n} notebook đang có kernel` : `${n} notebook${n > 1 ? "s" : ""} with a running kernel`;
  },
  async restore() {
    // remote kernels that are still there are re-attached when their notebook opens; local ones
    // died with the app, so the notebook offers "Restart kernel" (no cell ever runs by itself)
    const m = { ...jmap() };
    for (const [k, v] of Object.entries(m)) {
      if (!v.active) continue;
      if (v.conn?.kind === "url" && v.kernelId) {
        try { await rest(v.conn, "GET", `/api/kernels/${v.kernelId}`, null, 8); continue; } catch { /* gone */ }
      }
      m[k] = { ...v, active: false, kernelId: null, stale: true };
    }
    updateSettings({ jupyterMap: m });
  },
  discard() {
    const m = { ...jmap() };
    for (const k of Object.keys(m)) m[k] = { ...m[k], active: false, kernelId: null };
    updateSettings({ jupyterMap: m });
  },
});
