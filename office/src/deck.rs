//! Editing PowerPoint presentations (.pptx, .ppsx, .potx, .odp) with DeckCraft: one editing
//! session per open file. The window shows the slides as pictures this module draws and puts
//! the selection, handles and text caret on top; clicks and drags are DeckCraft pointer events,
//! keys and typing go to DeckCraft's key handling, ribbon buttons are DeckCraft commands.

use base64::Engine as _;
use deckcraft_engine::{Mods, PointerEvent, PointerKind, Session, ToolKind};
use serde_json::{Value as Json, json};

pub struct Deck {
    pub session: Session,
    pub path: String,
}

pub const READS: &[&str] = &["pptx", "pptm", "ppsx", "ppsm", "potx", "potm", "odp", "ppt"];

pub fn open(path: &str) -> Result<Deck, String> {
    let mut session = Session::new();
    session.execute("file.open", &json!({ "path": path })).map_err(|e| e.to_string())?;
    session.ui_requests.clear();
    Ok(Deck { session, path: path.to_string() })
}

fn mods(v: &Json) -> Mods {
    let b = |n: &str| v.get(n).and_then(Json::as_bool).unwrap_or(false);
    Mods { shift: b("shift"), alt: b("alt"), cmd: b("cmd") || b("ctrl") }
}

/// What the window needs after a change.
pub fn state(d: &mut Deck) -> Json {
    let s = &d.session;
    let Some(st) = s.active() else { return json!({ "slides": [] }) };
    let size = deckcraft_engine::page_size(st);
    let sel = &st.selection;
    let slides: Vec<Json> = st.doc.slides.iter().map(|sl| json!({ "id": sl.id, "hidden": sl.hidden, "title": sl.title() })).collect();
    let mut boxes = vec![];
    for id in &sel.shapes {
        if let Some(sh) = st.shape(*id) {
            let x = deckcraft_engine::cmd::xfrm_of(&st.doc, sel, sh);
            boxes.push(json!({ "id": id, "x": x.x, "y": x.y, "w": x.w, "h": x.h, "rot": x.rot }));
        }
    }
    let (caret, text_sel) = match &sel.text {
        Some(t) if !t.notes => {
            let caret = deckcraft_engine::cmd::text::caret_line(st, t).map(|(a, b)| json!([a.x, a.y, b.x, b.y]));
            let mut rects = vec![];
            if t.anchor != t.caret {
                if let Some((l, m)) = deckcraft_engine::cmd::text::text_frame(st, t) {
                    let (a, b) = if t.anchor <= t.caret { (t.anchor, t.caret) } else { (t.caret, t.anchor) };
                    for r in l.selection_rects(deckcraft_text::Pos { para: a.0, ch: a.1 }, deckcraft_text::Pos { para: b.0, ch: b.1 }) {
                        let pts = [(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1)]
                            .map(|(x, y)| m * deckcraft_engine::geom::Point::new(x, y))
                            .map(|p| json!([p.x, p.y]));
                        rects.push(json!(pts));
                    }
                }
            }
            (caret, rects)
        }
        _ => (None, vec![]),
    };
    let undo: Vec<&str> = st.history.undo.iter().rev().take(100).map(|e| e.label.as_str()).collect();
    let redo: Vec<&str> = st.history.redo.iter().rev().take(100).map(|e| e.label.as_str()).collect();
    let notes = st.doc.slides.get(sel.slide).map(|sl| sl.notes_text()).unwrap_or_default();
    let sections: Vec<Json> = st.doc.sections.iter().map(|sc| json!({ "name": sc.name, "slides": sc.slides })).collect();
    json!({
        "rev": st.revision,
        "w": size.width, "h": size.height,
        "slides": slides,
        "sections": sections,
        "slide": sel.slide,
        "shapes": boxes,
        "editing": sel.text.is_some(),
        "notesEditing": sel.text.as_ref().is_some_and(|t| t.notes),
        "caret": caret,
        "textSel": text_sel,
        "notes": notes,
        "undo": undo,
        "redo": redo,
        "dirty": st.is_dirty(),
        "tool": serde_json::to_value(&s.tool.kind).unwrap_or_default(),
    })
}

/// The formatting at the selection (font, size, bold…), for the ribbon.
pub fn format(d: &mut Deck) -> Json {
    d.session.execute("format.state", &json!({})).unwrap_or(Json::Null)
}

pub fn run(d: &mut Deck, id: &str, params: &Json) -> Result<Json, String> {
    let r = d.session.execute(id, params).map_err(|e| e.to_string());
    d.session.ui_requests.clear();
    r
}

