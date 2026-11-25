//! Finding the environments: WSL distros (`wsl.exe -l -v`, UTF-16), running Docker containers
//! (`docker ps`) and what is installed in each (probed only when asked). The list is cached for a
//! short time; the Refresh button asks again. Nothing here starts a distro except `envs_wsl_info`
//! and `envs_wsl_start`, because reading a distro's home folder wakes it up.
use super::exec::{self, Env};
use super::{argv, parse, paths};
use crate::util::{CmdResult, ErrStr};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

static CACHE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);
/// distro → (home, user), learned the first time the author asks for it
static HOMES: Mutex<Option<HashMap<String, (String, String)>>> = Mutex::new(None);
const TTL: Duration = Duration::from_secs(20);

fn home_of(distro: &str) -> Option<(String, String)> {
    HOMES.lock().unwrap().as_ref().and_then(|m| m.get(distro).cloned())
}

fn detect() -> Value {
    let mut envs = vec![json!({"id": "windows", "kind": "windows", "name": "Windows"})];
    // ---- WSL
    let mut wsl = json!({"available": false, "error": null});
    match exec::wsl_manage(&["-l", "-v"], 10) {
        Ok((true, text)) => {
            let list = parse::parse_wsl_list(&text);
            wsl["available"] = json!(true);
            let running: Vec<String> = exec::wsl_manage(&["-l", "--running", "-q"], 10).ok().filter(|r| r.0).map(|r| parse::parse_name_list(&r.1)).unwrap_or_default();
            for d in list.iter().filter(|d| !parse::is_internal_distro(&d.name) && argv::safe_name(&d.name)) {
                // the state is localised on some Windows languages: the "running" list is the reliable one
                let is_running = running.iter().any(|r| r.eq_ignore_ascii_case(&d.name)) || d.state.eq_ignore_ascii_case("running");
                let h = home_of(&d.name);
                envs.push(json!({
                    "id": format!("wsl:{}", d.name), "kind": "wsl", "name": format!("WSL · {}", d.name), "distro": d.name,
                    "state": if is_running { "Running" } else { "Stopped" }, "running": is_running, "version": d.version, "default": d.default,
                    "home": h.as_ref().map(|x| x.0.clone()), "user": h.as_ref().map(|x| x.1.clone()),
                }));
            }
            if list.iter().all(|d| parse::is_internal_distro(&d.name)) {
                wsl["error"] = json!("No Linux distribution is installed. Install one with: wsl --install");
            }
        }
        Ok((false, text)) => wsl["error"] = json!(text.lines().find(|l| !l.trim().is_empty()).unwrap_or("WSL is not installed or not enabled.")),
        Err(e) => wsl["error"] = json!(if cfg!(windows) { format!("WSL is not available: {e}") } else { "WSL exists on Windows only.".to_string() }),
    }
    // ---- Docker
    let mut docker = json!({"available": false, "error": null, "context": null});
    if crate::util::which("docker", &[]).is_some() {
        let ps = crate::util::run_with_timeout(
            {
                let mut c = crate::util::command(exec::docker_exe());
                c.args(["ps", "--format", "{{json .}}"]);
                c
            },
            Duration::from_secs(10),
        );
        match ps {
            Ok(o) if o.status.success() => {
                docker["available"] = json!(true);
                for c in parse::parse_docker_ps(&String::from_utf8_lossy(&o.stdout)) {
                    if !argv::safe_name(&c.name) {
                        continue;
                    }
                    envs.push(json!({"id": format!("docker:{}", c.name), "kind": "docker", "name": format!("Docker · {}", c.name), "container": c.name, "image": c.image, "status": c.status, "containerId": c.id, "ports": c.ports}));
                }
            }
            Ok(o) => {
                let e = String::from_utf8_lossy(&o.stderr).to_string();
                docker["error"] = json!(if e.to_lowercase().contains("daemon") || e.to_lowercase().contains("pipe") { "The Docker engine is not running. Start Docker Desktop.".to_string() } else { e.lines().next().unwrap_or("Docker did not answer.").to_string() });
            }
            Err(e) => docker["error"] = json!(e.to_string()),
        }
        let ctx = {
            let mut c = crate::util::command(exec::docker_exe());
            c.args(["context", "ls", "--format", "{{json .}}"]);
            crate::util::run_with_timeout(c, Duration::from_secs(8)).ok().filter(|o| o.status.success())
        };
        if let Some(o) = ctx {
            let l = parse::parse_docker_contexts(&String::from_utf8_lossy(&o.stdout));
            docker["context"] = json!(l.iter().find(|c| c.current).map(|c| c.name.clone()));
            docker["contexts"] = json!(l.iter().map(|c| json!({"name": c.name, "current": c.current})).collect::<Vec<_>>());
        }
    } else {
        docker["error"] = json!("Docker is not installed (the docker command was not found).");
    }
    json!({"envs": envs, "wsl": wsl, "docker": docker, "networking": super::bridge::networking_mode()})
}

