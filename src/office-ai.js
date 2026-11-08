// The AI's hands on Word documents, spreadsheets and PDFs (tools office_read, office_commands,
// word_edit, sheet_edit, pdf_tool — for Claude Code through Callio's MCP server and for the API
// models). A file open in a tab is changed there, as one named step of its Undo list, and stays
// unsaved for the author to review; a file that isn't open is changed by the office engine and
// saved with a backup of the old version first.
import { api, call } from "./api.js";
import { getTabs, folder, basename, dirname, status, pdfPagesOp, activeTab, tabText, csvSetCells } from "./main.js";
import { office, DOC_EXT, SHEET_EXT, DECK_EXT, extOf } from "./office.js";

const abs = (p) => (/^([A-Za-z]:)?[\\/]/.test(p || "") || !folder ? p : `${folder}/${p}`);
const norm = (p) => (p || "").replace(/\\/g, "/").toLowerCase();
const tabFor = (p) => getTabs().find((t) => t.path && norm(t.path) === norm(p));
const isDoc = (p) => DOC_EXT.includes(extOf(p));
const isSheet = (p) => SHEET_EXT.includes(extOf(p));
const isPdf = (p) => extOf(p) === "pdf";
const isDeck = (p) => DECK_EXT.includes(extOf(p));
const IMAGE_EXT = ["jpg", "jpeg", "jpe", "jfif", "png", "tif", "tiff", "webp", "avif", "heic", "heif", "jxl", "bmp", "gif", "psd", "dng", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "rwl", "pef", "srw", "x3f", "3fr", "fff", "iiq", "erf", "mef", "mos", "kdc", "dcr"];
const isImage = (p) => IMAGE_EXT.includes(extOf(p));
const IMAGE_WRITES = { jpg: 1, jpeg: 1, jpe: 1, jfif: 1, png: 1, tif: 1, tiff: 1, webp: 1, avif: 1, jxl: 1, psd: 1 };
/** A picture's edits in words: the sliders not at their defaults, and the rest of the settings. */
function describeImage(st, info) {
  const v = st?.values || {};
  const changed = Object.entries(v).filter(([, x]) => x !== 0 && x != null).map(([k, x]) => `${k}=${+x.toFixed?.(2) ?? x}`);
  const s = st?.settings || {};
  const p = info?.photo || {};
  return [
    `Size: ${p.width || "?"} × ${p.height || "?"} px${p.camera || p.make ? `, ${[p.make, p.model || p.camera].filter(Boolean).join(" ")}` : ""}`,
    `Sliders not at zero (develop.set ids): ${changed.join(", ") || "none"}`,
    `Masks: ${(s.masks || []).length}, healing spots: ${(s.spots || []).length}, treatment: ${JSON.stringify(s.treatment ?? "color")}, profile: ${JSON.stringify(s.profile?.id ?? s.profile ?? "default")}`,
    `Undo list (newest first): ${(st?.undo || []).slice(0, 10).join(" · ") || "—"}`,
    `Metadata: ${JSON.stringify(info?.metadata || {}).slice(0, 4000)}`,
  ].join("\n");
}

/** Write engine output over `path`, keeping a backup of the old file (Callio's backups). */
async function putInPlace(tmp, path) {
  const bytes = new Uint8Array(await api.readBinary(tmp));
  await api.writeBinary(path, bytes, 0, true);
}

async function sheetIndex(id, sheet, book) {
  if (sheet == null || sheet === "") return book?.active ?? 0;
  if (typeof sheet === "number" || /^\d+$/.test(String(sheet))) return +sheet;
  const i = (book?.sheets || []).findIndex((s) => s.name.toLowerCase() === String(sheet).toLowerCase());
  if (i < 0) throw new Error(`No sheet named “${sheet}” (sheets: ${(book?.sheets || []).map((s) => s.name).join(", ")})`);
  return i;
}

