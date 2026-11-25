// Dev-only: the envs_* commands for the browser. Two WSL distros (Ubuntu running and the default,
// Ubuntu-22.04 stopped), a Docker engine with two containers, and a "WSL file system" that is really
// /root/specs/samples/tree (override with window.__wslRoot) so the folder flow, tree, tabs and
// saving can be tried. Every call that matters is appended to window.__envCalls for the tests.
import { mockEmit } from "../mock.js";

const norm = (p) => String(p || "").replace(/\\/g, "/");
const UNC = /^\/\/wsl(?:\.localhost|\$)\/([^/]+)(\/.*)?$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (cmd, a) => (window.__envCalls ||= []).push({ cmd, ...a });

const state = {
  running: { Ubuntu: true, "Ubuntu-22.04": false },
  claude: { Ubuntu: false, "Ubuntu-22.04": false },
};
const root = () => window.__wslRoot || "/root/specs/samples/tree";
const PROJ = "/home/minh/proj";

/** `\\wsl.localhost\Ubuntu\home\minh\proj\x` → the real file under the sample tree (null: not in the project). */
function real(p) {
  const m = UNC.exec(norm(p));
  if (!m) return null;
  const lin = m[2] || "/";
  if (lin === PROJ || lin.startsWith(PROJ + "/")) return root() + lin.slice(PROJ.length);
  return null;
}
const synthetic = {
  "/": ["home", "etc", "tmp", "usr", "var"],
  "/home": ["minh"],
  "/home/minh": ["proj", "notes", "papers"],
  "/home/minh/notes": ["2026"],
  "/home/minh/papers": [],
};
const unc = (d, lin) => `\\\\wsl.localhost\\${d}${lin.replace(/\//g, "\\")}`;

