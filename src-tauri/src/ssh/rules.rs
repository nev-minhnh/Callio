//! What a linked folder leaves out: `.gitignore`-style patterns (no `ignore` crate needed for this
//! much). `name` matches at any depth, `/name` only at the top, `dir/` only directories,
//! `*` `?` stay inside one path part, `**` crosses parts, `!pattern` brings something back.
//! The last matching pattern wins; a file inside an excluded folder is excluded.

pub const DEFAULT_EXCLUDES: &[&str] = &[".git/", ".venv/", "venv/", "__pycache__/", "node_modules/", ".ipynb_checkpoints/", "*.pyc", ".DS_Store", "Thumbs.db", "~$*"];
/// Never synced whatever the author writes: our own trash and half-copied files.
pub const ALWAYS: &[&str] = &[".callio-trash/", ".callio-tmp-*", ".callio-part-*", "* (server)", "* (server).*"];

#[derive(Clone, Debug)]
struct Pat {
    neg: bool,
    dir_only: bool,
    /// has a slash inside: matched against the whole path from the top
    anchored: bool,
    parts: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Rules {
    pats: Vec<Pat>,
}

fn part_match(p: &[u8], s: &[u8]) -> bool {
    match p.first() {
        None => s.is_empty(),
        Some(b'*') => (0..=s.len()).any(|i| part_match(&p[1..], &s[i..])),
        Some(b'?') => !s.is_empty() && part_match(&p[1..], &s[1..]),
        Some(c) => s.first() == Some(c) && part_match(&p[1..], &s[1..]),
    }
}

fn parts_match(p: &[String], s: &[&str]) -> bool {
    match p.first() {
        None => s.is_empty(),
        Some(x) if x == "**" => (0..=s.len()).any(|i| parts_match(&p[1..], &s[i..])),
        Some(x) => !s.is_empty() && part_match(x.as_bytes(), s[0].as_bytes()) && parts_match(&p[1..], &s[1..]),
    }
}

impl Rules {
    /// Defaults first, then the author's lines (later lines win).
    pub fn new(lines: &[String]) -> Rules {
        let mut r = Rules::default();
        for l in DEFAULT_EXCLUDES.iter().map(|s| s.to_string()).chain(lines.iter().cloned()).chain(ALWAYS.iter().map(|s| s.to_string())) {
            r.add(&l);
        }
        r
    }
    fn add(&mut self, line: &str) {
        let mut l = line.trim_end_matches(['\r', '\n']).trim_end().to_string();
        if l.is_empty() || l.starts_with('#') {
            return;
        }
        let neg = l.starts_with('!');
        if neg {
            l.remove(0);
        }
        let dir_only = l.ends_with('/');
        let l = l.trim_end_matches('/');
        let anchored = l.starts_with('/') || l.contains('/');
        let l = l.trim_start_matches('/');
        if l.is_empty() {
            return;
        }
        self.pats.push(Pat { neg, dir_only, anchored, parts: l.split('/').map(String::from).collect() });
    }
    /// Is this entry (`rel` uses `/`) left out? Also true when a folder above it is.
    pub fn excluded(&self, rel: &str, is_dir: bool) -> bool {
        let segs: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
        for i in 1..=segs.len() {
            let dir = i < segs.len() || is_dir;
            if self.hit(&segs[..i], dir) {
                return true;
            }
        }
        false
    }
    fn hit(&self, path: &[&str], is_dir: bool) -> bool {
        let mut res = false;
        for p in &self.pats {
            if p.dir_only && !is_dir {
                continue;
            }
            let ok = if p.anchored { parts_match(&p.parts, path) } else { path.last().map(|n| part_match(p.parts[0].as_bytes(), n.as_bytes())).unwrap_or(false) };
            if ok {
                res = !p.neg;
            }
        }
        res
    }
    /// Plain folder names the server can skip while listing (`find -prune`): the unanchored
    /// directory patterns without wildcards.
    pub fn prune_names(&self) -> Vec<String> {
        self.pats.iter().filter(|p| !p.neg && p.dir_only && !p.anchored && !p.parts[0].contains(['*', '?'])).map(|p| p.parts[0].clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults() {
        let r = Rules::new(&[]);
        for (p, d, want) in [(".git", true, true), ("a/.git/config", false, true), ("a/b.pyc", false, true), ("src/x.py", false, false), ("~$tmp.docx", false, true), (".venv/bin/python", false, true), ("notes/venv.md", false, false), ("a/.callio-trash/x", false, true), ("x/.callio-tmp-12", false, true), ("a/b (server).ipynb", false, true), ("a/b (server)", false, true)] {
            assert_eq!(r.excluded(p, d), want, "{p}");
        }
    }
    #[test]
    fn custom() {
        let r = Rules::new(&["/data/".into(), "*.csv".into(), "!keep.csv".into(), "out/**/tmp".into(), "# c".into()]);
        assert!(r.excluded("data/x.txt", false) && !r.excluded("sub/data/x.txt", false));
        assert!(r.excluded("a/b.csv", false) && !r.excluded("a/keep.csv", false));
        assert!(r.excluded("out/a/b/tmp", true) && !r.excluded("out/a/b/tmp2", true));
    }
    #[test]
    fn prune() {
        let r = Rules::new(&["/top/".into()]);
        let n = r.prune_names();
        assert!(n.contains(&".git".to_string()) && n.contains(&"node_modules".to_string()) && !n.contains(&"top".to_string()));
    }
}
