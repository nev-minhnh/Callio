//! Local Jupyter servers: one hidden `jupyter_server` per (interpreter, drive), started when the
//! author first runs something and stopped when no kernels are left for a while and when Callio
//! exits. The token is random per server and lives only in memory (and in the child's
//! environment) — it never reaches the window, a command line or a log.
use super::{net, parse};
use crate::util::{command, kill_pid_tree, ErrStr, CmdResult};
use serde::Serialize;
use serde_json::json;
use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub struct Local {
    pub id: String,
    pub python: String,
    pub root: String,
    pub base: reqwest::Url,
    pub token: String,
    child: Mutex<Option<std::process::Child>>,
    idle_since: Mutex<Option<Instant>>,
}

static LOCALS: Mutex<Vec<Arc<Local>>> = Mutex::new(Vec::new());
/// Minutes without any kernel before a local server is stopped (0 = never).
pub static IDLE_MIN: AtomicU64 = AtomicU64::new(10);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalInfo {
    pub id: String,
    pub base_url: String,
    pub root: String,
    pub python: String,
}

pub fn find(id: &str) -> Option<Arc<Local>> {
    LOCALS.lock().unwrap().iter().find(|l| l.id == id).cloned()
}
pub fn list() -> Vec<LocalInfo> {
    LOCALS.lock().unwrap().iter().map(|l| LocalInfo { id: l.id.clone(), base_url: l.base.to_string(), root: l.root.clone(), python: l.python.clone() }).collect()
}
impl Local {
    pub fn endpoint(&self) -> net::Endpoint {
        net::Endpoint { base: self.base.clone(), token: self.token.clone(), pin: None, id: self.id.clone() }
    }
    fn alive(&self) -> bool {
        self.child.lock().unwrap().as_mut().map(|c| matches!(c.try_wait(), Ok(None))).unwrap_or(false)
    }
    fn kill(&self) {
        if let Some(mut c) = self.child.lock().unwrap().take() {
            kill_pid_tree(&mut c);
        }
    }
}

fn free_port() -> CmdResult<u16> {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).es()?;
    Ok(l.local_addr().es()?.port())
}

#[cfg(windows)]
pub(crate) mod job {
    //! A Windows Job object with KILL_ON_JOB_CLOSE: every server (and so every kernel) dies
    //! with Callio, even if Callio crashes or is ended from the Task Manager.
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::*;
    struct H(HANDLE);
    unsafe impl Send for H {}
    unsafe impl Sync for H {}
    static JOB: OnceLock<Option<H>> = OnceLock::new();
    pub fn assign(child: &std::process::Child) {
        use std::os::windows::io::AsRawHandle;
        let j = JOB.get_or_init(|| unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) == 0 {
                return None;
            }
            Some(H(h))
        });
        if let Some(H(h)) = j {
            unsafe {
                AssignProcessToJobObject(*h, child.as_raw_handle() as HANDLE);
            }
        }
    }
}
#[cfg(not(windows))]
pub(crate) mod job {
    pub fn assign(_: &std::process::Child) {}
}

fn tail(lines: &Arc<Mutex<VecDeque<String>>>, n: usize) -> String {
    let l = lines.lock().unwrap();
    l.iter().rev().take(n).rev().cloned().collect::<Vec<_>>().join("\n")
}

fn pump(r: impl std::io::Read + Send + 'static, keep: Arc<Mutex<VecDeque<String>>>) {
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(r).lines().map_while(Result::ok) {
            let mut k = keep.lock().unwrap();
            if k.len() >= 60 {
                k.pop_front();
            }
            // the server prints URLs with ?token=… in its banner; keep the token out of anything we show
            k.push_back(line.split("?token=").next().unwrap_or("").to_string());
        }
    });
}

fn progress(app: &AppHandle, id: &str, text: String) {
    let _ = app.emit("jp-progress", json!({"id": id, "text": text}));
}

