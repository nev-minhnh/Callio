//! Word-processing documents through WordCraft: .docx/.docm/.dotx (OOXML), .doc (Word 97-2003),
//! .odt, .rtf, .html, .md, .tex and .txt in; PDF (real text, links, bookmarks), .docx, .odt,
//! .rtf, .html, .md, .tex and .txt out.

use std::path::Path;

use wordcraft_doc::Document;

pub const READS: &[&str] = &["docx", "docm", "dotx", "dotm", "doc", "dot", "odt", "ott", "fodt", "rtf", "html", "htm", "xhtml", "mht", "mhtml", "md", "markdown", "tex", "latex", "ltx", "txt", "text"];

fn ext_of(path: &str) -> String {
    Path::new(path).extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

/// What the bytes really are (a ".doc" saved as RTF or HTML by another program, a ".docx"
/// that is really a .doc…), falling back to the extension.
fn sniff(bytes: &[u8], ext: &str) -> String {
    if bytes.starts_with(b"PK\x03\x04") {
        if ext == "odt" || ext == "ott" {
            return ext.into();
        }
        // an OpenDocument package names its type in the first entry
        if bytes.windows(39).take(200).any(|w| w == b"application/vnd.oasis.opendocument.text") {
            return "odt".into();
        }
        return "docx".into();
    }
    if bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0]) {
        // OLE: a Word 97-2003 file, or an encrypted .docx
        return if matches!(ext, "docx" | "docm" | "dotx" | "dotm") { "docx".into() } else { "doc".into() };
    }
    if bytes.starts_with(b"{\\rtf") {
        return "rtf".into();
    }
    ext.into()
}

pub fn open(path: &str, password: Option<&str>) -> Result<Document, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Couldn't read {path}: {e}"))?;
    let ext = ext_of(path);
    let kind = sniff(&bytes, &ext);
    let dir = Path::new(path).parent().map(Path::to_path_buf);
    from_bytes(&bytes, &kind, dir.as_deref(), password)
}

/// `kind`: an extension naming the format. `dir`: where relative pictures are looked up.
pub fn from_bytes(bytes: &[u8], kind: &str, dir: Option<&Path>, password: Option<&str>) -> Result<Document, String> {
    let need_pw = |e: String| if e.to_lowercase().contains("password") || e.to_lowercase().contains("encrypt") { format!("PASSWORD: {e}") } else { e };
    match kind {
        "docx" | "docm" | "dotx" | "dotm" => wordcraft_docx::read_with_password(bytes, password).map_err(|e| need_pw(e.to_string())),
        "doc" | "dot" => wordcraft_docbin::read_with_password(bytes, password).map_err(|e| need_pw(e.to_string())),
        "md" | "markdown" => {
            let text = String::from_utf8_lossy(bytes);
            let text = inline_md_images(&text, dir);
            wordcraft_formats::import("md", text.as_bytes()).unwrap_or_else(|| Err("Markdown isn't supported".into()))
        }
        "html" | "htm" | "xhtml" => {
            let text = String::from_utf8_lossy(bytes).to_string();
            let text = inline_html_images(&text, dir);
            wordcraft_formats::import("html", text.as_bytes()).unwrap_or_else(|| Err("HTML isn't supported".into()))
        }
        k => wordcraft_formats::import(k, bytes).unwrap_or_else(|| Err(format!("Can't open .{k} files as documents"))),
    }
}

fn mime_for(p: &Path) -> Option<&'static str> {
    match p.extension()?.to_string_lossy().to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => None,
        _ => None,
    }
}

