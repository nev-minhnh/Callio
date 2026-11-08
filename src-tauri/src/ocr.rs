//! OCR engines, all without Python:
//! * Windows OCR — built into Windows 10/11 (Windows.Media.Ocr), nothing to download.
//! * Tesseract — downloaded on request (official installer from GitHub), languages from
//!   tesseract-ocr/tessdata_fast.
//! * Claude Code (your Claude plan), Claude API and Gemini API — the page image goes to the
//!   model, which writes Markdown.
//! Local engines return positioned lines; the window turns them into Markdown with the same
//! layout logic as PDF conversion.
use crate::engines::{download, emit, InstallState};
use crate::settings::data_dir;
use crate::util::{command, CmdResult, ErrStr};
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;

// ---------------- cancelling a running OCR job ----------------
static JOBS: std::sync::Mutex<Option<std::collections::HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>> = std::sync::Mutex::new(None);
fn job_token(id: &str) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
    let mut g = JOBS.lock().unwrap_or_else(|e| e.into_inner());
    g.get_or_insert_with(Default::default).entry(id.to_string()).or_default().clone()
}
fn job_done(id: &str) {
    if let Some(m) = JOBS.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        m.remove(id);
    }
}
#[tauri::command]
pub fn ocr_job_end(job: String) {
    job_done(&job);
}
#[tauri::command]
pub fn ocr_cancel(job: String) {
    job_token(&job).store(true, std::sync::atomic::Ordering::SeqCst);
}
/// Page images are private: their temp folder goes away however the job ends.
struct TempDir(PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrEngines {
    windows: bool,
    windows_languages: Vec<String>,
    /// why Windows OCR couldn't be used (PowerShell's message)
    windows_error: Option<String>,
    tesseract: Option<String>,
    tesseract_languages: Vec<String>,
    claude_code: bool,
    anthropic_key: bool,
    gemini_key: bool,
}

fn tess_dir(app: &AppHandle) -> PathBuf {
    data_dir(app).join("tesseract")
}
fn tessdata_dir(app: &AppHandle) -> PathBuf {
    data_dir(app).join("tessdata")
}
/// Callio's own copy first, then a normal installation.
pub fn tesseract_exe(app: &AppHandle) -> Option<PathBuf> {
    let mut c = vec![tess_dir(app).join("tesseract.exe")];
    for v in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(p) = std::env::var_os(v) {
            c.push(PathBuf::from(&p).join("Tesseract-OCR").join("tesseract.exe"));
            c.push(PathBuf::from(&p).join("Programs").join("Tesseract-OCR").join("tesseract.exe"));
        }
    }
    if !cfg!(windows) {
        c.push(PathBuf::from("/usr/bin/tesseract"));
    }
    c.into_iter().find(|p| p.is_file())
}
fn tess_langs(app: &AppHandle) -> Vec<String> {
    let mut v: Vec<String> = vec![];
    let mut dirs = vec![tessdata_dir(app)];
    if let Some(exe) = tesseract_exe(app) {
        if let Some(d) = exe.parent() {
            dirs.push(d.join("tessdata"));
        }
    }
    for d in dirs {
        if let Ok(rd) = std::fs::read_dir(d) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if let Some(l) = n.strip_suffix(".traineddata") {
                    if l != "osd" && !v.contains(&l.to_string()) {
                        v.push(l.to_string());
                    }
                }
            }
        }
    }
    v.sort();
    v
}

#[tauri::command]
pub async fn ocr_engines(app: AppHandle) -> OcrEngines {
    let win_langs = tauri::async_runtime::spawn_blocking(windows_languages).await.ok().flatten();
    OcrEngines {
        windows: win_langs.is_some(),
        windows_languages: win_langs.unwrap_or_default(),
        windows_error: if cfg!(windows) { WIN_ERR.lock().unwrap().clone() } else { None },
        tesseract: tesseract_exe(&app).map(|p| p.to_string_lossy().to_string()),
        tesseract_languages: tess_langs(&app),
        claude_code: crate::claude_code::find_claude().is_some(),
        anthropic_key: crate::settings::get_secret_value("ai-key-anthropic").is_some(),
        gemini_key: crate::settings::get_secret_value("ai-key-gemini").is_some(),
    }
}

