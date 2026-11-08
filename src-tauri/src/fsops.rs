use crate::util::{CmdResult, ErrStr};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::ipc::Response;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    text: String,
    mtime: u64,
    /// "utf8", "utf8bom", "utf16le", "utf16be" or an encoding label ("windows-1258"…) — passed
    /// back on save to keep the file's encoding
    encoding: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

fn mtime(p: &Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The Windows "ANSI" code page as an encoding label (windows-1252 on most Western systems,
/// windows-1258 on Vietnamese ones…).
pub fn ansi_label() -> &'static str {
    #[cfg(windows)]
    {
        extern "system" {
            fn GetACP() -> u32;
        }
        let cp = unsafe { GetACP() };
        return match cp {
            874 => "windows-874",
            932 => "shift_jis",
            936 => "gbk",
            949 => "euc-kr",
            950 => "big5",
            1250 => "windows-1250",
            1251 => "windows-1251",
            1253 => "windows-1253",
            1254 => "windows-1254",
            1255 => "windows-1255",
            1256 => "windows-1256",
            1257 => "windows-1257",
            1258 => "windows-1258",
            _ => "windows-1252",
        };
    }
    #[allow(unreachable_code)]
    "windows-1252"
}

#[tauri::command]
pub fn system_ansi() -> String {
    ansi_label().to_string()
}

/// Bytes → text. `encoding`: "utf8", "utf8bom", "utf16le", "utf16be" or any WHATWG label
/// ("windows-1258", "shift_jis"…); None: detect (BOM, else UTF-8, else the ANSI code page).
pub fn decode_bytes(bytes: &[u8], encoding: Option<&str>) -> (String, String) {
    let enc = match encoding {
        Some(e) if !e.is_empty() => e.to_string(),
        _ => {
            if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
                "utf8bom".into()
            } else if bytes.starts_with(&[0xFF, 0xFE]) {
                "utf16le".into()
            } else if bytes.starts_with(&[0xFE, 0xFF]) {
                "utf16be".into()
            } else if std::str::from_utf8(bytes).is_ok() {
                "utf8".into()
            } else {
                ansi_label().into()
            }
        }
    };
    let text = match enc.as_str() {
        "utf8" | "utf8bom" => {
            let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
            String::from_utf8_lossy(b).into_owned()
        }
        "utf16le" | "utf16be" => {
            let le = enc == "utf16le";
            let b = if bytes.starts_with(if le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] }) { &bytes[2..] } else { bytes };
            let units: Vec<u16> = b.chunks_exact(2).map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) }).collect();
            String::from_utf16_lossy(&units)
        }
        "latin1" => bytes.iter().map(|&c| c as char).collect(),
        label => {
            let e = encoding_rs::Encoding::for_label(label.as_bytes()).unwrap_or(encoding_rs::WINDOWS_1252);
            e.decode_without_bom_handling(bytes).0.into_owned()
        }
    };
    (text, enc)
}

/// Text → bytes in `encoding` (see decode_bytes). Err names a character the encoding can't hold.
pub fn encode_text(text: &str, encoding: Option<&str>) -> Result<Vec<u8>, String> {
    Ok(match encoding.unwrap_or("utf8") {
        "utf8" | "" => text.as_bytes().to_vec(),
        "utf8bom" => [&[0xEF, 0xBB, 0xBF][..], text.as_bytes()].concat(),
        "utf16le" => [0xFF, 0xFE].into_iter().chain(text.encode_utf16().flat_map(|u| u.to_le_bytes())).collect(),
        "utf16be" => [0xFE, 0xFF].into_iter().chain(text.encode_utf16().flat_map(|u| u.to_be_bytes())).collect(),
        "latin1" => {
            if let Some(c) = text.chars().find(|c| (*c as u32) > 255) {
                return Err(format!("UNMAPPABLE:{c}"));
            }
            text.chars().map(|c| c as u8).collect()
        }
        label => {
            let e = encoding_rs::Encoding::for_label(label.as_bytes()).ok_or_else(|| format!("Unknown encoding {label}"))?;
            let (out, _, bad) = e.encode(text);
            if bad {
                // name the first character that doesn't fit
                let c = text.chars().find(|c| { let mut b = [0u8; 4]; e.encode(c.encode_utf8(&mut b)).2 }).unwrap_or('?');
                return Err(format!("UNMAPPABLE:{c}"));
            }
            out.into_owned()
        }
    })
}

