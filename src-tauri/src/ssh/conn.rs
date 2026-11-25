//! One SSH connection per server, shared by everything (sync, Jupyter tunnels, the AI): login
//! with the agent, key files, password or a keyboard-interactive prompt (one-time codes); host
//! keys checked against `known_hosts`; keepalive every 30 s; automatic reconnect with backoff.
//! Secrets are only ever read from / written to the Credential Manager through `Env`.
use super::config::HostCfg;
use super::env::Env;
use russh::client::{self, Handle, Msg};
use russh::keys::{self, ssh_key, HashAlg, PrivateKeyWithHashAlg};
use russh::{Channel, ChannelMsg};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;

// ---------------- transports (direct now, jump hosts later) ----------------

pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
pub type BoxStream = Box<dyn Stream>;

/// How the bytes reach the server. `Direct` is a TCP connection; `ProxyJump` will open a
/// `direct-tcpip` channel on another connection and hand that back.
pub trait Transport: Send + Sync {
    fn connect<'a>(&'a self, cfg: &'a HostCfg) -> Pin<Box<dyn Future<Output = std::io::Result<BoxStream>> + Send + 'a>>;
}
pub struct Direct;
impl Transport for Direct {
    fn connect<'a>(&'a self, cfg: &'a HostCfg) -> Pin<Box<dyn Future<Output = std::io::Result<BoxStream>> + Send + 'a>> {
        Box::pin(async move {
            let addr = format!("{}:{}", cfg.host, cfg.port_or_default());
            let s = tokio::time::timeout(Duration::from_secs(5), tokio::net::TcpStream::connect(addr)).await.map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out"))??;
            let _ = s.set_nodelay(true);
            Ok(Box::new(s) as BoxStream)
        })
    }
}

fn unreachable_error(e: &std::io::Error) -> bool {
    use std::io::ErrorKind::*;
    if matches!(e.kind(), TimedOut | HostUnreachable | NetworkUnreachable | NetworkDown) {
        return true;
    }
    let t = e.to_string().to_lowercase();
    // name resolution failures have no stable ErrorKind
    t.contains("failed to lookup") || t.contains("no such host") || t.contains("name or service not known") || t.contains("no route") || t.contains("not know") || t.contains("11001") || t.contains("10060") || t.contains("10065")
}

pub fn connect_error(cfg: &HostCfg, e: &std::io::Error) -> String {
    if cfg.needs_vpn && unreachable_error(e) {
        return format!("Could not connect to {}. This server needs a VPN — turn the VPN on and try again.", cfg.label());
    }
    if e.kind() == std::io::ErrorKind::ConnectionRefused {
        return format!("{} refused the connection on port {}. Check that SSH is running there and the port is right.", cfg.label(), cfg.port_or_default());
    }
    if unreachable_error(e) {
        return format!("Could not reach {} ({}). Check the address and your network{}.", cfg.label(), e, if cfg.needs_vpn { "" } else { " (or turn on the VPN if this server needs one)" });
    }
    format!("Could not connect to {}: {}", cfg.label(), e)
}

// ---------------- the handler ----------------

pub type Reverse = Arc<Mutex<HashMap<u32, String>>>;

struct Handler {
    env: Env,
    cfg: HostCfg,
    known_hosts: PathBuf,
    interactive: bool,
    why: Arc<Mutex<Option<String>>>,
    reverse: Reverse,
}

