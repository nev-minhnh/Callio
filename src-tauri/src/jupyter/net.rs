//! Talking to a Jupyter Server: REST (reqwest) and the kernel channels WebSocket
//! (tokio-tungstenite). Every kind of connection ends up here as an `Endpoint` (base URL +
//! token): a local server Callio started, a URL the author typed, and later an SSH tunnel.
//! The token goes only in the `Authorization: token …` header — never in a URL, log or argument.
//! Self-signed HTTPS is refused unless the author pinned the certificate's SHA-256 fingerprint.
use crate::util::{sha256_hex, CmdResult, ErrStr};
use reqwest::{Client, Url};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::WebPkiSupportedAlgorithms;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Endpoint {
    pub base: Url,
    pub token: String,
    /// SHA-256 fingerprint (hex) of the one certificate this server may present.
    pub pin: Option<String>,
    /// Which saved connection this is (clients and cookies are kept per id).
    pub id: String,
}

/// Accepts exactly the pinned certificate; with no pin it accepts anything but remembers what it
/// saw (used once, to show the author the fingerprint before they decide to trust it).
#[derive(Debug)]
struct PinVerifier {
    pin: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
    algs: WebPkiSupportedAlgorithms,
}
impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(&self, end: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        let fp = sha256_hex(end.as_ref());
        *self.seen.lock().unwrap() = Some(fp.clone());
        match &self.pin {
            Some(p) if p.eq_ignore_ascii_case(&fp) => Ok(ServerCertVerified::assertion()),
            Some(_) => Err(rustls::Error::General("certificate does not match the pinned fingerprint".into())),
            None => Ok(ServerCertVerified::assertion()),
        }
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &self.algs)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &self.algs)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algs.supported_schemes()
    }
}

fn pin_config(pin: Option<String>, seen: Arc<Mutex<Option<String>>>) -> CmdResult<ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let algs = provider.signature_verification_algorithms;
    let cfg = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .es()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinVerifier { pin, seen, algs }))
        .with_no_client_auth();
    Ok(cfg)
}

static CLIENTS: Mutex<Option<HashMap<String, Client>>> = Mutex::new(None);
static XSRF: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn client_for(ep: &Endpoint) -> CmdResult<Client> {
    let key = format!("{}|{}|{}", ep.id, ep.base, ep.pin.clone().unwrap_or_default());
    if let Some(c) = CLIENTS.lock().unwrap().as_ref().and_then(|m| m.get(&key)) {
        return Ok(c.clone());
    }
    let mut b = Client::builder().cookie_store(true).connect_timeout(Duration::from_secs(10)).user_agent("Callio");
    if ep.pin.is_some() {
        b = b.use_preconfigured_tls(pin_config(ep.pin.clone(), Arc::new(Mutex::new(None)))?);
    }
    if is_loopback(&ep.base) {
        b = b.no_proxy(); // never send local traffic through a proxy
    }
    let c = b.build().es()?;
    CLIENTS.lock().unwrap().get_or_insert_with(HashMap::new).insert(key, c.clone());
    Ok(c)
}

pub fn is_loopback(u: &Url) -> bool {
    matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "::1" | "[::1]"))
}

pub fn join(base: &Url, path: &str) -> String {
    format!("{}/{}", base.as_str().trim_end_matches('/'), path.trim_start_matches('/'))
}

fn hdr_err(e: reqwest::Error) -> String {
    // the useful part of a connection error is deep in its source chain
    let mut s = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(x) = src {
        s = format!("{s}: {x}");
        src = x.source();
    }
    s
}

