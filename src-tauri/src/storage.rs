//! Data storage: where Callio keeps its data (library, history, memory, tools…) and moving it to
//! another drive. `storage_core.rs` holds the pure rules; this file reads/writes the pointer
//! (`config_dir/storage.json`), measures folders and copies them safely:
//!   copy (with sha256) → verify (count, sizes, sha256) → write the pointer → restart → the old
//!   copies are only deleted after the author confirms on the next start.
//! A failed or cancelled move leaves the old location in use and removes what it copied.
use crate::settings::config_dir;
use crate::storage_core::*;
use crate::util::{CmdResult, ErrStr};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};

static LAYOUT: OnceLock<Layout> = OnceLock::new();
/// "Open without my data": nothing is read from or written to the missing location.
static NO_DATA: AtomicBool = AtomicBool::new(false);
static MOVING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

const MARKER: &str = ".callio-data";

fn pointer_path(app: &AppHandle) -> PathBuf {
    config_dir(app).join("storage.json")
}
fn cleanup_path(app: &AppHandle) -> PathBuf {
    config_dir(app).join("storage-cleanup.json")
}
fn default_data(app: &AppHandle) -> PathBuf {
    app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("Callio"))
}
/// `data\` next to Callio.exe: portable mode.
fn portable_dir() -> Option<PathBuf> {
    let d = std::env::current_exe().ok()?.parent()?.join("data");
    d.is_dir().then_some(d)
}
fn read_pointer(app: &AppHandle) -> Pointer {
    let v: Value = std::fs::read_to_string(pointer_path(app)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    Pointer {
        data_dir: v["dataDir"].as_str().map(|s| s.to_string()),
        categories: v["categories"].as_object().map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect()).unwrap_or_default(),
    }
}
fn write_json_atomic(p: &Path, v: &Value) -> Result<(), String> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).es()?;
    }
    let tmp = p.with_extension("json.tmp");
    {
        let mut f = std::fs::File::create(&tmp).es()?;
        f.write_all(&serde_json::to_vec_pretty(v).es()?).es()?;
        f.sync_all().es()?;
    }
    std::fs::rename(&tmp, p).es()
}
fn write_pointer(app: &AppHandle, p: &Pointer) -> Result<(), String> {
    write_json_atomic(&pointer_path(app), &json!({ "dataDir": p.data_dir, "categories": p.categories }))
}

fn layout(app: &AppHandle) -> &'static Layout {
    LAYOUT.get_or_init(|| resolve(&read_pointer(app), &default_data(app), portable_dir().as_deref(), &|p| p.exists()))
}
fn nodata_dir() -> PathBuf {
    std::env::temp_dir().join("Callio-no-data")
}

/// Callio's data folder. Read once at start; honours the pointer and portable mode. When the
/// chosen location is missing, nothing is created anywhere: this is a scratch folder until the
/// author decides (see `storage_status`).
pub fn data_dir(app: &AppHandle) -> PathBuf {
    let l = layout(app);
    if !l.problems.is_empty() || NO_DATA.load(Ordering::SeqCst) {
        return nodata_dir();
    }
    l.data.clone()
}
/// Where one data folder (`library`, `history`, `memory`…) lives now.
pub fn category_dir(app: &AppHandle, name: &str) -> PathBuf {
    let l = layout(app);
    if l.problems.is_empty() && !NO_DATA.load(Ordering::SeqCst) {
        if let Some(p) = l.cats.get(name) {
            return p.clone();
        }
    }
    data_dir(app).join(name)
}
/// Every Callio-owned location (for the uninstaller).
pub fn extra_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let l = layout(app);
    let mut v = vec![l.data.clone()];
    v.extend(l.cats.values().cloned());
    v.retain(|p| !l.portable && p.exists());
    v
}

/// Writers (memory, history) wait here while a move runs.
pub fn wait_while_moving() {
    for _ in 0..1200 {
        if !MOVING.load(Ordering::SeqCst) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

// ---------------- measuring ----------------

fn dir_size(p: &Path) -> (u64, u64) {
    let (mut bytes, mut files) = (0u64, 0u64);
    let mut stack = vec![p.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                stack.push(e.path());
            } else if ft.is_file() {
                bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
                files += 1;
            }
        }
    }
    (bytes, files)
}

