// Engine installer UI: progress dialog (download → unpack → set up), background mode in the
// status bar, cancel, and the engine cards in Settings → LaTeX.
import { api, listen } from "./api.js";
import { toast, status } from "./main.js";

const $ = (s) => document.querySelector(s);
export const ENGINE_NAMES = { tectonic: "Tectonic", tinytex: "TeX distribution (TinyTeX)" };
export const ENGINE_SIZES = { tectonic: "about 30 MB", tinytex: "about 75 MB download, 290 MB on disk" };

let running = null; // { kind, promise }
let hidden = false;

function setBar(bar, done, total) {
  if (total > 0) { bar.max = total; bar.value = Math.min(done, total); }
  else bar.removeAttribute("value"); // indeterminate
}

function onProgress(p) {
  const dlg = $("#dlg-install");
  for (const s of dlg.querySelectorAll(".inst-steps span")) {
    const order = ["download", "extract", "setup", "done"];
    const i = order.indexOf(s.dataset.step), cur = order.indexOf(p.phase);
    s.className = i < cur ? "done" : i === cur ? "active" : "";
  }
  setBar($("#inst-bar"), p.done, p.total);
  $("#inst-label").textContent = p.label;
  $("#inst-pct").textContent = p.total > 0 ? `${Math.floor((p.done / p.total) * 100)}%` : "";
  const st = $("#st-install");
  setBar(st.querySelector("progress"), p.done, p.total);
  st.querySelector("span").textContent = `${ENGINE_NAMES[p.kind] || p.kind}: ${p.total > 0 ? Math.floor((p.done / p.total) * 100) + "%" : p.phase}`;
}

function showDialog() {
  hidden = false;
  $("#st-install").hidden = true;
  const dlg = $("#dlg-install");
  if (!dlg.open) dlg.showModal();
}

/** Install an engine with a progress dialog. Resolves true on success. */
export function installEngine(kind) {
  if (running) { showDialog(); return running.promise; }
  const dlg = $("#dlg-install");
  $("#inst-title").textContent = `Installing ${ENGINE_NAMES[kind] || kind}`;
  $("#inst-label").textContent = "Starting…";
  $("#inst-pct").textContent = "";
  $("#inst-label").classList.remove("err");
  setBar($("#inst-bar"), 0, 0);
  for (const s of dlg.querySelectorAll(".inst-steps span")) s.className = "";
  $("#inst-cancel").hidden = false; $("#inst-hide").hidden = false; $("#inst-close").hidden = true;
  showDialog();

  const promise = (async () => {
    const unlisten = await listen("install-progress", onProgress);
    try {
      const r = await api.installEngine(kind);
      onProgress({ kind, phase: "done", label: `${ENGINE_NAMES[kind]} ${r.version} is ready.`, done: 1, total: 1 });
      toast(`${ENGINE_NAMES[kind]} installed (${r.version})`, "ok");
      if (hidden || !dlg.open) { $("#st-install").hidden = true; }
      else setTimeout(() => { if (dlg.open && !running) dlg.close(); }, 1200);
      return true;
    } catch (e) {
      const cancelled = /Cancelled/.test(e.message);
      $("#inst-label").textContent = cancelled ? "Installation cancelled." : e.message;
      $("#inst-label").classList.toggle("err", !cancelled);
      $("#inst-pct").textContent = "";
      setBar($("#inst-bar"), 0, 1);
      $("#st-install").hidden = true;
      if (!cancelled) { if (!dlg.open) dlg.showModal(); toast(`Install failed: ${e.message}`, "err", 9000); }
      return false;
    } finally {
      unlisten?.();
      running = null;
      $("#inst-cancel").hidden = true; $("#inst-hide").hidden = true; $("#inst-close").hidden = false;
      refreshEngineCards();
    }
  })();
  running = { kind, promise };
  return promise;
}

export function initEngineUI() {
  const dlg = $("#dlg-install");
  $("#inst-hide").onclick = () => { hidden = true; dlg.close(); $("#st-install").hidden = false; };
  $("#inst-cancel").onclick = () => { $("#inst-label").textContent = "Cancelling…"; api.cancelInstall(); };
  $("#inst-close").onclick = () => dlg.close();
  // Esc while running = run in background, never a silent cancel
  dlg.addEventListener("cancel", (e) => { if (running) { e.preventDefault(); $("#inst-hide").click(); } });
  $("#st-install").onclick = showDialog;
  for (const card of document.querySelectorAll(".engine-card")) {
    const kind = card.dataset.engine;
    card.querySelector(".ec-install").onclick = () => installEngine(kind);
    card.querySelector(".ec-remove").onclick = async () => {
      if (!confirm(`Remove ${ENGINE_NAMES[kind]} installed by Callio?`)) return;
      try { await api.removeEngine(kind); toast(`${ENGINE_NAMES[kind]} removed`, "ok"); }
      catch (e) { toast(e.message, "err", 8000); }
      refreshEngineCards();
    };
  }
}

export async function refreshEngineCards() {
  let e;
  try { e = await api.detectEngines(); } catch { return; }
  const set = (kind, text, installed, managed) => {
    const card = document.querySelector(`.engine-card[data-engine="${kind}"]`);
    if (!card) return;
    card.querySelector(".ec-status").textContent = text;
    card.classList.toggle("ok", installed);
    const btn = card.querySelector(".ec-install");
    btn.textContent = managed ? "Update" : installed ? "Install anyway" : "Install";
    btn.classList.toggle("primary", !installed);
    btn.disabled = !!running;
    card.querySelector(".ec-remove").hidden = !managed;
  };
  set("tectonic", e.tectonic ? `✓ Installed${e.tectonicManaged ? " by Callio" : ""}: ${e.tectonic}` : "Not installed", !!e.tectonic, e.tectonicManaged);
  const src = { tinytex: `✓ TinyTeX (${e.tinytexVersion || "TeX Live"}) installed by Callio`, miktex: "✓ Using your MiKTeX", texlive: "✓ Using your TeX Live", other: "✓ Found a TeX installation" }[e.texSource];
  const tools = ["latexmk", "pdflatex", "xelatex", "lualatex"].filter((k) => e[k]).join(", ");
  set("tinytex", src ? `${src}${tools ? " — " + tools : ""}` : "Not installed", !!e.texSource, e.texSource === "tinytex" || !!e.tinytexVersion);
}

export const isInstalling = () => !!running;
