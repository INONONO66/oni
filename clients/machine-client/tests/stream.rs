use std::{
    future::Future,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    num::NonZeroU64,
    path::Path,
    pin::Pin,
    sync::{mpsc as blocking, Arc, Mutex},
    task::{Context, Poll, Waker},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use oni_machine_client::{
    attach::{Hooks, Negotiated, Session as Attachment, Uplink, UplinkCall},
    budget::Pressure,
    cdp::Cdp,
    config::ClientConfig,
    handlers::Service,
    input::Input,
    pty::ops::Pty,
    screen::{fixture::Fixture as Frames, Display, Fault, Screen, Source, Window},
    stream::{
        encoder::{Bounds, Budget, Encoder, Quality, Stats, Video, MIN_BITRATE},
        local_address,
        session::{Session, CHANNEL, EARLY_RELAY},
        MAX_ENCODE_MS, MAX_FPS, MAX_STREAMS, SIGNAL_QUEUE,
    },
};
use serde_json::{json, Value};
use str0m::{
    change::SdpOffer,
    media::{KeyframeRequestKind, Mid},
    net::{Protocol, Receive},
    Candidate, Event, Input as RtcInput, Output, Rtc,
};
use tempfile::TempDir;
use tokio::{net::UdpSocket, sync::mpsc};

const COMPUTER_USE: &str = "computer.use";
const LONG: Duration = Duration::from_secs(30);
const OFFERER: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)), 5000);
const VIEWER: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2)), 6000);
const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
/// A candidate a loopback socket cannot send to: checks towards it fail in
/// the kernel and the stream still connects over the reachable one.
const UNREACHABLE: &str = "candidate:9 1 udp 2130706431 192.0.2.1 9 typ host";

/// Bounds whose bitrate cap sits below any estimate on the in-memory wire,
/// so the transport's estimate never retunes the encoder.
fn capped(fps: u32, keyframe: Duration) -> Bounds {
    Bounds {
        max_bitrate: MIN_BITRATE,
        ..bounds(fps, keyframe)
    }
}

fn bounds(fps: u32, keyframe: Duration) -> Bounds {
    Bounds {
        max_fps: fps,
        keyframe_interval: keyframe,
        max_bitrate: 1_000_000,
        max_dimension: 64,
        max_frame_bytes: 1 << 20,
    }
}

fn noise(width: u32, height: u32, seed: u32) -> Vec<u8> {
    let mut state = seed.wrapping_mul(2_654_435_761) | 1;
    let mut pixels = Vec::new();
    for _ in 0..width * height {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        pixels.extend_from_slice(&[state as u8, (state >> 8) as u8, (state >> 16) as u8, 255]);
    }
    pixels
}

#[test]
fn the_budget_caps_fps_on_its_own_cadence() {
    let start = Instant::now();
    let period = Duration::from_millis(100);
    let mut budget = Budget::new(bounds(10, Duration::from_secs(1)));
    assert_eq!(budget.next(), None);
    assert!(budget.due(start));
    assert_eq!(budget.next(), Some(start + period));
    assert!(!budget.due(start + period / 2));
    assert!(budget.due(start + period + Duration::from_millis(5)));
    assert_eq!(budget.next(), Some(start + period * 2));
    let late = start + Duration::from_secs(2);
    assert!(budget.due(late));
    assert_eq!(budget.next(), Some(late + period));
    assert!(!budget.due(late + period / 2));
}

#[test]
fn the_budget_adapts_inside_the_bounds() {
    let bounds = bounds(30, Duration::from_secs(2));
    let full = Quality {
        bitrate: 1_000_000,
        fps: 30,
        dimension: 64,
    };
    let mut budget = Budget::new(bounds);
    assert_eq!(budget.quality(), full);
    assert!(
        !budget.estimate(u64::MAX),
        "an estimate above the cap is the cap"
    );
    assert_eq!(budget.quality(), full);
    assert!(budget.estimate(0));
    let floor = Quality {
        bitrate: MIN_BITRATE,
        fps: 6,
        dimension: 32,
    };
    assert_eq!(budget.quality(), floor);
    assert!(!budget.congested(), "congestion never goes below the floor");
    assert_eq!(budget.quality(), floor);
    assert!(budget.estimate(1_000_000));
    assert_eq!(
        budget.quality(),
        Quality {
            bitrate: 900_000,
            fps: 24,
            dimension: 56
        }
    );
    assert!(!budget.estimate(950_000), "a small move costs no keyframe");
    assert_eq!(budget.quality().bitrate, 900_000);
    assert!(budget.congested());
    assert_eq!(
        budget.quality(),
        Quality {
            bitrate: 450_000,
            fps: 12,
            dimension: 40
        }
    );
    let mut tight = Budget::new(Bounds {
        max_fps: 1,
        max_bitrate: 10_000,
        max_dimension: 2,
        ..bounds
    });
    assert!(!tight.estimate(0));
    assert_eq!(
        tight.quality(),
        Quality {
            bitrate: 10_000,
            fps: 1,
            dimension: 2
        }
    );
}

#[test]
fn keyframes_follow_the_interval_and_requests() {
    let start = Instant::now();
    let interval = Duration::from_secs(1);
    let mut video = Video::new(bounds(10, interval)).expect("encoder");
    let frame = noise(64, 48, 1);
    assert!(
        video.budget.keyframe(start),
        "the first frame is a keyframe"
    );
    let (unit, key) = video
        .encode(start, &frame, (64, 48))
        .expect("encodes")
        .expect("within the frame cap");
    assert!(key);
    assert_eq!(&unit[..4], &[0, 0, 0, 1], "an Annex-B access unit");
    let half = start + interval / 2;
    assert!(!video.budget.keyframe(half));
    let (_, key) = video
        .encode(half, &frame, (64, 48))
        .expect("encodes")
        .expect("within the frame cap");
    assert!(!key, "inside the interval frames are predicted");
    video.budget.request_keyframe();
    let (_, key) = video
        .encode(half, &frame, (64, 48))
        .expect("encodes")
        .expect("within the frame cap");
    assert!(key, "a receiver's request forces a keyframe");
    assert!(!video.budget.keyframe(half));
    assert!(video.budget.keyframe(half + interval));
    assert_eq!(video.stats.frames, 3);
    assert_eq!(video.stats.encoded, 3);
    assert_eq!(video.stats.dropped, 0);
    assert!(video.stats.bytes > 0);
    assert!(video.retained() >= 64 * 48 * 3 / 2);
}

