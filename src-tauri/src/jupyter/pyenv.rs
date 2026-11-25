//! Finding the user's own Python interpreters (Callio bundles none) and checking which of them
//! can run a Jupyter server + kernels. Order shown to the author: the notebook folder's .venv /
//! venv, the folder's conda env (environment.yml), the `py` launcher, python/python3 on PATH,
//! conda base installs. The slow part (starting each Python once) is cached by exe + mtime.
use super::parse;
use crate::util::{command, run_with_timeout, which};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Interp {
    pub path: String,
    /// "Python 3.12 (.venv)"
    pub label: String,
    pub version: String,
    /// venv | conda-env | launcher | path | conda-base
    pub source: String,
    pub has_server: bool,
    pub has_kernel: bool,
    /// Package names to install when something is missing.
    pub missing: Vec<String>,
}

type Key = (String, Option<SystemTime>);
static CACHE: Mutex<Option<HashMap<Key, Option<parse::Probe>>>> = Mutex::new(None);

fn py_in_venv(root: &Path) -> PathBuf {
    if cfg!(windows) { root.join("Scripts").join("python.exe") } else { root.join("bin").join("python") }
}
fn py_in_conda(root: &Path) -> PathBuf {
    if cfg!(windows) { root.join("python.exe") } else { root.join("bin").join("python") }
}
fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn out_of(mut c: std::process::Command, secs: u64) -> Option<String> {
    let o = run_with_timeout({ c.stdin(std::process::Stdio::null()); c }, Duration::from_secs(secs)).ok()?;
    if !o.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&o.stdout).to_string())
}

/// `conda env list --json` → env folders.
fn conda_envs() -> Vec<String> {
    let mut cands: Vec<PathBuf> = which("conda", &[]).into_iter().collect();
    if let Some(h) = home() {
        for d in ["miniconda3", "anaconda3", "miniforge3", "mambaforge"] {
            cands.push(if cfg!(windows) { h.join(d).join("Scripts").join("conda.exe") } else { h.join(d).join("bin").join("conda") });
        }
    }
    for c in cands.into_iter().filter(|c| c.is_file()) {
        let mut cmd = command(&c);
        cmd.args(["env", "list", "--json"]);
        if let Some(j) = out_of(cmd, 20).and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) {
            return j["envs"].as_array().map(|a| a.iter().filter_map(|e| e.as_str().map(String::from)).collect()).unwrap_or_default();
        }
    }
    Vec::new()
}

/// Candidate interpreters (path, source) in display order, not yet checked.
fn candidates(dir: &str) -> Vec<(PathBuf, &'static str)> {
    let mut v: Vec<(PathBuf, &'static str)> = Vec::new();
    // 1 + 2: the notebook folder and its parents
    let mut yml_name: Option<String> = None;
    let mut cur = if dir.is_empty() { None } else { Some(PathBuf::from(dir)) };
    for _ in 0..8 {
        let Some(d) = cur else { break };
        for n in [".venv", "venv"] {
            let p = py_in_venv(&d.join(n));
            if p.is_file() {
                v.push((p, "venv"));
            }
        }
        if yml_name.is_none() {
            for f in ["environment.yml", "environment.yaml"] {
                if let Ok(t) = std::fs::read_to_string(d.join(f)) {
                    yml_name = parse::parse_env_yml_name(&t);
                    break;
                }
            }
        }
        cur = d.parent().map(|p| p.to_path_buf());
    }
    if let Some(n) = yml_name {
        if let Some(env) = parse::conda_env_for(&conda_envs(), &n) {
            let p = py_in_conda(Path::new(&env));
            if p.is_file() {
                v.push((p, "conda-env"));
            }
        }
    }
    // 3: Windows launcher
    if cfg!(windows) {
        if let Some(py) = which("py", &[]) {
            let mut c = command(py);
            c.arg("-0p");
            if let Some(o) = out_of(c, 10) {
                for p in parse::parse_py_launcher(&o) {
                    v.push((PathBuf::from(p), "launcher"));
                }
            }
        }
    }
    // 4: PATH
    for n in ["python", "python3"] {
        if let Some(p) = which(n, &[]) {
            // the Microsoft Store stub is a 0-byte file that opens the Store
            if std::fs::metadata(&p).map(|m| m.len() > 0).unwrap_or(false) {
                v.push((p, "path"));
            }
        }
    }
    // 5: conda bases
    if let Some(h) = home() {
        for d in ["miniconda3", "anaconda3", "miniforge3", "mambaforge"] {
            let p = py_in_conda(&h.join(d));
            if p.is_file() {
                v.push((p, "conda-base"));
            }
        }
    }
    // one entry per real file
    let mut seen = std::collections::HashSet::new();
    v.retain(|(p, _)| {
        let k = std::fs::canonicalize(p).unwrap_or_else(|_| p.clone()).to_string_lossy().to_lowercase();
        seen.insert(k.trim_start_matches(r"\\?\").to_string())
    });
    v
}

const PROBE: &str = "import sys,importlib.util as u;print(sys.version.split()[0]);print(int(u.find_spec('jupyter_server') is not None));print(int(u.find_spec('ipykernel') is not None))";

fn probe(path: &Path) -> Option<parse::Probe> {
    let key: Key = (path.to_string_lossy().to_string(), std::fs::metadata(path).and_then(|m| m.modified()).ok());
    if let Some(r) = CACHE.lock().unwrap().as_ref().and_then(|m| m.get(&key)) {
        return r.clone();
    }
    let mut c = command(path);
    c.args(["-c", PROBE]);
    let r = out_of(c, 20).and_then(|o| parse::parse_probe(&o));
    CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(key, r.clone());
    r
}
/// Forget what we know about one interpreter (after pip installed something into it).
pub fn forget(path: &str) {
    if let Some(m) = CACHE.lock().unwrap().as_mut() {
        m.retain(|k, _| k.0 != path);
    }
}

pub fn discover(dir: &str) -> Vec<Interp> {
    let cands = candidates(dir);
    let handles: Vec<_> = cands.iter().map(|(p, _)| { let p = p.clone(); std::thread::spawn(move || probe(&p)) }).collect();
    let mut out = Vec::new();
    for ((p, src), h) in cands.into_iter().zip(handles) {
        let Some(pr) = h.join().ok().flatten() else { continue };
        let path = p.to_string_lossy().to_string();
        let mut missing = Vec::new();
        if !pr.server {
            missing.push("jupyter_server".to_string());
        }
        if !pr.kernel {
            missing.push("ipykernel".to_string());
        }
        out.push(Interp { label: format!("Python {} ({})", parse::short_version(&pr.version), parse::env_tag(&path, src)), path, version: pr.version, source: src.to_string(), has_server: pr.server, has_kernel: pr.kernel, missing });
    }
    out
}
