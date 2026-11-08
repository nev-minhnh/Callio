//! PDF tools on PdfCraft's object layer (Stirling-PDF's toolbox, without a server): merge,
//! split, extract, reorder, delete, rotate, insert, N-up, crop, page numbers / header & footer,
//! watermark, flatten, compress, repair, password protect / remove, redact, metadata,
//! attachments and images → PDF. Pages are 0-based here; the window speaks 1-based.

use std::sync::Arc;

use pdfcraft_cos::{Dict, Document, Object, SaveOptions, Stream};
use serde_json::{Value as Json, json};

fn open(path: &str, password: Option<&str>) -> Result<Document, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Couldn't read {path}: {e}"))?;
    Document::open_with_password(Arc::new(bytes), password).map_err(|e| {
        let m = e.to_string();
        if m.to_lowercase().contains("password") { format!("PASSWORD: {m}") } else { m }
    })
}

fn save_full(doc: &Document, out: &str, compact: bool) -> Result<u64, String> {
    let opts = SaveOptions { object_streams: compact, ..Default::default() };
    let bytes = pdfcraft_cos::write_full(doc, &opts).map_err(|e| e.to_string())?;
    let n = bytes.len() as u64;
    crate::write_safely(out, &bytes)?;
    Ok(n)
}

fn pages_arg(a: &Json, key: &str, count: usize) -> Result<Vec<usize>, String> {
    match a.get(key) {
        None | Some(Json::Null) => Ok((0..count).collect()),
        Some(Json::String(s)) => parse_ranges(s, count),
        Some(Json::Array(v)) => {
            let p: Vec<usize> = v.iter().filter_map(|x| x.as_u64()).map(|x| x as usize).collect();
            if let Some(bad) = p.iter().find(|&&i| i >= count) {
                return Err(format!("There is no page {} (the file has {count})", bad + 1));
            }
            Ok(p)
        }
        _ => Err(format!("`{key}` should list pages")),
    }
}

/// "1-3, 5, 8-" (1-based, as typed) → 0-based indices; "odd", "even", "all", "last".
pub fn parse_ranges(s: &str, count: usize) -> Result<Vec<usize>, String> {
    let s = s.trim().to_lowercase();
    if s.is_empty() || s == "all" {
        return Ok((0..count).collect());
    }
    let mut out = vec![];
    for part in s.split([',', ';']).map(str::trim).filter(|p| !p.is_empty()) {
        match part {
            "odd" => out.extend((0..count).step_by(2)),
            "even" => out.extend((1..count).step_by(2)),
            "last" | "z" => out.push(count.saturating_sub(1)),
            _ => {
                let num = |t: &str| -> Result<usize, String> {
                    let t = t.trim();
                    if t == "last" || t == "z" {
                        return Ok(count);
                    }
                    t.parse::<usize>().map_err(|_| format!("“{part}” isn't a page range"))
                };
                let (a, b) = match part.split_once('-') {
                    Some((a, b)) => (if a.trim().is_empty() { 1 } else { num(a)? }, if b.trim().is_empty() { count } else { num(b)? }),
                    None => {
                        let n = num(part)?;
                        (n, n)
                    }
                };
                if a == 0 || b == 0 || a > count || b > count {
                    return Err(format!("Pages run from 1 to {count}: “{part}” is outside"));
                }
                if a <= b {
                    out.extend(a - 1..b);
                } else {
                    out.extend((b - 1..a).rev());
                }
            }
        }
    }
    Ok(out)
}

fn count(doc: &Document) -> Result<usize, String> {
    pdfcraft_organize::page_count(doc).map_err(|e| e.to_string())
}

fn seed() -> [u8; 32] {
    let mut s = [0u8; 32];
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let pid = std::process::id() as u128;
    let x = t ^ (pid << 64) ^ (&s as *const _ as usize as u128);
    s[..16].copy_from_slice(&x.to_le_bytes());
    s[16..].copy_from_slice(&(t.rotate_left(17) ^ 0x9e37_79b9_7f4a_7c15).to_le_bytes());
    // mixed again by the crypt crate's SHA-256 expansion
    s
}

