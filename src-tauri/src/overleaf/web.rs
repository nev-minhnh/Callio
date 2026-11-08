//! Overleaf web client (unofficial). Uses the user's session cookie, like the browser does.
use crate::util::html_unescape;
use anyhow::{anyhow, bail, Context, Result};
use reqwest::{cookie::Jar, Client, Url};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

pub struct Web {
    pub base: String,
    client: Client,
    jar: Arc<Jar>,
    csrf: String,
    pub user_email: String,
    project_page: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub last_updated: Option<String>,
    pub owner: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Entity {
    pub id: String,
    pub kind: &'static str, // "doc" | "file" | "folder"
}

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Callio/0.1";

fn meta(html: &str, name: &str) -> Option<String> {
    let needle = format!("name=\"{name}\"");
    let idx = html.find(&needle)?;
    let start = html[..idx].rfind('<')?;
    let end = idx + html[idx..].find('>')?;
    let tag = &html[start..end];
    let c = tag.find("content=\"")? + 9;
    let v = &tag[c..];
    let q = v.find('"')?;
    Some(html_unescape(&v[..q]))
}

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

impl Web {
    pub async fn connect(base: &str, cookie: &str) -> Result<Web> {
        let base = base.trim_end_matches('/').to_string();
        let url = Url::parse(&base).context("Invalid Overleaf server URL")?;
        let jar = Arc::new(Jar::default());
        let cookie = cookie.trim().trim_start_matches("Cookie:").trim();
        if cookie.contains('=') {
            for part in cookie.split(';') {
                let p = part.trim();
                if !p.is_empty() {
                    jar.add_cookie_str(&format!("{p}; Path=/"), &url);
                }
            }
        } else {
            let name = if url.host_str().map(|h| h.ends_with("overleaf.com")).unwrap_or(false) { "overleaf_session2" } else { "overleaf.sid" };
            jar.add_cookie_str(&format!("{name}={cookie}; Path=/"), &url);
        }
        let client = Client::builder()
            .user_agent(UA)
            .cookie_provider(jar.clone())
            .timeout(Duration::from_secs(180))
            .connect_timeout(Duration::from_secs(20))
            .build()?;
        let resp = client.get(format!("{base}/project")).header("Accept", "text/html").send().await.context("Couldn't reach Overleaf")?;
        let final_url = resp.url().clone();
        let status = resp.status();
        let html = resp.text().await?;
        if final_url.path().starts_with("/login") || status.as_u16() == 401 || status.as_u16() == 403 {
            bail!("SESSION_EXPIRED");
        }
        if !status.is_success() {
            bail!("Overleaf returned HTTP {status} for the project list");
        }
        let csrf = meta(&html, "ol-csrfToken").ok_or_else(|| anyhow!("Couldn't read the CSRF token from Overleaf (page layout changed or Cloudflare challenge)."))?;
        let user_email = meta(&html, "ol-usersEmail").or_else(|| meta(&html, "ol-userEmail")).unwrap_or_default();
        Ok(Web { base, client, jar, csrf, user_email, project_page: html })
    }

    /// The session cookie as it stands now (Overleaf rolls it forward on every request).
    pub fn session_cookie(&self) -> Option<String> {
        use reqwest::cookie::CookieStore;
        let url = Url::parse(&self.base).ok()?;
        let h = self.jar.cookies(&url)?;
        let h = h.to_str().ok()?;
        h.split(';').map(|p| p.trim()).find(|p| ["overleaf_session2=", "overleaf.sid=", "sharelatex.sid="].iter().any(|n| p.starts_with(n))).map(|s| s.to_string())
    }