#[test]
fn oversized_units_and_backlog_are_dropped_frames() {
    let start = Instant::now();
    let tiny = Bounds {
        max_frame_bytes: 1,
        ..bounds(10, Duration::from_secs(60))
    };
    let mut video = Video::new(tiny).expect("encoder");
    assert_eq!(
        video
            .encode(start, &noise(64, 48, 2), (64, 48))
            .expect("encodes"),
        None
    );
    assert_eq!(video.stats.dropped, 1);
    assert_eq!(video.stats.frames, 0);
    assert!(video.budget.keyframe(start), "the next frame is a keyframe");
    video.backlog().expect("retunes");
    assert_eq!(video.stats.dropped, 2);
    assert_eq!(video.budget.quality().bitrate, 500_000);
    video.estimate(1_000_000_000).expect("retunes");
    assert_eq!(video.budget.quality().bitrate, 1_000_000);
    video.estimate(1_000_000_000).expect("unchanged");
}

#[test]
fn the_encoder_rebuilds_on_tune_and_resizes() {
    let quality = Quality {
        bitrate: 200_000,
        fps: 10,
        dimension: 32,
    };
    let mut encoder = Encoder::new(quality).expect("encoder");
    assert_eq!(encoder.retained(), 0);
    let (_, key) = encoder
        .encode(&noise(32, 16, 3), (32, 16), false)
        .expect("encodes");
    assert!(key, "a fresh encoder starts with an IDR");
    let (_, key) = encoder
        .encode(&noise(64, 48, 4), (64, 48), false)
        .expect("a new size restarts the encoder");
    assert!(key);
    encoder.tune(quality).expect("retunes");
    let (_, key) = encoder
        .encode(&noise(64, 48, 5), (64, 48), false)
        .expect("encodes");
    assert!(key, "a retuned encoder starts with an IDR");
    assert!(encoder.retained() >= 64 * 48 * 3 / 2);
}

#[test]
fn stats_turn_into_bounded_report_rates() {
    let earlier = Stats {
        frames: 10,
        bytes: 1_000,
        encoded: 10,
        encoding: Duration::from_millis(50),
        dropped: 1,
    };
    let later = Stats {
        frames: 40,
        bytes: 4_000,
        encoded: 40,
        encoding: Duration::from_millis(350),
        dropped: 3,
    };
    let rates = later.rates(&earlier, Duration::from_secs(1));
    assert!((rates.fps - 30.0).abs() < 1e-9);
    assert_eq!(rates.bytes_per_second, 3_000);
    assert!((rates.encode_ms - 10.0).abs() < 1e-9);
    assert_eq!(rates.dropped_frames, 3);
    let burst = later.rates(&earlier, Duration::ZERO);
    assert!((burst.fps - f64::from(MAX_FPS)).abs() < 1e-9);
    let slow = Stats {
        encoding: Duration::from_secs(600),
        ..later
    };
    let rates = slow.rates(&later, Duration::from_secs(1));
    assert!((rates.encode_ms - MAX_ENCODE_MS).abs() < 1e-9);
    assert!(rates.fps.abs() < 1e-9);
}

struct Pair {
    session: Session,
    viewer: Rtc,
    now: Instant,
    events: Vec<Event>,
    cut: bool,
}

impl Pair {
    fn new(bounds: Bounds, data_channel: bool) -> Self {
        let now = Instant::now();
        let (mut session, offer) =
            Session::offer(bounds, data_channel, &[OFFERER], now).expect("offer");
        assert_eq!(offer.candidates.len(), 1);
        let mut viewer = Rtc::builder().build(now);
        let local = viewer
            .add_local_candidate(Candidate::host(VIEWER, "udp").expect("host"))
            .expect("local candidate")
            .to_sdp_string();
        for line in &offer.candidates {
            viewer.add_remote_candidate(Candidate::from_sdp_string(line).expect("candidate"));
        }
        let answer = viewer
            .sdp_api()
            .accept_offer(SdpOffer::from_sdp_string(&offer.sdp).expect("sdp"))
            .expect("answer");
        session.answer(&answer.to_sdp_string()).expect("accepted");
        session.candidate(&local).expect("remote candidate");
        Self {
            session,
            viewer,
            now,
            events: Vec::new(),
            cut: false,
        }
    }

    fn settle(&mut self) -> Result<Instant, String> {
        loop {
            let polled = self.session.poll()?;
            let mut moved = !polled.datagrams.is_empty() && !self.cut;
            for datagram in polled.datagrams.into_iter().filter(|_| !self.cut) {
                let receive = Receive::new(
                    Protocol::Udp,
                    datagram.source,
                    datagram.destination,
                    &datagram.contents,
                )
                .expect("a WebRTC datagram");
                self.viewer
                    .handle_input(RtcInput::Receive(self.now, receive))
                    .expect("viewer input");
            }
            let viewer = loop {
                match self.viewer.poll_output().expect("viewer output") {
                    Output::Timeout(timeout) => break timeout,
                    Output::Transmit(_) if self.cut => {}
                    Output::Transmit(transmit) => {
                        moved = true;
                        self.session.receive(
                            self.now,
                            transmit.source,
                            transmit.destination,
                            &transmit.contents,
                        )?;
                    }
                    Output::Event(event) => self.events.push(event),
                }
            };
            if !moved {
                return Ok(polled.timeout.min(viewer));
            }
        }
    }

    fn step(&mut self) -> Result<(), String> {
        let next = self.settle()?;
        self.now = next.clamp(
            self.now + Duration::from_millis(1),
            self.now + Duration::from_millis(20),
        );
        self.session.tick(self.now)?;
        self.viewer
            .handle_input(RtcInput::Timeout(self.now))
            .expect("viewer tick");
        Ok(())
    }

    fn until(&mut self, mut done: impl FnMut(&Self) -> bool) {
        for _ in 0..5_000 {
            if done(self) {
                return;
            }
            self.step().expect("step");
        }
        panic!("condition not reached on the injected clock");
    }

    fn stream(&mut self, span: Duration, seed: u32) -> u32 {
        let end = self.now + span;
        let mut sent = 0;
        while self.now < end {
            if self.session.due(self.now) {
                let side = self.session.dimension();
                let size = (side, side * 3 / 4 / 2 * 2);
                let frame = noise(size.0, size.1, seed + sent);
                if self.session.frame(self.now, &frame, size).expect("frame") {
                    sent += 1;
                }
            }
            self.step().expect("step");
        }
        sent
    }

