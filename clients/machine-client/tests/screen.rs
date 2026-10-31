#[path = "support/ordinary_focus.rs"]
mod ordinary_focus;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use oni_machine_client::screen::{fixture::Fixture, Display, Fault, Screen, Source, Window};
use oni_protocol::{
    ScreenCaptureRequest, ScreenCaptureResult, ScreenListRequest, ScreenListResult,
    ScreenReadRequest, ScreenReadResult,
};
use serde_json::{json, Value};

fn display(id: u32, x: i32, width: u32, height: u32, scale: f32) -> Display {
    Display {
        id,
        x,
        y: 0,
        width,
        height,
        scale,
        primary: id == 1,
    }
}

fn window(id: u32, display: u32, x: i32, y: i32, width: u32, height: u32) -> Window {
    Window {
        id,
        display,
        title: format!("window {id}"),
        owner: "Fixture".into(),
        pid: None,
        app: None,
        x,
        y,
        width,
        height,
    }
}

fn screen(fixture: Fixture) -> Screen {
    ordinary_focus::screen(fixture, 2, &[4])
}

fn list(screen: &Screen, params: Value) -> Value {
    let request: ScreenListRequest = oni_protocol::decode(params).expect("list request");
    let answer = screen.list(&request);
    oni_protocol::decode::<ScreenListResult>(answer.clone()).expect("list result");
    answer
}

fn capture(screen: &Screen, params: Value) -> Value {
    let request: ScreenCaptureRequest = oni_protocol::decode(params).expect("capture request");
    let answer = screen.capture(&request);
    oni_protocol::decode::<ScreenCaptureResult>(answer.clone()).expect("capture result");
    answer
}

fn read(screen: &Screen, params: Value) -> Value {
    let request: ScreenReadRequest = oni_protocol::decode(params).expect("read request");
    let answer = screen.read(&request);
    oni_protocol::decode::<ScreenReadResult>(answer.clone()).expect("read result");
    answer
}

fn whole(display: u32) -> Value {
    json!({"target":{"kind":"display","display":display},"encoding":{"format":"png"}})
}

fn image(answer: &Value, field: &str) -> Vec<u8> {
    STANDARD
        .decode(answer[field].as_str().expect("data"))
        .expect("base64")
}

fn refusal(reason: &str) -> Value {
    json!({"status":"refused","reason":reason})
}

struct DeniedAx(Fault);
impl oni_machine_client::screen::ax::Observer for DeniedAx {
    fn focused(
        &self,
        _: &oni_machine_client::screen::ax::WindowIdentity,
    ) -> Result<Option<oni_machine_client::screen::private::Focused>, Fault> {
        Err(self.0.clone())
    }
    fn windows(&self) -> Result<Vec<oni_machine_client::screen::ax::WindowIdentity>, Fault> {
        Err(self.0.clone())
    }
    fn walk(
        &self,
        _: &oni_machine_client::screen::ax::WindowIdentity,
        _: &oni_machine_client::screen::ax::Bounds,
    ) -> Result<oni_machine_client::screen::ax::Walk, Fault> {
        Err(Fault::Permission)
    }
    fn act(
        &self,
        _: &oni_machine_client::screen::ax::WindowIdentity,
        _: &[oni_machine_client::screen::ax::Segment],
        _: oni_machine_client::screen::ax::Admit<'_>,
        _: &oni_machine_client::screen::ax::Action,
    ) -> Result<(), oni_machine_client::screen::ax::ActFault> {
        Err(oni_machine_client::screen::ax::ActFault::Permission)
    }
}

#[test]
fn window_capture_refuses_when_accessibility_is_denied() {
    let mut source = Fixture::display(8, 8, 1.0);
    source.windows.push(window(7, 1, 0, 0, 8, 8));
    let granted = screen(source.clone()).observing(Box::new(DeniedAx(Fault::Permission)));
    assert_eq!(
        capture(
            &granted,
            json!({"target":{"kind":"window","windowId":"7"},"encoding":{"format":"png"}})
        ),
        refusal("permission_denied")
    );
    let failed = screen(source).observing(Box::new(DeniedAx(Fault::Failed(
        "source unavailable".into(),
    ))));
    assert_eq!(
        capture(
            &failed,
            json!({"target":{"kind":"window","windowId":"7"},"encoding":{"format":"png"}})
        )["reason"],
        "capture_failed"
    );
}

