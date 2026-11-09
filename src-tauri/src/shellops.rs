//! Things handed to Windows: printing a file with its own app, starting a program the author
//! confirmed, and extracting an archive with an extractor installed on this PC (or Windows' own
//! tar). Callio never reads an archive or a program as text.
use crate::util::CmdResult;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[cfg(windows)]
fn shell_execute(verb: &str, file: &str, params: Option<&str>, dir: Option<&str>) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let w = |s: &str| std::ffi::OsStr::new(s).encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    let (v, f) = (w(verb), w(file));
    let p = params.map(w);
    let d = dir.map(w);
    let r = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            v.as_ptr(),
            f.as_ptr(),
            p.as_ref().map(|x| x.as_ptr()).unwrap_or(std::ptr::null()),
            d.as_ref().map(|x| x.as_ptr()).unwrap_or(std::ptr::null()),
            SW_SHOWNORMAL,
        )
    } as isize;
    if r > 32 {
        Ok(())
    } else if r == 31 {
        Err(format!("Windows has no app set up to {verb} this kind of file"))
    } else {
        Err(format!("Windows couldn't {verb} it (error {r})"))
    }
}
#[cfg(not(windows))]
fn shell_execute(verb: &str, file: &str, _params: Option<&str>, _dir: Option<&str>) -> Result<(), String> {
    Err(format!("Can't {verb} {file} on this system"))
}

/// Print a saved file with the app Windows uses for it.
#[tauri::command]
pub fn print_file(path: String) -> CmdResult<()> {
    if !Path::new(&path).is_file() {
        return Err("Save the file first".into());
    }
    shell_execute("print", &path, None, None)
}

/// Start a program (.exe, .msi, .bat…) the author confirmed, outside Callio.
#[tauri::command]
pub fn launch_program(path: String) -> CmdResult<()> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err(format!("{path} doesn't exist"));
    }
    let dir = p.parent().map(|d| d.to_string_lossy().to_string());
    shell_execute("open", &path, None, dir.as_deref())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Extractor {
    /// "7zip" | "winrar" | "bandizip" | "peazip" | "nanazip" | "tar" | "explorer"
    id: String,
    name: String,
    exe: String,
    /// extracts by itself into a folder (vs. opens its window on the archive)
    direct: bool,
}

#[cfg(windows)]
fn reg_str(root: winreg::HKEY, key: &str, val: &str) -> Option<String> {
    winreg::RegKey::predef(root).open_subkey(key).ok()?.get_value::<String, _>(val).ok().filter(|s| !s.is_empty())
}

#[cfg(windows)]
fn find(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| p.is_file()).cloned()
}

/// The extractors installed on this PC (newest first: what the author most likely uses).
#[tauri::command]
pub fn list_extractors() -> Vec<Extractor> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
        let pf: Vec<PathBuf> = ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"].iter().filter_map(|v| std::env::var(v).ok()).map(PathBuf::from).collect();
        let local = std::env::var("LOCALAPPDATA").map(PathBuf::from).ok();
        let app_path = |exe: &str| -> Option<PathBuf> {
            let k = format!("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{exe}");
            reg_str(HKEY_LOCAL_MACHINE, &k, "").or_else(|| reg_str(HKEY_CURRENT_USER, &k, "")).map(|s| PathBuf::from(s.trim_matches('"')))
        };
        let in_pf = |rel: &str| -> Vec<PathBuf> { pf.iter().map(|p| p.join(rel)).collect() };
        // 7-Zip
        let mut c: Vec<PathBuf> = vec![];
        for k in ["SOFTWARE\\7-Zip"] {
            for v in ["Path64", "Path"] {
                if let Some(p) = reg_str(HKEY_LOCAL_MACHINE, k, v).or_else(|| reg_str(HKEY_CURRENT_USER, k, v)) {
                    c.push(PathBuf::from(p).join("7zG.exe"));
                }
            }
        }
        c.extend(in_pf("7-Zip\\7zG.exe"));
        if let Some(p) = app_path("7zFM.exe") {
            c.push(p.with_file_name("7zG.exe"));
        }
        if let Some(p) = find(&c) {
            out.push(Extractor { id: "7zip".into(), name: "7-Zip".into(), exe: p.to_string_lossy().into(), direct: true });
        }
        // WinRAR
        let mut c: Vec<PathBuf> = vec![];
        for v in ["exe64", "exe32"] {
            if let Some(p) = reg_str(HKEY_LOCAL_MACHINE, "SOFTWARE\\WinRAR", v) {
                c.push(PathBuf::from(p));
            }
        }
        c.extend(in_pf("WinRAR\\WinRAR.exe"));
        if let Some(p) = app_path("WinRAR.exe") {
            c.push(p);
        }
        if let Some(p) = find(&c) {
            out.push(Extractor { id: "winrar".into(), name: "WinRAR".into(), exe: p.to_string_lossy().into(), direct: true });
        }
        // Bandizip
        let mut c = in_pf("Bandizip\\Bandizip.exe");
        if let Some(l) = &local {
            c.push(l.join("Programs\\Bandizip\\Bandizip.exe"));
        }
        if let Some(p) = app_path("Bandizip.exe") {
            c.push(p);
        }
        if let Some(p) = find(&c) {
            out.push(Extractor { id: "bandizip".into(), name: "Bandizip".into(), exe: p.to_string_lossy().into(), direct: true });
        }
        // PeaZip
        let mut c = in_pf("PeaZip\\peazip.exe");
        if let Some(p) = app_path("peazip.exe") {
            c.push(p);
        }
        if let Some(p) = find(&c) {
            out.push(Extractor { id: "peazip".into(), name: "PeaZip".into(), exe: p.to_string_lossy().into(), direct: true });
        }
        // NanaZip (Microsoft Store): its command-line alias
        if let Some(l) = &local {
            let p = l.join("Microsoft\\WindowsApps\\NanaZipG.exe");
            if p.is_file() {
                out.push(Extractor { id: "nanazip".into(), name: "NanaZip".into(), exe: p.to_string_lossy().into(), direct: true });
            }
        }
        // Windows' own tar (zip, tar, gz, bz2, xz, 7z, cab, iso and most rar)
        let sys = std::env::var("SystemRoot").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("C:\\Windows")).join("System32\\tar.exe");
        if sys.is_file() {
            out.push(Extractor { id: "tar".into(), name: "Windows (built in)".into(), exe: sys.to_string_lossy().into(), direct: true });
        }
        out.push(Extractor { id: "explorer".into(), name: "File Explorer (open the archive)".into(), exe: "explorer.exe".into(), direct: false });
    }
    #[cfg(not(windows))]
    {
        if Path::new("/usr/bin/tar").exists() {
            out.push(Extractor { id: "tar".into(), name: "tar".into(), exe: "/usr/bin/tar".into(), direct: true });
        }
    }
    out
}

