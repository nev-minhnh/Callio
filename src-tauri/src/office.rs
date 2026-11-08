//! The office engine (callio-office.exe, next to Callio.exe): Word documents, spreadsheets and
//! PDF tools. It is started on first use and talks JSON lines over its stdin/stdout, so the editor
//! itself stays small and starts fast; it ends when Callio closes (its stdin closes).
use crate::util::CmdResult;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

struct Proc {
    child: Child,
    stdin: ChildStdin,
    pending: Pending,
}

#[derive(Default)]
pub struct OfficeState {
    proc: Mutex<Option<Proc>>,
}

static NEXT: AtomicU64 = AtomicU64::new(1);

fn engine_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("CALLIO_OFFICE").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) { "callio-office.exe" } else { "callio-office" };
    let mut cands = vec![dir.join(name)];
    // development: the engine's own build folder
    for up in dir.ancestors().take(6) {
        cands.push(up.join("office").join("bin").join(name));
        cands.push(up.join("office").join("target").join("release").join(name));
        cands.push(up.join("office").join("target").join("x86_64-pc-windows-gnu").join("release").join(name));
    }
    cands.into_iter().find(|p| p.is_file())
}

fn spawn() -> Result<Proc, String> {
    let exe = engine_path().ok_or("The office engine (callio-office.exe) is missing next to Callio.exe — reinstall Callio")?;
    let mut c = crate::util::command(&exe);
    c.arg("--serve").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = c.spawn().map_err(|e| format!("Couldn't start the office engine: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let p2 = pending.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if let Some(id) = v["id"].as_u64() {
                if let Some(tx) = p2.lock().unwrap().remove(&id) {
                    let _ = tx.send(v);
                }
            }
        }
        // the engine ended: everyone still waiting gets an answer
        for (_, tx) in p2.lock().unwrap().drain() {
            let _ = tx.send(json!({"ok": false, "error": "The office engine stopped — try again"}));
        }
    });
    Ok(Proc { child, stdin, pending })
}

pub async fn request(state: &OfficeState, cmd: &str, args: Value) -> Result<Value, String> {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    {
        let mut g = state.proc.lock().unwrap();
        // started on first use; started again if it ended
        let alive = g.as_mut().map(|p| matches!(p.child.try_wait(), Ok(None))).unwrap_or(false);
        if !alive {
            *g = Some(spawn()?);
        }
        let p = g.as_mut().unwrap();
        p.pending.lock().unwrap().insert(id, tx);
        let line = json!({"id": id, "cmd": cmd, "args": args}).to_string();
        if writeln!(p.stdin, "{line}").and_then(|_| p.stdin.flush()).is_err() {
            p.pending.lock().unwrap().remove(&id);
            *g = None;
            return Err("The office engine stopped — try again".into());
        }
    }
    let v = rx.await.map_err(|_| "The office engine stopped — try again".to_string())?;
    if v["ok"].as_bool() == Some(true) {
        Ok(v["result"].clone())
    } else {
        Err(v["error"].as_str().unwrap_or("The office engine failed").to_string())
    }
}

/// Call the office engine: `cmd` and its JSON arguments (see office/src/main.rs).
#[tauri::command]
pub async fn office(state: tauri::State<'_, OfficeState>, cmd: String, args: Value) -> CmdResult<Value> {
    request(&state, &cmd, args).await
}

/// Whether the engine is installed (for menus).
#[tauri::command]
pub fn office_available() -> bool {
    engine_path().is_some()
}

/// A temporary file path for a rendered document (cleaned when Callio starts again).
#[tauri::command]
pub fn office_temp(name: String) -> CmdResult<String> {
    let dir = std::env::temp_dir().join("callio-office");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).collect();
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    Ok(dir.join(format!("{stamp}-{safe}")).to_string_lossy().to_string())
}

/// Old rendered copies from earlier sessions.
pub fn clean_temp() {
    let dir = std::env::temp_dir().join("callio-office");
    let Ok(rd) = std::fs::read_dir(&dir) else { return };
    let day = std::time::Duration::from_secs(86_400);
    for e in rd.flatten() {
        if e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > day) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}
