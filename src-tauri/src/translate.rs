//! Google Translate (the free web endpoint Google's own pages use) for "Translate" on a selection.
//! The text goes to Google only when the author picks Google as the translator.
use crate::util::CmdResult;
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Translated {
    text: String,
    /// the language Google detected
    from: String,
}

#[tauri::command]
pub async fn translate_google(text: String, to: String, from: Option<String>) -> CmdResult<Translated> {
    if text.trim().is_empty() {
        return Ok(Translated { text: String::new(), from: String::new() });
    }
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    let mut out = String::new();
    let mut detected = String::new();
    // the endpoint takes ~5000 characters per request: send paragraphs in chunks
    let mut chunks: Vec<String> = vec![];
    let mut cur = String::new();
    for para in text.split_inclusive('\n') {
        if cur.len() + para.len() > 4500 && !cur.is_empty() {
            chunks.push(std::mem::take(&mut cur));
        }
        cur.push_str(para);
    }
    if !cur.is_empty() {
        chunks.push(cur);
    }
    for c in chunks {
        let r = client
            .get("https://translate.googleapis.com/translate_a/single")
            .query(&[("client", "gtx"), ("sl", from.as_deref().unwrap_or("auto")), ("tl", to.as_str()), ("dt", "t"), ("q", c.as_str())])
            .send()
            .await
            .map_err(|e| format!("Google Translate can't be reached: {e}"))?;
        if !r.status().is_success() {
            return Err(format!("Google Translate answered {}", r.status()));
        }
        let v: Value = r.json().await.map_err(|e| e.to_string())?;
        for seg in v[0].as_array().into_iter().flatten() {
            if let Some(t) = seg[0].as_str() {
                out.push_str(t);
            }
        }
        if detected.is_empty() {
            detected = v[2].as_str().unwrap_or_default().to_string();
        }
    }
    Ok(Translated { text: out, from: detected })
}
