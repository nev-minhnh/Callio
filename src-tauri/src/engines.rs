//! Engine management: detect, download and install Tectonic and TinyTeX (latexmk, pdfLaTeX,
//! XeLaTeX, LuaLaTeX) with live progress, and install missing LaTeX packages on demand.
use crate::settings::{backend, data_dir, Backend, SettingsState};
use crate::util::{command, run_with_timeout, which, CmdResult, ErrStr};
use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

pub const TINYTEX_URL: &str = "https://github.com/rstudio/tinytex-releases/releases/download/daily/TinyTeX-1-windows.exe";

#[derive(Default)]
pub struct InstallState {
    cancel: AtomicBool,
    busy: AtomicBool,
}
impl InstallState {
    /// Claim the (single) download slot; false if another download runs.
    pub fn begin(&self) -> bool {
        if self.busy.swap(true, Ordering::SeqCst) {
            return false;
        }
        self.cancel.store(false, Ordering::SeqCst);
        true
    }
    pub fn end(&self) {
        self.busy.store(false, Ordering::SeqCst);
    }
}

#[derive(Serialize, Clone)]
pub struct Progress {
    kind: String,
    /// "download" | "extract" | "setup" | "done"
    phase: String,
    label: String,
    done: u64,
    /// 0 = indeterminate
    total: u64,
}

pub fn emit(app: &AppHandle, kind: &str, phase: &str, label: &str, done: u64, total: u64) {
    let _ = app.emit("install-progress", Progress { kind: kind.into(), phase: phase.into(), label: label.into(), done, total });
}

// ---------------- locations ----------------

pub fn tectonic_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("bin").join(if cfg!(windows) { "tectonic.exe" } else { "tectonic" })
}

/// TeX misbehaves under paths with spaces or non-ASCII letters (e.g. some Windows user
/// names), so fall back to ProgramData in that case, as the official TinyTeX script does.
pub fn tinytex_root(app: &AppHandle) -> PathBuf {
    let d = data_dir(app);
    let s = d.to_string_lossy();
    if s.is_ascii() && !s.contains(' ') {
        return d.join("TinyTeX");
    }
    #[cfg(windows)]
    if let Some(pd) = std::env::var_os("ProgramData") {
        for name in ["Proemia", "Quire"] {
            let old = PathBuf::from(&pd).join(name).join("TinyTeX");
            if old.is_dir() {
                return old; // installed before a rename
            }
        }
        return PathBuf::from(pd).join("Callio").join("TinyTeX");
    }
    d.join("TinyTeX")
}

pub fn tinytex_bin(app: &AppHandle) -> Option<PathBuf> {
    let r = tinytex_root(app);
    ["bin/windows", "bin/win32", "bin/x86_64-linux"].iter().map(|b| r.join(b)).find(|p| p.is_dir())
}

/// Folders searched before PATH: the user's custom TeX folder, then what Callio installed.
pub fn search_dirs(app: &AppHandle, b: &Backend) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(t) = &b.tex_bin {
        v.push(t.clone());
    }
    if let Some(t) = tinytex_bin(app) {
        v.push(t);
    }
    v.push(data_dir(app).join("bin"));
    v
}

pub fn is_managed_tinytex(app: &AppHandle, exe: &Path) -> bool {
    tinytex_bin(app).map(|b| exe.starts_with(b)).unwrap_or(false)
}

// ---------------- status ----------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Engines {
    tectonic: Option<String>,
    latexmk: Option<String>,
    pdflatex: Option<String>,
    xelatex: Option<String>,
    lualatex: Option<String>,
    git: Option<String>,
    /// Where the TeX binaries come from: "tinytex" (installed by Callio), "miktex", "texlive", "other"
    tex_source: Option<String>,
    tinytex_version: Option<String>,
    tectonic_managed: bool,
    installing: bool,
}

fn tex_version(root: &Path) -> Option<String> {
    let t = std::fs::read_to_string(root.join("release-texlive.txt")).ok()?;
    t.lines().next().and_then(|l| l.rsplit(' ').next()).map(|y| format!("TeX Live {y}"))
}

