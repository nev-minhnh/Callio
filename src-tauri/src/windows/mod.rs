//! Callio windows: every window is a session with its own folder. A file that is not inside the
//! window's folder opens in another window (the one that has it, the one whose folder holds it,
//! or a new one). This module keeps the registry of windows, decides routing (see `route.rs`),
//! creates windows, handles closing, remembers the window list for restoring after a crash, and
//! lowers WebView2's memory for minimised windows (`mem.rs`).
//!
//! A window has a `role`: "editor" for the folder windows, "chat" for the AI chat popped out of an
//! editor window (`chat.rs`; its label is `chat-<parent label>` and `parent` names the editor).
pub mod chat;
pub mod mem;
pub mod route;

use crate::util::{CmdResult, ErrStr};
use route::{Decision, Win};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

pub const MAIN: &str = "main";
pub const ROLE_EDITOR: &str = "editor";
pub const ROLE_CHAT: &str = "chat";

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub label: String,
    #[serde(default)]
    pub role: String,
    pub folder: Option<String>,
    /// logical x, y, width, height
    pub bounds: Option<[i32; 4]>,
    #[serde(default)]
    pub layout: Value,
    /// a chat window: the editor window it belongs to
    #[serde(default)]
    pub parent: Option<String>,
}

struct WinState {
    role: String,
    folder: Option<String>,
    files: Vec<String>,
    focused_at: u64,
    bounds: Option<[i32; 4]>,
    layout: Value,
    /// the page has loaded and listens for "win-open"; until then paths wait in `pending`
    ready: bool,
    pending: Vec<(String, Option<u32>)>,
    low_memory: bool,
    parent: Option<String>,
}

impl WinState {
    fn new(role: &str) -> Self {
        WinState { role: role.into(), folder: None, files: vec![], focused_at: 0, bounds: None, layout: Value::Null, ready: false, pending: vec![], low_memory: false, parent: None }
    }
    fn as_win(&self, label: &str) -> Win {
        Win { label: label.into(), folder: self.folder.clone(), files: self.files.clone(), focused_at: self.focused_at }
    }
}

struct Registry {
    wins: BTreeMap<String, WinState>,
    seq: u64,
    next: u32,
    /// the window list of the last run (read at start, before this run overwrites the file)
    prev: Vec<Saved>,
    /// where each editor window's chat window was last (logical x, y, width, height), by parent label
    chat_bounds: BTreeMap<String, [i32; 4]>,
}

static REG: Mutex<Registry> = Mutex::new(Registry { wins: BTreeMap::new(), seq: 0, next: 2, prev: Vec::new(), chat_bounds: BTreeMap::new() });
static PERSIST_QUEUED: AtomicBool = AtomicBool::new(false);
/// windows that handed a close request to the UI and wait for the answer
static CLOSE_PENDING: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);
static UI_READY: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn reg() -> std::sync::MutexGuard<'static, Registry> {
    REG.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn is_app_window(label: &str) -> bool {
    label == MAIN || label.starts_with("w-")
}

pub fn is_chat_window(label: &str) -> bool {
    label.starts_with("chat-")
}

fn windows_file(app: &AppHandle) -> std::path::PathBuf {
    crate::settings::data_dir(app).join("windows.json")
}

// ---------------------------------------------------------------- start-up / persistence

/// Called once from setup: registers the main window and reads the previous run's window list.
pub fn init(app: &AppHandle) {
    let file: Option<Value> = std::fs::read_to_string(windows_file(app)).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let prev: Vec<Saved> = file.as_ref().and_then(|v| serde_json::from_value(v["windows"].clone()).ok()).unwrap_or_default();
    let bounds: BTreeMap<String, [i32; 4]> = file.as_ref().and_then(|v| serde_json::from_value(v["chatBounds"].clone()).ok()).unwrap_or_default();
    let mut r = reg();
    r.wins.entry(MAIN.into()).or_insert_with(|| WinState::new(ROLE_EDITOR));
    // labels of the last run stay reserved so a restored window never clashes with a new one
    for s in &prev {
        if let Some(n) = s.label.strip_prefix("w-").and_then(|n| n.parse::<u32>().ok()) {
            r.next = r.next.max(n + 1);
        }
    }
    r.chat_bounds = bounds;
    r.prev = prev.into_iter().filter(|s| s.label != MAIN && (is_app_window(&s.label) || is_chat_window(&s.label))).collect();
}

