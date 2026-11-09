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

/// A dictionary entry for an English word (Free Dictionary, dictionaryapi.dev), as plain text.
#[tauri::command]
pub async fn define_english(word: String) -> CmdResult<String> {
    let w = word.trim().to_lowercase();
    if w.is_empty() || !w.chars().all(|c| c.is_ascii_alphabetic() || c == '-' || c == '\'') {
        return Err("not an English word".into());
    }
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(12)).build().map_err(|e| e.to_string())?;
    let r = client.get(format!("https://api.dictionaryapi.dev/api/v2/entries/en/{}", urlencoding::encode(&w))).send().await.map_err(|e| format!("The dictionary can't be reached: {e}"))?;
    if !r.status().is_success() {
        return Err("No dictionary entry".into());
    }
    let v: Value = r.json().await.map_err(|e| e.to_string())?;
    let mut out = String::new();
    for e in v.as_array().into_iter().flatten().take(2) {
        if out.is_empty() {
            out.push_str(e["word"].as_str().unwrap_or(&w));
            if let Some(p) = e["phonetic"].as_str().or_else(|| e["phonetics"].as_array().and_then(|a| a.iter().find_map(|p| p["text"].as_str()))) {
                out.push_str(&format!("  {p}"));
            }
            out.push('\n');
        }
        for m in e["meanings"].as_array().into_iter().flatten().take(4) {
            out.push_str(&format!("\n{}\n", m["partOfSpeech"].as_str().unwrap_or("")));
            for (i, d) in m["definitions"].as_array().into_iter().flatten().take(3).enumerate() {
                out.push_str(&format!("{}. {}\n", i + 1, d["definition"].as_str().unwrap_or("")));
                if let Some(x) = d["example"].as_str() {
                    out.push_str(&format!("   “{x}”\n"));
                }
            }
            let syn: Vec<&str> = m["synonyms"].as_array().into_iter().flatten().filter_map(|s| s.as_str()).take(6).collect();
            if !syn.is_empty() {
                out.push_str(&format!("   Synonyms: {}\n", syn.join(", ")));
            }
        }
    }
    if out.trim().is_empty() {
        return Err("No dictionary entry".into());
    }
    Ok(out.trim_end().to_string())
}