impl client::Handler for Handler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &russh::keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let pk: ssh_key::PublicKey = match key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            russh::keys::PublicKeyOrCertificate::Certificate(c) => ssh_key::PublicKey::from(c.public_key().clone()),
        };
        let (host, port) = (self.cfg.host.clone(), self.cfg.port_or_default());
        let fp = pk.fingerprint(HashAlg::Sha256).to_string();
        let say = |m: String| *self.why.lock().unwrap() = Some(m);
        match keys::check_known_hosts_path(&host, port, &pk, &self.known_hosts) {
            Ok(true) => Ok(true),
            Ok(false) => {
                if !self.interactive {
                    say(format!("{} is not in known_hosts yet. Connect to it once from Callio to trust it.", self.cfg.label()));
                    return Ok(false);
                }
                let ans = self.env.ask("hostkey", json!({"host": host, "port": port, "name": self.cfg.label(), "fingerprint": fp, "algorithm": pk.algorithm().to_string()})).await;
                if ans.as_ref().and_then(|a| a["trust"].as_bool()) == Some(true) {
                    let _ = keys::known_hosts::learn_known_hosts_path(&host, port, &pk, &self.known_hosts);
                    Ok(true)
                } else {
                    say(format!("You did not trust the key of {}. Nothing was saved.", self.cfg.label()));
                    Ok(false)
                }
            }
            Err(keys::Error::KeyChanged { line }) => {
                let msg = format!("WARNING: the key of {} has CHANGED (known_hosts line {line}). Someone may be intercepting the connection, or the server was reinstalled. Callio will not connect. If you are sure it is safe, remove that line from known_hosts and connect again.", self.cfg.label());
                self.env.emit("ssh-alert", json!({"kind": "hostkey-changed", "host": host, "port": port, "name": self.cfg.label(), "fingerprint": fp, "line": line, "message": msg}));
                say(msg);
                Ok(false)
            }
            Err(e) => {
                say(format!("Could not check known_hosts: {e}"));
                Ok(false)
            }
        }
    }

    async fn server_channel_open_forwarded_tcpip(&mut self, channel: Channel<Msg>, _connected_address: &str, connected_port: u32, _oa: &str, _op: u32, reply: russh::client::ChannelOpenHandle, _s: &mut client::Session) -> Result<(), Self::Error> {
        let target = self.reverse.lock().unwrap().get(&connected_port).cloned();
        match target {
            Some(addr) => {
                reply.accept().await;
                tokio::spawn(async move {
                    if let Ok(mut tcp) = tokio::net::TcpStream::connect(addr).await {
                        let mut ch = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut tcp, &mut ch).await;
                    }
                });
            }
            None => {
                reply.reject(russh::ChannelOpenFailure::AdministrativelyProhibited).await;
            }
        }
        Ok(())
    }
}

// ---------------- execution results ----------------

#[derive(Debug, Default, Clone)]
pub struct ExecOut {
    pub code: Option<u32>,
    pub out: Vec<u8>,
    pub err: Vec<u8>,
}
impl ExecOut {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.out).to_string()
    }
    pub fn err_text(&self) -> String {
        String::from_utf8_lossy(&self.err).to_string()
    }
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }
}

// ---------------- a live session ----------------

pub struct Session {
    handle: Handle<Handler>,
    sftp: tokio::sync::Mutex<Option<Arc<russh_sftp::client::SftpSession>>>,
    reverse: Reverse,
}

