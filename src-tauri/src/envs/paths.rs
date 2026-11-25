//! Path mapping between Windows and the Linux side of WSL / Docker. Pure functions (std only,
//! no Callio types) so they can be unit-tested anywhere.
//!   \\wsl.localhost\Ubuntu\home\u\p  <->  (Ubuntu, /home/u/p)      (also \\wsl$\Ubuntu\…)
//!   C:\x\y                           <->  /mnt/c/x/y
//! The distro's own root is reached through the 9P share; `/mnt/<drive>` is the automount.

/// One Docker bind mount: `source` is a Windows (or WSL) path, `destination` is inside the container.
#[derive(Clone, Debug, PartialEq)]
pub struct Mount {
    pub source: String,
    pub destination: String,
}

fn strip_prefix_ci<'a>(s: &'a str, p: &str) -> Option<&'a str> {
    if s.len() >= p.len() && s.is_char_boundary(p.len()) && s[..p.len()].eq_ignore_ascii_case(p) {
        Some(&s[p.len()..])
    } else {
        None
    }
}

/// `\\wsl.localhost\Ubuntu\home\u` / `\\wsl$\Ubuntu\home\u` / `//wsl.localhost/Ubuntu/home/u` /
/// `\\?\UNC\wsl.localhost\Ubuntu\…` → (distro, "/home/u"). The root of a distro is "/".
pub fn parse_wsl_unc(p: &str) -> Option<(String, String)> {
    let s = p.trim().replace('\\', "/");
    let s = strip_prefix_ci(&s, "//?/UNC/").map(|r| format!("//{r}")).unwrap_or(s);
    let rest = s.strip_prefix("//")?;
    let rest = strip_prefix_ci(rest, "wsl.localhost/").or_else(|| strip_prefix_ci(rest, "wsl$/")).or_else(|| strip_prefix_ci(rest, "wsl.localhost").filter(|r| r.is_empty()))?;
    let mut it = rest.splitn(2, '/');
    let distro = it.next().unwrap_or("").to_string();
    if distro.is_empty() {
        return None;
    }
    let tail = it.next().unwrap_or("");
    let parts: Vec<&str> = tail.split('/').filter(|x| !x.is_empty()).collect();
    Some((distro, format!("/{}", parts.join("/"))))
}

pub fn is_wsl_unc(p: &str) -> bool {
    parse_wsl_unc(p).is_some()
}

/// ("Ubuntu", "/home/u/p") → `\\wsl.localhost\Ubuntu\home\u\p`
pub fn wsl_unc(distro: &str, linux: &str) -> String {
    let tail = linux.trim_matches('/').replace('/', "\\");
    if tail.is_empty() {
        format!("\\\\wsl.localhost\\{distro}")
    } else {
        format!("\\\\wsl.localhost\\{distro}\\{tail}")
    }
}

/// `C:\x\y` or `c:/x/y` → `/mnt/c/x/y`; a `\\wsl…` path → its Linux path; anything else → None.
pub fn win_to_wsl(p: &str) -> Option<String> {
    if let Some((_, l)) = parse_wsl_unc(p) {
        return Some(l);
    }
    let s = p.trim().replace('\\', "/");
    let b = s.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b.len() == 2 || b[2] == b'/') {
        let drive = (b[0] as char).to_ascii_lowercase();
        let parts: Vec<&str> = s[2..].split('/').filter(|x| !x.is_empty()).collect();
        return Some(if parts.is_empty() { format!("/mnt/{drive}") } else { format!("/mnt/{drive}/{}", parts.join("/")) });
    }
    None
}

#[allow(dead_code)] // the pure mapping API is complete and tested; the window maps Claude's paths itself (envs-core.js)
/// `/mnt/c/x/y` → `C:\x\y`; any other Linux path → the distro's `\\wsl.localhost\…` path.
pub fn wsl_to_win(distro: &str, linux: &str) -> String {
    let l = linux.trim();
    if let Some(rest) = l.strip_prefix("/mnt/") {
        let mut it = rest.splitn(2, '/');
        let d = it.next().unwrap_or("");
        if d.len() == 1 && d.as_bytes()[0].is_ascii_alphabetic() {
            let tail = it.next().unwrap_or("").trim_matches('/').replace('/', "\\");
            return format!("{}:\\{}", d.to_ascii_uppercase(), tail);
        }
    }
    wsl_unc(distro, l)
}

/// The Linux directory above `p` ("/" stays "/").
pub fn posix_parent(p: &str) -> String {
    let t = p.trim_end_matches('/');
    match t.rfind('/') {
        Some(0) | None => "/".into(),
        Some(i) => t[..i].to_string(),
    }
}

