//! Live screen streams (#1662). `machine.stream.open` validates the source
//! with a first capture from the screen's frame pool, binds one UDP socket
//! and starts a [`session::Session`] (str0m, sans-I/O) pumped by one Tokio
//! task: the offer, its candidates and `end_of_candidates` go up as
//! `machine.stream.signal` calls on the attachment's uplink, the host's
//! answer and candidates come back the same way, and H.264 units from
//! [`encoder`] flow as SRTP to the viewer. Every queue is bounded (the
//! inbound signal queue, one frame in capture, the socket's send buffer);
//! a full send buffer drops the frame and backs the quality off. Streams
//! belong to the attachment: detach aborts them, revoke and memory
//! pressure close them with `failed`, and expiry closes with `expired`.

pub mod encoder;
pub mod session;

use std::{
    collections::{HashMap, HashSet, VecDeque},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use oni_protocol::{
    stream_open_request::StreamOpenRequestSource, stream_signal_request::StreamSignalRequestSignal,
    StreamCloseRequest, StreamOpenRequest, StreamSignalRequest, StreamSignalResult,
};
use serde_json::{json, Value};
use tokio::{
    net::UdpSocket,
    sync::{mpsc, oneshot},
    task::AbortHandle,
};

use crate::{
    attach::{now_ms, Uplink},
    screen::{Fault, Screen},
};
use encoder::{Bounds, Stats};
use session::{Datagram, Session};

pub const MAX_STREAMS: usize = 4;
pub const MAX_FPS: u32 = 60;
pub const MAX_ENCODE_MS: f64 = 60_000.0;
/// Inbound signals queued for one stream before `signal_limit`.
pub const SIGNAL_QUEUE: usize = 32;
const DATAGRAM: usize = 2048;
const MAX_CLOSED: usize = 64;
const MAX_MESSAGE: usize = 256;
const SIGNAL: &str = "machine.stream.signal";
const CLOSE: &str = "machine.stream.close";

type Reply = oneshot::Sender<Result<(), String>>;

#[derive(Clone, Copy, Default)]
struct Meter {
    stats: Stats,
    retained: usize,
}

struct Live {
    epoch: u64,
    inbox: mpsc::Sender<(StreamSignalRequestSignal, Reply)>,
    abort: Option<AbortHandle>,
    expected: u16,
    /// The last seq the pump applied; only it replays as accepted.
    accepted: Option<u16>,
    meter: Arc<Mutex<Meter>>,
    reported: (Stats, Instant),
}

#[derive(Default)]
struct State {
    uplink: Option<Uplink>,
    epoch: u64,
    pending: HashSet<String>,
    live: HashMap<String, Live>,
    closed: VecDeque<String>,
}

impl State {
    /// Removes `id` only while `epoch` is still its live stream.
    fn retire(&mut self, id: &str, epoch: u64) -> bool {
        let current = self.live.get(id).is_some_and(|live| live.epoch == epoch);
        current.then(|| self.forget(id)).is_some()
    }

    /// The stream's own task retiring itself: disarm its abort handle first,
    /// or the abort would cancel the close it still owes the host.
    fn settle(&mut self, id: &str, epoch: u64) -> bool {
        if let Some(live) = self.live.get_mut(id).filter(|live| live.epoch == epoch) {
            live.abort = None;
        }
        self.retire(id, epoch)
    }

    fn forget(&mut self, id: &str) {
        if let Some(abort) = self.live.remove(id).and_then(|live| live.abort) {
            abort.abort();
        }
        if self.closed.len() == MAX_CLOSED {
            self.closed.pop_front();
        }
        self.closed.push_back(id.to_owned());
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn refused(reason: &str) -> Value {
    json!({"status":"refused","reason":reason})
}

fn refused_with(reason: &str, message: impl ToString) -> Value {
    let message: String = message.to_string().chars().take(MAX_MESSAGE).collect();
    json!({"status":"refused","reason":reason,"message":message})
}

fn unavailable(error: impl ToString) -> Value {
    refused_with("stream_not_available", error)
}

fn failure(error: impl ToString) -> String {
    error.to_string()
}

fn fault_refusal(fault: &Fault) -> Value {
    match fault {
        Fault::Permission => refused("permission_denied"),
        Fault::DisplayNotFound => refused("display_not_found"),
        Fault::WindowNotFound => refused("window_not_found"),
        Fault::Failed(message) => refused_with("stream_not_available", message),
        other => refused_with("stream_not_available", format!("{other:?}")),
    }
}

fn bounds(request: &StreamOpenRequest) -> Bounds {
    let video = &request.video;
    let clamp = |value: std::num::NonZeroU64, max: u64| value.get().min(max);
    Bounds {
        max_fps: clamp(video.max_fps, u64::from(MAX_FPS)) as u32,
        keyframe_interval: Duration::from_millis(video.keyframe_interval_ms.max(1) as u64),
        max_bitrate: video.max_bitrate_bps.get(),
        max_dimension: video
            .max_dimension
            .clamp(2, i64::from(crate::screen::MAX_DIMENSION)) as u32,
        max_frame_bytes: clamp(video.max_frame_bytes, u64::MAX) as usize,
    }
}

/// The interface address a host candidate is gathered on: the one the
/// routing table picks for outbound traffic, else loopback.
pub fn local_address() -> IpAddr {
    std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .and_then(|socket| {
            socket.connect((Ipv4Addr::new(192, 0, 2, 1), 9))?;
            socket.local_addr()
        })
        .map_or(IpAddr::V4(Ipv4Addr::LOCALHOST), |address| address.ip())
}

fn accepted(answer: Result<Option<Value>, crate::transport::request_table::CallError>) -> bool {
    answer
        .ok()
        .flatten()
        .and_then(|value| oni_protocol::decode::<StreamSignalResult>(value).ok())
        .is_some_and(|result| matches!(result, StreamSignalResult::Accepted { .. }))
}

struct Pump {
    session: Session,
    socket: UdpSocket,
    local: SocketAddr,
    inbox: mpsc::Receiver<(StreamSignalRequestSignal, Reply)>,
    screen: Arc<Screen>,
    source: StreamOpenRequestSource,
    frame: Vec<u8>,
    meter: Arc<Mutex<Meter>>,
    deadline: Instant,
}

impl Pump {
    /// Sends every datagram; a full send buffer backs the quality off once
    /// per batch. Other failures (an unreachable candidate) are ICE's to judge.
    fn send(&mut self, datagrams: &[Datagram]) -> Result<(), String> {
        let backlog = datagrams
            .iter()
            .filter(|datagram| {
                self.socket
                    .try_send_to(&datagram.contents, datagram.destination)
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::WouldBlock)
            })
            .count();
        self.session.congested(backlog)
    }

    fn apply(&mut self, signal: StreamSignalRequestSignal) -> Result<(), String> {
        match signal {
            StreamSignalRequestSignal::Answer { sdp } => self.session.answer(&sdp),
            StreamSignalRequestSignal::Candidate { candidate, .. } => {
                self.session.candidate(&candidate)
            }
            StreamSignalRequestSignal::EndOfCandidates => Ok(()),
            StreamSignalRequestSignal::Data { label, data } => {
                let bytes = STANDARD.decode(data.as_bytes()).map_err(failure)?;
                self.session.data(&label, &bytes)
            }
            StreamSignalRequestSignal::Offer { .. } => Err("this peer is the offerer".to_owned()),
        }
    }

    async fn capture(&mut self, now: Instant) -> Result<(), String> {
        let (screen, source) = (self.screen.clone(), self.source.clone());
        let (dimension, mut frame) = (self.session.dimension(), std::mem::take(&mut self.frame));
        let (frame, captured) = tokio::task::spawn_blocking(move || {
            let captured = screen.frame(&source, dimension, &mut frame);
            (frame, captured)
        })
        .await
        .map_err(failure)?;
        self.frame = frame;
        match captured {
            Ok(size) => self.session.frame(now, &self.frame, size).map(drop),
            Err(Fault::Failed(_)) => {
                self.session.skipped();
                Ok(())
            }
            Err(fault) => Err(format!("capture source lost: {fault:?}")),
        }
    }

    async fn serve(&mut self) -> Result<(), String> {
        let mut buffer = vec![0_u8; DATAGRAM];
        loop {
            let polled = self.session.poll()?;
            self.send(&polled.datagrams)?;
            *lock(&self.meter) = Meter {
                stats: self.session.stats(),
                retained: self.session.retained() + self.frame.capacity() + DATAGRAM,
            };
            let wake = [Some(polled.timeout), Some(self.deadline)]
                .into_iter()
                .chain([self.session.next_frame(Instant::now())])
                .flatten()
                .min()
                .unwrap_or(self.deadline);
            tokio::select! {
                Some((signal, reply)) = self.inbox.recv() => {
                    let _ = reply.send(self.apply(signal));
                }
                received = self.socket.recv_from(&mut buffer) => {
                    let (length, source) = received.map_err(failure)?;
                    self.session.receive(Instant::now(), source, self.local, &buffer[..length])?;
                }
                () = tokio::time::sleep_until(wake.into()) => {}
            }
            let now = Instant::now();
            if now >= self.deadline {
                return Ok(());
            }
            self.session.tick(now)?;
            if self.session.due(now) {
                self.capture(now).await?;
            }
        }
    }
}

async fn signal(uplink: &Uplink, id: &str, seq: &mut u8, signal: Value) -> Result<(), String> {
    let call = json!({"streamId": id, "seq": *seq, "signal": signal});
    *seq = seq.wrapping_add(1);
    if accepted(uplink.call(SIGNAL, call).await) {
        Ok(())
    } else {
        Err("host refused the signal".to_owned())
    }
}

async fn negotiate(uplink: &Uplink, id: &str, offer: session::Offer) -> Result<(), String> {
    let mut seq = 0;
    signal(
        uplink,
        id,
        &mut seq,
        json!({"type":"offer","sdp":offer.sdp}),
    )
    .await?;
    for candidate in offer.candidates {
        let line = json!({"type":"candidate","candidate":candidate,"sdpMLineIndex":0});
        signal(uplink, id, &mut seq, line).await?;
    }
    signal(uplink, id, &mut seq, json!({"type":"end_of_candidates"})).await
}

async fn pump(
    state: Arc<Mutex<State>>,
    (id, epoch): (String, u64),
    mut pump: Pump,
    offer: session::Offer,
    uplink: Uplink,
) {
    let outcome = match negotiate(&uplink, &id, offer).await {
        Ok(()) => pump.serve().await,
        Err(error) => Err(error),
    };
    pump.session.close();
    let reason = if outcome.is_ok() { "expired" } else { "failed" };
    // Only the still-live stream tells the host; a closer that retired it
    // first owns the close. The host may already be gone.
    let close = lock(&state)
        .settle(&id, epoch)
        .then(|| json!({"streamId": id, "reason": reason}));
    let Some(params) = close else { return };
    let _ = uplink.call(CLOSE, params).await;
}

pub struct Stream {
    address: IpAddr,
    state: Arc<Mutex<State>>,
}

impl Stream {
    /// Streams gather host candidates on `address`.
    pub fn new(address: IpAddr) -> Self {
        Self {
            address,
            state: Arc::default(),
        }
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
        if state.live.len() + state.pending.len() >= MAX_STREAMS {
            return Err(refused("stream_limit"));
        }
        state.pending.insert(id.to_owned());
        Ok(uplink)
    }

    async fn prepare(
        &self,
        request: &StreamOpenRequest,
        screen: &Arc<Screen>,
    ) -> Result<(Pump, session::Offer), Value> {
        let bounds = bounds(request);
        let (shared, source) = (screen.clone(), request.source.clone());
        let mut frame = Vec::new();
        tokio::task::spawn_blocking(move || {
            shared
                .frame(&source, bounds.max_dimension, &mut frame)
                .map(|_| frame)
        })
        .await
        .map_err(unavailable)?
        .map_err(|fault| fault_refusal(&fault))
        .and_then(|frame| {
            let (socket, local) = std::net::UdpSocket::bind((self.address, 0))
                .and_then(|socket| {
                    socket.set_nonblocking(true)?;
                    let local = socket.local_addr()?;
                    Ok((UdpSocket::from_std(socket)?, local))
                })
                .map_err(unavailable)?;
            let (session, offer) =
                Session::offer(bounds, request.data_channel, &[local], Instant::now())
                    .map_err(|error| refused_with("encoder_failed", error))?;
            let (_, inbox) = mpsc::channel(1);
            // Owned from here, before negotiation: the encoder, the captured
            // frame and the receive buffer the pump allocates.
            let meter = Arc::new(Mutex::new(Meter {
                stats: Stats::default(),
                retained: session.retained() + frame.capacity() + DATAGRAM,
            }));
            let pump = Pump {
                session,
                socket,
                local,
                inbox,
                screen: screen.clone(),
                source: request.source.clone(),
                frame,
                meter,
                deadline: Instant::now() + Duration::from_millis(request.lifetime_ms.get()),
            };
            Ok((pump, offer))
        })
    }

    pub async fn open(&self, request: &StreamOpenRequest, screen: &Arc<Screen>) -> Value {
        let id = request.stream_id.to_string();
        let uplink = match self.reserve(&id) {
            Ok(uplink) => uplink,
            Err(refusal) => return refusal,
        };
        let prepared = self.prepare(request, screen).await;
        let mut state = self.state();
        if !state.pending.remove(&id) {
            return refused("machine_not_attached");
        }
        let (mut prepared, offer) = match prepared {
            Ok(prepared) => prepared,
            Err(refusal) => return refusal,
        };
        let (inbox, queue) = mpsc::channel(SIGNAL_QUEUE);
        prepared.inbox = queue;
        state.epoch += 1;
        let epoch = state.epoch;
        let meter = prepared.meter.clone();
        let task = tokio::spawn(pump(
            self.state.clone(),
            (id.clone(), epoch),
            prepared,
            offer,
            uplink,
        ));
        state.live.insert(
            id.clone(),
            Live {
                epoch,
                inbox,
                abort: Some(task.abort_handle()),
                expected: 0,
                accepted: None,
                meter,
                reported: (Stats::default(), Instant::now()),
            },
        );
        let lifetime = request.lifetime_ms.get();
        json!({"status":"opened","streamId":id,"expiresAt":now_ms().saturating_add(lifetime)})
    }

    pub async fn signal(&self, request: &StreamSignalRequest) -> Value {
        let id = request.stream_id.as_str();
        let seq = u16::from(request.seq);
        let reply = {
            let mut state = self.state();
            let closed = state.closed.iter().any(|closed| closed == id);
            let Some(live) = state.live.get_mut(id) else {
                return refused(if closed {
                    "stream_expired"
                } else {
                    "stream_not_found"
                });
            };
            if live.accepted == Some(seq) {
                return json!({"status":"accepted","seq":request.seq});
            }
            if seq != live.expected {
                return refused("invalid_sequence");
            }
            let (reply, answer) = oneshot::channel();
            if live
                .inbox
                .try_send((request.signal.clone(), reply))
                .is_err()
            {
                return refused("signal_limit");
            }
            live.expected += 1;
            (live.epoch, answer)
        };
        let (epoch, reply) = reply;
        let applied = reply.await;
        self.settle_signal(id, epoch, seq, matches!(applied, Ok(Ok(()))));
        match applied {
            Ok(Ok(())) => json!({"status":"accepted","seq":request.seq}),
            Ok(Err(message)) => refused_with("invalid_signal", message),
            Err(_) => refused("stream_expired"),
        }
    }

    /// Records the pump's verdict on `seq`: an applied signal becomes the
    /// one replayable seq, a refused one hands its seq back to the sender.
    fn settle_signal(&self, id: &str, epoch: u64, seq: u16, applied: bool) {
        let mut state = self.state();
        let Some(live) = state.live.get_mut(id).filter(|live| live.epoch == epoch) else {
            return;
        };
        if applied {
            live.accepted = Some(seq);
        } else if live.expected == seq + 1 {
            live.expected = seq;
        }
    }

    pub fn close(&self, request: &StreamCloseRequest) -> Value {
        let id = request.stream_id.as_str();
        let mut state = self.state();
        match state.live.get(id).map(|live| live.epoch) {
            Some(epoch) if state.retire(id, epoch) => json!({"status":"closed","streamId":id}),
            _ => refused("stream_not_found"),
        }
    }

    /// Closes every stream with `failed` (revoke, memory pressure); the
    /// host is told on the attachment's uplink.
    pub fn fail_all(&self) {
        let (uplink, ids) = {
            let mut state = self.state();
            let ids: Vec<String> = state.live.keys().cloned().collect();
            for id in &ids {
                state.forget(id);
            }
            (state.uplink.clone(), ids)
        };
        if let Some(uplink) = uplink {
            tokio::spawn(async move {
                for id in ids {
                    let _ = uplink
                        .call(CLOSE, json!({"streamId": id, "reason": "failed"}))
                        .await;
                }
            });
        }
    }

    /// Aborts every stream of the ending attachment.
    pub fn detach(&self) {
        let mut state = self.state();
        state.uplink = None;
        state.pending.clear();
        let ids: Vec<String> = state.live.keys().cloned().collect();
        for id in &ids {
            state.forget(id);
        }
        state.closed.clear();
    }

    pub fn open_streams(&self) -> usize {
        self.state().live.len()
    }

    pub fn retained(&self) -> usize {
        self.state()
            .live
            .values()
            .map(|live| lock(&live.meter).retained)
            .sum()
    }

    /// One observation per live stream over the window since the last call.
    pub fn observations(&self) -> Vec<Value> {
        let now = Instant::now();
        let mut state = self.state();
        let mut rows: Vec<Value> = state
            .live
            .iter_mut()
            .map(|(id, live)| {
                let meter = *lock(&live.meter);
                let (earlier, at) = live.reported;
                let rates = meter.stats.rates(&earlier, now.duration_since(at));
                live.reported = (meter.stats, now);
                json!({
                    "streamId": id, "fps": rates.fps, "bytesPerSecond": rates.bytes_per_second,
                    "encodeMs": rates.encode_ms, "droppedFrames": rates.dropped_frames,
                    "retainedBytes": meter.retained
                })
            })
            .collect();
        rows.sort_by(|a, b| a["streamId"].as_str().cmp(&b["streamId"].as_str()));
        rows
    }
}
