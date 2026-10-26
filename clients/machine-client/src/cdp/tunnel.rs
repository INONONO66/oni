//! The generic byte tunnel: a bounded loopback HTTP GET, a WebSocket
//! client upgrade, and one channel that forwards the upgraded socket's
//! bytes opaquely in both directions. Nothing here knows a browser.

use std::{
    hash::{BuildHasher, Hasher},
    io,
    net::Ipv4Addr,
    sync::{Mutex, PoisonError},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use sha1::{Digest, Sha1};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{
        tcp::{OwnedReadHalf, OwnedWriteHalf},
        TcpStream,
    },
    process::Child,
    task::AbortHandle,
};

/// `Machine.CDP_CHUNK_MAX_BYTES`: the decoded size bound of one chunk.
pub const CHUNK_MAX_BYTES: usize = 262_143;
const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 64 * 1024;
const ACCEPT_GUID: &str = "258EAFA5-E914-47A5-95CA-C5AB0DC85B11";

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

async fn head(stream: &mut TcpStream) -> io::Result<(String, Vec<u8>)> {
    let mut buffer = Vec::new();
    let mut piece = [0_u8; 4096];
    loop {
        if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buffer.split_off(end + 4);
            return Ok((String::from_utf8_lossy(&buffer).into_owned(), rest));
        }
        if buffer.len() > MAX_HEAD {
            return Err(invalid("response head too large"));
        }
        let read = stream.read(&mut piece).await?;
        if read == 0 {
            return Err(invalid("connection closed before the response head"));
        }
        buffer.extend_from_slice(&piece[..read]);
    }
}

fn status(head: &str) -> Option<u16> {
    head.split(' ').nth(1)?.parse().ok()
}

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then_some(value.trim())
    })
}

/// `GET path` on `127.0.0.1:port`; the body is bounded to 64 KiB.
pub async fn get(port: u16, path: &str) -> io::Result<Vec<u8>> {
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await?;
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await?;
    let (head, mut body) = head(&mut stream).await?;
    if status(&head) != Some(200) {
        return Err(invalid("discovery status is not 200"));
    }
    let length = header(&head, "content-length").and_then(|value| value.parse::<usize>().ok());
    let limit = length.unwrap_or(MAX_BODY + 1).min(MAX_BODY + 1);
    let missing = limit.saturating_sub(body.len());
    (&mut stream)
        .take(missing as u64)
        .read_to_end(&mut body)
        .await?;
    if body.len() > MAX_BODY || length.is_some_and(|length| body.len() != length) {
        return Err(invalid("discovery body is oversized or truncated"));
    }
    Ok(body)
}

fn nonce() -> String {
    let state = std::collections::hash_map::RandomState::new();
    let mut key = [0_u8; 16];
    for (index, half) in key.chunks_mut(8).enumerate() {
        let mut hasher = state.build_hasher();
        hasher.write_usize(index);
        half.copy_from_slice(&hasher.finish().to_le_bytes());
    }
    STANDARD.encode(key)
}

fn accept(key: &str) -> String {
    STANDARD.encode(Sha1::digest(format!("{key}{ACCEPT_GUID}").as_bytes()))
}

/// The RFC 6455 client upgrade of `path` on `127.0.0.1:port`; returns the
/// upgraded socket and any bytes the endpoint sent after its 101 head.
pub async fn upgrade(port: u16, path: &str) -> io::Result<(TcpStream, Vec<u8>)> {
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await?;
    let key = nonce();
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n\
         Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await?;
    let (head, rest) = head(&mut stream).await?;
    if status(&head) != Some(101) || header(&head, "sec-websocket-accept") != Some(&accept(&key)) {
        return Err(invalid("endpoint refused the upgrade"));
    }
    Ok((stream, rest))
}

pub enum Write {
    Accepted,
    Gap,
    Broken,
}

struct Inbound {
    last: i64,
    writer: OwnedWriteHalf,
}

/// One open tunnel: host-to-endpoint writes are ordered by `seq` under one
/// lock, so a slow endpoint holds back the host's next chunk.
pub struct Channel {
    pub id: String,
    inbound: tokio::sync::Mutex<Inbound>,
    child: Mutex<Option<Child>>,
    pump: Mutex<Option<AbortHandle>>,
}

impl Channel {
    pub fn new(id: String, writer: OwnedWriteHalf, child: Option<Child>) -> Self {
        Self {
            id,
            inbound: tokio::sync::Mutex::new(Inbound { last: -1, writer }),
            child: Mutex::new(child),
            pump: Mutex::new(None),
        }
    }

    pub fn pumping(&self, pump: AbortHandle) {
        *self.pump.lock().unwrap_or_else(PoisonError::into_inner) = Some(pump);
    }

    /// A repeat of the last accepted `seq` is accepted without a write.
    pub async fn write(&self, seq: i64, data: &[u8]) -> Write {
        let mut inbound = self.inbound.lock().await;
        if seq == inbound.last {
            return Write::Accepted;
        }
        if seq != inbound.last + 1 {
            return Write::Gap;
        }
        if inbound.writer.write_all(data).await.is_err() {
            return Write::Broken;
        }
        inbound.last = seq;
        Write::Accepted
    }

    /// Signals the launched process, if any, and hands it back for reaping.
    pub fn release(&self) -> Option<Child> {
        let mut child = self
            .child
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()?;
        // A process that already exited has nothing to signal; reaping follows.
        let _ = child.start_kill();
        Some(child)
    }

    /// Stops the endpoint-to-host pump, then releases the process.
    pub fn halt(&self) -> Option<Child> {
        if let Some(pump) = self
            .pump
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            pump.abort();
        }
        self.release()
    }
}

/// Reads the endpoint into chunks of at most [`CHUNK_MAX_BYTES`]; `send`
/// carries one chunk upstream and the next read waits for its answer.
pub async fn forward<S, F>(mut reader: OwnedReadHalf, leftover: Vec<u8>, mut send: S) -> bool
where
    S: FnMut(i64, Vec<u8>) -> F,
    F: std::future::Future<Output = bool>,
{
    let mut seq = 0;
    if !leftover.is_empty() {
        if !send(seq, leftover).await {
            return false;
        }
        seq = 1;
    }
    let mut buffer = vec![0_u8; CHUNK_MAX_BYTES];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => return true,
            Ok(read) => {
                if !send(seq, buffer[..read].to_vec()).await {
                    return false;
                }
                seq += 1;
            }
        }
    }
}
