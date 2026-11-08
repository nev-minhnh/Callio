use crate::settings::{backend, data_dir, Backend, SettingsState};
use crate::util::{command, resolve, run_with_timeout, which, CmdResult, ErrStr};
use regex_lite::Regex;
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Diag {
    pub severity: String,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub message: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    pub ok: bool,
    pub pdf: Option<String>,
    pub log: String,
    pub diagnostics: Vec<Diag>,
    pub engine: String,
    pub duration_ms: u64,
    /// Files changed on disk as a side effect (e.g. merged in by an Overleaf push)
    pub updated: Vec<String>,
}

// ---------------- root detection ----------------

fn read_head(p: &Path, max: usize) -> String {
    std::fs::read(p).map(|b| String::from_utf8_lossy(&b[..b.len().min(max)]).to_string()).unwrap_or_default()
}

fn has_documentclass(text: &str) -> bool {
    text.lines().any(|l| {
        let l = l.split('%').next().unwrap_or("");
        l.contains("\\documentclass") || l.contains("\\documentstyle")
    })
}

fn magic_root(text: &str) -> Option<String> {
    let re = Regex::new(r"(?i)^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$").unwrap();
    text.lines().take(30).find_map(|l| re.captures(l).map(|c| c[1].to_string()))
}

fn tex_files(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.extension().map(|e| e.eq_ignore_ascii_case("tex")).unwrap_or(false)).collect())
        .unwrap_or_default();
    // prefer the usual names first
    v.sort_by_key(|p| {
        let n = p.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
        (!["main", "thesis", "paper", "report", "document", "manuscript"].contains(&n.as_str()), n)
    });
    v
}

pub fn find_root_path(file: &Path) -> PathBuf {
    let text = read_head(file, 256 * 1024);
    let dir = file.parent().unwrap_or(Path::new("."));
    if let Some(r) = magic_root(&text) {
        let p = resolve(dir, &r);
        let p = if p.extension().is_none() { p.with_extension("tex") } else { p };
        if p.is_file() {
            return p;
        }
    }
    if file.extension().map(|e| e.eq_ignore_ascii_case("tex")).unwrap_or(false) && has_documentclass(&text) {
        return file.to_path_buf();
    }
    let stem = file.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    // Walk up a few levels looking for a main document that includes this one.
    let mut d = Some(dir);
    let mut fallback: Option<PathBuf> = None;
    for _ in 0..4 {
        let Some(cur) = d else { break };
        for cand in tex_files(cur) {
            if cand == file {
                continue;
            }
            let t = read_head(&cand, 512 * 1024);
            if !has_documentclass(&t) {
                continue;
            }
            if !stem.is_empty() && t.contains(&stem) {
                return cand;
            }
            if fallback.is_none() {
                fallback = Some(cand);
            }
        }
        if fallback.is_some() {
            break;
        }
        d = cur.parent();
    }
    fallback.unwrap_or_else(|| file.to_path_buf())
}

#[tauri::command]
pub async fn find_root(path: String) -> CmdResult<String> {
    Ok(find_root_path(Path::new(&path)).to_string_lossy().to_string())
}

// ---------------- project index (labels, bib keys, files) ----------------

#[derive(Serialize, Default)]
pub struct ProjectIndex {
    labels: Vec<String>,
    citations: Vec<String>,
    files: Vec<String>,
}

