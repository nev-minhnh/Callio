//! Claude Code inside Callio's AI panel. Callio runs the official `claude` command-line tool
//! headless (`claude -p --output-format stream-json`) in the project folder, with the user's
//! own Claude sign-in (Pro/Max plan or API key, handled entirely by Claude Code — Callio never
//! sees the credentials). Output is streamed into the chat; permission questions come back
//! through Callio's MCP server (`mcp.rs`) and are answered in Callio's window.
//!
//! Safety: every text file in the project is snapshotted in memory before a turn; afterwards
//! each changed file gets a "Before Claude Code" version in local history and the author sees
//! a diff with one-click undo.
pub mod mcp;

use crate::history;
use crate::settings::data_dir;
use crate::util::{command, run_with_timeout, safe_name, sha256_hex, which, CmdResult, ErrStr};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct CcState {
    runs: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
    /// runs stopped before their process existed
    cancelled: Mutex<std::collections::HashSet<String>>,
    server: tokio::sync::Mutex<Option<(u16, PathBuf)>>,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

/// Where Claude Code may be installed (native installer, npm, WinGet) besides PATH.
fn extra_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(h) = home() {
        v.push(h.join(".local").join("bin"));
        v.push(h.join(".claude").join("local"));
    }
    if let Some(a) = std::env::var_os("APPDATA") {
        v.push(PathBuf::from(a).join("npm"));
    }
    if let Some(l) = std::env::var_os("LOCALAPPDATA") {
        v.push(PathBuf::from(l).join("Microsoft").join("WinGet").join("Links"));
    }
    v
}

pub fn find_claude() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("CALLIO_CLAUDE").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }
    which("claude", &extra_dirs())
}

pub(crate) fn claude_cmd(exe: &Path) -> std::process::Command {
    let mut c = command(exe);
    // An API key in the environment would silently take precedence over the user's Claude
    // plan; Callio's Claude Code integration always uses the sign-in made in Claude Code.
    c.env_remove("ANTHROPIC_API_KEY");
    c
}

fn git_bash() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let mut cands = vec![PathBuf::from(r"C:\Program Files\Git\bin\bash.exe")];
        if let Some(l) = std::env::var_os("LOCALAPPDATA") {
            cands.push(PathBuf::from(l).join(r"Programs\Git\bin\bash.exe"));
        }
        if let Some(g) = which("git", &[]) {
            if let Some(root) = g.parent().and_then(|p| p.parent()) {
                cands.push(root.join("bin").join("bash.exe"));
            }
        }
        cands.into_iter().find(|p| p.is_file())
    }
    #[cfg(not(windows))]
    {
        which("bash", &[])
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcStatus {
    installed: bool,
    path: Option<String>,
    version: Option<String>,
    logged_in: bool,
    auth: Value,
    git_bash: bool,
}

#[tauri::command]
pub async fn cc_status() -> CmdResult<CcStatus> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(exe) = find_claude() else {
            return CcStatus { installed: false, path: None, version: None, logged_in: false, auth: Value::Null, git_bash: git_bash().is_some() };
        };
        let mut c = claude_cmd(&exe);
        c.arg("--version");
        let version = run_with_timeout(c, Duration::from_secs(30)).ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|s| !s.is_empty());
        let mut c = claude_cmd(&exe);
        c.args(["auth", "status"]);
        let (logged_in, auth) = match run_with_timeout(c, Duration::from_secs(30)) {
            Ok(o) => {
                let out = String::from_utf8_lossy(&o.stdout).to_string();
                let v: Value = serde_json::from_str(out.trim()).unwrap_or_else(|_| json!({"text": out.trim()}));
                let method = v["authMethod"].as_str().unwrap_or("");
                (v["loggedIn"].as_bool().unwrap_or(o.status.success() && !method.is_empty() && method != "none"), v)
            }
            Err(e) => (false, json!({"error": e.to_string()})),
        };
        CcStatus { installed: true, path: Some(exe.to_string_lossy().into()), version, logged_in, auth, git_bash: git_bash().is_some() }
    })
    .await
    .es()
}