#[allow(dead_code)]
pub fn posix_join(a: &str, b: &str) -> String {
    if b.starts_with('/') {
        return b.to_string();
    }
    format!("{}/{}", a.trim_end_matches('/'), b.trim_start_matches("./"))
}

/// Docker: a path of the host (Windows `C:\p\q`, or a WSL path) → the path inside the container,
/// through a bind mount. Longest matching mount wins.
pub fn host_to_container(mounts: &[Mount], host: &str) -> Option<String> {
    let h = norm_host(host);
    let mut best: Option<(usize, String)> = None;
    for m in mounts {
        let src = norm_host(&m.source);
        if src.is_empty() {
            continue;
        }
        // Windows paths ignore case; compare the prefix that way but keep the rest as written
        let rest = if h.eq_ignore_ascii_case(&src) {
            Some("")
        } else if h.len() > src.len() && h.is_char_boundary(src.len()) && h[..src.len()].eq_ignore_ascii_case(&src) && h.as_bytes()[src.len()] == b'/' {
            Some(&h[src.len() + 1..])
        } else {
            None
        };
        if let Some(rest) = rest {
            let dest = format!("{}/{}", m.destination.trim_end_matches('/'), rest).trim_end_matches('/').to_string();
            let dest = if dest.is_empty() { "/".to_string() } else { dest };
            if best.as_ref().map(|(n, _)| src.len() > *n).unwrap_or(true) {
                best = Some((src.len(), dest));
            }
        }
    }
    best.map(|(_, d)| d)
}

/// The reverse: a path inside the container that sits on a bind mount → the host path
/// (`C:\p\q` style when the source is a Windows path).
pub fn container_to_host(mounts: &[Mount], inside: &str) -> Option<String> {
    let c = inside.trim_end_matches('/');
    let mut best: Option<(usize, String)> = None;
    for m in mounts {
        let dest = m.destination.trim_end_matches('/');
        let rest = if c == dest { Some("") } else { c.strip_prefix(&format!("{dest}/")) };
        if let Some(rest) = rest {
            let src = m.source.trim_end_matches(['/', '\\']);
            let win = src.contains('\\') || src.as_bytes().get(1) == Some(&b':');
            let joined = if rest.is_empty() { src.to_string() } else if win { format!("{src}\\{}", rest.replace('/', "\\")) } else { format!("{src}/{rest}") };
            if best.as_ref().map(|(n, _)| dest.len() > *n).unwrap_or(true) {
                best = Some((dest.len(), joined));
            }
        }
    }
    best.map(|(_, d)| d)
}

