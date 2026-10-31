//! One stream's WebRTC peer over str0m (sans-I/O): every call takes the
//! caller's `now`, so a test drives it on an injected clock and an in-memory
//! wire, and the live pump in [`super`] drives it from a Tokio loop with UDP
//! sockets. The peer offers one send-only H.264 track (plus an optional data
//! channel), takes the remote answer and candidates, and writes encoded
//! units as RTP; the remote's bandwidth estimate and keyframe requests feed
//! the [`Video`] budget.

use std::{collections::VecDeque, net::SocketAddr, time::Instant};

use str0m::{
    bwe::{Bitrate, BweKind},
    change::{SdpAnswer, SdpPendingOffer},
    channel::{Channel, ChannelId},
    format::Codec,
    media::{Direction, Frequency, MediaKind, MediaTime, Mid},
    net::{Protocol, Receive},
    Candidate, Event, IceConnectionState, Input, Output, Rtc,
};

use super::encoder::{Bounds, Video};

pub const CHANNEL: &str = "oni";
/// Relayed messages held while the data channel's open acknowledgement is
/// still in flight; the next one is refused as full.
pub const EARLY_RELAY: usize = 16;

/// One datagram for the transport to send.
#[derive(Debug, PartialEq, Eq)]
pub struct Datagram {
    pub source: SocketAddr,
    pub destination: SocketAddr,
    pub contents: Vec<u8>,
}

/// What [`Session::poll`] produced: datagrams to send and when to call
/// [`Session::tick`] next.
#[derive(Debug)]
pub struct Polled {
    pub datagrams: Vec<Datagram>,
    pub timeout: Instant,
}

/// The local offer: its SDP and one candidate line per local address.
pub struct Offer {
    pub sdp: String,
    pub candidates: Vec<String>,
}

pub struct Session {
    rtc: Rtc,
    video: Video,
    mid: Mid,
    channel: Option<ChannelId>,
    channel_open: bool,
    /// Relayed bytes that arrived while the negotiated channel's open
    /// acknowledgement was still in flight; written on `ChannelOpen`.
    early: VecDeque<Vec<u8>>,
    pending: Option<SdpPendingOffer>,
    connected: bool,
    failed: bool,
    started: Instant,
    frame_seq: u64,
}

fn failure(error: impl ToString) -> String {
    error.to_string()
}

impl Session {
    /// A peer gathering on `locals` with a send-only video track; the data
    /// channel only when asked for.
    pub fn offer(
        bounds: Bounds,
        data_channel: bool,
        locals: &[SocketAddr],
        now: Instant,
    ) -> Result<(Self, Offer), String> {
        let video = Video::new(bounds)?;
        let mut rtc = Rtc::builder()
            .clear_codecs()
            .enable_h264(true)
            .enable_bwe(Some(Bitrate::bps(bounds.max_bitrate)))
            .build(now);
        let mut candidates = Vec::new();
        for local in locals {
            let candidate = Candidate::host(*local, "udp").map_err(failure)?;
            candidates.push(candidate.to_sdp_string());
            rtc.add_local_candidate(candidate);
        }
        rtc.bwe()
            .set_desired_bitrate(Bitrate::bps(bounds.max_bitrate));
        let mut changes = rtc.sdp_api();
        let mid = changes.add_media(MediaKind::Video, Direction::SendOnly, None, None, None);
        let channel = data_channel.then(|| changes.add_channel(CHANNEL.to_owned()));
        let (offer, pending) = changes.apply().ok_or("no offer to negotiate")?;
        let session = Self {
            rtc,
            video,
            mid,
            channel,
            channel_open: false,
            early: VecDeque::new(),
            pending: Some(pending),
            connected: false,
            failed: false,
            started: now,
            frame_seq: 0,
        };
        Ok((
            session,
            Offer {
                sdp: offer.to_sdp_string(),
                candidates,
            },
        ))
    }

    /// A malformed answer leaves the offer pending for a corrected one; an
    /// answer the peer rejects fails the session, which then closes.
    pub fn answer(&mut self, sdp: &str) -> Result<(), String> {
        let pending = self
            .pending
            .take()
            .ok_or_else(|| "no offer awaits an answer".to_owned())?;
        let answer = match SdpAnswer::from_sdp_string(sdp) {
            Ok(answer) => answer,
            Err(error) => {
                self.pending = Some(pending);
                return Err(failure(error));
            }
        };
        let accepted = self.rtc.sdp_api().accept_answer(pending, answer);
        self.failed |= accepted.is_err();
        accepted.map_err(failure)
    }

    /// A browser hides its host addresses behind mDNS `.local` names this
    /// peer does not resolve: such a candidate is skipped, and the viewer is
    /// learned peer-reflexively from its own checks against this peer's host
    /// candidate, as on any network where the viewer's address is private.
    pub fn candidate(&mut self, line: &str) -> Result<(), String> {
        let address = line.split_whitespace().nth(4);
        if address.is_some_and(|address| address.ends_with(".local")) {
            return Ok(());
        }
        let candidate = Candidate::from_sdp_string(line).map_err(failure)?;
        self.rtc.add_remote_candidate(candidate);
        Ok(())
    }

    /// Writes relayed bytes into this stream's negotiated data channel. The
    /// viewer learns the channel is open before this peer sees its
    /// acknowledgement, so bytes relayed in that window are queued (bounded
    /// by [`EARLY_RELAY`]) and written on `ChannelOpen` rather than refused.
    pub fn data(&mut self, label: &str, bytes: &[u8]) -> Result<(), String> {
        let id = self
            .channel
            .filter(|_| label == CHANNEL)
            .ok_or_else(|| format!("no open data channel {label}"))?;
        match self.rtc.channel(id) {
            Some(channel) => Self::write(channel, bytes),
            None if self.early.len() < EARLY_RELAY => {
                self.early.push_back(bytes.to_vec());
                Ok(())
            }
            None => Err("data channel is full".to_owned()),
        }
    }

