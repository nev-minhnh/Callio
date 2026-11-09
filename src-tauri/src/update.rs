//! Version takeover and full uninstall.
//!
//! * A newer Callio started while an older one runs: the older copy (from any path) is asked
//!   to close so the new code really runs (the single-instance lock would otherwise hand the
//!   launch to the old window), and the user can replace the old copy in place.
//! * "Uninstall Callio": removes Open with / default-app entries, saved credentials, Claude
//!   Code skill copies, all app data, and the program itself (installer or portable files).
use crate::util::CmdResult;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Credential names Callio stores (keyring target "<name>.Callio").
const SECRETS: &[&str] = &[
    "ai-key-anthropic", "ai-key-openai", "ai-key-gemini", "ai-key-perplexity", "ai-key-xai", "ai-key-llamacpp",
    "ai-key-custom", "search-key-brave", "search-key-tavily", "search-key-searxng", "search-key-none",
    "overleaf-git-token", "overleaf-session", "library-extension-token",
];

/// "0.4.0" → [0,4,0]; anything unparsable compares as 0.
pub fn parse_version(v: &str) -> Vec<u64> {
    v.trim().split(|c: char| c == '.' || c == ',').map(|p| p.trim().chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0)).collect()
}

pub fn newer(a: &str, b: &str) -> bool {
    let (mut x, mut y) = (parse_version(a), parse_version(b));
    let n = x.len().max(y.len());
    x.resize(n, 0);
    y.resize(n, 0);
    x > y
}

/// Reads the ProductVersion string from a Windows exe's version resource by scanning for
/// the UTF-16 key (no Win32 version API needed; works for any PE file).
pub fn exe_version_bytes(data: &[u8]) -> Option<String> {
    res_string(data, "ProductVersion", |s| s.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false))
}
/// A string of the exe's version resource (`ProductName`, `ProductVersion`, …).
fn res_string(data: &[u8], name: &str, ok: impl Fn(&str) -> bool) -> Option<String> {
    let key: Vec<u8> = format!("{name}\0").encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
    let mut from = 0;
    while let Some(off) = data[from..].windows(key.len()).position(|w| w == key.as_slice()) {
        let mut i = from + off + key.len();
        // padding to a 32-bit boundary
        while i + 1 < data.len() && data[i] == 0 && data[i + 1] == 0 {
            i += 2;
        }
        let mut s = String::new();
        while i + 1 < data.len() {
            let c = u16::from_le_bytes([data[i], data[i + 1]]);
            if c == 0 || s.len() > 40 {
                break;
            }
            s.push(char::from_u32(c as u32).unwrap_or('?'));
            i += 2;
        }
        if ok(&s) {
            return Some(s);
        }
        from = from + off + 2;
    }
    None
}

/// The version of a Callio exe — None for any other program (ProductName must be "Callio").
pub fn exe_version(p: &Path) -> Option<String> {
    let meta = std::fs::metadata(p).ok()?;
    if !meta.is_file() || meta.len() > 200 * 1024 * 1024 {
        return None;
    }
    let data = std::fs::read(p).ok()?;
    res_string(&data, "ProductName", |s| s == "Callio")?;
    exe_version_bytes(&data)
}

fn same_path(a: &Path, b: &Path) -> bool {
    let n = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()).to_string_lossy().to_lowercase();
    n(a) == n(b)
}

/// `--wait-pid=N`: a hand-off from an older window; wait for it to exit so the
/// single-instance lock is free.
pub fn wait_for_handoff(args: &[String]) {
    if let Some(pid) = args.iter().find_map(|a| a.strip_prefix("--wait-pid=")).and_then(|p| p.parse::<u32>().ok()) {
        imp::wait_pid(pid, 20_000);
    }
}