    fn keyframes(&self) -> usize {
        self.media().filter(|key| *key).count()
    }

    fn media(&self) -> impl Iterator<Item = bool> + '_ {
        self.events.iter().filter_map(|event| match event {
            Event::MediaData(data) => Some(data.is_keyframe()),
            _ => None,
        })
    }

    fn mid(&self) -> Mid {
        self.events
            .iter()
            .find_map(|event| match event {
                Event::MediaAdded(added) => Some(added.mid),
                _ => None,
            })
            .expect("the video track was added")
    }
}

#[test]
fn h264_flows_with_a_capped_rate_and_keyframe_interval() {
    let mut pair = Pair::new(capped(10, Duration::from_secs(1)), false);
    assert!(!pair.session.live());
    assert_eq!(pair.session.next_frame(pair.now), None);
    assert!(
        !pair.session.due(pair.now),
        "no media before the peer connects"
    );
    pair.until(|pair| pair.session.live());
    assert_eq!(pair.session.next_frame(pair.now), Some(pair.now));
    let sent = pair.stream(Duration::from_secs(3), 10);
    assert!((25..=31).contains(&sent), "{sent} frames");
    assert_eq!(pair.session.stats().frames, u64::from(sent));
    assert!(pair.session.next_frame(pair.now).is_some());
    pair.until(|pair| pair.media().count() + 2 >= sent as usize);
    let media: Vec<bool> = pair.media().collect();
    assert!(media[0], "the first delivered frame is a keyframe");
    assert!((3..=4).contains(&pair.keyframes()), "{media:?}");
    assert!(pair.session.retained() > 0);
    assert!(pair.session.quality().fps <= 10);
}

#[test]
fn the_transport_estimate_adapts_quality_inside_the_bounds() {
    let bounds = bounds(10, Duration::from_secs(1));
    let mut pair = Pair::new(bounds, false);
    pair.until(|pair| pair.session.live());
    pair.stream(Duration::from_secs(3), 70);
    let quality = pair.session.quality();
    assert!(quality.bitrate < bounds.max_bitrate, "{quality:?}");
    assert!(quality.bitrate >= MIN_BITRATE, "{quality:?}");
    assert!(
        quality.fps < bounds.max_fps && quality.fps >= 1,
        "{quality:?}"
    );
    assert!(quality.dimension <= bounds.max_dimension, "{quality:?}");
}

#[test]
fn a_viewer_keyframe_request_forces_the_next_keyframe() {
    let mut pair = Pair::new(capped(10, Duration::from_secs(600)), false);
    pair.until(|pair| pair.session.live());
    pair.stream(Duration::from_millis(500), 20);
    pair.until(|pair| pair.media().count() >= 3);
    assert_eq!(pair.keyframes(), 1);
    let mid = pair.mid();
    pair.viewer
        .writer(mid)
        .expect("the viewer's track")
        .request_keyframe(None, KeyframeRequestKind::Pli)
        .expect("request");
    pair.stream(Duration::from_millis(500), 40);
    pair.until(|pair| pair.keyframes() >= 2);
    assert_eq!(pair.keyframes(), 2);
}

#[test]
fn the_data_channel_carries_relayed_bytes() {
    let mut pair = Pair::new(bounds(10, Duration::from_secs(1)), true);
    let open = |pair: &Pair| {
        pair.events
            .iter()
            .any(|event| matches!(event, Event::ChannelOpen(_, label) if label == CHANNEL))
    };
    pair.until(open);
    pair.session.data(CHANNEL, b"ping").expect("written");
    pair.until(|pair| {
        pair.events
            .iter()
            .any(|event| matches!(event, Event::ChannelData(data) if data.data == b"ping"))
    });
    let error = pair
        .session
        .data("control", b"x")
        .expect_err("not a channel");
    assert_eq!(error, "no open data channel control");
    // Unpolled writes fill the channel's bounded buffer: the next write is refused.
    let chunk = vec![7_u8; 16 * 1024];
    let full = (0..64)
        .find_map(|_| pair.session.data(CHANNEL, &chunk).err())
        .expect("the buffer fills");
    assert_eq!(full, "data channel is full");
}

#[test]
fn an_oversized_unit_is_a_dropped_frame_in_the_session() {
    let bounds = Bounds {
        max_frame_bytes: 1,
        ..capped(10, Duration::from_secs(1))
    };
    let mut pair = Pair::new(bounds, false);
    pair.until(|pair| pair.session.live());
    let frame = noise(32, 24, 9);
    let sent = pair
        .session
        .frame(pair.now, &frame, (32, 24))
        .expect("encodes");
    assert!(!sent, "a unit above max_frame_bytes is not sent");
    assert_eq!(pair.session.stats().dropped, 1);
    assert_eq!(pair.session.stats().frames, 0);
}

#[test]
fn relay_before_the_channel_opens_is_queued_and_written_on_open() {
    let mut pair = Pair::new(bounds(10, Duration::from_secs(1)), true);
    // The open acknowledgement has not been exchanged: nothing has been polled.
    pair.session.data(CHANNEL, b"early").expect("queued");
    pair.until(|pair| {
        pair.events
            .iter()
            .any(|event| matches!(event, Event::ChannelData(data) if data.data == b"early"))
    });
}

#[test]
fn the_early_relay_queue_is_bounded() {
    let mut pair = Pair::new(bounds(10, Duration::from_secs(1)), true);
    for _ in 0..EARLY_RELAY {
        pair.session.data(CHANNEL, b"x").expect("queued");
    }
    let full = pair.session.data(CHANNEL, b"x").expect_err("bounded");
    assert_eq!(full, "data channel is full");
}

#[test]
fn without_a_data_channel_relay_is_refused() {
    let mut pair = Pair::new(bounds(10, Duration::from_secs(1)), false);
    pair.until(|pair| pair.session.live());
    let error = pair.session.data(CHANNEL, b"x").expect_err("no channel");
    assert_eq!(error, "no open data channel oni");
}

