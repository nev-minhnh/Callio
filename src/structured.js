// Beautify, minify and check structured text: JSON (and JSON with comments), XML, YAML, and —
// through js-beautify — HTML, CSS and JavaScript. Formatting never changes the data: numbers,
// strings and comments are kept as written; only whitespace and indentation change.

const ext = (name) => (name || "").toLowerCase().split(/[\\/]/).pop().split(".").pop();

export const JSON_EXT = ["json", "jsonc", "json5", "geojson", "webmanifest", "har", "jsonl", "ndjson", "babelrc", "eslintrc", "prettierrc", "code-workspace", "topojson", "jsonld", "ipynb"];
export const XML_EXT = ["xml", "svg", "xsd", "xsl", "xslt", "plist", "csproj", "vbproj", "fsproj", "vcxproj", "props", "targets", "config", "resx", "xaml", "axaml", "kml", "gpx", "rss", "atom", "wsdl", "pom", "fxml", "xlf", "xliff", "nuspec", "manifest", "tmx", "graphml", "drawio", "dae", "xhtml", "storyboard", "xib", "sitemap", "opf", "ncx"];
export const YAML_EXT = ["yaml", "yml"];
const HTML_EXT = ["html", "htm", "vue", "svelte", "hbs", "handlebars", "ejs", "njk", "jinja", "twig", "cshtml", "razor", "aspx", "jsp"];
const CSS_EXT = ["css", "scss", "less", "sass"];
const JS_EXT = ["js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts"];

/** "json" | "xml" | "yaml" | "html" | "css" | "js" | null — which formatter fits a file. */
export function formatKind(name) {
  const e = ext(name);
  const base = (name || "").toLowerCase().split(/[\\/]/).pop();
  if (JSON_EXT.includes(e) || /^\.?(babelrc|eslintrc|prettierrc|jshintrc|swcrc)$/.test(base)) return e === "jsonl" || e === "ndjson" ? "jsonl" : "json";
  if (XML_EXT.includes(e)) return "xml";
  if (YAML_EXT.includes(e)) return "yaml";
  if (HTML_EXT.includes(e)) return "html";
  if (CSS_EXT.includes(e) && e !== "sass") return "css";
  if (JS_EXT.includes(e)) return "js";
  return null;
}
/** JSON flavours that allow comments and trailing commas. */
export const allowsComments = (name) => /\.(jsonc|json5|code-workspace)$|(^|[\\/])(tsconfig|jsconfig)[^\\/]*\.json$|[\\/]\.vscode[\\/][^\\/]*\.json$|\.?(babelrc|eslintrc)(\.json)?$/i.test(name || "");

const unit = (indent) => (indent === "tab" ? "\t" : " ".repeat(+indent || 2));

/** A problem found in the text: positions are character offsets. */
export class ParseError extends Error {
  constructor(message, from, to = from + 1) { super(message); this.from = from; this.to = to; }
}