#[tauri::command]
pub async fn scan_project(root: String) -> CmdResult<ProjectIndex> {
    let root = PathBuf::from(root);
    let label_re = Regex::new(r"\\label\{([^}]+)\}").unwrap();
    let bib_re = Regex::new(r"@[a-zA-Z]+\s*\{\s*([^,\s]+)\s*,").unwrap();
    let bibitem_re = Regex::new(r"\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}").unwrap();
    let (mut labels, mut cites, mut files) = (BTreeSet::new(), BTreeSet::new(), Vec::new());
    let mut stack = vec![(root.clone(), 0)];
    let mut count = 0;
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            if p.is_dir() {
                if depth < 6 {
                    stack.push((p, depth + 1));
                }
                continue;
            }
            count += 1;
            if count > 5000 {
                break;
            }
            let rel = p.strip_prefix(&root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or(name.clone());
            let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            if ["tex", "bib", "png", "jpg", "jpeg", "pdf", "eps", "svg", "tikz", "pgf", "sty", "cls"].contains(&ext.as_str()) && files.len() < 2000 {
                files.push(rel);
            }
            if ext == "tex" || ext == "bib" {
                let t = read_head(&p, 4 * 1024 * 1024);
                if ext == "tex" {
                    for c in label_re.captures_iter(&t) {
                        labels.insert(c[1].trim().to_string());
                    }
                    for c in bibitem_re.captures_iter(&t) {
                        cites.insert(c[1].trim().to_string());
                    }
                } else {
                    for c in bib_re.captures_iter(&t) {
                        cites.insert(c[1].trim().to_string());
                    }
                }
            }
        }
    }
    files.sort();
    Ok(ProjectIndex { labels: labels.into_iter().collect(), citations: cites.into_iter().collect(), files })
}

// ---------------- compile ----------------

pub fn build_dir(app: &AppHandle, root: &Path) -> PathBuf {
    let key = crate::util::sha256_hex(crate::util::path_key(&root.parent().unwrap_or(root).to_string_lossy()).as_bytes());
    data_dir(app).join("build").join(&key[..16])
}

/// pdflatex & co can't create subfolders of -output-directory for \include{dir/file}.
fn mirror_dirs(src: &Path, dst: &Path, depth: usize) {
    if depth > 5 {
        return;
    }
    if let Ok(rd) = std::fs::read_dir(src) {
        for e in rd.flatten() {
            let n = e.file_name();
            let ns = n.to_string_lossy();
            if e.path().is_dir() && !ns.starts_with('.') && ns != "node_modules" {
                let d = dst.join(&n);
                let _ = std::fs::create_dir_all(&d);
                mirror_dirs(&e.path(), &d, depth + 1);
            }
        }
    }
}

const TIMEOUT: Duration = Duration::from_secs(600);

#[tauri::command]
pub async fn compile(app: AppHandle, state: State<'_, SettingsState>, root: String, engine: Option<String>) -> CmdResult<CompileResult> {
    let mut b = backend(&state);
    if let Some(e) = engine.filter(|e| !e.is_empty()) {
        b.engine = e;
    }
    let root = PathBuf::from(root);
    if b.engine == "overleaf" {
        return crate::overleaf::compile_on_overleaf(&app, &b, &root).await.es();
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || compile_local(&app2, &b, &root)).await.es()?.es()
}

