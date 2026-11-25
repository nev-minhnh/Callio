//! Claude Code sessions that stay alive: one long-lived `claude -p --input-format stream-json
//! --output-format stream-json` process per session. Messages go in as JSON lines on stdin
//! (which stays open), so the author can add instructions while the model works, several
//! sessions can run side by side, and everything the model and its subagents do streams to the
//! window as `cc-session` events ({handle, kind, …}; see `session_logic::translate`).
//!
//! The pieces:
//!  - `Sess`: one session — its process (if alive), status, queue of messages not yet read,
//!    to-do list, current step, and the journal on disk (`cc-sessions/<handle>.json`) that lets
//!    a session be brought back after a power cut.
//!  - slots: at most `ccMaxParallel` sessions run a turn at once; the rest wait ("queued").
//!  - an idle process is closed after `ccIdleMinutes`; the next message resumes it (`--resume`).
//!  - the MCP server tells permission questions apart by the session handle in its URL path
//!    (`/mcp/<handle>`), so every question reaches the right tab.
use super::session_logic::{control_line, new_uuid, translate, user_line, Tracker};
use super::{backups_dir, claude_cmd, diff_snapshots, ensure_server, find_claude, prune_backups, run_args, snapshot, ui_event, CcState, Extra, Snapshot, NO_THINKING_DISPLAY};
use crate::util::{safe_name, CmdResult, ErrStr};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

// ---------------- requests ----------------

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct StartReq {
    /// continue an earlier session's journal (restore after a crash); otherwise a new handle
    handle: Option<String>,
    cwd: String,
    model: Option<String>,
    permission_mode: String,
    system_append: String,
    label: String,
    effort: Option<String>,
    thinking: bool,
    /// None = Claude Code decides, "off" = no web, "<engine>" = Callio's web_search with that engine
    web: Option<String>,
    resume_id: Option<String>,
    window: Option<String>,
    /// brought back after a crash: stays "unfinished" in the journal until it has run again
    restored: bool,
    /// the window's own notes about the session (chat id, project, title…), kept in the journal
    meta: Value,
    max_parallel: Option<u32>,
    idle_minutes: Option<u32>,
    /// [wsl] where the process runs: "windows" (default) or "wsl:<distro>"
    run_in: Option<String>,
    /// [ssh] None = this computer, "ssh:<host id>" = on that server (wins over run_in)
    run_on: Option<String>,
}

/// What may change between two messages of one session.
#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SendPatch {
    model: Option<String>,
    permission_mode: Option<String>,
    effort: Option<String>,
    thinking: Option<bool>,
    web: Option<String>,
    label: Option<String>,
    /// recalled project memory: goes into the system prompt of a new process, or in front of
    /// the message when the process is already running (its system prompt is fixed)
    memory: Option<String>,
    system_append: Option<String>,
    max_parallel: Option<u32>,
    idle_minutes: Option<u32>,
}

// ---------------- state ----------------

struct Msg {
    uuid: String,
    text: String,
    mode: String,
    at: u64,
}

/// How a Claude Code process is reached. A local child process is the default; a process on a
/// server over SSH (`RemoteCtl`) plugs in here, and so can any other way of starting it.
trait ProcCtl: Send + Sync {
    /// `Some(exit code)` once the process has ended
    fn try_exit(&self) -> Option<Option<i32>>;
    fn kill_tree(&self);
}
impl ProcCtl for Mutex<Child> {
    fn try_exit(&self) -> Option<Option<i32>> {
        match self.lock().unwrap().try_wait() {
            Ok(Some(s)) => Some(s.code()),
            _ => None,
        }
    }
    fn kill_tree(&self) {
        kill_child_tree(self);
    }
}
struct RemoteCtl(Arc<crate::ssh::claude::RemoteProc>);
impl ProcCtl for RemoteCtl {
    fn try_exit(&self) -> Option<Option<i32>> {
        self.0.try_exit()
    }
    fn kill_tree(&self) {
        self.0.kill();
    }
}
fn kill_child_tree(c: &Mutex<Child>) {
    // super::kill_tree wants the Arc it was written for
    let pid = c.lock().unwrap().id();
    #[cfg(windows)]
    {
        let mut k = crate::util::command("taskkill");
        k.args(["/PID", &pid.to_string(), "/T", "/F"]);
        let _ = crate::util::run_with_timeout(k, Duration::from_secs(10));
    }
    let _ = pid;
    let _ = c.lock().unwrap().kill();
}

struct Proc {
    child: Arc<dyn ProcCtl>,
    /// lines for stdin (a writer thread owns the pipe, so a big message can never block the reader)
    tx: mpsc::Sender<String>,
    mode: String,
    model: Option<String>,
    cfg: PathBuf,
    sys: PathBuf,
}

struct Inner {
    req: StartReq,
    status: &'static str,
    proc: Option<Proc>,
    gen: u64,
    /// the process was ended on purpose (idle close, stop, interrupt that didn't work)
    closing: bool,
    claude_id: Option<String>,
    model_seen: Option<String>,
    turn_active: bool,
    turn_started: Option<Instant>,
    turn_started_ms: u64,
    /// written to the process, not read by the model yet
    pending: Vec<Msg>,
    /// waiting for a free slot or a process
    unsent: Vec<Msg>,
    todos: Value,
    step: Value,
    tokens: u64,
    waiting_perms: u32,
    cli_requires_action: bool,
    saw_state_events: bool,
    proc_events: bool,
    resumed_proc: bool,
    last_activity: Instant,
    created: u64,
    updated: u64,
    ended: Option<u64>,
    last_error: Option<String>,
    last_result_error: bool,
    /// the author pressed Stop / "Ngắt & gửi": the turn that ends with an error result is not a failure
    interrupted: bool,
    summary: Value,
    meta: Value,
    before: Option<Arc<Snapshot>>,
    restored_pending: bool,
    waiters: HashMap<String, mpsc::Sender<Value>>,
    dirty: bool,
}

struct Sess {
    handle: String,
    inner: Mutex<Inner>,
    cv: Condvar,
}

struct Mgr {
    map: Mutex<HashMap<String, Arc<Sess>>>,
    waiting: Mutex<VecDeque<String>>,
}

static MGR: OnceLock<Mgr> = OnceLock::new();
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static MAX_PAR: AtomicUsize = AtomicUsize::new(4);
static IDLE_MIN: AtomicU64 = AtomicU64::new(30);
static BG: AtomicBool = AtomicBool::new(false);
static SEQ: AtomicU64 = AtomicU64::new(1);

fn mgr() -> &'static Mgr {
    MGR.get_or_init(|| Mgr { map: Mutex::new(HashMap::new()), waiting: Mutex::new(VecDeque::new()) })
}