#[cfg(windows)]
fn free_space(p: &Path) -> Option<(u64, u64)> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    // the nearest folder that exists
    let mut cur = Some(p);
    while let Some(c) = cur {
        if c.exists() {
            let w: Vec<u16> = c.as_os_str().encode_wide().chain(Some(0)).collect();
            let (mut free, mut total, mut tf) = (0u64, 0u64, 0u64);
            let ok = unsafe { GetDiskFreeSpaceExW(w.as_ptr(), &mut free, &mut total, &mut tf) };
            return (ok != 0).then_some((free, total));
        }
        cur = c.parent();
    }
    None
}
#[cfg(not(windows))]
fn free_space(_p: &Path) -> Option<(u64, u64)> {
    None
}

fn drive_of(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        return s[..2].to_uppercase();
    }
    if s.starts_with("\\\\") {
        return s.split('\\').filter(|x| !x.is_empty()).take(2).collect::<Vec<_>>().join("\\");
    }
    "/".into()
}

#[tauri::command]
pub async fn storage_info(app: AppHandle) -> CmdResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let l = layout(&app);
        let mut cats = vec![];
        for c in CATS {
            let mut size = 0u64;
            let mut where_: Vec<String> = vec![];
            let mut present: Vec<&str> = vec![];
            for f in c.folders {
                let p = category_dir(&app, f);
                if p.is_dir() {
                    size += dir_size(&p).0;
                    present.push(f);
                    where_.push(p.to_string_lossy().to_string());
                }
            }
            let mut w = where_.clone();
            w.sort();
            w.dedup();
            cats.push(json!({ "id": c.id, "label": c.label, "folders": c.folders, "present": present, "size": size, "where": drive_list(&where_), "movable": true }));
        }
        let mut drives: Vec<Value> = vec![];
        let mut seen: Vec<String> = vec![];
        let mut roots = vec![l.data.clone()];
        roots.extend(l.cats.values().cloned());
        for r in roots {
            let d = drive_of(&r);
            if seen.contains(&d) {
                continue;
            }
            seen.push(d.clone());
            let fs = free_space(&r);
            drives.push(json!({ "drive": d, "free": fs.map(|x| x.0), "total": fs.map(|x| x.1) }));
        }
        Ok(json!({
            "dataDir": data_dir(&app).to_string_lossy(),
            "defaultDir": default_data(&app).to_string_lossy(),
            "portable": l.portable,
            "categories": cats,
            "drives": drives,
            "stays": [config_dir(&app).to_string_lossy()],
        }))
    })
    .await
    .es()?
}
fn drive_list(w: &[String]) -> String {
    let mut v: Vec<String> = w.iter().map(|s| drive_of(Path::new(s))).collect();
    v.sort();
    v.dedup();
    v.join(", ")
}

/// Cheap, at start: where things stand (missing location, leftovers to delete, portable offer).
#[tauri::command]
pub fn storage_status(app: AppHandle) -> Value {
    let l = layout(&app);
    let cleanup: Vec<Value> = cleanup_list(&app).into_iter().map(|p| json!({ "path": p.to_string_lossy() })).collect();
    let portable_offer = l.portable && {
        let done = l.data.join(".portable-offer-done").exists();
        let d = default_data(&app);
        !done && !same_path(&d, &l.data) && CATS.iter().any(|c| c.folders.iter().any(|f| d.join(f).is_dir() && !l.data.join(f).is_dir()))
    };
    json!({
        "dataDir": data_dir(&app).to_string_lossy(),
        "portable": l.portable,
        "problems": l.problems.iter().map(|p| json!({"path": p.path, "what": p.what})).collect::<Vec<_>>(),
        "noData": NO_DATA.load(Ordering::SeqCst),
        "cleanup": cleanup,
        "portableOffer": portable_offer,
        "defaultDir": default_data(&app).to_string_lossy(),
    })
}

/// "Try again" after a missing drive: if every location is there now, restart so Callio starts normally.
#[tauri::command]
pub fn storage_retry(app: AppHandle) -> bool {
    let l = resolve(&read_pointer(&app), &default_data(&app), portable_dir().as_deref(), &|p| p.exists());
    if l.problems.is_empty() {
        app.restart();
    }
    false
}
#[tauri::command]
pub fn storage_open_without_data() {
    NO_DATA.store(true, Ordering::SeqCst);
}
#[tauri::command]
pub fn storage_portable_dismiss(app: AppHandle) {
    let _ = std::fs::write(layout(&app).data.join(".portable-offer-done"), "1");
}
#[tauri::command]
pub fn storage_restart(app: AppHandle) {
    app.restart();
}

