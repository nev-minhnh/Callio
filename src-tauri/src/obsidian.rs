//! Obsidian: find it, install it (per user, no admin), connect a vault, and give Callio and the AI
//! exactly the access the author allowed. Every vault read/write/search/CLI call goes through
//! `vaultscope::Scope` here, so the limits hold even if the UI or the AI asks for more.
//! Settings it reads (non-secret): `settings.obsidian = {exe, version, cli, vaultPath, vaultName,
//! vaultId, callioDir, folderNames, read:{mode,folders}, write:{mode,folders}, cliLevel, …}`.
use crate::notes_core;
use crate::settings::{category_dir, SettingsState};
use crate::textindex::{snippet, Index};
use crate::util::{command, run_cancellable, sha256_hex, CmdResult, ErrStr};
use crate::vaultscope::{cli_allows, guess_sync, inside_vault, Scope};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

static CANCEL: AtomicBool = AtomicBool::new(false);
static BUSY: AtomicBool = AtomicBool::new(false);
static WRITE_LOCK: Mutex<()> = Mutex::new(());

const MAX_NOTE: u64 = 2 * 1024 * 1024;
const MIN_CLI: (u32, u32, u32) = (1, 12, 7);

// ---------------- finding Obsidian ----------------

fn appdata() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(PathBuf::from)
}
fn obsidian_json() -> Option<PathBuf> {
    appdata().map(|a| a.join("obsidian").join("obsidian.json"))
}

pub fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let re = regex_lite::Regex::new(r"(\d+)\.(\d+)\.(\d+)").ok()?;
    let c = re.captures(s)?;
    Some((c[1].parse().ok()?, c[2].parse().ok()?, c[3].parse().ok()?))
}

/// The vaults Obsidian knows: `{id: {path, ts, open}}` → list, the last opened first.
pub fn parse_vaults(text: &str) -> Vec<Value> {
    let v: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let mut out: Vec<Value> = v["vaults"]
        .as_object()
        .map(|o| {
            o.iter()
                .filter_map(|(id, e)| {
                    let path = e["path"].as_str()?;
                    let name = Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string());
                    Some(json!({ "id": id, "path": path, "name": name, "ts": e["ts"].as_u64().unwrap_or(0), "open": e["open"].as_bool().unwrap_or(false), "exists": Path::new(path).is_dir() }))
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|e| std::cmp::Reverse((e["open"].as_bool().unwrap_or(false), e["ts"].as_u64().unwrap_or(0))));
    out
}

#[cfg(windows)]
fn file_version(p: &Path) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
    let w: Vec<u16> = p.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        let n = GetFileVersionInfoSizeW(w.as_ptr(), std::ptr::null_mut());
        if n == 0 {
            return None;
        }
        let mut buf = vec![0u8; n as usize];
        if GetFileVersionInfoW(w.as_ptr(), 0, n, buf.as_mut_ptr() as *mut _) == 0 {
            return None;
        }
        let root: Vec<u16> = "\\\0".encode_utf16().collect();
        let mut ptr: *mut std::ffi::c_void = std::ptr::null_mut();
        let mut len = 0u32;
        if VerQueryValueW(buf.as_ptr() as *const _, root.as_ptr(), &mut ptr, &mut len) == 0 || ptr.is_null() || len < 16 {
            return None;
        }
        // VS_FIXEDFILEINFO: dwFileVersionMS / LS at offsets 8 and 12
        let words = std::slice::from_raw_parts(ptr as *const u32, 4);
        let (ms, ls) = (words[2], words[3]);
        Some(format!("{}.{}.{}", ms >> 16, ms & 0xffff, ls >> 16))
    }
}

