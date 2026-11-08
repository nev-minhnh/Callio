//! Export to PDF. Markdown is printed by Microsoft Edge (already on every Windows 11 PC) in
//! headless mode: headings become PDF bookmarks, links stay clickable, text stays text, and
//! images are embedded at their original resolution. LaTeX PDFs are copied as compiled.
use crate::util::{command, run_with_timeout, which, CmdResult, ErrStr};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn find_browser() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("CALLIO_CHROME").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }
    #[cfg(windows)]
    {
        let mut c = Vec::new();
        for k in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
            if let Some(d) = std::env::var_os(k) {
                c.push(PathBuf::from(d).join(r"Microsoft\Edge\Application\msedge.exe"));
            }
        }
        if let Some(p) = c.into_iter().find(|p| p.is_file()) {
            return Some(p);
        }
        which("msedge", &[])
    }
    #[cfg(not(windows))]
    {
        ["microsoft-edge", "chromium", "chromium-browser", "google-chrome"].iter().find_map(|n| which(n, &[]))
    }
}

/// Print a self-contained HTML document to `out` (PDF) with document outline (bookmarks).
#[tauri::command]
pub async fn export_html_pdf(html: String, out: String) -> CmdResult<u64> {
    let browser = find_browser().ok_or("Microsoft Edge wasn't found — it is needed to print Markdown to PDF.")?;
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<u64> {
        let dir = std::env::temp_dir().join(format!("callio-export-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)));
        std::fs::create_dir_all(&dir)?;
        struct Rm(PathBuf);
        impl Drop for Rm {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _rm = Rm(dir.clone());
        let page = dir.join("document.html");
        std::fs::write(&page, html)?;
        let tmp_pdf = dir.join("out.pdf");
        let url = tauri::Url::from_file_path(&page).map_err(|_| anyhow::anyhow!("bad temp path"))?.to_string();
        let mut c = command(&browser);
        c.args([
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-sync",
            "--allow-file-access-from-files",
            "--no-pdf-header-footer",
            "--generate-pdf-document-outline",
            "--run-all-compositor-stages-before-draw",
            "--virtual-time-budget=15000",
        ]);
        c.arg(format!("--user-data-dir={}", dir.join("profile").display()));
        c.arg(format!("--print-to-pdf={}", tmp_pdf.display()));
        #[cfg(not(windows))]
        c.arg("--no-sandbox");
        c.arg(url);
        let o = run_with_timeout(c, Duration::from_secs(180))?;
        let ok = std::fs::read(&tmp_pdf).map(|b| b.starts_with(b"%PDF")).unwrap_or(false);
        if !ok {
            anyhow::bail!("Edge couldn't print the document. {}", String::from_utf8_lossy(&o.stderr).lines().rev().find(|l| !l.trim().is_empty()).unwrap_or(""));
        }
        copy_over(&tmp_pdf, Path::new(&out))
    })
    .await
    .es()?
    .es()
}

fn copy_over(from: &Path, to: &Path) -> anyhow::Result<u64> {
    if let Some(d) = to.parent() {
        std::fs::create_dir_all(d)?;
    }
    std::fs::copy(from, to).map_err(|e| anyhow::anyhow!("Couldn't write {} ({e}). Is it open in another program?", to.display()))
}

/// Save a compiled PDF under a new name.
#[tauri::command]
pub async fn export_copy_pdf(src: String, out: String) -> CmdResult<u64> {
    if Path::new(&src) == Path::new(&out) {
        return Ok(0);
    }
    copy_over(Path::new(&src), Path::new(&out)).es()
}

#[tauri::command]
pub fn export_browser() -> Option<String> {
    find_browser().map(|p| p.to_string_lossy().to_string())
}
