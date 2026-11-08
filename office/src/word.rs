//! Editing Word documents: a WordCraft editing session per open document. The window shows the
//! pages as pictures this module draws, with the caret and selection on top; every keystroke,
//! click and ribbon button is a WordCraft command (`format.bold`, `text.insert`, `caret.set`…),
//! so editing, undo and saving behave exactly as in WordCraft.

use std::sync::OnceLock;

use base64::Engine as _;
use serde_json::{Value as Json, json};
use wordcraft_engine::{KeyMap, Registry, Session};

pub struct WordDoc {
    pub session: Session,
    pub path: String,
    /// The undo depth when the document was last saved (the document is "dirty" otherwise).
    saved_mark: u64,
}

fn registry() -> &'static Registry {
    static R: OnceLock<Registry> = OnceLock::new();
    R.get_or_init(wordcraft_engine::cmd::registry)
}

pub fn open(path: &str, password: Option<&str>) -> Result<WordDoc, String> {
    let doc = crate::doc::open(path, password)?;
    let mut session = Session::new(doc);
    session.reset_history();
    let saved_mark = session.undo_mark();
    Ok(WordDoc { session, path: path.to_string(), saved_mark })
}

pub fn from_document(doc: wordcraft_doc::Document, path: &str) -> WordDoc {
    let mut session = Session::new(doc);
    session.reset_history();
    let saved_mark = session.undo_mark();
    WordDoc { session, path: path.to_string(), saved_mark }
}

/// What the window needs after any change: pages, caret, selection, formatting at the caret,
/// undo/redo lists.
pub fn state(w: &mut WordDoc) -> Json {
    let s = &mut w.session;
    let l = s.layout();
    let pages: Vec<Json> = l.pages.iter().map(|p| json!([p.w, p.h])).collect();
    let (a, b) = (s.sel.anchor.clone(), s.sel.focus.clone());
    let caret = l.caret_on(&b, 0).map(|c| json!({"page": c.page, "x": c.x, "y": c.top, "h": c.height}));
    let sel: Vec<Json> = if a != b {
        l.selection_rects(&s.doc, &a, &b, caret.as_ref().and_then(|c| c["page"].as_u64()).unwrap_or(0) as usize)
            .into_iter()
            .take(4000)
            .map(|(p, r)| json!([p, r.x, r.y, r.w, r.h]))
            .collect()
    } else {
        vec![]
    };
    let fmt = s.run("format.state", &json!({})).unwrap_or(Json::Null);
    let align = s.doc.para_at(&b).and_then(|p| p.props.align).map(|a| format!("{a:?}").to_lowercase()).unwrap_or_else(|| "left".into());
    let list = s.doc.para_at(&b).map(|p| p.props.numbering.is_some()).unwrap_or(false);
    let undo: Vec<String> = s.undo_history().into_iter().map(String::from).collect();
    let dirty = s.undo_mark() != w.saved_mark;
    json!({
        "rev": s.rev(),
        "pages": pages,
        "caret": caret,
        "sel": sel,
        "fmt": fmt,
        "align": align,
        "list": list,
        "canUndo": s.can_undo(),
        "canRedo": s.can_redo(),
        "undo": undo,
        "redo": s.redo_label(),
        "dirty": dirty,
        "words": s.word_count(),
        "inHeader": s.in_header_footer(),
    })
}

/// The paragraph styles for the Styles list: the quick ones first, as Word shows them.
pub fn styles(w: &WordDoc) -> Json {
    let mut v: Vec<(bool, u32, String, String)> = w
        .session
        .doc
        .styles
        .styles
        .iter()
        .filter(|st| matches!(st.kind, wordcraft_doc::styles::StyleKind::Paragraph) && !st.hidden)
        .map(|st| (!st.quick, st.priority.unwrap_or(99), st.name.clone(), st.id.clone()))
        .collect();
    v.sort();
    let list: Vec<Json> = v.into_iter().take(60).map(|(_, _, n, id)| json!({"id": id, "name": n})).collect();
    json!(list)
}

