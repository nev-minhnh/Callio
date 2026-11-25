// Work inside WSL2 and Docker (Settings → Environments, "Open WSL folder…", the "WSL · Ubuntu" chip,
// where Claude Code and the LaTeX tools run). A WSL project is simply a folder at
// `\\wsl.localhost\<distro>\…`, so the tree, tabs, history, search and compare need nothing special;
// this file adds the screens around that. The backend half is src-tauri/src/envs/. Loaded when needed
// (the always-loaded part is envs-core.js).
import "./envs.css";
import { call, api, listen } from "./api.js";
import { settings, updateSettings, toast, setFolder, expandedDirs, openFilePaths } from "./main.js";
import * as main from "./main.js";
import { addVi, t } from "./i18n.js";
import { ic } from "./icons.js";
import { wslParts, wslUnc, isWslPath, folderPref, bindEnvSettings } from "./envs-core.js";

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const norm = (p) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

addVi({
  "Environments": "Môi trường",
  "Environment": "Môi trường",
  "Windows, WSL distributions and Docker containers: where Callio can open projects, run Python and LaTeX, and work with Claude Code.": "Windows, bản phân phối WSL và container Docker: nơi Callio mở dự án, chạy Python, LaTeX và Claude Code.",
  "Refresh": "Làm mới",
  "Looking for environments…": "Đang tìm môi trường…",
  "This PC": "Máy này",
  "Callio itself runs here. Its Windows tools are used unless you pick another place.": "Callio chạy ở đây. Công cụ Windows được dùng trừ khi bạn chọn nơi khác.",
  "Running": "Đang chạy",
  "Stopped": "Đã dừng",
  "default": "mặc định",
  "Check": "Kiểm tra",
  "Checking…": "Đang kiểm tra…",
  "Start": "Khởi động",
  "Stop": "Dừng",
  "Starting…": "Đang khởi động…",
  "Open folder…": "Mở thư mục…",
  "Open WSL folder…": "Mở thư mục WSL…",
  "Open a folder in WSL or Docker": "Mở thư mục trong WSL hoặc Docker",
  "WSL distributions": "Bản phân phối WSL",
  "Docker containers (running)": "Container Docker (đang chạy)",
  "Starting {d}…": "Đang khởi động {d}…",
  "Open this folder": "Mở thư mục này",
  "Up": "Lên",
  "Home": "Thư mục nhà",
  "Go": "Đi",
  "Folder in the distribution": "Thư mục trong bản phân phối",
  "No sub-folders here.": "Không có thư mục con.",
  "Back": "Quay lại",
  "Callio reads and writes these files through Windows (\\\\wsl.localhost), so everything works as for any folder. Projects stored in the Linux file system are much faster than those under /mnt/c.": "Callio đọc và ghi các tệp này qua Windows (\\\\wsl.localhost), nên mọi tính năng hoạt động như với thư mục thường. Dự án nằm trong hệ thống tệp Linux nhanh hơn nhiều so với dự án trong /mnt/c.",
  "No WSL distribution found.": "Không tìm thấy bản phân phối WSL nào.",
  "No running container.": "Không có container nào đang chạy.",
  "Folders shared with Windows (bind mounts):": "Thư mục chia sẻ với Windows (bind mount):",
  "Not installed": "Chưa cài",
  "installed": "đã cài",
  "not found": "không thấy",
  "missing": "thiếu",
  "ok": "ổn",
  "Run LaTeX tools in": "Chạy công cụ LaTeX trong",
  "Run tools in": "Chạy công cụ trong",
  "Run Claude Code in": "Chạy Claude Code trong",
  "Windows": "Windows",
  "This folder": "Thư mục này",
  "Claude Code installed in {d}": "Claude Code đã cài trong {d}",
  "Claude Code isn't installed in {d}.": "Claude Code chưa được cài trong {d}.",
  "Install in {d}": "Cài trong {d}",
  "Installing…": "Đang cài…",
  "Sign in…": "Đăng nhập…",
  "Signed in": "Đã đăng nhập",
  "Not signed in": "Chưa đăng nhập",
  "Claude Code has its own sign-in inside the distribution (it does not share the Windows one).": "Claude Code có đăng nhập riêng trong bản phân phối (không dùng chung với Windows).",
  "Networking: mirrored — Claude Code in WSL reaches Callio on 127.0.0.1.": "Mạng: mirrored — Claude Code trong WSL kết nối tới Callio qua 127.0.0.1.",
  "Networking: NAT — Callio opens a private link on the WSL virtual network address so Claude Code in WSL can reach its tools (protected by a secret token).": "Mạng: NAT — Callio mở một cổng riêng trên địa chỉ mạng ảo của WSL để Claude Code trong WSL dùng được công cụ của Callio (có mã bí mật bảo vệ).",
  "Windows only keeps files under C:\\ available as /mnt/c in WSL; a Windows folder runs in WSL through that path.": "Thư mục Windows chạy trong WSL qua đường dẫn /mnt/c.",
  "The Docker engine is not running. Start Docker Desktop.": "Docker chưa chạy. Hãy mở Docker Desktop.",
  "Docker is not installed (the docker command was not found).": "Chưa cài Docker (không tìm thấy lệnh docker).",
  "No Linux distribution is installed. Install one with: wsl --install": "Chưa cài bản phân phối Linux nào. Cài bằng lệnh: wsl --install",
  "WSL exists on Windows only.": "WSL chỉ có trên Windows.",
  "Python 3": "Python 3",
  "Not shared with Windows: its files can't be edited here.": "Không chia sẻ với Windows: không sửa được tệp của nó ở đây.",
  "Ports": "Cổng",
  "Network": "Mạng",
  "Docker context": "Ngữ cảnh Docker",
});

