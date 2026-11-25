//! `~/.ssh/config` and the host records Callio stores. Pure parsing, no network.
//! Supported: Host (with wildcards and `!` negation), HostName, User, Port, IdentityFile,
//! IdentitiesOnly, ProxyJump. `Match` blocks and `Include` are skipped, and the result says so.
use serde::{Deserialize, Serialize};
use std::path::Path;

/// One server, as Callio uses it. `id` is `cfg:<alias>` for hosts from the ssh config file and a
/// random id for hosts added in Callio. Nothing secret is in here.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HostCfg {
    pub id: String,
    /// shown name (the alias for config hosts)
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// "auto" (agent → key files → password → keyboard-interactive) | "agent" | "key" | "password" | "interactive"
    pub auth: String,
    /// explicit private key files (config IdentityFile or chosen in Callio)
    pub identity_files: Vec<String>,
    pub identities_only: bool,
    /// stored and shown, used later ("jump hosts come later")
    pub proxy_jump: String,
    /// "Cần VPN": a failed connection says so instead of a raw error
    pub needs_vpn: bool,
    /// keep the password / key passphrase in Credential Manager
    pub remember: bool,
    /// "config" | "callio"
    pub source: String,
}

impl HostCfg {
    pub fn port_or_default(&self) -> u16 {
        if self.port == 0 { 22 } else { self.port }
    }
    pub fn label(&self) -> String {
        if !self.name.is_empty() { self.name.clone() } else { self.host.clone() }
    }
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct ParsedConfig {
    pub hosts: Vec<HostCfg>,
    /// things that were skipped (shown once in the settings)
    pub notes: Vec<String>,
}

#[derive(Default, Clone)]
struct Block {
    patterns: Vec<String>,
    host_name: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity: Vec<String>,
    identities_only: Option<bool>,
    proxy_jump: Option<String>,
}

/// `*` and `?` wildcards, case-insensitive like ssh.
pub fn wild(pat: &str, s: &str) -> bool {
    fn go(p: &[u8], s: &[u8]) -> bool {
        match p.first() {
            None => s.is_empty(),
            Some(b'*') => (0..=s.len()).any(|i| go(&p[1..], &s[i..])),
            Some(b'?') => !s.is_empty() && go(&p[1..], &s[1..]),
            Some(c) => s.first().map(|d| d.eq_ignore_ascii_case(c)).unwrap_or(false) && go(&p[1..], &s[1..]),
        }
    }
    go(pat.as_bytes(), s.as_bytes())
}

fn matches(b: &Block, alias: &str) -> bool {
    let mut hit = false;
    for p in &b.patterns {
        if let Some(neg) = p.strip_prefix('!') {
            if wild(neg, alias) {
                return false;
            }
        } else if wild(p, alias) {
            hit = true;
        }
    }
    hit
}

fn split_kv(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let i = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let key = line[..i].to_lowercase();
    let rest = line[i..].trim_start_matches(|c: char| c.is_whitespace() || c == '=').trim();
    Some((key, rest.to_string()))
}

fn unquote(s: &str) -> String {
    s.trim().trim_matches('"').to_string()
}

fn split_args(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut q = false;
    for c in s.chars() {
        match c {
            '"' => q = !q,
            c if c.is_whitespace() && !q => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Expand `~`, `%d` (home) and `%u` (user) in an IdentityFile value.
pub fn expand_path(p: &str, home: &str, user: &str) -> String {
    let p = p.replace("%d", home).replace("%u", user);
    if let Some(r) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        format!("{}/{}", home.trim_end_matches(['/', '\\']), r)
    } else if p == "~" {
        home.to_string()
    } else {
        p
    }
}

pub fn parse(text: &str, home: &str) -> ParsedConfig {
    let mut blocks: Vec<Block> = vec![];
    let mut notes: Vec<String> = vec![];
    // options before the first Host line apply to every host
    let mut cur = Block { patterns: vec!["*".into()], ..Default::default() };
    let mut in_match = false;
    for raw in text.lines() {
        let Some((k, v)) = split_kv(raw) else { continue };
        match k.as_str() {
            "host" => {
                blocks.push(std::mem::take(&mut cur));
                cur = Block { patterns: split_args(&v), ..Default::default() };
                in_match = false;
            }
            "match" => {
                blocks.push(std::mem::take(&mut cur));
                in_match = true;
                cur = Block::default(); // matches nothing
                notes.push(format!("Match {v} was skipped (Match blocks are not supported)."));
            }
            "include" => notes.push(format!("Include {v} was skipped.")),
            _ if in_match => {}
            "hostname" => cur.host_name = cur.host_name.take().or(Some(unquote(&v))),
            "user" => cur.user = cur.user.take().or(Some(unquote(&v))),
            "port" => cur.port = cur.port.or(v.trim().parse().ok()),
            "identityfile" => cur.identity.push(unquote(&v)),
            "identitiesonly" => cur.identities_only = cur.identities_only.or(Some(v.eq_ignore_ascii_case("yes"))),
            "proxyjump" => cur.proxy_jump = cur.proxy_jump.take().or(Some(unquote(&v))),
            "proxycommand" => notes.push("ProxyCommand was ignored (use ProxyJump).".into()),
            _ => {}
        }
    }
    blocks.push(cur);
    let mut aliases: Vec<String> = vec![];
    for b in &blocks {
        for p in &b.patterns {
            if !p.starts_with('!') && !p.contains(['*', '?']) && !aliases.contains(p) {
                aliases.push(p.clone());
            }
        }
    }
    let mut hosts = vec![];
    for a in aliases {
        let mut h = HostCfg { id: format!("cfg:{a}"), name: a.clone(), source: "config".into(), auth: "auto".into(), ..Default::default() };
        let (mut hn, mut user, mut port, mut io, mut pj): (Option<String>, Option<String>, Option<u16>, Option<bool>, Option<String>) = (None, None, None, None, None);
        for b in blocks.iter().filter(|b| matches(b, &a)) {
            hn = hn.or(b.host_name.clone());
            user = user.or(b.user.clone());
            port = port.or(b.port);
            io = io.or(b.identities_only);
            pj = pj.or(b.proxy_jump.clone());
            h.identity_files.extend(b.identity.iter().cloned());
        }
        h.host = hn.map(|x| x.replace("%h", &a)).unwrap_or_else(|| a.clone());
        h.user = user.unwrap_or_default();
        h.port = port.unwrap_or(22);
        h.identities_only = io.unwrap_or(false);
        h.proxy_jump = pj.filter(|p| !p.eq_ignore_ascii_case("none")).unwrap_or_default();
        let u = h.user.clone();
        h.identity_files = h.identity_files.iter().map(|p| expand_path(p, home, &u)).collect();
        hosts.push(h);
    }
    notes.dedup();
    ParsedConfig { hosts, notes }
}

pub fn load(ssh_dir: &Path) -> ParsedConfig {
    let home = ssh_dir.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    match std::fs::read_to_string(ssh_dir.join("config")) {
        Ok(t) => parse(&t, &home),
        Err(_) => ParsedConfig::default(),
    }
}

/// Layer the hosts stored in Callio's settings over the config-file hosts: an entry with an
/// `id` of `cfg:<alias>` only carries Callio's own flags (VPN, auth, remember, key); others are
/// whole hosts. Fields left empty in the overlay keep the config file's value.
pub fn merge(config: Vec<HostCfg>, stored: Vec<HostCfg>) -> Vec<HostCfg> {
    let mut out = config;
    for s in stored {
        if let Some(h) = out.iter_mut().find(|h| h.id == s.id) {
            h.needs_vpn = s.needs_vpn;
            h.remember = s.remember;
            if !s.auth.is_empty() { h.auth = s.auth.clone(); }
            if !s.identity_files.is_empty() { h.identity_files = s.identity_files.clone(); }
            if !s.user.is_empty() { h.user = s.user.clone(); }
            if s.port != 0 { h.port = s.port; }
            if !s.host.is_empty() { h.host = s.host.clone(); }
        } else if !s.id.starts_with("cfg:") {
            let mut s = s;
            if s.auth.is_empty() { s.auth = "auto".into(); }
            s.source = "callio".into();
            out.push(s);
        }
    }
    out
}

/// POSIX single-quote a word for a remote shell.
pub fn sh_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_-./=:@%+,".contains(c)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// A path on the server written for `sh`, keeping a leading `~/` working.
pub fn sh_path(p: &str) -> String {
    if let Some(r) = p.strip_prefix("~/") {
        format!("\"$HOME\"/{}", sh_quote(r))
    } else if p == "~" {
        "\"$HOME\"".into()
    } else {
        sh_quote(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const CFG: &str = r#"
# comment
Host juniper jun
    HostName juniper.example.org
    User minh
    Port 2200
    IdentityFile ~/.ssh/id_jun
    IdentitiesOnly yes
Host lab-*
    ProxyJump bastion
Host lab-a
    HostName 10.0.0.5
Host !skip *.x
    Compression yes
Match host foo
    User nobody
Host bastion
    HostName bastion.example.org
    User = jump
Host *
    ServerAliveInterval 30
    User common
"#;
    #[test]
    fn parses_hosts() {
        let p = parse(CFG, "C:/Users/m");
        let ids: Vec<_> = p.hosts.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(ids, vec!["juniper", "jun", "lab-a", "bastion"]);
        let j = &p.hosts[0];
        assert_eq!((j.host.as_str(), j.user.as_str(), j.port), ("juniper.example.org", "minh", 2200));
        assert!(j.identities_only);
        assert_eq!(j.identity_files, vec!["C:/Users/m/.ssh/id_jun".to_string()]);
        let l = &p.hosts[2];
        assert_eq!((l.host.as_str(), l.user.as_str(), l.port, l.proxy_jump.as_str()), ("10.0.0.5", "common", 22, "bastion"));
        assert_eq!(p.hosts[3].user, "jump");
        assert!(p.notes.iter().any(|n| n.contains("Match")));
    }
    #[test]
    fn wildcards() {
        assert!(wild("lab-*", "lab-a") && wild("a?c", "abc") && !wild("a?c", "ac") && wild("*", "x"));
    }
    #[test]
    fn overlay() {
        let p = parse(CFG, "/h");
        let stored = vec![HostCfg { id: "cfg:juniper".into(), needs_vpn: true, auth: "key".into(), ..Default::default() }, HostCfg { id: "x1".into(), host: "h".into(), user: "u".into(), ..Default::default() }];
        let m = merge(p.hosts, stored);
        assert!(m[0].needs_vpn && m[0].auth == "key" && m[0].host == "juniper.example.org");
        assert_eq!(m.last().unwrap().id, "x1");
    }
    #[test]
    fn quoting() {
        assert_eq!(sh_quote("a b'c"), "'a b'\\''c'");
        assert_eq!(sh_path("~/x y"), "\"$HOME\"/'x y'");
    }
}
