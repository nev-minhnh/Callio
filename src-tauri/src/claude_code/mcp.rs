//! Callio's MCP server for Claude Code: a tiny Streamable-HTTP server on 127.0.0.1 with a
//! random bearer token. It gives Claude Code
//!   approve       — the permission prompt: Callio asks the author (with a diff for edits)
//!   editor_state  — which file the author is looking at, cursor line, selection, errors
//!   compile       — compile the LaTeX project in Callio and return the errors
//!   open_file     — show a file (at a line) to the author
//! Requests that need the author or the editor go to the window as "cc-rpc" events and wait
//! for `cc_reply`.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

/// How the server asks the window (method, params, timeout) → answer.
pub type Asker = Arc<dyn Fn(String, Value, Duration) -> Pin<Box<dyn Future<Output = Option<Value>> + Send>> + Send + Sync>;

pub fn window_asker(app: AppHandle) -> Asker {
    Arc::new(move |m, p, t| {
        let app = app.clone();
        Box::pin(async move { ask_window(&app, &m, p, t).await })
    })
}

pub struct Server {
    pub port: u16,
    pub token: String,
}

static PENDING: Mutex<Option<HashMap<u64, oneshot::Sender<Value>>>> = Mutex::new(None);
static SEQ: AtomicU64 = AtomicU64::new(1);

/// Answer from the window to a "cc-rpc" request.
pub fn reply(rpc: u64, value: Value) {
    if let Some(tx) = PENDING.lock().unwrap().as_mut().and_then(|m| m.remove(&rpc)) {
        let _ = tx.send(value);
    }
}

/// Decline every open question (used when a run is stopped).
pub fn cancel_all() {
    let drained: Vec<_> = PENDING.lock().unwrap().as_mut().map(|m| m.drain().collect()).unwrap_or_default();
    for (_, tx) in drained {
        let _ = tx.send(json!({"allow": false, "message": "Stopped by the user"}));
    }
}

async fn ask_window(app: &AppHandle, method: &str, params: Value, timeout: Duration) -> Option<Value> {
    let rpc = SEQ.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    PENDING.lock().unwrap().get_or_insert_with(HashMap::new).insert(rpc, tx);
    // Removes the question and its card however this ends — answered, timed out, or
    // dropped because Claude Code went away.
    struct Guard<'a> {
        app: &'a AppHandle,
        rpc: u64,
        answered: bool,
    }
    impl Drop for Guard<'_> {
        fn drop(&mut self) {
            if let Some(m) = PENDING.lock().unwrap().as_mut() {
                m.remove(&self.rpc);
            }
            if !self.answered {
                let _ = self.app.emit("cc-rpc-cancel", json!({"rpc": self.rpc}));
            }
        }
    }
    let mut g = Guard { app, rpc, answered: false };
    let _ = app.emit("cc-rpc", json!({"rpc": rpc, "method": method, "params": params}));
    let r = tokio::time::timeout(timeout, rx).await.ok().and_then(|r| r.ok());
    g.answered = r.is_some();
    r
}

pub fn random_token() -> String {
    let mut b = [0u8; 32];
    if getrandom::getrandom(&mut b).is_err() {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
        return crate::util::sha256_hex(format!("{t}-{}-{:p}", std::process::id(), &b).as_bytes());
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub async fn start(app: Asker) -> anyhow::Result<Server> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let token = random_token();
    let tok = token.clone();
    let slots = Arc::new(tokio::sync::Semaphore::new(32));
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else { continue };
            let Ok(permit) = slots.clone().try_acquire_owned() else { continue }; // too many: drop
            let (app, tok) = (app.clone(), tok.clone());
            tokio::spawn(async move {
                let _ = serve(sock, app, tok).await;
                drop(permit);
            });
        }
    });
    Ok(Server { port, token })
}

