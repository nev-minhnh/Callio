// Restore after an unclean exit, and unsaved drafts.
//
// - A marker file in the data folder says "Callio is running". It is removed by every normal exit
//   (`clean_exit`), so finding it at start means the last run ended abruptly (power cut, crash,
//   Windows restarting). The front end touches it now and then, so its modified time is about
//   when that happened.
// - Drafts: one small JSON file per unsaved text tab under `drafts/<window>/`, and the list of a
//   window's tabs under `session/<window>.json`. All writes are atomic (temp file + rename) so a
//   power cut never leaves half a file. Nothing here ever touches the user's own files.
use crate::settings::data_dir;
use crate::util::{CmdResult, ErrStr};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

fn marker_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("session.marker")
}
fn drafts_dir(app: &AppHandle) -> PathBuf {
    crate::settings::category_dir(app, "drafts")
}
fn session_dir(app: &AppHandle) -> PathBuf {
    data_dir(app).join("session")
}
/// A window label or draft key as a safe file name (letters, digits, `.`, `-`, `_`).
fn safe(s: &str) -> String {
    let t: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).take(120).collect();
    if t.is_empty() || t.starts_with('.') { format!("_{t}") } else { t }
}
fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
fn mtime_ms(p: &Path) -> Option<i64> {
    std::fs::metadata(p).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
}
/// Write a file so that a crash leaves either the old content or the new, never half of it.
fn write_atomic(path: &Path, bytes: &[u8]) -> CmdResult<()> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).es()?;
    }
    let tmp = path.with_extension("tmp");
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp).es()?;
        f.write_all(bytes).es()?;
        f.sync_all().es()?;
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

/// Called once at start (main window): did the last run end abruptly? Then marks this run.
#[tauri::command]
pub async fn session_marker_begin(app: AppHandle) -> CmdResult<Value> {
    let p = marker_path(&app);
    let (unclean, at) = if p.exists() { (true, mtime_ms(&p)) } else { (false, None) };
    write_atomic(&p, json!({ "started": now_ms() }).to_string().as_bytes())?;
    Ok(json!({ "unclean": unclean, "at": at }))
}
/// Keeps the marker's modified time current (about "when it stopped" if the run is cut short).
#[tauri::command]
pub async fn session_marker_touch(app: AppHandle) -> CmdResult<()> {
    let p = marker_path(&app);
    if p.exists() {
        write_atomic(&p, json!({ "touched": now_ms() }).to_string().as_bytes())?;
    }
    Ok(())
}
#[tauri::command]
pub async fn session_marker_end(app: AppHandle) -> CmdResult<()> {
    clean_exit(&app);
    Ok(())
}
/// Every normal way out of the app calls this (closing the window, installing an update).
pub fn clean_exit(app: &AppHandle) {
    let _ = std::fs::remove_file(marker_path(app));
}

/// Save one window's unsaved tab (`key` is made by the front end: a hash of the path or the untitled id).
#[tauri::command]
pub async fn draft_save(app: AppHandle, window: String, key: String, draft: Value) -> CmdResult<()> {
    let p = drafts_dir(&app).join(safe(&window)).join(format!("{}.json", safe(&key)));
    let bytes = serde_json::to_vec(&draft).es()?;
    tauri::async_runtime::spawn_blocking(move || write_atomic(&p, &bytes)).await.es()?
}
/// Drafts of one window, or of every window when `window` is empty. Each carries `window` and `key`.
#[tauri::command]
pub async fn draft_list(app: AppHandle, window: Option<String>) -> CmdResult<Vec<Value>> {
    let root = drafts_dir(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = vec![];
        let Ok(wins) = std::fs::read_dir(&root) else { return Ok(out) };
        for w in wins.flatten() {
            let wname = w.file_name().to_string_lossy().to_string();
            if let Some(only) = &window {
                if !only.is_empty() && safe(only) != wname {
                    continue;
                }
            }
            let Ok(files) = std::fs::read_dir(w.path()) else { continue };
            for f in files.flatten() {
                let name = f.file_name().to_string_lossy().to_string();
                let Some(key) = name.strip_suffix(".json") else { continue };
                let Ok(text) = std::fs::read_to_string(f.path()) else { continue };
                let Ok(mut v) = serde_json::from_str::<Value>(&text) else { continue };
                if let Some(o) = v.as_object_mut() {
                    o.insert("window".into(), json!(wname));
                    o.insert("key".into(), json!(key));
                }
                out.push(v);
            }
        }
        Ok(out)
    })
    .await
    .es()?
}
/// Delete one draft, or all of a window's when `key` is empty.
#[tauri::command]
pub async fn draft_delete(app: AppHandle, window: String, key: Option<String>) -> CmdResult<()> {
    let dir = drafts_dir(&app).join(safe(&window));
    match key.as_deref() {
        Some(k) if !k.is_empty() => {
            let _ = std::fs::remove_file(dir.join(format!("{}.json", safe(k))));
        }
        _ => {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
    Ok(())
}
/// Remove drafts (and saved tab lists) not touched for `max_age_ms`. Returns how many went.
#[tauri::command]
pub async fn draft_purge(app: AppHandle, max_age_ms: i64) -> CmdResult<u32> {
    let roots = [drafts_dir(&app), session_dir(&app)];
    let limit = Duration::from_millis(max_age_ms.max(0) as u64);
    tauri::async_runtime::spawn_blocking(move || {
        let mut n = 0u32;
        let old = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|e| e > limit).unwrap_or(false);
        for root in roots {
            let Ok(entries) = std::fs::read_dir(&root) else { continue };
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    if let Ok(files) = std::fs::read_dir(&p) {
                        for f in files.flatten() {
                            if old(&f.path()) && std::fs::remove_file(f.path()).is_ok() {
                                n += 1;
                            }
                        }
                    }
                    let _ = std::fs::remove_dir(&p); // only succeeds when empty
                } else if old(&p) && std::fs::remove_file(&p).is_ok() {
                    n += 1;
                }
            }
        }
        Ok(n)
    })
    .await
    .es()?
}

/// A window's tab list (paths, order, active tab, pinned, view mode, folder), for restoring it.
#[tauri::command]
pub async fn tabs_state_save(app: AppHandle, window: String, state: Value) -> CmdResult<()> {
    let p = session_dir(&app).join(format!("{}.json", safe(&window)));
    write_atomic(&p, &serde_json::to_vec(&state).es()?)
}
#[tauri::command]
pub async fn tabs_state_load(app: AppHandle, window: String) -> CmdResult<Value> {
    let p = session_dir(&app).join(format!("{}.json", safe(&window)));
    Ok(std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null))
}
#[tauri::command]
pub async fn tabs_state_delete(app: AppHandle, window: String) -> CmdResult<()> {
    let _ = std::fs::remove_file(session_dir(&app).join(format!("{}.json", safe(&window))));
    Ok(())
}
