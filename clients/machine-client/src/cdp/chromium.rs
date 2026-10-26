//! The Chromium dialect: the only module that knows a browser. It owns the
//! DevTools discovery path and its version JSON, the browser-endpoint
//! selection rule, the launch flags and the readiness line on stderr.

use std::{ffi::OsString, process::Stdio};

use serde::Deserialize;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::{Child, ChildStderr, Command},
};

use super::{manifest::Launch, tunnel};

pub const VERSION_PATH: &str = "/json/version";
const READY: &str = "DevTools listening on ";
const MAX_READY_LINES: usize = 64;
const MAX_LINE: u64 = 4096;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Version {
    web_socket_debugger_url: String,
}

/// The browser target path of `url` only when it is `ws://` on the
/// loopback interface at exactly `port`: a version reply that points
/// anywhere else is not this endpoint.
fn target(url: &str, port: u16) -> Option<String> {
    let rest = url.strip_prefix("ws://")?;
    let (authority, path) = rest.split_at(rest.find('/')?);
    let (host, found) = authority.rsplit_once(':')?;
    let loopback = matches!(host, "127.0.0.1" | "localhost");
    (loopback && found.parse::<u16>().ok()? == port).then(|| path.to_owned())
}

pub fn endpoint(body: &[u8], port: u16) -> Option<String> {
    let version: Version = serde_json::from_slice(body).ok()?;
    target(&version.web_socket_debugger_url, port)
}

pub async fn discover(port: u16) -> Option<String> {
    endpoint(&tunnel::get(port, VERSION_PATH).await.ok()?, port)
}

fn flag(name: &str, value: impl Into<OsString>) -> OsString {
    let mut flag = OsString::from(name);
    flag.push(value.into());
    flag
}

pub fn command(entry: &Launch) -> Command {
    let mut command = Command::new(&entry.binary);
    command
        .args(&entry.args)
        .arg(flag("--remote-debugging-port=", entry.port.to_string()))
        .arg(flag("--user-data-dir=", &entry.profile))
        .args(["--no-first-run", "--no-default-browser-check"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

/// Waits for the readiness line naming `port`; afterwards stderr is
/// drained so the browser never blocks on a full pipe.
async fn ready(stderr: ChildStderr, port: u16) -> bool {
    let mut reader = BufReader::new(stderr);
    let mut line = Vec::new();
    for _ in 0..MAX_READY_LINES {
        line.clear();
        let read = (&mut reader)
            .take(MAX_LINE)
            .read_until(b'\n', &mut line)
            .await;
        if !matches!(read, Ok(1..)) {
            return false;
        }
        let text = String::from_utf8_lossy(&line);
        if let Some(url) = text.trim_end().strip_prefix(READY) {
            if target(url, port).is_some() {
                tokio::spawn(
                    async move { tokio::io::copy(&mut reader, &mut tokio::io::sink()).await },
                );
                return true;
            }
        }
    }
    false
}

pub async fn launch(entry: &Launch) -> Result<Child, String> {
    let mut child = command(entry).spawn().map_err(|error| error.to_string())?;
    let stderr = child.stderr.take().ok_or("stderr is not piped")?;
    if ready(stderr, entry.port).await {
        Ok(child)
    } else {
        Err("browser exited before announcing its DevTools endpoint".to_owned())
    }
}