#[test]
fn an_absent_or_unpermitted_screen_refuses_typed() {
    let absent = Screen::absent();
    assert!(!absent.available());
    assert_eq!(list(&absent, json!({})), refusal("screen_not_available"));
    assert_eq!(capture(&absent, whole(1)), refusal("screen_not_available"));
    assert_eq!(read(&absent, json!({})), refusal("screen_not_available"));
    assert_eq!(absent.retained(), 0);

    let headless = screen(Fixture::default());
    assert!(headless.available());
    assert_eq!(list(&headless, json!({})), refusal("screen_not_available"));
    assert_eq!(
        capture(&headless, whole(1)),
        refusal("screen_not_available")
    );

    let denied = screen(Fixture {
        denied: true,
        ..Fixture::display(8, 8, 1.0)
    });
    assert!(denied.available());
    assert_eq!(list(&denied, json!({})), refusal("permission_denied"));
    assert_eq!(capture(&denied, whole(1)), refusal("permission_denied"));
    assert_eq!(read(&denied, json!({})), refusal("permission_denied"));
    assert!(screen(Fixture::display(8, 8, 1.0)).available());
}

#[test]
fn listing_numbers_displays_and_places_windows_relative_to_them() {
    let mut displays: Vec<Display> = (1..=17)
        .map(|id| display(id, i32::try_from(id).expect("id") * 100, 100, 80, 1.0))
        .collect();
    displays[1].scale = 0.0;
    displays[2].scale = 12.0;
    displays[3].width = 0;
    let mut long = window(7, 2, 210, 5, 50, 40);
    long.title = "t".repeat(300);
    let fixture = Fixture {
        windows: vec![
            window(5, 1, 110, 10, 30, 20),
            long,
            window(9, 1, -40_000, 0, 20_000, 10),
            window(11, 17, 0, 0, 10, 10),
        ],
        displays,
        ..Fixture::default()
    };
    let screen = screen(fixture);

    let bare = list(&screen, json!({}));
    assert_eq!(bare["windows"], json!([]));
    assert_eq!(bare["truncated"], true);
    let shown = bare["displays"].as_array().expect("displays");
    assert_eq!(shown.len(), 16);
    assert_eq!(
        shown[0],
        json!({"display":1,"width":100,"height":80,"scale":1.0,"primary":true})
    );
    assert_eq!(
        (&shown[1]["scale"], &shown[2]["scale"], &shown[3]["width"]),
        (&json!(1.0), &json!(8.0), &json!(1))
    );

    let full = list(&screen, json!({"windows":true}));
    let windows = full["windows"].as_array().expect("windows");
    assert_eq!(windows.len(), 3);
    assert_eq!(
        windows[0],
        json!({"windowId":"5","display":1,"title":"window 5","owner":"Fixture",
               "bounds":{"x":10,"y":10,"width":30,"height":20}})
    );
    assert_eq!(windows[1]["display"], 2);
    assert_eq!(windows[1]["bounds"]["x"], 10);
    assert_eq!(windows[1]["title"].as_str().expect("title").len(), 256);
    assert_eq!(
        windows[2]["bounds"],
        json!({"x":-16384,"y":0,"width":16384,"height":10})
    );
    assert_eq!(full["truncated"], true);
}

#[test]
fn listing_caps_windows_at_the_wire_limit() {
    let fixture = Fixture {
        windows: (1..=513).map(|id| window(id, 1, 0, 0, 1, 1)).collect(),
        ..Fixture::display(10, 10, 1.0)
    };
    let screen = screen(fixture);
    let full = list(&screen, json!({"windows":true}));
    assert_eq!(full["windows"].as_array().expect("windows").len(), 512);
    assert_eq!(full["truncated"], true);
    let exact = list(
        &self::screen(Fixture::display(10, 10, 1.0)),
        json!({"windows":true}),
    );
    assert_eq!(exact["truncated"], false);
}

