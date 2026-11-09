//! Web search for the AI chat with the engine the author picks in the chat's toolbar.
//!
//! Web engines (Google, Cốc Cốc, Bing, Yahoo!, Yandex, DuckDuckGo, Baidu, Naver, Ecosia, Brave,
//! Ask, Google Scholar) are read the way the author would see them: a hidden Edge (WebView2)
//! window opens the engine's own results page and a few lines of script read the results off it,
//! so they are the engine's own results, in its order. The window is reused for a minute and a
//! half, then closed. Scholarly sources with open APIs (Semantic Scholar, OpenAlex, arXiv, PubMed,
//! Europe PMC, Crossref, DBLP) are asked directly.
use crate::util::CmdResult;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

static APP: OnceLock<AppHandle> = OnceLock::new();
/// Where the page script's answer goes (one search at a time).
static PENDING: Mutex<Option<tokio::sync::oneshot::Sender<Value>>> = Mutex::new(None);
static ONE_AT_A_TIME: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static LAST_USED: AtomicU64 = AtomicU64::new(0);
const LABEL: &str = "callio-websearch";
const RESULT_HOST: &str = "callio-result.invalid";

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Hit {
    pub title: String,
    pub url: String,
    pub snippet: String,
    /// authors · year · venue (scholarly results)
    #[serde(skip_serializing_if = "String::is_empty")]
    pub meta: String,
}

/// (id, display name, results page) of the engines read off their own page.
pub const PAGE_ENGINES: &[(&str, &str, &str)] = &[
    ("google", "Google", "https://www.google.com/search?q="),
    ("coccoc", "Cốc Cốc", "https://coccoc.com/search?query="),
    ("bing", "Bing", "https://www.bing.com/search?q="),
    ("yahoo", "Yahoo!", "https://search.yahoo.com/search?p="),
    ("yandex", "Yandex", "https://yandex.com/search/?text="),
    ("duckduckgo", "DuckDuckGo", "https://html.duckduckgo.com/html/?q="),
    ("baidu", "Baidu", "https://www.baidu.com/s?wd="),
    ("naver", "Naver", "https://search.naver.com/search.naver?query="),
    ("ecosia", "Ecosia", "https://www.ecosia.org/search?q="),
    ("brave", "Brave Search", "https://search.brave.com/search?q="),
    ("ask", "Ask.com", "https://www.ask.com/web?q="),
    ("scholar", "Google Scholar", "https://scholar.google.com/scholar?q="),
];

pub fn engine_name(id: &str) -> &'static str {
    match id {
        "semantic" => "Semantic Scholar",
        "openalex" => "OpenAlex",
        "arxiv" => "arXiv",
        "pubmed" => "PubMed",
        "europepmc" => "Europe PMC",
        "crossref" => "Crossref",
        "dblp" => "DBLP",
        _ => PAGE_ENGINES.iter().find(|e| e.0 == id).map(|e| e.1).unwrap_or("Google"),
    }
}
pub fn is_scholarly(id: &str) -> bool {
    matches!(id, "scholar" | "semantic" | "openalex" | "arxiv" | "pubmed" | "europepmc" | "crossref" | "dblp")
}

/// Search `q` with `engine`.
pub async fn search(engine: &str, q: &str) -> Result<Vec<Hit>, String> {
    let q = q.trim();
    if q.is_empty() {
        return Err("empty query".into());
    }
    match engine {
        "semantic" => semantic(q).await,
        "openalex" => openalex(q).await,
        "arxiv" => arxiv(q).await,
        "pubmed" => pubmed(q).await,
        "europepmc" => europepmc(q).await,
        "crossref" => crossref(q).await,
        "dblp" => dblp(q).await,
        id => {
            let (_, name, base) = PAGE_ENGINES.iter().find(|e| e.0 == id).copied().unwrap_or(PAGE_ENGINES[0]);
            let url = format!("{base}{}", urlencoding::encode(q));
            let v = read_page(&url).await?;
            let hits: Vec<Hit> = v["hits"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|h| {
                    let url = h["u"].as_str()?.to_string();
                    let title = h["t"].as_str()?.trim().to_string();
                    (!title.is_empty() && url.starts_with("http")).then(|| Hit { title, url, snippet: h["d"].as_str().unwrap_or_default().trim().to_string(), meta: h["m"].as_str().unwrap_or_default().trim().to_string() })
                })
                .take(10)
                .collect();
            if hits.is_empty() {
                return Err(match v["blocked"].as_str().unwrap_or_default() {
                    "captcha" => format!("{name} asked to confirm you're not a robot — try another engine, or open {name} in the browser once"),
                    "consent" => format!("{name} showed its cookie page — open {name} in the browser once and accept it, or pick another engine"),
                    _ => format!("{name}'s page had no results ({})", v["title"].as_str().unwrap_or("nothing loaded")),
                });
            }
            Ok(hits)
        }
    }
}