#[cfg(windows)]
fn installed_exe() -> Option<(PathBuf, Option<String>)> {
    use winreg::enums::*;
    use winreg::RegKey;
    // the uninstall entry of a per-user install
    if let Ok(k) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Uninstall") {
        for name in k.enum_keys().flatten() {
            let Ok(sub) = k.open_subkey(&name) else { continue };
            let dn: String = sub.get_value("DisplayName").unwrap_or_default();
            if dn.trim().eq_ignore_ascii_case("obsidian") {
                let loc: String = sub.get_value("InstallLocation").unwrap_or_default();
                let ver: Option<String> = sub.get_value("DisplayVersion").ok();
                let exe = PathBuf::from(loc.trim_matches('"')).join("Obsidian.exe");
                if exe.is_file() {
                    return Some((exe, ver));
                }
                let icon: String = sub.get_value("DisplayIcon").unwrap_or_default();
                let p = PathBuf::from(icon.split(',').next().unwrap_or("").trim_matches('"'));
                if p.is_file() {
                    return Some((p, ver));
                }
            }
        }
    }
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    let exe = local.join("Programs").join("Obsidian").join("Obsidian.exe");
    exe.is_file().then(|| (exe.clone(), file_version(&exe)))
}
#[cfg(not(windows))]
fn installed_exe() -> Option<(PathBuf, Option<String>)> {
    None
}

#[cfg(windows)]
fn process_running(name: &str) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = false;
        let mut ok = Process32FirstW(snap, &mut e);
        while ok != 0 {
            let n = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
            if String::from_utf16_lossy(&e.szExeFile[..n]).eq_ignore_ascii_case(name) {
                found = true;
                break;
            }
            ok = Process32NextW(snap, &mut e);
        }
        CloseHandle(snap);
        found
    }
}
#[cfg(not(windows))]
fn process_running(_name: &str) -> bool {
    false
}

/// Where a new vault goes by default: `D:\Notes\Callio Notes` if D: exists, else in Documents.
fn default_vault_path() -> String {
    if cfg!(windows) && Path::new("D:\\").exists() {
        return "D:\\Notes\\Callio Notes".into();
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default();
    home.join("Documents").join("Callio Notes").to_string_lossy().to_string()
}

#[tauri::command]
pub async fn obs_detect() -> CmdResult<Value> {
    tauri::async_runtime::spawn_blocking(|| {
        let exe = installed_exe();
        let vaults = obsidian_json().and_then(|p| std::fs::read_to_string(p).ok()).map(|t| parse_vaults(&t)).unwrap_or_default();
        let cli = exe.as_ref().map(|(e, _)| e.with_file_name("Obsidian.com")).filter(|c| c.is_file());
        Ok(json!({
            "installed": exe.is_some(),
            "exe": exe.as_ref().map(|e| e.0.to_string_lossy().to_string()),
            "dir": exe.as_ref().and_then(|e| e.0.parent().map(|p| p.to_string_lossy().to_string())),
            "version": exe.as_ref().and_then(|e| e.1.clone()),
            "running": process_running("Obsidian.exe"),
            "vaults": vaults,
            "cli": { "exe": cli.map(|c| c.to_string_lossy().to_string()) },
            "defaultVaultPath": default_vault_path(),
        }))
    })
    .await
    .es()?
}

/// Facts about a vault folder: sync tool (guessed), whether it exists, whether Callio's folder is there.
#[tauri::command]
pub fn obs_vault_info(path: String, callio_dir: Option<String>) -> Value {
    let p = Path::new(&path);
    let has_git = p.join(".git").exists();
    let has_sync = std::fs::read_to_string(p.join(".obsidian").join("core-plugins.json")).map(|t| t.contains("\"sync\": true") || t.contains("\"sync\":true")).unwrap_or(false);
    let cd = callio_dir.unwrap_or_else(|| "Callio".into());
    json!({ "exists": p.is_dir(), "sync": guess_sync(&path, has_git, has_sync), "hasCallio": p.join(cd.trim_matches('/')).is_dir() })
}

/// Run one harmless CLI command ("version") so the author sees whether the CLI is switched on.
/// Only when asked: the first CLI command starts Obsidian.
#[tauri::command]
pub async fn obs_cli_test(exe: String, vault: String) -> CmdResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let com = PathBuf::from(&exe).with_file_name("Obsidian.com");
        if !com.is_file() {
            return Ok(json!({ "ok": false, "error": "Obsidian.com wasn't found next to Obsidian.exe. Update Obsidian to 1.12.7 or newer." }));
        }
        let mut c = command(&com);
        c.arg(format!("vault={vault}")).arg("version");
        match run_cancellable(c, std::time::Duration::from_secs(40), None) {
            Ok(o) if o.status.success() => {
                let out = String::from_utf8_lossy(&o.stdout).to_string();
                let v = parse_version(&out);
                let old = v.map(|v| v < MIN_CLI).unwrap_or(false);
                Ok(json!({ "ok": !old, "version": v.map(|v| format!("{}.{}.{}", v.0, v.1, v.2)), "error": if old { Some("Obsidian is older than 1.12.7: update it to use the CLI.") } else { None } }))
            }
            Ok(o) => {
                let msg = String::from_utf8_lossy(if o.stderr.is_empty() { &o.stdout } else { &o.stderr }).trim().chars().take(300).collect::<String>();
                Ok(json!({ "ok": false, "error": if msg.is_empty() { "The command line interface is off. In Obsidian: Settings → General → Command line interface.".to_string() } else { msg } }))
            }
            Err(e) => Ok(json!({ "ok": false, "error": format!("Couldn't run Obsidian.com: {e}") })),
        }
    })
    .await
    .es()?
}

