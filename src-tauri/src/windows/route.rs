//! Where does a file open? A pure decision (no Tauri, no I/O) so it can be unit-tested on its own:
//!   rustc --test src-tauri/src/windows/route.rs -o /tmp/route_test && /tmp/route_test
//!
//! The rule: a file opens in the window it was asked from when that window has no folder or the
//! file is inside its folder; otherwise in the window that already has the file open, else in a
//! window whose folder contains it, else in a new window whose folder is the file's directory.

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Win {
    pub label: String,
    pub folder: Option<String>,
    pub files: Vec<String>,
    /// larger = focused more recently
    pub focused_at: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Decision {
    /// open (or activate the tab) in the asking window
    Here,
    /// another window already has the file: focus it and its tab
    Focus(String),
    /// another window's folder contains the file: open it there
    OpenIn(String),
    /// nobody: a new window with this folder
    New { folder: String },
}

/// `\` → `/`, lower case, no trailing slash: how paths are compared (Windows is case-insensitive).
pub fn norm(p: &str) -> String {
    let s = p.replace('\\', "/").to_lowercase();
    if s.len() > 1 && s.ends_with('/') && !s.ends_with(":/") {
        s.trim_end_matches('/').to_string()
    } else {
        s
    }
}

pub fn inside(path: &str, dir: &str) -> bool {
    let (p, d) = (norm(path), norm(dir));
    if d.is_empty() {
        return false;
    }
    let d = d.trim_end_matches('/');
    p == d || p.starts_with(&format!("{d}/"))
}

pub fn dirname(path: &str) -> String {
    let p = path.replace('\\', "/");
    match p.rfind('/') {
        Some(0) => "/".to_string(),
        Some(i) if i == 2 && p.as_bytes().get(1) == Some(&b':') => p[..3].to_string(), // C:/x → C:/
        Some(i) => p[..i].to_string(),
        None => String::new(),
    }
}

pub fn decide(path: &str, me: &Win, others: &[Win]) -> Decision {
    let key = norm(path);
    if me.files.iter().any(|f| norm(f) == key) {
        return Decision::Here;
    }
    match &me.folder {
        None => return Decision::Here,
        Some(f) if inside(path, f) => return Decision::Here,
        _ => {}
    }
    // another window has this very file open (the most recently used one if several)
    if let Some(w) = others.iter().filter(|w| w.files.iter().any(|f| norm(f) == key)).max_by_key(|w| w.focused_at) {
        return Decision::Focus(w.label.clone());
    }
    // a window whose folder holds it: the deepest folder wins, then the most recently used
    let best = others
        .iter()
        .filter_map(|w| w.folder.as_ref().filter(|f| inside(path, f)).map(|f| (norm(f).len(), w.focused_at, &w.label)))
        .max_by_key(|(len, at, _)| (*len, *at));
    if let Some((_, _, label)) = best {
        return Decision::OpenIn(label.clone());
    }
    Decision::New { folder: dirname(path) }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn w(label: &str, folder: Option<&str>, files: &[&str], at: u64) -> Win {
        Win { label: label.into(), folder: folder.map(String::from), files: files.iter().map(|s| s.to_string()).collect(), focused_at: at }
    }

    #[test]
    fn inside_folder_opens_here() {
        let me = w("main", Some("C:\\Work\\Paper"), &[], 1);
        assert_eq!(decide("c:/work/paper/sub/a.md", &me, &[]), Decision::Here);
        assert_eq!(decide("C:\\Work\\Paper\\a.md", &me, &[]), Decision::Here);
    }
    #[test]
    fn no_folder_opens_here() {
        let me = w("main", None, &[], 1);
        let other = w("w-2", Some("D:/x"), &["D:/x/a.md"], 2);
        assert_eq!(decide("D:/x/a.md", &me, &[other]), Decision::Here);
    }
    #[test]
    fn own_open_file_is_here_even_outside_the_folder() {
        let me = w("main", Some("C:/a"), &["D:/z/f.md"], 1);
        assert_eq!(decide("d:\\z\\F.md", &me, &[]), Decision::Here);
    }
    #[test]
    fn other_window_with_the_file_gets_focus() {
        let me = w("main", Some("C:/a"), &[], 1);
        let o1 = w("w-2", Some("D:/z"), &["D:/z/f.md"], 5);
        let o2 = w("w-3", Some("D:/z"), &[], 9);
        assert_eq!(decide("D:/z/f.md", &me, &[o1, o2]), Decision::Focus("w-2".into()));
    }
    #[test]
    fn other_windows_folder_contains_it() {
        let me = w("main", Some("C:/a"), &[], 1);
        let o1 = w("w-2", Some("D:/z"), &[], 5);
        let o2 = w("w-3", Some("D:/z/deep"), &[], 3);
        assert_eq!(decide("D:/z/deep/f.md", &me, &[o1.clone(), o2]), Decision::OpenIn("w-3".into()));
        assert_eq!(decide("D:/z/g.md", &me, &[o1]), Decision::OpenIn("w-2".into()));
    }
    #[test]
    fn new_window_when_nobody_has_it() {
        let me = w("main", Some("C:/a"), &[], 1);
        let o = w("w-2", Some("D:/zz"), &[], 5);
        assert_eq!(decide("D:/z/f.md", &me, &[o]), Decision::New { folder: "D:/z".into() });
        assert_eq!(decide("D:\\z\\sub\\f.md", &me, &[]), Decision::New { folder: "D:/z/sub".into() });
    }
    #[test]
    fn sibling_folder_with_same_prefix_is_not_inside() {
        assert!(!inside("C:/work/paper2/a.md", "C:/work/paper"));
        assert!(inside("C:/work/paper/a.md", "C:/work/paper/"));
        assert!(inside("C:/a.md", "C:\\"));
    }
    #[test]
    fn dirnames() {
        assert_eq!(dirname("C:\\a\\b.md"), "C:/a");
        assert_eq!(dirname("C:/b.md"), "C:/");
        assert_eq!(dirname("/home/x/b.md"), "/home/x");
    }
}
