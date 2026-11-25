//! Claude Code's notebook tools. They work on the notebook in the window (the open tab, or the
//! file when it isn't open), so an edit is reviewable and one Undo step, and running a cell uses
//! the kernel the author already started. Only `nb_run_cell` asks first, like Bash does.
use crate::claude_code::mcp::text_result;
use serde_json::{json, Value};
use std::time::Duration;

pub fn defs() -> Vec<Value> {
    let path = json!({"type": "string", "description": "Path of the .ipynb file"});
    vec![
        json!({"name": "nb_list_cells", "description": "List the cells of a Jupyter notebook: index, id, type, execution count and the first line of each cell. Works for a notebook open in Callio or a file on disk.",
            "inputSchema": {"type": "object", "properties": {"path": path.clone()}, "required": ["path"]}}),
        json!({"name": "nb_read_cell", "description": "Read one notebook cell (by index or id): its source and its outputs as text (pictures appear as \"[image WxH]\", so use nb_run_cell's result or ask the author for the figure).",
            "inputSchema": {"type": "object", "properties": {"path": path.clone(), "index": {"type": "integer"}, "id": {"type": "string"}}, "required": ["path"]}}),
        json!({"name": "nb_edit_cell", "description": "Replace the source of a notebook cell (by id). If the notebook is open in Callio the edit appears there as one step the author can undo; the file on disk is not written until the author saves.",
            "inputSchema": {"type": "object", "properties": {"path": path.clone(), "id": {"type": "string"}, "source": {"type": "string"}}, "required": ["path", "id", "source"]}}),
        json!({"name": "nb_insert_cell", "description": "Insert a new cell after the cell with id `after_id` (omit or empty to insert at the top). type is \"code\" or \"markdown\". Appears in the open notebook as one undoable step.",
            "inputSchema": {"type": "object", "properties": {"path": path.clone(), "after_id": {"type": "string"}, "type": {"type": "string", "enum": ["code", "markdown"]}, "source": {"type": "string"}}, "required": ["path", "type", "source"]}}),
        json!({"name": "nb_run_cell", "description": "Run one code cell in the notebook's running kernel and return its output (text, errors, and pictures as images). Needs a kernel the author has started in Callio; the author is asked to approve it like a shell command.",
            "inputSchema": {"type": "object", "properties": {"path": path.clone(), "id": {"type": "string"}, "timeout_s": {"type": "integer", "description": "give up waiting after this many seconds (default 120); the cell keeps running"}}, "required": ["path", "id"]}}),
        json!({"name": "nb_kernel_state", "description": "The notebook's kernel: connection, kernel name, state (idle/busy/starting/dead/none) and which cell is running.",
            "inputSchema": {"type": "object", "properties": {"path": path}, "required": ["path"]}}),
    ]
}

pub const NAMES: &[&str] = &["nb_list_cells", "nb_read_cell", "nb_edit_cell", "nb_insert_cell", "nb_run_cell", "nb_kernel_state"];

/// `nb_*` → the window (rpc), with the approval step for running code.
pub async fn call(name: &str, args: &Value) -> Value {
    let Some(app) = crate::mcp_ext::app() else { return text_result(Value::String("Callio is not ready.".into()), true) };
    if name == "nb_run_cell" {
        let mode = crate::settings::load_from_disk(app)["ccPermissionMode"].as_str().unwrap_or("default").to_string();
        if mode == "plan" {
            return text_result(Value::String("Plan mode: running code is not allowed.".into()), true);
        }
        if !matches!(mode.as_str(), "bypassPermissions" | "auto") {
            let ask = crate::claude_code::mcp::window_asker(app.clone());
            let a = ask("permission".into(), json!({"toolName": "Bash", "input": {"command": format!("Run cell {} of {} in its Jupyter kernel", args["id"].as_str().unwrap_or("?"), args["path"].as_str().unwrap_or("?")), "description": "Claude Code wants to run a notebook cell (code runs on the kernel's computer)"}}), Duration::from_secs(3600)).await;
            match a {
                Some(v) if v["allow"].as_bool() == Some(true) => {}
                Some(v) => return text_result(Value::String(format!("The author declined to run the cell. {}", v["message"].as_str().unwrap_or(""))), true),
                None => return text_result(Value::String("No answer from the author.".into()), true),
            }
        }
    }
    let wait = if name == "nb_run_cell" { args["timeout_s"].as_u64().unwrap_or(120).clamp(5, 3600) + 30 } else { 60 };
    let ask = crate::claude_code::mcp::window_asker(app.clone());
    match ask(name.to_string(), args.clone(), Duration::from_secs(wait)).await {
        Some(v) => {
            let err = v.get("error").is_some();
            text_result(if err { v["error"].clone() } else { v }, err)
        }
        None => text_result(Value::String("Callio did not answer (is the window open?)".into()), true),
    }
}