// ---------------- the list ----------------
let data = null;
export async function loadEnvs(force) {
  data = await call("envs_list", { refresh: !!force });
  return data;
}
const cached = () => data;
export const wslDistros = () => (data?.envs || []).filter((e) => e.kind === "wsl");

// ---------------- the status chip, the tools select, polling ----------------
let chip = null, toolsSel = null, pollTimer = null, lastPoll = "";

function setPref(patch) {
  const f = main.folder;
  if (!f) return;
  const prefs = { ...(settings.envFolderPrefs || {}) };
  const k = norm(f);
  prefs[k] = { ...(prefs[k] || {}), ...patch };
  updateSettings({ envFolderPrefs: prefs });
  updateToolsSelect();
}

function updateChip() {
  if (!chip) return;
  const w = wslParts(main.folder);
  chip.hidden = !w;
  if (w) {
    chip.textContent = `WSL · ${w.distro}`;
    chip.title = `${w.distro}:${w.linux}`;
  }
}

function updateToolsSelect() {
  if (!toolsSel) return;
  const w = wslParts(main.folder);
  toolsSel.hidden = !w || settings.engine === "overleaf";
  if (!w) return;
  toolsSel.innerHTML = `<option value="windows">Windows</option><option value="wsl">WSL</option>`;
  toolsSel.title = `${t("Run LaTeX tools in")}: ${folderPref(main.folder).tools === "wsl" ? `WSL · ${w.distro}` : "Windows"}`;
  toolsSel.value = folderPref(main.folder).tools === "wsl" ? "wsl" : "windows";
}

async function feedPoll() {
  if (!isWslPath(main.folder)) return;
  const dirs = [main.folder, ...expandedDirs()].slice(0, 60);
  const files = openFilePaths().filter(isWslPath).slice(0, 60);
  const sig = JSON.stringify([dirs, files]);
  if (sig === lastPoll) return;
  lastPoll = sig;
  call("envs_poll_set", { dirs, files }).catch(() => {});
}

