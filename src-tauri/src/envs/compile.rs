//! LaTeX compile with the distro's own tools (latexmk / pdflatex / xelatex / lualatex / tectonic
//! from the distro) for a project that lives in WSL. The sources are read in place; the build
//! files (and the PDF) go to Callio's normal build folder on Windows (`/mnt/c/…` from the
//! distro), so the PDF viewer, SyncTeX folder mapping and "clean build files" behave as usual.
use super::exec::{self, Env};
use super::{argv, paths};
use crate::compile::{build_dir, parse_log, CompileResult};
use crate::settings::Backend;
use crate::util::run_with_timeout;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const TIMEOUT: Duration = Duration::from_secs(600);

/// `tools_in` is "wsl:<distro>". The root file may be a `\\wsl.localhost\…` path or a Windows path.
pub fn compile_in_wsl(app: &AppHandle, b: &Backend, root: &Path, tools_in: &str) -> anyhow::Result<CompileResult> {
    let start = Instant::now();
    let root_s = root.to_string_lossy().to_string();
    let (distro, root_linux) = match paths::parse_wsl_unc(&root_s) {
        Some(x) => x,
        None => (
            tools_in.strip_prefix("wsl:").unwrap_or("").to_string(),
            paths::win_to_wsl(&root_s).ok_or_else(|| anyhow::anyhow!("This file can't be reached from WSL."))?,
        ),
    };
    anyhow::ensure!(argv::safe_name(&distro), "That distribution name is not valid.");
    let env = Env::wsl(&distro);
    let dir_linux = paths::posix_parent(&root_linux);
    let fname = root_linux.rsplit('/').next().unwrap_or("main.tex").to_string();
    let stem = fname.rsplit_once('.').map(|x| x.0).unwrap_or(&fname).to_string();
    let dir_win = root.parent().unwrap_or(Path::new(".")).to_path_buf();

    let out: PathBuf = build_dir(app, root);
    std::fs::create_dir_all(&out)?;
    let _ = std::fs::write(out.join(".source-dir"), dir_win.to_string_lossy().as_bytes());
    crate::compile::mirror_dirs(&dir_win, &out, 0);
    let out_linux = paths::win_to_wsl(&out.to_string_lossy()).ok_or_else(|| anyhow::anyhow!("Callio's build folder can't be reached from WSL."))?;
    let pdf_path = out.join(format!("{stem}.pdf"));
    let _ = std::fs::remove_file(out.join(format!("{stem}.log")));
    let before = std::fs::metadata(&pdf_path).and_then(|m| m.modified()).ok();

    let have = |tool: &str| exec::out(&env, "sh", &["-c", &format!("command -v {tool}")], None, 30).map(|s| !s.trim().is_empty()).unwrap_or(false);
    let (prog, args, label): (&str, Vec<String>, String) = if b.engine == "tectonic" {
        if !have("tectonic") {
            anyhow::bail!("{distro} has no tectonic. Install it there, or choose “Windows” for the tools in this folder's settings.");
        }
        let mut a: Vec<String> = vec!["--outdir".into(), out_linux.clone(), "--synctex".into(), "--keep-logs".into(), "--keep-intermediates".into()];
        if b.shell_escape {
            a.extend(["-Z".into(), "shell-escape".into()]);
        }
        a.push(fname.clone());
        ("tectonic", a, "tectonic".into())
    } else {
        if !have("latexmk") {
            anyhow::bail!("latexmk isn't installed in {distro}. Install it there (sudo apt install latexmk texlive-latex-extra), or choose “Windows” for the tools in this folder's settings.");
        }
        let flavor = match b.engine.as_str() {
            "xelatex" => "-xelatex",
            "lualatex" => "-lualatex",
            "latexmk" => match b.latexmk_flavor.as_str() {
                "xelatex" => "-xelatex",
                "lualatex" => "-lualatex",
                _ => "-pdf",
            },
            _ => "-pdf",
        };
        let mut a: Vec<String> = vec![flavor.into(), "-interaction=nonstopmode".into(), "-file-line-error".into(), "-synctex=1".into(), "-f".into()];
        if b.shell_escape {
            a.push("-shell-escape".into());
        }
        a.push(format!("-outdir={out_linux}"));
        a.push(fname.clone());
        ("latexmk", a, format!("latexmk ({distro})"))
    };
    let inputs = format!("{dir_linux}:");
    let cmd = exec::command_env(&env, prog, &args, Some(&dir_linux), &[("BIBINPUTS", &inputs), ("TEXINPUTS", &inputs)]);
    let o = run_with_timeout(cmd, TIMEOUT)?;
    let mut transcript = format!("──── {label} ────\n{}{}\n", super::parse::decode_wsl_output(&o.stdout), super::parse::decode_wsl_output(&o.stderr));
    let log_file = std::fs::read(out.join(format!("{stem}.log"))).map(|b| String::from_utf8_lossy(&b).to_string()).unwrap_or_default();
    let mut diagnostics = parse_log(&log_file, &dir_win, root);
    for d in parse_log(&transcript, &dir_win, root) {
        if !diagnostics.iter().any(|x| x.message == d.message && x.line == d.line) {
            diagnostics.push(d);
        }
    }
    let fresh = std::fs::metadata(&pdf_path).and_then(|m| m.modified()).ok().map(|m| Some(m) != before).unwrap_or(false);
    let pdf = if pdf_path.is_file() { Some(pdf_path.to_string_lossy().to_string()) } else { None };
    let has_err = diagnostics.iter().any(|d| d.severity == "error");
    if !log_file.is_empty() {
        transcript = format!("{transcript}\n──── {stem}.log ────\n{log_file}");
    }
    Ok(CompileResult { ok: o.status.success() && pdf.is_some() && (fresh || !has_err), pdf, log: transcript, diagnostics, engine: label, duration_ms: start.elapsed().as_millis() as u64, updated: Vec::new() })
}
