pub mod git;
pub mod login;
pub mod web;

use crate::compile::{build_dir, find_root_path, parse_log, CompileResult};
use crate::settings::{backend, get_secret_value, Backend, SettingsState};
use crate::util::{safe_name, sha256_hex, CmdResult, ErrStr};
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};
use web::Web;

const TOKEN_KEY: &str = "overleaf-git-token";
use login::COOKIE_KEY;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub project_id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub mode: String, // "git" | "web"
    #[serde(default)]
    pub server: String,
    /// Web mode: content hashes at the last sync (relative path → sha256)
    #[serde(default)]
    pub hashes: BTreeMap<String, String>,
    /// Web mode: files changed on both sides at the last pull (key → Overleaf hash then)
    #[serde(default)]
    pub conflicts: BTreeMap<String, String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LinkInfo {
    folder: String,
    project_id: String,
    name: Option<String>,
    mode: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    updated: Vec<String>,
    conflicts: Vec<String>,
    message: String,
}

fn link_file(folder: &Path) -> PathBuf {
    // projects linked before the renames keep their link (".proemia" / ".quire" become ".callio")
    let new = folder.join(".callio");
    for old in [".proemia", ".quire"].map(|n| folder.join(n)) {
        if old.is_dir() && !new.exists() {
            let _ = std::fs::rename(&old, &new);
        }
    }
    new.join("overleaf.json")
}

fn save_link(folder: &Path, l: &Link) -> Result<()> {
    let p = link_file(folder);
    std::fs::create_dir_all(p.parent().unwrap())?;
    #[cfg(windows)]
    {
        // hide the .callio folder in Explorer
        use std::os::windows::ffi::OsStrExt;
        let w: Vec<u16> = p.parent().unwrap().as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            extern "system" {
                fn SetFileAttributesW(name: *const u16, attrs: u32) -> i32;
            }
            SetFileAttributesW(w.as_ptr(), 0x2);
        }
    }
    std::fs::write(p, serde_json::to_vec_pretty(l)?)?;
    Ok(())
}

/// Find the linked project folder containing `path` (walking up).
pub fn find_link(path: &Path, server: &str) -> Option<(PathBuf, Link)> {
    let mut d = if path.is_dir() { Some(path) } else { path.parent() };
    for _ in 0..10 {
        let cur = d?;
        if let Ok(s) = std::fs::read_to_string(link_file(cur)) {
            if let Ok(mut l) = serde_json::from_str::<Link>(&s) {
                if l.server.is_empty() {
                    l.server = server.to_string();
                }
                return Some((cur.to_path_buf(), l));
            }
        }
        if let Some(id) = git::overleaf_remote_id(cur) {
            return Some((cur.to_path_buf(), Link { project_id: id, name: None, mode: "git".into(), server: server.into(), ..Default::default() }));
        }
        d = cur.parent();
    }
    None
}

fn info(folder: &Path, l: &Link) -> LinkInfo {
    LinkInfo {
        folder: folder.to_string_lossy().to_string(),
        project_id: l.project_id.clone(),
        name: l.name.clone().or_else(|| folder.file_name().map(|n| n.to_string_lossy().to_string())),
        mode: l.mode.clone(),
    }
}

fn extra_dirs(app: &AppHandle, b: &Backend) -> Vec<PathBuf> {
    crate::engines::search_dirs(app, b)
}

fn git_client(app: &AppHandle, b: &Backend) -> Result<git::Git> {
    let token = get_secret_value(TOKEN_KEY).ok_or_else(|| anyhow!("No Overleaf Git token set. Add it in Settings → Overleaf."))?;
    let exe = git::git_exe(&extra_dirs(app, b)).ok_or_else(|| anyhow!("Git isn't installed. Install Git for Windows (git-scm.com) or switch Overleaf sync to Web mode."))?;
    Ok(git::Git::new(exe, token, &b.overleaf_url))
}