pub fn pointer(d: &mut Deck, a: &Json) -> Result<Json, String> {
    let kind = match a["kind"].as_str().unwrap_or("down") {
        "down" => PointerKind::Down,
        "drag" => PointerKind::Drag,
        "up" => PointerKind::Up,
        "move" => PointerKind::Move,
        "dblclick" => PointerKind::DoubleClick,
        "tripleclick" => PointerKind::TripleClick,
        "contextclick" => PointerKind::ContextClick,
        k => return Err(format!("unknown pointer kind {k}")),
    };
    let ev = PointerEvent { kind, x: a["x"].as_f64().unwrap_or(0.0), y: a["y"].as_f64().unwrap_or(0.0), mods: mods(a), tol: a["tol"].as_f64().unwrap_or(3.0), pressure: None };
    let r = d.session.pointer(ev).map_err(|e| e.to_string());
    d.session.ui_requests.clear();
    r
}

pub fn key(d: &mut Deck, key: &str, a: &Json) -> Result<Json, String> {
    let r = d.session.key(key, mods(a)).map_err(|e| e.to_string());
    d.session.ui_requests.clear();
    r
}

pub fn type_text(d: &mut Deck, text: &str) -> Result<Json, String> {
    d.session.type_text(text).map_err(|e| e.to_string())
}

pub fn tool(d: &mut Deck, name: &str, preset: Option<&str>) -> Result<(), String> {
    let kind = match name {
        "select" => ToolKind::Select,
        "textBox" => ToolKind::TextBox,
        "shape" => ToolKind::Shape { preset: preset.unwrap_or("rect").to_string() },
        other => ToolKind::Shape { preset: other.to_string() },
    };
    d.session.set_tool(kind);
    Ok(())
}

/// Slide `i` at `scale` pixels per point, as a PNG (base64). `edit`: with placeholder prompts.
pub fn render(d: &mut Deck, i: usize, scale: f64, edit: bool) -> Result<Json, String> {
    let st = d.session.active().ok_or("No presentation open")?;
    if i >= st.doc.slides.len() {
        return Err(format!("No slide {}", i + 1));
    }
    let scale = scale.clamp(0.02, 8.0);
    let img = deckcraft_engine::render::render_slide(&st.doc, i, &deckcraft_engine::render::RenderOpts { scale, edit, ..Default::default() });
    let png = img.to_png_at(deckcraft_engine::render::dpi_for_scale(scale));
    Ok(json!({ "png": base64::engine::general_purpose::STANDARD.encode(png), "width": img.width, "height": img.height, "rev": st.revision }))
}

/// Undo or redo the newest `n` steps.
pub fn undo_n(d: &mut Deck, n: usize, redo: bool) -> Result<(), String> {
    for _ in 0..n.max(1) {
        let can = d.session.active().map(|st| if redo { !st.history.redo.is_empty() } else { !st.history.undo.is_empty() }).unwrap_or(false);
        if !can {
            break;
        }
        run(d, if redo { "edit.redo" } else { "edit.undo" }, &json!({}))?;
    }
    Ok(())
}

/// Several commands as one undo step named `label` (the AI's edits).
pub fn batch(d: &mut Deck, label: &str, cmds: &[Json]) -> Vec<Json> {
    let n0 = d.session.active().map(|st| st.history.undo.len()).unwrap_or(0);
    let mut out = vec![];
    for c in cmds {
        let id = c["command"].as_str().unwrap_or_default();
        out.push(match run(d, id, &c.get("params").cloned().unwrap_or(json!({}))) {
            Ok(r) => json!({ "ok": true, "result": r }),
            Err(e) => json!({ "ok": false, "error": e }),
        });
    }
    if let Some(st) = d.session.active_mut() {
        if st.history.undo.len() > n0 {
            let mut first = st.history.undo[n0].clone();
            st.history.undo.truncate(n0);
            first.label = label.to_string();
            st.history.undo.push(first);
        }
    }
    out
}

/// Save (pptx, or by the extension: pdf, png…). `mark_saved`: the file is now the document's.
pub fn save(d: &mut Deck, out: &str, mark_saved: bool) -> Result<(), String> {
    let ext = std::path::Path::new(out).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if ext == "pptx" && mark_saved {
        run(d, "file.save", &json!({ "path": out, "format": "pptx" }))?;
    } else {
        run(d, "file.export", &json!({ "path": out }))?;
    }
    Ok(())
}

/// Every command, for the ribbon and the command search.
pub fn commands(d: &Deck) -> Json {
    serde_json::to_value(d.session.commands()).unwrap_or(json!([]))
}

/// The slides as text (titles, bodies, notes), for the AI.
pub fn text(d: &mut Deck) -> Json {
    run(d, "document.inspect", &json!({})).unwrap_or(Json::Null)
}

// ---------------- the writing assistant ----------------

/// The text of shape `id`, paragraph by paragraph.
fn paragraphs(d: &mut Deck, id: u64) -> Option<Vec<String>> {
    let v = run(d, "text.get", &json!({ "id": id })).ok()?;
    Some(v["paragraphs"].as_array()?.iter().map(|p| p["text"].as_str().unwrap_or("").to_string()).collect())
}

