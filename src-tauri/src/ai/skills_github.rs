//! Install skills from a public GitHub link. Accepts:
//!   https://github.com/owner/repo
//!   https://github.com/owner/repo/tree/<branch>/<path>
//!   https://github.com/owner/repo/blob/<branch>/<path>/SKILL.md
//!   owner/repo
//! The repository archive is downloaded (no git needed), every folder with a SKILL.md under
//! the given path is offered, and the chosen ones are saved into Callio's skills folder and —
//! if enabled — Claude Code's personal skills folder (~/.claude/skills), so both use them.
use super::skills::own_dir;
use crate::util::{safe_name, sha256_hex, CmdResult, ErrStr};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, PartialEq)]
pub struct GhRef {
    pub owner: String,
    pub repo: String,
    /// None = default branch
    pub rest: Vec<String>,
}

/// Parse a GitHub link. `rest` holds "<ref>/<path...>" segments when a tree/blob URL is given.
pub fn parse_link(s: &str) -> Result<GhRef> {
    let s = s.trim().trim_end_matches('/');
    let s = s.strip_prefix("git+").unwrap_or(s);
    let path = if let Some(p) = s.split_once("github.com/").map(|(_, p)| p) {
        p.to_string()
    } else if !s.contains("://") && s.matches('/').count() >= 1 {
        s.to_string()
    } else {
        bail!("That isn't a GitHub link (expected https://github.com/owner/repo…)");
    };
    let path = path.split(['?', '#']).next().unwrap_or("").to_string();
    let segs: Vec<&str> = path.split('/').filter(|x| !x.is_empty()).collect();
    if segs.len() < 2 {
        bail!("The link needs an owner and a repository");
    }
    let owner = segs[0].to_string();
    let repo = segs[1].trim_end_matches(".git").to_string();
    let rest = if segs.len() > 3 && (segs[2] == "tree" || segs[2] == "blob") {
        let mut r: Vec<String> = segs[3..].iter().map(|x| x.to_string()).collect();
        if r.last().map(|l| l.eq_ignore_ascii_case("SKILL.md")).unwrap_or(false) {
            r.pop();
        }
        r
    } else {
        Vec::new()
    };
    let ok = |x: &str| !x.is_empty() && x.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if !ok(&owner) || !ok(&repo) {
        bail!("That doesn't look like a valid GitHub owner/repository");
    }
    Ok(GhRef { owner, repo, rest })
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().user_agent("Callio-editor").connect_timeout(Duration::from_secs(20)).timeout(Duration::from_secs(300)).build().unwrap()
}

/// Download the archive. For tree/blob links the ref may itself contain slashes, so try the
/// shortest ref first and grow it. Returns (zip bytes, ref used, path inside the repo).
async fn download(g: &GhRef) -> Result<(Vec<u8>, String, String)> {
    let c = client();
    let mut tries: Vec<(String, String)> = Vec::new();
    if g.rest.is_empty() {
        tries.push(("HEAD".into(), String::new()));
    } else {
        for i in 1..=g.rest.len() {
            tries.push((g.rest[..i].join("/"), g.rest[i..].join("/")));
        }
    }
    let mut last = String::new();
    for (r, p) in tries {
        // github.com redirects to codeload.github.com, which serves the archive
        let url = format!("https://github.com/{}/{}/archive/{}.zip", g.owner, g.repo, r);
        let resp = c.get(&url).send().await.with_context(|| "Couldn't reach GitHub")?;
        match resp.status().as_u16() {
            200 => {
                const CAP: u64 = 200 * 1024 * 1024;
                if resp.content_length().unwrap_or(0) > CAP {
                    bail!("The repository is too large to download as skills (over 200 MB)");
                }
                let mut resp = resp;
                let mut b: Vec<u8> = Vec::new();
                while let Some(chunk) = resp.chunk().await? {
                    b.extend_from_slice(&chunk);
                    if b.len() as u64 > CAP {
                        bail!("The repository is too large to download as skills (over 200 MB)");
                    }
                }
                if !b.starts_with(b"PK") {
                    bail!("GitHub didn't send a zip archive (try again later)");
                }
                return Ok((b, r, p));
            }
            404 => last = format!("{}/{} (ref {r}) not found — is the repository public?", g.owner, g.repo),
            s => last = format!("GitHub returned HTTP {s}"),
        }
    }
    bail!(last)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    /// folder path inside the repository
    pub path: String,
    pub name: String,
    pub description: String,
    pub files: usize,
    pub bytes: u64,
}