fn compile_once(app: &AppHandle, b: &Backend, root: &Path) -> anyhow::Result<(CompileResult, bool)> {
    let start = Instant::now();
    let dir = root.parent().unwrap_or(Path::new(".")).to_path_buf();
    let stem = root.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "main".into());
    let fname = root.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let out = build_dir(app, root);
    std::fs::create_dir_all(&out)?;
    let _ = std::fs::write(out.join(".source-dir"), dir.to_string_lossy().as_bytes());
    let extra = crate::engines::search_dirs(app, b);
    let find = |n: &str| which(n, &extra);
    let mut transcript = String::new();
    let sep = if cfg!(windows) { ";" } else { ":" };
    let dir_s = dir.to_string_lossy().to_string();
    let run = |mut c: std::process::Command, label: &str, transcript: &mut String| -> anyhow::Result<bool> {
        c.current_dir(&dir);
        // let bibtex/biber/kpathsea find files that live next to the sources
        c.env("BIBINPUTS", format!("{dir_s}{sep}"));
        c.env("TEXINPUTS", format!("{dir_s}{sep}"));
        let o = run_with_timeout(c, TIMEOUT)?;
        transcript.push_str(&format!("──── {label} ────\n"));
        transcript.push_str(&String::from_utf8_lossy(&o.stdout));
        transcript.push_str(&String::from_utf8_lossy(&o.stderr));
        transcript.push('\n');
        Ok(o.status.success())
    };

    let pdf_path = out.join(format!("{stem}.pdf"));
    let _ = std::fs::remove_file(out.join(format!("{stem}.log")));
    let mtime_before = std::fs::metadata(&pdf_path).and_then(|m| m.modified()).ok();

    let engine_label;
    let mut uses_tinytex = false;
    let ok = match b.engine.as_str() {
        "tectonic" => {
            let exe = find("tectonic").ok_or_else(|| anyhow::anyhow!("ENGINE_MISSING:tectonic:Tectonic isn't installed yet."))?;
            engine_label = "Tectonic".to_string();
            let mut c = command(exe);
            c.arg("--outdir").arg(&out).args(["--synctex", "--keep-logs", "--keep-intermediates", "--chatter", "minimal"]);
            if b.shell_escape {
                c.args(["-Z", "shell-escape"]);
            }
            c.arg(&fname);
            run(c, "tectonic", &mut transcript)?
        }
        "latexmk" => {
            let exe = find("latexmk").ok_or_else(|| anyhow::anyhow!("ENGINE_MISSING:tinytex:latexmk isn't installed."))?;
            engine_label = "latexmk".to_string();
            uses_tinytex = crate::engines::is_managed_tinytex(app, &exe);
            mirror_dirs(&dir, &out, 0);
            let mut c = command(exe);
            let flavor = match b.latexmk_flavor.as_str() {
                "xelatex" => "-xelatex",
                "lualatex" => "-lualatex",
                _ => "-pdf",
            };
            c.args([flavor, "-interaction=nonstopmode", "-file-line-error", "-synctex=1", "-f"]);
            if b.shell_escape {
                c.arg("-shell-escape");
            }
            c.arg(format!("-outdir={}", out.to_string_lossy()));
            c.arg(&fname);
            run(c, "latexmk", &mut transcript)?
        }
        eng @ ("pdflatex" | "xelatex" | "lualatex") => {
            let exe = find(eng).ok_or_else(|| anyhow::anyhow!("ENGINE_MISSING:tinytex:{eng} isn't installed."))?;
            uses_tinytex = crate::engines::is_managed_tinytex(app, &exe);
            engine_label = eng.to_string();
            mirror_dirs(&dir, &out, 0);
            let mk = |exe: &PathBuf| {
                let mut c = command(exe);
                c.args(["-interaction=nonstopmode", "-file-line-error", "-synctex=1"]);
                if b.shell_escape {
                    c.arg("-shell-escape");
                }
                c.arg(format!("-output-directory={}", out.to_string_lossy()));
                c.arg(&fname);
                c
            };
            let mut ok = run(mk(&exe), eng, &mut transcript)?;
            // bibliography pass
            let bcf = out.join(format!("{stem}.bcf"));
            let aux = std::fs::read_to_string(out.join(format!("{stem}.aux"))).unwrap_or_default();
            let mut need_rerun = false;
            if bcf.is_file() {
                if let Some(biber) = find("biber") {
                    let mut c = command(biber);
                    c.arg("--input-directory").arg(&out).arg("--output-directory").arg(&out).arg(&stem);
                    run(c, "biber", &mut transcript)?;
                    need_rerun = true;
                }
            } else if aux.contains("\\bibdata") {
                if let Some(bibtex) = find("bibtex") {
                    let mut c = command(bibtex);
                    c.arg(&stem);
                    c.current_dir(&out);
                    // bibtex must run inside the output dir; point it at the sources for .bib/.bst
                    c.env("BIBINPUTS", format!("{dir_s}{sep}"));
                    c.env("BSTINPUTS", format!("{dir_s}{sep}"));
                    let o = run_with_timeout(c, TIMEOUT)?;
                    transcript.push_str("──── bibtex ────\n");
                    transcript.push_str(&String::from_utf8_lossy(&o.stdout));
                    need_rerun = true;
                }
            }
            let log_text = |s: &str| std::fs::read_to_string(out.join(format!("{s}.log"))).unwrap_or_default();
            let mut passes = 0;
            while passes < 3 && (need_rerun || {
                let l = log_text(&stem);
                l.contains("Rerun to get") || l.contains("Label(s) may have changed") || l.contains("Please rerun")
            }) {
                need_rerun = false;
                ok = run(mk(&exe), &format!("{eng} (pass {})", passes + 2), &mut transcript)?;
                passes += 1;
            }
            ok
        }
        other => anyhow::bail!("Unknown engine: {other}"),
    };

    let log_file = std::fs::read(out.join(format!("{stem}.log"))).map(|b| String::from_utf8_lossy(&b).to_string()).unwrap_or_default();
    let mut diagnostics = parse_log(&log_file, &dir, root);
    for d in parse_log(&transcript, &dir, root) {
        if !diagnostics.iter().any(|x| x.message == d.message && x.line == d.line) {
            diagnostics.push(d);
        }
    }
    let pdf_fresh = std::fs::metadata(&pdf_path).and_then(|m| m.modified()).ok().map(|m| Some(m) != mtime_before).unwrap_or(false);
    let pdf = if pdf_path.is_file() { Some(pdf_path.to_string_lossy().to_string()) } else { None };
    let has_err = diagnostics.iter().any(|d| d.severity == "error");
    let log = if log_file.is_empty() { transcript } else { format!("{transcript}\n──── {stem}.log ────\n{log_file}") };
    Ok((CompileResult {
        ok: ok && pdf.is_some() && (pdf_fresh || !has_err),
        pdf,
        log,
        diagnostics,
        engine: engine_label,
        duration_ms: start.elapsed().as_millis() as u64,
        updated: Vec::new(),
    }, uses_tinytex))
}

