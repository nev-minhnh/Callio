// PPTX (PresentationML) -> Markdown: "## <title>" (or "## Slide N") per slide, text in reading order,
// bullet levels, tables, pictures and speaker notes (as a quote).
import { unzip, zipXml, readRels, kids, kid, desc, attr, renderInline, renderTable, joinBlocks, escapeLineStart, mime, ConvertError, checkAbort, tick } from "./util.js";
import { ommlToLatex } from "./omml.js";

export async function convertPptx(ctx) {
  const files = await unzip(ctx.bytes);
  const presPath = "ppt/presentation.xml";
  const pres = zipXml(files, presPath);
  if (!pres) throw new ConvertError("This doesn't look like a PowerPoint presentation (ppt/presentation.xml is missing).");
  const rels = readRels(files, presPath);
  const ids = desc(pres, "sldId");
  const out = [];
  let n = 0;
  for (const sid of ids) {
    checkAbort(ctx.signal);
    n++;
    ctx.progress(n - 1, ids.length, `Slide ${n}`);
    if (attr(sid, "show") === "0") continue;
    const rel = rels.get(attr(sid, "r:id"));
    if (!rel) continue;
    const slide = zipXml(files, rel.target);
    if (!slide) continue;
    if (attr(slide.documentElement, "show") === "0") { ctx.warnings.push(`Skipped hidden slide ${n}.`); continue; }
    out.push(convertSlide(ctx, files, rel.target, slide, n));
    if (n % 10 === 0) await tick();
  }
  ctx.progress(ids.length, ids.length);
  return out.filter(Boolean).join("\n\n");
}

function convertSlide(ctx, files, path, slide, n) {
  const rels = readRels(files, path);
  const layoutRel = [...rels.values()].find((r) => r.type === "slideLayout");
  const layout = layoutRel ? zipXml(files, layoutRel.target) : null;
  const layoutPos = new Map();
  if (layout) {
    const lrels = readRels(files, layoutRel.target);
    const masterRel = [...lrels.values()].find((r) => r.type === "slideMaster");
    const master = masterRel ? zipXml(files, masterRel.target) : null;
    for (const d of [master, layout]) {
      if (!d) continue;
      for (const sp of desc(d, "sp")) {
        const ph = desc(sp, "ph")[0];
        const off = desc(kid(sp, "spPr"), "off")[0];
        if (!ph || !off) continue;
        const pos = { x: +attr(off, "x"), y: +attr(off, "y") };
        if (attr(ph, "idx")) layoutPos.set("idx:" + attr(ph, "idx"), pos);
        layoutPos.set("type:" + (attr(ph, "type") || "body"), pos);
      }
    }
  }
  const items = [];
  const tree = desc(slide, "spTree")[0];
  collect(tree, items, { dx: 0, dy: 0 }, layoutPos);
  // reading order: top-to-bottom, then left-to-right (rows grouped with a tolerance)
  items.forEach((it, i) => (it.order = i));
  items.sort((a, b) => (Math.abs(a.y - b.y) < 300000 ? a.x - b.x : a.y - b.y) || a.order - b.order);
  let title = null;
  const blocks = [];
  for (const it of items) {
    if (it.kind === "sp") {
      const isTitle = it.phType === "title" || it.phType === "ctrTitle";
      if (isTitle && title == null) {
        title = textOf(it.el).replace(/\s+/g, " ").trim();
        if (title) continue;
      }
      if (it.phType === "sldNum" || it.phType === "dt" || it.phType === "ftr") continue;
      blocks.push(...textBody(kid(it.el, "txBody"), rels, it.phType));
    } else if (it.kind === "pic") {
      const blip = desc(it.el, "blip")[0];
      const rel = blip ? rels.get(attr(blip, "r:embed")) : null;
      const alt = attr(desc(it.el, "cNvPr")[0], "descr") || "";
      if (rel && !rel.external) blocks.push(ctx.images.add(files[rel.target], mime(rel.target), alt, rel.target));
      else blocks.push("<!-- image -->");
    } else if (it.kind === "table") blocks.push(table(it.el, rels));
    else if (it.kind === "chart") blocks.push("<!-- image -->");
  }
  const head = `## ${title ? escapeLineStart(title) : `Slide ${n}`}`;
  const parts = [head, joinBlocks(blocks)];
  const notesRel = [...rels.values()].find((r) => r.type === "notesSlide");
  if (notesRel) {
    const notes = zipXml(files, notesRel.target);
    if (notes) {
      const nb = [];
      for (const sp of desc(notes, "sp")) {
        const ph = desc(sp, "ph")[0];
        if (!ph || (attr(ph, "type") || "body") !== "body") continue;
        nb.push(...textBody(kid(sp, "txBody"), readRels(files, notesRel.target), "notes"));
      }
      const md = joinBlocks(nb).trim();
      if (md) parts.push(md.split("\n").map((l) => (l ? "> " + l : ">")).join("\n"));
    }
  }
  return joinBlocks(parts);
}