pub fn run(op: &str, a: &Json) -> Result<Json, String> {
    let s = |k: &str| a.get(k).and_then(|v| v.as_str()).map(str::to_string);
    let input = || s("input").ok_or_else(|| "No input file".to_string());
    let output = || s("output").ok_or_else(|| "No output file".to_string());
    let pw = s("password");
    match op {
        "info" => {
            let d = open(&input()?, pw.as_deref())?;
            let n = count(&d)?;
            let mut info = serde_json::Map::new();
            for k in ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"] {
                if let Some(v) = pdfcraft_organize::info(&d, k) {
                    info.insert(k.into(), json!(v));
                }
            }
            let sizes: Vec<Json> = pdfcraft_organize::page_boxes(&d).unwrap_or_default().iter().take(2000).map(|b| json!([b[1][2] - b[1][0], b[1][3] - b[1][1]])).collect();
            Ok(json!({ "pages": n, "version": d.version(), "encrypted": d.security().is_some(), "info": info, "sizes": sizes,
                "attachments": pdfcraft_organize::attachment_keys(&d) }))
        }
        "merge" => {
            let inputs: Vec<String> = a["inputs"].as_array().ok_or("Pick the files to merge")?.iter().filter_map(|v| v.as_str().map(String::from)).collect();
            if inputs.len() < 2 {
                return Err("Pick at least two PDFs to merge".into());
            }
            let docs: Vec<Document> = inputs.iter().map(|p| open(p, None)).collect::<Result<_, _>>()?;
            let names: Vec<String> = inputs.iter().map(|p| std::path::Path::new(p).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()).collect();
            let src: Vec<(&str, &Document)> = names.iter().map(String::as_str).zip(docs.iter()).collect();
            let out = pdfcraft_organize::combine(&src).map_err(|e| e.to_string())?;
            let size = save_full(&out, &output()?, true)?;
            Ok(json!({ "output": output()?, "pages": count(&out)?, "bytes": size }))
        }
        "split" => {
            let d = open(&input()?, pw.as_deref())?;
            let n = count(&d)?;
            let by = match a["mode"].as_str().unwrap_or("every") {
                "every" => pdfcraft_organize::SplitBy::PageCount(a["n"].as_u64().unwrap_or(1).max(1) as usize),
                "before" => {
                    let at = pages_arg(a, "at", n)?;
                    pdfcraft_organize::SplitBy::Before(at)
                }
                m => return Err(format!("Unknown split mode {m}")),
            };
            let dir = s("outDir").ok_or("Pick a folder for the parts")?;
            let stem = s("stem").unwrap_or_else(|| "part".into());
            let parts = pdfcraft_organize::split(&d, &by).map_err(|e| e.to_string())?;
            let width = parts.len().to_string().len().max(2);
            let mut outs = vec![];
            for (i, p) in parts.iter().enumerate() {
                let path = std::path::Path::new(&dir).join(format!("{stem}-{:0width$}.pdf", i + 1));
                let path = path.to_string_lossy().to_string();
                if std::path::Path::new(&path).exists() {
                    return Err(format!("{path} already exists — pick an empty folder"));
                }
                save_full(p, &path, true)?;
                outs.push(path);
            }
            Ok(json!({ "outputs": outs }))
        }
        // a new PDF of these pages, in this order (repeats allowed): extract, reorder, reverse,
        // duplicate, delete (= keep the rest), odd/even
        "select" => {
            let d = open(&input()?, pw.as_deref())?;
            let n = count(&d)?;
            let pages = pages_arg(a, "pages", n)?;
            if pages.is_empty() {
                return Err("No pages left".into());
            }
            let out = pdfcraft_organize::extract_pages(&d, &pages).map_err(|e| e.to_string())?;
            let size = save_full(&out, &output()?, true)?;
            Ok(json!({ "output": output()?, "pages": pages.len(), "bytes": size }))
        }
        "organize" => {
            // the page organizer: [{page (0-based), rotate (degrees)}] in their new order
            let d = open(&input()?, pw.as_deref())?;
            let n = count(&d)?;
            let order = a["order"].as_array().ok_or("No pages left")?;
            let pages: Vec<usize> = order.iter().filter_map(|o| o["page"].as_u64().map(|p| p as usize)).filter(|&p| p < n).collect();
            if pages.is_empty() {
                return Err("No pages left".into());
            }
            let mut out = pdfcraft_organize::extract_pages(&d, &pages).map_err(|e| e.to_string())?;
            let mut by: std::collections::BTreeMap<i64, Vec<usize>> = Default::default();
            for (i, o) in order.iter().enumerate() {
                let r = o["rotate"].as_i64().unwrap_or(0).rem_euclid(360);
                if r != 0 {
                    by.entry(r).or_default().push(i);
                }
            }
            for (deg, idx) in by {
                pdfcraft_organize::rotate_pages(&mut out, &idx, deg).map_err(|e| e.to_string())?;
            }
            let size = save_full(&out, &output()?, true)?;
            Ok(json!({ "output": output()?, "pages": pages.len(), "bytes": size }))
        }
        "delete" => {
            let d = open(&input()?, pw.as_deref())?;
            let n = count(&d)?;
            let del: std::collections::HashSet<usize> = pages_arg(a, "pages", n)?.into_iter().collect();
            let keep: Vec<usize> = (0..n).filter(|i| !del.contains(i)).collect();
            if keep.is_empty() {
                return Err("A PDF needs at least one page".into());
            }
            let out = pdfcraft_organize::extract_pages(&d, &keep).map_err(|e| e.to_string())?;
            save_full(&out, &output()?, true)?;
            Ok(json!({ "output": output()?, "pages": keep.len() }))
        }
        "rotate" => {
            let mut d = open(&input()?, pw.as_deref())?;
            let n = count(&d)?;
            let pages = pages_arg(a, "pages", n)?;
            let deg = a["degrees"].as_i64().unwrap_or(90);
            pdfcraft_organize::rotate_pages(&mut d, &pages, deg).map_err(|e| e.to_string())?;
            save_full(&d, &output()?, true)?;
            Ok(json!({ "output": output()? }))
        }
        "insert" => {
            // another PDF's pages (or blank pages) before page `at` (1-based; 0 = at the end)
            let mut d = open(&input()?, pw.as_deref())?;
            let n = count(&d)?;
            let at = match a["at"].as_u64() {
                Some(0) | None => n,
                Some(x) => (x as usize - 1).min(n),
            };
            if let Some(f) = s("file") {
                let src = open(&f, None)?;
                let sn = count(&src)?;
                let pages = pages_arg(a, "filePages", sn)?;
                pdfcraft_organize::import_pages(&mut d, &src, &pages, at).map_err(|e| e.to_string())?;
            } else {
                let blanks = a["blank"].as_u64().unwrap_or(1).clamp(1, 500) as usize;
                let size = pdfcraft_organize::page_boxes(&d).ok().and_then(|v| v.get(at.min(n.saturating_sub(1))).copied()).map(|b| (b[0][2] - b[0][0], b[0][3] - b[0][1])).unwrap_or((595.0, 842.0));
                for k in 0..blanks {
                    pdfcraft_organize::insert_blank_page(&mut d, at + k, size.0, size.1).map_err(|e| e.to_string())?;
                }
            }
            save_full(&d, &output()?, true)?;
            Ok(json!({ "output": output()?, "pages": count(&d)? }))
        }
        "nup" => nup(a, &input()?, pw.as_deref(), &output()?),
        "crop" => {
            // margins to cut, in points: [top, right, bottom, left]
            let mut d = open(&input()?, pw.as_deref())?;
            let n = count(&d)?;
            let m: Vec<f64> = a["margins"].as_array().map(|v| v.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default();
            let [t, r, b, l] = [m.first().copied().unwrap_or(0.0), m.get(1).copied().unwrap_or(0.0), m.get(2).copied().unwrap_or(0.0), m.get(3).copied().unwrap_or(0.0)];
            let pages = pages_arg(a, "pages", n)?;
            if t + b < 0.0 || l + r < 0.0 {
                return Err("Margins can't be negative".into());
            }
            // left, bottom, right, top
            pdfcraft_organize::set_page_box(&mut d, &pages, pdfcraft_organize::PageBox::Crop, pdfcraft_organize::BoxSpec::Margins([l, b, r, t])).map_err(|e| e.to_string())?;
            save_full(&d, &output()?, true)?;
            Ok(json!({ "output": output()? }))
        }
        "headerFooter" | "pageNumbers" => {
            let mut d = open(&input()?, pw.as_deref())?;
            let n = count(&d)?;
            let pages = pages_arg(a, "pages", n)?;
            let mut hf = pdfcraft_edit::HeaderFooter::default();
            if op == "pageNumbers" {
                // position: one of tl, tc, tr, bl, bc, br
                let pos = a["position"].as_str().unwrap_or("bc");
                let fmt = a["format"].as_str().unwrap_or("<<1>>").to_string();
                let slot = match pos {
                    "tl" => 0,
                    "tc" => 1,
                    "tr" => 2,
                    "bl" => 3,
                    "br" => 5,
                    _ => 4,
                };
                hf.text[slot] = fmt;
                hf.font_size = a["size"].as_f64().unwrap_or(10.0);
            } else if let Some(t) = a["text"].as_array() {
                for (i, v) in t.iter().take(6).enumerate() {
                    hf.text[i] = v.as_str().unwrap_or("").to_string();
                }
                hf.font_size = a["size"].as_f64().unwrap_or(9.0);
            }
            hf.start_number = a["start"].as_u64().unwrap_or(1) as u32;
            if let Some(c) = a["color"].as_str() {
                hf.color = rgb(c);
            }
            hf.font = match a["font"].as_str().unwrap_or("helvetica") {
                "times" => pdfcraft_edit::Family::Times,
                "courier" => pdfcraft_edit::Family::Courier,
                _ => pdfcraft_edit::Family::Helvetica,
            };
            let cx = pdfcraft_edit::Context { date: today() };
            pdfcraft_edit::add_header_footer(&mut d, &pages, &hf, true, &cx).map_err(|e| e.to_string())?;
            save_full(&d, &output()?, true)?;
            Ok(json!({ "output": output()? }))
        }
        "watermark" => {
            let mut d = open(&input()?, pw.as_deref())?;
            let n = count(&d)?;
            let pages = pages_arg(a, "pages", n)?;
            let wm = pdfcraft_edit::Watermark {
                text: s("text").filter(|t| !t.trim().is_empty()).ok_or("Type the watermark text")?,
                font_size: a["size"].as_f64().unwrap_or(60.0),
                color: a["color"].as_str().map(rgb).unwrap_or([0.6, 0.6, 0.6]),
                opacity: a["opacity"].as_f64().unwrap_or(0.3).clamp(0.02, 1.0),
                rotation: a["rotation"].as_f64().unwrap_or(45.0),
                behind: a["behind"].as_bool().unwrap_or(false),
                ..Default::default()
            };
            if let Some(ch) = wm.first_undrawable() {
                return Err(format!("“{ch}” can't be drawn with the standard PDF fonts — use Latin letters for the watermark"));
            }
            pdfcraft_edit::add_watermark(&mut d, &pages, &wm, true).map_err(|e| e.to_string())?;
            save_full(&d, &output()?, true)?;
            Ok(json!({ "output": output()? }))
        }
        "removeMarks" => {
            let mut d = open(&input()?, pw.as_deref())?;
            let n = count(&d)?;
            let pages = pages_arg(a, "pages", n)?;
            let mut total = 0;
            for k in [pdfcraft_edit::MarkKind::Watermark, pdfcraft_edit::MarkKind::HeaderFooter, pdfcraft_edit::MarkKind::Background] {
                total += pdfcraft_edit::remove_marks(&mut d, &pages, k).unwrap_or(0);
            }
            save_full(&d, &output()?, true)?;
            Ok(json!({ "output": output()?, "removed": total }))
        }
        "flatten" => {
            let mut d = open(&input()?, pw.as_deref())?;
            let n = count(&d)?;
            let pages = pages_arg(a, "pages", n)?;
            pdfcraft_edit::flatten(&mut d, &pages, a["annotations"].as_bool().unwrap_or(true), a["fields"].as_bool().unwrap_or(true)).map_err(|e| e.to_string())?;
            save_full(&d, &output()?, true)?;
            Ok(json!({ "output": output()? }))
        }
        "compress" => {
            let inp = input()?;
            let before = std::fs::metadata(&inp).map(|m| m.len()).unwrap_or(0);
            let mut d = open(&inp, pw.as_deref())?;
            let mut st = pdfcraft_optimize::Settings::default();
            match a["level"].as_str().unwrap_or("standard") {
                // lossless: only the file structure
                "lossless" => {
                    st.color.downsample = false;
                    st.gray.downsample = false;
                    st.mono.downsample = false;
                    st.color.compression = pdfcraft_optimize::Compression::Retain;
                    st.gray.compression = pdfcraft_optimize::Compression::Retain;
                    st.mono.compression = pdfcraft_optimize::MonoCompression::Retain;
                }
                "screen" => {
                    st.color = pdfcraft_optimize::ImageSettings::MOBILE;
                    st.gray = pdfcraft_optimize::ImageSettings::MOBILE;
                }
                "smallest" => {
                    let small = pdfcraft_optimize::ImageSettings { downsample: true, target_ppi: 72.0, above_ppi: 100.0, compression: pdfcraft_optimize::Compression::Jpeg(45) };
                    st.color = small;
                    st.gray = small;
                    st.discard_tags = true;
                }
                _ => {}
            }
            let report = pdfcraft_optimize::optimize(&mut d, &st).map_err(|e| e.to_string())?;
            let after = save_full(&d, &output()?, true)?;
            let _ = report;
            Ok(json!({ "output": output()?, "before": before, "after": after }))
        }
        "repair" => {
            let mut d = open(&input()?, pw.as_deref())?;
            let fixed = pdfcraft_organize::recover_page_tree(&mut d).unwrap_or(0);
            let log = d.repair_log().to_vec();
            save_full(&d, &output()?, true)?;
            Ok(json!({ "output": output()?, "pages": count(&d)?, "fixed": fixed, "log": log }))
        }
        "protect" => {
            let mut d = open(&input()?, pw.as_deref())?;
            let user = s("userPassword").unwrap_or_default();
            let owner = s("ownerPassword").filter(|o| !o.is_empty()).unwrap_or_else(|| if user.is_empty() { String::new() } else { user.clone() });
            if user.is_empty() && owner.is_empty() {
                return Err("Type a password".into());
            }
            // permissions bits (ISO 32000-2 Table 22): print 3, modify 4, copy 5, annotate 6,
            // fill forms 9, accessibility 10, assemble 11, high-quality print 12
            let allow = |k: &str| a["allow"].get(k).and_then(|v| v.as_bool()).unwrap_or(true);
            let mut p: i32 = -1; // all allowed
            for (k, bit) in [("print", 3), ("modify", 4), ("copy", 5), ("annotate", 6), ("forms", 9), ("assemble", 11), ("printHigh", 12)] {
                if !allow(k) {
                    p &= !(1 << (bit - 1));
                }
            }
            let enc = pdfcraft_cos::NewEncryption { algorithm: pdfcraft_cos::Algorithm::Aes256, user_password: &user, owner_password: &owner, permissions: p, encrypt_metadata: true, seed: seed() };
            d.set_encryption(&enc).map_err(|e| e.to_string())?;
            save_full(&d, &output()?, false)?;
            Ok(json!({ "output": output()? }))
        }
        "unlock" => {
            let mut d = open(&input()?, pw.as_deref())?;
            d.remove_encryption();
            save_full(&d, &output()?, true)?;
            Ok(json!({ "output": output()? }))
        }
        "redact" => {
            // areas from the window: [{page (0-based), rect: [x0, y0, x1, y1] in PDF points}]
            let mut d = open(&input()?, pw.as_deref())?;
            let areas = a["areas"].as_array().ok_or("Mark what to remove first")?;
            let meta = pdfcraft_annot::Meta { date: None, id: String::new() };
            let mut pages = std::collections::BTreeSet::new();
            for (i, ar) in areas.iter().enumerate() {
                let page = ar["page"].as_u64().ok_or("area without page")? as usize;
                let r: Vec<f64> = ar["rect"].as_array().map(|v| v.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default();
                if r.len() != 4 {
                    continue;
                }
                let (x0, y0, x1, y1) = (r[0].min(r[2]), r[1].min(r[3]), r[0].max(r[2]), r[1].max(r[3]));
                let quad = [x0, y1, x1, y1, x0, y0, x1, y0];
                let shape = pdfcraft_annot::Shape::Redact { quads: vec![quad], overlay: String::new(), look: Default::default() };
                let new = pdfcraft_annot::NewAnnotation { page, style: pdfcraft_annot::Style::default_for(&shape), shape, contents: String::new(), author: "Callio".into() };
                let m = pdfcraft_annot::Meta { id: format!("callio-redact-{i}"), ..meta.clone() };
                pdfcraft_annot::add_annotation(&mut d, &new, &m).map_err(|e| e.to_string())?;
                pages.insert(page);
            }
            let p: Vec<usize> = pages.into_iter().collect();
            let report = pdfcraft_redact::apply(&mut d, Some(&p)).map_err(|e| e.to_string())?;
            let _ = report;
            // a redacted file is written whole: the removed content can't be found in older revisions
            save_full(&d, &output()?, true)?;
            Ok(json!({ "output": output()?, "areas": areas.len() }))
        }
        "metadata" => {
            let mut d = open(&input()?, pw.as_deref())?;
            if let Some(m) = a["info"].as_object() {
                for (k, v) in m {
                    let v = v.as_str().unwrap_or("");
                    pdfcraft_organize::set_info(&mut d, k, v).map_err(|e| e.to_string())?;
                }
            }
            save_full(&d, &output()?, true)?;
            Ok(json!({ "output": output()? }))
        }
        "attach" => {
            let mut d = open(&input()?, pw.as_deref())?;
            for f in a["files"].as_array().ok_or("Pick files to attach")?.iter().filter_map(|v| v.as_str()) {
                let bytes = std::fs::read(f).map_err(|e| format!("{f}: {e}"))?;
                let name = std::path::Path::new(f).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
                pdfcraft_organize::add_attachment(&mut d, &name, &bytes, None, pdfcraft_organize::mime_for_name(&name), None).map_err(|e| e.to_string())?;
            }
            save_full(&d, &output()?, true)?;
            Ok(json!({ "output": output()? }))
        }
        "images" => {
            let files: Vec<String> = a["inputs"].as_array().ok_or("Pick pictures")?.iter().filter_map(|v| v.as_str().map(String::from)).collect();
            let mut imgs = vec![];
            for f in &files {
                let name = std::path::Path::new(f).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                imgs.push((name, std::fs::read(f).map_err(|e| format!("{f}: {e}"))?));
            }
            let d = pdfcraft_create::from_images(&imgs).map_err(|e| e.to_string())?;
            save_full(&d, &output()?, true)?;
            Ok(json!({ "output": output()?, "pages": imgs.len() }))
        }
        "blank" => {
            let w = a["width"].as_f64().unwrap_or(595.276);
            let h = a["height"].as_f64().unwrap_or(841.89);
            let d = pdfcraft_create::blank(w, h, a["pages"].as_u64().unwrap_or(1).clamp(1, 1000) as usize).map_err(|e| e.to_string())?;
            save_full(&d, &output()?, true)?;
            Ok(json!({ "output": output()? }))
        }
        o => Err(format!("Unknown PDF tool {o}")),
    }
}

fn rgb(hex: &str) -> [f64; 3] {
    let h = hex.trim_start_matches('#');
    let v = u32::from_str_radix(h, 16).unwrap_or(0);
    [((v >> 16) & 255) as f64 / 255.0, ((v >> 8) & 255) as f64 / 255.0, (v & 255) as f64 / 255.0]
}

fn today() -> (i64, u32, u32) {
    // days since 1970 → civil date (Howard Hinnant's algorithm)
    let days = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Several pages on one sheet: `per` = 2, 4, 6, 8, 9 or 16; the sheet is the first page's
/// size (turned to landscape for 2, 6 and 8 up).
fn nup(a: &Json, input: &str, pw: Option<&str>, output: &str) -> Result<Json, String> {
    let src = open(input, pw)?;
    let n = count(&src)?;
    let per = a["per"].as_u64().unwrap_or(2) as usize;
    let (cols, rows) = match per {
        2 => (2, 1),
        4 => (2, 2),
        6 => (3, 2),
        8 => (4, 2),
        9 => (3, 3),
        16 => (4, 4),
        _ => return Err("Pages per sheet: 2, 4, 6, 8, 9 or 16".into()),
    };
    let b0 = pdfcraft_organize::page_boxes(&src).map_err(|e| e.to_string())?.first().copied().ok_or("The PDF has no pages")?[1];
    let (pw0, ph0) = (b0[2] - b0[0], b0[3] - b0[1]);
    let (sw, sh) = if cols > rows { (pw0.max(ph0), pw0.min(ph0)) } else { (pw0.min(ph0), pw0.max(ph0)) };
    let border = a["border"].as_bool().unwrap_or(false);
    let gap = 8.0;
    let mut dst = Document::new_empty();
    let sheets = n.div_ceil(per);
    for s in 0..sheets {
        let page = pdfcraft_organize::insert_blank_page(&mut dst, s, sw, sh).map_err(|e| e.to_string())?;
        let mut xobj = Dict::new();
        let mut content = String::new();
        let cw = (sw - gap * (cols as f64 + 1.0)) / cols as f64;
        let ch = (sh - gap * (rows as f64 + 1.0)) / rows as f64;
        for k in 0..per {
            let i = s * per + k;
            if i >= n {
                break;
            }
            let (form, (fw, fh)) = pdfcraft_organize::page_as_form(&mut dst, &src, i).map_err(|e| e.to_string())?;
            let name = format!("P{k}");
            xobj.set(name.as_bytes().to_vec(), Object::Ref(form));
            let (cx, cy) = (k % cols, k / cols);
            let scale = (cw / fw).min(ch / fh);
            let x = gap + cx as f64 * (cw + gap) + (cw - fw * scale) / 2.0;
            let y = sh - gap - (cy as f64 + 1.0) * ch - cy as f64 * gap + (ch - fh * scale) / 2.0;
            content.push_str(&format!("q {scale:.5} 0 0 {scale:.5} {x:.3} {y:.3} cm /{name} Do Q\n"));
            if border {
                content.push_str(&format!("q 0.5 w 0.6 G {:.3} {:.3} {:.3} {:.3} re S Q\n", x, y, fw * scale, fh * scale));
            }
        }
        let mut res = Dict::new();
        res.set(b"XObject".to_vec(), Object::Dict(xobj));
        let stream = Stream::flate(Dict::new(), content.as_bytes());
        let cref = dst.add(Object::Stream(stream));
        dst.update_dict(page, |d| {
            d.set(b"Resources".to_vec(), Object::Dict(res));
            d.set(b"Contents".to_vec(), Object::Ref(cref));
        })
        .map_err(|e| e.to_string())?;
    }
    save_full(&dst, output, true)?;
    Ok(json!({ "output": output, "pages": sheets }))
}