/// Start (or reuse) the server for `python` rooted at `root`; waits until it answers.
pub async fn start(app: &AppHandle, python: &str, root: &str) -> CmdResult<LocalInfo> {
    let id = format!("local-{}", parse::short_hash(&format!("{}|{}", python.to_lowercase(), root.to_lowercase())));
    if let Some(l) = find(&id) {
        if l.alive() && net::rest(&l.endpoint(), "GET", "/api/status", None, 5).await.is_ok() {
            *l.idle_since.lock().unwrap() = None;
            return Ok(LocalInfo { id, base_url: l.base.to_string(), root: l.root.clone(), python: l.python.clone() });
        }
        l.kill();
        LOCALS.lock().unwrap().retain(|x| x.id != id);
    }
    ensure_watcher(app.clone());
    let token = crate::claude_code::mcp::random_token();
    let sib = |name: &str| {
        let p = std::path::Path::new(python).parent().map(|d| d.join(if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }));
        p.filter(|p| p.is_file()).map(|p| p.to_string_lossy().to_string())
    };
    // `python -m jupyter_server` first; if that fails, the console script, then `jupyter lab`
    let mut ways: Vec<(String, Vec<&str>)> = vec![(python.to_string(), vec!["-m", "jupyter_server"])];
    if let Some(s) = sib("jupyter-server") {
        ways.push((s, vec![]));
    }
    ways.push((python.to_string(), vec!["-m", "jupyter", "lab"]));
    let mut last_err = String::new();
    for (exe, pre) in ways {
        let port = free_port()?;
        progress(app, &id, format!("Starting the Jupyter server ({})…", std::path::Path::new(&exe).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()));
        let mut c = command(&exe);
        c.args(&pre)
            .args(["--no-browser", "--allow-root", "--ServerApp.port_retries=0", "--ServerApp.ip=127.0.0.1", "--ServerApp.password=", "--ServerApp.disable_check_xsrf=False"])
            .arg(format!("--ServerApp.port={port}"))
            .arg(format!("--ServerApp.root_dir={root}"))
            .env("JUPYTER_TOKEN", &token)
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUNBUFFERED", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = match c.spawn() {
            Ok(c) => c,
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        };
        job::assign(&child);
        let log = Arc::new(Mutex::new(VecDeque::new()));
        if let Some(o) = child.stdout.take() {
            pump(o, log.clone());
        }
        if let Some(o) = child.stderr.take() {
            pump(o, log.clone());
        }
        let base: reqwest::Url = format!("http://127.0.0.1:{port}/").parse().es()?;
        let local = Arc::new(Local { id: id.clone(), python: python.to_string(), root: root.to_string(), base: base.clone(), token: token.clone(), child: Mutex::new(Some(child)), idle_since: Mutex::new(None) });
        let t0 = Instant::now();
        let mut ready = false;
        loop {
            if !local.alive() {
                break;
            }
            if net::rest(&local.endpoint(), "GET", "/api/status", None, 2).await.is_ok() {
                ready = true;
                break;
            }
            if t0.elapsed() > Duration::from_secs(40) {
                last_err = "The server did not start within 40 seconds.".into();
                break;
            }
            progress(app, &id, format!("Starting the Jupyter server… {} s", t0.elapsed().as_secs()));
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        if ready {
            LOCALS.lock().unwrap().push(local.clone());
            return Ok(LocalInfo { id, base_url: base.to_string(), root: root.to_string(), python: python.to_string() });
        }
        if last_err.is_empty() {
            last_err = "The server stopped right after starting.".into();
        }
        let t = tail(&log, 8);
        local.kill();
        if !t.is_empty() {
            last_err = format!("{last_err}\n{t}");
        }
    }
    Err(last_err)
}

pub fn stop(id: &str) {
    if let Some(l) = find(id) {
        l.kill();
    }
    LOCALS.lock().unwrap().retain(|x| x.id != id);
}
pub fn stop_all() {
    let all: Vec<_> = LOCALS.lock().unwrap().drain(..).collect();
    for l in all {
        l.kill();
    }
}

static WATCHER: std::sync::Once = std::sync::Once::new();
/// Every 30 s: a local server with no kernels for IDLE_MIN minutes is stopped.
fn ensure_watcher(app: AppHandle) {
    WATCHER.call_once(|| {
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let idle = IDLE_MIN.load(Ordering::Relaxed);
                let all: Vec<_> = LOCALS.lock().unwrap().clone();
                for l in all {
                    if !l.alive() {
                        LOCALS.lock().unwrap().retain(|x| x.id != l.id);
                        let _ = app.emit("jp-server-gone", json!({"id": l.id}));
                        continue;
                    }
                    let n = net::rest(&l.endpoint(), "GET", "/api/kernels", None, 5).await.ok().and_then(|v| v.as_array().map(|a| a.len()));
                    match n {
                        Some(0) => {
                            let mut s = l.idle_since.lock().unwrap();
                            let since = *s.get_or_insert_with(Instant::now);
                            if idle > 0 && since.elapsed() >= Duration::from_secs(idle * 60) {
                                drop(s);
                                l.kill();
                                LOCALS.lock().unwrap().retain(|x| x.id != l.id);
                                let _ = app.emit("jp-server-gone", json!({"id": l.id}));
                            }
                        }
                        Some(_) => *l.idle_since.lock().unwrap() = None,
                        None => {}
                    }
                }
            }
        });
    });
}

/// Run `python -m pip install …` for the author, line by line into the log panel.
pub fn pip_install(app: &AppHandle, python: &str, id: &str) -> CmdResult<i32> {
    let mut c = command(python);
    c.args(["-m", "pip", "install", "jupyter_server", "ipykernel"]).env("PYTHONUNBUFFERED", "1").stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().es()?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    for (i, r) in [child.stdout.take().map(|x| Box::new(x) as Box<dyn std::io::Read + Send>), child.stderr.take().map(|x| Box::new(x) as Box<dyn std::io::Read + Send>)].into_iter().enumerate() {
        let _ = i;
        if let Some(r) = r {
            let tx = tx.clone();
            std::thread::spawn(move || {
                use std::io::BufRead;
                for l in std::io::BufReader::new(r).lines().map_while(Result::ok) {
                    let _ = tx.send(l);
                }
            });
        }
    }
    drop(tx);
    for l in rx {
        let _ = app.emit("jp-log", json!({"id": id, "line": l}));
    }
    let code = child.wait().es()?.code().unwrap_or(-1);
    super::pyenv::forget(python);
    let _ = app.emit("jp-log", json!({"id": id, "done": true, "code": code}));
    Ok(code)
}
