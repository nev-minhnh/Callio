//! Where Callio's data lives — the pure part (std only, unit-tested on its own): the list of
//! data categories, the location pointer (`storage.json`) and how it turns into real folders.
//! `storage.rs` does the I/O around it.
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// One row of Settings › Data storage: an id, an English label (translated in the UI) and the
/// real folder names under the data folder it covers.
pub struct Cat {
    pub id: &'static str,
    pub label: &'static str,
    pub folders: &'static [&'static str],
}

pub const CATS: &[Cat] = &[
    Cat { id: "library", label: "Paper library", folders: &["library"] },
    Cat { id: "versions", label: "Versions & backups", folders: &["history", "backups", "pdf-backups"] },
    Cat { id: "memory", label: "AI memory & session journals", folders: &["memory", "cc-sessions"] },
    Cat { id: "drafts", label: "Unsaved drafts", folders: &["drafts"] },
    Cat { id: "csl", label: "Citation styles", folders: &["csl"] },
    Cat { id: "tools", label: "Tools Callio installed", folders: &["bin", "TinyTeX", "tesseract", "tessdata", "downloads"] },
    Cat { id: "skills", label: "Skills & Claude Code copies", folders: &["skills", "claude-code"] },
];

pub fn folders_of(ids: &[String]) -> Vec<&'static str> {
    CATS.iter().filter(|c| ids.iter().any(|i| i == c.id)).flat_map(|c| c.folders.iter().copied()).collect()
}

/// `config_dir/storage.json`
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Pointer {
    pub data_dir: Option<String>,
    /// folder name (e.g. "library") → where that folder lives now
    pub categories: HashMap<String, String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Problem {
    pub path: String,
    pub what: String,
}

#[derive(Clone, Debug)]
pub struct Layout {
    pub data: PathBuf,
    pub cats: HashMap<String, PathBuf>,
    pub problems: Vec<Problem>,
    pub portable: bool,
}

/// Turn the pointer into a layout. A portable `data\` folder wins over everything. A location that
/// is gone (drive unplugged, BitLocker locked…) becomes a problem and is never replaced by an
/// empty folder somewhere else: the caller shows a dialog instead.
pub fn resolve(p: &Pointer, default: &Path, portable: Option<&Path>, exists: &dyn Fn(&Path) -> bool) -> Layout {
    if let Some(d) = portable {
        return Layout { data: d.to_path_buf(), cats: HashMap::new(), problems: vec![], portable: true };
    }
    let mut problems = vec![];
    let data = match p.data_dir.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(d) => {
            let d = PathBuf::from(d);
            if !exists(&d) {
                problems.push(Problem { path: d.to_string_lossy().to_string(), what: "data folder".into() });
            }
            d
        }
        None => default.to_path_buf(),
    };
    let mut cats = HashMap::new();
    for (k, v) in &p.categories {
        if v.trim().is_empty() || !is_folder_name(k) {
            continue;
        }
        let path = PathBuf::from(v);
        // the category folder itself may be absent (nothing was in it); its parent must be there
        let anchor = path.parent().unwrap_or(&path);
        if !exists(anchor) {
            problems.push(Problem { path: v.clone(), what: k.clone() });
        }
        cats.insert(k.clone(), path);
    }
    Layout { data, cats, problems, portable: false }
}

pub fn is_folder_name(s: &str) -> bool {
    CATS.iter().any(|c| c.folders.contains(&s))
}

/// Same place, ignoring case, slashes and a trailing slash.
pub fn same_path(a: &Path, b: &Path) -> bool {
    key(a) == key(b)
}
pub fn key(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase()
}
/// `inner` is `outer` or below it.
pub fn is_inside(inner: &Path, outer: &Path) -> bool {
    let (i, o) = (key(inner), key(outer));
    i == o || i.starts_with(&format!("{o}/"))
}

/// The pointer after moving `folders` into `dest`. Moving every category makes `dest` the data folder.
pub fn after_move(old: &Pointer, dest: &Path, moved: &[&str], everything: bool) -> Pointer {
    if everything {
        return Pointer { data_dir: Some(dest.to_string_lossy().to_string()), categories: HashMap::new() };
    }
    let mut p = old.clone();
    for f in moved {
        p.categories.insert(f.to_string(), dest.join(f).to_string_lossy().to_string());
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_when_no_pointer() {
        let l = resolve(&Pointer::default(), Path::new("C:/d"), None, &|_| true);
        assert_eq!(l.data, PathBuf::from("C:/d"));
        assert!(l.problems.is_empty() && !l.portable);
    }
    #[test]
    fn portable_wins() {
        let p = Pointer { data_dir: Some("D:/x".into()), ..Default::default() };
        let l = resolve(&p, Path::new("C:/d"), Some(Path::new("E:/app/data")), &|_| false);
        assert!(l.portable && l.problems.is_empty());
        assert_eq!(l.data, PathBuf::from("E:/app/data"));
    }
    #[test]
    fn missing_drive_is_a_problem_not_a_new_folder() {
        let p = Pointer { data_dir: Some("D:/Callio".into()), ..Default::default() };
        let l = resolve(&p, Path::new("C:/d"), None, &|x| !x.to_string_lossy().starts_with("D:"));
        assert_eq!(l.problems.len(), 1);
        assert_eq!(l.problems[0].path, "D:/Callio");
        let mut c = HashMap::new();
        c.insert("library".to_string(), "D:/Callio/library".to_string());
        c.insert("nonsense".to_string(), "D:/Callio/x".to_string());
        let l2 = resolve(&Pointer { data_dir: None, categories: c }, Path::new("C:/d"), None, &|x| !x.to_string_lossy().starts_with("D:"));
        assert_eq!(l2.problems.len(), 1);
        assert_eq!(l2.cats.len(), 1);
    }
    #[test]
    fn move_updates_pointer() {
        let old = Pointer::default();
        let p = after_move(&old, Path::new("D:/C"), &["library", "csl"], false);
        assert_eq!(p.categories.get("csl").unwrap(), &PathBuf::from("D:/C").join("csl").to_string_lossy().to_string());
        assert!(p.data_dir.is_none());
        let q = after_move(&p, Path::new("D:/C"), &[], true);
        assert_eq!(q.data_dir.as_deref(), Some("D:/C"));
        assert!(q.categories.is_empty());
    }
    #[test]
    fn paths() {
        assert!(is_inside(Path::new("C:\\A\\b\\c"), Path::new("c:/a/B")));
        assert!(!is_inside(Path::new("C:/ab"), Path::new("C:/a")));
        assert!(same_path(Path::new("C:\\a\\"), Path::new("c:/A")));
        assert_eq!(folders_of(&["versions".into()]), vec!["history", "backups", "pdf-backups"]);
    }
}