/// Point Callio at another data folder (after a missing drive): an empty folder, or an existing Callio data folder.
#[tauri::command]
pub fn storage_use_folder(app: AppHandle, path: String) -> CmdResult<()> {
    let p = PathBuf::from(path.trim());
    check_dest_folder(&app, &p)?;
    std::fs::create_dir_all(&p).es()?;
    let _ = std::fs::write(p.join(MARKER), "Callio data folder\n");
    write_pointer(&app, &Pointer { data_dir: Some(p.to_string_lossy().to_string()), categories: HashMap::new() })
}

fn cleanup_list(app: &AppHandle) -> Vec<PathBuf> {
    let v: Value = std::fs::read_to_string(cleanup_path(app)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    let l = layout(app);
    v["old"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str()).map(PathBuf::from).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        // only what still exists and is not in use now
        .filter(|p| p.is_dir() && !is_in_use(app, l, p))
        .collect()
}
fn is_in_use(app: &AppHandle, l: &Layout, p: &Path) -> bool {
    let mut live: Vec<PathBuf> = vec![l.data.clone()];
    live.extend(l.cats.values().cloned());
    CATS.iter().flat_map(|c| c.folders.iter()).any(|f| same_path(&category_dir(app, f), p)) || live.iter().any(|d| same_path(d, p) || is_inside(d, p))
}

/// After a move: delete the old copies (`delete`) or keep them and stop asking (`keep`).
#[tauri::command]
pub async fn storage_cleanup(app: AppHandle, action: String) -> CmdResult<u64> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut freed = 0;
        if action == "delete" {
            for p in cleanup_list(&app) {
                // only folders with a Callio data name, never anything else
                let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                if !is_folder_name(&name) {
                    continue;
                }
                freed += dir_size(&p).0;
                std::fs::remove_dir_all(&p).es()?;
            }
        }
        let _ = std::fs::remove_file(cleanup_path(&app));
        Ok(freed)
    })
    .await
    .es()?
}

// ---------------- moving ----------------

/// A destination must be empty or already a Callio data folder, and not inside what is being moved.
fn check_dest_folder(app: &AppHandle, dest: &Path) -> Result<(), String> {
    if dest.as_os_str().is_empty() || !dest.is_absolute() {
        return Err("Choose a folder (a full path such as D:\\Callio data).".into());
    }
    let l = layout(app);
    if l.portable && same_path(dest, &l.data) {
        return Ok(());
    }
    for c in CATS {
        for f in c.folders {
            let src = category_dir(app, f);
            if is_inside(dest, &src) {
                return Err(format!("That folder is inside the current “{f}” folder. Choose another place."));
            }
        }
    }
    if dest.exists() {
        if !dest.is_dir() {
            return Err("That path is a file, not a folder.".into());
        }
        let empty = std::fs::read_dir(dest).map(|mut r| r.next().is_none()).unwrap_or(false);
        if !empty && !dest.join(MARKER).exists() {
            return Err("That folder isn't empty and isn't a Callio data folder. Choose an empty folder.".into());
        }
    }
    Ok(())
}

fn busy_reason(app: &AppHandle) -> Option<String> {
    let n = app.try_state::<crate::claude_code::CcState>().map(|s| s.running()).unwrap_or(0);
    if n > 0 {
        return Some(format!("{n} Claude Code session{} {} running. Stop {} first.", if n == 1 { "" } else { "s" }, if n == 1 { "is" } else { "are" }, if n == 1 { "it" } else { "them" }));
    }
    None
}

fn plan(app: &AppHandle, dest: &Path, ids: &[String]) -> Vec<(String, PathBuf, PathBuf)> {
    folders_of(ids)
        .into_iter()
        .filter_map(|f| {
            let src = category_dir(app, f);
            (src.is_dir() && !same_path(&src, &dest.join(f))).then(|| (f.to_string(), src, dest.join(f)))
        })
        .collect()
}