// ---------------- Windows OCR (PowerShell + WinRT) ----------------

const WIN_OCR_PS: &str = r#"param([string]$List, [string]$Lang)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
if ($List -eq 'LANGUAGES') {
  @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) | ConvertTo-Json -Compress
  exit 0
}
if ($Lang) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($Lang)) }
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { throw 'No OCR language is installed in Windows (Settings > Time & language > Language > add a language with "Optical character recognition").' }
$out = @()
foreach ($img in (Get-Content -LiteralPath $List -Encoding UTF8)) {
  if (-not $img) { continue }
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($img)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
  $lines = @($res.Lines | ForEach-Object {
    $ws = @($_.Words | ForEach-Object { @{ t = $_.Text; x = $_.BoundingRect.X; y = $_.BoundingRect.Y; w = $_.BoundingRect.Width; h = $_.BoundingRect.Height } })
    @{ text = $_.Text; words = $ws }
  })
  $out += @{ width = $bmp.PixelWidth; height = $bmp.PixelHeight; lines = $lines }
  $stream.Dispose()
}
ConvertTo-Json -InputObject @($out) -Depth 8 -Compress
"#;

fn run_ps(script: &str, args: &[&str], secs: u64) -> Result<String> {
    run_ps_c(script, args, secs, None)
}
fn run_ps_c(script: &str, args: &[&str], secs: u64, cancel: Option<&std::sync::atomic::AtomicBool>) -> Result<String> {
    let dir = std::env::temp_dir().join(format!("callio-ocr-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    let ps1 = dir.join("winocr.ps1");
    let mut b = vec![0xEF, 0xBB, 0xBF];
    b.extend_from_slice(script.as_bytes());
    std::fs::write(&ps1, b)?;
    let mut c = command("powershell.exe");
    c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]).arg(&ps1).args(args);
    let out = crate::util::run_cancellable(c, Duration::from_secs(secs), cancel)?;
    if !out.status.success() {
        let e = String::from_utf8_lossy(&out.stderr);
        let msg = e.lines().find(|l| !l.trim().is_empty() && !l.starts_with("At ") && !l.starts_with('+')).unwrap_or("Windows OCR failed").trim();
        bail!("{msg}");
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_start_matches('\u{feff}').to_string())
}

static WIN_ERR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn windows_languages() -> Option<Vec<String>> {
    if !cfg!(windows) {
        return None;
    }
    // (a word, not "--languages": PowerShell would take that for a parameter name)
    let out = match run_ps(WIN_OCR_PS, &["LANGUAGES"], 40) {
        Ok(o) => o,
        Err(e) => {
            *WIN_ERR.lock().unwrap() = Some(e.to_string());
            return None;
        }
    };
    if out.trim().is_empty() {
        *WIN_ERR.lock().unwrap() = None;
        return Some(vec![]);
    }
    let v: Value = match serde_json::from_str(out.trim()) {
        Ok(v) => v,
        Err(_) => {
            *WIN_ERR.lock().unwrap() = Some(format!("unexpected answer from Windows: {}", out.trim().chars().take(160).collect::<String>()));
            return None;
        }
    };
    Some(match v {
        Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        Value::String(s) => vec![s],
        _ => vec![],
    }).inspect(|_| *WIN_ERR.lock().unwrap() = None)
}

// ---------------- Tesseract ----------------

/// TSV → [{width,height,lines:[{text,words:[{t,x,y,w,h}]}]}]
fn tsv_page(tsv: &str) -> Value {
    let (mut width, mut height) = (0.0, 0.0);
    let mut lines: Vec<(String, Vec<Value>)> = vec![];
    let mut key = String::new();
    for row in tsv.lines().skip(1) {
        let c: Vec<&str> = row.split('\t').collect();
        if c.len() < 12 {
            continue;
        }
        let n = |i: usize| c[i].parse::<f64>().unwrap_or(0.0);
        if c[0] == "1" {
            width = n(8);
            height = n(9);
        }
        if c[0] != "5" || c[11].trim().is_empty() || n(10) < 0.0 {
            continue;
        }
        let k = format!("{}-{}-{}-{}", c[1], c[2], c[3], c[4]);
        if k != key {
            key = k;
            lines.push((String::new(), vec![]));
        }
        let l = lines.last_mut().unwrap();
        if !l.0.is_empty() {
            l.0.push(' ');
        }
        l.0.push_str(c[11]);
        l.1.push(json!({ "t": c[11], "x": n(6), "y": n(7), "w": n(8), "h": n(9) }));
    }
    json!({ "width": width, "height": height, "lines": lines.into_iter().map(|(t, w)| json!({ "text": t, "words": w })).collect::<Vec<_>>() })
}