// ---------------- scope & settings ----------------

fn cfg(app: &AppHandle) -> Value {
    app.state::<SettingsState>().0.lock().map(|v| v["obsidian"].clone()).unwrap_or(Value::Null)
}
fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default()
}
pub fn scope_from(o: &Value) -> Result<Scope, String> {
    let vault = o["vaultPath"].as_str().filter(|s| !s.is_empty()).ok_or("No Obsidian vault is connected (Settings › AI memory).")?;
    Ok(Scope::new(
        vault,
        o["callioDir"].as_str().unwrap_or("Callio"),
        o["read"]["mode"].as_str().unwrap_or("folders"),
        &strs(&o["read"]["folders"]),
        o["write"]["mode"].as_str().unwrap_or("callio"),
        &strs(&o["write"]["folders"]),
    ))
}
pub fn scope(app: &AppHandle) -> Result<Scope, String> {
    scope_from(&cfg(app))
}

// ---------------- reading, writing, searching the vault ----------------

pub struct Note {
    pub text: String,
    pub sha: String,
    pub mtime: u64,
}
fn mtime_of(p: &Path) -> u64 {
    std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn read_note(s: &Scope, rel: &str) -> Result<Option<Note>, String> {
    let (p, _) = s.check_read(rel)?;
    if !p.exists() {
        return Ok(None);
    }
    if !inside_vault(&s.vault, &p) {
        return Err("That path leaves the vault.".into());
    }
    let md = std::fs::metadata(&p).es()?;
    if !md.is_file() || md.len() > MAX_NOTE {
        return Err("That isn't a note Callio can read (too big or not a file).".into());
    }
    let bytes = std::fs::read(&p).es()?;
    let text = String::from_utf8_lossy(&bytes).to_string();
    Ok(Some(Note { sha: sha256_hex(text.as_bytes()), mtime: mtime_of(&p), text }))
}

/// Write a note atomically. `expected` is the hash of what the caller last read: if the file
/// changed on disk since (say, edited in Obsidian), nothing is written and "CHANGED" comes back.
/// The previous text is saved to Callio's version history first.
pub fn write_note(app: Option<&AppHandle>, s: &Scope, rel: &str, text: &str, expected: Option<&str>) -> Result<String, String> {
    let (p, r) = s.check_write(rel)?;
    if text.len() as u64 > MAX_NOTE {
        return Err("That note is too big.".into());
    }
    let _g = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(d) = p.parent() {
        if !inside_vault(&s.vault, d) {
            return Err("That path leaves the vault.".into());
        }
        std::fs::create_dir_all(d).es()?;
    }
    if p.exists() {
        if !inside_vault(&s.vault, &p) {
            return Err("That path leaves the vault.".into());
        }
        let cur = String::from_utf8_lossy(&std::fs::read(&p).es()?).to_string();
        if let Some(e) = expected {
            if sha256_hex(cur.as_bytes()) != e {
                return Err(format!("CHANGED: {r} was changed on disk (for example in Obsidian) after Callio read it. Nothing was written."));
            }
        }
        if let Some(a) = app {
            let _ = crate::history::record(a, &p.to_string_lossy(), &cur, "Before an AI memory update", "ai");
        }
    } else if expected.map(|e| !e.is_empty()).unwrap_or(false) {
        return Err(format!("CHANGED: {r} was removed after Callio read it. Nothing was written."));
    }
    let tmp = p.with_extension("md.callio-tmp");
    {
        let mut f = std::fs::File::create(&tmp).es()?;
        f.write_all(text.as_bytes()).es()?;
        f.sync_all().es()?;
    }
    std::fs::rename(&tmp, &p).es()?;
    Ok(sha256_hex(text.as_bytes()))
}

struct VaultIndex {
    key: String,
    at: std::time::Instant,
    docs: Vec<(String, String)>,
    idx: Index,
}
static INDEX: Mutex<Option<VaultIndex>> = Mutex::new(None);

/// `papers/sub` → the folder as spelled on disk (`Papers/Sub`), or the input when it doesn't exist.
fn real_case(vault: &Path, folder: &str) -> (String, PathBuf) {
    let mut dir = vault.to_path_buf();
    let mut rel: Vec<String> = vec![];
    for part in folder.split('/') {
        let found = std::fs::read_dir(&dir).ok().and_then(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).find(|n| n.eq_ignore_ascii_case(part)));
        let name = found.unwrap_or_else(|| part.to_string());
        dir = dir.join(&name);
        rel.push(name);
    }
    (rel.join("/"), dir)
}