/// A local picture as a data: URI (WordCraft's Markdown and HTML readers embed only those).
fn data_uri(src: &str, dir: Option<&Path>) -> Option<String> {
    if src.starts_with("data:") || src.contains("://") {
        return None;
    }
    let src = src.split(['?', '#']).next().unwrap_or(src);
    let decoded = percent_decode(src);
    let p = Path::new(&decoded);
    let full = if p.is_absolute() { p.to_path_buf() } else { dir?.join(p) };
    let mime = mime_for(&full)?;
    let meta = std::fs::metadata(&full).ok()?;
    if meta.len() > 40 << 20 {
        return None;
    }
    let bytes = std::fs::read(&full).ok()?;
    use base64::Engine;
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
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

/// `![alt](picture.png)` → the picture embedded, so it shows in the PDF / Word file.
fn inline_md_images(md: &str, dir: Option<&Path>) -> String {
    let mut out = String::with_capacity(md.len());
    let mut rest = md;
    while let Some(i) = rest.find("![") {
        out.push_str(&rest[..i]);
        let after = &rest[i..];
        // ![alt](src "title")
        if let Some(close) = after.find("](")
            && let Some(end) = after[close + 2..].find(')')
        {
            let inner = &after[close + 2..close + 2 + end];
            let src = inner.split_whitespace().next().unwrap_or("").trim_matches(['<', '>']);
            if let Some(uri) = data_uri(src, dir) {
                out.push_str(&after[..close + 2]);
                out.push_str(&uri);
                out.push(')');
                rest = &after[close + 2 + end + 1..];
                continue;
            }
            out.push_str(&after[..close + 2 + end + 1]);
            rest = &after[close + 2 + end + 1..];
            continue;
        }
        out.push_str("![");
        rest = &after[2..];
    }
    out.push_str(rest);
    out
}

fn inline_html_images(html: &str, dir: Option<&Path>) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    let lower = |s: &str| s.to_ascii_lowercase();
    while let Some(i) = lower(rest).find("src=\"") {
        let (head, tail) = rest.split_at(i + 5);
        out.push_str(head);
        if let Some(end) = tail.find('"') {
            let src = &tail[..end];
            match data_uri(src, dir) {
                Some(u) => out.push_str(&u),
                None => out.push_str(src),
            }
            rest = &tail[end..];
        } else {
            rest = tail;
        }
    }
    out.push_str(rest);
    out
}

pub fn to_pdf(doc: &Document) -> Result<Vec<u8>, String> {
    wordcraft_pdf::export(doc, &wordcraft_pdf::PdfOptions::default()).map_err(|e| e.to_string())
}

/// Save as `fmt` (an extension): docx, odt, rtf, html, md, tex, txt or pdf.
pub fn save(doc: &Document, fmt: &str) -> Result<Vec<u8>, String> {
    match fmt {
        "pdf" => to_pdf(doc),
        "docx" => wordcraft_docx::write(doc).map_err(|e| e.to_string()),
        "dotx" => wordcraft_docx::write_as(doc, wordcraft_docx::Flavor::Template).map_err(|e| e.to_string()),
        f => wordcraft_formats::export(f, doc).unwrap_or_else(|| Err(format!("Can't save documents as .{f}"))),
    }
}

/// Document statistics for the status bar.
pub fn info(doc: &Document) -> serde_json::Value {
    let flow = wordcraft_formats::model::from_doc(doc);
    let mut words = 0usize;
    let mut chars = 0usize;
    fn walk(b: &[wordcraft_formats::model::FBlock], words: &mut usize, chars: &mut usize) {
        for x in b {
            match x {
                wordcraft_formats::model::FBlock::Para(p) => {
                    for i in &p.inlines {
                        if let wordcraft_formats::model::Inline::Text(t, _) = i {
                            *words += t.split_whitespace().count();
                            *chars += t.chars().count();
                        }
                    }
                }
                wordcraft_formats::model::FBlock::Table(t) => {
                    for r in &t.rows {
                        for c in r {
                            walk(&c.blocks, words, chars);
                        }
                    }
                }
            }
        }
    }
    walk(&flow.blocks, &mut words, &mut chars);
    serde_json::json!({ "title": flow.meta.title, "author": flow.meta.author, "words": words, "chars": chars })
}
