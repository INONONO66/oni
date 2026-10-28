//! Screen enumeration and bounded capture (#1662). A [`Source`] reports
//! displays, windows and raw RGBA8 frames; region bounds, downscale, the
//! PNG/JPEG byte cap and the frame pool are shared, so the headless
//! [`fixture`] adapter drives the same path as the native backend.

mod encode;
pub mod fixture;
#[cfg(target_os = "macos")]
pub mod native;
mod pool;

use std::{
    num::NonZeroU64,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, PoisonError,
    },
};

use base64::{engine::general_purpose::STANDARD, Engine};
use oni_protocol::{
    screen_capture_request::{ScreenCaptureRequestEncoding, ScreenCaptureRequestTarget},
    ScreenCaptureRequest, ScreenListRequest, ScreenReadRequest,
};
use serde_json::{json, Value};

use crate::attach::now_ms;
use encode::{Encoding, Format};
use pool::Pool;

pub const MAX_BYTES: usize = 4_194_304;
pub const MAX_DIMENSION: u32 = 16_384;
const MAX_DISPLAYS: usize = 16;
const MAX_WINDOWS: usize = 512;
const MAX_TEXT: usize = 256;
const COORDINATE: i64 = 16_384;
/// Simultaneous captures the native backend allows.
pub const CAPTURES: usize = 2;

/// A display in points; `x`/`y` place it in the global desktop space.
#[derive(Clone, Debug, PartialEq)]
pub struct Display {
    pub id: u32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    pub primary: bool,
}

/// A window with global bounds in points on the display `display` (a
/// [`Display::id`]).
#[derive(Clone, Debug, PartialEq)]
pub struct Window {
    pub id: u32,
    pub display: u32,
    pub title: String,
    pub owner: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fault {
    Absent,
    Permission,
    InvalidRegion,
    DisplayNotFound,
    WindowNotFound,
    Failed(String),
}

impl Fault {
    fn reason(&self) -> &'static str {
        match self {
            Self::Absent => "screen_not_available",
            Self::Permission => "permission_denied",
            Self::InvalidRegion => "invalid_region",
            Self::DisplayNotFound => "display_not_found",
            Self::WindowNotFound => "window_not_found",
            Self::Failed(_) => "capture_failed",
        }
    }

    fn refusal(&self) -> Value {
        match self {
            Self::Failed(message) => json!({
                "status":"refused","reason":self.reason(),
                "message":message.chars().take(MAX_TEXT).collect::<String>()
            }),
            _ => json!({"status":"refused","reason":self.reason()}),
        }
    }

    /// The legacy `screen_read` refusal has no message and no target
    /// reasons: an unknown display is an invalid region there.
    fn legacy(&self) -> Value {
        let reason = match self {
            Self::DisplayNotFound | Self::WindowNotFound => "invalid_region",
            other => other.reason(),
        };
        json!({"status":"refused","reason":reason})
    }
}

/// A capture backend. `capture_*` clear `pixels`, fill it with an RGBA8
/// frame and return its pixel size.
pub trait Source: Send + Sync {
    /// `Err(Fault::Permission)` when capture is not permitted.
    fn ready(&self) -> Result<(), Fault>;
    fn displays(&self) -> Result<Vec<Display>, Fault>;
    fn windows(&self) -> Result<Vec<Window>, Fault>;
    fn capture_display(&self, display: u32, pixels: &mut Vec<u8>) -> Result<(u32, u32), Fault>;
    fn capture_window(&self, window: u32, pixels: &mut Vec<u8>) -> Result<(u32, u32), Fault>;
}

struct Region {
    x: i64,
    y: i64,
    width: u64,
    height: u64,
}

enum Target {
    Display(u64, Option<Region>),
    Window(String),
}

struct Shot<'a> {
    id: String,
    display: usize,
    width: u32,
    height: u32,
    downscaled: bool,
    data: &'a [u8],
}

/// The latest successful capture: input names it, and only it, as its anchor.
struct Anchor {
    seq: u64,
    id: String,
    display: Display,
}

pub struct Screen {
    source: Option<Box<dyn Source>>,
    available: bool,
    pool: Pool,
    next: AtomicU64,
    latest: Mutex<Option<Anchor>>,
}

