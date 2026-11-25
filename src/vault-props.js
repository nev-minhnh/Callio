// The Properties block (a note's YAML frontmatter) as typed fields: text, list, number, check box,
// date. Used in the preview's header and in the visual editor. Reading and writing the YAML is done
// by Rust (`vault_props_*`), which changes only the line of the property you edit and leaves every
// other line exactly as it was, so Obsidian sees the same file.
import { call } from "./api.js";
import { V } from "./vault-state.js";
import { t } from "./i18n.js";

const OPEN_KEY = "callio.vault.propsOpen";
const isOpen = () => { try { return localStorage.getItem(OPEN_KEY) !== "0"; } catch { return true; } };
const setOpen = (v) => { try { localStorage.setItem(OPEN_KEY, v ? "1" : "0"); } catch { /* no storage */ } };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const TYPES = [["text", "Text"], ["list", "List"], ["number", "Number"], ["checkbox", "Checkbox"], ["date", "Date"], ["datetime", "Date & time"]];

/**
 * Draw the properties of `text` into `host`.
 *   getText()  the note's current full text (an edit is applied to it, not to what was drawn)
 *   apply(t)   put the new text in the editor
 */
export async function buildProps(host, { text, getText, apply, sourceBtn }) {
  const rows = await call("vault_props_get", { args: { root: V.root, text, types: V.config.types || {} } });
  host.classList.add("vp");
  host.classList.toggle("vp-empty", !rows.length);
  host.replaceChildren();
  const open = isOpen();
  const head = el("div", "vp-head");
  const tog = el("button", "vp-toggle"); tog.type = "button";
  tog.append(el("span", "vp-caret", open ? "▾" : "▸"), el("span", "vp-title", t("Properties")));
  tog.onclick = () => { setOpen(!isOpen()); host.classList.toggle("collapsed", !isOpen()); tog.firstChild.textContent = isOpen() ? "▾" : "▸"; };
  head.append(tog);
  if (sourceBtn) { const s = el("button", "vp-src", t("Source")); s.type = "button"; s.onclick = sourceBtn; head.append(s); }
  host.classList.toggle("collapsed", !open);
  const body = el("div", "vp-body");
  host.append(head, body);

  const commit = async (key, value, type) => {
    const cur = getText();
    const next = await call("vault_props_set", { args: { root: V.root, text: cur, key, value, type } });
    if (next !== cur) apply(next);
  };
  const drop = async (key) => { const cur = getText(); const next = await call("vault_props_remove", { args: { root: V.root, text: cur, key } }); if (next !== cur) apply(next); };
  const rename = async (key, newKey) => { const cur = getText(); const next = await call("vault_props_rename", { args: { root: V.root, text: cur, key, newKey } }); if (next !== cur) apply(next); };

  for (const p of rows) {
    const row = el("div", "vp-row"); row.dataset.key = p.key; row.dataset.type = p.type;
    const k = el("input", "vp-key"); k.value = p.key; k.title = t("Property name"); k.setAttribute("aria-label", t("Property name"));
    k.onchange = () => { const nk = k.value.trim(); if (nk && nk !== p.key) rename(p.key, nk); else k.value = p.key; };
    const v = el("div", "vp-val");
    v.append(widget(p, (val) => commit(p.key, val, p.type)));
    const x = el("button", "vp-del", "×"); x.type = "button"; x.title = t("Remove"); x.setAttribute("aria-label", t("Remove"));
    x.onclick = () => drop(p.key);
    row.append(k, v, x);
    body.append(row);
  }
  // + Add property
  const add = el("div", "vp-add");
  const btn = el("button", "vp-add-btn", "+ " + t("Add property")); btn.type = "button";
  btn.onclick = () => {
    const name = el("input", "vp-key"); name.placeholder = t("Property name"); name.setAttribute("aria-label", t("Property name"));
    const sel = el("select", "vp-type"); for (const [v, l] of TYPES) sel.append(new Option(t(l), v));
    const ok = el("button", "vp-ok", t("Add")); ok.type = "button";
    const go = () => {
      const key = name.value.trim(); if (!key) return;
      const ty = sel.value;
      const init = ty === "list" ? [] : ty === "number" ? 0 : ty === "checkbox" ? false : ty === "date" ? today() : ty === "datetime" ? today() + "T00:00" : "";
      commit(key, init, ty);
    };
    ok.onclick = go;
    name.onkeydown = (e) => { if (e.key === "Enter") go(); if (e.key === "Escape") add.replaceChildren(btn); e.stopPropagation(); };
    add.replaceChildren(name, sel, ok);
    name.focus();
  };
  add.append(btn);
  body.append(add);
}

function widget(p, set) {
  switch (p.type) {
    case "checkbox": {
      const c = el("input", "vp-check"); c.type = "checkbox"; c.checked = p.value === true;
      c.onchange = () => set(c.checked);
      return c;
    }
    case "number": {
      const n = el("input", "vp-in"); n.type = "number"; n.step = "any"; n.value = p.value ?? "";
      n.onchange = () => set(n.value === "" ? null : Number(n.value));
      return n;
    }
    case "date": case "datetime": {
      const d = el("input", "vp-in"); d.type = p.type === "date" ? "date" : "datetime-local"; d.value = typeof p.value === "string" ? p.value.slice(0, p.type === "date" ? 10 : 16) : "";
      d.onchange = () => set(d.value || null);
      return d;
    }
    case "list": {
      const box = el("div", "vp-chips");
      let items = Array.isArray(p.value) ? [...p.value] : p.value ? [String(p.value)] : [];
      const draw = () => {
        box.replaceChildren();
        items.forEach((it, i) => {
          const chip = el("span", "vp-chip"); chip.append(el("span", null, it));
          const x = el("button", "vp-chip-x", "×"); x.type = "button"; x.setAttribute("aria-label", t("Remove"));
          x.onclick = () => { items = items.filter((_, j) => j !== i); set(items); };
          chip.append(x); box.append(chip);
        });
        const inp = el("input", "vp-chip-in"); inp.setAttribute("aria-label", t("Add"));
        const take = () => { const v = inp.value.trim().replace(/^#/, ""); inp.value = ""; if (v) { items = [...items, v]; set(items); } };
        inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter" || e.key === ",") { e.preventDefault(); take(); } else if (e.key === "Backspace" && !inp.value && items.length) { items = items.slice(0, -1); set(items); } };
        inp.onblur = take;
        box.append(inp);
      };
      draw();
      return box;
    }
    case "other": return el("code", "vp-raw", String(p.value ?? ""));
    default: {
      const i = el("input", "vp-in"); i.value = p.value ?? "";
      i.onchange = () => set(i.value);
      return i;
    }
  }
}

/** The header block of the preview: the placeholder `markdown-it` left for the frontmatter. */
export async function mountPreviewProps(host) {
  const { getView, replaceDocAsStep } = await import("./editor.js");
  buildProps(host, {
    text: host.dataset.fm || "",
    getText: () => getView().state.doc.toString(),
    apply: (next) => { const v = getView(); const spec = replaceDocAsStep(v.state, next, "Edit property"); if (spec) v.dispatch(spec); },
  }).catch((e) => console.warn(e));
}
