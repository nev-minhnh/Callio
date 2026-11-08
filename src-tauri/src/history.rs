//! Local version history: every save, AI edit, Overleaf pull and restore keeps a copy of the
//! file. No git, nothing to install. Stored compressed and de-duplicated under app data:
//!   history/<file key>/log.jsonl      one JSON line per version
//!   history/<file key>/objects/<sha>  gzip'd content
use crate::settings::data_dir;
use crate::util::{path_key, sha256_hex, CmdResult, ErrStr};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Version {
    pub id: String,
    /// unix ms
    pub t: u64,
    pub sha: String,
    pub label: String,
    /// "save" | "ai" | "pull" | "manual" | "restore"
    pub kind: String,
    pub size: u64,
    #[serde(default)]
    pub path: String,
}

const MAX_FILE: usize = 20 * 1024 * 1024;

fn dir_for(app: &AppHandle, path: &str) -> PathBuf {
    let k = sha256_hex(path_key(path).as_bytes());
    data_dir(app).join("history").join(&k[..20])
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// All history operations run one at a time (they are quick), so concurrent saves can't
/// lose each other's versions.
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct Log {
    versions: Vec<Version>,
    /// lines we couldn't parse: kept verbatim, and their presence disables object cleanup
    unknown: Vec<String>,
}

/// Missing log = empty history. Any other read error is an error (never "empty"), so a
/// temporarily locked file can't make the next write wipe the history.
fn read_log(dir: &PathBuf) -> std::io::Result<Log> {
    let f = match std::fs::File::open(dir.join("log.jsonl")) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Log { versions: Vec::new(), unknown: Vec::new() }),
        Err(e) => return Err(e),
    };
    let mut log = Log { versions: Vec::new(), unknown: Vec::new() };
    for l in std::io::BufReader::new(f).lines() {
        let l = l?;
        if l.trim().is_empty() {
            continue;
        }
        match serde_json::from_str(&l) {
            Ok(v) => log.versions.push(v),
            Err(_) => log.unknown.push(l),
        }
    }
    Ok(log)
}

fn write_log(dir: &PathBuf, log: &Log) -> std::io::Result<()> {
    let tmp = dir.join(format!("log.jsonl.{}.tmp", std::process::id()));
    {
        let mut f = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
        for l in &log.unknown {
            writeln!(f, "{l}")?;
        }
        for e in &log.versions {
            writeln!(f, "{}", serde_json::to_string(e).unwrap())?;
        }
        f.flush()?;
        f.get_ref().sync_all()?;
    }
    std::fs::rename(tmp, dir.join("log.jsonl"))
}

/// Keep everything from the last 2 days, then one per hour for 30 days, then one per day.
/// Named versions are always kept.
fn prune(v: Vec<Version>) -> Vec<Version> {
    let now = now_ms();
    const H: u64 = 3_600_000;
    let mut out: Vec<Version> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    // newest first so each bucket keeps its latest version
    for e in v.into_iter().rev() {
        let age = now.saturating_sub(e.t);
        let bucket = if e.kind == "manual" || age < 48 * H {
            None
        } else if age < 30 * 24 * H {
            Some(e.t / H)
        } else {
            Some(1_000_000_000 + e.t / (24 * H))
        };
        if let Some(b) = bucket {
            if !seen.insert(b) {
                continue;
            }
        }
        out.push(e);
    }
    // cap the number of automatic versions; named ones are never dropped
    let mut unnamed = 0;
    out.retain(|e| {
        if e.kind == "manual" {
            return true;
        }
        unnamed += 1;
        unnamed <= 3000
    });
    out.reverse();
    out
}

pub fn record(app: &AppHandle, path: &str, text: &str, label: &str, kind: &str) -> anyhow::Result<Option<Version>> {
    if text.len() > MAX_FILE {
        return Ok(None);
    }
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = dir_for(app, path);
    std::fs::create_dir_all(dir.join("objects"))?;
    let mut log = read_log(&dir)?;
    let sha = sha256_hex(text.as_bytes());
    // nothing changed since the last version: don't add noise (named versions still count)
    if kind != "manual" && log.versions.last().map(|l| l.sha == sha).unwrap_or(false) {
        return Ok(None);
    }
    let obj = dir.join("objects").join(&sha);
    if !obj.exists() {
        let tmp = obj.with_extension(format!("{}.tmp", std::process::id()));
        let mut enc = GzEncoder::new(std::fs::File::create(&tmp)?, Compression::default());
        enc.write_all(text.as_bytes())?;
        enc.finish()?.sync_all()?;
        std::fs::rename(&tmp, &obj)?;
    }
    let t = now_ms();
    let v = Version { id: format!("{t}-{}", &sha[..8]), t, sha, label: label.to_string(), kind: kind.to_string(), size: text.len() as u64, path: path.to_string() };
    log.versions.push(v.clone());
    let before = log.versions.len();
    log.versions = prune(std::mem::take(&mut log.versions));
    write_log(&dir, &log)?;
    if log.versions.len() != before && log.unknown.is_empty() {
        // drop objects no version refers to any more (never in-progress temp files)
        let live: std::collections::HashSet<&str> = log.versions.iter().map(|e| e.sha.as_str()).collect();
        if let Ok(rd) = std::fs::read_dir(dir.join("objects")) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if !n.ends_with(".tmp") && !live.contains(n.as_str()) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
    Ok(Some(v))
}

#[tauri::command]
pub async fn history_record(app: AppHandle, path: String, text: String, label: String, kind: String) -> CmdResult<Option<Version>> {
    record(&app, &path, &text, &label, &kind).es()
}

/// Snapshot what is on disk right now (used before a sync overwrites files).
#[tauri::command]
pub async fn history_record_disk(app: AppHandle, paths: Vec<String>, label: String, kind: String) -> CmdResult<()> {
    for p in paths {
        if let Ok(b) = std::fs::read(&p) {
            if let Ok(t) = String::from_utf8(b) {
                let _ = record(&app, &p, &t, &label, &kind);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn history_list(app: AppHandle, path: String) -> CmdResult<Vec<Version>> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut v = read_log(&dir_for(&app, &path)).es()?.versions;
    v.reverse();
    Ok(v)
}

#[tauri::command]
pub async fn history_get(app: AppHandle, path: String, id: String) -> CmdResult<String> {
    let dir = dir_for(&app, &path);
    let v = {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        read_log(&dir).es()?.versions.into_iter().find(|e| e.id == id).ok_or("That version no longer exists")?
    };
    let f = std::fs::File::open(dir.join("objects").join(&v.sha)).es()?;
    let mut s = String::new();
    GzDecoder::new(f).read_to_string(&mut s).es()?;
    Ok(s)
}

#[tauri::command]
pub async fn history_rename(app: AppHandle, path: String, id: String, label: String) -> CmdResult<()> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = dir_for(&app, &path);
    let mut log = read_log(&dir).es()?;
    if let Some(e) = log.versions.iter_mut().find(|e| e.id == id) {
        e.label = label;
        e.kind = "manual".into(); // named versions are kept forever
    }
    write_log(&dir, &log).es()
}

/// Id of the newest version of `path` whose content has this hash.
pub fn latest_id_with_sha(app: &AppHandle, path: &str, sha: &str) -> Option<String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_log(&dir_for(app, path)).ok()?.versions.into_iter().rev().find(|v| v.sha == sha).map(|v| v.id)
}
