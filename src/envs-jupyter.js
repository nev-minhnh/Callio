// Notebook kernels inside WSL distros and Docker containers: the "WSL · Ubuntu" / "Docker · name"
// groups of the kernel picker (jupyter.js calls mountEnvGroups) and the default for a notebook that
// lives in a distro. The backend (src-tauri/src/envs/jupyter.rs) starts `python -m jupyter_server`
// INSIDE the environment; the one Jupyter client then talks to it on localhost.
// Stopped distros are not started just by opening the picker: a button looks for Python there.
import { call, listen } from "./api.js";
import { addVi } from "./i18n.js";
import { loadEnvs } from "./envs.js";
import { wslParts } from "./envs-core.js";

addVi({
  "Look for Python": "Tìm Python",
  "Stopped — starting it takes a few seconds": "Đã dừng — khởi động mất vài giây",
  "Needs a published port (docker run -p 8888:8888): Callio reaches Jupyter through it.": "Cần một cổng được công bố (docker run -p 8888:8888): Callio kết nối tới Jupyter qua cổng đó.",
  "Not shared with Windows, so notebooks there can't be edited.": "Không chia sẻ với Windows nên không sửa được notebook ở đó.",
  "Use a .venv here": "Dùng .venv ở thư mục này",
  "No Python with Jupyter found here.": "Không thấy Python có Jupyter ở đây.",
  "Looking…": "Đang tìm…",
});

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const uid = () => (crypto.randomUUID?.() || Math.random().toString(16).slice(2)).replace(/-/g, "").slice(0, 8);
const envRef = (e) => ({ id: e.id, kind: e.kind, name: e.name, distro: e.distro || null, container: e.container || null, user: e.user || null, home: e.home || null });
const choiceOf = (e, i, host, spec) => ({ kind: e.kind, env: envRef(e), python: i.path, spec: spec || host.nb?.metadata?.kernelspec?.name || "python3", label: `${i.label} · ${e.kind === "wsl" ? "WSL " + e.distro : "Docker " + e.container}` });

/** Pythons of one environment for the notebook's folder. */
const pythons = (e, host) => call("envs_jp_interpreters", { env: envRef(e), dir: host.dir || "" });

function pyRow(e, i, cur) {
  const ok = i.hasServer && i.hasKernel;
  if (ok) return `<button class="jp-row${cur ? " cur" : ""}" data-ea="py" data-env="${esc(e.id)}" data-path="${esc(i.path)}" title="${esc(i.path)}"><span class="jp-dot none"></span><span class="jp-rn">${esc(i.label)}</span><small>${esc(i.path)}</small></button>`;
  return `<div class="jp-row bad"><span class="jp-dot none"></span><span class="jp-rn">${esc(i.label)}</span><span class="jp-miss"><span>missing</span> <code>${esc(i.missing.join(", "))}</code></span><button class="small" data-ea="install" data-env="${esc(e.id)}" data-path="${esc(i.path)}">Install packages</button>${i.source === "path" ? `<button class="small" data-ea="venv" data-env="${esc(e.id)}">Use a .venv here</button>` : ""}</div>`;
}

async function fillGroup(host, box, e, choice, list) {
  box.innerHTML = `<div class="jp-note">Looking…</div>`;
  try {
    const l = await pythons(e, host);
    list.set(e.id, l);
    const cur = choice && choice.env?.id === e.id ? choice.python : null;
    box.innerHTML = l.length ? l.map((i) => pyRow(e, i, i.path === cur)).join("") : `<div class="jp-note">No Python with Jupyter found here.</div>`;
  } catch (er) { box.innerHTML = ""; box.append(Object.assign(document.createElement("div"), { className: "jp-note err", textContent: er.message || String(er) })); }
}

