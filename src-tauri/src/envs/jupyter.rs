//! Jupyter servers that run INSIDE a WSL distro or a Docker container. Callio starts
//! `python -m jupyter_server` there on a port, and the one Jupyter client (jupyter/net.rs)
//! talks to it at `http://127.0.0.1:<port>/` — WSL2 forwards Windows localhost into the distro, and a
//! Docker container is reached through a port it publishes. The window learns about these
//! connections as kinds "wsl" and "docker"; `ConnSpec::endpoint` finds them here by id.
//!
//! The secret token: it is a random value that lives in memory and in the environment of the
//! Windows `wsl.exe` / `docker.exe` process, never on a command line. For WSL it crosses into the
//! distro through `WSLENV`; for Docker through `docker exec -e JUPYTER_TOKEN` (no value: Docker reads
//! it from its own environment). Chosen over a 0600 token file because a file would leave the
//! secret on the distro's disk and needs a shell string with `$(cat …)`.
//!
//! Docker: only containers that publish a TCP port are supported (Jupyter has to listen on a
//! published container port; reaching an unpublished one would need a forwarder inside the container).
use super::exec::{self, Env};
use super::{parse, paths};
use crate::jupyter::{net, server};
use crate::util::{kill_pid_tree, CmdResult, ErrStr};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub struct Srv {
    id: String,
    env: Env,
    python: String,
    base: reqwest::Url,
    token: String,
    child: Mutex<Option<std::process::Child>>,
    idle_since: Mutex<Option<Instant>>,
}
static SERVERS: Mutex<Vec<Arc<Srv>>> = Mutex::new(Vec::new());

impl Srv {
    fn endpoint(&self) -> net::Endpoint {
        net::Endpoint { base: self.base.clone(), token: self.token.clone(), pin: None, id: self.id.clone() }
    }
    fn alive(&self) -> bool {
        self.child.lock().unwrap().as_mut().map(|c| matches!(c.try_wait(), Ok(None))).unwrap_or(false)
    }
    /// Ask the server to stop (it ends its kernels), then end the client process. A `docker exec`
    /// process keeps running in the container when its client is killed, so the API call matters there.
    fn kill(&self) {
        http_shutdown(self.base.port().unwrap_or(0), &self.token);
        if let Some(mut c) = self.child.lock().unwrap().take() {
            kill_pid_tree(&mut c);
        }
    }
}

/// `POST /api/shutdown` with the token, over a plain socket (callable from any thread, async or not).
/// A request carrying the token is exempt from the XSRF check.
fn http_shutdown(port: u16, token: &str) {
    use std::io::Write;
    if port == 0 {
        return;
    }
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else { return };
    let _ = s.set_write_timeout(Some(Duration::from_secs(2)));
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = write!(s, "POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: token {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    let mut sink = [0u8; 256];
    let _ = std::io::Read::read(&mut s, &mut sink);
}

/// Used by `ConnSpec::endpoint` for kinds "wsl" and "docker".
pub fn endpoint(id: &str) -> Option<net::Endpoint> {
    SERVERS.lock().unwrap().iter().find(|s| s.id == id).map(|s| s.endpoint())
}

fn find(id: &str) -> Option<Arc<Srv>> {
    SERVERS.lock().unwrap().iter().find(|s| s.id == id).cloned()
}

pub fn stop_all() {
    let all: Vec<_> = SERVERS.lock().unwrap().drain(..).collect();
    for s in all {
        s.kill();
    }
}

fn free_port() -> CmdResult<u16> {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).es()?;
    Ok(l.local_addr().es()?.port())
}

fn port_busy(p: u16) -> bool {
    std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], p)), Duration::from_millis(300)).is_ok()
}

/// A folder of the window (UNC / Windows path) as a path inside the environment.
fn folder_in_env(env: &Env, dir: &str) -> CmdResult<String> {
    match env.kind.as_str() {
        "wsl" => paths::win_to_wsl(dir).ok_or_else(|| "That folder can't be reached from WSL.".to_string()),
        "docker" => {
            let c = env.container.as_deref().unwrap_or("");
            let i = inspect(c)?;
            paths::host_to_container(&i.mounts, dir).ok_or_else(|| "That folder is not shared with the container (no bind mount covers it), so a kernel there could not see the notebook's files.".to_string())
        }
        _ => Err("Not an environment.".into()),
    }
}