fn run_tesseract(app: &AppHandle, images: &[PathBuf], langs: &str, cancel: Option<&std::sync::atomic::AtomicBool>) -> Result<Value> {
    let exe = tesseract_exe(app).ok_or_else(|| anyhow!("Tesseract isn't installed — Settings → OCR → Download Tesseract"))?;
    let mut pages = vec![];
    let data = tessdata_dir(app);
    for img in images {
        let mut c = command(&exe);
        c.arg(img).arg("stdout");
        if data.join(format!("{}.traineddata", langs.split('+').next().unwrap_or("eng"))).is_file() {
            c.arg("--tessdata-dir").arg(&data);
        }
        if !langs.is_empty() {
            c.args(["-l", langs]);
        }
        c.args(["--psm", "3", "tsv"]);
        let out = crate::util::run_cancellable(c, Duration::from_secs(300), cancel)?;
        if !out.status.success() {
            bail!("Tesseract: {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("failed"));
        }
        pages.push(tsv_page(&String::from_utf8_lossy(&out.stdout)));
    }
    Ok(Value::Array(pages))
}

/// Download and install Tesseract for this user (official Windows installer from GitHub).
pub async fn install_tesseract(app: &AppHandle, inst: &InstallState) -> Result<()> {
    #[cfg(not(windows))]
    {
        let _ = (app, inst);
        bail!("Tesseract can be installed from Callio on Windows only");
    }
    #[cfg(windows)]
    {
        let client = reqwest::Client::builder().user_agent("Callio-editor").build()?;
        emit(app, "tesseract", "setup", "Finding the latest Tesseract…", 0, 0);
        // The Windows installer (built by UB Mannheim) is attached to some releases only, often a
        // little after the release itself: take the newest release that has one.
        let is_setup = |a: &Value| {
            let n = a["name"].as_str().unwrap_or("");
            n.starts_with("tesseract-ocr-w64-setup") && n.ends_with(".exe")
        };
        let mut found: Option<Value> = None;
        for repo in ["tesseract-ocr/tesseract", "UB-Mannheim/tesseract"] {
            let Ok(r) = client.get(format!("https://api.github.com/repos/{repo}/releases?per_page=30")).send().await else { continue };
            let Ok(list) = r.error_for_status().map(|r| r.json::<Value>()) else { continue };
            let list = list.await.unwrap_or(Value::Null);
            if let Some(a) = list.as_array().into_iter().flatten().filter(|r| !r["draft"].as_bool().unwrap_or(false) && !r["prerelease"].as_bool().unwrap_or(false)).find_map(|r| r["assets"].as_array().and_then(|a| a.iter().find(|x| is_setup(x)).cloned())) {
                found = Some(a);
                break;
            }
        }
        let asset = found.as_ref();
        let url = asset.and_then(|a| a["browser_download_url"].as_str()).ok_or_else(|| anyhow!("Couldn't find the Tesseract installer for Windows on GitHub (is the internet reachable?)"))?;
        let digest = asset.and_then(|a| a["digest"].as_str()).and_then(|d| d.strip_prefix("sha256:")).map(|d| d.to_lowercase());
        // a private, unpredictable path (not a fixed name in %TEMP%) for a program run as administrator
        let setup = data_dir(app).join(format!("tesseract-setup-{}.exe", &crate::util::sha256_hex(format!("{:?}{}", std::time::SystemTime::now(), std::process::id()).as_bytes())[..12]));
        download(app, inst, "tesseract", "Tesseract", url, &setup).await?;
        if let Some(want) = digest {
            let got = crate::util::sha256_hex(&std::fs::read(&setup)?);
            if got != want {
                let _ = std::fs::remove_file(&setup);
                bail!("The Tesseract download didn't match GitHub's checksum — not installed");
            }
        }
        let dest = tess_dir(app);
        std::fs::create_dir_all(&dest)?;
        emit(app, "tesseract", "setup", "Installing Tesseract (Windows may ask for permission)…", 0, 0);
        // the installer asks for administrator rights; Start-Process -Verb RunAs shows the prompt
        let script = format!(
            "$p = Start-Process -FilePath '{}' -ArgumentList '/S','/D={}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode",
            setup.to_string_lossy().replace('\'', "''"),
            dest.to_string_lossy().replace('\'', "''")
        );
        let mut c = command("powershell.exe");
        c.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        let out = tauri::async_runtime::spawn_blocking(move || crate::util::run_with_timeout(c, Duration::from_secs(900))).await??;
        let _ = std::fs::remove_file(&setup);
        if tesseract_exe(app).is_none() {
            bail!("Tesseract wasn't installed ({})", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("cancelled"));
        }
        // its English data, next to the other languages Callio downloads
        let data = tessdata_dir(app);
        std::fs::create_dir_all(&data)?;
        if let Some(src) = tesseract_exe(app).and_then(|e| e.parent().map(|d| d.join("tessdata"))) {
            for l in ["eng", "osd"] {
                let f = format!("{l}.traineddata");
                if !data.join(&f).exists() {
                    let _ = std::fs::copy(src.join(&f), data.join(&f));
                }
            }
        }
        emit(app, "tesseract", "done", "Tesseract installed", 1, 1);
        Ok(())
    }
}

#[tauri::command]
pub async fn ocr_install_tesseract(app: AppHandle, inst: tauri::State<'_, InstallState>) -> CmdResult<()> {
    if !inst.begin() {
        return Err("Another download is already running".into());
    }
    let r = install_tesseract(&app, &inst).await;
    inst.end();
    r.es()
}

/// A Tesseract language (e.g. "vie", "deu", "chi_sim") from tessdata_fast.
#[tauri::command]
pub async fn ocr_tesseract_language(app: AppHandle, inst: tauri::State<'_, InstallState>, lang: String) -> CmdResult<()> {
    if lang.is_empty() || !lang.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("Bad language code".into());
    }
    if !inst.begin() {
        return Err("Another download is already running".into());
    }
    let url = format!("https://github.com/tesseract-ocr/tessdata_fast/raw/main/{lang}.traineddata");
    let dest = tessdata_dir(&app).join(format!("{lang}.traineddata"));
    let r = download(&app, &inst, "tesseract", &format!("Tesseract language “{lang}”"), &url, &dest).await;
    inst.end();
    r.es()?;
    emit(&app, "tesseract", "done", &format!("Language {lang} installed"), 1, 1);
    Ok(())
}

