//! Running notebooks. One client for every case: the Jupyter Server REST API and the kernel
//! channels WebSocket (never ZMQ). A "connection" is `{id, kind, baseUrl, fingerprint}`:
//!   local — a hidden jupyter_server Callio started from the author's own Python
//!   url   — a server the author typed (URL + token; the token is in Credential Manager)
//! and the SSH track adds a third kind that yields a local URL + token through a tunnel: only
//! `ConnSpec::endpoint` needs a new arm. The window speaks the Jupyter messaging protocol; this
//! side only carries the JSON frames (events `jp-msg`, `jp-ws`) and does REST calls, so the
//! token never leaves Rust.
pub mod mcp;
pub(crate) mod net;
pub mod parse;
mod pyenv;
pub(crate) mod server;

use crate::util::{CmdResult, ErrStr};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConnSpec {
    pub id: String,
    /// "local" | "url" | "ssh"
    pub kind: String,
    #[serde(default)]
    pub base_url: String,
    /// Pinned certificate fingerprint (SHA-256 hex) for self-signed HTTPS.
    #[serde(default)]
    pub fingerprint: Option<String>,
}

pub fn secret_key(id: &str) -> String {
    format!("callio-jupyter-{id}")
}

impl ConnSpec {
    /// Where to talk and with which token. The one place a new kind of connection plugs in.
    pub async fn endpoint(&self) -> CmdResult<net::Endpoint> {
        match self.kind.as_str() {
            "local" => server::find(&self.id).map(|l| l.endpoint()).ok_or_else(|| "The local Jupyter server is not running. Pick the kernel again.".to_string()),
            "url" => {
                let base = normalize_url(&self.base_url)?;
                let token = crate::settings::get_secret_value(&secret_key(&self.id)).unwrap_or_default();
                Ok(net::Endpoint { base, token, pin: self.fingerprint.clone().filter(|f| !f.is_empty()), id: self.id.clone() })
            }
            // [wsl] a server started inside a WSL distro or a Docker container (envs/jupyter.rs)
            "wsl" | "docker" => crate::envs::jupyter::endpoint(&self.id).ok_or_else(|| "The Jupyter server in that environment is not running. Pick the kernel again.".to_string()),
            // a Jupyter server on a remote computer, reached through an SSH tunnel (the ssh feature)
            "ssh" => {
                let (u, token) = crate::ssh::jupyter_endpoint(&self.id).ok_or_else(|| "The connection to the server ended. Pick the kernel again.".to_string())?;
                Ok(net::Endpoint { base: normalize_url(&u)?, token, pin: None, id: self.id.clone() })
            }
            k => Err(format!("Unknown connection kind: {k}")),
        }
    }
}

/// `http(s)://host:port[/base]` → the same with a trailing slash, without query or fragment.
fn normalize_url(s: &str) -> CmdResult<reqwest::Url> {
    let mut u: reqwest::Url = s.trim().parse().map_err(|_| "That is not a valid address. Use http://host:port or https://host:port.".to_string())?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err("The address must start with http:// or https://".into());
    }
    u.set_query(None);
    u.set_fragment(None);
    if !u.path().ends_with('/') {
        let p = format!("{}/", u.path());
        u.set_path(&p);
    }
    Ok(u)
}

// ---------------- environments and local servers ----------------
#[tauri::command]
pub async fn jp_interpreters(dir: String) -> CmdResult<Vec<pyenv::Interp>> {
    tauri::async_runtime::spawn_blocking(move || pyenv::discover(&dir)).await.es()
}

/// Install the two packages into one interpreter; progress as `jp-log` events {id, line | done, code}.
#[tauri::command]
pub async fn jp_pip_install(app: AppHandle, python: String, id: String) -> CmdResult<i32> {
    tauri::async_runtime::spawn_blocking(move || server::pip_install(&app, &python, &id)).await.es()?
}

/// Start (or reuse) the local server for `python`; `dir` is the notebook's folder. Returns the
/// connection and the kernel's working folder relative to the server root.
#[tauri::command]
pub async fn jp_local_start(app: AppHandle, python: String, dir: String) -> CmdResult<Value> {
    let root = parse::server_root(&dir);
    let l = server::start(&app, &python, &root).await?;
    Ok(json!({"id": l.id, "kind": "local", "baseUrl": l.base_url, "root": l.root, "kernelPath": parse::rel_to_root(&l.root, &dir)}))
}

