//! Remote Linux servers over SSH: connections, linked folders that stay in sync, Jupyter on the
//! server, and the AI working there. The work is in the Tauri-free core modules below (tested
//! against a real sshd); this file connects them to the app: commands, events, the Credential
//! Manager, the Recycle Bin, the file watcher.
pub mod claude;
pub mod config;
pub mod conn;
pub mod decide;
pub mod env;
pub mod jup;
pub mod mcp;
pub mod nbmerge;
pub mod remote;
pub mod rules;
pub mod sync;

use crate::util::CmdResult;
#[cfg(not(windows))]
use crate::util::ErrStr;
use config::HostCfg;
use conn::Hub;
use env::Env;
use jup::JupMgr;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use sync::{LinkCfg, SyncMgr};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

pub struct Rt {
    pub app: AppHandle,
    pub env: Env,
    pub hub: Arc<Hub>,
    pub sync: Arc<SyncMgr>,
    pub jup: Arc<JupMgr>,
    watchers: Mutex<HashMap<String, notify::RecommendedWatcher>>,
    notes: Mutex<Vec<String>>,
}

static RT: OnceLock<Rt> = OnceLock::new();
static ASKS: Mutex<Option<HashMap<String, oneshot::Sender<Option<Value>>>>> = Mutex::new(None);

pub fn rt() -> CmdResult<&'static Rt> {
    RT.get().ok_or_else(|| "Remote servers are not ready yet.".to_string())
}

fn home_ssh() -> PathBuf {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default();
    home.join(".ssh")
}

#[cfg(windows)]
fn trash_local(p: &Path) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::{SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW};
    let mut from: Vec<u16> = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf()).to_string_lossy().encode_utf16().collect();
    from.extend([0, 0]);
    let mut op: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
    op.wFunc = FO_DELETE;
    op.pFrom = from.as_ptr();
    op.fFlags = (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT | 0x4000) as u16;
    let r = unsafe { SHFileOperationW(&mut op) };
    if r != 0 || op.fAnyOperationsAborted != 0 {
        return Err(format!("Could not move {} to the Recycle Bin (error {r:#x}). Is the file open in another program?", p.display()));
    }
    Ok(())
}
#[cfg(not(windows))]
fn trash_local(p: &Path) -> Result<(), String> {
    // development builds on Linux
    let bin = std::env::var("HOME").map(|h| PathBuf::from(h).join(".local/share/Trash/files")).es()?;
    std::fs::create_dir_all(&bin).es()?;
    let to = bin.join(format!("{}-{}", remote::rand_hex(3), p.file_name().unwrap_or_default().to_string_lossy()));
    std::fs::rename(p, to).es()
}

fn delete_secret(key: &str) {
    if let Ok(e) = keyring::Entry::new(crate::settings::SERVICE, key) {
        let _ = e.delete_credential();
    }
}

fn make_env(app: &AppHandle) -> Env {
    let a1 = app.clone();
    let a2 = app.clone();
    Env {
        emit: Arc::new(move |n, v| {
            let _ = a1.emit(n, v);
        }),
        ask: Arc::new(move |kind, payload| {
            let app = a2.clone();
            Box::pin(async move {
                let id = remote::rand_hex(8);
                let (tx, rx) = oneshot::channel();
                ASKS.lock().unwrap().get_or_insert_with(HashMap::new).insert(id.clone(), tx);
                let mut p = payload;
                p["id"] = json!(id);
                p["kind"] = json!(kind);
                let _ = app.emit("ssh-ask", p);
                let r = tokio::time::timeout(Duration::from_secs(900), rx).await;
                ASKS.lock().unwrap().get_or_insert_with(HashMap::new).remove(&id);
                match r {
                    Ok(Ok(v)) => v,
                    _ => None,
                }
            })
        }),
        secret_get: Arc::new(|k| crate::settings::get_secret_value(k)),
        secret_set: Arc::new(|k, v| {
            if v.is_empty() {
                delete_secret(k)
            } else {
                crate::settings::put_secret_value(k, v)
            }
        }),
        data_dir: crate::settings::category_dir(app, "sync"),
        ssh_dir: home_ssh(),
        trash: Arc::new(trash_local),
    }
}

