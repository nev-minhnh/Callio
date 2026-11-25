//! Claude Code on this computer, tools on the server: `remote_run`, `remote_read`, `remote_list`,
//! `remote_sync_status`, `remote_sync_now`. Running a command asks the author first, like Bash.
use crate::claude_code::mcp::text_result;
use serde_json::{json, Value};
use std::time::Duration;

pub const NAMES: &[&str] = &["remote_run", "remote_read", "remote_list", "remote_sync_status", "remote_sync_now"];
const CAP: usize = 30_000;

pub fn defs() -> Vec<Value> {
    let host = json!({"type": "string", "description": "The server's name as shown in Callio (Settings › Remote servers)"});
    vec![
        json!({"name": "remote_run", "description": "Run a shell command on a remote server over SSH (heavy jobs, GPU work, long scripts live there). The author is asked to approve it like a Bash command. Output is capped; the exit code is reported. The linked folder is mirrored on the server: use its server path as cwd.",
            "inputSchema": {"type": "object", "properties": {"host": host.clone(), "command": {"type": "string"}, "cwd": {"type": "string", "description": "folder on the server (default: the linked folder's server side, else the home folder)"}, "timeout_s": {"type": "integer", "description": "default 120, at most 3600"}}, "required": ["host", "command"]}}),
        json!({"name": "remote_read", "description": "Read a text file on a remote server (up to 200 KB).",
            "inputSchema": {"type": "object", "properties": {"host": host.clone(), "path": {"type": "string"}}, "required": ["host", "path"]}}),
        json!({"name": "remote_list", "description": "List a folder on a remote server: names, sizes, whether each is a folder.",
            "inputSchema": {"type": "object", "properties": {"host": host.clone(), "path": {"type": "string"}}, "required": ["host", "path"]}}),
        json!({"name": "remote_sync_status", "description": "State of the two-way sync between a local folder and its server folder: pending uploads/downloads, conflicts waiting for the author, files too big to sync. `link` is the local folder path (or omitted for all links).",
            "inputSchema": {"type": "object", "properties": {"link": {"type": "string", "description": "local folder path of the link"}}}}),
        json!({"name": "remote_sync_now", "description": "Sync a linked folder with its server folder right now and wait (up to 60 s) until it has finished. Use it after editing locally before running something on the server, and after the server changed files before reading them locally.",
            "inputSchema": {"type": "object", "properties": {"link": {"type": "string", "description": "local folder path of the link"}}}}),
    ]
}

fn err(m: impl Into<String>) -> Value {
    text_result(Value::String(m.into()), true)
}
fn ok(m: impl Into<String>) -> Value {
    text_result(Value::String(m.into()), false)
}

fn cap(s: &str) -> String {
    if s.len() <= CAP {
        return s.to_string();
    }
    let (a, b) = (CAP / 2, CAP / 2);
    let head: String = s.chars().take(a).collect();
    let tail: String = s.chars().rev().take(b).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{head}\n… [output cut: {} characters omitted] …\n{tail}", s.len() - a - b)
}

/// The server a name refers to: its id, its name, or its address.
fn resolve(name: &str) -> Result<String, String> {
    let r = super::rt()?;
    let list = r.hub.all_cfgs();
    list.iter().find(|h| h.id == name || h.name == name || h.host == name).map(|h| h.id.clone()).ok_or_else(|| format!("No server called \"{name}\" in Settings › Remote servers. Known: {}", list.iter().map(|h| h.name.clone()).collect::<Vec<_>>().join(", ")))
}

pub async fn call(name: &str, args: &Value) -> Value {
    match go(name, args).await {
        Ok(v) => v,
        Err(e) => err(e),
    }
}

