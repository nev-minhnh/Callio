//! Parsing what `wsl.exe`, `docker` and a few shell probes print. Pure functions (only serde_json
//! from the crate list) so they are unit-tested with real sample outputs.
use super::paths::Mount;
use serde_json::Value;

/// `wsl.exe` prints UTF-16LE (with a BOM, and sometimes without one); with `WSL_UTF8=1` or an
/// older build it can be UTF-8. Decode whichever it is; stray NULs and CRs are dropped.
pub fn decode_wsl_output(b: &[u8]) -> String {
    let b = b.strip_prefix(&[0xFF, 0xFE]).unwrap_or(b);
    let nuls = b.iter().filter(|x| **x == 0).count();
    let s = if b.len() >= 2 && nuls * 4 >= b.len() {
        let u: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&u)
    } else {
        String::from_utf8_lossy(b).to_string()
    };
    s.trim_start_matches('\u{feff}').replace('\0', "").replace('\r', "")
}

#[derive(Debug, Clone, PartialEq)]
pub struct WslDistro {
    pub name: String,
    /// "Running", "Stopped", … as printed (may be localised)
    pub state: String,
    pub version: u8,
    pub default: bool,
}

/// Rows of `wsl -l -v`:
/// ```text
///   NAME            STATE           VERSION
/// * Ubuntu          Running         2
///   Debian          Stopped         2
/// ```
/// The header is skipped by its shape (the last column must be 1 or 2), so a localised header
/// works too. Distro names have no spaces.
pub fn parse_wsl_list(text: &str) -> Vec<WslDistro> {
    let mut out = Vec::new();
    for line in text.lines() {
        let t = line.trim_end();
        if t.trim().is_empty() {
            continue;
        }
        let default = t.trim_start().starts_with('*');
        let body = t.trim_start().trim_start_matches('*').trim_start();
        let toks: Vec<&str> = body.split_whitespace().collect();
        if toks.len() < 3 {
            continue;
        }
        let Ok(version) = toks[toks.len() - 1].parse::<u8>() else { continue };
        if version != 1 && version != 2 {
            continue;
        }
        out.push(WslDistro { name: toks[0].to_string(), state: toks[1..toks.len() - 1].join(" "), version, default });
    }
    out
}

/// `wsl -l --running -q`: one name per line.
pub fn parse_name_list(text: &str) -> Vec<String> {
    text.lines().map(|l| l.trim().trim_start_matches('*').trim().to_string()).filter(|l| !l.is_empty() && !l.contains(' ')).collect()
}

/// Distros Docker Desktop keeps for itself: never offered as places to work.
pub fn is_internal_distro(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == "docker-desktop" || n == "docker-desktop-data" || n.starts_with("rancher-desktop")
}

#[derive(Debug, Clone, PartialEq)]
pub struct Container {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    /// (host port, container port) of published TCP ports on an IPv4 address
    pub ports: Vec<(u16, u16)>,
}

/// `docker ps --format '{{json .}}'`: one JSON object per line.
pub fn parse_docker_ps(text: &str) -> Vec<Container> {
    let mut out = Vec::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
        let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
        let name = s("Names").split(',').next().unwrap_or("").trim().to_string();
        if name.is_empty() {
            continue;
        }
        out.push(Container { id: s("ID"), name, image: s("Image"), status: s("Status"), ports: parse_ports(&s("Ports")) });
    }
    out
}