/// Called once at start-up.
pub fn init(app: &AppHandle) {
    let env = make_env(app);
    let hub = Hub::new(env.clone());
    let sync = SyncMgr::new(env.clone(), hub.clone());
    let jup = JupMgr::new(hub.clone());
    let _ = RT.set(Rt { app: app.clone(), env, hub, sync, jup, watchers: Mutex::new(HashMap::new()), notes: Mutex::new(vec![]) });
}

/// Called when Callio exits: stop what we started on servers, close connections.
pub fn on_exit() {
    if let Ok(r) = rt() {
        r.sync.stop_all();
        tauri::async_runtime::block_on(async {
            let _ = tokio::time::timeout(Duration::from_secs(8), async {
                r.jup.stop_all().await;
                r.hub.disconnect_all().await;
            })
            .await;
        });
    }
}

// ---------------------------------------------------------------- answers to questions
#[tauri::command]
pub fn ssh_answer(id: String, value: Option<Value>) {
    if let Some(tx) = ASKS.lock().unwrap().as_mut().and_then(|m| m.remove(&id)) {
        let _ = tx.send(value);
    }
}

// ---------------------------------------------------------------- hosts
/// Tell the backend which servers the author added in Callio; get back every server (those from
/// `~/.ssh/config` too) and what was skipped.
#[tauri::command]
pub fn ssh_set_hosts(stored: Vec<HostCfg>) -> CmdResult<Value> {
    let r = rt()?;
    let parsed = config::load(&r.env.ssh_dir);
    let merged = config::merge(parsed.hosts, stored);
    r.hub.set_hosts(merged.clone());
    *r.notes.lock().unwrap() = parsed.notes.clone();
    Ok(json!({"hosts": merged, "notes": parsed.notes, "sshDir": r.env.ssh_dir.to_string_lossy(), "states": r.hub.states()}))
}

#[tauri::command]
pub fn ssh_states() -> CmdResult<Value> {
    Ok(rt()?.hub.states())
}

#[tauri::command]
pub async fn ssh_connect(host: String) -> CmdResult<Value> {
    let r = rt()?;
    r.hub.session(&host, true).await?;
    Ok(json!({"ok": true}))
}

#[tauri::command]
pub async fn ssh_disconnect(host: String) -> CmdResult<()> {
    let r = rt()?;
    r.hub.disconnect(&host).await;
    Ok(())
}

#[tauri::command]
pub fn ssh_forget(host: String) -> CmdResult<()> {
    let r = rt()?;
    let cfg = r.hub.cfg(&host)?;
    conn::forget_secrets(&r.env, &cfg);
    Ok(())
}

/// What a server offers: system, Python, Jupyter, Claude Code, rsync, SFTP.
#[tauri::command]
pub async fn ssh_test(host: String) -> CmdResult<Value> {
    let r = rt()?;
    let sess = r.hub.session(&host, true).await?;
    let script = "uname -sr 2>/dev/null; (. /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\"); echo ---; for c in python3 rsync find sha256sum tar; do command -v $c >/dev/null 2>&1 && echo \"has:$c\"; done; python3 -c 'import importlib.util as u;print(\"has:jupyter_server\" if u.find_spec(\"jupyter_server\") else \"no:jupyter_server\");print(\"has:ipykernel\" if u.find_spec(\"ipykernel\") else \"no:ipykernel\")' 2>/dev/null";
    let o = sess.exec(&format!("sh -c {}", config::sh_quote(script)), None, Duration::from_secs(40)).await?;
    let t = o.text();
    let (head, tail) = t.split_once("---\n").unwrap_or((&t, ""));
    let mut hl = head.lines();
    let kernel = hl.next().unwrap_or("").to_string();
    let os = hl.next().unwrap_or("").to_string();
    let has = |n: &str| tail.lines().any(|l| l.trim() == format!("has:{n}"));
    let cl = claude::find_claude(&sess).await;
    let sftp = sess.sftp().await.is_ok();
    Ok(json!({"ok": true, "kernel": kernel, "os": if os.is_empty() { kernel.clone() } else { os }, "python3": has("python3"), "jupyterServer": has("jupyter_server"), "ipykernel": has("ipykernel"), "rsync": has("rsync"), "claude": !cl.is_empty(), "claudePath": cl, "sftp": sftp, "find": has("find"), "sha256": has("sha256sum")}))
}