async fn go(name: &str, a: &Value) -> Result<Value, String> {
    let r = super::rt()?;
    match name {
        "remote_run" => {
            let host = resolve(a["host"].as_str().unwrap_or(""))?;
            let cmd = a["command"].as_str().ok_or("command is required")?.to_string();
            let label = r.hub.cfg(&host)?.label();
            let mode = crate::settings::load_from_disk(&r.app)["ccPermissionMode"].as_str().unwrap_or("default").to_string();
            if mode == "plan" {
                return Err("Plan mode: running commands is not allowed.".into());
            }
            if !matches!(mode.as_str(), "bypassPermissions" | "auto") {
                let ask = crate::claude_code::mcp::window_asker(r.app.clone());
                let q = ask("permission".into(), json!({"toolName": "Bash", "input": {"command": cmd, "description": format!("Runs on the server {label} (over SSH), not on this computer")}}), Duration::from_secs(3600)).await;
                match q {
                    Some(v) if v["allow"].as_bool() == Some(true) => {}
                    Some(v) => return Err(format!("The author declined to run this on the server. {}", v["message"].as_str().unwrap_or(""))),
                    None => return Err("No answer from the author.".into()),
                }
            }
            let sess = r.hub.session(&host, false).await?;
            let t = a["timeout_s"].as_u64().unwrap_or(120).clamp(1, 3600);
            let mut script = String::new();
            if let Some(cwd) = a["cwd"].as_str().filter(|c| !c.is_empty()) {
                script.push_str(&format!("cd {} && ", super::config::sh_path(cwd)));
            }
            script.push_str(&cmd);
            let has_bash = sess.exec("command -v bash", None, Duration::from_secs(10)).await.map(|o| o.ok()).unwrap_or(false);
            let line = if has_bash { format!("bash -lc {}", super::config::sh_quote(&script)) } else { format!("sh -c {}", super::config::sh_quote(&script)) };
            match sess.exec(&line, None, Duration::from_secs(t)).await {
                Ok(o) => {
                    let mut t = o.text();
                    if !o.err.is_empty() {
                        t.push_str(&format!("\n[stderr]\n{}", o.err_text()));
                    }
                    Ok(ok(format!("{}\n[exit code {}]", cap(&t), o.code.map(|c| c.to_string()).unwrap_or("?".into()))))
                }
                Err(e) => Err(e),
            }
        }
        "remote_read" => {
            let host = resolve(a["host"].as_str().unwrap_or(""))?;
            let sess = r.hub.session(&host, false).await?;
            let rem = super::remote::Remote::bare(sess, "/");
            let b = rem.read(a["path"].as_str().unwrap_or(""), 200 << 10).await?;
            if b.iter().take(8000).any(|c| *c == 0) {
                return Err("That file is binary.".into());
            }
            Ok(ok(String::from_utf8_lossy(&b).to_string()))
        }
        "remote_list" => {
            let host = resolve(a["host"].as_str().unwrap_or(""))?;
            let sess = r.hub.session(&host, false).await?;
            let items = super::remote::Remote::bare(sess, "/").list(a["path"].as_str().unwrap_or("/")).await?;
            let t: Vec<String> = items.iter().take(500).map(|i| if i.dir { format!("{}/", i.name) } else { format!("{}  ({} bytes)", i.name, i.size) }).collect();
            Ok(ok(if t.is_empty() { "(empty)".to_string() } else { t.join("\n") }))
        }
        "remote_sync_status" | "remote_sync_now" => {
            let want = a["link"].as_str().unwrap_or("").replace('\\', "/").trim_end_matches('/').to_lowercase();
            let links: Vec<_> = r.sync.all().into_iter().filter(|l| want.is_empty() || l.cfg().local.replace('\\', "/").trim_end_matches('/').to_lowercase() == want).collect();
            if links.is_empty() {
                return Err("No linked folder matches. Link the folder to a server first (Settings › Remote servers).".into());
            }
            if name == "remote_sync_now" {
                for l in &links {
                    let r0 = l.status().rounds;
                    l.now(false);
                    let t = std::time::Instant::now();
                    while l.status().rounds < r0 + 2 && t.elapsed() < Duration::from_secs(60) {
                        tokio::time::sleep(Duration::from_millis(150)).await;
                    }
                }
            }
            let out: Vec<Value> = links.iter().map(|l| {
                let (c, s) = (l.cfg(), l.status());
                json!({"local": c.local, "host": c.host, "remote": c.remote, "state": s.state, "pendingUploads": s.up, "pendingDownloads": s.down, "conflicts": s.conflicts, "tooBig": s.skipped, "error": s.error})
            }).collect();
            Ok(ok(serde_json::to_string_pretty(&out).unwrap_or_default()))
        }
        _ => Err(format!("Unknown tool {name}")),
    }
}

/// The note the system prompt gets when the open folder is mirrored on a server.
pub fn prompt_note(local_dir: &str) -> Option<String> {
    let r = super::rt().ok()?;
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let want = norm(local_dir);
    for l in r.sync.all() {
        let c = l.cfg();
        let base = norm(&c.local);
        if want == base || want.starts_with(&format!("{base}/")) {
            let label = r.hub.cfg(&c.host).map(|h| h.label()).unwrap_or(c.host.clone());
            return Some(format!("This folder ({}) is mirrored by two-way sync on the server \"{label}\" at {}. Run heavy jobs, GPU work and long scripts there with the remote_run tool (host \"{label}\", cwd = the server path), not on this computer. After editing files here call remote_sync_now before running them on the server; after the server changed files, call it before reading them here.", c.local, c.remote));
        }
    }
    None
}