fn walk_notes(s: &Scope) -> Vec<(String, PathBuf)> {
    let mut roots: Vec<(String, PathBuf)> = vec![];
    match s.read_folders() {
        None => roots.push((String::new(), s.vault.clone())),
        Some(fs) => {
            for f in fs {
                // settings compare lowercase; use the folder's real spelling for paths shown to the AI
                let (rel, dir) = real_case(&s.vault, &f);
                roots.push((rel, dir));
            }
        }
    }
    let mut out = vec![];
    for (prefix, root) in roots {
        let mut stack = vec![(prefix, root)];
        while let Some((rel, dir)) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
                let Ok(ft) = e.file_type() else { continue };
                if ft.is_symlink() {
                    continue;
                }
                if ft.is_dir() {
                    stack.push((r, e.path()));
                } else if ft.is_file() && (name.ends_with(".md") || name.ends_with(".txt")) && e.metadata().map(|m| m.len() <= 300_000).unwrap_or(false) {
                    out.push((r, e.path()));
                    if out.len() >= 4000 {
                        return out;
                    }
                }
            }
        }
    }
    out
}

/// BM25 over the notes the AI may read. The index is rebuilt at most once a minute.
pub fn search_notes(app: &AppHandle, s: &Scope, query: &str, limit: usize) -> Vec<Value> {
    let key = format!("{:?}|{:?}|{}", s.vault, s.read, mtime_of(&s.vault));
    let _ = app;
    let mut g = INDEX.lock().unwrap_or_else(|e| e.into_inner());
    let stale = g.as_ref().map(|i| i.key != key || i.at.elapsed().as_secs() > 60).unwrap_or(true);
    if stale {
        let mut docs = vec![];
        let mut idx = Index::default();
        for (rel, p) in walk_notes(s) {
            let Ok(b) = std::fs::read(&p) else { continue };
            let text = String::from_utf8_lossy(&b).to_string();
            let n = docs.len() as u32;
            idx.add(n, &[(&rel, 2.0), (&text, 1.0)]);
            docs.push((rel, text));
        }
        idx.finish();
        *g = Some(VaultIndex { key, at: std::time::Instant::now(), docs, idx });
    }
    let vi = g.as_ref().unwrap();
    vi.idx
        .search(query, limit, |_| true)
        .into_iter()
        .map(|(d, score)| {
            let (rel, text) = &vi.docs[d as usize];
            let sn = snippet(text, query, 240).map(|x| x.0).unwrap_or_else(|| text.chars().take(240).collect());
            json!({ "path": rel, "score": score, "snippet": sn })
        })
        .collect()
}