/// Install Claude Code with Anthropic's official installer; output lines go to "cc-install".
#[tauri::command]
pub async fn cc_install(app: AppHandle) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<()> {
        #[cfg(windows)]
        let mut c = {
            let mut c = command("powershell.exe");
            c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"]);
            c
        };
        #[cfg(not(windows))]
        let mut c = {
            let mut c = command("bash");
            c.args(["-c", "curl -fsSL https://claude.ai/install.sh | bash"]);
            c
        };
        c.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = c.spawn()?;
        let err = child.stderr.take().unwrap();
        let app2 = app.clone();
        let t = std::thread::spawn(move || {
            let mut tail = Vec::new();
            for l in std::io::BufReader::new(err).lines().map_while(Result::ok) {
                let _ = app2.emit("cc-install", l.clone());
                tail.push(l);
            }
            tail
        });
        for l in std::io::BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
            let _ = app.emit("cc-install", l);
        }
        let st = child.wait()?;
        let errs = t.join().unwrap_or_default();
        if !st.success() || find_claude().is_none() {
            anyhow::bail!("The installer didn't finish: {}", errs.iter().rev().take(4).rev().cloned().collect::<Vec<_>>().join(" "));
        }
        Ok(())
    })
    .await
    .es()?
    .es()
}

/// Sign in: Claude Code's own sign-in runs in a console window (it opens the browser).
#[tauri::command]
pub fn cc_login() -> CmdResult<()> {
    let exe = find_claude().ok_or("Claude Code isn't installed")?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        let mut c = std::process::Command::new("cmd.exe");
        c.raw_arg(format!("/k \"title Sign in to Claude Code && \"{}\" auth login && echo. && echo Signed in - you can close this window.\"", exe.display()));
        c.env_remove("ANTHROPIC_API_KEY");
        c.creation_flags(CREATE_NEW_CONSOLE);
        c.spawn().es()?;
    }
    #[cfg(not(windows))]
    {
        let _ = exe;
        return Err("Run `claude auth login` in a terminal".into());
    }
    #[allow(unreachable_code)]
    Ok(())
}

#[tauri::command]
pub async fn cc_logout() -> CmdResult<()> {
    let exe = find_claude().ok_or("Claude Code isn't installed")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut c = claude_cmd(&exe);
        c.args(["auth", "logout"]);
        run_with_timeout(c, Duration::from_secs(30)).map(|_| ())
    })
    .await
    .es()?
    .es()
}

// ---------------- project snapshot ----------------

const TEXT_EXT: &[&str] = &[
    "tex", "ltx", "sty", "cls", "bib", "bst", "bbx", "cbx", "md", "markdown", "txt", "rst", "csv", "tsv", "json", "yaml", "yml", "toml", "py", "r", "jl", "m", "js", "ts", "html", "css", "xml", "tikz", "dat",
];

pub struct Snapshot {
    pub files: HashMap<String, Vec<u8>>,
    /// some files were left out (limits reached)
    pub truncated: bool,
}

/// path → content of the project's text files (bounded), to compare after a turn.
pub fn snapshot(root: &Path) -> Snapshot {
    let mut out = HashMap::new();
    let mut truncated = false;
    let mut total = 0usize;
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "node_modules" || name == "__pycache__" || name == "target" {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if depth < 8 {
                    stack.push((e.path(), depth + 1));
                } else {
                    truncated = true;
                }
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            let ext = name.rsplit_once('.').map(|(_, x)| x.to_ascii_lowercase()).unwrap_or_default();
            if !TEXT_EXT.contains(&ext.as_str()) {
                continue;
            }
            let Ok(md) = e.metadata() else { continue };
            if md.len() > 4 << 20 || out.len() >= 5000 || total + md.len() as usize > 96 << 20 {
                truncated = true;
                continue;
            }
            if let Ok(b) = std::fs::read(e.path()) {
                total += b.len();
                out.insert(e.path().to_string_lossy().to_string(), b);
            }
        }
    }
    Snapshot { files: out, truncated }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Changed {
    pub path: String,
    /// "modified" | "added" | "deleted"
    pub status: String,
    /// local-history version with the text from before the turn (for the diff)
    pub before_version: Option<String>,
    /// exact copy of the file's bytes from before the turn (for Undo; any encoding)
    pub backup: Option<String>,
    /// hash of the file right after the turn (Undo checks nobody changed it since)
    pub after_sha: Option<String>,
}

