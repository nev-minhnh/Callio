import { ConvertError, mime } from "./util.js";

// Image files: run the OCR callback on the decoded image.
export async function convertImage(ctx) {
  if (!ctx.ocr) throw new ConvertError("Images can only be converted with OCR, which isn't available.");
  const type = mime(ctx.name);
  const blob = new Blob([ctx.bytes], { type });
  let canvas = null, width = 0, height = 0;
  try {
    const bmp = await createImageBitmap(blob);
    width = bmp.width; height = bmp.height;
    canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
    const g = canvas.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, width, height);
    g.drawImage(bmp, 0, 0);
    bmp.close?.();
  } catch {
    // e.g. TIFF isn't decodable by Chromium; hand over the raw blob
    ctx.warnings.push(`Couldn't decode ${ctx.name} in the browser; passing the raw file to OCR.`);
  }
  ctx.progress(0, 1, "OCR");
  const text = await ctx.ocr({ canvas, blob, width, height, pageNumber: 1 });
  ctx.progress(1, 1, "OCR");
  if (text && typeof text === "object" && Array.isArray(text.lines)) {
    const { layoutToMarkdown } = await import("./layout.js");
    const md = layoutToMarkdown([text]);
    if (!md.trim()) ctx.warnings.push("OCR found no text in the image.");
    return md;
  }
  if (!text || !String(text).trim()) ctx.warnings.push("OCR found no text in the image.");
  return String(text || "");
}
