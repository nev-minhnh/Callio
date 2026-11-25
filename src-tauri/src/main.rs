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
mod drawio;
mod mcp_ext;
// [chat-core] mods

// [chat-ui] mods
mod chat_ui;

// [memory] mods
mod memnotes;
mod notes_core;
mod obsidian;
mod storage;
mod storage_core;
mod vaultscope;

// [windows] mods
mod windows;

// [jupyter] mods
mod jupyter;

// [wsl] mods
mod envs;

// [ssh] mods

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

use std::sync::Mutex;
use tauri::Manager;

struct Startup(Vec<String>);

#[tauri::command]
fn close_ack(window: tauri::WebviewWindow) {
    windows::close_ack(window.label());
}

/// The page is up and listening: the first window gets the files it was started with, every
/// window the paths that were handed to it while it loaded.
#[tauri::command]
fn startup_paths(window: tauri::WebviewWindow, state: tauri::State<Startup>) -> Vec<String> {
    let mut v = if window.label() == windows::MAIN { state.0.clone() } else { vec![] };
    v.extend(windows::take_pending(window.label()));
    v
}

/// The window starts hidden and is shown once the UI has painted: no white flash on startup.
#[tauri::command]
fn show_window(window: tauri::WebviewWindow) {
    if !window.is_visible().unwrap_or(true) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    chat_ui::clean_exit(&app);
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
                windows::emit_app(app, "newer-version", serde_json::json!({ "exe": exe, "version": version, "args": paths.clone() }));
                if let Some(w) = windows::handler_window(app) {
                    windows::focus(&w);
                }
                return; // its files open in the new version (or here, if the user says no)
            }
            // each file goes to the window it belongs to (or a new one); no files: just show the app
            windows::route_external(app, paths);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Startup(startup))
        .manage(synctex::SyncCache(Mutex::new(Default::default())))
        .manage(engines::InstallState::default())
        .manage(ai::AiState::default())
        .manage(claude_code::CcState::default())
        .manage(office::OfficeState::default())
        .register_asynchronous_uri_scheme_protocol("drawio", drawio::protocol)
        .setup(|app| {
            mcp_ext::set_app(app.handle().clone());
            // [chat-core] setup

            // [chat-ui] setup

            // [memory] setup

            // [windows] setup
            windows::init(app.handle());

            // [jupyter] setup

            // [wsl] setup

            // [ssh] setup

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
                if let Some(w) = h2.get_webview_window(windows::MAIN) {
                    show_window(w);
                }
            });
            // the paper library's endpoint for the Edge extension, after startup settles
            let h3 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                library::server::start(h3);
            });
            Ok(())
        })
        .on_window_event(|window, event| windows::on_event(window, event))
        .invoke_handler(tauri::generate_handler![
            startup_paths,
            drawio::drawio_available,
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
            claude_code::cc_usage,
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
            library::lib_fill,
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
            translate::define_english,
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
            // [chat-core] commands
            claude_code::session::cc_session_start,
            claude_code::session::cc_session_send,
            claude_code::session::cc_session_cancel_queued,
            claude_code::session::cc_session_interrupt,
            claude_code::session::cc_session_stop,
            claude_code::session::cc_session_state,
            claude_code::session::cc_session_stop_task,
            claude_code::session::cc_session_list,
            claude_code::session::cc_session_meta,
            claude_code::session::cc_journal_list,
            claude_code::session::cc_journal_end,

            // [chat-ui] commands
            chat_ui::session_marker_begin,
            chat_ui::session_marker_touch,
            chat_ui::session_marker_end,
            chat_ui::draft_save,
            chat_ui::draft_list,
            chat_ui::draft_delete,
            chat_ui::draft_purge,
            chat_ui::tabs_state_save,
            chat_ui::tabs_state_load,
            chat_ui::tabs_state_delete,

            // [memory] commands
            storage::storage_info, storage::storage_status, storage::storage_check_dest, storage::storage_move, storage::storage_cancel, storage::storage_restart, storage::storage_cleanup, storage::storage_use_folder, storage::storage_retry, storage::storage_open_without_data, storage::storage_portable_dismiss,
            obsidian::obs_detect, obsidian::obs_vault_info, obsidian::obs_cli_test, obsidian::obs_cli, obsidian::obs_open, obsidian::obs_setup_vault, obsidian::obs_install, obsidian::obs_install_cancel, obsidian::vault_read, obsidian::vault_write, obsidian::vault_list, obsidian::vault_search,
            memnotes::memnotes_get, memnotes::memnotes_write, memnotes::memnotes_remember, memnotes::memnotes_delete, memnotes::memnotes_prompt,

            // [windows] commands
            windows::win_route,
            windows::win_report,
            windows::win_boot,
            windows::win_list,
            windows::win_focus,
            windows::win_close,
            windows::win_previous,
            windows::win_restore,
            windows::win_discard_previous,

            // [jupyter] commands
            jupyter::jp_interpreters,
            jupyter::jp_pip_install,
            jupyter::jp_local_start,
            jupyter::jp_local_stop,
            jupyter::jp_local_list,
            jupyter::jp_set_idle,
            jupyter::jp_shutdown,
            jupyter::jp_test,
            jupyter::jp_rest,
            jupyter::jp_ws_open,
            jupyter::jp_ws_send,
            jupyter::jp_ws_close,

            // [wsl] commands
            envs::detect::envs_list,
            envs::detect::envs_wsl_info,
            envs::detect::envs_wsl_start,
            envs::detect::envs_wsl_stop,
            envs::detect::envs_probe,
            envs::detect::envs_docker_info,
            envs::claude::envs_install_claude,
            envs::claude::envs_cc_status,
            envs::claude::envs_cc_login,
            envs::poll::envs_poll_set,
            envs::jupyter::envs_jp_interpreters,
            envs::jupyter::envs_jp_start,
            envs::jupyter::envs_jp_stop,
            envs::jupyter::envs_jp_list,
            envs::jupyter::envs_jp_install,
            envs::jupyter::envs_jp_venv,

            // [ssh] commands
        ])
        .build(tauri::generate_context!())
        .expect("error while building Callio")
        .run(|app, event| {
            // [chat-core] exit: end Claude Code processes and mark their journals clean
            if let tauri::RunEvent::Exit = event {
                claude_code::session::on_app_exit(app);
            }
        });
}