fn backups_dir(app: &AppHandle) -> PathBuf {
    data_dir(app).join("claude-code").join("backups")
}

/// Remove backups older than 30 days.
fn prune_backups(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|d| d.as_secs() > 30 * 86400).unwrap_or(false);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

fn diff_snapshots(app: Option<&AppHandle>, before: &Snapshot, root: &Path, label: &str) -> Vec<Changed> {
    let after = snapshot(root);
    let bdir = app.map(backups_dir);
    if let Some(d) = &bdir {
        let _ = std::fs::create_dir_all(d);
    }
    let mut out = Vec::new();
    let mut keep = |path: &str, bytes: Option<&Vec<u8>>, now: Option<&[u8]>, status: &str| {
        let (mut before_version, mut backup) = (None, None);
        if let Some(b) = bytes {
            let sha = sha256_hex(b);
            if let Some(d) = &bdir {
                let f = d.join(&sha);
                if f.exists() || std::fs::write(&f, b).is_ok() {
                    backup = Some(f.to_string_lossy().to_string());
                }
            }
            if let (Some(app), Ok(t)) = (app, std::str::from_utf8(b)) {
                before_version = history::record(app, path, t, &format!("Before Claude Code: {label}"), "ai").ok().flatten().map(|v| v.id).or_else(|| history::latest_id_with_sha(app, path, &sha));
            }
        }
        out.push(Changed { path: path.to_string(), status: status.into(), before_version, backup, after_sha: now.map(sha256_hex) });
    };
    for (p, b) in &before.files {
        match after.files.get(p) {
            Some(a) if a == b => {}
            Some(a) => keep(p, Some(b), Some(a), "modified"),
            None if !Path::new(p).exists() => keep(p, Some(b), None, "deleted"),
            // left out of the second snapshot by its limits: compare with the disk directly
            None => {
                if let Ok(a) = std::fs::read(p) {
                    if &a != b {
                        keep(p, Some(b), Some(&a), "modified");
                    }
                }
            }
        }
    }
    for (p, a) in &after.files {
        // with a partial first snapshot, a file missing from it may simply have been skipped
        if !before.files.contains_key(p) && !before.truncated {
            keep(p, None, Some(a), "added");
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Undo: put a file back exactly as it was before Claude Code's turn.
#[tauri::command]
pub async fn cc_restore(app: AppHandle, path: String, backup: String, expected_sha: Option<String>, force: bool) -> CmdResult<()> {
    let bdir = backups_dir(&app);
    let b = PathBuf::from(&backup);
    if !b.starts_with(&bdir) {
        return Err("Not a Callio backup".into());
    }
    let bytes = std::fs::read(&b).map_err(|_| "The saved copy is gone (backups are kept for 30 days)".to_string())?;
    match std::fs::read(&path) {
        Ok(cur) => {
            if !force && expected_sha.as_deref().map(|e| e != sha256_hex(&cur)).unwrap_or(false) {
                return Err("CHANGED_SINCE".into());
            }
            // keep what is there now, so Undo can itself be undone
            let sha = sha256_hex(&cur);
            std::fs::create_dir_all(&bdir).es()?;
            std::fs::write(bdir.join(&sha), &cur).es()?;
            if let Ok(t) = std::str::from_utf8(&cur) {
                history::record(&app, &path, t, "Before undoing Claude Code", "restore").es()?;
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    if let Some(d) = Path::new(&path).parent() {
        std::fs::create_dir_all(d).es()?;
    }
    std::fs::write(&path, bytes).es()
}

// ---------------- running a turn ----------------

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CcRequest {
    id: String,
    prompt: String,
    session_id: Option<String>,
    model: Option<String>,
    cwd: String,
    /// "default" | "acceptEdits" | "auto" | "bypassPermissions" | "plan"
    permission_mode: String,
    #[serde(default)]
    system_append: String,
    #[serde(default)]
    label: String,
    /// "low" | "medium" | "high" | "xhigh" | "max"
    #[serde(default)]
    effort: Option<String>,
    /// stream summarized thinking
    #[serde(default)]
    thinking: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CcResult {
    session_id: Option<String>,
    result: String,
    is_error: bool,
    cancelled: bool,
    cost_usd: Option<f64>,
    duration_ms: Option<u64>,
    num_turns: Option<u64>,
    error: Option<String>,
    changed: Vec<Changed>,
    /// the project was too big to protect every file
    snapshot_partial: bool,
}

fn trunc(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let mut i = n;
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    format!("{}… [{} more characters]", &s[..i], s.len() - i)
}

/// Turn one stream-json line into a small UI event (None = nothing to show).
pub fn ui_event(v: &Value) -> Option<Value> {
    match v["type"].as_str()? {
        "stream_event" => {
            let e = &v["event"];
            match e["type"].as_str()? {
                "content_block_delta" => match e["delta"]["type"].as_str()? {
                    "text_delta" => Some(json!({"t": "text", "text": e["delta"]["text"]})),
                    "thinking_delta" => Some(json!({"t": "thinking", "text": e["delta"]["thinking"]})),
                    _ => None,
                },
                "message_start" => Some(json!({"t": "message_start"})),
                _ => None,
            }
        }
        "assistant" => {
            let mut tools = Vec::new();
            let mut text = String::new();
            for b in v["message"]["content"].as_array()? {
                match b["type"].as_str() {
                    Some("tool_use") => {
                        let input = b["input"].clone();
                        let s = serde_json::to_string(&input).unwrap_or_default();
                        tools.push(json!({"id": b["id"], "name": b["name"], "input": if s.len() > 6000 { json!({"_summary": trunc(&s, 6000)}) } else { input }}));
                    }
                    Some("text") => text.push_str(b["text"].as_str().unwrap_or("")),
                    _ => {}
                }
            }
            Some(json!({"t": "assistant", "text": text, "tools": tools, "sub": !v["parent_tool_use_id"].is_null()}))
        }
        "user" => {
            let mut results = Vec::new();
            for b in v["message"]["content"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
                if b["type"] == "tool_result" {
                    let text = match &b["content"] {
                        Value::String(s) => s.clone(),
                        Value::Array(a) => a.iter().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join("\n"),
                        _ => String::new(),
                    };
                    results.push(json!({"id": b["tool_use_id"], "isError": b["is_error"].as_bool().unwrap_or(false), "text": trunc(&text, 800)}));
                }
            }
            (!results.is_empty()).then(|| json!({"t": "tool_results", "results": results}))
        }
        "system" => match v["subtype"].as_str() {
            Some("init") => Some(json!({"t": "init", "model": v["model"], "sessionId": v["session_id"], "mcp": v["mcp_servers"], "permissionMode": v["permissionMode"]})),
            Some(s) => Some(json!({"t": "system", "subtype": s})),
            None => None,
        },
        "result" => Some(json!({"t": "result", "isError": v["is_error"], "subtype": v["subtype"]})),
        _ => None,
    }
}

async fn ensure_server(app: &AppHandle, st: &CcState) -> anyhow::Result<PathBuf> {
    let mut g = st.server.lock().await;
    if let Some((_, cfg)) = g.as_ref() {
        return Ok(cfg.clone());
    }
    let srv = mcp::start(mcp::window_asker(app.clone())).await?;
    let dir = data_dir(app).join("claude-code");
    std::fs::create_dir_all(&dir)?;
    let cfg = dir.join("callio-mcp.json");
    let body = mcp_config_json(srv.port, &srv.token);
    std::fs::write(&cfg, serde_json::to_vec_pretty(&body)?)?;
    *g = Some((srv.port, cfg.clone()));
    Ok(cfg)
}

/// Command-line arguments for one headless turn.
/// Set when this Claude Code doesn't know `--thinking-display` (it is a hidden option).
static NO_THINKING_DISPLAY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub struct Extra<'a> {
    pub effort: Option<&'a str>,
    pub thinking: bool,
}

pub fn run_args(mcp_cfg: &Path, sys_file: &Path, mode: &str, model: Option<&str>, session: Option<&str>, extra: &Extra) -> Vec<std::ffi::OsString> {
    let mut a: Vec<std::ffi::OsString> = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--mcp-config"].iter().map(Into::into).collect();
    a.push(mcp_cfg.into());
    for x in ["--permission-prompt-tool", "mcp__callio__approve", "--allowedTools", "mcp__callio__editor_state,mcp__callio__compile,mcp__callio__open_file,mcp__callio__search_library,mcp__callio__read_library_paper,mcp__callio__library_bibtex,mcp__callio__read_pdf,mcp__callio__view_pdf_page", "--append-system-prompt-file"] {
        a.push(x.into());
    }
    a.push(sys_file.into());
    a.push("--permission-mode".into());
    a.push(match mode {
        "acceptEdits" => "acceptEdits",
        "plan" => "plan",
        // Claude Code's auto mode: a classifier approves each action (no questions)
        "auto" => "auto",
        // never asks (Claude Code still refuses a few dangerous actions)
        "bypassPermissions" => "bypassPermissions",
        _ => "default",
    }
    .into());
    if let Some(m) = model.filter(|m| !m.is_empty() && *m != "default") {
        a.push("--model".into());
        a.push(m.into());
    }
    if let Some(s) = session.filter(|s| !s.is_empty()) {
        a.push("--resume".into());
        a.push(s.into());
    }
    if let Some(e) = extra.effort.filter(|e| ["low", "medium", "high", "xhigh", "max"].contains(e)) {
        a.push("--effort".into());
        a.push(e.into());
    }
    if extra.thinking && !NO_THINKING_DISPLAY.load(std::sync::atomic::Ordering::Relaxed) {
        a.push("--thinking-display".into());
        a.push("summarized".into());
    }
    a
}

pub fn mcp_config_json(port: u16, token: &str) -> Value {
    json!({"mcpServers": {"callio": {"type": "http", "url": format!("http://127.0.0.1:{port}/mcp"), "headers": {"Authorization": format!("Bearer {token}")}}}})
}

#[tauri::command]
pub async fn cc_run(app: AppHandle, req: CcRequest) -> CmdResult<CcResult> {
    let st = app.state::<CcState>();
    let exe = find_claude().ok_or("CLAUDE_MISSING")?;
    let cwd = PathBuf::from(&req.cwd);
    if !cwd.is_dir() {
        return Err("Open a project folder (or a saved file) first".into());
    }
    let mcp_cfg = ensure_server(&app, &st).await.es()?;
    let sys_file = data_dir(&app).join("claude-code").join(format!("system-{}.md", safe_name(&req.id)));
    std::fs::write(&sys_file, &req.system_append).es()?;
    struct Rm(PathBuf);
    impl Drop for Rm {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _rm = Rm(sys_file.clone());
    let stopped = |st: &CcState| st.cancelled.lock().unwrap().remove(&req.id);
    let cancelled_result = || CcResult { cancelled: true, session_id: req.session_id.clone(), ..Default::default() };

    let root = cwd.clone();
    let bdir = backups_dir(&app);
    let before = tauri::async_runtime::spawn_blocking(move || {
        prune_backups(&bdir);
        snapshot(&root)
    })
    .await
    .es()?;
    if stopped(&st) {
        return Ok(cancelled_result());
    }

    let mut c = claude_cmd(&exe);
    let extra = Extra { effort: req.effort.as_deref(), thinking: req.thinking };
    let with_display = req.thinking && !NO_THINKING_DISPLAY.load(std::sync::atomic::Ordering::Relaxed);
    c.current_dir(&cwd).args(run_args(&mcp_cfg, &sys_file, &req.permission_mode, req.model.as_deref(), req.session_id.as_deref(), &extra));
    c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| format!("Couldn't start Claude Code: {e}"))?;
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let prompt = req.prompt.clone();
    std::thread::spawn(move || {
        let _ = stdin.write_all(prompt.as_bytes());
        // dropping stdin closes it: Claude Code reads the prompt to the end
    });
    let err_t = std::thread::spawn(move || {
        // read to the end (so the CLI never blocks on a full pipe), keep the last 64 KB
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
    let child = Arc::new(Mutex::new(child));
    st.runs.lock().unwrap().insert(req.id.clone(), child.clone());
    if stopped(&st) {
        // Stop was pressed while we were getting ready
        kill_tree(&child);
        st.runs.lock().unwrap().remove(&req.id);
    }

    let (app2, id2) = (app.clone(), req.id.clone());
    let read = tauri::async_runtime::spawn_blocking(move || {
        let mut session = None;
        let mut result: Option<Value> = None;
        let mut texts = String::new();
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
            if let Some(s) = v["session_id"].as_str() {
                session = Some(s.to_string());
            }
            if v["type"] == "result" {
                result = Some(v.clone());
            }
            if let Some(ev) = ui_event(&v) {
                if ev["t"] == "assistant" {
                    texts.push_str(ev["text"].as_str().unwrap_or(""));
                }
                let _ = app2.emit("cc-event", json!({"id": id2, "ev": ev}));
            }
        }
        (session, result, texts)
    });
    let (session, result, _texts) = read.await.es()?;
    let status = tauri::async_runtime::spawn_blocking({
        let child = child.clone();
        move || loop {
            if let Ok(Some(s)) = child.lock().unwrap().try_wait() {
                return Some(s);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    })
    .await
    .es()?;
    let cancelled = st.runs.lock().unwrap().remove(&req.id).is_none();
    let stderr = err_t.join().unwrap_or_default();
    // an older/newer Claude Code without the (hidden) thinking-display option: run again without it
    if result.is_none() && !cancelled && with_display && stderr.contains("thinking-display") {
        NO_THINKING_DISPLAY.store(true, std::sync::atomic::Ordering::Relaxed);
        drop(_rm);
        return Box::pin(cc_run(app.clone(), req.clone())).await;
    }

    let root = cwd.clone();
    let (app3, label) = (app.clone(), if req.label.is_empty() { "turn".to_string() } else { req.label.clone() });
    let partial = before.truncated;
    let changed = tauri::async_runtime::spawn_blocking(move || diff_snapshots(Some(&app3), &before, &root, &label)).await.es()?;

    let mut out = CcResult { session_id: session, cancelled, changed, snapshot_partial: partial, ..Default::default() };
    if let Some(r) = result {
        out.result = r["result"].as_str().unwrap_or("").to_string();
        out.is_error = r["is_error"].as_bool().unwrap_or(false);
        out.cost_usd = r["total_cost_usd"].as_f64();
        out.duration_ms = r["duration_ms"].as_u64();
        out.num_turns = r["num_turns"].as_u64();
        if out.is_error {
            let errs = r["errors"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from).or_else(|| x["message"].as_str().map(String::from))).collect::<Vec<_>>().join("\n")).unwrap_or_default();
            out.error = Some(if !errs.is_empty() { errs } else if !out.result.is_empty() { out.result.clone() } else { r["subtype"].as_str().unwrap_or("error").to_string() });
        }
    } else if !cancelled {
        let code = status.and_then(|s| s.code());
        let msg = stderr.lines().filter(|l| !l.trim().is_empty()).rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        out.is_error = true;
        out.error = Some(if msg.is_empty() { format!("Claude Code stopped (exit code {})", code.map(|c| c.to_string()).unwrap_or("?".into())) } else { msg });
    }
    Ok(out)
}

fn kill_tree(child: &Arc<Mutex<Child>>) {
    let pid = child.lock().unwrap().id();
    #[cfg(windows)]
    {
        // end the whole tree (Claude Code's shells too)
        let mut k = command("taskkill");
        k.args(["/PID", &pid.to_string(), "/T", "/F"]);
        let _ = run_with_timeout(k, Duration::from_secs(10));
    }
    let _ = pid;
    let _ = child.lock().unwrap().kill();
}

#[tauri::command]
pub async fn cc_cancel(app: AppHandle, id: String) -> CmdResult<()> {
    let st = app.state::<CcState>();
    let child = st.runs.lock().unwrap().remove(&id);
    mcp::cancel_all();
    match child {
        Some(c) => tauri::async_runtime::spawn_blocking(move || kill_tree(&c)).await.es()?,
        None => {
            st.cancelled.lock().unwrap().insert(id);
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcSkill {
    name: String,
    description: String,
    path: String,
    /// "personal" | "project"
    source: String,
    /// "skill" | "command"
    kind: String,
}

/// Skills and slash commands Claude Code itself knows: ~/.claude and <project>/.claude.
#[tauri::command]
pub fn cc_skills(cwd: Option<String>) -> Vec<CcSkill> {
    let mut out: Vec<CcSkill> = Vec::new();
    let mut roots = Vec::new();
    if let Some(h) = home() {
        roots.push((h.join(".claude"), "personal"));
    }
    if let Some(c) = cwd.filter(|c| !c.is_empty()) {
        roots.push((PathBuf::from(c).join(".claude"), "project"));
    }
    for (root, source) in roots {
        if let Ok(rd) = std::fs::read_dir(root.join("skills")) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                let md = e.path().join("SKILL.md");
                if n.starts_with('.') || !md.is_file() {
                    continue;
                }
                let text = std::fs::read_to_string(&md).unwrap_or_default();
                let (_, desc) = crate::ai::skills::front_matter(&text);
                // Claude Code invokes a skill by its folder name
                out.push(CcSkill { name: n, description: desc.unwrap_or_default(), path: md.to_string_lossy().into(), source: source.into(), kind: "skill".into() });
            }
        }
        if let Ok(rd) = std::fs::read_dir(root.join("commands")) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                let Some(stem) = n.strip_suffix(".md") else { continue };
                let text = std::fs::read_to_string(e.path()).unwrap_or_default();
                let (_, desc) = crate::ai::skills::front_matter(&text);
                let desc = desc.unwrap_or_else(|| text.lines().find(|l| !l.trim().is_empty() && !l.starts_with("---")).unwrap_or("").chars().take(160).collect());
                out.push(CcSkill { name: stem.into(), description: desc, path: e.path().to_string_lossy().into(), source: source.into(), kind: "command".into() });
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out.dedup_by(|a, b| a.name == b.name);
    out
}

#[tauri::command]
pub fn cc_reply(rpc: u64, value: Value) {
    mcp::reply(rpc, value);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn events() {
        let d = json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}});
        assert_eq!(ui_event(&d).unwrap(), json!({"t":"text","text":"Hi"}));
        let a = json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"ok"},{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"a.tex"}}]}});
        let e = ui_event(&a).unwrap();
        assert_eq!(e["tools"][0]["name"], "Edit");
        assert_eq!(e["sub"], false);
        let u = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"done"}]}]}});
        assert_eq!(ui_event(&u).unwrap()["results"][0]["text"], "done");
        assert!(ui_event(&json!({"type":"stream_event","event":{"type":"ping"}})).is_none());
    }
    #[test]
    fn snapshot_diff() {
        let d = std::env::temp_dir().join(format!("callio-cc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("sec")).unwrap();
        std::fs::create_dir_all(d.join(".git")).unwrap();
        std::fs::write(d.join("main.tex"), "a").unwrap();
        std::fs::write(d.join("sec/intro.tex"), "b").unwrap();
        std::fs::write(d.join(".git/x.txt"), "z").unwrap();
        std::fs::write(d.join("fig.png"), "png").unwrap();
        let s = snapshot(&d);
        assert_eq!(s.files.len(), 2);
        std::fs::write(d.join("main.tex"), "A").unwrap();
        std::fs::remove_file(d.join("sec/intro.tex")).unwrap();
        std::fs::write(d.join("new.md"), "n").unwrap();
        let c = diff_snapshots(None, &s, &d, "t");
        let st: Vec<_> = c.iter().map(|c| (Path::new(&c.path).file_name().unwrap().to_string_lossy().to_string(), c.status.clone())).collect();
        assert_eq!(st, vec![("main.tex".to_string(), "modified".to_string()), ("new.md".into(), "added".into()), ("intro.tex".into(), "deleted".into())]);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Real end-to-end run against the installed `claude` (needs a signed-in Claude Code):
    /// CALLIO_E2E_CLAUDE=1 cargo test e2e -- --nocapture
    #[tokio::test(flavor = "multi_thread")]
    async fn e2e_claude_code() {
        if std::env::var("CALLIO_E2E_CLAUDE").is_err() {
            return;
        }
        let asked = Arc::new(Mutex::new(Vec::<String>::new()));
        let a2 = asked.clone();
        let asker: mcp::Asker = Arc::new(move |m, p, _| {
            a2.lock().unwrap().push(format!("{m}:{}", p["toolName"].as_str().unwrap_or("")));
            Box::pin(async move {
                Some(match m.as_str() {
                    "permission" => json!({"allow": true}),
                    "editor_state" => json!({"file": "main.tex", "line": 1, "selection": ""}),
                    _ => json!("ok"),
                })
            })
        });
        let srv = mcp::start(asker).await.unwrap();
        let d = std::env::temp_dir().join(format!("callio-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("main.tex"), "\\documentclass{article}\n\\begin{document}\nHello wrld.\n\\end{document}\n").unwrap();
        let cfg = d.join("mcp.json");
        std::fs::write(&cfg, mcp_config_json(srv.port, &srv.token).to_string()).unwrap();
        let sys = d.join("sys.md");
        std::fs::write(&sys, "You are being tested. Be brief.").unwrap();
        let exe = find_claude().expect("claude");
        let (e2, d2, c2, s2) = (exe.clone(), d.clone(), cfg.clone(), sys.clone());
        let run = move |prompt: &str, session: Option<String>| {
            let mut c = claude_cmd(&e2);
            c.current_dir(&d2).args(run_args(&c2, &s2, "default", Some("claude-haiku-5-5"), session.as_deref(), &Extra { effort: Some("low"), thinking: true }));
            c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            let mut ch = c.spawn().unwrap();
            ch.stdin.take().unwrap().write_all(prompt.as_bytes()).unwrap();
            let out = ch.wait_with_output().unwrap();
            eprintln!("stderr: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).to_string()
        };
        let before = snapshot(&d);
        let out = tokio::task::spawn_blocking({
            let run = run.clone();
            move || run("Fix the spelling mistake in main.tex with the Edit tool. Then call the mcp__callio__editor_state tool once. Finally reply with just the word done.", None)
        })
        .await
        .unwrap();
        let mut session = None;
        let mut kinds = std::collections::BTreeSet::new();
        let mut init_mcp = Value::Null;
        let mut result = Value::Null;
        for l in out.lines() {
            let v: Value = serde_json::from_str(l).unwrap();
            kinds.insert(format!("{}{}", v["type"].as_str().unwrap_or(""), v["subtype"].as_str().map(|s| format!("/{s}")).unwrap_or_default()));
            if v["type"] == "system" && v["subtype"] == "init" {
                init_mcp = v["mcp_servers"].clone();
            }
            if v["type"] == "result" {
                result = v.clone();
            }
            if let Some(s) = v["session_id"].as_str() {
                session = Some(s.to_string());
            }
            let _ = ui_event(&v);
        }
        eprintln!("kinds: {kinds:?}\nmcp: {init_mcp}\nasked: {:?}\nresult: {}", asked.lock().unwrap(), result);
        assert!(init_mcp.to_string().contains("callio"), "{init_mcp}");
        assert_eq!(result["is_error"], false, "{result}");
        let changed = diff_snapshots(None, &before, &d, "t");
        assert_eq!(changed.len(), 1, "{changed:?}");
        assert!(std::fs::read_to_string(d.join("main.tex")).unwrap().contains("Hello world"));
        assert!(asked.lock().unwrap().iter().any(|a| a == "permission:Edit"), "{:?}", asked.lock().unwrap());
        assert!(asked.lock().unwrap().iter().any(|a| a.starts_with("editor_state")));
        // a second turn continues the same session
        let out2 = tokio::task::spawn_blocking(move || run("Which word did you correct? Answer with that one corrected word only.", session)).await.unwrap();
        let last: Value = serde_json::from_str(out2.lines().last().unwrap()).unwrap();
        eprintln!("turn 2: {}", last["result"]);
        assert!(last["result"].as_str().unwrap_or("").to_lowercase().contains("world"));
        let _ = std::fs::remove_dir_all(&d);
    }
}
