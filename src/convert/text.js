import { decodeText, fence, escapeLineStart, escapeMd } from "./util.js";

const PROSE = new Set(["txt", "text", "log", "rst", "adoc", "org"]);
const MARKDOWN = new Set(["md", "markdown", "mdown", "mkd"]);

export async function convertText(ctx) {
  const text = decodeText(ctx.bytes);
  if (MARKDOWN.has(ctx.ext)) return text;
  if (!PROSE.has(ctx.ext)) return fence(text, ctx.lang || "");
  if (ctx.ext === "log") return fence(text, "text");
  // plain text: paragraphs as-is (blank-line separated); keep line breaks inside a paragraph
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t]+$/gm, "").replace(/^\n+|\n+$/g, ""))
    .filter((p) => p.trim())
    .map((p) => {
      const lines = p.split("\n");
      // preformatted-looking blocks (indented / aligned columns) stay verbatim
      if (lines.length > 1 && lines.every((l) => /^( {4}|\t)/.test(l) || / {3,}\S/.test(l.trim()))) return fence(p, "text");
      return lines.map((l) => escapeLineStart(escapeMd(l.trim()))).join("\\\n");
    })
    .join("\n\n");
}