/// For the AI: results as compact JSON.
pub async fn search_for_ai(engine: &str, q: &str) -> anyhow::Result<String> {
    let hits = search(engine, q).await.map_err(|e| anyhow::anyhow!(e))?;
    Ok(serde_json::to_string(&json!({"engine": engine_name(engine), "results": hits}))?)
}

#[tauri::command]
pub async fn web_search_engine(engine: String, query: String) -> CmdResult<Vec<Hit>> {
    search(&engine, &query).await
}

// ---------------- the hidden browser ----------------

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

async fn read_page(url: &str) -> Result<Value, String> {
    let app = APP.get().ok_or("the app isn't ready")?.clone();
    let _turn = ONE_AT_A_TIME.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
    let target: tauri::Url = url.parse().map_err(|e| format!("{e}"))?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    *PENDING.lock().unwrap() = Some(tx);
    LAST_USED.store(now(), Ordering::SeqCst);
    match app.get_webview_window(LABEL) {
        Some(w) => w.navigate(target).map_err(|e| e.to_string())?,
        None => {
            WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(target))
                .title("Callio web search")
                .visible(false)
                .skip_taskbar(true)
                .focused(false)
                .inner_size(1100.0, 900.0)
                .initialization_script(EXTRACT_JS)
                .on_navigation(|u| {
                    if u.host_str() == Some(RESULT_HOST) {
                        let d = u.query_pairs().find(|(k, _)| k == "d").map(|(_, v)| v.to_string()).unwrap_or_default();
                        let v: Value = serde_json::from_str(&d).unwrap_or(Value::Null);
                        if let Some(tx) = PENDING.lock().unwrap().take() {
                            let _ = tx.send(v);
                        }
                        return false;
                    }
                    true
                })
                .build()
                .map_err(|e| format!("couldn't open the search page: {e}"))?;
        }
    }
    let r = tokio::time::timeout(Duration::from_secs(20), rx).await;
    PENDING.lock().unwrap().take();
    LAST_USED.store(now(), Ordering::SeqCst);
    // close the hidden window after 90 s without searches
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(95)).await;
        if now().saturating_sub(LAST_USED.load(Ordering::SeqCst)) >= 90 {
            if let Some(w) = app2.get_webview_window(LABEL) {
                let _ = w.destroy();
            }
        }
    });
    match r {
        Ok(Ok(v)) if !v.is_null() => Ok(v),
        Ok(_) => Err("the results page sent nothing back".into()),
        Err(_) => {
            // a stuck page: start afresh next time
            if let Some(w) = app.get_webview_window(LABEL) {
                let _ = w.destroy();
            }
            Err("the results page took too long".into())
        }
    }
}

