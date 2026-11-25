//! Work inside WSL2 and Docker. An "environment" is a place programs can run: Windows, a WSL distro
//! or a running Docker container. Files of a WSL project are the ones Windows sees at
//! `\\wsl.localhost\<distro>\…`, so the tree, tabs, history, search and compare need no changes;
//! this module adds what is different:
//!   paths    — `\\wsl.localhost\Ubuntu\home\u` <-> `/home/u`, `C:\x` <-> `/mnt/c/x`, Docker bind mounts
//!   argv     — how a program is started inside an environment (never through a shell string)
//!   parse    — what `wsl.exe` and `docker` print (UTF-16 included)
//!   exec     — `command(env, program, args, cwd)`
//!   detect   — the list of environments and what is installed in each
//!   poll     — a folder on the 9P share is polled (file-change events do not arrive there)
//!   claude   — Claude Code started inside a distro (session.rs calls `claude::target`)
//!   bridge   — how Claude Code in WSL reaches Callio's MCP server on Windows
//!   jupyter  — Jupyter servers started inside a distro / container
//!   compile  — LaTeX with the distro's own tools
pub mod argv;
pub mod bridge;
pub mod claude;
pub mod compile;
pub mod detect;
pub mod exec;
pub mod jupyter;
pub mod parse;
pub mod paths;
pub mod poll;
pub mod toolpaths;

#[allow(unused_imports)]
pub use exec::{command, command_env, Env};

/// Windows can't write Linux file modes over the 9P share: a temp file + rename would drop the
/// executable bit of a script and its owner. Saves into a distro therefore overwrite in place.
pub fn is_wsl_path(p: &str) -> bool {
    paths::is_wsl_unc(p)
}
