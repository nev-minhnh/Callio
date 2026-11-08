//! Registers Callio in Windows "Open with" for .md/.tex/… under HKCU (no admin rights).
use crate::util::CmdResult;
use serde::Serialize;
use tauri::AppHandle;

pub const APP_NAME: &str = "Callio";
/// (extension, ProgID, friendly type name)
pub const TYPES: &[(&str, &str, &str)] = &[
    (".md", "Callio.Markdown", "Markdown document"),
    (".markdown", "Callio.Markdown", "Markdown document"),
    (".tex", "Callio.LaTeX", "LaTeX document"),
    (".ltx", "Callio.LaTeX", "LaTeX document"),
    (".sty", "Callio.LaTeX", "LaTeX style"),
    (".cls", "Callio.LaTeX", "LaTeX class"),
    (".bib", "Callio.BibTeX", "BibTeX database"),
    (".pdf", "Callio.PDF", "PDF document"),
    (".docx", "Callio.Document", "Word document"),
    (".doc", "Callio.Document", "Word 97-2003 document"),
    (".odt", "Callio.Document", "OpenDocument text"),
    (".rtf", "Callio.Document", "Rich Text document"),
    (".xlsx", "Callio.Sheet", "Excel workbook"),
    (".xlsm", "Callio.Sheet", "Excel macro-enabled workbook"),
    (".xls", "Callio.Sheet", "Excel 97-2003 workbook"),
    (".xlsb", "Callio.Sheet", "Excel binary workbook"),
    (".ods", "Callio.Sheet", "OpenDocument spreadsheet"),
    (".csv", "Callio.Sheet", "CSV file"),
    (".pptx", "Callio.Presentation", "PowerPoint presentation"),
    (".ppsx", "Callio.Presentation", "PowerPoint show"),
    (".potx", "Callio.Presentation", "PowerPoint template"),
    (".odp", "Callio.Presentation", "OpenDocument presentation"),
    (".tsv", "Callio.Sheet", "Tab-separated values"),
];

#[derive(Serialize)]
pub struct AssocStatus {
    registered: bool,
    exe: String,
    extensions: Vec<String>,
}

fn exe_path() -> String {
    std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
}

#[cfg(windows)]
mod imp {
    use super::*;
    use winreg::enums::*;
    use winreg::RegKey;

