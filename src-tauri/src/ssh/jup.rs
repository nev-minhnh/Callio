//! Jupyter on a server, reached through the SSH connection (never an open port on the network):
//!  - find Pythons on the server and which have jupyter_server + ipykernel,
//!  - start a Jupyter server there (token fed through stdin, never on a command line) and forward
//!    a local port to it,
//!  - or forward a port to a Jupyter server that is already running there (URL + token).
//! The Jupyter client only sees `http://127.0.0.1:<port>/` and a token.
use super::config::{sh_path, sh_quote};
use super::conn::{forward_local, Forward, Hub, Session};
use super::remote::rand_hex;
use russh::ChannelMsg;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Py {
    pub path: String,
    pub label: String,
    pub version: String,
    pub has_server: bool,
    pub has_kernel: bool,
    pub missing: Vec<String>,
}

const PROBE: &str = "import sys,importlib.util as u;f=lambda m:int(u.find_spec(m) is not None);print('PY|%s|%d.%d.%d|%d|%d|%s'%(sys.executable,sys.version_info[0],sys.version_info[1],sys.version_info[2],f('jupyter_server'),f('ipykernel'),sys.prefix))";

/// Pythons on the server: PATH, `~/.venv`, the linked folder's `.venv`/`venv`, conda/mamba bases and envs.
pub async fn pythons(sess: &Session, remote_root: Option<&str>) -> Result<Vec<Py>, String> {
    let root = remote_root.map(|r| r.trim_end_matches('/')).unwrap_or("");
    let mut cands = String::new();
    if !root.is_empty() {
        for d in [".venv", "venv"] {
            cands.push_str(&format!(" {}/{d}/bin/python", sh_path(root)));
        }
    }
    let script = format!(
        "for p in $(command -v python3 python 2>/dev/null) $(which -a python3 2>/dev/null) \"$HOME/.venv/bin/python\"{cands} \"$HOME\"/miniconda3/bin/python \"$HOME\"/anaconda3/bin/python \"$HOME\"/miniforge3/bin/python \"$HOME\"/mambaforge/bin/python /opt/conda/bin/python /usr/bin/python3 /usr/local/bin/python3 \"$HOME\"/miniconda3/envs/*/bin/python \"$HOME\"/anaconda3/envs/*/bin/python \"$HOME\"/miniforge3/envs/*/bin/python \"$HOME\"/.conda/envs/*/bin/python; do [ -x \"$p\" ] && echo \"$p\"; done | awk '!s[$0]++' | while read -r p; do timeout 15 \"$p\" -c {} 2>/dev/null; done",
        sh_quote(PROBE)
    );
    let o = sess.exec(&format!("sh -c {}", sh_quote(&script)), None, Duration::from_secs(90)).await?;
    let mut seen = std::collections::HashSet::new();
    let mut out = vec![];
    for l in o.text().lines() {
        let p: Vec<&str> = l.trim().split('|').collect();
        if p.len() != 6 || p[0] != "PY" || !seen.insert(p[5].to_string()) {
            continue;
        }
        let (hs, hk) = (p[3] == "1", p[4] == "1");
        let mut missing = vec![];
        if !hs {
            missing.push("jupyter_server".to_string());
        }
        if !hk {
            missing.push("ipykernel".to_string());
        }
        let env = if p[1].contains("/envs/") { p[1].split("/envs/").nth(1).and_then(|x| x.split('/').next()).map(|e| format!(" (conda {e})")).unwrap_or_default() } else if p[1].contains("/.venv/") || p[1].contains("/venv/") { " (venv)".to_string() } else if p[1].contains("conda") { " (conda)".to_string() } else { String::new() };
        out.push(Py { path: p[1].into(), label: format!("Python {}{}", p[2], env), version: p[2].into(), has_server: hs, has_kernel: hk, missing });
    }
    Ok(out)
}

