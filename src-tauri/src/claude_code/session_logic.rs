//! The pure part of the session manager: turning Claude Code's stream-json lines into the small
//! events the window understands, and building the lines Callio writes to it. No Tauri, no
//! processes, no disk — so it can be tested on its own (see /root/specs/tests/chat-core/logic).
//!
//! The field names come from the installed Claude Code (2.1.332): `system/init`,
//! `system/session_state_changed` (only sent when CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS is set),
//! `command_lifecycle` (`command_uuid`, `state`), `system/task_started|task_progress|
//! task_updated|task_notification` (subagents and background tasks), `rate_limit_event`,
//! `result`, and `parent_tool_use_id` on every message of a subagent.
use serde_json::{json, Value};

/// A random version-4 UUID (Claude Code tracks queued messages by it).
pub fn new_uuid() -> String {
    let mut b = [0u8; 16];
    if getrandom::getrandom(&mut b).is_err() {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(1);
        for (i, x) in b.iter_mut().enumerate() {
            *x = ((t >> ((i % 8) * 8)) as u8) ^ (i as u8).wrapping_mul(37);
        }
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: Vec<String> = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", h[0..4].concat(), h[4..6].concat(), h[6..8].concat(), h[8..10].concat(), h[10..16].concat())
}

/// One user message as a stream-json input line. `priority`: "next" (read after the step now
/// running), "now" (stop at the next chance) or "later" (after the turn).
pub fn user_line(text: &str, uuid: &str, priority: &str) -> String {
    let p = if ["now", "next", "later"].contains(&priority) { priority } else { "next" };
    json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}, "parent_tool_use_id": null, "priority": p, "uuid": uuid, "origin": {"kind": "human"}}).to_string()
}

pub fn control_line(request_id: &str, request: Value) -> String {
    json!({"type": "control_request", "request_id": request_id, "request": request}).to_string()
}

/// The answer to a Claude Code control request (`can_use_tool` and friends), as a stdin line.
pub fn control_response_line(request_id: &str, body: Value) -> String {
    json!({"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": body}}).to_string()
}

pub fn control_error_line(request_id: &str, error: &str) -> String {
    json!({"type": "control_response", "response": {"subtype": "error", "request_id": request_id, "error": error}}).to_string()
}

/// What the window's permission card is told about a `can_use_tool` request (the same fields the
/// old MCP `approve` path sent, plus why Claude Code is asking).
pub fn perm_params(req: &Value, session: &str) -> Value {
    json!({
        "toolName": req["tool_name"], "input": if req["input"].is_object() { req["input"].clone() } else { json!({}) },
        "session": session, "toolUseId": req["tool_use_id"], "agentId": req["agent_id"],
        "reason": req["decision_reason"], "blockedPath": req["blocked_path"],
    })
}

/// The window's answer ({allow: true} | {allow: false, message}; None = nobody answered) as the
/// body of the control response Claude Code expects (`behavior: allow|deny`).
pub fn perm_body(answer: Option<&Value>, input: &Value, tool_use_id: Option<&str>) -> Value {
    let mut b = match answer {
        Some(a) if a["allow"].as_bool() == Some(true) => json!({"behavior": "allow", "updatedInput": input}),
        Some(a) => json!({"behavior": "deny", "message": a["message"].as_str().filter(|m| !m.is_empty()).map(|m| format!("The author declined: {m}")).unwrap_or_else(|| "The author declined this action.".into())}),
        None => json!({"behavior": "deny", "message": "No answer from the author."}),
    };
    if let Some(id) = tool_use_id.filter(|i| !i.is_empty()) {
        b["toolUseID"] = json!(id);
    }
    b
}

/// May the idle check close a session's process? Never while a turn runs, messages wait for a
/// slot, or Remote Control is on (the phone may write at any time).
pub fn idle_closable(proc_alive: bool, turn_active: bool, nothing_waiting: bool, remote_on: bool, idle_for: std::time::Duration, limit: std::time::Duration) -> bool {
    proc_alive && !turn_active && nothing_waiting && !remote_on && idle_for > limit
}