/// Runs on every page the hidden window loads: waits until the engine has drawn its results,
/// reads them and "navigates" to callio-result.invalid with them (the navigation is cancelled
/// and its address delivers the answer — the page itself never talks to Callio).
const EXTRACT_JS: &str = r#"(() => {
  if (window.top !== window || window.__callioSearch) return; window.__callioSearch = 1;
  const H = location.hostname;
  const R = [
    [/(^|\.)scholar\.google\./, { title: '.gs_ri h3 a', block: '.gs_ri', snip: ['.gs_rs'], meta: '.gs_a' }],
    [/(^|\.)google\./, { title: '#rso a h3, #search a h3, #center_col a h3, #main a h3', snip: ['.VwiC3b', '[data-sncf]', '.ITZIwc', '.lEBKkf'] }],
    [/(^|\.)bing\.com$/, { title: '#b_results li.b_algo h2 a', block: 'li.b_algo', snip: ['.b_caption p', '.b_lineclamp2', '.b_lineclamp3', '.b_lineclamp4', '.b_algoSlug', '.b_caption'] }],
    [/search\.yahoo\./, { title: '#web .algo h3 a, #web li .compTitle a, .searchCenterMiddle li h3 a', block: 'li', snip: ['.compText p', '.compText'] }],
    [/(^|\.)yandex\./, { title: '.serp-item .OrganicTitle-Link, .serp-item a.organic__url, li.serp-item h2 a', block: '.serp-item', snip: ['.OrganicText', '.organic__content-wrapper', '.TextContainer'] }],
    [/duckduckgo\.com$/, { title: '.result__a, article[data-testid="result"] h2 a', block: '.result, article', snip: ['.result__snippet', '[data-result="snippet"]'] }],
    [/(^|\.)baidu\.com$/, { title: '#content_left .c-container h3 a, #content_left .result h3 a', block: '.c-container, .result', snip: ['.c-abstract', '[class*="content-right"]', '[class*="summary"]', '.c-span-last'] }],
    [/naver\.com$/, { title: 'a.link_tit, a.title_link, .total_tit a, a.api_txt_lines.total_tit', block: 'li, .total_wrap, .total_area', snip: ['.dsc_txt', '.total_dsc', '.api_txt_lines.dsc_txt', '.dsc_link'] }],
    [/ecosia\.org$/, { title: '[data-test-id="result-link"], a.result-title, .result__title a', block: '[data-test-id="mainline-result-web"], article, .result', snip: ['[data-test-id="web-result-description"]', '.result-snippet', '.web-result__description'] }],
    [/search\.brave\.com$/, { title: '#results .snippet[data-type="web"] .title, #results .snippet[data-type="web"] a.h', block: '.snippet', snip: ['.snippet-description', '.generic-snippet .content', '.snippet-content'] }],
    [/(^|\.)ask\.com$/, { title: '.PartialSearchResults-item-title a, .result .result-title-link, .result-title a', block: '.PartialSearchResults-item, .result', snip: ['.PartialSearchResults-item-abstract', '.result-abstract', '.abstract'] }],
  ];
  const rule = (R.find(([re]) => re.test(H)) || [0, null])[1];
  const GENERIC = { title: 'a h3, h3 a, a h2, h2 a' };
  const own = (u) => { try { const h = new URL(u).hostname; return h === H || h.endsWith('.' + H.split('.').slice(-2).join('.')) && !/scholar\./.test(H); } catch { return true; } };
  const decode = (a, block) => {
    let u = a.href || '';
    try {
      const x = new URL(u);
      if (/bing\.com$/.test(x.hostname) && x.searchParams.get('u')) { const v = x.searchParams.get('u').replace(/^a1/, ''); u = atob(v.replace(/-/g, '+').replace(/_/g, '/')); }
      else if (/yahoo\.com$/.test(x.hostname) && /\/RU=/.test(x.pathname)) u = decodeURIComponent(x.pathname.split('/RU=')[1].split('/')[0]);
      else if (/duckduckgo\.com$/.test(x.hostname) && x.searchParams.get('uddg')) u = x.searchParams.get('uddg');
      else if (/(^|\.)google\./.test(x.hostname) && x.pathname === '/url') u = x.searchParams.get('q') || x.searchParams.get('url') || u;
      else if (/baidu\.com$/.test(x.hostname) && block) u = block.getAttribute('mu') || (block.querySelector('[mu]') || {}).getAttribute?.('mu') || u;
    } catch {}
    return u;
  };
  const read = (r, generic) => {
    const out = [], seen = new Set();
    for (const el of document.querySelectorAll(r.title)) {
      const a = el.closest('a') || el.querySelector('a'); if (!a) continue;
      let block = r.block ? el.closest(r.block) : null;
      if (!block) { block = a; while (block.parentElement && block.parentElement !== document.body && block.parentElement.querySelectorAll(r.title).length <= 1) block = block.parentElement; }
      const u = decode(a, block);
      if (!/^https?:/.test(u) || seen.has(u) || (generic && own(u))) continue;
      const t = (el.innerText || a.innerText || '').trim(); if (!t) continue;
      seen.add(u);
      let d = '';
      for (const s of r.snip || []) { const n = block.querySelector(s); if (n && n.innerText.trim()) { d = n.innerText; break; } }
      if (!d) d = (block.innerText || '').replace(t, '');
      const m = r.meta ? ((block.querySelector(r.meta) || {}).innerText || '') : '';
      out.push({ t, u, d: d.replace(/\s+/g, ' ').trim().slice(0, 400), m });
      if (out.length >= 10) break;
    }
    return out;
  };
  const blocked = () => {
    if (/\/sorry\/|showcaptcha|wappass\.baidu|captcha/i.test(location.href) || document.querySelector('#captcha-form, form[action*="sorry"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .CheckboxCaptcha, #challenge-form')) return 'captcha';
    if (/consent\./.test(H) || document.querySelector('form[action*="consent"]')) return 'consent';
    return '';
  };
  const t0 = Date.now(); let last = -1, lastAt = Date.now(), sent = false;
  const send = (hits, b) => { if (sent) return; sent = true; obs && obs.disconnect(); location.replace('https://callio-result.invalid/?d=' + encodeURIComponent(JSON.stringify({ hits, blocked: b, title: document.title, loc: location.href }))); };
  const check = () => {
    if (sent || !document.body) return;
    const b = blocked(); if (b) return send([], b);
    let hits = rule ? read(rule, false) : [];
    if (!hits.length && Date.now() - t0 > 2500) hits = read(GENERIC, true);
    if (hits.length !== last) { last = hits.length; lastAt = Date.now(); }
    const settled = document.readyState === 'complete' && Date.now() - lastAt > 700;
    if (hits.length >= 10 || (hits.length && settled) || Date.now() - t0 > 12000) send(hits, '');
  };
  let obs = null;
  const start = () => { obs = new MutationObserver(() => { clearTimeout(window.__cs); window.__cs = setTimeout(check, 120); }); obs.observe(document.documentElement, { childList: true, subtree: true }); check(); };
  setInterval(check, 400);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();"#;