// ---------------- running local engines ----------------

fn unhex(s: &str) -> Option<String> {
    let b: Option<Vec<u8>> = (0..s.len()).step_by(2).map(|i| s.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok())).collect();
    String::from_utf8(b?).ok()
}

/// Body: page images (PNG), each prefixed with its length as 4 bytes (little endian).
/// Headers: x-engine ("windows" | "tesseract"), x-langs (hex).
#[tauri::command]
pub async fn ocr_local(app: AppHandle, request: tauri::ipc::Request<'_>) -> CmdResult<Value> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else { return Err("Expected images".into()) };
    let h = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(String::from);
    let engine = h("x-engine").unwrap_or_default();
    let langs = h("x-langs").and_then(|v| unhex(&v)).unwrap_or_default();
    let job = h("x-job").unwrap_or_default();
    let dir = std::env::temp_dir().join(format!("callio-ocr-{}-{}", std::process::id(), crate::util::sha256_hex(&data[..data.len().min(4096)])[..8].to_string()));
    std::fs::create_dir_all(&dir).es()?;
    let guard = TempDir(dir.clone());
    let mut paths = vec![];
    let mut i = 0usize;
    while i + 4 <= data.len() {
        let n = u32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]) as usize;
        i += 4;
        if i + n > data.len() {
            return Err("Damaged image data".into());
        }
        let p = dir.join(format!("page-{}.png", paths.len() + 1));
        std::fs::write(&p, &data[i..i + n]).es()?;
        paths.push(p);
        i += n;
    }
    let app2 = app.clone();
    let token = job_token(&job);
    let res = tauri::async_runtime::spawn_blocking(move || -> Result<Value> {
        let _guard = guard;
        match engine.as_str() {
            "windows" => {
                let list = dir.join("pages.txt");
                std::fs::write(&list, paths.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>().join("\n"))?;
                let out = run_ps_c(WIN_OCR_PS, &[&list.to_string_lossy(), &langs], 120 + 30 * paths.len() as u64, Some(&token))?;
                serde_json::from_str(out.trim()).context("Windows OCR gave no result")
            }
            "tesseract" => run_tesseract(&app2, &paths, &langs, Some(&token)),
            other => bail!("Unknown OCR engine {other}"),
        }
    })
    .await
    .es()?;
    if !job.is_empty() && res.is_ok() {
        // keep the token for the job's next batch; the window ends the job
    }
    res.es()
}