impl Screen {
    pub fn absent() -> Self {
        Self {
            source: None,
            available: false,
            pool: Pool::new(0),
            next: AtomicU64::new(0),
            latest: Mutex::new(None),
        }
    }

    /// Available only when the source is permitted and reports a display.
    pub fn new(source: Box<dyn Source>, captures: usize) -> Self {
        let available =
            source.ready().is_ok() && source.displays().is_ok_and(|displays| !displays.is_empty());
        Self {
            source: Some(source),
            available,
            pool: Pool::new(captures),
            next: AtomicU64::new(0),
            latest: Mutex::new(None),
        }
    }

    #[cfg(target_os = "macos")]
    pub fn platform() -> Self {
        Self::new(Box::new(native::Native), CAPTURES)
    }

    /// No native backend off macOS: the screen is absent.
    #[cfg(not(target_os = "macos"))]
    pub fn platform() -> Self {
        Self::absent()
    }

    pub fn available(&self) -> bool {
        self.available
    }

    /// Recheck permission and displays at each report, not just at attach.
    pub fn probe(&self) -> Option<Result<bool, Fault>> {
        self.source.as_deref().map(|source| {
            source.ready()?;
            source.displays().map(|displays| !displays.is_empty())
        })
    }

    pub fn retained(&self) -> usize {
        self.pool.retained()
    }

    pub fn release(&self) {
        self.pool.release();
    }

    fn latest(&self) -> std::sync::MutexGuard<'_, Option<Anchor>> {
        self.latest.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Records capture `seq` as the anchor unless a later one already is.
    fn anchor(&self, seq: u64, id: &str, display: &Display) {
        let mut latest = self.latest();
        if latest.as_ref().is_none_or(|anchor| anchor.seq < seq) {
            *latest = Some(Anchor {
                seq,
                id: id.to_owned(),
                display: display.clone(),
            });
        }
    }

    /// The display `capture` was taken on, as it stands now: `Ok(None)` when
    /// `capture` is not the latest capture, or its display has since gone or
    /// moved, so input anchored to it would land somewhere else;
    /// `Fault::Absent` when no display is active at all.
    pub fn anchored(&self, capture: &str) -> Result<Option<Display>, Fault> {
        let current = self.source()?.displays()?;
        if current.is_empty() {
            return Err(Fault::Absent);
        }
        let latest = self.latest();
        Ok(latest
            .as_ref()
            .filter(|anchor| anchor.id == capture && current.contains(&anchor.display))
            .map(|anchor| anchor.display.clone()))
    }

    /// Drops the anchor: no capture taken before this call admits input.
    pub fn forget(&self) {
        *self.latest() = None;
    }

    pub fn list(&self, request: &ScreenListRequest) -> Value {
        self.listing(request.windows.unwrap_or(false))
            .unwrap_or_else(|fault| fault.refusal())
    }

    pub fn capture(&self, request: &ScreenCaptureRequest) -> Value {
        let (format, quality) = match request.encoding {
            ScreenCaptureRequestEncoding::Png => (Format::Png, 0),
            ScreenCaptureRequestEncoding::Jpeg(quality) => {
                (Format::Jpeg, u8::try_from(quality.get()).unwrap_or(100))
            }
        };
        let encoding = Encoding {
            format,
            quality,
            max_bytes: request.max_bytes.map_or(MAX_BYTES, |bytes| {
                usize::try_from(bytes.get())
                    .unwrap_or(MAX_BYTES)
                    .min(MAX_BYTES)
            }),
            max_dimension: request.max_dimension.map_or(MAX_DIMENSION, |side| {
                u32::try_from(side.get())
                    .unwrap_or(MAX_DIMENSION)
                    .min(MAX_DIMENSION)
            }),
        };
        let target = match &request.target {
            ScreenCaptureRequestTarget::Display { display, region } => Target::Display(
                display.get(),
                region.as_ref().map(|region| Region {
                    x: region.x,
                    y: region.y,
                    width: region.width.get(),
                    height: region.height.get(),
                }),
            ),
            ScreenCaptureRequestTarget::Window { window_id } => {
                Target::Window(window_id.to_string())
            }
        };
        self.shoot(&target, &encoding, |shot| {
            json!({
                "status":"ok","captureId":shot.id,"display":shot.display,
                "format":format.name(),"data":STANDARD.encode(shot.data),
                "width":shot.width,"height":shot.height,
                "downscaled":shot.downscaled,"observedAt":now_ms()
            })
        })
        .unwrap_or_else(|fault| fault.refusal())
    }

