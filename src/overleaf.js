import { api, listen } from "./api.js";
import { link, folder, olPull, olPush, onLinked, setFolder, openPath, toast, ask, basename, settings } from "./main.js";
import { ic } from "./icons.js";

const $ = (s) => document.querySelector(s);
let projects = null;
let busy = false;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function parseProjectId(s) {
  s = (s || "").trim();
  const m = /(?:project\/|git\.overleaf\.com\/|\/)([0-9a-f]{24})/i.exec(s) || /^([0-9a-f]{24})$/i.exec(s);
  return m ? m[1] : null;
}

export function initOverleaf() {
  $("#overleaf-panel").addEventListener("click", onClick);
  listen("overleaf-auth", (r) => {
    toast(r.message, r.ok ? "ok" : "err", r.ok ? 3000 : 9000);
    const out = document.querySelector("#ol-test-result");
    if (out) { out.textContent = r.message; out.className = "note " + (r.ok ? "ok" : "err"); }
    if (r.ok) { projects = null; refreshOverleafPanel(); }
  });
}

/** Open Overleaf's sign-in window (result arrives as an "overleaf-auth" event). */
export function signInOverleaf() {
  return api.olSignIn().catch((e) => toast(e.message, "err"));
}

/** For callers: if an error means "signed out", offer to sign in. Returns true if handled. */
export async function handleSignInError(e) {
  if (!/OVERLEAF_SIGNIN/.test(e?.message || "")) return false;
  const r = await ask({ title: "Sign in to Overleaf", text: "Your Overleaf session has ended and couldn't be renewed automatically. Sign in again (once) and Callio will keep it fresh.",
    buttons: [{ label: "Not now", value: null }, { label: "Sign in", value: "yes", primary: true }] });
  if (r) signInOverleaf();
  return true;
}

export function refreshOverleafPanel() {
  const box = $("#overleaf-panel");
  if (!box || $("#side-overleaf").hidden) return;
  let html = "";
  if (link) {
    html += `<h4>Linked project</h4>
      <div><b>${esc(link.name || link.projectId)}</b><div class="note">${esc(link.mode === "git" ? "Git sync" : "Web sync")} · ${esc(link.folder)}</div></div>
      <div class="row">
        <button data-a="pull">${ic("pull")}<span>Pull</span></button><button data-a="push">${ic("push")}<span>Push</span></button>
        <button data-a="web"><span>Open on Overleaf</span>${ic("external")}</button><button data-a="unlink">Unlink</button>
      </div>`;
  } else if (folder) {
    html += `<h4>This folder</h4><div class="note">${esc(basename(folder))} isn't linked to Overleaf.</div>
      <div class="row"><button data-a="link">Link to an Overleaf project…</button></div>`;
  }
  html += `<h4>Open an Overleaf project</h4>
    <div class="row"><input id="ol-id" placeholder="Project URL or ID" /><button data-a="open-id">Open</button></div>
    <div class="row"><button data-a="list">${projects ? "Refresh list" : "Load my projects"}</button></div>`;
  if (projects) {
    html += `<div class="ol-list">` + (projects.length ? projects.map((p) => `
      <div class="ol-proj" data-id="${esc(p.id)}" data-name="${esc(p.name)}" title="Click to open locally">
        <div>${esc(p.name)}</div><div class="meta">${esc(p.owner || "")}${p.lastUpdated ? " · " + new Date(p.lastUpdated).toLocaleDateString() : ""}</div>
      </div>`).join("") : `<div class="empty-note">No projects found.</div>`) + `</div>`;
  }
  html += `<p class="note">Project list and web sync: sign in once (Settings → Overleaf → Sign in). Git sync: add a Git token there.</p>`;
  box.innerHTML = html;
}

async function onClick(e) {
  const b = e.target.closest("[data-a], .ol-proj");
  if (!b || busy) return;
  const a = b.dataset.a;
  try {
    busy = true;
    if (a === "pull") await olPull();
    else if (a === "push") await olPush();
    else if (a === "web") api.openUrl(`${settings.overleafUrl}/project/${link.projectId}`);
    else if (a === "unlink") {
      const ok = await ask({ title: "Unlink folder", text: "Stop syncing this folder with Overleaf? Local files are kept." });
      if (ok) { await api.olUnlink(link.folder); onLinked({ folder: link.folder }); }
    } else if (a === "list") {
      b.disabled = true; b.textContent = "Loading…";
      projects = await api.olListProjects();
      refreshOverleafPanel();
    } else if (a === "open-id") {
      const id = parseProjectId($("#ol-id").value);
      if (!id) return toast("Paste an Overleaf project URL like https://www.overleaf.com/project/<id>", "err");
      await cloneProject(id, null);
    } else if (a === "link") {
      const v = await ask({ title: "Link folder to Overleaf", text: "Paste the Overleaf project URL or ID. Pull will then download it into this folder.", input: "" });
      const id = parseProjectId(v);
      if (!id) return v && toast("That doesn't look like an Overleaf project URL.", "err");
      const l = await api.olLink(folder, id, null);
      onLinked(l);
      toast("Linked. Use Pull to fetch the project.", "ok");
    } else if (b.classList.contains("ol-proj")) {
      await cloneProject(b.dataset.id, b.dataset.name);
    }
  } catch (err) {
    if (!(await handleSignInError(err))) toast(err.message, "err", 9000);
    refreshOverleafPanel();
  } finally { busy = false; }
}

async function cloneProject(id, name) {
  const parent = await api.pickFolder("Choose where to put the project folder");
  if (!parent) return;
  toast(`Downloading ${name || id}…`, "", 2500);
  const r = await api.olClone(id, name, parent);
  setFolder(r.folder);
  onLinked(r.link);
  if (r.mainFile) await openPath(r.mainFile);
  toast(`Opened ${r.link.name || id} (${r.link.mode} sync)`, "ok");
}