/// Compile; with Callio's TinyTeX, install packages TeX reports missing and try again.
fn compile_local(app: &AppHandle, b: &Backend, root: &Path) -> anyhow::Result<CompileResult> {
    use tauri::Emitter;
    let mut tried: std::collections::HashSet<String> = Default::default();
    let mut installed: Vec<String> = Vec::new();
    let start = Instant::now();
    loop {
        let (mut r, tinytex) = compile_once(app, b, root)?;
        let missing: Vec<String> = if tinytex && b.auto_install_packages && tried.len() < 25 {
            crate::engines::missing_files(&r.log).into_iter().filter(|f| !tried.contains(f)).collect()
        } else {
            Vec::new()
        };
        if missing.is_empty() {
            if !installed.is_empty() {
                r.log = format!("──── installed packages: {} ────\n{}", installed.join(", "), r.log);
            }
            r.duration_ms = start.elapsed().as_millis() as u64;
            return Ok(r);
        }
        let mut any = false;
        for f in missing {
            tried.insert(f.clone());
            let _ = app.emit("compile-status", format!("Installing the LaTeX package for {f}…"));
            match crate::engines::tlmgr_install_for(app, &f) {
                Ok(pkg) => {
                    installed.push(pkg);
                    any = true;
                }
                Err(e) => {
                    let _ = app.emit("compile-status", format!("Couldn't install a package for {f}: {e}"));
                }
            }
        }
        if !any {
            r.duration_ms = start.elapsed().as_millis() as u64;
            return Ok(r);
        }
        let _ = app.emit("compile-status", "Recompiling…".to_string());
    }
}

// ---------------- log parsing ----------------