/// List the archive's files as (path-without-top-folder → index), skipping unsafe names.
fn index(zip: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>) -> BTreeMap<String, usize> {
    let mut m = BTreeMap::new();
    for i in 0..zip.len() {
        let Ok(f) = zip.by_index(i) else { continue };
        if f.is_dir() || f.is_symlink() {
            continue;
        }
        let Some(p) = f.enclosed_name() else { continue };
        let p = p.to_string_lossy().replace('\\', "/");
        // strip "repo-ref/" top folder
        let Some((_, rest)) = p.split_once('/') else { continue };
        m.insert(rest.to_string(), i);
    }
    m
}

fn read_entry(zip: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>, i: usize, cap: u64) -> Result<Vec<u8>> {
    let mut f = zip.by_index(i)?;
    if f.size() > cap {
        bail!("{} is too large", f.name());
    }
    let mut v = Vec::with_capacity(f.size() as usize);
    f.read_to_end(&mut v)?;
    Ok(v)
}

fn find_skills(zip: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>, base: &str) -> Vec<Found> {
    let idx = index(zip);
    let base = base.trim_matches('/');
    let mut out = Vec::new();
    let skill_dirs: Vec<String> = idx
        .keys()
        .filter(|k| k.rsplit('/').next().map(|n| n.eq_ignore_ascii_case("SKILL.md")).unwrap_or(false))
        .map(|k| k.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default())
        .filter(|d| base.is_empty() || d == base || d.starts_with(&format!("{base}/")))
        .collect();
    for d in skill_dirs {
        // don't offer skills nested inside another skill
        if out.iter().any(|f: &Found| !f.path.is_empty() && d.starts_with(&format!("{}/", f.path))) {
            continue;
        }
        let prefix = if d.is_empty() { String::new() } else { format!("{d}/") };
        let files: Vec<(&String, &usize)> = idx.iter().filter(|(k, _)| k.starts_with(&prefix)).collect();
        let skill_md_key = files.iter().find(|(k, _)| k.rsplit('/').next().map(|n| n.eq_ignore_ascii_case("SKILL.md")).unwrap_or(false) && k[prefix.len()..].matches('/').count() == 0);
        let Some((_, &si)) = skill_md_key else { continue };
        let text = read_entry(zip, si, 2_000_000).ok().map(|b| String::from_utf8_lossy(&b).to_string()).unwrap_or_default();
        let (n, desc) = super::skills::front_matter(&text);
        let bytes: u64 = files.iter().filter_map(|(_, &i)| zip.by_index(i).ok().map(|f| f.size())).sum();
        out.push(Found {
            name: n.unwrap_or_else(|| d.rsplit('/').next().filter(|x| !x.is_empty()).unwrap_or("skill").to_string()),
            description: desc.unwrap_or_default(),
            files: files.len(),
            bytes,
            path: d,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspect {
    source: String,
    reference: String,
    skills: Vec<Found>,
}

/// Look inside a GitHub link and list the skills it contains (nothing is installed yet).
#[tauri::command]
pub async fn skills_github_inspect(url: String) -> CmdResult<Inspect> {
    let g = parse_link(&url).es()?;
    let (bytes, r, path) = download(&g).await.es()?;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).es()?;
    let skills = find_skills(&mut zip, &path);
    if skills.is_empty() {
        return Err(format!("No SKILL.md found in {}/{}{}", g.owner, g.repo, if path.is_empty() { String::new() } else { format!("/{path}") }));
    }
    Ok(Inspect { source: format!("{}/{}", g.owner, g.repo), reference: r, skills })
}

// ---------------- installed registry ----------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub name: String,
    pub folder: String,
    pub url: String,
    pub repo: String,
    pub reference: String,
    pub path: String,
    pub hash: String,
    pub installed_at: u64,
    #[serde(default)]
    pub claude_code: bool,
}

fn registry_path(app: &AppHandle) -> PathBuf {
    own_dir(app).join(".installed.json")
}
fn load_registry(app: &AppHandle) -> Vec<Installed> {
    std::fs::read_to_string(registry_path(app)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}
fn save_registry(app: &AppHandle, v: &[Installed]) -> Result<()> {
    let p = registry_path(app);
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(v)?)?;
    std::fs::rename(tmp, p)?;
    Ok(())
}

pub fn claude_skills_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".claude").join("skills"))
}