async fn serve(sock: TcpStream, app: Asker, token: String) -> anyhow::Result<()> {
    let (rd, mut w) = sock.into_split();
    let mut r = BufReader::new(rd);
    // an idle or slow client is dropped after 2 minutes
    while let Some(req) = tokio::time::timeout(Duration::from_secs(120), crate::localhttp::read_req(&mut r, |h| if h.get("authorization").map(|v| v == &format!("Bearer {token}")).unwrap_or(false) { 8 << 20 } else { 0 })).await.map_err(|_| anyhow::anyhow!("timeout"))?? {
        // Only Claude Code with the token may talk to us; browsers can't (no CORS, Origin check).
        let authed = req.headers.get("authorization").map(|v| v == &format!("Bearer {token}")).unwrap_or(false);
        let foreign_origin = req.headers.get("origin").map(|o| !o.starts_with("http://127.0.0.1") && !o.starts_with("http://localhost")).unwrap_or(false);
        if !req.path.starts_with("/mcp") {
            crate::localhttp::respond(&mut w, 404, "text/plain", b"not found").await?;
            continue;
        }
        if !authed || foreign_origin {
            crate::localhttp::respond(&mut w, 401, "text/plain", b"unauthorized").await?;
            continue;
        }
        match req.method.as_str() {
            "POST" => {}
            "DELETE" => {
                crate::localhttp::respond(&mut w, 200, "text/plain", b"").await?;
                continue;
            }
            _ => {
                crate::localhttp::respond(&mut w, 405, "text/plain", b"").await?;
                continue;
            }
        }
        let Ok(msg) = serde_json::from_slice::<Value>(&req.body) else {
            crate::localhttp::respond(&mut w, 400, "application/json", json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}).to_string().as_bytes()).await?;
            continue;
        };
        // notifications and responses: nothing to answer
        if msg.get("id").is_none() || msg.get("method").is_none() {
            crate::localhttp::respond(&mut w, 202, "text/plain", b"").await?;
            continue;
        }
        let id = msg["id"].clone();
        let method = msg["method"].as_str().unwrap_or("").to_string();
        if method == "tools/call" {
            // A tool call may wait for the author for minutes: answer as an event stream and
            // keep it alive with comments so no HTTP timeout cuts it off.
            w.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").await?;
            w.flush().await?;
            let fut = call_tool(&app, &msg["params"]);
            tokio::pin!(fut);
            let mut tick = tokio::time::interval(Duration::from_secs(15));
            tick.tick().await;
            let result = loop {
                tokio::select! {
                    r = &mut fut => break r,
                    _ = tick.tick() => {
                        if w.write_all(b": keep-alive\n\n").await.is_err() {
                            return Ok(()); // Claude Code went away (run stopped)
                        }
                        let _ = w.flush().await;
                    }
                }
            };
            let body = json!({"jsonrpc":"2.0","id":id,"result":result});
            w.write_all(format!("event: message\ndata: {body}\n\n").as_bytes()).await?;
            w.flush().await?;
            return Ok(());
        }
        let out = match method.as_str() {
            "initialize" => json!({"jsonrpc":"2.0","id":id,"result":{
                "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": "callio", "version": env!("CARGO_PKG_VERSION")},
                "instructions": "Callio is the editor the author is using (Markdown, LaTeX, Word documents, spreadsheets, presentations, pictures, PDFs). Use editor_state to see what they are looking at, compile to build the LaTeX project and read its errors, open_file to show them a place in a file. For Word documents, spreadsheets, presentations, pictures and PDFs never write the files yourself: read them with office_read and change them with word_edit, sheet_edit, deck_edit, image_edit or pdf_tool, so the author sees the change and can undo it."
            }}),
            "ping" => json!({"jsonrpc":"2.0","id":id,"result":{}}),
            "tools/list" => json!({"jsonrpc":"2.0","id":id,"result":{"tools": tools()}}),
            _ => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}}),
        };
        crate::localhttp::respond(&mut w, 200, "application/json", out.to_string().as_bytes()).await?;
        if req.headers.get("connection").map(|c| c.eq_ignore_ascii_case("close")).unwrap_or(false) {
            break;
        }
    }
    Ok(())
}

fn tools() -> Value {
    let mut v = base_tools();
    if let Some(a) = v.as_array_mut() {
        a.extend(crate::ai::office_tools::mcp_defs());
    }
    v
}