/// A Remote Control error from Claude Code, said so the author knows what to do.
pub fn friendly_rc_error(err: &str) -> String {
    let e = err.to_lowercase();
    if e.contains("subscription") || e.contains("sign-in") || e.contains("sign in") || e.contains("full-scope") || e.contains("login") || e.contains("api key") || e.contains("oauth") || e.contains("claude.ai") {
        return "Remote Control needs Claude Code signed in with your Claude account (not an API key). Sign in with /login in a terminal, then try again.".into();
    }
    if e.contains("policy") || e.contains("not available for") || e.contains("disabled") || e.contains("organization") || e.contains("allow_remote_control") {
        return format!("Remote Control isn't available for this plan or organization ({}).", err.trim().trim_end_matches('.'));
    }
    if e.contains("network") || e.contains("timed out") || e.contains("timeout") || e.contains("econn") || e.contains("enotfound") || e.contains("fetch failed") || e.contains("connect") {
        return format!("Couldn't reach Claude's servers for Remote Control. Check the internet connection and try again ({}).", err.trim().trim_end_matches('.'));
    }
    if err.trim().is_empty() { "Remote Control couldn't start.".into() } else { err.trim().to_string() }
}

fn short(s: &str, n: usize) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= n {
        return one;
    }
    let mut t: String = one.chars().take(n).collect();
    t.push('…');
    t
}

fn base(p: &str) -> String {
    p.rsplit(['/', '\\']).next().unwrap_or(p).to_string()
}

/// What the main agent is doing for one tool call: (tool, short argument) — the window words it.
pub fn step_of(name: &str, input: &Value) -> (String, String) {
    let s = |k: &str| input[k].as_str().unwrap_or("");
    let arg = match name {
        "Bash" | "PowerShell" => short(s("command"), 90),
        "Read" | "Edit" | "MultiEdit" | "Write" => base(s("file_path")),
        "NotebookEdit" => base(s("notebook_path")),
        "Grep" | "Glob" => short(s("pattern"), 60),
        "WebSearch" => short(s("query"), 60),
        "WebFetch" => short(s("url"), 80),
        "Task" | "Agent" => short(if s("description").is_empty() { s("prompt") } else { s("description") }, 80),
        n if n.starts_with("mcp__") => short(n.rsplit("__").next().unwrap_or(n), 40),
        _ => String::new(),
    };
    (name.to_string(), arg)
}

/// Running token count of the main agent: finished messages plus the one being written.
#[derive(Default, Debug)]
pub struct Tracker {
    done: u64,
    cur_in: u64,
    cur_out: u64,
}

impl Tracker {
    pub fn reset(&mut self) {
        *self = Tracker::default();
    }
    pub fn total(&self) -> u64 {
        self.done + self.cur_in + self.cur_out
    }
}

fn u(v: &Value) -> u64 {
    v.as_u64().unwrap_or(0)
}

