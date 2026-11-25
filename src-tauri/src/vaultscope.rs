//! What Callio may touch in an Obsidian vault — the pure part (std only, unit-tested on its own).
//! Every vault command and every AI tool goes through `Scope`, so a folder that is "hidden" in the
//! settings is refused here too, not only greyed out in the UI.
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq)]
pub enum Access {
    /// these folders (vault-relative, `/`-separated, lowercase compare)
    Folders(Vec<String>),
    All,
    Nothing,
}

#[derive(Clone, Debug)]
pub struct Scope {
    pub vault: PathBuf,
    pub callio_dir: String,
    pub read: Access,
    pub write: Access,
}

const RESERVED: &[&str] = &["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"];

/// A vault-relative path made safe: `/` separators, no `..`, no drive letters or streams, no
/// Windows device names, never inside `.obsidian` (settings and plugins: they can run code).
pub fn normalize_rel(rel: &str) -> Result<String, String> {
    let r = rel.trim().replace('\\', "/");
    if r.is_empty() {
        return Err("Empty path".into());
    }
    if r.starts_with('/') || r.contains(':') || r.starts_with("//") {
        return Err("Only paths inside the vault are allowed".into());
    }
    if r.chars().any(|c| c.is_control() || "<>\"|?*".contains(c)) || r.len() > 400 {
        return Err("This path has characters Windows doesn't allow".into());
    }
    let mut out: Vec<&str> = Vec::new();
    for c in r.split('/') {
        match c {
            "" | "." => {}
            ".." => return Err("Paths can't go up out of a folder".into()),
            c => {
                let lc = c.to_lowercase();
                let stem = lc.split('.').next().unwrap_or("");
                if c.ends_with('.') || c.ends_with(' ') || RESERVED.contains(&stem) {
                    return Err("This name isn't allowed on Windows".into());
                }
                if lc == ".obsidian" {
                    return Err("The .obsidian folder (settings and plugins) is off limits".into());
                }
                out.push(c);
            }
        }
    }
    if out.is_empty() {
        return Err("Empty path".into());
    }
    Ok(out.join("/"))
}

/// A folder from the settings, as a normalised prefix ("Papers/" → "papers"). Bad entries → None.
pub fn clean_folder(f: &str) -> Option<String> {
    let t = f.trim().trim_matches(|c| c == '/' || c == '\\');
    if t.is_empty() {
        return None;
    }
    normalize_rel(t).ok().map(|s| s.to_lowercase())
}

pub fn in_folders(rel: &str, folders: &[String]) -> bool {
    let r = rel.to_lowercase();
    folders.iter().any(|f| r == *f || r.starts_with(&format!("{f}/")))
}

impl Scope {
    /// Build from the settings values. `read_mode`: "folders" | "all". `write_mode`: "callio" | "folders" | "all" | "none".
    /// The Callio folder is always part of "folders" (the notes live there).
    pub fn new(vault: &str, callio_dir: &str, read_mode: &str, read_folders: &[String], write_mode: &str, write_folders: &[String]) -> Scope {
        let cd = clean_folder(callio_dir).unwrap_or_else(|| "callio".into());
        let with_callio = |fs: &[String]| -> Vec<String> {
            let mut v: Vec<String> = fs.iter().filter_map(|f| clean_folder(f)).collect();
            if !v.contains(&cd) {
                v.push(cd.clone());
            }
            v
        };
        let read = if read_mode == "all" { Access::All } else { Access::Folders(with_callio(read_folders)) };
        let write = match write_mode {
            "all" => Access::All,
            "folders" => Access::Folders(with_callio(write_folders)),
            "none" => Access::Nothing,
            _ => Access::Folders(vec![cd.clone()]),
        };
        Scope { vault: PathBuf::from(vault), callio_dir: cd, read, write }
    }
    fn allows(a: &Access, rel: &str) -> bool {
        match a {
            Access::All => true,
            Access::Nothing => false,
            Access::Folders(f) => in_folders(rel, f),
        }
    }
    pub fn can_read(&self, rel: &str) -> bool {
        normalize_rel(rel).map(|r| Self::allows(&self.read, &r)).unwrap_or(false)
    }
    /// (the commands use `check_write`; this is the yes/no form, used by the tests)
    #[allow(dead_code)]
    pub fn can_write(&self, rel: &str) -> bool {
        normalize_rel(rel).map(|r| Self::allows(&self.write, &r)).unwrap_or(false)
    }
    /// The absolute path for a readable file, or why not.
    pub fn check_read(&self, rel: &str) -> Result<(PathBuf, String), String> {
        let r = normalize_rel(rel)?;
        if !Self::allows(&self.read, &r) {
            return Err(format!("“{r}” is outside the folders Callio may read in this vault (Settings › AI memory › Permissions)."));
        }
        Ok((self.vault.join(&r), r))
    }
    pub fn check_write(&self, rel: &str) -> Result<(PathBuf, String), String> {
        let r = normalize_rel(rel)?;
        if matches!(self.write, Access::Nothing) {
            return Err("Callio isn't allowed to write in this vault (Settings › AI memory › Permissions).".into());
        }
        if !Self::allows(&self.write, &r) {
            return Err(format!("“{r}” is outside the folders Callio may write in this vault (Settings › AI memory › Permissions)."));
        }
        Ok((self.vault.join(&r), r))
    }
    /// Folders to search for recall (None = the whole vault).
    pub fn read_folders(&self) -> Option<Vec<String>> {
        match &self.read {
            Access::Folders(f) => Some(f.clone()),
            Access::All => None,
            Access::Nothing => Some(vec![]),
        }
    }
}