#[test]
fn captures_target_displays_windows_and_regions_in_pixels() {
    let fixture = Fixture {
        displays: vec![display(1, 0, 40, 30, 2.0), display(2, 40, 20, 10, 1.5)],
        windows: vec![window(4, 2, 45, 0, 12, 6), window(8, 3, -100, 0, 5, 5)],
        ..Fixture::default()
    };
    let screen = screen(fixture);

    let first = capture(&screen, whole(1));
    assert_eq!(
        (
            &first["status"],
            &first["display"],
            &first["width"],
            &first["height"]
        ),
        (&json!("ok"), &json!(1), &json!(80), &json!(60))
    );
    assert_eq!(
        (&first["format"], &first["downscaled"]),
        (&json!("png"), &json!(false))
    );
    let decoded = image::load_from_memory(&image(&first, "data")).expect("png");
    assert_eq!((decoded.width(), decoded.height()), (80, 60));

    let second = capture(&screen, whole(2));
    assert_eq!(
        (&second["width"], &second["height"]),
        (&json!(30), &json!(15))
    );
    assert_ne!(first["captureId"], second["captureId"]);

    let region = json!({"target":{"kind":"display","display":1,
        "region":{"x":10,"y":5,"width":20,"height":10}},"encoding":{"format":"png"}});
    let cropped = capture(&screen, region);
    assert_eq!(
        (&cropped["width"], &cropped["height"]),
        (&json!(40), &json!(20))
    );
    let fractional = json!({"target":{"kind":"display","display":2,
        "region":{"x":1,"y":1,"width":3,"height":1}},"encoding":{"format":"png"}});
    let fractional = capture(&screen, fractional);
    assert_eq!(
        (&fractional["width"], &fractional["height"]),
        (&json!(5), &json!(2))
    );
    let edge = json!({"target":{"kind":"display","display":1,
        "region":{"x":30,"y":20,"width":10,"height":10}},"encoding":{"format":"png"}});
    assert_eq!(capture(&screen, edge)["width"], 20);

    for (x, y, width, height) in [(31, 0, 10, 1), (0, 21, 1, 10)] {
        let outside = json!({"target":{"kind":"display","display":1,
            "region":{"x":x,"y":y,"width":width,"height":height}},"encoding":{"format":"png"}});
        assert_eq!(capture(&screen, outside), refusal("invalid_region"));
    }
    assert_eq!(capture(&screen, whole(3)), refusal("display_not_found"));

    let window =
        |id: &str| json!({"target":{"kind":"window","windowId":id},"encoding":{"format":"png"}});
    let shot = capture(&screen, window("4"));
    assert_eq!(
        (&shot["display"], &shot["width"], &shot["height"]),
        (&json!(2), &json!(12), &json!(6))
    );
    for missing in ["99", "not-a-number", "8"] {
        assert_eq!(
            capture(&screen, window(missing)),
            refusal("window_not_found"),
            "{missing}"
        );
    }
}

#[test]
fn encoding_downscales_and_shrinks_until_the_byte_cap_holds() {
    let screen = screen(Fixture::display(64, 48, 1.0));
    let bounded = capture(
        &screen,
        json!({"target":{"kind":"display","display":1},"encoding":{"format":"png"},"maxDimension":16}),
    );
    assert_eq!(
        (
            &bounded["width"],
            &bounded["height"],
            &bounded["downscaled"]
        ),
        (&json!(16), &json!(12), &json!(true))
    );

    let jpeg = capture(
        &screen,
        json!({"target":{"kind":"display","display":1},"encoding":{"format":"jpeg","quality":80}}),
    );
    assert_eq!(
        (&jpeg["format"], &jpeg["width"]),
        (&json!("jpeg"), &json!(64))
    );
    assert_eq!(image(&jpeg, "data")[..2], [0xFF, 0xD8]);

    let capped = capture(
        &screen,
        json!({"target":{"kind":"display","display":1},"encoding":{"format":"png"},"maxBytes":2000}),
    );
    assert_eq!(capped["downscaled"], true);
    let bytes = image(&capped, "data");
    assert!(bytes.len() <= 2000, "{}", bytes.len());
    let decoded = image::load_from_memory(&bytes).expect("png");
    assert_eq!(json!(decoded.width()), capped["width"]);

    let impossible = capture(
        &screen,
        json!({"target":{"kind":"display","display":1},"encoding":{"format":"png"},"maxBytes":1}),
    );
    assert_eq!(impossible["reason"], "capture_failed");
    assert_eq!(impossible["message"], "encoded frame exceeds 1 bytes");
}

