//! Building the argument lists that run a program inside WSL or a Docker container, and quoting
//! for the few places a shell is unavoidable. Pure functions (std only) with unit tests.
//!
//! Rules: user data (paths, names, tokens) is always its own argv item, never part of a shell
//! string. When a shell is needed, its script is a constant from this file and the data comes
//! as positional parameters ("$1", "$@"). `wsl.exe --exec` runs the program without the distro's
//! shell, so nothing is re-parsed on the way in.

/// Constant script: put the usual per-user tool folders on PATH (a non-login `--exec` has the bare
/// PATH, so `~/.local/bin/claude` would not be found), then run the program given as arguments.
pub const PATH_WRAP: &str = r#"PATH="$HOME/.local/bin:$HOME/.claude/local:$HOME/.npm-global/bin:$HOME/.cargo/bin:/usr/local/bin:$PATH"; export PATH; unset ANTHROPIC_API_KEY; exec "$@""#;

/// Arguments for `wsl.exe`: `-d <distro> [-u user] [--cd cwd] --exec [sh -c <PATH_WRAP> callio] <program> <args…>`.
pub fn wsl_args(distro: &str, user: Option<&str>, cwd: Option<&str>, program: &str, args: &[String], wrap_path: bool) -> Vec<String> {
    let mut v: Vec<String> = vec!["-d".into(), distro.into()];
    if let Some(u) = user.filter(|u| !u.is_empty()) {
        v.extend(["-u".into(), u.into()]);
    }
    if let Some(c) = cwd.filter(|c| !c.is_empty()) {
        v.extend(["--cd".into(), c.into()]);
    }
    v.push("--exec".into());
    if wrap_path {
        v.extend(["sh".into(), "-c".into(), PATH_WRAP.into(), "callio".into()]);
    }
    v.push(program.into());
    v.extend(args.iter().cloned());
    v
}

/// Arguments for `docker`: `exec -i [-u user] [-w cwd] [-e NAME …] <container> <program> <args…>`.
/// `-e NAME` has no value on purpose: Docker takes it from its own environment, so a secret never
/// appears in a command line.
pub fn docker_args(container: &str, user: Option<&str>, cwd: Option<&str>, env_names: &[&str], program: &str, args: &[String]) -> Vec<String> {
    let mut v: Vec<String> = vec!["exec".into(), "-i".into()];
    if let Some(u) = user.filter(|u| !u.is_empty()) {
        v.extend(["-u".into(), u.into()]);
    }
    if let Some(c) = cwd.filter(|c| !c.is_empty()) {
        v.extend(["-w".into(), c.into()]);
    }
    for n in env_names {
        v.extend(["-e".into(), (*n).into()]);
    }
    v.push(container.into());
    v.push(program.into());
    v.extend(args.iter().cloned());
    v
}

/// WSLENV for variables that must cross from a Windows process into the distro.
pub fn wslenv_value(existing: Option<&str>, names: &[&str]) -> String {
    let mut parts: Vec<String> = existing.unwrap_or("").split(':').filter(|s| !s.is_empty()).map(String::from).collect();
    for n in names {
        if !parts.iter().any(|p| p.split('/').next() == Some(*n)) {
            parts.push((*n).to_string());
        }
    }
    parts.join(":")
}

#[allow(dead_code)] // for the few places a shell string is unavoidable; unit-tested
/// POSIX single-quote quoting: safe inside `sh -c` even for quotes, spaces, `$` and newlines.
pub fn sh_quote(s: &str) -> String {
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-./=:,+@%".contains(&b)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[allow(dead_code)]
pub fn sh_join(words: &[String]) -> String {
    words.iter().map(|w| sh_quote(w)).collect::<Vec<_>>().join(" ")
}

/// Names that may reach a command line (distro, container, user): letters, digits and `._-`.
pub fn safe_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && !s.starts_with('-') && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn s(x: &[&str]) -> Vec<String> {
        x.iter().map(|y| y.to_string()).collect()
    }
    #[test]
    fn wsl_plain() {
        let v = wsl_args("Ubuntu", None, Some("/home/u/my proj"), "python3", &s(&["-c", "print('a b')"]), false);
        assert_eq!(v, s(&["-d", "Ubuntu", "--cd", "/home/u/my proj", "--exec", "python3", "-c", "print('a b')"]));
    }
    #[test]
    fn wsl_wrapped_keeps_args_separate() {
        let v = wsl_args("Ubuntu-22.04", Some("minh"), None, "claude", &s(&["-p", "--model", "x y"]), true);
        assert_eq!(&v[..6], &s(&["-d", "Ubuntu-22.04", "-u", "minh", "--exec", "sh"])[..]);
        assert_eq!(v[6], "-c");
        assert_eq!(v[7], PATH_WRAP);
        assert_eq!(&v[8..], &s(&["callio", "claude", "-p", "--model", "x y"])[..]);
        assert!(!PATH_WRAP.contains("minh"));
    }
    #[test]
    fn docker_exec() {
        let v = docker_args("my-ctr", None, Some("/workspace"), &["JUPYTER_TOKEN"], "python3", &s(&["-m", "jupyter_server"]));
        assert_eq!(v, s(&["exec", "-i", "-w", "/workspace", "-e", "JUPYTER_TOKEN", "my-ctr", "python3", "-m", "jupyter_server"]));
        assert!(!v.iter().any(|x| x.contains('=')));
    }
    #[test]
    fn wslenv() {
        assert_eq!(wslenv_value(None, &["A", "B"]), "A:B");
        assert_eq!(wslenv_value(Some("X/p:A"), &["A", "B"]), "X/p:A:B");
        assert_eq!(wslenv_value(Some(""), &[]), "");
    }
    #[test]
    fn quoting() {
        assert_eq!(sh_quote("abc-1.2/x"), "abc-1.2/x");
        assert_eq!(sh_quote("a b"), "'a b'");
        assert_eq!(sh_quote("it's"), r#"'it'\''s'"#);
        assert_eq!(sh_quote(""), "''");
        assert_eq!(sh_quote("$(rm -rf ~)"), "'$(rm -rf ~)'");
        assert_eq!(sh_quote("a\nb"), "'a\nb'");
        assert_eq!(sh_join(&s(&["echo", "x y", "'"])), r#"echo 'x y' ''\'''"#);
    }
    #[test]
    fn names() {
        assert!(safe_name("Ubuntu-22.04"));
        assert!(safe_name("my_ctr.1"));
        assert!(!safe_name("-rm"));
        assert!(!safe_name("a b"));
        assert!(!safe_name("a;b"));
        assert!(!safe_name(""));
    }
}
