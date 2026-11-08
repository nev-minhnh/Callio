use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

pub type CmdResult<T> = Result<T, String>;

pub trait ErrStr<T> {
    fn es(self) -> CmdResult<T>;
}
impl<T, E: std::fmt::Display> ErrStr<T> for Result<T, E> {
    fn es(self) -> CmdResult<T> {
        self.map_err(|e| e.to_string())
    }
}

/// A `Command` that never flashes a console window on Windows.
pub fn command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c.stdin(Stdio::null());
    c
}

/// Run a command, collecting output, killing it after `timeout`.
/// End a process and everything it started (claude.cmd → node, powershell → its children).
pub fn kill_pid_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        let mut k = command("taskkill");
        k.args(["/PID", &child.id().to_string(), "/T", "/F"]);
        k.stdout(Stdio::null()).stderr(Stdio::null());
        let _ = k.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub fn run_with_timeout(cmd: Command, timeout: Duration) -> anyhow::Result<Output> {
    run_cancellable(cmd, timeout, None)
}

/// Like `run_with_timeout`, and stops early (killing the whole tree) when `cancel` is set.
pub fn run_cancellable(mut cmd: Command, timeout: Duration, cancel: Option<&std::sync::atomic::AtomicBool>) -> anyhow::Result<Output> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    // Drain pipes on threads so a chatty child can't block on a full pipe.
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let t1 = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = std::io::Read::read_to_end(&mut so, &mut v);
        v
    });
    let t2 = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = std::io::Read::read_to_end(&mut se, &mut v);
        v
    });
    let start = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break s;
        }
        if cancel.map(|c| c.load(std::sync::atomic::Ordering::SeqCst)).unwrap_or(false) {
            kill_pid_tree(&mut child);
            anyhow::bail!("Cancelled");
        }
        if start.elapsed() > timeout {
            kill_pid_tree(&mut child);
            anyhow::bail!("Timed out after {} s", timeout.as_secs());
        }
        std::thread::sleep(Duration::from_millis(40));
    };
    Ok(Output { status, stdout: t1.join().unwrap_or_default(), stderr: t2.join().unwrap_or_default() })
}

pub fn sha256_hex(data: &[u8]) -> String {
    let d = Sha256::digest(data);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

/// Turn "./sec/a.tex" relative to `base` into a clean absolute path.
pub fn resolve(base: &Path, p: &str) -> PathBuf {
    let p = p.trim().trim_matches('"');
    let pb = PathBuf::from(p);
    let joined = if pb.is_absolute() { pb } else { base.join(p.trim_start_matches("./").trim_start_matches(".\\")) };
    clean(&joined)
}

/// Lexically normalise `..`/`.` and slashes (no filesystem access).
pub fn clean(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Case-insensitive, slash-agnostic key for comparing paths.
pub fn path_key(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Locate an executable on PATH, in `extra` dirs, or in well-known TeX locations.
pub fn which(name: &str, extra: &[PathBuf]) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".bat", ".cmd", ""] } else { &[""] };
    let mut dirs: Vec<PathBuf> = extra.to_vec();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs.extend(tex_dirs());
    for d in dirs {
        for e in exts {
            let p = d.join(format!("{name}{e}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Common MiKTeX / TeX Live / Git install folders (so it works even if PATH is stale).
pub fn tex_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    #[cfg(windows)]
    {
        let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
        if let Some(l) = env("LOCALAPPDATA") {
            v.push(l.join("Programs/MiKTeX/miktex/bin/x64"));
        }
        for pf in [env("ProgramFiles"), env("ProgramFiles(x86)")].into_iter().flatten() {
            v.push(pf.join("MiKTeX/miktex/bin/x64"));
            v.push(pf.join("Git/cmd"));
        }
        if let Some(l) = env("LOCALAPPDATA") {
            v.push(l.join("Programs/Git/cmd"));
        }
        // C:\texlive\<year>\bin\windows (or win32/win64 on older releases), newest first
        if let Ok(rd) = std::fs::read_dir("C:\\texlive") {
            let mut years: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
            years.sort();
            years.reverse();
            for y in years {
                for b in ["bin/windows", "bin/win64", "bin/win32"] {
                    v.push(y.join(b));
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        v.push(PathBuf::from("/usr/bin"));
        v.push(PathBuf::from("/Library/TeX/texbin"));
    }
    v
}

pub fn html_unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let end = rest.find(';').filter(|&e| e < 12);
        match end {
            Some(e) => {
                let ent = &rest[1..e];
                let rep = match ent {
                    "quot" => Some('"'),
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "apos" | "#39" | "#x27" => Some('\''),
                    _ if ent.starts_with("#x") => u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32),
                    _ if ent.starts_with('#') => ent[1..].parse().ok().and_then(char::from_u32),
                    _ => None,
                };
                match rep {
                    Some(c) => {
                        out.push(c);
                        rest = &rest[e + 1..];
                    }
                    None => {
                        out.push('&');
                        rest = &rest[1..];
                    }
                }
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Filename-safe version of a project name.
pub fn safe_name(s: &str) -> String {
    let t: String = s
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let t = t.trim().trim_end_matches('.').to_string();
    if t.is_empty() { "project".into() } else { t }
}