    /// The legacy whole-or-region PNG read of one display (default 1).
    pub fn read(&self, request: &ScreenReadRequest) -> Value {
        let region = request.region.as_ref().map(|region| Region {
            x: region.x,
            y: region.y,
            width: region.width.get(),
            height: region.height.get(),
        });
        let target = Target::Display(request.display.map_or(1, NonZeroU64::get), region);
        let encoding = Encoding {
            format: Format::Png,
            quality: 0,
            max_bytes: MAX_BYTES,
            max_dimension: MAX_DIMENSION,
        };
        self.shoot(
            &target,
            &encoding,
            |shot| json!({"status":"ok","captureId":shot.id,"png":STANDARD.encode(shot.data)}),
        )
        .unwrap_or_else(|fault| fault.legacy())
    }

    fn source(&self) -> Result<&dyn Source, Fault> {
        let source = self.source.as_deref().ok_or(Fault::Absent)?;
        source.ready()?;
        Ok(source)
    }

    fn listing(&self, windows: bool) -> Result<Value, Fault> {
        let source = self.source()?;
        let all = source.displays()?;
        let displays = shown(&all)?;
        let mut truncated = all.len() > displays.len();
        let mut rows = Vec::new();
        if windows {
            for window in source.windows()? {
                let Some(index) = displays
                    .iter()
                    .position(|display| display.id == window.display)
                else {
                    truncated = true;
                    continue;
                };
                if rows.len() == MAX_WINDOWS {
                    truncated = true;
                    break;
                }
                rows.push(window_row(&window, index, &displays[index]));
            }
        }
        let displays: Vec<Value> = displays
            .iter()
            .enumerate()
            .map(|(index, display)| display_row(index, display))
            .collect();
        Ok(json!({
            "status":"ok","displays":displays,"windows":rows,
            "truncated":truncated,"observedAt":now_ms()
        }))
    }

    fn shoot(
        &self,
        target: &Target,
        encoding: &Encoding,
        render: impl FnOnce(Shot<'_>) -> Value,
    ) -> Result<Value, Fault> {
        let source = self.source()?;
        let all = source.displays()?;
        let displays = shown(&all)?;
        let mut lease = self
            .pool
            .acquire()
            .ok_or_else(|| Fault::Failed("frame pool saturated".to_owned()))?;
        let slot = &mut lease.slot;
        let (display, anchor, size) = raw(source, displays, target, &mut slot.pixels)?;
        let fitted = encode::fit(
            &slot.pixels,
            size,
            encoding,
            &mut slot.scratch,
            &mut slot.encoded,
        )?;
        let seq = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let id = format!("cap-{seq}");
        self.anchor(seq, &id, anchor);
        let value = render(Shot {
            id,
            display,
            width: fitted.width,
            height: fitted.height,
            downscaled: fitted.downscaled,
            data: &slot.encoded,
        });
        lease.keep();
        Ok(value)
    }
}

/// Captures `target` into `pixels` (cropped to its region): the 1-based
/// display index, that display and the frame's pixel size.
fn raw<'a>(
    source: &dyn Source,
    displays: &'a [Display],
    target: &Target,
    frame: &mut Vec<u8>,
) -> Result<(usize, &'a Display, (u32, u32)), Fault> {
    match target {
        Target::Display(number, region) => {
            let index = usize::try_from(*number)
                .ok()
                .filter(|index| (1..=displays.len()).contains(index))
                .ok_or(Fault::DisplayNotFound)?;
            let display = &displays[index - 1];
            let points = region
                .as_ref()
                .map(|region| bounds(region, display))
                .transpose()?;
            let size = source.capture_display(display.id, frame)?;
            let size = match points {
                Some((columns, rows)) => {
                    let columns = pixels(columns, display.width, size.0);
                    let rows = pixels(rows, display.height, size.1);
                    encode::crop(frame, size.0, columns, rows)
                }
                None => size,
            };
            Ok((index, display, size))
        }
        Target::Window(id) => {
            let id: u32 = id.parse().map_err(|_| Fault::WindowNotFound)?;
            let window = source
                .windows()?
                .into_iter()
                .find(|window| window.id == id)
                .ok_or(Fault::WindowNotFound)?;
            let index = displays
                .iter()
                .position(|display| display.id == window.display)
                .ok_or(Fault::WindowNotFound)?;
            let size = source.capture_window(id, frame)?;
            Ok((index + 1, &displays[index], size))
        }
    }
}

