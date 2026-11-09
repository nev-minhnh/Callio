//! callio-office — Callio's office engine, a helper process the editor starts only when an
//! office document, a spreadsheet or a PDF tool is used (so the editor itself stays small).
//!
//! `callio-office --serve` reads one JSON request per line on stdin:
//!   {"id": 1, "cmd": "doc.open", "args": {...}}
//! and answers one line per request on stdout (in any order; requests run in parallel):
//!   {"id": 1, "ok": true, "result": ...}   or   {"id": 1, "ok": false, "error": "..."}
//! Large results (PDF bytes, saved files) go to the paths the request names.
//!
//! `callio-office <cmd> '<json args>'` runs one request (for scripts and tests).
//!
//! Built on WordCraft, GridCraft and PdfCraft by the ArtCraft team (MIT OR Apache-2.0).

mod chart_svg;
mod deck;
mod doc;
mod image;
mod md;
mod pdftools;
mod sheet;
mod word;

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value as Json, json};

/// Write `bytes` to `path` through a temporary file, so a failed write never leaves half a file.
pub fn write_safely(path: &str, bytes: &[u8]) -> Result<(), String> {
    let p = std::path::Path::new(path);
    if let Some(dir) = p.parent()
        && !dir.as_os_str().is_empty()
    {
        std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    }
    let tmp = p.with_file_name(format!(".{}.callio-tmp", p.file_name().and_then(|n| n.to_str()).unwrap_or("file")));
    std::fs::write(&tmp, bytes).map_err(|e| format!("Couldn't write {path}: {e}"))?;
    std::fs::rename(&tmp, p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Couldn't write {path}: {e} (is it open in another program?)")
    })
}

#[derive(Default)]
struct State {
    docs: HashMap<u64, Arc<wordcraft_doc::Document>>,
    books: HashMap<u64, Arc<Mutex<sheet::Book>>>,
    words: HashMap<u64, Arc<Mutex<word::WordDoc>>>,
    decks: HashMap<u64, Arc<Mutex<deck::Deck>>>,
    images: HashMap<u64, Arc<Mutex<image::Img>>>,
}

static NEXT: AtomicU64 = AtomicU64::new(1);

