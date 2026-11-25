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
