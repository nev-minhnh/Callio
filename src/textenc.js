// Text encodings, in JavaScript: the names Callio uses for them, and decoding/encoding for the
// browser preview (the desktop app does the same in Rust with encoding_rs).

/** The encodings the status bar offers (like Notepad++'s Encoding menu). */
export const ENCODINGS = {
  main: [
    ["ansi", "ANSI"], ["utf8", "UTF-8"], ["utf8bom", "UTF-8-BOM"], ["utf16be", "UTF-16 BE BOM"], ["utf16le", "UTF-16 LE BOM"],
  ],
  sets: [
    ["Arabic", [["windows-1256", "Windows-1256"], ["iso-8859-6", "ISO 8859-6"]]],
    ["Baltic", [["windows-1257", "Windows-1257"], ["iso-8859-4", "ISO 8859-4"], ["iso-8859-13", "ISO 8859-13"]]],
    ["Central European", [["windows-1250", "Windows-1250"], ["iso-8859-2", "ISO 8859-2"]]],
    ["Chinese", [["gbk", "GBK (Simplified)"], ["gb18030", "GB18030"], ["big5", "Big5 (Traditional)"]]],
    ["Cyrillic", [["windows-1251", "Windows-1251"], ["koi8-r", "KOI8-R"], ["koi8-u", "KOI8-U"], ["iso-8859-5", "ISO 8859-5"], ["ibm866", "OEM 866"]]],
    ["Greek", [["windows-1253", "Windows-1253"], ["iso-8859-7", "ISO 8859-7"]]],
    ["Hebrew", [["windows-1255", "Windows-1255"], ["iso-8859-8", "ISO 8859-8"]]],
    ["Japanese", [["shift_jis", "Shift-JIS"], ["euc-jp", "EUC-JP"], ["iso-2022-jp", "ISO-2022-JP"]]],
    ["Korean", [["euc-kr", "EUC-KR (Windows-949)"]]],
    ["Thai", [["windows-874", "Windows-874 (TIS-620)"]]],
    ["Turkish", [["windows-1254", "Windows-1254"], ["iso-8859-9", "ISO 8859-9"]]],
    ["Vietnamese", [["windows-1258", "Windows-1258"]]],
    ["Western European", [["windows-1252", "Windows-1252"], ["iso-8859-1", "ISO 8859-1 (Latin-1)"], ["iso-8859-15", "ISO 8859-15"], ["macintosh", "Mac Roman"]]],
  ],
};

let ansi = "windows-1252";
export const setAnsi = (a) => { if (a) ansi = a; };
export const getAnsi = () => ansi;

/** A short name for the status bar. */
export function encodingName(enc) {
  if (!enc) return "UTF-8";
  for (const [k, n] of ENCODINGS.main) if (k === enc) return n;
  if (enc === "latin1") return "ISO 8859-1";
  if (enc === ansi) return "ANSI";
  for (const [, list] of ENCODINGS.sets) for (const [k, n] of list) if (k === enc) return n;
  return enc.toUpperCase();
}
/** "ansi" means the system's code page. */
export const resolveEncoding = (enc) => (enc === "ansi" ? ansi : enc);

export function decodeBytes(bytes, enc, ansiLabel = ansi) {
  if (!enc) {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) enc = "utf8bom";
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) enc = "utf16le";
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) enc = "utf16be";
    else { try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); enc = "utf8"; } catch { enc = ansiLabel; } }
  }
  const label = enc === "utf8" || enc === "utf8bom" ? "utf-8" : enc === "utf16le" ? "utf-16le" : enc === "utf16be" ? "utf-16be" : enc === "latin1" ? "iso-8859-1" : enc;
  let text;
  try { text = new TextDecoder(label).decode(bytes); } catch { text = new TextDecoder("windows-1252").decode(bytes); }
  return [text, enc];
}

const singleByteMaps = new Map();
function reverseMap(label) {
  if (singleByteMaps.has(label)) return singleByteMaps.get(label);
  const m = new Map();
  const dec = new TextDecoder(label);
  for (let b = 0; b < 256; b++) { const ch = dec.decode(new Uint8Array([b])); if (ch !== "�") m.set(ch, b); }
  singleByteMaps.set(label, m);
  return m;
}
export function encodeText(text, enc) {
  enc = enc || "utf8";
  if (enc === "utf8") return new TextEncoder().encode(text);
  if (enc === "utf8bom") return new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
  if (enc === "utf16le" || enc === "utf16be") {
    const out = new Uint8Array(2 + text.length * 2);
    out[0] = enc === "utf16le" ? 0xff : 0xfe; out[1] = enc === "utf16le" ? 0xfe : 0xff;
    for (let i = 0; i < text.length; i++) {
      const u = text.charCodeAt(i);
      if (enc === "utf16le") { out[2 + i * 2] = u & 255; out[3 + i * 2] = u >> 8; } else { out[2 + i * 2] = u >> 8; out[3 + i * 2] = u & 255; }
    }
    return out;
  }
  const m = reverseMap(enc === "latin1" ? "iso-8859-1" : enc);
  const out = [];
  for (const ch of text) {
    const b = m.get(ch);
    if (b === undefined) throw `UNMAPPABLE:${ch}`;
    out.push(b);
  }
  return new Uint8Array(out);
}

/** Line endings: which one the text mostly uses. */
export function detectEol(text) {
  let crlf = 0, lf = 0, cr = 0;
  const n = Math.min(text.length, 2_000_000);
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) { if (text.charCodeAt(i + 1) === 10) { crlf++; i++; } else cr++; }
    else if (c === 10) lf++;
  }
  if (!crlf && !lf && !cr) return null;
  return crlf >= lf && crlf >= cr ? "\r\n" : cr > lf ? "\r" : "\n";
}
export const EOL_NAMES = { "\r\n": "Windows (CR LF)", "\n": "Unix (LF)", "\r": "Macintosh (CR)" };