function onFolder() {
  lastPoll = "";
  updateChip();
  updateToolsSelect();
  const wsl = isWslPath(main.folder);
  if (wsl && !pollTimer) pollTimer = setInterval(feedPoll, 2000);
  if (!wsl && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (wsl) feedPoll();
}

/** Called once from main.js at start: the chip, the "run tools in" choice, and the poll feeder. */
export function initEnvs() {
  bindEnvSettings(() => settings);
  chip = $("#st-env");
  if (chip) chip.onclick = () => import("./settings.js").then((m) => m.openSettings("environments"));
  const eng = $("#sel-engine");
  if (eng && !$("#sel-tools-in")) {
    toolsSel = document.createElement("select");
    toolsSel.id = "sel-tools-in";
    toolsSel.hidden = true;
    toolsSel.title = t("Run LaTeX tools in");
    toolsSel.onchange = () => setPref({ tools: toolsSel.value });
    eng.after(toolsSel);
  }
  window.addEventListener("callio-folder", onFolder);
  $("#w-wsl")?.addEventListener("click", () => openWslFolder());
  onFolder();
}

// ---------------- "Open WSL folder…" ----------------
const joinL = (a, b) => (a === "/" ? "" : a.replace(/\/+$/, "")) + "/" + b;
const upL = (p) => { const s = p.replace(/\/+$/, ""); const i = s.lastIndexOf("/"); return i <= 0 ? "/" : s.slice(0, i); };

export async function openWslFolder(pre) {
  const d = document.createElement("dialog");
  d.className = "env-dlg";
  d.innerHTML = `<form method="dialog"><h3>Open a folder in WSL or Docker</h3><div class="env-body"></div>
    <div class="env-btns"><button type="button" data-x="back" hidden>Back</button><span class="tb-spacer"></span><button type="button" data-x="cancel">Cancel</button><button type="button" class="primary" data-x="open" disabled>Open this folder</button></div></form>`;
  document.body.appendChild(d);
  const body = $(".env-body", d), btnOpen = $("[data-x=open]", d), btnBack = $("[data-x=back]", d);
  let target = null; // what "Open this folder" opens
  const choose = (p) => { target = p; btnOpen.disabled = !p; };
  const close = () => { d.close(); d.remove(); };
  $("[data-x=cancel]", d).onclick = close;
  d.addEventListener("cancel", () => setTimeout(() => d.remove(), 0));
  btnOpen.onclick = () => { if (!target) return; const p = target; close(); setFolder(p); settings.sidebar || updateSettings({ sidebar: true }); };
  btnBack.onclick = () => showPick();

  async function showPick() {
    btnBack.hidden = true; choose(null);
    body.innerHTML = `<p class="note">Looking for environments…</p>`;
    let l;
    try { l = await loadEnvs(false); } catch (e) { body.innerHTML = ""; body.append(Object.assign(document.createElement("p"), { className: "note err", textContent: e.message || String(e) })); return; }
    const wsl = l.envs.filter((e) => e.kind === "wsl"), dk = l.envs.filter((e) => e.kind === "docker");
    body.innerHTML = `<h4>WSL distributions</h4><div class="env-pick env-wsl"></div><h4>Docker containers (running)</h4><div class="env-pick env-dk"></div>`;
    const wb = $(".env-wsl", body), db = $(".env-dk", body);
    if (!wsl.length) wb.innerHTML = `<p class="note">${esc(t(l.wsl?.error || "No WSL distribution found."))}</p>`;
    for (const e of wsl) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "env-row";
      b.innerHTML = `<span class="env-dot ${e.running ? "on" : "off"}"></span><span class="env-n"></span><small>${esc(e.running ? t("Running") : t("Stopped"))} · WSL ${e.version}</small>`;
      $(".env-n", b).textContent = e.distro;
      b.onclick = () => browseDistro(e.distro);
      wb.appendChild(b);
    }
    if (!dk.length) db.innerHTML = `<p class="note">${esc(t(l.docker?.error || "No running container."))}</p>`;
    for (const e of dk) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "env-row";
      b.innerHTML = `<span class="env-dot on"></span><span class="env-n"></span><small></small>`;
      $(".env-n", b).textContent = e.container;
      $("small", b).textContent = e.image || "";
      b.onclick = () => showDocker(e);
      db.appendChild(b);
    }
    if (pre) { const p = pre; pre = null; if (p.distro) browseDistro(p.distro); }
  }

  async function browseDistro(distro) {
    btnBack.hidden = false; choose(null);
    body.innerHTML = `<p class="note">${esc(t("Starting {d}…").replace("{d}", distro))}</p>`;
    let info;
    try { info = await call("envs_wsl_info", { distro }); } catch (e) { body.innerHTML = ""; body.append(Object.assign(document.createElement("p"), { className: "note err", textContent: e.message || String(e) })); return; }
    body.innerHTML = `<div class="env-bar"><button type="button" class="small" data-b="up" title="Up">${ic("arrow-up")}</button><button type="button" class="small" data-b="home">Home</button>
      <input class="env-path" type="text" aria-label="Folder in the distribution" spellcheck="false" autocomplete="off" data-noi18n><button type="button" class="small" data-b="go">Go</button></div>
      <div class="env-list" role="listbox"></div><p class="note env-hint">Callio reads and writes these files through Windows (\\\\wsl.localhost), so everything works as for any folder. Projects stored in the Linux file system are much faster than those under /mnt/c.</p>`;
    const input = $(".env-path", body), list = $(".env-list", body);
    let cur = "/";
    const go = async (p) => {
      p = ("/" + String(p || "/").split("/").filter(Boolean).join("/"));
      const unc = wslUnc(distro, p);
      list.innerHTML = `<p class="note">…</p>`;
      let items;
      try { items = await api.listDir(unc); } catch (e) { list.innerHTML = ""; list.append(Object.assign(document.createElement("p"), { className: "note err", textContent: String(e.message || e) })); return; }
      cur = p; input.value = p; choose(unc);
      const dirs = items.filter((i) => i.isDir).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      list.innerHTML = dirs.length ? "" : `<p class="note">No sub-folders here.</p>`;
      for (const it of dirs) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "env-row"; b.setAttribute("role", "option");
        b.innerHTML = `${ic("folder")}<span class="env-n"></span>`;
        $(".env-n", b).textContent = it.name;
        b.onclick = () => go(joinL(cur, it.name));
        list.appendChild(b);
      }
    };
    body.onclick = (e) => {
      const b = e.target.closest("[data-b]");
      if (!b) return;
      if (b.dataset.b === "up") go(upL(cur));
      else if (b.dataset.b === "home") go(info.home);
      else if (b.dataset.b === "go") go(input.value);
    };
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); go(input.value); } };
    go(info.home);
  }

  async function showDocker(e) {
    btnBack.hidden = false; choose(null);
    body.innerHTML = `<p class="note">…</p>`;
    let info;
    try { info = await call("envs_docker_info", { container: e.container }); } catch (er) { body.innerHTML = ""; body.append(Object.assign(document.createElement("p"), { className: "note err", textContent: er.message || String(er) })); return; }
    const mounts = (info.mounts || []).filter((m) => m.host);
    body.innerHTML = mounts.length ? `<p class="note">Folders shared with Windows (bind mounts):</p><div class="env-list"></div>` : `<p class="note"></p>`;
    if (!mounts.length) { $(".note", body).textContent = t("Not shared with Windows: its files can't be edited here.") + " " + (info.note || ""); return; }
    const list = $(".env-list", body);
    for (const m of mounts) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "env-row";
      b.innerHTML = `${ic("folder")}<span class="env-n"></span><small></small>`;
      $(".env-n", b).textContent = m.host;
      $("small", b).textContent = `${e.container}:${m.inside}`;
      b.onclick = () => { for (const x of list.children) x.classList.toggle("cur", x === b); choose(m.host); };
      list.appendChild(b);
    }
  }

  d.showModal();
  showPick();
}