fn get(handle: &str) -> Option<Arc<Sess>> {
    mgr().map.lock().unwrap().get(handle).cloned()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn set_limits(max: Option<u32>, idle: Option<u32>) {
    if let Some(m) = max {
        MAX_PAR.store(m.clamp(1, 8) as usize, Ordering::SeqCst);
    }
    if let Some(i) = idle {
        IDLE_MIN.store(i.clamp(1, 24 * 60) as u64, Ordering::SeqCst);
    }
}

// ---------------- events to the window ----------------

/// Every event carries a number that only grows. A window that takes a session over from another
/// window (the AI chat popped out or attached back) says "I have seen everything up to N", so
/// events that arrive while the state moves are neither lost nor applied twice.
static EV_SEQ: AtomicU64 = AtomicU64::new(1);

fn emit(app: &AppHandle, handle: &str, kind: &str, mut extra: Value) {
    if !extra.is_object() {
        extra = json!({});
    }
    extra["handle"] = json!(handle);
    extra["kind"] = json!(kind);
    extra["seq"] = json!(EV_SEQ.fetch_add(1, Ordering::SeqCst));
    let _ = app.emit("cc-session", extra);
}

fn emit_raw(app: &AppHandle, handle: &str, mut ev: Value) {
    ev["handle"] = json!(handle);
    ev["seq"] = json!(EV_SEQ.fetch_add(1, Ordering::SeqCst));
    let _ = app.emit("cc-session", ev);
}

fn queue_json(g: &Inner) -> Value {
    let one = |m: &Msg, sent: bool| json!({"uuid": m.uuid, "text": m.text, "mode": m.mode, "at": m.at, "sent": sent});
    Value::Array(g.pending.iter().map(|m| one(m, true)).chain(g.unsent.iter().map(|m| one(m, false))).collect())
}

fn status_json(g: &Inner) -> Value {
    json!({"status": g.status, "proc": g.proc.is_some(), "turnActive": g.turn_active, "claudeId": g.claude_id, "queued": queue_json(g), "waiting": g.waiting_perms})
}

fn emit_status(app: &AppHandle, handle: &str, g: &Inner) {
    emit(app, handle, "status", status_json(g));
}

fn touch(g: &mut Inner) {
    g.dirty = true;
    g.updated = now_ms();
}

fn clean_end(g: &Inner) -> bool {
    g.ended.is_some() || (!g.turn_active && g.pending.is_empty() && g.unsent.is_empty() && !g.restored_pending)
}

// ---------------- journal ----------------

fn journal_dir(app: &AppHandle) -> PathBuf {
    crate::settings::category_dir(app, "cc-sessions")
}

fn full_state(handle: &str, g: &Inner) -> Value {
    json!({
        "handle": handle, "status": g.status, "proc": g.proc.is_some(), "turnActive": g.turn_active,
        "claudeId": g.claude_id, "cwd": g.req.cwd, "model": g.req.model, "modelSeen": g.model_seen, "label": g.req.label,
        "step": g.step, "todos": g.todos, "queued": queue_json(g), "tokens": g.tokens, "waiting": g.waiting_perms,
        "createdAt": g.created, "updatedAt": g.updated, "turnStartedAt": g.turn_started_ms, "endedAt": g.ended,
        "summary": g.summary, "lastError": g.last_error, "cleanEnd": clean_end(g), "meta": g.meta, "window": g.req.window,
        "settings": {"permissionMode": g.req.permission_mode, "effort": g.req.effort, "thinking": g.req.thinking, "web": g.req.web},
    })
}

/// Write the journal atomically (temp file + rename): a power cut never leaves half a file.
fn write_journal(app: &AppHandle, sess: &Sess) {
    let v = {
        let mut g = sess.inner.lock().unwrap();
        g.dirty = false;
        full_state(&sess.handle, &g)
    };
    let dir = journal_dir(app);
    let _ = std::fs::create_dir_all(&dir);
    let f = dir.join(format!("{}.json", safe_name(&sess.handle)));
    let tmp = dir.join(format!("{}.json.tmp", safe_name(&sess.handle)));
    if let Ok(mut fh) = std::fs::File::create(&tmp) {
        if fh.write_all(v.to_string().as_bytes()).is_ok() && fh.sync_all().is_ok() {
            drop(fh);
            let _ = std::fs::rename(&tmp, &f);
            return;
        }
    }
    let _ = std::fs::remove_file(&tmp);
}

/// Old journals of ended sessions are kept 30 days.
fn prune_journals(app: &AppHandle) {
    let Ok(rd) = std::fs::read_dir(journal_dir(app)) else { return };
    for e in rd.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|d| d.as_secs() > 30 * 86400).unwrap_or(false);
        if !old {
            continue;
        }
        let clean = std::fs::read(e.path()).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).map(|v| v["cleanEnd"].as_bool().unwrap_or(true)).unwrap_or(true);
        if clean {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// One background thread: writes dirty journals within a fraction of a second and closes idle processes.
fn ensure_bg(app: &AppHandle) {
    if BG.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        prune_journals(&app);
        let mut tick = 0u64;
        loop {
            std::thread::sleep(Duration::from_millis(250));
            tick += 1;
            let all: Vec<Arc<Sess>> = mgr().map.lock().unwrap().values().cloned().collect();
            for s in &all {
                let dirty = s.inner.lock().unwrap().dirty;
                if dirty {
                    write_journal(&app, s);
                }
            }
            if tick % 20 == 0 {
                let limit = Duration::from_secs(IDLE_MIN.load(Ordering::SeqCst) * 60);
                for s in &all {
                    let idle = {
                        let g = s.inner.lock().unwrap();
                        g.proc.is_some() && !g.turn_active && g.unsent.is_empty() && g.last_activity.elapsed() > limit
                    };
                    if idle {
                        close_process(&app, s, "idle");
                    }
                }
            }
        }
    });
}

// ---------------- slots ----------------

fn try_acquire() -> bool {
    loop {
        let c = ACTIVE.load(Ordering::SeqCst);
        if c >= MAX_PAR.load(Ordering::SeqCst) {
            return false;
        }
        if ACTIVE.compare_exchange(c, c + 1, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
            return true;
        }
    }
}

fn release_slot(app: &AppHandle) {
    let _ = ACTIVE.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |c| Some(c.saturating_sub(1)));
    let app = app.clone();
    std::thread::spawn(move || pump(&app));
}

/// A slot is free: start the next waiting session.
fn pump(app: &AppHandle) {
    loop {
        let h = mgr().waiting.lock().unwrap().pop_front();
        let Some(h) = h else { return };
        let Some(sess) = get(&h) else { continue };
        if !try_acquire() {
            mgr().waiting.lock().unwrap().push_front(h);
            return;
        }
        let msgs = std::mem::take(&mut sess.inner.lock().unwrap().unsent);
        if msgs.is_empty() {
            let _ = ACTIVE.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |c| Some(c.saturating_sub(1)));
            continue;
        }
        let _ = begin_turn(app, &sess, msgs);
    }
}

