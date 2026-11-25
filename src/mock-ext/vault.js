// Dev/test mock for the vault track. The vault commands go to the dev server's `/__vault`
// endpoint, which runs the same Rust code as the app (src-tauri/src/vault/*.rs, built as a small
// program: see /root/specs/tests/vault/rs); renames and moves of real files use `/__mv`.
const VAULT_CMDS = new Set(["vault_open", "vault_close", "vault_sync", "vault_touch", "vault_notes", "vault_resolve", "vault_resolve_many", "vault_headings", "vault_blocks", "vault_tags", "vault_tag_notes", "vault_backlinks", "vault_outgoing", "vault_embed", "vault_graph", "vault_link_text", "vault_unique", "vault_rename_plan", "vault_rename_apply", "vault_undo", "vault_props_get", "vault_props_set", "vault_props_remove", "vault_props_rename"]);
const real = (p) => typeof p === "string" && p.startsWith("/");
const dirOf = (p) => p.replace(/\/[^/]*$/, "");

async function engine(cmd, args) {
  const r = await (await fetch("/__vault", { method: "POST", body: JSON.stringify({ cmd, args }) })).json();
  if (!r.ok) throw r.error;
  return r.result;
}
async function mv(from, to) {
  const r = await fetch(`/__mv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  if (!r.ok) throw await r.text();
}
const exists = async (p) => (await (await fetch("/__stat?path=" + encodeURIComponent(p))).json()).exists;

export async function handle(cmd, a) {
  if (VAULT_CMDS.has(cmd)) {
    const args = { ...(a?.args || {}) };
    if (cmd === "vault_rename_apply" || cmd === "vault_undo") args.undoDir = window.__vaultUndoDir || "/tmp/callio-vault-undo";
    return engine(cmd, args);
  }
  if (cmd === "vault_ai_context") {
    const p = String(a.path || ""), root = window.__vaultRoot;
    if (!root || !p.startsWith(root + "/")) return "";
    const rel = p.slice(root.length + 1);
    const out = await engine("vault_outgoing", { root, rel }), back = await engine("vault_backlinks", { root, rel, unlinked: false });
    const o = [...new Set(out.map((x) => x.rel).filter(Boolean))], b = back.linked.map((x) => x.rel);
    return o.length || b.length ? `The open note ${rel} is in the author's Obsidian vault. It links to: ${o.join(", ") || "nothing"}. Linked from: ${b.join(", ") || "no note"}.` : "";
  }
  if (cmd === "rename_path" && real(a.from)) {
    const to = dirOf(a.from) + "/" + a.name;
    if (await exists(to)) throw `${a.name} already exists here`;
    await mv(a.from, to);
    return to;
  }
  if (cmd === "fs_move" && real(a.dest)) {
    const moved = [];
    for (const p of a.paths) { const to = a.dest.replace(/\/+$/, "") + "/" + p.split("/").pop(); await mv(p, to); moved.push([p, to]); }
    return { moved, error: null };
  }
  return undefined;
}
