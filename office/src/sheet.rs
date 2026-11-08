//! Spreadsheets through GridCraft: XLSX (styles, themes, formulas incl. dynamic arrays, tables,
//! conditional formats, validation, comments, links, charts, pictures, sparklines, pivots and
//! print settings round-trip), XLS, XLSB and ODS (data), CSV/TSV. The window asks for the cells
//! it shows ([`view`]); edits go through the GridCraft engine (recalculation, undo).

use std::collections::HashMap;

use base64::Engine as _;
use gridcraft_core::{CellRef, RangeRef, Value};
use gridcraft_engine::cf::CfCache;
use gridcraft_engine::{DocState, Session, Trust};
use gridcraft_model::{BorderLine, BorderStyle, Color, HAlign, PatternType, Sheet, Style, Underline, VAlign, Workbook};
use serde_json::{Value as Json, json};

pub const READS: &[&str] = &["xlsx", "xlsm", "xltx", "xltm", "xls", "xlsb", "ods", "csv", "tsv", "txt"];

pub struct Book {
    pub session: Session,
    pub path: String,
}

impl Book {
    fn doc(&self) -> Result<&DocState, String> {
        self.session.active().ok_or_else(|| "No workbook".to_string())
    }
    pub fn wb(&self) -> Result<&Workbook, String> {
        Ok(&self.doc()?.wb)
    }
}

pub fn open(path: &str, password: Option<&str>) -> Result<(Book, Vec<String>), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Couldn't read {path}: {e}"))?;
    let name = std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let (wb, warnings) = gridcraft_engine::io::open_bytes_with_password(&name, &bytes, password).map_err(|e| {
        let m = e.to_string();
        if m.to_lowercase().contains("password") || m.to_lowercase().contains("encrypt") { format!("PASSWORD: {m}") } else { m }
    })?;
    let mut session = Session::new();
    // Workbooks are recalculated on open (files from other programs may carry no results);
    // very large ones keep the results they were saved with, until an edit reaches them.
    let cells: usize = wb.sheets.iter().map(|s| s.cells.len()).sum();
    let d = if cells > 400_000 { DocState::from_saved(wb, Some(path.into()), name, Trust::FromFile) } else { DocState::new(wb, Some(path.into()), name, Trust::FromFile) };
    session.add_document(d);
    Ok((Book { session, path: path.into() }, warnings))
}

fn hex(rgb: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])
}
fn col(c: Color, wb: &Workbook) -> Option<String> {
    c.resolve(&wb.theme).map(hex)
}

pub fn summary(b: &Book) -> Result<Json, String> {
    let wb = b.wb()?;
    let sheets: Vec<Json> = wb
        .sheets
        .iter()
        .map(|s| {
            json!({
                "name": s.name,
                "hidden": !matches!(s.visibility, gridcraft_model::Visibility::Visible),
                "tab": s.tab_color.and_then(|c| col(c, wb)),
            })
        })
        .collect();
    Ok(json!({ "sheets": sheets, "active": wb.active_sheet(), "dirty": b.doc()?.is_dirty() }))
}

/// Sizes, frozen panes, merges, pictures and charts of one sheet.
pub fn meta(b: &Book, si: usize) -> Result<Json, String> {
    let wb = b.wb()?;
    let sh = wb.sheet(si).ok_or("No such sheet")?;
    let cols: Vec<Json> = sh.cols.iter().map(|(i, l)| json!([i, l.size, l.hidden])).collect();
    let rows: Vec<Json> = sh.rows.iter().map(|(i, l)| json!([i, l.size, l.hidden])).collect();
    let used = sh.used_range();
    let merges: Vec<Json> = sh.merges.iter().map(|m| json!([m.start.row, m.start.col, m.end.row, m.end.col])).collect();
    let pt = 96.0 / 72.0;
    let mut pictures = vec![];
    for img in &sh.images {
        pictures.push(json!({
            "row": img.anchor.cell.row, "col": img.anchor.cell.col,
            "dx": img.anchor.dx * pt, "dy": img.anchor.dy * pt, "w": img.anchor.width * pt, "h": img.anchor.height * pt,
            "src": format!("data:{};base64,{}", if img.mime.is_empty() { "image/png" } else { &img.mime }, base64::engine::general_purpose::STANDARD.encode(&*img.data)),
            "alt": img.alt,
        }));
    }
    let mut charts = vec![];
    for ch in &sh.charts {
        if let Some(svg) = crate::chart_svg::chart_svg(wb, si, ch) {
            charts.push(json!({
                "row": ch.anchor.cell.row, "col": ch.anchor.cell.col,
                "dx": ch.anchor.dx * pt, "dy": ch.anchor.dy * pt, "w": ch.anchor.width * pt, "h": ch.anchor.height * pt,
                "svg": svg,
            }));
        }
    }
    Ok(json!({
        "name": sh.name,
        "defaultW": sh.default_col_width, "defaultH": sh.default_row_height,
        "cols": cols, "rows": rows,
        "used": used.map(|u| json!([u.end.row, u.end.col])),
        "freeze": sh.freeze.map(|(r, c)| json!([r, c])),
        "merges": merges,
        "gridlines": sh.show_gridlines,
        "rtl": sh.right_to_left,
        "zoom": sh.zoom,
        "pictures": pictures,
        "charts": charts,
    }))
}