// ---------------------------------------------------------------- JSON
function lexJson(text, comments) {
  const toks = [];
  const n = text.length;
  let i = 0, nl = 0;
  while (i < n) {
    const c = text[i];
    if (c === "\n") { nl++; i++; continue; }
    if (c === " " || c === "\t" || c === "\r" || c === "﻿") { i++; continue; }
    const from = i;
    if (c === "{" || c === "}" || c === "[" || c === "]" || c === ":" || c === ",") { toks.push({ t: c, v: c, from, to: i + 1, nl }); i++; nl = 0; continue; }
    if (c === '"') {
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\") {
          const e = text[i + 1];
          if (e === "u") { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) throw new ParseError("Invalid \\u escape: it needs four hex digits", i, i + 6); i += 6; continue; }
          if (!'"\\/bfnrt'.includes(e)) throw new ParseError(`Invalid escape "\\${e ?? ""}" in a string`, i, i + 2);
          i += 2; continue;
        }
        if (text.charCodeAt(i) < 0x20) throw new ParseError(text[i] === "\n" ? "Unterminated string (a line break inside a string must be written \\n)" : "Control character inside a string", i);
        i++;
      }
      if (i >= n) throw new ParseError("Unterminated string", from, n);
      i++;
      toks.push({ t: "str", v: text.slice(from, i), from, to: i, nl }); nl = 0; continue;
    }
    if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      let end;
      if (text[i + 1] === "/") { end = text.indexOf("\n", i); if (end < 0) end = n; while (end > i && text[end - 1] === "\r") end--; }
      else { end = text.indexOf("*/", i + 2); if (end < 0) throw new ParseError("Unterminated /* comment", i, n); end += 2; }
      if (!comments) throw new ParseError("Comments aren't allowed in JSON (they are in .jsonc files)", i, end);
      toks.push({ t: "comment", v: text.slice(i, end), from: i, to: end, nl, line: text[i + 1] === "/" });
      i = end; nl = 0; continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
      if (!m || /[\w.]/.test(text[i + m[0].length] || "")) {
        const bad = /^[-\w.+]+/.exec(text.slice(i))[0];
        throw new ParseError(`Invalid number "${bad}"`, i, i + bad.length);
      }
      i += m[0].length;
      toks.push({ t: "num", v: m[0], from, to: i, nl }); nl = 0; continue;
    }
    const w = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 64));
    if (w) {
      if (w[0] === "true" || w[0] === "false" || w[0] === "null") { i += w[0].length; toks.push({ t: "lit", v: w[0], from, to: i, nl }); nl = 0; continue; }
      throw new ParseError(`Unexpected "${w[0]}"${/^(NaN|Infinity|undefined)$/.test(w[0]) ? " (not a JSON value)" : " — property names and strings need double quotes"}`, i, i + w[0].length);
    }
    if (c === "'") throw new ParseError("Strings must use double quotes", i);
    throw new ParseError(`Unexpected character "${c}"`, i);
  }
  return toks;
}

/** Check the token structure. Returns the parsed outline: for each value its kind and range. */
function parseJson(toks, text, { comments = false, multi = false } = {}) {
  const v = toks.filter((t) => t.t !== "comment");
  let k = 0;
  const end = text.length;
  const peek = () => v[k];
  const fail = (msg, t) => { throw new ParseError(msg, t ? t.from : end, t ? t.to : end); };
  const warnings = [];
  function value() {
    const t = v[k];
    if (!t) fail("Unexpected end of file: a value is missing");
    if (t.t === "{") {
      k++;
      const keys = new Set();
      if (peek()?.t === "}") { k++; return; }
      for (;;) {
        const key = v[k];
        if (!key) fail("Unexpected end of file inside an object (missing \"}\")", null);
        if (key.t === "}" && comments) { k++; return; } // trailing comma
        if (key.t !== "str") fail(key.t === "}" ? "Trailing comma before \"}\"" : "Expected a property name in double quotes", key);
        const name = key.v;
        if (keys.has(name)) warnings.push(new ParseError(`Duplicate key ${name}`, key.from, key.to));
        keys.add(name);
        k++;
        if (peek()?.t !== ":") fail(`Expected ":" after the property name ${name}`, peek() || null);
        k++;
        value();
        const sep = v[k];
        if (sep?.t === ",") { k++; continue; }
        if (sep?.t === "}") { k++; return; }
        fail(sep ? `Expected "," or "}" after the value of ${name}` : "Unexpected end of file inside an object (missing \"}\")", sep || null);
      }
    }
    if (t.t === "[") {
      k++;
      if (peek()?.t === "]") { k++; return; }
      for (;;) {
        if (peek()?.t === "]" && comments) { k++; return; }
        if (peek()?.t === "]") fail("Trailing comma before \"]\"", peek());
        value();
        const sep = v[k];
        if (sep?.t === ",") { k++; continue; }
        if (sep?.t === "]") { k++; return; }
        fail(sep ? 'Expected "," or "]" in the list' : "Unexpected end of file inside a list (missing \"]\")", sep || null);
      }
    }
    if (t.t === "str" || t.t === "num" || t.t === "lit") { k++; return; }
    fail(`Unexpected "${t.v}"`, t);
  }
  if (!v.length) { if (multi) return warnings; fail("The file is empty — JSON needs a value"); }
  value();
  while (multi && k < v.length) value();
  if (k < v.length) fail(`Unexpected "${v[k].v}" after the end of the JSON value`, v[k]);
  return warnings;
}