/// Connect with the stored session; if it expired, renew it silently from Overleaf's remembered
/// login, and only ask the user to sign in when that fails too.
async fn web_client(app: &AppHandle, b: &Backend) -> Result<Web> {
    if let Some(cookie) = get_secret_value(COOKIE_KEY) {
        match Web::connect(&b.overleaf_url, &cookie).await {
            Ok(w) => return Ok(w),
            Err(e) if e.to_string() != "SESSION_EXPIRED" => return Err(e),
            Err(_) => {}
        }
    }
    if let Some(fresh) = login::silent_refresh(app, &b.overleaf_url).await {
        if let Ok(w) = Web::connect(&b.overleaf_url, &fresh).await {
            return Ok(w);
        }
    }
    bail!("OVERLEAF_SIGNIN: Sign in to Overleaf to continue (your session has ended).")
}

/// Save the rolled-forward session cookie after talking to Overleaf.
fn keep_session(w: &Web) {
    if let Some(c) = w.session_cookie() {
        login::save_session(&c);
    }
}

fn choose_mode(app: &AppHandle, b: &Backend) -> &'static str {
    match b.overleaf_mode.as_str() {
        "git" => "git",
        "web" => "web",
        _ => {
            if get_secret_value(TOKEN_KEY).is_some() && git::git_exe(&extra_dirs(app, b)).is_some() {
                "git"
            } else {
                "web"
            }
        }
    }
}

// ---------------- local snapshot helpers ----------------

/// Comparison key for a project path. Windows file names are case-insensitive, so
/// "main.tex" and "Main.tex" must be treated as the same file there.
fn key(rel: &str) -> String {
    if cfg!(windows) { rel.to_lowercase() } else { rel.to_string() }
}

/// Whether a project-relative path takes part in web sync (same rule on both sides).
fn synced(rel: &str) -> bool {
    let segs: Vec<&str> = rel.split('/').collect();
    if segs.iter().any(|s| s.is_empty() || *s == ".git" || *s == ".callio") {
        return false;
    }
    let name = segs.last().copied().unwrap_or("");
    // ".overleaf." files are our conflict copies; never push them back
    !(crate::fsops::is_junk(name) || name.ends_with('~') || name.contains(".overleaf.") || name.starts_with(".~lock") || name == "desktop.ini" || name == "Thumbs.db")
}

/// Names Overleaf allows but Windows can't store.
fn valid_local_name(rel: &str) -> bool {
    rel.split('/').all(|s| {
        !s.is_empty()
            && !s.chars().any(|c| "<>:\"|?*".contains(c) || c.is_control())
            && !s.ends_with('.')
            && !s.ends_with(' ')
    })
}

struct LocalFile {
    rel: String,
    hash: String,
}

fn local_files(folder: &Path) -> BTreeMap<String, LocalFile> {
    let mut out = BTreeMap::new();
    let mut stack = vec![folder.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            // never follow symlinks/junctions out of the project
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            let p = e.path();
            let rel = p.strip_prefix(folder).unwrap().to_string_lossy().replace('\\', "/");
            if !synced(&rel) {
                continue;
            }
            if ft.is_dir() {
                stack.push(p);
            } else if let Ok(bytes) = std::fs::read(&p) {
                out.insert(key(&rel), LocalFile { hash: sha256_hex(&bytes), rel });
            }
        }
    }
    out
}

struct RemoteFile {
    rel: String,
    hash: String,
    bytes: Vec<u8>,
}

/// Remote zip → files keyed by `key()`. Rejects path traversal.
fn unzip(bytes: &[u8]) -> Result<BTreeMap<String, RemoteFile>> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
    let mut out = BTreeMap::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i)?;
        if f.is_dir() {
            continue;
        }
        let Some(p) = f.enclosed_name() else { continue };
        let rel = p.to_string_lossy().replace('\\', "/");
        if !synced(&rel) {
            continue;
        }
        let mut v = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut v)?;
        out.insert(key(&rel), RemoteFile { hash: sha256_hex(&v), rel, bytes: v });
    }
    Ok(out)
}