// ---------------- scholarly sources with open APIs ----------------

fn client() -> reqwest::Client {
    crate::ai::tools::client()
}
async fn get_json(url: &str) -> Result<Value, String> {
    let r = client().get(url).send().await.map_err(|e| format!("can't be reached: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("answered {}", r.status()));
    }
    r.json().await.map_err(|e| e.to_string())
}
fn clip(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > n {
        s.chars().take(n).collect::<String>() + "…"
    } else {
        s
    }
}
fn authors_of(list: impl Iterator<Item = String>) -> String {
    let v: Vec<String> = list.collect();
    if v.len() > 4 {
        format!("{} et al.", v[..3].join(", "))
    } else {
        v.join(", ")
    }
}
fn meta(parts: &[String]) -> String {
    parts.iter().filter(|s| !s.trim().is_empty()).cloned().collect::<Vec<_>>().join(" · ")
}

async fn semantic(q: &str) -> Result<Vec<Hit>, String> {
    let v = get_json(&format!("https://api.semanticscholar.org/graph/v1/paper/search?limit=10&fields=title,url,abstract,year,authors,venue,externalIds,citationCount&query={}", urlencoding::encode(q))).await.map_err(|e| format!("Semantic Scholar {e}"))?;
    Ok(v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| {
            let doi = p["externalIds"]["DOI"].as_str().unwrap_or_default();
            Hit {
                title: p["title"].as_str().unwrap_or_default().into(),
                url: if doi.is_empty() { p["url"].as_str().unwrap_or_default().into() } else { format!("https://doi.org/{doi}") },
                snippet: clip(p["abstract"].as_str().unwrap_or_default(), 400),
                meta: meta(&[authors_of(p["authors"].as_array().into_iter().flatten().filter_map(|a| a["name"].as_str().map(String::from))), p["year"].as_i64().map(|y| y.to_string()).unwrap_or_default(), p["venue"].as_str().unwrap_or_default().into(), p["citationCount"].as_i64().map(|c| format!("cited by {c}")).unwrap_or_default()]),
            }
        })
        .collect())
}