export function validateJson(text, { comments = false } = {}) {
  const toks = lexJson(text, comments);
  return parseJson(toks, text, { comments });
}

export function formatJson(text, { indent = 2, comments = false } = {}) {
  const toks = lexJson(text, comments);
  parseJson(toks, text, { comments });
  const ind = unit(indent);
  let out = "", depth = 0, atStart = true, pendingNl = false;
  const write = (s) => { out += s; atStart = false; };
  const newline = () => { out = out.replace(/[ \t]+$/, "") + "\n" + ind.repeat(depth); atStart = true; };
  const closeOf = { "{": "}", "[": "]" };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === "comment") {
      if (t.nl === 0 && out && !atStart) { write(" " + t.v); if (t.line) pendingNl = true; }
      else { if (out) { if (t.nl > 1 && !/\{\s*$|\[\s*$/.test(out)) { newline(); } newline(); } write(t.v); pendingNl = true; }
      continue;
    }
    if (t.t === "}" || t.t === "]") {
      depth--;
      newline(); pendingNl = false;
      write(t.v);
      continue;
    }
    if (pendingNl) { newline(); pendingNl = false; }
    if (t.t === "{" || t.t === "[") {
      if (toks[i + 1]?.t === closeOf[t.t]) { write(t.v + toks[i + 1].v); i++; continue; }
      write(t.v); depth++; pendingNl = true; continue;
    }
    if (t.t === ",") { write(","); pendingNl = true; continue; }
    if (t.t === ":") { write(": "); continue; }
    write(t.v);
  }
  return out.replace(/[ \t]+$/gm, "") + (/\n\s*$/.test(text) || !text ? "\n" : "");
}

export function minifyJson(text, { comments = false } = {}) {
  const toks = lexJson(text, comments);
  parseJson(toks, text, { comments });
  return toks.filter((t) => t.t !== "comment").map((t) => t.v).join("");
}

/** JSON Lines: each line is one value. */
export function validateJsonLines(text) {
  const warnings = [];
  let pos = 0;
  for (const line of text.split("\n")) {
    if (line.trim()) {
      try { warnings.push(...validateJson(line)); }
      catch (e) { if (e instanceof ParseError) throw new ParseError(e.message, pos + e.from, pos + e.to); throw e; }
    }
    pos += line.length + 1;
  }
  return warnings;
}

/** The outline of a JSON text, for the tree view: nodes with ranges. */
export function jsonTree(text, { comments = false } = {}) {
  const toks = lexJson(text, comments).filter((t) => t.t !== "comment");
  let k = 0;
  function value(key) {
    const t = toks[k];
    if (!t) throw new ParseError("Unexpected end of file", text.length);
    if (t.t === "{" || t.t === "[") {
      const obj = t.t === "{";
      const node = { key, type: obj ? "object" : "array", from: t.from, children: [] };
      k++;
      let idx = 0;
      while (toks[k] && toks[k].t !== (obj ? "}" : "]")) {
        if (toks[k].t === ",") { k++; continue; }
        if (obj) {
          const kt = toks[k];
          let name;
          try { name = JSON.parse(kt.v); } catch { name = kt.v; }
          k += 2; // key and ":"
          node.children.push(value(name));
        } else node.children.push(value(idx++));
      }
      node.to = toks[k]?.to ?? text.length;
      k++;
      return node;
    }
    k++;
    let val = t.v;
    if (t.t === "str") { try { val = JSON.parse(t.v); } catch {} }
    return { key, type: t.t === "str" ? "string" : t.t === "num" ? "number" : t.v === "null" ? "null" : "boolean", value: val, raw: t.v, from: t.from, to: t.to };
  }
  return value(null);
}