// ---------------- vision models ----------------

pub const OCR_PROMPT: &str = "Transcribe this page image into Markdown, exactly as written. Keep the reading order (columns left to right), headings as #/##/###, paragraphs (join lines broken by layout, undo end-of-line hyphenation), bullet and numbered lists, tables as GitHub pipe tables, formulas as LaTeX ($…$ inline, $$…$$ display), footnotes at the end. Write <!-- image --> where a figure or photo is. Keep the original language and spelling; don't translate, summarise, correct or add anything. Output only the Markdown, without code fences or comments.";

/// One page image (PNG, base64) → Markdown from Claude (API key) or Gemini (API key).
#[tauri::command]
pub async fn ocr_vision(provider: String, model: String, png_base64: String, hint: Option<String>) -> CmdResult<String> {
    let prompt = match hint.filter(|h| !h.trim().is_empty()) {
        Some(h) => format!("{OCR_PROMPT}\nThe text is mainly in: {h}."),
        None => OCR_PROMPT.to_string(),
    };
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).timeout(Duration::from_secs(300)).build().es()?;
    match provider.as_str() {
        "anthropic" => {
            let key = crate::settings::get_secret_value("ai-key-anthropic").ok_or("Add an Anthropic API key in Settings → AI")?;
            let body = json!({
                "model": if model.is_empty() { "claude-sonnet-5-5" } else { &model },
                "max_tokens": 8000,
                "messages": [{ "role": "user", "content": [
                    { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": png_base64 } },
                    { "type": "text", "text": prompt }
                ]}]
            });
            let r: Value = client.post("https://api.anthropic.com/v1/messages").header("x-api-key", key).header("anthropic-version", "2023-06-01").json(&body).send().await.es()?.json().await.es()?;
            if let Some(e) = r["error"]["message"].as_str() {
                return Err(format!("Claude: {e}"));
            }
            Ok(r["content"].as_array().into_iter().flatten().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join(""))
        }
        "gemini" => {
            let key = crate::settings::get_secret_value("ai-key-gemini").ok_or("Add a Gemini API key in Settings → AI")?;
            let m = if model.is_empty() { "gemini-2.5-flash".to_string() } else { model.trim_start_matches("models/").to_string() };
            let body = json!({ "contents": [{ "role": "user", "parts": [
                { "inline_data": { "mime_type": "image/png", "data": png_base64 } },
                { "text": prompt }
            ]}], "generationConfig": { "temperature": 0 } });
            let r: Value = client.post(format!("https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent")).header("x-goog-api-key", key).json(&body).send().await.es()?.json().await.es()?;
            if let Some(e) = r["error"]["message"].as_str() {
                return Err(format!("Gemini: {e}"));
            }
            Ok(r["candidates"][0]["content"]["parts"].as_array().into_iter().flatten().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join(""))
        }
        other => Err(format!("Unknown provider {other}")),
    }
}