fn border(l: &BorderLine, wb: &Workbook) -> Json {
    if l.style == BorderStyle::None {
        return Json::Null;
    }
    let kind = match l.style {
        BorderStyle::Dashed | BorderStyle::MediumDashed | BorderStyle::DashDot | BorderStyle::MediumDashDot | BorderStyle::DashDotDot | BorderStyle::MediumDashDotDot | BorderStyle::SlantDashDot => "dash",
        BorderStyle::Dotted | BorderStyle::Hair => "dot",
        BorderStyle::Double => "double",
        _ => "solid",
    };
    json!([l.style.width(), kind, col(l.color, wb).unwrap_or_else(|| "#000000".into())])
}

/// The look of a cell: its style, a table's style, then conditional formats on top.
fn look(wb: &Workbook, si: usize, sh: &Sheet, c: CellRef, cf: &mut CfCache) -> (Style, Option<gridcraft_engine::cf::CfLook>) {
    let mut style = wb.styles.get(sh.style_id(c)).clone();
    if let Some(t) = sh.table_at(c) {
        style = gridcraft_engine::tables::table_cell_style(wb, si, t, c);
    }
    let cfl = cf.look(wb, si, c);
    if let Some(l) = &cfl
        && let Some(st) = &l.style
    {
        if st.fill.pattern != PatternType::None {
            style.fill = st.fill;
        }
        if st.font.color != Color::Auto {
            style.font.color = st.font.color;
        }
        style.font.bold |= st.font.bold;
        style.font.italic |= st.font.italic;
        if st.font.underline != Underline::None {
            style.font.underline = st.font.underline;
        }
        style.font.strike |= st.font.strike;
        if st.num_fmt.as_str() != "General" {
            style.num_fmt = st.num_fmt.clone();
        }
        for (dst, src) in [
            (&mut style.borders.left, st.borders.left),
            (&mut style.borders.right, st.borders.right),
            (&mut style.borders.top, st.borders.top),
            (&mut style.borders.bottom, st.borders.bottom),
        ] {
            if !src.is_none() {
                *dst = src;
            }
        }
    }
    (style, cfl)
}

