//! The vault commands as plain functions from JSON to JSON (`run`), shared by the Tauri commands
//! in `mod.rs`, the Claude Code tools, and the dev server's test bridge. One index per vault
//! root is kept in memory and brought up to date from the disk (only changed files are read).
use super::index::{self, Edit, FileEdits, Index};
use super::text::{self, Val};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

static STATE: Mutex<Option<HashMap<String, Index>>> = Mutex::new(None);
const FRESH: Duration = Duration::from_millis(1500);

/// Restricts what a caller may see (the AI tools: only the folders the author allowed).
pub type Allow<'a> = Option<&'a dyn Fn(&str) -> bool>;

fn key(root: &str) -> String {
    root.replace('\\', "/").trim_end_matches('/').to_string()
}
fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or("").to_string()
}

fn with_index<T>(root: &str, force: bool, f: impl FnOnce(&mut Index) -> T) -> T {
    let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let map = g.get_or_insert_with(HashMap::new);
    let k = key(root);
    let ix = map.entry(k.clone()).or_insert_with(|| Index::new(&k));
    if force || ix.last_sync.map(|t| t.elapsed() > FRESH).unwrap_or(true) {
        ix.sync();
    }
    f(ix)
}

fn read_json(p: &Path) -> Value {
    std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok()).unwrap_or(Value::Null)
}

/// What a vault's own settings say (read only; nothing is ever written into `.obsidian/`).
pub fn config(root: &str) -> Value {
    let o = Path::new(root).join(".obsidian");
    let app = read_json(&o.join("app.json"));
    let daily = read_json(&o.join("daily-notes.json"));
    let tpl = read_json(&o.join("templates.json"));
    let core = read_json(&o.join("core-plugins.json"));
    let types = read_json(&o.join("types.json"));
    let plugin_on = |name: &str, default: bool| -> bool {
        match &core {
            Value::Array(a) => a.iter().any(|x| x.as_str() == Some(name)),
            Value::Object(m) => m.get(name).and_then(|x| x.as_bool()).unwrap_or(default),
            _ => default,
        }
    };
    json!({
        "attachmentFolderPath": app["attachmentFolderPath"].as_str().unwrap_or("/"),
        "newFileLocation": app["newFileLocation"].as_str().unwrap_or("root"),
        "newFileFolderPath": app["newFileFolderPath"].as_str().unwrap_or(""),
        "useMarkdownLinks": app["useMarkdownLinks"].as_bool().unwrap_or(false),
        "alwaysUpdateLinks": app["alwaysUpdateLinks"].as_bool().unwrap_or(false),
        "daily": { "enabled": plugin_on("daily-notes", true), "folder": daily["folder"].as_str().unwrap_or(""), "format": daily["format"].as_str().filter(|x| !x.is_empty()).unwrap_or("YYYY-MM-DD"), "template": daily["template"].as_str().unwrap_or("") },
        "templates": { "enabled": plugin_on("templates", true), "folder": tpl["folder"].as_str().unwrap_or(""), "dateFormat": tpl["dateFormat"].as_str().unwrap_or("YYYY-MM-DD"), "timeFormat": tpl["timeFormat"].as_str().unwrap_or("HH:mm") },
        "types": types["types"].clone(),
    })
}

fn name_of(rel: &str) -> String {
    index::stem_of(rel)
}
fn ok_rel(allow: Allow, rel: &str) -> bool {
    allow.map(|f| f(rel)).unwrap_or(true)
}

fn link_json(l: &text::Link) -> Value {
    json!({ "target": l.target, "sub": l.sub, "alias": l.alias, "embed": l.embed, "md": l.md, "line": l.line })
}