async fn openalex(q: &str) -> Result<Vec<Hit>, String> {
    let v = get_json(&format!("https://api.openalex.org/works?per-page=10&search={}", urlencoding::encode(q))).await.map_err(|e| format!("OpenAlex {e}"))?;
    Ok(v["results"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|w| {
            // the abstract comes as word → positions
            let mut words: Vec<(u64, String)> = vec![];
            if let Some(ix) = w["abstract_inverted_index"].as_object() {
                for (word, pos) in ix {
                    for p in pos.as_array().into_iter().flatten() {
                        words.push((p.as_u64().unwrap_or(0), word.clone()));
                    }
                }
            }
            words.sort();
            let abs = words.into_iter().map(|w| w.1).collect::<Vec<_>>().join(" ");
            Hit {
                title: w["display_name"].as_str().unwrap_or_default().into(),
                url: w["doi"].as_str().or(w["id"].as_str()).unwrap_or_default().into(),
                snippet: clip(&abs, 400),
                meta: meta(&[authors_of(w["authorships"].as_array().into_iter().flatten().filter_map(|a| a["author"]["display_name"].as_str().map(String::from))), w["publication_year"].as_i64().map(|y| y.to_string()).unwrap_or_default(), w["primary_location"]["source"]["display_name"].as_str().unwrap_or_default().into(), w["cited_by_count"].as_i64().map(|c| format!("cited by {c}")).unwrap_or_default()]),
            }
        })
        .collect())
}

async fn arxiv(q: &str) -> Result<Vec<Hit>, String> {
    let url = format!("https://export.arxiv.org/api/query?max_results=10&search_query=all:{}", urlencoding::encode(q));
    let xml = client().get(url).send().await.map_err(|e| format!("arXiv can't be reached: {e}"))?.text().await.map_err(|e| e.to_string())?;
    let tag = |s: &str, t: &str| -> String {
        let open = format!("<{t}");
        let Some(a) = s.find(&open) else { return String::new() };
        let Some(b) = s[a..].find('>') else { return String::new() };
        let rest = &s[a + b + 1..];
        let end = rest.find(&format!("</{t}>")).unwrap_or(rest.len());
        rest[..end].replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").trim().to_string()
    };
    Ok(xml
        .split("<entry>")
        .skip(1)
        .map(|e| {
            let names = e.split("<author>").skip(1).map(|a| tag(a, "name"));
            Hit {
                title: clip(&tag(e, "title"), 300),
                url: tag(e, "id"),
                snippet: clip(&tag(e, "summary"), 400),
                meta: meta(&[authors_of(names), tag(e, "published").chars().take(4).collect(), "arXiv".into()]),
            }
        })
        .filter(|h| !h.title.is_empty())
        .collect())
}

async fn pubmed(q: &str) -> Result<Vec<Hit>, String> {
    let base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
    let ids = get_json(&format!("{base}/esearch.fcgi?db=pubmed&retmode=json&retmax=10&sort=relevance&term={}", urlencoding::encode(q))).await.map_err(|e| format!("PubMed {e}"))?;
    let ids: Vec<String> = ids["esearchresult"]["idlist"].as_array().into_iter().flatten().filter_map(|i| i.as_str().map(String::from)).collect();
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let v = get_json(&format!("{base}/esummary.fcgi?db=pubmed&retmode=json&id={}", ids.join(","))).await.map_err(|e| format!("PubMed {e}"))?;
    Ok(ids
        .iter()
        .map(|id| {
            let p = &v["result"][id];
            Hit {
                title: p["title"].as_str().unwrap_or_default().into(),
                url: format!("https://pubmed.ncbi.nlm.nih.gov/{id}/"),
                snippet: p["elocationid"].as_str().unwrap_or_default().into(),
                meta: meta(&[authors_of(p["authors"].as_array().into_iter().flatten().filter_map(|a| a["name"].as_str().map(String::from))), p["pubdate"].as_str().unwrap_or_default().chars().take(4).collect(), p["fulljournalname"].as_str().or(p["source"].as_str()).unwrap_or_default().into()]),
            }
        })
        .collect())
}