fn write_file(folder: &Path, rel: &str, bytes: &[u8]) -> Result<PathBuf> {
    let p = folder.join(rel);
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d)?;
    }
    let tmp = p.with_file_name(format!(".{}.callio-tmp", p.file_name().and_then(|n| n.to_str()).unwrap_or("f")));
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &p)?;
    Ok(p)
}

/// "sec/intro.tex" → "sec/intro.overleaf.tex" (extension split on the file name only)
fn conflict_name(rel: &str) -> String {
    let (dir, name) = match rel.rsplit_once('/') {
        Some((d, n)) => (format!("{d}/"), n),
        None => (String::new(), rel),
    };
    match name.rsplit_once('.') {
        Some((a, b)) if !a.is_empty() => format!("{dir}{a}.overleaf.{b}"),
        _ => format!("{dir}{name}.overleaf"),
    }
}

// ---------------- web sync ----------------
//
// `link.hashes` is the content of each file at the last sync (key → sha256).
// `link.conflicts` records files that changed on both sides (key → Overleaf's hash at that
// time); they are never pushed until the user has merged and deleted the `.overleaf.` copy.

async fn web_pull(app: &AppHandle, b: &Backend, folder: &Path, link: &mut Link) -> Result<SyncResult> {
    let w = web_client(app, b).await?;
    let remote = unzip(&w.download_zip(&link.project_id).await?)?;
    let local = local_files(folder);
    let (mut updated, mut conflicts, mut skipped, mut deleted) = (Vec::new(), Vec::new(), Vec::new(), 0);
    let mut snap: BTreeMap<String, String> = BTreeMap::new();
    for (k, r) in &remote {
        let sh = link.hashes.get(k).cloned();
        if !valid_local_name(&r.rel) {
            skipped.push(r.rel.clone());
            if let Some(sh) = sh {
                snap.insert(k.clone(), sh);
            }
            continue;
        }
        let l = local.get(k);
        // write onto the existing local file (whatever its letter case)
        let target = l.map(|l| l.rel.clone()).unwrap_or_else(|| r.rel.clone());
        match (l.map(|l| &l.hash), sh.as_ref()) {
            (Some(lh), _) if *lh == r.hash => {
                snap.insert(k.clone(), r.hash.clone());
                link.conflicts.remove(k);
            }
            (None, Some(sh)) if *sh == r.hash => {
                // deleted locally, unchanged on Overleaf: keep it deleted (push removes it there)
                snap.insert(k.clone(), sh.clone());
            }
            (None, _) => {
                updated.push(write_file(folder, &target, &r.bytes)?.to_string_lossy().to_string());
                snap.insert(k.clone(), r.hash.clone());
            }
            (Some(lh), Some(sh)) if lh == sh => {
                // unchanged locally: take Overleaf's version
                updated.push(write_file(folder, &target, &r.bytes)?.to_string_lossy().to_string());
                snap.insert(k.clone(), r.hash.clone());
            }
            (Some(_), Some(sh)) if *sh == r.hash => {
                // changed locally only: keep it, Push will send it
                snap.insert(k.clone(), sh.clone());
            }
            (Some(_), sh) if link.conflicts.get(k) == Some(&r.hash) => {
                // known conflict and Overleaf unchanged since: don't recreate the copy the
                // user may already have merged and deleted
                if let Some(sh) = sh {
                    snap.insert(k.clone(), sh.clone());
                }
            }
            (Some(_), sh) => {
                // changed on both sides (or never synced): keep local, save Overleaf's copy beside it
                write_file(folder, &conflict_name(&target), &r.bytes)?;
                conflicts.push(folder.join(&target).to_string_lossy().to_string());
                link.conflicts.insert(k.clone(), r.hash.clone());
                if let Some(sh) = sh {
                    snap.insert(k.clone(), sh.clone());
                }
            }
        }
    }
    // deleted on Overleaf since the last sync
    for (k, sh) in &link.hashes {
        if remote.contains_key(k) {
            continue;
        }
        if let Some(l) = local.get(k) {
            if &l.hash == sh {
                let _ = std::fs::remove_file(folder.join(&l.rel));
                deleted += 1;
            }
            // edited locally: keep it; it is no longer in the snapshot, so Push re-creates it
        }
        link.conflicts.remove(k);
    }
    link.hashes = snap;
    keep_session(&w);
    save_link(folder, link)?;
    let mut msg = format!("Pulled from Overleaf: {} file(s) updated", updated.len());
    if deleted > 0 {
        msg.push_str(&format!(", {deleted} removed"));
    }
    if !conflicts.is_empty() {
        msg.push_str(&format!(", {} conflict(s)", conflicts.len()));
    }
    if !skipped.is_empty() {
        msg.push_str(&format!(". Skipped names Windows can't store: {}", skipped.join(", ")));
    }
    Ok(SyncResult { updated, conflicts, message: msg })
}

