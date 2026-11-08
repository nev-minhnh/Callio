//! File list operations: new file / folder, copy, move (drag and drop), duplicate, delete to the
//! Recycle Bin, a terminal in a folder, and find in folder. Everything stays inside the folder
//! that is open in the file list (only copies may come from outside, e.g. dropped from Explorer),
//! and nothing ever replaces an existing file: a clash gets a " (copy)" / " (2)" name instead.
use crate::util::{path_key, CmdResult, ErrStr};
use serde::Serialize;
use std::path::{Path, PathBuf};

fn canon(p: &Path) -> String {
    std::fs::canonicalize(p).map(|c| path_key(&c.to_string_lossy())).unwrap_or_default()
}
/// `p` is the root or inside it.
fn inside(root: &str, p: &Path, allow_root: bool) -> CmdResult<()> {
    let (rk, pk) = (canon(Path::new(root)), canon(p));
    let r = rk.trim_end_matches('/');
    if rk.is_empty() || pk.is_empty() {
        return Err("That file or folder isn't there any more".into());
    }
    if (allow_root && pk == rk) || pk.starts_with(&format!("{r}/")) {
        Ok(())
    } else {
        Err("Only files inside the open folder can be changed here".into())
    }
}
fn not_link(p: &Path) -> CmdResult<()> {
    if std::fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        return Err("Links can't be changed here".into());
    }
    Ok(())
}
fn valid_name(name: &str) -> CmdResult<&str> {
    let n = name.trim();
    const RESERVED: &[&str] = &["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "lpt1", "lpt2", "lpt3"];
    let stem = n.split('.').next().unwrap_or("").to_lowercase();
    if n.is_empty() || n == "." || n == ".." || n.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) || n.ends_with('.') || n.ends_with(' ') || RESERVED.contains(&stem.as_str()) {
        return Err("That name isn't allowed in Windows file names".into());
    }
    Ok(n)
}
/// A free name in `dir` like `name`: "a.tex" → "a (copy).tex", "a (copy 2).tex"… (or "a (2).tex").
fn free_name(dir: &Path, name: &str, word: &str) -> PathBuf {
    let p = dir.join(name);
    if !taken(&p) {
        return p;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for i in 1..1000 {
        let n = match (word.is_empty(), i) {
            (false, 1) => format!("{stem} ({word}){ext}"),
            (false, _) => format!("{stem} ({word} {i}){ext}"),
            (true, _) => format!("{stem} ({}){ext}", i + 1),
        };
        let q = dir.join(n);
        if !taken(&q) {
            return q;
        }
    }
    dir.join(format!("{stem} ({}){ext}", std::process::id()))
}
/// Something (even a broken link) is at `p`.
fn taken(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}
fn copy_rec(src: &Path, dst: &Path, depth: usize) -> std::io::Result<()> {
    if depth > 64 {
        return Err(std::io::Error::other("folders nested too deeply"));
    }
    let m = std::fs::symlink_metadata(src)?;
    if m.file_type().is_symlink() {
        return Ok(()); // links are not followed
    }
    if m.is_dir() {
        std::fs::create_dir(dst)?;
        for e in std::fs::read_dir(src)?.flatten() {
            copy_rec(&e.path(), &dst.join(e.file_name()), depth + 1)?;
        }
        Ok(())
    } else {
        std::fs::copy(src, dst).map(|_| ())
    }
}
fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

/// A new empty file (any extension) or folder in `dir`.
#[tauri::command]
pub async fn fs_create(root: String, dir: String, name: String, folder: bool) -> CmdResult<String> {
    let d = PathBuf::from(&dir);
    inside(&root, &d, true)?;
    // a path like "sub/notes.md" makes the folders on the way
    let parts: Vec<&str> = name.split(['/', '\\']).filter(|x| !x.is_empty()).collect();
    if parts.is_empty() {
        return Err("Type a name".into());
    }
    let mut p = d.clone();
    for part in &parts {
        p.push(valid_name(part)?);
        // never through a link (a junction could lead outside the folder)
        if std::fs::symlink_metadata(&p).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            return Err(format!("{part} is a link — can't create through it"));
        }
    }
    if taken(&p) {
        return Err(format!("{} already exists here", parts.join("/")));
    }
    if folder {
        std::fs::create_dir_all(&p).es()?;
    } else {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).es()?;
        }
        std::fs::OpenOptions::new().write(true).create_new(true).open(&p).es()?;
    }
    Ok(s(&p))
}