#[test]
fn the_legacy_read_answers_png_and_maps_target_refusals() {
    let screen = screen(Fixture::display(20, 10, 1.0));
    let whole = read(&screen, json!({}));
    assert_eq!(whole["status"], "ok");
    let png = image::load_from_memory(&image(&whole, "png")).expect("png");
    assert_eq!((png.width(), png.height()), (20, 10));
    let region = read(
        &screen,
        json!({"display":1,"region":{"x":2,"y":2,"width":4,"height":3}}),
    );
    let png = image::load_from_memory(&image(&region, "png")).expect("png");
    assert_eq!((png.width(), png.height()), (4, 3));
    assert_eq!(
        read(&screen, json!({"display":2})),
        refusal("invalid_region")
    );
    assert_eq!(
        read(
            &screen,
            json!({"region":{"x":0,"y":0,"width":21,"height":1}})
        ),
        refusal("invalid_region")
    );

    let failing = self::screen(Fixture {
        failure: Some("x".repeat(300)),
        ..Fixture::display(4, 4, 1.0)
    });
    assert_eq!(read(&failing, json!({})), refusal("capture_failed"));
    let refused = capture(&failing, self::whole(1));
    assert_eq!(refused["message"].as_str().expect("message").len(), 256);
}

/// A source whose display capture parks until the test lets it finish, so
/// pool occupancy is observed at exact points rather than by timing.
struct Gate {
    inner: Fixture,
    entered: mpsc::Sender<()>,
    proceed: Mutex<mpsc::Receiver<()>>,
    fail: Arc<AtomicBool>,
    malformed: Arc<AtomicBool>,
    first_window: AtomicBool,
}

impl Source for Gate {
    fn ready(&self) -> Result<(), Fault> {
        self.inner.ready()
    }

    fn displays(&self) -> Result<Vec<Display>, Fault> {
        self.inner.displays()
    }

    fn windows(&self) -> Result<Vec<Window>, Fault> {
        self.inner.windows()
    }

    fn capture_display(&self, display: u32, pixels: &mut Vec<u8>) -> Result<(u32, u32), Fault> {
        self.entered.send(()).expect("test listens");
        self.proceed
            .lock()
            .expect("gate")
            .recv()
            .expect("test releases");
        let size = self.inner.capture_display(display, pixels)?;
        if self.fail.load(Ordering::Relaxed) {
            return Err(Fault::Failed("backend failed".into()));
        }
        if self.malformed.load(Ordering::Relaxed) {
            pixels.pop();
        }
        Ok(size)
    }

    fn capture_window(&self, window: u32, pixels: &mut Vec<u8>) -> Result<(u32, u32), Fault> {
        let first = self.first_window.swap(false, Ordering::SeqCst);
        self.entered.send(()).expect("test listens");
        if first {
            self.proceed
                .lock()
                .expect("gate")
                .recv_timeout(std::time::Duration::from_secs(2))
                .expect("test releases");
        }
        if self.fail.load(Ordering::SeqCst) {
            return Err(Fault::Failed("backend failed".into()));
        }
        self.inner.capture_window(window, pixels)
    }
}

#[test]
fn newer_window_capture_supersedes_the_inflight_frame_before_publication() {
    for fail_older in [false, true] {
        let failure = Arc::new(AtomicBool::new(false));
        let (entered, arrivals) = mpsc::channel();
        let (proceed, gate) = mpsc::channel();
        let mut inner = Fixture::display(16, 16, 1.0);
        inner.windows.push(window(7, 1, 0, 0, 8, 8));
        let screen = ordinary_focus::screen(
            Gate {
                inner,
                entered,
                proceed: Mutex::new(gate),
                fail: failure.clone(),
                malformed: Arc::new(AtomicBool::new(false)),
                first_window: AtomicBool::new(true),
            },
            2,
            &[7],
        );
        let request: ScreenCaptureRequest = oni_protocol::decode(
            json!({"target":{"kind":"window","windowId":"7"},"encoding":{"format":"png"}}),
        )
        .expect("request");
        std::thread::scope(|scope| {
            let older = scope.spawn(|| screen.capture(&request));
            arrivals
                .recv_timeout(std::time::Duration::from_secs(2))
                .expect("older entered");
            let newer = scope.spawn(|| screen.capture(&request));
            arrivals
                .recv_timeout(std::time::Duration::from_secs(2))
                .expect("newer entered");
            assert_eq!(newer.join().expect("newer")["status"], "ok");
            failure.store(fail_older, Ordering::SeqCst);
            proceed.send(()).expect("release older");
            assert_eq!(
                older.join().expect("older"),
                json!({"status":"refused","reason":"superseded"})
            );
        });
    }
}