#[test]
fn congestion_and_capture_misses_are_dropped_frames() {
    let mut pair = Pair::new(bounds(10, Duration::from_secs(600)), false);
    pair.until(|pair| pair.session.live());
    pair.stream(Duration::from_millis(300), 50);
    let before = pair.session.quality();
    pair.session.congested(0).expect("no blocked sends");
    assert_eq!(pair.session.quality(), before);
    pair.session.congested(3).expect("backs off");
    assert_eq!(pair.session.quality().bitrate, before.bitrate / 2);
    pair.session.skipped();
    assert_eq!(pair.session.stats().dropped, 2);
    let keys = pair.keyframes();
    pair.stream(Duration::from_millis(300), 60);
    pair.until(|pair| pair.keyframes() > keys);
}

#[test]
fn a_silent_peer_fails_the_session_on_the_injected_clock() {
    let mut pair = Pair::new(bounds(10, Duration::from_secs(1)), false);
    pair.until(|pair| pair.session.live());
    pair.cut = true;
    let mut outcome = Ok(());
    for _ in 0..10_000 {
        outcome = pair.step();
        if outcome.is_err() {
            break;
        }
    }
    assert_eq!(outcome, Err("peer disconnected".to_owned()));
    assert!(pair.session.failed());
    assert!(!pair.session.live());
}

#[test]
fn a_closed_session_reports_its_loss() {
    let mut pair = Pair::new(bounds(10, Duration::from_secs(1)), false);
    pair.until(|pair| pair.session.live());
    pair.session.close();
    assert!(pair.session.failed());
    assert_eq!(
        pair.session.poll().expect_err("closed"),
        "peer disconnected"
    );
}

#[test]
fn negotiation_inputs_are_validated() {
    let now = Instant::now();
    let (mut session, _) =
        Session::offer(bounds(10, Duration::from_secs(1)), false, &[], now).expect("offer");
    assert!(session.answer("v=garbage").is_err());
    assert!(
        session.answer("v=garbage").is_err(),
        "a malformed answer keeps the offer"
    );
    let error = session
        .frame(now, &noise(16, 16, 1), (16, 16))
        .expect_err("no answered track");
    assert_eq!(error, "video track not negotiated");
    assert!(session.candidate("candidate:nonsense").is_err());
    session
        .receive(now, VIEWER, OFFERER, &[0xff; 4])
        .expect("discarded");
    let unspecified = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 1);
    assert!(Session::offer(
        bounds(10, Duration::from_secs(1)),
        false,
        &[unspecified],
        now
    )
    .is_err());
}

#[test]
fn a_saturated_frame_pool_refuses_the_next_frame() {
    let hold = Arc::new(Mutex::new(Hold::default()));
    let source = Flaky {
        frames: Frames::display(64, 48, 1.0),
        mode: Arc::new(Mutex::new(Mode::Ready)),
        hold: Arc::clone(&hold),
    };
    let screen = Arc::new(Screen::new(Box::new(source), 1));
    let display: oni_protocol::stream_open_request::StreamOpenRequestSource =
        serde_json::from_value(json!({"kind":"display","display":1})).expect("source");
    let (entered, reached) = tokio::sync::oneshot::channel();
    let (release, released) = blocking::channel();
    *hold.lock().expect("hold") = Hold {
        entered: Some(entered),
        release: Some(released),
    };
    let held = {
        let (screen, display) = (Arc::clone(&screen), display.clone());
        std::thread::spawn(move || screen.frame(&display, 64, &mut Vec::new()))
    };
    reached.blocking_recv().expect("the held capture began");
    let refused = screen.frame(&display, 64, &mut Vec::new());
    assert_eq!(
        refused,
        Err(Fault::Failed("frame pool saturated".to_owned()))
    );
    release.send(()).expect("released");
    assert!(held.join().expect("joined").is_ok());
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Ready,
    Failing,
    Denied,
}

#[derive(Default)]
struct Hold {
    entered: Option<tokio::sync::oneshot::Sender<()>>,
    release: Option<blocking::Receiver<()>>,
}

struct Flaky {
    frames: Frames,
    mode: Arc<Mutex<Mode>>,
    hold: Arc<Mutex<Hold>>,
}

impl Source for Flaky {
    fn ready(&self) -> Result<(), Fault> {
        match *self.mode.lock().expect("mode") {
            Mode::Denied => Err(Fault::Permission),
            _ => Ok(()),
        }
    }

    fn displays(&self) -> Result<Vec<Display>, Fault> {
        self.frames.displays()
    }

    fn windows(&self) -> Result<Vec<Window>, Fault> {
        self.frames.windows()
    }

    fn capture_display(&self, display: u32, pixels: &mut Vec<u8>) -> Result<(u32, u32), Fault> {
        let hold = std::mem::take(&mut *self.hold.lock().expect("hold"));
        if let (Some(entered), Some(release)) = (hold.entered, hold.release) {
            entered.send(()).expect("the test waits");
            release.recv().expect("released");
        }
        if *self.mode.lock().expect("mode") == Mode::Failing {
            return Err(Fault::Failed("capture busy".to_owned()));
        }
        self.frames.capture_display(display, pixels)
    }

    fn capture_window(&self, window: u32, pixels: &mut Vec<u8>) -> Result<(u32, u32), Fault> {
        self.frames.capture_window(window, pixels)
    }
}

fn settings(root: &Path) -> ClientConfig {
    ClientConfig {
        machine_id: "laptop".into(),
        name: "Laptop".into(),
        host: "127.0.0.1:7643".into(),
        tags: vec![],
        exports: vec![],
        memory_budget_mb: 96,
        unix: Some(root.join("host.sock")),
    }
}

struct Machine {
    _root: TempDir,
    service: Arc<Service>,
    hooks: Hooks,
    calls: mpsc::Receiver<UplinkCall>,
    mode: Arc<Mutex<Mode>>,
    hold: Arc<Mutex<Hold>>,
}

impl Machine {
    async fn on(address: IpAddr) -> Self {
        let root = tempfile::tempdir().expect("root");
        let pty = Pty::new("/definitely/missing/tmux", None, "g".into()).await;
        let (mode, hold) = (Arc::new(Mutex::new(Mode::Ready)), Arc::default());
        let source = Flaky {
            frames: Frames::display(64, 48, 1.0),
            mode: mode.clone(),
            hold: Arc::clone(&hold),
        };
        let screen = Screen::new(Box::new(source), 2);
        let service = Service::open_stream(
            &settings(root.path()),
            pty,
            (screen, Input::absent()),
            Cdp::absent(),
            address,
        )
        .expect("service");
        let hooks = service.hooks(LONG);
        let (_, calls) = Uplink::channel();
        Self {
            _root: root,
            service,
            hooks,
            calls,
            mode,
            hold,
        }
    }