#[tauri::command]
pub async fn storage_check_dest(app: AppHandle, dest: String, ids: Vec<String>) -> CmdResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let d = PathBuf::from(dest.trim());
        if let Err(e) = check_dest_folder(&app, &d) {
            return Ok(json!({ "ok": false, "error": e }));
        }
        let p = plan(&app, &d, &ids);
        let existing: Vec<String> = p.iter().filter(|(_, _, dst)| dst.is_dir() && dst.read_dir().map(|mut r| r.next().is_some()).unwrap_or(false)).map(|(f, _, _)| f.clone()).collect();
        let need: u64 = p.iter().filter(|(f, _, _)| !existing.contains(f)).map(|(_, s, _)| dir_size(s).0).sum();
        let free = free_space(&d).map(|x| x.0);
        let ok = free.map(|f| f > need + need / 20 + 64 * 1024 * 1024).unwrap_or(true);
        let busy = busy_reason(&app);
        Ok(json!({
            "ok": ok && busy.is_none(), "need": need, "free": free, "useExisting": existing, "busy": busy,
            "error": if !ok { Some("There isn't enough free space on that drive for the selected data.".to_string()) } else { busy.clone() },
        }))
    })
    .await
    .es()?
}

#[tauri::command]
pub fn storage_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

struct Copied {
    rel: PathBuf,
    size: u64,
    sha: String,
}

struct Progress<'a> {
    app: &'a AppHandle,
    total: u64,
    done: u64,
    files_total: u64,
    files_done: u64,
    last: std::time::Instant,
}
impl Progress<'_> {
    fn emit(&mut self, phase: &str, file: &str, force: bool) {
        if !force && self.last.elapsed().as_millis() < 120 {
            return;
        }
        self.last = std::time::Instant::now();
        let _ = self.app.emit("callio-storage-progress", json!({ "phase": phase, "done": self.done, "total": self.total, "files": self.files_done, "filesTotal": self.files_total, "file": file }));
    }
}

fn walk_files(root: &Path) -> Vec<(PathBuf, u64)> {
    let mut out = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                stack.push(e.path());
            } else if ft.is_file() {
                out.push((e.path().strip_prefix(root).unwrap_or(&e.path()).to_path_buf(), e.metadata().map(|m| m.len()).unwrap_or(0)));
            }
        }
    }
    out.sort();
    out
}

fn copy_file(src: &Path, dst: &Path, pr: &mut Progress) -> Result<(u64, String), String> {
    if let Some(p) = dst.parent() {
        std::fs::create_dir_all(p).es()?;
    }
    let tmp = dst.with_extension(format!("{}.callio-part", dst.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default()));
    let mut r = std::fs::File::open(src).map_err(|e| format!("Couldn't read {}: {e}", src.display()))?;
    let mut w = std::fs::File::create(&tmp).map_err(|e| format!("Couldn't write {}: {e}", tmp.display()))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut n = 0u64;
    loop {
        if CANCEL.load(Ordering::SeqCst) {
            drop(w);
            let _ = std::fs::remove_file(&tmp);
            return Err("Cancelled".into());
        }
        let k = r.read(&mut buf).map_err(|e| format!("Couldn't read {}: {e}", src.display()))?;
        if k == 0 {
            break;
        }
        h.update(&buf[..k]);
        w.write_all(&buf[..k]).map_err(|e| format!("Couldn't write {}: {e}", tmp.display()))?;
        n += k as u64;
        pr.done += k as u64;
        pr.emit("copy", &src.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(), false);
    }
    w.sync_all().es()?;
    drop(w);
    std::fs::rename(&tmp, dst).es()?;
    let sha: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    Ok((n, sha))
}