/// Write the window list soon (several changes in a burst make one write).
fn persist_later(app: &AppHandle) {
    if PERSIST_QUEUED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(700));
        PERSIST_QUEUED.store(false, Ordering::SeqCst);
        persist_now(&app);
    });
}

fn persist_now(app: &AppHandle) {
    let (list, chat_bounds): (Vec<Saved>, BTreeMap<String, [i32; 4]>) = {
        let r = reg();
        (
            r.wins
                .iter()
                .map(|(l, w)| Saved { label: l.clone(), role: w.role.clone(), folder: w.folder.clone(), bounds: w.bounds, layout: w.layout.clone(), parent: w.parent.clone() })
                .collect(),
            r.chat_bounds.clone(),
        )
    };
    let p = windows_file(app);
    let _ = std::fs::create_dir_all(p.parent().unwrap_or(std::path::Path::new(".")));
    let tmp = p.with_extension("json.tmp");
    if let Ok(bytes) = serde_json::to_vec_pretty(&json!({ "version": 1, "windows": list, "chatBounds": chat_bounds })) {
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }
}

// ---------------------------------------------------------------- helpers

/// The window the user is working in: the most recently focused one that still exists.
pub fn handler_window(app: &AppHandle) -> Option<WebviewWindow> {
    let best = {
        let r = reg();
        r.wins.iter().filter(|(l, w)| w.role == ROLE_EDITOR && app.get_webview_window(l).is_some()).max_by_key(|(_, w)| w.focused_at).map(|(l, _)| l.clone())
    };
    best.and_then(|l| app.get_webview_window(&l)).or_else(|| app.get_webview_window(MAIN)).or_else(|| app.webview_windows().into_iter().find(|(l, _)| is_app_window(l)).map(|(_, w)| w))
}

/// An event for the window the user is working in (requests that only one window may answer).
pub fn emit_app<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    match handler_window(app) {
        Some(w) => {
            let _ = app.emit_to(w.label().to_string(), event, payload);
        }
        None => {
            let _ = app.emit(event, payload);
        }
    }
}

/// Bring a window to the front: restore it if minimised, flash its taskbar button if Windows
/// won't let it take the focus.
pub fn focus(w: &WebviewWindow) {
    let _ = w.show();
    if w.is_minimized().unwrap_or(false) {
        let _ = w.unminimize();
    }
    let _ = w.set_focus();
    if !w.is_focused().unwrap_or(true) {
        let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}

fn enc(s: &str) -> String {
    urlencoding::encode(s).into_owned()
}

/// Make a window. Its page reads `win`, `open`, `folder` and `restore` from the query.
fn create(app: &AppHandle, label: &str, folder: Option<&str>, open: Option<&str>, restore: bool, near: Option<&WebviewWindow>, bounds: Option<[i32; 4]>) -> CmdResult<()> {
    create_as(app, label, None, folder, open, restore, near, bounds)
}

/// `chat_of`: Some(parent label) makes a chat window (the AI panel on its own) for that editor window.
pub(crate) fn create_as(app: &AppHandle, label: &str, chat_of: Option<&str>, folder: Option<&str>, open: Option<&str>, restore: bool, near: Option<&WebviewWindow>, bounds: Option<[i32; 4]>) -> CmdResult<()> {
    if app.get_webview_window(label).is_some() {
        return Ok(());
    }
    let mut q = format!("index.html?win={}", enc(label));
    if let Some(p) = chat_of {
        q += &format!("&role=chat&parent={}", enc(p));
    }
    if let Some(o) = open {
        q += &format!("&open={}", enc(o));
    }
    if let Some(f) = folder {
        q += &format!("&folder={}", enc(f));
    }
    if restore {
        q += "&restore=1";
    }
    let mut b = WebviewWindowBuilder::new(app, label, WebviewUrl::App(q.into()))
        .title("Callio")
        .min_inner_size(if chat_of.is_some() { 360.0 } else { 720.0 }, 460.0)
        .zoom_hotkeys_enabled(true)
        .visible(false);
    // size and place: the saved bounds, else the asking window's, shifted a little
    let mut placed = false;
    if let Some([x, y, w, h]) = bounds {
        let min_w = if chat_of.is_some() { 360 } else { 720 };
        b = b.inner_size(w.max(min_w) as f64, h.max(460) as f64).position(x as f64, y as f64);
        placed = true;
    } else if let Some(n) = near {
        if let (Ok(p), Ok(s), Ok(f)) = (n.outer_position(), n.inner_size(), n.scale_factor()) {
            if !n.is_minimized().unwrap_or(false) && !n.is_maximized().unwrap_or(false) {
                b = b.inner_size(s.width as f64 / f, s.height as f64 / f).position(p.x as f64 / f + 32.0, p.y as f64 / f + 32.0);
                placed = true;
            } else if let Ok(s2) = n.inner_size() {
                b = b.inner_size((s2.width as f64 / f * 0.85).max(720.0), (s2.height as f64 / f * 0.85).max(460.0));
            }
        }
    }
    if !placed {
        b = b.center();
    }
    b.build().es()?;
    // safety net like the main window's: show it even if the page never reports in
    let a = app.clone();
    let l = label.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        if let Some(w) = a.get_webview_window(&l) {
            if !w.is_visible().unwrap_or(true) {
                let _ = w.show();
            }
        }
    });
    Ok(())
}

