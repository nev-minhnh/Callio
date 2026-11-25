//! The AI chat in its own window. An editor window can pop its AI panel out into a chat window
//! (label `chat-<editor label>`, role "chat", at most one per editor window); the page of that
//! window is the same `index.html`, started with `role=chat&parent=<editor label>`, and shows only
//! the AI panel. The Claude Code sessions themselves live in Rust, so they keep running while
//! the window changes; the pages hand the chat state over to each other (see src/detach.js).
//!
//! This file is the Rust half: create / focus / close the chat window, remember where it was
//! (per editor window), keep it on top if asked, and a small relay (`win_send`) that carries
//! the messages the two pages send each other (`win-msg` events, see src/winrpc.js).
use super::{create_as, focus, persist_later, reg, WinState, ROLE_CHAT};
use crate::util::CmdResult;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WindowEvent};

pub fn label_for(parent: &str) -> String {
    format!("chat-{parent}")
}

/// Pop the chat out of `window` (an editor window): creates the chat window, or focuses the one
/// that exists. Returns its label.
#[tauri::command]
pub async fn win_chat_open(app: AppHandle, window: WebviewWindow) -> CmdResult<String> {
    let parent = window.label().to_string();
    if super::is_chat_window(&parent) {
        return Err("The AI chat is already in its own window.".into());
    }
    let label = label_for(&parent);
    if let Some(w) = app.get_webview_window(&label) {
        focus(&w);
        return Ok(label);
    }
    let bounds = {
        let mut r = reg();
        let folder = r.wins.get(&parent).and_then(|w| w.folder.clone());
        let b = r.chat_bounds.get(&parent).copied();
        let mut st = WinState::new(ROLE_CHAT);
        st.parent = Some(parent.clone());
        st.folder = folder;
        st.bounds = b;
        r.wins.insert(label.clone(), st);
        b
    };
    // first time: beside the editor window (to its right when there is room), else on top of it
    let bounds = bounds.or_else(|| beside(&window));
    if let Err(e) = create_as(&app, &label, Some(&parent), None, None, false, Some(&window), bounds) {
        reg().wins.remove(&label);
        return Err(format!("Couldn't open the AI window: {e}"));
    }
    persist_later(&app);
    Ok(label)
}

/// A good first place: right of the editor window if the screen has room, else over its right part.
fn beside(w: &WebviewWindow) -> Option<[i32; 4]> {
    let (p, s, f) = (w.outer_position().ok()?, w.inner_size().ok()?, w.scale_factor().ok()?);
    let (x, y, ww, hh) = (p.x as f64 / f, p.y as f64 / f, s.width as f64 / f, s.height as f64 / f);
    let width = 460.0_f64.min((ww * 0.6).max(360.0));
    let screen_right = w.current_monitor().ok().flatten().map(|m| (m.position().x as f64 + m.size().width as f64) / f);
    let fits = screen_right.map(|r| x + ww + width <= r + 1.0).unwrap_or(false);
    let nx = if fits { x + ww } else { (x + ww - width - 24.0).max(0.0) };
    Some([nx as i32, y as i32, width as i32, hh.max(520.0) as i32])
}

/// Bring the chat window of this editor window to the front (the AI button while it is out).
#[tauri::command]
pub fn win_chat_focus(app: AppHandle, window: WebviewWindow) -> bool {
    match app.get_webview_window(&label_for(window.label())) {
        Some(w) => {
            focus(&w);
            true
        }
        None => false,
    }
}

/// Close a chat window without asking again: the chat window itself (its chat was attached back), or,
/// from an editor window, the chat window of that editor window (it never started, or is shutting down).
#[tauri::command]
pub fn win_chat_close(app: AppHandle, window: WebviewWindow) {
    if super::is_chat_window(window.label()) {
        let _ = window.destroy();
    } else if let Some(w) = app.get_webview_window(&label_for(window.label())) {
        let _ = w.destroy();
    }
}

/// Keep the chat window above the others (it sits beside the editor on a second monitor).
#[tauri::command]
pub fn win_chat_pin(window: WebviewWindow, on: bool) {
    let _ = window.set_always_on_top(on);
}

/// One page tells another one something (see src/winrpc.js for the message shapes). The message
/// is passed on as it is, with the sender's label added. `false`: no such window.
#[tauri::command]
pub fn win_send(app: AppHandle, window: WebviewWindow, to: String, mut msg: Value) -> bool {
    if app.get_webview_window(&to).is_none() {
        return false;
    }
    if let Some(o) = msg.as_object_mut() {
        o.insert("from".into(), json!(window.label()));
    }
    app.emit_to(to, "win-msg", msg).is_ok()
}

/// The chat windows of an editor window that is going away close with it.
pub fn close_children(app: &AppHandle, parent: &str) {
    let kids: Vec<String> = reg().wins.iter().filter(|(_, w)| w.parent.as_deref() == Some(parent)).map(|(l, _)| l.clone()).collect();
    for k in kids {
        if let Some(w) = app.get_webview_window(&k) {
            let _ = w.destroy();
        }
    }
}

/// Events of a chat window: closing asks the page to attach the chat back first (the page then
/// calls `win_chat_close`); moving and resizing are remembered per editor window.
pub fn on_event(window: &tauri::Window, event: &WindowEvent) {
    let label = window.label().to_string();
    let app = window.app_handle();
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            let mut guard = super::CLOSE_PENDING.lock().unwrap_or_else(|e| e.into_inner());
            let map = guard.get_or_insert_with(Default::default);
            // a page that did not answer within 3 s is hung: let the window close
            let hung = map.get(&label).map(|t| t.elapsed() > Duration::from_secs(3)).unwrap_or(false);
            if super::ui_ready(&label) && !hung {
                api.prevent_close();
                map.insert(label.clone(), Instant::now());
                let _ = app.emit_to(label.clone(), "chat-close-requested", ());
            }
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if window.is_minimized().unwrap_or(false) || window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
                return;
            }
            if let (Ok(p), Ok(s), Ok(f)) = (window.outer_position(), window.inner_size(), window.scale_factor()) {
                if s.width == 0 || s.height == 0 {
                    return;
                }
                let b = [(p.x as f64 / f) as i32, (p.y as f64 / f) as i32, (s.width as f64 / f) as i32, (s.height as f64 / f) as i32];
                let mut r = reg();
                let parent = r.wins.get(&label).and_then(|w| w.parent.clone());
                if let Some(w) = r.wins.get_mut(&label) {
                    w.bounds = Some(b);
                }
                if let Some(p) = parent {
                    r.chat_bounds.insert(p, b);
                }
                drop(r);
                persist_later(app);
            }
        }
        WindowEvent::Destroyed => {
            let parent = reg().wins.remove(&label).and_then(|w| w.parent);
            if let Some(m) = super::CLOSE_PENDING.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                m.remove(&label);
            }
            if let Some(s) = super::UI_READY.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                s.remove(&label);
            }
            // the editor window finds out (if the chat went away without attaching back)
            if let Some(p) = parent {
                let _ = app.emit_to(p, "chat-gone", json!({ "label": label }));
            }
            persist_later(app);
        }
        _ => {}
    }
}
