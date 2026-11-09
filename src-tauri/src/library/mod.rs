//! Paper library (a small Zotero): papers with metadata, their PDFs and full text, collections,
//! and which drafts cite which papers. Stored as plain files under the app's data folder:
//!   library/library.json           metadata, collections
//!   library/papers/<id>/paper.pdf  the PDF
//!   library/papers/<id>/text.txt   its text, pages separated by form feeds (\f)
//! Full-text search is an in-memory BM25 index built on first use.
pub mod server;

pub mod resolve;
use crate::ai::tools::{clean_doi, title_similarity};
use crate::settings::data_dir;
use crate::textindex::{snippet, Index};
use crate::util::{CmdResult, ErrStr};
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Paper {
    pub id: String,
    /// BibTeX citation key
    pub key: String,
    pub title: String,
    /// the title is only a guess (the file name): better details may replace it
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub title_guess: bool,
    /// "Family, Given"
    pub authors: Vec<String>,
    pub year: Option<i32>,
    /// BibTeX entry type: article, inproceedings, book, misc, …
    #[serde(rename = "type")]
    pub kind: String,
    pub venue: String,
    pub volume: String,
    pub issue: String,
    pub pages: String,
    pub publisher: String,
    pub doi: String,
    pub arxiv: String,
    pub url: String,
    #[serde(rename = "abstract")]
    pub abstract_: String,
    pub tags: Vec<String>,
    pub collections: Vec<String>,
    pub notes: String,
    pub added: u64,
    pub modified: u64,
    pub pdf: bool,
    /// full text extracted and indexed
    pub text: bool,
    pub page_count: u32,
    /// drafts (file paths) that cite this paper
    pub used_in: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub parent: Option<String>,
    /// drafts (file paths) attached to this collection
    pub drafts: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Library {
    pub papers: Vec<Paper>,
    pub collections: Vec<Collection>,
}

pub fn dir(app: &AppHandle) -> PathBuf {
    data_dir(app).join("library")
}
fn paper_dir(app: &AppHandle, id: &str) -> PathBuf {
    dir(app).join("papers").join(id)
}

static LIB: Mutex<Option<Library>> = Mutex::new(None);
/// The search index, built from the library as of a generation; any save bumps GEN.
static INDEX: Mutex<Option<std::sync::Arc<(Index, Vec<String>, u64)>>> = Mutex::new(None);
static GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Paper ids are generated hex strings; anything else is refused (they become folder names).
fn valid_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        bail!("invalid paper id");
    }
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Run `f` on the library (loaded on first use) — and save it if `f` changed something.
pub fn with<R>(app: &AppHandle, save: bool, f: impl FnOnce(&mut Library) -> R) -> Result<R> {
    let mut g = LIB.lock().unwrap_or_else(|e| e.into_inner());
    if g.is_none() {
        let p = dir(app).join("library.json");
        let lib = match std::fs::read_to_string(&p) {
            Ok(s) => serde_json::from_str(&s).map_err(|e| anyhow!("library.json is damaged ({e}); it was left untouched"))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Library::default(),
            Err(e) => return Err(e.into()),
        };
        *g = Some(lib);
    }
    let lib = g.as_mut().unwrap();
    let r = f(lib);
    if save {
        let d = dir(app);
        std::fs::create_dir_all(&d)?;
        let tmp = d.join("library.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(lib)?)?;
        std::fs::rename(tmp, d.join("library.json"))?;
        GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    Ok(r)
}

/// A paper in the library matching a DOI or (closely) a title — used by the citation check.
pub fn lookup(app: &AppHandle, doi: Option<&str>, title: Option<&str>) -> Option<Paper> {
    with(app, false, |l| {
        if let Some(d) = doi.map(clean_doi).filter(|d| !d.is_empty()) {
            if let Some(p) = l.papers.iter().find(|p| !p.doi.is_empty() && p.doi.eq_ignore_ascii_case(&d)) {
                return Some(p.clone());
            }
        }
        let t = title?.trim();
        if t.len() < 8 {
            return None;
        }
        l.papers.iter().find(|p| title_similarity(t, &p.title) >= 0.9).cloned()
    })
    .ok()
    .flatten()
}

// ---------------- keys and BibTeX ----------------

fn ascii_fold(s: &str) -> String {
    s.chars()
        .filter_map(|c| {
            let c = match c {
                'à'..='å' | 'ā' | 'ă' | 'ą' => 'a',
                'ç' | 'ć' | 'č' => 'c',
                'è'..='ë' | 'ē' | 'ę' | 'ě' => 'e',
                'ì'..='ï' | 'ī' => 'i',
                'ñ' | 'ń' | 'ň' => 'n',
                'ò'..='ö' | 'ø' | 'ō' | 'ő' => 'o',
                'ù'..='ü' | 'ū' | 'ů' | 'ű' => 'u',
                'ý' | 'ÿ' => 'y',
                'ś' | 'š' => 's',
                'ź' | 'ż' | 'ž' => 'z',
                'ł' => 'l',
                'ß' => 's',
                'đ' => 'd',
                c => c,
            };
            c.is_ascii_alphanumeric().then_some(c.to_ascii_lowercase())
        })
        .collect()
}

/// authorYEARword, e.g. vaswani2017attention — unique within the library.
pub fn make_key(p: &Paper, taken: &dyn Fn(&str) -> bool) -> String {
    let fam = p.authors.first().map(|a| a.split(',').next().unwrap_or(a).trim().rsplit(' ').next().unwrap_or("").to_string()).unwrap_or_default();
    let mut fam = ascii_fold(&fam);
    if fam.is_empty() {
        fam = "anon".into();
    }
    let year = p.year.map(|y| y.to_string()).unwrap_or_default();
    let word = p.title.split(|c: char| !c.is_alphanumeric()).map(ascii_fold).find(|w| w.len() > 3 && !["with", "from", "that", "this", "towards", "toward", "using", "into", "over", "under", "what", "when", "where", "which"].contains(&w.as_str())).unwrap_or_default();
    let base = format!("{fam}{year}{word}");
    if !taken(&base) {
        return base;
    }
    for c in 'a'..='z' {
        let k = format!("{base}{c}");
        if !taken(&k) {
            return k;
        }
    }
    format!("{base}{}", now_ms() % 10000)
}

/// Escape LaTeX's special characters that aren't escaped yet (imported .bib values already
/// contain LaTeX, web metadata doesn't), and make sure braces balance.
fn bib_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    let mut prev = '\0';
    for c in s.chars() {
        if "&%#_".contains(c) && prev != '\\' {
            out.push('\\');
        }
        out.push(c);
        prev = c;
    }
    let mut depth = 0i32;
    let mut ok = true;
    for c in out.chars() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth < 0 {
                    ok = false;
                }
            }
            _ => {}
        }
    }
    if !ok || depth != 0 {
        out = out.replace(['{', '}'], "");
    }
    out
}

