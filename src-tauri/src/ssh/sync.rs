//! The sync engine: one task per linked folder. Each round it lists both sides, compares every
//! file with what both sides agreed on last time (the "base": a hash, plus a copy of small text
//! files), and decides with `decide::decide`. Copies go through temp files and are verified;
//! deletions go to the Recycle Bin / the server's `.callio-trash`; a file changed on both sides is
//! merged when that is safe (notebook cells, text lines) and otherwise both versions are kept and
//! the file waits for the author. Nothing is ever overwritten silently.
use super::conn::Hub;
use super::decide::{decide, Action, Direction, Obs, Why};
use super::env::Env;
use super::nbmerge;
use super::remote::{file_hash, rand_hex, RFile, Remote};
use super::rules::Rules;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Notify;

const BASE_MAX: u64 = 2 << 20;

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct LinkCfg {
    pub id: String,
    pub name: String,
    pub host: String,
    pub local: String,
    pub remote: String,
    /// "two-way" | "upload" | "download"
    pub direction: String,
    /// extra `.gitignore`-style lines (the defaults are always on)
    pub exclude: Vec<String>,
    pub size_limit_mb: u64,
    /// big files the author chose to sync anyway (relative paths)
    pub include: Vec<String>,
    pub paused: bool,
    /// "newest" | "local" | "server": which outputs win when a notebook was run on both sides
    pub prefer_outputs: String,
}
impl Default for LinkCfg {
    fn default() -> Self {
        LinkCfg { id: String::new(), name: String::new(), host: String::new(), local: String::new(), remote: String::new(), direction: "two-way".into(), exclude: vec![], size_limit_mb: 10, include: vec![], paused: false, prefer_outputs: "newest".into() }
    }
}
impl LinkCfg {
    fn dir(&self) -> Direction {
        match self.direction.as_str() {
            "upload" => Direction::UploadOnly,
            "download" => Direction::DownloadOnly,
            _ => Direction::TwoWay,
        }
    }
    fn limit(&self) -> u64 {
        if self.size_limit_mb == 0 { u64::MAX } else { self.size_limit_mb << 20 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct Conflict {
    why: String,
    lh: String,
    rh: String,
    /// where the server's version was saved next to the file
    copy: Option<String>,
    at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct Rec {
    hash: String,
    /// local size / mtime (ms)
    ls: u64,
    lm: i64,
    /// remote size / mtime (s)
    rs: u64,
    rm: i64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    conflict: Option<Conflict>,
}

#[derive(Serialize, Deserialize, Default)]
struct StateFile {
    files: BTreeMap<String, Rec>,
    purged: i64,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Transfer {
    pub rel: String,
    pub dir: String,
    pub done: u64,
    pub total: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Status {
    /// idle | scanning | syncing | paused | offline | error
    pub state: String,
    pub up: u32,
    pub down: u32,
    pub tracked: u32,
    pub conflicts: Vec<Value>,
    pub skipped: Vec<Value>,
    pub pending: Vec<Value>,
    pub transfers: Vec<Transfer>,
    pub error: String,
    pub last_ok: i64,
    /// finished rounds so far (tests wait on this)
    pub rounds: u64,
    /// what the engine did lately ("Merged a.ipynb", "Moved b.txt to the Recycle Bin"…), newest last
    pub log: Vec<String>,
}

pub struct Link {
    pub id: String,
    cfg: Mutex<LinkCfg>,
    st: Mutex<Status>,
    state: Mutex<StateFile>,
    hold: Mutex<HashSet<String>>,
    forced: Mutex<HashMap<String, String>>,
    kick: Notify,
    stop: AtomicBool,
    paused: AtomicBool,
    allow_mass: AtomicBool,
    last_emit: Mutex<Instant>,
    dirty: AtomicBool,
    env: Env,
    hub: Arc<Hub>,
    quiet_rounds: Mutex<u32>,
}

#[derive(Clone)]
struct LFile {
    size: u64,
    mtime_ms: i64,
}

fn now_s() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}
fn ms_of(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// `20260131-142530` in UTC, for the server's trash folders.
pub fn stamp() -> String {
    let t = now_s();
    let (days, rem) = (t.div_euclid(86400), t.rem_euclid(86400));
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn scan_local(root: &Path, rules: &Rules) -> Result<HashMap<String, LFile>, String> {
    let mut out = HashMap::new();
    let mut stack: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(e) if rel.is_empty() => return Err(format!("Could not read the local folder {}: {e}", root.display())),
            Err(_) => continue,
        };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            let Some(name) = e.file_name().to_str().map(String::from) else { continue };
            let r = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            if ft.is_dir() {
                if !rules.excluded(&r, true) {
                    stack.push((e.path(), r));
                }
            } else if ft.is_file() && !rules.excluded(&r, false) {
                if let Ok(m) = e.metadata() {
                    out.insert(r, LFile { size: m.len(), mtime_ms: m.modified().map(ms_of).unwrap_or(0) });
                }
            }
        }
    }
    Ok(out)
}

fn lstat(p: &Path) -> Option<LFile> {
    let m = std::fs::metadata(p).ok()?;
    m.is_file().then(|| LFile { size: m.len(), mtime_ms: m.modified().map(ms_of).unwrap_or(0) })
}

fn texty(b: &[u8]) -> Option<&str> {
    if b.iter().take(8000).any(|c| *c == 0) {
        return None;
    }
    std::str::from_utf8(b).ok()
}

fn set_mtime(p: &Path, secs: i64) {
    if let Ok(f) = std::fs::OpenOptions::new().write(true).open(p) {
        let _ = f.set_modified(UNIX_EPOCH + Duration::from_secs(secs.max(0) as u64));
    }
}

/// `dir/name (server).ext`, not yet existing.
fn copy_name(local_root: &Path, rel: &str) -> String {
    let (dir, file) = rel.rsplit_once('/').map(|(d, f)| (format!("{d}/"), f.to_string())).unwrap_or((String::new(), rel.to_string()));
    let (stem, ext) = match file.rfind('.') {
        Some(i) if i > 0 => (file[..i].to_string(), file[i..].to_string()),
        _ => (file.clone(), String::new()),
    };
    let mut n = 0;
    loop {
        let cand = if n == 0 { format!("{dir}{stem} (server){ext}") } else { format!("{dir}{stem} (server {}){ext}", n + 1) };
        if !local_root.join(&cand).exists() {
            return cand;
        }
        n += 1;
    }
}

struct Item {
    rel: String,
    action: Action,
    lf: Option<LFile>,
    rf: Option<RFile>,
    lh: String,
    rh: String,
}

impl Link {
    pub fn new(env: Env, hub: Arc<Hub>, cfg: LinkCfg) -> Arc<Link> {
        let st = std::fs::read(env.data_dir.join("sync").join(format!("{}.json", cfg.id))).ok().and_then(|b| serde_json::from_slice::<StateFile>(&b).ok()).unwrap_or_default();
        let paused = cfg.paused;
        let l = Arc::new(Link {
            id: cfg.id.clone(),
            cfg: Mutex::new(cfg),
            st: Mutex::new(Status { state: if paused { "paused".into() } else { "idle".into() }, ..Default::default() }),
            state: Mutex::new(st),
            hold: Mutex::new(HashSet::new()),
            forced: Mutex::new(HashMap::new()),
            kick: Notify::new(),
            stop: AtomicBool::new(false),
            paused: AtomicBool::new(paused),
            allow_mass: AtomicBool::new(false),
            last_emit: Mutex::new(Instant::now() - Duration::from_secs(5)),
            dirty: AtomicBool::new(false),
            env,
            hub,
            quiet_rounds: Mutex::new(0),
        });
        l.refresh_conflicts();
        l
    }

    pub fn start(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move { me.run().await });
    }
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.kick.notify_one();
    }
    pub fn poke(&self) {
        *self.quiet_rounds.lock().unwrap() = 0;
        self.kick.notify_one();
    }
    pub fn now(&self, allow_mass: bool) {
        self.allow_mass.store(allow_mass, Ordering::SeqCst);
        self.poke();
    }
    pub fn set_paused(&self, p: bool) {
        self.paused.store(p, Ordering::SeqCst);
        self.cfg.lock().unwrap().paused = p;
        {
            let mut s = self.st.lock().unwrap();
            if p {
                s.state = "paused".into();
            } else if s.state == "paused" {
                s.state = "idle".into();
            }
        }
        self.emit(true);
        self.poke();
    }
    pub fn update(&self, cfg: LinkCfg) {
        let p = cfg.paused;
        *self.cfg.lock().unwrap() = cfg;
        self.paused.store(p, Ordering::SeqCst);
        self.poke();
    }
    pub fn set_hold(&self, rels: Vec<String>) {
        let new: HashSet<String> = rels.into_iter().collect();
        let released = { let mut h = self.hold.lock().unwrap(); let r = h.difference(&new).count() > 0; *h = new; r };
        if released {
            self.poke();
        }
    }
    pub fn status(&self) -> Status {
        self.st.lock().unwrap().clone()
    }
    pub fn cfg(&self) -> LinkCfg {
        self.cfg.lock().unwrap().clone()
    }
    /// Resolve a waiting conflict: "local" (keep this computer's file), "server", or "both"
    /// (this computer's file wins, the server's copy stays as its own file next to it).
    pub fn resolve(&self, rel: &str, choice: &str) {
        self.forced.lock().unwrap().insert(rel.to_string(), choice.to_string());
        self.poke();
    }

    fn emit(&self, force: bool) {
        {
            let mut t = self.last_emit.lock().unwrap();
            if !force && t.elapsed() < Duration::from_millis(250) {
                return;
            }
            *t = Instant::now();
        }
        let s = self.st.lock().unwrap().clone();
        self.env.emit("ssh-sync", json!({"id": self.id, "status": s}));
    }
    fn note(&self, t: String) {
        let mut s = self.st.lock().unwrap();
        s.log.push(t);
        if s.log.len() > 30 {
            s.log.remove(0);
        }
    }
    fn set_state(&self, st: &str, err: &str) {
        {
            let mut s = self.st.lock().unwrap();
            s.state = st.to_string();
            s.error = err.to_string();
        }
        self.emit(true);
    }
    fn refresh_conflicts(&self) {
        let list: Vec<Value> = self.state.lock().unwrap().files.iter().filter_map(|(r, rec)| rec.conflict.as_ref().map(|c| json!({"rel": r, "why": c.why, "copy": c.copy, "at": c.at}))).collect();
        let n = self.state.lock().unwrap().files.len() as u32;
        let mut s = self.st.lock().unwrap();
        s.conflicts = list;
        s.tracked = n;
    }

    fn state_path(&self) -> PathBuf {
        self.env.data_dir.join("sync").join(format!("{}.json", self.id))
    }
    fn base_path(&self, rel: &str) -> PathBuf {
        self.env.data_dir.join("sync").join(&self.id).join("base").join(rel)
    }
    pub fn base_text(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.base_path(rel)).ok()
    }
    fn save_base(&self, rel: &str, bytes: &[u8]) {
        let p = self.base_path(rel);
        if bytes.len() as u64 <= BASE_MAX && texty(bytes).is_some() {
            if let Some(d) = p.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            let _ = std::fs::write(&p, bytes);
        } else {
            let _ = std::fs::remove_file(&p);
        }
    }
    fn persist(&self) {
        if !self.dirty.swap(false, Ordering::SeqCst) {
            return;
        }
        let p = self.state_path();
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let tmp = p.with_extension("tmp");
        let body = serde_json::to_vec(&*self.state.lock().unwrap()).unwrap_or_default();
        if std::fs::write(&tmp, body).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }
    fn set_rec(&self, rel: &str, rec: Option<Rec>) {
        let mut s = self.state.lock().unwrap();
        match rec {
            Some(r) => {
                s.files.insert(rel.to_string(), r);
            }
            None => {
                s.files.remove(rel);
            }
        }
        self.dirty.store(true, Ordering::SeqCst);
    }

    // ------------------------------------------------------------ the loop
    async fn run(self: Arc<Self>) {
        loop {
            if self.stop.load(Ordering::SeqCst) {
                break;
            }
            if self.paused.load(Ordering::SeqCst) {
                self.set_state("paused", "");
                let _ = tokio::time::timeout(Duration::from_secs(3600), self.kick.notified()).await;
                continue;
            }
            let wait = match self.round().await {
                Ok(changed) => {
                    let mut q = self.quiet_rounds.lock().unwrap();
                    *q = if changed { 0 } else { (*q + 1).min(20) };
                    // 15 s while things happen, slowly backing off to 60 s when nothing does
                    Duration::from_secs(match *q { 0..=3 => 15, 4..=9 => 30, _ => 60 })
                }
                Err(e) => {
                    let off = e.contains("disconnected") || e.contains("sign in") || e.contains("Could not") || e.contains("refused") || e.contains("VPN");
                    self.set_state(if off { "offline" } else { "error" }, &e);
                    Duration::from_secs(20)
                }
            };
            self.st.lock().unwrap().rounds += 1;
            self.emit(true);
            if self.stop.load(Ordering::SeqCst) {
                break;
            }
            let _ = tokio::time::timeout(wait, self.kick.notified()).await;
            // a burst of local changes: let it settle
            tokio::time::sleep(Duration::from_millis(600)).await;
        }
    }

    /// One pass: list, compare, copy. Returns whether anything changed.
    async fn round(self: &Arc<Self>) -> Result<bool, String> {
        let cfg = self.cfg();
        let sess = self.hub.session(&cfg.host, false).await?;
        let rem = Remote::new(sess, &cfg.remote).await;
        let local_root = PathBuf::from(&cfg.local);
        if !local_root.is_dir() {
            return Err(format!("The local folder {} is missing. Link it again or restore the folder.", cfg.local));
        }
        {
            let mut s = self.st.lock().unwrap();
            if s.state != "syncing" {
                s.state = "scanning".into();
            }
            s.error.clear();
        }
        self.emit(false);
        let rules = Rules::new(&cfg.exclude);
        let (lroot, lrules) = (local_root.clone(), rules.clone());
        let lscan = tokio::task::spawn_blocking(move || scan_local(&lroot, &lrules));
        let rmap = rem.scan(&rules).await?;
        let lmap = lscan.await.map_err(|e| e.to_string())??;
        // purge the server's trash about once a day
        {
            let due = self.state.lock().unwrap().purged < now_s() - 86400;
            if due {
                rem.purge_trash().await;
                self.state.lock().unwrap().purged = now_s();
                self.dirty.store(true, Ordering::SeqCst);
            }
        }

        // ---- plan
        let mut rels: BTreeSet<String> = lmap.keys().chain(rmap.keys()).cloned().collect();
        let snapshot: BTreeMap<String, Rec> = self.state.lock().unwrap().files.clone();
        rels.extend(snapshot.keys().cloned());
        let hold = self.hold.lock().unwrap().clone();
        let forced = self.forced.lock().unwrap().clone();
        let limit = cfg.limit();
        let include: HashSet<&String> = cfg.include.iter().collect();
        let mut skipped = vec![];
        let mut held = 0;
        let mut need_l: Vec<String> = vec![];
        let mut need_r: Vec<String> = vec![];
        let mut pre: Vec<(String, Option<LFile>, Option<RFile>)> = vec![];
        for rel in &rels {
            let (lf, rf, rec) = (lmap.get(rel).cloned(), rmap.get(rel).cloned(), snapshot.get(rel));
            if rec.map(|r| r.conflict.is_some()).unwrap_or(false) && !forced.contains_key(rel) {
                // a waiting conflict: if the file is gone from both sides there is nothing to wait for
                if lf.is_none() && rf.is_none() {
                    self.set_rec(rel, None);
                }
                continue;
            }
            let big = lf.as_ref().map(|f| f.size).unwrap_or(0).max(rf.as_ref().map(|f| f.size).unwrap_or(0));
            if big >= limit && !include.contains(rel) {
                skipped.push(json!({"rel": rel, "size": big}));
                continue;
            }
            if hold.contains(rel) {
                held += 1;
                continue;
            }
            // which sides need a hash to be classified
            let l_need = match (&lf, rec) {
                (Some(l), Some(r)) => !(l.size == r.ls && l.mtime_ms == r.lm),
                (Some(l), None) => rf.as_ref().map(|r| r.size == l.size).unwrap_or(false),
                _ => false,
            };
            let r_need = match (&rf, rec) {
                (Some(r), Some(x)) => !(r.size == x.rs && r.mtime == x.rm),
                (Some(r), None) => lf.as_ref().map(|l| l.size == r.size).unwrap_or(false),
                _ => false,
            };
            if l_need {
                need_l.push(rel.clone());
            }
            if r_need {
                need_r.push(rel.clone());
            }
            pre.push((rel.clone(), lf, rf));
        }
        // hashes (local on a thread, remote through the server)
        let lh_task = {
            let root = local_root.clone();
            let list = need_l.clone();
            tokio::task::spawn_blocking(move || list.into_iter().filter_map(|r| file_hash(&root.join(&r)).ok().map(|h| (r, h))).collect::<HashMap<_, _>>())
        };
        let rhs = rem.hashes(&need_r).await;
        let lhs = lh_task.await.map_err(|e| e.to_string())?;

        let dirn = cfg.dir();
        let mut items: Vec<Item> = vec![];
        let mut touched = 0;
        for (rel, lf, rf) in pre {
            let rec = snapshot.get(&rel);
            let base = rec.map(|r| r.hash.as_str());
            let classify = |present: bool, hash: Option<&String>, same_meta: bool, placeholder: &str| -> Obs {
                if !present {
                    return Obs::Absent;
                }
                if same_meta {
                    return Obs::Same;
                }
                match hash {
                    Some(h) if Some(h.as_str()) == base => Obs::Same,
                    Some(h) => Obs::Changed(h.clone()),
                    None => Obs::Changed(placeholder.to_string()),
                }
            };
            let l_same = matches!((&lf, rec), (Some(l), Some(r)) if l.size == r.ls && l.mtime_ms == r.lm);
            let r_same = matches!((&rf, rec), (Some(r), Some(x)) if r.size == x.rs && r.mtime == x.rm);
            let lo = classify(lf.is_some(), lhs.get(&rel), l_same, "?local");
            let ro = classify(rf.is_some(), rhs.get(&rel), r_same, "?remote");
            // a hash that failed to compute leaves a placeholder: don't act on a guess
            if (need_l.contains(&rel) && !lhs.contains_key(&rel) && lf.is_some()) || (need_r.contains(&rel) && !rhs.contains_key(&rel) && rf.is_some()) {
                continue;
            }
            // touched but identical: refresh the record's file times
            if let (Obs::Same, Obs::Same, Some(r), Some(l), Some(x)) = (&lo, &ro, rec, &lf, &rf) {
                if l.mtime_ms != r.lm || x.mtime != r.rm || l.size != r.ls || x.size != r.rs {
                    let mut n = r.clone();
                    (n.ls, n.lm, n.rs, n.rm) = (l.size, l.mtime_ms, x.size, x.mtime);
                    self.set_rec(&rel, Some(n));
                    touched += 1;
                }
            }
            let mut action = decide(rec.is_some(), &lo, &ro, dirn);
            if std::env::var_os("CALLIO_SYNC_DEBUG").is_some() && action != Action::Nothing {
                eprintln!("[sync] {rel}: local {lo:?} remote {ro:?} -> {action:?}");
            }
            if let Some(choice) = forced.get(&rel) {
                action = match (choice.as_str(), &lo, &ro) {
                    ("server", _, Obs::Absent) => if lf.is_some() { Action::DeleteLocal } else { Action::Forget },
                    ("server", _, _) => Action::Download,
                    (_, Obs::Absent, _) => if rf.is_some() { Action::DeleteRemote } else { Action::Forget },
                    (_, _, _) => Action::Upload,
                };
            }
            if action == Action::Nothing {
                continue;
            }
            let (lh, rh) = (lhs.get(&rel).cloned().unwrap_or_default(), rhs.get(&rel).cloned().unwrap_or_default());
            items.push(Item { rel, action, lf, rf, lh, rh });
        }
        let _ = touched;

        // ---- guard against a missing folder looking like "everything was deleted"
        let tracked = snapshot.values().filter(|r| r.conflict.is_none()).count();
        let dels = items.iter().filter(|i| matches!(i.action, Action::DeleteLocal | Action::DeleteRemote)).count();
        if dels >= 20 && dels * 2 >= tracked.max(1) && !self.allow_mass.load(Ordering::SeqCst) {
            let mut s = self.st.lock().unwrap();
            s.skipped = skipped;
            drop(s);
            return Err(format!("{dels} files would be deleted (more than half of the linked files). Nothing was changed. If this is what you want, press Sync now and confirm; otherwise check that the folder on both sides is the right one."));
        }
        self.allow_mass.store(false, Ordering::SeqCst);

        {
            let mut s = self.st.lock().unwrap();
            s.skipped = skipped;
            s.up = items.iter().filter(|i| matches!(i.action, Action::Upload)).count() as u32 + held;
            s.down = items.iter().filter(|i| matches!(i.action, Action::Download)).count() as u32;
            s.pending = items.iter().take(200).map(|i| json!({"rel": i.rel, "dir": match i.action { Action::Upload => "up", Action::Download => "down", Action::DeleteLocal => "delete-local", Action::DeleteRemote => "delete-remote", Action::Conflict(_) => "conflict", _ => "other" }})).collect();
            if !items.is_empty() {
                s.state = "syncing".into();
            }
        }
        self.refresh_conflicts();
        self.emit(true);
        let changed = !items.is_empty();

        // ---- do it (three at a time)
        let ctx = Arc::new(Ctx { rem, local_root, cfg: cfg.clone() });
        let me = self.clone();
        let total = items.len();
        futures_util::stream::iter(items).for_each_concurrent(3, |it| {
            let (me, ctx) = (me.clone(), ctx.clone());
            async move {
                let rel = it.rel.clone();
                let r = me.perform(&ctx, it).await;
                if let Err(e) = r {
                    me.note(format!("{rel}: {e}"));
                    me.st.lock().unwrap().error = e;
                }
                {
                    let mut s = me.st.lock().unwrap();
                    s.pending.retain(|p| p["rel"] != json!(rel));
                    s.transfers.retain(|t| t.rel != rel);
                }
                me.emit(false);
            }
        }).await;
        if total > 0 {
            self.persist();
        }
        // forced resolutions are done (or failed and shown as an error)
        {
            let mut f = self.forced.lock().unwrap();
            for (k, _) in forced.iter() {
                f.remove(k);
            }
        }
        self.refresh_conflicts();
        let failed = self.st.lock().unwrap().error.clone();
        {
            let mut s = self.st.lock().unwrap();
            s.state = "idle".into();
            s.up = 0;
            s.down = 0;
            s.pending.clear();
            if failed.is_empty() {
                s.last_ok = now_s();
            }
        }
        self.persist();
        self.emit(true);
        Ok(changed || touched > 0)
    }

    fn progress(self: &Arc<Self>, rel: &str, dir: &str, done: u64, total: u64) {
        {
            let mut s = self.st.lock().unwrap();
            match s.transfers.iter_mut().find(|t| t.rel == rel) {
                Some(t) => t.done = done,
                None => s.transfers.push(Transfer { rel: rel.into(), dir: dir.into(), done, total }),
            }
        }
        self.emit(false);
    }

    async fn perform(self: &Arc<Self>, c: &Arc<Ctx>, it: Item) -> Result<(), String> {
        let rel = it.rel.as_str();
        let lp = c.local_root.join(rel);
        match it.action {
            Action::Nothing => Ok(()),
            Action::Forget => {
                self.set_rec(rel, None);
                let _ = std::fs::remove_file(self.base_path(rel));
                Ok(())
            }
            Action::Adopt => {
                let (Some(l), Some(r)) = (&it.lf, &it.rf) else { return Ok(()) };
                self.set_rec(rel, Some(Rec { hash: it.lh.clone(), ls: l.size, lm: l.mtime_ms, rs: r.size, rm: r.mtime, conflict: None }));
                if let Ok(b) = std::fs::read(&lp) {
                    self.save_base(rel, &b);
                }
                Ok(())
            }
            Action::Upload => self.upload(c, &it, &lp).await,
            Action::Download => self.download(c, &it, &lp).await,
            Action::DeleteLocal => {
                let copy = self.conflict_copy(rel);
                if lstat(&lp).is_none() {
                    self.set_rec(rel, None);
                    return Ok(());
                }
                (self.env.trash)(&lp)?;
                self.note(format!("Moved {rel} to the Recycle Bin (deleted on the server)"));
                self.set_rec(rel, None);
                let _ = std::fs::remove_file(self.base_path(rel));
                self.clean_copy(c, copy, false);
                Ok(())
            }
            Action::DeleteRemote => {
                let copy = self.conflict_copy(rel);
                c.rem.trash(rel, &stamp()).await?;
                self.note(format!("Moved {rel} to the server's .callio-trash (deleted here)"));
                self.set_rec(rel, None);
                let _ = std::fs::remove_file(self.base_path(rel));
                self.clean_copy(c, copy, false);
                Ok(())
            }
            Action::Conflict(why) => self.conflict(c, &it, &lp, why).await,
        }
    }

    /// Remove the server-copy file next to a resolved conflict (to the Recycle Bin).
    fn conflict_copy(&self, rel: &str) -> Option<String> {
        self.state.lock().unwrap().files.get(rel).and_then(|r| r.conflict.as_ref()).and_then(|x| x.copy.clone())
    }
    fn clean_copy(&self, c: &Ctx, copy: Option<String>, keep: bool) {
        if let (Some(cp), false) = (copy, keep) {
            let p = c.local_root.join(cp);
            if p.exists() {
                let _ = (self.env.trash)(&p);
            }
        }
    }

    async fn upload(self: &Arc<Self>, c: &Arc<Ctx>, it: &Item, lp: &Path) -> Result<(), String> {
        let rel = it.rel.as_str();
        let copy = self.conflict_copy(rel);
        let l = lstat(lp).ok_or_else(|| format!("{rel} changed while syncing; it will be tried again."))?;
        if let Some(pl) = &it.lf {
            if pl.size != l.size || pl.mtime_ms != l.mtime_ms {
                return Err(format!("{rel} changed while syncing; it will be tried again."));
            }
        }
        // the server's copy must still be what we compared (never overwrite news)
        let now_r = c.rem.stat(rel).await;
        if now_r != it.rf {
            return Err(format!("{rel} changed on the server while syncing; it will be compared again."));
        }
        let p2 = lp.to_path_buf();
        let hash = tokio::task::spawn_blocking(move || file_hash(&p2)).await.map_err(|e| e.to_string())??;
        let secs = l.mtime_ms / 1000;
        let me = self.clone();
        let rl = rel.to_string();
        let total = l.size;
        // a remote file that exists is moved aside first only when a forced choice replaces a conflicting copy
        if self.forced.lock().unwrap().contains_key(rel) && it.rf.is_some() {
            c.rem.trash(rel, &stamp()).await.ok();
        }
        c.rem.upload(lp, rel, secs, l.size, &hash, &move |d| me.progress(&rl, "up", d, total)).await?;
        let after = c.rem.stat(rel).await.unwrap_or(RFile { size: l.size, mtime: secs });
        let l2 = lstat(lp).unwrap_or(l.clone());
        if l2.mtime_ms != l.mtime_ms || l2.size != l.size {
            // edited during the upload: keep the old record so the next round sees "changed"
            return Err(format!("{rel} changed while it was uploading; it will be uploaded again."));
        }
        self.set_rec(rel, Some(Rec { hash, ls: l.size, lm: l.mtime_ms, rs: after.size, rm: after.mtime, conflict: None }));
        if let Ok(b) = std::fs::read(lp) {
            self.save_base(rel, &b);
        }
        self.after_force(c, rel, copy);
        Ok(())
    }

    fn after_force(&self, c: &Ctx, rel: &str, copy: Option<String>) {
        let choice = self.forced.lock().unwrap().get(rel).cloned();
        if let Some(ch) = choice {
            self.clean_copy(c, copy, ch == "both");
        }
    }

    async fn download(self: &Arc<Self>, c: &Arc<Ctx>, it: &Item, lp: &Path) -> Result<(), String> {
        let rel = it.rel.as_str();
        let r = it.rf.clone().ok_or("The file is gone from the server.")?;
        let copy = self.conflict_copy(rel);
        let me = self.clone();
        let rl = rel.to_string();
        let (part, hash) = c.rem.download(rel, lp, r.mtime, r.size, &move |d| me.progress(&rl, "down", d, r.size)).await?;
        // the server's file must be the one we planned for
        if c.rem.stat(rel).await.as_ref() != Some(&r) {
            let _ = std::fs::remove_file(&part);
            return Err(format!("{rel} changed on the server while it was downloading; it will be tried again."));
        }
        // and the local file must not have changed since we looked
        let now_l = lstat(lp);
        let same = match (&now_l, &it.lf) {
            (None, None) => true,
            (Some(a), Some(b)) => a.size == b.size && a.mtime_ms == b.mtime_ms,
            _ => false,
        };
        if !same {
            let _ = std::fs::remove_file(&part);
            return Err(format!("{rel} changed here while it was downloading; it will be compared again."));
        }
        set_mtime(&part, r.mtime);
        if now_l.is_some() && self.forced.lock().unwrap().contains_key(rel) {
            // the author chose the server's version over a changed local one: keep that one in the Recycle Bin
            let _ = (self.env.trash)(lp);
        }
        std::fs::rename(&part, lp).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            format!("Could not replace {rel}: {e}. Is the file open in another program?")
        })?;
        let l = lstat(lp).ok_or("The downloaded file disappeared.")?;
        self.set_rec(rel, Some(Rec { hash, ls: l.size, lm: l.mtime_ms, rs: r.size, rm: r.mtime, conflict: None }));
        if let Ok(b) = std::fs::read(lp) {
            self.save_base(rel, &b);
        }
        self.after_force(c, rel, copy);
        Ok(())
    }

    /// Both sides changed (or one deleted what the other edited).
    async fn conflict(self: &Arc<Self>, c: &Arc<Ctx>, it: &Item, lp: &Path, why: Why) -> Result<(), String> {
        let rel = it.rel.as_str();
        let rec = self.state.lock().unwrap().files.get(rel).cloned();
        let mut cf = Conflict { why: format!("{why:?}"), at: now_s(), ..Default::default() };
        let mut merged_done = false;
        if matches!(why, Why::BothChanged | Why::BothNew) {
            if let (Some(l), Some(r)) = (&it.lf, &it.rf) {
                if l.size <= (8 << 20) && r.size <= (8 << 20) {
                    let lb = std::fs::read(lp).map_err(|e| e.to_string())?;
                    let rb = c.rem.read(rel, 8 << 20).await?;
                    if let Some(m) = self.try_merge(c, rel, &lb, &rb, rec.as_ref(), l, r) {
                        // write locally (atomic), then to the server; both must still be as compared
                        if lstat(lp).map(|x| x.mtime_ms != l.mtime_ms || x.size != l.size).unwrap_or(true) || c.rem.stat(rel).await.as_ref() != Some(r) {
                            return Err(format!("{rel} changed while it was being merged; it will be tried again."));
                        }
                        let tmp = lp.with_file_name(format!(".callio-tmp-{}", rand_hex(5)));
                        std::fs::write(&tmp, &m).map_err(|e| e.to_string())?;
                        let now = now_s();
                        set_mtime(&tmp, now);
                        std::fs::rename(&tmp, lp).map_err(|e| { let _ = std::fs::remove_file(&tmp); format!("Could not replace {rel}: {e}") })?;
                        c.rem.write_atomic(rel, &m, now).await?;
                        let l2 = lstat(lp).ok_or("The merged file disappeared.")?;
                        let r2 = c.rem.stat(rel).await.unwrap_or(RFile { size: m.len() as u64, mtime: now });
                        let h = crate::util::sha256_hex(&m);
                        self.set_rec(rel, Some(Rec { hash: h, ls: l2.size, lm: l2.mtime_ms, rs: r2.size, rm: r2.mtime, conflict: None }));
                        self.save_base(rel, &m);
                        self.note(format!("Merged {rel} (both sides had changes)"));
                        merged_done = true;
                    } else {
                        // keep both: the server's version next to the local one
                        let copy = copy_name(&c.local_root, rel);
                        let cp = c.local_root.join(&copy);
                        if let Some(d) = cp.parent() {
                            let _ = std::fs::create_dir_all(d);
                        }
                        std::fs::write(&cp, &rb).map_err(|e| e.to_string())?;
                        set_mtime(&cp, r.mtime);
                        cf.copy = Some(copy.clone());
                        self.note(format!("{rel} changed on both sides. The server's version was saved as {copy}"));
                    }
                } else {
                    self.note(format!("{rel} is large and changed on both sides. It was left alone; choose which one to keep."));
                }
            }
        } else {
            self.note(format!("{rel}: {}", if why == Why::LocalDeleted { "deleted here but edited on the server" } else { "edited here but deleted on the server" }));
        }
        if !merged_done {
            cf.lh = it.lh.clone();
            cf.rh = it.rh.clone();
            let mut r = rec.unwrap_or_default();
            if let Some(l) = &it.lf {
                (r.ls, r.lm) = (l.size, l.mtime_ms);
            }
            if let Some(x) = &it.rf {
                (r.rs, r.rm) = (x.size, x.mtime);
            }
            r.conflict = Some(cf);
            self.set_rec(rel, Some(r));
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn try_merge(&self, c: &Ctx, rel: &str, lb: &[u8], rb: &[u8], rec: Option<&Rec>, l: &LFile, r: &RFile) -> Option<Vec<u8>> {
        let (ls, rs) = (texty(lb)?, texty(rb)?);
        let base = rec.filter(|x| x.conflict.is_none() && !x.hash.is_empty()).and_then(|_| self.base_text(rel));
        if rel.to_lowercase().ends_with(".ipynb") {
            let (lv, rv): (Value, Value) = (serde_json::from_str(ls).ok()?, serde_json::from_str(rs).ok()?);
            let bv: Value = match &base {
                Some(b) => serde_json::from_str(b).ok()?,
                None => json!({"cells": [], "metadata": {}, "nbformat": 4, "nbformat_minor": 5}),
            };
            let prefer = match c.cfg.prefer_outputs.as_str() {
                "local" => nbmerge::Prefer::Local,
                "server" => nbmerge::Prefer::Server,
                _ => nbmerge::Prefer::Newest,
            };
            let m = nbmerge::merge(&bv, &lv, &rv, prefer, l.mtime_ms / 1000 >= r.mtime).ok()?;
            return Some(nbmerge::to_string(&m).into_bytes());
        }
        let base = base?;
        diffy::merge(&base, ls, rs).ok().map(|s| s.into_bytes())
    }
}

struct Ctx {
    rem: Remote,
    local_root: PathBuf,
    cfg: LinkCfg,
}

// ---------------------------------------------------------------- manager
pub struct SyncMgr {
    pub env: Env,
    pub hub: Arc<Hub>,
    links: Mutex<HashMap<String, Arc<Link>>>,
}

impl SyncMgr {
    pub fn new(env: Env, hub: Arc<Hub>) -> Arc<SyncMgr> {
        Arc::new(SyncMgr { env, hub, links: Mutex::new(HashMap::new()) })
    }
    pub fn get(&self, id: &str) -> Option<Arc<Link>> {
        self.links.lock().unwrap().get(id).cloned()
    }
    pub fn all(&self) -> Vec<Arc<Link>> {
        self.links.lock().unwrap().values().cloned().collect()
    }
    /// Start (or update) a link.
    pub fn start(&self, cfg: LinkCfg) -> Arc<Link> {
        if let Some(l) = self.get(&cfg.id) {
            l.update(cfg);
            return l;
        }
        let l = Link::new(self.env.clone(), self.hub.clone(), cfg);
        self.links.lock().unwrap().insert(l.id.clone(), l.clone());
        l.start();
        l
    }
    pub fn stop(&self, id: &str, forget: bool) {
        if let Some(l) = self.links.lock().unwrap().remove(id) {
            l.stop();
        }
        if forget {
            let _ = std::fs::remove_file(self.env.data_dir.join("sync").join(format!("{id}.json")));
            let _ = std::fs::remove_dir_all(self.env.data_dir.join("sync").join(id));
        }
    }
    pub fn stop_all(&self) {
        for (_, l) in self.links.lock().unwrap().drain() {
            l.stop();
        }
    }
}