#[tauri::command]
pub async fn ssh_list_dir(host: String, path: Option<String>) -> CmdResult<Value> {
    let r = rt()?;
    let sess = r.hub.session(&host, true).await?;
    let rem = remote::Remote::bare(sess, "/");
    let p = match path.filter(|p| !p.is_empty()) {
        Some(p) => p,
        None => rem.home().await,
    };
    let items = rem.list(&p).await?;
    Ok(json!({"path": p, "items": items}))
}

#[tauri::command]
pub async fn ssh_mkdir(host: String, path: String) -> CmdResult<()> {
    let r = rt()?;
    let sess = r.hub.session(&host, true).await?;
    remote::Remote::bare(sess, "/").mkdir_p(&path).await
}

// ---------------------------------------------------------------- linked folders
fn watch_local(r: &'static Rt, link: Arc<sync::Link>, local: &str) {
    use notify::{RecursiveMode, Watcher};
    let l2 = link.clone();
    let w = notify::recommended_watcher(move |ev: notify::Result<notify::Event>| {
        if let Ok(ev) = ev {
            if matches!(ev.kind, notify::EventKind::Access(_)) {
                return;
            }
            let noisy = ev.paths.iter().all(|p| {
                let s = p.to_string_lossy();
                s.contains(".callio-") || s.contains("/.git/") || s.contains("\\.git\\") || s.contains("node_modules") || s.contains("__pycache__")
            });
            if !noisy {
                l2.poke();
            }
        }
    });
    if let Ok(mut w) = w {
        if w.watch(Path::new(local), RecursiveMode::Recursive).is_ok() {
            r.watchers.lock().unwrap().insert(link.id.clone(), w);
        }
    }
}

#[tauri::command]
pub async fn ssh_sync_start(link: LinkCfg) -> CmdResult<Value> {
    let r = rt()?;
    if !Path::new(&link.local).is_dir() {
        return Err(format!("The folder {} does not exist on this computer.", link.local));
    }
    let l = r.sync.start(link.clone());
    if !r.watchers.lock().unwrap().contains_key(&link.id) {
        watch_local(r, l.clone(), &link.local);
    }
    Ok(json!(l.status()))
}

#[tauri::command]
pub fn ssh_sync_stop(id: String, forget: Option<bool>) -> CmdResult<()> {
    let r = rt()?;
    r.watchers.lock().unwrap().remove(&id);
    r.sync.stop(&id, forget.unwrap_or(false));
    Ok(())
}

#[tauri::command]
pub fn ssh_sync_status(id: Option<String>) -> CmdResult<Value> {
    let r = rt()?;
    match id {
        Some(i) => Ok(json!(r.sync.get(&i).map(|l| l.status()))),
        None => Ok(Value::Object(r.sync.all().into_iter().map(|l| (l.id.clone(), json!(l.status()))).collect())),
    }
}

#[tauri::command]
pub fn ssh_sync_now(id: String, allow_mass: Option<bool>) -> CmdResult<()> {
    let r = rt()?;
    r.sync.get(&id).ok_or("This folder link is not running.")?.now(allow_mass.unwrap_or(false));
    Ok(())
}

#[tauri::command]
pub fn ssh_sync_pause(id: String, paused: bool) -> CmdResult<()> {
    let r = rt()?;
    r.sync.get(&id).ok_or("This folder link is not running.")?.set_paused(paused);
    Ok(())
}

#[tauri::command]
pub fn ssh_sync_resolve(id: String, rel: String, choice: String) -> CmdResult<()> {
    let r = rt()?;
    r.sync.get(&id).ok_or("This folder link is not running.")?.resolve(&rel, &choice);
    Ok(())
}

/// Files with unsaved changes in an open tab: not synced until saved.
#[tauri::command]
pub fn ssh_sync_hold(id: String, rels: Vec<String>) -> CmdResult<()> {
    if let Some(l) = rt()?.sync.get(&id) {
        l.set_hold(rels);
    }
    Ok(())
}

/// The version of a file both sides last agreed on (text files up to 2 MB): the undo point.
#[tauri::command]
pub fn ssh_sync_base(id: String, rel: String) -> CmdResult<Option<String>> {
    Ok(rt()?.sync.get(&id).and_then(|l| l.base_text(&rel)))
}