async fn web_push(app: &AppHandle, b: &Backend, folder: &Path, link: &mut Link) -> Result<SyncResult> {
    let w = web_client(app, b).await?;
    let remote = unzip(&w.download_zip(&link.project_id).await?)?;
    let local = local_files(folder);
    let mut uploads: Vec<(String, String)> = Vec::new(); // (key, remote-side rel)
    let mut deletes: Vec<String> = Vec::new();
    let mut conflicts = Vec::new();
    for (k, l) in &local {
        let rh = remote.get(k).map(|r| &r.hash);
        let mut sh = link.hashes.get(k).cloned();
        if let Some(crh) = link.conflicts.get(k).cloned() {
            if folder.join(conflict_name(&l.rel)).exists() || rh != Some(&crh) {
                // not merged yet (copy still there), or Overleaf changed again since
                conflicts.push(folder.join(&l.rel).to_string_lossy().to_string());
                continue;
            }
            sh = Some(crh); // merged: the user's file supersedes that Overleaf version
        }
        if sh.as_ref() == Some(&l.hash) {
            continue;
        }
        if rh == Some(&l.hash) {
            link.hashes.insert(k.clone(), l.hash.clone());
            link.conflicts.remove(k);
            continue;
        }
        if rh.is_some() && rh != sh.as_ref() {
            conflicts.push(folder.join(&l.rel).to_string_lossy().to_string());
            continue;
        }
        // replace the existing Overleaf entity under its own name/case
        uploads.push((k.clone(), remote.get(k).map(|r| r.rel.clone()).unwrap_or_else(|| l.rel.clone())));
    }
    for (k, sh) in link.hashes.clone() {
        if !local.contains_key(&k) && !link.conflicts.contains_key(&k) && remote.get(&k).map(|r| &r.hash) == Some(&sh) {
            deletes.push(k);
        }
    }
    let n_up = uploads.len();
    let n_del = deletes.len();
    if !uploads.is_empty() || !deletes.is_empty() {
        let tree: BTreeMap<String, web::Entity> = w.tree(&link.project_id).await?.into_iter().map(|(p, e)| (key(&p), e)).collect();
        let mut tree = tree;
        for (k, rel) in &uploads {
            let (dir, name) = rel.rsplit_once('/').unwrap_or(("", rel.as_str()));
            let mut cur = String::new();
            let mut parent_id = tree.get("").map(|e| e.id.clone()).unwrap_or_default();
            if !dir.is_empty() {
                for part in dir.split('/') {
                    cur = if cur.is_empty() { part.to_string() } else { format!("{cur}/{part}") };
                    parent_id = match tree.get(&key(&cur)) {
                        Some(e) if e.kind == "folder" => e.id.clone(),
                        _ => {
                            let id = w.create_folder(&link.project_id, &parent_id, part).await?;
                            tree.insert(key(&cur), web::Entity { id: id.clone(), kind: "folder" });
                            id
                        }
                    };
                }
            }
            let l = &local[k];
            let bytes = std::fs::read(folder.join(&l.rel))?;
            let h = sha256_hex(&bytes);
            w.upload(&link.project_id, &parent_id, name, bytes).await?;
            link.hashes.insert(k.clone(), h);
            link.conflicts.remove(k);
            save_link(folder, link)?; // progress survives a failure half-way
        }
        for k in &deletes {
            if let Some(e) = tree.get(k) {
                w.delete_entity(&link.project_id, e).await?;
            }
            link.hashes.remove(k);
            save_link(folder, link)?;
        }
    }
    keep_session(&w);
    save_link(folder, link)?;
    let mut msg = if n_up == 0 && n_del == 0 { "Overleaf is already up to date".to_string() } else { format!("Pushed {n_up} file(s) to Overleaf") };
    if n_del > 0 {
        msg.push_str(&format!(", deleted {n_del}"));
    }
    if !conflicts.is_empty() {
        msg.push_str(&format!(
            ". Not pushed (changed on Overleaf too): {}. Merge with the .overleaf copy, delete that copy, then Push — or Pull first.",
            conflicts.iter().map(|c| Path::new(c).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()).collect::<Vec<_>>().join(", ")
        ));
    }
    Ok(SyncResult { updated: Vec::new(), conflicts, message: msg })
}