pub fn run(w: &mut WordDoc, cmd: &str, params: &Json) -> Result<Json, String> {
    if cmd == "edit.undoTo" || cmd == "edit.redoTo" {
        let n = params["count"].as_u64().unwrap_or(1).max(1) as usize;
        for _ in 0..n {
            let ok = if cmd == "edit.undoTo" { w.session.undo() } else { w.session.redo() };
            if !ok {
                break;
            }
        }
        return Ok(Json::Null);
    }
    w.session.run(cmd, params).map_err(|e| e.to_string())
}

/// A key press ("Mod+B", "Shift+Left", "Enter"…): the command WordCraft binds it to.
pub fn key(w: &mut WordDoc, key: &str) -> Result<Json, String> {
    let reg = registry();
    let map = KeyMap::default();
    if let Some(spec) = map.resolve(reg, key) {
        let r = w.session.run(spec.id, &json!({})).map_err(|e| e.to_string())?;
        return Ok(json!({"handled": true, "command": spec.id, "result": r}));
    }
    // Shift with a movement key extends the selection
    if key.contains("Shift+") {
        let plain = key.replace("Shift+", "");
        if let Some(spec) = map.resolve(reg, &plain).filter(|s| s.params.contains("extend")) {
            let r = w.session.run(spec.id, &json!({"extend": true})).map_err(|e| e.to_string())?;
            return Ok(json!({"handled": true, "command": spec.id, "result": r}));
        }
    }
    Ok(json!({"handled": false}))
}

/// A click on page `page` (0-based) at (x, y) points; `count` 2 = word, 3 = paragraph.
pub fn click(w: &mut WordDoc, page: u64, x: f64, y: f64, extend: bool, count: u64) -> Result<Json, String> {
    let s = &mut w.session;
    s.run("caret.set", &json!({"page": page, "x": x, "y": y, "extend": extend})).map_err(|e| e.to_string())?;
    match count {
        2 => {
            let _ = s.run("select.word", &json!({}));
        }
        3.. => {
            let _ = s.run("select.paragraph", &json!({}));
        }
        _ => {}
    }
    Ok(Json::Null)
}

/// Page `page` drawn at `scale` pixels per point, as a PNG (base64).
pub fn render(w: &mut WordDoc, page: usize, scale: f32) -> Result<Json, String> {
    let s = &mut w.session;
    let l = s.layout();
    let p = l.pages.get(page).ok_or("No such page")?;
    let scale = scale.clamp(0.1, 8.0);
    let img = wordcraft_engine::render::render_page(&s.doc, p, scale, &Default::default());
    let png = encode_png(&img)?;
    Ok(json!({"png": base64::engine::general_purpose::STANDARD.encode(png), "width": img.width, "height": img.height, "rev": s.rev()}))
}

/// Fast PNG (screen pictures: speed matters more than a few kilobytes).
fn encode_png(img: &wordcraft_engine::render::Rendered) -> Result<Vec<u8>, String> {
    let px = img.to_straight();
    let mut out = Vec::with_capacity(px.len() / 6);
    {
        let mut enc = png::Encoder::new(&mut out, img.width, img.height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        enc.set_filter(png::Filter::Sub);
        let mut wr = enc.write_header().map_err(|e| e.to_string())?;
        wr.write_image_data(&px).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Save to `out` (format from its extension). Saving to the document's own path marks it clean.
pub fn save(w: &mut WordDoc, out: &str, mark_saved: bool) -> Result<(), String> {
    let ext = std::path::Path::new(out).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let bytes = crate::doc::save(&w.session.doc, &ext)?;
    crate::write_safely(out, &bytes)?;
    if mark_saved {
        w.saved_mark = w.session.undo_mark();
        w.session.stamp_save();
    }
    Ok(())
}

/// Every command, for the command search ("Tell me what you want to do").
pub fn commands() -> Json {
    let list: Vec<Json> = registry()
        .all()
        .iter()
        .filter(|s| !s.location.is_empty())
        .map(|s| json!({"id": s.id, "label": s.label, "where": s.location, "key": s.shortcut, "params": s.params, "mutates": s.mutates}))
        .collect();
    json!(list)
}

/// The document's text (for the AI): paragraphs, with headings marked.
pub fn text(w: &mut WordDoc) -> String {
    w.session.counted_text()
}