/// Cells of rows r0..=r1 × cols c0..=c1 that show something (a value, a fill, a border…).
/// Looks are shared: `styles[i]` is referenced by index from each cell.
pub fn view(b: &Book, si: usize, r0: u32, r1: u32, c0: u32, c1: u32) -> Result<Json, String> {
    let wb = b.wb()?;
    let sh = wb.sheet(si).ok_or("No such sheet")?;
    let r1 = r1.min(r0 + 400);
    let c1 = c1.min(c0 + 200);
    let mut cf = CfCache::new();
    let mut styles: Vec<Json> = vec![];
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut cells = vec![];
    // also cells with only a column/row style (a coloured column) — cheap enough for one screen
    for r in r0..=r1 {
        if sh.row_height(r) == 0.0 {
            continue;
        }
        for c in c0..=c1 {
            if sh.col_width(c) == 0.0 {
                continue;
            }
            let at = CellRef { row: r, col: c };
            let v = sh.value(at);
            let sid = sh.style_id(at);
            let has_cf = !sh.cond_formats.is_empty();
            let pic = sh.cell_pictures.get(&at);
            if matches!(v, Value::Empty) && sid == Default::default() && !has_cf && pic.is_none() && !sh.comments.contains_key(&at) {
                continue;
            }
            let (st, cfl) = look(wb, si, sh, at, &mut cf);
            let f = gridcraft_engine::display::format(&v, st.num_fmt.as_str(), wb);
            let mut fill = match st.fill.pattern {
                PatternType::None => None,
                PatternType::Solid => st.fill.fg.resolve(&wb.theme).map(hex),
                _ => {
                    let fg = st.fill.fg.resolve(&wb.theme).unwrap_or([0, 0, 0]);
                    let bg = st.fill.bg.resolve(&wb.theme).unwrap_or([255, 255, 255]);
                    Some(hex([((fg[0] as u16 + bg[0] as u16 * 3) / 4) as u8, ((fg[1] as u16 + bg[1] as u16 * 3) / 4) as u8, ((fg[2] as u16 + bg[2] as u16 * 3) / 4) as u8]))
                }
            };
            if let Some(l) = &cfl
                && let Some(rgb) = l.scale_fill
            {
                fill = Some(hex(rgb));
            }
            let color = f.color.and_then(|c| c.rgb()).map(hex).or_else(|| col(st.font.color, wb));
            let h = match st.align.h {
                HAlign::General => {
                    if matches!(v, Value::Bool(_) | Value::Error(_)) {
                        "c"
                    } else if f.numeric {
                        "r"
                    } else {
                        "l"
                    }
                }
                HAlign::Left => "l",
                HAlign::Center | HAlign::CenterAcross | HAlign::Distributed => "c",
                HAlign::Right => "r",
                HAlign::Fill => "f",
                HAlign::Justify => "j",
            };
            let va = match st.align.v {
                VAlign::Top => "t",
                VAlign::Center | VAlign::Justify | VAlign::Distributed => "m",
                VAlign::Bottom => "b",
            };
            let lk = json!({
                "f": st.font.name, "s": st.font.size, "b": st.font.bold, "i": st.font.italic,
                "u": st.font.underline != Underline::None, "st": st.font.strike,
                "c": color, "bg": fill, "h": h, "v": va, "w": st.align.wrap, "in": st.align.indent, "rot": st.align.rotation,
                "bl": border(&st.borders.left, wb), "br": border(&st.borders.right, wb), "bt": border(&st.borders.top, wb), "bb": border(&st.borders.bottom, wb),
            });
            let key = lk.to_string();
            let idx = *index.entry(key).or_insert_with(|| {
                styles.push(lk);
                styles.len() - 1
            });
            let hide = cfl.as_ref().is_some_and(|l| l.hide_value);
            let text = if hide || matches!(v, Value::Empty) {
                String::new()
            } else {
                match f.fill {
                    Some((_, pos)) => {
                        let mut t = f.text.clone();
                        if pos <= t.len() && t.is_char_boundary(pos) {
                            t.insert(pos, ' ');
                        }
                        t
                    }
                    None => f.text.clone(),
                }
            };
            let mut cell = json!([r, c, text, idx]);
            let mut extra = serde_json::Map::new();
            if let Some(l) = &cfl {
                if let Some((frac, rgb, grad)) = l.bar {
                    extra.insert("bar".into(), json!([frac, hex(rgb), grad]));
                }
                if let Some((set, i)) = &l.icon {
                    extra.insert("icon".into(), json!([set, i]));
                }
            }
            if sh.comments.contains_key(&at) {
                extra.insert("note".into(), json!(true));
            }
            if sh.hyperlinks.contains_key(&at) {
                extra.insert("link".into(), json!(true));
            }
            if f.numeric {
                extra.insert("num".into(), json!(true));
            }
            if let Some(p) = pic {
                extra.insert("pic".into(), json!(format!("data:{};base64,{}", if p.mime.is_empty() { "image/png" } else { &p.mime }, base64::engine::general_purpose::STANDARD.encode(&p.data))));
            }
            if !extra.is_empty()
                && let Some(a) = cell.as_array_mut()
            {
                a.push(Json::Object(extra));
            }
            cells.push(cell);
        }
    }
    Ok(json!({ "cells": cells, "styles": styles }))
}

