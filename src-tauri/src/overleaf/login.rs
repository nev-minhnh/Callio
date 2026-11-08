//! Overleaf sign-in without copying cookies by hand.
//!
//! The user signs in once in a small Overleaf window (password, institutional SSO, …). Its
//! WebView2 profile keeps Overleaf's own long-lived login, so later, when the session cookie
//! Callio uses has expired, a hidden window loads overleaf.com, Overleaf issues a fresh
//! session, and Callio stores it again — no user action. In between, every request Callio makes
//! refreshes the cookie (Overleaf sessions roll forward on use) and the newest value is saved.
use crate::settings::get_secret_value;
use crate::util::{CmdResult, ErrStr};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const COOKIE_KEY: &str = "overleaf-session";
const NAMES: &[&str] = &["overleaf_session2", "overleaf.sid", "sharelatex.sid"];

fn read_session(w: &WebviewWindow, base: &Url) -> Option<String> {
    let cookies = w.cookies_for_url(base.clone()).ok()?;
    cookies.iter().find(|c| NAMES.contains(&c.name())).map(|c| format!("{}={}", c.name(), c.value()))
}

pub fn save_session(value: &str) {
    if get_secret_value(COOKIE_KEY).as_deref() != Some(value) {
        crate::settings::put_secret_value(COOKIE_KEY, value);
    }
}

fn is_logged_in_page(u: &Url) -> bool {
    let p = u.path();
    p.starts_with("/project") || p.starts_with("/user/settings")
}

/// Open the Overleaf sign-in window. Emits "overleaf-auth" {ok, message} when done.
#[tauri::command]
pub async fn ol_sign_in(app: AppHandle, state: tauri::State<'_, crate::settings::SettingsState>) -> CmdResult<()> {
    let base = crate::settings::backend(&state).overleaf_url;
    let base_url = Url::parse(&base).es()?;
    if let Some(w) = app.get_webview_window("overleaf-login") {
        let _ = w.set_focus();
        return Ok(());
    }
    let url = Url::parse(&format!("{base}/login")).es()?;
    let app2 = app.clone();
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    WebviewWindowBuilder::new(&app, "overleaf-login", WebviewUrl::External(url))
        .title("Sign in to Overleaf — Callio")
        .inner_size(560.0, 780.0)
        .center()
        .on_page_load(move |w, p| {
            if p.event() != PageLoadEvent::Finished || !is_logged_in_page(p.url()) || done.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            let (app, base_url) = (app2.clone(), base_url.clone());
            // reading cookies must not happen on the event thread (WebView2 deadlock)
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                match read_session(&w, &base_url) {
                    Some(c) => {
                        save_session(&c);
                        let _ = app.emit("overleaf-auth", serde_json::json!({"ok": true, "message": "Signed in to Overleaf"}));
                    }
                    None => {
                        let _ = app.emit("overleaf-auth", serde_json::json!({"ok": false, "message": "Signed in, but Callio couldn't read the Overleaf session. Try again, or paste the cookie in Settings → Overleaf → Advanced."}));
                    }
                }
                let _ = w.destroy();
            });
        })
        .build()
        .es()?;
    Ok(())
}

static REFRESH: tokio::sync::Mutex<Option<(std::time::Instant, Option<String>)>> = tokio::sync::Mutex::const_new(None);
static REFRESH_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Try to get a fresh session from Overleaf's remembered login in a hidden window.
/// Concurrent callers share one attempt (and its result for a few seconds).
pub async fn silent_refresh(app: &AppHandle, base: &str) -> Option<String> {
    let mut guard = REFRESH.lock().await;
    if let Some((t, r)) = guard.as_ref() {
        if t.elapsed() < Duration::from_secs(20) {
            return r.clone();
        }
    }
    let r = refresh_once(app, base).await;
    *guard = Some((std::time::Instant::now(), r.clone()));
    r
}

async fn refresh_once(app: &AppHandle, base: &str) -> Option<String> {
    let base_url = Url::parse(base).ok()?;
    let url = Url::parse(&format!("{base}/project")).ok()?;
    let label = format!("overleaf-refresh-{}", REFRESH_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
    let (tx, rx) = mpsc::channel::<Option<String>>();
    let tx = Mutex::new(Some(tx));
    let w = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .visible(false)
        .skip_taskbar(true)
        .on_page_load(move |w, p| {
            if p.event() != PageLoadEvent::Finished {
                return;
            }
            let logged_in = is_logged_in_page(p.url());
            let login_page = p.url().path().starts_with("/login");
            if !logged_in && !login_page {
                return; // intermediate redirect
            }
            if let Some(tx) = tx.lock().unwrap().take() {
                let base_url = base_url.clone();
                std::thread::spawn(move || {
                    let r = if logged_in { read_session(&w, &base_url) } else { None };
                    let _ = tx.send(r);
                });
            }
        })
        .build()
        .ok()?;
    let r = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(30)).ok().flatten()).await.ok().flatten();
    let _ = w.destroy();
    if let Some(c) = &r {
        save_session(c);
    }
    r
}

/// Sign out: forget the stored session and Overleaf's cookies in Callio's browser profile.
#[tauri::command]
pub async fn ol_sign_out(app: AppHandle, state: tauri::State<'_, crate::settings::SettingsState>) -> CmdResult<()> {
    if let Ok(e) = keyring::Entry::new("Callio", COOKIE_KEY) {
        let _ = e.delete_credential();
    }
    let base = crate::settings::backend(&state).overleaf_url;
    if let (Some(w), Ok(u)) = (app.get_webview_window("main"), Url::parse(&base)) {
        let w2 = w.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Ok(cs) = w2.cookies_for_url(u) {
                for c in cs {
                    let _ = w2.delete_cookie(c);
                }
            }
        })
        .await;
    }
    Ok(())
}