// ---------------- the process ----------------

fn write_line(g: &mut Inner, line: String) -> Result<(), String> {
    let p = g.proc.as_ref().ok_or("Claude Code isn't running")?;
    p.tx.send(line).map_err(|_| "Claude Code stopped".to_string())
}

fn send_control(g: &mut Inner, id: &str, request: Value) -> Result<(), String> {
    write_line(g, control_line(id, request))
}

fn spawn_proc(app: &AppHandle, sess: &Arc<Sess>, g: &mut Inner) -> Result<(), String> {
    let cwd = PathBuf::from(&g.req.cwd);
    if !cwd.is_dir() {
        return Err("Open a project folder (or a saved file) first".into());
    }
    if let Some(host) = g.req.run_on.as_deref().and_then(|r| r.strip_prefix("ssh:")).map(String::from) {
        return spawn_remote(app, sess, g, &host);
    }
    // ---- how the process is spawned: ssh (above) | wsl | this computer ----
    let wsl = crate::envs::claude::target(&g.req.run_in, &g.req.cwd)?;
    let exe = if wsl.is_some() { PathBuf::new() } else { find_claude().ok_or("CLAUDE_MISSING")? };
    let st = app.state::<CcState>();
    let base_cfg = tauri::async_runtime::block_on(ensure_server(app, &st)).es()?;
    // this session's own MCP address: the handle in the path tells permission questions apart
    let mut body: Value = serde_json::from_slice(&std::fs::read(&base_cfg).es()?).es()?;
    let mut url = body["mcpServers"]["callio"]["url"].as_str().unwrap_or("").trim_end_matches('/').to_string();
    if let Some(w) = &wsl {
        url = w.mcp_url(&url)?; // an address the distro can reach
    }
    body["mcpServers"]["callio"]["url"] = json!(format!("{url}/{}", sess.handle));
    let dir = crate::settings::category_dir(app, "claude-code");
    std::fs::create_dir_all(&dir).es()?;
    let tag = safe_name(&sess.handle);
    let cfg = dir.join(format!("mcp-{tag}.json"));
    std::fs::write(&cfg, serde_json::to_vec_pretty(&body).es()?).es()?;
    let sys = dir.join(format!("system-{tag}.md"));
    let memory = g.meta["memory"].as_str().unwrap_or("");
    std::fs::write(&sys, format!("{}{}", g.req.system_append, memory)).es()?;

    let resume = g.claude_id.clone().or_else(|| g.req.resume_id.clone()).filter(|s| !s.is_empty());
    let mode = g.req.permission_mode.clone();
    let extra = Extra { effort: g.req.effort.as_deref(), thinking: g.req.thinking, web: g.req.web.as_deref() };
    let mut c = match &wsl {
        Some(w) => w.command(run_args(&w.path(&cfg), &w.path(&sys), &mode, g.req.model.as_deref(), resume.as_deref(), &extra)),
        None => {
            let mut c = claude_cmd(&exe);
            c.current_dir(&cwd).args(run_args(&cfg, &sys, &mode, g.req.model.as_deref(), resume.as_deref(), &extra));
            c
        }
    };
    c.args(["--input-format", "stream-json"]);
    // makes Claude Code say when a turn is really over (idle), running, or waiting for an answer
    c.env("CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS", "1");
    c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| format!("Couldn't start Claude Code: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    attach(app, sess, g, Box::new(stdin), Box::new(stdout), Box::new(stderr), Arc::new(Mutex::new(child)), mode, resume.is_some(), cfg, sys);
    Ok(())
}

/// Claude Code on a server: the process runs there through SSH; Callio's tools are reached through
/// a reverse port forward; the folder is the server side of the link that holds this project.
fn spawn_remote(app: &AppHandle, sess: &Arc<Sess>, g: &mut Inner, host: &str) -> Result<(), String> {
    let local = g.req.cwd.clone();
    let (_, rcwd) = crate::ssh::remote_of(&local, host).ok_or("This folder is not linked to that server. Link it in Settings › Remote servers first, or run Claude Code on this computer.")?;
    let st = app.state::<CcState>();
    let base_cfg = tauri::async_runtime::block_on(ensure_server(app, &st)).es()?;
    let mut body: Value = serde_json::from_slice(&std::fs::read(&base_cfg).es()?).es()?;
    let url = body["mcpServers"]["callio"]["url"].as_str().unwrap_or("").trim_end_matches('/').to_string();
    body["mcpServers"]["callio"]["url"] = json!(format!("{url}/{}", sess.handle));
    let addr = url.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or("127.0.0.1:0").to_string();
    let memory = g.meta["memory"].as_str().unwrap_or("");
    let note = format!("\n\nYou are running on the server \"{host}\", in {rcwd}. That folder is kept in two-way sync with the author's folder {local} on their Windows computer by Callio: files you change here appear there within seconds, and files they change appear here (files of 10 MB or more are not synced). Callio's own tools (mcp__callio__*) act on the author's computer and its paths, not on this server.", host = crate::ssh::host_label(host));
    let system_text = format!("{}{}{}", g.req.system_append, memory, note);
    let resume = g.claude_id.clone().or_else(|| g.req.resume_id.clone()).filter(|s| !s.is_empty());
    let mode = g.req.permission_mode.clone();
    let model = g.req.model.clone();
    let extra = Extra { effort: g.req.effort.as_deref(), thinking: g.req.thinking, web: g.req.web.as_deref() };
    let (m2, r2) = (mode.clone(), resume.clone());
    let build = move |cfg: &str, sys: &str| -> Vec<String> {
        let mut a: Vec<String> = run_args(Path::new(cfg), Path::new(sys), &m2, model.as_deref(), r2.as_deref(), &extra).into_iter().map(|x| x.to_string_lossy().to_string()).collect();
        a.extend(["--input-format".to_string(), "stream-json".to_string()]);
        a
    };
    let sp = crate::ssh::spawn_claude_blocking(host, &rcwd, &system_text, &build, &addr, body)?;
    let crate::ssh::RemoteSpawn { proc, io } = sp;
    attach(app, sess, g, Box::new(io.stdin), Box::new(io.stdout), Box::new(io.stderr), Arc::new(RemoteCtl(proc)), mode, resume.is_some(), PathBuf::new(), PathBuf::new());
    Ok(())
}

/// The pipes of a started process become the session's process: a thread feeds stdin (so a big
/// message can never block the reader), another reads the stream.
#[allow(clippy::too_many_arguments)]
fn attach(app: &AppHandle, sess: &Arc<Sess>, g: &mut Inner, mut stdin: Box<dyn Write + Send>, stdout: Box<dyn Read + Send>, stderr: Box<dyn Read + Send>, child: Arc<dyn ProcCtl>, mode: String, resumed: bool, cfg: PathBuf, sys: PathBuf) {
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in rx {
            if stdin.write_all(line.as_bytes()).is_err() || stdin.write_all(b"\n").is_err() || stdin.flush().is_err() {
                break;
            }
        }
        // the channel closed (or the pipe broke): dropping stdin closes it, which ends Claude Code
    });
    g.gen += 1;
    g.closing = false;
    g.proc_events = false;
    g.resumed_proc = resumed;
    g.cli_requires_action = false;
    g.proc = Some(Proc { child: child.clone(), tx, mode, model: g.req.model.clone(), cfg, sys });
    let (app2, sess2, gen) = (app.clone(), sess.clone(), g.gen);
    std::thread::spawn(move || reader(app2, sess2, gen, stdout, stderr, child));
}