/// Runs before the window exists. Returns false when this launch should stop.
pub fn startup_takeover(args: &[String]) -> bool {
    #[cfg(windows)]
    {
        if cfg!(debug_assertions) {
            return true;
        }
        return imp::takeover(args);
    }
    #[allow(unreachable_code)]
    {
        let _ = args;
        true
    }
}

/// Called by the single-instance plugin: a second launch came from another exe.
/// Some((exe, version)) when that exe is newer than us.
pub fn newer_launch(argv: &[String], cwd: &str) -> Option<(String, String)> {
    let first = argv.first()?;
    let mut p = PathBuf::from(first);
    if p.is_relative() {
        p = Path::new(cwd).join(p);
    }
    if !p.exists() {
        return None;
    }
    let me = std::env::current_exe().ok()?;
    if same_path(&p, &me) {
        return None;
    }
    let v = exe_version(&p)?;
    if !newer(&v, VERSION) {
        return None;
    }
    *NEWER.lock().unwrap_or_else(|e| e.into_inner()) = Some(p.clone());
    Some((p.to_string_lossy().to_string(), v))
}
/// The newer exe a second launch came from — the only program `handoff` will start.
static NEWER: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

/// Starts the newer Callio (it waits for us to exit) with these files, and quits.
#[tauri::command]
pub fn handoff(app: AppHandle, files: Vec<String>) -> CmdResult<()> {
    let p = NEWER.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("No newer Callio was started")?;
    let v = exe_version(&p).ok_or("That file isn't a Callio program")?;
    if !newer(&v, VERSION) {
        return Err("That copy isn't newer".into());
    }
    let mut cmd = std::process::Command::new(&p);
    cmd.arg(format!("--wait-pid={}", std::process::id()));
    // only existing files, never options
    cmd.args(files.into_iter().filter(|a| !a.starts_with('-') && Path::new(a).is_file()));
    cmd.spawn().map_err(|e| format!("Couldn't start {}: {e}", p.display()))?;
    app.exit(0);
    Ok(())
}

// ---------------------------------------------------------------- uninstall

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallInfo {
    exe: String,
    installed: bool,
    install_dir: Option<String>,
    data_dirs: Vec<String>,
    other_copies: Vec<String>,
    papers: usize,
    claude_skills: usize,
    tinytex: Option<String>,
}

fn data_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let r = app.path();
    let mut v: Vec<PathBuf> = [r.app_config_dir(), r.app_data_dir(), r.app_local_data_dir(), r.app_cache_dir(), r.app_log_dir()]
        .into_iter()
        .filter_map(|p| p.ok())
        .collect();
    v.sort();
    v.dedup();
    // never anything shallow (a resolver bug must not point at %APPDATA% itself)
    v.retain(|p| p.components().count() >= 4 && p.to_string_lossy().to_lowercase().contains("callio"));
    v
}

fn tinytex_dir() -> Option<PathBuf> {
    let pd = std::env::var_os("ProgramData")?;
    let p = PathBuf::from(pd).join("Callio");
    p.exists().then_some(p)
}