// ---------------- Settings → Environments ----------------
const TOOL_ROWS = [["python3", "Python 3"], ["jupyterServer", "jupyter_server"], ["ipykernel", "ipykernel"], ["claude", "Claude Code"], ["latexmk", "latexmk"]];

function toolsHtml(p) {
  return TOOL_ROWS.map(([k, label]) => {
    const v = p[k];
    const ok = typeof v === "string" ? !!v : !!v;
    return `<div class="env-tool ${ok ? "ok" : "no"}"><span class="env-tick">${ic(ok ? "check" : "minus")}</span><span>${esc(label)}</span><small>${typeof v === "string" && v ? esc(v) : ok ? esc(t("ok")) : esc(t("not found"))}</small></div>`;
  }).join("");
}

function card(e) {
  const wsl = e.kind === "wsl", dk = e.kind === "docker", win = e.kind === "windows";
  const el = document.createElement("div");
  el.className = "env-card";
  el.dataset.id = e.id;
  const tags = wsl ? `<span class="env-tag">WSL ${e.version}</span>${e.default ? `<span class="env-tag">${esc(t("default"))}</span>` : ""}` : dk ? `<span class="env-tag">Docker</span>` : "";
  const state = win ? "" : wsl ? (e.running ? t("Running") : t("Stopped")) : e.status || t("Running");
  const on = win || (wsl ? e.running : true);
  el.innerHTML = `<div class="env-top"><span class="env-dot ${on ? "on" : "off"}"></span><b class="env-name"></b>${tags}<span class="env-state">${esc(state)}</span><span class="tb-spacer"></span>
      ${win ? "" : `<button type="button" class="small" data-a="check">Check</button>`}
      ${wsl ? `<button type="button" class="small" data-a="toggle">${e.running ? "Stop" : "Start"}</button>` : ""}
      ${win ? "" : `<button type="button" class="small" data-a="open">Open folder…</button>`}</div>
    <div class="env-sub"></div><div class="env-tools" hidden></div>`;
  $(".env-name", el).textContent = win ? t("This PC") : wsl ? e.distro : e.container;
  $(".env-sub", el).textContent = win ? t("Callio itself runs here. Its Windows tools are used unless you pick another place.") : wsl ? [e.user, e.home].filter(Boolean).join(" · ") : [e.image, e.ports?.length ? `${t("Ports")}: ${e.ports.map((p) => p[0] + "→" + p[1]).join(", ")}` : ""].filter(Boolean).join(" · ");
  return el;
}