fn reader(app: AppHandle, sess: Arc<Sess>, gen: u64, stdout: Box<dyn Read + Send>, stderr: Box<dyn Read + Send>, child: Arc<dyn ProcCtl>) {
    let err_t = std::thread::spawn(move || {
        // read to the end (so Claude Code never blocks on a full pipe), keep the last 64 KB
        let mut tail: Vec<u8> = Vec::new();
        let mut buf = [0u8; 8192];
        let mut r = stderr;
        while let Ok(n) = r.read(&mut buf) {
            if n == 0 {
                break;
            }
            tail.extend_from_slice(&buf[..n]);
            if tail.len() > 128 << 10 {
                tail.drain(..tail.len() - (64 << 10));
            }
        }
        String::from_utf8_lossy(&tail).to_string()
    });
    let mut tr = Tracker::default();
    let mut rd = std::io::BufReader::new(stdout);
    let mut raw = Vec::new();
    loop {
        raw.clear();
        match rd.read_until(b'\n', &mut raw) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = String::from_utf8_lossy(&raw);
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
        handle_line(&app, &sess, gen, &mut tr, &v);
    }
    let code = loop {
        if let Some(code) = child.try_exit() {
            break code;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stderr = err_t.join().unwrap_or_default();
    on_exit(&app, &sess, gen, code, stderr);
}

fn handle_line(app: &AppHandle, sess: &Arc<Sess>, gen: u64, tr: &mut Tracker, v: &Value) {
    let h = sess.handle.as_str();
    {
        let mut g = sess.inner.lock().unwrap();
        if g.gen != gen {
            return;
        }
        g.proc_events = true;
        g.last_activity = Instant::now();
    }
    if v["type"] == "control_response" {
        let id = v["response"]["request_id"].as_str().unwrap_or("");
        let mut g = sess.inner.lock().unwrap();
        if let Some(tx) = g.waiters.remove(id) {
            let _ = tx.send(v["response"]["response"].clone());
        }
        return;
    }
    for ev in translate(v, tr, &ui_event) {
        match ev["kind"].as_str().unwrap_or("") {
            "session_id" => {
                let id = ev["sessionId"].as_str().unwrap_or("").to_string();
                let mut g = sess.inner.lock().unwrap();
                if !id.is_empty() && g.claude_id.as_deref() != Some(id.as_str()) {
                    g.claude_id = Some(id.clone());
                    touch(&mut g);
                    drop(g);
                    // the session id is the one thing a power cut must not lose: write it now
                    write_journal(app, sess);
                    emit(app, h, "session_id", json!({"sessionId": id}));
                }
            }
            "init" => {
                let mut g = sess.inner.lock().unwrap();
                g.model_seen = ev["model"].as_str().map(String::from);
                touch(&mut g);
                drop(g);
                emit_raw(app, h, ev);
            }
            "state" => on_state(app, sess, gen, tr, ev["state"].as_str().unwrap_or("")),
            "todos" => {
                let mut g = sess.inner.lock().unwrap();
                g.todos = ev["todos"].clone();
                touch(&mut g);
                drop(g);
                emit_raw(app, h, ev);
            }
            "step" => {
                let mut g = sess.inner.lock().unwrap();
                g.step = json!({"tool": ev["tool"], "arg": ev["arg"]});
                touch(&mut g);
                drop(g);
                emit_raw(app, h, ev);
            }
            "tokens" => {
                sess.inner.lock().unwrap().tokens = ev["total"].as_u64().unwrap_or(0);
                emit_raw(app, h, ev);
            }
            "cmd" => {
                let uuid = ev["uuid"].as_str().unwrap_or("").to_string();
                let st = ev["state"].as_str().unwrap_or("");
                if ["started", "completed", "cancelled", "discarded", "refused"].contains(&st) {
                    let mut g = sess.inner.lock().unwrap();
                    g.pending.retain(|m| m.uuid != uuid);
                    touch(&mut g);
                }
                emit_raw(app, h, ev);
            }
            "result" => {
                {
                    let mut g = sess.inner.lock().unwrap();
                    g.tokens = ev["tokens"].as_u64().unwrap_or(g.tokens);
                    g.last_result_error = ev["isError"].as_bool().unwrap_or(false) && !g.interrupted;
                    g.last_error = if g.last_result_error { Some(ev["errors"].as_str().filter(|s| !s.is_empty()).or(ev["text"].as_str()).unwrap_or("").to_string()) } else { None };
                    touch(&mut g);
                }
                emit_raw(app, h, ev);
                // without state events (an older Claude Code) a result is the best "turn over" signal
                if !sess.inner.lock().unwrap().saw_state_events {
                    on_state(app, sess, gen, tr, "idle");
                }
            }
            _ => emit_raw(app, h, ev),
        }
    }
}

fn on_state(app: &AppHandle, sess: &Arc<Sess>, gen: u64, tr: &mut Tracker, state: &str) {
    let h = sess.handle.as_str();
    match state {
        "running" | "requires_action" => {
            let mut g = sess.inner.lock().unwrap();
            if g.gen != gen {
                return;
            }
            g.saw_state_events = true;
            if !g.turn_active {
                // Claude Code started a turn by itself (a message it kept for later): count it
                g.turn_active = true;
                ACTIVE.fetch_add(1, Ordering::SeqCst);
                g.turn_started = Some(Instant::now());
                g.turn_started_ms = now_ms();
                tr.reset();
            }
            g.cli_requires_action = state == "requires_action";
            g.status = if g.cli_requires_action || g.waiting_perms > 0 { "waiting" } else { "running" };
            touch(&mut g);
            emit_status(app, h, &g);
        }
        "idle" => {
            sess.inner.lock().unwrap().saw_state_events = true;
            tr.reset();
            let settled = {
                let mut g = sess.inner.lock().unwrap();
                if g.gen != gen {
                    return;
                }
                let status = if g.last_result_error { "error" } else { "idle" };
                settle_locked(sess, &mut g, status)
            };
            finish_settled(app, sess, settled);
        }
        _ => {}
    }
}

/// What is needed after a turn ended, taken under the lock and used outside it.
struct Settled {
    was_active: bool,
    before: Option<Arc<Snapshot>>,
    cwd: PathBuf,
    label: String,
    tokens: u64,
    duration_ms: u64,
}

/// The turn is over (or the process is gone): back to idle/error, wake waiters, clear the queue
/// of messages the model has now read.
fn settle_locked(sess: &Sess, g: &mut Inner, status: &'static str) -> Settled {
    let was_active = g.turn_active;
    g.turn_active = false;
    g.cli_requires_action = false;
    g.pending.clear();
    g.restored_pending = false;
    g.last_activity = Instant::now();
    g.status = status;
    touch(g);
    sess.cv.notify_all();
    Settled {
        was_active,
        before: g.before.take(),
        cwd: PathBuf::from(&g.req.cwd),
        label: g.req.label.clone(),
        tokens: g.tokens,
        duration_ms: g.turn_started.map(|t| t.elapsed().as_millis() as u64).unwrap_or(0),
    }
}

/// Count lines added/removed between two versions of a file (an estimate by line multiset, fast
/// enough for large files).
fn line_delta(before: &[u8], after: &[u8]) -> (u32, u32) {
    let mut m: HashMap<&[u8], i64> = HashMap::new();
    for l in before.split(|b| *b == b'\n') {
        *m.entry(l).or_insert(0) -= 1;
    }
    for l in after.split(|b| *b == b'\n') {
        *m.entry(l).or_insert(0) += 1;
    }
    let (mut add, mut del) = (0i64, 0i64);
    for v in m.values() {
        if *v > 0 {
            add += v;
        } else {
            del -= v;
        }
    }
    (add as u32, del as u32)
}

fn finish_settled(app: &AppHandle, sess: &Arc<Sess>, s: Settled) {
    let h = sess.handle.clone();
    {
        let g = sess.inner.lock().unwrap();
        emit_status(app, &h, &g);
    }
    if s.was_active {
        release_slot(app);
    }
    if !s.was_active {
        return;
    }
    // what the turn changed: compared in the background (a big project takes a moment)
    let (app2, sess2) = (app.clone(), sess.clone());
    std::thread::spawn(move || {
        // Claude Code on a server: wait for the sync to bring its changes here, then compare
        if sess2.inner.lock().unwrap().req.run_on.as_deref().map(|r| r.starts_with("ssh:")).unwrap_or(false) {
            crate::ssh::sync_for_turn(&s.cwd.to_string_lossy());
        }
        let (mut changed, mut partial) = (json!([]), false);
        let (mut files, mut added, mut removed) = (0u32, 0u32, 0u32);
        if let Some(before) = &s.before {
            partial = before.truncated;
            let list = diff_snapshots(Some(&app2), before, &s.cwd, &if s.label.is_empty() { "turn".to_string() } else { s.label.clone() });
            let mut arr = Vec::new();
            for c in list {
                let mut v = serde_json::to_value(&c).unwrap_or(Value::Null);
                let was = before.files.get(&c.path).map(|b| b.as_slice()).unwrap_or(&[]);
                let now = std::fs::read(&c.path).unwrap_or_default();
                let (a, d) = line_delta(was, &now);
                v["added"] = json!(a);
                v["removed"] = json!(d);
                files += 1;
                added += a;
                removed += d;
                arr.push(v);
            }
            changed = Value::Array(arr);
        }
        {
            let mut g = sess2.inner.lock().unwrap();
            if files > 0 {
                g.summary = json!({"files": files, "added": added, "removed": removed, "at": now_ms()});
            }
            touch(&mut g);
        }
        emit(&app2, &sess2.handle, "turn_done", json!({"changed": changed, "snapshotPartial": partial, "tokens": s.tokens, "durationMs": s.duration_ms, "files": files, "added": added, "removed": removed}));
    });
}

/// The process ended. Usually on purpose (idle close, stop); otherwise something went wrong.
fn on_exit(app: &AppHandle, sess: &Arc<Sess>, gen: u64, code: Option<i32>, stderr: String) {
    let h = sess.handle.clone();
    let mut g = sess.inner.lock().unwrap();
    if g.gen != gen {
        return; // an older process, already replaced
    }
    g.proc = None;
    let intentional = std::mem::take(&mut g.closing);
    if !intentional && !g.proc_events {
        // A Claude Code without the (hidden) thinking-display option, or a session that was never
        // saved (killed before its first answer): run again without them.
        let thinking_opt = g.req.thinking && !NO_THINKING_DISPLAY.load(Ordering::Relaxed) && stderr.contains("thinking-display");
        let no_conv = g.resumed_proc && stderr.contains("No conversation found");
        if thinking_opt || no_conv {
            if thinking_opt {
                NO_THINKING_DISPLAY.store(true, Ordering::Relaxed);
            }
            if no_conv {
                g.claude_id = None;
                g.req.resume_id = None;
            }
            if spawn_proc(app, sess, &mut g).is_ok() {
                let lines: Vec<String> = g.pending.iter().map(|m| user_line(&m.text, &m.uuid, "next")).collect();
                for l in lines {
                    let _ = write_line(&mut g, l);
                }
                return;
            }
        }
    }
    let msg = {
        let m = stderr.lines().filter(|l| !l.trim().is_empty()).rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        if m.is_empty() { format!("Claude Code stopped (exit code {})", code.map(|c| c.to_string()).unwrap_or("?".into())) } else { m }
    };
    if g.turn_active || !g.pending.is_empty() {
        let status = if intentional { "idle" } else { "error" };
        if !intentional {
            g.last_error = Some(msg.clone());
        }
        let settled = settle_locked(sess, &mut g, status);
        let error = if intentional { Value::Null } else { json!(msg) };
        drop(g);
        emit(app, &h, "exit", json!({"error": error, "code": code}));
        finish_settled(app, sess, settled);
    } else {
        if g.ended.is_none() && g.status != "error" {
            g.status = "idle";
        }
        touch(&mut g);
        sess.cv.notify_all();
        emit_status(app, &h, &g);
    }
}

/// End the process (idle, or fell back from an interrupt that didn't work). The session stays;
/// the next message resumes it.
fn kill_proc(sess: &Sess, closing: bool) {
    let child = {
        let mut g = sess.inner.lock().unwrap();
        g.closing = closing;
        g.proc.take().map(|p| (p.child.clone(), p.tx, p.cfg, p.sys))
    };
    if let Some((child, tx, _cfg, _sys)) = child {
        drop(tx); // closes stdin: Claude Code finishes by itself
        std::thread::sleep(Duration::from_millis(300));
        child.kill_tree();
    }
}

fn close_process(app: &AppHandle, sess: &Arc<Sess>, reason: &str) {
    {
        let g = sess.inner.lock().unwrap();
        if g.turn_active || g.proc.is_none() {
            return;
        }
    }
    kill_proc(sess, true);
    let g = sess.inner.lock().unwrap();
    emit(app, &sess.handle, "status", {
        let mut s = status_json(&g);
        s["reason"] = json!(reason);
        s
    });
}

// ---------------- turns ----------------

fn begin_turn(app: &AppHandle, sess: &Arc<Sess>, msgs: Vec<Msg>) -> Result<(), String> {
    // a slot is held by the caller
    let cwd = {
        let mut g = sess.inner.lock().unwrap();
        g.turn_active = true;
        g.turn_started = Some(Instant::now());
        g.turn_started_ms = now_ms();
        g.status = if g.proc.is_some() { "running" } else { "starting" };
        g.interrupted = false;
        g.last_error = None;
        g.last_result_error = false;
        g.tokens = 0;
        touch(&mut g);
        emit_status(app, &sess.handle, &g);
        PathBuf::from(&g.req.cwd)
    };
    // Every text file of the project is copied (in memory) before the turn; afterwards each
    // changed file gets a "Before Claude Code" version and the window shows a diff with Undo.
    let before = if cwd.is_dir() {
        prune_backups(&backups_dir(app));
        Some(Arc::new(snapshot(&cwd)))
    } else {
        None
    };
    let mut g = sess.inner.lock().unwrap();
    g.before = before;
    let started = if g.proc.is_none() { spawn_proc(app, sess, &mut g) } else { Ok(()) };
    if let Err(e) = started {
        g.last_error = Some(e.clone());
        let settled = settle_locked(sess, &mut g, "error");
        drop(g);
        emit(app, &sess.handle, "exit", json!({"error": e, "code": null, "notStarted": true}));
        finish_settled(app, sess, settled);
        return Err(e);
    }
    for m in msgs {
        let line = user_line(&m.text, &m.uuid, "next");
        if let Err(e) = write_line(&mut g, line) {
            g.last_error = Some(e);
        }
        g.pending.push(m);
    }
    g.status = "running";
    touch(&mut g);
    emit_status(app, &sess.handle, &g);
    Ok(())
}

fn wait_idle(sess: &Sess, t: Duration) -> bool {
    let g = sess.inner.lock().unwrap();
    let (g, _) = sess.cv.wait_timeout_while(g, t, |i| i.turn_active && i.proc.is_some()).unwrap();
    !g.turn_active || g.proc.is_none()
}

fn apply_patch(g: &mut Inner, p: &SendPatch) -> Vec<(String, Value)> {
    let mut controls = Vec::new();
    if let Some(l) = &p.label {
        g.req.label = l.clone();
    }
    if let Some(t) = p.thinking {
        g.req.thinking = t;
    }
    if p.effort.is_some() {
        g.req.effort = p.effort.clone().filter(|e| !e.is_empty());
    }
    if p.web.is_some() {
        g.req.web = p.web.clone().filter(|e| !e.is_empty());
    }
    if let Some(s) = &p.system_append {
        g.req.system_append = s.clone();
    }
    if let Some(m) = &p.memory {
        g.meta["memory"] = json!(m);
    }
    if let Some(mode) = &p.permission_mode {
        g.req.permission_mode = mode.clone();
        if let Some(pr) = g.proc.as_mut() {
            if &pr.mode != mode {
                pr.mode = mode.clone();
                controls.push(("pm".to_string(), json!({"subtype": "set_permission_mode", "mode": mode})));
            }
        }
    }
    if let Some(model) = &p.model {
        let m = Some(model.clone()).filter(|m| !m.is_empty() && m != "default");
        g.req.model = m.clone();
        if let Some(pr) = g.proc.as_mut() {
            if pr.model != m {
                pr.model = m.clone();
                controls.push(("sm".to_string(), json!({"subtype": "set_model", "model": m})));
            }
        }
    }
    controls
}

#[tauri::command]
pub async fn cc_session_start(app: AppHandle, req: StartReq) -> CmdResult<Value> {
    ensure_bg(&app);
    set_limits(req.max_parallel, req.idle_minutes);
    let handle = req.handle.clone().filter(|h| !h.is_empty()).unwrap_or_else(|| format!("cs-{}", &new_uuid()[..8]));
    if get(&handle).is_some() {
        return Err("This session is already open".into());
    }
    let now = now_ms();
    let restored = req.restored;
    let g = Inner {
        meta: if req.meta.is_object() { req.meta.clone() } else { json!({}) },
        req,
        status: "idle",
        proc: None,
        gen: 0,
        closing: false,
        claude_id: None,
        model_seen: None,
        turn_active: false,
        turn_started: None,
        turn_started_ms: 0,
        pending: vec![],
        unsent: vec![],
        todos: json!([]),
        step: Value::Null,
        tokens: 0,
        waiting_perms: 0,
        cli_requires_action: false,
        saw_state_events: false,
        proc_events: false,
        resumed_proc: false,
        last_activity: Instant::now(),
        created: now,
        updated: now,
        ended: None,
        last_error: None,
        last_result_error: false,
        interrupted: false,
        summary: Value::Null,
        waiters: HashMap::new(),
        before: None,
        restored_pending: restored,
        dirty: true,
    };
    let sess = Arc::new(Sess { handle: handle.clone(), inner: Mutex::new(g), cv: Condvar::new() });
    {
        let mut g = sess.inner.lock().unwrap();
        g.claude_id = g.req.resume_id.clone().filter(|s| !s.is_empty());
    }
    mgr().map.lock().unwrap().insert(handle.clone(), sess.clone());
    write_journal(&app, &sess);
    Ok(json!({"handle": handle}))
}

/// `mode`: "next" — the model reads it after the step it is doing now; "now" — stop what it is
/// doing (interrupt), wait for the turn to end, then send it.
#[tauri::command]
pub async fn cc_session_send(app: AppHandle, handle: String, text: String, mode: String, uuid: Option<String>, patch: Option<SendPatch>) -> CmdResult<Value> {
    let sess = get(&handle).ok_or("This session isn't open any more")?;
    tauri::async_runtime::spawn_blocking(move || send_blocking(&app, &sess, text, mode, uuid.unwrap_or_else(new_uuid), patch.unwrap_or_default())).await.es()?
}

fn send_blocking(app: &AppHandle, sess: &Arc<Sess>, text: String, mode: String, uuid: String, patch: SendPatch) -> CmdResult<Value> {
    set_limits(patch.max_parallel, patch.idle_minutes);
    let controls = {
        let mut g = sess.inner.lock().unwrap();
        if g.ended.is_some() {
            return Err("This session has ended".into());
        }
        apply_patch(&mut g, &patch)
    };
    {
        let mut g = sess.inner.lock().unwrap();
        for (id, req) in controls {
            let _ = send_control(&mut g, &format!("{id}-{}", SEQ.fetch_add(1, Ordering::SeqCst)), req);
        }
    }
    // "Ngắt & gửi": stop the running step, wait for the turn to end, then send
    if mode == "now" {
        let active = {
            let mut g = sess.inner.lock().unwrap();
            if g.turn_active && g.proc.is_some() {
                g.interrupted = true;
                let _ = send_control(&mut g, &format!("int-{}", SEQ.fetch_add(1, Ordering::SeqCst)), json!({"subtype": "interrupt"}));
                true
            } else {
                false
            }
        };
        if active && !wait_idle(sess, Duration::from_secs(8)) {
            // it did not stop: end the process; the session resumes from its transcript
            kill_proc(sess, true);
            let settled = {
                let mut g = sess.inner.lock().unwrap();
                settle_locked(sess, &mut g, "idle")
            };
            finish_settled(app, sess, settled);
        }
    }
    let memory = patch.memory.clone().filter(|m| !m.trim().is_empty());
    let alive_now = sess.inner.lock().unwrap().proc.is_some();
    let body = match &memory {
        Some(m) if alive_now => format!("<callio-memory>\n{}\n</callio-memory>\n\n{text}", m.trim()),
        _ => text.clone(),
    };
    let msg = Msg { uuid: uuid.clone(), text: body, mode: if mode == "now" { "now".into() } else { "next".into() }, at: now_ms() };
    let mut g = sess.inner.lock().unwrap();
    if g.turn_active && g.proc.is_some() {
        // mid-turn: the model reads it after the step it is doing now
        let line = user_line(&msg.text, &msg.uuid, "next");
        write_line(&mut g, line)?;
        g.pending.push(msg);
        g.last_activity = Instant::now();
        touch(&mut g);
        emit_status(app, &sess.handle, &g);
        return Ok(json!({"uuid": uuid, "state": "sent"}));
    }
    if try_acquire() {
        drop(g);
        begin_turn(app, sess, vec![msg])?;
        return Ok(json!({"uuid": uuid, "state": "sent"}));
    }
    // no free slot: wait in line (the window shows "queued")
    g.unsent.push(msg);
    g.status = "queued";
    touch(&mut g);
    emit_status(app, &sess.handle, &g);
    drop(g);
    let mut w = mgr().waiting.lock().unwrap();
    if !w.contains(&sess.handle) {
        w.push_back(sess.handle.clone());
    }
    Ok(json!({"uuid": uuid, "state": "queued"}))
}

/// Take back a message that Claude Code has not read yet. Returns whether it was withdrawn.
#[tauri::command]
pub async fn cc_session_cancel_queued(app: AppHandle, handle: String, uuid: String) -> CmdResult<bool> {
    let sess = get(&handle).ok_or("This session isn't open any more")?;
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<bool> {
        let rx = {
            let mut g = sess.inner.lock().unwrap();
            if let Some(i) = g.unsent.iter().position(|m| m.uuid == uuid) {
                g.unsent.remove(i);
                if g.unsent.is_empty() && g.status == "queued" {
                    g.status = "idle";
                    mgr().waiting.lock().unwrap().retain(|h| h != &handle);
                }
                touch(&mut g);
                emit_status(&app, &handle, &g);
                return Ok(true);
            }
            if !g.pending.iter().any(|m| m.uuid == uuid) {
                return Ok(false);
            }
            let id = format!("cancel-{}", SEQ.fetch_add(1, Ordering::SeqCst));
            let (tx, rx) = mpsc::channel();
            g.waiters.insert(id.clone(), tx);
            send_control(&mut g, &id, json!({"subtype": "cancel_async_message", "message_uuid": uuid}))?;
            (rx, id)
        };
        let ok = rx.0.recv_timeout(Duration::from_secs(3)).map(|v| v["cancelled"].as_bool().unwrap_or(false)).unwrap_or(false);
        let mut g = sess.inner.lock().unwrap();
        g.waiters.remove(&rx.1);
        if ok {
            g.pending.retain(|m| m.uuid != uuid);
            touch(&mut g);
            emit_status(&app, &handle, &g);
        }
        Ok(ok)
    })
    .await
    .es()?
}

/// Stop: halt the running step and drop the queue. The session stays open.
#[tauri::command]
pub async fn cc_session_interrupt(app: AppHandle, handle: String) -> CmdResult<()> {
    let sess = get(&handle).ok_or("This session isn't open any more")?;
    let waiting_only = {
        let mut g = sess.inner.lock().unwrap();
        g.unsent.clear();
        g.interrupted = true;
        if g.proc.is_some() && g.turn_active {
            g.pending.clear();
            let _ = send_control(&mut g, &format!("int-{}", SEQ.fetch_add(1, Ordering::SeqCst)), json!({"subtype": "interrupt", "cancel_queued": true}));
            touch(&mut g);
            emit_status(&app, &handle, &g);
            false
        } else {
            true
        }
    };
    mgr().waiting.lock().unwrap().retain(|h| h != &handle);
    if waiting_only {
        let mut g = sess.inner.lock().unwrap();
        if g.status == "queued" {
            g.status = "idle";
        }
        touch(&mut g);
        emit_status(&app, &handle, &g);
        return Ok(());
    }
    // if Claude Code does not stop within a few seconds, end the process (it resumes next time)
    let (app2, sess2) = (app.clone(), sess.clone());
    std::thread::spawn(move || {
        if !wait_idle(&sess2, Duration::from_secs(6)) {
            kill_proc(&sess2, true);
            let settled = {
                let mut g = sess2.inner.lock().unwrap();
                settle_locked(&sess2, &mut g, "idle")
            };
            finish_settled(&app2, &sess2, settled);
        }
    });
    Ok(())
}

/// Close the session for good (the tab was closed): end the process, keep the journal as ended.
#[tauri::command]
pub async fn cc_session_stop(app: AppHandle, handle: String) -> CmdResult<()> {
    let Some(sess) = get(&handle) else { return Ok(()) };
    tauri::async_runtime::spawn_blocking(move || {
        mgr().waiting.lock().unwrap().retain(|h| h != &handle);
        let (settled, files) = {
            let mut g = sess.inner.lock().unwrap();
            g.ended = Some(now_ms());
            g.unsent.clear();
            let files = g.proc.as_ref().map(|p| (p.cfg.clone(), p.sys.clone()));
            (settle_locked(&sess, &mut g, "ended"), files)
        };
        kill_proc(&sess, true);
        finish_settled(&app, &sess, settled);
        write_journal(&app, &sess);
        mgr().map.lock().unwrap().remove(&handle);
        if let Some((a, b)) = files {
            let _ = std::fs::remove_file(a);
            let _ = std::fs::remove_file(b);
        }
        emit(&app, &handle, "status", json!({"status": "ended", "proc": false, "turnActive": false, "queued": []}));
    })
    .await
    .es()
}

/// Stop one subagent (or background task) without stopping the session.
#[tauri::command]
pub fn cc_session_stop_task(handle: String, task_id: String) -> CmdResult<()> {
    let s = get(&handle).ok_or("This session isn't open any more")?;
    let mut g = s.inner.lock().unwrap();
    send_control(&mut g, &format!("stop-{}", SEQ.fetch_add(1, Ordering::SeqCst)), json!({"subtype": "stop_task", "task_id": task_id}))
}

#[tauri::command]
pub fn cc_session_state(handle: String) -> CmdResult<Value> {
    let s = get(&handle).ok_or("This session isn't open any more")?;
    let g = s.inner.lock().unwrap();
    Ok(full_state(&handle, &g))
}

#[tauri::command]
pub fn cc_session_list() -> Vec<Value> {
    let all: Vec<Arc<Sess>> = mgr().map.lock().unwrap().values().cloned().collect();
    let mut v: Vec<Value> = all.iter().map(|s| full_state(&s.handle, &s.inner.lock().unwrap())).collect();
    v.sort_by_key(|x| x["createdAt"].as_u64().unwrap_or(0));
    v
}

/// The window's notes about a session (chat id, project, title): kept in the journal.
#[tauri::command]
pub fn cc_session_meta(handle: String, meta: Value) -> CmdResult<()> {
    let s = get(&handle).ok_or("This session isn't open any more")?;
    let mut g = s.inner.lock().unwrap();
    if let (Some(dst), Some(src)) = (g.meta.as_object_mut(), meta.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    if let Some(l) = meta["title"].as_str() {
        if g.req.label.is_empty() {
            g.req.label = l.to_string();
        }
    }
    touch(&mut g);
    Ok(())
}

/// The AI chat moved to another window (popped out, or attached back): from now on this session's
/// permission questions go to `label`, and the ones still waiting are asked there again. The new
/// window shows each question once (it knows the rpc ids it already has).
#[tauri::command]
pub fn cc_session_set_window(app: AppHandle, handle: String, label: String) -> CmdResult<()> {
    let s = get(&handle).ok_or("This session isn't open any more")?;
    {
        let mut g = s.inner.lock().unwrap();
        g.req.window = Some(label.clone());
        if let Some(m) = g.meta.as_object_mut() {
            m.insert("win".into(), json!(label));
        } else {
            g.meta = json!({ "win": label });
        }
        touch(&mut g);
    }
    super::mcp::reemit_pending(&app, &handle, &label);
    Ok(())
}

/// A permission question (MCP `approve`) is open or answered: the session shows "needs you".
pub fn perm_delta(app: &AppHandle, handle: &str, d: i32) {
    let Some(s) = get(handle) else { return };
    let mut g = s.inner.lock().unwrap();
    g.waiting_perms = (g.waiting_perms as i32 + d).max(0) as u32;
    if g.turn_active {
        g.status = if g.waiting_perms > 0 || g.cli_requires_action { "waiting" } else { "running" };
    }
    touch(&mut g);
    emit_status(app, handle, &g);
}

/// All journals on disk, newest first (for restore after a crash and the sessions list).
#[tauri::command]
pub fn cc_journal_list(app: AppHandle) -> Vec<Value> {
    let live: Vec<String> = mgr().map.lock().unwrap().keys().cloned().collect();
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(journal_dir(&app)) {
        for e in rd.flatten() {
            if e.path().extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            if let Some(mut v) = std::fs::read(e.path()).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
                v["live"] = json!(v["handle"].as_str().map(|h| live.iter().any(|l| l == h)).unwrap_or(false));
                out.push(v);
            }
        }
    }
    out.sort_by_key(|x| std::cmp::Reverse(x["updatedAt"].as_u64().unwrap_or(0)));
    out
}

/// Mark journals as ended (the author chose not to bring the sessions back).
#[tauri::command]
pub fn cc_journal_end(app: AppHandle, handles: Option<Vec<String>>) -> CmdResult<u32> {
    let live: Vec<String> = mgr().map.lock().unwrap().keys().cloned().collect();
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(journal_dir(&app)) {
        for e in rd.flatten() {
            let Some(mut v) = std::fs::read(e.path()).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { continue };
            let h = v["handle"].as_str().unwrap_or("").to_string();
            if live.contains(&h) || v["cleanEnd"].as_bool().unwrap_or(true) || handles.as_ref().map(|l| !l.contains(&h)).unwrap_or(false) {
                continue;
            }
            v["cleanEnd"] = json!(true);
            v["status"] = json!("ended");
            v["endedAt"] = json!(now_ms());
            v["queued"] = json!([]);
            let tmp = e.path().with_extension("json.tmp");
            if std::fs::write(&tmp, v.to_string()).is_ok() && std::fs::rename(&tmp, e.path()).is_ok() {
                n += 1;
            }
        }
    }
    Ok(n)
}

/// The app is closing: end every process and mark the journals clean (closing Callio on purpose
/// is not a crash; only a power cut or a kill leaves a journal unfinished).
pub fn on_app_exit(app: &AppHandle) {
    let all: Vec<Arc<Sess>> = mgr().map.lock().unwrap().values().cloned().collect();
    for s in all {
        {
            let mut g = s.inner.lock().unwrap();
            g.ended = Some(now_ms());
            g.pending.clear();
            g.unsent.clear();
            g.status = "ended";
        }
        kill_proc(&s, true);
        write_journal(app, &s);
    }
}

/// The window a session belongs to (its permission questions go there).
/// [wsl] The distro this session's Claude Code runs in (its file paths are Linux paths); None on Windows.
pub(crate) fn wsl_distro_of(handle: &str) -> Option<String> {
    let s = mgr().map.lock().ok()?.get(handle).cloned()?;
    let g = s.inner.lock().ok()?;
    crate::envs::claude::distro_for(&g.req.run_in, &g.req.cwd)
}

pub(crate) fn window_of(handle: &str) -> Option<String> {
    let s = mgr().map.lock().ok()?.get(handle).cloned()?;
    let w = s.inner.lock().ok()?.req.window.clone();
    w.filter(|w| !w.is_empty())
}
