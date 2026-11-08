//! Installed fonts, for PDF text boxes: the families Windows has as single .ttf/.otf files
//! (collections like Cambria's .ttc are skipped — they can't be embedded as one font).
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Serialize, Default, Clone)]
pub struct FontFamily {
    pub family: String,
    pub regular: Option<String>,
    pub bold: Option<String>,
    pub italic: Option<String>,
    #[serde(rename = "boldItalic")]
    pub bold_italic: Option<String>,
}

/// "Arial Bold Italic (TrueType)" → ("Arial", "boldItalic")
fn split_name(name: &str) -> Option<(String, &'static str)> {
    let n = name.trim();
    let n = n.strip_suffix("(TrueType)").or_else(|| n.strip_suffix("(OpenType)")).unwrap_or(n).trim();
    if n.contains(" & ") {
        return None;
    }
    for (suffix, style) in [(" Bold Italic", "boldItalic"), (" Bold Oblique", "boldItalic"), (" Bold", "bold"), (" Italic", "italic"), (" Oblique", "italic"), (" Regular", "regular")] {
        if let Some(f) = n.strip_suffix(suffix) {
            return Some((f.trim().to_string(), style));
        }
    }
    Some((n.to_string(), "regular"))
}

fn fonts_dir() -> PathBuf {
    let win = std::env::var_os("WINDIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows"));
    win.join("Fonts")
}

#[tauri::command]
pub async fn system_fonts() -> Vec<FontFamily> {
    tauri::async_runtime::spawn_blocking(list).await.unwrap_or_default()
}

fn list() -> Vec<FontFamily> {
    let mut map: BTreeMap<String, FontFamily> = BTreeMap::new();
    for (name, file) in registry_fonts() {
        let lower = file.to_lowercase();
        if !(lower.ends_with(".ttf") || lower.ends_with(".otf")) {
            continue;
        }
        let Some((family, style)) = split_name(&name) else { continue };
        let path = if PathBuf::from(&file).is_absolute() { PathBuf::from(&file) } else { fonts_dir().join(&file) };
        let p = Some(path.to_string_lossy().to_string());
        let e = map.entry(family.to_lowercase()).or_insert_with(|| FontFamily { family: family.clone(), ..Default::default() });
        match style {
            "bold" => e.bold = e.bold.take().or(p),
            "italic" => e.italic = e.italic.take().or(p),
            "boldItalic" => e.bold_italic = e.bold_italic.take().or(p),
            _ => e.regular = e.regular.take().or(p),
        }
    }
    map.into_values().filter(|f| f.regular.is_some()).collect()
}

#[cfg(windows)]
fn registry_fonts() -> Vec<(String, String)> {
    use winreg::enums::*;
    use winreg::RegKey;
    let mut v = vec![];
    for (root, key) in [(HKEY_LOCAL_MACHINE, "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"), (HKEY_CURRENT_USER, "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts")] {
        if let Ok(k) = RegKey::predef(root).open_subkey(key) {
            for (name, _) in k.enum_values().flatten() {
                if let Ok(file) = k.get_value::<String, _>(&name) {
                    v.push((name, file));
                }
            }
        }
    }
    v
}
#[cfg(not(windows))]
fn registry_fonts() -> Vec<(String, String)> {
    // development: whatever .ttf files are in the usual Linux folders
    let mut v = vec![];
    for d in ["/usr/share/fonts", "/usr/local/share/fonts"] {
        for e in walk(PathBuf::from(d)) {
            if let Some(stem) = e.file_stem().map(|s| s.to_string_lossy().to_string()) {
                let name = stem.replace('-', " ").replace("BoldItalic", "Bold Italic");
                v.push((name, e.to_string_lossy().to_string()));
            }
        }
    }
    v
}
#[cfg(not(windows))]
fn walk(d: PathBuf) -> Vec<PathBuf> {
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(&d) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() { out.extend(walk(p)); } else { out.push(p); }
        }
    }
    out
}

/// The bytes of a font file listed by `system_fonts` (only font files are readable).
#[tauri::command]
pub async fn font_file(path: String) -> Result<tauri::ipc::Response, String> {
    let l = path.to_lowercase();
    if !(l.ends_with(".ttf") || l.ends_with(".otf")) {
        return Err("Not a font file".into());
    }
    let known = tauri::async_runtime::spawn_blocking(list).await.unwrap_or_default();
    let ok = known.iter().any(|f| [&f.regular, &f.bold, &f.italic, &f.bold_italic].iter().any(|p| p.as_deref().map(|p| p.eq_ignore_ascii_case(&path)).unwrap_or(false)));
    if !ok {
        return Err("Not an installed font".into());
    }
    std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn names() {
        assert_eq!(super::split_name("Arial Bold Italic (TrueType)"), Some(("Arial".into(), "boldItalic")));
        assert_eq!(super::split_name("Segoe UI (TrueType)"), Some(("Segoe UI".into(), "regular")));
        assert_eq!(super::split_name("Cambria & Cambria Math (TrueType)"), None);
    }
}