/// Hand a path to a window: now if its page is listening, else when it asks for its start-up paths.
fn deliver(app: &AppHandle, label: &str, path: &str, line: Option<u32>) {
    let ready = {
        let mut r = reg();
        match r.wins.get_mut(label) {
            Some(w) if !w.ready => {
                w.pending.push((path.to_string(), line));
                false
            }
            _ => true,
        }
    };
    if ready {
        let _ = app.emit_to(label.to_string(), "win-open", json!({ "paths": [path], "line": line }));
    }
}

fn alloc_label(r: &mut Registry) -> String {
    let n = r.next;
    r.next += 1;
    format!("w-{n}")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteOut {
    here: bool,
    label: Option<String>,
    created: bool,
}

/// Decide and act. `me`: the asking window's fresh state; None = nobody asked (second launch).
fn route_one(app: &AppHandle, from: Option<&WebviewWindow>, me_state: Option<(Option<String>, Vec<String>)>, path: &str, line: Option<u32>) -> CmdResult<RouteOut> {
    let (decision, new_label, my_label) = {
        let mut r = reg();
        let my_label = match from {
            Some(w) => w.label().to_string(),
            None => r.wins.iter().filter(|(_, w)| w.role == ROLE_EDITOR).max_by_key(|(_, w)| w.focused_at).map(|(l, _)| l.clone()).unwrap_or_else(|| MAIN.into()),
        };
        if let (Some((folder, files)), Some(w)) = (me_state, r.wins.get_mut(&my_label)) {
            w.folder = folder;
            w.files = files;
        }
        let me = r.wins.get(&my_label).map(|w| w.as_win(&my_label)).unwrap_or_default();
        let others: Vec<Win> = r.wins.iter().filter(|(l, w)| **l != my_label && w.role == ROLE_EDITOR).map(|(l, w)| w.as_win(l)).collect();
        let d = route::decide(path, &me, &others);
        // a brand-new window is registered at once, so a second request for the same file
        // (a double launch) finds it instead of making another
        let (d, new_label) = match d {
            Decision::New { folder } => {
                let label = alloc_label(&mut r);
                let mut st = WinState::new(ROLE_EDITOR);
                st.folder = Some(folder.clone());
                st.files = vec![path.to_string()];
                r.seq += 1;
                st.focused_at = r.seq;
                r.wins.insert(label.clone(), st);
                (Decision::New { folder }, Some(label))
            }
            d => (d, None),
        };
        (d, new_label, my_label)
    };
    match decision {
        Decision::Here => {
            if from.is_none() {
                deliver(app, &my_label, path, line);
                if let Some(w) = app.get_webview_window(&my_label) {
                    focus(&w);
                }
            }
            Ok(RouteOut { here: true, label: Some(my_label), created: false })
        }
        Decision::Focus(l) | Decision::OpenIn(l) => {
            deliver(app, &l, path, line);
            if let Some(w) = app.get_webview_window(&l) {
                focus(&w);
            }
            Ok(RouteOut { here: false, label: Some(l), created: false })
        }
        Decision::New { folder } => {
            let label = new_label.unwrap_or_default();
            let near = from.cloned().or_else(|| app.get_webview_window(&my_label));
            if let Err(e) = create(app, &label, Some(&folder), Some(path), false, near.as_ref(), None) {
                reg().wins.remove(&label);
                return Err(format!("Couldn't open a new window: {e}"));
            }
            persist_later(app);
            Ok(RouteOut { here: false, label: Some(label), created: true })
        }
    }
}

/// Files handed over from outside (second launch, "Open with"): route each one.
pub fn route_external(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        if let Some(w) = handler_window(app) {
            focus(&w);
        }
        return;
    }
    let app = app.clone();
    // window creation must not run on the thread that handles the single-instance callback
    tauri::async_runtime::spawn(async move {
        for p in paths {
            if let Err(e) = route_one(&app, None, None, &p, None) {
                emit_app(&app, "compile-status", e);
            }
        }
    });
}