#[tauri::command]
pub async fn vault_read(app: AppHandle, path: String) -> CmdResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = scope(&app)?;
        Ok(match read_note(&s, &path)? {
            Some(n) => json!({ "exists": true, "text": n.text, "sha": n.sha, "mtime": n.mtime }),
            None => json!({ "exists": false }),
        })
    })
    .await
    .es()?
}

#[tauri::command]
pub async fn vault_write(app: AppHandle, path: String, text: String, expected_sha: Option<String>) -> CmdResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = scope(&app)?;
        let sha = write_note(Some(&app), &s, &path, &text, expected_sha.as_deref())?;
        Ok(json!({ "sha": sha }))
    })
    .await
    .es()?
}

#[tauri::command]
pub async fn vault_list(app: AppHandle, dir: Option<String>) -> CmdResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = scope(&app)?;
        let rel = dir.unwrap_or_default();
        let (base, r) = if rel.trim().is_empty() || rel.trim() == "." { (s.vault.clone(), String::new()) } else { let (p, r) = s.check_read(&rel)?; (p, r) };
        let mut out = vec![];
        for e in std::fs::read_dir(&base).es()?.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let child = if r.is_empty() { name.clone() } else { format!("{r}/{name}") };
            // the root lists only what may be read (or leads to it)
            if s.can_read(&child) || r.is_empty() && s.read_folders().map(|f| f.iter().any(|x| x.starts_with(&child.to_lowercase()))).unwrap_or(true) {
                out.push(json!({ "name": name, "path": child, "isDir": e.file_type().map(|t| t.is_dir()).unwrap_or(false) }));
            }
        }
        Ok(json!({ "entries": out }))
    })
    .await
    .es()?
}

#[tauri::command]
pub async fn vault_search(app: AppHandle, query: String, limit: Option<usize>) -> CmdResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = scope(&app)?;
        Ok(json!({ "hits": search_notes(&app, &s, &query, limit.unwrap_or(8).min(25)) }))
    })
    .await
    .es()?
}

/// The CLI, only the commands the chosen level allows. `args` is everything after `Obsidian.com`
/// except `vault=…` (added here, first).
#[tauri::command]
pub async fn obs_cli(app: AppHandle, args: Vec<String>) -> CmdResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let o = cfg(&app);
        let level = o["cliLevel"].as_str().unwrap_or("read").to_string();
        let exe = o["exe"].as_str().ok_or("Obsidian isn't connected.")?;
        if o["cli"].as_str() == Some("off") {
            return Err("The Obsidian command line interface isn't switched on.".to_string());
        }
        let name = o["vaultName"].as_str().ok_or("No vault is connected.")?;
        let cmd = args.iter().find(|a| !a.contains('=') && !a.starts_with('-')).cloned().unwrap_or_default();
        if !cli_allows(&level, &cmd) {
            return Err(format!("“{cmd}” isn't allowed at the CLI level you chose (Settings › AI memory › Permissions)."));
        }
        if args.iter().any(|a| a.starts_with("vault=")) {
            return Err("The vault is fixed by Callio.".into());
        }
        let com = PathBuf::from(exe).with_file_name("Obsidian.com");
        let mut c = command(&com);
        c.arg(format!("vault={name}"));
        c.args(&args);
        let out = run_cancellable(c, std::time::Duration::from_secs(60), None).es()?;
        Ok(json!({ "ok": out.status.success(), "stdout": String::from_utf8_lossy(&out.stdout).chars().take(20000).collect::<String>(), "stderr": String::from_utf8_lossy(&out.stderr).chars().take(2000).collect::<String>() }))
    })
    .await
    .es()?
}

