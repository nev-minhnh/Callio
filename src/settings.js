import { api } from "./api.js";
import { settings, updateSettings, toast, ask } from "./main.js";
import { refreshEngineCards } from "./engines.js";
import { signInOverleaf } from "./overleaf.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function showSection(sec) {
  for (const b of $$(".settings-nav button")) b.classList.toggle("active", b.dataset.sec === sec);
  for (const s of $$(".settings-pages section")) s.hidden = s.dataset.sec !== sec;
  if (sec === "latex") refreshEngines();
  if (sec === "files") refreshAssoc();
  if (sec === "ai") import("./ai.js").then((m) => m.renderAISettings());
  if (sec === "library") import("./library.js").then((m) => m.renderLibrarySettings());
  if (sec === "ocr") import("./ocr.js").then((m) => m.renderOcrSettings($("#ocr-settings")));
}

// ---------------- one look for every page ----------------
// Every settings page — the static ones here and those other modules draw (AI, Library, OCR) —
// is laid out the same way: titled groups (cards), and in them one row per setting with its name
// on the left and its control on the right; on/off settings are switches. Pages are written as
// plain <h3> + <label> markup and shaped here as they appear.
const NO_ROW = ".sr, .no-row, .ocr-card, .gh-list, .skill-row, .pl-row, .csl-list, .engine-card, .cc-status, .ocr-langs, .set-tabs, .wr-panel";
let rowN = 0;
function rowify(lab) {
  if (lab.closest(NO_ROW) || lab.dataset.row === "0") return;
  const ctl = [...lab.children].find((c) => /^(INPUT|SELECT|TEXTAREA)$/.test(c.tagName) || c.classList.contains("ocr-key"));
  if (!ctl) return;
  const isCheck = ctl.tagName === "INPUT" && ctl.type === "checkbox";
  const wide = ctl.tagName === "TEXTAREA" || (ctl.tagName === "INPUT" && ctl.type === "search") || lab.classList.contains("wide");
  const row = document.createElement("div");
  row.className = ["sr", isCheck ? "sr-check" : "", wide ? "sr-wide" : "", ...[...lab.classList].filter((c) => c !== "check" && c !== "wide")].filter(Boolean).join(" ");
  if (lab.hidden) row.hidden = true;
  if (lab.title) row.title = lab.title;
  const left = document.createElement("label");
  left.className = "sr-l";
  const input = ctl.matches("input, select, textarea") ? ctl : ctl.querySelector("input, select, textarea");
  if (input) { if (!input.id) input.id = `sr-${++rowN}`; left.htmlFor = input.id; }
  for (const n of [...lab.childNodes]) if (n !== ctl) left.appendChild(n);
  // trim the label text
  const first = left.firstChild; if (first?.nodeType === 3) first.nodeValue = first.nodeValue.replace(/^\s+/, "");
  const last = left.lastChild; if (last?.nodeType === 3) last.nodeValue = last.nodeValue.replace(/\s+$/, "");
  const right = document.createElement("div");
  right.className = "sr-c";
  right.appendChild(ctl);
  row.append(left, right);
  lab.replaceWith(row);
}
/** Puts each <h3> and what follows it (until the next) into a card. */
function groupify(box) {
  if (box.dataset.grouped === "1" || box.querySelector(":scope > .sg")) return;
  const kids = [...box.children];
  if (!kids.some((k) => /^H[34]$/.test(k.tagName))) return;
  box.dataset.grouped = "1";
  let g = null;
  for (const k of kids) {
    if (/^H[34]$/.test(k.tagName) && !k.closest(".sg")) {
      g = document.createElement("div");
      g.className = "sg";
      k.classList.add("sg-h");
      box.insertBefore(g, k);
      g.appendChild(k);
      continue;
    }
    if (k.classList.contains("set-tabs") || k.classList.contains("ai-pane") || k.classList.contains("set-intro")) { g = null; continue; }
    if (!g) { g = document.createElement("div"); g.className = "sg"; box.insertBefore(g, k); }
    g.appendChild(k);
  }
}
export function normalizeSettings(root = $(".settings-pages")) {
  if (!root) return;
  for (const box of root.querySelectorAll("section, #lib-settings, #ocr-settings, .ai-pane, .sg-body")) groupify(box);
  for (const lab of root.querySelectorAll("label")) rowify(lab);
}
let normQueued = false;
function watchSettings() {
  const root = $(".settings-pages");
  if (!root) return;
  new MutationObserver(() => {
    if (normQueued) return;
    normQueued = true;
    queueMicrotask(() => { normQueued = false; normalizeSettings(root); });
  }).observe(root, { childList: true, subtree: true });
  normalizeSettings(root);
}

export async function openSettings(section = "editor") {
  const form = $("#settings-form");
  for (const el of form.elements) {
    if (!el.name || !(el.name in settings)) continue;
    if (el.type === "checkbox") el.checked = !!settings[el.name];
    else el.value = settings[el.name] ?? "";
  }
  $("#ol-token").value = (await api.getSecret("overleaf-git-token").catch(() => null)) || "";
  $("#ol-cookie").value = (await api.getSecret("overleaf-session").catch(() => null)) || "";
  showSection(section);
  $("#dlg-settings").showModal();
}

function refreshEngines() { refreshEngineCards(); }

