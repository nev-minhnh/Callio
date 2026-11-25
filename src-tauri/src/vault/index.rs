//! The vault index: every file of a vault, what each note contains (links, tags, headings,
//! blocks, aliases), Obsidian's "shortest unique path" link resolution, backlinks, and the link
//! rewrites for a rename. Std only (the JSON layer is in `api.rs`).
use super::text::{self, Block, Heading, Link};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

const MAX_FILES: usize = 300_000;
const MAX_NOTE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, Default)]
pub struct NoteInfo {
    pub aliases: Vec<String>,
    pub fm_tags: Vec<String>,
    pub tags: Vec<(String, usize)>,
    pub headings: Vec<Heading>,
    pub blocks: Vec<Block>,
    pub links: Vec<Link>,
}

#[derive(Clone, Debug)]
pub struct FileEntry {
    pub size: u64,
    pub mtime: u64,
    pub note: Option<NoteInfo>,
}

pub fn is_md(rel: &str) -> bool {
    rel.to_lowercase().ends_with(".md")
}
pub fn stem_of(rel: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    if is_md(name) { name[..name.len() - 3].to_string() } else { name.to_string() }
}
pub fn dir_of(rel: &str) -> &str {
    rel.rfind('/').map(|i| &rel[..i]).unwrap_or("")
}

// ------------------------------------------------------------ name tables and resolution

/// The set of file paths of a vault and the lookups over it; also built for a *hypothetical*
/// set (after a rename) to work out how links would read then.
#[derive(Clone, Debug, Default)]
pub struct Names {
    pub rels: Vec<String>,
    lc: HashMap<String, usize>,
    by_name: HashMap<String, Vec<usize>>,
}

impl Names {
    pub fn new(rels: Vec<String>) -> Names {
        let mut n = Names { rels, lc: HashMap::new(), by_name: HashMap::new() };
        for (i, r) in n.rels.iter().enumerate() {
            n.lc.insert(r.to_lowercase(), i);
            n.by_name.entry(stem_of(r).to_lowercase()).or_default().push(i);
        }
        n
    }
    pub fn exact(&self, rel: &str) -> Option<&str> {
        self.lc.get(&rel.to_lowercase()).map(|&i| self.rels[i].as_str())
    }

    fn pick(&self, cands: &[usize], from: &str) -> Option<String> {
        let fd = dir_of(from).to_lowercase();
        cands
            .iter()
            .map(|&i| &self.rels[i])
            .min_by_key(|r| {
                let d = dir_of(r).to_lowercase();
                let common = common_prefix_len(&d, &fd);
                // same folder first, then the closest folder, then the shortest path
                (if d == fd { 0 } else { 1 }, std::cmp::Reverse(common), r.matches('/').count(), r.to_lowercase())
            })
            .cloned()
    }

    /// Resolve the path part of a link written in note `from`, the way Obsidian does: a full
    /// path from the vault root, else the shortest matching path ending with what was typed.
    pub fn resolve(&self, target: &str, from: &str) -> Option<String> {
        let t = target.trim().trim_start_matches('/').replace('\\', "/");
        if t.is_empty() {
            return Some(from.to_string());
        }
        let l = t.to_lowercase();
        // full path from the root, with or without .md
        for c in [l.clone(), format!("{l}.md")] {
            if let Some(&i) = self.lc.get(&c) {
                return Some(self.rels[i].clone());
            }
        }
        let mut cands: Vec<usize> = Vec::new();
        let last = l.rsplit('/').next().unwrap_or(&l).to_string();
        let keys = [last.clone(), last.strip_suffix(".md").map(|s| s.to_string()).unwrap_or_default()];
        for k in keys.iter().filter(|k| !k.is_empty()) {
            if let Some(v) = self.by_name.get(k) {
                cands.extend(v.iter().copied());
            }
        }
        // non-note files are keyed by their full name
        if let Some(v) = self.by_name.get(&last) { let _ = v; }
        cands.sort();
        cands.dedup();
        let has_dir = l.contains('/');
        let want_md = format!("/{l}.md");
        let want_plain = format!("/{l}");
        let cands: Vec<usize> = cands
            .into_iter()
            .filter(|&i| {
                if !has_dir {
                    // typed with an extension: it must be that file's own name
                    let r = self.rels[i].to_lowercase();
                    let name = r.rsplit('/').next().unwrap_or(&r).to_string();
                    return name == l || name == format!("{l}.md");
                }
                let r = format!("/{}", self.rels[i].to_lowercase());
                r.ends_with(&want_md) || r.ends_with(&want_plain)
            })
            .collect();
        self.pick(&cands, from)
    }

