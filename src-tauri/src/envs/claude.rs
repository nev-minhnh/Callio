//! Claude Code inside WSL. The session manager (claude_code/session.rs) asks `target()` whether
//! a session runs in a distro; if so, it builds the command with `WslTarget::command` instead of
//! starting `claude` on Windows. Everything else about a session (stream-json protocol, MCP
//! permission questions, snapshots and Undo) is unchanged:
//!  * the working folder is the Linux path of the project;
//!  * the MCP config and system-prompt files stay in Callio's data folder, which the distro reads
//!    through `/mnt/c/…`; the MCP address inside the config is the one the distro can reach
//!    (see bridge.rs);
//!  * file changes Claude Code makes are the very files the tree shows (`\\wsl.localhost\…`), so
//!    the before/after snapshots work on those paths.
use super::exec::{self, Env};
use super::{argv, bridge, paths};
use crate::util::{CmdResult, ErrStr};
use serde_json::json;
use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub use super::toolpaths::{distro_for, map_tool_args};

pub struct WslTarget {
    env: Env,
    cwd: String,
}

static HAS_CLAUDE: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// `run_in`: "windows" | "wsl:<distro>" (what the window chose for this folder); `cwd`: the project
/// folder as the window knows it. None = run on Windows as always.
pub fn target(run_in: &Option<String>, cwd: &str) -> Result<Option<WslTarget>, String> {
    let Some(distro) = distro_for(run_in, cwd) else { return Ok(None) };
    let linux = paths::win_to_wsl(cwd).ok_or("This folder can't be reached from WSL. Choose a folder on a local drive or inside WSL.")?;
    if !argv::safe_name(&distro) {
        return Err("That distribution name is not valid.".into());
    }
    let env = Env::wsl(&distro);
    let known = HAS_CLAUDE.lock().unwrap().as_ref().map(|s| s.contains(&distro)).unwrap_or(false);
    if !known {
        let found = exec::out(&env, "sh", &["-c", "command -v claude"], None, 60).map(|s| !s.trim().is_empty()).unwrap_or(false);
        if !found {
            return Err(format!("CLAUDE_MISSING_WSL:{distro}"));
        }
        HAS_CLAUDE.lock().unwrap().get_or_insert_with(HashSet::new).insert(distro.clone());
    }
    Ok(Some(WslTarget { env, cwd: linux }))
}

impl WslTarget {
    /// The MCP server address as this distro must call it.
    pub fn mcp_url(&self, local_url: &str) -> Result<String, String> {
        bridge::url_for(&self.env, local_url)
    }
    /// A Callio file (config, system prompt) as the distro sees it.
    pub fn path(&self, p: &Path) -> PathBuf {
        PathBuf::from(paths::win_to_wsl(&p.to_string_lossy()).unwrap_or_else(|| p.to_string_lossy().to_string()))
    }
    /// `claude <args>` in the project folder, inside the distro.
    pub fn command(&self, args: Vec<OsString>) -> Command {
        let a: Vec<String> = args.iter().map(|s| s.to_string_lossy().to_string()).collect();
        exec::command_env(&self.env, "claude", &a, Some(&self.cwd), &[("CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS", "1")])
    }
}

/// Install Claude Code in a distro with Anthropic's own installer; every output line arrives as an
/// `env-install` event {distro, line} and the end as {distro, done, code}. Only on the author's click.
#[tauri::command]
pub async fn envs_install_claude(app: AppHandle, distro: String) -> CmdResult<i32> {
    if !argv::safe_name(&distro) {
        return Err("That distribution name is not valid.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let env = Env::wsl(&distro);
        // constant script, no user data in it
        let c = exec::command(&env, "sh", &["-c".into(), "command -v curl >/dev/null 2>&1 || { echo 'curl is missing: install it first (sudo apt install curl).'; exit 127; }; curl -fsSL https://claude.ai/install.sh | bash".into()], None);
        let code = exec::stream(c, |l| {
            let _ = app.emit("env-install", json!({"distro": distro, "line": l}));
        })?;
        if code == 0 {
            HAS_CLAUDE.lock().unwrap().get_or_insert_with(HashSet::new).remove(&distro);
        }
        let _ = app.emit("env-install", json!({"distro": distro, "done": true, "code": code}));
        Ok(code)
    })
    .await
    .es()?
}

/// Is Claude Code installed in the distro, which version, and is it signed in there? (It has its own
/// sign-in in the distro: `~/.claude` is not shared with Windows.)
#[tauri::command]
pub async fn envs_cc_status(distro: String) -> CmdResult<serde_json::Value> {
    if !argv::safe_name(&distro) {
        return Err("That distribution name is not valid.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let env = Env::wsl(&distro);
        let Some(v) = exec::out(&env, "claude", &["--version"], None, 60) else { return Ok(json!({"installed": false})) };
        let auth = exec::out(&env, "claude", &["auth", "status"], None, 30).and_then(|s| serde_json::from_str::<serde_json::Value>(s.trim()).ok());
        let logged_in = auth.as_ref().and_then(|a| a["loggedIn"].as_bool()).unwrap_or(false);
        Ok(json!({"installed": true, "version": v.trim(), "loggedIn": logged_in, "auth": auth}))
    })
    .await
    .es()?
}

/// Open a console window running `claude auth login` in the distro (the sign-in needs a terminal).
#[tauri::command]
pub fn envs_cc_login(distro: String) -> CmdResult<()> {
    if !argv::safe_name(&distro) {
        return Err("That distribution name is not valid.".into());
    }
    let mut c = Command::new(exec::wsl_exe());
    c.args(argv::wsl_args(&distro, None, None, "claude", &["auth".into(), "login".into()], true));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        c.creation_flags(CREATE_NEW_CONSOLE);
    }
    c.spawn().map(|_| ()).map_err(|e| format!("Couldn't open WSL: {e}"))
}