    async fn new() -> Self {
        let mut machine = Self::on(LOOPBACK).await;
        machine.connect(&[COMPUTER_USE]);
        machine
    }

    fn connect(&mut self, capabilities: &[&str]) {
        let (uplink, calls) = Uplink::channel();
        self.service.uplink(uplink);
        self.calls = calls;
        self.grant(capabilities);
    }

    fn grant(&self, capabilities: &[&str]) {
        self.service.attached(&Negotiated {
            generation: NonZeroU64::MIN,
            capabilities: capabilities.iter().map(|&id| id.to_owned()).collect(),
            exports: vec![],
        });
    }

    fn call(&self, method: &str, params: Value) -> Pin<Box<dyn Future<Output = Value> + Send>> {
        let reply = (self.hooks.service)(method.to_owned(), Some(params));
        let method = method.to_owned();
        Box::pin(async move { reply.await.expect(&method) })
    }

    async fn open(&self, id: &str, lifetime: u64, source: Value) -> Value {
        let request = json!({
            "streamId": id, "source": source, "dataChannel": true, "lifetimeMs": lifetime,
            "video": {"maxFps": 30, "keyframeIntervalMs": 1000, "maxBitrateBps": 1_000_000,
                      "maxDimension": 64, "maxFrameBytes": 1_048_576}
        });
        self.call("machine.stream.open", request).await
    }

    async fn display(&self, id: &str) -> Value {
        self.open(id, 600_000, json!({"kind":"display","display":1}))
            .await
    }

    async fn signal(&self, id: &str, seq: u8, signal: Value) -> Value {
        let request = json!({"streamId": id, "seq": seq, "signal": signal});
        self.call("machine.stream.signal", request).await
    }

    async fn close(&self, id: &str) -> Value {
        let request = json!({"streamId": id, "reason": "requested"});
        self.call("machine.stream.close", request).await
    }

    async fn uplinked(&mut self) -> UplinkCall {
        tokio::time::timeout(LONG, self.calls.recv())
            .await
            .expect("an uplink call in time")
            .expect("uplink call")
    }

    async fn offered(&mut self, id: &str) -> (String, Vec<String>) {
        let (mut sdp, mut candidates) = (String::new(), Vec::new());
        for seq in 0_u8.. {
            let call = self.uplinked().await;
            assert_eq!(call.method, "machine.stream.signal");
            assert_eq!(call.params["streamId"], id);
            assert_eq!(call.params["seq"], seq);
            let signal = call.params["signal"].clone();
            call.answer(Ok(Some(json!({"status":"accepted","seq":seq}))));
            match signal["type"].as_str().expect("typed signal") {
                "offer" => sdp = signal["sdp"].as_str().expect("sdp").to_owned(),
                "candidate" => {
                    assert_eq!(signal["sdpMLineIndex"], 0);
                    candidates.push(signal["candidate"].as_str().expect("line").to_owned());
                }
                kind => {
                    assert_eq!(kind, "end_of_candidates");
                    break;
                }
            }
        }
        (sdp, candidates)
    }

    async fn closed_with(&mut self, id: &str, reason: &str) {
        let call = self.uplinked().await;
        assert_eq!(call.method, "machine.stream.close");
        assert_eq!(call.params, json!({"streamId": id, "reason": reason}));
        call.answer(Ok(Some(json!({"status":"closed","streamId":id}))));
    }

    fn observations(&self) -> Vec<oni_protocol::StreamObservation> {
        self.service
            .streams()
            .into_iter()
            .map(|row| oni_protocol::decode(row).expect("a wire observation"))
            .collect()
    }
}

fn refusal(reason: &str) -> Value {
    json!({"status":"refused","reason":reason})
}

struct Viewer {
    rtc: Rtc,
    seen: Vec<Event>,
    socket: UdpSocket,
    local: SocketAddr,
}

impl Viewer {
    async fn answer(offer: &str, candidates: &[String]) -> (Self, String, String) {
        let socket = UdpSocket::bind((LOOPBACK, 0)).await.expect("viewer socket");
        let local = socket.local_addr().expect("viewer address");
        let mut rtc = Rtc::builder().build(Instant::now());
        let line = rtc
            .add_local_candidate(Candidate::host(local, "udp").expect("host"))
            .expect("local candidate")
            .to_sdp_string();
        for candidate in candidates {
            rtc.add_remote_candidate(Candidate::from_sdp_string(candidate).expect("candidate"));
        }
        let answer = rtc
            .sdp_api()
            .accept_offer(SdpOffer::from_sdp_string(offer).expect("offer"))
            .expect("answer");
        let viewer = Self {
            rtc,
            seen: Vec::new(),
            socket,
            local,
        };
        (viewer, answer.to_sdp_string(), line)
    }

    /// Drives the answerer until `want` matches an event seen so far.
    async fn until<T>(&mut self, mut want: impl FnMut(&Event) -> Option<T>) -> T {
        let mut buffer = vec![0_u8; 2048];
        let wait = async {
            loop {
                let timeout = match self.rtc.poll_output().expect("viewer output") {
                    Output::Timeout(timeout) => timeout,
                    Output::Transmit(transmit) => {
                        self.socket
                            .send_to(&transmit.contents, transmit.destination)
                            .await
                            .expect("viewer send");
                        continue;
                    }
                    Output::Event(event) => {
                        self.seen.push(event);
                        continue;
                    }
                };
                if let Some(found) = self.seen.iter().find_map(&mut want) {
                    return found;
                }
                tokio::select! {
                    received = self.socket.recv_from(&mut buffer) => {
                        let (length, source) = received.expect("viewer receive");
                        let receive = Receive::new(Protocol::Udp, source, self.local, &buffer[..length])
                            .expect("a WebRTC datagram");
                        self.rtc.handle_input(RtcInput::Receive(Instant::now(), receive)).expect("input");
                    }
                    () = tokio::time::sleep_until(timeout.into()) => {
                        self.rtc.handle_input(RtcInput::Timeout(Instant::now())).expect("tick");
                    }
                }
            }
        };
        tokio::time::timeout(LONG, wait)
            .await
            .expect("viewer event")
    }
}