export async function renderEnvSettings(box) {
  if (!box) return;
  box.innerHTML = `<div class="sg"><h3 class="set-h sg-h">Environments</h3><p class="note">Windows, WSL distributions and Docker containers: where Callio can open projects, run Python and LaTeX, and work with Claude Code.</p>
    <div class="env-actions"><button type="button" class="small" data-a="refresh">${ic("refresh")}<span>Refresh</span></button></div><div class="env-cards"><p class="note">Looking for environments…</p></div><div class="env-msgs"></div></div><div class="env-here"></div>`;
  const cards = $(".env-cards", box), msgs = $(".env-msgs", box);
  async function fill(force) {
    let l;
    try { l = await loadEnvs(force); } catch (e) { cards.innerHTML = ""; cards.append(Object.assign(document.createElement("p"), { className: "note err", textContent: e.message || String(e) })); return; }
    cards.innerHTML = "";
    for (const e of l.envs) cards.appendChild(card(e));
    msgs.innerHTML = "";
    for (const [k, v] of [["wsl", l.wsl], ["docker", l.docker]]) {
      if (v?.error) msgs.append(Object.assign(document.createElement("p"), { className: "note", textContent: t(v.error) }));
      else if (k === "docker" && v?.context) msgs.append(Object.assign(document.createElement("p"), { className: "note", textContent: `${t("Docker context")}: ${v.context}` }));
    }
    paintHere($(".env-here", box));
  }
  box.onclick = async (ev) => {
    const b = ev.target.closest("[data-a]");
    if (!b) return;
    const a = b.dataset.a;
    if (a === "refresh") { cards.innerHTML = `<p class="note">Looking for environments…</p>`; return fill(true); }
    const c = b.closest(".env-card");
    const env = c && (data?.envs || []).find((x) => x.id === c.dataset.id);
    if (!env) return;
    if (a === "toggle") {
      b.disabled = true; b.textContent = t("Starting…");
      try { await call(env.running ? "envs_wsl_stop" : "envs_wsl_start", { distro: env.distro }); } catch (e) { toast(e.message || String(e), "err", 6000); }
      return fill(true);
    }
    if (a === "open") return openWslFolder(env.kind === "wsl" ? { distro: env.distro } : undefined);
    if (a === "check") {
      b.disabled = true; const was = b.textContent; b.textContent = t("Checking…");
      const tools = $(".env-tools", c);
      try {
        const p = await call("envs_probe", { env });
        let extra = "";
        if (env.kind === "docker") {
          const i = await call("envs_docker_info", { container: env.container }).catch(() => null);
          if (i) extra = `<div class="env-note note">${i.mounts?.length ? esc(t("Folders shared with Windows (bind mounts):")) + " " + i.mounts.map((m) => esc((m.host || "?") + " ← " + m.inside)).join(", ") : esc(t("Not shared with Windows: its files can't be edited here."))}</div>`;
        }
        tools.innerHTML = toolsHtml(p) + extra;
      } catch (e) { tools.innerHTML = ""; tools.append(Object.assign(document.createElement("p"), { className: "note err", textContent: e.message || String(e) })); }
      tools.hidden = false; b.disabled = false; b.textContent = was;
    }
  };
  await fill(false);
}

