// Right-click menus with submenus, shortcuts and icons (tabs, files, editors).
// items: [{ label, key?, icon?, action?, disabled?, sub?: items }, "-", { header: "…" }]
import { ic } from "./icons.js";

let open = null;

export function closeContextMenu() {
  if (!open) return;
  open.forEach((m) => m.remove());
  open = null;
  document.removeEventListener("pointerdown", away, true);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("blur", closeContextMenu);
}
function away(e) { if (open && !open.some((m) => m.contains(e.target))) closeContextMenu(); }
function onKey(e) {
  if (!open) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeContextMenu(); return; }
  const m = open[open.length - 1];
  const btns = [...m.querySelectorAll("button:not([disabled])")];
  const i = btns.indexOf(document.activeElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = btns.length;
    btns[(i + (e.key === "ArrowDown" ? 1 : -1) + n) % n]?.focus();
  } else if (e.key === "ArrowRight" && document.activeElement?.classList.contains("has-sub")) {
    e.preventDefault(); document.activeElement.dispatchEvent(new Event("pointerenter")); open[open.length - 1]?.querySelector("button:not([disabled])")?.focus();
  } else if (e.key === "ArrowLeft" && open.length > 1) {
    e.preventDefault(); open.pop().remove(); open[open.length - 1].querySelector(".has-sub.open")?.focus();
  }
}

function build(items, level) {
  const m = document.createElement("div");
  m.className = "menu ctx-menu" + (level ? " ctx-sub" : "");
  m.setAttribute("role", "menu");
  let pendingSep = false;
  for (const it of items) {
    if (!it) continue;
    if (it === "-") { pendingSep = m.childElementCount > 0; continue; }
    if (pendingSep) { m.appendChild(document.createElement("hr")); pendingSep = false; }
    if (it.header) { const h = document.createElement("div"); h.className = "menu-h"; h.textContent = it.header; m.appendChild(h); continue; }
    const b = document.createElement("button");
    b.setAttribute("role", "menuitem");
    b.innerHTML = `<span class="fi">${it.icon ? (it.icon.startsWith("<") ? it.icon : ic(it.icon)) : ""}</span><span class="ml"></span>${it.sub ? `<span class="sub-caret">${ic("chevron-right")}</span>` : `<kbd>${it.key || ""}</kbd>`}`;
    b.querySelector(".ml").textContent = it.label;
    if (it.disabled) b.disabled = true;
    if (it.checked) b.classList.add("checked");
    if (it.sub) {
      b.classList.add("has-sub");
      const openSub = () => {
        while (open.length > level + 1) open.pop().remove();
        for (const x of m.querySelectorAll(".has-sub.open")) x.classList.remove("open");
        b.classList.add("open");
        const sm = build(it.sub, level + 1);
        document.body.appendChild(sm);
        open.push(sm);
        const r = b.getBoundingClientRect();
        const w = sm.offsetWidth, h = sm.offsetHeight;
        let x = r.right - 4, y = r.top - 6;
        if (x + w > innerWidth - 8) x = Math.max(8, r.left - w + 4);
        if (y + h > innerHeight - 8) y = Math.max(8, innerHeight - h - 8);
        sm.style.left = x + "px"; sm.style.top = y + "px";
      };
      b.addEventListener("pointerenter", () => { clearTimeout(b._t); b._t = setTimeout(openSub, 90); });
      b.addEventListener("pointerleave", () => clearTimeout(b._t));
      b.onclick = (e) => { e.stopPropagation(); openSub(); };
    } else {
      b.addEventListener("pointerenter", () => { while (open && open.length > level + 1) open.pop().remove(); for (const x of m.querySelectorAll(".has-sub.open")) x.classList.remove("open"); });
      b.onclick = (e) => {
        e.stopPropagation();
        closeContextMenu();
        try { const r = it.action?.(); if (r?.catch) r.catch((er) => console.error(er)); } catch (er) { console.error(er); }
      };
    }
    m.appendChild(b);
  }
  return m;
}

/** Show a menu at the mouse (or at {x, y}). */
export function showContextMenu(e, items) {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  closeContextMenu();
  document.querySelector(".ctx-menu")?.remove();
  const m = build(items, 0);
  document.body.appendChild(m);
  open = [m];
  const w = m.offsetWidth, h = m.offsetHeight;
  const x0 = e?.clientX ?? e?.x ?? 100, y0 = e?.clientY ?? e?.y ?? 100;
  m.style.left = Math.max(8, Math.min(x0, innerWidth - w - 8)) + "px";
  m.style.top = Math.max(8, Math.min(y0, innerHeight - h - 8)) + "px";
  document.addEventListener("pointerdown", away, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", closeContextMenu);
  return m;
}
