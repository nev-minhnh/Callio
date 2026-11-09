//! Project memory, after the ideas of Zero-Mem ("zero-token memory operations"): every chat
//! turn is kept verbatim as the source of record; memory is organised as an entity–context
//! graph plus a time hierarchy (sessions → turns); recall profiles the question, fuses lexical
//! (BM25) and graph evidence, adds the neighbouring turn for context, and packs the result into a
//! small budget. Writing, organising and recalling use no model calls and no tokens — only the
//! recalled lines are read by the model, inside the next prompt.
//!
//! Storage (per project folder, under the app's data folder):
//!   memory/<hash>/traces.jsonl   one JSON line per turn
//!   memory/<hash>/pins.json      things the author asked to remember
//!   memory/<hash>/meta.json      project path, last Claude Code session
use crate::settings::data_dir;
use crate::textindex::Index;
use crate::util::{path_key, sha256_hex, CmdResult, ErrStr};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use tauri::AppHandle;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Trace {
    pub id: String,
    /// unix ms
    pub t: u64,
    pub session: String,
    /// "user" | "assistant" | "event"
    pub role: String,
    pub text: String,
    pub file: String,
    pub model: String,
    pub skills: Vec<String>,
    pub changed: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Pin {
    pub id: String,
    pub t: u64,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Meta {
    pub project: String,
    pub cc_session: String,
    pub cc_session_at: u64,
    pub cc_model: String,
}

pub(crate) fn dir(app: &AppHandle, project: &str) -> PathBuf {
    data_dir(app).join("memory").join(&sha256_hex(path_key(project).as_bytes())[..16])
}
fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// All lines of traces.jsonl; a damaged line (e.g. a crash mid-write) is skipped, never the rest.
fn read_lines(d: &PathBuf) -> Vec<String> {
    let Ok(f) = std::fs::File::open(d.join("traces.jsonl")) else { return Vec::new() };
    std::io::BufReader::new(f).split(b'\n').map_while(Result::ok).map(|b| String::from_utf8_lossy(&b).trim_end_matches('\r').to_string()).filter(|l| !l.trim().is_empty()).collect()
}
fn read_traces(d: &PathBuf) -> Vec<Trace> {
    read_lines(d).iter().filter_map(|l| serde_json::from_str(l).ok()).collect()
}
fn read_json<T: for<'a> Deserialize<'a> + Default>(p: PathBuf) -> T {
    std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}
fn write_json<T: Serialize>(p: PathBuf, v: &T) -> anyhow::Result<()> {
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(v)?)?;
    std::fs::rename(tmp, p)?;
    Ok(())
}

// ---------------- entities (no NER model: patterns that matter in academic writing) ----------------

/// Entities of a text: citation keys, labels, file names, section titles, acronyms and model
/// names, multi-word capitalised names, quoted phrases. Lowercased.
pub fn entities(text: &str) -> Vec<String> {
    use regex_lite::Regex;
    thread_local! {
        static RES: Vec<Regex> = vec![
            Regex::new(r"\\(?:[a-zA-Z]*cite[a-zA-Z]*|ref|eqref|cref|Cref|autoref|label)\*?(?:\[[^\]]*\])*\{([^}]{1,200})\}").unwrap(),
            Regex::new(r"@([A-Za-z][\w:.-]{2,60})").unwrap(),
            Regex::new(r"\b([\w.-]{1,80}\.(?:tex|bib|md|pdf|csv|py|r|json|sty|cls|png|jpg|svg|txt|ipynb))\b").unwrap(),
            Regex::new(r"\\(?:section|subsection|subsubsection|chapter|paragraph)\*?\{([^}]{2,120})\}").unwrap(),
            Regex::new(r"\b([A-Z][a-z]*[A-Z][A-Za-z0-9-]*|[A-Z]{2,}[A-Za-z0-9-]*|[A-Za-z]+-\d+[A-Za-z0-9.-]*)\b").unwrap(),
            Regex::new(r"\b([A-Z][a-z]{2,}(?:\s+(?:of|for|and|the|de|van|von)?\s*[A-Z][a-z]{2,}){1,4})\b").unwrap(),
            Regex::new(r#"["“]([^"”\n]{3,60})["”]"#).unwrap(),
        ];
    }
    let mut out: Vec<String> = Vec::new();
    RES.with(|res| {
        for (i, re) in res.iter().enumerate() {
            for c in re.captures_iter(text) {
                let v = c[1].trim();
                let parts: Vec<&str> = if i == 0 { v.split(',').collect() } else { vec![v] };
                for p in parts {
                    let p = p.trim().to_lowercase();
                    if p.len() >= 2 && p.len() <= 120 && !["the", "this", "that", "and", "we", "i"].contains(&p.as_str()) {
                        out.push(p);
                    }
                }
            }
        }
    });
    out.sort();
    out.dedup();
    out
}

const TEMPORAL: &[&str] = &["last time", "yesterday", "earlier", "before", "previous", "previously", "last session", "where were we", "where we left", "continue", "so far", "recap", "remind me", "what did we", "what did i", "we were", "last week", "again"];

// ---------------- commands ----------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordEntry {
    role: String,
    text: String,
    #[serde(default)]
    file: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    skills: Vec<String>,
    #[serde(default)]
    changed: Vec<String>,
}

/// Keep a chat turn (verbatim, trimmed to a sane size).
#[tauri::command]
pub async fn mem_record(app: AppHandle, project: String, session: String, entries: Vec<RecordEntry>) -> CmdResult<()> {
    if project.trim().is_empty() {
        return Ok(());
    }
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let d = dir(&app, &project);
    std::fs::create_dir_all(&d).es()?;
    let mut meta: Meta = read_json(d.join("meta.json"));
    if meta.project.is_empty() {
        meta.project = project.clone();
        write_json(d.join("meta.json"), &meta).es()?;
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(d.join("traces.jsonl")).es()?;
    for e in entries {
        let mut text = e.text.trim().to_string();
        if text.is_empty() {
            continue;
        }
        if text.len() > 12_000 {
            let mut cut = 12_000;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
            text.push_str(" …");
        }
        let t = now_ms();
        let tr = Trace { id: format!("{t:x}{}", &sha256_hex(text.as_bytes())[..4]), t, session: session.clone(), role: e.role, text, file: e.file, model: e.model, skills: e.skills, changed: e.changed };
        writeln!(f, "{}", serde_json::to_string(&tr).es()?).es()?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recall {
    /// ready-to-use block for the prompt ("" when there is nothing relevant)
    text: String,
    /// skills the author used in this project (most used first)
    skills: Vec<String>,
    /// number of turns remembered
    turns: usize,
    meta: Meta,
}

/// Recall what's relevant to `query` (zero model tokens), packed into `budget` characters.
#[tauri::command]
pub async fn mem_recall(app: AppHandle, project: String, query: String, session: String, budget: Option<usize>, before: Option<u64>) -> CmdResult<Recall> {
    tauri::async_runtime::spawn_blocking(move || recall(&app, &project, &query, &session, budget.unwrap_or(6000), before)).await.es()
}

fn day(t: u64) -> String {
    // yyyy-mm-dd from unix ms (UTC), without a date library
    let days = (t / 86_400_000) as i64;
    let (mut y, mut d) = (1970i64, days);
    loop {
        let len = if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 { 366 } else { 365 };
        if d < len {
            break;
        }
        d -= len;
        y += 1;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let ml = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 0;
    while d >= ml[m] {
        d -= ml[m];
        m += 1;
    }
    format!("{y:04}-{:02}-{:02}", m + 1, d + 1)
}

fn clip(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= n {
        return s;
    }
    let mut out: String = s.chars().take(n).collect();
    out.push('…');
    out
}

pub fn recall(app: &AppHandle, project: &str, query: &str, session: &str, budget: usize, before: Option<u64>) -> Recall {
    let d = dir(app, project);
    let meta: Meta = read_json(d.join("meta.json"));
    let pins: Vec<Pin> = read_json(d.join("pins.json"));
    let traces = read_traces(&d);
    recall_core(&traces, &pins, meta, query, session, budget, before)
}

/// `before`: turns of the current conversation older than this (unix ms) have left the model's
/// window, so they can be recalled too.
pub fn recall_core(traces: &[Trace], pins: &[Pin], meta: Meta, query: &str, session: &str, budget: usize, before: Option<u64>) -> Recall {
    let recallable = |t: &Trace| t.session != session || before.is_some_and(|b| t.t < b);
    let mut skill_count: HashMap<String, usize> = HashMap::new();
    for t in traces {
        for s in &t.skills {
            *skill_count.entry(s.clone()).or_default() += 1;
        }
    }
    let mut skills: Vec<(String, usize)> = skill_count.into_iter().collect();
    skills.sort_by(|a, b| b.1.cmp(&a.1));
    let skills: Vec<String> = skills.into_iter().map(|(s, _)| s).take(8).collect();

    // only earlier sessions are recalled (the current conversation is already in context)
    let past: Vec<usize> = (0..traces.len()).filter(|&i| recallable(&traces[i])).collect();
    let mut out = String::new();
    if !pins.is_empty() {
        out.push_str("Things the author asked you to remember:\n");
        for p in pins {
            out.push_str(&format!("- {}\n", clip(&p.text, 400)));
        }
    }
    if past.is_empty() {
        let text = if out.is_empty() { String::new() } else { format!("# Memory of this project\n{out}") };
        return Recall { text, skills, turns: traces.len(), meta };
    }

    // ---- profile the query ----
    let ql = query.to_lowercase();
    let temporal = TEMPORAL.iter().any(|c| ql.contains(c)) || query.trim().len() < 12;
    let q_ent: HashSet<String> = entities(query).into_iter().collect();

    // ---- views: lexical (BM25) and entity graph ----
    let mut ix = Index::default();
    let mut ent_of: Vec<Vec<String>> = Vec::with_capacity(past.len());
    let mut by_ent: HashMap<String, Vec<usize>> = HashMap::new();
    for (k, &i) in past.iter().enumerate() {
        let t = &traces[i];
        let ents = entities(&t.text);
        let ent_text = ents.join(" ");
        ix.add(k as u32, &[(&t.text, 1.0), (&ent_text, 1.5), (&t.file, 1.0), (&t.skills.join(" "), 1.0)]);
        for e in &ents {
            by_ent.entry(e.clone()).or_default().push(k);
        }
        ent_of.push(ents);
    }
    ix.finish();
    let n = past.len().max(1) as f32;
    let mut lexical = vec![0f32; past.len()];
    let lex = ix.search(query, 200, |_| true);
    let lmax = lex.first().map(|x| x.1).unwrap_or(1.0).max(1e-6);
    for (dd, s) in lex {
        lexical[dd as usize] = s / lmax;
    }
    // graph: seed from entities shared with the query (weighted by rarity), then one damped
    // spreading step through shared entities (personalised-PageRank style, damping 0.6)
    let mut graph = vec![0f32; past.len()];
    for e in &q_ent {
        if let Some(ts) = by_ent.get(e) {
            let idf = (n / ts.len() as f32).ln() + 1.0;
            for &k in ts {
                graph[k] += idf;
            }
        }
    }
    let seed = graph.clone();
    for (k, ents) in ent_of.iter().enumerate() {
        if seed[k] <= 0.0 {
            continue;
        }
        for e in ents {
            let ts = &by_ent[e];
            if ts.len() > 50 {
                continue; // too common to carry meaning
            }
            for &j in ts {
                if j != k {
                    graph[j] += 0.6 * seed[k] / ts.len() as f32;
                }
            }
        }
    }
    let gmax = graph.iter().cloned().fold(0f32, f32::max).max(1e-6);
    // ---- route & fuse: entity-rich questions lean on the graph, others on words ----
    let (wg, wl) = if q_ent.is_empty() { (0.4, 0.6) } else { (0.6, 0.4) };
    let newest = traces.iter().map(|t| t.t).max().unwrap_or(0);
    let mut score: Vec<(usize, f32)> = (0..past.len())
        .map(|k| {
            let age_days = (newest.saturating_sub(traces[past[k]].t)) as f32 / 86_400_000.0;
            // recency only breaks ties: relevance decides
            (k, wg * graph[k] / gmax + wl * lexical[k] + 0.05 * (-age_days / 30.0).exp())
        })
        .collect();
    score.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let top = score.first().map(|x| x.1).unwrap_or(0.0);
    let specific = top >= 0.3;

    // ---- evidence closure: each pick brings its neighbouring turn (question ↔ answer) ----
    let mut chosen: Vec<usize> = Vec::new();
    if specific {
        let floor = (0.35 * top).max(0.15);
        for &(k, s) in score.iter().take(6) {
            if s < floor {
                break;
            }
            let i = past[k];
            for j in [i.wrapping_sub(1), i, i + 1] {
                if let Some(t) = traces.get(j) {
                    if t.session == traces[i].session && recallable(t) && !chosen.contains(&j) {
                        chosen.push(j);
                    }
                }
            }
        }
    }
    // nothing specific asked ("where were we?", "continue"): the end of the last session
    if !specific && temporal {
        if let Some(last_s) = past.iter().rev().map(|&i| traces[i].session.clone()).next() {
            let tail: Vec<usize> = past.iter().rev().filter(|&&i| traces[i].session == last_s).take(6).cloned().collect();
            for j in tail {
                if !chosen.contains(&j) {
                    chosen.push(j);
                }
            }
        }
    }
    chosen.sort();
    // ---- pack, in time order, grouped by session ----
    let mut used = out.len();
    let mut body = String::new();
    let mut last_session = String::new();
    for i in chosen {
        let t = &traces[i];
        let who = match t.role.as_str() {
            "user" => "Author",
            "assistant" => "You",
            _ => "Note",
        };
        let per = if t.role == "user" { 500 } else { 900 };
        let mut line = format!("  {who}: {}\n", clip(&t.text, per));
        if !t.changed.is_empty() {
            line.push_str(&format!("  (files changed: {})\n", t.changed.iter().map(|c| c.rsplit(['/', '\\']).next().unwrap_or(c)).collect::<Vec<_>>().join(", ")));
        }
        let head = if t.session != last_session { format!("{} — {}{}:\n", day(t.t), if t.file.is_empty() { "chat".to_string() } else { t.file.rsplit(['/', '\\']).next().unwrap_or("").to_string() }, if t.model.is_empty() { String::new() } else { format!(" ({})", t.model) }) } else { String::new() };
        if used + head.len() + line.len() > budget {
            break;
        }
        used += head.len() + line.len();
        body.push_str(&head);
        body.push_str(&line);
        last_session = t.session.clone();
    }
    if !body.is_empty() {
        out.push_str("From earlier sessions on this project (verbatim excerpts; use them only if relevant):\n");
        out.push_str(&body);
    }
    let text = if out.is_empty() { String::new() } else { format!("# Memory of this project\n{out}") };
    Recall { text, skills, turns: traces.len(), meta }
}

#[tauri::command]
pub async fn mem_pin(app: AppHandle, project: String, text: String) -> CmdResult<Pin> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let d = dir(&app, &project);
    std::fs::create_dir_all(&d).es()?;
    let mut pins: Vec<Pin> = read_json(d.join("pins.json"));
    let t = now_ms();
    let p = Pin { id: format!("p{t:x}"), t, text: text.trim().to_string() };
    pins.push(p.clone());
    write_json(d.join("pins.json"), &pins).es()?;
    let mut meta: Meta = read_json(d.join("meta.json"));
    if meta.project.is_empty() {
        meta.project = project;
        write_json(d.join("meta.json"), &meta).es()?;
    }
    Ok(p)
}

#[tauri::command]
pub async fn mem_list(app: AppHandle, project: String) -> CmdResult<Value> {
    let d = dir(&app, &project);
    let traces = read_traces(&d);
    let pins: Vec<Pin> = read_json(d.join("pins.json"));
    let meta: Meta = read_json(d.join("meta.json"));
    let sessions: HashSet<&str> = traces.iter().map(|t| t.session.as_str()).collect();
    let recent: Vec<&Trace> = traces.iter().rev().take(300).collect();
    Ok(json!({"pins": pins, "recent": recent, "turns": traces.len(), "sessions": sessions.len(), "meta": meta}))
}

/// Forget one pin or turn (by id), or everything for this project (id = None).
#[tauri::command]
pub async fn mem_forget(app: AppHandle, project: String, id: Option<String>) -> CmdResult<()> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let d = dir(&app, &project);
    match id {
        None => {
            if d.starts_with(data_dir(&app).join("memory")) {
                let _ = std::fs::remove_dir_all(&d);
            }
        }
        Some(id) => {
            let mut pins: Vec<Pin> = read_json(d.join("pins.json"));
            let before = pins.len();
            pins.retain(|p| p.id != id);
            if pins.len() != before {
                write_json(d.join("pins.json"), &pins).es()?;
                return Ok(());
            }
            // keep every other line exactly as it was (also ones we can't parse)
            let lines: Vec<String> = read_lines(&d).into_iter().filter(|l| serde_json::from_str::<Trace>(l).map(|t| t.id != id).unwrap_or(true)).collect();
            let tmp = d.join("traces.jsonl.tmp");
            {
                let mut f = std::fs::File::create(&tmp).es()?;
                for l in &lines {
                    writeln!(f, "{l}").es()?;
                }
            }
            std::fs::rename(tmp, d.join("traces.jsonl")).es()?;
        }
    }
    Ok(())
}

/// Remember the Claude Code conversation of this project (to continue it later).
#[tauri::command]
pub async fn mem_set_cc(app: AppHandle, project: String, session: String, model: String) -> CmdResult<()> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let d = dir(&app, &project);
    std::fs::create_dir_all(&d).es()?;
    let mut meta: Meta = read_json(d.join("meta.json"));
    meta.project = project;
    meta.cc_session = session;
    meta.cc_session_at = now_ms();
    meta.cc_model = model;
    write_json(d.join("meta.json"), &meta).es()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finds_entities() {
        let e = entities("We fine-tuned GLiNER on the AFP data in chapter3.tex; see \\cite{zaratiana2024gliner,vaswani2017} and \\label{sec:method}. Named Entity Recognition matters. Call it “span extraction”.");
        for want in ["gliner", "afp", "chapter3.tex", "zaratiana2024gliner", "vaswani2017", "sec:method", "named entity recognition", "span extraction"] {
            assert!(e.contains(&want.to_string()), "{want} missing in {e:?}");
        }
        assert_eq!(day(0), "1970-01-01");
    }
    #[test]
    fn recalls_by_entity_and_time() {
        let mk = |t: u64, s: &str, role: &str, text: &str| Trace { id: format!("{t}"), t, session: s.into(), role: role.into(), text: text.into(), ..Default::default() };
        let dms = 86_400_000u64;
        let tr = vec![
            mk(dms, "a", "user", "How should I describe the GLiNER baseline in chapter3.tex?"),
            mk(dms + 1, "a", "assistant", "Describe GLiNER as a span-based NER model; cite zaratiana2024gliner."),
            mk(2 * dms, "b", "user", "Fix the table formatting in results.tex"),
            mk(2 * dms + 1, "b", "assistant", "I used booktabs and aligned the decimal columns."),
            mk(3 * dms, "c", "user", "Let's make the abstract shorter."),
            mk(3 * dms + 1, "c", "assistant", "Cut it to 180 words, keeping the AFP collaboration sentence."),
        ];
        let pins = vec![Pin { id: "p".into(), t: 0, text: "British spelling throughout".into() }];
        let r = recall_core(&tr, &pins, Meta::default(), "what did we decide about GLiNER?", "now", 4000, None);
        assert!(r.text.contains("British spelling"), "{}", r.text);
        assert!(r.text.contains("span-based NER"), "{}", r.text);
        assert!(!r.text.contains("booktabs"), "{}", r.text);
        // "where were we" → the latest session comes back
        let r2 = recall_core(&tr, &[], Meta::default(), "where were we?", "now", 4000, None);
        assert!(r2.text.contains("180 words"), "{}", r2.text);
        // the current session is never recalled
        let r3 = recall_core(&tr, &[], Meta::default(), "abstract shorter", "c", 4000, None);
        assert!(!r3.text.contains("180 words"), "{}", r3.text);
        assert_eq!(day(1_793_404_800_000), "2026-10-31");
        assert_eq!(day(951_782_400_000), "2000-02-29");
    }
}
