//! CDP channels (#1662): `machine.cdp.open` reaches a loopback DevTools
//! endpoint named by the manifest (discovered or launched) and tunnels its
//! upgraded socket as opaque bytes; endpoint bytes go up as
//! `machine.cdp.chunk` calls on the attachment's uplink, one in flight per
//! channel. Every channel belongs to the attachment that opened it: detach
//! halts them all, and a reconnect starts with none.

pub mod chromium;
pub mod manifest;
pub mod tunnel;

use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use oni_protocol::{
    cdp_open_request::CdpOpenRequestEndpoint, CdpChunk, CdpChunkResult, CdpCloseRequest,
    CdpOpenRequest,
};
use serde_json::{json, Value};
use tokio::{net::TcpStream, process::Child, time::Instant};

use crate::{
    attach::{now_ms, Uplink},
    transport::request_table::CallError,
};
use manifest::Manifest;
use tunnel::{Channel, Write};

pub const MAX_CHANNELS: usize = 4;
pub const OPEN_DEADLINE: Duration = Duration::from_secs(30);
const MAX_CLOSED: usize = 64;
const MAX_MESSAGE: usize = 256;
const CHUNK: &str = "machine.cdp.chunk";
const CLOSE: &str = "machine.cdp.close";

type Connected = (TcpStream, Vec<u8>, Option<Child>);

#[derive(Default)]
struct State {
    uplink: Option<Uplink>,
    pending: HashSet<String>,
    live: HashMap<String, Arc<Channel>>,
    closed: VecDeque<String>,
}

impl State {
    /// Removes `channel` only while it is still the live channel of its id.
    fn retire(&mut self, channel: &Arc<Channel>) -> bool {
        let current = self
            .live
            .get(&channel.id)
            .is_some_and(|live| Arc::ptr_eq(live, channel));
        current.then(|| self.forget(&channel.id)).is_some()
    }

    fn forget(&mut self, id: &str) {
        self.live.remove(id);
        if self.closed.len() == MAX_CLOSED {
            self.closed.pop_front();
        }
        self.closed.push_back(id.to_owned());
    }
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

fn refused(reason: &str) -> Value {
    json!({"status":"refused","reason":reason})
}

fn refused_with(reason: &str, message: impl ToString) -> Value {
    let message: String = message.to_string().chars().take(MAX_MESSAGE).collect();
    json!({"status":"refused","reason":reason,"message":message})
}

fn accepted(answer: Result<Option<Value>, CallError>) -> bool {
    answer
        .ok()
        .flatten()
        .and_then(|value| oni_protocol::decode::<CdpChunkResult>(value).ok())
        .is_some_and(|result| matches!(result, CdpChunkResult::Accepted { .. }))
}

/// Reaps a signalled process; a wait error leaves nothing further to do.
async fn reap(child: Option<Child>) {
    if let Some(mut child) = child {
        let _ = child.wait().await;
    }
}

async fn pump(
    state: Arc<Mutex<State>>,
    channel: Arc<Channel>,
    (reader, leftover): (tokio::net::tcp::OwnedReadHalf, Vec<u8>),
    uplink: Uplink,
    deadline: Instant,
) {
    let id = channel.id.clone();
    let send = |seq: i64, data: Vec<u8>| {
        let (uplink, id) = (uplink.clone(), id.clone());
        async move {
            let chunk = json!({"channelId": id, "seq": seq, "data": STANDARD.encode(data)});
            accepted(uplink.call(CHUNK, chunk).await)
        }
    };
    let reason = tokio::select! {
        clean = tunnel::forward(reader, leftover, send) => if clean { "endpoint_closed" } else { "failed" },
        () = tokio::time::sleep_until(deadline) => "expired",
    };
    let retired = lock(&state).retire(&channel);
    reap(channel.release()).await;
    drop(channel);
    // Only the still-live channel tells the host; a closer that retired it
    // first owns the close. The host may already be gone, and its answer
    // carries nothing to act on.
    retired.then(|| {
        tokio::spawn(async move {
            let _ = uplink
                .call(CLOSE, json!({"channelId": id, "reason": reason}))
                .await;
        })
    });
}

pub struct Cdp {
    manifest: Manifest,
    deadline: Duration,
    state: Arc<Mutex<State>>,
}

impl Cdp {
    pub fn new(manifest: Manifest, deadline: Duration) -> Self {
        Self {
            manifest,
            deadline,
            state: Arc::default(),
        }
    }

    pub fn absent() -> Self {
        Self::new(Manifest::default(), OPEN_DEADLINE)
    }

    pub fn available(&self) -> bool {
        self.manifest.configured()
    }

    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    pub fn uplink(&self, uplink: Uplink) {
        self.state().uplink = Some(uplink);
    }

    fn reserve(&self, id: &str) -> Result<Uplink, Value> {
        let mut state = self.state();
        let uplink = state
            .uplink
            .clone()
            .ok_or_else(|| refused("machine_not_attached"))?;
        if state.live.contains_key(id) || state.pending.contains(id) {
            return Err(refused("already_open"));
        }
        if state.live.len() + state.pending.len() >= MAX_CHANNELS {
            return Err(refused("channel_limit"));
        }
        state.pending.insert(id.to_owned());
        Ok(uplink)
    }

    async fn discover(&self) -> Result<Connected, Value> {
        for &port in &self.manifest.ports {
            if let Some(path) = chromium::discover(port).await {
                let (stream, rest) = tunnel::upgrade(port, &path)
                    .await
                    .map_err(|error| refused_with("endpoint_not_found", error))?;
                return Ok((stream, rest, None));
            }
        }
        Err(refused("endpoint_not_found"))
    }