export async function officeRead({ path, sheet, range, from_page, to_page }) {
  path = abs(path);
  if (isPdf(path)) {
    const t = tabFor(path);
    const r = await (await import("./pdf.js")).extractText(new Uint8Array(await api.readBinary(path)));
    const a = Math.max(1, from_page || 1), b = Math.min(r.pages.length, to_page || r.pages.length);
    const body = r.pages.slice(a - 1, b).map((x, i) => `--- page ${a + i} ---\n${x}`).join("\n");
    return `${r.numPages} pages${t?.dirty ? " (the tab has unsaved changes; this is the saved file)" : ""}\n${body.slice(0, 150000)}`;
  }
  if (isDoc(path)) {
    const t = tabFor(path);
    if (t?.wordId) {
      const r = await office("word.text", { id: t.wordId });
      return `${basename(path)}${t.dirty ? " (open in Callio, with unsaved changes)" : " (open in Callio)"} as Markdown:\n\n${r.markdown.slice(0, 200000)}`;
    }
    const r = await office("doc.open", { path });
    try {
      const m = await office("doc.markdown", { id: r.id, stem: basename(path).replace(/\.[^.]+$/, "") });
      return `${basename(path)} (${r.info?.words ?? "?"} words) as Markdown:\n\n${(m.markdown || "").slice(0, 200000)}`;
    } finally { office("doc.close", { id: r.id }).catch(() => {}); }
  }
  const ct = tabFor(path);
  if (ct?.kind === "csv") {
    // a CSV/TSV open in Callio: what is on screen now (unsaved edits included)
    const lines = tabText(ct).split("\n");
    return `${basename(path)} (open in Callio${ct.dirty ? ", with unsaved changes" : ""}; ${ct.delim === "\t" ? "tab" : `"${ct.delim}"`}-separated, ${lines.length} lines). Cells are addressed like a sheet: column letters, row numbers counting every line.\n${lines.slice(0, 3000).join("\n").slice(0, 150000)}`;
  }
  if (isSheet(path)) {
    const t = tabFor(path);
    let id = t?.sheetId, book = t?.book, opened = false;
    if (!id) { const r = await office("sheet.open", { path }); id = r.id; book = r.book; opened = true; }
    try {
      const si = await sheetIndex(id, sheet, book);
      const r = await office("sheet.read", { id, sheet: si, range: range || null });
      const names = (book?.sheets || []).map((s, i) => `${i}: ${s.name}`).join(", ");
      const rows = (r.rows || []).map((row, i) => row.map((v) => (Array.isArray(v) ? `${v[0]} {${v[1]}}` : v)).join(" | ")).join("\n");
      return `${basename(path)} — sheets: ${names}\nSheet “${r.sheet}”, ${r.from || ""}:${r.to || ""} (one row per line, cells separated by |, formulas in {})\n${rows}`;
    } finally { if (opened) office("sheet.close", { id }).catch(() => {}); }
  }
  if (isDeck(path)) {
    const t = tabFor(path);
    let id = t?.deckId, opened = false;
    if (!id) { id = (await office("deck.open", { path })).id; opened = true; }
    try {
      const r = await office("deck.text", { id });
      return `${basename(path)}${t?.dirty ? " (open in Callio, with unsaved changes)" : ""}:\n${JSON.stringify(r, null, 1).slice(0, 200000)}`;
    } finally { if (opened) office("deck.close", { id }).catch(() => {}); }
  }
  if (isImage(path)) {
    const t = tabFor(path);
    if (t?.imageId) return `${basename(path)} (open in Callio${t.dirty ? ", edits not saved yet" : ""}):\n${describeImage(t.imageState, t.imageInfo)}`;
    const r = await office("image.open", { path });
    try { return `${basename(path)}:\n${describeImage(r.state, r.info)}`; }
    finally { office("image.close", { id: r.id }).catch(() => {}); }
  }
  return { error: `office_read is for Word documents, spreadsheets, presentations, pictures and PDFs; read ${basename(path)} as a text file instead.` };
}

export async function officeCommands({ kind, query }) {
  let list;
  if (kind === "sheet") {
    const t = getTabs().find((x) => x.sheetId);
    let id = t?.sheetId, tmp = null;
    if (!id) {
      // any workbook gives the catalog: a blank one
      tmp = await call("office_temp", { name: "blank.csv" });
      await api.writeText(tmp, "", "utf8", 0);
      id = (await office("sheet.open", { path: tmp })).id;
    }
    list = (await office("sheet.commands", { id })).map((c) => ({ id: c.id, label: c.label, where: (c.menu || []).join(" › "), params: c.params }));
    if (tmp) office("sheet.close", { id }).catch(() => {});
  } else if (kind === "image") {
    let t = getTabs().find((x) => x.imageId), id = t?.imageId, tmp = null;
    if (!id) {
      // any picture gives the catalogue: a blank one
      tmp = await call("office_temp", { name: "blank.png" });
      const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC"), (c) => c.charCodeAt(0));
      await api.writeBinary(tmp, png, 0, false);
      id = (await office("image.open", { path: tmp })).id;
    }
    list = (await office("image.commands", { id })).map((c) => ({ id: c.id, label: c.label, where: (c.menu || []).join(" › "), params: c.params }));
    const ctl = await office("image.controls", { id }).catch(() => null);
    const sliders = (Array.isArray(ctl) ? ctl : ctl?.controls || []).map((c) => `${c.id} (${c.min}…${c.max})`).join(", ");
    if (tmp) office("image.close", { id }).catch(() => {});
    if (!query) list.unshift({ id: "develop.set", label: `Set sliders: {values: {id: number}} — slider ids: ${sliders}`, where: "", params: "" });
  } else if (kind === "deck") {
    const t = getTabs().find((x) => x.deckId);
    if (!t) return "Open a presentation in Callio first (or call deck_edit with commands from DeckCraft: slide.new, insert.textBox, shape.insert, text.replace, slide.notes…).";
    list = (await office("deck.commands", { id: t.deckId })).map((c) => ({ id: c.id, label: c.label, where: (c.menu || []).join(" › "), params: c.params }));
  } else {
    list = (await office("word.commands", {})).map((c) => ({ id: c.id, label: c.label, where: c.where, params: c.params }));
  }
  const q = (query || "").toLowerCase();
  const hits = list.filter((c) => !q || `${c.id} ${c.label} ${c.where}`.toLowerCase().includes(q)).slice(0, 150);
  return hits.map((c) => `${c.id} — ${c.label}${c.where ? ` (${c.where})` : ""}${c.params ? `  params: ${c.params}` : ""}`).join("\n") || "No command matches.";
}