#[tauri::command]
pub fn uninstall_info(app: AppHandle) -> UninstallInfo {
    let exe = std::env::current_exe().unwrap_or_default();
    let install_dir = imp::install_dir();
    let installed = install_dir.as_ref().map(|d| exe.starts_with(d)).unwrap_or(false);
    let others = imp::known_copies().into_iter().filter(|p| !same_path(p, &exe) && p.exists()).map(|p| p.to_string_lossy().to_string()).collect();
    UninstallInfo {
        exe: exe.to_string_lossy().to_string(),
        installed,
        install_dir: install_dir.map(|d| d.to_string_lossy().to_string()),
        data_dirs: data_dirs(&app).into_iter().filter(|p| p.exists()).map(|p| p.to_string_lossy().to_string()).collect(),
        other_copies: others,
        papers: crate::library::paper_count(&app),
        claude_skills: crate::ai::skills_github::claude_code_count(&app),
        tinytex: tinytex_dir().map(|p| p.to_string_lossy().to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallOpts {
    #[serde(default = "yes")]
    program: bool,
    #[serde(default = "yes")]
    other_copies: bool,
}
fn yes() -> bool {
    true
}

/// Files that came with a portable Callio, next to `exe`: only ours are listed.
fn portable_files(exe: &Path, my_dll_hash: Option<&[u8]>) -> (Vec<PathBuf>, Option<PathBuf>) {
    let mut files = vec![exe.to_path_buf()];
    let Some(dir) = exe.parent() else { return (files, None) };
    let dll = dir.join("WebView2Loader.dll");
    if let (Some(h), Ok(b)) = (my_dll_hash, std::fs::read(&dll)) {
        if crate::util::sha256_hex(&b).as_bytes() == h {
            files.push(dll);
        }
    }
    for f in ["callio-office.exe", "drawio.zip"] {
        let p = dir.join(f);
        if p.is_file() {
            files.push(p);
        }
    }
    let readme = dir.join("READ-ME.txt");
    if std::fs::read_to_string(&readme).map(|t| t.starts_with("Callio ")).unwrap_or(false) {
        files.push(readme);
    }
    // the folder goes too only if it is Callio's own (named so) and ends up empty
    let name = dir.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let own = name.contains("callio") && dir.components().count() >= 3;
    (files, own.then(|| dir.to_path_buf()))
}

#[derive(Serialize)]
struct CleanupPlan {
    pid: u32,
    dirs: Vec<String>,
    files: Vec<String>,
    #[serde(rename = "emptyDirs")]
    empty_dirs: Vec<String>,
    uninstaller: String,
}

#[tauri::command]
pub async fn uninstall_everything(app: AppHandle, opts: UninstallOpts) -> CmdResult<()> {
    // 1. Open with, defaults, Capabilities, our registry key
    crate::assoc::unregister_all();
    // 2. credentials
    for s in SECRETS {
        for svc in ["Callio", "Proemia", "Quire"] {
            if let Ok(e) = keyring::Entry::new(svc, s) {
                let _ = e.delete_credential();
            }
        }
    }
    imp::delete_all_credentials();
    // 3. Claude Code skill copies Callio installed
    crate::ai::skills_github::remove_claude_code_copies(&app);
    // 4. files: deleted by a script after we exit (the WebView holds its data folder open)
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut dirs: Vec<PathBuf> = data_dirs(&app);
    if let Some(t) = tinytex_dir() {
        dirs.push(t);
    }
    let install_dir = imp::install_dir();
    let installed = install_dir.as_ref().map(|d| exe.starts_with(d)).unwrap_or(false);
    let my_dll = exe.parent().and_then(|d| std::fs::read(d.join("WebView2Loader.dll")).ok()).map(|b| crate::util::sha256_hex(&b));
    let (mut files, mut empty_dirs) = (vec![], vec![]);
    let mut add = |e: &Path| {
        let (f, d) = portable_files(e, my_dll.as_deref().map(|h| h.as_bytes()));
        files.extend(f);
        empty_dirs.extend(d);
    };
    if opts.program && !installed {
        add(&exe);
    }
    if opts.other_copies {
        for p in imp::known_copies() {
            // only real Callio programs (exe_version checks the product name)
            if !same_path(&p, &exe) && !install_dir.as_ref().map(|d| p.starts_with(d)).unwrap_or(false) && exe_version(&p).is_some() {
                add(&p);
            }
        }
    }
    let uninstaller = if opts.program { imp::uninstaller() } else { None };
    imp::forget_copies();

    // The paths travel in a JSON file the script reads — never spliced into the script text.
    let s_ = |v: &[PathBuf]| v.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>();
    let plan = CleanupPlan { pid: std::process::id(), dirs: s_(&dirs), files: s_(&files), empty_dirs: s_(&empty_dirs), uninstaller: uninstaller.map(|u| u.to_string_lossy().to_string()).unwrap_or_default() };
    let base = std::env::temp_dir().join(format!("callio-uninstall-{}", std::process::id()));
    let (script, json) = (base.with_extension("ps1"), base.with_extension("json"));
    std::fs::write(&json, serde_json::to_vec(&plan).map_err(|e| e.to_string())?).map_err(|e| format!("Couldn't write the clean-up list: {e}"))?;
    let s = r#"$ErrorActionPreference='SilentlyContinue'
$plan = Get-Content -LiteralPath ([IO.Path]::ChangeExtension($PSCommandPath, 'json')) -Raw -Encoding UTF8 | ConvertFrom-Json
# WebView2 processes started by this Callio (not other running copies)
$web = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.ParentProcessId -eq $plan.pid })
Wait-Process -Id $plan.pid -Timeout 90
Start-Sleep -Milliseconds 800
foreach ($w in $web) { Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $w.ProcessId } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Stop-Process -Id $w.ProcessId -Force }
foreach ($p in $plan.dirs) { for ($i = 0; $i -lt 15 -and (Test-Path -LiteralPath $p); $i++) { Remove-Item -LiteralPath $p -Recurse -Force; if (Test-Path -LiteralPath $p) { Start-Sleep -Seconds 1 } } }
if ($plan.uninstaller -and (Test-Path -LiteralPath $plan.uninstaller)) { Start-Process -FilePath $plan.uninstaller -ArgumentList '/S' -Wait }
foreach ($p in $plan.files) { for ($i = 0; $i -lt 10 -and (Test-Path -LiteralPath $p); $i++) { Remove-Item -LiteralPath $p -Force; if (Test-Path -LiteralPath $p) { Start-Sleep -Seconds 1 } } }
foreach ($p in $plan.emptyDirs) { if ((Test-Path -LiteralPath $p) -and -not (Get-ChildItem -LiteralPath $p -Force)) { Remove-Item -LiteralPath $p -Force } }
Get-ChildItem -LiteralPath $env:TEMP -Filter 'callio-export-*' | Remove-Item -Recurse -Force
Remove-Item -LiteralPath ([IO.Path]::ChangeExtension($PSCommandPath, 'json')) -Force
Remove-Item -LiteralPath $PSCommandPath -Force
"#
    .replace('\n', "\r\n");
    let mut bytes = vec![0xEF, 0xBB, 0xBF]; // UTF-8 BOM for Windows PowerShell 5
    bytes.extend_from_slice(s.as_bytes());
    std::fs::write(&script, bytes).map_err(|e| format!("Couldn't write the clean-up script: {e}"))?;
    imp::run_hidden_ps(&script).map_err(|e| format!("Couldn't start the clean-up: {e}"))?;
    app.exit(0);
    Ok(())
}