export async function handle(cmd, a) {
  switch (cmd) {
    case "envs_list": {
      log(cmd, a);
      if (window.__envsData) return window.__envsData;
      const envs = [{ id: "windows", kind: "windows", name: "Windows" }];
      for (const [d, v, def] of [["Ubuntu", 2, true], ["Ubuntu-22.04", 2, false]]) {
        const r = !!state.running[d];
        envs.push({ id: `wsl:${d}`, kind: "wsl", name: `WSL · ${d}`, distro: d, state: r ? "Running" : "Stopped", running: r, version: v, default: def, home: state.home?.[d] || null, user: state.home?.[d] ? "minh" : null });
      }
      envs.push({ id: "docker:dev-py", kind: "docker", name: "Docker · dev-py", container: "dev-py", image: "python:3.12", status: "Up 2 hours", containerId: "3f2a1b", ports: [[8888, 8888]] });
      envs.push({ id: "docker:scratch", kind: "docker", name: "Docker · scratch", container: "scratch", image: "ubuntu:24.04", status: "Up 5 minutes", containerId: "9c8d7e", ports: [] });
      return { envs, wsl: { available: true, error: null }, docker: { available: true, error: null, context: "desktop-linux" }, networking: window.__wslNet || "nat" };
    }
    case "envs_wsl_info": case "envs_wsl_start": {
      log(cmd, a);
      if (window.__wslFail) throw new Error(window.__wslFail);
      await sleep(250);
      state.running[a.distro] = true;
      (state.home ||= {})[a.distro] = "/home/minh";
      return { home: "/home/minh", user: "minh", homeWin: unc(a.distro, "/home/minh") };
    }
    case "envs_wsl_stop": log(cmd, a); state.running[a.distro] = false; return null;
    case "envs_probe": {
      log(cmd, a);
      await sleep(150);
      if (a.env.distro === "Ubuntu-22.04") return { python3: "/usr/bin/python3", jupyterServer: false, ipykernel: false, claude: null, latexmk: null };
      if (a.env.kind === "docker") return { python3: "/usr/local/bin/python3", jupyterServer: true, ipykernel: true, claude: null, latexmk: null };
      return { python3: "/usr/bin/python3", jupyterServer: true, ipykernel: true, claude: state.claude.Ubuntu ? "/home/minh/.local/bin/claude" : null, latexmk: "/usr/bin/latexmk", claudeVersion: "2.1.326 (Claude Code)" };
    }
    case "envs_docker_info": {
      log(cmd, a);
      if (a.container === "scratch") return { mounts: [], workdir: "/", user: "", ports: [], running: true, note: "No folder of this container is shared with Windows, so its files can't be edited here. Start it with a bind mount (-v C:\\folder:/workspace)." };
      return { mounts: [{ inside: "/workspace", host: "C:\\Users\\me\\proj" }], workdir: "/workspace", user: "vscode", ports: [[8888, 8888]], running: true, note: "" };
    }
    case "envs_cc_status": {
      log(cmd, a);
      return state.claude[a.distro] ? { installed: true, version: "2.1.326 (Claude Code)", loggedIn: !!window.__wslLoggedIn } : { installed: false };
    }
    case "envs_install_claude": {
      log(cmd, a);
      for (const line of ["Setting up Claude Code…", "Downloading from claude.ai", "✔ Claude Code installed in ~/.local/bin/claude"]) { mockEmit("env-install", { distro: a.distro, line }); await sleep(120); }
      state.claude[a.distro] = true;
      mockEmit("env-install", { distro: a.distro, done: true, code: 0 });
      return 0;
    }
    case "envs_cc_login": log(cmd, a); return null;
    case "envs_poll_set": (window.__pollSets ||= []).push(a); return null;
    case "envs_jp_interpreters": {
      log(cmd, a);
      await sleep(120);
      if (a.env.kind === "docker") return [{ path: "/usr/local/bin/python3", label: "Python 3.12 (PATH)", version: "3.12.4", source: "path", hasServer: true, hasKernel: true, missing: [] }];
      return [
        { path: "/home/minh/proj/.venv/bin/python", label: "Python 3.12 (.venv)", version: "3.12.3", source: "venv", hasServer: true, hasKernel: true, missing: [] },
        { path: "/usr/bin/python3", label: "Python 3.12 (system)", version: "3.12.3", source: "path", hasServer: false, hasKernel: false, missing: ["jupyter_server", "ipykernel"] },
      ];
    }
    case "envs_jp_start": {
      log(cmd, a);
      const srv = window.__jpServer || { url: "http://127.0.0.1:8891/", token: "testtoken123" };
      const id = `${a.env.kind}-mock`;
      const { api } = await import("../api.js");
      await api.setSecret(`callio-jupyter-${id}`, srv.token);
      return { id, kind: a.env.kind, baseUrl: srv.url, root: "/", kernelPath: "home/minh/proj", python: a.python };
    }
    case "envs_jp_stop": log(cmd, a); return null;
    case "envs_jp_list": return [];
    case "envs_jp_install": case "envs_jp_venv": {
      log(cmd, a);
      for (const l of ["Collecting jupyter_server", "Successfully installed jupyter_server ipykernel"]) { mockEmit("jp-log", { id: a.id, line: l }); await sleep(60); }
      mockEmit("jp-log", { id: a.id, done: true, code: 0 });
      return 0;
    }
    case "find_root": return UNC.test(norm(a.path)) ? a.path : undefined; // a file in the distro is its own root
    case "compile": {
      log(cmd, a);
      // a project in the distro compiles "successfully" (the PDF lands next to the sources), so the UI flow can be followed
      if (!UNC.test(norm(a.root))) return undefined;
      return { ok: true, pdf: a.root.replace(/\.tex$/i, ".pdf"), engine: a.toolsIn ? "latexmk (Ubuntu)" : a.engine || "tectonic", durationMs: 700, log: "", diagnostics: [], updated: [] };
    }
    case "cc_session_start": log(cmd, { runIn: a.req?.runIn, cwd: a.req?.cwd }); return undefined;
    // ---- files of the "WSL file system"
    case "list_dir": case "path_info": case "read_text": case "write_text": case "file_mtime": {
      const m = UNC.exec(norm(a.path));
      if (!m) return undefined;
      const lin = (m[2] || "/").replace(/\/+$/, "") || "/";
      const r = real(a.path);
      const mock = await import("../mock.js");
      if (r) {
        const res = await mock.invoke(cmd, { ...a, path: r });
        if (cmd === "list_dir" && Array.isArray(res)) return res.map((e) => ({ ...e, path: unc(m[1], lin === "/" ? "/" + e.name : lin + "/" + e.name) }));
        return res;
      }
      if (cmd === "list_dir") {
        if (!(lin in synthetic)) throw new Error("The system cannot find the path specified.");
        return synthetic[lin].map((n) => ({ name: n, path: unc(m[1], (lin === "/" ? "" : lin) + "/" + n), isDir: true })).concat(lin === "/home/minh" ? [{ name: ".bashrc", path: unc(m[1], "/home/minh/.bashrc"), isDir: false }] : []);
      }
      return undefined;
    }
    default: return undefined;
  }
}