/// Open the vault (or one note) in Obsidian: `obsidian://open?vault=…&file=…`.
#[tauri::command]
pub fn obs_open(app: AppHandle, file: Option<String>) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let o = cfg(&app);
    let vault = o["vaultId"].as_str().filter(|s| !s.is_empty()).or_else(|| o["vaultName"].as_str()).ok_or("No vault is connected.")?;
    let mut uri = format!("obsidian://open?vault={}", urlencoding::encode(vault));
    if let Some(f) = file {
        let s = scope_from(&o)?;
        let (_, rel) = s.check_read(&f)?;
        uri.push_str(&format!("&file={}", urlencoding::encode(rel.strip_suffix(".md").unwrap_or(&rel))));
    }
    app.opener().open_url(uri, None::<&str>).es()
}

// ---------------- creating a vault and registering it ----------------

fn new_vault_id() -> String {
    let mut b = [0u8; 8];
    let _ = getrandom::getrandom(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Add the vault to Obsidian's list — only while Obsidian is closed (it rewrites the file on exit).
/// Other vaults are kept; the file is replaced atomically.
fn register_vault(path: &Path) -> Result<Option<String>, String> {
    let Some(file) = obsidian_json() else { return Err("Couldn't find %APPDATA%.".into()) };
    let mut v: Value = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}));
    if !v["vaults"].is_object() {
        v["vaults"] = json!({});
    }
    // already registered?
    let key = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
    if let Some((id, _)) = v["vaults"].as_object().unwrap().iter().find(|(_, e)| e["path"].as_str().map(|p| key(p) == key(&path.to_string_lossy())).unwrap_or(false)) {
        return Ok(Some(id.clone()));
    }
    if process_running("Obsidian.exe") {
        return Ok(None);
    }
    let id = new_vault_id();
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    v["vaults"][&id] = json!({ "path": path.to_string_lossy(), "ts": ts });
    if let Some(d) = file.parent() {
        std::fs::create_dir_all(d).es()?;
    }
    let tmp = file.with_extension("json.callio-tmp");
    std::fs::write(&tmp, serde_json::to_vec(&v).es()?).es()?;
    std::fs::rename(&tmp, &file).es()?;
    Ok(Some(id))
}

/// Create the vault folder and Callio's structure in it; register it with Obsidian when possible.
fn setup_vault(path: &Path, callio_dir: &str, vi: bool, register: bool) -> Result<Value, String> {
    let (pn, sn) = notes_core::folder_names(vi);
    let cd = callio_dir.trim_matches(|c| c == '/' || c == '\\');
    let cd = if cd.is_empty() { "Callio" } else { cd };
    crate::vaultscope::normalize_rel(cd)?;
    std::fs::create_dir_all(path.join(".obsidian")).es()?;
    for f in [pn, sn] {
        std::fs::create_dir_all(path.join(cd).join(f)).es()?;
    }
    let readme = path.join(cd).join("README.md");
    if !readme.exists() {
        let t = format!("# Callio\n\nNotes the AI keeps for your projects.\n\n- `{pn}/` — one note per project (goals, decisions, conventions…)\n- `{sn}/` — one note per AI session (summary, files changed, decisions)\n\nCallio saves the previous version of a note before every AI change, and you review each change first.\n");
        std::fs::write(&readme, t).es()?;
    }
    let (id, needs_close) = if register {
        match register_vault(path)? {
            Some(id) => (Some(id), false),
            None => (None, true),
        }
    } else {
        (None, false)
    };
    Ok(json!({ "vaultId": id, "needsClose": needs_close, "folderNames": { "projects": pn, "sessions": sn }, "callioDir": cd }))
}

#[tauri::command]
pub async fn obs_setup_vault(path: String, callio_dir: Option<String>, vi: bool, register: bool) -> CmdResult<Value> {
    tauri::async_runtime::spawn_blocking(move || setup_vault(Path::new(&path), callio_dir.as_deref().unwrap_or("Callio"), vi, register)).await.es()?
}

// ---------------- installing Obsidian ----------------

fn step(app: &AppHandle, step: &str, state: &str, pct: Option<u32>, text: &str) {
    let _ = app.emit("obs-install", json!({ "step": step, "state": state, "pct": pct, "text": text }));
}

#[tauri::command]
pub fn obs_install_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

