//! AI chat sessions, saved per project folder (next to that project's memory):
//! data/memory/<project hash>/sessions/<id>.json. The window owns the format; this only
//! stores, lists and deletes.
use crate::util::{CmdResult, ErrStr};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use tauri::AppHandle;

fn sdir(app: &AppHandle, project: &str) -> PathBuf {
    crate::memory::dir(app, project).join("sessions")
}
fn valid(id: &str) -> CmdResult<()> {
    if id.is_empty() || id.len() > 48 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Bad session id".into());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    id: String,
    title: String,
    created: u64,
    updated: u64,
    count: usize,
    model: String,
}

#[tauri::command]
pub async fn sess_list(app: AppHandle, project: String) -> CmdResult<Vec<SessionMeta>> {
    tauri::async_runtime::spawn_blocking(move || {
        let d = sdir(&app, &project);
        let mut out = vec![];
        let Ok(rd) = std::fs::read_dir(&d) else { return out };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let Some(v) = std::fs::read(&p).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { continue };
            let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            let n = |k: &str| v.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
            out.push(SessionMeta {
                id: p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                title: s("title"),
                created: n("created"),
                updated: n("updated"),
                count: v.get("history").and_then(|h| h.as_array()).map(|a| a.len()).unwrap_or(0),
                model: s("model"),
            });
        }
        out.sort_by(|a, b| b.updated.cmp(&a.updated));
        out
    })
    .await
    .es()
}

#[tauri::command]
pub fn sess_get(app: AppHandle, project: String, id: String) -> CmdResult<Value> {
    valid(&id)?;
    let b = std::fs::read(sdir(&app, &project).join(format!("{id}.json"))).map_err(|_| "That conversation no longer exists".to_string())?;
    serde_json::from_slice(&b).es()
}

#[tauri::command]
pub fn sess_put(app: AppHandle, project: String, id: String, session: Value) -> CmdResult<()> {
    valid(&id)?;
    let d = sdir(&app, &project);
    std::fs::create_dir_all(&d).es()?;
    let bytes = serde_json::to_vec(&session).es()?;
    if bytes.len() > 40 * 1024 * 1024 {
        return Err("This conversation is too long to save".into());
    }
    let tmp = d.join(format!("{id}.json.tmp"));
    std::fs::write(&tmp, bytes).es()?;
    std::fs::rename(tmp, d.join(format!("{id}.json"))).es()
}

#[tauri::command]
pub fn sess_delete(app: AppHandle, project: String, id: String) -> CmdResult<()> {
    valid(&id)?;
    let p = sdir(&app, &project).join(format!("{id}.json"));
    match std::fs::remove_file(p) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}