/// All environments; cached for 20 s unless `refresh`.
#[tauri::command]
pub async fn envs_list(refresh: Option<bool>) -> CmdResult<Value> {
    if refresh != Some(true) {
        if let Some((t, v)) = CACHE.lock().unwrap().as_ref() {
            if t.elapsed() < TTL {
                return Ok(v.clone());
            }
        }
    }
    let v = tauri::async_runtime::spawn_blocking(detect).await.es()?;
    *CACHE.lock().unwrap() = Some((Instant::now(), v.clone()));
    Ok(v)
}

pub fn forget_cache() {
    *CACHE.lock().unwrap() = None;
}

const HOME_SH: &str = r#"printf '%s\n%s\n' "$HOME" "$(id -un)""#;

/// Home folder and user of a distro. Starts the distro if it is stopped.
#[tauri::command]
pub async fn envs_wsl_info(distro: String) -> CmdResult<Value> {
    if !argv::safe_name(&distro) {
        return Err("That distribution name is not valid.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let env = Env::wsl(&distro);
        let text = exec::out(&env, "sh", &["-lc", HOME_SH], None, 60).ok_or_else(|| format!("Couldn't start {distro}. Open a terminal with “wsl -d {distro}” to see the error."))?;
        let (home, user) = parse::parse_home_user(&text).ok_or("The distribution did not tell its home folder.")?;
        HOMES.lock().unwrap().get_or_insert_with(HashMap::new).insert(distro.clone(), (home.clone(), user.clone()));
        forget_cache();
        Ok(json!({"home": home, "user": user, "homeWin": paths::wsl_unc(&distro, &home)}))
    })
    .await
    .es()?
}

#[tauri::command]
pub async fn envs_wsl_start(distro: String) -> CmdResult<Value> {
    envs_wsl_info(distro).await
}

#[tauri::command]
pub async fn envs_wsl_stop(distro: String) -> CmdResult<()> {
    if !argv::safe_name(&distro) {
        return Err("That distribution name is not valid.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (ok, text) = exec::wsl_manage(&["--terminate", &distro], 30)?;
        forget_cache();
        if ok { Ok(()) } else { Err(text.lines().next().unwrap_or("Couldn't stop the distribution.").to_string()) }
    })
    .await
    .es()?
}

/// Constant probe script: which tools exist (PATH already includes ~/.local/bin and friends in WSL).
const PROBE_SH: &str = r#"for t in python3 claude latexmk; do p=$(command -v "$t" 2>/dev/null) && echo "$t=$p"; done; if command -v python3 >/dev/null 2>&1; then python3 -c "import importlib.util as u;print('jupyter_server=%d'%(u.find_spec('jupyter_server') is not None));print('ipykernel=%d'%(u.find_spec('ipykernel') is not None))" 2>/dev/null; fi; true"#;

/// What is installed in an environment (python3, jupyter_server, ipykernel, claude, latexmk).
#[tauri::command]
pub async fn envs_probe(env: Env) -> CmdResult<Value> {
    env.check()?;
    tauri::async_runtime::spawn_blocking(move || {
        if env.kind == "windows" {
            return Err("Windows is checked by the other settings pages.".to_string());
        }
        let text = exec::out(&env, "sh", &["-c", PROBE_SH], None, 60).ok_or("Couldn't run a command there. Is it running?")?;
        let p = parse::parse_probe(&text);
        let ver = |prog: &str| exec::out(&env, prog, &["--version"], None, 20).map(|s| s.lines().next().unwrap_or("").trim().to_string());
        Ok(json!({
            "python3": p.python3, "jupyterServer": p.jupyter_server, "ipykernel": p.ipykernel, "claude": p.claude, "latexmk": p.latexmk,
            "claudeVersion": p.claude.as_ref().and_then(|_| ver("claude")),
        }))
    })
    .await
    .es()?
}

/// Folders of a running container that are bind-mounted from the host (the only ones Callio can edit).
#[tauri::command]
pub async fn envs_docker_info(container: String) -> CmdResult<Value> {
    if !argv::safe_name(&container) {
        return Err("That container name is not valid.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut c = crate::util::command(exec::docker_exe());
        c.args(["inspect", &container]);
        let o = crate::util::run_with_timeout(c, Duration::from_secs(15)).map_err(|e| e.to_string())?;
        let i = parse::parse_inspect(&String::from_utf8_lossy(&o.stdout)).ok_or("Docker did not describe that container.")?;
        let mounts: Vec<Value> = i.mounts.iter().map(|m| json!({"inside": m.destination, "host": paths::container_to_host(std::slice::from_ref(m), &m.destination)})).collect();
        Ok(json!({"mounts": mounts, "workdir": i.workdir, "user": i.user, "ports": i.ports, "running": i.running,
            "note": if mounts.is_empty() { "No folder of this container is shared with Windows, so its files can't be edited here. Start it with a bind mount (-v C:\\folder:/workspace)." } else { "" }}))
    })
    .await
    .es()?
}
