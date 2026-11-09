// Mermaid diagrams: .mmd / .mermaid files and ```mermaid blocks in Markdown are drawn in the
// preview (the library loads only when a diagram is on screen). Diagrams follow the theme, and
// can be saved as SVG or PNG.
let lib = null, n = 0;
const cache = new Map(); // source + theme → svg

function dark() {
  const t = document.documentElement.dataset.theme;
  return t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
}

async function load() {
  if (lib) return lib;
  const m = await import("mermaid");
  lib = m.default;
  return lib;
}

function themeVars() {
  const css = getComputedStyle(document.documentElement);
  const v = (k, d) => css.getPropertyValue(k).trim() || d;
  return dark()
    ? { darkMode: true, background: v("--bg", "#0e1814"), primaryColor: "#173a2a", primaryTextColor: "#ebe7da", primaryBorderColor: "#ddb04e", lineColor: "#b1b9ae", secondaryColor: "#2e2a17", tertiaryColor: "#122019", fontFamily: v("--ui-font", "Segoe UI") }
    : { darkMode: false, background: "#ffffff", primaryColor: "#e3efe6", primaryTextColor: "#18221d", primaryBorderColor: "#0f5c3c", lineColor: "#4e5b53", secondaryColor: "#f6ebcf", tertiaryColor: "#f6f3ea", fontFamily: v("--ui-font", "Segoe UI") };
}

/** SVG of one diagram (throws with Mermaid's message when the source is wrong). */
export async function renderMermaid(src) {
  const key = (dark() ? "d|" : "l|") + src;
  if (cache.has(key)) return cache.get(key);
  const m = await load();
  m.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables: themeVars(), flowchart: { htmlLabels: false }, fontFamily: themeVars().fontFamily });
  const id = `mmd-${++n}`;
  try {
    const { svg } = await m.render(id, src);
    if (cache.size > 60) cache.delete(cache.keys().next().value);
    cache.set(key, svg);
    return svg;
  } finally {
    document.getElementById(id)?.remove();
    document.getElementById("d" + id)?.remove();
  }
}

/** Draw every ```mermaid block inside `root` (rendered Markdown). */
export async function drawMermaidBlocks(root) {
  const blocks = [...root.querySelectorAll("pre > code.language-mermaid")];
  for (const code of blocks) {
    const pre = code.parentElement;
    const src = code.textContent;
    const box = document.createElement("div");
    box.className = "mermaid-diagram";
    if (pre.dataset.line) box.dataset.line = pre.dataset.line;
    box._k = pre._k;
    try {
      box.innerHTML = await renderMermaid(src);
    } catch (e) {
      box.classList.add("mermaid-error");
      box.innerHTML = `<b>This diagram has a problem</b><pre></pre>`;
      box.querySelector("pre").textContent = String(e?.message || e).replace(/^Error:\s*/, "").slice(0, 600);
    }
    if (pre.isConnected) pre.replaceWith(box);
  }
}

/** The diagram on screen as an SVG string or a PNG blob. */
export function diagramSvg(root) {
  const svg = root.querySelector(".mermaid-diagram svg");
  if (!svg) return null;
  const c = svg.cloneNode(true);
  c.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + c.outerHTML;
}
export async function diagramPng(root, scale = 2) {
  const svg = root.querySelector(".mermaid-diagram svg");
  if (!svg) return null;
  const r = svg.getBoundingClientRect();
  const w = Math.ceil((svg.viewBox?.baseVal?.width || r.width) * scale), h = Math.ceil((svg.viewBox?.baseVal?.height || r.height) * scale);
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(diagramSvg(root));
  await img.decode();
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = dark() ? "#0e1814" : "#ffffff";
  g.fillRect(0, 0, w, h);
  g.drawImage(img, 0, 0, w, h);
  return new Promise((res) => c.toBlob(res, "image/png"));
}