#[tauri::command]
pub async fn read_text(path: String, encoding: Option<String>) -> CmdResult<TextFile> {
    let p = PathBuf::from(&path);
    let bytes = std::fs::read(&p).map_err(|e| format!("{path}: {e}"))?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("File is larger than 64 MB".into());
    }
    let (text, encoding) = decode_bytes(&bytes, encoding.as_deref());
    Ok(TextFile { text, mtime: mtime(&p), encoding })
}

#[tauri::command]
pub async fn write_text(path: String, text: String, encoding: Option<String>, expected_mtime: Option<u64>) -> CmdResult<u64> {
    let p = PathBuf::from(&path);
    // Refuse to clobber a file another program (or a sync) changed since we loaded it.
    if let Some(exp) = expected_mtime.filter(|m| *m > 0) {
        let cur = mtime(&p);
        if cur != 0 && cur != exp {
            return Err("CHANGED_ON_DISK".into());
        }
    }
    let bytes = encode_text(&text, encoding.as_deref())?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).es()?;
    }
    // Write a sibling temp file, flush it to disk, then rename over the original, so a crash
    // or power cut never leaves a half-written file.
    let tmp = p.with_file_name(format!(".{}.callio-tmp", p.file_name().and_then(|n| n.to_str()).unwrap_or("file")));
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("{path}: {e}"))?;
        f.write_all(&bytes).map_err(|e| format!("{path}: {e}"))?;
        f.sync_all().map_err(|e| format!("{path}: {e}"))?;
    }
    if let Err(e) = std::fs::rename(&tmp, &p) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("{path}: {e} (is the file open in another program?)"));
    }
    Ok(mtime(&p))
}

const HIDDEN_DIRS: &[&str] = &[".git", ".callio", ".proemia", ".quire", "node_modules", "__pycache__", ".vscode", ".idea", "_minted", "svg-inkscape"];
const JUNK_EXT: &[&str] = &["aux", "fls", "fdb_latexmk", "synctex.gz", "out", "toc", "lof", "lot", "blg", "bcf", "run.xml", "xdv", "nav", "snm", "vrb", "callio-tmp", "proemia-tmp", "quire-tmp"];

pub fn is_junk(name: &str) -> bool {
    let l = name.to_lowercase();
    JUNK_EXT.iter().any(|e| l.ends_with(&format!(".{e}"))) || l.ends_with(".synctex(busy)")
}

#[tauri::command]
pub async fn list_dir(path: String) -> CmdResult<Vec<DirEntry>> {
    let mut v = Vec::new();
    for e in std::fs::read_dir(&path).es()?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir && (HIDDEN_DIRS.contains(&name.as_str()) || name.starts_with('.')) {
            continue;
        }
        if !is_dir && (name.starts_with('.') || is_junk(&name) || name.ends_with('~')) {
            continue;
        }
        v.push(DirEntry { path: e.path().to_string_lossy().to_string(), name, is_dir });
    }
    Ok(v)
}