async fn europepmc(q: &str) -> Result<Vec<Hit>, String> {
    let v = get_json(&format!("https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&pageSize=10&resultType=core&query={}", urlencoding::encode(q))).await.map_err(|e| format!("Europe PMC {e}"))?;
    Ok(v["resultList"]["result"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| {
            let doi = p["doi"].as_str().unwrap_or_default();
            Hit {
                title: p["title"].as_str().unwrap_or_default().into(),
                url: if doi.is_empty() { format!("https://europepmc.org/article/{}/{}", p["source"].as_str().unwrap_or("MED"), p["id"].as_str().unwrap_or_default()) } else { format!("https://doi.org/{doi}") },
                snippet: clip(&p["abstractText"].as_str().unwrap_or_default().replace(|c| c == '<' || c == '>', " "), 400),
                meta: meta(&[p["authorString"].as_str().map(|s| clip(s, 80)).unwrap_or_default(), p["pubYear"].as_str().unwrap_or_default().into(), p["journalTitle"].as_str().or(p["journalInfo"]["journal"]["title"].as_str()).unwrap_or_default().into(), p["citedByCount"].as_i64().map(|c| format!("cited by {c}")).unwrap_or_default()]),
            }
        })
        .collect())
}

async fn crossref(q: &str) -> Result<Vec<Hit>, String> {
    let v = get_json(&format!("https://api.crossref.org/works?rows=10&select=DOI,title,author,issued,container-title,abstract,is-referenced-by-count&query={}", urlencoding::encode(q))).await.map_err(|e| format!("Crossref {e}"))?;
    Ok(v["message"]["items"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|w| Hit {
            title: w["title"][0].as_str().unwrap_or_default().into(),
            url: format!("https://doi.org/{}", w["DOI"].as_str().unwrap_or_default()),
            snippet: clip(&regex_lite::Regex::new(r"<[^>]+>").unwrap().replace_all(w["abstract"].as_str().unwrap_or_default(), " "), 400),
            meta: meta(&[
                authors_of(w["author"].as_array().into_iter().flatten().map(|a| format!("{} {}", a["given"].as_str().unwrap_or_default(), a["family"].as_str().unwrap_or_default()).trim().to_string())),
                w["issued"]["date-parts"][0][0].as_i64().map(|y| y.to_string()).unwrap_or_default(),
                w["container-title"][0].as_str().unwrap_or_default().into(),
                w["is-referenced-by-count"].as_i64().map(|c| format!("cited by {c}")).unwrap_or_default(),
            ]),
        })
        .filter(|h| !h.title.is_empty())
        .collect())
}

async fn dblp(q: &str) -> Result<Vec<Hit>, String> {
    let v = get_json(&format!("https://dblp.org/search/publ/api?format=json&h=10&q={}", urlencoding::encode(q))).await.map_err(|e| format!("DBLP {e}"))?;
    Ok(v["result"]["hits"]["hit"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|h| {
            let i = &h["info"];
            let au = &i["authors"]["author"];
            let names: Vec<String> = match au.as_array() {
                Some(a) => a.iter().filter_map(|x| x["text"].as_str().map(String::from)).collect(),
                None => au["text"].as_str().map(|s| vec![s.to_string()]).unwrap_or_default(),
            };
            Hit {
                title: i["title"].as_str().unwrap_or_default().trim_end_matches('.').into(),
                url: i["ee"].as_str().or(i["url"].as_str()).unwrap_or_default().into(),
                snippet: String::new(),
                meta: meta(&[authors_of(names.into_iter()), i["year"].as_str().unwrap_or_default().into(), i["venue"].as_str().unwrap_or_default().into()]),
            }
        })
        .collect())
}