function summarize(results) {
  const bad = results.map((r, i) => (r.ok ? null : `#${i + 1}: ${r.error}`)).filter(Boolean);
  const vals = results.map((r, i) => (r.ok && r.result && typeof r.result === "object" && Object.keys(r.result).length && !("anchor" in r.result) ? `#${i + 1}: ${JSON.stringify(r.result).slice(0, 400)}` : null)).filter(Boolean);
  return `${results.length - bad.length} of ${results.length} command(s) done.${bad.length ? `\nFailed: ${bad.join("; ")}` : ""}${vals.length ? `\nResults: ${vals.join("; ")}` : ""}`;
}

export async function wordEdit({ path, commands, label }) {
  path = abs(path);
  if (!isDoc(path)) return { error: "word_edit is for Word documents (.docx .doc .odt .rtf)." };
  if (!Array.isArray(commands) || !commands.length) return { error: "Give the commands to run." };
  label = `AI: ${label || "edit"}`;
  const t = tabFor(path);
  if (t?.wordId) {
    const w = await import("./word.js");
    const results = await w.aiBatch(t, commands, label);
    status(`${label} — in ${t.name} (unsaved; Undo takes it back)`, "ok");
    return `${summarize(results)}\nThe document is open in Callio: the change is shown there, unsaved, as one Undo step “${label}”.`;
  }
  // not open: edit with the engine, then save over the file (old one backed up)
  const ext = extOf(path);
  if (!["docx", "docm", "dotx", "dotm", "odt", "rtf"].includes(ext)) return { error: `.${ext} can't be written; open it in Callio and save it as .docx first.` };
  const r = await office("word.open", { path });
  try {
    const b = await office("word.batch", { id: r.id, commands, label });
    const tmp = await call("office_temp", { name: basename(path) });
    await office("word.save", { id: r.id, out: tmp });
    await putInPlace(tmp, path);
    return `${summarize(b.results)}\nSaved ${basename(path)} (the previous version is in Callio's backups).`;
  } finally { office("word.close", { id: r.id }).catch(() => {}); }
}

export async function sheetEdit({ path, sheet, cells, commands, label }) {
  path = abs(path);
  if (!isSheet(path)) return { error: "sheet_edit is for spreadsheets." };
  const t = tabFor(path);
  if (t?.kind === "csv") {
    if (commands?.length) return { error: `${basename(path)} is open in Callio as text (CSV). Give \`cells\` here, or edit its text with the file editing tools.` };
    const n = await csvSetCells(t, cells, `AI: ${label || "edit"}`);
    return `Changed ${Object.keys(cells || {}).length} cell(s) in ${n} row(s). The file is open in Callio: the change is shown there, unsaved, as one Undo step.`;
  }
  let id = t?.sheetId, book = t?.book, opened = false;
  if (!id) { const r = await office("sheet.open", { path }); id = r.id; book = r.book; opened = true; }
  try {
    const si = await sheetIndex(id, sheet, book);
    const list = [{ command: "sheet.activate", params: { sheet: si } }];
    for (const [cell, input] of Object.entries(cells || {})) list.push({ command: "cell.set", params: { sheet: si, cell, input: String(input) } });
    for (const c of commands || []) list.push({ command: c.command, params: { sheet: si, ...(c.params || {}) } });
    if (list.length === 1) return { error: "Give `cells` or `commands`." };
    label = `AI: ${label || "edit"}`;
    if (t?.sheetId) {
      const s = await import("./sheet.js");
      const results = await s.aiBatch(t, list, label);
      return `${summarize(results.slice(1))}\nThe workbook is open in Callio: the change is shown there, unsaved, as one Undo step “${label}”.`;
    }
    const b = await office("sheet.batch", { id, commands: list, label });
    let out = path;
    if (!["xlsx", "xlsm", "csv", "tsv"].includes(extOf(path))) out = path.replace(/\.[^.]+$/, ".xlsx");
    const tmp = await call("office_temp", { name: basename(out) });
    await office("sheet.save", { id, out: tmp });
    await putInPlace(tmp, out);
    return `${summarize(b.results.slice(1))}\nSaved ${basename(out)}${out !== path ? ` (a new .xlsx next to ${basename(path)})` : " (the previous version is in Callio's backups)"}.`;
  } finally { if (opened) office("sheet.close", { id }).catch(() => {}); }
}

