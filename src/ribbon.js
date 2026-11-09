// The Office-style ribbon shared by Word documents, spreadsheets and presentations.
// Icons are the office engine's own ribbon icons (exported to SVG,
// MIT OR Apache-2.0). Every tab after Home is built from the engine's own command catalogue (each
// command names its tab and group: "Insert › Tables"), so every command the engine has is on the
// ribbon; Home is laid out by hand like the Office apps.
import { ask } from "./main.js";

let ICONS = null;
export async function loadIcons() {
  ICONS ||= (await import("./ribbon-icons.json")).default;
  return ICONS;
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** SVG markup of icon `name` from `set` (deck | word | grid), "" when there is none. */
export function icon(set, name) {
  const s = name && ICONS?.[set]?.[name];
  return s ? s.replaceAll(" ~", ' stroke-linejoin="round" stroke-linecap="round"') : "";
}

/** Parameters a command takes, from its description: [{key, optional, kind, options}]. */
export function parseParams(desc) {
  if (!desc) return [];
  let s = String(desc).trim();
  // only the first alternative, only up to the closing brace of the object
  const end = s.indexOf("}");
  if (s.startsWith("{") && end > 0) s = s.slice(1, end);
  else return [];
  s = s.split(/\}\s*\|\s*\{/)[0];
  const out = [];
  const re = /"?([A-Za-z_]\w*)"?(\?)?\s*:\s*((?:"[^"]*"(?:\s*\|\s*"[^"]*")*)|[^,]+)/g;
  let m;
  while ((m = re.exec(s))) {
    const [, key, opt, rawT] = m;
    const t = rawT.trim();
    let kind = "text", options = null;
    const quoted = [...t.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    if (quoted.length > 1) { kind = "select"; options = quoted; }
    else if (quoted.length === 1 && quoted[0].includes("|")) { kind = "select"; options = quoted[0].split("|").map((x) => x.replace(/\(.*$/, "").trim()).filter(Boolean); }
    else if (/^[A-Za-z][\w]*(\s*\|\s*[A-Za-z][\w]*)+/.test(t) && !/string|number|bool/.test(t.split(/\s/)[0])) { kind = "select"; options = t.split(/\s+/)[0].split("|").map((x) => x.trim()).filter(Boolean); }
    else if (/^(bool|true|false)/i.test(t)) kind = "bool";
    else if (/^(number|n\b|int|pt|px|\d|-?\d)/i.test(t) || /\b(pt|percent|points)\b/.test(t)) kind = "number";
    else if (/^\[|CharProps|ParaProps|TabStop|Pos\b|base64/.test(t)) kind = "complex";
    out.push({ key, optional: !!opt, kind, options, hint: t.replace(/"/g, "") });
  }
  return out;
}

/** Ask for the parameters `cmd` needs (those not in `given` or `auto`). null = cancelled. */
export async function askParams(cmd, given = {}, auto = []) {
  const ps = parseParams(cmd.params).filter((p) => !(p.key in given) && !auto.includes(p.key) && p.kind !== "complex");
  const need = ps.filter((p) => !p.optional);
  if (!need.length) return given;
  let d = document.querySelector("#dlg-rbparams");
  if (!d) {
    d = document.createElement("dialog");
    d.id = "dlg-rbparams";
    d.innerHTML = `<form method="dialog"><header class="dlg-head"><h2></h2></header><div class="dlg-body col rbp-body"></div><footer class="dlg-foot"><button value="">Cancel</button><button value="ok" class="primary">OK</button></footer></form>`;
    document.body.appendChild(d);
  }
  d.querySelector("h2").textContent = cmd.label || cmd.id;
  const body = d.querySelector(".rbp-body");
  body.innerHTML = ps.map((p, i) => {
    const label = `${p.key.replace(/([A-Z])/g, " $1").replace(/^./, (x) => x.toUpperCase())}${p.optional ? "" : " *"}`;
    let input;
    if (p.kind === "select") input = `<select data-k="${p.key}">${p.optional ? `<option value=""></option>` : ""}${p.options.map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
    else if (p.kind === "bool") input = `<input type="checkbox" data-k="${p.key}">`;
    else input = `<input type="${p.kind === "number" ? "number" : "text"}" step="any" data-k="${p.key}" placeholder="${esc(p.hint.slice(0, 60))}">`;
    return `<label class="rbp-row"><span>${esc(label)}</span>${input}</label>`;
  }).join("");
  d.returnValue = "";
  d.showModal();
  body.querySelector("[data-k]")?.focus();
  await new Promise((r) => d.addEventListener("close", r, { once: true }));
  if (d.returnValue !== "ok") return null;
  const out = { ...given };
  for (const el of body.querySelectorAll("[data-k]")) {
    const p = ps.find((x) => x.key === el.dataset.k);
    if (el.type === "checkbox") { out[p.key] = el.checked; continue; }
    const v = el.value.trim();
    if (v === "") continue;
    out[p.key] = p.kind === "number" && !isNaN(+v) ? +v : v === "true" ? true : v === "false" ? false : v;
  }
  for (const p of need) if (!(p.key in out)) return null;
  return out;
}

// ---------------- building ----------------
const UI_ONLY = /^(ui|app|window|file|recovery|backstage|agent)\.|Dialog$|dialog$|Pane$|pane$|Window$|\.state$|\.inspect|\.list$|^font\.|\.get$|History$|Items$|\.describe/;

/**
 * Tabs built from a command catalogue. `cmds`: [{id, label, path: [tab, group, sub?], params}].
 * Returns [{name, groups: [{name, items}]}] in `order` (other tabs after, unless skipped).
 */
export function autoTabs(cmds, { order = [], skip = [], iconFor = () => null, exclude = () => false } = {}) {
  const tabs = new Map();
  for (const c of cmds) {
    const [tab, group = "", sub] = c.path || [];
    if (!tab || skip.includes(tab) || UI_ONLY.test(c.id) || exclude(c)) continue;
    if (!tabs.has(tab)) tabs.set(tab, new Map());
    const g = tabs.get(tab);
    const gname = group || tab;
    if (!g.has(gname)) g.set(gname, { plain: [], subs: new Map() });
    const gg = g.get(gname);
    gg.seen ||= new Set();
    const key = `${sub || ""}|${c.label}`;
    if (gg.seen.has(key)) continue; // the same button twice (two commands, one label)
    gg.seen.add(key);
    if (sub) { if (!gg.subs.has(sub)) gg.subs.set(sub, []); gg.subs.get(sub).push(c); }
    else gg.plain.push(c);
  }
  const names = [...order.filter((t) => tabs.has(t)), ...[...tabs.keys()].filter((t) => !order.includes(t))];
  return names.map((name) => ({
    name,
    groups: [...tabs.get(name)].map(([gname, gg]) => {
      const items = [];
      const withIcon = (c) => iconFor(c.id);
      // the first commands with icons are big buttons (up to two), the rest small in columns of three
      let big = 0;
      const plain = [...gg.plain];
      const smalls = [];
      for (const c of plain) {
        if (big < 2 && withIcon(c) && plain.length <= 6) { items.push({ t: "big", cmd: c.id, label: c.label, icon: withIcon(c) }); big++; }
        else smalls.push({ t: "small", cmd: c.id, label: c.label, icon: withIcon(c) });
      }
      for (const [sub, list] of gg.subs) {
        const first = list.find(withIcon);
        smalls.push({ t: "small", label: sub, icon: first ? withIcon(first) : null, menu: list.map((c) => ({ cmd: c.id, label: c.label, icon: withIcon(c) })) });
      }
      for (let i = 0; i < smalls.length; i += 3) items.push({ t: "stack", items: smalls.slice(i, i + 3) });
      return { name: gname, items };
    }).filter((g) => g.items.length),
  }));
}

export class Ribbon {
  /**
   * @param {object} o
   *  el: host element; set: icon set; tabs: [{name, groups}]; commands: Map id → {id,label,params};
   *  run(id, params): run a command; auto: parameter keys the app fills in itself;
   *  state(): the current formatting state for toggles; extra(el): right side of the tab row.
   */
  constructor(o) {
    Object.assign(this, o);
    this.cur = this.tabs[0]?.name;
    this.el.classList.add("rb");
    this.el.innerHTML = `<div class="rb-tabs"></div><div class="rb-body"></div>`;
    this.el.addEventListener("mousedown", (e) => { if (e.target.closest("button, .rb-gal-item, .rb-menu")) e.preventDefault(); });
    this.render();
  }
  render() {
    const tabsEl = this.el.querySelector(".rb-tabs");
    tabsEl.innerHTML = `<div class="rb-tablist">${this.tabs.map((t) => `<button class="rb-tab${t.name === this.cur ? " on" : ""}" data-tab="${esc(t.name)}">${esc(t.name)}</button>`).join("")}</div>`;
    tabsEl.onclick = (e) => {
      const b = e.target.closest(".rb-tab"); if (!b || b.dataset.tab === this.cur) return;
      this.cur = b.dataset.tab; this.render();
      const body = this.el.querySelector(".rb-body"); body.classList.remove("switch"); void body.offsetWidth; body.classList.add("switch");
    };
    tabsEl.ondblclick = (e) => { if (e.target.closest(".rb-tab")) this.el.classList.toggle("collapsed"); };
    this.extra?.(tabsEl);
    const tab = this.tabs.find((t) => t.name === this.cur) || this.tabs[0];
    const body = this.el.querySelector(".rb-body");
    body.innerHTML = "";
    for (const g of tab.groups) {
      const ge = document.createElement("div");
      ge.className = "rb-group";
      const items = document.createElement("div");
      items.className = "rb-items";
      for (const it of g.items) items.appendChild(this.item(it));
      ge.appendChild(items);
      ge.insertAdjacentHTML("beforeend", `<div class="rb-gname">${esc(g.name)}</div>`);
      body.appendChild(ge);
    }
    this.update();
  }
  ico(name, big) {
    const svg = typeof name === "string" && name.startsWith("<") ? name : icon(this.set, name);
    return svg ? `<span class="rb-ico${big ? " big" : ""}">${svg}</span>` : "";
  }
  item(it) {
    const mk = (tag, cls, html) => { const e = document.createElement(tag); e.className = cls; e.innerHTML = html; return e; };
    switch (it.t) {
      case "big": {
        const b = mk("button", "rb-big", `${this.ico(it.icon, true) || `<span class="rb-ico big rb-letter">${esc((it.label || "?")[0])}</span>`}<span class="rb-lbl">${esc(it.label)}${it.menu ? " ▾" : ""}</span>`);
        b.title = it.title || it.label || it.cmd;
        this.wire(b, it);
        return b;
      }
      case "small": {
        const iconHtml = this.ico(it.icon, false);
        const b = mk("button", "rb-small" + (it.label && !it.iconOnly ? "" : " io"), `${iconHtml}${it.iconOnly && iconHtml ? "" : `<span class="rb-lbl">${esc(it.label || it.cmd)}</span>`}${it.menu ? `<span class="rb-caret">▾</span>` : ""}`);
        b.title = it.title || it.label || it.cmd;
        this.wire(b, it);
        return b;
      }
      case "stack": case "row": {
        const e = mk("div", it.t === "stack" ? "rb-stack" : "rb-row", "");
        for (const x of it.items) e.appendChild(this.item(x));
        return e;
      }
      case "rows": {
        const e = mk("div", "rb-rows", "");
        for (const r of it.rows) { const row = mk("div", "rb-row", ""); for (const x of r) row.appendChild(this.item(x)); e.appendChild(row); }
        return e;
      }
      case "select": {
        const s = document.createElement("select");
        s.className = "rb-select " + (it.cls || "");
        if (it.width) s.style.width = it.width + "px";
        s.title = it.title || "";
        const fill = () => {
          const opts = typeof it.options === "function" ? it.options() : it.options;
          s.innerHTML = (it.placeholder ? `<option value="">${esc(it.placeholder)}</option>` : "") + opts.map((o) => Array.isArray(o) ? `<option value="${esc(o[0])}">${esc(o[1])}</option>` : `<option>${esc(o)}</option>`).join("");
        };
        fill();
        s._fill = fill; s._it = it;
        s.addEventListener("focus", () => { const v = s.value; fill(); s.value = v; });
        s.addEventListener("change", () => { const v = s.value; if (v !== "") it.pick(v); if (it.placeholder) s.value = ""; this.focus?.(); });
        return s;
      }
      case "color": {
        const l = mk("label", "rb-color", `${this.ico(it.icon, false) || `<span class="rb-a">A</span>`}<span class="rb-bar" style="background:${it.value || "#c00000"}"></span><input type="color" value="${it.value || "#c00000"}">`);
        l.title = it.title || "";
        const inp = l.querySelector("input");
        inp.addEventListener("change", () => { l.querySelector(".rb-bar").style.background = inp.value; it.pick(inp.value); this.focus?.(); });
        return l;
      }
      case "gallery": {
        const e = mk("div", "rb-gallery", "");
        e._it = it;
        const fill = () => {
          e.innerHTML = (it.items() || []).map((g, i) => `<div class="rb-gal-item" data-i="${i}" title="${esc(g.label)}"><div class="rb-gal-prev" style="${g.style || ""}">${esc(g.preview || "AaBbCcDd")}</div><div class="rb-gal-name">${esc(g.label)}</div></div>`).join("");
        };
        fill();
        e._fill = fill;
        e.addEventListener("click", (ev) => { const x = ev.target.closest(".rb-gal-item"); if (!x) return; const g = it.items()[+x.dataset.i]; if (g) { this.exec(g.cmd, g.params || {}); } });
        return e;
      }
      case "custom": return it.el();
      default: return document.createElement("span");
    }
  }
  wire(b, it) {
    b._it = it;
    b.addEventListener("click", (e) => {
      const r = b.getBoundingClientRect();
      if (it.menu && ((!it.cmd && !it.action) || e.target.closest(".rb-caret") || (it.t === "big" && e.clientY - r.top > r.height * 0.55))) return this.menu(b, it.menu);
      if (it.action) return it.action();
      if (it.cmd) this.exec(it.cmd, typeof it.params === "function" ? it.params() : it.params || {});
    });
  }
  async exec(id, params = {}) {
    const c = this.commands.get(id) || { id, label: id, params: "" };
    const p = await askParams(c, params, this.auto || []);
    if (p == null) return this.focus?.();
    await this.run(id, p);
    this.focus?.();
  }
  menu(anchor, items) {
    document.querySelectorAll(".rb-menu").forEach((x) => x.remove());
    const m = document.createElement("div");
    m.className = "rb-menu";
    const list = typeof items === "function" ? items() : items;
    m.innerHTML = list.map((x, i) => (x.sep ? `<div class="rb-sep"></div>` : x.header ? `<div class="rb-mh">${esc(x.label)}</div>` : `<div class="rb-mi" data-i="${i}">${this.ico(x.icon, false) || `<span class="rb-ico"></span>`}<span>${esc(x.label)}</span>${x.key ? `<kbd>${esc(x.key)}</kbd>` : ""}</div>`)).join("");
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.min(r.left, innerWidth - m.offsetWidth - 8) + "px";
    m.style.top = Math.min(r.bottom + 2, innerHeight - m.offsetHeight - 8) + "px";
    const close = (e) => { if (!e || !e.target.closest(".rb-menu")) { closing(m); document.removeEventListener("mousedown", close, true); } };
    setTimeout(() => document.addEventListener("mousedown", close, true), 0);
    m.addEventListener("mousedown", (e) => e.preventDefault());
    m.addEventListener("click", (e) => {
      const x = e.target.closest(".rb-mi"); if (!x) return;
      const it = list[+x.dataset.i];
      close();
      if (it.action) it.action(); else if (it.cmd) this.exec(it.cmd, typeof it.params === "function" ? it.params() : it.params || {});
    });
  }
  /** Toggle states and current values from the app's state. */
  update() {
    const st = this.state?.() || {};
    this.el.querySelectorAll(".rb-small, .rb-big").forEach((b) => { const it = b._it; if (it?.on) b.classList.toggle("on", !!it.on(st)); });
    this.el.querySelectorAll(".rb-select").forEach((s) => {
      const it = s._it; if (!it?.value || document.activeElement === s) return;
      const v = it.value(st);
      if (v == null || v === "") { if (!it.placeholder) s.value = ""; return; }
      if (![...s.options].some((o) => o.value === String(v))) s.insertAdjacentHTML("afterbegin", `<option>${esc(v)}</option>`);
      s.value = String(v);
    });
    this.el.querySelectorAll(".rb-gallery").forEach((g) => { const it = g._it; if (it.current) { const cur = it.current(st); g.querySelectorAll(".rb-gal-item").forEach((x) => x.classList.toggle("on", it.items()[+x.dataset.i]?.label === cur)); } });
  }
  refreshLists() { this.el.querySelectorAll(".rb-gallery").forEach((g) => g._fill?.()); this.update(); }
}

/** A command catalogue as a Map, plus its tab paths. */
export function catalog(list, pathOf) {
  const map = new Map();
  const cmds = list.map((c) => ({ ...c, path: pathOf(c) }));
  for (const c of cmds) map.set(c.id, c);
  return { map, cmds };
}

/** Choose an icon for a command id from an icon set by name likeness. */
export function iconMatcher(set, overrides = {}) {
  const names = Object.keys(ICONS?.[set] || {});
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const byNorm = new Map(names.map((n) => [norm(n), n]));
  return (id) => {
    if (overrides[id]) return overrides[id];
    const parts = id.split(".");
    const last = parts[parts.length - 1];
    for (const k of [last, parts.join(""), last.replace(/^(insert|add|toggle|show|set)/i, ""), last.replace(/s$/, "")]) {
      const n = byNorm.get(norm(k));
      if (n) return n;
    }
    return null;
  };
}

/** "Search every command…" box for the right of the tab row. */
export function tellBox(rb, placeholder = "Search every command… (Alt+Q)") {
  const box = document.createElement("div");
  box.className = "rb-tell";
  box.innerHTML = `<span class="rb-ico">${'<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m20 20-4-4" stroke="currentColor" stroke-width="2"/></svg>'}</span><input spellcheck="false" placeholder="${esc(placeholder)}"><div class="rb-tell-list" hidden></div>`;
  const inp = box.querySelector("input"), list = box.querySelector(".rb-tell-list");
  const all = () => [...rb.commands.values()].filter((c) => !UI_ONLY.test(c.id));
  const show = () => {
    const q = inp.value.trim().toLowerCase();
    const hits = all().filter((c) => !q || `${c.label} ${(c.path || []).join(" ")} ${c.id}`.toLowerCase().includes(q)).slice(0, 80);
    list.innerHTML = hits.map((c) => `<div class="rb-tell-it" data-id="${esc(c.id)}"><b>${esc(c.label)}</b><small>${esc((c.path || []).join(" › "))}</small></div>`).join("") || `<div class="note" style="padding:8px">No command</div>`;
    list.hidden = false;
  };
  inp.addEventListener("focus", show);
  inp.addEventListener("input", show);
  inp.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 150));
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { inp.blur(); rb.focus?.(); }
    if (e.key === "Enter") { const f = list.querySelector(".rb-tell-it"); if (f) { inp.value = ""; list.hidden = true; rb.exec(f.dataset.id); } }
  });
  list.addEventListener("mousedown", (e) => { const it = e.target.closest(".rb-tell-it"); if (it) { e.preventDefault(); inp.value = ""; list.hidden = true; rb.exec(it.dataset.id); } });
  box.focusSearch = () => inp.focus();
  return box;
}

/** A menu leaves with a short fade (it no longer takes clicks meanwhile). */
export function closing(m) {
  if (!m?.isConnected || m.classList.contains("out")) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { m.remove(); return; }
  m.classList.add("out");
  m.addEventListener("animationend", () => m.remove(), { once: true });
  setTimeout(() => m.remove(), 200);
}
