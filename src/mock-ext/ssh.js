// Dev-only: the ssh_* commands for the browser. No network here: the "servers" are a few fake ones and
// the sync status is a scripted scenario (one conflict, one pending upload and download, one big file
// that is not synced). Tests drive it with window.__ssh* hooks and read window.__sshLog (every command).
import { mockEmit } from "../mock.js";

const CONFIG_HOSTS = [
  { id: "gpu-box", name: "gpu-box", host: "gpu.lab.example.org", port: 22, user: "minh", auth: "auto", identityFiles: ["C:/Users/me/.ssh/id_ed25519"], identitiesOnly: false, proxyJump: "", needsVpn: false, remember: false, source: "config" },
  { id: "campus-hpc", name: "campus-hpc", host: "hpc.campus.example.edu", port: 2222, user: "mnguyen", auth: "auto", identityFiles: [], identitiesOnly: false, proxyJump: "", needsVpn: true, remember: false, source: "config" },
];
const states = new Map();
const links = new Map();
const asks = new Map();
let hosts = [];
const log = (window.__sshLog = window.__sshLog || []);
const ws = (p) => p;

const FS = {
  "/home/minh": [["proj", 1], ["data", 1], ["notes.txt", 0]],
  "/home/minh/proj": [["analysis", 1], ["thesis", 1], ["train.py", 0]],
  "/home/minh/proj/analysis": [["notebooks", 1], ["results.md", 0]],
  "/home/minh/proj/thesis": [["main.tex", 0]],
  "/home/minh/data": [["raw", 1]],
};

function setState(id, state, reason = "") { states.set(id, { id, state, reason }); mockEmit("ssh-state", { id, state, reason }); }

function scenario(link) {
  const lone = window.__sshQuiet;
  return {
    state: lone ? "idle" : (link.paused ? "paused" : "idle"),
    up: lone ? 0 : 1, down: lone ? 0 : 1, tracked: 42,
    conflicts: lone ? [] : [{ rel: "analysis/results.md", why: "both-changed", copy: "analysis/results (server).md", at: Date.now() / 1000 - 300 }],
    skipped: lone ? [] : [{ rel: "data/embeddings.npy", size: 52428800 }],
    pending: lone ? [] : [{ rel: "train.py", dir: "up" }, { rel: "analysis/log.txt", dir: "down" }],
    transfers: [], error: "", lastOk: Math.floor(Date.now() / 1000) - 20, rounds: 3,
    log: ["Merged analysis/model.ipynb", "Moved old.csv to the Recycle Bin"],
  };
}