    fn exe_name() -> String {
        std::path::Path::new(&exe_path()).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "callio.exe".into())
    }

    fn notify() {
        unsafe {
            windows_sys::Win32::UI::Shell::SHChangeNotify(
                windows_sys::Win32::UI::Shell::SHCNE_ASSOCCHANGED as i32,
                windows_sys::Win32::UI::Shell::SHCNF_IDLIST,
                std::ptr::null(),
                std::ptr::null(),
            );
        }
    }

    /// The entries the app wrote under its old names (Proemia, Quire): replaced by Callio's.
    fn remove_old_name() {
        const KINDS: [&str; 7] = ["Markdown", "LaTeX", "BibTeX", "PDF", "Document", "Sheet", "Presentation"];
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for old in ["Proemia", "Quire"] {
            let progids: Vec<String> = KINDS.iter().map(|k| format!("{old}.{k}")).collect();
            if let Ok(classes) = hkcu.open_subkey_with_flags("Software\\Classes", KEY_ALL_ACCESS) {
                for (ext, _, _) in TYPES {
                    if let Ok(k) = classes.open_subkey_with_flags(format!("{ext}\\OpenWithProgids"), KEY_ALL_ACCESS) {
                        for n in &progids {
                            let _ = k.delete_value(n);
                        }
                    }
                }
                for n in &progids {
                    let _ = classes.delete_subkey_all(n);
                }
                let _ = classes.delete_subkey_all(format!("Applications\\{old}.exe"));
            }
            let _ = hkcu.delete_subkey_all(format!("Software\\{old}\\Capabilities"));
            if let Ok(k) = hkcu.open_subkey_with_flags("Software\\RegisteredApplications", KEY_ALL_ACCESS) {
                let _ = k.delete_value(old);
            }
        }
    }

    pub fn register() -> std::io::Result<()> {
        remove_old_name();
        let exe = exe_path();
        let cmd = format!("\"{exe}\" \"%1\"");
        let icon = format!("\"{exe}\",0");
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let classes = hkcu.create_subkey("Software\\Classes")?.0;

        // ProgIDs
        let mut seen = std::collections::HashSet::new();
        for (_, progid, friendly) in TYPES {
            if !seen.insert(*progid) {
                continue;
            }
            let (k, _) = classes.create_subkey(progid)?;
            k.set_value("", friendly)?;
            k.set_value("FriendlyTypeName", friendly)?;
            k.create_subkey("DefaultIcon")?.0.set_value("", &icon)?;
            let (open, _) = k.create_subkey("shell\\open")?;
            open.set_value("FriendlyAppName", &APP_NAME)?;
            open.create_subkey("command")?.0.set_value("", &cmd)?;
        }
        // Extensions → OpenWithProgids (adds Callio to "Open with" without stealing the default)
        let hkcr = RegKey::predef(HKEY_CLASSES_ROOT);
        for (ext, progid, _) in TYPES {
            let (k, _) = classes.create_subkey(format!("{ext}\\OpenWithProgids"))?;
            k.set_value(progid, &"")?;
            // No handler at all yet? Then make double-click work right away.
            let has_default = hkcr.open_subkey(ext).and_then(|k| k.get_value::<String, _>("")).map(|v| !v.is_empty()).unwrap_or(false);
            if !has_default {
                classes.create_subkey(ext)?.0.set_value("", progid)?;
            }
            if *ext == ".md" || *ext == ".markdown" {
                let (e, _) = classes.create_subkey(ext)?;
                if e.get_value::<String, _>("Content Type").is_err() {
                    e.set_value("Content Type", &"text/markdown")?;
                }
                if e.get_value::<String, _>("PerceivedType").is_err() {
                    e.set_value("PerceivedType", &"text")?;
                }
            }
        }
        // Applications\callio.exe
        let (app, _) = classes.create_subkey(format!("Applications\\{}", exe_name()))?;
        app.set_value("FriendlyAppName", &APP_NAME)?;
        app.create_subkey("DefaultIcon")?.0.set_value("", &icon)?;
        app.create_subkey("shell\\open\\command")?.0.set_value("", &cmd)?;
        let (st, _) = app.create_subkey("SupportedTypes")?;
        for (ext, _, _) in TYPES {
            st.set_value(ext, &"")?;
        }
        // Capabilities → shows up in Settings → Apps → Default apps
        let (caps, _) = hkcu.create_subkey("Software\\Callio\\Capabilities")?;
        caps.set_value("ApplicationName", &APP_NAME)?;
        caps.set_value("ApplicationDescription", &"Lightweight Markdown and LaTeX editor with Overleaf sync")?;
        caps.set_value("ApplicationIcon", &icon)?;
        let (fa, _) = caps.create_subkey("FileAssociations")?;
        for (ext, progid, _) in TYPES {
            fa.set_value(ext, progid)?;
        }
        hkcu.create_subkey("Software\\RegisteredApplications")?.0.set_value(APP_NAME, &"Software\\Callio\\Capabilities")?;
        notify();
        Ok(())
    }

    pub fn unregister() -> std::io::Result<()> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(classes) = hkcu.open_subkey_with_flags("Software\\Classes", KEY_ALL_ACCESS) {
            for (ext, progid, _) in TYPES {
                if let Ok(k) = classes.open_subkey_with_flags(format!("{ext}\\OpenWithProgids"), KEY_ALL_ACCESS) {
                    let _ = k.delete_value(progid);
                }
                if let Ok(k) = classes.open_subkey_with_flags(ext, KEY_ALL_ACCESS) {
                    if k.get_value::<String, _>("").map(|v| v == *progid).unwrap_or(false) {
                        let _ = k.delete_value("");
                    }
                }
                let _ = classes.delete_subkey_all(progid);
            }
            let _ = classes.delete_subkey_all(format!("Applications\\{}", exe_name()));
        }
        let _ = hkcu.delete_subkey_all("Software\\Callio\\Capabilities");
        if let Ok(k) = hkcu.open_subkey_with_flags("Software\\RegisteredApplications", KEY_ALL_ACCESS) {
            let _ = k.delete_value(APP_NAME);
        }
        notify();
        Ok(())
    }

    /// Explorer's per-user choices that point at Callio (Open with list, default app).
    pub fn cleanup_choices() {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let base = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts";
        let Ok(fe) = hkcu.open_subkey(base) else { return };
        let exts: Vec<String> = fe.enum_keys().flatten().collect();
        for ext in exts {
            let k = format!("{base}\\{ext}");
            if let Ok(op) = hkcu.open_subkey_with_flags(format!("{k}\\OpenWithProgids"), KEY_ALL_ACCESS) {
                let names: Vec<String> = op.enum_values().flatten().map(|(n, _)| n).filter(|n| n.starts_with("Callio.")).collect();
                for n in names {
                    let _ = op.delete_value(n);
                }
            }
            if let Ok(ol) = hkcu.open_subkey_with_flags(format!("{k}\\OpenWithList"), KEY_ALL_ACCESS) {
                let mut mru: String = ol.get_value("MRUList").unwrap_or_default();
                let hits: Vec<String> = ol
                    .enum_values()
                    .flatten()
                    .filter(|(n, _)| n.len() == 1)
                    .filter(|(n, _)| ol.get_value::<String, _>(n).map(|v| v.to_lowercase() == "callio.exe").unwrap_or(false))
                    .map(|(n, _)| n)
                    .collect();
                for n in hits {
                    let _ = ol.delete_value(&n);
                    mru = mru.replace(&n, "");
                }
                let _ = ol.set_value("MRUList", &mru);
            }
            if let Ok(uc) = hkcu.open_subkey(format!("{k}\\UserChoice")) {
                let id: String = uc.get_value("ProgId").unwrap_or_default();
                let l = id.to_lowercase();
                if l.starts_with("callio.") || l.contains("callio.exe") {
                    drop(uc);
                    // Windows may protect this key; then it simply falls back once the ProgID is gone
                    let _ = hkcu.delete_subkey(format!("{k}\\UserChoice"));
                }
            }
        }
        if let Ok(classes) = hkcu.open_subkey_with_flags("Software\\Classes", KEY_ALL_ACCESS) {
            let _ = classes.delete_subkey_all("Applications\\Callio.exe");
        }
        notify();
    }

    /// Some(true) = registered for this exe, Some(false) = registered for another path, None = not registered
    pub fn state() -> Option<bool> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        // the newest ProgID: older registrations lacking it get refreshed on launch
        let k = hkcu.open_subkey("Software\\Classes\\Callio.PDF\\shell\\open\\command").ok()?;
        let v: String = k.get_value("").ok()?;
        Some(v.to_lowercase().contains(&exe_path().to_lowercase()))
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn register() -> std::io::Result<()> {
        Err(std::io::Error::other("File associations are only supported on Windows"))
    }
    pub fn unregister() -> std::io::Result<()> {
        Ok(())
    }
    pub fn state() -> Option<bool> {
        None
    }
    pub fn cleanup_choices() {}
}

