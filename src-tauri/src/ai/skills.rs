//! Skills: folders of writing guidance the AI can follow. Supported shapes:
//!   - a folder with SKILL.md (Anthropic skill format, front matter name/description)
//!   - a packaged `.skill` / `.zip` file containing SKILL.md
//!   - any standalone .md guide (style guide, vocabulary list, …)
use crate::settings::data_dir;
use crate::util::{CmdResult, ErrStr};
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    /// stable id = path
    id: String,
    name: String,
    description: String,
    path: String,
    /// "skill" | "package" | "guide"
    kind: String,
    size: u64,
    source: String,
}

pub fn front_matter(text: &str) -> (Option<String>, Option<String>) {
    let t = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    if !t.starts_with("---") {
        return (None, None);
    }
    let end = t[3..].find("\n---").map(|e| e + 3);
    let Some(end) = end else { return (None, None) };
    let lines: Vec<&str> = t[3..end].lines().collect();
    // minimal YAML: `key: value`, quoted values, and block scalars (`>`, `|`) / indented
    // continuation lines.
    let get = |key: &str| -> Option<String> {
        let i = lines.iter().position(|l| l.starts_with(&format!("{key}:")))?;
        let v = lines[i][key.len() + 1..].trim();
        let mut parts: Vec<String> = Vec::new();
        let block = v.starts_with('>') || v.starts_with('|');
        if !block && !v.is_empty() {
            parts.push(v.to_string());
        }
        for l in &lines[i + 1..] {
            if l.starts_with(' ') || l.starts_with('\t') || l.trim().is_empty() {
                if !l.trim().is_empty() {
                    parts.push(l.trim().to_string());
                }
            } else {
                break;
            }
        }
        let s = parts.join(" ");
        let s = s.trim();
        let s = if (s.starts_with('"') && s.ends_with('"') || s.starts_with('\'') && s.ends_with('\'')) && s.len() >= 2 { &s[1..s.len() - 1] } else { s };
        Some(s.replace("\\\"", "\"")).filter(|x| !x.is_empty())
    };
    (get("name"), get("description"))
}

fn first_heading(text: &str) -> Option<String> {
    text.lines().find_map(|l| l.strip_prefix("# ").map(|h| h.trim().to_string()))
}
fn first_paragraph(text: &str) -> String {
    text.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("---") && !l.contains(':') || l.len() > 60)
        .take(2)
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect()
}

fn read_package(p: &Path) -> anyhow::Result<String> {
    let mut z = zip::ZipArchive::new(std::fs::File::open(p)?)?;
    let mut main = String::new();
    let mut extra = String::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i)?;
        let n = f.name().to_string();
        if f.is_dir() || !(n.ends_with(".md") || n.ends_with(".txt")) || f.size() > 400_000 {
            continue;
        }
        let mut s = String::new();
        f.read_to_string(&mut s)?;
        if n.rsplit('/').next() == Some("SKILL.md") {
            main = s;
        } else {
            extra.push_str(&format!("\n\n<!-- {n} -->\n{s}"));
        }
    }
    if main.is_empty() && extra.is_empty() {
        anyhow::bail!("no SKILL.md or markdown inside {}", p.display());
    }
    Ok(main + &extra)
}

fn describe(p: &Path, source: &str) -> Option<Skill> {
    let path = p.to_string_lossy().to_string();
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let fname = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    if p.is_dir() {
        let sk = p.join("SKILL.md");
        let text = std::fs::read_to_string(&sk).ok()?;
        let (n, d) = front_matter(&text);
        let size: u64 = std::fs::read_dir(p).ok()?.flatten().filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum();
        return Some(Skill { id: path.clone(), name: n.unwrap_or(fname), description: d.unwrap_or_else(|| first_paragraph(&text)), path, kind: "skill".into(), size, source: source.into() });
    }
    match ext.as_str() {
        "skill" | "zip" => {
            let text = read_package(p).ok()?;
            let (n, d) = front_matter(&text);
            Some(Skill { id: path.clone(), name: n.unwrap_or(fname), description: d.unwrap_or_else(|| first_paragraph(&text)), path, kind: "package".into(), size: text.len() as u64, source: source.into() })
        }
        "md" | "markdown" | "txt" => {
            if fname.eq_ignore_ascii_case("readme") {
                return None;
            }
            let text = std::fs::read_to_string(p).ok()?;
            let (n, d) = front_matter(&text);
            Some(Skill {
                id: path.clone(),
                name: n.or_else(|| first_heading(&text)).unwrap_or(fname),
                description: d.unwrap_or_else(|| first_paragraph(&text)),
                path,
                kind: "guide".into(),
                size: text.len() as u64,
                source: source.into(),
            })
        }
        _ => None,
    }
}

pub fn own_dir(app: &AppHandle) -> PathBuf {
    let d = data_dir(app).join("skills");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Find skills in the given folders (searched two levels deep) and in Callio's own folder.
#[tauri::command]
pub async fn skills_scan(app: AppHandle, folders: Vec<String>, include_own: bool) -> CmdResult<Vec<Skill>> {
    let mut out = Vec::new();
    let mut roots: Vec<(PathBuf, String)> = folders.into_iter().map(|f| (PathBuf::from(&f), f)).collect();
    if include_own {
        roots.insert(0, (own_dir(&app), "Callio".into()));
    }
    for (root, label) in roots {
        if root.join("SKILL.md").is_file() {
            if let Some(s) = describe(&root, &label) {
                out.push(s);
            }
            continue;
        }
        let mut stack = vec![(root.clone(), 0)];
        while let Some((d, depth)) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&d) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                let n = e.file_name().to_string_lossy().to_string();
                if n.starts_with('.') {
                    continue;
                }
                if p.is_dir() {
                    if p.join("SKILL.md").is_file() {
                        if let Some(s) = describe(&p, &label) {
                            out.push(s);
                        }
                    } else if depth < 2 {
                        stack.push((p, depth + 1));
                    }
                } else if let Some(s) = describe(&p, &label) {
                    out.push(s);
                }
            }
        }
    }
    out.sort_by(|a, b| a.source.cmp(&b.source).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// Full text of a skill (SKILL.md plus its markdown references) for the prompt.
#[tauri::command]
pub async fn skills_read(path: String) -> CmdResult<String> {
    let p = PathBuf::from(&path);
    if p.is_dir() {
        let mut s = std::fs::read_to_string(p.join("SKILL.md")).es()?;
        // include referenced markdown in the skill folder (one level), capped
        if let Ok(rd) = std::fs::read_dir(&p) {
            for e in rd.flatten() {
                let q = e.path();
                let n = e.file_name().to_string_lossy().to_string();
                if n != "SKILL.md" && (n.ends_with(".md") || n.ends_with(".txt")) && s.len() < 120_000 {
                    if let Ok(t) = std::fs::read_to_string(&q) {
                        s.push_str(&format!("\n\n<!-- {n} -->\n{t}"));
                    }
                }
            }
        }
        return Ok(s);
    }
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if ext == "skill" || ext == "zip" {
        return read_package(&p).es();
    }
    std::fs::read_to_string(&p).es()
}

#[tauri::command]
pub fn skills_own_dir(app: AppHandle) -> String {
    own_dir(&app).to_string_lossy().to_string()
}