// ---------------------------------------------------------------- XML
function lexXml(text) {
  const toks = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (text[i] === "<") {
      let end, kind;
      if (text.startsWith("<!--", i)) { end = text.indexOf("-->", i + 4); kind = "comment"; if (end < 0) throw new ParseError("Unterminated comment <!--", i, n); end += 3; }
      else if (text.startsWith("<![CDATA[", i)) { end = text.indexOf("]]>", i); kind = "cdata"; if (end < 0) throw new ParseError("Unterminated <![CDATA[", i, n); end += 3; }
      else if (text.startsWith("<?", i)) { end = text.indexOf("?>", i); kind = "pi"; if (end < 0) throw new ParseError("Unterminated <?", i, n); end += 2; }
      else if (text.startsWith("<!", i)) {
        // <!DOCTYPE …> with an optional [internal subset]
        let j = i + 2, br = 0;
        while (j < n && (text[j] !== ">" || br > 0)) { if (text[j] === "[") br++; else if (text[j] === "]") br--; j++; }
        end = j + 1; kind = "doctype";
      } else {
        let j = i + 1, q = null;
        while (j < n) { const c = text[j]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === ">") break; j++; }
        if (j >= n) throw new ParseError("Unterminated tag", i, n);
        end = j + 1;
        const raw = text.slice(i, end);
        kind = raw[1] === "/" ? "close" : /\/\s*>$/.test(raw) ? "empty" : "open";
        const name = /^<\/?\s*([^\s/>]+)/.exec(raw)?.[1] || "";
        toks.push({ t: kind, v: raw, name, from: i, to: end });
        i = end; continue;
      }
      toks.push({ t: kind, v: text.slice(i, end), from: i, to: end });
      i = end;
    } else {
      const j = text.indexOf("<", i);
      const end = j < 0 ? n : j;
      toks.push({ t: "text", v: text.slice(i, end), from: i, to: end });
      i = end;
    }
  }
  return toks;
}

/** Tidy a tag's inside: one space between attributes, line breaks kept out (unless inside quotes). */
function tidyTag(raw) {
  let out = "", q = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (q) { out += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; out += c; continue; }
    if (/\s/.test(c)) { if (!/\s$/.test(out)) out += " "; continue; }
    out += c;
  }
  return out.replace(/\s+(\/?>)$/, (m, e) => (e === "/>" ? " />" : ">")).replace(/^<\s+/, "<").replace(/\s*=\s*/g, "=");
}

export function validateXml(text) {
  if (!text.trim()) throw new ParseError("The file is empty", 0);
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const err = doc.querySelector("parsererror");
  if (!err) return [];
  const msg = err.textContent || "Not well-formed XML";
  const m = /line (\d+) at column (\d+):\s*([^\n]*)/.exec(msg);
  if (m) {
    const lines = text.split("\n");
    let pos = 0;
    for (let l = 0; l < +m[1] - 1 && l < lines.length; l++) pos += lines[l].length + 1;
    pos += Math.max(0, +m[2] - 1);
    throw new ParseError(m[3].trim().replace(/\.$/, ""), Math.min(pos, text.length), Math.min(pos + 1, text.length));
  }
  throw new ParseError(msg.split("\n")[0], 0);
}