/// Uninstall: every trace in the registry.
pub fn unregister_all() {
    let _ = imp::unregister();
    imp::cleanup_choices();
}

pub fn register_now() -> std::io::Result<()> {
    imp::register()
}
pub fn unregister_now() -> std::io::Result<()> {
    imp::unregister()
}

fn disabled_flag(app: &AppHandle) -> std::path::PathBuf {
    crate::settings::config_dir(app).join("assoc-disabled")
}

/// First run: register automatically. If the exe moved, refresh the paths.
pub fn ensure_registered(app: &AppHandle) {
    if cfg!(debug_assertions) || disabled_flag(app).exists() {
        return;
    }
    if imp::state() != Some(true) {
        let _ = imp::register();
    }
}

#[tauri::command]
pub fn assoc_status() -> AssocStatus {
    AssocStatus { registered: imp::state() == Some(true), exe: exe_path(), extensions: TYPES.iter().map(|t| t.0.to_string()).collect() }
}

#[tauri::command]
pub fn assoc_register(app: AppHandle) -> CmdResult<()> {
    let _ = std::fs::remove_file(disabled_flag(&app));
    imp::register().map_err(|e| format!("Couldn't write registry: {e}"))
}

#[tauri::command]
pub fn assoc_unregister(app: AppHandle) -> CmdResult<()> {
    let f = disabled_flag(&app);
    let _ = std::fs::create_dir_all(f.parent().unwrap());
    let _ = std::fs::write(f, b"1");
    imp::unregister().map_err(|e| format!("Couldn't write registry: {e}"))
}

#[tauri::command]
pub fn open_default_apps(app: AppHandle) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(format!("ms-settings:defaultapps?registeredAppUser={APP_NAME}"), None::<&str>)
        .map_err(|e| e.to_string())
}