async function refreshAssoc() {
  try {
    const s = await api.assocStatus();
    $("#assoc-exts").textContent = s.extensions.join("  ");
    $("#assoc-status").textContent = s.registered ? `Registered for ${s.exe}` : "Not registered yet.";
    $("#assoc-status").className = "note" + (s.registered ? " ok" : "");
  } catch (e) { $("#assoc-status").textContent = e.message; }
}

export function initSettings() {
  watchSettings();
  const form = $("#settings-form");
  form.addEventListener("change", (e) => {
    const el = e.target;
    if (!el.name || !(el.name in settings)) return;
    let v = el.type === "checkbox" ? el.checked : el.type === "number" ? +el.value : el.value;
    if (el.name === "overleafUrl") v = (v || "https://www.overleaf.com").trim().replace(/\/+$/, "");
    updateSettings({ [el.name]: v });
  });
  for (const b of $$(".settings-nav button")) b.onclick = () => showSection(b.dataset.sec);
  $("#dlg-settings").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-url]");
    if (a) { e.preventDefault(); api.openUrl(a.dataset.url); }
  });

  const saveSecret = (key) => async (e) => {
    try { await api.setSecret(key, e.target.value.trim()); toast("Saved to Windows Credential Manager", "ok", 2000); }
    catch (err) { toast(err.message, "err"); }
  };
  $("#ol-token").addEventListener("change", saveSecret("overleaf-git-token"));
  $("#ol-cookie").addEventListener("change", saveSecret("overleaf-session"));

  $("#btn-ol-signin").onclick = () => signInOverleaf();
  $("#btn-ol-signout").onclick = async () => {
    await api.olSignOut().catch(() => {});
    $("#ol-cookie").value = "";
    $("#ol-test-result").textContent = "Signed out of Overleaf."; $("#ol-test-result").className = "note";
  };
  $("#btn-ol-test").onclick = async () => {
    const out = $("#ol-test-result");
    out.textContent = "Connecting…"; out.className = "note";
    try {
      const r = await api.olTest();
      out.textContent = `Connected as ${r.user || "unknown"} · ${r.projects} project(s)`;
      out.className = "note ok";
    } catch (e) { out.textContent = e.message; out.className = "note err"; }
  };


  $("#btn-assoc-register").onclick = async () => {
    try { await api.assocRegister(); toast("Registered. Now pick Callio as the default in Windows Settings.", "ok"); refreshAssoc(); }
    catch (e) { toast(e.message, "err"); }
  };
  $("#btn-assoc-unregister").onclick = async () => {
    try { await api.assocUnregister(); toast("Removed file type registration.", "ok"); refreshAssoc(); }
    catch (e) { toast(e.message, "err"); }
  };
  $("#btn-default-apps").onclick = () => api.openDefaultApps().catch((e) => toast(e.message, "err"));

  $("#btn-uninstall").onclick = uninstall;
  api.appInfo().then((i) => {
    $("#about-version").textContent = "v" + i.version;
    $("#about-paths").textContent = i.settingsPath;
  }).catch(() => {});
}

async function uninstall() {
  let i;
  try { i = await api.uninstallInfo(); } catch (e) { return toast(e.message, "err"); }
  const lines = [
    "This deletes, on this PC:",
    "• “Open with”, default-app and file-type entries",
    "• saved API keys, Overleaf token and sign-in, extension pairing (Windows Credential Manager)",
    `• settings, AI memory, local history and the paper library${i.papers ? ` (${i.papers} paper${i.papers === 1 ? "" : "s"} and their PDFs)` : ""}`,
    ...(i.claudeSkills ? [`• ${i.claudeSkills} skill(s) Callio copied into Claude Code`] : []),
    ...(i.tinytex ? [`• TinyTeX installed by Callio (${i.tinytex})`] : []),
    i.installed ? "• the installed program (runs the uninstaller)" : `• this portable copy: ${i.exe}`,
    ...(i.otherCopies.length ? [`• other Callio copies found:\n   ${i.otherCopies.join("\n   ")}`] : []),
    "",
    "Your documents and folders are not touched. Claude Code itself and the Edge extension stay installed (remove the extension in Edge → Extensions).",
    "",
    "This can't be undone. Type UNINSTALL to confirm.",
  ];
  const r = await ask({ title: "Uninstall Callio", text: lines.join("\n"), input: "", buttons: [{ label: "Cancel", value: null }, { label: "Uninstall everything", value: "go", primary: true }] });
  if (r === null) return;
  if (String(r).trim().toUpperCase() !== "UNINSTALL") return toast("Not uninstalled — type UNINSTALL to confirm.", "err");
  const { getTabs } = await import("./main.js");
  const dirty = getTabs().filter((t) => t.dirty);
  if (dirty.length) {
    const s = await ask({ title: "Unsaved changes", text: `${dirty.length} file(s) have unsaved changes. Save them before uninstalling?`, buttons: [{ label: "Cancel", value: null }, { label: "Discard", value: "quit" }, { label: "Save all", value: "save", primary: true }] });
    if (!s) return;
    if (s === "save") { const { saveTab } = await import("./main.js"); for (const t of dirty) if (!(await saveTab(t))) return; }
  }
  try { await api.uninstallEverything({ program: true, otherCopies: true }); }
  catch (e) { toast(e.message, "err"); }
}
