//! Running programs inside an environment: `envs::command(env, program, args, cwd)` gives a
//! `std::process::Command` (no console window) that starts the program in a WSL distro
//! (`wsl.exe -d <distro> --cd <cwd> --exec …`), in a running Docker container
//! (`docker exec -i -w <cwd> …`) or plainly on Windows. Arguments are always separate argv items.
use super::argv;
use crate::util::{command as win_command, run_with_timeout, which};
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::time::Duration;

/// One place to work: `kind` is "windows", "wsl" or "docker".
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Env {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub distro: Option<String>,
    pub container: Option<String>,
    pub user: Option<String>,
    pub home: Option<String>,
}

impl Env {
    pub fn wsl(distro: &str) -> Env {
        Env { id: format!("wsl:{distro}"), kind: "wsl".into(), name: format!("WSL · {distro}"), distro: Some(distro.into()), ..Default::default() }
    }
    #[cfg(test)]
    pub fn docker(container: &str) -> Env {
        Env { id: format!("docker:{container}"), kind: "docker".into(), name: format!("Docker · {container}"), container: Some(container.into()), ..Default::default() }
    }
    /// Names that reach a command line must be plain (the list we detected has such names only).
    pub fn check(&self) -> Result<(), String> {
        match self.kind.as_str() {
            "windows" => Ok(()),
            "wsl" if self.distro.as_deref().map(argv::safe_name).unwrap_or(false) => Ok(()),
            "docker" if self.container.as_deref().map(argv::safe_name).unwrap_or(false) => Ok(()),
            _ => Err("That environment is not valid.".into()),
        }
    }
}

pub fn wsl_exe() -> std::ffi::OsString {
    which("wsl", &[]).map(Into::into).unwrap_or_else(|| "wsl.exe".into())
}
pub fn docker_exe() -> std::ffi::OsString {
    which("docker", &[]).map(Into::into).unwrap_or_else(|| "docker".into())
}

/// The command that runs `program args…` in `env` (working folder `cwd`, a path of that environment:
/// a Linux path for wsl and docker, a Windows path for windows).
pub fn command(env: &Env, program: &str, args: &[String], cwd: Option<&str>) -> Command {
    command_env(env, program, args, cwd, &[])
}

/// Like `command`, plus environment variables for the program. They travel in the environment of
/// the Windows process, never on a command line: through `WSLENV` for WSL, and `docker exec -e NAME`
/// (no value) for Docker.
pub fn command_env(env: &Env, program: &str, args: &[String], cwd: Option<&str>, vars: &[(&str, &str)]) -> Command {
    let names: Vec<&str> = vars.iter().map(|(k, _)| *k).collect();
    let mut c = match env.kind.as_str() {
        "wsl" => {
            let mut c = win_command(wsl_exe());
            c.args(argv::wsl_args(env.distro.as_deref().unwrap_or(""), env.user.as_deref(), cwd, program, args, true));
            if !names.is_empty() {
                c.env("WSLENV", argv::wslenv_value(std::env::var("WSLENV").ok().as_deref(), &names));
            }
            c
        }
        "docker" => {
            let mut c = win_command(docker_exe());
            c.args(argv::docker_args(env.container.as_deref().unwrap_or(""), env.user.as_deref(), cwd, &names, program, args));
            c
        }
        _ => {
            let mut c = win_command(program);
            c.args(args);
            if let Some(d) = cwd {
                c.current_dir(d);
            }
            c
        }
    };
    for (k, v) in vars {
        c.env(k, v);
    }
    c
}

/// stdout of a finished command (None when it failed to start, timed out or exited non-zero).
pub fn out(env: &Env, program: &str, args: &[&str], cwd: Option<&str>, secs: u64) -> Option<String> {
    let a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let o = run_with_timeout(command(env, program, &a, cwd), Duration::from_secs(secs)).ok()?;
    if !o.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&o.stdout).to_string())
}

/// `wsl.exe <args>` for the management commands (`-l -v`, `--terminate`, …): output decoded.
pub fn wsl_manage(args: &[&str], secs: u64) -> Result<(bool, String), String> {
    let mut c = win_command(wsl_exe());
    c.args(args);
    let o = run_with_timeout(c, Duration::from_secs(secs)).map_err(|e| e.to_string())?;
    let text = super::parse::decode_wsl_output(&o.stdout);
    let err = super::parse::decode_wsl_output(&o.stderr);
    Ok((o.status.success(), if text.trim().is_empty() { err } else { text }))
}

/// Run a command and hand every output line (stdout and stderr) to `on_line` as it arrives.
/// Returns the exit code.
pub fn stream(mut c: Command, mut on_line: impl FnMut(String)) -> Result<i32, String> {
    use std::process::Stdio;
    c.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| format!("Couldn't start the command: {e}"))?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let readers: Vec<Box<dyn std::io::Read + Send>> = [child.stdout.take().map(|x| Box::new(x) as Box<dyn std::io::Read + Send>), child.stderr.take().map(|x| Box::new(x) as Box<dyn std::io::Read + Send>)].into_iter().flatten().collect();
    for r in readers {
        let tx = tx.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for l in std::io::BufReader::new(r).lines().map_while(Result::ok) {
                let _ = tx.send(l);
            }
        });
    }
    drop(tx);
    for l in rx {
        on_line(l);
    }
    Ok(child.wait().map_err(|e| e.to_string())?.code().unwrap_or(-1))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn env_validation() {
        assert!(Env::wsl("Ubuntu-22.04").check().is_ok());
        assert!(Env::docker("dev_1").check().is_ok());
        assert!(Env { kind: "windows".into(), ..Default::default() }.check().is_ok());
        assert!(Env::wsl("a b").check().is_err());
        assert!(Env::docker("-x").check().is_err());
        assert!(Env { kind: "ssh".into(), ..Default::default() }.check().is_err());
    }
    #[test]
    fn wsl_command_line() {
        let c = command_env(&Env::wsl("Ubuntu"), "python3", &["-V".into()], Some("/home/u"), &[("JUPYTER_TOKEN", "t")]);
        let a: Vec<String> = c.get_args().map(|x| x.to_string_lossy().to_string()).collect();
        assert!(a.contains(&"--exec".to_string()) && a.contains(&"--cd".to_string()));
        assert!(!a.iter().any(|x| x == "t"), "the token must not be an argument");
        let w = c.get_envs().find(|(k, _)| *k == "WSLENV").and_then(|(_, v)| v).map(|v| v.to_string_lossy().to_string());
        assert!(w.unwrap().contains("JUPYTER_TOKEN"));
    }
}
