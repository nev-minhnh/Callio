//! Claude Code running ON the server: the process is started through an SSH exec channel, its
//! stdin/stdout are the same stream-json pipes as for a local process (they are handed to the
//! session manager as plain `Read`/`Write` objects), and Callio's tool server on this computer is
//! reached from the server through a reverse port forward.
use super::config::{sh_path, sh_quote};
use super::conn::Session;
use super::remote::rand_hex;
use russh::ChannelMsg;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub struct ChanRead {
    rx: mpsc::Receiver<Vec<u8>>,
    buf: Vec<u8>,
    pos: usize,
}
impl Read for ChanRead {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        while self.pos >= self.buf.len() {
            match self.rx.recv() {
                Ok(v) => {
                    self.buf = v;
                    self.pos = 0;
                }
                Err(_) => return Ok(0),
            }
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

pub struct ChanWrite(tokio::sync::mpsc::UnboundedSender<Vec<u8>>);
impl Write for ChanWrite {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.send(b.to_vec()).map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "the connection to the server closed"))?;
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The handle the session manager keeps.
pub struct RemoteProc {
    sess: Arc<Session>,
    exit: Arc<Mutex<Option<Option<i32>>>>,
    pid: Arc<Mutex<Option<u32>>>,
    close: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// remote temp files and the reverse forward to clean up
    pub files: Vec<String>,
    pub rport: Option<u32>,
}
pub struct Io {
    pub stdin: ChanWrite,
    pub stdout: ChanRead,
    pub stderr: ChanRead,
}

impl RemoteProc {
    pub fn try_exit(&self) -> Option<Option<i32>> {
        *self.exit.lock().unwrap()
    }
    /// End the process (and with it what it started) and remove the temp files.
    pub fn kill(&self) {
        let (sess, pid, files, rport) = (self.sess.clone(), *self.pid.lock().unwrap(), self.files.clone(), self.rport);
        if let Some(tx) = self.close.lock().unwrap().take() {
            let _ = tx.send(());
        }
        let work = async move {
            if let Some(p) = pid {
                let _ = sess.exec(&format!("kill -TERM -- -{p} 2>/dev/null; kill -TERM {p} 2>/dev/null; sleep 1; kill -KILL {p} 2>/dev/null; true"), None, Duration::from_secs(10)).await;
            }
            if !files.is_empty() {
                let list: Vec<String> = files.iter().map(|f| sh_path(f)).collect();
                let _ = sess.exec(&format!("rm -f {}", list.join(" ")), None, Duration::from_secs(10)).await;
            }
            if let Some(p) = rport {
                sess.cancel_reverse(p).await;
            }
        };
        // may be called from a plain thread or from inside the runtime
        match tokio::runtime::Handle::try_current() {
            Ok(h) => {
                h.spawn(work);
            }
            Err(_) => {
                std::thread::spawn(move || {
                    if let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() {
                        rt.block_on(work);
                    }
                });
            }
        }
    }
}

/// Where `claude` is on the server ("" when it is not installed), looked up the way a login shell would.
pub async fn find_claude(sess: &Session) -> String {
    let s = "command -v claude || ls \"$HOME/.local/bin/claude\" \"$HOME/.claude/local/claude\" 2>/dev/null | head -1";
    for sh in ["bash -lc", "sh -c"] {
        if let Ok(o) = sess.exec(&format!("{sh} {}", sh_quote(s)), None, Duration::from_secs(25)).await {
            let t = o.text();
            if let Some(l) = t.lines().map(|l| l.trim()).find(|l| l.starts_with('/')) {
                return l.to_string();
            }
        }
    }
    String::new()
}

/// Write a small private file on the server (0600) and return its path.
pub async fn put_private(sess: &Session, name: &str, data: &[u8]) -> Result<String, String> {
    let path = format!("/tmp/callio-{}-{name}", rand_hex(5));
    let o = sess.exec(&format!("umask 077; cat > {}", sh_path(&path)), Some(data), Duration::from_secs(20)).await?;
    if !o.ok() {
        return Err(format!("Could not write {path} on the server: {}", o.err_text()));
    }
    Ok(path)
}

/// Start `exe args…` in `cwd` on the server. `args` are already the complete argument list.
pub async fn spawn(sess: Arc<Session>, cwd: &str, exe: &str, args: &[String], env: &[(&str, &str)]) -> Result<(RemoteProc, Io), String> {
    let mut cmd = format!("cd {} && ", sh_path(cwd));
    for (k, v) in env {
        cmd.push_str(&format!("{k}={} ", sh_quote(v)));
    }
    cmd.push_str("exec ");
    cmd.push_str(&sh_quote(exe));
    for a in args {
        cmd.push(' ');
        cmd.push_str(&sh_quote(a));
    }
    // stderr starts with the process id (for stopping it); a login shell gives it the user's PATH (node, nvm)
    let script = format!("echo CALLIO_PID=$$ >&2; {cmd}");
    // through bash -lc when there is one (the user's PATH), plain sh otherwise
    let has_bash = sess.exec("command -v bash", None, Duration::from_secs(10)).await.map(|o| o.ok()).unwrap_or(false);
    let line = if has_bash { format!("bash -lc {}", sh_quote(&script)) } else { format!("sh -c {}", sh_quote(&script)) };
    let ch = sess.exec_stream(&line).await?;
    let (mut rd, wr) = ch.split();
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
    let (err_tx, err_rx) = mpsc::channel::<Vec<u8>>();
    let (in_tx, mut in_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let (close_tx, close_rx) = tokio::sync::oneshot::channel::<()>();
    let exit: Arc<Mutex<Option<Option<i32>>>> = Arc::new(Mutex::new(None));
    let pid: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));
    let (exit2, pid2) = (exit.clone(), pid.clone());
    tokio::spawn(async move {
        let mut first_err = true;
        let mut errbuf: Vec<u8> = vec![];
        let mut stdin_open = true;
        let mut close_rx = Some(close_rx);
        loop {
            tokio::select! {
                r = async { match close_rx.as_mut() { Some(rx) => (&mut *rx).await, None => std::future::pending().await } } => {
                    if r.is_ok() { let _ = wr.close().await; break; }
                    close_rx = None; // the handle was dropped without asking to close: keep running
                }
                inp = in_rx.recv(), if stdin_open => match inp {
                    Some(d) => { if wr.data_bytes(d).await.is_err() { break; } }
                    None => { stdin_open = false; let _ = wr.eof().await; }
                },
                m = rd.wait() => match m {
                    Some(ChannelMsg::Data { data }) => { if out_tx.send(data.to_vec()).is_err() { break; } }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if first_err {
                            errbuf.extend_from_slice(&data);
                            if let Some(i) = errbuf.iter().position(|b| *b == b'\n') {
                                let line = String::from_utf8_lossy(&errbuf[..i]).to_string();
                                if let Some(p) = line.trim().strip_prefix("CALLIO_PID=") { *pid2.lock().unwrap() = p.parse().ok(); }
                                let rest = errbuf[i + 1..].to_vec();
                                first_err = false;
                                if !rest.is_empty() { let _ = err_tx.send(rest); }
                            }
                        } else { let _ = err_tx.send(data.to_vec()); }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => { *exit2.lock().unwrap() = Some(Some(exit_status as i32)); }
                    Some(ChannelMsg::ExitSignal { .. }) => { *exit2.lock().unwrap() = Some(None); }
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
            }
        }
        if exit2.lock().unwrap().is_none() {
            *exit2.lock().unwrap() = Some(None);
        }
        // dropping the senders ends the readers
    });
    let rp = RemoteProc { sess, exit, pid, close: Mutex::new(Some(close_tx)), files: vec![], rport: None };
    Ok((rp, Io { stdin: ChanWrite(in_tx), stdout: ChanRead { rx: out_rx, buf: vec![], pos: 0 }, stderr: ChanRead { rx: err_rx, buf: vec![], pos: 0 } }))
}
