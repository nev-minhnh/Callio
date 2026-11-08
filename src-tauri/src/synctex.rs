//! Minimal SyncTeX reader: forward (source line → PDF spot) and inverse (PDF click → source line).
use crate::util::{path_key, resolve, CmdResult, ErrStr};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// SyncTeX coordinates are TeX scaled points; 65781.76 sp = 1 PDF big point.
const SP_PER_BP: f64 = 65781.76;

#[derive(Clone, Debug)]
struct Rec {
    kind: u8, // b'(' hbox, b'[' vbox, b'h' void hbox, b'v' void vbox, b'x' b'k' b'g' b'$'
    tag: u32,
    line: u32,
    page: u32,
    h: f64,
    v: f64,
    w: f64,
    ht: f64,
    dp: f64,
}

pub struct Sync {
    inputs: HashMap<u32, String>,
    recs: Vec<Rec>,
}

pub struct SyncCache(pub Mutex<HashMap<String, (SystemTime, std::sync::Arc<Sync>)>>);

fn synctex_file(pdf: &Path) -> Option<PathBuf> {
    let stem = pdf.file_stem()?.to_string_lossy().to_string();
    let dir = pdf.parent()?;
    for n in [format!("{stem}.synctex.gz"), format!("{stem}.synctex")] {
        let p = dir.join(n);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn parse(text: &str, base: &Path) -> Sync {
    let mut inputs = HashMap::new();
    let mut recs = Vec::new();
    let (mut unit, mut mag, mut xoff, mut yoff) = (1.0f64, 1000.0f64, 0.0f64, 0.0f64);
    let mut page = 0u32;
    let mut in_content = false;
    for line in text.lines() {
        if !in_content {
            if let Some(r) = line.strip_prefix("Input:") {
                if let Some((t, p)) = r.split_once(':') {
                    if let Ok(t) = t.parse() {
                        // Overleaf compiles in /compile/…; map back onto the local folder.
                        let p = p.strip_prefix("/compile/").unwrap_or(p);
                        inputs.insert(t, resolve(base, p).to_string_lossy().to_string());
                    }
                }
            } else if let Some(r) = line.strip_prefix("Unit:") {
                unit = r.trim().parse().unwrap_or(1.0);
            } else if let Some(r) = line.strip_prefix("Magnification:") {
                mag = r.trim().parse().unwrap_or(1000.0);
            } else if let Some(r) = line.strip_prefix("X Offset:") {
                xoff = r.trim().parse().unwrap_or(0.0);
            } else if let Some(r) = line.strip_prefix("Y Offset:") {
                yoff = r.trim().parse().unwrap_or(0.0);
            } else if line.starts_with("Content:") {
                in_content = true;
            }
            continue;
        }
        if let Some(r) = line.strip_prefix("Input:") {
            if let Some((t, p)) = r.split_once(':') {
                if let Ok(t) = t.parse() {
                    let p = p.strip_prefix("/compile/").unwrap_or(p);
                    inputs.insert(t, resolve(base, p).to_string_lossy().to_string());
                }
            }
            continue;
        }
        let b = line.as_bytes();
        if b.is_empty() {
            continue;
        }
        match b[0] {
            b'{' => page = line[1..].trim().parse().unwrap_or(page + 1),
            b'(' | b'[' | b'h' | b'v' | b'x' | b'k' | b'g' | b'$' => {
                let body = &line[1..];
                let mut parts = body.split(':');
                let (Some(tl), Some(hv)) = (parts.next(), parts.next()) else { continue };
                let mut tl = tl.split(',');
                let (Some(Ok(tag)), Some(Ok(ln))) = (tl.next().map(|x| x.parse::<u32>()), tl.next().map(|x| x.parse::<u32>())) else { continue };
                let mut hvv = hv.split(',');
                let (Some(Ok(h)), Some(Ok(v))) = (hvv.next().map(|x| x.parse::<f64>()), hvv.next().map(|x| x.parse::<f64>())) else { continue };
                let mut whd = parts.next().unwrap_or("").split(',').map(|x| x.parse::<f64>().unwrap_or(0.0));
                let (w, ht, dp) = (whd.next().unwrap_or(0.0), whd.next().unwrap_or(0.0), whd.next().unwrap_or(0.0));
                let s = unit * mag / 1000.0 / SP_PER_BP;
                recs.push(Rec {
                    kind: b[0],
                    tag,
                    line: ln,
                    page,
                    h: h * s + xoff / SP_PER_BP,
                    v: v * s + yoff / SP_PER_BP,
                    w: w * s,
                    ht: ht * s,
                    dp: dp * s,
                });
            }
            _ => {}
        }
        if line.starts_with("Postamble") {
            break;
        }
    }
    Sync { inputs, recs }
}

fn load(cache: &SyncCache, pdf: &str) -> anyhow::Result<std::sync::Arc<Sync>> {
    let pdfp = Path::new(pdf);
    let f = synctex_file(pdfp).ok_or_else(|| anyhow::anyhow!("No SyncTeX data for this PDF (recompile first)"))?;
    let mt = std::fs::metadata(&f)?.modified()?;
    if let Some((t, s)) = cache.0.lock().unwrap().get(pdf) {
        if *t == mt {
            return Ok(s.clone());
        }
    }
    let raw = std::fs::read(&f)?;
    let text = if f.extension().map(|e| e == "gz").unwrap_or(false) {
        let mut d = flate2::read::MultiGzDecoder::new(&raw[..]);
        let mut s = String::new();
        d.read_to_string(&mut s)?;
        s
    } else {
        String::from_utf8_lossy(&raw).to_string()
    };
    // Relative "Input:" paths are relative to the folder the engine ran in; compile()
    // records that folder next to the PDF.
    let base = std::fs::read_to_string(pdfp.with_file_name(".source-dir")).ok().map(|s| PathBuf::from(s.trim()));
    let base = base.unwrap_or_else(|| pdfp.parent().map(|p| p.to_path_buf()).unwrap_or_default());
    let s = parse(&text, &base);
    let arc = std::sync::Arc::new(s);
    cache.0.lock().unwrap().insert(pdf.to_string(), (mt, arc.clone()));
    Ok(arc)
}

fn same_file(a: &str, b: &str) -> bool {
    let (ka, kb) = (path_key(a), path_key(b));
    if ka == kb {
        return true;
    }
    // relative inputs: compare the tail
    ka.ends_with(&format!("/{}", kb.trim_start_matches("./"))) || kb.ends_with(&format!("/{}", ka.trim_start_matches("./")))
}

#[derive(Serialize, Debug)]
pub struct PdfSpot {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[tauri::command]
pub async fn synctex_forward(cache: tauri::State<'_, SyncCache>, pdf: String, file: String, line: u32) -> CmdResult<Option<PdfSpot>> {
    let s = load(&cache, &pdf).es()?;
    Ok(forward(&s, &file, line))
}

pub fn forward(s: &Sync, file: &str, line: u32) -> Option<PdfSpot> {
    let tags: Vec<u32> = s.inputs.iter().filter(|(_, p)| same_file(p, file)).map(|(t, _)| *t).collect();
    let tags = if tags.is_empty() {
        // fall back to file-name match
        let name = Path::new(file).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        s.inputs.iter().filter(|(_, p)| p.to_lowercase().ends_with(&name)).map(|(t, _)| *t).collect()
    } else {
        tags
    };
    if tags.is_empty() {
        return None;
    }
    // nearest line at or after the cursor, else before
    let cand: Vec<&Rec> = s.recs.iter().filter(|r| tags.contains(&r.tag)).collect();
    if cand.is_empty() {
        return None;
    }
    let best_line = cand
        .iter()
        .map(|r| r.line)
        .min_by_key(|&l| if l >= line { (0, l - line) } else { (1, line - l) })
        .unwrap();
    let on_line: Vec<&&Rec> = cand.iter().filter(|r| r.line == best_line).collect();
    let first_page = on_line.iter().map(|r| r.page).min().unwrap();
    let rs: Vec<&&Rec> = on_line.into_iter().filter(|r| r.page == first_page).collect();
    // union of the boxes on that line (prefer real boxes)
    let boxes: Vec<&&Rec> = rs.iter().copied().filter(|r| matches!(r.kind, b'(' | b'h') && r.w > 0.0).collect();
    let set = if boxes.is_empty() { rs } else { boxes };
    let top = set.iter().map(|r| r.v - r.ht.max(8.0)).fold(f64::MAX, f64::min);
    let bot = set.iter().map(|r| r.v + r.dp.max(2.0)).fold(f64::MIN, f64::max);
    let left = set.iter().map(|r| r.h).fold(f64::MAX, f64::min);
    let right = set.iter().map(|r| r.h + r.w).fold(f64::MIN, f64::max);
    Some(PdfSpot { page: first_page, x: left, y: top, w: (right - left).max(0.0), h: (bot - top).max(10.0) })
}

/// Every line of `file` that has a place in the PDF: [line, page, y (top, PDF points from the
/// page top)], in line order — one call gives the whole map, so scrolling never waits.
#[tauri::command]
pub async fn synctex_lines(cache: tauri::State<'_, SyncCache>, pdf: String, file: String) -> CmdResult<Vec<(u32, u32, f64)>> {
    let s = load(&cache, &pdf).es()?;
    Ok(lines(&s, &file))
}

pub fn lines(s: &Sync, file: &str) -> Vec<(u32, u32, f64)> {
    let mut tags: Vec<u32> = s.inputs.iter().filter(|(_, p)| same_file(p, file)).map(|(t, _)| *t).collect();
    if tags.is_empty() {
        let name = Path::new(file).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        tags = s.inputs.iter().filter(|(_, p)| p.to_lowercase().ends_with(&name)).map(|(t, _)| *t).collect();
    }
    // per line: the first page it appears on, and the top of its highest box there
    let mut best: std::collections::BTreeMap<u32, (u32, f64, bool)> = std::collections::BTreeMap::new();
    for r in s.recs.iter().filter(|r| tags.contains(&r.tag) && r.line > 0 && r.page > 0) {
        // whole-page vertical boxes say little about where a line is
        if matches!(r.kind, b'[' | b'v') {
            continue;
        }
        let is_box = matches!(r.kind, b'(' | b'h') && r.w > 0.0;
        let top = r.v - r.ht.max(if is_box { 0.0 } else { 8.0 });
        let e = best.entry(r.line).or_insert((r.page, top, is_box));
        if r.page < e.0 || (r.page == e.0 && ((is_box && !e.2) || (is_box == e.2 && top < e.1))) {
            *e = (r.page, top, is_box);
        }
    }
    best.into_iter().map(|(l, (p, y, _))| (l, p, y)).collect()
}

#[derive(Serialize, Debug)]
pub struct SrcSpot {
    pub file: String,
    pub line: u32,
}

#[tauri::command]
pub async fn synctex_inverse(cache: tauri::State<'_, SyncCache>, pdf: String, page: u32, x: f64, y: f64) -> CmdResult<Option<SrcSpot>> {
    let s = load(&cache, &pdf).es()?;
    Ok(inverse(&s, page, x, y))
}

pub fn inverse(s: &Sync, page: u32, x: f64, y: f64) -> Option<SrcSpot> {
    let on_page: Vec<&Rec> = s.recs.iter().filter(|r| r.page == page && r.line > 0).collect();
    // smallest horizontal box containing the point
    let mut best: Option<(&Rec, f64)> = None;
    for r in &on_page {
        if !matches!(r.kind, b'(' | b'h') {
            continue;
        }
        let (l, rr, t, b) = (r.h, r.h + r.w, r.v - r.ht, r.v + r.dp);
        if x >= l && x <= rr && y >= t && y <= b {
            let area = (rr - l) * (b - t);
            if best.map(|(_, a)| area < a).unwrap_or(true) {
                best = Some((r, area));
            }
        }
    }
    // within that box (or anywhere), the closest glyph-level record gives a better line
    let pick = {
        let mut pool: Vec<&&Rec> = match best {
            Some((bx, _)) => on_page.iter().filter(|r| r.v >= bx.v - bx.ht - 1.0 && r.v <= bx.v + bx.dp + 1.0).collect(),
            None => on_page.iter().collect(),
        };
        // A paragraph's line boxes carry the line where the paragraph *ended*; the glyph-level
        // records inside carry the real source lines, so prefer those.
        if let Some((bx, _)) = best {
            let glyphs: Vec<&&Rec> = pool.iter().copied().filter(|r| matches!(r.kind, b'x' | b'k' | b'g' | b'$') && r.line != bx.line).collect();
            if !glyphs.is_empty() {
                pool = glyphs;
            }
        }
        pool.into_iter()
            .min_by(|a, b| {
                let da = (a.h - x).abs() + 3.0 * (a.v - y).abs();
                let db = (b.h - x).abs() + 3.0 * (b.v - y).abs();
                da.partial_cmp(&db).unwrap()
            })
            .map(|r| (**r).clone())
            .or_else(|| best.map(|(r, _)| r.clone()))
    };
    pick.and_then(|r| s.inputs.get(&r.tag).map(|f| SrcSpot { file: f.clone(), line: r.line }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_records() {
        let t = "SyncTeX Version:1\nInput:1:/p/main.tex\nOutput:pdf\nMagnification:1000\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n!100\n{1\n[1,5:4736286,4736286:30000000,40000000,0\n(1,7:4736286,9472572:30000000,655360,196608\nx1,7:5000000,9472572\n)\n]\n}1\nPostamble:\n";
        let s = parse(t, Path::new("/p"));
        assert_eq!(s.recs.len(), 3);
        let r = &s.recs[1];
        assert_eq!(r.page, 1);
        assert!((r.h - 72.0).abs() < 0.01, "h={}", r.h);
        assert!((r.v - 144.0).abs() < 0.01);
    }
}
#[cfg(test)]
mod lines_tests {
    use super::*;
    #[test]
    #[ignore]
    fn real_lines() {
        let dir = std::env::var("SYNCTEX_DIR").unwrap();
        let raw = std::fs::read(format!("{dir}/t.synctex.gz")).unwrap();
        let mut d = flate2::read::MultiGzDecoder::new(&raw[..]);
        let mut t = String::new();
        d.read_to_string(&mut t).unwrap();
        let s = parse(&t, Path::new(&dir));
        let l = lines(&s, &format!("{dir}/t.tex"));
        for x in &l { println!("{:?}", x); }
        assert!(l.len() > 20);
    }
}
