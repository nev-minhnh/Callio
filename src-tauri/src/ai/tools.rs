//! Tools the AI can call: scholarly search and citation checks (OpenAlex, Crossref, doi.org),
//! reading web pages, optional web search, and reading files of the open project.
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Callio/0.2 (LaTeX editor; https://github.com/callio-editor)")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap()
}

#[derive(Clone, Default)]
pub struct ToolContext {
    pub project_root: Option<PathBuf>,
    /// "none" | "brave" | "tavily" | "searxng"
    pub search_backend: String,
    pub search_url: String,
    pub search_key: Option<String>,
    pub web: bool,
    pub skills: Vec<super::SkillRef>,
    /// asks Callio's window (PDF text via pdf.js, the paper library)
    pub asker: Option<crate::claude_code::mcp::Asker>,
}

/// JSON-schema tool definitions (provider-neutral).
pub fn definitions(ctx: &ToolContext) -> Vec<Value> {
    let mut v = vec![
        json!({"name": "search_papers", "description": "Search scholarly literature (OpenAlex: journals, conferences, arXiv). Returns title, authors, year, venue, DOI and citation count. Use it to find real papers before citing anything.",
            "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 10}}, "required": ["query"]}}),
        json!({"name": "verify_citation", "description": "Check that a reference really exists and its metadata is right (Crossref/OpenAlex). Give a DOI if known, otherwise title (and authors/year). Returns verified/likely/not_found with the matching record.",
            "parameters": {"type": "object", "properties": {"doi": {"type": "string"}, "title": {"type": "string"}, "authors": {"type": "string"}, "year": {"type": "integer"}}}}),
        json!({"name": "get_bibtex", "description": "Get the official BibTeX entry for a DOI from doi.org.",
            "parameters": {"type": "object", "properties": {"doi": {"type": "string"}}, "required": ["doi"]}}),
    ];
    if ctx.web {
        v.push(json!({"name": "fetch_url", "description": "Read a web page (or text file) and return its text content.",
            "parameters": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}}));
        if ctx.search_backend != "none" && !ctx.search_backend.is_empty() {
            let desc = match ctx.search_backend.strip_prefix("engine:") {
                Some(e) if crate::websearch::is_scholarly(e) => format!("Search scholarly literature with {} (the author's choice). Returns titles, links, authors/year/venue and abstracts. Use fetch_url to read a result.", crate::websearch::engine_name(e)),
                Some(e) => format!("Search the web with {} (the author's choice). Returns the top results: titles, URLs and snippets. Use fetch_url to read a page.", crate::websearch::engine_name(if e == "auto" { "google" } else { e })),
                None => "Search the web. Returns titles, URLs and snippets.".to_string(),
            };
            v.push(json!({"name": "web_search", "description": desc,
                "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}));
        }
    }
    if ctx.asker.is_some() {
        v.push(json!({"name": "search_library", "description": "Search the author's own paper library (titles, authors, abstracts and the full text of the PDFs they saved). Returns citation keys, titles, years and matching passages with page numbers. Prefer these papers when citing.",
            "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 30}}, "required": ["query"]}}));
        v.push(json!({"name": "read_library_paper", "description": "Read the text of a paper in the author's library (by citation key), optionally only some pages.",
            "parameters": {"type": "object", "properties": {"key": {"type": "string"}, "from_page": {"type": "integer"}, "to_page": {"type": "integer"}}, "required": ["key"]}}));
        v.push(json!({"name": "library_bibtex", "description": "The BibTeX entries of papers in the author's library, by citation key (comma-separated).",
            "parameters": {"type": "object", "properties": {"keys": {"type": "string"}}, "required": ["keys"]}}));
    }
    if !ctx.skills.is_empty() {
        let names: Vec<&str> = ctx.skills.iter().map(|s| s.name.as_str()).collect();
        v.push(json!({"name": "use_skill", "description": "Load the full instructions of one of the author's installed skills (listed in your instructions) before doing a task it covers.",
            "parameters": {"type": "object", "properties": {"name": {"type": "string", "enum": names}}, "required": ["name"]}}));
    }
    if ctx.asker.is_some() {
        v.extend(super::office_tools::chat_defs());
    }
    if ctx.project_root.is_some() {
        v.push(json!({"name": "list_project_files", "description": "List the files and subfolders of the folder the user opened (recursively), with sizes. Optionally only below a subfolder.",
            "parameters": {"type": "object", "properties": {"subfolder": {"type": "string", "description": "path relative to the project folder"}}}}));
        v.push(json!({"name": "read_project_file", "description": "Read any file in the user's opened folder or its subfolders (path relative to the project folder): .tex, .bib, .md, data files, code, and PDFs (their text). For long files give a line range.",
            "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "start_line": {"type": "integer"}, "end_line": {"type": "integer"}}, "required": ["path"]}}));
        v.push(json!({"name": "search_project_files", "description": "Search the text of every file in the user's opened folder and subfolders. Returns path:line: matching line. Use it to find where something is defined, cited or discussed.",
            "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "words or a phrase (case-insensitive)"}, "extension": {"type": "string", "description": "optional, e.g. tex"}}, "required": ["query"]}}));
    }
    v
}

pub async fn run(ctx: &ToolContext, name: &str, input: &Value) -> String {
    let r = match name {
        "search_papers" => search_papers(input["query"].as_str().unwrap_or(""), input["limit"].as_u64().unwrap_or(5) as usize).await,
        "verify_citation" => verify_citation(input["doi"].as_str(), input["title"].as_str(), input["authors"].as_str(), input["year"].as_i64()).await.map(|v| v.to_string()),
        "get_bibtex" => get_bibtex(input["doi"].as_str().unwrap_or("")).await,
        "fetch_url" if ctx.web => fetch_url(input["url"].as_str().unwrap_or("")).await,
        "web_search" if ctx.web => web_search(ctx, input["query"].as_str().unwrap_or("")).await,
        "list_project_files" => {
            let (c, sub) = (ctx.clone(), input["subfolder"].as_str().unwrap_or("").to_string());
            tokio::task::spawn_blocking(move || list_files(&c, &sub)).await.map_err(|e| anyhow!(e.to_string())).and_then(|r| r)
        }
        "read_project_file" => read_file(ctx, input["path"].as_str().unwrap_or(""), input["start_line"].as_u64(), input["end_line"].as_u64()).await,
        "search_project_files" => {
            let (c, q, ext) = (ctx.clone(), input["query"].as_str().unwrap_or("").to_string(), input["extension"].as_str().map(String::from));
            tokio::task::spawn_blocking(move || search_files(&c, &q, ext.as_deref())).await.map_err(|e| anyhow!(e.to_string())).and_then(|r| r)
        }
        n if super::office_tools::NAMES.contains(&n) => match &ctx.asker {
            Some(ask) => match ask(n.to_string(), input.clone(), Duration::from_secs(600)).await {
                Some(v) => {
                    if let Some(e) = v.get("error").and_then(|e| e.as_str()) {
                        Err(anyhow!("{e}"))
                    } else {
                        Ok(v.as_str().map(String::from).unwrap_or_else(|| serde_json::to_string_pretty(&v).unwrap_or_default()))
                    }
                }
                None => Err(anyhow!("Callio's window didn't answer")),
            },
            None => Err(anyhow!("editing documents isn't available here")),
        },
        "search_library" | "read_library_paper" | "library_bibtex" => match &ctx.asker {
            Some(ask) => match ask(name.to_string(), input.clone(), Duration::from_secs(60)).await {
                Some(v) => Ok(v.as_str().map(String::from).unwrap_or_else(|| v.to_string())),
                None => Err(anyhow!("the library didn't answer")),
            },
            None => Err(anyhow!("the library isn't available here")),
        },
        "use_skill" => match ctx.skills.iter().find(|s| Some(s.name.as_str()) == input["name"].as_str()) {
            Some(s) => super::skills::skills_read(s.path.clone()).await.map(|t| t.chars().take(150_000).collect()).map_err(|e| anyhow!(e)),
            None => Err(anyhow!("No skill with that name")),
        },
        other => Err(anyhow!("Unknown or disabled tool: {other}")),
    };
    match r {
        Ok(s) => s,
        Err(e) => format!("ERROR: {e}"),
    }
}

// ---------------- scholarly ----------------

fn openalex_brief(w: &Value) -> Value {
    let authors: Vec<String> = w["authorships"].as_array().into_iter().flatten().take(6).filter_map(|a| a["author"]["display_name"].as_str().map(String::from)).collect();
    json!({
        "title": w["display_name"],
        "year": w["publication_year"],
        "authors": authors.join(", ") + if w["authorships"].as_array().map(|a| a.len() > 6).unwrap_or(false) { " et al." } else { "" },
        "venue": w["primary_location"]["source"]["display_name"],
        "doi": w["doi"].as_str().map(|d| d.trim_start_matches("https://doi.org/")),
        "cited_by": w["cited_by_count"],
        "type": w["type"],
    })
}

pub async fn search_papers(q: &str, limit: usize) -> Result<String> {
    if q.trim().is_empty() {
        bail!("empty query");
    }
    let url = format!("https://api.openalex.org/works?search={}&per-page={}", urlencoding::encode(q), limit.clamp(1, 10));
    let v: Value = client().get(url).send().await?.error_for_status()?.json().await?;
    let items: Vec<Value> = v["results"].as_array().into_iter().flatten().map(openalex_brief).collect();
    Ok(serde_json::to_string(&items)?)
}

pub fn normalize(s: &str) -> Vec<String> {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .filter(|w| w.len() > 1 && !["the", "of", "and", "in", "on", "for", "an", "to", "with", "a"].contains(w))
        .map(String::from)
        .collect()
}

/// Token-set similarity of two titles in 0..1.
pub fn title_similarity(a: &str, b: &str) -> f64 {
    let (x, y) = (normalize(a), normalize(b));
    if x.is_empty() || y.is_empty() {
        return 0.0;
    }
    let sx: std::collections::HashSet<_> = x.iter().collect();
    let sy: std::collections::HashSet<_> = y.iter().collect();
    let inter = sx.intersection(&sy).count() as f64;
    inter / (sx.len().max(sy.len()) as f64)
}

pub fn clean_doi(d: &str) -> String {
    let d = d.trim();
    let d = d.strip_prefix("https://doi.org/").or_else(|| d.strip_prefix("http://doi.org/")).or_else(|| d.strip_prefix("doi:")).unwrap_or(d);
    d.trim().to_string()
}

pub async fn crossref(doi: &str) -> Result<Option<Value>> {
    let r = client().get(format!("https://api.crossref.org/works/{}", urlencoding::encode(&clean_doi(doi)))).send().await?;
    if r.status().as_u16() == 404 {
        return Ok(None);
    }
    let v: Value = r.error_for_status()?.json().await?;
    let m = &v["message"];
    let authors: Vec<String> = m["author"].as_array().into_iter().flatten().take(6).map(|a| format!("{} {}", a["given"].as_str().unwrap_or(""), a["family"].as_str().unwrap_or("")).trim().to_string()).collect();
    Ok(Some(json!({
        "title": m["title"][0], "year": m["issued"]["date-parts"][0][0], "authors": authors.join(", "),
        "venue": m["container-title"][0], "doi": m["DOI"], "type": m["type"],
    })))
}

pub async fn verify_citation(doi: Option<&str>, title: Option<&str>, authors: Option<&str>, year: Option<i64>) -> Result<Value> {
    let title = title.unwrap_or("").trim();
    if let Some(d) = doi.filter(|d| !d.trim().is_empty()) {
        match crossref(d).await? {
            Some(rec) => {
                let sim = if title.is_empty() { 1.0 } else { title_similarity(title, rec["title"].as_str().unwrap_or("")) };
                let year_ok = year.map(|y| rec["year"].as_i64() == Some(y)).unwrap_or(true);
                let status = if sim > 0.8 && year_ok { "verified" } else if sim > 0.5 { "doi_exists_metadata_differs" } else { "doi_belongs_to_another_work" };
                return Ok(json!({"status": status, "title_similarity": (sim * 100.0).round() / 100.0, "record": rec}));
            }
            None if title.is_empty() => return Ok(json!({"status": "doi_not_found", "doi": d})),
            None => {}
        }
    }
    if title.is_empty() {
        bail!("give a DOI or a title");
    }
    let q = format!("{title} {}", authors.unwrap_or(""));
    let url = format!("https://api.openalex.org/works?search={}&per-page=5", urlencoding::encode(q.trim()));
    let v: Value = client().get(url).send().await?.error_for_status()?.json().await?;
    let mut best: Option<(f64, Value)> = None;
    for w in v["results"].as_array().into_iter().flatten() {
        let sim = title_similarity(title, w["display_name"].as_str().unwrap_or(""));
        if best.as_ref().map(|(s, _)| sim > *s).unwrap_or(true) {
            best = Some((sim, openalex_brief(w)));
        }
    }
    Ok(match best {
        Some((s, rec)) if s > 0.85 => {
            let year_ok = year.map(|y| rec["year"].as_i64() == Some(y)).unwrap_or(true);
            json!({"status": if year_ok { "verified" } else { "found_year_differs" }, "title_similarity": (s * 100.0).round() / 100.0, "record": rec})
        }
        Some((s, rec)) if s > 0.55 => json!({"status": "likely_match", "title_similarity": (s * 100.0).round() / 100.0, "record": rec}),
        Some((s, rec)) => json!({"status": "not_found", "closest": rec, "title_similarity": (s * 100.0).round() / 100.0}),
        None => json!({"status": "not_found"}),
    })
}

pub async fn get_bibtex(doi: &str) -> Result<String> {
    let d = clean_doi(doi);
    if d.is_empty() {
        bail!("missing DOI");
    }
    let r = client().get(format!("https://doi.org/{d}")).header("Accept", "application/x-bibtex; charset=utf-8").send().await?;
    if !r.status().is_success() {
        bail!("doi.org returned HTTP {} for {d}", r.status());
    }
    Ok(r.text().await?)
}

// ---------------- web ----------------

pub fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 3);
    let lower = html.to_ascii_lowercase(); // same byte offsets as `html`
    let mut i = 0;
    let b = html.as_bytes();
    while i < b.len() {
        if b[i] == b'<' {
            // skip script/style blocks entirely (possibly several in a row)
            'skip: loop {
                for tag in ["script", "style", "noscript", "svg"] {
                    if i < b.len() && lower[i..].starts_with(&format!("<{tag}")) {
                        if let Some(end) = lower[i..].find(&format!("</{tag}>")) {
                            i += end + tag.len() + 3;
                            continue 'skip;
                        }
                    }
                }
                break;
            }
            if i >= b.len() {
                break;
            }
            if b[i] == b'<' {
                let close = html[i..].find('>').map(|e| i + e + 1).unwrap_or(b.len());
                let tag = &lower[i..close.min(i + 12)];
                if tag.starts_with("<p") || tag.starts_with("<br") || tag.starts_with("<div") || tag.starts_with("<li") || tag.starts_with("<h") || tag.starts_with("<tr") {
                    out.push('\n');
                }
                i = close;
                continue;
            }
        }
        let ch_end = (i + 1..=b.len()).find(|&j| html.is_char_boundary(j)).unwrap_or(b.len());
        out.push_str(&html[i..ch_end]);
        i = ch_end;
    }
    let t = crate::util::html_unescape(&out);
    let mut lines: Vec<String> = Vec::new();
    for l in t.lines() {
        let l = l.split_whitespace().collect::<Vec<_>>().join(" ");
        if !l.is_empty() {
            lines.push(l);
        }
    }
    lines.join("\n")
}

fn is_public(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v) => !(v.is_loopback() || v.is_private() || v.is_link_local() || v.is_unspecified() || v.is_broadcast() || v.is_multicast() || v.octets()[0] == 100 && (v.octets()[1] & 0xC0) == 64 || v.octets()[0] == 0),
        IpAddr::V6(v) => {
            let seg = v.segments();
            !(v.is_loopback() || v.is_unspecified() || v.is_multicast() || (seg[0] & 0xfe00) == 0xfc00 || (seg[0] & 0xffc0) == 0xfe80
                || v.to_ipv4_mapped().map(|m| !is_public(std::net::IpAddr::V4(m))).unwrap_or(false))
        }
    }
}

/// Only public internet addresses: the AI must not be able to reach your PC or local network.
async fn check_public(url: &reqwest::Url) -> Result<()> {
    if !matches!(url.scheme(), "http" | "https") {
        bail!("only http(s) URLs");
    }
    let host = url.host_str().ok_or_else(|| anyhow!("no host"))?;
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<_> = tokio::net::lookup_host((host, port)).await?.collect();
    if addrs.is_empty() || addrs.iter().any(|a| !is_public(a.ip())) {
        bail!("refusing to read a local or private network address");
    }
    Ok(())
}

pub async fn fetch_url(url: &str) -> Result<String> {
    let c = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Callio/0.2")
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(45))
        .build()?;
    let mut u = reqwest::Url::parse(url)?;
    let mut resp = None;
    for _ in 0..6 {
        check_public(&u).await?;
        let r = c.get(u.clone()).send().await?;
        if r.status().is_redirection() {
            let loc = r.headers().get("location").and_then(|v| v.to_str().ok()).ok_or_else(|| anyhow!("redirect without location"))?;
            u = u.join(loc)?;
            continue;
        }
        resp = Some(r);
        break;
    }
    let mut r = resp.ok_or_else(|| anyhow!("too many redirects"))?;
    let status = r.status();
    let ct = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = r.chunk().await? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > 3_000_000 {
            break; // enough to read; don't download huge files
        }
    }
    if !status.is_success() {
        bail!("HTTP {status}");
    }
    if ct.contains("pdf") {
        return Ok(format!("[PDF document, {} KB — text extraction isn't available; use search_papers for its metadata]", bytes.len() / 1024));
    }
    let body = String::from_utf8_lossy(&bytes[..bytes.len().min(3_000_000)]).to_string();
    let text = if ct.contains("html") || body.trim_start().starts_with('<') { html_to_text(&body) } else { body };
    let mut t: String = text.chars().take(20_000).collect();
    if text.chars().count() > 20_000 {
        t.push_str("\n[…truncated]");
    }
    Ok(t)
}

pub async fn web_search(ctx: &ToolContext, q: &str) -> Result<String> {
    let c = client();
    let items: Vec<Value> = match ctx.search_backend.as_str() {
        "brave" => {
            let key = ctx.search_key.clone().ok_or_else(|| anyhow!("no Brave Search API key set"))?;
            let v: Value = c.get(format!("https://api.search.brave.com/res/v1/web/search?count=6&q={}", urlencoding::encode(q))).header("X-Subscription-Token", key).header("Accept", "application/json").send().await?.error_for_status()?.json().await?;
            v["web"]["results"].as_array().into_iter().flatten().map(|r| json!({"title": r["title"], "url": r["url"], "snippet": r["description"]})).collect()
        }
        "tavily" => {
            let key = ctx.search_key.clone().ok_or_else(|| anyhow!("no Tavily API key set"))?;
            let v: Value = c.post("https://api.tavily.com/search").json(&json!({"api_key": key, "query": q, "max_results": 6})).send().await?.error_for_status()?.json().await?;
            v["results"].as_array().into_iter().flatten().map(|r| json!({"title": r["title"], "url": r["url"], "snippet": r["content"]})).collect()
        }
        "searxng" => {
            let base = ctx.search_url.trim_end_matches('/');
            let v: Value = c.get(format!("{base}/search?format=json&q={}", urlencoding::encode(q))).send().await?.error_for_status()?.json().await?;
            v["results"].as_array().into_iter().flatten().take(6).map(|r| json!({"title": r["title"], "url": r["url"], "snippet": r["content"]})).collect()
        }
        e if e.starts_with("engine:") => {
            let id = &e["engine:".len()..];
            return crate::websearch::search_for_ai(if id == "auto" { "google" } else { id }, q).await;
        }
        _ => bail!("web search isn't configured (Settings → AI → Web search)"),
    };
    Ok(serde_json::to_string(&items)?)
}

// ---------------- project ----------------

/// The project folder, refusing places that are clearly not a project (drive root, home).
fn project_root(ctx: &ToolContext) -> Result<PathBuf> {
    let root = ctx.project_root.as_ref().ok_or_else(|| anyhow!("no project folder"))?;
    let root = std::fs::canonicalize(root)?;
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).and_then(|h| std::fs::canonicalize(h).ok());
    if root.parent().is_none() || root.components().count() <= 2 || Some(&root) == home.as_ref() {
        bail!("the open file isn't inside a project folder, so project files aren't available");
    }
    // whole personal folders are not a project: open the project's own folder instead
    if let Some(h) = &home {
        let broad = ["Downloads", "Desktop", "Documents", "OneDrive", "Pictures", "Videos", "Music"].iter().any(|n| root == h.join(n));
        if broad || root.parent() == Some(h.as_path()) && root.file_name().map(|n| n.to_string_lossy().starts_with("OneDrive")).unwrap_or(false) {
            bail!("the open folder is a whole personal folder ({}); open the project's own folder (Open ▾ → Open folder) to let the AI read its files", root.display());
        }
    }
    Ok(root)
}

fn project_path(ctx: &ToolContext, rel: &str) -> Result<PathBuf> {
    let root = project_root(ctx)?;
    let rel = rel.trim_start_matches(['/', '\\']);
    if rel.split(['/', '\\']).any(|c| c.starts_with('.') || c.contains(':')) {
        bail!("hidden files and folders aren't readable");
    }
    // resolve symlinks/junctions, then make sure we're still inside the project
    let p = std::fs::canonicalize(root.join(rel)).map_err(|_| anyhow!("no such file in the project: {rel}"))?;
    if !p.starts_with(&root) {
        bail!("path outside the project");
    }
    Ok(p)
}

/// Walk the project (no hidden folders, LaTeX junk or links), calling `f` for each file.
fn walk(root: &Path, mut f: impl FnMut(&Path, u64) -> bool) -> Result<bool> {
    let mut stack = vec![(root.to_path_buf(), 0)];
    let mut complete = true;
    while let Some((d, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with('.') || n == "node_modules" || n == "__pycache__" || crate::fsops::is_junk(&n) || e.file_type().map(|t| t.is_symlink()).unwrap_or(true) {
                continue;
            }
            let p = e.path();
            if p.is_dir() {
                if depth < 16 {
                    stack.push((p, depth + 1));
                }
            } else if !f(&p, e.metadata().map(|m| m.len()).unwrap_or(0)) {
                complete = false;
                return Ok(complete);
            }
        }
    }
    Ok(complete)
}

fn list_files(ctx: &ToolContext, sub: &str) -> Result<String> {
    let root = project_root(ctx)?;
    let start = if sub.trim().is_empty() { root.clone() } else { project_path(ctx, sub)? };
    let mut out = Vec::new();
    let complete = walk(&start, |p, len| {
        out.push(format!("{}  ({})", p.strip_prefix(&root).unwrap_or(p).to_string_lossy().replace('\\', "/"), human(len)));
        out.len() < 4000
    })?;
    out.sort();
    if !complete {
        out.push("… (more files — list a subfolder)".into());
    }
    Ok(out.join("\n"))
}

fn human(n: u64) -> String {
    if n < 1024 { format!("{n} B") } else if n < 1 << 20 { format!("{:.0} KB", n as f64 / 1024.0) } else { format!("{:.1} MB", n as f64 / 1048576.0) }
}

async fn read_file(ctx: &ToolContext, rel: &str, start: Option<u64>, end: Option<u64>) -> Result<String> {
    let p = project_path(ctx, rel)?;
    let is_pdf = p.extension().map(|e| e.eq_ignore_ascii_case("pdf")).unwrap_or(false);
    let text = if is_pdf {
        // PDF text comes from Callio's PDF engine in the window
        let ask = ctx.asker.as_ref().ok_or_else(|| anyhow!("PDF text isn't available here"))?;
        let v = ask("pdf_text".into(), json!({"path": p.to_string_lossy()}), Duration::from_secs(120)).await.ok_or_else(|| anyhow!("couldn't read the PDF"))?;
        v.as_str().map(String::from).unwrap_or_else(|| v.to_string())
    } else {
        if std::fs::metadata(&p)?.len() > 8 << 20 {
            bail!("file is larger than 8 MB");
        }
        let b = std::fs::read(&p)?;
        if b.iter().take(8000).any(|&c| c == 0) {
            bail!("binary file (not text)");
        }
        String::from_utf8_lossy(&b).to_string()
    };
    let lines: Vec<&str> = text.lines().collect();
    let (a, z) = (start.unwrap_or(1).max(1) as usize, end.map(|e| e as usize).unwrap_or(lines.len()).min(lines.len()));
    let mut out = String::new();
    if start.is_some() || end.is_some() || text.len() > 200_000 {
        let z = if start.is_none() && end.is_none() { lines.len().min(2000) } else { z };
        for (i, l) in lines.iter().enumerate().take(z).skip(a - 1) {
            out.push_str(&format!("{:>5}| {l}\n", i + 1));
        }
        if z < lines.len() {
            out.push_str(&format!("… ({} lines in total — ask for a range)\n", lines.len()));
        }
        return Ok(out);
    }
    Ok(text)
}

fn search_files(ctx: &ToolContext, query: &str, ext: Option<&str>) -> Result<String> {
    let root = project_root(ctx)?;
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        bail!("empty query");
    }
    let ext = ext.map(|e| e.trim_start_matches('.').to_lowercase()).filter(|e| !e.is_empty());
    let mut hits = Vec::new();
    let mut files = 0;
    let mut bytes = 0u64;
    walk(&root, |p, len| {
        bytes += len;
        if bytes > 400 << 20 {
            return false; // enough reading for one search
        }
        if len > 4 << 20 {
            return true;
        }
        if let Some(e) = &ext {
            if p.extension().map(|x| x.to_string_lossy().to_lowercase() != *e).unwrap_or(true) {
                return true;
            }
        }
        let Ok(b) = std::fs::read(p) else { return true };
        if b.iter().take(8000).any(|&c| c == 0) {
            return true;
        }
        files += 1;
        let t = String::from_utf8_lossy(&b);
        let rel = p.strip_prefix(&root).unwrap_or(p).to_string_lossy().replace('\\', "/");
        for (i, l) in t.lines().enumerate() {
            if l.to_lowercase().contains(&q) {
                let l = l.trim();
                let l: String = l.chars().take(240).collect();
                hits.push(format!("{rel}:{}: {l}", i + 1));
                if hits.len() >= 150 {
                    return false;
                }
            }
        }
        files < 20000
    })?;
    if hits.is_empty() {
        return Ok(format!("No matches for “{query}” in {files} text files."));
    }
    Ok(hits.join("\n"))
}

pub fn project_root_of(path: &str) -> Option<PathBuf> {
    let p = Path::new(path);
    if p.is_dir() { Some(p.to_path_buf()) } else { p.parent().map(|x| x.to_path_buf()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn similarity() {
        assert!(title_similarity("Attention Is All You Need", "Attention is all you need") > 0.99);
        assert!(title_similarity("CATS: A Pragmatic Chinese Answer-to-Sequence Dataset", "A framework for cross-cultural hate typology") < 0.2);
    }
    #[test]
    fn strips_html() {
        let t = html_to_text("<html><head><style>x{}</style><script>var a=1;</script></head><body><h1>Hi&amp;bye</h1><p>One <b>two</b></p></body></html>");
        assert_eq!(t, "Hi&bye\nOne two");
    }
}