/// Translate one stream-json line into window events (`{"kind": …}`). `ui_event` is the
/// existing converter for chat content (text, thinking, tool calls, tool results).
pub fn translate(v: &Value, tr: &mut Tracker, ui_event: &dyn Fn(&Value) -> Option<Value>) -> Vec<Value> {
    let mut out = Vec::new();
    let ty = v["type"].as_str().unwrap_or("");
    let sub = v["subtype"].as_str().unwrap_or("");
    let parent = v["parent_tool_use_id"].as_str();
    if let Some(s) = v["session_id"].as_str() {
        out.push(json!({"kind": "session_id", "sessionId": s}));
    }
    match (ty, sub) {
        ("system", "init") => {
            out.push(json!({"kind": "init", "model": v["model"], "sessionId": v["session_id"], "mcp": v["mcp_servers"], "permissionMode": v["permissionMode"], "version": v["claude_code_version"]}));
        }
        // Remote Control's connection to claude.ai: connected / ready / reconnecting / failed …
        ("system", "bridge_state") => out.push(json!({"kind": "bridge", "state": v["state"], "detail": v["detail"], "failure": v["failure_kind"]})),
        ("system", "session_state_changed") => out.push(json!({"kind": "state", "state": v["state"]})),
        ("system", "task_started") => out.push(json!({"kind": "agent", "phase": "start", "taskId": v["task_id"], "toolUseId": v["tool_use_id"], "description": v["description"], "subagentType": v["subagent_type"], "prompt": v["prompt"], "taskType": v["task_type"], "background": v["is_backgrounded"], "parentTaskId": v["parent_task_id"]})),
        ("system", "task_progress") => out.push(json!({"kind": "agent", "phase": "progress", "taskId": v["task_id"], "toolUseId": v["tool_use_id"], "description": v["description"], "subagentType": v["subagent_type"], "usage": {"tokens": u(&v["usage"]["total_tokens"]), "toolUses": u(&v["usage"]["tool_uses"]), "durationMs": u(&v["usage"]["duration_ms"])}, "lastTool": v["last_tool_name"], "summary": v["summary"]})),
        ("system", "task_updated") => out.push(json!({"kind": "agent", "phase": "update", "taskId": v["task_id"], "patch": v["patch"]})),
        ("system", "task_notification") => out.push(json!({"kind": "agent", "phase": "end", "taskId": v["task_id"], "toolUseId": v["tool_use_id"], "status": v["status"], "summary": v["summary"], "usage": {"tokens": u(&v["usage"]["total_tokens"]), "toolUses": u(&v["usage"]["tool_uses"]), "durationMs": u(&v["usage"]["duration_ms"])}})),
        ("system", "compact_boundary") => out.push(json!({"kind": "notice", "subtype": "compact", "preTokens": v["compact_metadata"]["pre_tokens"], "postTokens": v["compact_metadata"]["post_tokens"], "trigger": v["compact_metadata"]["trigger"]})),
        ("system", "status") => {
            if let Some(s) = v["status"].as_str() {
                if s == "compacting" {
                    out.push(json!({"kind": "notice", "subtype": "compacting"}));
                }
            }
        }
        ("system", "notification") => out.push(json!({"kind": "notice", "subtype": "notification", "text": v["text"].as_str().or(v["message"].as_str()).unwrap_or("")})),
        ("command_lifecycle", _) => out.push(json!({"kind": "cmd", "uuid": v["command_uuid"].as_str().or(v["uuid"].as_str()), "state": v["state"]})),
        ("rate_limit_event", _) => out.push(json!({"kind": "rate", "info": v["rate_limit_info"]})),
        ("result", _) => {
            let us = &v["usage"];
            let tokens = u(&us["input_tokens"]) + u(&us["output_tokens"]) + u(&us["cache_creation_input_tokens"]);
            let errors = v["errors"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from).or_else(|| x["message"].as_str().map(String::from))).collect::<Vec<_>>().join("\n")).unwrap_or_default();
            out.push(json!({"kind": "result", "isError": v["is_error"].as_bool().unwrap_or(false), "subtype": v["subtype"], "text": v["result"].as_str().unwrap_or(""), "errors": errors, "costUsd": v["total_cost_usd"], "durationMs": v["duration_ms"], "numTurns": v["num_turns"], "tokens": tokens, "stopReason": v["stop_reason"], "terminalReason": v["terminal_reason"], "uuids": v["user_message_uuids"]}));
            tr.reset();
        }
        ("stream_event", _) => {
            let e = &v["event"];
            if parent.is_none() {
                match e["type"].as_str() {
                    Some("message_start") => {
                        tr.done += tr.cur_in + tr.cur_out;
                        let us = &e["message"]["usage"];
                        tr.cur_in = u(&us["input_tokens"]) + u(&us["cache_creation_input_tokens"]);
                        tr.cur_out = u(&us["output_tokens"]);
                    }
                    Some("message_delta") => {
                        tr.cur_out = u(&e["usage"]["output_tokens"]);
                        out.push(json!({"kind": "tokens", "total": tr.total()}));
                    }
                    _ => {}
                }
                if let Some(mut ev) = ui_event(v) {
                    ev["parent"] = Value::Null;
                    out.push(json!({"kind": "ev", "ev": ev}));
                }
            }
            // a subagent's partial text stays out of the main answer (its finished messages come as `assistant`)
        }
        ("assistant", _) | ("user", _) => {
            if let Some(mut ev) = ui_event(v) {
                ev["parent"] = v["parent_tool_use_id"].clone();
                if ty == "assistant" {
                    ev["model"] = v["message"]["model"].clone();
                    for b in v["message"]["content"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
                        if b["type"] != "tool_use" || parent.is_some() {
                            continue;
                        }
                        let name = b["name"].as_str().unwrap_or("");
                        if name == "TodoWrite" {
                            out.push(json!({"kind": "todos", "todos": b["input"]["todos"]}));
                        } else {
                            let (tool, arg) = step_of(name, &b["input"]);
                            out.push(json!({"kind": "step", "tool": tool, "arg": arg, "toolUseId": b["id"]}));
                        }
                    }
                }
                out.push(json!({"kind": "ev", "ev": ev}));
            }
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn none(_: &Value) -> Option<Value> {
        None
    }
    fn some(v: &Value) -> Option<Value> {
        match v["type"].as_str()? {
            "assistant" => Some(json!({"t": "assistant", "text": "", "tools": [], "sub": !v["parent_tool_use_id"].is_null()})),
            _ => None,
        }
    }
    #[test]
    fn uuid_shape() {
        let a = new_uuid();
        assert_eq!(a.len(), 36);
        assert_eq!(&a[14..15], "4");
        assert_ne!(a, new_uuid());
    }
    #[test]
    fn lines() {
        let l: Value = serde_json::from_str(&user_line("hi\nthere", "u1", "now")).unwrap();
        assert_eq!(l["priority"], "now");
        assert_eq!(l["message"]["content"][0]["text"], "hi\nthere");
        assert_eq!(l["origin"]["kind"], "human");
        let l: Value = serde_json::from_str(&user_line("x", "u1", "weird")).unwrap();
        assert_eq!(l["priority"], "next");
        let c: Value = serde_json::from_str(&control_line("r1", json!({"subtype": "interrupt", "cancel_queued": true}))).unwrap();
        assert_eq!(c["request"]["subtype"], "interrupt");
    }
    #[test]
    fn permissions() {
        let req = json!({"tool_name": "Bash", "input": {"command": "ls"}, "tool_use_id": "tu1", "agent_id": "ag", "decision_reason": "why"});
        let p = perm_params(&req, "cs-1");
        assert_eq!(p["toolName"], "Bash");
        assert_eq!(p["toolUseId"], "tu1");
        assert_eq!(p["session"], "cs-1");
        let input = json!({"command": "ls"});
        let a = perm_body(Some(&json!({"allow": true})), &input, Some("tu1"));
        assert_eq!(a["behavior"], "allow");
        assert_eq!(a["updatedInput"], input);
        assert_eq!(a["toolUseID"], "tu1");
        let d = perm_body(Some(&json!({"allow": false, "message": "no way"})), &input, None);
        assert_eq!(d["behavior"], "deny");
        assert!(d["message"].as_str().unwrap().contains("no way"));
        assert!(d.get("toolUseID").is_none());
        assert_eq!(perm_body(None, &input, None)["message"], "No answer from the author.");
        let l: Value = serde_json::from_str(&control_response_line("r9", a)).unwrap();
        assert_eq!(l["response"]["request_id"], "r9");
        assert_eq!(l["response"]["response"]["behavior"], "allow");
    }
    #[test]
    fn idle_close_rules() {
        use std::time::Duration as D;
        assert!(idle_closable(true, false, true, false, D::from_secs(1900), D::from_secs(1800)));
        assert!(!idle_closable(true, false, true, true, D::from_secs(99999), D::from_secs(1800)), "never while Remote Control is on");
        assert!(!idle_closable(true, true, true, false, D::from_secs(99999), D::from_secs(1800)));
        assert!(!idle_closable(true, false, false, false, D::from_secs(99999), D::from_secs(1800)));
        assert!(!idle_closable(false, false, true, false, D::from_secs(99999), D::from_secs(1800)));
        assert!(!idle_closable(true, false, true, false, D::from_secs(5), D::from_secs(1800)));
    }
    #[test]
    fn remote_errors() {
        assert!(friendly_rc_error("Remote Control requires a claude.ai subscription. Run /login").contains("signed in with your Claude account"));
        assert!(friendly_rc_error("Remote Control is not available inside a cloud session.").contains("cloud session"));
        assert!(friendly_rc_error("fetch failed: ECONNRESET").contains("internet"));
        assert!(friendly_rc_error("Remote Control is disabled by policy").contains("plan or organization"));
        let e = translate(&json!({"type": "system", "subtype": "bridge_state", "state": "failed", "detail": "x", "failure_kind": "terminal"}), &mut Tracker::default(), &|_| None);
        assert_eq!(e[0]["kind"], "bridge");
        assert_eq!(e[0]["state"], "failed");
    }
    #[test]
    fn steps() {
        assert_eq!(step_of("Bash", &json!({"command": "npm run   typecheck\n&& echo"})).1, "npm run typecheck && echo");
        assert_eq!(step_of("Edit", &json!({"file_path": "C:\\a\\b.md"})), ("Edit".into(), "b.md".into()));
        assert_eq!(step_of("mcp__callio__compile", &json!({})).1, "compile");
        assert_eq!(step_of("Agent", &json!({"description": "Find callers"})).1, "Find callers");
    }
    #[test]
    fn state_and_lifecycle() {
        let mut t = Tracker::default();
        let e = translate(&json!({"type": "system", "subtype": "session_state_changed", "state": "idle", "session_id": "s"}), &mut t, &none);
        assert_eq!(e[0]["kind"], "session_id");
        assert_eq!(e[1], json!({"kind": "state", "state": "idle"}));
        let e = translate(&json!({"type": "command_lifecycle", "command_uuid": "u1", "state": "started", "uuid": "z"}), &mut t, &none);
        assert_eq!(e[0], json!({"kind": "cmd", "uuid": "u1", "state": "started"}));
    }
    #[test]
    fn subagents() {
        let mut t = Tracker::default();
        let e = translate(&json!({"type": "system", "subtype": "task_started", "task_id": "k1", "tool_use_id": "tu1", "description": "Read logs", "subagent_type": "Explore", "task_type": "local_agent"}), &mut t, &none);
        assert_eq!(e[0]["phase"], "start");
        assert_eq!(e[0]["toolUseId"], "tu1");
        let e = translate(&json!({"type": "system", "subtype": "task_progress", "task_id": "k1", "usage": {"total_tokens": 900, "tool_uses": 3, "duration_ms": 4000}, "last_tool_name": "Grep"}), &mut t, &none);
        assert_eq!(e[0]["usage"]["tokens"], 900);
        let e = translate(&json!({"type": "system", "subtype": "task_notification", "task_id": "k1", "status": "completed", "summary": "ok"}), &mut t, &none);
        assert_eq!(e[0]["status"], "completed");
    }
    #[test]
    fn todos_steps_and_parents() {
        let mut t = Tracker::default();
        let main = json!({"type": "assistant", "parent_tool_use_id": null, "message": {"model": "m", "content": [{"type": "tool_use", "id": "a", "name": "TodoWrite", "input": {"todos": [{"content": "x", "status": "pending", "activeForm": "xing"}]}}, {"type": "tool_use", "id": "b", "name": "Bash", "input": {"command": "ls"}}]}});
        let e = translate(&main, &mut t, &some);
        let kinds: Vec<_> = e.iter().map(|x| x["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, vec!["todos", "step", "ev"]);
        assert_eq!(e[0]["todos"][0]["content"], "x");
        // a subagent's tool call is not the main agent's step, but its parent is kept
        let subm = json!({"type": "assistant", "parent_tool_use_id": "tu1", "message": {"content": [{"type": "tool_use", "id": "c", "name": "Grep", "input": {"pattern": "x"}}]}});
        let e = translate(&subm, &mut t, &some);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0]["ev"]["parent"], "tu1");
    }
    #[test]
    fn tokens_and_result() {
        let mut t = Tracker::default();
        translate(&json!({"type": "stream_event", "parent_tool_use_id": null, "event": {"type": "message_start", "message": {"usage": {"input_tokens": 2, "cache_creation_input_tokens": 100, "output_tokens": 1}}}}), &mut t, &none);
        let e = translate(&json!({"type": "stream_event", "parent_tool_use_id": null, "event": {"type": "message_delta", "usage": {"output_tokens": 40}}}), &mut t, &none);
        assert_eq!(e[0]["total"], 142);
        translate(&json!({"type": "stream_event", "parent_tool_use_id": null, "event": {"type": "message_start", "message": {"usage": {"input_tokens": 3, "output_tokens": 0}}}}), &mut t, &none);
        assert_eq!(t.total(), 145);
        let e = translate(&json!({"type": "result", "subtype": "success", "is_error": false, "result": "ok", "usage": {"input_tokens": 5, "output_tokens": 10, "cache_creation_input_tokens": 20}, "total_cost_usd": 0.1}), &mut t, &none);
        assert_eq!(e[0]["tokens"], 35);
        assert_eq!(t.total(), 0);
        // a subagent's stream does not count into the main total
        translate(&json!({"type": "stream_event", "parent_tool_use_id": "tu", "event": {"type": "message_delta", "usage": {"output_tokens": 999}}}), &mut t, &none);
        assert_eq!(t.total(), 0);
    }
}