/// Page images → Markdown with Claude Code (the user's Claude plan). Pages go in small batches;
/// Claude Code reads the image files with its Read tool and nothing else.
#[tauri::command]
pub async fn ocr_claude_code(pages_base64: Vec<String>, model: Option<String>, effort: Option<String>, hint: Option<String>, job: Option<String>) -> CmdResult<String> {
    let exe = crate::claude_code::find_claude().ok_or("Claude Code isn't installed — Settings → AI → Claude Code")?;
    let dir = std::env::temp_dir().join(format!("callio-ocr-cc-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)));
    std::fs::create_dir_all(&dir).es()?;
    let guard = TempDir(dir.clone());
    let mut names = vec![];
    for (i, b) in pages_base64.iter().enumerate() {
        let bytes = base64::engine::general_purpose::STANDARD.decode(b).es()?;
        let n = format!("page-{}.png", i + 1);
        std::fs::write(dir.join(&n), bytes).es()?;
        names.push(n);
    }
    let lang = hint.filter(|h| !h.trim().is_empty()).map(|h| format!(" The text is mainly in: {h}.")).unwrap_or_default();
    let prompt = format!(
        "Read each of these page images in this folder, in order: {}. {OCR_PROMPT}{lang} Put a line <!-- page N --> before each page's Markdown. Reply with the Markdown only.",
        names.join(", ")
    );
    let mut c = crate::claude_code::claude_cmd(&exe);
    c.current_dir(&dir).args(["-p", &prompt, "--output-format", "text", "--allowedTools", "Read", "--permission-mode", "default"]);
    if let Some(m) = model.filter(|m| !m.is_empty() && m != "default") {
        c.args(["--model", &m]);
    }
    if let Some(e) = effort.filter(|e| ["low", "medium", "high", "xhigh", "max"].contains(&e.as_str())) {
        c.args(["--effort", &e]);
    }
    let token = job_token(job.as_deref().unwrap_or(""));
    let out = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        crate::util::run_cancellable(c, Duration::from_secs(900), Some(&token))
    })
    .await
    .es()?
    .es()?;
    if !out.status.success() {
        return Err(format!("Claude Code: {}", String::from_utf8_lossy(&out.stderr).lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("failed")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[allow(dead_code)]
fn _unused(_: &Path) {}

#[cfg(test)]
mod tests {
    #[test]
    fn tsv() {
        let t = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n1\t1\t0\t0\t0\t0\t0\t0\t800\t1000\t-1\t\n5\t1\t1\t1\t1\t1\t10\t20\t50\t12\t95\tHello\n5\t1\t1\t1\t1\t2\t70\t20\t50\t12\t95\tworld\n5\t1\t1\t1\t2\t1\t10\t40\t50\t12\t95\tNext\n";
        let v = super::tsv_page(t);
        assert_eq!(v["width"], 800.0);
        assert_eq!(v["lines"][0]["text"], "Hello world");
        assert_eq!(v["lines"][1]["text"], "Next");
    }
}

/// Add a Windows OCR language pack (Settings → Language → "Optical character recognition"),
/// e.g. "en-US". Windows asks for administrator permission.
#[tauri::command]
pub async fn ocr_windows_language(tag: String) -> CmdResult<Vec<String>> {
    let ok = !tag.is_empty() && tag.len() < 20 && tag.split('-').all(|p| !p.is_empty() && p.len() <= 8 && p.chars().all(|c| c.is_ascii_alphanumeric()));
    if !ok {
        return Err("Not a language tag".into());
    }
    if !cfg!(windows) {
        return Err("Windows OCR needs Windows".into());
    }
    // no double quotes anywhere: they don't survive the trip through two command lines
    let script = format!(
        "$p = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-Command','Add-WindowsCapability -Online -Name ''Language.OCR~~~{tag}~0.0.1.0''' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode"
    );
    let mut c = command("powershell.exe");
    c.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    let out = tauri::async_runtime::spawn_blocking(move || crate::util::run_with_timeout(c, Duration::from_secs(900))).await.es()?.es()?;
    let langs = tauri::async_runtime::spawn_blocking(windows_languages).await.ok().flatten().unwrap_or_default();
    if !out.status.success() && !langs.iter().any(|l| l.eq_ignore_ascii_case(&tag)) {
        return Err(format!("The {tag} OCR pack wasn't installed (cancelled, or Windows Update couldn't be reached)"));
    }
    Ok(langs)
}