/// What the formula bar shows for a cell, with its note and link.
pub fn cell(b: &Book, si: usize, r: u32, c: u32) -> Result<Json, String> {
    let wb = b.wb()?;
    let sh = wb.sheet(si).ok_or("No such sheet")?;
    let at = CellRef { row: r, col: c };
    let edit = if gridcraft_engine::display::formula_hidden(wb, sh, at) { String::new() } else { gridcraft_engine::display::edit_text(wb, sh, at) };
    let comment = sh.comments.get(&at).map(|n| {
        let mut t = format!("{}{}", if n.author.is_empty() { String::new() } else { format!("{}: ", n.author) }, n.text);
        for (a, r) in &n.replies {
            t.push_str(&format!("\n{a}: {r}"));
        }
        t
    });
    let link = sh.hyperlinks.get(&at).map(|h| h.target.clone());
    let merge = sh.merges.iter().find(|m| m.contains(at)).map(|m| json!([m.start.row, m.start.col, m.end.row, m.end.col]));
    Ok(json!({
        "a1": at.a1(), "edit": edit, "text": gridcraft_engine::display::value_text(wb, sh, at),
        "formula": sh.cell(at).and_then(|x| x.formula.as_ref()).is_some(),
        "comment": comment, "link": link, "merge": merge,
    }))
}

pub fn exec(b: &mut Book, cmd: &str, params: Json) -> Result<Json, String> {
    b.session.execute(cmd, params).map_err(|e| e.to_string())
}

pub fn save(b: &Book, out: &str) -> Result<(), String> {
    let wb = b.wb()?;
    let bytes = gridcraft_engine::io::save_bytes(wb, out).map_err(|e| e.to_string())?;
    crate::write_safely(out, &bytes)
}

/// Every visible sheet as a Markdown table (what each cell shows).
pub fn markdown(b: &Book) -> Result<String, String> {
    let wb = b.wb()?;
    let mut out = String::new();
    let many = wb.sheets.iter().filter(|s| matches!(s.visibility, gridcraft_model::Visibility::Visible)).count() > 1;
    for (si, sh) in wb.sheets.iter().enumerate() {
        if !matches!(sh.visibility, gridcraft_model::Visibility::Visible) {
            continue;
        }
        let Some(u) = sh.used_range() else { continue };
        if many {
            out.push_str(&format!("## {}\n\n", sh.name));
        }
        let rows: Vec<u32> = (u.start.row..=u.end.row).filter(|&r| sh.row_height(r) > 0.0).collect();
        let cols: Vec<u32> = (u.start.col..=u.end.col).filter(|&c| sh.col_width(c) > 0.0).collect();
        let cell_md = |r: u32, c: u32| {
            let at = CellRef { row: r, col: c };
            let t = gridcraft_engine::display::value_text(wb, sh, at);
            let st = wb.styles.get(sh.style_id(at));
            let mut t = t.replace('|', "\\|").replace('\n', "<br>");
            if !t.is_empty() {
                if st.font.bold {
                    t = format!("**{t}**");
                }
                if st.font.italic {
                    t = format!("*{t}*");
                }
                if let Some(h) = sh.hyperlinks.get(&at)
                    && h.target.contains("://")
                {
                    t = format!("[{t}]({})", h.target.replace(' ', "%20"));
                }
            }
            t
        };
        for (i, &r) in rows.iter().enumerate() {
            out.push('|');
            for &c in &cols {
                out.push_str(&format!(" {} |", cell_md(r, c)));
            }
            out.push('\n');
            if i == 0 {
                out.push('|');
                for &c in &cols {
                    let at = CellRef { row: rows.get(1).copied().unwrap_or(r), col: c };
                    let num = matches!(sh.value(at), Value::Number(_));
                    out.push_str(if num { " ---: |" } else { " --- |" });
                }
                out.push('\n');
            }
        }
        out.push('\n');
        let _ = (si, RangeRef::default());
    }
    Ok(out)
}

/// The undo and redo lists (newest first, at most 100 each) and whether each is possible.
pub fn history(b: &Book) -> Json {
    let Ok(d) = b.session.doc() else { return json!({ "undo": [], "redo": [] }) };
    let undo: Vec<&str> = d.undo.iter().rev().take(100).map(|e| e.label.as_str()).collect();
    let redo: Vec<&str> = d.redo.iter().rev().take(100).map(|e| e.label.as_str()).collect();
    json!({ "undo": undo, "redo": redo })
}

