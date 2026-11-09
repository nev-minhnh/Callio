import { defineConfig } from "vite";

// Development only: the browser test harness (src/mock.js) reaches the real office engine and
// real files through these endpoints. Never part of the built app.
function devBridge() {
  let proc = null, buf = "", seq = 1;
  const waiting = new Map();
  return {
    name: "callio-dev-bridge",
    apply: "serve",
    async configureServer(server) {
      const { spawn } = await import("node:child_process");
      const fs = await import("node:fs");
      const engine = () => {
        if (proc) return proc;
        proc = spawn(process.env.CALLIO_OFFICE || "office/target/release/callio-office", ["--serve"], { stdio: ["pipe", "pipe", "inherit"] });
        proc.on("exit", () => { proc = null; for (const [id, r] of waiting) r({ id, ok: false, error: "engine stopped" }); waiting.clear(); });
        proc.stdout.on("data", (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            try { const v = JSON.parse(line); waiting.get(v.id)?.(v); waiting.delete(v.id); } catch {}
          }
        });
        return proc;
      };
      const body = (req) => new Promise((res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => res(Buffer.concat(c))); });
      server.middlewares.use("/__office", async (req, res) => {
        const { cmd, args } = JSON.parse(await body(req));
        const id = seq++;
        const p = new Promise((r) => waiting.set(id, r));
        engine().stdin.write(JSON.stringify({ id, cmd, args }) + "\n");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(await p));
      });
      server.middlewares.use("/__stat", (req, res) => {
        const path = new URL(req.url, "http://x").searchParams.get("path");
        try { const st = fs.statSync(path); res.end(JSON.stringify({ exists: true, isDir: st.isDirectory(), size: st.size, mtime: Math.round(st.mtimeMs) })); }
        catch { res.end(JSON.stringify({ exists: false, isDir: false, size: 0, mtime: 0 })); }
      });
      server.middlewares.use("/__cmpdir", (req, res) => {
        const q = new URL(req.url, "http://x").searchParams;
        const walk = (root, dir = root, out = new Map()) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = dir + "/" + e.name; if (e.isDirectory()) { if (![".git", "node_modules"].includes(e.name)) walk(root, p, out); } else out.set(p.slice(root.length + 1), p); } return out; };
        const A = walk(q.get("a")), B = walk(q.get("b"));
        const keys = [...new Set([...A.keys(), ...B.keys()])].sort();
        res.end(JSON.stringify(keys.map((k) => {
          const a = A.get(k), b = B.get(k);
          const sa = a ? fs.statSync(a).size : 0, sb = b ? fs.statSync(b).size : 0;
          const state = !b ? "left" : !a ? "right" : sa !== sb || !fs.readFileSync(a).equals(fs.readFileSync(b)) ? "changed" : "same";
          return { rel: k, state, sizeA: sa, sizeB: sb };
        })));
      });
      server.middlewares.use("/__ls", (req, res) => {
        const path = new URL(req.url, "http://x").searchParams.get("path");
        try { res.end(JSON.stringify(fs.readdirSync(path, { withFileTypes: true }).map((e) => ({ name: e.name, path: path.replace(/\/$/, "") + "/" + e.name, isDir: e.isDirectory() })))); }
        catch (e) { res.statusCode = 404; res.end(String(e)); }
      });
      server.middlewares.use("/__fs", async (req, res) => {
        const path = new URL(req.url, "http://x").searchParams.get("path");
        try {
          if (req.method === "POST") { fs.mkdirSync(path.replace(/\/[^/]*$/, ""), { recursive: true }); fs.writeFileSync(path, await body(req)); res.end("ok"); }
          else res.end(fs.readFileSync(path));
        } catch (e) { res.statusCode = 404; res.end(String(e)); }
      });
    },
  };
}

export default defineConfig({
  clearScreen: false,
  plugins: [devBridge()],
  server: { port: 1420, strictPort: true },
  optimizeDeps: { include: ["yaml", "js-beautify", "mermaid"] },
  build: {
    target: "es2022",
    outDir: "dist",
    chunkSizeWarningLimit: 4000,
    sourcemap: false,
  },
});