fn base_tools() -> Value {
    json!([
        {"name": "approve", "description": "Permission prompt (used by Claude Code itself).",
         "inputSchema": {"type": "object", "properties": {"tool_name": {"type": "string"}, "input": {"type": "object"}, "tool_use_id": {"type": "string"}}, "required": ["tool_name", "input"]}},
        {"name": "editor_state", "description": "What the author has open in Callio: file path, cursor line, selected text, whether there are unsaved changes, and the latest LaTeX compile errors.",
         "inputSchema": {"type": "object", "properties": {}}},
        {"name": "compile", "description": "Compile the LaTeX project in Callio (saves open files first) and return errors and warnings with file and line. Use after editing .tex or .bib files.",
         "inputSchema": {"type": "object", "properties": {}}},
        {"name": "open_file", "description": "Open a file in Callio's editor for the author, optionally at a line.",
         "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}, "line": {"type": "integer"}}, "required": ["path"]}},
        {"name": "search_library", "description": "Search the author's paper library in Callio (titles, authors, abstracts and the full text of their saved PDFs). Returns citation keys, titles, years and matching passages with page numbers. Prefer these papers when citing, and use their keys.",
         "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["query"]}},
        {"name": "read_library_paper", "description": "Read the text of a paper in the author's Callio library by citation key (optionally a page range).",
         "inputSchema": {"type": "object", "properties": {"key": {"type": "string"}, "from_page": {"type": "integer"}, "to_page": {"type": "integer"}}, "required": ["key"]}},
        {"name": "read_pdf", "description": "Read the text of a PDF file (any path, or relative to the project folder), optionally a page range. Use this for PDFs instead of pdftoppm, Python or other tools.",
         "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}, "from_page": {"type": "integer"}, "to_page": {"type": "integer"}}, "required": ["path"]}},
        {"name": "view_pdf_page", "description": "See one page of a PDF as an image (figures, tables, equations, layout).",
         "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}, "page": {"type": "integer"}}, "required": ["path", "page"]}},
        {"name": "library_bibtex", "description": "BibTeX entries for papers in the author's Callio library, by citation key (comma-separated). Use these exact entries when adding references to a .bib file.",
         "inputSchema": {"type": "object", "properties": {"keys": {"type": "string"}}, "required": ["keys"]}}
    ])
}

fn text_result(v: Value, is_error: bool) -> Value {
    // {"text": …, "images": [{"data": base64, "mimeType": …}]} → text + image content
    if let Some(imgs) = v.get("images").and_then(|i| i.as_array()) {
        let mut content = vec![json!({"type": "text", "text": v["text"].as_str().unwrap_or("")})];
        for im in imgs {
            content.push(json!({"type": "image", "data": im["data"], "mimeType": im["mimeType"].as_str().unwrap_or("image/png")}));
        }
        return json!({"content": content, "isError": is_error});
    }
    let text = match v {
        Value::String(s) => s,
        other => serde_json::to_string_pretty(&other).unwrap_or_default(),
    };
    json!({"content": [{"type": "text", "text": text}], "isError": is_error})
}

async fn call_tool(app: &Asker, params: &Value) -> Value {
    let name = params["name"].as_str().unwrap_or("");
    let args = params.get("arguments").cloned().unwrap_or(json!({}));
    match name {
        "approve" => {
            let tool = args["tool_name"].as_str().unwrap_or("").to_string();
            let input = args.get("input").cloned().unwrap_or(json!({}));
            // Callio's own tools never need a question
            let decision = if tool.starts_with("mcp__callio__") {
                json!({"behavior": "allow", "updatedInput": input})
            } else {
                match app("permission".into(), json!({"toolName": tool, "input": input}), Duration::from_secs(3600)).await {
                    Some(a) if a["allow"].as_bool() == Some(true) => json!({"behavior": "allow", "updatedInput": input}),
                    Some(a) => json!({"behavior": "deny", "message": a["message"].as_str().filter(|m| !m.is_empty()).map(|m| format!("The author declined: {m}")).unwrap_or_else(|| "The author declined this action.".into())}),
                    None => json!({"behavior": "deny", "message": "No answer from the author."}),
                }
            };
            text_result(Value::String(decision.to_string()), false)
        }
        "view_pdf_page" => match app("pdf_page_image".into(), args, Duration::from_secs(60)).await {
            Some(v) if v["data"].is_string() => json!({"content": [{"type": "image", "data": v["data"], "mimeType": "image/png"}, {"type": "text", "text": format!("Page {} of {}", v["page"], v["pages"])}]}),
            Some(v) => text_result(v, true),
            None => text_result(Value::String("Callio did not answer (is the window open?)".into()), true),
        },
        "read_pdf" => match app("pdf_text".into(), args, Duration::from_secs(120)).await {
            Some(v) => text_result(v, false),
            None => text_result(Value::String("Callio did not answer (is the window open?)".into()), true),
        },
        "editor_state" | "compile" | "open_file" | "search_library" | "read_library_paper" | "library_bibtex" => {
            let wait = if name == "compile" { 600 } else { 30 };
            match app(name.to_string(), args, Duration::from_secs(wait)).await {
                Some(v) => text_result(v, false),
                None => text_result(Value::String("Callio did not answer (is the window open?)".into()), true),
            }
        }
        n if crate::ai::office_tools::NAMES.contains(&n) => match app(n.to_string(), args, Duration::from_secs(600)).await {
            Some(v) => {
                let err = v.get("error").is_some();
                text_result(v, err)
            }
            None => text_result(Value::String("Callio did not answer (is the window open?)".into()), true),
        },
        _ => text_result(Value::String(format!("Unknown tool {name}")), true),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn token_is_random() {
        let a = super::random_token();
        assert_eq!(a.len(), 64);
        assert_ne!(a, super::random_token());
    }
}
