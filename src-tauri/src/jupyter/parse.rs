//! Pure helpers for the Jupyter feature (no Tauri, no I/O), so they can be tested on their own:
//!   rustc --test src-tauri/src/jupyter/parse.rs -o /tmp/jp-parse-test && /tmp/jp-parse-test

/// `py -0p` prints one installed Python per line, e.g.
/// ` -V:3.12 *        C:\Users\me\AppData\Local\Programs\Python\Python312\python.exe`
/// (older launchers: ` -3.12-64        C:\Python312\python.exe`). The path may contain spaces.
pub fn parse_py_launcher(out: &str) -> Vec<String> {
    let mut v = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if !line.starts_with('-') {
            continue;
        }
        let b = line.as_bytes();
        // the first "X:\" or "X:/" after the version tag starts the path
        let start = (1..b.len().saturating_sub(2)).find(|&i| b[i].is_ascii_alphabetic() && b[i + 1] == b':' && (b[i + 2] == b'\\' || b[i + 2] == b'/') && (i == 0 || b[i - 1] == b' '));
        if let Some(s) = start {
            let p = line[s..].trim();
            if p.to_ascii_lowercase().ends_with(".exe") && !v.iter().any(|x: &String| x == p) {
                v.push(p.to_string());
            }
        }
    }
    v
}

/// `name: thesis` in an environment.yml.
pub fn parse_env_yml_name(text: &str) -> Option<String> {
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("name:") {
            let n = rest.trim().trim_matches(|c| c == '"' || c == '\'').trim();
            if !n.is_empty() {
                return Some(n.to_string());
            }
        }
    }
    None
}

/// The env whose folder name is `name` (conda names an env after its folder; "base" is the root).
pub fn conda_env_for(envs: &[String], name: &str) -> Option<String> {
    envs.iter().find(|p| p.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next() == Some(name)).cloned()
}

#[derive(Debug, PartialEq, Clone, Default)]
pub struct Probe {
    pub version: String,
    pub server: bool,
    pub kernel: bool,
}
/// Output of the one `python -c` probe: three lines — version, jupyter_server (0/1), ipykernel (0/1).
pub fn parse_probe(out: &str) -> Option<Probe> {
    let l: Vec<&str> = out.lines().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    let n = l.len();
    if n < 3 {
        return None;
    }
    let v = l[n - 3];
    if !v.chars().next()?.is_ascii_digit() {
        return None;
    }
    Some(Probe { version: v.to_string(), server: l[n - 2] == "1", kernel: l[n - 1] == "1" })
}

/// "3.12.1" → "3.12"
pub fn short_version(v: &str) -> String {
    v.split('.').take(2).collect::<Vec<_>>().join(".")
}

/// The part of the label that says where an interpreter lives: ".venv", "conda: thesis", "py launcher"…
pub fn env_tag(path: &str, source: &str) -> String {
    let norm = path.replace('\\', "/");
    let parts: Vec<&str> = norm.split('/').collect();
    // …/<env>/Scripts/python.exe or …/<env>/bin/python
    // (conda on Windows keeps python.exe in the env's root folder)
    let env_dir = if parts.len() >= 3 && matches!(parts[parts.len() - 2], "Scripts" | "bin") { Some(parts[parts.len() - 3]) } else if parts.len() >= 2 { Some(parts[parts.len() - 2]) } else { None };
    match source {
        "venv" => env_dir.unwrap_or("venv").to_string(),
        "conda-env" => format!("conda: {}", env_dir.unwrap_or("env")),
        "conda-base" => "conda base".to_string(),
        "launcher" => "py launcher".to_string(),
        _ => "PATH".to_string(),
    }
}

/// The folder a local server is rooted at, so one server serves every notebook on that drive.
pub fn server_root(dir: &str) -> String {
    let b = dir.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        format!("{}:\\", (b[0] as char).to_ascii_uppercase())
    } else if dir.starts_with("\\\\") {
        // UNC share: root at \\host\share
        let p: Vec<&str> = dir.trim_start_matches('\\').split('\\').collect();
        if p.len() >= 2 { format!("\\\\{}\\{}\\", p[0], p[1]) } else { dir.to_string() }
    } else {
        "/".to_string()
    }
}

