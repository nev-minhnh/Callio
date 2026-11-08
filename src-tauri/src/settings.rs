use crate::util::{CmdResult, ErrStr};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

pub struct SettingsState(pub Mutex<Value>);

pub fn config_dir(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir().join("Callio"))
}
pub fn data_dir(app: &AppHandle) -> PathBuf {
    app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("Callio"))
}
fn settings_path(app: &AppHandle) -> PathBuf {
    config_dir(app).join("settings.json")
}

pub fn load_from_disk(app: &AppHandle) -> Value {
    std::fs::read_to_string(settings_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

/// Typed view of the settings the backend cares about.
#[derive(Clone, Debug)]
pub struct Backend {
    pub engine: String,
    pub latexmk_flavor: String,
    pub shell_escape: bool,
    pub tex_bin: Option<PathBuf>,
    pub overleaf_url: String,
    pub overleaf_mode: String,
    pub auto_install_packages: bool,
}

pub fn backend(state: &SettingsState) -> Backend {
    let v = state.0.lock().unwrap().clone();
    let s = |k: &str, d: &str| v.get(k).and_then(|x| x.as_str()).filter(|x| !x.is_empty()).unwrap_or(d).to_string();
    Backend {
        engine: s("engine", "tectonic"),
        latexmk_flavor: s("latexmkFlavor", "pdf"),
        shell_escape: v.get("shellEscape").and_then(|x| x.as_bool()).unwrap_or(false),
        tex_bin: v.get("texBin").and_then(|x| x.as_str()).filter(|x| !x.trim().is_empty()).map(|x| PathBuf::from(x.trim())),
        overleaf_url: s("overleafUrl", "https://www.overleaf.com").trim_end_matches('/').to_string(),
        overleaf_mode: s("overleafMode", "auto"),
        auto_install_packages: v.get("autoInstallPackages").and_then(|x| x.as_bool()).unwrap_or(true),
    }
}

#[tauri::command]
pub fn load_settings(state: State<SettingsState>) -> Value {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_settings(app: AppHandle, state: State<SettingsState>, settings: Value) -> CmdResult<()> {
    *state.0.lock().unwrap() = settings.clone();
    let p = settings_path(&app);
    std::fs::create_dir_all(p.parent().unwrap()).es()?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&settings).es()?).es()?;
    std::fs::rename(&tmp, &p).es()
}

// ---------- secrets (Windows Credential Manager) ----------
pub const SERVICE: &str = "Callio";
/// The names before the renames: secrets saved under them are read (and copied over) once.
const OLD_SERVICES: [&str; 2] = ["Proemia", "Quire"];

pub fn get_secret_value(key: &str) -> Option<String> {
    if let Some(v) = keyring::Entry::new(SERVICE, key).ok().and_then(|e| e.get_password().ok()).filter(|s| !s.is_empty()) {
        return Some(v);
    }
    let old = OLD_SERVICES.iter().find_map(|svc| keyring::Entry::new(svc, key).ok()?.get_password().ok().filter(|s| !s.is_empty()))?;
    put_secret_value(key, &old);
    Some(old)
}
/// Copy every secret saved under the old names (Proemia, Quire) at once, so removing them later can't
/// take any with it.
pub fn migrate_secrets() {
    let mut keys: Vec<String> = ["overleaf-git-token", "overleaf-session", "library-extension-token", "library-sessions", "search-key-brave", "search-key-tavily"].iter().map(|s| s.to_string()).collect();
    for p in ["anthropic", "openai", "gemini", "xai", "perplexity", "custom", "llamacpp"] {
        keys.push(format!("ai-key-{p}"));
    }
    for k in keys {
        let _ = get_secret_value(&k);
    }
}
/// Save a secret in Windows Credential Manager (best effort).
pub fn put_secret_value(key: &str, value: &str) {
    if let Ok(e) = keyring::Entry::new(SERVICE, key) {
        let _ = e.set_password(value);
    }
}

#[tauri::command]
pub fn get_secret(key: String) -> CmdResult<Option<String>> {
    Ok(get_secret_value(&key))
}

#[tauri::command]
pub fn set_secret(key: String, value: String) -> CmdResult<()> {
    let e = keyring::Entry::new(SERVICE, &key).es()?;
    if value.is_empty() {
        for svc in OLD_SERVICES {
            if let Ok(o) = keyring::Entry::new(svc, &key) {
                let _ = o.delete_credential();
            }
        }
        match e.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    } else {
        e.set_password(&value).es()
    }
}
