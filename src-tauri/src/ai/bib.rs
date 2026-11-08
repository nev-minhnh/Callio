//! Citation checker: verifies every entry of a .bib file against Crossref / OpenAlex, so
//! invented references or wrong DOIs are caught before submission. No AI involved.
use super::tools::{crossref, title_similarity};
use crate::util::{CmdResult, ErrStr};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Default)]
pub struct BibEntry {
    pub key: String,
    pub kind: String,
    pub fields: HashMap<String, String>,
    pub line: usize,
}

/// Small, forgiving BibTeX parser (nested braces, quotes, @comment/@string skipped).
pub fn parse_bib(text: &str) -> Vec<BibEntry> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(off) = text[i..].find('@') {
        let start = i + off;
        let line = text[..start].matches('\n').count() + 1;
        let mut j = start + 1;
        while j < b.len() && (b[j] as char).is_ascii_alphabetic() {
            j += 1;
        }
        let kind = text[start + 1..j].to_lowercase();
        while j < b.len() && (b[j] as char).is_whitespace() {
            j += 1;
        }
        if j >= b.len() || (b[j] != b'{' && b[j] != b'(') {
            i = start + 1;
            continue;
        }
        // find the matching close of the entry's own bracket type
        let (open, close) = if b[j] == b'{' { (b'{', b'}') } else { (b'(', b')') };
        let mut depth = 0i32;
        let mut k = j;
        while k < b.len() {
            if b[k] == open {
                depth += 1;
            } else if b[k] == close {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            k += 1;
        }
        let body = &text[j + 1..k.min(text.len())];
        i = (k + 1).min(text.len());
        if kind == "comment" || kind == "string" || kind == "preamble" {
            continue;
        }
        let Some(comma) = body.find(',') else { continue };
        let key = body[..comma].trim().to_string();
        let mut fields = HashMap::new();
        let rest = &body[comma + 1..];
        let rb = rest.as_bytes();
        let mut p = 0;
        while p < rb.len() {
            while p < rb.len() && (rb[p] as char).is_whitespace() || (p < rb.len() && rb[p] == b',') {
                p += 1;
            }
            let ns = p;
            while p < rb.len() && rb[p] != b'=' && rb[p] != b',' {
                p += 1;
            }
            if p >= rb.len() || rb[p] != b'=' {
                break;
            }
            let name = rest[ns..p].trim().to_lowercase();
            p += 1;
            while p < rb.len() && (rb[p] as char).is_whitespace() {
                p += 1;
            }
            let vs = p;
            let value;
            if p < rb.len() && rb[p] == b'{' {
                let mut d = 0;
                while p < rb.len() {
                    if rb[p] == b'{' {
                        d += 1;
                    } else if rb[p] == b'}' {
                        d -= 1;
                        if d == 0 {
                            break;
                        }
                    }
                    p += 1;
                }
                value = rest[vs + 1..p.min(rest.len())].to_string();
                p += 1;
            } else if p < rb.len() && rb[p] == b'"' {
                p += 1;
                let s0 = p;
                let mut d = 0;
                // a quote inside braces ({\"u}) doesn't end the value
                while p < rb.len() && !(rb[p] == b'"' && d == 0) {
                    if rb[p] == b'{' {
                        d += 1;
                    } else if rb[p] == b'}' {
                        d -= 1;
                    }
                    p += 1;
                }
                value = rest[s0..p.min(rest.len())].to_string();
                p += 1;
            } else {
                while p < rb.len() && rb[p] != b',' {
                    p += 1;
                }
                value = rest[vs..p].trim().to_string();
            }
            let clean = value.replace(['{', '}'], "").split_whitespace().collect::<Vec<_>>().join(" ");
            fields.insert(name, clean);
        }
        out.push(BibEntry { key, kind, fields, line });
    }
    out
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BibCheck {
    key: String,
    line: usize,
    title: String,
    /// "verified" | "check" | "problem" | "skipped"
    level: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    found: Option<Value>,
    /// the matching paper in the author's Callio library
    #[serde(skip_serializing_if = "Option::is_none")]
    library: Option<Value>,
    /// Perplexity's (academic search) verdict, when a deep check ran
    #[serde(skip_serializing_if = "Option::is_none")]
    deep: Option<Value>,
}

async fn check_entry(e: &BibEntry) -> BibCheck {
    let title = e.fields.get("title").cloned().unwrap_or_default();
    let year: Option<i64> = e.fields.get("year").and_then(|y| y.chars().filter(|c| c.is_ascii_digit()).take(4).collect::<String>().parse().ok());
    let mk = |level: &str, message: String, found: Option<Value>| BibCheck { key: e.key.clone(), line: e.line, title: title.clone(), level: level.into(), message, found, library: None, deep: None };
    if ["misc", "online", "software", "manual", "unpublished", "techreport"].contains(&e.kind.as_str()) && !e.fields.contains_key("doi") {
        return mk("skipped", format!("@{} without DOI — not checked automatically", e.kind), None);
    }
    if let Some(doi) = e.fields.get("doi") {
        match crossref(doi).await {
            Ok(Some(rec)) => {
                let sim = title_similarity(&title, rec["title"].as_str().unwrap_or(""));
                let ry = rec["year"].as_i64();
                return if sim < 0.5 {
                    mk("problem", format!("DOI {doi} belongs to a different work: “{}”", rec["title"].as_str().unwrap_or("?")), Some(rec))
                } else if sim < 0.8 || (year.is_some() && ry.is_some() && year != ry) {
                    mk("check", format!("DOI found, but metadata differs (title match {:.0}%, year {} vs {})", sim * 100.0, year.map(|y| y.to_string()).unwrap_or("?".into()), ry.map(|y| y.to_string()).unwrap_or("?".into())), Some(rec))
                } else {
                    mk("verified", "DOI and title match".into(), Some(rec))
                };
            }
            Ok(None) => return mk("problem", format!("DOI {doi} doesn't exist (Crossref has no record)"), None),
            Err(err) => return mk("check", format!("Couldn't check DOI: {err}"), None),
        }
    }
    if title.is_empty() {
        return mk("check", "No title or DOI to check".into(), None);
    }
    match super::tools::verify_citation(None, Some(&title), e.fields.get("author").map(|s| s.as_str()), year).await {
        Ok(v) => {
            let st = v["status"].as_str().unwrap_or("");
            let rec = v.get("record").or(v.get("closest")).cloned();
            match st {
                "verified" => mk("verified", "Found with matching title and year (no DOI in .bib — consider adding it)".into(), rec),
                "found_year_differs" => mk("check", "Found, but the year differs".into(), rec),
                "likely_match" => mk("check", format!("Only a similar title was found ({:.0}% match)", v["title_similarity"].as_f64().unwrap_or(0.0) * 100.0), rec),
                _ => mk("problem", "Not found in Crossref/OpenAlex — may not exist or be mis-titled".into(), rec),
            }
        }
        Err(err) => mk("check", format!("Couldn't check: {err}"), None),
    }
}

/// The author's library first: a paper they saved (usually with its PDF and publisher metadata)
/// is strong evidence; it's checked against the entry's DOI, title and year.
fn library_check(app: &AppHandle, e: &BibEntry) -> Option<BibCheck> {
    let title = e.fields.get("title").cloned().unwrap_or_default();
    let p = crate::library::lookup(app, e.fields.get("doi").map(|s| s.as_str()), Some(&title))?;
    let year: Option<i32> = e.fields.get("year").and_then(|y| y.chars().filter(|c| c.is_ascii_digit()).take(4).collect::<String>().parse().ok());
    let sim = super::tools::title_similarity(&title, &p.title);
    let lib = json!({"id": p.id, "key": p.key, "title": p.title, "year": p.year, "doi": p.doi, "pdf": p.pdf});
    let entry_doi = e.fields.get("doi").map(|d| super::tools::clean_doi(d)).filter(|d| !d.is_empty());
    let doi_conflict = entry_doi.as_ref().map(|d| !p.doi.eq_ignore_ascii_case(d)).unwrap_or(false);
    let (level, message) = if sim < 0.6 {
        ("problem", format!("The DOI belongs to “{}” in your library — a different title", p.title))
    } else if doi_conflict {
        // a wrong DOI with the right title is exactly what this check must catch
        ("check", if p.doi.is_empty() { "In your library, but without a DOI to compare".to_string() } else { format!("In your library with a different DOI ({})", p.doi) })
    } else if year.is_some() && p.year.is_some() && year != p.year {
        ("check", format!("In your library, but the year differs ({} there)", p.year.unwrap()))
    } else {
        ("verified", format!("Matches a paper in your library{}", if p.pdf { " (with its PDF)" } else { "" }))
    };
    Some(BibCheck { key: e.key.clone(), line: e.line, title, level: level.into(), message, found: None, library: Some(lib), deep: None })
}

/// Ask Perplexity (academic search mode) whether a reference exists and what its real details are.
async fn deep_check(e: &BibEntry, model: &str) -> Result<Value, String> {
    let key = crate::settings::get_secret_value("ai-key-perplexity").ok_or("Add a Perplexity API key in Settings → AI to use the deep check")?;
    let f = |k: &str| e.fields.get(k).cloned().unwrap_or_default();
    let q = format!(
        "Check whether this scholarly reference exists. Title: \"{}\". Authors: {}. Year: {}. Venue: {}. DOI: {}.\nReply with ONLY a JSON object: {{\"exists\": true|false|null, \"title\": \"…\", \"authors\": \"…\", \"year\": 0, \"venue\": \"…\", \"doi\": \"…\", \"note\": \"one sentence: what matches or differs\"}}. Use null for exists if you cannot tell. Never guess a DOI.",
        f("title"), f("author"), f("year"), [f("journal"), f("booktitle")].concat(), f("doi")
    );
    let body = json!({"model": model, "messages": [{"role": "user", "content": q}], "search_mode": "academic", "temperature": 0, "max_tokens": 600});
    let r = super::tools::client().post("https://api.perplexity.ai/chat/completions").bearer_auth(key).json(&body).send().await.map_err(|e| e.to_string())?;
    let status = r.status();
    let v: Value = r.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(v["error"]["message"].as_str().unwrap_or("Perplexity error").to_string());
    }
    let text = v["choices"][0]["message"]["content"].as_str().unwrap_or("");
    // the model may wrap JSON in prose or think first: take the last {...}
    let text = text.rsplit("</think>").next().unwrap_or(text);
    let j = text.rfind('}').and_then(|z| text[..=z].rfind("{\"exists\"").or_else(|| text[..=z].find('{')).map(|a| &text[a..=z])).and_then(|s| serde_json::from_str::<Value>(s).ok()).unwrap_or(json!({"note": text.chars().take(400).collect::<String>()}));
    let sources: Vec<Value> = v["search_results"].as_array().cloned().unwrap_or_default().into_iter().take(5).map(|s| json!({"title": s["title"], "url": s["url"]})).chain(v["citations"].as_array().cloned().unwrap_or_default().into_iter().take(5).map(|u| json!({"url": u}))).take(5).collect();
    Ok(json!({"verdict": j, "sources": sources, "model": model}))
}