#[tokio::test]
async fn a_stream_negotiates_and_delivers_h264_over_udp() {
    let mut machine = Machine::new().await;
    let opened = machine.display("s-1").await;
    assert_eq!(opened["status"], "opened");
    assert_eq!(opened["streamId"], "s-1");
    assert!(opened["expiresAt"].as_u64().expect("expiry") > 600_000);
    assert_eq!(machine.service.open_streams(), 1);
    let (sdp, candidates) = machine.offered("s-1").await;
    assert!(sdp.contains("H264"), "the offer carries H.264");
    assert_eq!(candidates.len(), 1);
    let (mut viewer, answer, line) = Viewer::answer(&sdp, &candidates).await;
    let accepted = |seq: u8| json!({"status":"accepted","seq":seq});
    assert_eq!(
        machine
            .signal("s-1", 0, json!({"type":"answer","sdp":answer}))
            .await,
        accepted(0)
    );
    let unreachable = json!({"type":"candidate","candidate":UNREACHABLE,"sdpMid":"0"});
    assert_eq!(machine.signal("s-1", 1, unreachable).await, accepted(1));
    let reachable = json!({"type":"candidate","candidate":line,"sdpMLineIndex":0});
    assert_eq!(
        machine.signal("s-1", 2, reachable.clone()).await,
        accepted(2)
    );
    assert_eq!(
        machine.signal("s-1", 2, reachable).await,
        accepted(2),
        "a repeat"
    );
    assert_eq!(
        machine
            .signal("s-1", 9, json!({"type":"end_of_candidates"}))
            .await,
        refusal("invalid_sequence")
    );
    assert_eq!(
        machine
            .signal("s-1", 3, json!({"type":"end_of_candidates"}))
            .await,
        accepted(3)
    );
    viewer
        .until(|event| match event {
            Event::MediaData(data) if data.is_keyframe() => Some(()),
            _ => None,
        })
        .await;
    let channel = viewer
        .until(|event| match event {
            Event::ChannelOpen(_, label) => Some(label.clone()),
            _ => None,
        })
        .await;
    assert_eq!(channel, CHANNEL);
    let data = json!({"type":"data","label":CHANNEL,"data":STANDARD.encode(b"ping")});
    assert_eq!(machine.signal("s-1", 4, data).await, accepted(4));
    let relayed = viewer
        .until(|event| match event {
            Event::ChannelData(data) => Some(data.data.clone()),
            _ => None,
        })
        .await;
    assert_eq!(relayed, b"ping");
    let offer = json!({"type":"offer","sdp":"v=0"});
    assert_eq!(
        machine.signal("s-1", 5, offer).await,
        json!({"status":"refused","reason":"invalid_signal","message":"this peer is the offerer"})
    );
    let bad = json!({"type":"data","label":CHANNEL,"data":"AB=="});
    let refused = machine.signal("s-1", 5, bad.clone()).await;
    assert_eq!(refused["reason"], "invalid_signal", "{refused}");
    let again = machine.signal("s-1", 5, bad).await;
    assert_eq!(
        again["reason"], "invalid_signal",
        "a refused seq is never replayed as accepted"
    );
    assert_eq!(
        machine
            .signal("s-1", 6, json!({"type":"end_of_candidates"}))
            .await,
        refusal("invalid_sequence"),
        "a refusal does not advance the sequence"
    );
    assert_eq!(
        machine
            .signal("s-1", 5, json!({"type":"end_of_candidates"}))
            .await,
        accepted(5),
        "a valid signal right after a refusal takes the refused seq"
    );
    assert_eq!(
        machine
            .signal("s-1", 4, json!({"type":"end_of_candidates"}))
            .await,
        refusal("invalid_sequence"),
        "only the last accepted seq replays"
    );
    let [observation] = machine.observations().try_into().expect("one stream");
    assert_eq!(observation.stream_id.as_str(), "s-1");
    assert!(observation.fps.as_f64().expect("fps") > 0.0);
    assert!(observation.bytes_per_second > 0);
    assert!(observation.retained_bytes > 0);
    assert!(machine.service.retained().stream_bytes > 0);
    assert_eq!(
        machine.close("s-1").await,
        json!({"status":"closed","streamId":"s-1"})
    );
    assert_eq!(machine.service.open_streams(), 0);
    assert_eq!(machine.service.retained().stream_bytes, 0);
    assert_eq!(
        machine
            .signal("s-1", 7, json!({"type":"end_of_candidates"}))
            .await,
        refusal("stream_expired")
    );
    assert_eq!(machine.close("s-1").await, refusal("stream_not_found"));
}

#[tokio::test]
async fn capture_misses_count_as_drops_and_a_lost_source_fails_the_stream() {
    let mut machine = Machine::new().await;
    assert_eq!(machine.display("s-1").await["status"], "opened");
    let (sdp, candidates) = machine.offered("s-1").await;
    let (mut viewer, answer, line) = Viewer::answer(&sdp, &candidates).await;
    machine
        .signal("s-1", 0, json!({"type":"answer","sdp":answer}))
        .await;
    machine
        .signal("s-1", 1, json!({"type":"candidate","candidate":line}))
        .await;
    viewer
        .until(|event| matches!(event, Event::MediaData(_)).then_some(()))
        .await;
    *machine.mode.lock().expect("mode") = Mode::Denied;
    machine.closed_with("s-1", "failed").await;
    assert_eq!(machine.service.open_streams(), 0);
    assert_eq!(
        machine
            .signal("s-1", 2, json!({"type":"end_of_candidates"}))
            .await,
        refusal("stream_expired")
    );
}

#[tokio::test]
async fn a_failing_capture_is_a_dropped_frame_in_the_report() {
    let mut machine = Machine::new().await;
    assert_eq!(machine.display("s-1").await["status"], "opened");
    let (sdp, candidates) = machine.offered("s-1").await;
    let (mut viewer, answer, line) = Viewer::answer(&sdp, &candidates).await;
    machine
        .signal("s-1", 0, json!({"type":"answer","sdp":answer}))
        .await;
    machine
        .signal("s-1", 1, json!({"type":"candidate","candidate":line}))
        .await;
    viewer
        .until(|event| matches!(event, Event::MediaData(_)).then_some(()))
        .await;
    // Hold one capture while it is switched to failing, then hold the next so
    // the report is read with exactly one miss counted.
    let (entered, reached) = tokio::sync::oneshot::channel();
    let (release, released) = blocking::channel();
    *machine.hold.lock().expect("hold") = Hold {
        entered: Some(entered),
        release: Some(released),
    };
    reached.await.expect("a capture began");
    *machine.mode.lock().expect("mode") = Mode::Failing;
    release.send(()).expect("released");
    let (entered, reached) = tokio::sync::oneshot::channel();
    let (release, released) = blocking::channel();
    *machine.hold.lock().expect("hold") = Hold {
        entered: Some(entered),
        release: Some(released),
    };
    reached.await.expect("the next capture began");
    let [observation] = machine.observations().try_into().expect("one stream");
    assert_eq!(observation.dropped_frames, 1);
    *machine.mode.lock().expect("mode") = Mode::Ready;
    release.send(()).expect("released");
    assert_eq!(machine.close("s-1").await["status"], "closed");
}