    /// Obsidian resolves `[x](path)` against the note's folder first, then the vault root.
    pub fn resolve_md(&self, url: &str, from: &str) -> Option<String> {
        let u = url.trim().replace('\\', "/");
        if u.is_empty() {
            return Some(from.to_string());
        }
        let joined = join_rel(dir_of(from), &u);
        if let Some(j) = &joined {
            if let Some(r) = self.exact(j).or_else(|| self.exact(&format!("{j}.md"))) {
                return Some(r.to_string());
            }
        }
        self.resolve(&u, from)
    }

    pub fn resolve_link(&self, l: &Link, from: &str) -> Option<String> {
        if l.md { self.resolve_md(&l.target, from) } else { self.resolve(&l.target, from) }
    }

    /// The shortest text that finds `rel` among all files: `Note`, or `folder/Note` when two
    /// notes share a name. Other files keep their extension.
    pub fn link_text(&self, rel: &str) -> String {
        let md = is_md(rel);
        let parts: Vec<&str> = rel.split('/').collect();
        let strip = |s: &str| if md && is_md(s) { s[..s.len() - 3].to_string() } else { s.to_string() };
        let same_name: Vec<&String> = self.rels.iter().filter(|r| r.to_lowercase().rsplit('/').next() == rel.to_lowercase().rsplit('/').next()).collect();
        if same_name.len() <= 1 {
            return strip(parts[parts.len() - 1]);
        }
        for n in 1..=parts.len() {
            let tail = parts[parts.len() - n..].join("/");
            let tl = format!("/{}", tail.to_lowercase());
            let hits = same_name.iter().filter(|r| format!("/{}", r.to_lowercase()).ends_with(&tl)).count();
            if hits == 1 {
                return strip_last(&tail, md);
            }
        }
        strip_last(rel, md)
    }
}

fn strip_last(p: &str, md: bool) -> String {
    if md && is_md(p) { p[..p.len() - 3].to_string() } else { p.to_string() }
}
fn common_prefix_len(a: &str, b: &str) -> usize {
    let (sa, sb): (Vec<&str>, Vec<&str>) = (a.split('/').collect(), b.split('/').collect());
    sa.iter().zip(sb.iter()).take_while(|(x, y)| x == y).count()
}