fn s(a: &Json, k: &str) -> Option<String> {
    a.get(k).and_then(|v| v.as_str()).map(str::to_string)
}
fn u(a: &Json, k: &str) -> Result<u64, String> {
    a.get(k).and_then(|v| v.as_u64()).ok_or_else(|| format!("missing `{k}`"))
}
fn stem_of(p: &str) -> String {
    std::path::Path::new(p).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "document".into())
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn handle(st: &Mutex<State>, cmd: &str, a: &Json) -> Result<Json, String> {
    let doc_of = |id: u64| st.lock().unwrap().docs.get(&id).cloned().ok_or_else(|| "That document is closed".to_string());
    let word_of = |id: u64| st.lock().unwrap().words.get(&id).cloned().ok_or_else(|| "That document is closed".to_string());
    let deck_of = |id: u64| st.lock().unwrap().decks.get(&id).cloned().ok_or_else(|| "That presentation is closed".to_string());
    let img_of = |id: u64| st.lock().unwrap().images.get(&id).cloned().ok_or_else(|| "That picture is closed".to_string());
    let book_of = |id: u64| st.lock().unwrap().books.get(&id).cloned().ok_or_else(|| "That workbook is closed".to_string());
    match cmd {
        "ping" => Ok(json!({ "version": env!("CARGO_PKG_VERSION"), "docs": doc::READS, "sheets": sheet::READS })),

        // a new, empty document / workbook / presentation written to `out` (its extension decides)
        "office.blank" => {
            let out = s(a, "out").ok_or("missing `out`")?;
            let ext = std::path::Path::new(&out).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            // an empty file just made in the file list is filled in; anything else is never replaced
            if std::fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false) {
                return Err(format!("{out} already exists"));
            }
            let bytes = match ext.as_str() {
                "docx" | "dotx" | "odt" | "rtf" => doc::save(&wordcraft_doc::Document::new(), &ext)?,
                "xlsx" | "xltx" | "ods" => {
                    let wb = gridcraft_model::Workbook::new();
                    gridcraft_engine::io::save_bytes(&wb, &out).map_err(|e| e.to_string())?
                }
                "pptx" => {
                    let mut ses = deckcraft_engine::Session::new();
                    ses.execute("file.new", &json!({})).map_err(|e| e.to_string())?;
                    ses.execute("file.save", &json!({ "path": out, "format": ext })).map_err(|e| e.to_string())?;
                    return Ok(json!({ "out": out }));
                }
                _ => return Err(format!("Can't create a blank .{ext} file")),
            };
            std::fs::write(&out, bytes).map_err(|e| format!("{out}: {e}"))?;
            Ok(json!({ "out": out }))
        }

        // ---------- documents ----------
        "doc.open" => {
            let path = s(a, "path").ok_or("missing `path`")?;
            let d = doc::open(&path, s(a, "password").as_deref())?;
            let info = doc::info(&d);
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            st.lock().unwrap().docs.insert(id, Arc::new(d));
            Ok(json!({ "id": id, "info": info }))
        }
        "doc.fromText" => {
            // Markdown / LaTeX / HTML text (from the editor) as a document
            let text = s(a, "text").unwrap_or_default();
            let kind = s(a, "kind").unwrap_or_else(|| "md".into());
            let dir = s(a, "dir");
            let d = doc::from_bytes(text.as_bytes(), &kind, dir.as_deref().map(std::path::Path::new), None)?;
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            st.lock().unwrap().docs.insert(id, Arc::new(d));
            Ok(json!({ "id": id }))
        }
        "doc.pdf" => {
            let d = doc_of(u(a, "id")?)?;
            let out = s(a, "out").ok_or("missing `out`")?;
            let bytes = doc::to_pdf(&d)?;
            write_safely(&out, &bytes)?;
            Ok(json!({ "out": out, "bytes": bytes.len() }))
        }
        "doc.save" => {
            let d = doc_of(u(a, "id")?)?;
            let out = s(a, "out").ok_or("missing `out`")?;
            let fmt = s(a, "format").unwrap_or_else(|| std::path::Path::new(&out).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default());
            if fmt == "md" || fmt == "markdown" {
                let m = md::to_markdown(&d, &stem_of(&out));
                let dir = std::path::Path::new(&out).parent().map(|p| p.to_path_buf()).unwrap_or_default();
                for (name, bytes) in &m.images {
                    write_safely(&dir.join(name).to_string_lossy(), bytes)?;
                }
                write_safely(&out, m.markdown.as_bytes())?;
                return Ok(json!({ "out": out, "images": m.images.len() }));
            }
            let bytes = doc::save(&d, &fmt)?;
            write_safely(&out, &bytes)?;
            Ok(json!({ "out": out }))
        }
        "doc.markdown" => {
            // the Markdown and its pictures, for the window to place where the user picks
            let d = doc_of(u(a, "id")?)?;
            let stem = s(a, "stem").unwrap_or_else(|| "document".into());
            let m = md::to_markdown(&d, &stem);
            let images: Vec<Json> = m.images.iter().map(|(n, b)| json!({ "name": n, "data": b64(b) })).collect();
            Ok(json!({ "markdown": m.markdown, "images": images }))
        }
        "doc.close" => {
            st.lock().unwrap().docs.remove(&u(a, "id")?);
            Ok(Json::Null)
        }
        // one step: any document file → another format (pdf, docx, md, html, odt, rtf, tex, txt)
        "convert" => {
            let input = s(a, "input").ok_or("missing `input`")?;
            let out = s(a, "out").ok_or("missing `out`")?;
            let to = std::path::Path::new(&out).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            let ext = std::path::Path::new(&input).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            if sheet::READS.contains(&ext.as_str()) && !matches!(ext.as_str(), "txt") {
                let (b, _) = sheet::open(&input, s(a, "password").as_deref())?;
                let mut b = b;
                return match to.as_str() {
                    "pdf" => {
                        let tmp = format!("{out}.callio-part");
                        sheet::exec(&mut b, "file.exportPdf", json!({ "path": tmp, "sheets": "all" }))?;
                        let bytes = std::fs::read(&tmp).map_err(|e| e.to_string())?;
                        let _ = std::fs::remove_file(&tmp);
                        write_safely(&out, &bytes)?;
                        Ok(json!({ "out": out }))
                    }
                    "md" => {
                        let m = sheet::markdown(&b)?;
                        write_safely(&out, m.as_bytes())?;
                        Ok(json!({ "out": out }))
                    }
                    _ => {
                        sheet::save(&b, &out)?;
                        Ok(json!({ "out": out }))
                    }
                };
            }
            let d = doc::open(&input, s(a, "password").as_deref())?;
            if to == "md" {
                let m = md::to_markdown(&d, &stem_of(&out));
                let dir = std::path::Path::new(&out).parent().map(|p| p.to_path_buf()).unwrap_or_default();
                for (name, bytes) in &m.images {
                    write_safely(&dir.join(name).to_string_lossy(), bytes)?;
                }
                write_safely(&out, m.markdown.as_bytes())?;
                return Ok(json!({ "out": out, "images": m.images.len() }));
            }
            let bytes = doc::save(&d, &to)?;
            write_safely(&out, &bytes)?;
            Ok(json!({ "out": out }))
        }

        // ---------- spreadsheets ----------
        // ---------- editing Word documents ----------
        "word.open" => {
            let path = s(a, "path").ok_or("missing `path`")?;
            let mut w = word::open(&path, s(a, "password").as_deref())?;
            let state = word::state(&mut w);
            let styles = word::styles(&w);
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            st.lock().unwrap().words.insert(id, Arc::new(Mutex::new(w)));
            Ok(json!({ "id": id, "state": state, "styles": styles }))
        }
        "word.state" => {
            let w = word_of(u(a, "id")?)?;
            let mut w = w.lock().unwrap();
            Ok(word::state(&mut w))
        }
        "word.run" => {
            let w = word_of(u(a, "id")?)?;
            let mut w = w.lock().unwrap();
            let r = word::run(&mut w, &s(a, "cmd").ok_or("missing `cmd`")?, &a.get("params").cloned().unwrap_or(json!({})));
            let state = word::state(&mut w);
            match r {
                Ok(r) => Ok(json!({ "result": r, "state": state })),
                Err(e) => Ok(json!({ "error": e, "state": state })),
            }
        }
        "word.batch" => {
            // several commands as one step for the undo list (the AI's edits)
            let w = word_of(u(a, "id")?)?;
            let mut w = w.lock().unwrap();
            let label = s(a, "label").unwrap_or_else(|| "AI edit".into());
            // one named step: a snapshot first, then the commands' own steps folded into it
            w.session.close_typing();
            let mark = w.session.undo_mark();
            w.session.checkpoint(&label);
            let mut results = vec![];
            for c in a["commands"].as_array().ok_or("missing `commands`")? {
                let id = c["command"].as_str().unwrap_or_default();
                results.push(match word::run(&mut w, id, &c.get("params").cloned().unwrap_or(json!({}))) {
                    Ok(r) => json!({ "ok": true, "result": r }),
                    Err(e) => json!({ "ok": false, "error": e }),
                });
            }
            w.session.merge_undo_since(mark);
            let state = word::state(&mut w);
            Ok(json!({ "results": results, "state": state }))
        }
        "word.key" => {
            let w = word_of(u(a, "id")?)?;
            let mut w = w.lock().unwrap();
            let r = word::key(&mut w, &s(a, "key").ok_or("missing `key`")?);
            let state = word::state(&mut w);
            match r {
                Ok(r) => Ok(json!({ "result": r, "state": state })),
                Err(e) => Ok(json!({ "error": e, "result": { "handled": true }, "state": state })),
            }
        }
        "word.type" => {
            let w = word_of(u(a, "id")?)?;
            let mut w = w.lock().unwrap();
            let t = s(a, "text").unwrap_or_default();
            let r = word::run(&mut w, "text.insert", &json!({ "text": t }));
            let state = word::state(&mut w);
            Ok(json!({ "error": r.err(), "state": state }))
        }
        "word.click" => {
            let w = word_of(u(a, "id")?)?;
            let mut w = w.lock().unwrap();
            let r = word::click(&mut w, u(a, "page")?, a["x"].as_f64().unwrap_or(0.0), a["y"].as_f64().unwrap_or(0.0), a["extend"].as_bool().unwrap_or(false), a["count"].as_u64().unwrap_or(1));
            let state = word::state(&mut w);
            Ok(json!({ "error": r.err(), "state": state }))
        }
        "word.render" => {
            let w = word_of(u(a, "id")?)?;
            let mut w = w.lock().unwrap();
            word::render(&mut w, u(a, "page")? as usize, a["scale"].as_f64().unwrap_or(1.5) as f32)
        }
        "word.save" => {
            let w = word_of(u(a, "id")?)?;
            let mut w = w.lock().unwrap();
            let out = s(a, "out").ok_or("missing `out`")?;
            if out.to_lowercase().ends_with(".md") {
                let m = md::to_markdown(&w.session.doc, &stem_of(&out));
                let dir = std::path::Path::new(&out).parent().map(|p| p.to_path_buf()).unwrap_or_default();
                for (name, bytes) in &m.images {
                    write_safely(&dir.join(name).to_string_lossy(), bytes)?;
                }
                write_safely(&out, m.markdown.as_bytes())?;
            } else if out.to_lowercase().ends_with(".pdf") {
                let bytes = doc::to_pdf(&w.session.doc)?;
                write_safely(&out, &bytes)?;
            } else {
                word::save(&mut w, &out, a["markSaved"].as_bool().unwrap_or(false))?;
            }
            Ok(json!({ "out": out, "state": word::state(&mut w) }))
        }
        "word.text" => {
            let w = word_of(u(a, "id")?)?;
            let mut w = w.lock().unwrap();
            let m = md::to_markdown(&w.session.doc, "doc");
            Ok(json!({ "markdown": m.markdown, "text": word::text(&mut w) }))
        }
        "word.commands" => Ok(word::commands()),
        "word.styles" => Ok(word::styles(&word_of(u(a, "id")?)?.lock().unwrap())),
        "word.close" => {
            st.lock().unwrap().words.remove(&u(a, "id")?);
            Ok(json!({}))
        }

        // ---------- presentations ----------
        "deck.open" => {
            let path = s(a, "path").ok_or("missing `path`")?;
            let mut d = deck::open(&path)?;
            let state = deck::state(&mut d);
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            st.lock().unwrap().decks.insert(id, Arc::new(Mutex::new(d)));
            Ok(json!({ "id": id, "state": state }))
        }
        "deck.state" => {
            let d = deck_of(u(a, "id")?)?;
            let mut d = d.lock().unwrap();
            let fmt = if a["format"].as_bool().unwrap_or(false) { deck::format(&mut d) } else { Json::Null };
            let mut state = deck::state(&mut d);
            state["fmt"] = fmt;
            Ok(state)
        }
        "deck.run" | "deck.pointer" | "deck.key" | "deck.type" | "deck.tool" | "deck.undoN" | "deck.batch" => {
            let d = deck_of(u(a, "id")?)?;
            let mut d = d.lock().unwrap();
            let r: Result<Json, String> = match cmd {
                "deck.run" => deck::run(&mut d, &s(a, "cmd").ok_or("missing `cmd`")?, &a.get("params").cloned().unwrap_or(json!({}))),
                "deck.pointer" => deck::pointer(&mut d, a),
                "deck.key" => deck::key(&mut d, &s(a, "key").unwrap_or_default(), a),
                "deck.type" => deck::type_text(&mut d, &s(a, "text").unwrap_or_default()),
                "deck.tool" => deck::tool(&mut d, &s(a, "tool").unwrap_or_else(|| "select".into()), s(a, "preset").as_deref()).map(|_| Json::Null),
                "deck.undoN" => deck::undo_n(&mut d, a["count"].as_u64().unwrap_or(1) as usize, a["redo"].as_bool().unwrap_or(false)).map(|_| Json::Null),
                _ => Ok(json!(deck::batch(&mut d, &s(a, "label").unwrap_or_else(|| "AI edit".into()), a["commands"].as_array().map(Vec::as_slice).unwrap_or(&[])))),
            };
            let mut state = deck::state(&mut d);
            if a["format"].as_bool().unwrap_or(true) {
                state["fmt"] = deck::format(&mut d);
            }
            match r {
                Ok(r) => Ok(json!({ "result": r, "state": state })),
                Err(e) => Ok(json!({ "error": e, "state": state })),
            }
        }
        "deck.render" => {
            let d = deck_of(u(a, "id")?)?;
            let mut d = d.lock().unwrap();
            deck::render(&mut d, u(a, "slide")? as usize, a["scale"].as_f64().unwrap_or(1.0), a["edit"].as_bool().unwrap_or(true))
        }
        "deck.save" => {
            let d = deck_of(u(a, "id")?)?;
            let mut d = d.lock().unwrap();
            let out = s(a, "out").ok_or("missing `out`")?;
            deck::save(&mut d, &out, a["markSaved"].as_bool().unwrap_or(false))?;
            Ok(json!({ "out": out, "state": deck::state(&mut d) }))
        }
        "deck.commands" => Ok(deck::commands(&*deck_of(u(a, "id")?)?.lock().unwrap())),
        "deck.text" => Ok(deck::text(&mut deck_of(u(a, "id")?)?.lock().unwrap())),
        "deck.close" => {
            st.lock().unwrap().decks.remove(&u(a, "id")?);
            Ok(json!({}))
        }

        // ---------- pictures (LightCraft) ----------
        "image.open" => {
            let path = s(a, "path").ok_or("missing `path`")?;
            let mut m = image::open(&path)?;
            let state = image::state(&mut m);
            let info = image::info(&mut m);
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            st.lock().unwrap().images.insert(id, Arc::new(Mutex::new(m)));
            Ok(json!({ "id": id, "state": state, "info": info }))
        }
        "image.render" => image::render(&img_of(u(a, "id")?)?, a),
        "image.map" => image::map(&mut img_of(u(a, "id")?)?.lock().unwrap(), a),
        "image.state" | "image.controls" | "image.info" | "image.commands" | "image.size" => {
            let m = img_of(u(a, "id")?)?;
            let mut m = m.lock().unwrap();
            Ok(match cmd {
                "image.state" => image::state(&mut m),
                "image.controls" => image::controls(&mut m),
                "image.info" => image::info(&mut m),
                "image.size" => image::size(&mut m),
                _ => image::commands(&m),
            })
        }
        "image.run" | "image.undoN" | "image.batch" => {
            let m = img_of(u(a, "id")?)?;
            let mut m = m.lock().unwrap();
            let r: Result<Json, String> = match cmd {
                "image.run" => image::run(&mut m, &s(a, "cmd").ok_or("missing `cmd`")?, &a.get("params").cloned().unwrap_or(json!({}))),
                "image.undoN" => image::undo_n(&mut m, a["n"].as_u64().unwrap_or(1) as usize, a["redo"].as_bool().unwrap_or(false)).map(|_| Json::Null),
                _ => Ok(json!(image::batch(&mut m, &s(a, "label").unwrap_or_else(|| "AI edit".into()), a["commands"].as_array().map(|v| v.as_slice()).unwrap_or(&[])))),
            };
            let state = image::state(&mut m);
            Ok(match r {
                Ok(v) => json!({ "result": v, "state": state }),
                Err(e) => json!({ "error": e, "state": state }),
            })
        }
        "image.save" => {
            let m = img_of(u(a, "id")?)?;
            let mut m = m.lock().unwrap();
            let out = s(a, "out").ok_or("missing `out`")?;
            let r = image::save(&mut m, &out, &a.get("params").cloned().unwrap_or(json!({})), a["markSaved"].as_bool().unwrap_or(false))?;
            let state = image::state(&mut m);
            Ok(json!({ "result": r, "state": state }))
        }
        "image.close" => {
            st.lock().unwrap().images.remove(&u(a, "id")?);
            Ok(json!({}))
        }

        "sheet.open" => {
            let path = s(a, "path").ok_or("missing `path`")?;
            let (b, warnings) = sheet::open(&path, s(a, "password").as_deref())?;
            let sum = sheet::summary(&b)?;
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            st.lock().unwrap().books.insert(id, Arc::new(Mutex::new(b)));
            Ok(json!({ "id": id, "book": sum, "warnings": warnings }))
        }
        "sheet.summary" => sheet::summary(&book_of(u(a, "id")?)?.lock().unwrap()),
        "sheet.meta" => sheet::meta(&book_of(u(a, "id")?)?.lock().unwrap(), u(a, "sheet")? as usize),
        "sheet.view" => {
            let b = book_of(u(a, "id")?)?;
            let b = b.lock().unwrap();
            sheet::view(&b, u(a, "sheet")? as usize, u(a, "r0")? as u32, u(a, "r1")? as u32, u(a, "c0")? as u32, u(a, "c1")? as u32)
        }
        "sheet.cell" => {
            let b = book_of(u(a, "id")?)?;
            let b = b.lock().unwrap();
            sheet::cell(&b, u(a, "sheet")? as usize, u(a, "r")? as u32, u(a, "c")? as u32)
        }
        "sheet.exec" => {
            let b = book_of(u(a, "id")?)?;
            let mut b = b.lock().unwrap();
            sheet::exec(&mut b, &s(a, "cmd").ok_or("missing `cmd`")?, a.get("params").cloned().unwrap_or(json!({})))
        }
        "sheet.save" => {
            let b = book_of(u(a, "id")?)?;
            let mut b = b.lock().unwrap();
            let out = s(a, "out").ok_or("missing `out`")?;
            if out.to_lowercase().ends_with(".md") {
                write_safely(&out, sheet::markdown(&b)?.as_bytes())?;
            } else if out.to_lowercase().ends_with(".pdf") {
                let tmp = format!("{out}.callio-part");
                sheet::exec(&mut b, "file.exportPdf", json!({ "path": tmp, "sheets": "all" }))?;
                let bytes = std::fs::read(&tmp).map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(&tmp);
                write_safely(&out, &bytes)?;
            } else {
                sheet::save(&b, &out)?;
            }
            Ok(json!({ "out": out }))
        }
        "sheet.history" => Ok(sheet::history(&book_of(u(a, "id")?)?.lock().unwrap())),
        "sheet.undoN" => {
            let b = book_of(u(a, "id")?)?;
            let mut b = b.lock().unwrap();
            sheet::undo_n(&mut b, a["count"].as_u64().unwrap_or(1) as usize, a["redo"].as_bool().unwrap_or(false))?;
            Ok(sheet::history(&b))
        }
        "sheet.batch" => {
            let b = book_of(u(a, "id")?)?;
            let mut b = b.lock().unwrap();
            let r = sheet::batch(&mut b, &s(a, "label").unwrap_or_else(|| "AI edit".into()), a["commands"].as_array().map(Vec::as_slice).unwrap_or(&[]))?;
            Ok(json!({ "results": r }))
        }
        "sheet.read" => sheet::read(&book_of(u(a, "id")?)?.lock().unwrap(), a["sheet"].as_u64().unwrap_or(0) as usize, s(a, "range").as_deref()),
        "sheet.commands" => Ok(sheet::commands(&book_of(u(a, "id")?)?.lock().unwrap())),
        "sheet.markdown" => Ok(json!({ "markdown": sheet::markdown(&book_of(u(a, "id")?)?.lock().unwrap())? })),
        "sheet.close" => {
            st.lock().unwrap().books.remove(&u(a, "id")?);
            Ok(Json::Null)
        }

        // ---------- PDF tools ----------
        c if c.starts_with("pdf.") => pdftools::run(&c[4..], a),
        "pdf" => pdftools::run(&s(a, "op").ok_or("missing `op`")?, a),

        other => Err(format!("Unknown command {other}")),
    }
}