#[cfg(windows)]
fn authenticode_ok(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::core::GUID;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Security::WinTrust::*;
    let w: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        let mut fi: WINTRUST_FILE_INFO = std::mem::zeroed();
        fi.cbStruct = std::mem::size_of::<WINTRUST_FILE_INFO>() as u32;
        fi.pcwszFilePath = w.as_ptr();
        let mut d: WINTRUST_DATA = std::mem::zeroed();
        d.cbStruct = std::mem::size_of::<WINTRUST_DATA>() as u32;
        d.dwUIChoice = WTD_UI_NONE;
        d.fdwRevocationChecks = WTD_REVOKE_NONE;
        d.dwUnionChoice = WTD_CHOICE_FILE;
        d.dwStateAction = WTD_STATEACTION_VERIFY;
        d.Anonymous.pFile = &mut fi;
        let mut action = GUID { data1: 0x00AAC56B, data2: 0xCD44, data3: 0x11d0, data4: [0x8C, 0xC2, 0x00, 0xC0, 0x4F, 0xC2, 0x95, 0xEE] };
        let hwnd = INVALID_HANDLE_VALUE as _;
        let rc = WinVerifyTrust(hwnd, &mut action, &mut d as *mut _ as *mut std::ffi::c_void);
        d.dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrust(hwnd, &mut action, &mut d as *mut _ as *mut std::ffi::c_void);
        if rc == 0 {
            Ok(())
        } else {
            Err(format!("Windows doesn't trust the installer's signature (code 0x{:08X}).", rc as u32))
        }
    }
}
#[cfg(not(windows))]
fn authenticode_ok(_p: &Path) -> Result<(), String> {
    Ok(())
}

fn pick_asset(release: &Value) -> Option<Value> {
    let assets = release["assets"].as_array()?;
    let ok = |a: &&Value| a["name"].as_str().map(|n| n.to_lowercase().ends_with(".exe")).unwrap_or(false);
    assets
        .iter()
        .filter(ok)
        .find(|a| {
            let n = a["name"].as_str().unwrap_or("").to_lowercase();
            !n.contains("arm64") && !n.contains("ia32") && !n.contains("portable")
        })
        .or_else(|| assets.iter().find(ok))
        .cloned()
}

async fn download_installer(app: &AppHandle) -> Result<(PathBuf, String), String> {
    let client = reqwest::Client::builder().user_agent("Callio").timeout(std::time::Duration::from_secs(600)).build().es()?;
    step(app, "download", "run", Some(0), "Looking up the latest Obsidian…");
    let rel: Value = client.get("https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest").header("Accept", "application/vnd.github+json").send().await.es()?.error_for_status().es()?.json().await.es()?;
    let asset = pick_asset(&rel).ok_or("The Obsidian release has no Windows installer.")?;
    let version = rel["tag_name"].as_str().unwrap_or("").trim_start_matches('v').to_string();
    let url = asset["browser_download_url"].as_str().ok_or("The release asset has no download link.")?.to_string();
    if !url.starts_with("https://github.com/obsidianmd/obsidian-releases/releases/download/") {
        return Err("The download link isn't Obsidian's official GitHub release; stopped.".into());
    }
    let size = asset["size"].as_u64().unwrap_or(0);
    let digest = asset["digest"].as_str().and_then(|d| d.strip_prefix("sha256:")).map(|s| s.to_lowercase());
    let dir = category_dir(app, "downloads");
    std::fs::create_dir_all(&dir).es()?;
    let file = dir.join(format!("Obsidian-{version}.exe"));
    let mut resp = client.get(&url).send().await.es()?.error_for_status().es()?;
    let total = resp.content_length().unwrap_or(size);
    let tmp = file.with_extension("exe.part");
    let mut f = std::fs::File::create(&tmp).es()?;
    let mut h = sha2::Sha256::default();
    let mut got = 0u64;
    use sha2::Digest;
    while let Some(chunk) = resp.chunk().await.es()? {
        if CANCEL.load(Ordering::SeqCst) {
            drop(f);
            let _ = std::fs::remove_file(&tmp);
            return Err("Cancelled".into());
        }
        h.update(&chunk);
        f.write_all(&chunk).es()?;
        got += chunk.len() as u64;
        if total > 0 {
            step(app, "download", "run", Some((got * 100 / total) as u32), &format!("Downloading Obsidian {version}…"));
        }
    }
    f.sync_all().es()?;
    drop(f);
    step(app, "download", "done", Some(100), &format!("Downloaded Obsidian {version}"));
    // verify before anything runs
    step(app, "verify", "run", None, "Checking the download…");
    let sha: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    let fail = |m: String| {
        let _ = std::fs::remove_file(&tmp);
        Err::<(), String>(m)
    };
    if size > 0 && got != size {
        fail(format!("The download is incomplete ({got} of {size} bytes)."))?;
    }
    if let Some(d) = &digest {
        if *d != sha {
            fail("The download doesn't match the checksum GitHub published for it; it was deleted.".into())?;
        }
    }
    if let Err(e) = authenticode_ok(&tmp) {
        fail(e.clone())?;
    }
    std::fs::rename(&tmp, &file).es()?;
    step(app, "verify", "done", None, if digest.is_some() { "Checked: checksum and signature" } else { "Checked: size and signature (GitHub published no checksum)" });
    Ok((file, version))
}

