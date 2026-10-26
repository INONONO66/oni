//! The encoded-video path of a live stream (#1662): RGBA8 frames from the
//! screen's frame pool become H.264 access units through openh264 (built
//! from its bundled source, so Linux headless and macOS share one encoder).
//! [`Budget`] decides on an injected clock which frames are due (the fps
//! cap), which must be keyframes (the interval or a receiver's request) and
//! what quality the encoder runs at: it adapts under congestion but never
//! leaves the bounds the host set. A unit above `max_frame_bytes` is
//! dropped, never split, and the next frame is a keyframe.

use std::time::{Duration, Instant};

use openh264::{
    encoder::{BitRate, Encoder as H264, EncoderConfig, FrameRate, FrameType},
    formats::{RgbaSliceU8, YUVBuffer, YUVSource},
    OpenH264API,
};

/// The floor congestion steps the bitrate down to (or the host's maximum, if lower).
pub const MIN_BITRATE: u64 = 64_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bounds {
    pub max_fps: u32,
    pub keyframe_interval: Duration,
    pub max_bitrate: u64,
    pub max_dimension: u32,
    pub max_frame_bytes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quality {
    pub bitrate: u64,
    pub fps: u32,
    pub dimension: u32,
}

pub struct Budget {
    bounds: Bounds,
    quality: Quality,
    next: Option<Instant>,
    keyframe_at: Option<Instant>,
    keyframe_wanted: bool,
}

impl Budget {
    pub fn new(bounds: Bounds) -> Self {
        Self {
            bounds,
            quality: Quality {
                bitrate: bounds.max_bitrate,
                fps: bounds.max_fps,
                dimension: bounds.max_dimension,
            },
            next: None,
            keyframe_at: None,
            keyframe_wanted: true,
        }
    }

    pub fn quality(&self) -> Quality {
        self.quality
    }

    /// When the next frame is due; `None` before the first one.
    pub fn next(&self) -> Option<Instant> {
        self.next
    }

    /// Admits a frame at `now` when one is due at the current fps. Frames
    /// keep their cadence; after a stall the next one is a period away.
    pub fn due(&mut self, now: Instant) -> bool {
        if self.next.is_some_and(|next| now < next) {
            return false;
        }
        let period = Duration::from_secs(1) / self.quality.fps;
        self.next = Some(match self.next {
            Some(next) if now < next + period => next + period,
            _ => now + period,
        });
        true
    }

    pub fn keyframe(&self, now: Instant) -> bool {
        self.keyframe_wanted
            || self
                .keyframe_at
                .is_none_or(|at| now.duration_since(at) >= self.bounds.keyframe_interval)
    }

    fn sent(&mut self, now: Instant, keyframe: bool) {
        if keyframe {
            self.keyframe_at = Some(now);
            self.keyframe_wanted = false;
        }
    }

    pub fn request_keyframe(&mut self) {
        self.keyframe_wanted = true;
    }

    /// Targets `bitrate` clamped to the bounds; fps and dimension follow its
    /// share of the maximum in quarters (fps 1/5..5/5, dimension 4/8..8/8).
    /// Only a material change is taken (another fps or dimension, or a
    /// bitrate a quarter away), since every retune costs a keyframe. True
    /// when the quality changed.
    fn target(&mut self, bitrate: u64) -> bool {
        let max = self.bounds.max_bitrate;
        let bitrate = bitrate.clamp(MIN_BITRATE.min(max), max);
        let quarters = (u128::from(bitrate) * 4 / u128::from(max)) as u32;
        let quality = Quality {
            bitrate,
            fps: (self.bounds.max_fps * (quarters + 1) / 5).max(1),
            dimension: (self.bounds.max_dimension * (quarters + 4) / 8).max(2),
        };
        let material = quality.fps != self.quality.fps
            || quality.dimension != self.quality.dimension
            || quality.bitrate.abs_diff(self.quality.bitrate) * 4 >= self.quality.bitrate;
        if material {
            self.quality = quality;
        }
        material
    }

    /// The transport's bandwidth estimate: the encoder aims at 90% of it.
    pub fn estimate(&mut self, bps: u64) -> bool {
        self.target(bps / 10 * 9)
    }

    /// A local backlog halves the target.
    pub fn congested(&mut self) -> bool {
        self.target(self.quality.bitrate / 2)
    }
}

fn build(quality: Quality) -> Result<H264, String> {
    let bitrate = u32::try_from(quality.bitrate).unwrap_or(u32::MAX);
    let config = EncoderConfig::new()
        .bitrate(BitRate::from_bps(bitrate))
        .max_frame_rate(FrameRate::from_hz(quality.fps as f32))
        .skip_frames(false);
    H264::with_api_config(OpenH264API::from_source(), config).map_err(super::failure)
}

pub struct Encoder {
    h264: H264,
    quality: Quality,
    yuv: Option<YUVBuffer>,
    out: Vec<u8>,
}

impl Encoder {
    pub fn new(quality: Quality) -> Result<Self, String> {
        Ok(Self {
            h264: build(quality)?,
            quality,
            yuv: None,
            out: Vec::new(),
        })
    }

    /// Re-tunes to `quality` with a fresh encoder, whose first unit is a keyframe.
    pub fn tune(&mut self, quality: Quality) -> Result<(), String> {
        self.h264 = build(quality)?;
        self.quality = quality;
        Ok(())
    }

    /// Encodes one RGBA8 frame of even `size` into an Annex-B access unit;
    /// `keyframe` forces an IDR; a new size restarts the encoder. Returns the
    /// unit and whether it is a keyframe.
    pub fn encode(
        &mut self,
        rgba: &[u8],
        size: (u32, u32),
        keyframe: bool,
    ) -> Result<(&[u8], bool), String> {
        let dimensions = (size.0 as usize, size.1 as usize);
        let mut yuv = match self.yuv.take() {
            Some(yuv) if yuv.dimensions() == dimensions => yuv,
            Some(_) => {
                self.h264 = build(self.quality)?;
                YUVBuffer::new(dimensions.0, dimensions.1)
            }
            None => YUVBuffer::new(dimensions.0, dimensions.1),
        };
        yuv.read_rgba8(RgbaSliceU8::new(rgba, dimensions));
        if keyframe {
            self.h264.force_intra_frame();
        }
        self.out.clear();
        let key = {
            let bits = self.h264.encode(&yuv).map_err(super::failure)?;
            bits.write_vec(&mut self.out);
            matches!(bits.frame_type(), FrameType::IDR | FrameType::I)
        };
        self.yuv = Some(yuv);
        Ok((&self.out, key))
    }

    /// The bytes held between frames: the YUV planes and the last unit.
    pub fn retained(&self) -> usize {
        let planes = self.yuv.as_ref().map_or(0, |yuv| {
            let (width, height) = yuv.dimensions();
            width * height * 3 / 2
        });
        planes + self.out.capacity()
    }
}

/// Cumulative counters since open; [`Stats::rates`] turns two of them into
/// one report window.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub frames: u64,
    pub bytes: u64,
    pub encoded: u64,
    pub encoding: Duration,
    pub dropped: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rates {
    pub fps: f64,
    pub bytes_per_second: u64,
    pub encode_ms: f64,
    pub dropped_frames: u64,
}

impl Stats {
    /// The window from `earlier` to these counters over `elapsed` (at least
    /// a millisecond); fps and encode time are clamped to the wire bounds.
    pub fn rates(&self, earlier: &Self, elapsed: Duration) -> Rates {
        let seconds = elapsed.max(Duration::from_millis(1)).as_secs_f64();
        let encoded = self.encoded - earlier.encoded;
        let encoding = self.encoding - earlier.encoding;
        Rates {
            fps: ((self.frames - earlier.frames) as f64 / seconds).min(f64::from(super::MAX_FPS)),
            bytes_per_second: ((self.bytes - earlier.bytes) as f64 / seconds) as u64,
            encode_ms: (encoding.as_secs_f64() * 1000.0 / encoded.max(1) as f64)
                .min(super::MAX_ENCODE_MS),
            dropped_frames: self.dropped,
        }
    }
}

/// One stream's encoder side: the budget, the encoder and its counters.
pub struct Video {
    pub budget: Budget,
    encoder: Encoder,
    bounds: Bounds,
    pub stats: Stats,
}

impl Video {
    pub fn new(bounds: Bounds) -> Result<Self, String> {
        let budget = Budget::new(bounds);
        Ok(Self {
            encoder: Encoder::new(budget.quality())?,
            budget,
            bounds,
            stats: Stats::default(),
        })
    }

    fn adapted(&mut self, changed: bool) -> Result<(), String> {
        if changed {
            self.encoder.tune(self.budget.quality())?;
        }
        Ok(())
    }

    pub fn estimate(&mut self, bps: u64) -> Result<(), String> {
        let changed = self.budget.estimate(bps);
        self.adapted(changed)
    }

    /// A frame the transport could not take: it counts as dropped, the
    /// quality backs off and the next frame is a keyframe.
    pub fn backlog(&mut self) -> Result<(), String> {
        self.stats.dropped += 1;
        self.budget.request_keyframe();
        let changed = self.budget.congested();
        self.adapted(changed)
    }

    /// Encodes the frame admitted at `now`: `None` when the unit was dropped
    /// (empty or above `max_frame_bytes`), else the unit and its keyframe flag.
    pub fn encode(
        &mut self,
        now: Instant,
        rgba: &[u8],
        size: (u32, u32),
    ) -> Result<Option<(Vec<u8>, bool)>, String> {
        let keyframe = self.budget.keyframe(now);
        let started = Instant::now();
        let (unit, key) = self.encoder.encode(rgba, size, keyframe)?;
        self.stats.encoded += 1;
        self.stats.encoding += started.elapsed();
        if unit.is_empty() || unit.len() > self.bounds.max_frame_bytes {
            self.stats.dropped += 1;
            self.budget.request_keyframe();
            return Ok(None);
        }
        self.budget.sent(now, key);
        self.stats.frames += 1;
        self.stats.bytes += unit.len() as u64;
        Ok(Some((unit.to_vec(), key)))
    }

    pub fn retained(&self) -> usize {
        self.encoder.retained()
    }
}