/// Edit shape `id`'s text (if it isn't being edited already).
fn edit_shape(d: &mut Deck, id: u64) -> Result<(), String> {
    let editing = d.session.active().and_then(|st| st.selection.text.as_ref()).is_some_and(|t| u64::from(t.shape.0) == id);
    if editing {
        return Ok(());
    }
    let _ = run(d, "selection.set", &json!({ "ids": [id] }));
    run(d, "text.edit", &json!({ "id": id })).map(|_| ())
}

/// The text boxes of the slide shown.
pub fn ai_units(d: &mut Deck) -> Json {
    let Some(st) = d.session.active() else { return json!({ "rev": 0, "units": [] }) };
    let units: Vec<Json> = st
        .shapes()
        .iter()
        .filter_map(|sh| {
            let text = sh.text.as_ref()?.text();
            (text.trim().chars().count() >= 3).then(|| json!({ "key": { "shape": sh.id.0 }, "text": text }))
        })
        .collect();
    json!({ "rev": format!("{}:{}", st.revision, st.selection.slide), "units": units })
}

fn select_in(d: &mut Deck, shape: u64, p0: usize, p1: usize, original: &str) -> Result<(), String> {
    edit_shape(d, shape)?;
    let paras = paragraphs(d, shape).ok_or("The text box has gone")?;
    for (p, line) in paras.iter().enumerate().skip(p0).take(p1.saturating_sub(p0) + 1) {
        if let Some(byte) = line.find(original) {
            let c0 = line[..byte].chars().count();
            let c1 = c0 + original.chars().count();
            return run(d, "text.select", &json!({ "anchor": [p, c0], "caret": [p, c1] })).map(|_| ());
        }
    }
    Err("The text has changed since it was checked".into())
}

pub fn ai_apply(d: &mut Deck, shape: u64, original: &str, replacement: &str) -> Result<(), String> {
    select_in(d, shape, 0, 10_000, original)?;
    run(d, "text.insert", &json!({ "text": replacement })).map(|_| ())
}

pub fn ai_focus(d: &mut Deck, shape: u64, original: &str) {
    let _ = select_in(d, shape, 0, 10_000, original);
}

/// The selected text, the paragraph at the caret, or the selected text box.
pub fn ai_target(d: &mut Deck) -> Json {
    let Some(st) = d.session.active() else { return Json::Null };
    let (shape, sel) = match &st.selection.text {
        Some(t) if !t.notes && t.cell.is_none() => (u64::from(t.shape.0), Some((t.anchor, t.caret))),
        Some(_) => return Json::Null,
        None if st.selection.shapes.len() == 1 => (u64::from(st.selection.shapes[0].0), None),
        None => return Json::Null,
    };
    let Some(paras) = paragraphs(d, shape) else { return Json::Null };
    let pick = |a: (usize, usize), c: (usize, usize)| -> Option<(String, usize, usize, bool)> {
        if a != c {
            let (s, e) = if a <= c { (a, c) } else { (c, a) };
            let mut out = String::new();
            for p in s.0..=e.0 {
                let line: Vec<char> = paras.get(p)?.chars().collect();
                let from = if p == s.0 { s.1.min(line.len()) } else { 0 };
                let to = if p == e.0 { e.1.min(line.len()) } else { line.len() };
                if p > s.0 {
                    out.push('\n');
                }
                out.extend(line[from..to.max(from)].iter());
            }
            Some((out, s.0, e.0, true))
        } else {
            Some((paras.get(c.0)?.clone(), c.0, c.0, false))
        }
    };
    let r = match sel {
        Some((a, c)) => pick((a.0, a.1), (c.0, c.1)),
        None => Some((paras.join("\n"), 0, paras.len().saturating_sub(1), false)),
    };
    match r {
        Some((text, p0, p1, selection)) if !text.trim().is_empty() => json!({ "text": text, "selection": selection, "shape": shape, "p0": p0, "p1": p1 }),
        _ => Json::Null,
    }
}

pub fn ai_replace(d: &mut Deck, t: &Json, text: &str) -> Result<(), String> {
    let shape = t["shape"].as_u64().ok_or("no text box")?;
    let p0 = t["p0"].as_u64().unwrap_or(0) as usize;
    let p1 = t["p1"].as_u64().unwrap_or(0) as usize;
    if t["selection"].as_bool() == Some(true) {
        if ai_target(d)["text"].as_str() == t["text"].as_str() {
            return run(d, "text.insert", &json!({ "text": text })).map(|_| ());
        }
        return Err("The selection has changed".into());
    }
    edit_shape(d, shape)?;
    let paras = paragraphs(d, shape).ok_or("The text box has gone")?;
    let end = paras.get(p1).map_or(0, |l| l.chars().count());
    run(d, "text.select", &json!({ "anchor": [p0, 0], "caret": [p1, end] }))?;
    run(d, "text.insert", &json!({ "text": text })).map(|_| ())
}

pub fn ai_insert(d: &mut Deck, text: &str) -> Result<(), String> {
    let editing = d.session.active().is_some_and(|st| st.selection.text.is_some());
    if !editing {
        return Err("Click into a text box first.".into());
    }
    run(d, "text.insert", &json!({ "text": text })).map(|_| ())
}