// ---------------------------------------------------------------- platform

#[cfg(not(windows))]
mod imp {
    use std::path::{Path, PathBuf};
    pub fn wait_pid(_pid: u32, _ms: u32) {}
    pub fn install_dir() -> Option<PathBuf> {
        None
    }
    pub fn uninstaller() -> Option<PathBuf> {
        None
    }
    pub fn known_copies() -> Vec<PathBuf> {
        vec![]
    }
    pub fn forget_copies() {}
    pub fn delete_all_credentials() {}
    pub fn run_hidden_ps(_p: &Path) -> std::io::Result<()> {
        Err(std::io::Error::other("Uninstall is only available on Windows"))
    }
    #[allow(dead_code)]
    pub fn remember_exe() {}
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
    use windows_sys::Win32::System::Threading::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    use winreg::enums::*;
    use winreg::RegKey;

    const UNINSTALL_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Callio";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn msgbox(text: &str, flags: u32) -> i32 {
        let (t, c) = (wide(text), wide("Callio"));
        unsafe { MessageBoxW(std::ptr::null_mut(), t.as_ptr(), c.as_ptr(), flags | MB_SETFOREGROUND | MB_TOPMOST) }
    }

    pub fn wait_pid(pid: u32, ms: u32) {
        unsafe {
            let h = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if !h.is_null() {
                WaitForSingleObject(h, ms);
                CloseHandle(h);
            }
        }
    }

    fn terminate(pid: u32) {
        unsafe {
            let h = OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid);
            if !h.is_null() {
                TerminateProcess(h, 1);
                WaitForSingleObject(h, 5000);
                CloseHandle(h);
            }
        }
    }

    fn alive(pid: u32) -> bool {
        unsafe {
            let h = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if h.is_null() {
                return false;
            }
            let r = WaitForSingleObject(h, 0);
            CloseHandle(h);
            r == WAIT_TIMEOUT
        }
    }

    fn image_path(pid: u32) -> Option<PathBuf> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let mut buf = vec![0u16; 32768];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
            CloseHandle(h);
            (ok != 0).then(|| PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
        }
    }

    /// Other running processes with our file name: (pid, path).
    fn running_copies() -> Vec<(u32, PathBuf)> {
        let me = std::process::id();
        let my_name = std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase())).unwrap_or_default();
        let mut out = vec![];
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return out;
            }
            let mut e: PROCESSENTRY32W = std::mem::zeroed();
            e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut e);
            while ok != 0 {
                let n = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                let name = String::from_utf16_lossy(&e.szExeFile[..n]).to_lowercase();
                if e.th32ProcessID != me && (name == my_name || name == "callio.exe") {
                    if let Some(p) = image_path(e.th32ProcessID) {
                        out.push((e.th32ProcessID, p));
                    }
                }
                ok = Process32NextW(snap, &mut e);
            }
            CloseHandle(snap);
        }
        out
    }

    unsafe extern "system" fn close_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == lparam as u32 && IsWindowVisible(hwnd) != 0 {
            PostMessageW(hwnd, WM_CLOSE, 0, 0);
        }
        1
    }

    fn ask_to_close(pid: u32) {
        unsafe {
            EnumWindows(Some(close_cb), pid as LPARAM);
        }
    }

    fn reg_cmd_exe(v: &str) -> Option<PathBuf> {
        let v = v.trim();
        let p = if let Some(r) = v.strip_prefix('"') { r.split('"').next()? } else { v.split(' ').next()? };
        (!p.is_empty()).then(|| PathBuf::from(p))
    }

    pub fn install_dir() -> Option<PathBuf> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let k = hkcu.open_subkey(UNINSTALL_KEY).ok()?;
        if let Ok(d) = k.get_value::<String, _>("InstallLocation") {
            let d = d.trim().trim_matches('"');
            if !d.is_empty() {
                return Some(PathBuf::from(d));
            }
        }
        uninstaller().and_then(|u| u.parent().map(|p| p.to_path_buf()))
    }

    pub fn uninstaller() -> Option<PathBuf> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let k = hkcu.open_subkey(UNINSTALL_KEY).ok()?;
        let s: String = k.get_value("UninstallString").ok()?;
        reg_cmd_exe(&s).filter(|p| p.exists())
    }

    /// Callio exes this user ran before: our own record plus what older versions registered.
    pub fn known_copies() -> Vec<PathBuf> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let mut v: Vec<PathBuf> = vec![];
        if let Ok(k) = hkcu.open_subkey("Software\\Callio\\Copies") {
            for (name, _) in k.enum_values().flatten() {
                v.push(PathBuf::from(name));
            }
        }
        for key in ["Software\\Classes\\Applications\\Callio.exe\\shell\\open\\command", "Software\\Classes\\Callio.PDF\\shell\\open\\command", "Software\\Classes\\Callio.Markdown\\shell\\open\\command"] {
            if let Ok(k) = hkcu.open_subkey(key) {
                if let Some(p) = k.get_value::<String, _>("").ok().and_then(|s| reg_cmd_exe(&s)) {
                    v.push(p);
                }
            }
        }
        let mut seen = std::collections::HashSet::new();
        v.retain(|p| seen.insert(p.to_string_lossy().to_lowercase()));
        v
    }

    pub fn remember_exe() {
        if let Ok(exe) = std::env::current_exe() {
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            if let Ok((k, _)) = hkcu.create_subkey("Software\\Callio\\Copies") {
                let _ = k.set_value(exe.to_string_lossy().as_ref(), &VERSION);
            }
        }
    }

    pub fn forget_copies() {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let _ = hkcu.delete_subkey_all("Software\\Callio");
    }

    fn skipped(p: &Path) -> bool {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        hkcu.open_subkey("Software\\Callio\\KeepOld").and_then(|k| k.get_value::<String, _>(p.to_string_lossy().as_ref())).is_ok()
    }
    fn skip(p: &Path) {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok((k, _)) = hkcu.create_subkey("Software\\Callio\\KeepOld") {
            let _ = k.set_value(p.to_string_lossy().as_ref(), &"1");
        }
    }

    /// Copy this exe (and its WebView2 loader) over an older copy. Atomic per file:
    /// write next to it, move the old one aside, move the new one in.
    fn replace_copy(old: &Path) -> std::io::Result<()> {
        let me = std::env::current_exe()?;
        let (src_dir, dst_dir) = (me.parent().unwrap().to_path_buf(), old.parent().unwrap().to_path_buf());
        let mut pairs = vec![(me.clone(), old.to_path_buf())];
        for f in ["WebView2Loader.dll", "callio-office.exe", "drawio.zip", "READ-ME.txt"] {
            if src_dir.join(f).exists() {
                pairs.push((src_dir.join(f), dst_dir.join(f)));
            }
        }
        for (src, dst) in pairs {
            let tmp = dst.with_extension("new");
            std::fs::copy(&src, &tmp)?;
            let aside = dst.with_extension("old");
            let _ = std::fs::remove_file(&aside);
            if dst.exists() {
                std::fs::rename(&dst, &aside)?;
            }
            if let Err(e) = std::fs::rename(&tmp, &dst) {
                let _ = std::fs::rename(&aside, &dst);
                return Err(e);
            }
            let _ = std::fs::remove_file(&aside); // a still-mapped dll can't be removed: harmless
        }
        Ok(())
    }

    pub fn takeover(args: &[String]) -> bool {
        let Ok(me) = std::env::current_exe() else { return true };
        let my_dir_installed = install_dir().map(|d| me.starts_with(&d)).unwrap_or(false);

        let running = running_copies();
        // this very exe already runs: a second launch (a double-clicked file) — just hand it over
        if running.iter().any(|(_, p)| same_path(p, &me)) {
            return true;
        }
        // (1) an older copy is running: the single-instance lock would send us to it
        let old_running: Vec<(u32, PathBuf, String)> = running
            .into_iter()
            .filter(|(_, p)| !same_path(p, &me))
            .filter_map(|(pid, p)| exe_version(&p).filter(|v| newer(VERSION, v)).map(|v| (pid, p, v)))
            .collect();
        if let Some((_, path, v)) = old_running.first() {
            let r = msgbox(
                &format!("An older Callio ({v}) is still running from:\n{}\n\nClose it and start Callio {VERSION} instead?\nIt will ask about any unsaved changes first.", path.display()),
                MB_YESNO | MB_ICONQUESTION,
            );
            if r != IDYES {
                return true; // the launch goes to the old window, as before
            }
            for (pid, _, _) in &old_running {
                ask_to_close(*pid);
            }
            loop {
                let t = std::time::Instant::now();
                while t.elapsed().as_secs() < 30 && old_running.iter().any(|(p, _, _)| alive(*p)) {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                if !old_running.iter().any(|(p, _, _)| alive(*p)) {
                    break;
                }
                let r = msgbox(
                    "The older Callio hasn't closed yet (it may be waiting for you to save a file).\n\nYes: wait for it again\nNo: force it to close (unsaved changes in it are lost)\nCancel: don't start the new version now",
                    MB_YESNOCANCEL | MB_ICONWARNING,
                );
                if r == IDNO {
                    for (pid, _, _) in &old_running {
                        terminate(*pid);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(800));
                    break;
                }
                if r != IDYES {
                    return false;
                }
                for (pid, _, _) in &old_running {
                    ask_to_close(*pid);
                }
            }
        }

        // (2) an older copy elsewhere: offer to update it in place, once per path
        if !my_dir_installed {
            let inst = install_dir();
            let olds: Vec<(PathBuf, String)> = known_copies()
                .into_iter()
                .filter(|p| p.exists() && !same_path(p, &me) && !skipped(p))
                .filter(|p| !inst.as_ref().map(|d| p.starts_with(d)).unwrap_or(false))
                .filter_map(|p| exe_version(&p).filter(|v| newer(VERSION, v)).map(|v| (p, v)))
                .collect();
            if let Some((old, v)) = olds.first() {
                let r = msgbox(
                    &format!(
                        "Found an older portable Callio ({v}) at:\n{}\n\nYes: update that copy to {VERSION} (your shortcuts and \"Open with\" keep working) and start it.\nNo: keep the old copy and use this one from here.",
                        old.display()
                    ),
                    MB_YESNO | MB_ICONQUESTION,
                );
                if r == IDYES {
                    match replace_copy(old) {
                        Ok(()) => {
                            let mut cmd = std::process::Command::new(old);
                            cmd.args(args.iter().skip(1).filter(|a| !a.starts_with("--wait-pid=")));
                            if cmd.spawn().is_ok() {
                                return false;
                            }
                        }
                        Err(e) => {
                            msgbox(&format!("Couldn't update the old copy: {e}\n\nCallio {VERSION} will run from here instead."), MB_OK | MB_ICONWARNING);
                            skip(old);
                        }
                    }
                } else {
                    skip(old);
                }
            }
        }
        remember_exe();
        true
    }

    pub fn delete_all_credentials() {
        use windows_sys::Win32::Security::Credentials::*;
        unsafe {
            let filter = wide("*.Callio");
            let mut count = 0u32;
            let mut list: *mut *mut CREDENTIALW = std::ptr::null_mut();
            if CredEnumerateW(filter.as_ptr(), 0, &mut count, &mut list) == 0 {
                return;
            }
            let mut names = vec![];
            for i in 0..count as usize {
                let c = *list.add(i);
                if c.is_null() || (*c).TargetName.is_null() {
                    continue;
                }
                let mut n = 0;
                while *(*c).TargetName.add(n) != 0 {
                    n += 1;
                }
                let name = std::slice::from_raw_parts((*c).TargetName, n).to_vec();
                names.push(((*c).Type, name));
            }
            CredFree(list as *const _);
            for (ty, mut n) in names {
                n.push(0);
                CredDeleteW(n.as_ptr(), ty, 0);
            }
        }
    }

    pub fn run_hidden_ps(script: &Path) -> std::io::Result<()> {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File"])
            .arg(script)
            .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
            .spawn()
            .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions() {
        assert!(newer("0.5.0", "0.4.0"));
        assert!(newer("0.10.0", "0.9.9"));
        assert!(!newer("0.4.0", "0.4.0"));
        assert!(!newer("0.4", "0.4.0.0"));
        assert!(newer("1.0.0.1", "1.0"));
        let mut data = b"junk".to_vec();
        for c in "ProductVersion\0".encode_utf16() {
            data.extend(c.to_le_bytes());
        }
        data.extend([0, 0]);
        for c in "0.4.0\0".encode_utf16() {
            data.extend(c.to_le_bytes());
        }
        assert_eq!(exe_version_bytes(&data).as_deref(), Some("0.4.0"));
    }
}
