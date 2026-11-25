//! What the SSH core needs from the app, as plain callbacks, so the core (connections, SFTP,
//! the sync engine, remote Jupyter) has no dependency on Tauri and can be tested against a real
//! sshd from a small standalone program. `mod.rs` fills it in with the real app.
use serde_json::Value;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

pub type Ask = Arc<dyn Fn(String, Value) -> Pin<Box<dyn Future<Output = Option<Value>> + Send>> + Send + Sync>;

#[derive(Clone)]
pub struct Env {
    /// Tell the window something (events `ssh-state`, `ssh-sync`, …).
    pub emit: Arc<dyn Fn(&str, Value) + Send + Sync>,
    /// Ask the author (host key, passphrase, password, one-time code) and wait for the answer.
    /// `None` means they closed the dialog.
    pub ask: Ask,
    /// Credential Manager (the only place a secret may live). Empty value = delete.
    pub secret_get: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    pub secret_set: Arc<dyn Fn(&str, &str) + Send + Sync>,
    /// Where sync state lives (`<data>/sync`).
    pub data_dir: PathBuf,
    /// `%USERPROFILE%\.ssh`
    pub ssh_dir: PathBuf,
    /// Move a local file to the Recycle Bin.
    pub trash: Arc<dyn Fn(&Path) -> Result<(), String> + Send + Sync>,
}

impl Env {
    pub fn emit(&self, name: &str, v: Value) {
        (self.emit)(name, v)
    }
    pub async fn ask(&self, kind: &str, v: Value) -> Option<Value> {
        (self.ask)(kind.to_string(), v).await
    }
    pub fn secret(&self, k: &str) -> Option<String> {
        (self.secret_get)(k).filter(|s| !s.is_empty())
    }
    pub fn set_secret(&self, k: &str, v: &str) {
        (self.secret_set)(k, v)
    }
}
