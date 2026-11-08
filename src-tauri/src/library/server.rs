//! Local endpoint for Callio's Microsoft Edge extension ("Save to Callio").
//!   GET  /callio/ping          → {app, version, paired}
//!   POST /callio/pair          → asks the user in Callio; on yes returns {token}
//!   GET  /callio/collections   → collections            (token)
//!   POST /callio/lookup        → is this page already in the library? (token)
//!   POST /callio/add           → add a paper (+ PDF)     (token)
//! Listens on 127.0.0.1 only, port 27183 (or the next free one up to 27189). Everything but
//! ping and pair needs the token the user approved, sent as X-Callio-Token.
use super::{add, with, AddRequest, Paper};
use serde::Deserialize;
use crate::localhttp::{read_req, respond_with};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::BufReader;
use tokio::net::{TcpListener, TcpStream};

pub const PORTS: std::ops::RangeInclusive<u16> = 27183..=27189;
const SECRET: &str = "library-extension-token";

/// Tokens per extension origin (each browser extension pairs separately).
fn tokens() -> std::collections::HashMap<String, String> {
    crate::settings::get_secret_value(SECRET).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}
fn save_token(origin: &str, token: &str) {
    let mut m = tokens();
    m.insert(origin.to_string(), token.to_string());
    if let Ok(v) = serde_json::to_string(&m) {
        crate::settings::put_secret_value(SECRET, &v);
    }
}

/// What the extension may send — nothing that touches local files or links.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ExtMeta {
    title: String,
    authors: Vec<String>,
    year: Option<i32>,
    #[serde(rename = "type")]
    kind: String,
    venue: String,
    volume: String,
    issue: String,
    pages: String,
    publisher: String,
    doi: String,
    arxiv: String,
    url: String,
    #[serde(rename = "abstract")]
    abstract_: String,
    tags: Vec<String>,
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ExtAdd {
    meta: ExtMeta,
    pdf_base64: Option<String>,
    pdf_url: Option<String>,
    page_url: Option<String>,
    collection: Option<String>,
}
impl From<ExtAdd> for AddRequest {
    fn from(x: ExtAdd) -> Self {
        let m = x.meta;
        let web = |u: Option<String>| u.filter(|u| u.starts_with("https://") || u.starts_with("http://"));
        let kinds = ["article", "inproceedings", "incollection", "book", "misc", "phdthesis", "mastersthesis", "techreport"];
        AddRequest {
            meta: Paper {
                title: m.title.chars().take(1000).collect(),
                authors: m.authors.into_iter().take(500).map(|a| a.chars().take(200).collect()).collect(),
                year: m.year.filter(|y| (1000..3000).contains(y)),
                kind: if kinds.contains(&m.kind.as_str()) { m.kind } else { String::new() },
                venue: m.venue.chars().take(500).collect(),
                volume: m.volume.chars().take(40).collect(),
                issue: m.issue.chars().take(40).collect(),
                pages: m.pages.chars().take(40).collect(),
                publisher: m.publisher.chars().take(300).collect(),
                doi: m.doi.chars().take(200).collect(),
                arxiv: m.arxiv.chars().take(40).collect(),
                url: web(Some(m.url)).unwrap_or_default(),
                abstract_: m.abstract_.chars().take(20000).collect(),
                tags: m.tags.into_iter().take(30).map(|t| t.chars().take(60).collect()).collect(),
                ..Default::default()
            },
            pdf_base64: x.pdf_base64,
            pdf_url: web(x.pdf_url),
            page_url: web(x.page_url),
            collection: x.collection.filter(|c| c.len() < 64 && c.chars().all(|ch| ch.is_ascii_alphanumeric())),
            lookup: Some(true),
            ..Default::default()
        }
    }
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut listener = None;
        for p in PORTS {
            if let Ok(l) = TcpListener::bind(("127.0.0.1", p)).await {
                listener = Some(l);
                break;
            }
        }
        let Some(listener) = listener else { return };
        let slots = Arc::new(tokio::sync::Semaphore::new(16));
        loop {
            let Ok((sock, _)) = listener.accept().await else { continue };
            let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
            let app = app.clone();
            tokio::spawn(async move {
                let _ = serve(sock, app).await;
                drop(permit);
            });
        }
    });
}

