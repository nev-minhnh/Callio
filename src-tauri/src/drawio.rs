//! draw.io diagram editor: the draw.io web app (github.com/jgraph/drawio, Apache-2.0) is shipped
//! as one zip (drawio.zip, built by scripts/build-drawio.mjs) next to Callio.exe and served to the
//! editor's frame from it as `http://drawio.localhost/…` (drawio://localhost/… off Windows).
//! Nothing is unpacked to disk and nothing is fetched from the internet.
use std::{
    borrow::Cow,
    fs::File,
    io::Read,
    path::PathBuf,
    sync::Mutex,
};
use tauri::{
    http::{header, Request, Response, StatusCode},
    Manager, Runtime, UriSchemeContext, UriSchemeResponder,
};
use zip::ZipArchive;

static ZIP: Mutex<Option<(PathBuf, ZipArchive<File>)>> = Mutex::new(None);

fn zip_path<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    let mut places = Vec::new();
    if let Ok(d) = app.path().resource_dir() {
        places.push(d.join("drawio.zip"));
    }
    if let Some(d) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
        places.push(d.join("drawio.zip"));
        places.push(d.join("resources").join("drawio.zip"));
    }
    places.into_iter().find(|p| p.is_file())
}

fn mime(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "txt" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn respond(status: StatusCode, ctype: &str, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, ctype)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "max-age=31536000")
        .body(Cow::Owned(body))
        .unwrap()
}

fn read<R: Runtime>(app: &tauri::AppHandle<R>, path: &str) -> Result<Vec<u8>, StatusCode> {
    let mut guard = ZIP.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        let p = zip_path(app).ok_or(StatusCode::NOT_FOUND)?;
        let f = File::open(&p).map_err(|_| StatusCode::NOT_FOUND)?;
        let z = ZipArchive::new(f).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        *guard = Some((p, z));
    }
    let (_, z) = guard.as_mut().unwrap();
    let mut entry = z.by_name(path).map_err(|_| StatusCode::NOT_FOUND)?;
    let mut buf = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut buf).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(buf)
}

/// The `drawio` URI scheme: files of the draw.io web app, from drawio.zip.
pub fn protocol<R: Runtime>(ctx: UriSchemeContext<'_, R>, req: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    let raw = req.uri().path().to_string();
    std::thread::spawn(move || {
        let decoded = percent_decode(raw.trim_start_matches('/'));
        let path = if decoded.is_empty() || decoded.ends_with('/') { format!("{decoded}index.html") } else { decoded };
        if path.split('/').any(|s| s == "..") {
            return responder.respond(respond(StatusCode::FORBIDDEN, "text/plain", Vec::new()));
        }
        match read(&app, &path) {
            Ok(body) => responder.respond(respond(StatusCode::OK, mime(&path), body)),
            Err(code) => responder.respond(respond(code, "text/plain", format!("{path}: not found").into_bytes())),
        }
    });
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Whether the draw.io editor is installed next to Callio.
#[tauri::command]
pub fn drawio_available(app: tauri::AppHandle) -> bool {
    zip_path(&app).is_some()
}