/// Download, verify, install (per user, silent), then create and register the vault.
#[tauri::command]
pub async fn obs_install(app: AppHandle, vault_path: String, vi: bool) -> CmdResult<Value> {
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("An install is already running.".into());
    }
    CANCEL.store(false, Ordering::SeqCst);
    let r = install_inner(&app, &vault_path, vi).await;
    BUSY.store(false, Ordering::SeqCst);
    r
}

async fn install_inner(app: &AppHandle, vault_path: &str, vi: bool) -> CmdResult<Value> {
    let (installer, version) = match download_installer(app).await {
        Ok(x) => x,
        Err(e) => {
            step(app, "download", "fail", None, &e);
            return Err(e);
        }
    };
    step(app, "install", "run", None, "Installing Obsidian for you only…");
    let a2 = app.clone();
    let inst = installer.clone();
    let res = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut c = command(&inst);
        c.args(["/S", "/currentuser"]);
        let out = run_cancellable(c, std::time::Duration::from_secs(420), Some(&CANCEL)).map_err(|e| e.to_string())?;
        if CANCEL.load(Ordering::SeqCst) {
            return Err("Cancelled".into());
        }
        if !out.status.success() {
            return Err(format!("The installer stopped with code {}.", out.status.code().unwrap_or(-1)));
        }
        let _ = &a2;
        Ok(())
    })
    .await
    .es()?;
    if let Err(e) = res {
        step(app, "install", "fail", None, &e);
        return Err(e);
    }
    let det = obs_detect().await?;
    if det["installed"] != json!(true) {
        let e = "Obsidian didn't show up after the install. Try the installer by hand from obsidian.md.".to_string();
        step(app, "install", "fail", None, &e);
        return Err(e);
    }
    step(app, "install", "done", None, &format!("Installed Obsidian {}", det["version"].as_str().unwrap_or(&version)));
    step(app, "vault", "run", None, "Creating the vault and registering it with Obsidian…");
    let vp = PathBuf::from(vault_path);
    let vi2 = vi;
    let setup = tauri::async_runtime::spawn_blocking(move || setup_vault(&vp, "Callio", vi2, true)).await.es()?;
    let setup = match setup {
        Ok(s) => s,
        Err(e) => {
            step(app, "vault", "fail", None, &e);
            return Err(e);
        }
    };
    if setup["needsClose"] == json!(true) {
        step(app, "vault", "done", None, "Vault created — close Obsidian, then press Register");
    } else {
        step(app, "vault", "done", None, "Vault created and registered");
    }
    let name = Path::new(vault_path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    Ok(json!({ "exe": det["exe"], "version": det["version"].as_str().map(|s| s.to_string()).or(Some(version)), "cliExe": det["cli"]["exe"], "vaultPath": vault_path, "vaultName": name, "vaultId": setup["vaultId"], "needsClose": setup["needsClose"], "folderNames": setup["folderNames"], "callioDir": "Callio" }))
}