function collect(container, items, off, layoutPos) {
  for (const el of kids(container)) {
    const name = el.localName;
    if (name === "sp" || name === "pic" || name === "graphicFrame" || name === "cxnSp") {
      if (name === "cxnSp") continue;
      const xfrm = name === "graphicFrame" ? kid(el, "xfrm") : kid(kid(el, "spPr"), "xfrm");
      const o = kid(xfrm, "off");
      const ph = desc(kid(el, "nvSpPr") || kid(el, "nvPicPr") || kid(el, "nvGraphicFramePr"), "ph")[0];
      const phType = ph ? attr(ph, "type") || "body" : null;
      let pos = o ? { x: +attr(o, "x") + off.dx, y: +attr(o, "y") + off.dy } : null;
      if (!pos && ph) pos = layoutPos.get("idx:" + attr(ph, "idx")) || layoutPos.get("type:" + phType) || null;
      if (!pos) pos = { x: 0, y: phType === "title" || phType === "ctrTitle" ? -1 : 1e9 };
      let kind = name === "pic" ? "pic" : "sp";
      if (name === "graphicFrame") {
        if (desc(el, "tbl").length) kind = "table";
        else if (desc(el, "chart").length || desc(el, "relIds").length) kind = "chart";
        else continue;
      }
      if (kind === "sp" && !kid(el, "txBody")) {
        // shape filled with a picture
        if (desc(kid(el, "spPr"), "blip").length) kind = "pic";
        else continue;
      }
      items.push({ kind, el, phType, x: pos.x, y: pos.y, txBox: attr(kid(el, "nvSpPr") && kid(kid(el, "nvSpPr"), "cNvSpPr"), "txBox") === "1" });
    } else if (name === "grpSp") {
      const xfrm = kid(kid(el, "grpSpPr"), "xfrm");
      const o = kid(xfrm, "off"), ch = kid(xfrm, "chOff");
      const d = o && ch ? { dx: off.dx + +attr(o, "x") - +attr(ch, "x"), dy: off.dy + +attr(o, "y") - +attr(ch, "y") } : off;
      collect(el, items, d, layoutPos);
    } else if (name === "AlternateContent") {
      const choice = kid(el, "Choice") || kid(el, "Fallback");
      if (choice) collect(choice, items, off, layoutPos);
    }
  }
}

function textOf(el) {
  return desc(el, "p").map((p) => desc(p, "*").filter((x) => x.localName === "t" || x.localName === "br").map((t) => (t.localName === "br" ? " " : t.textContent)).join("")).join(" ");
}

function textBody(body, rels, phType) {
  if (!body) return [];
  const blocks = [];
  const lstStyle = kid(body, "lstStyle");
  void lstStyle;
  const defaultBullets = phType === "body" || phType === "obj" || (phType && /^\d+$/.test(phType));
  const counters = [];
  for (const p of kids(body, "p")) {
    const ppr = kid(p, "pPr");
    const lvl = +(attr(ppr, "lvl") || 0);
    const segs = [];
    for (const r of kids(p)) {
      if (r.localName === "r" || r.localName === "fld") {
        const rpr = kid(r, "rPr");
        const t = kid(r, "t")?.textContent || "";
        const link = kid(rpr, "hlinkClick");
        const rel = link ? rels.get(attr(link, "r:id")) : null;
        const href = rel && (rel.external || /^(https?|mailto):/i.test(rel.target)) ? rel.target : null;
        segs.push({
          text: t, href,
          b: attr(rpr, "b") === "1", i: attr(rpr, "i") === "1",
          s: (attr(rpr, "strike") || "noStrike") !== "noStrike",
          u: !href && (attr(rpr, "u") || "none") !== "none",
          sup: +(attr(rpr, "baseline") || 0) > 0, sub: +(attr(rpr, "baseline") || 0) < 0,
        });
      } else if (r.localName === "br") segs.push({ raw: "\\\n" });
      else if (r.localName === "AlternateContent" || r.localName === "m" || r.localName === "oMath" || r.localName === "oMathPara") {
        const paraM = r.localName === "oMathPara" ? r : desc(r, "oMathPara")[0];
        const m = desc(r, "oMath")[0] || (r.localName === "oMath" ? r : null);
        if (paraM) segs.push({ raw: `$$${ommlToLatex(paraM)}$$` });
        else if (m) segs.push({ raw: `$${ommlToLatex(m)}$` });
        else segs.push({ text: desc(r, "t").map((x) => x.textContent).join("") });
      }
    }
    const md = renderInline(segs).replace(/[ \t]+/g, " ").trim().replace(/^(\\\n)+|(\\\n)+$/g, "").trim();
    if (!md) continue;
    const buNone = kid(ppr, "buNone");
    const buChar = kid(ppr, "buChar");
    const buAuto = kid(ppr, "buAutoNum");
    const bullet = !buNone && (buChar || buAuto || defaultBullets);
    if (bullet && phType !== "notes") {
      for (let i = lvl + 1; i < counters.length; i++) counters[i] = 0;
      let marker = "-";
      if (buAuto) {
        counters[lvl] = (counters[lvl] || +(attr(buAuto, "startAt") || 1) - 1) + 1;
        marker = `${counters[lvl]}.`;
      }
      blocks.push({ md: " ".repeat(4 * Math.min(lvl, 8)) + `${marker} ${md}`, list: true });
    } else {
      counters.length = 0;
      blocks.push(escapeLineStart(md));
    }
  }
  return blocks;
}

function table(frame, rels) {
  const tbl = desc(frame, "tbl")[0];
  const rows = [];
  for (const tr of kids(tbl, "tr")) {
    const row = [];
    for (const tc of kids(tr, "tc")) {
      if (attr(tc, "hMerge") === "1" || attr(tc, "vMerge") === "1") continue;
      const blocks = textBody(kid(tc, "txBody"), rels, null);
      row.push({
        text: blocks.map((b) => (typeof b === "object" ? b.md : b)).join("\n"),
        colspan: +(attr(tc, "gridSpan") || 1),
        rowspan: +(attr(tc, "rowSpan") || 1),
      });
    }
    rows.push(row);
  }
  return renderTable(rows, { header: true });
}
