//! Zotero-like "add by link": a DOI, a DOI link, a paper's page or its PDF link → metadata
//! (page meta tags, Crossref, arXiv) and the PDF (publisher meta tags, ACL Anthology, arXiv,
//! OpenAlex, Semantic Scholar, Crossref links). PDFs behind a sign-in are fetched with the
//! session the user signed in with in a Callio window (kept for next time).
use super::Paper;
use anyhow::{anyhow, bail, Result};
use regex_lite::Regex;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0";
const SESSIONS_KEY: &str = "library-sessions";

pub fn browser() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(UA)
        .cookie_store(true)
        .redirect(reqwest::redirect::Policy::limited(12))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap()
}

pub fn progress(app: &AppHandle, step: &str) {
    let _ = app.emit("library-add-progress", json!({ "step": step }));
}

// ---------------- signed-in sessions (per site, in Windows Credential Manager) ----------------
fn sessions() -> serde_json::Map<String, Value> {
    crate::settings::get_secret_value(SESSIONS_KEY).and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}
pub fn save_session(host: &str, cookie: &str) {
    let mut m = sessions();
    m.insert(host.to_lowercase(), Value::String(cookie.to_string()));
    crate::settings::put_secret_value(SESSIONS_KEY, &Value::Object(m).to_string());
}
fn session_for(url: &str) -> Option<String> {
    let host = reqwest::Url::parse(url).ok()?.host_str()?.to_lowercase();
    let m = sessions();
    // the site or a parent domain (sign-in on www.x.com, PDF on pdfs.x.com)
    let mut h = host.as_str();
    loop {
        if let Some(Value::String(c)) = m.get(h) {
            return Some(c.clone());
        }
        match h.split_once('.') {
            Some((_, rest)) if rest.contains('.') => h = rest,
            _ => return None,
        }
    }
}
pub fn host_of(url: &str) -> String {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default()
}

/// Download a PDF; Err("LOGIN") when the site answers with a page instead (sign-in or paywall).
pub async fn fetch_pdf(url: &str) -> Result<Vec<u8>> {
    let mut rq = browser().get(url).header("Accept", "application/pdf,application/octet-stream;q=0.9,*/*;q=0.5");
    if let Some(c) = session_for(url) {
        rq = rq.header("Cookie", c);
    }
    let r = rq.send().await?;
    let status = r.status();
    let mut r = r;
    let mut b = Vec::new();
    while let Some(c) = r.chunk().await? {
        b.extend_from_slice(&c);
        if b.len() > 300 << 20 {
            bail!("PDF larger than 300 MB");
        }
    }
    if b.starts_with(b"%PDF") || b.windows(5).take(1024).any(|w| w == b"%PDF-") {
        return Ok(b);
    }
    if status.as_u16() == 401 || status.as_u16() == 403 || status.is_success() {
        bail!("LOGIN");
    }
    bail!("{} answered {}", host_of(url), status)
}

// ---------------- page meta tags (Highwire / Dublin Core / OpenGraph) ----------------
#[derive(Default, Debug)]
pub struct PageMeta {
    pub title: String,
    pub authors: Vec<String>,
    pub doi: String,
    pub pdf_url: String,
    pub year: Option<i32>,
    pub venue: String,
    pub volume: String,
    pub issue: String,
    pub pages: String,
    pub publisher: String,
    pub abstract_: String,
    pub arxiv: String,
}

fn abs_url(base: &str, href: &str) -> String {
    reqwest::Url::parse(base).and_then(|b| b.join(href)).map(|u| u.to_string()).unwrap_or_else(|_| href.to_string())
}