fn run(st: &Mutex<State>, cmd: &str, a: &Json) -> Result<Json, String> {
    match std::panic::catch_unwind(AssertUnwindSafe(|| handle(st, cmd, a))) {
        Ok(r) => r,
        Err(p) => {
            let m = p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_else(|| "internal error".into());
            Err(format!("The office engine failed on this file ({m})"))
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    std::panic::set_hook(Box::new(|_| {})); // panics become error answers, not stderr noise
    let st = Arc::new(Mutex::new(State::default()));
    if args.get(1).map(String::as_str) == Some("--serve") {
        // private picture copies left by an engine that didn't close normally
        std::thread::spawn(|| {
            let Ok(rd) = std::fs::read_dir(std::env::temp_dir()) else { return };
            for e in rd.flatten() {
                let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|a| a.as_secs() > 86_400);
                if old && e.file_name().to_string_lossy().starts_with("callio-img-") {
                    let _ = std::fs::remove_dir_all(e.path());
                }
            }
        });
        let out = Arc::new(Mutex::new(std::io::stdout()));
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let req: Json = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(e) => {
                    let mut o = out.lock().unwrap();
                    let _ = writeln!(o, "{}", json!({ "id": null, "ok": false, "error": format!("bad request: {e}") }));
                    let _ = o.flush();
                    continue;
                }
            };
            let (st, out) = (st.clone(), out.clone());
            // each request on its own thread: a long PDF compression doesn't hold up the grid
            let _ = std::thread::Builder::new().stack_size(16 << 20).spawn(move || {
                let id = req["id"].clone();
                let cmd = req["cmd"].as_str().unwrap_or("");
                let args = req.get("args").cloned().unwrap_or(json!({}));
                let reply = match run(&st, cmd, &args) {
                    Ok(r) => json!({ "id": id, "ok": true, "result": r }),
                    Err(e) => json!({ "id": id, "ok": false, "error": e }),
                };
                let mut o = out.lock().unwrap();
                let _ = writeln!(o, "{reply}");
                let _ = o.flush();
            });
        }
        return;
    }
    // one-shot: callio-office <cmd> '<json>'
    let Some(cmd) = args.get(1) else {
        eprintln!("usage: callio-office --serve | <cmd> '<json args>'");
        std::process::exit(2);
    };
    let a: Json = args.get(2).and_then(|s| serde_json::from_str(s).ok()).unwrap_or(json!({}));
    match run(&st, cmd, &a) {
        Ok(r) => println!("{}", serde_json::to_string_pretty(&r).unwrap_or_default()),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