// "This folder": the choices for a folder that lives in WSL
function prefSelect(key, label, opts, value) {
  return `<label>${esc(label)} <select data-pref="${key}">${opts.map(([v, l]) => `<option value="${esc(v)}"${v === value ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
}
function hereHtml() {
  const w = wslParts(main.folder);
  if (!w) return "";
  const pref = folderPref(main.folder);
  const opts = [["windows", "Windows"], ["wsl", `WSL (${w.distro})`]];
  return `<div class="sg"><h3 class="set-h sg-h"></h3>${prefSelect("tools", t("Run LaTeX tools in"), opts, pref.tools === "wsl" ? "wsl" : "windows")}${prefSelect("cc", t("Run Claude Code in"), opts, pref.cc === "windows" ? "windows" : "wsl")}</div>`;
}
function paintHere(box) {
  if (!box) return;
  box.innerHTML = hereHtml();
  const h = $(".set-h", box);
  if (h) h.textContent = `${t("This folder")} — WSL · ${wslParts(main.folder).distro}`;
  box.onchange = (e) => {
    const s = e.target.closest("[data-pref]");
    if (s) setPref({ [s.dataset.pref]: s.value });
  };
}

// ---------------- Claude Code: where it runs (the provider card) ----------------
export async function renderCCEnv(box) {
  if (!box || !box.isConnected) return;
  const holder = document.createElement("div");
  holder.className = "env-cc";
  box.appendChild(holder);
  let l = cached();
  if (!l) { try { l = await loadEnvs(false); } catch { l = { envs: [] }; } }
  const wsl = l.envs.filter((e) => e.kind === "wsl");
  const opts = [["windows", "Windows"], ...wsl.map((e) => [`wsl:${e.distro}`, `WSL (${e.distro})`])];
  const cur = typeof settings.ccRunIn === "string" && opts.some((o) => o[0] === settings.ccRunIn) ? settings.ccRunIn : "windows";
  holder.innerHTML = `${prefSelect("ccRunIn", t("Run Claude Code in"), opts, cur)}<div class="cc-status env-ccst" hidden></div><pre class="cc-log" hidden></pre><div class="env-here"></div>`;
  const sel = $("select", holder), st = $(".env-ccst", holder), log = $(".cc-log", holder);
  async function status() {
    const v = sel.value;
    st.hidden = !v.startsWith("wsl:");
    if (st.hidden) return;
    const distro = v.slice(4);
    st.className = "cc-status env-ccst";
    st.innerHTML = `<span>…</span>`;
    let s;
    try { s = await call("envs_cc_status", { distro }); } catch (e) { st.innerHTML = ""; st.append(Object.assign(document.createElement("span"), { textContent: e.message || String(e) })); return; }
    if (!s.installed) {
      st.innerHTML = `<span></span><button type="button" class="primary small" data-a="install"></button>`;
      $("span", st).textContent = t("Claude Code isn't installed in {d}.").replace("{d}", distro);
      $("button", st).textContent = t("Install in {d}").replace("{d}", distro);
      $("button", st).onclick = () => install(distro);
    } else {
      st.classList.toggle("ok", !!s.loggedIn);
      st.innerHTML = `<span></span>${s.loggedIn ? "" : `<button type="button" class="primary small" data-a="login"></button>`}<button type="button" class="small" data-a="again"></button>`;
      $("span", st).textContent = `${t("Claude Code installed in {d}").replace("{d}", distro)} — ${s.version || ""} — ${s.loggedIn ? t("Signed in") : t("Not signed in")}`;
      const lb = $("[data-a=login]", st); if (lb) { lb.textContent = t("Sign in…"); lb.onclick = () => call("envs_cc_login", { distro }).catch((e) => toast(e.message, "err")); }
      const ab = $("[data-a=again]", st); ab.textContent = t("Refresh"); ab.onclick = status;
    }
    const net = l.networking === "mirrored" ? "Networking: mirrored — Claude Code in WSL reaches Callio on 127.0.0.1." : "Networking: NAT — Callio opens a private link on the WSL virtual network address so Claude Code in WSL can reach its tools (protected by a secret token).";
    st.append(Object.assign(document.createElement("small"), { className: "env-note", textContent: `${t(net)} ${t("Claude Code has its own sign-in inside the distribution (it does not share the Windows one).")}` }));
  }
  async function install(distro) {
    const b = $("[data-a=install]", st);
    if (b) { b.disabled = true; b.textContent = t("Installing…"); }
    log.hidden = false; log.textContent = "";
    const off = await listen("env-install", (e) => {
      if (e.distro !== distro) return;
      if (e.line != null) { log.textContent += e.line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "") + "\n"; log.scrollTop = log.scrollHeight; }
      if (e.done) { off?.(); status(); }
    });
    call("envs_install_claude", { distro }).catch((e) => { log.textContent += (e.message || String(e)) + "\n"; off?.(); status(); });
  }
  holder.addEventListener("change", (e) => {
    const s = e.target.closest("[data-pref=ccRunIn]");
    if (s) { updateSettings({ ccRunIn: s.value }); status(); }
  });
  paintHere($(".env-here", holder));
  status();
}

/** For tests and other modules. */
export const _test = { wslParts, wslUnc };