fn inspect(container: &str) -> CmdResult<parse::Inspect> {
    let mut c = crate::util::command(exec::docker_exe());
    c.args(["inspect", container]);
    let o = crate::util::run_with_timeout(c, Duration::from_secs(15)).es()?;
    parse::parse_inspect(&String::from_utf8_lossy(&o.stdout)).ok_or_else(|| "Docker did not describe that container.".to_string())
}

/// Constant discovery + probe script ($1 = the notebook's folder in the environment): prints
/// `source|python|version has_server has_kernel` for the folder's .venv / venv (and its parents), the
/// conda installs in the home folder, and python3 / python on PATH.
const FIND_SH: &str = r#"seen=" "
probe() { rp=$(readlink -f "$1" 2>/dev/null || echo "$1"); case "$seen" in *" $rp "*) return;; esac; seen="$seen$rp "; r=$("$1" -c "import sys,importlib.util as u;print(sys.version.split()[0],int(u.find_spec('jupyter_server') is not None),int(u.find_spec('ipykernel') is not None))" 2>/dev/null) && echo "$2|$1|$r"; }
d="$1"; i=0
while [ -n "$d" ] && [ "$d" != "/" ] && [ $i -lt 8 ]; do for n in .venv venv; do [ -x "$d/$n/bin/python" ] && probe "$d/$n/bin/python" venv; done; d=$(dirname "$d"); i=$((i+1)); done
for c in "$HOME/miniconda3" "$HOME/anaconda3" "$HOME/miniforge3" "$HOME/mambaforge" "$HOME"/.conda/envs/* "$HOME"/miniconda3/envs/* "$HOME"/miniforge3/envs/*; do [ -x "$c/bin/python" ] && probe "$c/bin/python" conda; done
for n in python3 python; do p=$(command -v "$n" 2>/dev/null) && probe "$p" path; done
true"#;

/// Pythons of an environment for a notebook in `dir`, in the shape of `jp_interpreters`.
#[tauri::command]
pub async fn envs_jp_interpreters(env: Env, dir: String) -> CmdResult<Value> {
    env.check()?;
    tauri::async_runtime::spawn_blocking(move || {
        let folder = folder_in_env(&env, &dir).unwrap_or_else(|_| "/".into());
        let text = exec::out(&env, "sh", &["-c", FIND_SH, "callio", &folder], None, 90).ok_or("Couldn't look for Python there. Is the environment running?")?;
        let list = parse::parse_pythons(&text);
        Ok(Value::Array(
            list.into_iter()
                .map(|p| {
                    let mut missing = Vec::new();
                    if !p.has_server {
                        missing.push("jupyter_server");
                    }
                    if !p.has_kernel {
                        missing.push("ipykernel");
                    }
                    json!({"path": p.path, "label": p.label, "version": p.version, "source": p.source, "hasServer": p.has_server, "hasKernel": p.has_kernel, "missing": missing})
                })
                .collect(),
        ))
    })
    .await
    .es()?
}

fn progress(app: &AppHandle, id: &str, text: String) {
    let _ = app.emit("jp-progress", json!({"id": id, "text": text}));
}

/// Start (or reuse) the server for `python` in the environment; `dir` is the notebook's folder as
/// the window knows it. Returns the connection and the kernel's folder relative to the server root "/".
#[tauri::command]
pub async fn envs_jp_start(app: AppHandle, env: Env, python: String, dir: String) -> CmdResult<Value> {
    env.check()?;
    if !python.starts_with('/') || python.contains('\n') {
        return Err("Choose a Python from the list.".into());
    }
    let folder = {
        let (e, d) = (env.clone(), dir.clone());
        tauri::async_runtime::spawn_blocking(move || folder_in_env(&e, &d)).await.es()??
    };
    let id = format!("{}-{}", env.kind, parse_hash(&format!("{}|{}", env.id, python)));
    let kernel_path = folder.trim_matches('/').to_string();
    let reply = |s: &Srv| json!({"id": s.id, "kind": env.kind, "baseUrl": s.base.to_string(), "root": "/", "kernelPath": kernel_path, "python": s.python});
    if let Some(s) = find(&id) {
        if s.alive() && net::rest(&s.endpoint(), "GET", "/api/status", None, 5).await.is_ok() {
            *s.idle_since.lock().unwrap() = None;
            return Ok(reply(&s));
        }
        s.kill();
        SERVERS.lock().unwrap().retain(|x| x.id != id);
    }
    ensure_watcher(app.clone());
    // where it will listen: WSL — any free Windows port (localhost forwarding); Docker — a published container port
    let (port, listen_port, ip) = match env.kind.as_str() {
        "wsl" => {
            let p = free_port()?;
            (p, p, "127.0.0.1")
        }
        _ => {
            let e = env.clone();
            let i = tauri::async_runtime::spawn_blocking(move || inspect(e.container.as_deref().unwrap_or(""))).await.es()??;
            let pair = i.ports.iter().find(|(h, _)| !port_busy(*h)).copied().ok_or("This container doesn't publish a TCP port, so Callio can't reach a Jupyter server inside it. Start the container with a published port, e.g. -p 8888:8888.")?;
            (pair.0, pair.1, "0.0.0.0")
        }
    };
    let token = crate::claude_code::mcp::random_token();
    progress(&app, &id, format!("Starting the Jupyter server in {}…", env.name));
    let args: Vec<String> = vec![
        "-m".into(), "jupyter_server".into(), "--no-browser".into(), "--allow-root".into(),
        "--ServerApp.port_retries=0".into(), format!("--ServerApp.ip={ip}"), "--ServerApp.password=".into(),
        "--ServerApp.disable_check_xsrf=False".into(), format!("--ServerApp.port={listen_port}"), "--ServerApp.root_dir=/".into(),
        // safety net: if Callio dies without stopping it, the server ends itself after 30 idle minutes
        "--ServerApp.shutdown_no_activity_timeout=1800".into(),
    ];
    let mut c = exec::command_env(&env, &python, &args, None, &[("JUPYTER_TOKEN", &token), ("PYTHONUNBUFFERED", "1"), ("PYTHONIOENCODING", "utf-8")]);
    c.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| format!("Couldn't start the command: {e}"))?;
    server::job::assign(&child);
    let log = Arc::new(Mutex::new(VecDeque::new()));
    for r in [child.stdout.take().map(|x| Box::new(x) as Box<dyn std::io::Read + Send>), child.stderr.take().map(|x| Box::new(x) as Box<dyn std::io::Read + Send>)].into_iter().flatten() {
        let keep: Arc<Mutex<VecDeque<String>>> = log.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(r).lines().map_while(Result::ok) {
                let mut k = keep.lock().unwrap();
                if k.len() >= 60 {
                    k.pop_front();
                }
                k.push_back(line.split("?token=").next().unwrap_or("").to_string());
            }
        });
    }
    let base: reqwest::Url = format!("http://127.0.0.1:{port}/").parse().es()?;
    let srv = Arc::new(Srv { id: id.clone(), env: env.clone(), python: python.clone(), base, token, child: Mutex::new(Some(child)), idle_since: Mutex::new(None) });
    let t0 = Instant::now();
    let err: String;
    loop {
        if !srv.alive() {
            err = "The server stopped right after starting.".into();
            break;
        }
        if net::rest(&srv.endpoint(), "GET", "/api/status", None, 2).await.is_ok() {
            SERVERS.lock().unwrap().push(srv.clone());
            return Ok(reply(&srv));
        }
        // a stopped distro or container needs a while to wake up
        if t0.elapsed() > Duration::from_secs(90) {
            err = "The server did not start within 90 seconds.".into();
            break;
        }
        progress(&app, &id, format!("Starting the Jupyter server in {}… {} s", env.name, t0.elapsed().as_secs()));
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let tail = log.lock().unwrap().iter().rev().take(8).rev().cloned().collect::<Vec<_>>().join("\n");
    srv.kill();
    Err(if tail.is_empty() { err } else { format!("{err}\n{tail}") })
}

fn parse_hash(s: &str) -> String {
    crate::jupyter::parse::short_hash(&s.to_lowercase())
}

#[tauri::command]
pub async fn envs_jp_stop(id: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        if let Some(s) = find(&id) {
            s.kill();
        }
        SERVERS.lock().unwrap().retain(|x| x.id != id);
    })
    .await;
}

#[tauri::command]
pub fn envs_jp_list() -> Value {
    json!(SERVERS.lock().unwrap().iter().map(|s| json!({"id": s.id, "kind": s.env.kind, "baseUrl": s.base.to_string(), "python": s.python, "env": s.env.id})).collect::<Vec<_>>())
}

/// `python -m pip install jupyter_server ipykernel` in the environment; progress as `jp-log` events.
#[tauri::command]
pub async fn envs_jp_install(app: AppHandle, env: Env, python: String, id: String) -> CmdResult<i32> {
    env.check()?;
    if !python.starts_with('/') {
        return Err("Choose a Python from the list.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let c = exec::command_env(&env, &python, &["-m".into(), "pip".into(), "install".into(), "jupyter_server".into(), "ipykernel".into()], None, &[("PYTHONUNBUFFERED", "1")]);
        let code = exec::stream(c, |l| {
            let _ = app.emit("jp-log", json!({"id": id, "line": l}));
        })?;
        let _ = app.emit("jp-log", json!({"id": id, "done": true, "code": code}));
        Ok(code)
    })
    .await
    .es()?
}

/// Create `.venv` in the notebook's folder and install the two packages there (modern Ubuntu
/// refuses `pip install` into the system Python). `$1` = the folder, passed as an argument.
const VENV_SH: &str = r#"cd "$1" && python3 -m venv .venv && .venv/bin/python -m pip install jupyter_server ipykernel"#;

#[tauri::command]
pub async fn envs_jp_venv(app: AppHandle, env: Env, dir: String, id: String) -> CmdResult<i32> {
    env.check()?;
    tauri::async_runtime::spawn_blocking(move || {
        let folder = folder_in_env(&env, &dir)?;
        let c = exec::command_env(&env, "sh", &["-c".into(), VENV_SH.into(), "callio".into(), folder], None, &[("PYTHONUNBUFFERED", "1")]);
        let code = exec::stream(c, |l| {
            let _ = app.emit("jp-log", json!({"id": id, "line": l}));
        })?;
        let _ = app.emit("jp-log", json!({"id": id, "done": true, "code": code}));
        Ok(code)
    })
    .await
    .es()?
}

static WATCHER: std::sync::Once = std::sync::Once::new();
/// Every 30 s: a server with no kernels for the same number of minutes the local ones use is stopped.
fn ensure_watcher(app: AppHandle) {
    WATCHER.call_once(|| {
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let idle = server::IDLE_MIN.load(Ordering::Relaxed);
                let all: Vec<_> = SERVERS.lock().unwrap().clone();
                for s in all {
                    if !s.alive() {
                        SERVERS.lock().unwrap().retain(|x| x.id != s.id);
                        let _ = app.emit("jp-server-gone", json!({"id": s.id}));
                        continue;
                    }
                    let n = net::rest(&s.endpoint(), "GET", "/api/kernels", None, 5).await.ok().and_then(|v| v.as_array().map(|a| a.len()));
                    match n {
                        Some(0) => {
                            let since = *s.idle_since.lock().unwrap().get_or_insert_with(Instant::now);
                            if idle > 0 && since.elapsed() >= Duration::from_secs(idle * 60) {
                                s.kill();
                                SERVERS.lock().unwrap().retain(|x| x.id != s.id);
                                let _ = app.emit("jp-server-gone", json!({"id": s.id}));
                            }
                        }
                        Some(_) => *s.idle_since.lock().unwrap() = None,
                        None => {}
                    }
                }
            }
        });
    });
}
