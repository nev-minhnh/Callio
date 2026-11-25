// Mock of the window commands (browser only). There are no real windows here: the other windows
// are whatever the page puts in `window.__mockWins` ([{label, folder, files}]) and every decision
// the backend would act on is appended to `window.__winLog`. The decision is the same rule as
// src-tauri/src/windows/route.rs.
const norm = (p) => (p || "").replace(/\\/g, "/").replace(/(?<=.)\/+$/, "").toLowerCase();
const inside = (p, d) => { const a = norm(p), b = norm(d); return !!b && (a === b || a.startsWith(b + "/")); };
const dir = (p) => { const s = p.replace(/\\/g, "/"); const i = s.lastIndexOf("/"); return i > 0 ? s.slice(0, i) : s; };
let lastSaved = null, n = 1;

function decide(path, me, others) {
  const key = norm(path);
  if (me.files.some((f) => norm(f) === key)) return { d: "here" };
  if (!me.folder || inside(path, me.folder)) return { d: "here" };
  const has = others.find((w) => (w.files || []).some((f) => norm(f) === key));
  if (has) return { d: "focus", label: has.label };
  const owners = others.filter((w) => inside(path, w.folder)).sort((a, b) => norm(b.folder).length - norm(a.folder).length);
  if (owners.length) return { d: "openIn", label: owners[0].label };
  return { d: "new", folder: dir(path) };
}

export async function handle(cmd, a) {
  const log = (window.__winLog ||= []);
  switch (cmd) {
    case "win_route": {
      const r = decide(a.path, { folder: a.folder, files: a.files || [] }, window.__mockWins || []);
      log.push({ ...r, path: a.path, line: a.line });
      if (r.d === "here") return { here: true, label: "main", created: false };
      if (r.d === "new") {
        const label = "w-" + ++n;
        (window.__mockWins ||= []).push({ label, folder: r.folder, files: [a.path] });
        return { here: false, label, created: true };
      }
      return { here: false, label: r.label, created: false };
    }
    case "win_report": (window.__winReports ||= []).push(a); return null;
    case "win_boot": return { layout: window.__mockLayout || null, folder: null };
    case "win_list": return [{ label: "main", role: "editor", folder: null, files: [], me: true }, ...(window.__mockWins || []).map((w) => ({ role: "editor", me: false, files: [], ...w }))];
    case "win_close": log.push({ d: "close" }); return window.__mockWins?.length ? "closed" : "last";
    case "win_previous": return window.__mockPrev || [];
    case "win_restore": log.push({ d: "restore" }); return (window.__mockPrev || []).length;
    case "win_discard_previous": log.push({ d: "discard" }); window.__mockPrev = []; return null;
    case "save_settings": {
      // like the backend: keys in `omit` stay as they were
      for (const k of a.omit || []) { if (lastSaved && k in lastSaved) a.settings[k] = lastSaved[k]; else delete a.settings[k]; }
      lastSaved = { ...a.settings };
      window.__lastSave = a;
      return undefined; // mock.js stores it
    }
    default: return undefined;
  }
}