/// Slashes forward, no trailing slash, `C:` form for Windows drives (also from Docker Desktop's
/// `/run/desktop/mnt/host/c/…` and `/host_mnt/c/…`). Case is kept.
fn norm_host(p: &str) -> String {
    let s = p.trim().replace('\\', "/");
    for pre in ["/run/desktop/mnt/host/", "/host_mnt/"] {
        if let Some(r) = s.strip_prefix(pre) {
            let mut it = r.splitn(2, '/');
            let d = it.next().unwrap_or("");
            if d.len() == 1 {
                return format!("{}:/{}", d.to_ascii_uppercase(), it.next().unwrap_or("")).trim_end_matches('/').to_string();
            }
        }
    }
    s.trim_end_matches('/').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unc_forms() {
        assert_eq!(parse_wsl_unc(r"\\wsl.localhost\Ubuntu\home\u\p"), Some(("Ubuntu".into(), "/home/u/p".into())));
        assert_eq!(parse_wsl_unc(r"\\wsl$\Ubuntu-22.04\home\u"), Some(("Ubuntu-22.04".into(), "/home/u".into())));
        assert_eq!(parse_wsl_unc("//WSL.LOCALHOST/Debian/etc/"), Some(("Debian".into(), "/etc".into())));
        assert_eq!(parse_wsl_unc(r"\\?\UNC\wsl.localhost\Ubuntu\var\log"), Some(("Ubuntu".into(), "/var/log".into())));
        assert_eq!(parse_wsl_unc(r"\\wsl.localhost\Ubuntu"), Some(("Ubuntu".into(), "/".into())));
        assert_eq!(parse_wsl_unc(r"\\wsl.localhost\Ubuntu\\home\\u"), Some(("Ubuntu".into(), "/home/u".into())));
        assert_eq!(parse_wsl_unc(r"\\wsl.localhost"), None);
        assert_eq!(parse_wsl_unc(r"\\server\share\x"), None);
        assert_eq!(parse_wsl_unc(r"C:\Users\a"), None);
        assert_eq!(parse_wsl_unc("/home/u"), None);
        assert!(is_wsl_unc(r"\\wsl$\Ubuntu\x"));
    }
    #[test]
    fn unc_roundtrip() {
        assert_eq!(wsl_unc("Ubuntu", "/home/u/p"), r"\\wsl.localhost\Ubuntu\home\u\p");
        assert_eq!(wsl_unc("Ubuntu", "/"), r"\\wsl.localhost\Ubuntu");
        let (d, l) = parse_wsl_unc(&wsl_unc("Ubuntu-22.04", "/home/u/my docs")).unwrap();
        assert_eq!((d.as_str(), l.as_str()), ("Ubuntu-22.04", "/home/u/my docs"));
    }
    #[test]
    fn drives() {
        assert_eq!(win_to_wsl(r"C:\x\y").as_deref(), Some("/mnt/c/x/y"));
        assert_eq!(win_to_wsl("d:/Data").as_deref(), Some("/mnt/d/Data"));
        assert_eq!(win_to_wsl(r"C:\").as_deref(), Some("/mnt/c"));
        assert_eq!(win_to_wsl("C:").as_deref(), Some("/mnt/c"));
        assert_eq!(win_to_wsl(r"\\wsl.localhost\Ubuntu\home\u").as_deref(), Some("/home/u"));
        assert_eq!(win_to_wsl("relative\\x"), None);
        assert_eq!(win_to_wsl("Cx:\\y"), None);
        assert_eq!(wsl_to_win("Ubuntu", "/mnt/c/x/y"), r"C:\x\y");
        assert_eq!(wsl_to_win("Ubuntu", "/mnt/c"), r"C:\");
        assert_eq!(wsl_to_win("Ubuntu", "/mnt/wsl/x"), r"\\wsl.localhost\Ubuntu\mnt\wsl\x");
        assert_eq!(wsl_to_win("Ubuntu", "/home/u"), r"\\wsl.localhost\Ubuntu\home\u");
    }
    #[test]
    fn posix() {
        assert_eq!(posix_parent("/home/u/p"), "/home/u");
        assert_eq!(posix_parent("/home"), "/");
        assert_eq!(posix_parent("/"), "/");
        assert_eq!(posix_join("/home/u/", "./a.tex"), "/home/u/a.tex");
        assert_eq!(posix_join("/home/u", "/etc/x"), "/etc/x");
    }
    fn mounts() -> Vec<Mount> {
        vec![
            Mount { source: r"C:\Users\me\proj".into(), destination: "/workspace".into() },
            Mount { source: r"C:\Users\me\proj\data".into(), destination: "/data".into() },
            Mount { source: "/run/desktop/mnt/host/d/Work".into(), destination: "/work".into() },
        ]
    }
    #[test]
    fn docker_paths() {
        let m = mounts();
        assert_eq!(host_to_container(&m, r"C:\Users\me\proj\src\a.py").as_deref(), Some("/workspace/src/a.py"));
        assert_eq!(host_to_container(&m, r"c:\users\ME\proj").as_deref(), Some("/workspace"));
        assert_eq!(host_to_container(&m, r"C:\Users\me\proj\data\x.csv").as_deref(), Some("/data/x.csv"));
        assert_eq!(host_to_container(&m, r"D:\Work\r.md").as_deref(), Some("/work/r.md"));
        assert_eq!(host_to_container(&m, r"C:\Users\me\other"), None);
        assert_eq!(host_to_container(&m, r"C:\Users\me\project2"), None);
        assert_eq!(container_to_host(&m, "/workspace/src/a.py").as_deref(), Some(r"C:\Users\me\proj\src\a.py"));
        assert_eq!(container_to_host(&m, "/data/x.csv").as_deref(), Some(r"C:\Users\me\proj\data\x.csv"));
        assert_eq!(container_to_host(&m, "/workspace").as_deref(), Some(r"C:\Users\me\proj"));
        assert_eq!(container_to_host(&m, "/tmp/x"), None);
        assert_eq!(container_to_host(&m, "/workspacex/a"), None);
    }
    #[test]
    fn docker_wsl_source() {
        let m = vec![Mount { source: "/home/u/proj".into(), destination: "/app".into() }];
        assert_eq!(container_to_host(&m, "/app/a/b").as_deref(), Some("/home/u/proj/a/b"));
        assert_eq!(host_to_container(&m, "/home/u/proj/a/b").as_deref(), Some("/app/a/b"));
    }
}