pub fn parse_meta(html: &str, base: &str) -> PageMeta {
    let tag = Regex::new(r#"(?is)<meta\s+[^>]*>"#).unwrap();
    let attr = |t: &str, a: &str| -> Option<String> {
        let re = Regex::new(&format!(r#"(?is)\b{a}\s*=\s*("([^"]*)"|'([^']*)')"#)).unwrap();
        re.captures(t).map(|c| c.get(2).or(c.get(3)).map(|m| m.as_str()).unwrap_or("").to_string())
    };
    let mut m = PageMeta::default();
    let (mut first, mut last) = (String::new(), String::new());
    for t in tag.find_iter(html) {
        let t = t.as_str();
        let name = attr(t, "name").or_else(|| attr(t, "property")).unwrap_or_default().to_lowercase();
        let Some(v) = attr(t, "content") else { continue };
        let v = crate::util::html_unescape(v.trim());
        if v.is_empty() {
            continue;
        }
        match name.as_str() {
            "citation_title" | "dc.title" if m.title.is_empty() => m.title = v,
            "citation_author" | "dc.creator" => {
                if !m.authors.contains(&v) {
                    m.authors.push(v)
                }
            }
            "citation_doi" | "dc.identifier" | "prism.doi" if m.doi.is_empty() && v.contains("10.") => m.doi = v.trim_start_matches("doi:").trim_start_matches("https://doi.org/").to_string(),
            "citation_pdf_url" if m.pdf_url.is_empty() => m.pdf_url = abs_url(base, &v),
            "citation_publication_date" | "citation_date" | "citation_online_date" | "dc.date" if m.year.is_none() => m.year = Regex::new(r"(19|20)\d\d").unwrap().find(&v).and_then(|y| y.as_str().parse().ok()),
            "citation_journal_title" | "citation_conference_title" | "citation_inbook_title" | "citation_book_title" if m.venue.is_empty() => m.venue = v,
            "citation_volume" if m.volume.is_empty() => m.volume = v,
            "citation_issue" if m.issue.is_empty() => m.issue = v,
            "citation_firstpage" => first = v,
            "citation_lastpage" => last = v,
            "citation_publisher" | "dc.publisher" if m.publisher.is_empty() => m.publisher = v,
            "citation_abstract" | "dc.description" | "description" | "og:description" if m.abstract_.is_empty() && v.len() > 80 => m.abstract_ = v,
            "citation_arxiv_id" if m.arxiv.is_empty() => m.arxiv = v,
            "og:title" if m.title.is_empty() => m.title = v,
            _ => {}
        }
    }
    if !first.is_empty() {
        m.pages = if last.is_empty() { first } else { format!("{first}--{last}") };
    }
    // a <link rel="alternate" type="application/pdf"> or an obvious PDF link
    if m.pdf_url.is_empty() {
        let link = Regex::new(r#"(?is)<link[^>]+type\s*=\s*["']application/pdf["'][^>]*>"#).unwrap();
        if let Some(l) = link.find(html) {
            if let Some(h) = attr(l.as_str(), "href") {
                m.pdf_url = abs_url(base, &h);
            }
        }
    }
    m
}

pub async fn fetch_page(url: &str) -> Result<(String, String)> {
    let mut rq = browser().get(url).header("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8");
    if let Some(c) = session_for(url) {
        rq = rq.header("Cookie", c);
    }
    let r = rq.send().await?;
    let final_url = r.url().to_string();
    let ct = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
    if ct.contains("pdf") {
        bail!("PDF:{final_url}");
    }
    Ok((final_url, r.text().await?))
}

pub fn apply_meta(p: &mut Paper, m: &PageMeta) {
    macro_rules! fill { ($($f:ident),*) => { $( if p.$f.is_empty() { p.$f = m.$f.clone(); } )* } }
    fill!(title, doi, venue, volume, issue, pages, publisher, abstract_, arxiv);
    if p.authors.is_empty() {
        p.authors = m
            .authors
            .iter()
            .map(|a| if a.contains(',') { a.clone() } else { match a.rsplit_once(' ') { Some((g, f)) => format!("{f}, {g}"), None => a.clone() } })
            .collect();
    }
    if p.year.is_none() {
        p.year = m.year;
    }
}

// ---------------- where a free PDF lives ----------------
/// Candidate PDF links for a paper, best first.
pub async fn pdf_candidates(p: &Paper, page_pdf: &str) -> Vec<String> {
    let mut v: Vec<String> = vec![];
    let mut push = |u: String| {
        if !u.is_empty() && !v.contains(&u) {
            v.push(u)
        }
    };
    push(page_pdf.to_string());
    let doi = p.doi.to_lowercase();
    // known open repositories, no lookup needed
    if let Some(id) = doi.strip_prefix("10.18653/v1/") {
        push(format!("https://aclanthology.org/{id}.pdf"));
    }
    if !p.arxiv.is_empty() {
        push(format!("https://arxiv.org/pdf/{}", p.arxiv));
    }
    if doi.is_empty() {
        return v;
    }
    let c = browser();
    // OpenAlex (open-access locations)
    if let Ok(r) = c.get(format!("https://api.openalex.org/works/doi:{}", p.doi)).send().await {
        if let Ok(j) = r.json::<Value>().await {
            if let Some(u) = j["best_oa_location"]["pdf_url"].as_str() {
                push(u.to_string());
            }
            for l in j["locations"].as_array().into_iter().flatten() {
                if let Some(u) = l["pdf_url"].as_str() {
                    push(u.to_string());
                }
            }
            if let Some(a) = j["ids"]["arxiv"].as_str() {
                push(a.replace("/abs/", "/pdf/"));
            }
        }
    }
    // Semantic Scholar
    if let Ok(r) = c.get(format!("https://api.semanticscholar.org/graph/v1/paper/DOI:{}?fields=openAccessPdf,externalIds", p.doi)).send().await {
        if let Ok(j) = r.json::<Value>().await {
            if let Some(u) = j["openAccessPdf"]["url"].as_str() {
                push(u.to_string());
            }
            if let Some(a) = j["externalIds"]["ArXiv"].as_str() {
                push(format!("https://arxiv.org/pdf/{a}"));
            }
        }
    }
    // Crossref's own full-text links (often need a subscription — then a sign-in helps)
    if let Ok(r) = c.get(format!("https://api.crossref.org/works/{}", p.doi)).send().await {
        if let Ok(j) = r.json::<Value>().await {
            for l in j["message"]["link"].as_array().into_iter().flatten() {
                if l["content-type"].as_str().map(|t| t.contains("pdf")).unwrap_or(false) {
                    if let Some(u) = l["URL"].as_str() {
                        push(u.to_string());
                    }
                }
            }
        }
    }
    v
}

/// Title search on Crossref (for a PDF that carries no DOI). Only a near-exact title match counts.
pub async fn doi_by_title(title: &str) -> Option<String> {
    let t = title.trim();
    if t.len() < 12 {
        return None;
    }
    let close = |cand: &str| crate::ai::tools::title_similarity(cand, t) >= 0.9;
    if let Ok(r) = browser().get("https://api.crossref.org/works").query(&[("query.bibliographic", t), ("rows", "5")]).send().await {
        if let Ok(j) = r.json::<Value>().await {
            for it in j["message"]["items"].as_array().into_iter().flatten() {
                if close(it["title"][0].as_str().unwrap_or("")) {
                    if let Some(d) = it["DOI"].as_str() {
                        return Some(d.to_string());
                    }
                }
            }
        }
    }
    // Semantic Scholar knows most conference papers (and their DOIs) too
    let j: Value = browser().get("https://api.semanticscholar.org/graph/v1/paper/search/match").query(&[("query", t), ("fields", "title,externalIds")]).send().await.ok()?.json().await.ok()?;
    for it in j["data"].as_array()? {
        if close(it["title"].as_str().unwrap_or("")) {
            if let Some(d) = it["externalIds"]["DOI"].as_str() {
                return Some(d.to_string());
            }
        }
    }
    None
}

/// The PDF's own clues: a DOI in its text/metadata (when not compressed), or the title in its Info.
pub fn doi_in_pdf(bytes: &[u8]) -> Option<String> {
    let head = &bytes[..bytes.len().min(4 << 20)];
    let s = String::from_utf8_lossy(head);
    let re = Regex::new(r"(?i)(?:doi[:\s/=]*|doi\.org/)(10\.\d{4,9}/[^\s<>()\]\\]+)").unwrap();
    re.captures(&s).map(|c| c[1].trim_end_matches(['.', ',', ';']).to_string())
}

/// ACL Anthology PDF → its page (which has full meta tags).
pub fn page_for_pdf(url: &str) -> Option<String> {
    let re = Regex::new(r"(?i)^https?://aclanthology\.org/([^/]+?)\.pdf$").unwrap();
    if let Some(c) = re.captures(url) {
        return Some(format!("https://aclanthology.org/{}/", &c[1]));
    }
    let ow = Regex::new(r"(?i)^https?://openreview\.net/pdf\?id=([\w-]+)").unwrap();
    if let Some(c) = ow.captures(url) {
        return Some(format!("https://openreview.net/forum?id={}", &c[1]));
    }
    let nips = Regex::new(r"(?i)^(https?://proceedings\.neurips\.cc/.+?)/file/(\w+)-Paper[^/]*\.pdf$").unwrap();
    if let Some(c) = nips.captures(url) {
        return Some(format!("{}/hash/{}-Abstract.html", &c[1], &c[2]).replace("/file", ""));
    }
    None
}

#[allow(dead_code)]
pub fn err_login() -> anyhow::Error {
    anyhow!("LOGIN")
}

#[cfg(test)]
mod tests {
    #[test]
    fn meta_tags() {
        let html = r#"<meta name="citation_title" content="GPT-NER: Named Entity Recognition via Large Language Models"><meta name="citation_author" content="Wang, Shuhe"><meta name="citation_author" content="Xiaofei Sun"><meta name="citation_doi" content="10.18653/v1/2025.findings-naacl.239"><meta name="citation_pdf_url" content="/2025.findings-naacl.239.pdf"><meta name="citation_publication_date" content="2025/4"><meta content="Findings of NAACL 2025" name="citation_conference_title"><meta name="citation_firstpage" content="4257"><meta name="citation_lastpage" content="4275">"#;
        let m = super::parse_meta(html, "https://aclanthology.org/2025.findings-naacl.239/");
        assert_eq!(m.title, "GPT-NER: Named Entity Recognition via Large Language Models");
        assert_eq!(m.authors.len(), 2);
        assert_eq!(m.doi, "10.18653/v1/2025.findings-naacl.239");
        assert_eq!(m.pdf_url, "https://aclanthology.org/2025.findings-naacl.239.pdf");
        assert_eq!(m.year, Some(2025));
        assert_eq!(m.pages, "4257--4275");
        assert_eq!(super::page_for_pdf("https://aclanthology.org/2025.findings-naacl.239.pdf").as_deref(), Some("https://aclanthology.org/2025.findings-naacl.239/"));
    }
}