/// `dir` + relative `url` (with `./` and `../`), as a vault path; None if it climbs out.
pub fn join_rel(dir: &str, url: &str) -> Option<String> {
    let mut parts: Vec<&str> = if url.starts_with('/') || dir.is_empty() { vec![] } else { dir.split('/').collect() };
    for seg in url.trim_start_matches('/').split('/') {
        match seg {
            "" | "." => {}
            ".." => { parts.pop()?; }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}
/// Path of `to` seen from the folder `dir` (for relative Markdown links).
pub fn relative_to(dir: &str, to: &str) -> String {
    let a: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    let b: Vec<&str> = to.split('/').collect();
    let mut i = 0;
    while i < a.len() && i + 1 < b.len() && a[i].eq_ignore_ascii_case(b[i]) { i += 1; }
    let mut out: Vec<String> = vec!["..".into(); a.len() - i];
    out.extend(b[i..].iter().map(|s| s.to_string()));
    out.join("/")
}

// ------------------------------------------------------------ the index

pub struct Index {
    pub root: PathBuf,
    pub files: BTreeMap<String, FileEntry>,
    pub names: Names,
    /// target rel → [(source rel, index into the source's links)]
    pub back: HashMap<String, Vec<(String, usize)>>,
    pub last_sync: Option<Instant>,
    pub version: u64,
}

fn mtime_ms(md: &std::fs::Metadata) -> u64 {
    md.modified().ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn skip_dir(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules"
}

fn walk(root: &Path, dir: &Path, rel: &str, out: &mut Vec<(String, u64, u64)>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if out.len() >= MAX_FILES {
            return;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let Ok(ft) = e.file_type() else { continue };
        let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        if ft.is_dir() {
            if !skip_dir(&name) {
                walk(root, &e.path(), &child, out);
            }
        } else if ft.is_file() && !name.starts_with('.') && !name.starts_with("~$") && !name.ends_with(".callio-tmp") {
            if let Ok(md) = e.metadata() {
                out.push((child, md.len(), mtime_ms(&md)));
            }
        }
    }
}

pub fn parse_note(text: &str) -> NoteInfo {
    let p = text::parse(text);
    NoteInfo { aliases: p.aliases, fm_tags: p.fm_tags, tags: p.tags, headings: p.headings, blocks: p.blocks, links: p.links }
}

impl Index {
    pub fn new(root: &str) -> Index {
        Index { root: PathBuf::from(root), files: BTreeMap::new(), names: Names::default(), back: HashMap::new(), last_sync: None, version: 0 }
    }

    /// Bring the index up to date with the disk; only files whose size or time changed are read.
    /// Returns true when anything changed.
    pub fn sync(&mut self) -> bool {
        let mut found = Vec::new();
        walk(&self.root, &self.root.clone(), "", &mut found);
        let mut changed = false;
        let seen: HashSet<&String> = found.iter().map(|f| &f.0).collect();
        let gone: Vec<String> = self.files.keys().filter(|k| !seen.contains(k)).cloned().collect();
        for g in gone {
            self.files.remove(&g);
            changed = true;
        }
        for (rel, size, mtime) in found {
            let same = self.files.get(&rel).map(|f| f.size == size && f.mtime == mtime).unwrap_or(false);
            if same {
                continue;
            }
            let note = if is_md(&rel) && size <= MAX_NOTE_BYTES {
                std::fs::read(self.root.join(&rel)).ok().map(|b| parse_note(&String::from_utf8_lossy(&b)))
            } else {
                None
            };
            let note = if is_md(&rel) { Some(note.unwrap_or_default()) } else { None };
            self.files.insert(rel.clone(), FileEntry { size, mtime, note });
            changed = true;
        }
        self.last_sync = Some(Instant::now());
        if changed || self.names.rels.len() != self.files.len() {
            self.rebuild();
        }
        changed
    }

    /// Update one note from text the app already has (a save), without touching the disk.
    pub fn touch(&mut self, rel: &str, text: &str) {
        let (size, mtime) = std::fs::metadata(self.root.join(rel)).map(|m| (m.len(), mtime_ms(&m))).unwrap_or((text.len() as u64, 0));
        let new_file = !self.files.contains_key(rel);
        let note = if is_md(rel) { Some(parse_note(text)) } else { None };
        self.files.insert(rel.to_string(), FileEntry { size, mtime, note });
        if new_file { self.rebuild(); } else { self.rebuild_links(); }
    }

    fn rebuild(&mut self) {
        self.names = Names::new(self.files.keys().cloned().collect());
        self.rebuild_links();
    }
    fn rebuild_links(&mut self) {
        let mut back: HashMap<String, Vec<(String, usize)>> = HashMap::new();
        for (rel, f) in &self.files {
            if let Some(n) = &f.note {
                for (i, l) in n.links.iter().enumerate() {
                    if let Some(t) = self.names.resolve_link(l, rel) {
                        if &t != rel || !l.target.is_empty() {
                            back.entry(t).or_default().push((rel.clone(), i));
                        }
                    }
                }
            }
        }
        self.back = back;
        self.version += 1;
    }

    pub fn note(&self, rel: &str) -> Option<&NoteInfo> {
        self.files.get(rel).and_then(|f| f.note.as_ref())
    }

    /// All tags of a note: frontmatter and inline, without `#`.
    pub fn tags_of(n: &NoteInfo) -> Vec<String> {
        let mut v: Vec<String> = n.fm_tags.clone();
        v.extend(n.tags.iter().map(|t| t.0.clone()));
        v.sort();
        v.dedup();
        v
    }

    /// Tag → number of notes (a nested tag `a/b` also counts for `a`).
    pub fn tag_counts(&self, only: Option<&dyn Fn(&str) -> bool>) -> BTreeMap<String, usize> {
        let mut out: BTreeMap<String, usize> = BTreeMap::new();
        for (rel, f) in &self.files {
            if let Some(n) = &f.note {
                if let Some(ok) = only { if !ok(rel) { continue; } }
                let mut set: HashSet<String> = HashSet::new();
                for t in Self::tags_of(n) {
                    let mut acc = String::new();
                    for part in t.split('/') {
                        if !acc.is_empty() { acc.push('/'); }
                        acc.push_str(part);
                        set.insert(acc.clone());
                    }
                }
                for t in set { *out.entry(t).or_default() += 1; }
            }
        }
        out
    }

    pub fn notes_with_tag(&self, tag: &str) -> Vec<String> {
        let t = tag.trim_start_matches('#').to_lowercase();
        let mut out = vec![];
        for (rel, f) in &self.files {
            if let Some(n) = &f.note {
                if Self::tags_of(n).iter().any(|x| { let x = x.to_lowercase(); x == t || x.starts_with(&format!("{t}/")) }) {
                    out.push(rel.clone());
                }
            }
        }
        out
    }

    /// Resolve a link as written in note `from`: file, plus whether the heading / block exists.
    pub fn resolve(&self, target: &str, sub: &str, from: &str, md: bool) -> Resolved {
        let l = Link { target: target.to_string(), sub: sub.to_string(), md, ..Default::default() };
        let rel = self.names.resolve_link(&l, from);
        let mut r = Resolved { rel: rel.clone(), sub_ok: true, link_text: String::new() };
        if let Some(rel) = &rel {
            r.link_text = self.names.link_text(rel);
            if !sub.is_empty() {
                r.sub_ok = match self.note(rel) {
                    Some(n) => {
                        if let Some(b) = sub.strip_prefix('^') {
                            n.blocks.iter().any(|x| x.id.eq_ignore_ascii_case(b))
                        } else {
                            let last = sub.rsplit('#').next().unwrap_or(sub);
                            n.headings.iter().any(|h| text::same_heading(&h.text, last))
                        }
                    }
                    None => true,
                };
            }
        }
        r
    }

    /// Notes that link to `rel`.
    pub fn backlinks(&self, rel: &str) -> Vec<(String, Vec<Link>)> {
        let mut by: BTreeMap<String, Vec<Link>> = BTreeMap::new();
        if let Some(v) = self.back.get(rel) {
            for (src, i) in v {
                if src == rel { continue; }
                if let Some(l) = self.note(src).and_then(|n| n.links.get(*i)) {
                    by.entry(src.clone()).or_default().push(l.clone());
                }
            }
        }
        by.into_iter().collect()
    }

    /// Outgoing links of a note, resolved (None: the note doesn't exist yet).
    pub fn outgoing(&self, rel: &str) -> Vec<(Link, Option<String>)> {
        match self.note(rel) {
            Some(n) => n.links.iter().map(|l| (l.clone(), self.names.resolve_link(l, rel))).collect(),
            None => vec![],
        }
    }

    /// Mentions of the note's name (or an alias) in other notes that are not links yet.
    pub fn unlinked(&self, rel: &str, limit_notes: usize) -> Vec<(String, Vec<(usize, String)>)> {
        let mut words: Vec<String> = vec![stem_of(rel)];
        if let Some(n) = self.note(rel) { words.extend(n.aliases.iter().cloned()); }
        words.retain(|w| w.chars().count() >= 3);
        let words_lc: Vec<String> = words.iter().map(|w| w.to_lowercase()).collect();
        let linked: HashSet<String> = self.back.get(rel).map(|v| v.iter().map(|x| x.0.clone()).collect()).unwrap_or_default();
        let mut out = vec![];
        for (src, f) in &self.files {
            if out.len() >= limit_notes { break; }
            if f.note.is_none() || src == rel { continue; }
            let Ok(txt) = std::fs::read_to_string(self.root.join(src)) else { continue };
            let lc = txt.to_lowercase();
            if !words_lc.iter().any(|w| lc.contains(w.as_str())) { continue; }
            let p = text::parse(&txt);
            let spans: Vec<(usize, usize)> = p.links.iter().map(|l| (l.from, l.to)).collect();
            let body_from = text::fm_range(&txt).map(|r| r.2).unwrap_or(0);
            let mut hits = vec![];
            for (ln, (off, line)) in text::lines_of(&txt).into_iter().enumerate() {
                if off < body_from || line.trim().is_empty() { continue; }
                let ll = line.to_lowercase();
                for w in &words_lc {
                    let mut at = 0;
                    while let Some(i) = ll[at..].find(w.as_str()) {
                        let s = at + i;
                        let e = s + w.len();
                        let before = ll[..s].chars().next_back();
                        let after = ll[e..].chars().next();
                        let word_ok = !before.map(|c| c.is_alphanumeric()).unwrap_or(false) && !after.map(|c| c.is_alphanumeric()).unwrap_or(false);
                        let inside = spans.iter().any(|&(a, b)| off + s >= a && off + e <= b);
                        // byte offsets in the lowercase copy match the original for the usual scripts
                        if word_ok && !inside && line.is_char_boundary(s) {
                            hits.push((ln, line.trim().chars().take(240).collect::<String>()));
                            break;
                        }
                        at = e;
                    }
                }
                if hits.len() >= 5 { break; }
            }
            // a note that already links here is shown under "linked", not here
            if !hits.is_empty() && !linked.contains(src) { out.push((src.clone(), hits)); }
        }
        out
    }
}

pub struct Resolved {
    pub rel: Option<String>,
    pub sub_ok: bool,
    pub link_text: String,
}

// ------------------------------------------------------------ rename: which links change

#[derive(Clone, Debug)]
pub struct Edit {
    pub from: usize,
    pub to: usize,
    pub old: String,
    pub new: String,
    pub line: usize,
}
#[derive(Clone, Debug)]
pub struct FileEdits {
    /// the note's path before the rename
    pub rel: String,
    pub edits: Vec<Edit>,
}

/// Old path → new path for a rename or move of file or folder `from` to `to`.
fn mover(files: &[String], from: &str, to: &str) -> impl Fn(&str) -> String {
    let fl = from.to_lowercase();
    let _ = files;
    let (from, to) = (from.to_string(), to.to_string());
    move |r: &str| {
        if r.to_lowercase() == fl { to.clone() } else if r.to_lowercase().starts_with(&format!("{fl}/")) { format!("{to}{}", &r[from.len()..]) } else { r.to_string() }
    }
}

impl Index {
    /// The link edits needed in other notes (and in the moved notes themselves) when `from` is
    /// renamed or moved to `to` (vault paths; works for a folder too).
    pub fn rename_plan(&self, from: &str, to: &str) -> Vec<FileEdits> {
        let old = &self.names;
        let mv = mover(&old.rels, from, to);
        let new = Names::new(old.rels.iter().map(|r| mv(r)).collect());
        let mut out = vec![];
        for (rel, f) in &self.files {
            let Some(n) = &f.note else { continue };
            let new_rel = mv(rel);
            let Ok(txt) = std::fs::read_to_string(self.root.join(rel)) else { continue };
            let mut edits = vec![];
            for l in &n.links {
                if l.target.is_empty() && !l.md { continue; }
                let Some(t_old) = old.resolve_link(l, rel) else { continue };
                let t_new = mv(&t_old);
                let src_moved = new_rel != *rel;
                if t_new == t_old && !src_moved { continue; }
                // it still resolves to the same file with the same words: leave it alone
                let still = if l.md { new.resolve_md(&l.target, &new_rel) } else { new.resolve(&l.target, &new_rel) };
                if still.as_deref() == Some(t_new.as_str()) && !(l.md && (t_new != t_old || src_moved) && md_path_changed(l, rel, &new_rel, &t_old, &t_new)) {
                    continue;
                }
                let Some(repl) = rewrite(l, rel, &new_rel, &t_old, &t_new, &new) else { continue };
                if repl == txt[l.from..l.to] { continue; }
                edits.push(Edit { from: l.from, to: l.to, old: txt[l.from..l.to].to_string(), new: repl, line: l.line });
            }
            if !edits.is_empty() {
                out.push(FileEdits { rel: rel.clone(), edits });
            }
        }
        out
    }
}

fn md_path_changed(l: &Link, from_old: &str, from_new: &str, t_old: &str, t_new: &str) -> bool {
    let _ = (l, from_old, from_new);
    t_old != t_new || dir_of(from_old) != dir_of(from_new)
}

/// The new source text of link `l` after its target moved from `t_old` to `t_new`.
fn rewrite(l: &Link, from_old: &str, from_new: &str, t_old: &str, t_new: &str, new: &Names) -> Option<String> {
    let sub = if l.sub.is_empty() { String::new() } else { format!("#{}", l.sub) };
    if l.md {
        // keep the style: relative to the note's folder, or from the vault root
        let rel_style = !dir_of(from_old).is_empty()
            && join_rel(dir_of(from_old), &l.target).map(|j| j.eq_ignore_ascii_case(t_old) || format!("{j}.md").eq_ignore_ascii_case(t_old)).unwrap_or(false);
        let keep_ext = l.target.to_lowercase().ends_with(".md") || !is_md(t_new);
        let mut p = if rel_style { relative_to(dir_of(from_new), t_new) } else { t_new.to_string() };
        if !keep_ext { p = strip_last(&p, true); }
        let shown = if l.angle { p } else { text::percent_encode_path(&p) };
        let (o, c) = if l.angle { ("<", ">") } else { ("", "") };
        return Some(format!("{}[{}]({}{}{}{})", if l.embed { "!" } else { "" }, l.alias, o, shown, sub_enc(&sub, l.angle), c));
    }
    let mut txt = new.link_text(t_new);
    // a link that spelled out `.md` keeps it
    if l.target.to_lowercase().ends_with(".md") && is_md(t_new) { txt.push_str(".md"); }
    let alias = if l.alias.is_empty() { String::new() } else { format!("|{}", l.alias) };
    Some(format!("{}[[{}{}{}]]", if l.embed { "!" } else { "" }, txt, sub, alias))
}
fn sub_enc(sub: &str, angle: bool) -> String {
    if angle { sub.to_string() } else { sub.replace(' ', "%20") }
}

/// Apply edits (byte ranges, from the plan) to `text`, last first. Fails if a range no longer
/// holds what the plan saw (the note changed in between).
pub fn apply_edits(text: &str, edits: &[Edit]) -> Result<String, String> {
    let mut v: Vec<&Edit> = edits.iter().collect();
    v.sort_by_key(|e| std::cmp::Reverse(e.from));
    let mut out = text.to_string();
    for e in v {
        if e.to > out.len() || !out.is_char_boundary(e.from) || !out.is_char_boundary(e.to) || out[e.from..e.to] != e.old {
            return Err("CHANGED".into());
        }
        out.replace_range(e.from..e.to, &e.new);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(v: &[&str]) -> Names {
        Names::new(v.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn resolves_by_name_and_path() {
        let n = names(&["Home.md", "Notes/Alpha.md", "Notes/Beta.md", "Archive/Alpha.md", "img/pic.png", "docs/a.pdf"]);
        assert_eq!(n.resolve("Home", "x.md").unwrap(), "Home.md");
        assert_eq!(n.resolve("home", "x.md").unwrap(), "Home.md");
        assert_eq!(n.resolve("Notes/Beta", "x.md").unwrap(), "Notes/Beta.md");
        assert_eq!(n.resolve("Beta.md", "x.md").unwrap(), "Notes/Beta.md");
        assert_eq!(n.resolve("pic.png", "x.md").unwrap(), "img/pic.png");
        assert_eq!(n.resolve("img/pic.png", "x.md").unwrap(), "img/pic.png");
        assert_eq!(n.resolve("a.pdf", "x.md").unwrap(), "docs/a.pdf");
        assert_eq!(n.resolve("Missing", "x.md"), None);
        assert_eq!(n.resolve("", "Home.md").unwrap(), "Home.md");
    }
    #[test]
    fn ambiguous_names_prefer_the_same_folder_then_the_closest() {
        let n = names(&["Notes/Alpha.md", "Archive/Alpha.md", "Archive/Old/Alpha.md"]);
        assert_eq!(n.resolve("Alpha", "Archive/x.md").unwrap(), "Archive/Alpha.md");
        assert_eq!(n.resolve("Alpha", "Notes/x.md").unwrap(), "Notes/Alpha.md");
        assert_eq!(n.resolve("Alpha", "Archive/Old/x.md").unwrap(), "Archive/Old/Alpha.md");
        assert_eq!(n.resolve("Old/Alpha", "Notes/x.md").unwrap(), "Archive/Old/Alpha.md");
    }
    #[test]
    fn shortest_unique_link_text() {
        let n = names(&["Notes/Alpha.md", "Archive/Alpha.md", "Archive/Old/Alpha.md", "Solo.md", "a/b/Solo2.md", "x/pic.png"]);
        assert_eq!(n.link_text("Solo.md"), "Solo");
        assert_eq!(n.link_text("a/b/Solo2.md"), "Solo2");
        assert_eq!(n.link_text("x/pic.png"), "pic.png");
        assert_eq!(n.link_text("Notes/Alpha.md"), "Notes/Alpha");
        assert_eq!(n.link_text("Archive/Old/Alpha.md"), "Old/Alpha");
        // "Archive/Alpha" is a suffix of nothing else
        assert_eq!(n.link_text("Archive/Alpha.md"), "Archive/Alpha");
    }
    #[test]
    fn markdown_links_resolve_relative_first() {
        let n = names(&["a/x.md", "a/y.md", "b/y.md", "Top.md"]);
        assert_eq!(n.resolve_md("y.md", "a/x.md").unwrap(), "a/y.md");
        assert_eq!(n.resolve_md("../b/y.md", "a/x.md").unwrap(), "b/y.md");
        assert_eq!(n.resolve_md("Top.md", "a/x.md").unwrap(), "Top.md");
        assert_eq!(n.resolve_md("b/y", "a/x.md").unwrap(), "b/y.md");
    }
    #[test]
    fn join_and_relative_paths() {
        assert_eq!(join_rel("a/b", "../c.md").unwrap(), "a/c.md");
        assert_eq!(join_rel("", "./c.md").unwrap(), "c.md");
        assert!(join_rel("", "../c.md").is_none());
        assert_eq!(relative_to("a/b", "a/c/d.md"), "../c/d.md");
        assert_eq!(relative_to("a", "a/d.md"), "d.md");
        assert_eq!(relative_to("", "d.md"), "d.md");
    }

    fn index_of(files: &[(&str, &str)]) -> (Index, PathBuf) {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("callio-vault-test-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&dir);
        for (r, t) in files {
            let p = dir.join(r);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, t).unwrap();
        }
        let mut ix = Index::new(dir.to_str().unwrap());
        ix.sync();
        (ix, dir)
    }

    #[test]
    fn index_backlinks_tags_and_resolution() {
        let (ix, dir) = index_of(&[
            ("A.md", "---\naliases: [Alef]\ntags: [top]\n---\n# H\nbody ^b1\n#inline/deep\n"),
            ("B.md", "link [[A#H]] and [[A#^b1]] and [[Nope]]\n"),
            ("sub/C.md", "[c](../A.md) and [[Alef]]\n"),
        ]);
        let bl = ix.backlinks("A.md");
        assert_eq!(bl.iter().map(|b| b.0.as_str()).collect::<Vec<_>>(), vec!["B.md", "sub/C.md"]);
        assert_eq!(bl[0].1.len(), 2);
        assert!(ix.resolve("A", "H", "B.md", false).sub_ok);
        assert!(ix.resolve("A", "^b1", "B.md", false).sub_ok);
        assert!(!ix.resolve("A", "Missing", "B.md", false).sub_ok);
        assert!(ix.resolve("Nope", "", "B.md", false).rel.is_none());
        let tc = ix.tag_counts(None);
        assert_eq!(tc.get("inline"), Some(&1));
        assert_eq!(tc.get("inline/deep"), Some(&1));
        assert_eq!(tc.get("top"), Some(&1));
        assert_eq!(ix.notes_with_tag("inline"), vec!["A.md"]);
        assert_eq!(ix.note("A.md").unwrap().aliases, vec!["Alef"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unlinked_mentions_skip_existing_links() {
        let (ix, dir) = index_of(&[
            ("Topic.md", "# Topic\n"),
            ("X.md", "I read about topic yesterday.\nAlready [[Topic]] here.\n"),
            ("Y.md", "[[Topic]] only\n"),
        ]);
        let u = ix.unlinked("Topic.md", 20);
        assert_eq!(u.len(), 0, "X.md already links, Y.md only links");
        let (ix, dir2) = index_of(&[("Topic.md", "# Topic\n"), ("Z.md", "A topic is mentioned here.\n"), ("W.md", "plain Topic mention\n")]);
        let u = ix.unlinked("Topic.md", 20);
        assert_eq!(u.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), vec!["W.md", "Z.md"]);
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(dir2);
    }

    #[test]
    fn rename_rewrites_links_and_keeps_aliases_and_sections() {
        let (ix, dir) = index_of(&[
            ("Old name.md", "# H\n"),
            ("B.md", "[[Old name]] [[Old name#H|shown]] ![[Old name]] [[Old name.md]] [md](Old%20name.md)\n"),
            ("C.md", "[[Other]] [[Old name#^blk]]\n"),
            ("Other.md", "x\n"),
        ]);
        let plan = ix.rename_plan("Old name.md", "New.md");
        assert_eq!(plan.len(), 2);
        let b = &plan.iter().find(|p| p.rel == "B.md").unwrap().edits;
        let txt = std::fs::read_to_string(dir.join("B.md")).unwrap();
        let out = apply_edits(&txt, b).unwrap();
        assert_eq!(out, "[[New]] [[New#H|shown]] ![[New]] [[New.md]] [md](New.md)\n");
        let c = &plan.iter().find(|p| p.rel == "C.md").unwrap().edits;
        assert_eq!(apply_edits(&std::fs::read_to_string(dir.join("C.md")).unwrap(), c).unwrap(), "[[Other]] [[New#^blk]]\n");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn moving_a_note_between_folders_keeps_name_only_links_but_fixes_paths() {
        let (ix, dir) = index_of(&[
            ("Alpha.md", "x\n"),
            ("B.md", "[[Alpha]] [m](Alpha.md)\n"),
            ("sub/C.md", "[[Alpha]] [rel](../Alpha.md)\n"),
        ]);
        let plan = ix.rename_plan("Alpha.md", "deep/er/Alpha.md");
        // [[Alpha]] still finds it by name: only the Markdown links change
        let b = &plan.iter().find(|p| p.rel == "B.md").unwrap().edits;
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].new, "[m](deep/er/Alpha.md)");
        let c = &plan.iter().find(|p| p.rel == "sub/C.md").unwrap().edits;
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].new, "[rel](../deep/er/Alpha.md)");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn moving_creates_a_clash_so_links_get_a_folder() {
        let (ix, dir) = index_of(&[("Alpha.md", "x\n"), ("other/Alpha2.md", "y\n"), ("B.md", "[[Alpha2]] [[Alpha]]\n")]);
        // renaming Alpha → Alpha2 in the root: now two notes are named Alpha2
        let plan = ix.rename_plan("Alpha.md", "Alpha2.md");
        let b = &plan.iter().find(|p| p.rel == "B.md").unwrap().edits;
        let out = apply_edits(&std::fs::read_to_string(dir.join("B.md")).unwrap(), b).unwrap();
        assert!(out.contains("[[Alpha2]]") && out.contains("[[Alpha2]]"), "{out}");
        assert_eq!(out.matches("[[Alpha2]]").count(), 2, "{out}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn renaming_a_folder_updates_path_links() {
        let (ix, dir) = index_of(&[("proj/a.md", "x\n"), ("proj/b.md", "[[proj/a]]\n"), ("T.md", "[[proj/b]] [[a]]\n")]);
        let plan = ix.rename_plan("proj", "work");
        let t = &plan.iter().find(|p| p.rel == "T.md").unwrap().edits;
        let out = apply_edits(&std::fs::read_to_string(dir.join("T.md")).unwrap(), t).unwrap();
        assert_eq!(out, "[[work/b]] [[a]]\n".replace("[[work/b]]", "[[b]]"), "{out}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn apply_refuses_a_changed_note() {
        let e = Edit { from: 0, to: 5, old: "[[A]]".into(), new: "[[B]]".into(), line: 0 };
        assert!(apply_edits("[[A]] x", &[e.clone()]).is_ok());
        assert_eq!(apply_edits("[[Z]] x", &[e]), Err("CHANGED".into()));
    }
}