/// `dir` relative to `root` with forward slashes (what the Jupyter kernels API wants as `path`).
pub fn rel_to_root(root: &str, dir: &str) -> String {
    let r = root.replace('\\', "/");
    let d = dir.replace('\\', "/");
    let r = r.trim_end_matches('/');
    let rest = if d.len() >= r.len() && d[..r.len()].eq_ignore_ascii_case(r) { &d[r.len()..] } else { d.as_str() };
    rest.trim_matches('/').to_string()
}

/// A short stable id for a local server: letters and digits only.
pub fn short_hash(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:08x}", (h ^ (h >> 32)) as u32)
}

/// Whether a connection error is about the server's certificate (not trusted / wrong name / expired).
pub fn is_cert_error(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    ["certificate", "unknownissuer", "invalid peer", "self signed", "self-signed", "notvalidforname", "badsignature", "certnot"].iter().any(|k| m.contains(k))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launcher() {
        let o = " -V:3.13 *        C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python313\\python.exe\n -V:3.12          C:\\Program Files\\Python312\\python.exe\n -3.11-64        C:\\Python311\\python.exe\nnoise\n";
        let v = parse_py_launcher(o);
        assert_eq!(v.len(), 3);
        assert_eq!(v[1], "C:\\Program Files\\Python312\\python.exe");
        assert_eq!(v[2], "C:\\Python311\\python.exe");
    }
    #[test]
    fn yml() {
        assert_eq!(parse_env_yml_name("name: thesis\nchannels:\n - defaults\n"), Some("thesis".into()));
        assert_eq!(parse_env_yml_name("channels: []\n"), None);
        assert_eq!(parse_env_yml_name("name: \"x y\"\n"), Some("x y".into()));
    }
    #[test]
    fn conda() {
        let e = vec!["C:\\Users\\me\\miniconda3".to_string(), "C:\\Users\\me\\miniconda3\\envs\\thesis".to_string()];
        assert_eq!(conda_env_for(&e, "thesis").unwrap(), e[1]);
        assert_eq!(conda_env_for(&e, "nope"), None);
    }
    #[test]
    fn probe() {
        assert_eq!(parse_probe("3.12.1\n1\n0\n"), Some(Probe { version: "3.12.1".into(), server: true, kernel: false }));
        assert_eq!(parse_probe("warning blah\n3.9.0\n1\n1\n").unwrap().kernel, true);
        assert_eq!(parse_probe("Traceback\n"), None);
        assert_eq!(short_version("3.12.1"), "3.12");
    }
    #[test]
    fn tags() {
        assert_eq!(env_tag("C:\\proj\\.venv\\Scripts\\python.exe", "venv"), ".venv");
        assert_eq!(env_tag("C:\\Users\\me\\miniconda3\\envs\\thesis\\python.exe", "conda-env"), "conda: thesis");
        assert_eq!(env_tag("/usr/bin/python3", "path"), "PATH");
    }
    #[test]
    fn roots() {
        assert_eq!(server_root("c:\\Users\\me\\proj"), "C:\\");
        assert_eq!(server_root("/home/me/x"), "/");
        assert_eq!(server_root("\\\\nas\\share\\a\\b"), "\\\\nas\\share\\");
        assert_eq!(rel_to_root("C:\\", "c:\\Users\\me\\proj"), "Users/me/proj");
        assert_eq!(rel_to_root("/", "/home/me/x"), "home/me/x");
        assert_eq!(rel_to_root("C:\\", "C:\\"), "");
        assert_eq!(short_hash("a").len(), 8);
        assert_ne!(short_hash("a"), short_hash("b"));
    }
    #[test]
    fn certs() {
        assert!(is_cert_error("error trying to connect: invalid peer certificate: UnknownIssuer"));
        assert!(!is_cert_error("connection refused"));
    }
}