fn unhex(s: &str) -> Option<String> {
    if s.len() % 2 != 0 {
        return None;
    }
    let b: Option<Vec<u8>> = (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect();
    String::from_utf8(b?).ok()
}

/// Saves bytes (an edited PDF). The previous file is copied to the app's backups first, and
/// a file changed on disk since it was opened is not overwritten.
#[tauri::command]
pub async fn write_binary(app: AppHandle, request: tauri::ipc::Request<'_>) -> CmdResult<u64> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else { return Err("Expected file bytes".into()) };
    let h = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let path = h("x-path").and_then(|v| unhex(&v)).ok_or("Missing path")?;
    let expected: u64 = h("x-mtime").and_then(|v| v.parse().ok()).unwrap_or(0);
    let p = PathBuf::from(&path);
    if expected > 0 {
        let cur = mtime(&p);
        if cur != 0 && cur != expected {
            return Err("CHANGED_ON_DISK".into());
        }
    }
    let backup = h("x-backup").map(|v| v != "0").unwrap_or(true);
    if p.exists() && backup {
        let dir = crate::settings::data_dir(&app).join("pdf-backups");
        let _ = std::fs::create_dir_all(&dir);
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        // keep 30 days of backups
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                if e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|a| a.as_secs() > 30 * 86400).unwrap_or(false) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file.pdf".into());
        std::fs::copy(&p, dir.join(format!("{now}-{name}"))).map_err(|e| format!("Couldn't back up the original first: {e}"))?;
    }
    // a missing folder is made only one level deep (the "<name>_files" folder of an export)
    if let Some(dir) = p.parent() {
        if !dir.exists() && dir.parent().map(|g| g.is_dir()).unwrap_or(false) {
            std::fs::create_dir(dir).es()?;
        }
    }
    let tmp = p.with_file_name(format!(".{}.callio-tmp", p.file_name().and_then(|n| n.to_str()).unwrap_or("file")));
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("{path}: {e}"))?;
        f.write_all(data).map_err(|e| format!("{path}: {e}"))?;
        f.sync_all().map_err(|e| format!("{path}: {e}"))?;
    }
    if let Err(e) = std::fs::rename(&tmp, &p) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("{path}: {e} (is the file open in another program?)"));
    }
    Ok(mtime(&p))
}