fn val_json(v: &Val) -> Value {
    match v {
        Val::Null => Value::Null,
        Val::Str(x) => json!(x),
        Val::Num(x) => x.parse::<f64>().map(|n| json!(n)).unwrap_or_else(|_| json!(x)),
        Val::Bool(b) => json!(b),
        Val::List(l) => json!(l),
        Val::Complex(x) => json!(x),
    }
}
fn json_val(v: &Value, kind: &str) -> Val {
    match (kind, v) {
        (_, Value::Null) => Val::Null,
        ("checkbox", Value::Bool(b)) => Val::Bool(*b),
        ("number", Value::Number(n)) => Val::Num(n.to_string()),
        ("number", Value::String(x)) if !x.trim().is_empty() => Val::Num(x.trim().to_string()),
        ("number", _) => Val::Null,
        ("list", Value::Array(a)) => Val::List(a.iter().filter_map(|x| x.as_str().map(|s| s.trim().trim_start_matches('#').to_string())).filter(|s| !s.is_empty()).collect()),
        ("list", Value::String(x)) => Val::List(x.split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect()),
        (_, Value::Bool(b)) => Val::Bool(*b),
        (_, Value::String(x)) => Val::Str(x.clone()),
        (_, Value::Array(a)) => Val::List(a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()),
        (_, Value::Number(n)) => Val::Num(n.to_string()),
        _ => Val::Null,
    }
}
fn kind_of(key: &str, v: &Val, types: &Value) -> &'static str {
    if let Some(t) = types[key].as_str() {
        return match t { "checkbox" => "checkbox", "number" => "number", "date" => "date", "datetime" => "datetime", "multitext" | "tags" | "aliases" => "list", _ => if matches!(v, Val::Complex(_)) { "other" } else { "text" } };
    }
    let lk = key.to_lowercase();
    if matches!(lk.as_str(), "tags" | "aliases" | "cssclasses" | "tag" | "alias") { return "list"; }
    match v {
        Val::Bool(_) => "checkbox",
        Val::Num(_) => "number",
        Val::List(_) => "list",
        Val::Complex(_) => "other",
        Val::Str(x) if looks_date(x) => if x.contains('T') { "datetime" } else { "date" },
        _ => "text",
    }
}
fn looks_date(x: &str) -> bool {
    let b = x.as_bytes();
    b.len() >= 10 && b[4] == b'-' && b[7] == b'-' && b[..4].iter().all(|c| c.is_ascii_digit()) && b[5..7].iter().all(|c| c.is_ascii_digit()) && b[8..10].iter().all(|c| c.is_ascii_digit())
}

fn read_text(root: &str, rel: &str) -> Option<String> {
    std::fs::read_to_string(Path::new(root).join(rel)).ok()
}