/// Check every entry; progress is emitted as "bib-progress" {done, total, key}.
/// `deep`: "" (off), "sonar-pro", or "sonar-deep-research" — Perplexity re-checks doubtful entries.
#[tauri::command]
pub async fn verify_bib(app: AppHandle, path: String, only_keys: Option<Vec<String>>, deep: Option<String>) -> CmdResult<Vec<BibCheck>> {
    let text = std::fs::read_to_string(&path).es()?;
    let mut entries = parse_bib(&text);
    if let Some(keys) = only_keys.filter(|k| !k.is_empty()) {
        entries.retain(|e| keys.contains(&e.key));
    }
    let total = entries.len();
    let mut out = Vec::with_capacity(total);
    for (n, e) in entries.iter().enumerate() {
        let _ = app.emit("bib-progress", serde_json::json!({"done": n, "total": total, "key": e.key}));
        let mut c = match library_check(&app, e) {
            Some(c) if c.level == "verified" => c,
            Some(lib) => {
                // in the library but something differs: what does the publisher say?
                let mut c = check_entry(e).await;
                c.library = lib.library;
                c.message = format!("{} · {}", lib.message, c.message);
                if lib.level == "problem" { c.level = "problem".into(); }
                c
            }
            None => check_entry(e).await,
        };
        if let Some(model) = deep.as_deref().filter(|m| !m.is_empty()) {
            if c.level != "verified" {
                let _ = app.emit("bib-progress", serde_json::json!({"done": n, "total": total, "key": e.key, "deep": true}));
                match deep_check(e, model).await {
                    Ok(d) => {
                        let ex = d["verdict"]["exists"].as_bool();
                        let note = d["verdict"]["note"].as_str().unwrap_or("").to_string();
                        c.message = format!("{} · Perplexity: {}{}", c.message, match ex { Some(true) => "found it", Some(false) => "couldn't find it", None => "unsure" }, if note.is_empty() { String::new() } else { format!(" — {note}") });
                        if ex == Some(false) && c.level == "check" { c.level = "problem".into(); }
                        c.deep = Some(d);
                    }
                    Err(err) => c.message = format!("{} · Deep check failed: {err}", c.message),
                }
            }
        }
        out.push(c);
        // be polite to the free APIs
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    }
    let _ = app.emit("bib-progress", serde_json::json!({"done": total, "total": total}));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses() {
        let t = "@comment{x}\n@article{knuth84,\n title = {The {TeX}book (sic},\n author=\"M{\\\"u}ller, Donald\", year = 1984,\n doi={10.1/x}}\n@misc{web, title={A site}}";
        let e = parse_bib(t);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].key, "knuth84");
        assert_eq!(e[0].fields["title"], "The TeXbook (sic");
        assert_eq!(e[0].fields["author"], "M\\\"uller, Donald");
        assert_eq!(e[0].fields["year"], "1984");
        assert_eq!(e[0].fields["doi"], "10.1/x");
        assert_eq!(e[0].line, 2);
        assert_eq!(e[1].kind, "misc");
    }
}