/// The displays the wire can carry (at most 16); none is an absent screen.
fn shown(displays: &[Display]) -> Result<&[Display], Fault> {
    if displays.is_empty() {
        return Err(Fault::Absent);
    }
    Ok(&displays[..displays.len().min(MAX_DISPLAYS)])
}

fn side(points: u32) -> u32 {
    points.clamp(1, MAX_DIMENSION)
}

fn display_row(index: usize, display: &Display) -> Value {
    let scale = if display.scale > 0.0 {
        display.scale.min(8.0)
    } else {
        1.0
    };
    json!({
        "display":index + 1,"width":side(display.width),"height":side(display.height),
        "scale":scale,"primary":display.primary
    })
}

fn window_row(window: &Window, index: usize, display: &Display) -> Value {
    let offset =
        |at: i32, origin: i32| (i64::from(at) - i64::from(origin)).clamp(-COORDINATE, COORDINATE);
    json!({
        "windowId":window.id.to_string(),"display":index + 1,
        "title":window.title.chars().take(MAX_TEXT).collect::<String>(),
        "owner":window.owner.chars().take(MAX_TEXT).collect::<String>(),
        "bounds":{
            "x":offset(window.x, display.x),"y":offset(window.y, display.y),
            "width":window.width.min(MAX_DIMENSION),"height":window.height.min(MAX_DIMENSION)
        }
    })
}

/// The region's point ranges, refused unless inside the display.
fn bounds(
    region: &Region,
    display: &Display,
) -> Result<(std::ops::Range<u64>, std::ops::Range<u64>), Fault> {
    let start = |at: i64| u64::try_from(at).map_err(|_| Fault::InvalidRegion);
    let (x, y) = (start(region.x)?, start(region.y)?);
    let (right, bottom) = (x + region.width, y + region.height);
    if right > u64::from(display.width) || bottom > u64::from(display.height) {
        return Err(Fault::InvalidRegion);
    }
    Ok((x..right, y..bottom))
}

/// Maps a point range on a `points`-wide axis onto a `pixels`-wide frame,
/// covering every partially included pixel and at least one.
fn pixels(range: std::ops::Range<u64>, points: u32, pixels: u32) -> std::ops::Range<u32> {
    let (points, frame) = (u64::from(points), u64::from(pixels));
    let start = (range.start * frame / points).min(frame - 1);
    let end = range.end * frame;
    let end = end.div_ceil(points).clamp(start + 1, frame);
    start as u32..end as u32
}

impl Screen {
    /// One RGBA8 video frame of a stream's `source` into `out`, captured
    /// through the frame pool and box-scaled to fit `max_dimension` with even
    /// sides; a saturated pool is `Fault::Failed`.
    pub fn frame(
        &self,
        source: &oni_protocol::stream_open_request::StreamOpenRequestSource,
        max_dimension: u32,
        out: &mut Vec<u8>,
    ) -> Result<(u32, u32), Fault> {
        use oni_protocol::stream_open_request::StreamOpenRequestSource as Feed;
        let target = match source {
            Feed::Display { display, region } => Target::Display(
                display.get(),
                region.as_ref().map(|region| Region {
                    x: region.x,
                    y: region.y,
                    width: region.width.get(),
                    height: region.height.get(),
                }),
            ),
            Feed::Window { window_id } => Target::Window(window_id.to_string()),
        };
        let capture = self.source()?;
        let all = capture.displays()?;
        let displays = shown(&all)?;
        let mut lease = self
            .pool
            .acquire()
            .ok_or_else(|| Fault::Failed("frame pool saturated".to_owned()))?;
        let (_, _, size) = raw(capture, displays, &target, &mut lease.slot.pixels)?;
        let scaled = encode::even(&lease.slot.pixels, size, max_dimension, out);
        lease.keep();
        Ok(scaled)
    }
}