fn hash_file(p: &Path, pr: &mut Progress) -> Result<String, String> {
    let mut r = std::fs::File::open(p).map_err(|e| format!("Couldn't read {}: {e}", p.display()))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        if CANCEL.load(Ordering::SeqCst) {
            return Err("Cancelled".into());
        }
        let k = r.read(&mut buf).map_err(|e| e.to_string())?;
        if k == 0 {
            break;
        }
        h.update(&buf[..k]);
        pr.done += k as u64;
        pr.emit("verify", &p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(), false);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn do_move(app: &AppHandle, dest: &Path, ids: &[String]) -> Result<Value, String> {
    let todo = plan(app, dest, ids);
    if todo.is_empty() {
        return Err("Nothing to move: the selected folders don't exist yet.".into());
    }
    // data already in the new place is used as it is (never overwritten)
    let (use_existing, todo): (Vec<_>, Vec<_>) = todo.into_iter().partition(|(_, _, dst)| dst.is_dir() && dst.read_dir().map(|mut r| r.next().is_some()).unwrap_or(false));
    std::fs::create_dir_all(dest).es()?;
    let mut created: Vec<PathBuf> = vec![];
    let mut sizes: Vec<(String, Vec<(PathBuf, u64)>)> = vec![];
    let (mut total, mut nfiles) = (0u64, 0u64);
    for (f, src, _) in &todo {
        let files = walk_files(src);
        total += files.iter().map(|x| x.1).sum::<u64>();
        nfiles += files.len() as u64;
        sizes.push((f.clone(), files));
    }
    let mut pr = Progress { app, total: total * 2, done: 0, files_total: nfiles, files_done: 0, last: std::time::Instant::now() };
    let run = (|| -> Result<Vec<(String, PathBuf, PathBuf)>, String> {
        let mut copied: Vec<(String, Vec<Copied>)> = vec![];
        for ((f, src, dst), (_, files)) in todo.iter().zip(&sizes) {
            if !dst.exists() {
                created.push(dst.clone());
            }
            std::fs::create_dir_all(dst).es()?;
            let mut list = vec![];
            for (rel, _) in files {
                let (size, sha) = copy_file(&src.join(rel), &dst.join(rel), &mut pr)?;
                pr.files_done += 1;
                list.push(Copied { rel: rel.clone(), size, sha });
            }
            copied.push((f.clone(), list));
        }
        // verify: same number of files, same sizes, same sha256
        pr.files_done = 0;
        for ((_, _, dst), (_, list)) in todo.iter().zip(&copied) {
            let now = walk_files(dst);
            if now.len() != list.len() {
                return Err(format!("Verification failed: {} has {} files, expected {}.", dst.display(), now.len(), list.len()));
            }
            for c in list {
                let p = dst.join(&c.rel);
                let sz = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(u64::MAX);
                if sz != c.size {
                    return Err(format!("Verification failed: {} has a different size.", p.display()));
                }
                if hash_file(&p, &mut pr)? != c.sha {
                    return Err(format!("Verification failed: {} was not copied correctly.", p.display()));
                }
                pr.files_done += 1;
            }
        }
        Ok(todo.clone())
    })();
    match run {
        Err(e) => {
            // keep using the old location; remove only what this move created
            for c in created.iter().rev() {
                let _ = std::fs::remove_dir_all(c);
            }
            Err(e)
        }
        Ok(moved) => {
            let _ = std::fs::write(dest.join(MARKER), "Callio data folder\n");
            let all_ids = ids.len() == CATS.len();
            let mut names: Vec<&str> = moved.iter().map(|m| m.0.as_str()).collect();
            names.extend(use_existing.iter().map(|m| m.0.as_str()));
            let l = layout(app);
            if !l.portable {
                let np = after_move(&read_pointer(app), dest, &names, all_ids);
                write_pointer(app, &np)?;
            }
            // the old copies are listed for deletion after the next start (only if the author agrees)
            let mut old: Vec<String> = moved.iter().map(|m| m.1.to_string_lossy().to_string()).collect();
            let prev: Value = std::fs::read_to_string(cleanup_path(app)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
            for x in prev["old"].as_array().into_iter().flatten().filter_map(|x| x.as_str()) {
                if !old.iter().any(|o| o == x) {
                    old.push(x.to_string());
                }
            }
            let _ = write_json_atomic(&cleanup_path(app), &json!({ "old": old }));
            pr.emit("done", "", true);
            Ok(json!({ "moved": names, "files": nfiles, "bytes": total, "restart": !l.portable, "usedExisting": use_existing.iter().map(|m| m.0.clone()).collect::<Vec<_>>() }))
        }
    }
}

#[tauri::command]
pub async fn storage_move(app: AppHandle, dest: String, ids: Vec<String>) -> CmdResult<Value> {
    let d = PathBuf::from(dest.trim());
    check_dest_folder(&app, &d)?;
    if let Some(b) = busy_reason(&app) {
        return Err(b);
    }
    if MOVING.swap(true, Ordering::SeqCst) {
        return Err("A move is already running.".into());
    }
    CANCEL.store(false, Ordering::SeqCst);
    let _ = app.emit("callio-storage-moving", json!({ "moving": true }));
    let a2 = app.clone();
    let r = tauri::async_runtime::spawn_blocking(move || do_move(&a2, &d, &ids)).await.map_err(|e| e.to_string());
    MOVING.store(false, Ordering::SeqCst);
    let _ = app.emit("callio-storage-moving", json!({ "moving": false }));
    r?
}