#[tauri::command]
pub async fn detect_engines(app: AppHandle, state: State<'_, SettingsState>, inst: State<'_, InstallState>) -> CmdResult<Engines> {
    let b = backend(&state);
    let dirs = search_dirs(&app, &b);
    let f = |n: &str| which(n, &dirs).map(|p| p.to_string_lossy().to_string());
    let pdflatex = f("pdflatex");
    let tex_source = pdflatex.as_ref().map(|p| {
        let l = p.to_lowercase();
        if is_managed_tinytex(&app, Path::new(p)) {
            "tinytex"
        } else if l.contains("miktex") {
            "miktex"
        } else if l.contains("texlive") || l.contains("tinytex") {
            "texlive"
        } else {
            "other"
        }
        .to_string()
    });
    let tectonic = f("tectonic");
    Ok(Engines {
        tectonic_managed: tectonic.as_deref().map(|t| Path::new(t) == tectonic_path(&app)).unwrap_or(false),
        tectonic,
        latexmk: f("latexmk"),
        xelatex: f("xelatex"),
        lualatex: f("lualatex"),
        git: f("git"),
        tinytex_version: tinytex_bin(&app).and_then(|_| tex_version(&tinytex_root(&app))),
        tex_source,
        pdflatex,
        installing: inst.busy.load(Ordering::SeqCst),
    })
}

// ---------------- download / extract ----------------

fn http() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder().user_agent("Callio-editor").connect_timeout(Duration::from_secs(30)).build()?)
}

fn mb(n: u64) -> String {
    format!("{:.1} MB", n as f64 / 1_048_576.0)
}

pub(crate) async fn download(app: &AppHandle, inst: &InstallState, kind: &str, what: &str, url: &str, dest: &Path) -> Result<()> {
    let client = http()?;
    let mut resp = client.get(url).send().await.with_context(|| format!("Couldn't reach {url}"))?.error_for_status()?;
    let total = resp.content_length().unwrap_or(0);
    if let Some(d) = dest.parent() {
        std::fs::create_dir_all(d)?;
    }
    let part = dest.with_extension("part");
    let mut file = std::fs::File::create(&part)?;
    let (mut done, start, mut last) = (0u64, Instant::now(), Instant::now() - Duration::from_secs(1));
    loop {
        if inst.cancel.load(Ordering::SeqCst) {
            drop(file);
            let _ = std::fs::remove_file(&part);
            bail!("Cancelled");
        }
        let chunk = tokio_timeout(resp.chunk()).await.context("Download stalled (no data for 60 s)")??;
        let Some(c) = chunk else { break };
        file.write_all(&c)?;
        done += c.len() as u64;
        if last.elapsed() > Duration::from_millis(120) {
            last = Instant::now();
            let speed = done as f64 / start.elapsed().as_secs_f64().max(0.1);
            let eta = if total > done && speed > 0.0 { format!(" · {:.0} s left", (total - done) as f64 / speed) } else { String::new() };
            let size = if total > 0 { format!("{} of {}", mb(done), mb(total)) } else { mb(done) };
            emit(app, kind, "download", &format!("Downloading {what} — {size} · {}/s{eta}", mb(speed as u64)), done, total);
        }
    }
    file.sync_all()?;
    drop(file);
    std::fs::rename(&part, dest)?;
    emit(app, kind, "download", &format!("Downloaded {what} ({})", mb(done)), done, done.max(1));
    Ok(())
}

async fn tokio_timeout<F: std::future::Future>(f: F) -> Result<F::Output> {
    tokio::time::timeout(Duration::from_secs(60), f).await.map_err(|_| anyhow!("timed out"))
}

/// A reader that hides the self-extractor stub in front of an embedded 7z archive.
struct Offset {
    f: std::fs::File,
    off: u64,
}
impl Read for Offset {
    fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
        self.f.read(b)
    }
}
impl Seek for Offset {
    fn seek(&mut self, p: SeekFrom) -> std::io::Result<u64> {
        let r = match p {
            SeekFrom::Start(n) => self.f.seek(SeekFrom::Start(n + self.off))?,
            other => self.f.seek(other)?,
        };
        Ok(r.saturating_sub(self.off))
    }
}