    pub async fn projects(&self) -> Result<Vec<ProjectSummary>> {
        let mut list: Vec<Value> = Vec::new();
        if let Some(blob) = meta(&self.project_page, "ol-prefetchedProjectsBlob") {
            if let Ok(v) = serde_json::from_str::<Value>(&blob) {
                if let Some(a) = v["projects"].as_array() {
                    list = a.clone();
                }
                // more pages than prefetched?
                let total = v["totalSize"].as_u64().unwrap_or(0) as usize;
                if total > list.len() {
                    list.clear();
                }
            }
        }
        if list.is_empty() {
            let r = self
                .client
                .post(format!("{}/api/project", self.base))
                .header("X-Csrf-Token", &self.csrf)
                .json(&json!({"filters": {}, "page": {"size": 2000}, "sort": {"by": "lastUpdated", "order": "desc"}}))
                .send()
                .await?;
            if r.status().is_success() {
                let v: Value = r.json().await?;
                list = v["projects"].as_array().cloned().unwrap_or_default();
            } else {
                let v: Value = self.client.get(format!("{}/user/projects", self.base)).send().await?.error_for_status()?.json().await?;
                list = v["projects"].as_array().cloned().unwrap_or_default();
            }
        }
        Ok(list
            .into_iter()
            .filter(|p| !p["trashed"].as_bool().unwrap_or(false))
            .filter_map(|p| {
                let id = p["id"].as_str().or(p["_id"].as_str())?.to_string();
                let owner = p["owner"].as_object().map(|o| {
                    let n = format!("{} {}", o.get("firstName").and_then(|x| x.as_str()).unwrap_or(""), o.get("lastName").and_then(|x| x.as_str()).unwrap_or(""));
                    let n = n.trim().to_string();
                    if n.is_empty() { o.get("email").and_then(|x| x.as_str()).unwrap_or("").to_string() } else { n }
                });
                Some(ProjectSummary {
                    id,
                    name: p["name"].as_str().unwrap_or("Untitled").to_string(),
                    last_updated: p["lastUpdated"].as_str().map(|s| s.to_string()),
                    owner,
                })
            })
            .collect())
    }

    pub async fn download_zip(&self, id: &str) -> Result<Vec<u8>> {
        let r = self.client.get(format!("{}/project/{id}/download/zip", self.base)).send().await?;
        if !r.status().is_success() {
            bail!("Couldn't download project {id} (HTTP {})", r.status());
        }
        let b = r.bytes().await?;
        if !b.starts_with(b"PK") {
            bail!("Overleaf didn't return a zip for project {id} (no access, or session expired)");
        }
        Ok(b.to_vec())
    }