/// A link's folders and the other side's state, so the window can offer Compare for a conflict.
#[tauri::command]
pub async fn ssh_sync_remote_read(id: String, rel: String) -> CmdResult<String> {
    let r = rt()?;
    let l = r.sync.get(&id).ok_or("This folder link is not running.")?;
    let c = l.cfg();
    let sess = r.hub.session(&c.host, false).await?;
    let b = remote::Remote::bare(sess, &c.remote).read(&rel, 8 << 20).await?;
    Ok(String::from_utf8_lossy(&b).to_string())
}

// ---------------------------------------------------------------- Jupyter
#[tauri::command]
pub async fn ssh_py_list(host: String, remote_root: Option<String>) -> CmdResult<Value> {
    let r = rt()?;
    let sess = r.hub.session(&host, true).await?;
    Ok(json!(jup::pythons(&sess, remote_root.as_deref()).await?))
}

#[tauri::command]
pub async fn ssh_pip_install(app: AppHandle, host: String, python: String, id: String) -> CmdResult<i32> {
    let r = rt()?;
    let sess = r.hub.session(&host, true).await?;
    let a2 = app.clone();
    let id2 = id.clone();
    let code = jup::exec_lines(&sess, &format!("{} -m pip install jupyter_server ipykernel 2>&1", config::sh_quote(&python)), &move |l| {
        let _ = a2.emit("jp-log", json!({"id": id2, "line": l}));
    })
    .await?;
    let _ = app.emit("jp-log", json!({"id": id, "done": true, "code": code}));
    Ok(code as i32)
}

/// Start (or reuse) a Jupyter server on the server. `remote_root` is the linked folder's server
/// side; `nb_dir` the notebook's folder relative to it.
#[tauri::command]
pub async fn ssh_jp_start(app: AppHandle, host: String, python: String, remote_root: String, nb_dir: Option<String>, idle_min: Option<u64>) -> CmdResult<Value> {
    let r = rt()?;
    let a2 = app.clone();
    let s = r.jup.start(&host, &python, &remote_root, idle_min.unwrap_or(10), &move |m| {
        let _ = a2.emit("jp-progress", json!({"text": m}));
    })
    .await?;
    Ok(json!({"id": s.id, "kind": "ssh", "baseUrl": "", "root": s.root, "kernelPath": nb_dir.unwrap_or_default().trim_matches('/')}))
}

/// "Connect to a Jupyter that already runs on the server": forward its port.
#[tauri::command]
pub async fn ssh_jp_forward(host: String, url: String, token: Option<String>) -> CmdResult<Value> {
    let r = rt()?;
    let (h, p, t) = jup::parse_url(&url)?;
    let token = token.filter(|t| !t.is_empty()).unwrap_or(t);
    let s = r.jup.forward_existing(&host, &h, p, &token).await?;
    Ok(json!({"id": s.id, "kind": "ssh", "baseUrl": ""}))
}

#[tauri::command]
pub async fn ssh_jp_stop(id: String) -> CmdResult<()> {
    rt()?.jup.stop(&id).await;
    Ok(())
}

#[tauri::command]
pub fn ssh_jp_list() -> CmdResult<Value> {
    Ok(json!(rt()?.jup.list()))
}

/// The seam for `jupyter::ConnSpec::endpoint`: where a tunnelled server answers.
pub fn jupyter_endpoint(id: &str) -> Option<(String, String)> {
    RT.get().and_then(|r| r.jup.endpoint(id))
}

// ---------------------------------------------------------------- Claude Code on the server
/// Is Claude Code on the server, and where?
#[tauri::command]
pub async fn ssh_claude_info(host: String) -> CmdResult<Value> {
    let r = rt()?;
    let sess = r.hub.session(&host, true).await?;
    let p = claude::find_claude(&sess).await;
    Ok(json!({"installed": !p.is_empty(), "path": p, "installCommand": INSTALL_CMD}))
}

pub const INSTALL_CMD: &str = "curl -fsSL https://claude.ai/install.sh | bash";

/// Install Claude Code on the server (only when the author clicks); the log arrives as `jp-log`-style `ssh-log` events.
#[tauri::command]
pub async fn ssh_claude_install(app: AppHandle, host: String, id: String) -> CmdResult<i32> {
    let r = rt()?;
    let sess = r.hub.session(&host, true).await?;
    let a2 = app.clone();
    let id2 = id.clone();
    let code = jup::exec_lines(&sess, &format!("bash -lc {} 2>&1", config::sh_quote(INSTALL_CMD)), &move |l| {
        let _ = a2.emit("ssh-log", json!({"id": id2, "line": l}));
    })
    .await?;
    let _ = app.emit("ssh-log", json!({"id": id, "done": true, "code": code}));
    Ok(code as i32)
}