// ---------------------------------------------------------------- commands

/// The page is up: it receives the paths that were handed to it while it loaded.
pub fn take_pending(label: &str) -> Vec<String> {
    UI_READY.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashSet::new).insert(label.to_string());
    let mut r = reg();
    match r.wins.get_mut(label) {
        Some(w) => {
            w.ready = true;
            std::mem::take(&mut w.pending).into_iter().map(|(p, _)| p).collect()
        }
        None => vec![],
    }
}

pub fn ui_ready(label: &str) -> bool {
    UI_READY.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|s| s.contains(label)).unwrap_or(false)
}

#[tauri::command]
pub async fn win_route(app: AppHandle, window: WebviewWindow, path: String, line: Option<u32>, folder: Option<String>, files: Vec<String>) -> CmdResult<RouteOut> {
    route_one(&app, Some(&window), Some((folder, files)), &path, line)
}

/// A window tells the registry what it shows (debounced on its side).
#[tauri::command]
pub fn win_report(app: AppHandle, window: WebviewWindow, folder: Option<String>, files: Vec<String>, layout: Option<Value>) {
    {
        let mut r = reg();
        let w = r.wins.entry(window.label().to_string()).or_insert_with(|| WinState::new(if is_chat_window(window.label()) { ROLE_CHAT } else { ROLE_EDITOR }));
        if w.role != ROLE_CHAT {
            // (a chat window shows no folder or files of its own: the AI panel only; its layout is kept)
            w.folder = folder;
            w.files = files;
        }
        if let Some(l) = layout {
            w.layout = l;
        }
    }
    persist_later(&app);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    layout: Value,
    folder: Option<String>,
}