    fn write(mut channel: Channel<'_>, bytes: &[u8]) -> Result<(), String> {
        if channel.write(true, bytes).map_err(failure)? {
            Ok(())
        } else {
            Err("data channel is full".to_owned())
        }
    }

    /// A datagram that is not STUN, DTLS or (S)RTP is not for this peer and
    /// is discarded; one the peer rejects fails the stream.
    pub fn receive(
        &mut self,
        now: Instant,
        source: SocketAddr,
        destination: SocketAddr,
        datagram: &[u8],
    ) -> Result<(), String> {
        let Ok(receive) = Receive::new(Protocol::Udp, source, destination, datagram) else {
            return Ok(());
        };
        self.rtc
            .handle_input(Input::Receive(now, receive))
            .map_err(failure)
    }

    pub fn tick(&mut self, now: Instant) -> Result<(), String> {
        self.rtc.handle_input(Input::Timeout(now)).map_err(failure)
    }

    /// Drains the peer: datagrams to send, events folded into the budget,
    /// and the next timeout; a lost peer is an error.
    pub fn poll(&mut self) -> Result<Polled, String> {
        let mut datagrams = Vec::new();
        loop {
            match self.rtc.poll_output().map_err(failure)? {
                Output::Timeout(_) if self.failed() => return Err("peer disconnected".to_owned()),
                Output::Timeout(timeout) => return Ok(Polled { datagrams, timeout }),
                Output::Transmit(transmit) => datagrams.push(Datagram {
                    source: transmit.source,
                    destination: transmit.destination,
                    contents: transmit.contents.into(),
                }),
                Output::Event(event) => self.event(event)?,
            }
        }
    }

    fn event(&mut self, event: Event) -> Result<(), String> {
        match event {
            Event::Connected => self.connected = true,
            Event::ChannelOpen(id, _) if Some(id) == self.channel => {
                self.channel_open = true;
                while let Some(bytes) = self.early.pop_front() {
                    let channel = self.rtc.channel(id).ok_or("data channel closed")?;
                    Self::write(channel, &bytes)?;
                }
            }
            Event::IceConnectionStateChange(IceConnectionState::Disconnected) => {
                self.failed = true;
            }
            Event::KeyframeRequest(_) => self.video.budget.request_keyframe(),
            Event::EgressBitrateEstimate(
                BweKind::Twcc { estimate, .. } | BweKind::Remb { estimate, .. },
            ) => self.video.estimate(estimate.as_u64())?,
            _ => {}
        }
        Ok(())
    }

    /// Connected and not since lost.
    pub fn live(&self) -> bool {
        self.connected && !self.failed && (self.channel.is_none() || self.channel_open)
    }

    pub fn failed(&self) -> bool {
        self.failed || !self.rtc.is_alive()
    }

    /// When the next frame is due, once media can flow.
    pub fn next_frame(&self, now: Instant) -> Option<Instant> {
        self.live()
            .then(|| self.video.budget.next().map_or(now, |next| next.max(now)))
    }

    /// The side the next frame is scaled to.
    pub fn dimension(&self) -> u32 {
        self.video.budget.quality().dimension
    }

    pub fn due(&mut self, now: Instant) -> bool {
        self.live() && self.video.budget.due(now)
    }

    /// Encodes and sends the frame admitted at `now`; false when it was dropped.
    pub fn frame(
        &mut self,
        now: Instant,
        captured_at_us: u64,
        rgba: &[u8],
        size: (u32, u32),
    ) -> Result<bool, String> {
        let Some((unit, _)) = self.video.encode(now, rgba, size)? else {
            return Ok(false);
        };
        if let Some(id) = self.channel {
            let sidecar =
                serde_json::json!({"seq": self.frame_seq, "capturedAtUs": captured_at_us});
            let bytes = serde_json::to_vec(&sidecar).map_err(failure)?;
            let mut channel = self.rtc.channel(id).ok_or("data channel closed")?;
            if !channel.write(true, &bytes).map_err(failure)? {
                self.video.stats.frames -= 1;
                self.video.stats.bytes -= unit.len() as u64;
                self.video.backlog()?;
                return Ok(false);
            }
        }
        let writer = self
            .rtc
            .writer(self.mid)
            .ok_or("video track not negotiated")?;
        let pt = writer
            .payload_params()
            .find(|params| params.spec().codec == Codec::H264)
            .map(|params| params.pt())
            .ok_or("H.264 not negotiated")?;
        let elapsed = now.duration_since(self.started).as_micros();
        let rtp = MediaTime::new((elapsed * 9 / 100) as u64, Frequency::NINETY_KHZ);
        writer.write(pt, now, rtp, unit).map_err(failure)?;
        self.frame_seq = self.frame_seq.wrapping_add(1);
        Ok(true)
    }

    /// `blocked` datagrams of one batch found the transport full: back off
    /// once; a batch with none leaves the budget alone.
    pub fn congested(&mut self, blocked: usize) -> Result<(), String> {
        if blocked == 0 {
            return Ok(());
        }
        self.video.backlog()
    }

    /// A due frame the screen could not capture.
    pub fn skipped(&mut self) {
        self.video.stats.dropped += 1;
    }

    pub fn stats(&self) -> super::encoder::Stats {
        self.video.stats
    }

    pub fn quality(&self) -> super::encoder::Quality {
        self.video.budget.quality()
    }

    pub fn retained(&self) -> usize {
        self.video.retained()
    }

    pub fn close(&mut self) {
        self.rtc.disconnect();
    }
}
