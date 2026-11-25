// Dev-only: the jp_* commands for the browser, talking to a REAL Jupyter server so UI tests run real
// kernels. Tests call window.__jpServer = { url, token } (e.g. http://127.0.0.1:8891/ + token) before
// using the notebook. The token is sent in the Authorization header / WebSocket query here only;
// the app itself keeps it in the backend.
import { mockEmit } from "../mock.js";

const wss = new Map();
const srv = () => window.__jpServer || { url: "http://127.0.0.1:8891/", token: "testtoken123" };
const J = (cmd, a) => import("../api.js").then((m) => m.api);

async function endpoint(conn) {
  if (conn.kind === "local") return { base: srv().url, token: srv().token };
  const { api } = await import("../api.js");
  const token = (await api.getSecret(`callio-jupyter-${conn.id}`)) || "";
  return { base: conn.baseUrl, token };
}
const join = (b, p) => b.replace(/\/+$/, "") + "/" + p.replace(/^\/+/, "");

export async function handle(cmd, a) {
  switch (cmd) {
    case "jp_interpreters": {
      if (window.__jpInterps) return window.__jpInterps;
      return [
        { path: "/usr/bin/python3", label: "Python 3.13 (PATH)", version: "3.13.1", source: "path", hasServer: true, hasKernel: true, missing: [] },
        { path: "C:\\proj\\.venv\\Scripts\\python.exe", label: "Python 3.12 (.venv)", version: "3.12.1", source: "venv", hasServer: false, hasKernel: false, missing: ["jupyter_server", "ipykernel"] },
      ];
    }
    case "jp_local_start": return { id: "local-mock", kind: "local", baseUrl: srv().url, root: "/", kernelPath: "" };
    case "jp_local_list": return window.__jpLocals || [{ id: "local-mock", baseUrl: srv().url, root: "/", python: "/usr/bin/python3" }];
    case "jp_local_stop": case "jp_shutdown": case "jp_set_idle": return null;
    case "jp_pip_install": {
      window.__pipCalls = (window.__pipCalls || 0) + 1;
      for (const l of ["Collecting jupyter_server", "Downloading jupyter_server-2.21.1-py3-none-any.whl", "Successfully installed jupyter_server ipykernel"]) { mockEmit("jp-log", { id: a.id, line: l }); await new Promise((r) => setTimeout(r, 60)); }
      mockEmit("jp-log", { id: a.id, done: true, code: 0 });
      return 0;
    }
    case "jp_test": {
      // query token = simple GET requests (no CORS preflight); a refused token has no CORS headers, so a
      // network error on a reachable server is reported as "token refused", like the real backend does
      const base = a.url.replace(/\/+$/, "") + "/";
      const q = (p) => join(base, p) + "?token=" + encodeURIComponent(a.token);
      let r;
      try { r = await fetch(q("api/status")); }
      catch (e) {
        try { await fetch(join(base, "api/status"), { mode: "no-cors" }); } catch { throw new Error("Could not reach the server: " + e.message); }
        throw new Error("The server refused the token. Check it and try again.");
      }
      if (r.status === 403 || r.status === 401) throw new Error("The server refused the token. Check it and try again.");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const sp = await (await fetch(q("api/kernelspecs"))).json();
      const v = await (await fetch(q("api"))).json().catch(() => ({}));
      return { ok: true, baseUrl: base, version: v.version, kernelspecs: sp };
    }
    case "jp_rest": {
      const ep = await endpoint(a.conn);
      const r = await fetch(join(ep.base, a.path), { method: a.method, headers: { Authorization: "token " + ep.token, ...(a.body ? { "Content-Type": "application/json" } : {}) }, body: a.body ? JSON.stringify(a.body) : undefined });
      const t = await r.text();
      if (!r.ok) { let m = t; try { m = JSON.parse(t).message || t; } catch {} throw new Error(`HTTP ${r.status}: ${m}`); }
      return t.trim() ? JSON.parse(t) : null;
    }
    case "jp_ws_open": {
      const ep = await endpoint(a.conn);
      const u = new URL(join(ep.base, `api/kernels/${a.kernel}/channels`));
      u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
      u.searchParams.set("session_id", a.key); u.searchParams.set("token", ep.token);
      const ws = new WebSocket(u.toString());
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("Could not connect to the kernel")); });
      ws.onmessage = (e) => { try { mockEmit("jp-msg", { key: a.key, msg: JSON.parse(e.data) }); } catch {} };
      ws.onclose = () => mockEmit("jp-ws", { key: a.key, state: "closed" });
      wss.set(a.key, ws);
      return null;
    }
    case "jp_ws_send": { const ws = wss.get(a.key); if (!ws || ws.readyState !== 1) throw new Error("The kernel connection is closed."); ws.send(JSON.stringify(a.msg)); return null; }
    case "jp_ws_close": { const ws = wss.get(a.key); wss.delete(a.key); try { ws?.close(); } catch {} return null; }
  }
  return undefined;
}