    async fn launch(&self, name: &str) -> Result<Connected, Value> {
        let entry = self
            .manifest
            .entry(name)
            .ok_or_else(|| refused("manifest_not_found"))?;
        let child = chromium::launch(entry)
            .await
            .map_err(|message| refused_with("launch_failed", message))?;
        let path = chromium::discover(entry.port)
            .await
            .ok_or_else(|| refused_with("launch_failed", "browser endpoint not discovered"))?;
        let (stream, rest) = tunnel::upgrade(entry.port, &path)
            .await
            .map_err(|error| refused_with("launch_failed", error))?;
        Ok((stream, rest, Some(child)))
    }

    async fn connect(&self, endpoint: &CdpOpenRequestEndpoint) -> Result<Connected, Value> {
        let connecting = async {
            match endpoint {
                CdpOpenRequestEndpoint::Discover => self.discover().await,
                CdpOpenRequestEndpoint::Launch(name) => self.launch(name).await,
            }
        };
        tokio::time::timeout(self.deadline, connecting)
            .await
            .unwrap_or_else(|_| Err(refused_with("endpoint_not_found", "open deadline elapsed")))
    }

    pub async fn open(&self, request: &CdpOpenRequest) -> Value {
        let id = request.channel_id.to_string();
        let uplink = match self.reserve(&id) {
            Ok(uplink) => uplink,
            Err(refusal) => return refusal,
        };
        let connected = self.connect(&request.endpoint).await;
        let mut state = self.state();
        if !state.pending.remove(&id) {
            return refused("machine_not_attached");
        }
        let (stream, leftover, child) = match connected {
            Ok(connected) => connected,
            Err(refusal) => return refusal,
        };
        let (reader, writer) = stream.into_split();
        let channel = Arc::new(Channel::new(id.clone(), writer, child));
        state.live.insert(id.clone(), channel.clone());
        drop(state);
        let lifetime = request.lifetime_ms.get();
        let deadline = Instant::now() + Duration::from_millis(lifetime);
        let pumping = pump(
            self.state.clone(),
            channel.clone(),
            (reader, leftover),
            uplink,
            deadline,
        );
        channel.pumping(tokio::spawn(pumping).abort_handle());
        json!({"status":"opened","channelId":id,"expiresAt":now_ms().saturating_add(lifetime)})
    }

    async fn end(&self, channel: &Arc<Channel>) -> bool {
        let retired = self.state().retire(channel);
        reap(channel.halt()).await;
        retired
    }

    pub async fn chunk(&self, request: &CdpChunk) -> Result<Value, String> {
        let data = STANDARD
            .decode(request.data.as_bytes())
            .map_err(|error| error.to_string())?;
        // The schema's exact base64 bound already caps `data` at CHUNK_MAX_BYTES.
        let id = request.channel_id.as_str();
        let found = self.state().live.get(id).cloned();
        let Some(channel) = found else {
            let closed = self.state().closed.iter().any(|closed| closed == id);
            return Ok(refused(if closed {
                "channel_closed"
            } else {
                "channel_not_found"
            }));
        };
        Ok(match channel.write(request.seq, &data).await {
            Write::Accepted => json!({"status":"accepted","seq":request.seq}),
            Write::Gap => refused("invalid_sequence"),
            Write::Broken => {
                self.end(&channel).await;
                refused("channel_closed")
            }
        })
    }

    pub async fn close(&self, request: &CdpCloseRequest) -> Value {
        let id = request.channel_id.as_str();
        let found = self.state().live.get(id).cloned();
        match found {
            Some(channel) if self.end(&channel).await => json!({"status":"closed","channelId":id}),
            _ => refused("channel_not_found"),
        }
    }

    /// Halts every channel of the ending attachment; their processes are
    /// reaped in the background.
    pub fn detach(&self) {
        let channels: Vec<Arc<Channel>> = {
            let mut state = self.state();
            state.uplink = None;
            state.pending.clear();
            state.closed.clear();
            state.live.drain().map(|(_, channel)| channel).collect()
        };
        for channel in channels {
            tokio::spawn(reap(channel.halt()));
        }
    }

    pub fn open_channels(&self) -> usize {
        self.state().live.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn stale(id: &str) -> (Arc<Channel>, tokio::net::tcp::OwnedReadHalf) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        let (near, far) = tokio::join!(TcpStream::connect(address), listener.accept());
        drop(far.expect("accept"));
        let (reader, writer) = near.expect("connect").into_split();
        (Arc::new(Channel::new(id.to_owned(), writer, None)), reader)
    }

    #[tokio::test]
    async fn a_channel_already_replaced_or_retired_is_left_alone() {
        let cdp = Cdp::absent();
        let (current, _) = stale("c").await;
        let (replaced, reader) = stale("c").await;
        cdp.state().live.insert("c".into(), current.clone());
        assert!(!cdp.end(&replaced).await);

        let (uplink, mut calls) = Uplink::channel();
        let far = Instant::now() + Duration::from_secs(60);
        pump(
            cdp.state.clone(),
            replaced,
            (reader, Vec::new()),
            uplink,
            far,
        )
        .await;
        assert!(calls.try_recv().is_err());
        assert_eq!(cdp.open_channels(), 1);
        assert!(cdp.end(&current).await);
        assert_eq!(cdp.open_channels(), 0);
    }
}
