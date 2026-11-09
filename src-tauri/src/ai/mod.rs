//! AI providers. Two wire protocols cover everything:
//!   - Anthropic Messages API (Claude)
//!   - OpenAI-compatible Chat Completions (ChatGPT, Gemini, Perplexity, Grok, llama.cpp, custom)
//! Responses stream to the UI as "ai-event"s; tool calls run here in Rust in a loop.
pub mod bib;
pub mod skills;
pub mod skills_github;
pub mod tools;
pub mod office_tools;

use crate::util::{CmdResult, ErrStr};
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tools::ToolContext;

#[derive(Default)]
pub struct AiState {
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    /// "anthropic" | "openai"
    pub kind: String,
    pub base_url: String,
    #[serde(default)]
    pub no_tools: bool,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Msg {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub id: String,
    pub provider: Provider,
    pub model: String,
    #[serde(default)]
    pub system: String,
    pub messages: Vec<Msg>,
    #[serde(default)]
    pub tools: bool,
    #[serde(default)]
    pub web: bool,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub search_backend: String,
    #[serde(default)]
    pub search_url: String,
    /// skills the model may load on demand with `use_skill` (name, path)
    #[serde(default)]
    pub skills: Vec<SkillRef>,
    /// "low" | "medium" | "high" | "xhigh" | "max" (Claude); None = model default
    #[serde(default)]
    pub effort: Option<String>,
    /// ask the model to think and stream its (summarized) thinking
    #[serde(default)]
    pub thinking: bool,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct SkillRef {
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Event {
    id: String,
    /// "text" | "thinking" | "tool" | "tool_done" | "sources" | "done" | "error"
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

type EmitFn = Arc<dyn Fn(Event) + Send + Sync>;

struct Sink {
    out: EmitFn,
    id: String,
    cancel: Arc<AtomicBool>,
    full: String,
}
impl Sink {
    fn emit(&self, kind: &str, text: Option<String>, data: Option<Value>) {
        (self.out)(Event { id: self.id.clone(), kind: kind.into(), text, data });
    }
    fn text(&mut self, t: &str) {
        if !t.is_empty() {
            self.full.push_str(t);
            self.emit("text", Some(t.to_string()), None);
        }
    }
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

pub fn key_for(provider_id: &str) -> Option<String> {
    #[cfg(test)]
    if let Ok(k) = std::env::var("CALLIO_TEST_KEY") {
        return Some(k);
    }
    crate::settings::get_secret_value(&format!("ai-key-{provider_id}"))
}

fn http() -> reqwest::Client {
    reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).build().unwrap()
}

// ---------------- SSE ----------------

/// Read a server-sent-events stream, calling `on` with (event name, data) for each event.
async fn sse(mut resp: reqwest::Response, cancel: &AtomicBool, mut on: impl FnMut(&str, &str) -> Result<()>) -> Result<()> {
    // Work on bytes and decode only complete events, so multi-byte characters split across
    // network chunks aren't corrupted.
    let mut buf: Vec<u8> = Vec::new();
    let mut last_data = std::time::Instant::now();
    let mut finished = false;
    while !finished {
        let chunk = tokio::select! {
            c = resp.chunk() => c?,
            _ = async { while !cancel.load(Ordering::SeqCst) { tokio::time::sleep(Duration::from_millis(150)).await; } } => bail!("Stopped"),
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                if last_data.elapsed() > Duration::from_secs(180) {
                    bail!("The model stopped responding (no data for 3 minutes)");
                }
                continue;
            }
        };
        match chunk {
            Some(c) => {
                last_data = std::time::Instant::now();
                buf.extend_from_slice(&c);
            }
            None => {
                finished = true;
                buf.extend_from_slice(b"\n\n"); // flush a final event without a blank line
            }
        }
        loop {
            let pos = find(&buf, b"\n\n").map(|p| (p, 2)).or_else(|| find(&buf, b"\r\n\r\n").map(|p| (p, 4)));
            let Some((p, n)) = pos else { break };
            let block = String::from_utf8_lossy(&buf[..p]).to_string();
            buf.drain(..p + n);
            let (mut ev, mut data) = (String::new(), String::new());
            for line in block.lines() {
                if let Some(v) = line.strip_prefix("event:") {
                    ev = v.trim().to_string();
                } else if let Some(v) = line.strip_prefix("data:") {
                    if !data.is_empty() {
                        data.push('\n');
                    }
                    data.push_str(v.strip_prefix(' ').unwrap_or(v));
                }
            }
            if !data.is_empty() {
                on(&ev, &data)?;
            }
        }
    }
    Ok(())
}

fn find(h: &[u8], n: &[u8]) -> Option<usize> {
    h.windows(n.len()).position(|w| w == n)
}

async fn check(resp: reqwest::Response) -> Result<reqwest::Response> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().or(v["error"].as_str()).or(v["message"].as_str()).map(String::from))
        .unwrap_or_else(|| body.chars().take(400).collect());
    let hint = match status.as_u16() {
        401 | 403 => " — check the API key in Settings → AI.",
        404 => " — check the model name and base URL.",
        429 => " — rate limit or quota reached.",
        _ => "",
    };
    bail!("{} {msg}{hint}", status)
}

// ---------------- Anthropic ----------------

/// Opus 4.7+ and the 5.x generation: adaptive thinking, xhigh/max effort, no temperature.
fn claude_new_gen(m: &str) -> bool {
    m.contains("opus-4-7") || m.contains("opus-4-8") || m.contains("-5") && !m.contains("-4-5") && !m.contains("3-5")
}
fn claude_adaptive(m: &str) -> bool {
    claude_new_gen(m) || m.contains("opus-4-6") || m.contains("sonnet-4-6")
}
fn claude_can_think(m: &str) -> bool {
    !m.contains("claude-3-") && !m.contains("haiku-3")
}
fn claude_effort_ok(m: &str) -> bool {
    claude_adaptive(m) || m.contains("opus-4-5")
}

const ANTHROPIC_WEB_SEARCH: &str = "web_search_20250305";

/// The messages with a cache breakpoint on the block before the newest user turn (and on the
/// newest block during tool rounds), so the conversation so far is read from the cache.
fn with_cache_mark(messages: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = messages.to_vec();
    let n = out.len();
    // the newest message is new; the one before it ends the cached part
    let idx = if n >= 2 && out[n - 1]["role"] == "user" && out[n - 1]["content"].is_string() { n - 2 } else { n.saturating_sub(1) };
    if let Some(m) = out.get_mut(idx) {
        if let Some(t) = m["content"].as_str().map(|s| s.to_string()) {
            if !t.is_empty() {
                m["content"] = json!([{ "type": "text", "text": t, "cache_control": { "type": "ephemeral" } }]);
            }
        } else if let Some(arr) = m["content"].as_array_mut() {
            if let Some(last) = arr.iter_mut().rev().find(|b| matches!(b["type"].as_str(), Some("text") | Some("tool_result") | Some("tool_use"))) {
                last["cache_control"] = json!({ "type": "ephemeral" });
            }
        }
    }
    out
}

async fn run_anthropic(req: &ChatRequest, ctx: &ToolContext, sink: &mut Sink) -> Result<()> {
    let key = key_for(&req.provider.id).ok_or_else(|| anyhow!("No API key for Claude — add it in Settings → AI."))?;
    let base = req.provider.base_url.trim_end_matches('/');
    let mut messages: Vec<Value> = req.messages.iter().map(|m| json!({"role": if m.role == "assistant" { "assistant" } else { "user" }, "content": m.content})).collect();
    let mut tool_defs: Vec<Value> = Vec::new();
    if req.tools {
        for d in tools::definitions(ctx) {
            // Claude has its own web search, unless the author picked an engine in the chat
            let picked = ctx.search_backend.starts_with("engine:") && ctx.search_backend != "engine:auto";
            if d["name"] == "web_search" && !picked {
                continue;
            }
            tool_defs.push(json!({"name": d["name"], "description": d["description"], "input_schema": d["parameters"]}));
        }
        if req.web && !(ctx.search_backend.starts_with("engine:") && ctx.search_backend != "engine:auto") {
            tool_defs.push(json!({"type": ANTHROPIC_WEB_SEARCH, "name": "web_search", "max_uses": 5}));
        }
    }
    for _round in 0..10 {
        let m = req.model.as_str();
        let new_gen = claude_new_gen(m);
        let think = req.thinking && claude_can_think(m);
        let max = req.max_tokens.unwrap_or(if think { 32000 } else { 8192 });
        // prompt caching: the instructions (stable from turn to turn) and everything up to the
        // newest message are cached, so follow-up turns and tool rounds re-read them at a
        // fraction of the price; the per-turn context sits in the last message, after the cache
        let mut body = json!({"model": req.model, "max_tokens": max, "messages": with_cache_mark(&messages), "stream": true});
        if !req.system.is_empty() {
            body["system"] = json!([{ "type": "text", "text": req.system, "cache_control": { "type": "ephemeral" } }]);
        }
        if !tool_defs.is_empty() {
            body["tools"] = json!(tool_defs);
        }
        if think {
            body["thinking"] = if claude_adaptive(m) { json!({"type": "adaptive", "display": "summarized"}) } else { json!({"type": "enabled", "budget_tokens": (max / 2).max(1024)}) };
        }
        if let Some(e) = req.effort.as_deref().filter(|e| !e.is_empty() && claude_effort_ok(m)) {
            let e = if (e == "xhigh" || e == "max") && !new_gen { "high" } else { e };
            body["output_config"] = json!({"effort": e});
        }
        // newer models (and any thinking request) reject a sampling temperature
        if let Some(t) = req.temperature.filter(|_| !think && !new_gen) {
            body["temperature"] = json!(t);
        }
        let resp = http()
            .post(format!("{base}/v1/messages"))
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await?;
        let resp = check(resp).await?;
        let mut blocks: Vec<Value> = Vec::new();
        let mut partial: HashMap<usize, String> = HashMap::new();
        let mut stop = String::new();
        let cancel = sink.cancel.clone();
        sse(resp, &cancel, |ev, data| {
            let v: Value = serde_json::from_str(data).unwrap_or(Value::Null);
            match ev {
                "content_block_start" => {
                    let i = v["index"].as_u64().unwrap_or(0) as usize;
                    let b = v["content_block"].clone();
                    if b["type"] == "server_tool_use" {
                        sink.emit("tool", Some("Searching the web…".into()), Some(json!({"name": "web_search"})));
                    }
                    if b["type"] == "web_search_tool_result" {
                        let src: Vec<Value> = b["content"].as_array().into_iter().flatten().map(|r| json!({"title": r["title"], "url": r["url"]})).collect();
                        sink.emit("sources", None, Some(json!(src)));
                    }
                    while blocks.len() <= i {
                        blocks.push(Value::Null);
                    }
                    blocks[i] = b;
                }
                "content_block_delta" => {
                    let i = v["index"].as_u64().unwrap_or(0) as usize;
                    let d = &v["delta"];
                    match d["type"].as_str() {
                        Some("text_delta") => {
                            let t = d["text"].as_str().unwrap_or("");
                            if let Some(b) = blocks.get_mut(i) {
                                let cur = b["text"].as_str().unwrap_or("").to_string();
                                b["text"] = json!(cur + t);
                            }
                            sink.text(t);
                        }
                        Some("thinking_delta") => {
                            let t = d["thinking"].as_str().unwrap_or("");
                            // kept (with its signature) so the tool loop can send it back
                            if let Some(b) = blocks.get_mut(i) {
                                let cur = b["thinking"].as_str().unwrap_or("").to_string();
                                b["thinking"] = json!(cur + t);
                            }
                            sink.emit("thinking", Some(t.to_string()), None)
                        }
                        Some("signature_delta") => {
                            if let Some(b) = blocks.get_mut(i) {
                                b["signature"] = d["signature"].clone();
                            }
                        }
                        Some("input_json_delta") => partial.entry(i).or_default().push_str(d["partial_json"].as_str().unwrap_or("")),
                        _ => {}
                    }
                }
                "content_block_stop" => {
                    let i = v["index"].as_u64().unwrap_or(0) as usize;
                    if let (Some(p), Some(b)) = (partial.remove(&i), blocks.get_mut(i)) {
                        b["input"] = serde_json::from_str(if p.is_empty() { "{}" } else { &p }).unwrap_or(json!({}));
                    }
                }
                "message_delta" => {
                    if let Some(s) = v["delta"]["stop_reason"].as_str() {
                        stop = s.to_string();
                    }
                }
                "error" => return Err(anyhow!("{}", v["error"]["message"].as_str().unwrap_or("stream error"))),
                _ => {}
            }
            Ok(())
        })
        .await?;
        if stop.is_empty() {
            bail!("The response was cut off (connection closed before the model finished)");
        }
        // text blocks may carry citation metadata we don't need to send back; empty text
        // blocks are rejected by the API if resent
        let content: Vec<Value> = blocks
            .into_iter()
            .filter(|b| !b.is_null() && !(b["type"] == "text" && b["text"].as_str().map(|t| t.is_empty()).unwrap_or(true)))
            .map(|mut b| {
                if b["type"] == "text" {
                    if let Some(o) = b.as_object_mut() {
                        o.remove("citations");
                    }
                }
                b
            })
            .collect();
        let calls: Vec<Value> = content.iter().filter(|b| b["type"] == "tool_use").cloned().collect();
        messages.push(json!({"role": "assistant", "content": content}));
        if stop == "pause_turn" {
            continue;
        }
        if stop != "tool_use" || calls.is_empty() {
            return Ok(());
        }
        let mut results = Vec::new();
        for c in calls {
            let name = c["name"].as_str().unwrap_or("");
            sink.emit("tool", Some(describe_tool(name, &c["input"])), Some(json!({"name": name, "input": c["input"]})));
            let out = tools::run(ctx, name, &c["input"]).await;
            sink.emit("tool_done", Some(summarize_result(&out)), Some(json!({"name": name})));
            let is_error = out.starts_with("ERROR");
            results.push(json!({"type": "tool_result", "tool_use_id": c["id"], "content": out, "is_error": is_error}));
            if sink.cancelled() {
                bail!("Stopped");
            }
        }
        messages.push(json!({"role": "user", "content": results}));
    }
    Ok(())
}

// ---------------- OpenAI-compatible ----------------

async fn run_openai(req: &ChatRequest, ctx: &ToolContext, sink: &mut Sink) -> Result<()> {
    let key = key_for(&req.provider.id);
    let base = req.provider.base_url.trim_end_matches('/');
    let is_openai = base.contains("api.openai.com");
    let mut messages: Vec<Value> = Vec::new();
    if !req.system.is_empty() {
        messages.push(json!({"role": "system", "content": req.system}));
    }
    for m in &req.messages {
        messages.push(json!({"role": if m.role == "assistant" { "assistant" } else { "user" }, "content": m.content}));
    }
    let mut use_tools = req.tools && !req.provider.no_tools;
    let defs: Vec<Value> = tools::definitions(ctx).into_iter().map(|d| json!({"type": "function", "function": d})).collect();
    for round in 0..10 {
        let mut body = json!({"model": req.model, "messages": messages, "stream": true});
        let max = req.max_tokens.unwrap_or(8192);
        if is_openai {
            body["max_completion_tokens"] = json!(max);
        } else {
            body["max_tokens"] = json!(max);
        }
        if let Some(t) = req.temperature {
            body["temperature"] = json!(t);
        }
        if use_tools && !defs.is_empty() {
            body["tools"] = json!(defs);
        }
        let mut rb = http().post(format!("{base}/chat/completions")).json(&body);
        if let Some(k) = &key {
            rb = rb.bearer_auth(k);
        }
        let resp = rb.send().await?;
        let resp = match check(resp).await {
            Ok(r) => r,
            // local servers started without tool support reject "tools": retry without them
            Err(e) if use_tools && round == 0 && (e.to_string().to_lowercase().contains("tool") || e.to_string().contains("jinja")) => {
                use_tools = false;
                sink.emit("tool_done", Some("This model/server doesn't support tools; continuing without them.".into()), None);
                continue;
            }
            Err(e) => return Err(e),
        };
        let mut text = String::new();
        let mut calls: Vec<(String, String, String, Value)> = Vec::new(); // id, name, args, extra_content
        let mut finish = String::new();
        let mut sources_sent = false;
        let cancel = sink.cancel.clone();
        sse(resp, &cancel, |_ev, data| {
            if data.trim() == "[DONE]" {
                return Ok(());
            }
            let v: Value = serde_json::from_str(data).unwrap_or(Value::Null);
            if let Some(err) = v["error"]["message"].as_str() {
                return Err(anyhow!("{err}"));
            }
            // Perplexity returns its search results alongside the answer
            if !sources_sent {
                let src = v["search_results"].as_array().map(|a| a.iter().map(|r| json!({"title": r["title"], "url": r["url"]})).collect::<Vec<_>>())
                    .or_else(|| v["citations"].as_array().map(|a| a.iter().filter_map(|u| u.as_str()).map(|u| json!({"title": u, "url": u})).collect()));
                if let Some(s) = src.filter(|s| !s.is_empty()) {
                    sink.emit("sources", None, Some(json!(s)));
                    sources_sent = true;
                }
            }
            let ch = &v["choices"][0];
            let d = &ch["delta"];
            if let Some(r) = d["reasoning_content"].as_str().or(d["reasoning"].as_str()) {
                sink.emit("thinking", Some(r.to_string()), None);
            }
            if let Some(t) = d["content"].as_str() {
                text.push_str(t);
                sink.text(t);
            }
            for tc in d["tool_calls"].as_array().into_iter().flatten() {
                let mut i = tc["index"].as_u64().map(|x| x as usize).unwrap_or(calls.len().saturating_sub(1));
                // some servers reuse index 0 for several calls: a new id means a new call
                if let Some(id) = tc["id"].as_str().filter(|s| !s.is_empty()) {
                    if calls.get(i).map(|c| !c.0.is_empty() && c.0 != id).unwrap_or(false) {
                        i = calls.len();
                    }
                }
                while calls.len() <= i {
                    calls.push((String::new(), String::new(), String::new(), Value::Null));
                }
                if let Some(id) = tc["id"].as_str().filter(|s| !s.is_empty()) {
                    calls[i].0 = id.to_string();
                }
                if let Some(n) = tc["function"]["name"].as_str() {
                    // some servers stream the name in pieces, others repeat it whole
                    if calls[i].1.is_empty() {
                        calls[i].1 = n.to_string();
                    } else if calls[i].1 != n {
                        calls[i].1.push_str(n);
                    }
                }
                if let Some(a) = tc["function"]["arguments"].as_str() {
                    calls[i].2.push_str(a);
                }
                if !tc["extra_content"].is_null() {
                    calls[i].3 = tc["extra_content"].clone(); // Gemini thought signatures
                }
            }
            if let Some(f) = ch["finish_reason"].as_str() {
                finish = f.to_string();
            }
            Ok(())
        })
        .await?;
        let calls: Vec<_> = calls.into_iter().filter(|c| !c.1.is_empty()).collect();
        if calls.is_empty() || (finish != "tool_calls" && finish != "function_call" && !finish.is_empty() && finish != "stop") {
            return Ok(());
        }
        if calls.is_empty() {
            return Ok(());
        }
        let tc_json: Vec<Value> = calls
            .iter()
            .enumerate()
            .map(|(i, (id, n, a, extra))| {
                let mut v = json!({"id": if id.is_empty() { format!("call_{i}") } else { id.clone() }, "type": "function", "function": {"name": n, "arguments": if a.is_empty() { "{}" } else { a }}});
                if !extra.is_null() {
                    v["extra_content"] = extra.clone();
                }
                v
            })
            .collect();
        messages.push(json!({"role": "assistant", "content": if text.is_empty() { Value::Null } else { json!(text) }, "tool_calls": tc_json}));
        for (i, (id, name, args, _)) in calls.iter().enumerate() {
            let input: Value = serde_json::from_str(if args.is_empty() { "{}" } else { args }).unwrap_or(json!({}));
            sink.emit("tool", Some(describe_tool(name, &input)), Some(json!({"name": name, "input": input})));
            let out = tools::run(ctx, name, &input).await;
            sink.emit("tool_done", Some(summarize_result(&out)), Some(json!({"name": name})));
            messages.push(json!({"role": "tool", "tool_call_id": if id.is_empty() { format!("call_{i}") } else { id.clone() }, "content": out}));
            if sink.cancelled() {
                bail!("Stopped");
            }
        }
    }
    Ok(())
}

fn describe_tool(name: &str, input: &Value) -> String {
    let s = |k: &str| input[k].as_str().unwrap_or("").chars().take(80).collect::<String>();
    match name {
        "search_papers" => format!("Searching papers: “{}”", s("query")),
        "verify_citation" => format!("Verifying citation: {}", if !s("doi").is_empty() { s("doi") } else { s("title") }),
        "get_bibtex" => format!("Fetching BibTeX for {}", s("doi")),
        "fetch_url" => format!("Reading {}", s("url")),
        "web_search" => format!("Searching the web: “{}”", s("query")),
        "read_project_file" => format!("Reading {}", s("path")),
        "list_project_files" => "Listing project files".into(),
        "search_project_files" => format!("Searching project files for “{}”", s("query")),
        "use_skill" => format!("Using skill {}", s("name")),
        "search_library" => format!("Searching your library: “{}”", s("query")),
        "read_library_paper" => format!("Reading {} from your library", s("key")),
        "library_bibtex" => "Getting BibTeX from your library".into(),
        "office_read" => format!("Reading {}", s("path")),
        "office_commands" => "Looking up editing commands".into(),
        "word_edit" | "sheet_edit" | "deck_edit" | "image_edit" => format!("Editing {}", s("path")),
        "pdf_tool" => format!("{} on {}", s("op"), s("path")),
        other => other.to_string(),
    }
}

fn summarize_result(out: &str) -> String {
    if out.starts_with("ERROR") {
        return out.chars().take(160).collect();
    }
    if let Ok(v) = serde_json::from_str::<Value>(out) {
        if let Some(a) = v.as_array() {
            return format!("{} result(s)", a.len());
        }
        if let (Some(e), Some(a)) = (v["engine"].as_str(), v["results"].as_array()) {
            return format!("{} result(s) from {e}", a.len());
        }
        if let Some(st) = v["status"].as_str() {
            return st.replace('_', " ");
        }
    }
    format!("{} characters", out.len())
}

// ---------------- commands ----------------

fn tool_context(req: &ChatRequest, app: Option<&AppHandle>) -> ToolContext {
    let backend = if req.search_backend.is_empty() { "none".to_string() } else { req.search_backend.clone() };
    ToolContext {
        project_root: req.project_path.as_deref().and_then(tools::project_root_of),
        search_key: crate::settings::get_secret_value(&format!("search-key-{backend}")),
        search_backend: backend,
        search_url: req.search_url.clone(),
        web: req.web,
        skills: req.skills.clone(),
        asker: app.map(|a| crate::claude_code::mcp::window_asker(a.clone())),
    }
}

async fn run_chat(app: &AppHandle, req: ChatRequest, cancel: Arc<AtomicBool>) -> Result<String> {
    let ctx = tool_context(&req, Some(app));
    let app2 = app.clone();
    let out: EmitFn = Arc::new(move |e| {
        let _ = app2.emit("ai-event", e);
    });
    run_with(req, ctx, cancel, out).await
}

/// Quick AI functions (rewrite, fix, explain, check…) through Claude Code with the user's
/// Claude plan: one answer, no tools, streamed. The prompt goes in on stdin (no length limit).
async fn run_claude_code(req: &ChatRequest, sink: &mut Sink) -> Result<()> {
    use std::io::{BufRead, Write};
    let exe = crate::claude_code::find_claude().ok_or_else(|| anyhow::anyhow!("Claude Code isn't installed — Settings → AI → Claude Code"))?;
    let dir = std::env::temp_dir().join(format!("callio-cc-quick-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    let sys = dir.join(format!("{}.md", req.id.replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "_")));
    std::fs::write(
        &sys,
        format!("{}\n\n# How to answer\nYou are answering inside the Callio editor. Use no tools; answer directly in this reply, following the instructions above exactly (when asked for only the rewritten text, output only that text).", req.system),
    )?;
    let prompt = if req.messages.len() == 1 {
        req.messages[0].content.clone()
    } else {
        let mut p = String::from("Conversation so far:\n\n");
        for m in &req.messages[..req.messages.len().saturating_sub(1)] {
            p.push_str(&format!("{}: {}\n\n", if m.role == "assistant" { "Assistant" } else { "User" }, m.content));
        }
        p.push_str(&format!("Now reply to the user's last message:\n\n{}", req.messages.last().map(|m| m.content.as_str()).unwrap_or("")));
        p
    };
    let mut c = crate::claude_code::claude_cmd(&exe);
    c.current_dir(&dir).args(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--max-turns", "1"]);
    c.args(["--disallowedTools", "Bash,PowerShell,Read,Edit,MultiEdit,Write,NotebookEdit,Glob,Grep,WebFetch,WebSearch,Task,Agent,TodoWrite,Skill"]);
    c.arg("--append-system-prompt-file").arg(&sys);
    if !req.model.is_empty() && req.model != "default" {
        c.args(["--model", &req.model]);
    }
    c.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = c.spawn().map_err(|e| anyhow::anyhow!("Couldn't start Claude Code: {e}"))?;
    {
        let mut si = child.stdin.take().unwrap();
        let p = prompt.clone();
        std::thread::spawn(move || {
            let _ = si.write_all(p.as_bytes());
        });
    }
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let err_t = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut stderr, &mut s);
        s
    });
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines().map_while(|l| l.ok()) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let mut streamed = false;
    let mut final_text = String::new();
    let mut error: Option<String> = None;
    loop {
        if sink.cancelled() {
            crate::util::kill_pid_tree(&mut child);
            let _ = std::fs::remove_file(&sys);
            return Ok(());
        }
        let line = match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            Ok(Some(l)) => l,
            Ok(None) => break,
            Err(_) => continue,
        };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        match v["type"].as_str() {
            Some("stream_event") => {
                let e = &v["event"];
                if e["type"] == "content_block_delta" {
                    match e["delta"]["type"].as_str() {
                        Some("text_delta") => {
                            streamed = true;
                            sink.text(e["delta"]["text"].as_str().unwrap_or(""));
                        }
                        Some("thinking_delta") => sink.emit("thinking", e["delta"]["thinking"].as_str().map(String::from), None),
                        _ => {}
                    }
                }
            }
            Some("assistant") if !streamed => {
                for b in v["message"]["content"].as_array().into_iter().flatten() {
                    if b["type"] == "text" {
                        final_text.push_str(b["text"].as_str().unwrap_or(""));
                    }
                }
            }
            Some("result") => {
                if v["is_error"].as_bool().unwrap_or(false) {
                    error = Some(v["result"].as_str().unwrap_or("Claude Code reported an error").to_string());
                } else if !streamed && final_text.is_empty() {
                    final_text = v["result"].as_str().unwrap_or("").to_string();
                }
            }
            _ => {}
        }
    }
    let status = child.wait()?;
    let _ = std::fs::remove_file(&sys);
    if !streamed && !final_text.is_empty() {
        sink.text(&final_text);
    }
    if let Some(e) = error {
        anyhow::bail!("Claude Code: {e}");
    }
    if !status.success() && sink.full.is_empty() {
        let err = err_t.join().unwrap_or_default();
        let msg = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("it stopped without an answer").to_string();
        if msg.to_lowercase().contains("login") || msg.to_lowercase().contains("auth") {
            anyhow::bail!("Claude Code isn't signed in — Settings → AI → Claude Code → Sign in");
        }
        anyhow::bail!("Claude Code: {msg}");
    }
    Ok(())
}