/// Unpack a 7z archive (plain or 7-Zip SFX .exe) into `dest`, reporting byte progress.
fn extract_7z(app: &AppHandle, inst: &InstallState, kind: &str, what: &str, archive: &Path, dest: &Path) -> Result<()> {
    let mut f = std::fs::File::open(archive)?;
    let mut head = vec![0u8; 8 << 20];
    let n = f.read(&mut head)?;
    const SIG: [u8; 6] = [b'7', b'z', 0xBC, 0xAF, 0x27, 0x1C];
    let off = head[..n].windows(6).position(|w| w == SIG).ok_or_else(|| anyhow!("{what}: not a 7-Zip archive"))? as u64;
    f.seek(SeekFrom::Start(off))?;
    let mut r = sevenz_rust2::ArchiveReader::new(Offset { f, off }, sevenz_rust2::Password::empty()).map_err(|e| anyhow!("{what}: {e}"))?;
    let total: u64 = r.archive().files.iter().map(|e| e.size).sum();
    let mut done = 0u64;
    let mut last = Instant::now() - Duration::from_secs(1);
    let mut cancelled = false;
    let mut err: Option<anyhow::Error> = None;
    r.for_each_entries(|e, rd| {
        if inst.cancel.load(Ordering::SeqCst) {
            cancelled = true;
            return Ok(false);
        }
        // reject absolute paths / traversal
        let name = e.name().replace('\\', "/");
        if name.split('/').any(|s| s == "..") || name.starts_with('/') || name.contains(':') {
            return Ok(true);
        }
        let p = dest.join(&name);
        if e.is_directory() {
            let _ = std::fs::create_dir_all(&p);
            return Ok(true);
        }
        let res = (|| -> std::io::Result<()> {
            if let Some(d) = p.parent() {
                std::fs::create_dir_all(d)?;
            }
            let mut w = std::io::BufWriter::with_capacity(1 << 16, std::fs::File::create(&p)?);
            let mut b = [0u8; 1 << 16];
            loop {
                let k = rd.read(&mut b)?;
                if k == 0 {
                    break;
                }
                w.write_all(&b[..k])?;
                done += k as u64;
                if last.elapsed() > Duration::from_millis(120) {
                    last = Instant::now();
                    emit(app, kind, "extract", &format!("Unpacking {what} — {} of {}", mb(done), mb(total)), done, total);
                }
            }
            w.flush()
        })();
        if let Err(e) = res {
            err = Some(anyhow!("{}: {e}", p.display()));
            return Ok(false);
        }
        Ok(true)
    })
    .map_err(|e| anyhow!("{what}: {e}"))?;
    if cancelled {
        bail!("Cancelled");
    }
    if let Some(e) = err {
        return Err(e);
    }
    emit(app, kind, "extract", &format!("Unpacked {what}"), total, total.max(1));
    Ok(())
}

// ---------------- installers ----------------

#[derive(Serialize)]
pub struct Installed {
    version: String,
    path: String,
}

async fn install_tectonic(app: &AppHandle, inst: &InstallState) -> Result<Installed> {
    let kind = "tectonic";
    emit(app, kind, "setup", "Finding the latest Tectonic release…", 0, 0);
    let releases: serde_json::Value = http()?
        .get("https://api.github.com/repos/tectonic-typesetting/tectonic/releases?per_page=60")
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(60))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let target = if cfg!(windows) { "x86_64-pc-windows-msvc" } else { "x86_64-unknown-linux-musl" };
    let (version, url) = releases
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["tag_name"].as_str().unwrap_or("").starts_with("tectonic@") && !r["prerelease"].as_bool().unwrap_or(false))
        .find_map(|r| {
            r["assets"].as_array()?.iter().find(|a| {
                let n = a["name"].as_str().unwrap_or("");
                n.contains(target) && n.ends_with(".zip")
            }).map(|a| (r["tag_name"].as_str().unwrap_or("").trim_start_matches("tectonic@").to_string(), a["browser_download_url"].as_str().unwrap_or("").to_string()))
        })
        .ok_or_else(|| anyhow!("No Tectonic release for {target} found on GitHub"))?;
    let tmp = data_dir(app).join("downloads").join(format!("tectonic-{version}.zip"));
    download(app, inst, kind, &format!("Tectonic {version}"), &url, &tmp).await?;
    emit(app, kind, "extract", "Unpacking Tectonic…", 0, 0);
    let dest = tectonic_path(app);
    std::fs::create_dir_all(dest.parent().unwrap())?;
    let mut zip = zip::ZipArchive::new(std::fs::File::open(&tmp)?)?;
    let exe_name = if cfg!(windows) { "tectonic.exe" } else { "tectonic" };
    let mut ok = false;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i)?;
        if f.name().rsplit('/').next() == Some(exe_name) {
            let part = dest.with_extension("part");
            std::io::copy(&mut f, &mut std::fs::File::create(&part)?)?;
            std::fs::rename(&part, &dest)?;
            ok = true;
            break;
        }
    }
    let _ = std::fs::remove_file(&tmp);
    if !ok {
        bail!("tectonic.exe not found in the downloaded archive");
    }
    emit(app, kind, "done", &format!("Tectonic {version} installed"), 1, 1);
    Ok(Installed { version, path: dest.to_string_lossy().to_string() })
}