#[tokio::test]
async fn a_stream_expires_at_its_lifetime() {
    let mut machine = Machine::new().await;
    let opened = machine
        .open("s-1", 1, json!({"kind":"display","display":1}))
        .await;
    assert_eq!(opened["status"], "opened");
    machine.offered("s-1").await;
    machine.closed_with("s-1", "expired").await;
    assert_eq!(machine.service.open_streams(), 0);
    // With the service on a fresh uplink, the old channel closes exactly
    // when the expired stream's task drops its clone, i.e. when it has ended.
    let (uplink, calls) = Uplink::channel();
    machine.service.uplink(uplink);
    let mut previous = std::mem::replace(&mut machine.calls, calls);
    let ended = tokio::time::timeout(LONG, previous.recv())
        .await
        .expect("the stream task ends in time");
    assert!(ended.is_none(), "no call after the close");
    assert_eq!(
        machine
            .signal("s-1", 0, json!({"type":"end_of_candidates"}))
            .await,
        refusal("stream_expired")
    );
}

#[tokio::test]
async fn a_refused_offer_fails_the_stream() {
    let mut machine = Machine::new().await;
    assert_eq!(machine.display("s-1").await["status"], "opened");
    let offer = machine.uplinked().await;
    assert_eq!(offer.params["signal"]["type"], "offer");
    offer.answer(Ok(Some(refusal("stream_not_found"))));
    machine.closed_with("s-1", "failed").await;
    assert_eq!(machine.service.open_streams(), 0);
}

#[tokio::test]
async fn revoke_and_memory_pressure_close_streams_as_failed() {
    let mut machine = Machine::new().await;
    assert_eq!(machine.display("s-1").await["status"], "opened");
    let _offer = machine.uplinked().await;
    machine.grant(&[]);
    machine.closed_with("s-1", "failed").await;
    assert_eq!(machine.service.open_streams(), 0);
    machine.grant(&[COMPUTER_USE]);
    assert_eq!(machine.display("s-2").await["status"], "opened");
    let _offer = machine.uplinked().await;
    machine.service.shed();
    machine.closed_with("s-2", "failed").await;
    assert_eq!(machine.service.open_streams(), 0);
}

#[tokio::test]
async fn detach_aborts_streams_without_a_close() {
    let mut machine = Machine::new().await;
    assert_eq!(machine.display("s-1").await["status"], "opened");
    let offer = machine.uplinked().await;
    machine.service.detached();
    assert_eq!(machine.service.open_streams(), 0);
    drop(offer);
    assert!(matches!(
        machine.calls.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
    assert_eq!(
        machine.display("s-2").await,
        refusal("machine_not_attached")
    );
    machine.connect(&[COMPUTER_USE]);
    assert_eq!(
        machine
            .signal("s-1", 0, json!({"type":"end_of_candidates"}))
            .await,
        refusal("stream_not_found"),
        "a new attachment knows no earlier stream"
    );
}

#[tokio::test]
async fn a_detach_during_open_refuses_the_open() {
    let machine = Machine::new().await;
    let (entered, reached) = tokio::sync::oneshot::channel();
    let (release, released) = blocking::channel();
    *machine.hold.lock().expect("hold") = Hold {
        entered: Some(entered),
        release: Some(released),
    };
    let open = tokio::spawn(machine.call(
        "machine.stream.open",
        json!({
            "streamId": "s-1", "source": {"kind":"display","display":1}, "dataChannel": false,
            "lifetimeMs": 60_000, "video": {"maxFps": 30, "keyframeIntervalMs": 1000,
            "maxBitrateBps": 1_000_000, "maxDimension": 64, "maxFrameBytes": 1_048_576}
        }),
    ));
    reached.await.expect("the first capture began");
    machine.service.detached();
    release.send(()).expect("released");
    assert_eq!(open.await.expect("open"), refusal("machine_not_attached"));
    assert_eq!(machine.service.open_streams(), 0);
}

#[tokio::test]
async fn opens_are_bounded_and_signals_are_queued_within_a_cap() {
    let mut machine = Machine::new().await;
    let mut offers = Vec::new();
    for index in 0..MAX_STREAMS {
        let id = format!("s-{index}");
        assert_eq!(machine.display(&id).await["status"], "opened");
        offers.push(machine.uplinked().await);
    }
    assert_eq!(machine.display("s-0").await, refusal("already_open"));
    assert_eq!(machine.display("s-9").await, refusal("stream_limit"));
    let ids: Vec<String> = machine
        .observations()
        .iter()
        .map(|row| row.stream_id.to_string())
        .collect();
    assert_eq!(ids, ["s-0", "s-1", "s-2", "s-3"]);
    let mut cx = Context::from_waker(Waker::noop());
    let mut pending = Vec::new();
    for seq in 0..SIGNAL_QUEUE {
        let seq = u8::try_from(seq).expect("small");
        let mut call = machine.call(
            "machine.stream.signal",
            json!({"streamId":"s-0","seq":seq,"signal":{"type":"end_of_candidates"}}),
        );
        assert!(matches!(call.as_mut().poll(&mut cx), Poll::Pending));
        pending.push(call);
    }
    let over = u8::try_from(SIGNAL_QUEUE).expect("small");
    assert_eq!(
        machine
            .signal("s-0", over, json!({"type":"end_of_candidates"}))
            .await,
        refusal("signal_limit")
    );
    assert_eq!(machine.close("s-0").await["status"], "closed");
    for call in pending {
        assert_eq!(call.await, refusal("stream_expired"));
    }
    drop(offers);
}

#[tokio::test]
async fn closed_ids_are_remembered_within_a_bound() {
    let mut machine = Machine::new().await;
    for index in 0..65 {
        let id = format!("s-{index}");
        assert_eq!(machine.display(&id).await["status"], "opened");
        let offer = machine.uplinked().await;
        assert_eq!(machine.close(&id).await["status"], "closed");
        drop(offer);
    }
    let end = json!({"type":"end_of_candidates"});
    assert_eq!(
        machine.signal("s-0", 0, end.clone()).await,
        refusal("stream_not_found"),
        "the oldest closed id was forgotten"
    );
    assert_eq!(
        machine.signal("s-64", 0, end).await,
        refusal("stream_expired")
    );
}

#[tokio::test]
async fn open_refusals_name_the_failed_source() {
    let machine = Machine::new().await;
    let open = |source: Value| machine.open("s-1", 60_000, source);
    assert_eq!(
        open(json!({"kind":"display","display":7})).await,
        refusal("display_not_found")
    );
    assert_eq!(
        open(json!({"kind":"window","windowId":"w-42"})).await,
        refusal("window_not_found")
    );
    let outside = json!({"kind":"display","display":1,
        "region":{"x":4096,"y":0,"width":8,"height":8}});
    assert_eq!(
        open(outside).await,
        json!({"status":"refused","reason":"stream_not_available","message":"InvalidRegion"})
    );
    *machine.mode.lock().expect("mode") = Mode::Failing;
    assert_eq!(
        open(json!({"kind":"display","display":1})).await,
        json!({"status":"refused","reason":"stream_not_available","message":"capture busy"})
    );
    *machine.mode.lock().expect("mode") = Mode::Denied;
    assert_eq!(
        open(json!({"kind":"display","display":1})).await,
        refusal("permission_denied")
    );
    assert_eq!(machine.service.open_streams(), 0);
}

#[tokio::test]
async fn a_socket_or_peer_that_cannot_start_refuses_the_open() {
    let unbindable = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1));
    let mut machine = Machine::on(unbindable).await;
    machine.connect(&[COMPUTER_USE]);
    let refused = machine.display("s-1").await;
    assert_eq!(refused["reason"], "stream_not_available", "{refused}");
    let mut machine = Machine::on(IpAddr::V4(Ipv4Addr::UNSPECIFIED)).await;
    machine.connect(&[COMPUTER_USE]);
    let refused = machine.display("s-1").await;
    assert_eq!(refused["reason"], "encoder_failed", "{refused}");
    assert_eq!(machine.service.open_streams(), 0);
}

