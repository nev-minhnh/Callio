import { decodeText, fence, fromBase64, ConvertError, joinBlocks } from "./util.js";

const src = (s) => (Array.isArray(s) ? s.join("") : s || "");
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export async function convertIpynb(ctx) {
  let nb;
  try { nb = JSON.parse(decodeText(ctx.bytes)); }
  catch { throw new ConvertError("The notebook is not valid JSON."); }
  const lang = (nb.metadata?.kernelspec?.language || nb.metadata?.language_info?.name || "python").toLowerCase();
  const cells = nb.cells || nb.worksheets?.[0]?.cells || [];
  const blocks = [];
  const { htmlToMarkdown } = await import("./html.js");
  const html = (h) => htmlToMarkdown(h, ctx);
  const img = (b64, type, alt) => ctx.images.add(fromBase64(src(b64)), type, alt);
  cells.forEach((cell, n) => {
    const text = src(cell.source ?? cell.input).replace(/\s+$/, "");
    if (cell.cell_type === "markdown") {
      let md = text;
      // inline attachments: ![x](attachment:name.png)
      md = md.replace(/!\[([^\]]*)\]\(attachment:([^)\s]+)\)/g, (m, alt, file) => {
        const att = cell.attachments?.[file];
        if (!att) return m;
        const type = Object.keys(att)[0];
        return img(att[type], type, alt || file);
      });
      blocks.push(md);
    } else if (cell.cell_type === "code") {
      if (text) blocks.push(fence(text, lang));
      for (const out of cell.outputs || []) blocks.push(...renderOutput(out, img, html));
    } else if (cell.cell_type === "raw" || cell.cell_type === "heading") {
      if (cell.cell_type === "heading") blocks.push("#".repeat(cell.level || 1) + " " + text);
      else if (text) blocks.push(fence(text, ""));
    }
    ctx.progress(n + 1, cells.length);
  });
  return joinBlocks(blocks);
}

function renderOutput(out, img, html) {
  const t = out.output_type;
  if (t === "stream") {
    const s = src(out.text).replace(ANSI, "").replace(/\s+$/, "");
    return s ? [fence(s, "text")] : [];
  }
  if (t === "error" || t === "pyerr") {
    const tb = (out.traceback || []).join("\n").replace(ANSI, "");
    return [fence(tb || `${out.ename}: ${out.evalue}`, "text")];
  }
  const data = out.data || out;
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) if (data[type]) return [img(data[type], type, "output")];
  if (data["image/svg+xml"]) return [svgImage(data["image/svg+xml"], img)];
  if (data["text/html"] && /<table/i.test(src(data["text/html"])) && html) return [html(src(data["text/html"]))];
  if (data["text/markdown"]) return [src(data["text/markdown"])];
  if (data["text/latex"]) return [src(data["text/latex"]).trim()];
  if (data["text/plain"] || data.text) {
    const s = src(data["text/plain"] || data.text).replace(ANSI, "").replace(/\s+$/, "");
    return s ? [fence(s, "text")] : [];
  }
  if (data["text/html"]) return [html ? html(src(data["text/html"])) : src(data["text/html"])];
  return [];
}

function svgImage(svg, img) {
  const bytes = new TextEncoder().encode(src(svg));
  let b64 = "";
  for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
  return img(btoa(b64), "image/svg+xml", "output");
}