async fn run_with(req: ChatRequest, ctx: ToolContext, cancel: Arc<AtomicBool>, out: EmitFn) -> Result<String> {
    let mut sink = Sink { out, id: req.id.clone(), cancel, full: String::new() };
    let r = match req.provider.kind.as_str() {
        "anthropic" => run_anthropic(&req, &ctx, &mut sink).await,
        "claudecode" => run_claude_code(&req, &mut sink).await,
        _ => run_openai(&req, &ctx, &mut sink).await,
    };
    match r {
        Ok(()) => {
            sink.emit("done", None, None);
            Ok(sink.full)
        }
        Err(e) => {
            let msg = if e.to_string().contains("error sending request") || e.to_string().contains("connect") {
                format!("Couldn't reach {} — {e}", req.provider.base_url)
            } else {
                e.to_string()
            };
            sink.emit("error", Some(msg.clone()), None);
            Err(anyhow!(msg))
        }
    }
}

/// Start a streaming chat; events arrive as "ai-event" with this request's id.
#[tauri::command]
pub async fn ai_chat(app: AppHandle, state: State<'_, AiState>, req: ChatRequest) -> CmdResult<String> {
    let cancel = Arc::new(AtomicBool::new(false));
    state.cancels.lock().unwrap().insert(req.id.clone(), cancel.clone());
    let id = req.id.clone();
    let r = run_chat(&app, req, cancel).await;
    state.cancels.lock().unwrap().remove(&id);
    r.es()
}