#[tauri::command]
pub fn jp_local_stop(id: String) {
    server::stop(&id);
}
#[tauri::command]
pub fn jp_local_list() -> Value {
    json!(server::list())
}
#[tauri::command]
pub fn jp_set_idle(minutes: u64) {
    server::IDLE_MIN.store(minutes, std::sync::atomic::Ordering::Relaxed);
}
/// Stop every local server (also happens when Callio exits: they are in a Job object).
#[tauri::command]
pub fn jp_shutdown() {
    server::stop_all();
    crate::envs::jupyter::stop_all(); // [wsl]
}

// ---------------- remote servers ----------------
/// Try a URL + token: server version and kernelspecs. A certificate that isn't trusted comes back
/// as `{ok:false, cert:{fingerprint}}` so the window can ask whether to pin it.
#[tauri::command]
pub async fn jp_test(url: String, token: String, fingerprint: Option<String>) -> CmdResult<Value> {
    let base = normalize_url(&url)?;
    let ep = net::Endpoint { base: base.clone(), token, pin: fingerprint.filter(|f| !f.is_empty()), id: "test".into() };
    let st = match net::rest(&ep, "GET", "/api/status", None, 15).await {
        Ok(v) => v,
        Err(e) if ep.pin.is_none() && parse::is_cert_error(&e) && base.scheme() == "https" => {
            let fp = net::probe_fingerprint(&base).await?;
            return Ok(json!({"ok": false, "cert": {"fingerprint": fp, "message": e}}));
        }
        Err(e) if e.starts_with("HTTP 403") || e.starts_with("HTTP 401") => return Err("The server refused the token. Check it and try again.".into()),
        Err(e) => return Err(if parse::is_cert_error(&e) { "The server's certificate does not match the one you trusted.".into() } else { e }),
    };
    let specs = net::rest(&ep, "GET", "/api/kernelspecs", None, 15).await.unwrap_or(Value::Null);
    let version = net::rest(&ep, "GET", "/api/", None, 15).await.ok().and_then(|v| v["version"].as_str().map(String::from));
    Ok(json!({"ok": true, "baseUrl": base.as_str(), "version": version, "status": st, "kernelspecs": specs}))
}

#[tauri::command]
pub async fn jp_rest(conn: ConnSpec, method: String, path: String, body: Option<Value>, timeout_s: Option<u64>) -> CmdResult<Value> {
    let ep = conn.endpoint().await?;
    net::rest(&ep, &method, &path, body.as_ref(), timeout_s.unwrap_or(30)).await
}

// ---------------- kernel channels ----------------
type Sender = tokio::sync::mpsc::UnboundedSender<String>;
static WS: Mutex<Option<HashMap<String, (Sender, tauri::async_runtime::JoinHandle<()>)>>> = Mutex::new(None);

/// Open the kernel's channels; every incoming frame becomes a `jp-msg` {key, msg} event and the
/// end of the socket a `jp-ws` {key, state:"closed"} event. `key` is the window's session id.
#[tauri::command]
pub async fn jp_ws_open(app: AppHandle, conn: ConnSpec, kernel: String, key: String) -> CmdResult<()> {
    jp_ws_close(key.clone());
    let ep = conn.endpoint().await?;
    let (tx, mut rx, h) = net::ws_open(&ep, &kernel, &key).await?;
    let k = key.clone();
    let fwd = tauri::async_runtime::spawn(async move {
        while let Some(m) = rx.recv().await {
            let _ = app.emit("jp-msg", json!({"key": k, "msg": m}));
        }
        let _ = app.emit("jp-ws", json!({"key": k, "state": "closed"}));
    });
    // one handle that ends both tasks
    let both = tauri::async_runtime::spawn(async move {
        let _ = h.await;
        let _ = fwd.await;
    });
    WS.lock().unwrap().get_or_insert_with(HashMap::new).insert(key, (tx, both));
    Ok(())
}

#[tauri::command]
pub fn jp_ws_send(key: String, msg: Value) -> CmdResult<()> {
    let tx = WS.lock().unwrap().as_ref().and_then(|m| m.get(&key)).map(|(t, _)| t.clone()).ok_or_else(|| "The kernel connection is closed.".to_string())?;
    tx.send(msg.to_string()).map_err(|_| "The kernel connection is closed.".to_string())
}

#[tauri::command]
pub fn jp_ws_close(key: String) {
    if let Some((tx, h)) = WS.lock().unwrap().as_mut().and_then(|m| m.remove(&key)) {
        drop(tx); // lets the socket task send a Close frame and end
        let _ = h; // the task ends on its own
    }
}