    /// Join the project over the realtime (socket.io 0.9, xhr-polling) channel to read the
    /// file tree with entity ids, which uploads/deletes need.
    pub async fn tree(&self, id: &str) -> Result<BTreeMap<String, Entity>> {
        let referer = format!("{}/project/{id}", self.base);
        let hs = self
            .client
            .get(format!("{}/socket.io/1/?projectId={id}&esh=1&ssp=1&t={}", self.base, now_ms()))
            .header("Referer", &referer)
            .header("Origin", &self.base)
            .send()
            .await?
            .error_for_status()
            .context("Overleaf realtime handshake failed")?
            .text()
            .await?;
        let sid = hs.split(':').next().filter(|s| !s.is_empty() && !s.contains('<')).ok_or_else(|| anyhow!("Unexpected realtime handshake: {hs:.80}"))?.to_string();
        let poll = format!("{}/socket.io/1/xhr-polling/{sid}?projectId={id}", self.base);
        let send = |msg: String| {
            let c = self.client.clone();
            let url = format!("{poll}&t={}", now_ms());
            let referer = referer.clone();
            async move {
                let _ = c.post(url).header("Referer", referer).header("Content-Type", "text/plain;charset=UTF-8").body(msg).send().await;
            }
        };
        let mut project: Option<Value> = None;
        let mut sent_join = false;
        'outer: for attempt in 0..8 {
            let body = self.client.get(format!("{poll}&t={}", now_ms())).header("Referer", &referer).timeout(Duration::from_secs(40)).send().await?.text().await?;
            let msgs: Vec<String> = if body.starts_with('\u{fffd}') {
                body.split('\u{fffd}').skip(1).collect::<Vec<_>>().chunks(2).filter_map(|c| c.get(1).map(|s| s.to_string())).collect()
            } else {
                vec![body]
            };
            for m in msgs {
                if m.starts_with("7:") || m.starts_with("0::") {
                    bail!("Overleaf closed the realtime connection: {m:.120}");
                }
                if m == "2::" {
                    send("2::".into()).await;
                }
                if let Some(j) = m.strip_prefix("5:::") {
                    let v: Value = serde_json::from_str(j).unwrap_or(Value::Null);
                    match v["name"].as_str() {
                        Some("joinProjectResponse") => {
                            project = Some(v["args"][0]["project"].clone());
                            break 'outer;
                        }
                        Some("connectionRejected") => bail!("Overleaf rejected the realtime connection: {}", v["args"][0]["message"].as_str().unwrap_or("")),
                        _ => {}
                    }
                }
                if let Some(rest) = m.strip_prefix("6:::") {
                    let json = rest.splitn(2, '+').nth(1).unwrap_or("[]");
                    let v: Value = serde_json::from_str(json).unwrap_or(Value::Null);
                    if !v[0].is_null() {
                        bail!("Overleaf refused to open the project: {}", v[0]);
                    }
                    project = Some(v[1].clone());
                    break 'outer;
                }
            }
            if attempt >= 1 && !sent_join {
                send(format!("5:1+::{}", json!({"name": "joinProject", "args": [{"project_id": id}]}))).await;
                sent_join = true;
            }
        }
        send("0::".into()).await;
        let project = project.ok_or_else(|| anyhow!("Timed out reading the project's file tree from Overleaf"))?;
        let root = &project["rootFolder"][0];
        if root.is_null() {
            bail!("Overleaf returned no file tree for this project");
        }
        let mut map = BTreeMap::new();
        map.insert(String::new(), Entity { id: root["_id"].as_str().unwrap_or("").into(), kind: "folder" });
        fn walk(f: &Value, prefix: &str, map: &mut BTreeMap<String, Entity>) {
            for d in f["docs"].as_array().into_iter().flatten() {
                map.insert(format!("{prefix}{}", d["name"].as_str().unwrap_or("")), Entity { id: d["_id"].as_str().unwrap_or("").into(), kind: "doc" });
            }
            for d in f["fileRefs"].as_array().into_iter().flatten() {
                map.insert(format!("{prefix}{}", d["name"].as_str().unwrap_or("")), Entity { id: d["_id"].as_str().unwrap_or("").into(), kind: "file" });
            }
            for d in f["folders"].as_array().into_iter().flatten() {
                let p = format!("{prefix}{}", d["name"].as_str().unwrap_or(""));
                map.insert(p.clone(), Entity { id: d["_id"].as_str().unwrap_or("").into(), kind: "folder" });
                walk(d, &format!("{p}/"), map);
            }
        }
        walk(root, "", &mut map);
        Ok(map)
    }

    pub async fn create_folder(&self, id: &str, parent: &str, name: &str) -> Result<String> {
        let r = self
            .client
            .post(format!("{}/project/{id}/folder", self.base))
            .header("X-Csrf-Token", &self.csrf)
            .json(&json!({"name": name, "parent_folder_id": parent}))
            .send()
            .await?;
        if !r.status().is_success() {
            bail!("Couldn't create folder {name} on Overleaf (HTTP {})", r.status());
        }
        let v: Value = r.json().await?;
        v["_id"].as_str().map(|s| s.to_string()).ok_or_else(|| anyhow!("Overleaf didn't return the new folder id"))
    }

