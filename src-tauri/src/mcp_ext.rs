//! Extra MCP tools Claude Code gets from Callio, one block per feature (Jupyter, WSL/Docker,
//! remote SSH, memory…). Each feature keeps its tools in its own module and adds ONE line in each
//! function below, under its own marker, so features can be built side by side.
//! A tool's result is a full MCP tool result: use `crate::claude_code::mcp::text_result` for text,
//! or return `{"content":[{"type":"image","data":…,"mimeType":…}], "isError": false}` for pictures.
use serde_json::Value;
use std::sync::OnceLock;
use tauri::AppHandle;

static APP: OnceLock<AppHandle> = OnceLock::new();
/// Called once at start-up (main.rs setup).
pub fn set_app(app: AppHandle) {
    let _ = APP.set(app);
}
/// The app, for tools that need it (None in unit tests).
#[allow(dead_code)]
pub fn app() -> Option<&'static AppHandle> {
    APP.get()
}

/// Tool definitions: `[{"name", "description", "inputSchema"}]`.
pub fn defs() -> Vec<Value> {
    #[allow(unused_mut)]
    let mut v: Vec<Value> = Vec::new();
    // [jupyter] defs
    v.extend(crate::jupyter::mcp::defs());

    // [wsl] defs

    // [ssh] defs

    // [memory] defs
    v.extend(crate::memnotes::mcp_defs());

    v
}

/// Whether one of the features here owns tool `name`.
pub fn owns(name: &str) -> bool {
    defs().iter().any(|d| d["name"].as_str() == Some(name))
}

/// Run tool `name` (only called when `owns(name)`).
pub async fn call(name: &str, args: &Value) -> Value {
    #[allow(unused_variables)]
    let (name, args) = (name, args);
    // [jupyter] call
    if crate::jupyter::mcp::NAMES.contains(&name) {
        return crate::jupyter::mcp::call(name, args).await;
    }

    // [wsl] call

    // [ssh] call

    // [memory] call
    if crate::memnotes::mcp_owns(name) {
        return crate::memnotes::mcp_call(name, args).await;
    }

    crate::claude_code::mcp::text_result(Value::String(format!("Unknown tool: {name}")), true)
}