export async function handle(cmd, a) {
  if (cmd === "cc_session_start") { window.__sshLastReq = a.req; return undefined; }
  if (!cmd.startsWith("ssh_")) return undefined;
  log.push({ cmd, args: a });
  switch (cmd) {
    case "ssh_set_hosts": {
      const byId = new Map(CONFIG_HOSTS.map((h) => [h.id, { ...h }]));
      const own = [];
      for (const s of a.stored || []) {
        if (byId.has(s.id)) Object.assign(byId.get(s.id), { needsVpn: s.needsVpn, remember: s.remember, name: s.name || s.id });
        else own.push({ ...s, source: "callio" });
      }
      hosts = [...byId.values(), ...own];
      for (const h of hosts) if (!states.has(h.id)) states.set(h.id, { id: h.id, state: "off", reason: "" });
      return { hosts, notes: ["Match blocks in your ssh config are ignored (Callio reads Host blocks only)."], sshDir: ws("C:/Users/me/.ssh"), states: [...states.values()] };
    }
    case "ssh_states": return [...states.values()];
    case "ssh_answer": { asks.get(a.id)?.(a.value); asks.delete(a.id); return null; }
    case "ssh_connect": {
      const h = hosts.find((x) => x.id === a.host);
      if (!h) throw "Unknown server.";
      setState(h.id, "connecting");
      if (window.__sshDown?.includes(h.id) || (h.needsVpn && window.__sshVpnOff !== false)) {
        setState(h.id, "off", "offline");
        throw h.needsVpn ? `Could not connect to ${h.name}. This server needs a VPN — turn the VPN on and try again.` : `Could not connect to ${h.name}: connection timed out.`;
      }
      if (window.__sshAskHostkey) {
        const id = "ask" + Math.random().toString(36).slice(2, 8);
        const ans = await new Promise((res) => { asks.set(id, res); mockEmit("ssh-ask", { id, kind: "hostkey", host: h.host, port: h.port, name: h.name, fingerprint: "SHA256:uN3p0wFk2m7iQ1Zc9sJd8aL4xT6vYbHrE5oKgWnXe1U", algorithm: "ssh-ed25519" }); });
        if (!ans?.trust) { setState(h.id, "off", "error"); throw `You did not trust the key of ${h.name}. Nothing was saved.`; }
      }
      setState(h.id, "connected");
      return { ok: true };
    }
    case "ssh_disconnect": setState(a.host, "off"); return null;
    case "ssh_forget": return null;
    case "ssh_test": {
      const h = hosts.find((x) => x.id === a.host);
      await handle("ssh_connect", { host: a.host });
      return { ok: true, kernel: "Linux 6.1.0", os: "Ubuntu 22.04.4 LTS", python3: true, jupyterServer: h.id === "gpu-box", ipykernel: h.id === "gpu-box", rsync: true, claude: window.__sshClaude !== false, claudePath: "/home/minh/.local/bin/claude", sftp: true, find: true, sha256: true };
    }
    case "ssh_list_dir": {
      const p = a.path || "/home/minh";
      const items = FS[p];
      if (!items) throw `Could not list ${p}: No such file`;
      return { path: p, items: items.map(([name, dir]) => ({ name, dir: !!dir, size: dir ? 0 : 1200, mtime: 1760000000 })) };
    }
    case "ssh_mkdir": FS[a.path] = []; return null;
    case "ssh_sync_start": {
      const st = scenario(a.link);
      links.set(a.link.id, { cfg: a.link, st });
      setTimeout(() => mockEmit("ssh-sync", { id: a.link.id, status: st }), 30);
      return st;
    }
    case "ssh_sync_stop": links.delete(a.id); return null;
    case "ssh_sync_status": {
      if (a.id) return links.get(a.id)?.st || null;
      return [...links.entries()].map(([id, l]) => ({ id, ...l.st }));
    }
    case "ssh_sync_now": {
      const l = links.get(a.id); if (!l) throw "This folder link is not running.";
      l.st = { ...l.st, state: "syncing", transfers: [{ rel: "train.py", dir: "up", done: 400, total: 1200 }] };
      mockEmit("ssh-sync", { id: a.id, status: l.st });
      setTimeout(() => { l.st = { ...l.st, state: "idle", up: 0, down: 0, pending: [], transfers: [], rounds: l.st.rounds + 1, lastOk: Math.floor(Date.now() / 1000) }; mockEmit("ssh-sync", { id: a.id, status: l.st }); }, 500);
      return null;
    }
    case "ssh_sync_pause": {
      const l = links.get(a.id); if (!l) return null;
      l.st = { ...l.st, state: a.paused ? "paused" : "idle" }; mockEmit("ssh-sync", { id: a.id, status: l.st }); return null;
    }
    case "ssh_sync_resolve": {
      const l = links.get(a.id); if (!l) return null;
      l.st = { ...l.st, conflicts: l.st.conflicts.filter((c) => c.rel !== a.rel) }; mockEmit("ssh-sync", { id: a.id, status: l.st }); return null;
    }
    case "ssh_sync_hold": return null;
    case "ssh_sync_base": return "base text";
    case "ssh_sync_remote_read": return "server text";
    case "ssh_py_list": return [
      { path: "/usr/bin/python3", label: "Python 3.10 (system)", version: "3.10.12", hasServer: false, hasKernel: false, missing: ["jupyter_server", "ipykernel"] },
      { path: "/home/minh/miniconda3/envs/torch/bin/python", label: "Python 3.11 (conda: torch)", version: "3.11.7", hasServer: true, hasKernel: true, missing: [] },
    ];
    case "ssh_pip_install": {
      for (const l of ["Collecting jupyter_server", "Installing collected packages: jupyter_server, ipykernel", "Successfully installed jupyter_server ipykernel"]) mockEmit("jp-log", { id: a.id, line: l });
      mockEmit("jp-log", { id: a.id, done: true, code: 0 }); return 0;
    }
    case "ssh_jp_start": return { id: "sshjp-" + a.host, kind: "ssh", baseUrl: "", root: a.remoteRoot, kernelPath: a.nbDir || "" };
    case "ssh_jp_forward": return { id: "sshjp-fwd-" + a.host, kind: "ssh", baseUrl: "" };
    case "ssh_jp_stop": return null;
    case "ssh_jp_list": return [];
    case "ssh_claude_info": return { installed: window.__sshClaude !== false, path: window.__sshClaude === false ? "" : "/home/minh/.local/bin/claude", installCommand: "curl -fsSL https://claude.ai/install.sh | bash" };
    case "ssh_claude_install": {
      mockEmit("ssh-log", { id: a.id, line: "Downloading Claude Code…" });
      window.__sshClaude = true;
      mockEmit("ssh-log", { id: a.id, done: true, code: 0 }); return 0;
    }
    case "ssh_prompt_note": return window.__sshNote || "";
    default: return null;
  }
}