fn atomic_write(p: &Path, text: &str) -> Result<(), String> {
    let tmp = p.with_extension("md.callio-tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, p).map_err(|e| { let _ = std::fs::remove_file(&tmp); e.to_string() })
}

fn sha(text: &str) -> String {
    // a short fingerprint is enough to notice that a note changed between two steps
    let mut h: u64 = 0xcbf29ce484222325;
    for b in text.bytes() { h ^= b as u64; h = h.wrapping_mul(0x100000001b3); }
    format!("{h:016x}")
}

fn edits_from_json(v: &Value) -> Vec<Edit> {
    v.as_array().map(|a| a.iter().map(|e| Edit { from: e["from"].as_u64().unwrap_or(0) as usize, to: e["to"].as_u64().unwrap_or(0) as usize, old: s(e, "old"), new: s(e, "new"), line: e["line"].as_u64().unwrap_or(0) as usize }).collect()).unwrap_or_default()
}
fn plan_json(plan: &[FileEdits]) -> Value {
    json!(plan.iter().map(|f| json!({ "rel": f.rel, "edits": f.edits.iter().map(|e| json!({ "from": e.from, "to": e.to, "old": e.old, "new": e.new, "line": e.line + 1 })).collect::<Vec<_>>() })).collect::<Vec<_>>())
}

/// The part of a note a link points at, as Markdown (for embeds and hover cards).
fn embed_text(text: &str, sub: &str) -> Option<String> {
    let body = text::strip_fm(text);
    if sub.is_empty() {
        return Some(body.to_string());
    }
    if let Some(b) = sub.strip_prefix('^') {
        return text::block_of(body, b);
    }
    text::section_of(body, sub)
}

pub fn run(cmd: &str, a: &Value, allow: Allow) -> Result<Value, String> {
    let root = s(a, "root");
    let need_root = || if root.is_empty() { Err("No vault folder given".to_string()) } else { Ok(()) };
    match cmd {
        "vault_props_get" => {
            let t = s(a, "text");
            let types = &a["types"];
            Ok(json!(text::props_of(&t).iter().map(|(k, v)| json!({ "key": k, "type": kind_of(k, v, types), "value": val_json(v) })).collect::<Vec<_>>()))
        }
        "vault_props_set" => {
            let t = s(a, "text");
            let k = s(a, "key");
            let kind = a["type"].as_str().unwrap_or("text");
            if k.trim().is_empty() { return Err("A property needs a name".into()); }
            Ok(json!(text::set_prop(&t, &k, &json_val(&a["value"], kind))))
        }
        "vault_props_remove" => Ok(json!(text::remove_prop(&s(a, "text"), &s(a, "key")))),
        "vault_props_rename" => Ok(json!(text::rename_prop(&s(a, "text"), &s(a, "key"), &s(a, "newKey")))),
        "vault_open" => {
            need_root()?;
            let is_vault = Path::new(&root).join(".obsidian").is_dir();
            if !is_vault {
                return Ok(json!({ "isVault": false }));
            }
            let n = with_index(&root, true, |ix| ix.files.values().filter(|f| f.note.is_some()).count());
            Ok(json!({ "isVault": true, "name": Path::new(&root).file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default(), "notes": n, "config": config(&root) }))
        }
        "vault_close" => {
            if let Some(m) = STATE.lock().unwrap_or_else(|e| e.into_inner()).as_mut() { m.remove(&key(&root)); }
            Ok(json!(true))
        }
        "vault_sync" => {
            need_root()?;
            Ok(json!({ "changed": with_index(&root, true, |ix| ix.version) }))
        }
        "vault_touch" => {
            need_root()?;
            let rel = s(a, "rel");
            let t = s(a, "text");
            with_index(&root, false, |ix| ix.touch(&rel, &t));
            Ok(json!(true))
        }
        "vault_notes" => {
            need_root()?;
            Ok(with_index(&root, false, |ix| {
                let mut notes = vec![];
                let mut files = vec![];
                for (rel, f) in &ix.files {
                    if !ok_rel(allow, rel) { continue; }
                    match &f.note {
                        Some(n) => notes.push(json!({ "rel": rel, "name": name_of(rel), "aliases": n.aliases, "mtime": f.mtime })),
                        None => files.push(json!({ "rel": rel, "name": rel.rsplit('/').next().unwrap_or(rel) })),
                    }
                }
                json!({ "notes": notes, "files": files })
            }))
        }
        "vault_resolve" => {
            need_root()?;
            let (target, sub, from, md) = (s(a, "target"), s(a, "sub"), s(a, "from"), a["md"].as_bool().unwrap_or(false));
            Ok(with_index(&root, false, |ix| {
                let r = ix.resolve(&target, &sub, &from, md);
                let rel = r.rel.filter(|x| ok_rel(allow, x));
                json!({ "rel": rel, "subOk": r.sub_ok, "linkText": if rel.is_some() { r.link_text } else { String::new() }, "isNote": rel.as_deref().map(index::is_md).unwrap_or(false) })
            }))
        }
        "vault_resolve_many" => {
            need_root()?;
            let from = s(a, "from");
            let links = a["links"].as_array().cloned().unwrap_or_default();
            Ok(with_index(&root, false, |ix| {
                json!(links.iter().map(|l| {
                    let r = ix.resolve(&s(l, "target"), &s(l, "sub"), &from, l["md"].as_bool().unwrap_or(false));
                    let rel = r.rel.filter(|x| ok_rel(allow, x));
                    json!({ "rel": rel, "subOk": r.sub_ok, "isNote": rel.as_deref().map(index::is_md).unwrap_or(false) })
                }).collect::<Vec<_>>())
            }))
        }
        "vault_headings" => {
            need_root()?;
            let rel = s(a, "rel");
            if !ok_rel(allow, &rel) { return Err("That note is outside the folders you may read.".into()); }
            Ok(with_index(&root, false, |ix| json!(ix.note(&rel).map(|n| n.headings.iter().map(|h| json!({ "level": h.level, "text": h.text, "line": h.line + 1 })).collect::<Vec<_>>()).unwrap_or_default())))
        }
        "vault_blocks" => {
            need_root()?;
            let rel = s(a, "rel");
            if !ok_rel(allow, &rel) { return Err("That note is outside the folders you may read.".into()); }
            let ids: Vec<(String, usize)> = with_index(&root, false, |ix| ix.note(&rel).map(|n| n.blocks.iter().map(|b| (b.id.clone(), b.line)).collect()).unwrap_or_default());
            let txt = read_text(&root, &rel).unwrap_or_default();
            let lines: Vec<&str> = txt.lines().collect();
            Ok(json!(ids.iter().map(|(id, ln)| {
                let own = lines.get(*ln).map(|l| l.trim().to_string()).unwrap_or_default();
                let shown = if own == format!("^{id}") { text::block_of(text::strip_fm(&txt), id).unwrap_or_default() } else { own.trim_end_matches(&format!("^{id}")[..]).trim().to_string() };
                json!({ "id": id, "text": shown.chars().take(120).collect::<String>(), "line": ln + 1 })
            }).collect::<Vec<_>>()))
        }
        "vault_tags" => {
            need_root()?;
            Ok(with_index(&root, false, |ix| {
                let f = |r: &str| ok_rel(allow, r);
                json!(ix.tag_counts(Some(&f)).into_iter().map(|(t, c)| json!({ "tag": t, "count": c })).collect::<Vec<_>>())
            }))
        }
        "vault_tag_notes" => {
            need_root()?;
            let tag = s(a, "tag");
            Ok(with_index(&root, false, |ix| json!(ix.notes_with_tag(&tag).into_iter().filter(|r| ok_rel(allow, r)).map(|r| json!({ "rel": r, "name": name_of(&r) })).collect::<Vec<_>>())))
        }
        "vault_backlinks" => {
            need_root()?;
            let rel = s(a, "rel");
            if !ok_rel(allow, &rel) { return Err("That note is outside the folders you may read.".into()); }
            let with_unlinked = a["unlinked"].as_bool().unwrap_or(true);
            let (linked, unlinked) = with_index(&root, false, |ix| {
                let l = ix.backlinks(&rel);
                let u = if with_unlinked { ix.unlinked(&rel, 40) } else { vec![] };
                (l, u)
            });
            let ctx = |src: &str, lines: &[usize]| -> Vec<Value> {
                let t = read_text(&root, src).unwrap_or_default();
                let all: Vec<&str> = t.lines().collect();
                let mut seen = vec![];
                lines.iter().filter(|l| { let new = !seen.contains(*l); seen.push(**l); new }).take(6).map(|&l| json!({ "line": l + 1, "text": all.get(l).map(|x| x.trim().chars().take(240).collect::<String>()).unwrap_or_default() })).collect()
            };
            let linked_j: Vec<Value> = linked.iter().filter(|(src, _)| ok_rel(allow, src)).map(|(src, ls)| json!({ "rel": src, "name": name_of(src), "lines": ctx(src, &ls.iter().map(|l| l.line).collect::<Vec<_>>()) })).collect();
            let unlinked_j: Vec<Value> = unlinked.iter().filter(|(src, _)| ok_rel(allow, src)).map(|(src, hits)| json!({ "rel": src, "name": name_of(src), "lines": hits.iter().map(|(l, t)| json!({ "line": l + 1, "text": t })).collect::<Vec<_>>() })).collect();
            Ok(json!({ "linked": linked_j, "unlinked": unlinked_j }))
        }
        "vault_outgoing" => {
            need_root()?;
            let rel = s(a, "rel");
            if !ok_rel(allow, &rel) { return Err("That note is outside the folders you may read.".into()); }
            Ok(with_index(&root, false, |ix| {
                json!(ix.outgoing(&rel).into_iter().map(|(l, t)| {
                    let t = t.filter(|x| ok_rel(allow, x));
                    let mut j = link_json(&l);
                    j["rel"] = json!(t);
                    j
                }).collect::<Vec<_>>())
            }))
        }
        "vault_embed" => {
            need_root()?;
            let (target, sub, from) = (s(a, "target"), s(a, "sub"), s(a, "from"));
            let md = a["md"].as_bool().unwrap_or(false);
            let rel = with_index(&root, false, |ix| ix.resolve(&target, &sub, &from, md).rel).filter(|x| ok_rel(allow, x));
            let Some(rel) = rel else { return Ok(json!({ "rel": null })) };
            if !index::is_md(&rel) {
                return Ok(json!({ "rel": rel, "kind": "file", "abs": Path::new(&root).join(&rel).to_string_lossy() }));
            }
            let t = read_text(&root, &rel).unwrap_or_default();
            let part = embed_text(&t, &sub);
            Ok(json!({ "rel": rel, "kind": "note", "found": part.is_some(), "text": part.unwrap_or_default().chars().take(60000).collect::<String>() }))
        }
        "vault_graph" => {
            need_root()?;
            let rel = s(a, "rel");
            let depth = a["depth"].as_u64().unwrap_or(1).clamp(1, 3) as usize;
            Ok(with_index(&root, false, |ix| {
                let mut nodes: Vec<String> = vec![rel.clone()];
                let mut edges: Vec<(String, String)> = vec![];
                let mut frontier = vec![rel.clone()];
                for _ in 0..depth {
                    let mut next = vec![];
                    for n in &frontier {
                        for (_, t) in ix.outgoing(n) {
                            if let Some(t) = t { if index::is_md(&t) && &t != n && ok_rel(allow, &t) { edges.push((n.clone(), t.clone())); if !nodes.contains(&t) { nodes.push(t.clone()); next.push(t); } } }
                        }
                        for (src, _) in ix.backlinks(n) {
                            if ok_rel(allow, &src) { edges.push((src.clone(), n.clone())); if !nodes.contains(&src) { nodes.push(src.clone()); next.push(src); } }
                        }
                    }
                    frontier = next;
                    if nodes.len() > 80 { break; }
                }
                edges.sort(); edges.dedup();
                edges.retain(|(a, b)| nodes.contains(a) && nodes.contains(b));
                json!({ "nodes": nodes.iter().map(|n| json!({ "rel": n, "name": name_of(n) })).collect::<Vec<_>>(), "edges": edges })
            }))
        }
        "vault_link_text" => {
            need_root()?;
            let rel = s(a, "rel");
            Ok(with_index(&root, false, |ix| json!(ix.names.link_text(&rel))))
        }
        "vault_unique" => {
            // a path that doesn't exist yet: "pic.png" → "pic 1.png" if taken
            need_root()?;
            let rel = s(a, "rel").trim_start_matches('/').to_string();
            let p = Path::new(&root);
            let (stem, ext) = match rel.rfind('.') { Some(i) if i > rel.rfind('/').map(|x| x + 1).unwrap_or(0) => (rel[..i].to_string(), rel[i..].to_string()), _ => (rel.clone(), String::new()) };
            let mut out = rel.clone();
            let mut n = 0;
            while p.join(&out).exists() { n += 1; out = format!("{stem} {n}{ext}"); }
            Ok(json!(out))
        }
        "vault_rename_plan" => {
            need_root()?;
            let (from, to) = (s(a, "from"), s(a, "to"));
            let plan = with_index(&root, true, |ix| ix.rename_plan(&from, &to));
            let n: usize = plan.iter().map(|f| f.edits.len()).sum();
            Ok(json!({ "files": plan_json(&plan), "count": n }))
        }
        "vault_rename_apply" => {
            need_root()?;
            let (from, to, undo_dir) = (s(a, "from"), s(a, "to"), s(a, "undoDir"));
            let mv = |r: &str| -> String {
                let (fl, rl) = (from.to_lowercase(), r.to_lowercase());
                if rl == fl { to.clone() } else if rl.starts_with(&format!("{fl}/")) { format!("{to}{}", &r[from.len()..]) } else { r.to_string() }
            };
            let files: Vec<(String, Vec<Edit>)> = a["files"].as_array().map(|f| f.iter().map(|x| (s(x, "rel"), edits_from_json(&x["edits"]))).collect()).unwrap_or_default();
            let op = format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
            let dir = PathBuf::from(&undo_dir).join(&op);
            let mut manifest: Vec<Value> = vec![];
            let mut done: Vec<(PathBuf, String, String, String)> = vec![]; // path, old text, new text, rel
            // check everything first: either all files are updated or none
            let mut jobs = vec![];
            for (rel, edits) in &files {
                let now_rel = if Path::new(&root).join(rel).exists() { rel.clone() } else { mv(rel) };
                let p = Path::new(&root).join(&now_rel);
                let old = std::fs::read_to_string(&p).map_err(|e| format!("{now_rel}: {e}"))?;
                let new = index::apply_edits(&old, edits).map_err(|_| format!("CHANGED: {now_rel} changed after the list was made. Nothing was updated; try the rename again."))?;
                jobs.push((p, old, new, now_rel));
            }
            if !undo_dir.is_empty() { std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?; }
            for (i, (p, old, new, rel)) in jobs.into_iter().enumerate() {
                if !undo_dir.is_empty() {
                    std::fs::write(dir.join(format!("{i}.txt")), &old).map_err(|e| e.to_string())?;
                }
                if let Err(e) = atomic_write(&p, &new) {
                    // put back what was already written
                    for (pp, o, _, _) in &done { let _ = atomic_write(pp, o); }
                    return Err(format!("{rel}: {e}"));
                }
                manifest.push(json!({ "rel": rel, "backup": format!("{i}.txt"), "sha": sha(&new) }));
                done.push((p, old, new, rel));
            }
            if !undo_dir.is_empty() {
                let _ = std::fs::write(dir.join("manifest.json"), json!({ "files": manifest, "from": from, "to": to }).to_string());
            }
            with_index(&root, true, |_| ());
            Ok(json!({ "opId": op, "changed": done.iter().map(|d| d.3.clone()).collect::<Vec<_>>() }))
        }
        "vault_undo" => {
            need_root()?;
            let dir = PathBuf::from(s(a, "undoDir")).join(s(a, "opId"));
            let m = read_json(&dir.join("manifest.json"));
            let Some(files) = m["files"].as_array() else { return Err("There is nothing to undo for that rename.".into()) };
            let (mut restored, mut skipped) = (vec![], vec![]);
            for f in files {
                let rel = s(f, "rel");
                let p = Path::new(&root).join(&rel);
                let cur = std::fs::read_to_string(&p).unwrap_or_default();
                // only if nobody has edited the note since
                if sha(&cur) != s(f, "sha") { skipped.push(rel); continue; }
                match std::fs::read_to_string(dir.join(s(f, "backup"))) {
                    Ok(old) => { atomic_write(&p, &old)?; restored.push(rel); }
                    Err(_) => skipped.push(rel),
                }
            }
            with_index(&root, true, |_| ());
            Ok(json!({ "restored": restored, "skipped": skipped, "from": m["from"], "to": m["to"] }))
        }
        _ => Err(format!("Unknown vault command {cmd}")),
    }
}