/// The nearest existing ancestor of `p` must really be inside the vault (a junction or symlink
/// pointing out of it is refused).
pub fn inside_vault(vault: &Path, p: &Path) -> bool {
    let Ok(v) = vault.canonicalize() else { return false };
    let mut cur = Some(p);
    while let Some(c) = cur {
        if let Ok(real) = c.canonicalize() {
            return real.starts_with(&v);
        }
        cur = c.parent();
    }
    false
}

/// CLI levels: "read" (search, read, open) < "write" (+ create notes, edit properties) < "all"
/// (everything, including running JavaScript).
pub fn cli_allows(level: &str, command: &str) -> bool {
    const READ: &[&str] = &["version", "help", "vault", "vaults", "search", "search:context", "read", "open", "file", "files", "folder", "folders", "tags", "tag", "links", "backlinks", "outline", "properties", "property:read", "daily:read", "wordcount", "aliases", "orphans", "unresolved"];
    const WRITE: &[&str] = &["create", "append", "prepend", "daily", "daily:append", "daily:prepend", "property:set", "property:remove"];
    let c = command.trim().to_lowercase();
    match level {
        "all" => !c.is_empty(),
        "write" => READ.contains(&c.as_str()) || WRITE.contains(&c.as_str()),
        _ => READ.contains(&c.as_str()),
    }
}

/// Which sync tool keeps a vault in step, guessed from where it is (the author's wording in the
/// UI: OneDrive, Dropbox, Google Drive, iCloud, Git, Obsidian Sync, or unknown).
pub fn guess_sync(vault_path: &str, has_git: bool, has_obsidian_sync: bool) -> &'static str {
    let p = vault_path.replace('\\', "/").to_lowercase();
    let parts: Vec<&str> = p.split('/').collect();
    let any = |f: &dyn Fn(&str) -> bool| parts.iter().any(|x| f(x));
    if any(&|x| x.starts_with("onedrive")) {
        "onedrive"
    } else if any(&|x| x == "dropbox" || x.starts_with("dropbox (")) {
        "dropbox"
    } else if any(&|x| x == "google drive" || x == "googledrive" || x == "my drive" || x.starts_with("google drive")) {
        "gdrive"
    } else if any(&|x| x == "icloud" || x == "iclouddrive" || x.starts_with("icloud")) {
        "icloud"
    } else if has_obsidian_sync {
        "obsidian-sync"
    } else if has_git {
        "git"
    } else {
        "unknown"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn s() -> Scope {
        Scope::new("D:/Notes/Research", "Callio/", "folders", &["Papers/".into(), "Thesis".into()], "callio", &[])
    }
    #[test]
    fn defaults_for_an_existing_vault() {
        let s = s();
        assert!(s.can_read("Papers/a.md") && s.can_read("thesis/ch1/x.md") && s.can_read("Callio/Projects/P.md"));
        assert!(!s.can_read("Private/diary.md") && !s.can_read("Papersx/a.md"));
        assert!(s.can_write("Callio/Projects/P.md") && s.can_write("callio/Sessions/2026-01-01 x.md"));
        assert!(!s.can_write("Papers/a.md") && !s.can_write("Thesis/ch1.md"));
    }
    #[test]
    fn escapes_are_refused() {
        let s = s();
        for bad in ["../x.md", "Callio/../Private/a.md", "C:/Windows/x", "/etc/passwd", "Callio/a.md:stream", "\\\\server\\share\\a", "Callio/.obsidian/plugins/x.js", ".obsidian/app.json", "Callio/con.md", "Callio/a.md.", ""] {
            assert!(!s.can_write(bad) && !s.can_read(bad), "{bad}");
            assert!(s.check_write(bad).is_err());
        }
    }
    #[test]
    fn write_modes() {
        let none = Scope::new("V", "Callio", "all", &[], "none", &[]);
        assert!(none.can_read("anything/a.md") && !none.can_write("Callio/a.md"));
        assert!(none.check_write("Callio/a.md").unwrap_err().contains("isn't allowed to write"));
        let sel = Scope::new("V", "Callio", "all", &[], "folders", &["Inbox".into()]);
        assert!(sel.can_write("Inbox/a.md") && sel.can_write("Callio/x.md") && !sel.can_write("Papers/a.md"));
        // a full-permission (Callio-created) vault
        let full = Scope::new("V", "Callio", "all", &[], "all", &[]);
        assert!(full.can_write("Papers/a.md") && !full.can_write(".obsidian/app.json"));
        assert!(none.read_folders().is_none());
    }
    #[test]
    fn cli_levels() {
        assert!(cli_allows("read", "search") && cli_allows("read", "open") && !cli_allows("read", "create"));
        assert!(cli_allows("write", "create") && cli_allows("write", "property:set") && !cli_allows("write", "eval"));
        assert!(cli_allows("all", "eval") && !cli_allows("all", ""));
        assert!(!cli_allows("bogus", "eval"));
    }
    #[test]
    fn sync_guess() {
        assert_eq!(guess_sync("C:\\Users\\m\\OneDrive\\Notes", false, false), "onedrive");
        assert_eq!(guess_sync("C:\\Users\\m\\OneDrive - Monash University\\Notes", false, false), "onedrive");
        assert_eq!(guess_sync("D:\\Dropbox\\n", true, false), "dropbox");
        assert_eq!(guess_sync("D:\\Notes\\Research", true, false), "git");
        assert_eq!(guess_sync("D:\\Notes\\Research", false, false), "unknown");
        assert_eq!(guess_sync("G:\\My Drive\\Notes", false, false), "gdrive");
    }
    #[test]
    fn normalises() {
        assert_eq!(normalize_rel("Callio\\Projects//./P.md").unwrap(), "Callio/Projects/P.md");
        assert_eq!(clean_folder("/Papers/"), Some("papers".into()));
        assert_eq!(clean_folder("  "), None);
    }
}
