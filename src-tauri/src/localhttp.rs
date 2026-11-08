//! A tiny HTTP/1.1 reader for Callio's local servers (Claude Code's MCP server, the paper
//! library's browser-extension endpoint): bounded lines, headers and bodies.
use std::collections::HashMap;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

pub struct Req {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

/// One line of at most 16 KB.
async fn line(r: &mut BufReader<tokio::net::tcp::OwnedReadHalf>, out: &mut String) -> anyhow::Result<usize> {
    let mut buf = Vec::new();
    let n = (&mut *r).take(16 << 10).read_until(b'\n', &mut buf).await?;
    if n > 0 && !buf.ends_with(b"\n") {
        anyhow::bail!("line too long");
    }
    *out = String::from_utf8_lossy(&buf).to_string();
    Ok(n)
}

/// Read one request. `body_limit(headers)` says how large a body may be for this request
/// (0: don't read it — e.g. no token), so nothing is buffered for unauthorised callers.
pub async fn read_req(r: &mut BufReader<tokio::net::tcp::OwnedReadHalf>, body_limit: impl Fn(&HashMap<String, String>) -> usize) -> anyhow::Result<Option<Req>> {
    let mut line_s = String::new();
    if line(r, &mut line_s).await? == 0 {
        return Ok(None);
    }
    let line = line_s;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut headers = HashMap::new();
    loop {
        let mut h = String::new();
        if self::line(r, &mut h).await? == 0 {
            return Ok(None);
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
        if headers.len() > 100 {
            anyhow::bail!("too many headers");
        }
    }
    // no body is read (or memory reserved) for requests without the token
    let max_body = body_limit(&headers);
    if max_body == 0 {
        return Ok(Some(Req { method, path, headers, body: Vec::new() }));
    }
    let mut body = Vec::new();
    if headers.get("transfer-encoding").map(|v| v.eq_ignore_ascii_case("chunked")).unwrap_or(false) {
        loop {
            let mut sz = String::new();
            self::line(r, &mut sz).await?;
            let n = usize::from_str_radix(sz.trim().split(';').next().unwrap_or("0"), 16)?;
            if n == 0 {
                let mut end = String::new();
                self::line(r, &mut end).await?;
                break;
            }
            if body.len() + n > max_body {
                anyhow::bail!("body too large");
            }
            let mut chunk = vec![0u8; n];
            r.read_exact(&mut chunk).await?;
            body.extend_from_slice(&chunk);
            let mut crlf = [0u8; 2];
            r.read_exact(&mut crlf).await?;
        }
    } else {
        let n: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
        if n > max_body {
            anyhow::bail!("body too large");
        }
        (&mut *r).take(n as u64).read_to_end(&mut body).await?;
        if body.len() != n {
            anyhow::bail!("short body");
        }
    }
    Ok(Some(Req { method, path, headers, body }))
}

pub async fn respond(w: &mut tokio::net::tcp::OwnedWriteHalf, code: u16, ctype: &str, body: &[u8]) -> std::io::Result<()> {
    respond_with(w, code, ctype, body, "").await
}

/// Like `respond`, with extra header lines (each ending in \r\n).
pub async fn respond_with(w: &mut tokio::net::tcp::OwnedWriteHalf, code: u16, ctype: &str, body: &[u8], extra: &str) -> std::io::Result<()> {
    let reason = match code {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        _ => "Bad Request",
    };
    let head = format!("HTTP/1.1 {code} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n{extra}\r\n", body.len());
    w.write_all(head.as_bytes()).await?;
    w.write_all(body).await?;
    w.flush().await
}

