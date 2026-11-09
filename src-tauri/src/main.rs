// No console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod assoc;
mod claude_code;
mod compile;
mod engines;
mod export;
mod fonts;
mod fsops;
mod history;
mod library;
mod memory;
mod watch;
mod shellops;
mod media;
mod translate;
mod websearch;
mod ocr;
mod localhttp;
mod overleaf;
mod sessions;
mod settings;
mod synctex;
mod office;
mod textindex;
mod treeops;
mod update;
mod util;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager, WindowEvent};

struct Startup(Vec<String>);
static FRONTEND_READY: AtomicBool = AtomicBool::new(false);
/// Set when a close was handed to the UI and not yet acknowledged.
static CLOSE_PENDING: Mutex<Option<std::time::Instant>> = Mutex::new(None);

#[tauri::command]
fn close_ack() {
    *CLOSE_PENDING.lock().unwrap() = None;
}

#[tauri::command]
fn startup_paths(state: tauri::State<Startup>) -> Vec<String> {
    FRONTEND_READY.store(true, Ordering::SeqCst);
    state.0.clone()
}

/// The window starts hidden and is shown once the UI has painted: no white flash on startup.
#[tauri::command]
fn show_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if !w.is_visible().unwrap_or(true) {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// The app was called Proemia (dev.proemia.editor) and before that Quire (dev.quire.editor): its
/// settings, library, history, installed engines and browser data move to Callio's folders on
/// first start (the newest old name wins).
fn migrate_old_name() {
    let mut roots: Vec<std::path::PathBuf> = vec![];
    #[cfg(windows)]
    for v in ["APPDATA", "LOCALAPPDATA"] {
        if let Some(d) = std::env::var_os(v) {
            roots.push(d.into());
        }
    }
    #[cfg(not(windows))]
    if let Some(h) = std::env::var_os("HOME") {
        let h = std::path::PathBuf::from(h);
        roots.push(h.join(".config"));
        roots.push(h.join(".local/share"));
    }
    for r in roots {
        let new = r.join("dev.callio.editor");
        for old in ["dev.proemia.editor", "dev.quire.editor"].map(|n| r.join(n)) {
            if old.is_dir() && !new.exists() {
                // (a file in use: leave everything where it is; the next start tries again)
                let _ = std::fs::rename(&old, &new);
            }
        }
    }
}

fn main() {
    migrate_old_name();
    let cwd = std::env::current_dir().unwrap_or_default();
    let args: Vec<String> = std::env::args_os().map(|a| a.to_string_lossy().to_string()).collect();
    // Used by the installer (post-install / pre-uninstall hooks).
    if args.iter().any(|a| a == "--register-file-types") {
        let _ = assoc::register_now();
        return;
    }
    if args.iter().any(|a| a == "--unregister-file-types") {
        let _ = assoc::unregister_now();
        return;
    }
    // a hand-off from an older window, or an older copy still running / installed elsewhere
    update::wait_for_handoff(&args);
    if !update::startup_takeover(&args) {
        return;
    }
    let startup = fsops::paths_from_args(&args, &cwd);

    tauri::Builder::default()
        // must be first: a second launch (double-clicking another file) hands its
        // paths to the running window instead of opening a new one
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let paths = fsops::paths_from_args(&argv, std::path::Path::new(&cwd));
            // a newer Callio was started from another folder: offer to switch to it
            if let Some((exe, version)) = update::newer_launch(&argv, &cwd) {
                let _ = app.emit("newer-version", serde_json::json!({ "exe": exe, "version": version, "args": paths.clone() }));
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
                return; // its files open in the new version (or here, if the user says no)
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if !paths.is_empty() {
                let _ = app.emit("open-paths", paths);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Startup(startup))
        .manage(synctex::SyncCache(Mutex::new(Default::default())))
        .manage(engines::InstallState::default())
        .manage(ai::AiState::default())
        .manage(claude_code::CcState::default())
        .manage(office::OfficeState::default())
        .setup(|app| {
            websearch::init(app.handle());
            std::thread::spawn(|| {
                // after the window is up: tidy old temp files, then warm the office engine's file
                std::thread::sleep(std::time::Duration::from_secs(4));
                office::clean_temp();
                std::thread::sleep(std::time::Duration::from_secs(2));
                office::prefetch();
            });
            std::thread::spawn(settings::migrate_secrets);
            let handle = app.handle().clone();
            let s = settings::load_from_disk(&handle);
            app.manage(settings::SettingsState(Mutex::new(s)));
            // Register "Open with" entries on first run / when the exe moved.
            std::thread::spawn(move || assoc::ensure_registered(&handle));
            // safety net: show the window even if the UI failed to load
            let h2 = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                show_window(h2);
            });
            // the paper library's endpoint for the Edge extension, after startup settles
            let h3 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                library::server::start(h3);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return; // helper windows (Overleaf sign-in) close normally
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Let the UI ask about unsaved files; if the UI never loaded, just close.
                // If the UI didn't answer an earlier request within 2 s it is hung: let it close.
                let mut pending = CLOSE_PENDING.lock().unwrap();
                let hung = pending.map(|t| t.elapsed().as_secs_f32() > 2.0).unwrap_or(false);
                if FRONTEND_READY.load(Ordering::SeqCst) && !hung {
                    api.prevent_close();
                    *pending = Some(std::time::Instant::now());
                    let _ = window.emit("close-requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            startup_paths,
            exit_app,
            show_window,
            close_ack,
            update::handoff,
            update::uninstall_info,
            update::uninstall_everything,
            ai::ai_chat,
            ai::ai_cancel,
            ai::ai_list_models,
            ai::ai_test,
            ai::bib::verify_bib,
            claude_code::cc_status,
            claude_code::cc_install,
            claude_code::cc_login,
            claude_code::cc_logout,
            claude_code::cc_run,
            claude_code::cc_cancel,
            claude_code::cc_reply,
            claude_code::cc_restore,
            claude_code::cc_skills,
            export::export_html_pdf,
            export::export_copy_pdf,
            export::export_browser,
            library::lib_list,
            library::lib_add,
            library::lib_enrich,
            library::lib_sign_in_pdf,
            library::lib_sign_in_pdf_close,
            library::lib_set_text,
            library::lib_update,
            library::lib_delete,
            library::lib_save_collection,
            library::lib_delete_collection,
            library::lib_pdf_path,
            library::lib_bibtex,
            library::lib_cite,
            library::lib_text,
            library::lib_search,
            library::lib_import_bib,
            library::csl_fetch,
            library::find_tex_file,
            memory::mem_record,
            memory::mem_recall,
            memory::mem_pin,
            memory::mem_list,
            memory::mem_forget,
            sessions::sess_list,
            sessions::sess_get,
            sessions::sess_put,
            sessions::sess_delete,
            memory::mem_set_cc,
            library::server::lib_extension_dir,
            library::server::lib_open_edge_extensions,
            ai::skills::skills_scan,
            ai::skills::skills_read,
            ai::skills::skills_own_dir,
            ai::skills_github::skills_github_inspect,
            ai::skills_github::skills_github_install,
            ai::skills_github::skills_installed,
            ai::skills_github::skills_update,
            ai::skills_github::skills_remove,
            history::history_record,
            history::history_record_disk,
            history::history_list,
            history::history_get,
            history::history_rename,
            fsops::read_text,
            fsops::write_text,
            fsops::system_ansi,
            fsops::path_info,
            fsops::compare_dirs,
            fsops::list_dir,
            watch::fs_watch,
            shellops::print_file,
            shellops::launch_program,
            shellops::list_extractors,
            shellops::extract_with,
            media::media_ffmpeg,
            media::media_transcode,
            media::media_cancel,
            translate::translate_google,
            websearch::web_search_engine,
            fsops::read_binary,
            fsops::pick_open_file,
            fsops::pick_image,
            fsops::pick_convert_file,
            fonts::system_fonts,
            ocr::ocr_engines,
            ocr::ocr_install_tesseract,
            ocr::ocr_tesseract_language,
            ocr::ocr_windows_language,
            treeops::fs_create,
            treeops::fs_copy,
            treeops::fs_move,
            treeops::fs_duplicate,
            treeops::fs_trash,
            treeops::open_terminal,
            treeops::fs_find,
            treeops::pick_files,
            office::office,
            office::office_available,
            office::office_temp,
            ocr::ocr_local,
            ocr::ocr_vision,
            ocr::ocr_claude_code,
            ocr::ocr_cancel,
            ocr::ocr_job_end,
            fonts::font_file,
            fsops::write_binary,
            fsops::rename_path,
            fsops::file_mtime,
            fsops::pick_folder,
            fsops::pick_save_file,
            fsops::open_url,
            fsops::open_path,
            fsops::reveal_path,
            fsops::app_info,
            fsops::set_title,
            settings::load_settings,
            settings::save_settings,
            settings::get_secret,
            settings::set_secret,
            compile::find_root,
            compile::scan_project,
            engines::detect_engines,
            engines::install_engine,
            engines::cancel_install,
            engines::remove_engine,
            compile::compile,
            synctex::synctex_forward,
            synctex::synctex_lines,
            synctex::synctex_inverse,
            assoc::assoc_status,
            assoc::assoc_register,
            assoc::assoc_unregister,
            assoc::open_default_apps,
            overleaf::login::ol_sign_in,
            overleaf::login::ol_sign_out,
            overleaf::ol_link_info,
            overleaf::ol_test,
            overleaf::ol_list_projects,
            overleaf::ol_clone,
            overleaf::ol_link,
            overleaf::ol_unlink,
            overleaf::ol_pull,
            overleaf::ol_push,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Callio");
}
