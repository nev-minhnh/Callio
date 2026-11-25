//! Obsidian vault mode: the index of a vault (notes, links, tags, backlinks), link rewrites on
//! rename, the Properties (YAML) editor's text functions, and the Claude Code tools.
//! `text.rs` and `index.rs` are plain std; `api.rs` is the JSON layer; this file is the Tauri side.
pub mod api;
pub mod index;
pub mod text;

use crate::util::{CmdResult, ErrStr};
use serde_json::{json, Value};
use tauri::AppHandle;

fn undo_dir(app: &AppHandle) -> String {
    crate::settings::category_dir(app, "history").join("vault-undo").to_string_lossy().to_string()
}

async fn go(cmd: &'static str, args: Value) -> CmdResult<Value> {
    tauri::async_runtime::spawn_blocking(move || api::run(cmd, &args, None)).await.es()?
}

macro_rules! vault_cmd {
    ($name:ident) => {
        #[tauri::command]
        pub async fn $name(args: Value) -> CmdResult<Value> {
            go(stringify!($name), args).await
        }
    };
}
vault_cmd!(vault_open);
vault_cmd!(vault_close);
vault_cmd!(vault_sync);
vault_cmd!(vault_touch);
vault_cmd!(vault_notes);
vault_cmd!(vault_resolve);
vault_cmd!(vault_resolve_many);
vault_cmd!(vault_headings);
vault_cmd!(vault_blocks);
vault_cmd!(vault_tags);
vault_cmd!(vault_tag_notes);
vault_cmd!(vault_backlinks);
vault_cmd!(vault_outgoing);
vault_cmd!(vault_embed);
vault_cmd!(vault_graph);
vault_cmd!(vault_link_text);
vault_cmd!(vault_unique);
vault_cmd!(vault_rename_plan);
vault_cmd!(vault_props_get);
vault_cmd!(vault_props_set);
vault_cmd!(vault_props_remove);
vault_cmd!(vault_props_rename);

#[tauri::command]
pub async fn vault_rename_apply(app: AppHandle, mut args: Value) -> CmdResult<Value> {
    args["undoDir"] = json!(undo_dir(&app));
    go("vault_rename_apply", args).await
}
#[tauri::command]
pub async fn vault_undo(app: AppHandle, mut args: Value) -> CmdResult<Value> {
    args["undoDir"] = json!(undo_dir(&app));
    go("vault_undo", args).await
}

// ---------------- tools for Claude Code (only what the author allowed the AI to read) ----------------

pub const TOOLS: &[&str] = &["vault_backlinks", "vault_resolve", "vault_tags"];

pub fn mcp_defs() -> Vec<Value> {
    vec![
        json!({"name": "vault_backlinks", "description": "Notes in the author's Obsidian vault that link to a note (with the lines that link), plus unlinked mentions. Only inside the folders the author allowed you to read.",
            "inputSchema": {"type": "object", "properties": {"note": {"type": "string", "description": "A note name, alias or vault-relative path"}}, "required": ["note"]}}),
        json!({"name": "vault_resolve", "description": "Resolve an Obsidian link such as `Note`, `Folder/Note#Heading` or `[[Note|alias]]` to the vault-relative path of the file it points at (shortest-path rules like Obsidian), and say whether the heading or ^block exists.",
            "inputSchema": {"type": "object", "properties": {"link": {"type": "string"}, "from": {"type": "string", "description": "The note the link is written in (vault-relative path), if known"}}, "required": ["link"]}}),
        json!({"name": "vault_tags", "description": "All tags used in the author's Obsidian vault with the number of notes for each; or, with `tag`, the notes that have that tag (nested tags included).",
            "inputSchema": {"type": "object", "properties": {"tag": {"type": "string"}}}}),
    ]
}
pub fn mcp_owns(name: &str) -> bool {
    TOOLS.contains(&name)
}