/// "0.0.0.0:8888->8888/tcp, :::8888->8888/tcp, 5432/tcp" → [(8888, 8888)]
pub fn parse_ports(s: &str) -> Vec<(u16, u16)> {
    let mut out: Vec<(u16, u16)> = Vec::new();
    for part in s.split(',') {
        let p = part.trim();
        let Some((l, r)) = p.split_once("->") else { continue };
        if !r.ends_with("/tcp") || l.starts_with('[') || l.starts_with("::") {
            continue;
        }
        let host = l.rsplit(':').next().unwrap_or("");
        let cont = r.trim_end_matches("/tcp");
        // "8000-8010" ranges are skipped
        if let (Ok(h), Ok(c)) = (host.parse::<u16>(), cont.parse::<u16>()) {
            if !out.contains(&(h, c)) {
                out.push((h, c));
            }
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct DockerContext {
    pub name: String,
    pub current: bool,
    pub endpoint: String,
}

/// `docker context ls --format '{{json .}}'`
pub fn parse_docker_contexts(text: &str) -> Vec<DockerContext> {
    text.lines()
        .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
        .map(|v| DockerContext { name: v["Name"].as_str().unwrap_or("").to_string(), current: v["Current"].as_bool().unwrap_or(false), endpoint: v["DockerEndpoint"].as_str().unwrap_or("").to_string() })
        .filter(|c| !c.name.is_empty())
        .collect()
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Inspect {
    pub mounts: Vec<Mount>,
    pub workdir: String,
    pub user: String,
    pub ports: Vec<(u16, u16)>,
    pub running: bool,
}

/// `docker inspect <container>`: bind mounts (the only ones a Windows editor can reach), working
/// folder, user and published ports.
pub fn parse_inspect(text: &str) -> Option<Inspect> {
    let v: Value = serde_json::from_str(text.trim()).ok()?;
    let c = if v.is_array() { v.get(0)? } else { &v };
    let mounts = c["Mounts"].as_array().map(|a| a.iter().filter(|m| m["Type"] == "bind").filter_map(|m| Some(Mount { source: m["Source"].as_str()?.to_string(), destination: m["Destination"].as_str()?.to_string() })).collect()).unwrap_or_default();
    let mut ports = Vec::new();
    if let Some(o) = c["NetworkSettings"]["Ports"].as_object() {
        for (k, val) in o {
            let Some(cp) = k.strip_suffix("/tcp").and_then(|x| x.parse::<u16>().ok()) else { continue };
            for b in val.as_array().into_iter().flatten() {
                let ip = b["HostIp"].as_str().unwrap_or("");
                if ip.contains(':') {
                    continue;
                }
                if let Some(hp) = b["HostPort"].as_str().and_then(|x| x.parse::<u16>().ok()) {
                    if !ports.contains(&(hp, cp)) {
                        ports.push((hp, cp));
                    }
                }
            }
        }
        ports.sort();
    }
    Some(Inspect { mounts, workdir: c["Config"]["WorkingDir"].as_str().unwrap_or("").to_string(), user: c["Config"]["User"].as_str().unwrap_or("").to_string(), ports, running: c["State"]["Running"].as_bool().unwrap_or(false) })
}

/// `ip route show default` inside a distro → the gateway. In the default (NAT) networking mode
/// this is the Windows host as the distro sees it.
pub fn parse_default_gateway(text: &str) -> Option<String> {
    for l in text.lines() {
        let t: Vec<&str> = l.split_whitespace().collect();
        if t.first() == Some(&"default") {
            if let Some(i) = t.iter().position(|x| *x == "via") {
                return t.get(i + 1).filter(|g| g.parse::<std::net::Ipv4Addr>().is_ok()).map(|g| g.to_string());
            }
        }
    }
    None
}

/// `%UserProfile%\.wslconfig` → the networking mode ("nat" when not set). Keys are case-insensitive;
/// only the `[wsl2]` section counts.
pub fn wslconfig_networking_mode(text: &str) -> String {
    let mut in_wsl2 = false;
    for l in text.lines() {
        let l = l.split('#').next().unwrap_or("").split(';').next().unwrap_or("").trim();
        if l.starts_with('[') {
            in_wsl2 = l.trim_matches(|c| c == '[' || c == ']').trim().eq_ignore_ascii_case("wsl2");
            continue;
        }
        if in_wsl2 {
            if let Some((k, v)) = l.split_once('=') {
                if k.trim().eq_ignore_ascii_case("networkingMode") {
                    return v.trim().trim_matches('"').to_ascii_lowercase();
                }
            }
        }
    }
    "nat".into()
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Probe {
    pub python3: Option<String>,
    pub claude: Option<String>,
    pub latexmk: Option<String>,
    pub jupyter_server: bool,
    pub ipykernel: bool,
}

/// Output of the probe script: lines `name=value`; a tool that is missing prints nothing.
pub fn parse_probe(text: &str) -> Probe {
    let mut p = Probe::default();
    for l in text.lines() {
        let Some((k, v)) = l.split_once('=') else { continue };
        let v = v.trim();
        match k.trim() {
            "python3" if !v.is_empty() => p.python3 = Some(v.to_string()),
            "claude" if !v.is_empty() => p.claude = Some(v.to_string()),
            "latexmk" if !v.is_empty() => p.latexmk = Some(v.to_string()),
            "jupyter_server" => p.jupyter_server = v == "1",
            "ipykernel" => p.ipykernel = v == "1",
            _ => {}
        }
    }
    p
}

/// The two lines `$HOME` and `id -un`.
pub fn parse_home_user(text: &str) -> Option<(String, String)> {
    let mut it = text.lines().map(|l| l.trim()).filter(|l| !l.is_empty());
    let home = it.next()?.to_string();
    let user = it.next()?.to_string();
    if !home.starts_with('/') {
        return None;
    }
    Some((home, user))
}

#[derive(Debug, Clone, PartialEq)]
pub struct EnvPython {
    pub path: String,
    pub label: String,
    pub version: String,
    /// venv | conda | path
    pub source: String,
    pub has_server: bool,
    pub has_kernel: bool,
}

/// Lines `source|/path/to/python|3.12.3 1 0` printed by the discovery script (version, jupyter_server, ipykernel).
pub fn parse_pythons(text: &str) -> Vec<EnvPython> {
    let mut out: Vec<EnvPython> = Vec::new();
    for l in text.lines() {
        let mut it = l.splitn(3, '|');
        let (Some(src), Some(path), Some(info)) = (it.next(), it.next(), it.next()) else { continue };
        let f: Vec<&str> = info.split_whitespace().collect();
        if f.len() != 3 || !path.starts_with('/') || out.iter().any(|p| p.path == path) {
            continue;
        }
        let ver = f[0].to_string();
        let short = ver.split('.').take(2).collect::<Vec<_>>().join(".");
        let folder = path.rsplit('/').nth(2).unwrap_or("");
        let tag = match src {
            "venv" | "conda" if !folder.is_empty() => folder.to_string(),
            _ if path.starts_with("/usr/") => "system".to_string(),
            _ => "PATH".to_string(),
        };
        out.push(EnvPython { path: path.to_string(), label: format!("Python {short} ({tag})"), version: ver, source: src.to_string(), has_server: f[1] == "1", has_kernel: f[2] == "1" });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(s: &str, bom: bool) -> Vec<u8> {
        let mut v = if bom { vec![0xFF, 0xFE] } else { vec![] };
        for u in s.encode_utf16() {
            v.extend(u.to_le_bytes());
        }
        v
    }
    // what Windows 11 prints (CRLF, UTF-16LE with BOM, trailing spaces, odd column widths)
    const LIST: &str = "  NAME                   STATE           VERSION\r\n* Ubuntu                 Running         2\r\n  docker-desktop         Stopped         2\r\n  Ubuntu-22.04           Stopped         2\r\n  Debian                 Running         1\r\n\r\n";

    #[test]
    fn decode_utf16_with_and_without_bom() {
        assert_eq!(decode_wsl_output(&utf16(LIST, true)), LIST.replace('\r', ""));
        assert_eq!(decode_wsl_output(&utf16(LIST, false)), LIST.replace('\r', ""));
        assert_eq!(decode_wsl_output(b"plain utf8 \xc3\xa9\r\n"), "plain utf8 é\n");
        assert_eq!(decode_wsl_output(&[]), "");
        // an odd trailing byte does not panic
        let mut o = utf16("ab", true);
        o.push(0x41);
        let _ = decode_wsl_output(&o);
    }
    #[test]
    fn list_verbose() {
        let d = parse_wsl_list(&decode_wsl_output(&utf16(LIST, true)));
        assert_eq!(d.len(), 4);
        assert_eq!(d[0], WslDistro { name: "Ubuntu".into(), state: "Running".into(), version: 2, default: true });
        assert_eq!(d[1].name, "docker-desktop");
        assert!(is_internal_distro(&d[1].name));
        assert_eq!(d[2].name, "Ubuntu-22.04");
        assert!(!d[2].default);
        assert_eq!(d[3].version, 1);
    }
    #[test]
    fn list_localised_and_messages() {
        let vi = "  NAME      TRẠNG THÁI      PHIÊN BẢN\n* Ubuntu    Đang chạy       2\n  Kali      Đã dừng         2\n";
        let d = parse_wsl_list(vi);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].state, "Đang chạy");
        assert_eq!(d[1].name, "Kali");
        assert!(parse_wsl_list("Windows Subsystem for Linux has no installed distributions.\nYou can install distributions by running: wsl.exe --install\n").is_empty());
        assert!(parse_wsl_list("").is_empty());
        assert!(parse_wsl_list("NAME STATE VERSION\n").is_empty());
    }
    #[test]
    fn running_names() {
        assert_eq!(parse_name_list("Ubuntu\nDebian\n\n"), vec!["Ubuntu", "Debian"]);
        assert_eq!(parse_name_list("There are no running distributions.\n"), Vec::<String>::new());
    }
    #[test]
    fn docker_ps_lines() {
        let t = r#"{"Command":"\"sleep infinity\"","ID":"3f2a1b","Image":"python:3.12","Names":"dev-py","Ports":"0.0.0.0:8888->8888/tcp, :::8888->8888/tcp, 5432/tcp","State":"running","Status":"Up 2 hours"}
{"ID":"9c8d7e","Image":"ubuntu:24.04","Names":"scratch","Ports":"","State":"running","Status":"Up 5 minutes"}
not json
{"ID":"1","Image":"x","Names":"","Ports":""}"#;
        let c = parse_docker_ps(t);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0], Container { id: "3f2a1b".into(), name: "dev-py".into(), image: "python:3.12".into(), status: "Up 2 hours".into(), ports: vec![(8888, 8888)] });
        assert!(c[1].ports.is_empty());
    }
    #[test]
    fn ports() {
        assert_eq!(parse_ports("127.0.0.1:9000->8888/tcp"), vec![(9000, 8888)]);
        assert_eq!(parse_ports("0.0.0.0:8000-8010->8000-8010/tcp"), vec![]);
        assert_eq!(parse_ports("0.0.0.0:53->53/udp"), vec![]);
        assert_eq!(parse_ports("[::]:80->80/tcp"), vec![]);
    }
    #[test]
    fn contexts() {
        let t = r#"{"Current":true,"Description":"Current DOCKER_HOST based configuration","DockerEndpoint":"npipe:////./pipe/docker_engine","Name":"default"}
{"Current":false,"DockerEndpoint":"unix:///var/run/docker.sock","Name":"desktop-linux"}"#;
        let c = parse_docker_contexts(t);
        assert_eq!(c.len(), 2);
        assert!(c[0].current && c[0].name == "default");
    }
    #[test]
    fn inspect() {
        let t = r#"[{"State":{"Running":true},"Config":{"WorkingDir":"/workspace","User":"vscode"},
          "Mounts":[{"Type":"bind","Source":"/run/desktop/mnt/host/c/Users/me/proj","Destination":"/workspace","Mode":"rw"},{"Type":"volume","Name":"v","Source":"/var/lib/docker/volumes/v/_data","Destination":"/data"}],
          "NetworkSettings":{"Ports":{"8888/tcp":[{"HostIp":"0.0.0.0","HostPort":"8899"},{"HostIp":"::","HostPort":"8899"}],"5432/tcp":null}}}]"#;
        let i = parse_inspect(t).unwrap();
        assert_eq!(i.mounts, vec![Mount { source: "/run/desktop/mnt/host/c/Users/me/proj".into(), destination: "/workspace".into() }]);
        assert_eq!(i.workdir, "/workspace");
        assert_eq!(i.user, "vscode");
        assert_eq!(i.ports, vec![(8899, 8888)]);
        assert!(i.running);
        assert!(parse_inspect("nope").is_none());
        assert!(parse_inspect("[]").is_none());
    }
    #[test]
    fn gateway_and_wslconfig() {
        assert_eq!(parse_default_gateway("default via 172.28.176.1 dev eth0 proto kernel\n").as_deref(), Some("172.28.176.1"));
        assert_eq!(parse_default_gateway("172.28.176.0/20 dev eth0 proto kernel scope link src 172.28.180.5\n"), None);
        assert_eq!(parse_default_gateway("default via fe80::1 dev eth0\n"), None);
        assert_eq!(wslconfig_networking_mode("[wsl2]\nmemory=4GB\nnetworkingMode=mirrored\n"), "mirrored");
        assert_eq!(wslconfig_networking_mode("[wsl2]\n NetworkingMode = \"Mirrored\" # comment\n"), "mirrored");
        assert_eq!(wslconfig_networking_mode("[experimental]\nnetworkingMode=mirrored\n"), "nat");
        assert_eq!(wslconfig_networking_mode(""), "nat");
        assert_eq!(wslconfig_networking_mode("[wsl2]\nnetworkingMode=virtioproxy\n"), "virtioproxy");
    }
    #[test]
    fn probe_and_home() {
        let p = parse_probe("python3=/usr/bin/python3\nclaude=/home/u/.local/bin/claude\njupyter_server=1\nipykernel=0\n");
        assert_eq!(p.python3.as_deref(), Some("/usr/bin/python3"));
        assert!(p.latexmk.is_none() && p.jupyter_server && !p.ipykernel);
        assert_eq!(parse_home_user("/home/u\nu\n"), Some(("/home/u".into(), "u".into())));
        assert_eq!(parse_home_user("bash: warning\n"), None);
    }
    #[test]
    fn pythons() {
        let t = "venv|/home/u/p/.venv/bin/python|3.12.3 1 1\npath|/usr/bin/python3|3.10.12 0 0\nconda|/home/u/miniconda3/bin/python|3.11.5 1 0\npath|/usr/bin/python3|3.10.12 0 0\ngarbage\npath|rel/python|3.9.1 1 1\n";
        let p = parse_pythons(t);
        assert_eq!(p.len(), 3);
        assert_eq!(p[0].label, "Python 3.12 (.venv)");
        assert!(p[0].has_server && p[0].has_kernel);
        assert_eq!(p[1].label, "Python 3.10 (system)");
        assert!(!p[1].has_server);
        assert_eq!(p[2].label, "Python 3.11 (miniconda3)");
        assert!(p[2].has_server && !p[2].has_kernel);
    }
}