pub fn parse_log(log: &str, dir: &Path, root: &Path) -> Vec<Diag> {
    let fle = Regex::new(r"^(.*?\.(?:tex|sty|cls|bib|ltx|dtx|bbl|tikz|clo|def|cfg)):(\d+): (.*)$").unwrap();
    let tect = Regex::new(r"^(error|warning): (?:(.+?):(\d+): )?(.*)$").unwrap();
    let bang = Regex::new(r"^! (.*)$").unwrap();
    let lnum = Regex::new(r"^l\.(\d+)").unwrap();
    let warn = Regex::new(r"^((?:LaTeX|Package [\w.-]+|Class [\w.-]+)(?: [\w.-]+)? Warning): (.*)$").unwrap();
    let inline = Regex::new(r"on input line (\d+)").unwrap();
    let badbox = Regex::new(r"^((?:Over|Under)full \\[hv]box .*?)(?: (?:in paragraph|detected|has occurred while \\output is active))?(?: at lines? (\d+)(?:--\d+)?)?$").unwrap();

    let root_s = root.to_string_lossy().to_string();
    let mut out: Vec<Diag> = Vec::new();
    let lines: Vec<&str> = log.lines().collect();
    // TeX prints "(file" when it opens a file and ")" when it closes it; keep a stack so
    // messages are attributed to the user file currently being read.
    let dir_key = crate::util::path_key(&dir.to_string_lossy());
    let mut stack: Vec<Option<String>> = Vec::new();
    let mut i = 0;
    let push = |out: &mut Vec<Diag>, d: Diag| {
        if !out.iter().any(|x| x.message == d.message && x.line == d.line && x.file == d.file) && out.len() < 500 {
            out.push(d);
        }
    };
    let file_of = |f: &str| -> String {
        let f = f.trim();
        let p = resolve(dir, f);
        if p.exists() { p.to_string_lossy().to_string() } else { resolve(dir, f).to_string_lossy().to_string() }
    };
    while i < lines.len() {
        let l = lines[i];
        // track which file TeX is currently reading
        let b = l.as_bytes();
        let mut k = 0;
        while k < b.len() {
            match b[k] {
                b'(' => {
                    let rest = &l[k + 1..];
                    let end = rest.find(|c: char| c.is_whitespace() || c == '(' || c == ')').unwrap_or(rest.len());
                    let tok = &rest[..end];
                    let is_path = tok.contains('.') && (tok.starts_with('.') || tok.starts_with('/') || tok.contains(':') || tok.contains('/') || tok.contains('\\'))
                        && tok.rsplit('.').next().map(|e| e.len() <= 4 && e.chars().all(|c| c.is_ascii_alphanumeric())).unwrap_or(false);
                    stack.push(if is_path { Some(tok.to_string()) } else { None });
                    k += 1 + end;
                    continue;
                }
                b')' => {
                    stack.pop();
                }
                _ => {}
            }
            k += 1;
        }
        let cur_file = stack
            .iter()
            .rev()
            .flatten()
            .map(|f| file_of(f))
            .find(|f| crate::util::path_key(f).starts_with(&dir_key))
            .unwrap_or_else(|| root_s.clone());
        // "warning: file.sty:11: …" (Tectonic) is a warning, not a file:line: error
        if let Some(c) = fle.captures(l).filter(|_| !l.starts_with("warning: ") && !l.starts_with("error: ")) {
            let mut msg = c[3].to_string();
            // following lines up to "l.N" give context
            let mut j = i + 1;
            while j < lines.len() && j < i + 8 && !lnum.is_match(lines[j]) && !lines[j].is_empty() && !fle.is_match(lines[j]) {
                j += 1;
            }
            if j < lines.len() && lnum.is_match(lines[j]) {
                let ctx = lines[j].splitn(2, ' ').nth(1).unwrap_or("").trim();
                if !ctx.is_empty() {
                    msg.push_str(&format!("\n  near: {ctx}"));
                }
            }
            push(&mut out, Diag { severity: "error".into(), file: Some(file_of(&c[1])), line: c[2].parse().ok(), message: msg });
        } else if let Some(c) = tect.captures(l) {
            let sev = if &c[1] == "error" { "error" } else { "warning" };
            let msg = c[4].trim().to_string();
            if msg.starts_with("halted on potentially-recoverable error") && out.iter().any(|d| d.severity == "error") {
                // summary line; real error already captured
            } else {
                let file = c.get(2).map(|f| file_of(f.as_str())).or(Some(root_s.clone()));
                push(&mut out, Diag { severity: sev.into(), file, line: c.get(3).and_then(|x| x.as_str().parse().ok()), message: msg });
            }
        } else if let Some(c) = bang.captures(l) {
            let mut msg = c[1].to_string();
            let mut line = None;
            for j in i + 1..(i + 12).min(lines.len()) {
                if let Some(m) = lnum.captures(lines[j]) {
                    line = m[1].parse().ok();
                    let ctx = lines[j].splitn(2, ' ').nth(1).unwrap_or("").trim();
                    if !ctx.is_empty() {
                        msg.push_str(&format!("\n  near: {ctx}"));
                    }
                    break;
                }
            }
            push(&mut out, Diag { severity: "error".into(), file: Some(cur_file.clone()), line, message: msg });
        } else if let Some(c) = warn.captures(l) {
            let mut msg = c[2].to_string();
            let mut j = i + 1;
            while j < lines.len() && !lines[j].trim().is_empty() && lines[j].starts_with(' ') && j < i + 6 {
                msg.push(' ');
                msg.push_str(lines[j].trim());
                j += 1;
            }
            let line = inline.captures(&msg).and_then(|m| m[1].parse().ok());
            let msg = inline.replace(&msg, "").trim().trim_end_matches('.').trim().to_string();
            push(&mut out, Diag { severity: "warning".into(), file: Some(cur_file.clone()), line, message: format!("{}: {msg}", &c[1]) });
        } else if let Some(c) = badbox.captures(l) {
            push(&mut out, Diag { severity: "info".into(), file: Some(cur_file.clone()), line: c.get(2).and_then(|x| x.as_str().parse().ok()), message: c[1].to_string() });
        }
        i += 1;
    }
    // errors first
    out.sort_by_key(|d| match d.severity.as_str() {
        "error" => 0,
        "warning" => 1,
        _ => 2,
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tectonic_warning_with_file() {
        let d = parse_log("warning: algorithm.sty:11: Package float Warning: something\n", std::path::Path::new("/tmp"), std::path::Path::new("/tmp/main.tex"));
        assert_eq!(d[0].severity, "warning");
    }

    #[test]
    fn parses_file_line_error() {
        let log = "(./main.tex\n./main.tex:7: Undefined control sequence.\nl.7 \\foo\n\nLaTeX Warning: Reference `x' on page 1 undefined on input line 9.\n\nOverfull \\hbox (3.2pt too wide) in paragraph at lines 12--14\n";
        let d = parse_log(log, Path::new("/p"), Path::new("/p/main.tex"));
        assert_eq!(d[0].severity, "error");
        assert_eq!(d[0].line, Some(7));
        assert!(d[0].message.contains("near: \\foo"));
        assert_eq!(d[1].severity, "warning");
        assert_eq!(d[1].line, Some(9));
        assert_eq!(d[2].severity, "info");
        assert_eq!(d[2].line, Some(12));
    }
    #[test]
    fn parses_tectonic() {
        let log = "error: main.tex:5: Undefined control sequence\nerror: halted on potentially-recoverable error as specified\n";
        let d = parse_log(log, Path::new("/p"), Path::new("/p/main.tex"));
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].line, Some(5));
    }
    #[test]
    fn parses_bang() {
        let log = "(./main.tex\n! Missing $ inserted.\n<inserted text>\n$\nl.12 a_b\n";
        let d = parse_log(log, Path::new("/p"), Path::new("/p/main.tex"));
        assert_eq!(d[0].line, Some(12));
        assert!(d[0].file.as_deref().unwrap().ends_with("main.tex"));
    }
}
