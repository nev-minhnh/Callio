//! Watching a folder that lives in WSL. `notify` gets no reliable events from the 9P share
//! (`\\wsl.localhost\…`), so for such a folder the window is polled instead: every 2 s, only the
//! folders the tree shows and the files open in tabs (the window sends those with `envs_poll_set`).
//! Changes are reported with the same `fs-changed` event the normal watcher uses, so nothing else
//! in the window needs to know.
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter};

const EVERY: Duration = Duration::from_secs(2);
/// A folder with more entries than this is looked at by its own time stamp only.
const MAX_ENTRIES: usize = 4000;

struct Poller {
    stop: Arc<AtomicBool>,
    want: Arc<Mutex<Want>>,
}
#[derive(Default, Clone)]
struct Want {
    dirs: Vec<String>,
    files: Vec<String>,
}

static POLLERS: Mutex<BTreeMap<String, Poller>> = Mutex::new(BTreeMap::new());

/// (name → (modified ms, size)) of a folder's entries.
type Sig = HashMap<String, (u128, u64)>;

fn ms(t: std::io::Result<SystemTime>) -> u128 {
    t.ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0)
}

fn dir_sig(dir: &Path) -> Option<Sig> {
    let rd = std::fs::read_dir(dir).ok()?;
    let mut s = Sig::new();
    for (i, e) in rd.flatten().enumerate() {
        if i >= MAX_ENTRIES {
            break;
        }
        let name = e.file_name().to_string_lossy().to_string();
        // dot files and the busy folders are not shown by the tree anyway
        if name.starts_with('.') || name == "node_modules" || name == "__pycache__" {
            continue;
        }
        if let Ok(md) = e.metadata() {
            s.insert(name, (ms(md.modified()), if md.is_dir() { 0 } else { md.len() }));
        }
    }
    Some(s)
}

/// Compare a folder with its last look; returns the paths to report (the folder itself when
/// something was added or removed, and each changed file).
fn diff(dir: &Path, old: &Sig, new: &Sig) -> Vec<String> {
    let mut out = Vec::new();
    let shape = old.len() != new.len() || new.keys().any(|k| !old.contains_key(k));
    if shape {
        out.push(dir.to_string_lossy().to_string());
    }
    for (k, v) in new {
        if old.get(k).map(|o| o != v).unwrap_or(false) {
            out.push(dir.join(k).to_string_lossy().to_string());
            if !shape && !out.contains(&dir.to_string_lossy().to_string()) {
                out.push(dir.to_string_lossy().to_string());
            }
        }
    }
    out
}

/// Start polling `root` for the window `label` (replaces its previous poller).
pub fn start(app: AppHandle, label: String, root: String) {
    stop(&label);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let want = Arc::new(Mutex::new(Want { dirs: vec![root.clone()], files: vec![] }));
    POLLERS.lock().unwrap_or_else(|e| e.into_inner()).insert(label.clone(), Poller { stop: stop_flag.clone(), want: want.clone() });
    std::thread::spawn(move || {
        let mut dirs: HashMap<String, Sig> = HashMap::new();
        let mut files: HashMap<String, (u128, u64)> = HashMap::new();
        while !stop_flag.load(Ordering::Relaxed) {
            let w = want.lock().unwrap().clone();
            let mut changed: Vec<String> = Vec::new();
            for d in &w.dirs {
                let p = PathBuf::from(d);
                let Some(new) = dir_sig(&p) else {
                    if dirs.remove(d).is_some() {
                        changed.push(d.clone());
                    }
                    continue;
                };
                if let Some(old) = dirs.get(d) {
                    changed.extend(diff(&p, old, &new));
                }
                dirs.insert(d.clone(), new);
            }
            dirs.retain(|k, _| w.dirs.contains(k));
            for f in &w.files {
                let cur = std::fs::metadata(f).map(|m| (ms(m.modified()), m.len())).unwrap_or((0, 0));
                if let Some(old) = files.get(f) {
                    if *old != cur {
                        changed.push(f.clone());
                    }
                }
                files.insert(f.clone(), cur);
            }
            files.retain(|k, _| w.files.contains(k));
            changed.sort();
            changed.dedup();
            if !changed.is_empty() && !stop_flag.load(Ordering::Relaxed) {
                let _ = app.emit_to(label.clone(), "fs-changed", changed);
            }
            // sleep in small steps so stopping is quick
            for _ in 0..10 {
                if stop_flag.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(EVERY / 10);
            }
        }
    });
}

pub fn stop(label: &str) {
    if let Some(p) = POLLERS.lock().unwrap_or_else(|e| e.into_inner()).remove(label) {
        p.stop.store(true, Ordering::Relaxed);
    }
}

/// The window says which folders the tree shows and which files are open.
#[tauri::command]
pub fn envs_poll_set(window: tauri::WebviewWindow, dirs: Vec<String>, files: Vec<String>) {
    if let Some(p) = POLLERS.lock().unwrap_or_else(|e| e.into_inner()).get(window.label()) {
        let mut w = p.want.lock().unwrap();
        // at most 60 folders and 60 files: a runaway tree must not make the poll slow
        w.dirs = dirs.into_iter().take(60).collect();
        w.files = files.into_iter().take(60).collect();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diff_reports() {
        let d = Path::new("/p");
        let mut a = Sig::new();
        a.insert("a.md".into(), (1, 5));
        let mut b = a.clone();
        assert!(diff(d, &a, &b).is_empty());
        b.insert("n.md".into(), (2, 1));
        assert_eq!(diff(d, &a, &b), vec!["/p".to_string()]);
        let mut c = a.clone();
        c.insert("a.md".into(), (3, 6));
        let r = diff(d, &a, &c);
        assert!(r.contains(&"/p/a.md".to_string()) && r.contains(&"/p".to_string()));
    }
}
