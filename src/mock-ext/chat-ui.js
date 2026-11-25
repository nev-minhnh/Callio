// Dev mock of the chat-ui backend: the clean-exit marker, drafts and tab lists. They live in
// localStorage so that reloading the page in a test behaves like restarting Callio.
const KEY = { marker: "callio.mock.marker", drafts: "callio.mock.drafts", tabs: "callio.mock.tabstate" };
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

export async function handle(cmd, a) {
  switch (cmd) {
    case "session_marker_begin": {
      const m = load(KEY.marker, null);
      save(KEY.marker, { at: Date.now() });
      return { unclean: !!m, at: m?.at ?? null };
    }
    case "session_marker_touch": if (load(KEY.marker, null)) save(KEY.marker, { at: Date.now() }); return null;
    case "session_marker_end": localStorage.removeItem(KEY.marker); return null;
    case "draft_save": { const d = load(KEY.drafts, {}); d[`${a.window}/${a.key}`] = { ...a.draft, __mt: Date.now() }; save(KEY.drafts, d); return null; }
    case "draft_list": {
      const d = load(KEY.drafts, {});
      return Object.entries(d).filter(([k]) => !a.window || k.startsWith(a.window + "/")).map(([k, v]) => { const { __mt, ...rest } = v; return { ...rest, window: k.split("/")[0], key: k.slice(k.indexOf("/") + 1) }; });
    }
    case "draft_delete": {
      const d = load(KEY.drafts, {});
      for (const k of Object.keys(d)) if (k.startsWith(a.window + "/") && (!a.key || k === `${a.window}/${a.key}`)) delete d[k];
      save(KEY.drafts, d); return null;
    }
    case "draft_purge": {
      const d = load(KEY.drafts, {}); let n = 0;
      for (const [k, v] of Object.entries(d)) if (Date.now() - (v.__mt ?? v.savedAt ?? 0) > a.maxAgeMs) { delete d[k]; n++; }
      save(KEY.drafts, d); return n;
    }
    case "tabs_state_save": { const t = load(KEY.tabs, {}); t[a.window] = a.state; save(KEY.tabs, t); return null; }
    case "tabs_state_load": return load(KEY.tabs, {})[a.window] ?? null;
    case "tabs_state_delete": { const t = load(KEY.tabs, {}); delete t[a.window]; save(KEY.tabs, t); return null; }
  }
  return undefined;
}