static PAIRING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn serve(sock: TcpStream, app: AppHandle) -> anyhow::Result<()> {
    let (rd, mut w) = sock.into_split();
    let mut r = BufReader::new(rd);
    let toks = tokens();
    let authed = |h: &std::collections::HashMap<String, String>| {
        let o = h.get("origin").map(|s| s.as_str()).unwrap_or("");
        toks.get(o).map(|t| t.len() >= 32 && h.get("x-callio-token").map(|v| v == t).unwrap_or(false)).unwrap_or(false)
    };
    let limit = |h: &std::collections::HashMap<String, String>| if authed(h) { 250 << 20 } else if h.get("x-callio-pair").is_some() { 4096 } else { 0 };
    let mut req = match tokio::time::timeout(Duration::from_secs(300), read_req(&mut r, limit)).await {
        Ok(Ok(Some(q))) => q,
        _ => return Ok(()),
    };
    let origin = req.headers.get("origin").cloned().unwrap_or_default();
    let body = std::mem::take(&mut req.body);
    // Only browser extensions may call; web pages (http/https origins) may not.
    let ext_origin = origin.starts_with("chrome-extension://") || origin.starts_with("extension://") || origin.starts_with("moz-extension://");
    let cors = if ext_origin && !origin.is_empty() { format!("Access-Control-Allow-Origin: {origin}\r\nAccess-Control-Allow-Headers: Content-Type, X-Callio-Token, X-Callio-Pair\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nConnection: close\r\n") } else { "Connection: close\r\n".to_string() };
    let send = |code: u16, v: Value| (code, v.to_string());
    let path = req.path.split('?').next().unwrap_or("").to_string();
    let (code, body) = if !ext_origin {
        send(403, json!({"error": "not allowed"}))
    } else if req.method == "OPTIONS" {
        (204, String::new())
    } else {
        match (req.method.as_str(), path.as_str()) {
            ("GET", "/callio/ping") => send(200, json!({"app": "callio", "version": env!("CARGO_PKG_VERSION"), "paired": authed(&req.headers)})),
            ("POST", "/callio/pair") => {
                let _one = PAIRING.lock().await;
                let name: String = serde_json::from_slice::<Value>(&body).ok().and_then(|v| v["browser"].as_str().map(|s| s.chars().take(60).collect())).unwrap_or_else(|| "a browser extension".into());
                let ask = crate::claude_code::mcp::window_asker(app.clone());
                let ok = ask("library_pair".into(), json!({"browser": name, "origin": origin}), Duration::from_secs(120)).await.and_then(|v| v.as_bool()).unwrap_or(false);
                if ok {
                    let t = crate::claude_code::mcp::random_token();
                    save_token(&origin, &t);
                    send(200, json!({"token": t}))
                } else {
                    send(403, json!({"error": "Pairing was declined in Callio"}))
                }
            }
            _ if !authed(&req.headers) => send(401, json!({"error": "Not paired with Callio — open the extension and click Connect"})),
            ("GET", "/callio/collections") => match with(&app, false, |l| l.collections.iter().map(|c| json!({"id": c.id, "name": c.name, "parent": c.parent})).collect::<Vec<_>>()) {
                Ok(v) => send(200, json!({"collections": v})),
                Err(e) => send(500, json!({"error": e.to_string()})),
            },
            ("POST", "/callio/lookup") => {
                let v: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
                let p = super::lookup(&app, v["doi"].as_str(), v["title"].as_str());
                send(200, json!({"found": p.is_some(), "id": p.as_ref().map(|p| p.id.clone()), "title": p.map(|p| p.title)}))
            }
            ("POST", "/callio/add") => match { let parsed = serde_json::from_slice::<ExtAdd>(&body); drop(body); parsed } {
                Ok(a) => match add(&app, AddRequest::from(a)).await {
                    Ok(r) => send(200, serde_json::to_value(r).unwrap_or(Value::Null)),
                    Err(e) => send(500, json!({"error": e.to_string()})),
                },
                Err(e) => send(400, json!({"error": format!("bad request: {e}")})),
            },
            _ => send(404, json!({"error": "not found"})),
        }
    };
    respond_with(&mut w, code, "application/json", body.as_bytes(), &cors).await?;
    Ok(())
}

/// Write the bundled Edge extension to the app data folder (so it can be loaded in Edge).
#[tauri::command]
pub fn lib_extension_dir(app: AppHandle) -> crate::util::CmdResult<String> {
    use crate::util::ErrStr;
    let d = crate::settings::data_dir(&app).join("edge-extension");
    std::fs::create_dir_all(d.join("icons")).es()?;
    for (name, bytes) in EXTENSION_FILES {
        std::fs::write(d.join(name), bytes).es()?;
    }
    Ok(d.to_string_lossy().to_string())
}

/// Open Edge's extensions page (to turn on Developer mode and load the folder).
#[tauri::command]
pub fn lib_open_edge_extensions() -> crate::util::CmdResult<()> {
    #[cfg(windows)]
    {
        use crate::util::ErrStr;
        let mut cands = Vec::new();
        for k in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
            if let Some(d) = std::env::var_os(k) {
                cands.push(std::path::PathBuf::from(d).join(r"Microsoft\Edge\Application\msedge.exe"));
            }
        }
        let edge = cands.into_iter().find(|p| p.is_file()).ok_or("Microsoft Edge wasn't found")?;
        std::process::Command::new(edge).arg("edge://extensions/").spawn().es()?;
    }
    Ok(())
}

macro_rules! ext_files {
    ($($name:literal),*) => { &[ $( ($name, include_bytes!(concat!("../../../edge-extension/", $name)) as &[u8]) ),* ] };
}
const EXTENSION_FILES: &[(&str, &[u8])] = ext_files!("manifest.json", "background.js", "popup.html", "popup.js", "popup.css", "extract.js", "icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png");