#[tokio::test]
async fn streams_need_an_attachment_and_computer_use() {
    let mut machine = Machine::on(LOOPBACK).await;
    let end = json!({"type":"end_of_candidates"});
    assert_eq!(
        machine.display("s-1").await,
        refusal("machine_not_attached")
    );
    assert_eq!(
        machine.signal("s-1", 0, end.clone()).await,
        refusal("machine_not_attached")
    );
    assert_eq!(machine.close("s-1").await, refusal("machine_not_attached"));
    machine.grant(&[COMPUTER_USE]);
    assert_eq!(
        machine.display("s-1").await,
        refusal("machine_not_attached")
    );
    machine.connect(&["screen.read"]);
    assert_eq!(
        machine.display("s-1").await,
        refusal("stream_not_available")
    );
    machine.grant(&[COMPUTER_USE]);
    assert_eq!(
        machine.signal("s-1", 0, end).await,
        refusal("stream_not_found")
    );
    assert_eq!(machine.close("s-1").await, refusal("stream_not_found"));
    assert!(machine.service.streams().is_empty());
    assert!(machine.calls.try_recv().is_err());
}

#[test]
fn the_host_candidate_address_is_routable() {
    assert!(!local_address().is_unspecified());
}

#[test]
fn a_malformed_answer_leaves_the_offer_for_a_corrected_one() {
    let now = Instant::now();
    let (mut session, offer) =
        Session::offer(bounds(10, Duration::from_secs(1)), false, &[OFFERER], now).expect("offer");
    let mut viewer = Rtc::builder().build(now);
    let answer = viewer
        .sdp_api()
        .accept_offer(SdpOffer::from_sdp_string(&offer.sdp).expect("sdp"))
        .expect("answer");
    assert!(session.answer("v=garbage").is_err());
    session
        .answer(&answer.to_sdp_string())
        .expect("the offer survived the malformed answer");
    assert!(!session.failed());
    let error = session
        .answer(&answer.to_sdp_string())
        .expect_err("consumed");
    assert_eq!(error, "no offer awaits an answer");
}

#[tokio::test]
async fn a_stream_awaiting_its_offer_ack_reports_what_it_retains() {
    let mut machine = Machine::new().await;
    assert_eq!(machine.display("s-1").await["status"], "opened");
    let offer = machine.uplinked().await;
    assert_eq!(offer.params["signal"]["type"], "offer");
    assert!(machine.service.retained().stream_bytes >= 64 * 48 * 4);
    let [observation] = machine.observations().try_into().expect("one stream");
    assert!(observation.retained_bytes >= 64 * 48 * 4);
    assert_eq!(machine.close("s-1").await["status"], "closed");
    assert_eq!(machine.service.retained().stream_bytes, 0);
    assert!(machine.observations().is_empty());
    drop(offer);
}

#[test]
fn an_mdns_viewer_candidate_is_skipped_and_the_viewer_is_learned_from_its_checks() {
    let now = Instant::now();
    let (mut session, offer) =
        Session::offer(bounds(10, Duration::from_secs(1)), false, &[OFFERER], now).expect("offer");
    let mut viewer = Rtc::builder().build(now);
    viewer
        .add_local_candidate(Candidate::host(VIEWER, "udp").expect("host"))
        .expect("local candidate");
    for line in &offer.candidates {
        viewer.add_remote_candidate(Candidate::from_sdp_string(line).expect("candidate"));
    }
    let answer = viewer
        .sdp_api()
        .accept_offer(SdpOffer::from_sdp_string(&offer.sdp).expect("sdp"))
        .expect("answer");
    session.answer(&answer.to_sdp_string()).expect("accepted");
    session
        .candidate("candidate:1 1 UDP 2122260223 0b6c1f4e-viewer.local 6000 typ host")
        .expect("an mDNS candidate is skipped, not refused");
    let mut pair = Pair {
        session,
        viewer,
        now,
        events: Vec::new(),
        cut: false,
    };
    pair.until(|pair| pair.session.live());
}