    pub async fn upload(&self, id: &str, folder_id: &str, name: &str, bytes: Vec<u8>) -> Result<()> {
        use reqwest::multipart::{Form, Part};
        let form = Form::new()
            .text("relativePath", "null")
            .text("name", name.to_string())
            .text("type", "application/octet-stream")
            .part("qqfile", Part::bytes(bytes).file_name(name.to_string()).mime_str("application/octet-stream")?);
        let r = self
            .client
            .post(format!("{}/project/{id}/upload?folder_id={folder_id}", self.base))
            .header("X-Csrf-Token", &self.csrf)
            .multipart(form)
            .send()
            .await?;
        let status = r.status();
        let v: Value = r.json().await.unwrap_or(Value::Null);
        if !status.is_success() || v["success"].as_bool() == Some(false) {
            let why = v["error"].as_str().or(v["message"].as_str()).unwrap_or("");
            bail!("Upload of {name} failed (HTTP {status}) {why}");
        }
        Ok(())
    }

    pub async fn delete_entity(&self, id: &str, e: &Entity) -> Result<()> {
        let r = self
            .client
            .delete(format!("{}/project/{id}/{}/{}", self.base, e.kind, e.id))
            .header("X-Csrf-Token", &self.csrf)
            .send()
            .await?;
        if !r.status().is_success() {
            bail!("Couldn't delete a {} on Overleaf (HTTP {})", e.kind, r.status());
        }
        Ok(())
    }

    pub async fn compile(&self, id: &str) -> Result<Value> {
        let r = self
            .client
            .post(format!("{}/project/{id}/compile?auto_compile=false", self.base))
            .header("X-Csrf-Token", &self.csrf)
            .json(&json!({"rootDoc_id": null, "draft": false, "check": "silent", "incrementalCompilesEnabled": true, "stopOnFirstError": false}))
            .timeout(Duration::from_secs(300))
            .send()
            .await?;
        if !r.status().is_success() {
            bail!("Overleaf compile request failed (HTTP {})", r.status());
        }
        Ok(r.json().await?)
    }

    pub async fn get_output(&self, res: &Value, path: &str) -> Result<Option<Vec<u8>>> {
        let Some(f) = res["outputFiles"].as_array().and_then(|a| a.iter().find(|f| f["path"].as_str() == Some(path))) else { return Ok(None) };
        let url = f["url"].as_str().unwrap_or("");
        let mut q = Vec::new();
        if let Some(g) = res["compileGroup"].as_str() {
            q.push(format!("compileGroup={g}"));
        }
        if let Some(s) = res["clsiServerId"].as_str() {
            q.push(format!("clsiserverid={s}"));
        }
        let qs = if q.is_empty() { String::new() } else { format!("{}{}", if url.contains('?') { "&" } else { "?" }, q.join("&")) };
        let mut bases = Vec::new();
        if let Some(d) = res["pdfDownloadDomain"].as_str().filter(|d| !d.is_empty()) {
            bases.push(d.trim_end_matches('/').to_string());
        }
        bases.push(self.base.clone());
        let mut last_err = None;
        for b in bases {
            let full = if url.starts_with("http") { format!("{url}{qs}") } else { format!("{b}{url}{qs}") };
            match self.client.get(&full).send().await {
                Ok(r) if r.status().is_success() => return Ok(Some(r.bytes().await?.to_vec())),
                Ok(r) => last_err = Some(anyhow!("HTTP {} for {path}", r.status())),
                Err(e) => last_err = Some(e.into()),
            }
            if url.starts_with("http") {
                break;
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow!("Couldn't download {path}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_meta() {
        let h = r#"<meta name="ol-csrfToken" content="abc&amp;d"><meta name="ol-prefetchedProjectsBlob" data-type="json" content="{&quot;projects&quot;:[]}">"#;
        assert_eq!(meta(h, "ol-csrfToken").unwrap(), "abc&d");
        assert_eq!(meta(h, "ol-prefetchedProjectsBlob").unwrap(), r#"{"projects":[]}"#);
    }
}