export function formatXml(text, { indent = 2 } = {}) {
  const toks = lexXml(text);
  const ind = unit(indent);
  const lines = [];
  let depth = 0;
  const stack = []; // open element names
  let preserve = 0; // inside xml:space="preserve": copy verbatim
  let raw = "";
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (preserve) {
      raw += t.v;
      if (t.t === "open" && t.name === stack[stack.length - 1]?.name) preserve++;
      if (t.t === "close" && t.name === stack[stack.length - 1]?.name && --preserve === 0) { lines[lines.length - 1] += raw; raw = ""; stack.pop(); depth--; }
      continue;
    }
    if (t.t === "text") {
      const s = t.v.trim();
      if (s) lines.push(ind.repeat(depth) + s.replace(/\s*\n\s*/g, " "));
      continue;
    }
    if (t.t === "close") {
      if (stack.length && stack[stack.length - 1].name !== t.name) throw new ParseError(`</${t.name}> doesn't match <${stack[stack.length - 1].name}>`, t.from, t.to);
      if (!stack.length) throw new ParseError(`</${t.name}> has no opening tag`, t.from, t.to);
      stack.pop();
      depth--;
      lines.push(ind.repeat(depth) + `</${t.name}>`);
      continue;
    }
    if (t.t === "open") {
      const tag = tidyTag(t.v);
      // <a>short text</a> and <a></a> stay on one line
      const nx = toks[i + 1], nx2 = toks[i + 2];
      if (nx?.t === "close" && nx.name === t.name) { lines.push(ind.repeat(depth) + tag + `</${t.name}>`); i++; continue; }
      if (nx?.t === "text" && nx2?.t === "close" && nx2.name === t.name && !nx.v.trim().includes("\n") && nx.v.trim().length < 200) {
        lines.push(ind.repeat(depth) + tag + nx.v.trim() + `</${t.name}>`); i += 2; continue;
      }
      if ((nx?.t === "cdata") && toks[i + 2]?.t === "close" && toks[i + 2].name === t.name) { lines.push(ind.repeat(depth) + tag + nx.v + `</${t.name}>`); i += 2; continue; }
      lines.push(ind.repeat(depth) + tag);
      stack.push({ name: t.name });
      depth++;
      if (/xml:space\s*=\s*["']preserve["']/.test(t.v)) { preserve = 1; raw = ""; }
      continue;
    }
    if (t.t === "empty") { lines.push(ind.repeat(depth) + tidyTag(t.v)); continue; }
    // comments, CDATA, <?…?>, <!DOCTYPE>: kept as written, re-indented
    lines.push(t.v.split("\n").map((l, k) => (k ? l : ind.repeat(depth) + l.trimStart())).join("\n"));
  }
  if (stack.length) throw new ParseError(`<${stack[stack.length - 1].name}> is never closed`, text.length);
  return lines.join("\n") + "\n";
}

export function minifyXml(text) {
  const toks = lexXml(text);
  // whitespace between tags goes; text with content is kept exactly (it may matter)
  return toks.map((t) => (t.t === "text" ? (t.v.trim() ? t.v : "") : t.t === "comment" ? "" : t.t === "open" || t.t === "empty" || t.t === "close" ? tidyTag(t.v) : t.v)).join("");
}

// ---------------------------------------------------------------- YAML
let yamlMod = null;
const loadYaml = async () => (yamlMod ??= await import("yaml"));

function yamlError(e, text) {
  const pos = e.pos?.[0] ?? 0;
  return new ParseError(String(e.message || e).split("\n")[0].replace(/ at line \d+, column \d+:?$/, ""), Math.min(pos, text.length), Math.min(e.pos?.[1] ?? pos + 1, text.length));
}
export async function validateYaml(text) {
  const Y = await loadYaml();
  const docs = Y.parseAllDocuments(text, { prettyErrors: false });
  const list = Array.isArray(docs) ? docs : [docs];
  const warnings = [];
  for (const d of list) {
    if (d.errors?.length) throw yamlError(d.errors[0], text);
    for (const w of d.warnings || []) warnings.push(yamlError(w, text));
  }
  return warnings;
}
export async function formatYaml(text, { indent = 2 } = {}) {
  const Y = await loadYaml();
  const docs = Y.parseAllDocuments(text, { prettyErrors: false });
  const list = Array.isArray(docs) ? docs : [docs];
  for (const d of list) if (d.errors?.length) throw yamlError(d.errors[0], text);
  const n = indent === "tab" ? 2 : +indent || 2;
  return list.map((d, i) => {
    const s = d.toString({ indent: n, lineWidth: 0, minContentWidth: 0, flowCollectionPadding: true });
    return i && !s.startsWith("---") ? "---\n" + s : s;
  }).join("");
}
export async function yamlTree(text) {
  const Y = await loadYaml();
  const doc = Y.parseDocument(text, { prettyErrors: false });
  if (doc.errors?.length) throw yamlError(doc.errors[0], text);
  function walk(node, key) {
    const range = node?.range || [0, 0];
    if (Y.isMap(node)) return { key, type: "object", from: range[0], to: range[1], children: node.items.map((p) => walk(p.value, Y.isScalar(p.key) ? p.key.value : String(p.key))).map((c, i) => (c.from === undefined ? { ...c, from: node.items[i].key?.range?.[0] ?? range[0] } : c)) };
    if (Y.isSeq(node)) return { key, type: "array", from: range[0], to: range[1], children: node.items.map((v, i) => walk(v, i)) };
    if (Y.isScalar(node)) {
      const v = node.value;
      return { key, type: v === null ? "null" : typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string", value: v, raw: v === null ? "null" : typeof v === "string" ? JSON.stringify(v) : String(v), from: range[0], to: range[1] };
    }
    if (Y.isAlias(node)) return { key, type: "string", value: "*" + node.source, raw: "*" + node.source, from: range[0], to: range[1] };
    return { key, type: "null", value: null, raw: "null", from: range[0], to: range[1] };
  }
  return walk(doc.contents, null);
}

// ---------------------------------------------------------------- one entry point
let beautifyMod = null;
const loadBeautify = async () => (beautifyMod ??= (await import("js-beautify")).default);

/** Beautify `text` of file `name`. Throws ParseError for invalid input. */
export async function beautify(text, name, { indent = 2 } = {}) {
  const k = formatKind(name);
  if (k === "json") return formatJson(text, { indent, comments: allowsComments(name) || /\.json5$/i.test(name) });
  if (k === "jsonl") return text.split("\n").map((l) => (l.trim() ? minifyJson(l) : l)).join("\n");
  if (k === "xml") { try { validateXml(text); } catch (e) { if (!/xhtml$/i.test(name)) throw e; } return formatXml(text, { indent }); }
  if (k === "yaml") return formatYaml(text, { indent });
  if (k === "html" || k === "css" || k === "js") {
    const b = await loadBeautify();
    const o = { indent_size: indent === "tab" ? 1 : +indent || 2, indent_char: indent === "tab" ? "\t" : " ", indent_with_tabs: indent === "tab", preserve_newlines: true, max_preserve_newlines: 2, end_with_newline: /\n$/.test(text), wrap_line_length: 0 };
    if (k === "html") return b.html(text, { ...o, indent_inner_html: false, extra_liners: [] });
    if (k === "css") return b.css(text, o);
    return b.js(text, o);
  }
  return reindent(text, guessIndent(text) || 4, indent);
}

export function minify(text, name) {
  const k = formatKind(name);
  if (k === "json" || k === "jsonl") return minifyJson(text, { comments: allowsComments(name) });
  if (k === "xml") return minifyXml(text);
  throw new ParseError("Minify works on JSON and XML files", 0);
}

/** Problems in the text (throws the first error; returns warnings). null: no checker for this file. */
export async function validate(text, name) {
  const k = formatKind(name);
  if (k === "json") return validateJson(text, { comments: allowsComments(name) || /\.json5$/i.test(name) });
  if (k === "jsonl") return validateJsonLines(text);
  if (k === "xml" || (k === "html" && /\.xhtml$/i.test(name))) return validateXml(text);
  if (k === "yaml") return validateYaml(text);
  return null;
}

// ---------------------------------------------------------------- indentation
/** The indentation a text uses: "tab", 2, 4… (null when nothing is indented). */
export function guessIndent(text) {
  let tabs = 0, spaces = 0;
  const diffs = new Map();
  let prev = 0, n = 0;
  for (const line of text.split("\n", 5000)) {
    if (!line.trim()) continue;
    if (++n > 3000) break;
    if (line[0] === "\t") { tabs++; continue; }
    const m = /^ +/.exec(line);
    const w = m ? m[0].length : 0;
    if (w) spaces++;
    const d = Math.abs(w - prev);
    if (d > 0 && d <= 8) diffs.set(d, (diffs.get(d) || 0) + 1);
    prev = w;
  }
  if (tabs > spaces) return "tab";
  if (!spaces) return null;
  const best = [...diffs].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best === 1 ? 2 : best || null;
}

/** Change leading indentation from `from` units to `to` (2, 4 or "tab"). */
export function reindent(text, from, to) {
  const fw = from === "tab" ? 1 : +from || 4;
  const tu = unit(to);
  return text.split("\n").map((line) => {
    const m = /^[ \t]+/.exec(line);
    if (!m) return line;
    // width in units: tabs count as one unit, spaces as 1/fw
    let cols = 0;
    for (const c of m[0]) cols += c === "\t" ? fw : 1;
    const levels = Math.floor(cols / fw), rest = cols % fw;
    return tu.repeat(levels) + " ".repeat(rest) + line.slice(m[0].length);
  }).join("\n");
}

/** Line and column (1-based) of an offset. */
export function lineCol(text, pos) {
  let line = 1, last = 0;
  for (let i = 0; i < pos && i < text.length; i++) if (text.charCodeAt(i) === 10) { line++; last = i + 1; }
  return { line, col: pos - last + 1 };
}

/** The outline of an XML text for the tree view: elements with their attributes and text. */
export function xmlTree(text) {
  validateXml(text);
  const toks = lexXml(text);
  const root = { key: "document", type: "object", from: 0, to: text.length, children: [] };
  const stack = [root];
  const attrs = (raw) => {
    const out = [];
    const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    const inner = raw.replace(/^<\/?\s*[^\s/>]+/, "");
    while ((m = re.exec(inner))) out.push({ key: "@" + m[1], type: "attr", value: m[3] ?? m[4], raw: m[2] });
    return out;
  };
  for (const t of toks) {
    const top = stack[stack.length - 1];
    if (t.t === "open" || t.t === "empty") {
      const node = { key: t.name, type: "element", from: t.from, to: t.to, children: attrs(t.v).map((a) => ({ ...a, from: t.from, to: t.to })) };
      top.children.push(node);
      if (t.t === "open") stack.push(node);
    } else if (t.t === "close") {
      const node = stack.pop();
      if (node) node.to = t.to;
    } else if (t.t === "text" || t.t === "cdata") {
      const v = t.t === "cdata" ? t.v.slice(9, -3) : t.v.trim();
      if (v) top.children.push({ key: "#text", type: "string", value: v, raw: JSON.stringify(v), from: t.from, to: t.to });
    } else if (t.t === "comment") top.children.push({ key: "#comment", type: "comment", value: t.v.slice(4, -3).trim(), from: t.from, to: t.to });
  }
  // an element holding only text shows it as its value
  const fold = (n) => {
    if (!n.children) return;
    n.children.forEach(fold);
    const kids = n.children.filter((c) => c.type !== "attr");
    if (n.type === "element" && kids.length === 1 && kids[0].key === "#text" && n.children.length === 1) { n.value = kids[0].value; n.type = "string"; n.raw = JSON.stringify(n.value); delete n.children; }
  };
  fold(root);
  return root.children.length === 1 ? root.children[0] : root;
}