/** Fill the `.jp-envs` placeholder of the picker. `current` is the notebook's present choice (or null). */
export async function mountEnvGroups(host, p, finish, current) {
  const root = p.querySelector(".jp-envs");
  if (!root) return;
  let l;
  try { l = await loadEnvs(false); } catch { return; }
  if (!p.isConnected) return;
  const lists = new Map();
  const wsl = l.envs.filter((e) => e.kind === "wsl"), dk = l.envs.filter((e) => e.kind === "docker");
  // a notebook inside a distro: that distro first
  const here = wslParts(host.dir)?.distro;
  wsl.sort((a, b) => (a.distro === here ? -1 : b.distro === here ? 1 : 0));
  let html = "";
  for (const e of wsl) html += `<h4>WSL · ${esc(e.distro)}</h4><div class="jp-eg" data-env="${esc(e.id)}">${e.running ? `<div class="jp-note">Looking…</div>` : `<div class="jp-row" ><span class="jp-dot none"></span><span class="jp-rn">Stopped — starting it takes a few seconds</span><button class="small" data-ea="scan" data-env="${esc(e.id)}">Look for Python</button></div>`}</div>`;
  for (const e of dk) html += `<h4>Docker · ${esc(e.container)}</h4><div class="jp-eg" data-env="${esc(e.id)}">${e.ports?.length ? `<div class="jp-note">Looking…</div>` : `<div class="jp-note">Needs a published port (docker run -p 8888:8888): Callio reaches Jupyter through it.</div>`}</div>`;
  root.innerHTML = html;
  const byId = (id) => l.envs.find((x) => x.id === id);
  const groupBox = (id) => [...root.querySelectorAll(".jp-eg")].find((x) => x.dataset.env === id);
  for (const e of l.envs.filter((x) => (x.kind === "wsl" && x.running) || (x.kind === "docker" && x.ports?.length)).slice(0, 8)) fillGroup(host, groupBox(e.id), e, current, lists);

  root.onclick = async (ev) => {
    const b = ev.target.closest("[data-ea]");
    if (!b) return;
    const e = byId(b.dataset.env);
    if (!e) return;
    const a = b.dataset.ea;
    if (a === "scan") return fillGroup(host, groupBox(e.id), e, current, lists);
    if (a === "py") {
      const i = (lists.get(e.id) || []).find((x) => x.path === b.dataset.path);
      return finish(choiceOf(e, i || { path: b.dataset.path, label: "Python" }, host));
    }
    if (a === "install" || a === "venv") return setup(host, root, groupBox(e.id), e, a === "install" ? b.dataset.path : null, b, () => fillGroup(host, groupBox(e.id), e, current, lists));
  };
}

/** pip install into a Python of the environment, or create a .venv in the notebook's folder; the log shows under the row. */
async function setup(host, root, box, e, python, btn, after) {
  const id = "pip" + uid();
  const log = document.createElement("div");
  log.className = "jp-logbox";
  log.innerHTML = `<div class="jp-logh"><b>Installing…</b><code></code></div><pre class="jp-log" tabindex="0"></pre><button class="small" data-x="close">Close</button>`;
  log.querySelector("code").textContent = python ? `${python} -m pip install jupyter_server ipykernel` : "python3 -m venv .venv && .venv/bin/python -m pip install jupyter_server ipykernel";
  (btn.closest(".jp-row") || box).after(log);
  const pre = log.querySelector("pre");
  let hint = false;
  const off = await listen("jp-log", (ev) => {
    if (ev.id !== id) return;
    if (ev.line != null) {
      pre.textContent += ev.line + "\n"; pre.scrollTop = pre.scrollHeight;
      if (/externally-managed-environment/.test(ev.line)) hint = true;
    }
    if (ev.done) {
      off?.();
      log.querySelector("b").textContent = ev.code === 0 ? "Done" : `Failed (exit code ${ev.code})`;
      if (ev.code !== 0 && hint) pre.textContent += "\nThis Python is managed by the system. Use “Use a .venv here” instead.\n";
      if (ev.code === 0) setTimeout(after, 600);
    }
  });
  log.querySelector("[data-x=close]").onclick = () => log.remove();
  const run = python ? call("envs_jp_install", { env: envRef(e), python, id }) : call("envs_jp_venv", { env: envRef(e), dir: host.dir || "", id });
  run.catch((er) => { pre.textContent += String(er.message || er) + "\n"; off?.(); });
}

/** The choice for a notebook in a distro: its .venv / first Python that already has Jupyter; null when none. */
export async function defaultEnvChoice(host, settings) {
  const w = wslParts(host.dir);
  if (!w) return null;
  const l = await loadEnvs(false);
  const e = l.envs.find((x) => x.kind === "wsl" && x.distro.toLowerCase() === w.distro.toLowerCase());
  if (!e) return null;
  const list = await pythons(e, host);
  const usable = list.filter((i) => i.hasServer && i.hasKernel);
  const want = settings?.jupyterDefaultPython;
  const pick = (want && usable.find((i) => i.path === want)) || usable[0];
  return pick ? choiceOf(e, pick, host) : null;
}

