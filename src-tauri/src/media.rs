//! Playback for formats WebView2 can't decode: converted once with FFmpeg (when installed) to an
//! MP4 / M4A in the app's cache, with progress events. The original file is never touched.
use crate::util::CmdResult;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

static RUNNING: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

fn no_window(c: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = c;
}

/// ffmpeg on PATH, or in the usual install places (winget, Chocolatey, Scoop).
fn ffmpeg() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    if let Some(paths) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&paths) {
            let p = d.join(exe);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let mut c: Vec<PathBuf> = vec![];
    if let Ok(l) = std::env::var("LOCALAPPDATA") {
        let links = PathBuf::from(&l).join("Microsoft\\WinGet\\Links").join(exe);
        c.push(links);
        // winget's package folder: …\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*\bin\ffmpeg.exe
        if let Ok(rd) = std::fs::read_dir(PathBuf::from(&l).join("Microsoft\\WinGet\\Packages")) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().to_lowercase().contains("ffmpeg") {
                    if let Ok(inner) = std::fs::read_dir(e.path()) {
                        for i in inner.flatten() {
                            c.push(i.path().join("bin").join(exe));
                        }
                    }
                }
            }
        }
    }
    if let Ok(u) = std::env::var("USERPROFILE") {
        c.push(PathBuf::from(u).join("scoop\\shims").join(exe));
    }
    c.push(PathBuf::from("C:\\ProgramData\\chocolatey\\bin").join(exe));
    c.push(PathBuf::from("C:\\ffmpeg\\bin").join(exe));
    c.into_iter().find(|p| p.is_file())
}

/// Where FFmpeg is ("" when it isn't installed).
#[tauri::command]
pub fn media_ffmpeg() -> String {
    ffmpeg().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
}

fn duration_secs(line: &str) -> Option<f64> {
    // "  Duration: 00:03:21.45, start: …"
    let i = line.find("Duration: ")?;
    let t = line[i + 10..].split(',').next()?.trim();
    let mut s = 0.0;
    for part in t.split(':') {
        s = s * 60.0 + part.parse::<f64>().ok()?;
    }
    Some(s)
}

/// Convert `path` for playback; returns the converted file (reused when already converted).
#[tauri::command]
pub async fn media_transcode(app: AppHandle, path: String, audio: bool) -> CmdResult<String> {
    let ff = ffmpeg().ok_or("FFmpeg isn't installed")?;
    let src = PathBuf::from(&path);
    let meta = std::fs::metadata(&src).map_err(|e| e.to_string())?;
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    let key = crate::util::sha256_hex(format!("{path}|{}|{mtime}", meta.len()).as_bytes());
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("media");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(format!("{}.{}", &key[..20], if audio { "m4a" } else { "mp4" }));
    if out.is_file() && std::fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(out.to_string_lossy().to_string());
    }
    let part = out.with_extension(if audio { "part.m4a" } else { "part.mp4" });
    let mut c = Command::new(&ff);
    c.args(["-hide_banner", "-nostdin", "-y", "-i"]).arg(&src);
    if audio {
        c.args(["-vn", "-c:a", "aac", "-b:a", "192k"]);
    } else {
        c.args(["-map", "0:v:0?", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"]);
    }
    c.args(["-progress", "pipe:1", "-nostats"]).arg(&part);
    c.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    no_window(&mut c);
    let mut child: Child = c.spawn().map_err(|e| format!("Couldn't start FFmpeg: {e}"))?;
    RUNNING.lock().unwrap().get_or_insert_with(HashMap::new).insert(path.clone(), child.id());
    let stderr = child.stderr.take();
    let stdout = child.stdout.take();
    let total = std::sync::Arc::new(Mutex::new(0f64));
    let tot2 = total.clone();
    let err_lines = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
    let err2 = err_lines.clone();
    let t_err = std::thread::spawn(move || {
        if let Some(e) = stderr {
            for l in BufReader::new(e).lines().map_while(Result::ok) {
                if let Some(d) = duration_secs(&l) {
                    *tot2.lock().unwrap() = d;
                }
                let mut v = err2.lock().unwrap();
                v.push(l);
                if v.len() > 30 {
                    v.remove(0);
                }
            }
        }
    });
    let (app2, p2, tot3) = (app.clone(), path.clone(), total.clone());
    let t_out = std::thread::spawn(move || {
        if let Some(o) = stdout {
            for l in BufReader::new(o).lines().map_while(Result::ok) {
                if let Some(v) = l.strip_prefix("out_time_us=").or_else(|| l.strip_prefix("out_time_ms=")) {
                    let us: f64 = v.trim().parse().unwrap_or(0.0);
                    let d = *tot3.lock().unwrap();
                    let frac = if d > 0.0 { Some((us / 1e6 / d).clamp(0.0, 1.0)) } else { None };
                    let _ = app2.emit("media-progress", serde_json::json!({ "path": p2, "frac": frac }));
                }
            }
        }
    });
    let status = tauri::async_runtime::spawn_blocking(move || child.wait()).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    let _ = t_out.join();
    let _ = t_err.join();
    RUNNING.lock().unwrap().get_or_insert_with(HashMap::new).remove(&path);
    if !status.success() {
        let _ = std::fs::remove_file(&part);
        let last = err_lines.lock().unwrap().iter().rev().find(|l| !l.trim().is_empty()).cloned().unwrap_or_else(|| "cancelled".into());
        return Err(last);
    }
    std::fs::rename(&part, &out).map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().to_string())
}

/// Stop a conversion.
#[tauri::command]
pub fn media_cancel(path: String) {
    let pid = RUNNING.lock().unwrap().get_or_insert_with(HashMap::new).remove(&path);
    if let Some(pid) = pid {
        let mut k = if cfg!(windows) { Command::new("taskkill") } else { Command::new("kill") };
        if cfg!(windows) {
            k.args(["/PID", &pid.to_string(), "/T", "/F"]);
        } else {
            k.arg(pid.to_string());
        }
        no_window(&mut k);
        let _ = k.status();
    }
}