/// A folder next to the archive, named after it ("data.zip" → "data", "data (2)" if taken).
fn target_dir(archive: &Path) -> PathBuf {
    let parent = archive.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let name = archive.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "archive".into());
    let lower = name.to_lowercase();
    let mut stem = name.clone();
    for ext in [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tgz", ".tbz2", ".txz"] {
        if lower.ends_with(ext) {
            stem = name[..name.len() - ext.len()].to_string();
            break;
        }
    }
    if stem == name {
        stem = Path::new(&name).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or(name.clone());
    }
    let mut d = parent.join(&stem);
    let mut i = 2;
    while d.exists() {
        d = parent.join(format!("{stem} ({i})"));
        i += 1;
    }
    d
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Extracted {
    /// the folder the files go to ("" when the extractor's own window decides)
    dest: String,
    /// true: finished here (Windows' tar); false: the extractor is doing it in its own window
    finished: bool,
}

/// Extract `archive` with the chosen extractor (by id, from list_extractors).
#[tauri::command]
pub async fn extract_with(archive: String, extractor: String) -> CmdResult<Extracted> {
    let a = PathBuf::from(&archive);
    if !a.is_file() {
        return Err(format!("{archive} doesn't exist"));
    }
    let ex = list_extractors().into_iter().find(|e| e.id == extractor).ok_or("That extractor isn't installed any more")?;
    let dest = target_dir(&a);
    let d = dest.to_string_lossy().to_string();
    let mut cmd = std::process::Command::new(&ex.exe);
    match ex.id.as_str() {
        "explorer" => {
            shell_execute("open", &archive, None, None)?;
            return Ok(Extracted { dest: String::new(), finished: false });
        }
        "tar" => {
            std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
            cmd.arg("-xf").arg(&archive).arg("-C").arg(&dest);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000); // no console window
            }
            let out = tauri::async_runtime::spawn_blocking(move || cmd.output()).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
            if !out.status.success() {
                let _ = std::fs::remove_dir(&dest); // only if still empty
                let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
                return Err(if msg.is_empty() { "Windows couldn't extract this archive — try another extractor".into() } else { msg });
            }
            return Ok(Extracted { dest: d, finished: true });
        }
        "7zip" | "nanazip" => {
            cmd.arg("x").arg(&archive).arg(format!("-o{d}")).arg("-y");
        }
        "winrar" => {
            cmd.arg("x").arg("-ibck").arg("-y").arg(&archive).arg(format!("{d}\\"));
        }
        "bandizip" => {
            cmd.arg("x").arg(format!("-o:{d}")).arg(&archive);
        }
        "peazip" => {
            cmd.arg("-ext2folder").arg(&archive);
            cmd.spawn().map_err(|e| e.to_string())?;
            return Ok(Extracted { dest: String::new(), finished: false });
        }
        _ => return Err("Unknown extractor".into()),
    }
    cmd.spawn().map_err(|e| format!("Couldn't start {}: {e}", ex.name))?;
    Ok(Extracted { dest: d, finished: false })
}