async fn install_tinytex(app: &AppHandle, inst: &InstallState) -> Result<Installed> {
    let kind = "tinytex";
    let root = tinytex_root(app);
    let parent = root.parent().unwrap().to_path_buf();
    let tmp = data_dir(app).join("downloads").join("TinyTeX-1-windows.exe");
    download(app, inst, kind, "TinyTeX", TINYTEX_URL, &tmp).await?;

    // Unpack beside the final location, then swap it in, so a failed or cancelled
    // install never leaves a half-working TeX behind.
    let staging = parent.join("TinyTeX.staging");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;
    let (app2, tmp2, staging2) = (app.clone(), tmp.clone(), staging.clone());
    let res = tauri::async_runtime::spawn_blocking(move || {
        let inst = app2.state::<InstallState>();
        extract_7z(&app2, &inst, "tinytex", "TinyTeX", &tmp2, &staging2)
    })
    .await?;
    if let Err(e) = res {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    let unpacked = staging.join("TinyTeX");
    if !unpacked.is_dir() {
        let _ = std::fs::remove_dir_all(&staging);
        bail!("The TinyTeX archive had an unexpected layout");
    }
    emit(app, kind, "setup", "Finishing installation…", 0, 0);
    if root.exists() {
        std::fs::remove_dir_all(&root).context("Couldn't remove the previous TinyTeX (is a compile running?)")?;
    }
    std::fs::rename(&unpacked, &root)?;
    let _ = std::fs::remove_dir_all(&staging);
    let _ = std::fs::remove_file(&tmp);

    // Smoke test: the engine must start.
    let bin = tinytex_bin(app).ok_or_else(|| anyhow!("TinyTeX installed, but its bin folder is missing"))?;
    emit(app, kind, "setup", "Checking pdfLaTeX…", 0, 0);
    let exe = which("pdflatex", &[bin.clone()]).filter(|p| p.starts_with(&bin)).ok_or_else(|| anyhow!("pdflatex not found in TinyTeX"))?;
    let mut c = command(&exe);
    c.arg("--version");
    let o = tauri::async_runtime::spawn_blocking(move || run_with_timeout(c, Duration::from_secs(60))).await??;
    if !o.status.success() {
        bail!("TinyTeX was unpacked but pdflatex didn't start:\n{}", String::from_utf8_lossy(&o.stderr));
    }
    let version = tex_version(&root).unwrap_or_else(|| "TinyTeX".into());
    emit(app, kind, "done", &format!("TinyTeX ({version}) installed"), 1, 1);
    Ok(Installed { version, path: root.to_string_lossy().to_string() })
}

#[tauri::command]
pub async fn install_engine(app: AppHandle, inst: State<'_, InstallState>, kind: String) -> CmdResult<Installed> {
    if inst.busy.swap(true, Ordering::SeqCst) {
        return Err("Another installation is already running".into());
    }
    inst.cancel.store(false, Ordering::SeqCst);
    let r = match kind.as_str() {
        "tectonic" => install_tectonic(&app, &inst).await,
        "tinytex" => install_tinytex(&app, &inst).await,
        other => Err(anyhow!("Unknown engine: {other}")),
    };
    inst.busy.store(false, Ordering::SeqCst);
    r.es()
}

#[tauri::command]
pub fn cancel_install(inst: State<InstallState>) {
    inst.cancel.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub async fn remove_engine(app: AppHandle, kind: String) -> CmdResult<()> {
    match kind.as_str() {
        "tectonic" => {
            let p = tectonic_path(&app);
            if p.exists() {
                std::fs::remove_file(p).es()?;
            }
            // Tectonic's package cache can be large too
            #[cfg(windows)]
            if let Some(l) = std::env::var_os("LOCALAPPDATA") {
                let _ = std::fs::remove_dir_all(PathBuf::from(l).join("TectonicProject"));
            }
            Ok(())
        }
        "tinytex" => {
            let r = tinytex_root(&app);
            if r.exists() {
                std::fs::remove_dir_all(r).map_err(|e| format!("Couldn't remove TinyTeX: {e} (close any running compile and try again)"))?;
            }
            Ok(())
        }
        other => Err(format!("Unknown engine: {other}")),
    }
}

// ---------------- missing packages (TinyTeX) ----------------

/// Files TeX reported as missing in a log: "File `foo.sty' not found", missing fonts, biber.
pub fn missing_files(log: &str) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    let re_file = regex_lite::Regex::new(r"File `([^']+)' not found").unwrap();
    let re_tfm = regex_lite::Regex::new(r"Font \\[^=]+=([A-Za-z0-9_-]+)(?: at [^ ]+)? not loadable: Metric \(TFM\) file").unwrap();
    let re_ifind = regex_lite::Regex::new(r"! I can't find file `([^']+\.(?:sty|cls|tex|def|cfg|clo|fd))'").unwrap();
    for c in re_file.captures_iter(log).chain(re_ifind.captures_iter(log)) {
        v.push(c[1].to_string());
    }
    for c in re_tfm.captures_iter(log) {
        v.push(format!("{}.tfm", &c[1]));
    }
    let l = log.to_lowercase();
    if l.contains("'biber' is not recognized") || l.contains("biber: command not found") || l.contains("could not find biber") || l.contains("failed to find one or more biber") {
        v.push("biber".into());
    }
    v.sort();
    v.dedup();
    v
}

/// Install the TeX Live package that provides `file` via TinyTeX's tlmgr. Returns the package.
pub fn tlmgr_install_for(app: &AppHandle, file: &str) -> Result<String> {
    let bin = tinytex_bin(app).ok_or_else(|| anyhow!("TinyTeX isn't installed"))?;
    let tlmgr = which("tlmgr", &[bin.clone()]).filter(|p| p.starts_with(&bin)).ok_or_else(|| anyhow!("tlmgr not found"))?;
    let pkg = if file == "biber" {
        "biber".to_string()
    } else {
        let mut c = command(&tlmgr);
        c.args(["search", "--global", "--file", &format!("/{file}")]);
        let o = run_with_timeout(c, Duration::from_secs(180))?;
        let out = String::from_utf8_lossy(&o.stdout).to_string();
        // output: "pkgname:\n\ttexmf-dist/.../file\n…"
        let mut cur: Option<String> = None;
        let mut found = None;
        for line in out.lines() {
            if !line.starts_with(char::is_whitespace) && line.trim_end().ends_with(':') && !line.contains(' ') {
                cur = Some(line.trim_end().trim_end_matches(':').to_string());
            } else if line.trim().ends_with(&format!("/{file}")) {
                if let Some(c) = &cur {
                    found = Some(c.clone());
                    break;
                }
            }
        }
        found.ok_or_else(|| anyhow!("No TeX Live package provides {file}"))?
    };
    let mut c = command(&tlmgr);
    c.args(["install", &pkg]);
    let o = run_with_timeout(c, Duration::from_secs(900))?;
    if !o.status.success() {
        bail!("tlmgr install {pkg} failed:\n{}", String::from_utf8_lossy(&o.stderr).trim());
    }
    Ok(pkg)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finds_missing() {
        let log = "! LaTeX Error: File `booktabs.sty' not found.\n! Font \\T1/cmr/m/n/10=ecrm1000 at 10.0pt not loadable: Metric (TFM) file not found.\n";
        assert_eq!(missing_files(log), vec!["booktabs.sty".to_string(), "ecrm1000.tfm".to_string()]);
    }
}