/// Copy files or folders into `dest` (from the file list, or dropped from Explorer).
#[tauri::command]
pub async fn fs_copy(root: String, paths: Vec<String>, dest: String) -> CmdResult<Vec<String>> {
    let d = PathBuf::from(&dest);
    inside(&root, &d, true)?;
    if !d.is_dir() {
        return Err("Not a folder".into());
    }
    let dk = canon(&d);
    let mut out = vec![];
    for src in paths {
        let sp = PathBuf::from(&src);
        let sk = canon(&sp);
        if sk.is_empty() {
            return Err(format!("{src} isn't there any more"));
        }
        if dk == sk || dk.starts_with(&format!("{}/", sk.trim_end_matches('/'))) {
            return Err("A folder can't be copied into itself".into());
        }
        let name = sp.file_name().ok_or("No file name")?.to_string_lossy().to_string();
        let to = free_name(&d, &name, "copy");
        let (a, b) = (sp.clone(), to.clone());
        tauri::async_runtime::spawn_blocking(move || copy_rec(&a, &b, 0)).await.es()?.map_err(|e| format!("Couldn't copy {name}: {e}"))?;
        out.push(s(&to));
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct Moved {
    /// [from, to] for every item that moved (also when a later one failed)
    moved: Vec<(String, String)>,
    error: Option<String>,
}

/// Move files or folders (inside the open folder) into `dest`. Never replaces a file there.
#[tauri::command]
pub async fn fs_move(root: String, paths: Vec<String>, dest: String) -> CmdResult<Moved> {
    let d = PathBuf::from(&dest);
    inside(&root, &d, true)?;
    if !d.is_dir() {
        return Err("Not a folder".into());
    }
    let mut moved = vec![];
    for src in paths {
        match move_one(&root, &src, &d) {
            Ok(Some(to)) => moved.push((src, to)),
            Ok(None) => {}
            Err(e) => return Ok(Moved { moved, error: Some(e) }),
        }
    }
    Ok(Moved { moved, error: None })
}
fn move_one(root: &str, src: &str, d: &Path) -> CmdResult<Option<String>> {
    let dk = canon(d);
    let sp = PathBuf::from(src);
    inside(root, &sp, false)?;
    not_link(&sp)?;
    let sk = canon(&sp);
    if dk == sk || dk.starts_with(&format!("{}/", sk.trim_end_matches('/'))) {
        return Err("A folder can't be moved into itself".into());
    }
    if sp.parent().map(canon).as_deref() == Some(dk.as_str()) {
        return Ok(None); // already there
    }
    let name = sp.file_name().ok_or("No file name")?.to_string_lossy().to_string();
    let to = d.join(&name);
    if taken(&to) {
        return Err(format!("{name} already exists in {}", d.file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default()));
    }
    if let Err(e) = std::fs::rename(&sp, &to) {
        // only for another drive (ERROR_NOT_SAME_DEVICE): copy, then remove the original.
        // Anything else (a file open in another program…) is reported, nothing is touched.
        if e.raw_os_error() != Some(if cfg!(windows) { 17 } else { 18 }) {
            return Err(format!("Couldn't move {name}: {e}"));
        }
        copy_rec(&sp, &to, 0).map_err(|e| format!("Couldn't move {name}: {e}"))?;
        if sp.is_dir() { std::fs::remove_dir_all(&sp) } else { std::fs::remove_file(&sp) }.map_err(|e| format!("Copied {name}, but couldn't remove the original: {e}"))?;
    }
    Ok(Some(s(&to)))
}

/// A copy next to the original: "a.tex" → "a (copy).tex".
#[tauri::command]
pub async fn fs_duplicate(root: String, path: String) -> CmdResult<String> {
    let sp = PathBuf::from(&path);
    inside(&root, &sp, false)?;
    let dir = sp.parent().ok_or("No folder")?.to_path_buf();
    Ok(fs_copy(root, vec![path], s(&dir)).await?.remove(0))
}

/// Delete to the Recycle Bin (it can be restored from there).
#[tauri::command]
pub async fn fs_trash(root: String, paths: Vec<String>) -> CmdResult<()> {
    for p in &paths {
        inside(&root, Path::new(p), false)?;
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::{SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW};
        // double-NUL-terminated list of paths
        let mut from: Vec<u16> = vec![];
        for p in &paths {
            from.extend(std::path::absolute(p).unwrap_or_else(|_| PathBuf::from(p)).to_string_lossy().encode_utf16());
            from.push(0);
        }
        from.push(0);
        let r = tauri::async_runtime::spawn_blocking(move || {
            let mut op: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
            op.wFunc = FO_DELETE;
            op.pFrom = from.as_ptr();
            // FOF_WANTNUKEWARNING (0x4000): ask before deleting for good when there's no Recycle Bin
            op.fFlags = (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT | 0x4000) as u16;
            let r = unsafe { SHFileOperationW(&mut op) };
            (r, op.fAnyOperationsAborted)
        })
        .await
        .es()?;
        if r.0 != 0 || r.1 != 0 {
            return Err(format!("Couldn't move to the Recycle Bin (error {:#x}) — is a file open in another program?", r.0));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        // (development builds on Linux: into ~/.local/share/Trash/files)
        let bin = std::env::var("HOME").map(|h| PathBuf::from(h).join(".local/share/Trash/files")).es()?;
        std::fs::create_dir_all(&bin).es()?;
        for p in paths {
            let sp = PathBuf::from(&p);
            let to = free_name(&bin, &sp.file_name().unwrap_or_default().to_string_lossy(), "");
            std::fs::rename(&sp, &to).es()?;
        }
        Ok(())
    }
}

/// A terminal window in `dir` (Windows Terminal when installed, else PowerShell).
#[tauri::command]
pub fn open_terminal(dir: String) -> CmdResult<()> {
    let d = PathBuf::from(&dir);
    let d = if d.is_dir() { d } else { d.parent().map(Path::to_path_buf).ok_or("No folder")? };
    // (wt reads ";" as a command separator: such folders go straight to PowerShell)
    if !d.to_string_lossy().contains(';') {
        let mut wt = std::process::Command::new("wt.exe");
        wt.arg("-d").arg(&d);
        if wt.spawn().is_ok() {
            return Ok(());
        }
    }
    let mut ps = std::process::Command::new("powershell.exe");
    ps.arg("-NoExit").current_dir(&d);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        ps.creation_flags(0x0000_0010); // CREATE_NEW_CONSOLE
    }
    ps.spawn().map(|_| ()).map_err(|e| format!("Couldn't open a terminal: {e}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    path: String,
    line: usize,
    col: usize,
    text: String,
}

/// Find text in the files of a folder (text files only; case-insensitive unless `case`).
#[tauri::command]
pub async fn fs_find(root: String, dir: String, query: String, case: bool) -> CmdResult<Vec<Hit>> {
    let d = PathBuf::from(&dir);
    inside(&root, &d, true)?;
    if query.is_empty() {
        return Ok(vec![]);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let q = if case { query.clone() } else { query.to_lowercase() };
        let mut hits = vec![];
        let mut stack = vec![(d, 0usize)];
        let mut files = 0;
        while let Some((dir, depth)) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            let mut entries: Vec<_> = rd.flatten().collect();
            entries.sort_by_key(|e| e.file_name());
            for e in entries {
                let name = e.file_name().to_string_lossy().to_string();
                let Ok(ft) = e.file_type() else { continue };
                if ft.is_symlink() || name.starts_with('.') {
                    continue;
                }
                if ft.is_dir() {
                    if depth < 24 && !["node_modules", "__pycache__", "_minted", "target"].contains(&name.as_str()) {
                        stack.push((e.path(), depth + 1));
                    }
                    continue;
                }
                if crate::fsops::is_junk(&name) || e.metadata().map(|m| m.len() > 4 << 20).unwrap_or(true) {
                    continue;
                }
                files += 1;
                if files > 20000 {
                    return hits;
                }
                let Ok(bytes) = std::fs::read(e.path()) else { continue };
                if bytes.iter().take(4096).any(|&b| b == 0) {
                    continue; // binary
                }
                let text = String::from_utf8_lossy(&bytes);
                for (i, l) in text.lines().enumerate() {
                    let hay = if case { l.to_string() } else { l.to_lowercase() };
                    if let Some(c) = hay.find(&q) {
                        let start = l.char_indices().map(|(i, _)| i).filter(|&i| i <= c.saturating_sub(40)).last().unwrap_or(0);
                        let snippet: String = l[start..].chars().take(160).collect();
                        hits.push(Hit { path: e.path().to_string_lossy().to_string(), line: i + 1, col: if l.is_char_boundary(c) { l[..c].chars().count() } else { 0 }, text: snippet.trim().to_string() });
                        if hits.len() >= 2000 {
                            return hits;
                        }
                    }
                }
            }
        }
        hits
    })
    .await
    .es()
}

/// Pick several files (PDF tools: merge, images → PDF, attachments).
#[tauri::command]
pub async fn pick_files(app: tauri::AppHandle, name: String, exts: Vec<String>) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;
    let e: Vec<&str> = exts.iter().map(String::as_str).collect();
    let mut d = app.dialog().file();
    if !e.is_empty() {
        d = d.add_filter(&name, &e);
    }
    d.add_filter("All files", &["*"])
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}