#[tauri::command]
pub fn ai_cancel(state: State<AiState>, id: String) {
    if let Some(c) = state.cancels.lock().unwrap().get(&id) {
        c.store(true, Ordering::SeqCst);
    }
}

#[derive(Serialize)]
pub struct ModelInfo {
    id: String,
    name: String,
}

/// List the models a provider offers (used to fill the model pickers).
#[tauri::command]
pub async fn ai_list_models(provider: Provider) -> CmdResult<Vec<ModelInfo>> {
    let base = provider.base_url.trim_end_matches('/').to_string();
    let key = key_for(&provider.id);
    let c = http();
    let v: Value = if provider.kind == "anthropic" {
        let k = key.ok_or("No API key for Claude yet")?;
        let r = c.get(format!("{base}/v1/models?limit=100")).header("x-api-key", k).header("anthropic-version", "2023-06-01").send().await.es()?;
        check(r).await.es()?.json().await.es()?
    } else {
        let mut rb = c.get(format!("{base}/models")).timeout(Duration::from_secs(20));
        if let Some(k) = key {
            rb = rb.bearer_auth(k);
        }
        check(rb.send().await.es()?).await.es()?.json().await.es()?
    };
    let mut out: Vec<ModelInfo> = v["data"]
        .as_array()
        .or(v["models"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m["id"].as_str().or(m["name"].as_str())?.trim_start_matches("models/").to_string();
            let name = m["display_name"].as_str().or(m["name"].as_str()).unwrap_or(&id).trim_start_matches("models/").to_string();
            Some(ModelInfo { id, name })
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out.dedup_by(|a, b| a.id == b.id);
    Ok(out)
}

/// Quick check that a provider answers with the given model.
#[tauri::command]
pub async fn ai_test(app: AppHandle, state: State<'_, AiState>, provider: Provider, model: String) -> CmdResult<String> {
    let req = ChatRequest {
        id: format!("test-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)),
        provider,
        model,
        system: String::new(),
        messages: vec![Msg { role: "user".into(), content: "Reply with exactly: OK".into() }],
        tools: false,
        web: false,
        max_tokens: Some(16),
        temperature: None,
        project_path: None,
        search_backend: String::new(),
        search_url: String::new(),
        skills: Vec::new(),
        effort: None,
        thinking: false,
    };
    ai_chat(app, state, req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    /// Tiny HTTP server: answers each connection with the next canned SSE body; records requests.
    fn serve(bodies: Vec<String>) -> (String, Arc<Mutex<Vec<String>>>) {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        std::thread::spawn(move || {
            for body in bodies {
                let (mut c, _) = l.accept().unwrap();
                let mut buf = Vec::new();
                let mut tmp = [0u8; 8192];
                loop {
                    let n = c.read(&mut tmp).unwrap();
                    buf.extend_from_slice(&tmp[..n]);
                    let s = String::from_utf8_lossy(&buf).to_string();
                    if let Some(h) = s.find("\r\n\r\n") {
                        let cl = s[..h].lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                        if buf.len() >= h + 4 + cl {
                            seen2.lock().unwrap().push(s[h + 4..].to_string());
                            break;
                        }
                    }
                }
                let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}");
                c.write_all(resp.as_bytes()).unwrap();
            }
        });
        (format!("http://{addr}"), seen)
    }

    fn collect() -> (EmitFn, Arc<Mutex<Vec<Event>>>) {
        let ev = Arc::new(Mutex::new(Vec::new()));
        let e2 = ev.clone();
        (Arc::new(move |e| e2.lock().unwrap().push(e)), ev)
    }

    fn req(kind: &str, base: &str, project: &str) -> ChatRequest {
        ChatRequest {
            id: "t".into(),
            provider: Provider { id: "test-none".into(), kind: kind.into(), base_url: base.into(), no_tools: false },
            model: "m".into(),
            system: "sys".into(),
            messages: vec![Msg { role: "user".into(), content: "hi".into() }],
            tools: true,
            web: false,
            max_tokens: None,
            temperature: None,
            project_path: Some(project.into()),
            search_backend: String::new(),
            search_url: String::new(),
            skills: Vec::new(),
            effort: None,
            thinking: false,
        }
    }

    #[test]
    fn claude_generations() {
        assert!(claude_new_gen("claude-opus-5-5") && claude_new_gen("claude-sonnet-5") && claude_new_gen("claude-opus-4-8") && claude_new_gen("claude-fable-5-1"));
        assert!(!claude_new_gen("claude-haiku-4-5-20251001") && !claude_new_gen("claude-sonnet-4-20250514") && !claude_new_gen("claude-opus-4-1-20250805"));
        assert!(claude_adaptive("claude-sonnet-4-6") && !claude_adaptive("claude-sonnet-4-5"));
        assert!(claude_effort_ok("claude-opus-4-5") && !claude_effort_ok("claude-haiku-4-5"));
    }

    /// CALLIO_E2E_CLAUDE=1 cargo test e2e_quick -- --nocapture
    #[test]
    fn e2e_quick_claude_code() {
        if std::env::var("CALLIO_E2E_CLAUDE").is_err() {
            return;
        }
        let (out, ev) = collect();
        let mut r = req("claudecode", "", "/tmp");
        r.provider.kind = "claudecode".into();
        r.model = "default".into();
        r.system = "Rewrite the user's text to be more formal. Output only the rewritten text.".into();
        r.messages = vec![Msg { role: "user".into(), content: "hey guys, the results r pretty good".into() }];
        let ctx = tool_context(&r, None);
        let text = tauri::async_runtime::block_on(run_with(r, ctx, Arc::new(AtomicBool::new(false)), out)).unwrap();
        println!("ANSWER: {text}");
        assert!(!text.trim().is_empty());
        assert!(ev.lock().unwrap().iter().any(|e| e.kind == "text"));
    }

    #[test]
    fn openai_stream_with_tool_call() {
        let dir = std::env::temp_dir().join("callio-ai-test-oa");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("main.tex"), "x").unwrap();
        let first = [
            r#"data: {"choices":[{"delta":{"role":"assistant","content":"Let me look. "}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"list_project_files","arguments":""}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}]}"#,
            "data: [DONE]",
        ].join("\n\n") + "\n\n";
        let second = [r#"data: {"choices":[{"delta":{"content":"Found main.tex."},"finish_reason":"stop"}]}"#, "data: [DONE]"].join("\n\n") + "\n\n";
        let (base, seen) = serve(vec![first, second]);
        let (out, ev) = collect();
        let mut r = req("openai", &base, dir.to_str().unwrap());
        r.project_path = Some(dir.join("main.tex").to_string_lossy().to_string());
        let ctx = tool_context(&r, None);
        let text = tauri::async_runtime::block_on(run_with(r, ctx, Arc::new(AtomicBool::new(false)), out)).unwrap();
        assert_eq!(text, "Let me look. Found main.tex.");
        let reqs = seen.lock().unwrap();
        assert_eq!(reqs.len(), 2);
        assert!(reqs[1].contains("\"role\":\"tool\"") && reqs[1].contains("main.tex"), "{}", reqs[1]);
        assert!(ev.lock().unwrap().iter().any(|e| e.kind == "tool"));
    }

    #[test]
    fn anthropic_stream_with_tool_use() {
        let dir = std::env::temp_dir().join("callio-ai-test-an");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("refs.bib"), "@a{k,}").unwrap();
        let ev = |name: &str, data: &str| format!("event: {name}\ndata: {data}\n\n");
        let first = [
            ev("message_start", r#"{"type":"message_start","message":{"id":"m","content":[]}}"#),
            ev("content_block_start", r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#),
            ev("content_block_delta", r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking."}}"#),
            ev("content_block_stop", r#"{"type":"content_block_stop","index":0}"#),
            ev("content_block_start", r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu1","name":"read_project_file","input":{}}}"#),
            ev("content_block_delta", r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\": \"refs"}}"#),
            ev("content_block_delta", r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":".bib\"}"}}"#),
            ev("content_block_stop", r#"{"type":"content_block_stop","index":1}"#),
            ev("message_delta", r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"}}"#),
            ev("message_stop", r#"{"type":"message_stop"}"#),
        ].concat();
        let second = [
            ev("content_block_start", r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#),
            ev("content_block_delta", r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" Done."}}"#),
            ev("message_delta", r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"}}"#),
        ].concat();
        let (base, seen) = serve(vec![first, second]);
        let (out, _ev) = collect();
        let mut r = req("anthropic", &base, "");
        r.project_path = Some(dir.join("refs.bib").to_string_lossy().to_string());
        let ctx = tool_context(&r, None);
        // no key stored for "test-none": provide one through the environment-less path
        std::env::set_var("CALLIO_TEST_KEY", "x");
        let text = tauri::async_runtime::block_on(run_with(r, ctx, Arc::new(AtomicBool::new(false)), out)).unwrap();
        assert_eq!(text, "Checking. Done.");
        let reqs = seen.lock().unwrap();
        assert!(reqs[1].contains("tool_result") && reqs[1].contains("@a{k,}"), "{}", reqs[1]);
        assert!(reqs[1].contains("\"path\":\"refs.bib\""), "{}", reqs[1]);
    }
}