pub async fn mcp_call(name: &str, args: &Value) -> Value {
    let text = |s: String, err: bool| crate::claude_code::mcp::text_result(Value::String(s), err);
    let Some(app) = crate::mcp_ext::app().cloned() else { return text("Callio isn't ready.".into(), true) };
    let (name, args) = (name.to_string(), args.clone());
    let r = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let scope = crate::obsidian::scope(&app)?;
        let root = scope.vault.to_string_lossy().to_string();
        let allow = |rel: &str| scope.can_read(rel);
        let has = |rel: &str| scope.vault.join(rel).is_file();
        // a note by name, alias or path → its path
        let find = |q: &str, from: &str| -> Result<String, String> {
            let q = q.trim().trim_start_matches("[[").trim_end_matches("]]");
            let q = q.split('|').next().unwrap_or(q).split('#').next().unwrap_or(q).trim();
            if q.is_empty() { return Err("Name a note.".into()); }
            if has(q) { return Ok(q.replace('\\', "/")); }
            let r = api::run("vault_resolve", &json!({ "root": root, "target": q, "from": from }), Some(&allow))?;
            if let Some(p) = r["rel"].as_str() { return Ok(p.to_string()); }
            // an alias?
            let list = api::run("vault_notes", &json!({ "root": root }), Some(&allow))?;
            list["notes"].as_array().and_then(|n| n.iter().find(|x| x["aliases"].as_array().map(|a| a.iter().any(|al| al.as_str().map(|s| s.eq_ignore_ascii_case(q)).unwrap_or(false))).unwrap_or(false))).and_then(|x| x["rel"].as_str().map(|s| s.to_string())).ok_or_else(|| format!("No note called “{q}” in the folders you may read."))
        };
        match name.as_str() {
            "vault_backlinks" => {
                let rel = find(args["note"].as_str().unwrap_or(""), "")?;
                let r = api::run("vault_backlinks", &json!({ "root": root, "rel": rel }), Some(&allow))?;
                let fmt = |k: &str| -> String {
                    r[k].as_array().map(|a| a.iter().map(|n| format!("- {}\n{}", n["rel"].as_str().unwrap_or(""), n["lines"].as_array().map(|l| l.iter().map(|x| format!("    line {}: {}", x["line"], x["text"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n")).unwrap_or_default())).collect::<Vec<_>>().join("\n")).unwrap_or_default()
                };
                let (l, u) = (fmt("linked"), fmt("unlinked"));
                Ok(format!("Backlinks of {rel}\n\nLinked ({}):\n{}\n\nUnlinked mentions ({}):\n{}", r["linked"].as_array().map(|a| a.len()).unwrap_or(0), if l.is_empty() { "(none)".into() } else { l }, r["unlinked"].as_array().map(|a| a.len()).unwrap_or(0), if u.is_empty() { "(none)".into() } else { u }))
            }
            "vault_resolve" => {
                let raw = args["link"].as_str().unwrap_or("");
                let inner = raw.trim().trim_start_matches('!').trim_start_matches("[[").trim_end_matches("]]");
                let left = inner.split('|').next().unwrap_or(inner);
                let (t, sub) = match left.find('#') { Some(i) => (&left[..i], &left[i + 1..]), None => (left, "") };
                let from = args["from"].as_str().unwrap_or("");
                let r = api::run("vault_resolve", &json!({ "root": root, "target": t.trim(), "sub": sub.trim(), "from": from }), Some(&allow))?;
                match r["rel"].as_str() {
                    Some(p) => Ok(format!("{p}{}", if sub.is_empty() || r["subOk"].as_bool().unwrap_or(true) { String::new() } else { format!("  (but “{sub}” is not a heading or block in it)") })),
                    None => Ok("No file in the folders you may read matches that link.".into()),
                }
            }
            "vault_tags" => {
                if let Some(tag) = args["tag"].as_str().filter(|t| !t.is_empty()) {
                    let r = api::run("vault_tag_notes", &json!({ "root": root, "tag": tag }), Some(&allow))?;
                    let v: Vec<String> = r.as_array().map(|a| a.iter().map(|x| format!("- {}", x["rel"].as_str().unwrap_or(""))).collect()).unwrap_or_default();
                    return Ok(if v.is_empty() { format!("No notes with #{}.", tag.trim_start_matches('#')) } else { v.join("\n") });
                }
                let r = api::run("vault_tags", &json!({ "root": root }), Some(&allow))?;
                let v: Vec<String> = r.as_array().map(|a| a.iter().map(|x| format!("#{} ({})", x["tag"].as_str().unwrap_or(""), x["count"])).collect()).unwrap_or_default();
                Ok(if v.is_empty() { "No tags yet.".into() } else { v.join("\n") })
            }
            _ => Err(format!("Unknown tool {name}")),
        }
    })
    .await;
    match r {
        Ok(Ok(s)) => text(s, false),
        Ok(Err(e)) => text(e, true),
        Err(e) => text(e.to_string(), true),
    }
}

/// What the AI gets about the note in front of the author: where it links and who links to it.
pub fn context_for(app: &AppHandle, rel_or_path: &str) -> String {
    let Ok(s) = crate::obsidian::scope(app) else { return String::new() };
    let root = s.vault.to_string_lossy().replace('\\', "/");
    let p = rel_or_path.replace('\\', "/");
    let rel = match p.strip_prefix(&format!("{root}/")) { Some(r) => r.to_string(), None => return String::new() };
    if !s.can_read(&rel) { return String::new(); }
    let allow = |r: &str| s.can_read(r);
    let out = api::run("vault_outgoing", &json!({ "root": root, "rel": rel }), Some(&allow)).unwrap_or(Value::Null);
    let back = api::run("vault_backlinks", &json!({ "root": root, "rel": rel, "unlinked": false }), Some(&allow)).unwrap_or(Value::Null);
    let names = |v: &Value, k: &str| -> Vec<String> {
        let mut x: Vec<String> = v.as_array().map(|a| a.iter().filter_map(|n| n[k].as_str().map(|t| t.to_string())).collect()).unwrap_or_default();
        x.sort(); x.dedup(); x.truncate(25); x
    };
    let o = names(&out, "rel");
    let b = names(&back["linked"], "rel");
    if o.is_empty() && b.is_empty() { return String::new(); }
    format!("The open note {rel} is in the author's Obsidian vault. It links to: {}. Linked from: {}. (Tools vault_backlinks, vault_resolve and vault_tags give more.)", if o.is_empty() { "nothing".into() } else { o.join(", ") }, if b.is_empty() { "no note".into() } else { b.join(", ") })
}

#[tauri::command]
pub async fn vault_ai_context(app: AppHandle, path: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || context_for(&app, &path)).await.es()
}
