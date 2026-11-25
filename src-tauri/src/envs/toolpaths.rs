//! Paths in the arguments of Callio's tools when Claude Code runs in WSL, and which distro a
//! session runs in. Pure functions (std + serde_json) with unit tests.
use super::paths;

/// The distro a session's Claude Code runs in (None: on Windows): the setting, unless the folder is
/// itself under `\\wsl.localhost\X`, which always runs in X.
pub fn distro_for(run_in: &Option<String>, cwd: &str) -> Option<String> {
    let d = run_in.as_deref()?.strip_prefix("wsl:")?;
    Some(paths::parse_wsl_unc(cwd).map(|(x, _)| x).unwrap_or_else(|| d.to_string()))
}

/// Claude Code in WSL names files by Linux path; the window and Callio's tools use Windows paths.
/// Path arguments of a tool call (`path`, `output`, …) are translated before the tool runs.
pub fn map_tool_args(distro: &str, mut args: serde_json::Value) -> serde_json::Value {
    const KEYS: [&str; 8] = ["path", "file", "file_path", "pdf", "output", "out", "dir", "folder"];
    if let Some(o) = args.as_object_mut() {
        for k in KEYS {
            if let Some(s) = o.get(k).and_then(|v| v.as_str()).filter(|s| s.starts_with('/')) {
                let win = paths::wsl_to_win(distro, s);
                o.insert(k.to_string(), serde_json::Value::String(win));
            }
        }
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn distro_choice() {
        assert_eq!(distro_for(&Some("wsl:Ubuntu".into()), r"C:\p").as_deref(), Some("Ubuntu"));
        assert_eq!(distro_for(&Some("wsl:Ubuntu".into()), r"\\wsl.localhost\Debian\home\u").as_deref(), Some("Debian"));
        assert_eq!(distro_for(&Some("windows".into()), r"\\wsl.localhost\Debian\home\u"), None);
        assert_eq!(distro_for(&None, "x"), None);
    }
    #[test]
    fn tool_paths() {
        let a = map_tool_args("Ubuntu", json!({"path": "/home/u/a.docx", "sheet": "/not/a/path", "output": "/mnt/c/out/x.pdf", "label": "/x"}));
        assert_eq!(a["path"], r"\\wsl.localhost\Ubuntu\home\u\a.docx");
        assert_eq!(a["output"], r"C:\out\x.pdf");
        assert_eq!(a["sheet"], "/not/a/path");
        assert_eq!(a["label"], "/x");
        let w = map_tool_args("Ubuntu", json!({"path": r"C:\x\y.docx"}));
        assert_eq!(w["path"], r"C:\x\y.docx");
    }
}