/// What this window was created with (its saved layout and folder).
#[tauri::command]
pub fn win_boot(window: WebviewWindow) -> BootInfo {
    let r = reg();
    match r.wins.get(window.label()) {
        Some(w) => BootInfo { layout: w.layout.clone(), folder: w.folder.clone() },
        None => BootInfo { layout: Value::Null, folder: None },
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WinInfo {
    label: String,
    role: String,
    folder: Option<String>,
    files: Vec<String>,
    me: bool,
    parent: Option<String>,
}

#[tauri::command]
pub fn win_list(window: WebviewWindow) -> Vec<WinInfo> {
    let r = reg();
    r.wins.iter().map(|(l, w)| WinInfo { label: l.clone(), role: w.role.clone(), folder: w.folder.clone(), files: w.files.clone(), me: l == window.label(), parent: w.parent.clone() }).collect()
}

#[tauri::command]
pub fn win_focus(app: AppHandle, label: String) {
    if let Some(w) = app.get_webview_window(&label) {
        focus(&w);
    }
}

/// Close this window (after the UI settled unsaved files). "last": it is the only window left,
/// so the caller quits the app.
#[tauri::command]
pub fn win_close(app: AppHandle, window: WebviewWindow) -> &'static str {
    let others = app.webview_windows().keys().filter(|l| is_app_window(l) && l.as_str() != window.label()).count();
    if others == 0 {
        return "last";
    }
    let _ = window.destroy();
    "closed"
}

/// The previous run's other windows (for the restore dialog).
#[tauri::command]
pub fn win_previous() -> Vec<Saved> {
    reg().prev.clone()
}

/// Re-create the windows of the last run; each restores its own tabs (`restore=1`).
#[tauri::command]
pub async fn win_restore(app: AppHandle, window: WebviewWindow) -> CmdResult<usize> {
    let mut prev = std::mem::take(&mut reg().prev);
    // editor windows first: a chat window needs its editor window
    prev.sort_by_key(|s| s.role == ROLE_CHAT);
    let mut n = 0;
    for s in prev {
        if app.get_webview_window(&s.label).is_some() {
            continue;
        }
        let chat_of = if s.role == ROLE_CHAT { s.parent.clone().filter(|p| app.get_webview_window(p).is_some()) } else { None };
        if s.role == ROLE_CHAT && chat_of.is_none() {
            continue; // its editor window did not come back
        }
        {
            let mut r = reg();
            let mut st = WinState::new(if chat_of.is_some() { ROLE_CHAT } else { ROLE_EDITOR });
            st.folder = s.folder.clone();
            st.bounds = s.bounds;
            st.layout = s.layout.clone();
            st.parent = chat_of.clone();
            r.wins.insert(s.label.clone(), st);
        }
        if create_as(&app, &s.label, chat_of.as_deref(), s.folder.as_deref(), None, true, Some(&window), s.bounds).is_ok() {
            n += 1;
        } else {
            reg().wins.remove(&s.label);
        }
    }
    persist_later(&app);
    Ok(n)
}

#[tauri::command]
pub fn win_discard_previous(app: AppHandle) {
    reg().prev.clear();
    persist_later(&app);
}

// ---------------------------------------------------------------- window events

/// Close handling, focus order, bounds and memory level. Called for every window event.
pub fn on_event(window: &tauri::Window, event: &WindowEvent) {
    let label = window.label().to_string();
    if is_chat_window(&label) {
        return chat::on_event(window, event);
    }
    if !is_app_window(&label) {
        return; // helper windows (Overleaf sign-in…) close normally
    }
    let app = window.app_handle();
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            // Let the UI ask about unsaved files; if the UI never loaded, just close.
            // If the UI didn't answer an earlier request within 2 s it is hung: let it close.
            let mut guard = CLOSE_PENDING.lock().unwrap_or_else(|e| e.into_inner());
            let map = guard.get_or_insert_with(HashMap::new);
            let hung = map.get(&label).map(|t| t.elapsed().as_secs_f32() > 2.0).unwrap_or(false);
            if ui_ready(&label) && !hung {
                api.prevent_close();
                map.insert(label.clone(), Instant::now());
                let _ = app.emit_to(label.clone(), "close-requested", ()); // (not window.emit: that reaches every window)
            }
        }
        WindowEvent::Focused(true) => {
            {
                let mut r = reg();
                r.seq += 1;
                let s = r.seq;
                if let Some(w) = r.wins.get_mut(&label) {
                    w.focused_at = s;
                }
            }
            mem::restore(app, &label);
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            let minimized = window.is_minimized().unwrap_or(false);
            if minimized {
                mem::lower_later(app, &label);
                return;
            }
            mem::restore(app, &label);
            if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
                return; // keep the normal bounds
            }
            if let (Ok(p), Ok(s), Ok(f)) = (window.outer_position(), window.inner_size(), window.scale_factor()) {
                let b = [(p.x as f64 / f) as i32, (p.y as f64 / f) as i32, (s.width as f64 / f) as i32, (s.height as f64 / f) as i32];
                if let Some(w) = reg().wins.get_mut(&label) {
                    w.bounds = Some(b);
                }
                persist_later(app);
            }
        }
        WindowEvent::Destroyed => {
            // its AI chat window goes with it
            chat::close_children(app, &label);
            reg().wins.remove(&label);
            crate::watch::drop_for(&label);
            if let Some(m) = CLOSE_PENDING.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                m.remove(&label);
            }
            if let Some(s) = UI_READY.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                s.remove(&label);
            }
            persist_later(app);
            // the last window closed: quit (closing "main" while others are open keeps the app running)
            let left = app.webview_windows().keys().filter(|l| is_app_window(l) && **l != label).count();
            if left == 0 {
                persist_now(app);
                app.exit(0);
            }
        }
        _ => {}
    }
}

pub fn close_ack(label: &str) {
    if let Some(m) = CLOSE_PENDING.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        m.remove(label);
    }
}

/// Remember whether a window's memory is lowered; true when this changed it.
pub(crate) fn mark_low_memory(label: &str, low: bool) -> bool {
    let mut r = reg();
    match r.wins.get_mut(label) {
        Some(w) if w.low_memory != low => {
            w.low_memory = low;
            true
        }
        _ => false,
    }
}
