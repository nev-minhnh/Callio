//! Watches the open folder so the file tree shows new, renamed, changed and deleted files at
//! once. Events are coalesced (150 ms) and reported as the folders that changed; hidden and
//! temporary files (and the busy folders under .git, node_modules…) are ignored.
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

static WATCH: Mutex<Option<RecommendedWatcher>> = Mutex::new(None);

fn ignored(root: &Path, p: &Path) -> bool {
    let Ok(rel) = p.strip_prefix(root) else { return true };
    let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect();
    let n = parts.len();
    for (i, name) in parts.iter().enumerate() {
        let last = i + 1 == n;
        let l = name.to_lowercase();
        if name.starts_with('.') || name.starts_with('~') || name.starts_with('$') || l == "node_modules" || l == "__pycache__" {
            return true;
        }
        if last && (crate::fsops::is_junk(name) || [".tmp", ".temp", ".swp", ".crdownload", ".part", ".synctex(busy)"].iter().any(|x| l.ends_with(x))) {
            return true;
        }
    }
    false
}

/// Watch `path` (and everything under it); `None` stops watching.
#[tauri::command]
pub fn fs_watch(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let mut slot = WATCH.lock().unwrap_or_else(|e| e.into_inner());
    *slot = None; // drop the previous watcher first
    let Some(path) = path.filter(|p| !p.trim().is_empty()) else { return Ok(()) };
    let root = PathBuf::from(&path);
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut w = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
    w.watch(&root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    *slot = Some(w);
    std::thread::spawn(move || {
        // ends when the watcher (and with it the sender) is dropped
        while let Ok(first) = rx.recv() {
            let mut dirs: HashSet<String> = HashSet::new();
            let mut add = |ev: notify::Result<notify::Event>| {
                if let Ok(ev) = ev {
                    if matches!(ev.kind, notify::EventKind::Access(_)) {
                        return;
                    }
                    for p in ev.paths {
                        if ignored(&root, &p) {
                            continue;
                        }
                        if let Some(d) = p.parent() {
                            dirs.insert(d.to_string_lossy().to_string());
                        }
                        // a changed file is reported too (an open tab may want to reload it)
                        dirs.insert(p.to_string_lossy().to_string());
                    }
                }
            };
            add(first);
            // coalesce a burst (a save writes, renames and touches several times)
            while let Ok(ev) = rx.recv_timeout(Duration::from_millis(150)) {
                add(ev);
            }
            if !dirs.is_empty() {
                let _ = app.emit("fs-changed", dirs.into_iter().collect::<Vec<_>>());
            }
        }
    });
    Ok(())
}