impl Session {
    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    /// Run a command; `stdin` is fed to it (that's how secrets reach the server without
    /// appearing in `ps`). Stops waiting after `timeout`.
    pub async fn exec(&self, cmd: &str, stdin: Option<&[u8]>, timeout: Duration) -> Result<ExecOut, String> {
        let fut = async {
            let mut ch = self.handle.channel_open_session().await.map_err(es)?;
            ch.exec(true, cmd.as_bytes().to_vec()).await.map_err(es)?;
            if let Some(d) = stdin {
                ch.data_bytes(d.to_vec()).await.map_err(es)?;
            }
            let _ = ch.eof().await;
            let mut o = ExecOut::default();
            while let Some(m) = ch.wait().await {
                match m {
                    ChannelMsg::Data { data } => {
                        if o.out.len() < 64 << 20 {
                            o.out.extend_from_slice(&data)
                        }
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        if o.err.len() < 4 << 20 {
                            o.err.extend_from_slice(&data)
                        }
                    }
                    ChannelMsg::ExitStatus { exit_status } => o.code = Some(exit_status),
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            Ok::<ExecOut, String>(o)
        };
        tokio::time::timeout(timeout, fut).await.map_err(|_| format!("The command took longer than {} s and was stopped.", timeout.as_secs()))?
    }

    /// A command whose stdin/stdout stay open (Claude Code, a Jupyter server).
    pub async fn exec_stream(&self, cmd: &str) -> Result<Channel<Msg>, String> {
        let ch = self.handle.channel_open_session().await.map_err(es)?;
        ch.exec(true, cmd.as_bytes().to_vec()).await.map_err(es)?;
        Ok(ch)
    }

    pub async fn sftp(&self) -> Result<Arc<russh_sftp::client::SftpSession>, String> {
        let mut g = self.sftp.lock().await;
        if let Some(s) = g.as_ref() {
            return Ok(s.clone());
        }
        let ch = self.handle.channel_open_session().await.map_err(es)?;
        ch.request_subsystem(true, "sftp").await.map_err(|e| format!("The server has no SFTP: {e}"))?;
        let s = russh_sftp::client::SftpSession::new(ch.into_stream()).await.map_err(|e| format!("SFTP failed to start: {e}"))?;
        s.set_timeout(60);
        let s = Arc::new(s);
        *g = Some(s.clone());
        Ok(s)
    }

    pub async fn open_direct(&self, host: &str, port: u16) -> Result<russh::ChannelStream<Msg>, String> {
        let ch = self.handle.channel_open_direct_tcpip(host.to_string(), port as u32, "127.0.0.1", 0).await.map_err(|e| format!("The server could not open {host}:{port}: {e}"))?;
        Ok(ch.into_stream())
    }

    /// Ask the server to listen on 127.0.0.1 (port chosen by it) and send every connection to
    /// `local` (an address on this computer). Returns the server-side port.
    pub async fn reverse_forward(&self, local: String) -> Result<u32, String> {
        let port = self.handle.tcpip_forward("127.0.0.1", 0).await.map_err(|e| format!("The server refused the reverse forward: {e}"))?;
        self.reverse.lock().unwrap().insert(port, local);
        Ok(port)
    }
    pub async fn cancel_reverse(&self, port: u32) {
        self.reverse.lock().unwrap().remove(&port);
        let _ = self.handle.cancel_tcpip_forward("127.0.0.1", port).await;
    }

    pub async fn disconnect(&self) {
        let _ = self.handle.disconnect(russh::Disconnect::ByApplication, "bye", "en").await;
    }
}

fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------- login ----------------

fn secret_key(host: &str, what: &str) -> String {
    format!("callio-ssh-{host}-{what}")
}
pub fn password_key(host_id: &str) -> String {
    secret_key(host_id, "password")
}
fn pass_key(host_id: &str, key_path: &str) -> String {
    let h = crate::util::sha256_hex(key_path.as_bytes());
    secret_key(host_id, &format!("passphrase-{}", &h[..10]))
}
/// Forget everything saved for this server.
pub fn forget_secrets(env: &Env, cfg: &HostCfg) {
    env.set_secret(&password_key(&cfg.id), "");
    for f in default_keys(env, cfg) {
        env.set_secret(&pass_key(&cfg.id, &f), "");
    }
}

fn default_keys(env: &Env, cfg: &HostCfg) -> Vec<String> {
    let mut v: Vec<String> = cfg.identity_files.clone();
    if v.is_empty() || !cfg.identities_only {
        for n in ["id_ed25519", "id_ecdsa", "id_rsa"] {
            let p = env.ssh_dir.join(n).to_string_lossy().to_string();
            if !v.contains(&p) {
                v.push(p);
            }
        }
    }
    v
}

fn allows(rem: &russh::MethodSet, k: russh::MethodKind) -> bool {
    rem.is_empty() || rem.iter().any(|m| *m == k)
}

enum Step {
    Done,
    Next(russh::MethodSet),
}

async fn try_agent(h: &mut Handle<Handler>, user: &str) -> Result<Option<Step>, String> {
    #[cfg(windows)]
    let agent = {
        match keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            Ok(a) => Some(a.dynamic()),
            Err(_) => keys::agent::client::AgentClient::connect_pageant().await.ok().map(|a| a.dynamic()),
        }
    };
    #[cfg(not(windows))]
    let agent = keys::agent::client::AgentClient::connect_env().await.ok().map(|a| a.dynamic());
    let Some(mut agent) = agent else { return Ok(None) };
    let ids = agent.request_identities().await.map_err(es)?;
    let hash = h.best_supported_rsa_hash().await.ok().flatten().flatten();
    let mut last = Step::Next(russh::MethodSet::empty());
    for id in ids {
        let russh::keys::agent::AgentIdentity::PublicKey { key, .. } = id else { continue };
        match h.authenticate_publickey_with(user, key, hash, &mut agent).await {
            Ok(r) if r.success() => return Ok(Some(Step::Done)),
            Ok(russh::client::AuthResult::Failure { remaining_methods, .. }) => last = Step::Next(remaining_methods),
            Err(_) => {}
            _ => {}
        }
    }
    Ok(Some(last))
}

async fn try_keys(env: &Env, cfg: &HostCfg, h: &mut Handle<Handler>, interactive: bool) -> Result<Option<Step>, String> {
    let mut last: Option<Step> = None;
    let hash = h.best_supported_rsa_hash().await.ok().flatten().flatten();
    for path in default_keys(env, cfg) {
        if !std::path::Path::new(&path).is_file() {
            continue;
        }
        let mut pass: Option<String> = None;
        let key = loop {
            match keys::load_secret_key(&path, pass.as_deref()) {
                Ok(k) => break Some(k),
                Err(keys::Error::KeyIsEncrypted) | Err(keys::Error::SshKey(_)) => {
                    // encrypted (or a wrong passphrase): the saved one first, then ask once
                    let saved = env.secret(&pass_key(&cfg.id, &path));
                    if pass.is_none() && saved.is_some() {
                        pass = saved;
                        continue;
                    }
                    if pass.is_some() {
                        env.set_secret(&pass_key(&cfg.id, &path), "");
                    }
                    if !interactive {
                        break None;
                    }
                    let name = std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    let ans = env.ask("passphrase", json!({"host": cfg.label(), "hostId": cfg.id, "keyPath": path, "keyName": name, "retry": pass.is_some()})).await;
                    match ans.and_then(|a| a["value"].as_str().map(|s| (s.to_string(), a["save"].as_bool().unwrap_or(false)))) {
                        Some((p, save)) if !p.is_empty() => {
                            if keys::load_secret_key(&path, Some(&p)).is_ok() && (save || cfg.remember) {
                                env.set_secret(&pass_key(&cfg.id, &path), &p);
                            }
                            pass = Some(p);
                            // loop again: a wrong one asks again (saved copy is not used twice)
                            if keys::load_secret_key(&path, pass.as_deref()).is_err() {
                                break None;
                            }
                        }
                        _ => break None,
                    }
                }
                Err(_) => break None,
            }
        };
        let Some(key) = key else { continue };
        match h.authenticate_publickey(&cfg.user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await {
            Ok(r) if r.success() => return Ok(Some(Step::Done)),
            Ok(russh::client::AuthResult::Failure { remaining_methods, .. }) => last = Some(Step::Next(remaining_methods)),
            Err(e) => return Err(es(e)),
            _ => {}
        }
    }
    Ok(last)
}

async fn try_password(env: &Env, cfg: &HostCfg, h: &mut Handle<Handler>, interactive: bool) -> Result<Step, String> {
    let key = password_key(&cfg.id);
    let mut from_store = true;
    let mut pw = env.secret(&key);
    for _ in 0..3 {
        if pw.is_none() {
            from_store = false;
            if !interactive {
                return Err("login".into());
            }
            let ans = env.ask("password", json!({"host": cfg.label(), "hostId": cfg.id, "user": cfg.user, "retry": false})).await;
            let Some(a) = ans else { return Err("You closed the password box.".into()) };
            let p = a["value"].as_str().unwrap_or("").to_string();
            if p.is_empty() {
                return Err("You closed the password box.".into());
            }
            if a["save"].as_bool().unwrap_or(cfg.remember) {
                env.set_secret(&key, &p);
            }
            pw = Some(p);
        }
        match h.authenticate_password(&cfg.user, pw.clone().unwrap_or_default()).await.map_err(es)? {
            r if r.success() => return Ok(Step::Done),
            russh::client::AuthResult::Failure { remaining_methods, .. } => {
                if from_store {
                    env.set_secret(&key, "");
                    pw = None;
                    if !interactive {
                        return Err("login".into());
                    }
                    continue;
                }
                return Ok(Step::Next(remaining_methods));
            }
            _ => return Ok(Step::Next(russh::MethodSet::empty())),
        }
    }
    Err("The password was not accepted.".into())
}

async fn try_kbd(env: &Env, cfg: &HostCfg, h: &mut Handle<Handler>, interactive: bool) -> Result<Step, String> {
    use russh::client::KeyboardInteractiveAuthResponse as R;
    let mut r = h.authenticate_keyboard_interactive_start(&cfg.user, None).await.map_err(es)?;
    let mut first = true;
    for _ in 0..8 {
        match r {
            R::Success => return Ok(Step::Done),
            R::Failure { remaining_methods, .. } => return Ok(Step::Next(remaining_methods)),
            R::InfoRequest { name, instructions, prompts } => {
                let mut answers: Vec<String> = vec![];
                // a plain "Password:" prompt is answered from the saved password when there is one
                let saved = env.secret(&password_key(&cfg.id));
                let looks_pw = first && prompts.len() == 1 && prompts[0].prompt.to_lowercase().contains("password") && !prompts[0].echo;
                if looks_pw && saved.is_some() {
                    answers.push(saved.unwrap());
                } else if prompts.is_empty() {
                } else {
                    if !interactive {
                        return Err("login".into());
                    }
                    let ps: Vec<Value> = prompts.iter().map(|p| json!({"prompt": p.prompt, "echo": p.echo})).collect();
                    let ans = env.ask("kbd", json!({"host": cfg.label(), "hostId": cfg.id, "name": name, "instructions": instructions, "prompts": ps})).await;
                    let Some(a) = ans.and_then(|a| a["answers"].as_array().cloned()) else { return Err("You closed the sign-in box.".into()) };
                    answers = a.iter().map(|x| x.as_str().unwrap_or("").to_string()).collect();
                    if looks_pw && cfg.remember {
                        if let Some(p) = answers.first() {
                            env.set_secret(&password_key(&cfg.id), p);
                        }
                    }
                }
                first = false;
                r = h.authenticate_keyboard_interactive_respond(answers).await.map_err(es)?;
            }
        }
    }
    Err("The server kept asking questions. Sign-in stopped.".into())
}

async fn login(env: &Env, cfg: &HostCfg, h: &mut Handle<Handler>, interactive: bool) -> Result<(), String> {
    let mode = if cfg.auth.is_empty() { "auto" } else { cfg.auth.as_str() };
    let mut rem = russh::MethodSet::empty();
    if let Ok(r) = h.authenticate_none(&cfg.user).await {
        match r {
            r if r.success() => return Ok(()),
            russh::client::AuthResult::Failure { remaining_methods, .. } => rem = remaining_methods,
            _ => {}
        }
    }
    let mut tried: Vec<&str> = vec![];
    if matches!(mode, "auto" | "agent") && allows(&rem, russh::MethodKind::PublicKey) {
        tried.push("the SSH agent");
        match try_agent(h, &cfg.user).await {
            Ok(Some(Step::Done)) => return Ok(()),
            Ok(Some(Step::Next(r))) if !r.is_empty() => rem = r,
            _ => {}
        }
    }
    if matches!(mode, "auto" | "key") && allows(&rem, russh::MethodKind::PublicKey) {
        tried.push("key files");
        match try_keys(env, cfg, h, interactive).await? {
            Some(Step::Done) => return Ok(()),
            Some(Step::Next(r)) if !r.is_empty() => rem = r,
            _ => {}
        }
    }
    if matches!(mode, "auto" | "password") && allows(&rem, russh::MethodKind::Password) {
        tried.push("password");
        match try_password(env, cfg, h, interactive).await {
            Ok(Step::Done) => return Ok(()),
            Ok(Step::Next(r)) if !r.is_empty() => rem = r,
            Ok(_) => {}
            Err(e) if e == "login" => return Err("login".into()),
            Err(e) if rem.iter().any(|m| *m == russh::MethodKind::KeyboardInteractive) && mode == "auto" => {
                let _ = e;
            }
            Err(e) => return Err(e),
        }
    }
    if matches!(mode, "auto" | "interactive" | "password") && allows(&rem, russh::MethodKind::KeyboardInteractive) {
        tried.push("keyboard-interactive");
        if let Step::Done = try_kbd(env, cfg, h, interactive).await? {
            return Ok(());
        }
    }
    Err(format!("{} did not accept the login ({}). Check the user name, key or password in Settings › Remote servers.", cfg.label(), if tried.is_empty() { "no method available".to_string() } else { format!("tried {}", tried.join(", ")) }))
}

pub async fn connect(env: &Env, cfg: &HostCfg, interactive: bool, transport: &dyn Transport) -> Result<Arc<Session>, String> {
    if cfg.host.trim().is_empty() {
        return Err("This server has no address.".into());
    }
    if cfg.user.trim().is_empty() {
        return Err(format!("Set a user name for {} in Settings › Remote servers.", cfg.label()));
    }
    let stream = transport.connect(cfg).await.map_err(|e| connect_error(cfg, &e))?;
    let why = Arc::new(Mutex::new(None));
    let reverse: Reverse = Arc::new(Mutex::new(HashMap::new()));
    let handler = Handler { env: env.clone(), cfg: cfg.clone(), known_hosts: env.ssh_dir.join("known_hosts"), interactive, why: why.clone(), reverse: reverse.clone() };
    let config = Arc::new(client::Config { keepalive_interval: Some(Duration::from_secs(30)), keepalive_max: 3, window_size: 4 << 20, maximum_packet_size: 32768, ..Default::default() });
    let mut h = match tokio::time::timeout(Duration::from_secs(30), client::connect_stream(config, stream, handler)).await {
        Err(_) => return Err(connect_error(cfg, &std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out during the handshake"))),
        Ok(Err(e)) => {
            let w = why.lock().unwrap().clone();
            return Err(w.unwrap_or_else(|| format!("Could not connect to {}: {e}", cfg.label())));
        }
        Ok(Ok(h)) => h,
    };
    login(env, cfg, &mut h, interactive).await?;
    Ok(Arc::new(Session { handle: h, sftp: tokio::sync::Mutex::new(None), reverse }))
}

// ---------------- the hub: one connection per host, kept alive ----------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    Off,
    Connecting,
    Connected,
    Reconnecting,
}
impl State {
    pub fn name(&self) -> &'static str {
        match self {
            State::Off => "off",
            State::Connecting => "connecting",
            State::Connected => "connected",
            State::Reconnecting => "reconnecting",
        }
    }
}

struct HostConn {
    cfg: Mutex<HostCfg>,
    state: Mutex<(State, String)>,
    sess: Mutex<Option<Arc<Session>>>,
    lock: tokio::sync::Mutex<()>,
    /// the author disconnected on purpose: no automatic reconnect
    manual_off: Mutex<bool>,
    watcher: Mutex<bool>,
}

pub struct Hub {
    pub env: Env,
    hosts: Mutex<HashMap<String, Arc<HostConn>>>,
}

impl Hub {
    pub fn new(env: Env) -> Arc<Hub> {
        Arc::new(Hub { env, hosts: Mutex::new(HashMap::new()) })
    }

    /// Replace the known servers (settings changed). Live connections stay as they are.
    pub fn set_hosts(&self, list: Vec<HostCfg>) {
        let mut m = self.hosts.lock().unwrap();
        for h in list {
            match m.get(&h.id) {
                Some(c) => *c.cfg.lock().unwrap() = h,
                None => {
                    m.insert(h.id.clone(), Arc::new(HostConn { cfg: Mutex::new(h), state: Mutex::new((State::Off, String::new())), sess: Mutex::new(None), lock: tokio::sync::Mutex::new(()), manual_off: Mutex::new(false), watcher: Mutex::new(false) }));
                }
            }
        }
    }
    fn conn(&self, id: &str) -> Result<Arc<HostConn>, String> {
        self.hosts.lock().unwrap().get(id).cloned().ok_or_else(|| "This server is not in your list any more.".to_string())
    }
    pub fn all_cfgs(&self) -> Vec<HostCfg> {
        let mut v: Vec<HostCfg> = self.hosts.lock().unwrap().values().map(|c| c.cfg.lock().unwrap().clone()).collect();
        v.sort_by(|a, b| a.name.cmp(&b.name));
        v
    }
    pub fn cfg(&self, id: &str) -> Result<HostCfg, String> {
        Ok(self.conn(id)?.cfg.lock().unwrap().clone())
    }
    pub fn states(&self) -> Value {
        let m = self.hosts.lock().unwrap();
        Value::Array(m.iter().map(|(id, c)| {
            let (s, why) = c.state.lock().unwrap().clone();
            json!({"id": id, "state": s.name(), "reason": why})
        }).collect())
    }
    fn set_state(&self, c: &HostConn, id: &str, s: State, why: &str) {
        *c.state.lock().unwrap() = (s, why.to_string());
        self.env.emit("ssh-state", json!({"id": id, "state": s.name(), "reason": why}));
    }

    /// The live session for a server, connecting first if needed. `interactive` lets the sign-in
    /// ask the author questions (host key, passphrase, password, one-time code).
    pub async fn session(self: &Arc<Self>, id: &str, interactive: bool) -> Result<Arc<Session>, String> {
        let c = self.conn(id)?;
        if let Some(s) = c.sess.lock().unwrap().clone().filter(|s| !s.is_closed()) {
            return Ok(s);
        }
        let _g = c.lock.lock().await;
        if let Some(s) = c.sess.lock().unwrap().clone().filter(|s| !s.is_closed()) {
            return Ok(s);
        }
        let cfg = c.cfg.lock().unwrap().clone();
        if !interactive && *c.manual_off.lock().unwrap() {
            return Err(format!("{} is disconnected.", cfg.label()));
        }
        let was = c.state.lock().unwrap().0;
        self.set_state(&c, id, if was == State::Reconnecting { State::Reconnecting } else { State::Connecting }, "");
        match connect(&self.env, &cfg, interactive, &Direct).await {
            Ok(s) => {
                *c.sess.lock().unwrap() = Some(s.clone());
                *c.manual_off.lock().unwrap() = false;
                self.set_state(&c, id, State::Connected, "");
                self.watch(id.to_string(), c.clone());
                Ok(s)
            }
            Err(e) => {
                let e = if e == "login" { format!("{} needs you to sign in again.", cfg.label()) } else { e };
                self.set_state(&c, id, State::Off, &e);
                Err(e)
            }
        }
    }

    /// Reconnect by itself when the connection drops (not when the author disconnected).
    fn watch(self: &Arc<Self>, id: String, c: Arc<HostConn>) {
        {
            let mut w = c.watcher.lock().unwrap();
            if *w {
                return;
            }
            *w = true;
        }
        let hub = self.clone();
        tokio::spawn(async move {
            let mut wait = 2u64;
            loop {
                tokio::time::sleep(Duration::from_secs(3)).await;
                if *c.manual_off.lock().unwrap() {
                    *c.watcher.lock().unwrap() = false;
                    return;
                }
                let alive = c.sess.lock().unwrap().as_ref().map(|s| !s.is_closed()).unwrap_or(false);
                if alive {
                    wait = 2;
                    continue;
                }
                hub.set_state(&c, &id, State::Reconnecting, "");
                match hub.session_quiet(&id, &c).await {
                    Ok(()) => wait = 2,
                    Err(e) => {
                        if e.contains("sign in") || e.contains("not in known_hosts") || e.contains("CHANGED") || e.contains("did not accept") {
                            hub.set_state(&c, &id, State::Off, &e);
                            *c.watcher.lock().unwrap() = false;
                            return;
                        }
                        hub.set_state(&c, &id, State::Reconnecting, &e);
                        tokio::time::sleep(Duration::from_secs(wait)).await;
                        wait = (wait * 2).min(60);
                    }
                }
            }
        });
    }
    async fn session_quiet(self: &Arc<Self>, id: &str, c: &Arc<HostConn>) -> Result<(), String> {
        let _g = c.lock.lock().await;
        if c.sess.lock().unwrap().as_ref().map(|s| !s.is_closed()).unwrap_or(false) {
            return Ok(());
        }
        let cfg = c.cfg.lock().unwrap().clone();
        match connect(&self.env, &cfg, false, &Direct).await {
            Ok(s) => {
                *c.sess.lock().unwrap() = Some(s);
                self.set_state(c, id, State::Connected, "");
                Ok(())
            }
            Err(e) if e == "login" => Err(format!("{} needs you to sign in again.", cfg.label())),
            Err(e) => Err(e),
        }
    }

    pub async fn disconnect(&self, id: &str) {
        if let Ok(c) = self.conn(id) {
            *c.manual_off.lock().unwrap() = true;
            let s = c.sess.lock().unwrap().take();
            if let Some(s) = s {
                s.disconnect().await;
            }
            self.set_state(&c, id, State::Off, "");
        }
    }
    pub async fn disconnect_all(&self) {
        let ids: Vec<String> = self.hosts.lock().unwrap().keys().cloned().collect();
        for i in ids {
            self.disconnect(&i).await;
        }
    }
}

// ---------------- local port forward ----------------

pub struct Forward {
    pub port: u16,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Forward {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Listen on 127.0.0.1:<free port> here and carry each connection to `rhost:rport` as seen from
/// the server. A fresh channel is opened per connection through the shared session, so the
/// forward survives a reconnect.
pub async fn forward_local(hub: Arc<Hub>, host_id: String, rhost: String, rport: u16) -> Result<Forward, String> {
    let l = TcpListener::bind(("127.0.0.1", 0)).await.map_err(es)?;
    let port = l.local_addr().map_err(es)?.port();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut tcp, _)) = l.accept().await else { break };
            let (hub, id, rh) = (hub.clone(), host_id.clone(), rhost.clone());
            tokio::spawn(async move {
                let Ok(s) = hub.session(&id, false).await else { return };
                let Ok(mut ch) = s.open_direct(&rh, rport).await else { return };
                let _ = tokio::io::copy_bidirectional(&mut tcp, &mut ch).await;
            });
        }
    });
    Ok(Forward { port, task })
}