/// Text that came from a web page or Crossref (not LaTeX): no HTML, no backslashes or braces,
/// and the characters LaTeX would act on written as text.
pub fn from_web(s: &str) -> String {
    let no_tags = regex_lite::Regex::new(r"<[^>]{0,200}>").unwrap().replace_all(s, "");
    let t = crate::util::html_unescape(&no_tags).replace(['\\', '{', '}'], "");
    let t = t.replace('$', "\\$").replace('^', "\\^{}").replace('~', "\\~{}");
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A BibTeX entry for a paper (always generated from the library's metadata, so edits there
/// are what gets cited).
pub fn bibtex(p: &Paper) -> String {
    let kind = if p.kind.is_empty() { "article" } else { p.kind.as_str() };
    let mut f: Vec<(&str, String)> = Vec::new();
    // double braces keep the title's capitalisation
    f.push(("title", format!("{{{}}}", bib_escape(&p.title))));
    if !p.authors.is_empty() {
        f.push(("author", p.authors.iter().map(|a| bib_escape(a)).collect::<Vec<_>>().join(" and ")));
    }
    if let Some(y) = p.year {
        f.push(("year", y.to_string()));
    }
    let venue_field = match kind {
        "inproceedings" | "incollection" | "conference" => "booktitle",
        "book" | "misc" | "techreport" | "phdthesis" | "mastersthesis" => "howpublished",
        _ => "journal",
    };
    if !p.venue.is_empty() {
        f.push((venue_field, bib_escape(&p.venue)));
    }
    for (k, v) in [("volume", &p.volume), ("number", &p.issue), ("pages", &p.pages), ("publisher", &p.publisher)] {
        if !v.is_empty() {
            let v = if k == "pages" { regex_lite::Regex::new(r"\s*[-–—]+\s*").unwrap().replace_all(v, "--").to_string() } else { v.clone() };
            f.push((k, bib_escape(&v)));
        }
    }
    let plain = |v: &str| v.replace(['{', '}', '\\'], "");
    if !p.doi.is_empty() {
        f.push(("doi", plain(&p.doi)));
    }
    if !p.arxiv.is_empty() {
        f.push(("eprint", plain(&p.arxiv)));
        f.push(("archivePrefix", "arXiv".into()));
    }
    if !p.url.is_empty() && p.doi.is_empty() {
        f.push(("url", plain(&p.url)));
    }
    let body = f.iter().map(|(k, v)| format!("  {k} = {{{v}}}")).collect::<Vec<_>>().join(",\n");
    format!("@{kind}{{{},\n{body}\n}}\n", p.key)
}

// ---------------- metadata lookup ----------------

fn client() -> reqwest::Client {
    reqwest::Client::builder().user_agent("Callio/0.4 (paper library; mailto:callio@localhost)").connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(120)).build().unwrap()
}

/// Fill a paper's fields from Crossref (by DOI).
async fn from_crossref(p: &mut Paper) -> Result<()> {
    let v: Value = client().get(format!("https://api.crossref.org/works/{}", urlencoding::encode(&p.doi))).send().await?.error_for_status()?.json().await?;
    let m = &v["message"];
    let s = |x: &Value| x.as_str().unwrap_or("").trim().to_string();
    if p.title.is_empty() {
        p.title = s(&m["title"][0]);
    }
    if p.authors.is_empty() {
        p.authors = m["author"].as_array().into_iter().flatten().map(|a| if a["family"].is_string() { format!("{}, {}", s(&a["family"]), s(&a["given"])).trim_end_matches(", ").to_string() } else { s(&a["name"]) }).filter(|a| !a.is_empty()).collect();
    }
    if p.year.is_none() {
        p.year = m["issued"]["date-parts"][0][0].as_i64().or(m["published"]["date-parts"][0][0].as_i64()).map(|y| y as i32);
    }
    if p.venue.is_empty() {
        p.venue = s(&m["container-title"][0]);
    }
    for (dst, k) in [(&mut p.volume, "volume"), (&mut p.issue, "issue"), (&mut p.pages, "page"), (&mut p.publisher, "publisher")] {
        if dst.is_empty() {
            *dst = s(&m[k]);
        }
    }
    if p.abstract_.is_empty() {
        p.abstract_ = crate::util::html_unescape(&regex_lite::Regex::new(r"<[^>]+>").unwrap().replace_all(&s(&m["abstract"]), "")).trim().to_string();
    }
    if p.kind.is_empty() {
        p.kind = match m["type"].as_str().unwrap_or("") {
            "proceedings-article" => "inproceedings",
            "book" | "monograph" => "book",
            "book-chapter" => "incollection",
            "posted-content" => "misc",
            "dissertation" => "phdthesis",
            "report" => "techreport",
            _ => "article",
        }
        .into();
    }
    Ok(())
}

/// Fill from the arXiv API (Atom).
async fn from_arxiv(p: &mut Paper) -> Result<()> {
    let x = client().get(format!("https://export.arxiv.org/api/query?id_list={}", urlencoding::encode(&p.arxiv))).send().await?.error_for_status()?.text().await?;
    let entry = x.split("<entry>").nth(1).ok_or_else(|| anyhow!("arXiv has no record for {}", p.arxiv))?;
    let tag = |t: &str| -> String {
        entry.split(&format!("<{t}")).nth(1).and_then(|r| r.split_once('>')).and_then(|(_, r)| r.split(&format!("</{t}>")).next()).map(|v| v.split_whitespace().collect::<Vec<_>>().join(" ")).unwrap_or_default()
    };
    if p.title.is_empty() {
        p.title = crate::util::html_unescape(&tag("title"));
    }
    if p.abstract_.is_empty() {
        p.abstract_ = crate::util::html_unescape(&tag("summary"));
    }
    if p.authors.is_empty() {
        p.authors = entry.split("<author>").skip(1).filter_map(|a| a.split("<name>").nth(1)?.split("</name>").next().map(|n| {
            let n = crate::util::html_unescape(n.trim());
            match n.rsplit_once(' ') { Some((g, f)) => format!("{f}, {g}"), None => n }
        })).collect();
    }
    if p.year.is_none() {
        p.year = tag("published").get(0..4).and_then(|y| y.parse().ok());
    }
    if p.doi.is_empty() {
        p.doi = tag("arxiv:doi");
    }
    if p.kind.is_empty() {
        p.kind = "misc".into();
    }
    if p.venue.is_empty() {
        p.venue = format!("arXiv:{}", p.arxiv);
    }
    Ok(())
}

fn detect_ids(p: &mut Paper, extra: &str) {
    let doi_re = regex_lite::Regex::new(r"(?i)\b(10\.\d{4,9}/[^\s?#&]+)").unwrap();
    let arx_re = regex_lite::Regex::new(r"(?i)arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5}|[a-z\-]+/\d{7})").unwrap();
    if p.doi.is_empty() {
        if let Some(m) = doi_re.captures(&format!("{} {}", p.url, extra)) {
            p.doi = m[1].trim_end_matches(['.', ',', ';', ')']).trim_end_matches(".pdf").to_string();
        }
    }
    p.doi = clean_doi(&p.doi);
    if p.arxiv.is_empty() {
        if let Some(m) = arx_re.captures(&format!("{} {}", p.url, extra)) {
            p.arxiv = m[1].to_string();
        }
    }
    p.arxiv = regex_lite::Regex::new(r"v\d+$").unwrap().replace(p.arxiv.trim().trim_start_matches("arXiv:"), "").to_string();
    // arXiv's own DOIs (10.48550/arXiv.xxxx) are just the arXiv id
    if p.arxiv.is_empty() {
        if let Some(rest) = p.doi.to_lowercase().strip_prefix("10.48550/arxiv.") {
            p.arxiv = rest.to_string();
        }
    }
}

// ---------------- adding ----------------

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AddRequest {
    pub meta: Paper,
    /// PDF bytes, base64 (from the browser extension or a dropped file)
    pub pdf_base64: Option<String>,
    /// local PDF file to copy in
    pub pdf_path: Option<String>,
    /// PDF to download
    pub pdf_url: Option<String>,
    /// page the paper was saved from
    pub page_url: Option<String>,
    pub collection: Option<String>,
    /// look up missing metadata online (Crossref / arXiv)
    pub lookup: Option<bool>,
    /// fields are LaTeX already (imported from a .bib) — otherwise they're plain text
    #[serde(skip)]
    pub latex: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AddResult {
    pub id: String,
    pub title: String,
    pub duplicate: bool,
    pub pdf: bool,
    pub needs_text: bool,
    /// a PDF link that needs the user to sign in (paywall / institutional access)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    /// where the PDF came from
    #[serde(skip_serializing_if = "String::is_empty")]
    pub pdf_source: String,
    /// details were found (title + authors)
    pub has_meta: bool,
}

/// Make plain-text metadata safe to put in a .bib (see `from_web`).
fn sanitize(p: &mut Paper) {
    for f in [&mut p.title, &mut p.venue, &mut p.volume, &mut p.issue, &mut p.pages, &mut p.publisher, &mut p.abstract_, &mut p.notes] {
        *f = from_web(f);
    }
    for a in p.authors.iter_mut() {
        *a = from_web(a);
    }
    p.authors.retain(|a| !a.is_empty());
    for t in p.tags.iter_mut() {
        *t = from_web(t);
    }
    p.doi = p.doi.replace(['{', '}', '\\', ' '], "");
}

const PLACEHOLDER: &str = "Untitled paper";

/// Is `q` (in the library) the same work as `p`?
fn same_paper(q: &Paper, p: &Paper) -> bool {
    if !p.doi.is_empty() && !q.doi.is_empty() {
        return q.doi.eq_ignore_ascii_case(&p.doi);
    }
    if !p.arxiv.is_empty() && !q.arxiv.is_empty() {
        return q.arxiv == p.arxiv;
    }
    // titles only when both are real titles and nothing contradicts
    let real = |t: &str| t.len() >= 12 && t != PLACEHOLDER;
    real(&p.title) && real(&q.title) && q.year == p.year && title_similarity(&q.title, &p.title) >= 0.95
}

pub async fn add(app: &AppHandle, req: AddRequest) -> Result<AddResult> {
    let mut p = req.meta;
    p.id.clear();
    p.used_in.clear();
    p.pdf = false;
    p.text = false;
    if !req.latex {
        sanitize(&mut p);
    }
    p.title = p.title.split_whitespace().collect::<Vec<_>>().join(" ");
    if p.url.is_empty() {
        p.url = req.page_url.clone().unwrap_or_default();
    }
    let mut pdf_url = req.pdf_url.clone().unwrap_or_default();
    let mut page_pdf = String::new();
    let lookup = req.lookup.unwrap_or(true);
    let have_bytes = req.pdf_base64.as_deref().map(|b| !b.is_empty()).unwrap_or(false) || req.pdf_path.as_deref().map(|p| !p.is_empty()).unwrap_or(false);
    // a paper's page (or a PDF whose page we know): read its citation meta tags, like Zotero
    if lookup {
        let page = match req.page_url.as_deref().filter(|u| u.starts_with("http")) {
            Some(u) if u != pdf_url => Some(u.to_string()),
            _ => resolve::page_for_pdf(&pdf_url),
        };
        if let Some(u) = page {
            resolve::progress(app, &format!("Reading {}…", resolve::host_of(&u)));
            match resolve::fetch_page(&u).await {
                Ok((final_url, html)) => {
                    let m = resolve::parse_meta(&html, &final_url);
                    resolve::apply_meta(&mut p, &m);
                    page_pdf = m.pdf_url;
                    if p.url.is_empty() || p.url == pdf_url {
                        p.url = final_url;
                    }
                }
                Err(e) => {
                    if let Some(u2) = e.to_string().strip_prefix("PDF:") {
                        if pdf_url.is_empty() {
                            pdf_url = u2.to_string();
                        }
                    }
                }
            }
        }
    }
    detect_ids(&mut p, &pdf_url);
    let mut doi_from_name = false;
    // a file named after its identifier (ACL Anthology "2025.findings-naacl.239.pdf", arXiv "2301.01234v2.pdf")
    if let Some(stem) = req.pdf_path.as_deref().and_then(|f| std::path::Path::new(f).file_stem()).map(|s| s.to_string_lossy().to_string()) {
        if p.doi.is_empty() && p.arxiv.is_empty() {
            // new style "2025.findings-naacl.239" (the venue has letters), old style "P19-1001"
            let acl = regex_lite::Regex::new(r"^(\d{4}\.[a-z]+[a-z0-9]*(?:-[a-z0-9]+)*\.\d+|[A-Z]\d{2}-\d{4})$").unwrap();
            let arx = regex_lite::Regex::new(r"^(\d{4}\.\d{4,5})(v\d+)?$").unwrap();
            if acl.is_match(&stem) {
                p.doi = format!("10.18653/v1/{stem}");
                doi_from_name = true;
            } else if let Some(c) = arx.captures(&stem) {
                p.arxiv = c[1].to_string();
            }
        }
    }
    if lookup {
        resolve::progress(app, "Looking up the details (Crossref / arXiv)…");
        let mut q = Paper { doi: p.doi.clone(), arxiv: p.arxiv.clone(), ..Default::default() };
        if !q.doi.is_empty() && !q.doi.to_lowercase().starts_with("10.48550/") {
            let _ = from_crossref(&mut q).await;
        }
        // a DOI made from the file name is kept only when Crossref knows it
        if doi_from_name && q.title.is_empty() {
            p.doi.clear();
            q.doi.clear();
        }
        if !q.arxiv.is_empty() && (p.title.is_empty() || p.authors.is_empty() || p.abstract_.is_empty()) {
            let _ = from_arxiv(&mut q).await;
        }
        // the publisher's / arXiv's metadata fills what the page didn't give
        sanitize(&mut q);
        macro_rules! fill { ($($f:ident),*) => { $( if p.$f.is_empty() { p.$f = q.$f.clone(); } )* } }
        fill!(title, authors, venue, volume, issue, pages, publisher, abstract_, kind, doi);
        if p.year.is_none() {
            p.year = q.year;
        }
    }
    // the PDF
    let (mut login, mut pdf_source): (Option<String>, String) = (None, String::new());
    let _ = have_bytes;
    let pdf: Option<Vec<u8>> = if let Some(b) = req.pdf_base64.filter(|b| !b.is_empty()) {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(b.trim()).map_err(|_| anyhow!("the PDF data was damaged in transfer"))?;
        drop(b);
        Some(bytes)
    } else if let Some(path) = req.pdf_path.as_deref().filter(|p| !p.is_empty()) {
        Some(std::fs::read(path)?)
    } else if lookup || pdf_url.starts_with("http") {
        // the given link first, then the page's PDF link and the open-access copies
        let mut cands: Vec<String> = vec![];
        if pdf_url.starts_with("http") {
            cands.push(pdf_url.clone());
        }
        if lookup {
            resolve::progress(app, "Looking for the PDF…");
            for c in resolve::pdf_candidates(&p, &page_pdf).await {
                if !cands.contains(&c) {
                    cands.push(c);
                }
            }
        }
        let mut got = None;
        for c in cands.iter().take(8) {
            resolve::progress(app, &format!("Downloading the PDF from {}…", resolve::host_of(c)));
            match resolve::fetch_pdf(c).await {
                Ok(b) => {
                    pdf_source = resolve::host_of(c);
                    got = Some(b);
                    break;
                }
                Err(e) if e.to_string() == "LOGIN" && login.is_none() => login = Some(c.clone()),
                Err(_) => {}
            }
        }
        got
    } else {
        None
    };
    let pdf = pdf.filter(|b| b.starts_with(b"%PDF") || b.windows(5).take(1024).any(|w| w == b"%PDF-"));
    if pdf.is_some() {
        login = None;
    }
    // a PDF on its own: its DOI (or title) gives the details
    if lookup && p.doi.is_empty() && (p.title.is_empty() || p.authors.is_empty()) {
        if let Some(d) = pdf.as_deref().and_then(resolve::doi_in_pdf) {
            p.doi = clean_doi(&d);
            let mut q = Paper { doi: p.doi.clone(), ..Default::default() };
            if from_crossref(&mut q).await.is_ok() {
                sanitize(&mut q);
                macro_rules! fill { ($($f:ident),*) => { $( if p.$f.is_empty() { p.$f = q.$f.clone(); } )* } }
                fill!(title, authors, venue, volume, issue, pages, publisher, abstract_, kind);
                if p.year.is_none() {
                    p.year = q.year;
                }
            }
        }
    }
    if p.title.is_empty() {
        if let Some(path) = req.pdf_path.as_deref() {
            p.title = std::path::Path::new(path).file_stem().map(|s| s.to_string_lossy().replace(['_', '-'], " ")).unwrap_or_default();
            p.title_guess = !p.title.is_empty();
        }
    }
    if p.title.is_empty() && p.doi.is_empty() && pdf.is_none() {
        bail!("Nothing to add: no title, DOI or PDF was found on that page");
    }
    if p.title.is_empty() {
        p.title = PLACEHOLDER.into();
    }
    // write the PDF before taking the library lock (it can be large)
    let staged = match &pdf {
        Some(b) => {
            let d = dir(app).join("incoming");
            std::fs::create_dir_all(&d)?;
            let f = d.join(format!("{:x}.pdf", now_ms()));
            std::fs::write(&f, b)?;
            Some(f)
        }
        None => None,
    };
    drop(pdf);
    let app2 = app.clone();
    let collection = req.collection.clone();
    let staged2 = staged.clone();
    let r = with(app, true, move |lib| -> Result<(String, String, bool, bool, bool)> {
        let existing = lib.papers.iter().position(|q| same_paper(q, &p));
        let idx = match existing {
            Some(i) => i,
            None => {
                p.id = format!("{:x}", now_ms()) + &crate::util::sha256_hex(format!("{}{}{}", p.title, p.doi, now_ms()).as_bytes())[..6];
                let keys: std::collections::HashSet<String> = lib.papers.iter().map(|q| q.key.to_lowercase()).collect();
                if p.key.is_empty() || keys.contains(&p.key.to_lowercase()) || !p.key.chars().all(|c| c.is_ascii_alphanumeric() || "-_:.".contains(c)) {
                    p.key = make_key(&p, &|k| keys.contains(&k.to_lowercase()));
                }
                p.added = now_ms();
                lib.papers.push(p.clone());
                lib.papers.len() - 1
            }
        };
        let q = &mut lib.papers[idx];
        if existing.is_some() {
            // fill what the existing entry lacks
            macro_rules! fill { ($($f:ident),*) => { $( if q.$f.is_empty() { q.$f = p.$f.clone(); } )* } }
            fill!(doi, arxiv, url, venue, volume, issue, pages, publisher, abstract_, authors);
            if q.year.is_none() {
                q.year = p.year;
            }
            if (q.title == PLACEHOLDER || q.title_guess) && p.title != PLACEHOLDER && !p.title_guess {
                q.title = p.title.clone();
                q.title_guess = false;
            }
        }
        if let Some(c) = &collection {
            if !c.is_empty() && !q.collections.contains(c) {
                q.collections.push(c.clone());
            }
        }
        for t in &p.tags {
            if !q.tags.contains(t) {
                q.tags.push(t.clone());
            }
        }
        q.modified = now_ms();
        let id = q.id.clone();
        let mut stored = false;
        if let Some(f) = &staged2 {
            if !q.pdf {
                let d = paper_dir(&app2, &id);
                std::fs::create_dir_all(&d)?;
                std::fs::rename(f, d.join("paper.pdf")).or_else(|_| std::fs::copy(f, d.join("paper.pdf")).map(|_| ()))?;
                q.pdf = true;
                q.text = false;
                stored = true;
            }
        }
        Ok((id, q.title.clone(), existing.is_some(), q.pdf && !q.text, stored))
    });
    if let Some(f) = staged {
        let _ = std::fs::remove_file(f);
    }
    let (id, title, duplicate, needs_text, stored) = r??;
    let _ = app.emit("library-changed", json!({"id": id, "needsText": needs_text, "silent": true}));
    let has_meta = title != PLACEHOLDER && with(app, false, |l| l.papers.iter().find(|q| q.id == id).map(|q| !q.authors.is_empty()).unwrap_or(false)).unwrap_or(false);
    Ok(AddResult { id, title, duplicate, pdf: stored, needs_text, login, pdf_source, has_meta })
}


/// Put a PDF on a paper that has none yet.
pub fn attach_pdf(app: &AppHandle, id: &str, bytes: &[u8]) -> Result<()> {
    valid_id(id)?;
    let d = paper_dir(app, id);
    std::fs::create_dir_all(&d)?;
    let tmp = d.join("paper.pdf.part");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, d.join("paper.pdf"))?;
    with(app, true, |l| {
        if let Some(q) = l.papers.iter_mut().find(|q| q.id == id) {
            q.pdf = true;
            q.text = false;
            q.modified = now_ms();
        }
    })?;
    let _ = app.emit("library-changed", json!({"id": id, "needsText": true, "silent": true}));
    Ok(())
}

/// Details for a paper added from a bare PDF: the DOI (or title) the window found in its text.
#[tauri::command]
pub async fn lib_enrich(app: AppHandle, id: String, doi: Option<String>, title: Option<String>) -> CmdResult<bool> {
    valid_id(&id).es()?;
    // the DOI found in the file (checked against the title on its first page, so a cited
    // paper's DOI is never taken), then a title search
    let mut q = Paper::default();
    let mut found = false;
    if let Some(d) = doi.map(|d| clean_doi(&d)).filter(|d| !d.is_empty()) {
        let mut c = Paper { doi: d, ..Default::default() };
        if from_crossref(&mut c).await.is_ok() && !c.title.is_empty() {
            // without the first page's title, a DOI from the text can't be checked: not used
            let agrees = title.as_deref().is_some_and(|t| crate::ai::tools::title_similarity(&c.title, t) >= 0.6);
            if agrees {
                q = c;
                found = true;
            }
        }
    }
    if !found {
        if let Some(t) = title.as_deref() {
            if let Some(d) = resolve::doi_by_title(t).await {
                q = Paper { doi: d, ..Default::default() };
                found = from_crossref(&mut q).await.is_ok() && !q.title.is_empty();
            }
        }
    }
    if !found {
        return Ok(false);
    }
    sanitize(&mut q);
    let ok = with(&app, true, |l| {
        let Some(p) = l.papers.iter_mut().find(|p| p.id == id) else { return false };
        // the paper already has a different DOI: these details are another paper's
        if !p.doi.is_empty() && !p.doi.eq_ignore_ascii_case(&q.doi) {
            return false;
        }
        // the title was only a guess (the file name)
        if p.title == PLACEHOLDER || p.title.is_empty() || p.title_guess {
            p.title = q.title.clone();
            p.title_guess = false;
            if !q.kind.is_empty() && (p.kind.is_empty() || p.kind == "misc" || p.authors.is_empty()) {
                p.kind = q.kind.clone();
            }
        }
        macro_rules! fill { ($($f:ident),*) => { $( if p.$f.is_empty() { p.$f = q.$f.clone(); } )* } }
        fill!(doi, authors, venue, volume, issue, pages, publisher, abstract_, kind);
        if p.year.is_none() {
            p.year = q.year;
        }
        p.modified = now_ms();
        true
    })
    .es()?;
    let _ = app.emit("library-changed", json!({"id": id, "silent": true}));
    Ok(ok)
}

/// Details found by the AI and the web for a PDF that had none (see the window's `findDetails`):
/// fills the empty fields (and a title that was only a guess), then gives the paper a real
/// citation key when it isn't cited anywhere yet.
#[tauri::command]
pub async fn lib_fill(app: AppHandle, id: String, meta: Value) -> CmdResult<Option<Paper>> {
    valid_id(&id).es()?;
    let mut q: Paper = serde_json::from_value(meta).es()?;
    sanitize(&mut q);
    q.title = q.title.split_whitespace().collect::<Vec<_>>().join(" ");
    q.doi = clean_doi(&q.doi);
    let out = with(&app, true, |l| {
        let keys: std::collections::HashSet<String> = l.papers.iter().filter(|p| p.id != id).map(|p| p.key.to_lowercase()).collect();
        let p = l.papers.iter_mut().find(|p| p.id == id)?;
        if !p.doi.is_empty() && !q.doi.is_empty() && !p.doi.eq_ignore_ascii_case(&q.doi) {
            return None;
        }
        let had_authors = !p.authors.is_empty();
        if (p.title == PLACEHOLDER || p.title.is_empty() || p.title_guess) && !q.title.is_empty() {
            p.title = q.title.clone();
            p.title_guess = false;
        }
        if !q.kind.is_empty() && (p.kind.is_empty() || p.kind == "misc" || !had_authors) {
            p.kind = q.kind.clone();
        }
        macro_rules! fill { ($($f:ident),*) => { $( if p.$f.is_empty() { p.$f = q.$f.clone(); } )* } }
        fill!(doi, arxiv, authors, venue, volume, issue, pages, publisher, abstract_, url);
        if p.year.is_none() {
            p.year = q.year;
        }
        if p.used_in.is_empty() && (!had_authors || p.key.starts_with("anon")) {
            p.key = make_key(p, &|k| keys.contains(&k.to_lowercase()));
        }
        p.modified = now_ms();
        Some(p.clone())
    })
    .es()?;
    let _ = app.emit("library-changed", json!({"id": id, "silent": true}));
    Ok(out)
}

/// Sign in to a publisher in a Callio window to get a PDF; the session is kept for next time.
/// Emits "library-pdf-login" {id, ok, message} when the PDF arrived or the window was closed.
#[tauri::command]
pub async fn lib_sign_in_pdf(app: AppHandle, id: String, url: String) -> CmdResult<()> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    valid_id(&id).es()?;
    let target = tauri::Url::parse(&url).es()?;
    if !matches!(target.scheme(), "http" | "https") {
        return Err("Not a web link".into());
    }
    if let Some(w) = app.get_webview_window("lib-login") {
        let _ = w.destroy();
    }
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (app2, id2, url2, done2) = (app.clone(), id.clone(), url.clone(), done.clone());
    let w = WebviewWindowBuilder::new(&app, "lib-login", WebviewUrl::External(target))
        .title(format!("Sign in to get the PDF — {} — Callio", resolve::host_of(&url)))
        .inner_size(1000.0, 800.0)
        .center()
        .on_page_load(move |w, p| {
            if p.event() != tauri::webview::PageLoadEvent::Finished || done2.load(std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            let page = p.url().to_string();
            let (app, id, url, done) = (app2.clone(), id2.clone(), url2.clone(), done2.clone());
            // cookies can't be read on the event thread (WebView2 deadlock)
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(400));
                let mut tries: Vec<String> = vec![url.clone()];
                if page != url && (page.to_lowercase().contains("pdf") || page.to_lowercase().contains("download")) {
                    tries.insert(0, page.clone());
                }
                for t in tries {
                    let Ok(u) = tauri::Url::parse(&t) else { continue };
                    let Ok(cookies) = w.cookies_for_url(u) else { continue };
                    if cookies.is_empty() {
                        continue;
                    }
                    let header = cookies.iter().map(|c| format!("{}={}", c.name(), c.value())).collect::<Vec<_>>().join("; ");
                    resolve::save_session(&resolve::host_of(&t), &header);
                    let got = tauri::async_runtime::block_on(resolve::fetch_pdf(&t));
                    if let Ok(bytes) = got {
                        if done.swap(true, std::sync::atomic::Ordering::SeqCst) {
                            return;
                        }
                        let r = attach_pdf(&app, &id, &bytes);
                        let _ = app.emit("library-pdf-login", json!({"id": id, "ok": r.is_ok(), "message": r.err().map(|e| e.to_string()).unwrap_or_else(|| "PDF saved".into())}));
                        let _ = w.destroy();
                        return;
                    }
                }
            });
        })
        .build()
        .es()?;
    let app3 = app.clone();
    w.on_window_event(move |e| {
        if let tauri::WindowEvent::Destroyed = e {
            if !done.swap(true, std::sync::atomic::Ordering::SeqCst) {
                let _ = app3.emit("library-pdf-login", json!({"id": id, "ok": false, "message": "The sign-in window was closed before the PDF arrived"}));
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn lib_sign_in_pdf_close(app: AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("lib-login") {
        let _ = w.destroy();
    }
}

// ---------------- commands ----------------

#[derive(Serialize)]
pub struct Listing {
    papers: Vec<Paper>,
    collections: Vec<Collection>,
    dir: String,
}

#[tauri::command]
pub async fn lib_list(app: AppHandle) -> CmdResult<Listing> {
    let d = dir(&app).to_string_lossy().to_string();
    with(&app, false, |l| Listing { papers: l.papers.clone(), collections: l.collections.clone(), dir: d }).es()
}

#[tauri::command]
pub async fn lib_add(app: AppHandle, req: Value) -> CmdResult<AddResult> {
    let req: AddRequest = serde_json::from_value(req).es()?;
    add(&app, req).await.es()
}

/// Store the text the window extracted from a paper's PDF (pages separated by \f).
#[tauri::command]
pub async fn lib_set_text(app: AppHandle, id: String, pages: Vec<String>) -> CmdResult<()> {
    valid_id(&id).es()?;
    let d = paper_dir(&app, &id);
    std::fs::create_dir_all(&d).es()?;
    std::fs::write(d.join("text.txt"), pages.join("\x0c")).es()?;
    with(&app, true, |l| {
        if let Some(p) = l.papers.iter_mut().find(|p| p.id == id) {
            p.text = true;
            p.page_count = pages.len() as u32;
        }
    })
    .es()
}

#[tauri::command]
pub async fn lib_update(app: AppHandle, id: String, patch: Value) -> CmdResult<Paper> {
    with(&app, true, |l| -> Result<Paper> {
        let keys: std::collections::HashSet<String> = l.papers.iter().filter(|p| p.id != id).map(|p| p.key.to_lowercase()).collect();
        let p = l.papers.iter_mut().find(|p| p.id == id).ok_or_else(|| anyhow!("no such paper"))?;
        let mut v = serde_json::to_value(&*p)?;
        if let (Some(o), Some(patch)) = (v.as_object_mut(), patch.as_object()) {
            for (k, x) in patch {
                if !["id", "added", "pdf", "text", "pageCount"].contains(&k.as_str()) {
                    o.insert(k.clone(), x.clone());
                }
            }
        }
        let mut np: Paper = serde_json::from_value(v)?;
        // a title typed by the user is never replaced by looked-up details
        if patch.get("title").is_some() && patch.get("titleGuess").is_none() {
            np.title_guess = false;
        }
        np.key = np.key.trim().replace(|c: char| c.is_whitespace() || c == ',' || c == '{' || c == '}', "");
        if np.key.is_empty() || keys.contains(&np.key.to_lowercase()) {
            bail!("That citation key is empty or already used by another paper");
        }
        np.modified = now_ms();
        *p = np.clone();
        Ok(np)
    })
    .es()?
    .es()
}

#[tauri::command]
pub async fn lib_delete(app: AppHandle, ids: Vec<String>) -> CmdResult<()> {
    for id in &ids {
        valid_id(id).es()?;
    }
    with(&app, true, |l| l.papers.retain(|p| !ids.contains(&p.id))).es()?;
    for id in ids {
        let d = paper_dir(&app, &id);
        if d.starts_with(dir(&app)) && !id.is_empty() {
            let _ = std::fs::remove_dir_all(d);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn lib_save_collection(app: AppHandle, collection: Collection) -> CmdResult<Collection> {
    with(&app, true, |l| {
        let mut c = collection;
        if c.id.is_empty() {
            c.id = format!("c{:x}", now_ms());
        }
        match l.collections.iter_mut().find(|x| x.id == c.id) {
            Some(x) => *x = c.clone(),
            None => l.collections.push(c.clone()),
        }
        c
    })
    .es()
}

#[tauri::command]
pub async fn lib_delete_collection(app: AppHandle, id: String) -> CmdResult<()> {
    with(&app, true, |l| {
        l.collections.retain(|c| c.id != id);
        for c in l.collections.iter_mut().filter(|c| c.parent.as_deref() == Some(id.as_str())) {
            c.parent = None;
        }
        for p in &mut l.papers {
            p.collections.retain(|c| c != &id);
        }
    })
    .es()
}

#[tauri::command]
pub fn lib_pdf_path(app: AppHandle, id: String) -> Option<String> {
    valid_id(&id).ok()?;
    let p = paper_dir(&app, &id).join("paper.pdf");
    p.is_file().then(|| p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn lib_bibtex(app: AppHandle, ids: Vec<String>) -> CmdResult<String> {
    with(&app, false, |l| ids.iter().filter_map(|id| l.papers.iter().find(|p| &p.id == id)).map(bibtex).collect::<Vec<_>>().join("\n")).es()
}

/// A paper was cited in `draft`: remember the link (and attach the draft to its collections).
#[tauri::command]
pub async fn lib_cite(app: AppHandle, id: String, draft: Option<String>) -> CmdResult<Value> {
    with(&app, true, |l| -> Result<Value> {
        let p = l.papers.iter_mut().find(|p| p.id == id).ok_or_else(|| anyhow!("no such paper"))?;
        if let Some(d) = draft.as_ref().filter(|d| !d.is_empty()) {
            if !p.used_in.iter().any(|u| u.eq_ignore_ascii_case(d)) {
                p.used_in.push(d.clone());
            }
        }
        let out = json!({"key": p.key, "bibtex": bibtex(p), "doi": p.doi, "title": p.title});
        let cols = p.collections.clone();
        if let Some(d) = draft.as_ref().filter(|d| !d.is_empty()) {
            for c in l.collections.iter_mut().filter(|c| cols.contains(&c.id)) {
                if !c.drafts.iter().any(|x| x.eq_ignore_ascii_case(d)) {
                    c.drafts.push(d.clone());
                }
            }
        }
        Ok(out)
    })
    .es()?
    .es()
}

/// Text of a paper (optionally pages a..=b, 1-based).
pub fn read_text(app: &AppHandle, id: &str, from: Option<usize>, to: Option<usize>) -> Result<String> {
    valid_id(id)?;
    let t = std::fs::read_to_string(paper_dir(app, id).join("text.txt")).map_err(|_| anyhow!("this paper's text isn't indexed yet"))?;
    let pages: Vec<&str> = t.split('\x0c').collect();
    let a = from.unwrap_or(1).max(1);
    let b = to.unwrap_or(pages.len()).min(pages.len());
    Ok((a..=b).map(|i| format!("--- page {i} ---\n{}", pages[i - 1])).collect::<Vec<_>>().join("\n"))
}

#[tauri::command]
pub async fn lib_text(app: AppHandle, id: String, from: Option<usize>, to: Option<usize>) -> CmdResult<String> {
    read_text(&app, &id, from, to).es()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub id: String,
    pub score: f32,
    /// where the best match is: "title" | "authors" | "abstract" | "text"
    pub snippet: String,
    pub page: Option<usize>,
}

/// Search metadata and full text. Filters: collection id, draft path.
pub fn search(app: &AppHandle, query: &str, collection: Option<&str>, draft: Option<&str>, limit: usize) -> Result<Vec<Hit>> {
    let gen = GEN.load(std::sync::atomic::Ordering::SeqCst);
    let (papers, _) = with(app, false, |l| (l.papers.clone(), ()))?;
    let q = query.trim();
    let keep = |p: &Paper| collection.map(|c| p.collections.iter().any(|x| x == c)).unwrap_or(true) && draft.map(|d| p.used_in.iter().any(|u| u.eq_ignore_ascii_case(d))).unwrap_or(true);
    if q.is_empty() {
        let mut v: Vec<&Paper> = papers.iter().filter(|p| keep(p)).collect();
        v.sort_by(|a, b| b.added.cmp(&a.added));
        return Ok(v.into_iter().take(limit).map(|p| Hit { id: p.id.clone(), score: 0.0, snippet: String::new(), page: None }).collect());
    }
    let cached = INDEX.lock().unwrap_or_else(|e| e.into_inner()).as_ref().filter(|x| x.2 == gen && x.1.len() == papers.len()).cloned();
    let built = match cached {
        Some(a) => a,
        None => {
        // built without holding any lock: saves never wait for a rebuild
        let mut ix = Index::default();
        let mut ids = Vec::new();
        for (i, p) in papers.iter().enumerate() {
            let text = if p.text { std::fs::read_to_string(paper_dir(app, &p.id).join("text.txt")).unwrap_or_default() } else { String::new() };
            let authors = p.authors.join(" ");
            let tags = p.tags.join(" ");
            ix.add(i as u32, &[(&p.title, 6.0), (&authors, 4.0), (&p.key, 4.0), (&tags, 3.0), (&p.venue, 1.5), (&p.abstract_, 2.0), (&p.notes, 1.5), (&p.doi, 2.0), (&text, 1.0)]);
            ids.push(p.id.clone());
        }
        ix.finish();
        let a = std::sync::Arc::new((ix, ids, gen));
        *INDEX.lock().unwrap_or_else(|e| e.into_inner()) = Some(a.clone());
        a
        }
    };
    let (ix, ids, _) = &*built;
    let pos: std::collections::HashMap<&str, usize> = papers.iter().enumerate().map(|(i, p)| (p.id.as_str(), i)).collect();
    let mut found = ix.search(q, limit * 3, |d| papers.get(d as usize).map(&keep).unwrap_or(false));
    // results containing every word first
    let nterms = { let mut t = crate::textindex::tokenize(q); t.sort(); t.dedup(); t.len() };
    found.sort_by(|a, b| {
        let ca = ix.coverage(q, a.0) >= nterms;
        let cb = ix.coverage(q, b.0) >= nterms;
        cb.cmp(&ca).then(b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal))
    });
    let phrase = q.starts_with('"') && q.ends_with('"') && q.len() > 2;
    let mut out = Vec::new();
    for (d, score) in found {
        let Some(id) = ids.get(d as usize) else { continue };
        let Some(&i) = pos.get(id.as_str()) else { continue };
        let p = &papers[i];
        let meta = format!("{}\n{}\n{}", p.title, p.authors.join("; "), p.abstract_);
        let text = if p.text { std::fs::read_to_string(paper_dir(app, &p.id).join("text.txt")).unwrap_or_default() } else { String::new() };
        if phrase && !meta.to_lowercase().contains(&q[1..q.len() - 1].to_lowercase()) && !text.to_lowercase().contains(&q[1..q.len() - 1].to_lowercase()) {
            continue;
        }
        let (snip, page) = match snippet(&meta, q, 160).filter(|_| crate::textindex::tokenize(&p.title).iter().any(|t| crate::textindex::tokenize(q).contains(t))) {
            Some((s, _)) => (s, None),
            None => match snippet(&text, q, 220) {
                Some((s, pg)) => (s, Some(pg)),
                None => (snippet(&meta, q, 160).map(|x| x.0).unwrap_or_default(), None),
            },
        };
        out.push(Hit { id: id.clone(), score, snippet: snip, page });
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn lib_search(app: AppHandle, query: String, collection: Option<String>, draft: Option<String>, limit: Option<usize>) -> CmdResult<Vec<Hit>> {
    tauri::async_runtime::spawn_blocking(move || search(&app, &query, collection.as_deref(), draft.as_deref(), limit.unwrap_or(50)))
        .await
        .es()?
        .es()
}

/// Import entries from a .bib file (metadata only).
#[tauri::command]
pub async fn lib_import_bib(app: AppHandle, path: String, collection: Option<String>) -> CmdResult<usize> {
    let text = std::fs::read_to_string(&path).es()?;
    let mut batch = Vec::new();
    for e in crate::ai::bib::parse_bib(&text) {
        let f = |k: &str| e.fields.get(k).cloned().unwrap_or_default();
        let p = Paper {
            key: e.key.clone(),
            kind: e.kind.clone(),
            title: f("title"),
            authors: f("author").split(" and ").map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect(),
            year: f("year").chars().filter(|c| c.is_ascii_digit()).take(4).collect::<String>().parse().ok(),
            venue: [f("journal"), f("booktitle"), f("howpublished")].into_iter().find(|v| !v.is_empty()).unwrap_or_default(),
            volume: f("volume"),
            issue: f("number"),
            pages: f("pages").replace("--", "-"),
            doi: clean_doi(&f("doi")),
            publisher: f("publisher"),
            url: f("url"),
            abstract_: f("abstract"),
            arxiv: f("eprint"),
            ..Default::default()
        };
        batch.push(p);
    }
    // one save for the whole file
    let n = with(&app, true, |lib| {
        let mut n = 0;
        for mut p in batch {
            p.key = p.key.trim().to_string();
            if p.title.is_empty() || lib.papers.iter().any(|q| same_paper(q, &p)) {
                continue;
            }
            let keys: std::collections::HashSet<String> = lib.papers.iter().map(|q| q.key.to_lowercase()).collect();
            p.id = format!("{:x}{n:04x}", now_ms());
            if p.key.is_empty() || keys.contains(&p.key.to_lowercase()) || !p.key.chars().all(|c| c.is_ascii_alphanumeric() || "-_:.".contains(c)) {
                p.key = make_key(&p, &|k| keys.contains(&k.to_lowercase()));
            }
            p.added = now_ms();
            if let Some(c) = collection.as_ref().filter(|c| !c.is_empty()) {
                p.collections.push(c.clone());
            }
            lib.papers.push(p);
            n += 1;
        }
        n
    })
    .es()?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keys_and_bibtex() {
        let mut p = Paper { title: "Attention Is All You Need".into(), authors: vec!["Vaswani, Ashish".into(), "Shazeer, Noam".into()], year: Some(2017), kind: "inproceedings".into(), venue: "NeurIPS".into(), pages: "5998-6008".into(), ..Default::default() };
        p.key = make_key(&p, &|k| k == "vaswani2017attention");
        assert_eq!(p.key, "vaswani2017attentiona");
        let b = bibtex(&p);
        assert!(b.starts_with("@inproceedings{vaswani2017attentiona,"), "{b}");
        assert!(b.contains("title = {{Attention Is All You Need}}"), "{b}");
        assert!(b.contains("author = {Vaswani, Ashish and Shazeer, Noam}"));
        assert!(b.contains("booktitle = {NeurIPS}"));
        assert!(b.contains("pages = {5998--6008}"));
        let q = Paper { key: "k".into(), title: "Fine-tuning {BERT}: R&D at 50% \\& more".into(), ..Default::default() };
        let b2 = bibtex(&q);
        assert!(b2.contains("title = {{Fine-tuning {BERT}: R\\&D at 50\\% \\& more}}"), "{b2}");
        let bad = Paper { key: "k".into(), title: "{BERT}: pre-training}".into(), ..Default::default() };
        assert!(bibtex(&bad).contains("title = {{BERT: pre-training}}"), "{}", bibtex(&bad));
        assert_eq!(from_web("<i>In vivo</i> $\\alpha$ {x} &amp; y"), "In vivo \\$alpha\\$ x & y");
        let parsed = crate::ai::bib::parse_bib(&b);
        assert_eq!(parsed[0].fields["year"], "2017");
        let mut q = Paper { url: "https://arxiv.org/abs/1706.03762v7".into(), ..Default::default() };
        detect_ids(&mut q, "");
        assert_eq!(q.arxiv, "1706.03762");
        let mut r = Paper { url: "https://doi.org/10.1145/3292500.3330701".into(), ..Default::default() };
        detect_ids(&mut r, "");
        assert_eq!(r.doi, "10.1145/3292500.3330701");
    }
}

/// A citation style (CSL) or locale file from the official CSL repository, cached locally.
#[tauri::command]
pub async fn csl_fetch(app: AppHandle, kind: String, name: String) -> CmdResult<String> {
    let ok = |s: &str| !s.is_empty() && s.len() < 120 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !ok(&name) {
        return Err("bad style name".into());
    }
    let (url, file) = match kind.as_str() {
        "style" => (format!("https://raw.githubusercontent.com/citation-style-language/styles/master/{name}.csl"), format!("{name}.csl")),
        "dependent" => (format!("https://raw.githubusercontent.com/citation-style-language/styles/master/dependent/{name}.csl"), format!("dep-{name}.csl")),
        "locale" => (format!("https://raw.githubusercontent.com/citation-style-language/locales/master/locales-{name}.xml"), format!("locales-{name}.xml")),
        _ => return Err("bad kind".into()),
    };
    let cache = data_dir(&app).join("csl");
    let path = cache.join(&file);
    if let Ok(s) = std::fs::read_to_string(&path) {
        return Ok(s);
    }
    let r = client().get(&url).send().await.es()?;
    if !r.status().is_success() {
        return Err(format!("Couldn't download {name} (HTTP {})", r.status()));
    }
    let s = r.text().await.es()?;
    if !s.contains("<style") && !s.contains("<locale") {
        return Err("not a CSL file".into());
    }
    let _ = std::fs::create_dir_all(&cache);
    let _ = std::fs::write(&path, &s);
    Ok(s)
}

/// Where TeX finds a .bib that isn't next to the document (a global bibliography), via kpsewhich.
#[tauri::command]
pub async fn find_tex_file(app: AppHandle, state: tauri::State<'_, crate::settings::SettingsState>, dir: String, name: String) -> CmdResult<Option<String>> {
    if name.contains(['\n', '\r', '\0']) || name.len() > 260 {
        return Ok(None);
    }
    let dirs = crate::engines::search_dirs(&app, &crate::settings::backend(&state));
    tauri::async_runtime::spawn_blocking(move || {
        let exe = crate::util::which("kpsewhich", &dirs)?;
        let mut c = crate::util::command(exe);
        c.current_dir(&dir).arg(&name);
        let o = crate::util::run_with_timeout(c, Duration::from_secs(15)).ok()?;
        let p = String::from_utf8_lossy(&o.stdout).lines().next()?.trim().to_string();
        (!p.is_empty() && std::path::Path::new(&p).is_file()).then_some(p)
    })
    .await
    .es()
}

/// For the uninstall summary.
pub fn paper_count(app: &AppHandle) -> usize {
    with(app, false, |l| l.papers.len()).unwrap_or(0)
}