/// Run a command on the server and hand every output line to `on_line` (pip install log).
pub async fn exec_lines(sess: &Session, cmd: &str, on_line: &(dyn Fn(String) + Send + Sync)) -> Result<u32, String> {
    let mut ch = sess.exec_stream(cmd).await?;
    let mut buf: Vec<u8> = vec![];
    let mut code = 0;
    while let Some(m) = ch.wait().await {
        match m {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                buf.extend_from_slice(&data);
                while let Some(i) = buf.iter().position(|b| *b == b'\n' || *b == b'\r') {
                    let l: Vec<u8> = buf.drain(..=i).collect();
                    let t = String::from_utf8_lossy(&l).trim_end().to_string();
                    if !t.is_empty() {
                        on_line(t);
                    }
                }
            }
            ChannelMsg::ExitStatus { exit_status } => code = exit_status,
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    if !buf.is_empty() {
        on_line(String::from_utf8_lossy(&buf).trim_end().to_string());
    }
    Ok(code)
}

pub struct JupSrv {
    pub id: String,
    pub host: String,
    pub root: String,
    pub python: String,
    pub pid: Option<u32>,
    pub local_port: u16,
    pub token: String,
    _fwd: Forward,
    stop: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

pub struct JupMgr {
    hub: Arc<Hub>,
    servers: Mutex<HashMap<String, Arc<JupSrv>>>,
}

impl JupMgr {
    pub fn new(hub: Arc<Hub>) -> Arc<JupMgr> {
        Arc::new(JupMgr { hub, servers: Mutex::new(HashMap::new()) })
    }
    pub fn get(&self, id: &str) -> Option<Arc<JupSrv>> {
        self.servers.lock().unwrap().get(id).cloned()
    }
    /// `(base url, token)` for the Jupyter client.
    pub fn endpoint(&self, id: &str) -> Option<(String, String)> {
        self.get(id).map(|s| (format!("http://127.0.0.1:{}/", s.local_port), s.token.clone()))
    }
    pub fn list(&self) -> Vec<serde_json::Value> {
        self.servers.lock().unwrap().values().map(|s| serde_json::json!({"id": s.id, "host": s.host, "root": s.root, "python": s.python, "url": s.pid.is_none()})).collect()
    }

    async fn wait_ready(&self, port: u16, token: &str) -> Result<(), String> {
        let c = reqwest::Client::builder().timeout(Duration::from_secs(4)).build().map_err(|e| e.to_string())?;
        let t0 = std::time::Instant::now();
        loop {
            if let Ok(r) = c.get(format!("http://127.0.0.1:{port}/api/status")).header("Authorization", format!("token {token}")).send().await {
                if r.status().is_success() {
                    return Ok(());
                }
                if r.status().as_u16() == 403 || r.status().as_u16() == 401 {
                    return Err("The Jupyter server refused the token.".into());
                }
            }
            if t0.elapsed() > Duration::from_secs(45) {
                return Err("The Jupyter server on the server did not answer in time.".into());
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    /// Start (or reuse) a Jupyter server for `python` with `root` as its folder.
    pub async fn start(&self, host: &str, python: &str, root: &str, idle_min: u64, progress: &(dyn Fn(String) + Send + Sync)) -> Result<Arc<JupSrv>, String> {
        let id = format!("ssh-{}-{}", host, &crate::util::sha256_hex(format!("{python}|{root}").as_bytes())[..10]);
        if let Some(s) = self.get(&id) {
            if self.wait_ready(s.local_port, &s.token).await.is_ok() {
                return Ok(s);
            }
            self.stop(&id).await;
        }
        let sess = self.hub.session(host, true).await?;
        progress("Starting Jupyter on the server…".into());
        let token = rand_hex(24);
        let idle = if idle_min > 0 { format!(" --ServerApp.shutdown_no_activity_timeout={}", idle_min * 60) } else { String::new() };
        let py = sh_quote(python);
        let script = format!(
            "read -r JUPYTER_TOKEN || exit 3; export JUPYTER_TOKEN; PORT=$({py} -c 'import socket;s=socket.socket();s.bind((\"127.0.0.1\",0));print(s.getsockname()[1])') || exit 4; echo CALLIO_PORT=$PORT; echo CALLIO_PID=$$; mkdir -p \"$HOME/.cache/callio\"; cd {root} 2>/dev/null; exec {py} -m jupyter_server --no-browser --allow-root --ServerApp.ip=127.0.0.1 --ServerApp.port=$PORT --ServerApp.port_retries=0 --ServerApp.root_dir={root}{idle} >> \"$HOME/.cache/callio/jupyter-$PORT.log\" 2>&1",
            root = sh_path(root)
        );
        let mut ch = sess.exec_stream(&format!("sh -c {}", sh_quote(&script))).await?;
        ch.data_bytes(format!("{token}\n").into_bytes()).await.map_err(|e| e.to_string())?;
        // the two marker lines arrive first
        let (mut port, mut pid): (Option<u16>, Option<u32>) = (None, None);
        let mut buf = String::new();
        let mut errtxt = String::new();
        let got = tokio::time::timeout(Duration::from_secs(30), async {
            while let Some(m) = ch.wait().await {
                match m {
                    ChannelMsg::Data { data } => {
                        buf.push_str(&String::from_utf8_lossy(&data));
                        for l in buf.lines() {
                            if let Some(v) = l.strip_prefix("CALLIO_PORT=") {
                                port = v.trim().parse().ok();
                            }
                            if let Some(v) = l.strip_prefix("CALLIO_PID=") {
                                pid = v.trim().parse().ok();
                            }
                        }
                        if port.is_some() && pid.is_some() {
                            return true;
                        }
                    }
                    ChannelMsg::ExtendedData { data, .. } => errtxt.push_str(&String::from_utf8_lossy(&data)),
                    ChannelMsg::ExitStatus { .. } | ChannelMsg::Close => return false,
                    _ => {}
                }
            }
            false
        })
        .await
        .unwrap_or(false);
        let (Some(rport), Some(pid)) = (port, pid) else {
            return Err(format!("Could not start Jupyter on the server with {python}. {}", errtxt.lines().last().unwrap_or("Check that jupyter_server is installed there.")));
        };
        if !got {
            return Err("Jupyter did not start on the server.".into());
        }
        // keep the channel (and with it stdin) open for as long as the server lives
        let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut stop_rx => { let _ = ch.close().await; break; }
                    m = ch.wait() => { if m.is_none() { break; } }
                }
            }
        });
        let fwd = forward_local(self.hub_arc(), host.to_string(), "127.0.0.1".into(), rport).await?;
        let lport = fwd.port;
        progress("Waiting for Jupyter to answer…".into());
        if let Err(e) = self.wait_ready(lport, &token).await {
            let log = sess.exec(&format!("tail -n 15 \"$HOME/.cache/callio/jupyter-{rport}.log\" 2>/dev/null"), None, Duration::from_secs(10)).await.map(|o| o.text()).unwrap_or_default();
            let _ = sess.exec(&format!("kill {pid}"), None, Duration::from_secs(10)).await;
            let log = log.lines().filter(|l| !l.contains("token=")).collect::<Vec<_>>().join("\n");
            return Err(format!("{e} {}", log.lines().last().unwrap_or("")));
        }
        let srv = Arc::new(JupSrv { id: id.clone(), host: host.into(), root: root.into(), python: python.into(), pid: Some(pid), local_port: lport, token, _fwd: fwd, stop: Mutex::new(Some(stop_tx)) });
        self.servers.lock().unwrap().insert(id, srv.clone());
        Ok(srv)
    }

    /// A Jupyter server already running on the server: forward to it.
    pub async fn forward_existing(&self, host: &str, remote_host: &str, remote_port: u16, token: &str) -> Result<Arc<JupSrv>, String> {
        let id = format!("ssh-url-{}-{}-{}", host, remote_host.replace(['.', ':'], "_"), remote_port);
        if let Some(s) = self.get(&id) {
            return Ok(s);
        }
        self.hub.session(host, true).await?;
        let fwd = forward_local(self.hub_arc(), host.to_string(), remote_host.to_string(), remote_port).await?;
        let lport = fwd.port;
        self.wait_ready(lport, token).await.map_err(|e| if e.contains("did not answer") { format!("Nothing answered at {remote_host}:{remote_port} on the server. Is Jupyter running there?") } else { e })?;
        let srv = Arc::new(JupSrv { id: id.clone(), host: host.into(), root: String::new(), python: String::new(), pid: None, local_port: lport, token: token.into(), _fwd: fwd, stop: Mutex::new(None) });
        self.servers.lock().unwrap().insert(id, srv.clone());
        Ok(srv)
    }

    pub async fn stop(&self, id: &str) {
        let s = self.servers.lock().unwrap().remove(id);
        if let Some(s) = s {
            if let Some(tx) = s.stop.lock().unwrap().take() {
                let _ = tx.send(());
            }
            if let (Some(pid), Ok(sess)) = (s.pid, self.hub.session(&s.host, false).await) {
                let _ = sess.exec(&format!("kill {pid}; sleep 2; kill -9 {pid} 2>/dev/null; true"), None, Duration::from_secs(10)).await;
            }
        }
    }
    pub async fn stop_all(&self) {
        let ids: Vec<String> = self.servers.lock().unwrap().keys().cloned().collect();
        for i in ids {
            self.stop(&i).await;
        }
    }
    fn hub_arc(&self) -> Arc<Hub> {
        self.hub.clone()
    }
}

/// Split a pasted Jupyter address (`http://localhost:8888/lab?token=…`) into host, port, token.
pub fn parse_url(input: &str) -> Result<(String, u16, String), String> {
    let t = input.trim();
    let t = if t.contains("://") { t.to_string() } else { format!("http://{t}") };
    let rest = t.split_once("://").map(|x| x.1).unwrap_or("");
    let (hp, tail) = rest.split_once('/').map(|(a, b)| (a, b.to_string())).unwrap_or((rest, String::new()));
    let (host, port) = match hp.rsplit_once(':') {
        Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty() => (h.to_string(), p.parse::<u16>().map_err(|_| "The port is not valid.".to_string())?),
        _ => (hp.to_string(), if t.starts_with("https") { 443 } else { 80 }),
    };
    if host.is_empty() {
        return Err("Enter the address as http://localhost:8888/?token=…".into());
    }
    let token = tail.split_once('?').map(|x| x.1).unwrap_or("").split('&').find_map(|kv| kv.strip_prefix("token=")).unwrap_or("").to_string();
    Ok((host, port, token))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn urls() {
        assert_eq!(parse_url("http://localhost:8888/lab?token=abc123").unwrap(), ("localhost".into(), 8888, "abc123".into()));
        assert_eq!(parse_url("127.0.0.1:9000/tree?foo=1&token=t").unwrap(), ("127.0.0.1".into(), 9000, "t".into()));
        assert!(parse_url("").is_err());
    }
}