/// Renames a file or folder within its folder. Never replaces an existing file.
#[tauri::command]
pub async fn rename_path(from: String, name: String, root: String) -> CmdResult<String> {
    let src = PathBuf::from(&from);
    // only inside the folder that is open in the file list, and never a link
    let canon = |p: &Path| std::fs::canonicalize(p).map(|c| crate::util::path_key(&c.to_string_lossy())).unwrap_or_default();
    let (src_k, root_k) = (canon(&src), canon(Path::new(&root)));
    if root_k.is_empty() || src_k.is_empty() || src_k == root_k || !src_k.starts_with(&format!("{}/", root_k.trim_end_matches('/'))) {
        return Err("Only files inside the open folder can be renamed here".into());
    }
    if std::fs::symlink_metadata(&src).map(|m| m.file_type().is_symlink()).unwrap_or(true) {
        return Err("Links can't be renamed here".into());
    }
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) || name.ends_with('.') || name.ends_with(' ') {
        return Err("That name isn't allowed in Windows file names".into());
    }
    let dst = src.parent().ok_or("No parent folder")?.join(name);
    if dst == src {
        return Ok(from);
    }
    // a case-only change on Windows is the same file: allowed
    let case_only = dst.to_string_lossy().to_lowercase() == src.to_string_lossy().to_lowercase();
    if dst.exists() && !case_only {
        return Err(format!("{name} already exists here"));
    }
    std::fs::rename(&src, &dst).map_err(|e| format!("Couldn't rename: {e}"))?;
    Ok(dst.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn file_mtime(path: String) -> u64 {
    mtime(Path::new(&path))
}

#[tauri::command]
pub async fn read_binary(path: String) -> CmdResult<Response> {
    let b = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    Ok(Response::new(b))
}

#[tauri::command]
pub async fn pick_open_file(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .add_filter("Documents", &["md", "markdown", "tex", "bib", "sty", "cls", "ltx", "txt", "pdf", "docx", "doc", "odt", "rtf", "xlsx", "xlsm", "xls", "xlsb", "ods", "csv", "tsv", "pptx", "ppsx", "potx", "odp", "ipynb", "json", "jsonc", "xml", "yaml", "yml"])
        .add_filter("Pictures and photos", &["jpg", "jpeg", "png", "tif", "tiff", "webp", "avif", "heic", "heif", "jxl", "bmp", "gif", "psd", "dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2", "pef", "srw"])
        .add_filter("Data (JSON, XML, YAML, CSV)", &["json", "jsonc", "json5", "jsonl", "geojson", "xml", "svg", "xsd", "yaml", "yml", "csv", "tsv"])
        .add_filter("Word documents", &["docx", "docm", "dotx", "doc", "odt", "rtf"])
        .add_filter("Spreadsheets", &["xlsx", "xlsm", "xls", "xlsb", "ods", "csv", "tsv"])
        .add_filter("Presentations", &["pptx", "pptm", "ppsx", "potx", "odp"])
        .add_filter("PDF", &["pdf"])
        .add_filter("All files", &["*"])
        .blocking_pick_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn pick_convert_file(app: AppHandle, dir: Option<String>) -> Option<String> {
    let mut d = app
        .dialog()
        .file()
        .add_filter("Documents", &["pdf", "docx", "docm", "dotx", "doc", "rtf", "xlsx", "xlsm", "xls", "xlsb", "pptx", "pptm", "odt", "ods", "odp", "html", "htm", "csv", "tsv", "ipynb", "tex", "txt", "png", "jpg", "jpeg", "bmp", "webp", "gif", "tif", "tiff"])
        .add_filter("All files", &["*"]);
    if let Some(dir) = dir {
        d = d.set_directory(dir);
    }
    d.blocking_pick_file().and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn pick_image(app: AppHandle, dir: Option<String>) -> Option<String> {
    let mut d = app.dialog().file().add_filter("Images", &["png", "jpg", "jpeg", "gif", "svg", "webp", "pdf", "eps"]).add_filter("All files", &["*"]);
    if let Some(dir) = dir {
        d = d.set_directory(dir);
    }
    d.blocking_pick_file().and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn pick_folder(app: AppHandle, title: Option<String>) -> Option<String> {
    let mut d = app.dialog().file();
    if let Some(t) = title {
        d = d.set_title(t);
    }
    d.blocking_pick_folder().and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn pick_save_file(app: AppHandle, default_name: String, dir: Option<String>) -> Option<String> {
    let mut d = app.dialog().file().set_file_name(&default_name);
    if let Some(dir) = dir {
        d = d.set_directory(dir);
    }
    if default_name.ends_with(".tex") {
        d = d.add_filter("LaTeX", &["tex"]);
    } else if default_name.ends_with(".md") {
        d = d.add_filter("Markdown", &["md"]);
    } else if default_name.ends_with(".pdf") {
        d = d.add_filter("PDF", &["pdf"]);
    } else if default_name.ends_with(".bib") {
        d = d.add_filter("BibTeX", &["bib"]);
    }
    d.add_filter("All files", &["*"])
        .blocking_save_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> CmdResult<()> {
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:") || url.starts_with("ms-settings:")) {
        return Err("Only web links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).es()
}

#[tauri::command]
pub fn open_path(app: AppHandle, path: String) -> CmdResult<()> {
    // Never "open" executables or scripts from a document link.
    let lower = path.to_lowercase();
    const RISKY: &[&str] = &[".exe", ".bat", ".cmd", ".com", ".ps1", ".vbs", ".js", ".jse", ".wsf", ".msi", ".scr", ".lnk", ".hta", ".cpl", ".reg"];
    if RISKY.iter().any(|e| lower.ends_with(e)) {
        return app.opener().reveal_item_in_dir(&path).es();
    }
    app.opener().open_path(path, None::<&str>).es()
}

#[tauri::command]
pub fn reveal_path(app: AppHandle, path: String) -> CmdResult<()> {
    app.opener().reveal_item_in_dir(path).es()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    settings_path: String,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        settings_path: crate::settings::config_dir(&app).join("settings.json").to_string_lossy().to_string(),
    }
}

#[tauri::command]
pub fn set_title(app: AppHandle, title: String) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_title(&title);
    }
}

/// Paths given on the command line (double-click / Open with).
pub fn paths_from_args(args: &[String], cwd: &Path) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(a);
            let p = if p.is_absolute() { p } else { cwd.join(p) };
            crate::util::clean(&p).to_string_lossy().to_string()
        })
        .filter(|p| Path::new(p).is_file())
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInfo {
    exists: bool,
    is_dir: bool,
    size: u64,
    mtime: u64,
}

#[tauri::command]
pub fn path_info(path: String) -> PathInfo {
    let p = PathBuf::from(&path);
    match std::fs::metadata(&p) {
        Ok(m) => PathInfo { exists: true, is_dir: m.is_dir(), size: m.len(), mtime: mtime(&p) },
        Err(_) => PathInfo { exists: false, is_dir: false, size: 0, mtime: 0 },
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirDiff {
    rel: String,
    /// "same", "changed", "left" (only in the first folder), "right" (only in the second)
    state: &'static str,
    size_a: u64,
    size_b: u64,
}

fn walk_files(root: &Path, dir: &Path, out: &mut std::collections::BTreeMap<String, u64>, skip_hidden: bool) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if out.len() > 50_000 {
            return;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if skip_hidden && HIDDEN_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk_files(root, &p, out, skip_hidden);
        } else if ft.is_file() {
            let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
            out.insert(rel, e.metadata().map(|m| m.len()).unwrap_or(0));
        }
    }
}

fn same_bytes(a: &Path, b: &Path) -> bool {
    use std::io::Read;
    let (Ok(mut fa), Ok(mut fb)) = (std::fs::File::open(a), std::fs::File::open(b)) else { return false };
    let mut ba = vec![0u8; 1 << 16];
    let mut bb = vec![0u8; 1 << 16];
    loop {
        let na = match fa.read(&mut ba) { Ok(n) => n, Err(_) => return false };
        let mut got = 0;
        while got < na {
            match fb.read(&mut bb[got..na]) { Ok(0) => return false, Ok(n) => got += n, Err(_) => return false }
        }
        if na == 0 {
            return fb.read(&mut bb[..1]).map(|n| n == 0).unwrap_or(false);
        }
        if ba[..na] != bb[..na] {
            return false;
        }
    }
}

/// Compare two folders file by file (contents, not dates). `.git`, `node_modules`… are skipped.
#[tauri::command]
pub async fn compare_dirs(a: String, b: String) -> CmdResult<Vec<DirDiff>> {
    tauri::async_runtime::spawn_blocking(move || {
        let (ra, rb) = (PathBuf::from(&a), PathBuf::from(&b));
        let mut fa = std::collections::BTreeMap::new();
        let mut fb = std::collections::BTreeMap::new();
        walk_files(&ra, &ra, &mut fa, true);
        walk_files(&rb, &rb, &mut fb, true);
        let mut keys: Vec<&String> = fa.keys().chain(fb.keys()).collect();
        keys.sort();
        keys.dedup();
        let mut out = vec![];
        for k in keys {
            let (sa, sb) = (fa.get(k), fb.get(k));
            let state = match (sa, sb) {
                (Some(_), None) => "left",
                (None, Some(_)) => "right",
                (Some(x), Some(y)) if x != y => "changed",
                _ => if same_bytes(&ra.join(k), &rb.join(k)) { "same" } else { "changed" },
            };
            out.push(DirDiff { rel: k.clone(), state, size_a: sa.copied().unwrap_or(0), size_b: sb.copied().unwrap_or(0) });
        }
        Ok(out)
    })
    .await
    .es()?
}