// ---------------- commands ----------------

#[tauri::command]
pub fn ol_link_info(state: State<SettingsState>, path: String) -> Option<LinkInfo> {
    let b = backend(&state);
    find_link(Path::new(&path), &b.overleaf_url).map(|(f, l)| info(&f, &l))
}

#[derive(Serialize)]
pub struct TestResult {
    ok: bool,
    user: String,
    projects: usize,
}

#[tauri::command]
pub async fn ol_test(app: AppHandle, state: State<'_, SettingsState>) -> CmdResult<TestResult> {
    let b = backend(&state);
    let w = web_client(&app, &b).await.es()?;
    let n = w.projects().await.map(|p| p.len()).unwrap_or(0);
    keep_session(&w);
    Ok(TestResult { ok: true, user: w.user_email.clone(), projects: n })
}

#[tauri::command]
pub async fn ol_list_projects(app: AppHandle, state: State<'_, SettingsState>) -> CmdResult<Vec<web::ProjectSummary>> {
    let b = backend(&state);
    { let w = web_client(&app, &b).await.es()?; let r = w.projects().await.es(); keep_session(&w); r }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneResult {
    folder: String,
    link: LinkInfo,
    main_file: Option<String>,
}

fn main_file(folder: &Path) -> Option<String> {
    let mut cands: Vec<PathBuf> = std::fs::read_dir(folder).ok()?.flatten().map(|e| e.path()).filter(|p| p.extension().map(|e| e == "tex").unwrap_or(false)).collect();
    cands.sort_by_key(|p| p.file_stem().map(|s| s.to_string_lossy().to_lowercase() != "main").unwrap_or(true));
    let first = cands.first()?.clone();
    Some(find_root_path(&first).to_string_lossy().to_string())
}

#[tauri::command]
pub async fn ol_clone(app: AppHandle, state: State<'_, SettingsState>, project_id: String, name: Option<String>, parent: String) -> CmdResult<CloneResult> {
    let b = backend(&state);
    let parent = PathBuf::from(parent);
    let mode = choose_mode(&app, &b);
    // name: given, else look it up (web), else the id
    let name = match name {
        Some(n) => n,
        None => match web_client(&app, &b).await {
            Ok(w) => w.projects().await.ok().and_then(|ps| ps.into_iter().find(|p| p.id == project_id).map(|p| p.name)).unwrap_or_else(|| project_id.clone()),
            Err(_) => project_id.clone(),
        },
    };
    let mut dirname = safe_name(&name);
    let mut n = 2;
    while parent.join(&dirname).exists() && std::fs::read_dir(parent.join(&dirname)).map(|mut r| r.next().is_some()).unwrap_or(true) {
        dirname = format!("{} ({n})", safe_name(&name));
        n += 1;
    }
    let mut link = Link { project_id: project_id.clone(), name: Some(name.clone()), mode: mode.into(), server: b.overleaf_url.clone(), ..Default::default() };
    let folder = if mode == "git" {
        let g = git_client(&app, &b).es()?;
        let url = git::remote_url(&b.overleaf_url, &project_id);
        let (p, d) = (parent.clone(), dirname.clone());
        let folder = tauri::async_runtime::spawn_blocking(move || g.clone_into(&p, &d, &url)).await.es()?.es()?;
        save_link(&folder, &link).es()?;
        folder
    } else {
        let folder = parent.join(&dirname);
        std::fs::create_dir_all(&folder).es()?;
        web_pull(&app, &b, &folder, &mut link).await.es()?;
        folder
    };
    Ok(CloneResult { main_file: main_file(&folder), link: info(&folder, &link), folder: folder.to_string_lossy().to_string() })
}

#[tauri::command]
pub async fn ol_link(app: AppHandle, state: State<'_, SettingsState>, folder: String, project_id: String, name: Option<String>) -> CmdResult<LinkInfo> {
    let b = backend(&state);
    let folder = PathBuf::from(folder);
    let mut mode = choose_mode(&app, &b);
    let empty = std::fs::read_dir(&folder).map(|mut r| r.next().is_none()).unwrap_or(true);
    if mode == "git" && folder.join(".git").exists() && git::overleaf_remote_id(&folder).as_deref() != Some(project_id.as_str()) {
        // a git repo for something else (e.g. GitHub): don't mix remotes
        mode = "web";
    }
    if mode == "git" && !folder.join(".git").exists() {
        if empty {
            let g = git_client(&app, &b).es()?;
            let url = git::remote_url(&b.overleaf_url, &project_id);
            let f2 = folder.clone();
            tauri::async_runtime::spawn_blocking(move || g.run(&f2, &["clone", &url, "."]).map(|_| git::exclude_callio(&f2))).await.es()?.es()?;
        } else {
            // A non-empty folder can't become a clone safely; web mode merges file by file.
            mode = "web";
        }
    }
    let link = Link { project_id, name, mode: mode.into(), server: b.overleaf_url.clone(), ..Default::default() };
    save_link(&folder, &link).es()?;
    Ok(info(&folder, &link))
}

#[tauri::command]
pub fn ol_unlink(folder: String) -> CmdResult<()> {
    let f = link_file(Path::new(&folder));
    if f.exists() {
        std::fs::remove_file(f).es()?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ol_pull(app: AppHandle, state: State<'_, SettingsState>, folder: String) -> CmdResult<SyncResult> {
    let b = backend(&state);
    let (folder, mut link) = find_link(Path::new(&folder), &b.overleaf_url).ok_or("This folder isn't linked to Overleaf")?;
    if link.mode == "git" {
        let g = git_client(&app, &b).es()?;
        let f2 = folder.clone();
        let (updated, conflicts) = tauri::async_runtime::spawn_blocking(move || g.pull(&f2)).await.es()?.es()?;
        let message = if conflicts.is_empty() {
            format!("Pulled from Overleaf: {} file(s) changed", updated.len())
        } else {
            format!("Merged with conflicts in {} file(s) — look for <<<<<<< markers, fix, save, then Push.", conflicts.len())
        };
        Ok(SyncResult { updated: updated.into_iter().chain(conflicts.clone()).collect(), conflicts, message })
    } else {
        web_pull(&app, &b, &folder, &mut link).await.es()
    }
}

#[tauri::command]
pub async fn ol_push(app: AppHandle, state: State<'_, SettingsState>, folder: String) -> CmdResult<SyncResult> {
    let b = backend(&state);
    push_folder(&app, &b, Path::new(&folder)).await.es()
}

async fn push_folder(app: &AppHandle, b: &Backend, folder: &Path) -> Result<SyncResult> {
    let (folder, mut link) = find_link(folder, &b.overleaf_url).ok_or_else(|| anyhow!("This folder isn't linked to Overleaf"))?;
    if link.mode == "git" {
        let g = git_client(app, b)?;
        let f2 = folder.clone();
        let (updated, commits) = tauri::async_runtime::spawn_blocking(move || g.push(&f2)).await??;
        let message = if commits == 0 { "Overleaf is already up to date".into() } else { "Pushed to Overleaf".into() };
        Ok(SyncResult { updated, conflicts: vec![], message })
    } else {
        web_push(app, b, &folder, &mut link).await
    }
}

/// "Overleaf" engine: push local edits, compile on Overleaf's servers, download the PDF + log.
pub async fn compile_on_overleaf(app: &AppHandle, b: &Backend, root: &Path) -> Result<CompileResult> {
    let start = std::time::Instant::now();
    let (folder, link) = find_link(root, &b.overleaf_url).ok_or_else(|| anyhow!("Compiling on Overleaf needs this folder to be linked to an Overleaf project (Overleaf panel → Link)."))?;
    let pushed = push_folder(app, b, &folder).await?;
    let w = web_client(app, b).await?;
    let res = w.compile(&link.project_id).await?;
    keep_session(&w);
    let status = res["status"].as_str().unwrap_or("error").to_string();
    let out = build_dir(app, &folder.join("output.tex"));
    std::fs::create_dir_all(&out)?;
    let _ = std::fs::write(out.join(".source-dir"), folder.to_string_lossy().as_bytes());
    let mut log = String::new();
    if let Ok(Some(l)) = w.get_output(&res, "output.log").await {
        log = String::from_utf8_lossy(&l).to_string();
    }
    if let Ok(Some(s)) = w.get_output(&res, "output.synctex.gz").await {
        let _ = std::fs::write(out.join("output.synctex.gz"), s);
    }
    let pdf = match w.get_output(&res, "output.pdf").await {
        Ok(Some(p)) => {
            let path = out.join("output.pdf");
            std::fs::write(&path, p)?;
            Some(path.to_string_lossy().to_string())
        }
        _ => None,
    };
    let main = find_root_path(root);
    let mut diagnostics = parse_log(&log, &folder, &main);
    // edits that were NOT sent (changed on Overleaf too): the PDF won't show them — say so first
    for c in pushed.conflicts.iter().rev() {
        diagnostics.insert(0, crate::compile::Diag {
            severity: "error".into(),
            file: Some(c.clone()),
            line: None,
            message: "Your changes to this file were not sent to Overleaf, because it was also changed on Overleaf since the last sync — so this PDF doesn't include them. Pull, merge with the .overleaf copy, delete that copy, then compile again.".into(),
        });
    }
    if pdf.is_none() && status != "success" && status != "failure" {
        bail!(
            "Overleaf compile returned \"{status}\"{}",
            match status.as_str() {
                "too-recently-compiled" | "autocompile-backoff" => " — wait a few seconds and try again.",
                "timedout" => " — the project took too long (free plans have a short compile timeout).",
                "compile-in-progress" => " — another compile is running.",
                _ => ".",
            }
        );
    }
    let _ = app.emit("compile-status", format!("{} · compiling on Overleaf…", pushed.message));
    Ok(CompileResult {
        ok: status == "success" && pdf.is_some() && pushed.conflicts.is_empty(),
        pdf,
        log: format!("──── {} ────\nOverleaf status: {status}\n\n{log}", pushed.message),
        diagnostics,
        engine: "Overleaf".into(),
        duration_ms: start.elapsed().as_millis() as u64,
        updated: pushed.updated,
    })
}