/// A safe relative path inside a skill folder, or None (absolute parts, drive letters,
/// `..`, names Windows can't store, `.git` folders).
fn safe_rel(rel: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for part in rel.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.starts_with(".git") {
            return None;
        }
        if part.chars().any(|c| "<>:\"|?*\\".contains(c) || c.is_control()) || part.ends_with('.') || part.ends_with(' ') {
            return None;
        }
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3"].contains(&stem.as_str()) {
            return None;
        }
        match Path::new(part).components().next() {
            Some(std::path::Component::Normal(_)) => out.push(part),
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// Write one skill folder from the archive into `dest` (replacing what was there, safely).
fn write_skill(zip: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>, prefix: &str, dest: &Path) -> Result<String> {
    let idx = index(zip);
    let name = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    // dot names: skill scanners (Callio's and Claude Code's) ignore them
    let staging = dest.with_file_name(format!(".{name}.installing"));
    let old = dest.with_file_name(format!(".{name}.old"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;
    let r = (|| -> Result<String> {
        let mut hashes = Vec::new();
        let mut total = 0u64;
        for (k, &i) in idx.iter().filter(|(k, _)| prefix.is_empty() || k.starts_with(prefix)) {
            let rel = &k[prefix.len()..];
            let Some(relp) = safe_rel(rel) else { continue };
            let out = staging.join(&relp);
            if !out.starts_with(&staging) {
                continue;
            }
            let data = read_entry(zip, i, 30 * 1024 * 1024)?;
            total += data.len() as u64;
            if total > 100 * 1024 * 1024 {
                bail!("skill is larger than 100 MB");
            }
            hashes.push(format!("{rel}:{}", sha256_hex(&data)));
            if let Some(d) = out.parent() {
                std::fs::create_dir_all(d)?;
            }
            std::fs::write(out, data)?;
        }
        if !staging.join("SKILL.md").exists() {
            bail!("SKILL.md missing");
        }
        hashes.sort();
        Ok(sha256_hex(hashes.join("\n").as_bytes()))
    })();
    let hash = match r {
        Ok(h) => h,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    // swap in: dest → .old, staging → dest, then delete .old (roll back on failure)
    let _ = std::fs::remove_dir_all(&old);
    let had_old = dest.exists();
    if had_old {
        retry(|| std::fs::rename(dest, &old)).with_context(|| format!("couldn't replace {} (is a file in it open?)", dest.display()))
            .inspect_err(|_| { let _ = std::fs::remove_dir_all(&staging); })?;
    }
    if let Err(e) = retry(|| std::fs::rename(&staging, dest)) {
        if had_old {
            let _ = retry(|| std::fs::rename(&old, dest));
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e.into());
    }
    if had_old {
        let _ = std::fs::remove_dir_all(&old);
    }
    Ok(hash)
}

/// Windows: antivirus / indexer briefly hold new files; renames succeed on a retry.
fn retry(mut f: impl FnMut() -> std::io::Result<()>) -> std::io::Result<()> {
    let mut last = None;
    for i in 0..6 {
        match f() {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
        std::thread::sleep(Duration::from_millis(100 * (i + 1)));
    }
    Err(last.unwrap())
}

/// Install/update/remove change the registry one at a time.
static REG_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    installed: Vec<String>,
    updated: Vec<String>,
    unchanged: Vec<String>,
    failed: Vec<String>,
}

async fn install(app: &AppHandle, url: &str, paths: Option<Vec<String>>, claude_code: bool) -> Result<InstallResult> {
    let g = parse_link(url)?;
    let _ = app.emit("skills-progress", format!("Downloading {}/{}…", g.owner, g.repo));
    let (bytes, r, base) = download(&g).await?;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
    let found = find_skills(&mut zip, &base);
    let chosen: Vec<Found> = match &paths {
        Some(ps) => found.into_iter().filter(|f| ps.contains(&f.path)).collect(),
        None => found,
    };
    if chosen.is_empty() {
        bail!("No skills selected");
    }
    let _lock = REG_LOCK.lock().await;
    let mut reg = load_registry(app);
    let mut res = InstallResult { installed: vec![], updated: vec![], unchanged: vec![], failed: vec![] };
    let cc_dir = if claude_code { claude_skills_dir() } else { None };
    for f in chosen {
        let base_name = safe_name(&f.name).replace(' ', "-");
        let _ = app.emit("skills-progress", format!("Installing {}…", f.name));
        let prefix = if f.path.is_empty() { String::new() } else { format!("{}/", f.path) };
        let source = format!("{}/{}", g.owner, g.repo);
        // Reuse the folder this skill was installed into before; never overwrite a folder
        // Callio didn't create (in Callio's folder or in Claude Code's) — pick another name.
        let folder = match reg.iter().find(|e| e.repo == source && e.path == f.path) {
            Some(e) => e.folder.clone(),
            None => {
                let taken = |n: &str| reg.iter().any(|e| e.folder == n) || own_dir(app).join(n).exists() || cc_dir.as_ref().map(|c| c.join(n).exists()).unwrap_or(false);
                let mut n = base_name.clone();
                if taken(&n) {
                    n = format!("{base_name}-{}", g.owner.to_lowercase());
                }
                let mut k = 2;
                while taken(&n) {
                    n = format!("{base_name}-{}-{k}", g.owner.to_lowercase());
                    k += 1;
                }
                n
            }
        };
        let hash = match write_skill(&mut zip, &prefix, &own_dir(app).join(&folder)) {
            Ok(h) => h,
            Err(e) => {
                res.failed.push(format!("{}: {e}", f.name));
                continue;
            }
        };
        let prev = reg.iter().position(|e| e.folder == folder);
        let was_cc = prev.map(|i| reg[i].claude_code).unwrap_or(false);
        let mut cc_written = false;
        if let Some(cc) = &cc_dir {
            let d = cc.join(&folder);
            if !d.exists() || was_cc {
                match std::fs::create_dir_all(cc).map_err(anyhow::Error::from).and_then(|_| write_skill(&mut zip, &prefix, &d)) {
                    Ok(_) => cc_written = true,
                    Err(e) => res.failed.push(format!("{} (Claude Code copy): {e}", f.name)),
                }
            }
        }
        let entry = Installed { name: f.name.clone(), folder: folder.clone(), url: url.to_string(), repo: source, reference: r.clone(), path: f.path.clone(), hash: hash.clone(), installed_at: now(), claude_code: cc_written || was_cc };
        match prev {
            Some(i) if reg[i].hash == hash => {
                res.unchanged.push(f.name.clone());
                reg[i] = entry;
            }
            Some(i) => {
                res.updated.push(f.name.clone());
                reg[i] = entry;
            }
            None => {
                res.installed.push(f.name.clone());
                reg.push(entry);
            }
        }
        // saved after every skill, so a later failure can't orphan earlier ones
        save_registry(app, &reg)?;
    }
    if res.installed.is_empty() && res.updated.is_empty() && res.unchanged.is_empty() {
        bail!("{}", res.failed.join("\n"));
    }
    let _ = app.emit("skills-progress", String::new());
    Ok(res)
}

/// Install the chosen skills (folder paths from `skills_github_inspect`; None = all).
#[tauri::command]
pub async fn skills_github_install(app: AppHandle, url: String, paths: Option<Vec<String>>, claude_code: bool) -> CmdResult<InstallResult> {
    install(&app, &url, paths, claude_code).await.es()
}

#[tauri::command]
pub fn skills_installed(app: AppHandle) -> Vec<Installed> {
    load_registry(&app)
}

/// Re-download every installed skill (or one) and replace it if it changed upstream.
#[tauri::command]
pub async fn skills_update(app: AppHandle, folder: Option<String>) -> CmdResult<InstallResult> {
    let reg = load_registry(&app);
    let mut total = InstallResult { installed: vec![], updated: vec![], unchanged: vec![], failed: vec![] };
    // group by source link so each repository is downloaded once
    let mut by_url: BTreeMap<(String, bool), Vec<String>> = BTreeMap::new();
    for e in reg.iter().filter(|e| folder.as_ref().map(|f| &e.folder == f).unwrap_or(true)) {
        by_url.entry((e.url.clone(), e.claude_code)).or_default().push(e.path.clone());
    }
    let mut errors = Vec::new();
    for ((url, cc), paths) in by_url {
        match install(&app, &url, Some(paths), cc).await {
            Ok(r) => {
                total.installed.extend(r.installed);
                total.updated.extend(r.updated);
                total.unchanged.extend(r.unchanged);
                total.failed.extend(r.failed);
            }
            Err(e) => errors.push(format!("{url}: {e}")),
        }
    }
    if !errors.is_empty() && total.updated.is_empty() && total.unchanged.is_empty() {
        return Err(errors.join("\n"));
    }
    Ok(total)
}

#[tauri::command]
pub async fn skills_remove(app: AppHandle, folder: String) -> CmdResult<()> {
    let _lock = REG_LOCK.lock().await;
    let mut reg = load_registry(&app);
    let Some(i) = reg.iter().position(|e| e.folder == folder) else { return Err("Not an installed skill".into()) };
    let e = reg.remove(i);
    let dir = own_dir(&app).join(&e.folder);
    if dir.starts_with(own_dir(&app)) && dir != own_dir(&app) {
        let _ = std::fs::remove_dir_all(dir);
    }
    if e.claude_code {
        if let Some(cc) = claude_skills_dir() {
            let d = cc.join(&e.folder);
            if d.join("SKILL.md").exists() {
                let _ = std::fs::remove_dir_all(d);
            }
        }
    }
    save_registry(&app, &reg).es()
}

/// Uninstall: skills Callio copied into Claude Code's folder.
pub fn claude_code_count(app: &AppHandle) -> usize {
    load_registry(app).iter().filter(|e| e.claude_code).count()
}
pub fn remove_claude_code_copies(app: &AppHandle) {
    let Some(cc) = claude_skills_dir() else { return };
    for e in load_registry(app).into_iter().filter(|e| e.claude_code) {
        if safe_rel(&e.folder).map(|r| r.components().count() == 1).unwrap_or(false) {
            let d = cc.join(&e.folder);
            if d.join("SKILL.md").exists() {
                let _ = std::fs::remove_dir_all(d);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn links() {
        assert_eq!(parse_link("https://github.com/anthropics/skills").unwrap(), GhRef { owner: "anthropics".into(), repo: "skills".into(), rest: vec![] });
        assert_eq!(parse_link("anthropics/skills.git").unwrap().repo, "skills");
        let g = parse_link("https://github.com/a/b/tree/main/skills/pdf?tab=readme").unwrap();
        assert_eq!(g.rest, vec!["main", "skills", "pdf"]);
        let g = parse_link("https://github.com/a/b/blob/dev/x/SKILL.md").unwrap();
        assert_eq!(g.rest, vec!["dev", "x"]);
        assert!(parse_link("https://gitlab.com/a/b").is_err());
    }
    #[test]
    fn unsafe_paths() {
        assert!(safe_rel("scripts/run.py").is_some());
        for bad in ["C:/Users/x.bat", "/abs", "a//b", "../x", "a/../b", ".git/config", "a:b", "con.txt", "x/nul", "trail.", "q?.md"] {
            assert!(safe_rel(bad).is_none(), "{bad}");
        }
    }
    #[test]
    fn finds_skills_in_archive() {
        let p = std::env::var("CALLIO_TEST_SKILLS_ZIP").unwrap_or_default();
        if p.is_empty() {
            return;
        }
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(std::fs::read(p).unwrap())).unwrap();
        let all = find_skills(&mut z, "");
        assert!(all.len() >= 10, "{}", all.len());
        let one = find_skills(&mut z, "skills/pdf");
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].name, "pdf");
        assert!(!one[0].description.is_empty());
        let dir = std::env::temp_dir().join("callio-skill-test");
        let _ = std::fs::remove_dir_all(&dir);
        let h = write_skill(&mut z, "skills/pdf/", &dir).unwrap();
        assert!(dir.join("SKILL.md").exists() && !h.is_empty());
    }
}
