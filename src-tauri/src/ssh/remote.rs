//! Everything the sync engine and the tools do on a server, in one place: listing, hashing,
//! atomic upload / download with resume, moving to the server's trash. Uses `exec` when the
//! server has the usual tools (fast, one round-trip) and SFTP otherwise.
use super::config::{sh_path, sh_quote};
use super::conn::Session;
use super::rules::Rules;
use russh_sftp::client::fs::Metadata;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

const CHUNK: usize = 192 * 1024;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Caps {
    pub find: bool,
    pub xargs: bool,
    pub sha: String,
    pub rsync: bool,
    pub mv: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RFile {
    pub size: u64,
    pub mtime: i64,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct DirItem {
    pub name: String,
    pub dir: bool,
    pub size: u64,
    pub mtime: i64,
}

pub fn join(root: &str, rel: &str) -> String {
    if rel.is_empty() { root.to_string() } else { format!("{}/{}", root.trim_end_matches('/'), rel) }
}
pub fn parent(p: &str) -> &str {
    match p.rfind('/') {
        Some(0) => "/",
        Some(i) => &p[..i],
        None => "",
    }
}
fn s(x: impl AsRef<[u8]>) -> String {
    String::from_utf8_lossy(x.as_ref()).to_string()
}

#[derive(Clone)]
pub struct Remote {
    pub sess: Arc<Session>,
    pub root: String,
    pub caps: Caps,
}

impl Remote {
    /// Without looking for tools on the server (cheap; for browsing and one-off reads).
    pub fn bare(sess: Arc<Session>, root: &str) -> Remote {
        Remote { sess, root: root.trim_end_matches('/').to_string(), caps: Caps::default() }
    }
    pub async fn new(sess: Arc<Session>, root: &str) -> Remote {
        let caps = detect_caps(&sess).await;
        Remote { sess, root: root.trim_end_matches('/').to_string(), caps }
    }

    pub async fn sftp(&self) -> Result<Arc<SftpSession>, String> {
        self.sess.sftp().await
    }

    pub async fn stat(&self, rel: &str) -> Option<RFile> {
        let sf = self.sftp().await.ok()?;
        let m = sf.metadata(join(&self.root, rel)).await.ok()?;
        if m.is_dir() {
            return None;
        }
        Some(RFile { size: m.size.unwrap_or(0), mtime: m.mtime.unwrap_or(0) as i64 })
    }

    pub async fn is_dir(&self, path: &str) -> bool {
        match self.sftp().await {
            Ok(sf) => sf.metadata(path.to_string()).await.map(|m| m.is_dir()).unwrap_or(false),
            Err(_) => false,
        }
    }

    pub async fn mkdir_p(&self, dir: &str) -> Result<(), String> {
        let sf = self.sftp().await?;
        if sf.metadata(dir.to_string()).await.map(|m| m.is_dir()).unwrap_or(false) {
            return Ok(());
        }
        let mut cur = String::new();
        for part in dir.split('/') {
            if part.is_empty() && cur.is_empty() {
                cur.push('/');
                continue;
            }
            if part.is_empty() {
                continue;
            }
            if !cur.ends_with('/') && !cur.is_empty() {
                cur.push('/');
            }
            cur.push_str(part);
            if sf.metadata(cur.clone()).await.is_err() {
                let _ = sf.create_dir(cur.clone()).await;
            }
        }
        if sf.metadata(dir.to_string()).await.map(|m| m.is_dir()).unwrap_or(false) { Ok(()) } else { Err(format!("Could not create the folder {dir} on the server.")) }
    }

    /// Every regular file under the root (excluded ones left out), relative paths with `/`.
    pub async fn scan(&self, rules: &Rules) -> Result<HashMap<String, RFile>, String> {
        if self.caps.find {
            match self.scan_find(rules).await {
                Ok(m) => return Ok(m),
                Err(e) if e == "nofind" => {}
                Err(e) => return Err(e),
            }
        }
        self.scan_sftp(rules).await
    }

    async fn scan_find(&self, rules: &Rules) -> Result<HashMap<String, RFile>, String> {
        let prune: Vec<String> = rules.prune_names().into_iter().chain([".callio-trash".to_string()]).collect();
        let mut cmd = format!("cd {} && find . ", sh_path(&self.root));
        if !prune.is_empty() {
            cmd.push_str("\\( ");
            cmd.push_str(&prune.iter().map(|n| format!("-name {}", sh_quote(n))).collect::<Vec<_>>().join(" -o "));
            cmd.push_str(" \\) -prune -o ");
        }
        cmd.push_str("-type f -printf '%P\\0%s\\0%T@\\0'");
        let o = self.sess.exec(&cmd, None, Duration::from_secs(120)).await?;
        if o.code != Some(0) && o.out.is_empty() {
            let e = o.err_text();
            if e.contains("No such file") {
                return Err(format!("The folder {} does not exist on the server.", self.root));
            }
            if e.contains("illegal option") || e.contains("unknown predicate") || e.contains("printf") {
                return Err("nofind".into());
            }
            if e.contains("ermission denied") {
                return Err(format!("No permission to read {} on the server.", self.root));
            }
            return Err("nofind".into());
        }
        let mut out = HashMap::new();
        let mut it = o.out.split(|b| *b == 0);
        loop {
            let (Some(p), Some(sz), Some(t)) = (it.next(), it.next(), it.next()) else { break };
            if p.is_empty() {
                continue;
            }
            let rel = s(p);
            if rules.excluded(&rel, false) {
                continue;
            }
            let size = s(sz).parse().unwrap_or(0);
            let mtime = s(t).split('.').next().and_then(|x| x.parse().ok()).unwrap_or(0);
            out.insert(rel, RFile { size, mtime });
        }
        Ok(out)
    }

    async fn scan_sftp(&self, rules: &Rules) -> Result<HashMap<String, RFile>, String> {
        let sf = self.sftp().await?;
        if !self.is_dir(&self.root).await {
            return Err(format!("The folder {} does not exist on the server.", self.root));
        }
        let mut out = HashMap::new();
        let mut stack = vec![String::new()];
        while let Some(rel) = stack.pop() {
            let dir = join(&self.root, &rel);
            let rd = sf.read_dir(dir.clone()).await.map_err(|e| format!("Could not list {dir}: {e}"))?;
            for e in rd {
                let name = s(e.file_name().as_bytes());
                let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
                let m = e.metadata();
                if m.is_dir() {
                    if !rules.excluded(&r, true) {
                        stack.push(r);
                    }
                } else if m.is_regular() && !rules.excluded(&r, false) {
                    out.insert(r, RFile { size: m.size.unwrap_or(0), mtime: m.mtime.unwrap_or(0) as i64 });
                }
            }
        }
        Ok(out)
    }

    /// One level of a folder (the folder browser and the AI tools).
    pub async fn list(&self, path: &str) -> Result<Vec<DirItem>, String> {
        let sf = self.sftp().await?;
        let rd = sf.read_dir(path.to_string()).await.map_err(|e| format!("Could not list {path}: {e}"))?;
        let mut v: Vec<DirItem> = rd.map(|e| {
            let m = e.metadata();
            DirItem { name: s(e.file_name().as_bytes()), dir: m.is_dir(), size: m.size.unwrap_or(0), mtime: m.mtime.unwrap_or(0) as i64 }
        }).collect();
        v.sort_by(|a, b| b.dir.cmp(&a.dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(v)
    }

    pub async fn home(&self) -> String {
        match self.sftp().await {
            Ok(sf) => sf.canonicalize(".").await.map(|p| s(p.as_bytes())).unwrap_or_else(|_| "/".into()),
            Err(_) => "/".into(),
        }
    }

    /// SHA-256 of files under the root (relative paths). Missing entries could not be hashed.
    pub async fn hashes(&self, rels: &[String]) -> HashMap<String, String> {
        let mut out = HashMap::new();
        if rels.is_empty() {
            return out;
        }
        if self.caps.xargs && !self.caps.sha.is_empty() {
            for chunk in rels.chunks(400) {
                let mut inp = Vec::new();
                for r in chunk {
                    inp.extend_from_slice(r.as_bytes());
                    inp.push(0);
                }
                let cmd = format!("cd {} && xargs -0 {} --", sh_path(&self.root), self.caps.sha);
                if let Ok(o) = self.sess.exec(&cmd, Some(&inp), Duration::from_secs(300)).await {
                    for line in o.text().lines() {
                        if line.starts_with('\\') || line.len() < 66 {
                            continue;
                        }
                        let (h, f) = line.split_at(64);
                        let f = f.trim_start_matches([' ', '*']);
                        out.insert(f.to_string(), h.to_string());
                    }
                }
            }
        }
        for r in rels {
            if !out.contains_key(r) {
                if let Ok(h) = self.hash_by_reading(&join(&self.root, r)).await {
                    out.insert(r.clone(), h);
                }
            }
        }
        out
    }

    pub async fn hash_path(&self, path: &str) -> Result<String, String> {
        if self.caps.sha.is_empty() {
            return self.hash_by_reading(path).await;
        }
        let o = self.sess.exec(&format!("{} -- {}", self.caps.sha, sh_path(path)), None, Duration::from_secs(600)).await?;
        let t = o.text();
        if o.ok() && t.len() >= 64 && !t.starts_with('\\') {
            Ok(t[..64].to_string())
        } else {
            self.hash_by_reading(path).await
        }
    }

    async fn hash_by_reading(&self, path: &str) -> Result<String, String> {
        let sf = self.sftp().await?;
        let mut f = sf.open(path.to_string()).await.map_err(|e| e.to_string())?;
        let mut h = Sha256::new();
        let mut buf = vec![0u8; CHUNK];
        loop {
            let n = f.read(&mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
        }
        Ok(hex(&h.finalize()))
    }

    pub async fn read(&self, rel: &str, max: u64) -> Result<Vec<u8>, String> {
        let sf = self.sftp().await?;
        let path = join(&self.root, rel);
        let m = sf.metadata(path.clone()).await.map_err(|e| format!("Could not read {path}: {e}"))?;
        if m.size.unwrap_or(0) > max {
            return Err(format!("{path} is larger than {} MB.", max >> 20));
        }
        sf.read(path.clone()).await.map_err(|e| format!("Could not read {path}: {e}"))
    }

    /// Write bytes atomically (temp file + rename) and set the modification time.
    pub async fn write_atomic(&self, rel: &str, data: &[u8], mtime: i64) -> Result<(), String> {
        let sf = self.sftp().await?;
        let path = join(&self.root, rel);
        self.mkdir_p(parent(&path)).await?;
        let tmp = format!("{}/.callio-tmp-{}", parent(&path), rand_hex(6));
        sf.write(tmp.clone(), data).await.map_err(|e| format!("Could not write {path}: {e}"))?;
        self.finish_file(&tmp, &path, mtime).await
    }

    async fn finish_file(&self, tmp: &str, path: &str, mtime: i64) -> Result<(), String> {
        let sf = self.sftp().await?;
        if mtime > 0 {
            let m = Metadata { mtime: Some(mtime as u32), atime: Some(mtime as u32), ..Metadata::empty() };
            let _ = sf.set_metadata(tmp.to_string(), m).await;
        }
        self.replace(tmp, path).await
    }

    /// Move `from` over `to` in one step where the server allows it.
    pub async fn replace(&self, from: &str, to: &str) -> Result<(), String> {
        let sf = self.sftp().await?;
        if let Ok(true) = sf.posix_rename(from.to_string(), to.to_string()).await {
            return Ok(());
        }
        if self.caps.mv {
            let o = self.sess.exec(&format!("mv -f -- {} {}", sh_path(from), sh_path(to)), None, Duration::from_secs(60)).await?;
            if o.ok() {
                return Ok(());
            }
        }
        if sf.rename(from.to_string(), to.to_string()).await.is_ok() {
            return Ok(());
        }
        let _ = sf.remove_file(to.to_string()).await;
        sf.rename(from.to_string(), to.to_string()).await.map_err(|e| format!("Could not replace {to}: {e}"))
    }

    /// Upload a local file. `part` is a stable temp name so an interrupted upload resumes.
    /// The file is checked (size, and SHA-256 when the server can compute it) before it
    /// replaces the target; `expect_hash` is the local file's hash.
    pub async fn upload(&self, local: &Path, rel: &str, mtime: i64, size: u64, expect_hash: &str, prog: &(dyn Fn(u64) + Send + Sync)) -> Result<(), String> {
        let sf = self.sftp().await?;
        let path = join(&self.root, rel);
        self.mkdir_p(parent(&path)).await?;
        let part = format!("{}/.callio-part-{}", parent(&path), &crate::util::sha256_hex(format!("{rel}|{size}|{mtime}").as_bytes())[..12]);
        let have = sf.metadata(part.clone()).await.ok().and_then(|m| m.size).unwrap_or(0);
        let mut start = if have > 0 && have <= size { have } else { 0 };
        let mut src = tokio::fs::File::open(local).await.map_err(|e| format!("Could not read {}: {e}", local.display()))?;
        let mut f = sf.open_with_flags(part.clone(), OpenFlags::WRITE | OpenFlags::CREATE | if start == 0 { OpenFlags::TRUNCATE } else { OpenFlags::empty() }).await.map_err(|e| format!("Could not write {path}: {e}"))?;
        if start > 0 {
            f.seek(std::io::SeekFrom::Start(start)).await.map_err(|e| e.to_string())?;
            src.seek(std::io::SeekFrom::Start(start)).await.map_err(|e| e.to_string())?;
        }
        let mut buf = vec![0u8; CHUNK];
        loop {
            let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            f.write_all(&buf[..n]).await.map_err(|e| format!("Upload of {rel} failed: {e}"))?;
            start += n as u64;
            prog(start);
        }
        f.flush().await.map_err(|e| e.to_string())?;
        f.shutdown().await.ok();
        drop(f);
        let got = sf.metadata(part.clone()).await.ok().and_then(|m| m.size).unwrap_or(0);
        if got != size {
            let _ = sf.remove_file(part.clone()).await;
            return Err(format!("Upload of {rel} was incomplete ({got} of {size} bytes). It will be tried again."));
        }
        if !expect_hash.is_empty() && (self.caps.sha.is_empty() == false || size < (8 << 20)) {
            let h = self.hash_path(&part).await?;
            if h != expect_hash {
                let _ = sf.remove_file(part.clone()).await;
                return Err(format!("Upload of {rel} did not verify (the copy on the server differs). It will be tried again."));
            }
        }
        self.finish_file(&part, &path, mtime).await
    }

    /// Download to `dest` through a temp file next to it; returns the file's SHA-256.
    pub async fn download(&self, rel: &str, dest: &Path, mtime: i64, size: u64, prog: &(dyn Fn(u64) + Send + Sync)) -> Result<(std::path::PathBuf, String), String> {
        let sf = self.sftp().await?;
        let path = join(&self.root, rel);
        let dir = dest.parent().ok_or("bad path")?;
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
        let part = dir.join(format!(".callio-part-{}", &crate::util::sha256_hex(format!("{rel}|{size}|{mtime}").as_bytes())[..12]));
        let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        let mut done = if have > 0 && have <= size { have } else { 0 };
        let mut src = sf.open(path.clone()).await.map_err(|e| format!("Could not read {path}: {e}"))?;
        let mut out = if done > 0 {
            src.seek(std::io::SeekFrom::Start(done)).await.map_err(|e| e.to_string())?;
            tokio::fs::OpenOptions::new().append(true).open(&part).await.map_err(|e| e.to_string())?
        } else {
            tokio::fs::File::create(&part).await.map_err(|e| format!("Could not write {}: {e}", part.display()))?
        };
        let mut buf = vec![0u8; CHUNK];
        loop {
            let n = src.read(&mut buf).await.map_err(|e| format!("Download of {rel} failed: {e}"))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
            done += n as u64;
            prog(done);
        }
        out.flush().await.map_err(|e| e.to_string())?;
        drop(out);
        let p2 = part.clone();
        let hash = tokio::task::spawn_blocking(move || file_hash(&p2)).await.map_err(|e| e.to_string())??;
        let len = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if len != size {
            let _ = std::fs::remove_file(&part);
            return Err(format!("Download of {rel} was incomplete ({len} of {size} bytes). It will be tried again."));
        }
        Ok((part, hash))
    }

    /// Move a file into `<root>/.callio-trash/<stamp>/…` instead of deleting it.
    pub async fn trash(&self, rel: &str, stamp: &str) -> Result<(), String> {
        let sf = self.sftp().await?;
        let from = join(&self.root, rel);
        let to = join(&self.root, &format!(".callio-trash/{stamp}/{rel}"));
        self.mkdir_p(parent(&to)).await?;
        let _ = sf.remove_file(to.clone()).await;
        sf.rename(from.clone(), to).await.map_err(|e| format!("Could not move {from} to the server's trash: {e}"))
    }

    /// Forget trash older than 30 days.
    pub async fn purge_trash(&self) {
        if self.caps.find {
            let t = join(&self.root, ".callio-trash");
            let _ = self.sess.exec(&format!("[ -d {t} ] && find {t} -mindepth 1 -maxdepth 1 -mtime +30 -exec rm -rf {{}} +", t = sh_path(&t)), None, Duration::from_secs(60)).await;
        }
    }
}

pub async fn detect_caps(sess: &Session) -> Caps {
    let o = sess.exec("for c in find xargs sha256sum shasum rsync mv; do command -v $c >/dev/null 2>&1 && echo $c; done", None, Duration::from_secs(20)).await.map(|o| o.text()).unwrap_or_default();
    let has = |n: &str| o.lines().any(|l| l.trim() == n);
    Caps { find: has("find"), xargs: has("xargs"), sha: if has("sha256sum") { "sha256sum".into() } else if has("shasum") { "shasum -a 256".into() } else { String::new() }, rsync: has("rsync"), mv: has("mv") }
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
pub fn rand_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    let _ = getrandom::getrandom(&mut b);
    hex(&b)
}
pub fn file_hash(p: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(p).map_err(|e| format!("Could not read {}: {e}", p.display()))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 17];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}
