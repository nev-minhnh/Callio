// Save to Callio — background worker: talks to Callio on this PC and fetches PDFs with your
// browser session (so papers you can open, Callio can store).
const PORTS = [27183, 27184, 27185, 27186, 27187, 27188, 27189];

/** The port where Callio (and not some other program) is listening. */
async function findPort() {
  const { callioPort } = await chrome.storage.local.get("callioPort");
  const ports = callioPort ? [callioPort, ...PORTS.filter((p) => p !== callioPort)] : PORTS;
  for (const port of ports) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const r = await fetch(`http://127.0.0.1:${port}/callio/ping`, { signal: ctl.signal });
      clearTimeout(t);
      const j = await r.json();
      if (j.app === "callio") {
        if (port !== callioPort) chrome.storage.local.set({ callioPort: port });
        return port;
      }
    } catch {}
  }
  throw Object.assign(new Error("Callio isn't running on this PC. Open Callio and try again."), { offline: true });
}

async function callio(path, { method = "GET", body, needToken = true } = {}) {
  const port = await findPort(); // the token is only ever sent to Callio
  const { callioToken } = await chrome.storage.local.get("callioToken");
  const headers = { "Content-Type": "application/json" };
  if (needToken && callioToken) headers["X-Callio-Token"] = callioToken;
  if (path === "/callio/pair") headers["X-Callio-Pair"] = "1";
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Callio returned ${r.status}`), { status: r.status });
  return j;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function fetchPdf(url) {
  if (!url) return null;
  try {
    const r = await fetch(url, { credentials: "include", redirect: "follow" });
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 1024));
    const txt = String.fromCharCode(...head);
    if (!txt.includes("%PDF-")) return null; // a login or HTML page, not the PDF
    return buf;
  } catch { return null; }
}

async function save(meta, opts = {}) {
  const pdfUrl = meta.isPdf ? meta.url : meta.pdfUrl;
  const buf = await fetchPdf(pdfUrl);
  const body = {
    meta: {
      title: meta.title || "", authors: (meta.authors || []).map(fixName), year: meta.year ? +meta.year : null,
      type: meta.type || "", venue: meta.venue || "", volume: meta.volume || "", issue: meta.issue || "", pages: meta.pages || "",
      publisher: meta.publisher || "", doi: meta.doi || "", arxiv: meta.arxiv || "", url: meta.isPdf ? "" : meta.url,
      abstract: meta.abstract || "", tags: opts.tags || [],
    },
    pdfBase64: buf ? toBase64(buf) : null,
    pdfUrl: buf ? null : pdfUrl || null,
    pageUrl: meta.url,
    collection: opts.collection || null,
    lookup: true,
  };
  return callio("/callio/add", { method: "POST", body });
}

// "Given Family" → "Family, Given" (citation_author is often already "Family, Given")
function fixName(n) {
  n = String(n).trim();
  if (n.includes(",")) return n;
  const parts = n.split(/\s+/);
  return parts.length > 1 ? `${parts.pop()}, ${parts.join(" ")}` : n;
}

async function extractFrom(tabId, url) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, files: ["extract.js"] });
    if (res?.result) return res.result;
  } catch {}
  // Edge's PDF viewer and other pages scripts can't run in
  return { url, isPdf: true, title: "" };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    try {
      if (msg.type === "ping") reply({ ok: true, ...(await callio("/callio/ping", { needToken: true })) });
      else if (msg.type === "pair") {
        const r = await callio("/callio/pair", { method: "POST", body: { browser: navigator.userAgent.includes("Edg/") ? "Microsoft Edge" : "your browser" }, needToken: false });
        await chrome.storage.local.set({ callioToken: r.token });
        reply({ ok: true });
      } else if (msg.type === "collections") reply({ ok: true, ...(await callio("/callio/collections")) });
      else if (msg.type === "lookup") reply({ ok: true, ...(await callio("/callio/lookup", { method: "POST", body: { doi: msg.doi, title: msg.title } })) });
      else if (msg.type === "extract") reply({ ok: true, meta: await extractFrom(msg.tabId, msg.url) });
      else if (msg.type === "save") reply({ ok: true, ...(await save(msg.meta, msg.opts)) });
    } catch (e) { reply({ ok: false, error: e.message, offline: !!e.offline, status: e.status }); }
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "callio-link", title: "Save linked PDF to Callio", contexts: ["link"] });
  chrome.contextMenus.create({ id: "callio-page", title: "Save this page to Callio", contexts: ["page"] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let meta;
  if (info.menuItemId === "callio-link") meta = { url: info.linkUrl, pdfUrl: info.linkUrl, isPdf: true, title: "" };
  else meta = await extractFrom(tab.id, tab.url);
  try {
    const r = await save(meta);
    notify(r.duplicate ? "Already in your library — updated" : "Saved to Callio", r.title + (r.pdf ? " (with PDF)" : " (no PDF found)"));
  } catch (e) { notify("Couldn't save to Callio", e.message); }
});

function notify(title, message) {
  chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title, message: message || "" });
}