const IN_TAB = new Set(["organize", "select", "delete", "rotate", "insert", "nup", "crop", "pageNumbers", "headerFooter", "watermark", "removeMarks", "flatten"]);
export async function pdfTool({ path, op, output, args }) {
  path = abs(path);
  args = args || {};
  const t = tabFor(path);
  if (t && IN_TAB.has(op) && activeTab() === t) {
    await pdfPagesOp(t, `AI: ${op}`, `pdf.${op}`, args);
    return `Done in the open tab ${t.name} (unsaved; one Undo step “AI: ${op}”).`;
  }
  if (op === "split") {
    const r = await office("pdf.split", { ...args, input: path, outDir: abs(args.outDir || dirname(path)), stem: basename(path).replace(/\.pdf$/i, "") });
    return `Saved ${r.outputs?.length || 0} parts: ${(r.outputs || []).map(basename).join(", ")}`;
  }
  let out = output ? abs(output) : path.replace(/\.pdf$/i, `-${op}.pdf`);
  if (norm(out) === norm(path)) out = path.replace(/\.pdf$/i, `-${op}.pdf`);
  const r = await office(`pdf.${op}`, { ...args, input: op === "merge" ? undefined : path, inputs: op === "merge" ? [path, ...(args.inputs || []).map(abs)] : args.inputs, output: out });
  return `Saved ${basename(out)}${r?.pages ? ` (${r.pages} pages)` : ""}. ${JSON.stringify(r).slice(0, 300)}`;
}

export async function imageEdit({ path, commands, label }) {
  path = abs(path);
  if (!isImage(path)) return { error: "image_edit is for pictures and photos (JPEG, PNG, TIFF, WebP, AVIF, HEIC, raw…)." };
  if (!Array.isArray(commands) || !commands.length) return { error: "Give the commands to run." };
  label = `AI: ${label || "edit"}`;
  const t = tabFor(path);
  if (t?.imageId) {
    const m = await import("./image.js");
    const results = await m.aiBatch(t, commands, label);
    return `${summarize(results || [])}\nThe picture is open in Callio: the change is shown there, not saved yet, as one Undo step “${label}”.`;
  }
  if (!IMAGE_WRITES[extOf(path)]) return { error: `.${extOf(path)} files aren't overwritten (a camera raw file stays as it is); open it in Callio, edit, then Save as JPEG or TIFF.` };
  const r = await office("image.open", { path });
  try {
    const b = await office("image.batch", { id: r.id, commands, label });
    const tmp = await call("office_temp", { name: basename(path) });
    await office("image.save", { id: r.id, out: tmp, markSaved: true });
    await putInPlace(tmp, path);
    return `${summarize(b.result || [])}\nSaved ${basename(path)} (the previous version is in Callio's backups).`;
  } finally { office("image.close", { id: r.id }).catch(() => {}); }
}

export async function deckEdit({ path, commands, label }) {
  path = abs(path);
  if (!isDeck(path)) return { error: "deck_edit is for presentations (.pptx .ppsx .potx .odp)." };
  if (!Array.isArray(commands) || !commands.length) return { error: "Give the commands to run." };
  label = `AI: ${label || "edit"}`;
  const t = tabFor(path);
  if (t?.deckId) {
    const d = await import("./deck.js");
    const results = await d.aiBatch(t, commands, label);
    return `${summarize(results || [])}\nThe presentation is open in Callio: the change is shown there, unsaved, as one Undo step “${label}”.`;
  }
  if (!["pptx", "pptm", "potx", "ppsx"].includes(extOf(path))) return { error: `.${extOf(path)} can't be written; open it in Callio and save it as .pptx first.` };
  const r = await office("deck.open", { path });
  try {
    const b = await office("deck.batch", { id: r.id, commands, label });
    const tmp = await call("office_temp", { name: basename(path) });
    await office("deck.save", { id: r.id, out: tmp, markSaved: true });
    await putInPlace(tmp, path);
    return `${summarize(b.result || [])}\nSaved ${basename(path)} (the previous version is in Callio's backups).`;
  } finally { office("deck.close", { id: r.id }).catch(() => {}); }
}
