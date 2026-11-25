//! Lower WebView2's memory for a window nobody is looking at (minimised for a while), and back
//! to normal when it is shown again: `ICoreWebView2_19::put_MemoryUsageTargetLevel`.
//! Only does something on Windows with a WebView2 runtime new enough to have the call; elsewhere,
//! and on any error, it silently does nothing.
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// windows with a "lower it soon" timer already running (minimising fires several events)
static WAITING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// How long a window stays minimised before its memory is lowered.
const AFTER: Duration = Duration::from_secs(30);

fn set_level(app: &AppHandle, label: &str, low: bool) {
    let Some(w) = app.get_webview_window(label) else { return };
    #[cfg(windows)]
    {
        let _ = w.with_webview(move |wv| {
            use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL};
            use windows_core::Interface;
            unsafe {
                let Ok(core) = wv.controller().CoreWebView2() else { return };
                let Ok(c19) = core.cast::<ICoreWebView2_19>() else { return };
                let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
                let _ = c19.SetMemoryUsageTargetLevel(level);
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (w, low);
}

fn mark(label: &str, low: bool) -> bool {
    super::mark_low_memory(label, low)
}

/// Back to normal (a no-op unless it was lowered).
pub fn restore(app: &AppHandle, label: &str) {
    if mark(label, false) {
        set_level(app, label, false);
    }
}

/// After a while minimised (and still minimised): lower it.
pub fn lower_later(app: &AppHandle, label: &str) {
    if !WAITING.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashSet::new).insert(label.to_string()) {
        return;
    }
    let (app, label) = (app.clone(), label.to_string());
    std::thread::spawn(move || {
        std::thread::sleep(AFTER);
        if let Some(s) = WAITING.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            s.remove(&label);
        }
        let Some(w) = app.get_webview_window(&label) else { return };
        if w.is_minimized().unwrap_or(false) && mark(&label, true) {
            set_level(&app, &label, true);
        }
    });
}