/// Undo (or redo) the newest `n` steps.
pub fn undo_n(b: &mut Book, n: usize, redo: bool) -> Result<(), String> {
    for _ in 0..n.max(1) {
        let can = b.session.doc().map(|d| if redo { !d.redo.is_empty() } else { !d.undo.is_empty() }).unwrap_or(false);
        if !can {
            break;
        }
        b.session.execute(if redo { "edit.redo" } else { "edit.undo" }, json!({})).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Several commands as one undo step named `label` (the AI's edits).
pub fn batch(b: &mut Book, label: &str, cmds: &[Json]) -> Result<Vec<Json>, String> {
    let n0 = b.session.doc().map(|d| d.undo.len()).unwrap_or(0);
    let mut out = vec![];
    for c in cmds {
        let id = c["command"].as_str().unwrap_or_default();
        let params = c.get("params").cloned().unwrap_or(json!({}));
        out.push(match b.session.execute(id, params) {
            Ok(r) => json!({ "ok": true, "result": r }),
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        });
    }
    if let Ok(d) = b.session.doc_mut() {
        if d.undo.len() > n0 {
            let mut first = d.undo[n0].clone();
            d.undo.truncate(n0);
            first.label = label.to_string();
            d.undo.push(first);
        }
    }
    Ok(out)
}

/// The cells of `range` ("A1:D20"; the used range when left out) of sheet `si`: what each shows
/// and, for formulas, the formula — for the AI.
pub fn read(b: &Book, si: usize, range: Option<&str>) -> Result<Json, String> {
    let wb = b.wb()?;
    let sh = wb.sheet(si).ok_or("No such sheet")?;
    let (r0, c0, r1, c1) = match range.and_then(parse_range) {
        Some(r) => r,
        None => match sh.used_range() {
            Some(u) => (u.start.row, u.start.col, u.end.row, u.end.col),
            None => return Ok(json!({ "sheet": sh.name, "cells": [] })),
        },
    };
    let (r1, c1) = (r1.min(r0 + 499), c1.min(c0 + 99));
    let mut rows = vec![];
    for r in r0..=r1 {
        let mut row = vec![];
        for c in c0..=c1 {
            let at = CellRef { row: r, col: c };
            let shown = gridcraft_engine::display::value_text(wb, sh, at);
            let edit = gridcraft_engine::display::edit_text(wb, sh, at);
            if edit.starts_with('=') { row.push(json!([shown, edit])) } else { row.push(json!(shown)) }
        }
        rows.push(json!(row));
    }
    Ok(json!({ "sheet": sh.name, "from": cell_name(r0, c0), "to": cell_name(r1, c1), "rows": rows }))
}

fn col_name(mut c: u32) -> String {
    let mut s = String::new();
    c += 1;
    while c > 0 {
        let m = (c - 1) % 26;
        s.insert(0, (b'A' + m as u8) as char);
        c = (c - 1) / 26;
    }
    s
}
fn cell_name(r: u32, c: u32) -> String {
    format!("{}{}", col_name(c), r + 1)
}
fn parse_cell(s: &str) -> Option<(u32, u32)> {
    let s = s.trim().replace('$', "").to_uppercase();
    let i = s.find(|ch: char| ch.is_ascii_digit())?;
    let (letters, digits) = s.split_at(i);
    if letters.is_empty() {
        return None;
    }
    let mut c = 0u32;
    for ch in letters.chars() {
        if !ch.is_ascii_uppercase() {
            return None;
        }
        c = c * 26 + (ch as u32 - 'A' as u32 + 1);
    }
    Some((digits.parse::<u32>().ok()?.checked_sub(1)?, c - 1))
}
fn parse_range(s: &str) -> Option<(u32, u32, u32, u32)> {
    let s = s.rsplit('!').next()?;
    let (a, b) = s.split_once(':').unwrap_or((s, s));
    let (r0, c0) = parse_cell(a)?;
    let (r1, c1) = parse_cell(b)?;
    Some((r0.min(r1), c0.min(c1), r0.max(r1), c0.max(c1)))
}

/// Every GridCraft command, for the command search.
pub fn commands(b: &Book) -> Json {
    serde_json::to_value(b.session.commands()).unwrap_or(json!([]))
}
