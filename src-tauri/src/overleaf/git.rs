//! Overleaf Git integration via the user's installed git (Git for Windows).
use crate::util::{command, run_with_timeout, which};
use anyhow::{anyhow, bail, Result};
use base64::Engine;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub fn git_exe(extra: &[PathBuf]) -> Option<PathBuf> {
    which("git", extra)
}

pub fn remote_url(server: &str, id: &str) -> String {
    if server.contains("overleaf.com") {
        format!("https://git.overleaf.com/{id}")
    } else {
        format!("{}/git/{id}", server.trim_end_matches('/'))
    }
}

pub struct Git {
    exe: PathBuf,
    token: String,
    host_prefix: String,
}

impl Git {
    pub fn new(exe: PathBuf, token: String, server: &str) -> Git {
        let u = remote_url(server, "x");
        let host_prefix = u[..u.len() - 1].to_string(); // ".../"
        Git { exe, token, host_prefix }
    }

    fn cmd(&self, dir: &Path, args: &[&str]) -> std::process::Command {
        let mut c = command(&self.exe);
        c.current_dir(dir).args(args);
        let auth = base64::engine::general_purpose::STANDARD.encode(format!("git:{}", self.token));
        // Token travels via environment-scoped config, never on the command line or in .git/config.
        c.env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "never")
            .env("GIT_CONFIG_COUNT", "2")
            .env("GIT_CONFIG_KEY_0", format!("http.{}.extraHeader", self.host_prefix))
            .env("GIT_CONFIG_VALUE_0", format!("Authorization: Basic {auth}"))
            .env("GIT_CONFIG_KEY_1", "credential.helper")
            .env("GIT_CONFIG_VALUE_1", "");
        c
    }

    pub fn run(&self, dir: &Path, args: &[&str]) -> Result<String> {
        let o = run_with_timeout(self.cmd(dir, args), Duration::from_secs(300))?;
        let out = String::from_utf8_lossy(&o.stdout).to_string();
        if !o.status.success() {
            let err = String::from_utf8_lossy(&o.stderr).to_string();
            let hint = if err.contains("401") || err.contains("403") || err.contains("Authentication failed") || err.contains("could not read Username") {
                "\nCheck your Overleaf Git token in Settings → Overleaf (Git integration needs a premium/institutional plan)."
            } else {
                ""
            };
            bail!("git {} failed:\n{}{}{hint}", args.first().unwrap_or(&""), err.trim(), if out.trim().is_empty() { String::new() } else { format!("\n{}", out.trim()) });
        }
        Ok(out)
    }

    fn ok(&self, dir: &Path, args: &[&str]) -> Option<String> {
        self.run(dir, args).ok()
    }

    pub fn clone_into(&self, parent: &Path, dirname: &str, url: &str) -> Result<PathBuf> {
        self.run(parent, &["clone", url, dirname])?;
        let dir = parent.join(dirname);
        exclude_callio(&dir);
        Ok(dir)
    }

    fn ensure_identity(&self, dir: &Path) {
        if self.ok(dir, &["config", "user.email"]).map(|s| s.trim().is_empty()).unwrap_or(true) {
            let _ = self.run(dir, &["config", "user.email", "callio@localhost"]);
            let _ = self.run(dir, &["config", "user.name", "Callio"]);
        }
    }

    /// Commit any local edits so they can be merged/pushed. Returns true if a commit was made.
    pub fn commit_local(&self, dir: &Path) -> Result<bool> {
        self.ensure_identity(dir);
        if dir.join(".git").join("MERGE_HEAD").exists() {
            // Finishing a merge: refuse while conflict markers are still in the files.
            let unmerged = self.ok(dir, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default();
            let bad: Vec<String> = unmerged
                .lines()
                .filter(|f| !f.is_empty())
                .filter(|f| {
                    std::fs::read_to_string(dir.join(f))
                        .map(|t| t.lines().any(|l| l.starts_with("<<<<<<< ") || l.starts_with(">>>>>>> ") || l == "======="))
                        .unwrap_or(false)
                })
                .map(|s| s.to_string())
                .collect();
            if !bad.is_empty() {
                bail!("Unresolved merge conflicts in: {}\nEdit out the <<<<<<< / ======= / >>>>>>> blocks, save, then sync again.", bad.join(", "));
            }
        }
        self.run(dir, &["add", "-A"])?;
        let st = self.run(dir, &["status", "--porcelain"])?;
        let merging = dir.join(".git").join("MERGE_HEAD").exists();
        if st.trim().is_empty() && !merging {
            return Ok(false);
        }
        self.run(dir, &["commit", "-q", "-m", "Edits from Callio"])?;
        Ok(true)
    }

    pub fn head(&self, dir: &Path) -> Option<String> {
        self.ok(dir, &["rev-parse", "HEAD"]).map(|s| s.trim().to_string())
    }

    /// Commit local edits, then merge Overleaf's changes. Returns (changed files, conflicted files).
    pub fn pull(&self, dir: &Path) -> Result<(Vec<String>, Vec<String>)> {
        self.commit_local(dir)?;
        let before = self.head(dir);
        let r = self.run(dir, &["pull", "--no-rebase", "--ff", "--no-edit", "-q"]);
        let conflicts: Vec<String> = self
            .ok(dir, &["diff", "--name-only", "--diff-filter=U"])
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| dir.join(l).to_string_lossy().to_string())
            .collect();
        if let Err(e) = r {
            if conflicts.is_empty() {
                return Err(e);
            }
        }
        let after = self.head(dir);
        let changed = match (before, after) {
            (Some(b), Some(a)) if a != b => self
                .ok(dir, &["diff", "--name-only", &b, &a])
                .unwrap_or_default()
                .lines()
                .filter(|l| !l.is_empty())
                .map(|l| dir.join(l).to_string_lossy().to_string())
                .collect(),
            _ => Vec::new(),
        };
        Ok((changed, conflicts))
    }

    pub fn push(&self, dir: &Path) -> Result<(Vec<String>, usize)> {
        let (changed, conflicts) = self.pull(dir)?;
        if !conflicts.is_empty() {
            return Err(anyhow!(
                "Merge conflicts with Overleaf in: {}\nFix the <<<<<<< markers, save, then Push again.",
                conflicts.iter().map(|c| Path::new(c).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()).collect::<Vec<_>>().join(", ")
            ));
        }
        let ahead = self
            .ok(dir, &["rev-list", "--count", "@{u}..HEAD"])
            .and_then(|s| s.trim().parse::<usize>().ok())
            .unwrap_or(1);
        if ahead > 0 {
            self.run(dir, &["push", "-q"])?;
        }
        Ok((changed, ahead))
    }
}

pub fn exclude_callio(dir: &Path) {
    let p = dir.join(".git").join("info").join("exclude");
    let cur = std::fs::read_to_string(&p).unwrap_or_default();
    if !cur.lines().any(|l| l.trim() == ".callio/") {
        let _ = std::fs::create_dir_all(p.parent().unwrap());
        let _ = std::fs::write(&p, format!("{cur}{}.callio/\n", if cur.is_empty() || cur.ends_with('\n') { "" } else { "\n" }));
    }
}

/// If `dir` is a git clone of an Overleaf project, return its project id.
pub fn overleaf_remote_id(dir: &Path) -> Option<String> {
    let cfg = std::fs::read_to_string(dir.join(".git").join("config")).ok()?;
    let re = regex_lite::Regex::new(r"url\s*=\s*\S*?(?:git\.overleaf\.com|/git)/([0-9a-f]{24})").unwrap();
    re.captures(&cfg).map(|c| c[1].to_string())
}