struct Gated {
    screen: Screen,
    arrivals: mpsc::Receiver<()>,
    proceed: mpsc::Sender<()>,
    fail: Arc<AtomicBool>,
    malformed: Arc<AtomicBool>,
    request: ScreenCaptureRequest,
}

impl Gated {
    fn new(points: u32) -> Self {
        let (entered, arrivals) = mpsc::channel();
        let (proceed, gate) = mpsc::channel();
        let fail = Arc::new(AtomicBool::new(false));
        let malformed = Arc::new(AtomicBool::new(false));
        let source = Gate {
            inner: Fixture::display(points, points, 1.0),
            entered,
            proceed: Mutex::new(gate),
            fail: fail.clone(),
            malformed: malformed.clone(),
            first_window: AtomicBool::new(true),
        };
        Self {
            screen: Screen::new(Box::new(source), 1),
            arrivals,
            proceed,
            fail,
            malformed,
            request: oni_protocol::decode(whole(1)).expect("request"),
        }
    }

    /// One capture whose backend call is let through before it starts.
    fn once(&self) -> Value {
        self.proceed.send(()).expect("gate");
        let answer = self.screen.capture(&self.request);
        self.arrivals.recv().expect("entered");
        answer
    }
}

#[test]
fn the_frame_pool_bounds_captures_reuses_buffers_and_frees_on_teardown() {
    let gated = Gated::new(16);
    std::thread::scope(|scope| {
        let parked = scope.spawn(|| gated.screen.capture(&gated.request));
        gated
            .arrivals
            .recv()
            .expect("first capture entered the backend");
        let saturated = gated.screen.capture(&gated.request);
        assert_eq!(saturated["reason"], "capture_failed");
        assert_eq!(saturated["message"], "frame pool saturated");
        gated.screen.release();
        gated.proceed.send(()).expect("release the parked capture");
        assert_eq!(parked.join().expect("thread")["status"], "ok");
    });
    assert_eq!(
        gated.screen.retained(),
        0,
        "a slot released mid-capture is dropped"
    );

    assert_eq!(gated.once()["status"], "ok");
    let retained = gated.screen.retained();
    assert!(retained >= 16 * 16 * 4, "{retained}");
    assert_eq!(gated.once()["status"], "ok");
    assert_eq!(gated.screen.retained(), retained, "the idle slot is reused");

    gated.screen.release();
    assert_eq!(gated.screen.retained(), 0);
    assert_eq!(gated.once()["status"], "ok");
    assert!(gated.screen.retained() > 0);
}

#[test]
fn a_failed_or_malformed_capture_frees_its_buffers() {
    let gated = Gated::new(8);
    assert_eq!(gated.once()["status"], "ok");
    assert!(gated.screen.retained() > 0);

    gated.fail.store(true, Ordering::Relaxed);
    let failed = gated.once();
    assert_eq!(
        (&failed["reason"], &failed["message"]),
        (&json!("capture_failed"), &json!("backend failed"))
    );
    assert_eq!(gated.screen.retained(), 0);

    gated.fail.store(false, Ordering::Relaxed);
    gated.malformed.store(true, Ordering::Relaxed);
    assert_eq!(gated.once()["reason"], "capture_failed");
    assert_eq!(gated.screen.retained(), 0);
}

#[cfg(target_os = "macos")]
#[test]
fn the_native_backend_offers_before_permission_but_serves_only_when_ready() {
    assert!(Screen::platform().available());
    // Capture permission does not imply permission to inspect private focus.
    // Keep readiness assertions independent of this Mac's current grants.
    for denied in [false, true] {
        let screen = screen(Fixture {
            denied,
            ..Fixture::display(16, 16, 1.0)
        });
        assert!(screen.available());
        let listed = list(&screen, json!({"windows":true}));
        if denied {
            assert_eq!(listed, refusal("permission_denied"));
            assert_eq!(capture(&screen, whole(1)), listed);
        } else {
            assert_eq!(listed["status"], "ok");
            let shot = capture(
                &screen,
                json!({"target":{"kind":"display","display":1},"encoding":{"format":"jpeg","quality":50},"maxDimension":64}),
            );
            assert_eq!(shot["status"], "ok");
        }
    }
}
