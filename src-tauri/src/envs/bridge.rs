//! Letting Claude Code inside WSL reach Callio's MCP server, which listens on Windows 127.0.0.1.
//!
//! WSL2 forwards `localhost` from Windows into the distro, but NOT from the distro to Windows
//! (in the default NAT mode). Two ways work:
//!   * mirrored networking (`networkingMode=mirrored` in `%UserProfile%\.wslconfig`): the distro's
//!     127.0.0.1 is the Windows 127.0.0.1 — nothing to do;
//!   * NAT (default): the distro sees Windows as its default gateway (the "vEthernet (WSL)"
//!     address). Callio opens one small forwarder on exactly that address that passes every
//!     connection on to its own MCP server. The MCP server still demands its secret token, so a
//!     stranger on that virtual network gets "unauthorized". The forwarder lives as long as Callio.
use super::exec::{self, Env};
use super::parse;
use std::collections::HashMap;
use std::sync::Mutex;

/// `%UserProfile%\.wslconfig` → "nat" | "mirrored" | …
pub fn networking_mode() -> String {
    let Some(h) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) else { return "nat".into() };
    std::fs::read_to_string(std::path::Path::new(&h).join(".wslconfig")).map(|t| parse::wslconfig_networking_mode(&t)).unwrap_or_else(|_| "nat".into())
}

/// The address the distro uses to reach Windows: 127.0.0.1 with mirrored networking, otherwise
/// the default gateway as the distro sees it.
pub fn host_address(env: &Env) -> Result<String, String> {
    if networking_mode() == "mirrored" {
        return Ok("127.0.0.1".into());
    }
    let text = exec::out(env, "ip", &["route", "show", "default"], None, 15).ok_or("Couldn't ask the distribution for its network address.")?;
    parse::parse_default_gateway(&text).ok_or_else(|| "The distribution has no network route to Windows. Start it once (wsl) or turn on mirrored networking in .wslconfig.".to_string())
}

static BRIDGES: Mutex<Option<HashMap<(String, u16), u16>>> = Mutex::new(None);

/// A forwarder on `host_ip:<free port>` → `127.0.0.1:target`. Returns its port; reuses an existing one.
pub fn ensure_bridge(host_ip: &str, target: u16) -> Result<u16, String> {
    let key = (host_ip.to_string(), target);
    if let Some(p) = BRIDGES.lock().unwrap().as_ref().and_then(|m| m.get(&key)) {
        return Ok(*p);
    }
    let ip: std::net::IpAddr = host_ip.parse().map_err(|_| "Not a valid network address.".to_string())?;
    let listener = std::net::TcpListener::bind((ip, 0)).map_err(|e| format!("Callio couldn't open the connection for WSL on {host_ip}: {e}. Turn on mirrored networking (.wslconfig) or allow Callio in the Windows firewall."))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    tauri::async_runtime::spawn(async move {
        let Ok(l) = tokio::net::TcpListener::from_std(listener) else { return };
        loop {
            let Ok((mut inbound, _)) = l.accept().await else { continue };
            tauri::async_runtime::spawn(async move {
                if let Ok(mut out) = tokio::net::TcpStream::connect(("127.0.0.1", target)).await {
                    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut out).await;
                }
            });
        }
    });
    BRIDGES.lock().unwrap().get_or_insert_with(HashMap::new).insert(key, port);
    Ok(port)
}

/// `http://127.0.0.1:PORT/mcp/…` → the same address as the distro must use. Mirrored: unchanged.
pub fn url_for(env: &Env, local_url: &str) -> Result<String, String> {
    let rest = local_url.strip_prefix("http://127.0.0.1:").ok_or("Unexpected MCP address.")?;
    let (port_s, tail) = rest.split_once('/').map(|(a, b)| (a, format!("/{b}"))).unwrap_or((rest, String::new()));
    let port: u16 = port_s.parse().map_err(|_| "Unexpected MCP address.".to_string())?;
    let host = host_address(env)?;
    if host == "127.0.0.1" {
        return Ok(local_url.to_string());
    }
    let p = ensure_bridge(&host, port)?;
    Ok(format!("http://{host}:{p}{tail}"))
}