/// What a session needs to run Claude Code on a server (see `claude_code/session.rs`): the
/// process with its pipes. Blocking: called from the session manager's threads.
pub struct RemoteSpawn {
    pub proc: Arc<claude::RemoteProc>,
    pub io: claude::Io,
}

pub fn spawn_claude_blocking(host: &str, remote_cwd: &str, system_text: &str, build_args: &dyn Fn(&str, &str) -> Vec<String>, mcp_local_addr: &str, mcp_cfg_body: Value) -> Result<RemoteSpawn, String> {
    let r = rt()?;
    let host = host.to_string();
    let cwd = remote_cwd.to_string();
    let sys_text = system_text.to_string();
    let addr = mcp_local_addr.to_string();
    let args_fn = build_args;
    tauri::async_runtime::block_on(async move {
        let sess = r.hub.session(&host, false).await?;
        let exe = claude::find_claude(&sess).await;
        if exe.is_empty() {
            return Err("Claude Code is not installed on this server. Install it from the session menu or choose \"This computer\".".to_string());
        }
        let rport = sess.reverse_forward(addr).await?;
        // the tool server's address as the server sees it
        let mut body = mcp_cfg_body;
        let url = body["mcpServers"]["callio"]["url"].as_str().unwrap_or("").to_string();
        let tail = url.splitn(4, '/').nth(3).unwrap_or("");
        body["mcpServers"]["callio"]["url"] = json!(format!("http://127.0.0.1:{rport}/{tail}"));
        let cfg_path = claude::put_private(&sess, "mcp.json", serde_json::to_vec_pretty(&body).unwrap_or_default().as_slice()).await?;
        let sys_path = claude::put_private(&sess, "system.md", sys_text.as_bytes()).await?;
        let args = args_fn(&cfg_path, &sys_path);
        let (mut proc, io) = claude::spawn(sess.clone(), &cwd, &exe, &args, &[("CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS", "1")]).await?;
        proc.files = vec![cfg_path, sys_path];
        proc.rport = Some(rport);
        Ok(RemoteSpawn { proc: Arc::new(proc), io })
    })
}

/// Before the changes of a turn are compared: ask the sync to bring what Claude Code did on the
/// server to this computer, and wait a little.
pub fn sync_for_turn(local_dir: &str) {
    let Ok(r) = rt() else { return };
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let want = norm(local_dir);
    let link = r.sync.all().into_iter().find(|l| {
        let c = norm(&l.cfg().local);
        want == c || want.starts_with(&format!("{c}/"))
    });
    let Some(l) = link else { return };
    let r0 = l.status().rounds;
    l.now(false);
    let t = std::time::Instant::now();
    while l.status().rounds < r0 + 2 && t.elapsed() < Duration::from_secs(25) {
        std::thread::sleep(Duration::from_millis(150));
    }
}

/// The folder-link that holds `local_dir`, and the matching folder on the server.
pub fn remote_of(local_dir: &str, host: &str) -> Option<(String, String)> {
    let r = rt().ok()?;
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_string();
    let want = norm(local_dir);
    for l in r.sync.all() {
        let c = l.cfg();
        if c.host != host {
            continue;
        }
        let base = norm(&c.local);
        if want.to_lowercase() == base.to_lowercase() {
            return Some((c.id, c.remote));
        }
        if want.len() > base.len() && want[..base.len()].to_lowercase() == base.to_lowercase() && want.as_bytes()[base.len()] == b'/' {
            return Some((c.id, format!("{}/{}", c.remote.trim_end_matches('/'), &want[base.len() + 1..])));
        }
    }
    None
}

/// A server's display name for text shown to the model.
pub fn host_label(id: &str) -> String {
    rt().ok().and_then(|r| r.hub.cfg(id).ok()).map(|c| c.label()).unwrap_or_else(|| id.to_string())
}

/// The sentence for the system prompt when the open folder is mirrored on a server (empty when not).
#[tauri::command]
pub fn ssh_prompt_note(dir: String) -> String {
    mcp::prompt_note(&dir).unwrap_or_default()
}