/// One REST call. `path` starts with `/api/`. Returns the JSON answer (Null for an empty body).
pub async fn rest(ep: &Endpoint, method: &str, path: &str, body: Option<&Value>, timeout_s: u64) -> CmdResult<Value> {
    if !path.starts_with("/api/") {
        return Err("Only /api/ paths can be called".into());
    }
    let client = client_for(ep)?;
    let m = reqwest::Method::from_bytes(method.as_bytes()).es()?;
    for attempt in 0..2 {
        let mut rb = client.request(m.clone(), join(&ep.base, path)).header("Authorization", format!("token {}", ep.token)).timeout(Duration::from_secs(timeout_s.max(1)));
        if let Some(x) = XSRF.lock().unwrap().as_ref().and_then(|m| m.get(&ep.id)) {
            rb = rb.header("X-XSRFToken", x.clone());
        }
        if let Some(b) = body {
            rb = rb.json(b);
        }
        let resp = rb.send().await.map_err(hdr_err)?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if status.as_u16() == 403 && attempt == 0 && text.to_lowercase().contains("xsrf") {
            // a server that insists on the _xsrf cookie: fetch one and retry once
            let r = client.get(join(&ep.base, "/api/status")).header("Authorization", format!("token {}", ep.token)).send().await.map_err(hdr_err)?;
            let x = r.headers().get_all("set-cookie").iter().filter_map(|v| v.to_str().ok()).find_map(|c| c.strip_prefix("_xsrf=").map(|v| v.split(';').next().unwrap_or("").to_string()));
            if let Some(x) = x {
                XSRF.lock().unwrap().get_or_insert_with(HashMap::new).insert(ep.id.clone(), x);
                continue;
            }
        }
        if !status.is_success() {
            let msg = serde_json::from_str::<Value>(&text).ok().and_then(|j| j["message"].as_str().map(String::from)).unwrap_or_else(|| text.chars().take(200).collect());
            return Err(format!("HTTP {}: {}", status.as_u16(), msg.trim()));
        }
        return Ok(if text.trim().is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::String(text)) });
    }
    Err("The server refused the request (XSRF)".into())
}

/// Handshake with an untrusted server just to read its certificate fingerprint.
pub async fn probe_fingerprint(base: &Url) -> CmdResult<String> {
    let seen = Arc::new(Mutex::new(None));
    let c = Client::builder().use_preconfigured_tls(pin_config(None, seen.clone())?).connect_timeout(Duration::from_secs(10)).build().es()?;
    let _ = c.get(join(base, "/api/status")).timeout(Duration::from_secs(15)).send().await;
    let fp = seen.lock().unwrap().clone();
    fp.ok_or_else(|| "Could not read the server's certificate".to_string())
}

// ---------------- kernel channels (WebSocket) ----------------
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

/// Open `/api/kernels/<id>/channels`. Returns a sender for outgoing messages and a receiver for
/// incoming ones (parsed JSON; binary frames are ignored). The receiver ends when the socket closes.
pub async fn ws_open(ep: &Endpoint, kernel: &str, session: &str) -> CmdResult<(mpsc::UnboundedSender<String>, mpsc::UnboundedReceiver<Value>, tauri::async_runtime::JoinHandle<()>)> {
    let mut u = Url::parse(&join(&ep.base, &format!("/api/kernels/{}/channels", urlencoding::encode(kernel)))).es()?;
    u.set_scheme(if u.scheme() == "https" { "wss" } else { "ws" }).map_err(|_| "Bad server URL".to_string())?;
    u.query_pairs_mut().append_pair("session_id", session);
    let mut req = u.as_str().into_client_request().es()?;
    req.headers_mut().insert("Authorization", format!("token {}", ep.token).parse().es()?);
    let connector = if ep.pin.is_some() { Some(tokio_tungstenite::Connector::Rustls(Arc::new(pin_config(ep.pin.clone(), Arc::new(Mutex::new(None)))?))) } else { None };
    let (ws, _) = tokio::time::timeout(Duration::from_secs(15), tokio_tungstenite::connect_async_tls_with_config(req, None, false, connector))
        .await
        .map_err(|_| "Timed out connecting to the kernel".to_string())?
        .map_err(|e| format!("Could not connect to the kernel: {e}"))?;
    let (mut sink, mut stream) = ws.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let (in_tx, in_rx) = mpsc::unbounded_channel::<Value>();
    let h = tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                o = out_rx.recv() => match o {
                    Some(t) => { if sink.send(Message::text(t)).await.is_err() { break; } }
                    None => { let _ = sink.close().await; break; }
                },
                i = stream.next() => match i {
                    Some(Ok(Message::Text(t))) => { if let Ok(v) = serde_json::from_str::<Value>(t.as_str()) { if in_tx.send(v).is_err() { break; } } }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {}
                },
            }
        }
    });
    Ok((out_tx, in_rx, h))
}
