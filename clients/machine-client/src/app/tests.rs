use super::*;
use serde_json::json;
use std::{
    cell::Cell,
    sync::mpsc,
    time::{Duration, Instant},
};

fn request() -> AppLaunchRequest {
    oni_protocol::decode(json!({"app":{"bundleId":"test.app"},"activate":false})).expect("request")
}

#[test]
fn unavailable_platform_refuses_without_launching() {
    let (tx, _rx) = mpsc::channel();
    assert_eq!(
        Unavailable.start(
            &request(),
            &Resolved {
                identity: AppIdentity {
                    bundle_id: None,
                    path: String::new()
                },
                running_pid: None,
                bundle_path: String::new()
            },
            tx
        ),
        Err(Fault::Unsupported("platform"))
    );
    assert_eq!(Unavailable.quit(1), Err(Fault::Unsupported("platform")));
    assert_eq!(Unavailable.identity(1), Err(Fault::Unsupported("platform")));
    assert_eq!(
        Fault::Unsupported("platform").value(),
        json!({"status":"refused","reason":"unsupported","blocker":"platform"})
    );
}

#[test]
fn completion_distinguishes_success_error_timeout_and_disconnect() {
    assert_eq!(completion(Some(42), None), Ok(42));
    assert_eq!(
        completion(None, Some("launch failed".into())),
        Err(Fault::Failed("launch failed".into()))
    );
    assert!(matches!(completion(None, None), Err(Fault::Failed(_))));
    assert!(matches!(completion(Some(0), None), Err(Fault::Failed(_))));
    let (tx, rx) = mpsc::channel();
    tx.send(Ok(42)).expect("send");
    assert_eq!(completed(&rx, Duration::ZERO), Ok(42));
    tx.send(Err(Fault::Failed("denied".into()))).expect("send");
    assert_eq!(
        completed(&rx, Duration::ZERO),
        Err(Fault::Failed("denied".into()))
    );
    assert_eq!(completed(&rx, Duration::ZERO), Err(Fault::Timeout));
    drop(tx);
    assert!(matches!(
        completed(&rx, Duration::ZERO),
        Err(Fault::Failed(_))
    ));
}

#[test]
fn deadline_clamps_host_values() {
    assert_eq!(timeout(None), Duration::from_secs(10));
    assert_eq!(timeout(Some(0)), Duration::from_millis(1));
    assert_eq!(timeout(Some(123)), Duration::from_millis(123));
    assert_eq!(timeout(Some(u64::MAX)), Duration::from_secs(30));
}

struct ClockAt(Cell<Instant>);
impl Clock for ClockAt {
    fn now(&self) -> Instant {
        self.0.get()
    }
    fn wait(&self, duration: Duration) {
        self.0.set(self.now() + duration);
    }
}

#[test]
fn discovery_accepts_empty_deadline_and_pid_windows() {
    let now = Instant::now();
    let clock = ClockAt(Cell::new(now));
    assert_eq!(
        discover(&clock, now + Duration::from_millis(100), || Ok(vec![])),
        Ok(vec![])
    );
    let windows = vec![json!({"pid":42,"windowId":1,"epoch":0})];
    assert_eq!(discover(&clock, now, || Ok(windows.clone())), Ok(windows));
    assert_eq!(
        discover(&clock, now, || Err(Fault::Permission)),
        Err(Fault::Permission)
    );
}

#[test]
fn exclusion_matches_process_bundle_and_path() {
    let app = AppIdentity {
        bundle_id: Some("test.app".into()),
        path: "/Applications/Test.app".into(),
    };
    assert!(excluded(std::process::id(), &app, &[]));
    assert!(excluded(0, &app, &["test.app".into()]));
    assert!(excluded(0, &app, &["/Applications/Test.app".into()]));
    assert!(!excluded(0, &app, &["other".into()]));
}

#[test]
fn refusal_values_follow_the_lifecycle_contract() {
    for (fault, reason) in [
        (Fault::NotFound, "app_not_found"),
        (Fault::ProcessNotFound, "process_not_found"),
        (Fault::Permission, "permission_denied"),
        (Fault::Excluded, "excluded"),
    ] {
        assert_eq!(fault.value(), json!({"status":"refused","reason":reason}));
    }
    assert_eq!(
        Fault::Timeout.value(),
        json!({"status":"refused","reason":"unsupported","blocker":"launch_timeout"})
    );
    assert_eq!(
        Fault::Failed("x".repeat(300)).value()["message"]
            .as_str()
            .expect("message")
            .len(),
        256
    );
}

#[test]
fn termination_distinguishes_signals_exit_permissions_and_deadline() {
    use nix::errno::Errno;
    let clock = ClockAt(Cell::new(Instant::now()));
    let cases = [
        (vec![Err(Errno::ESRCH)], Err(Fault::ProcessNotFound)),
        (vec![Err(Errno::EPERM)], Err(Fault::Permission)),
        (
            vec![Err(Errno::EINVAL)],
            Err(Fault::Failed(Errno::EINVAL.to_string())),
        ),
        (vec![Ok(()), Err(Errno::ESRCH)], Ok(true)),
        (vec![Ok(()), Err(Errno::EPERM)], Err(Fault::Permission)),
        (
            vec![Ok(()), Err(Errno::EINVAL)],
            Err(Fault::Failed(Errno::EINVAL.to_string())),
        ),
        (vec![], Ok(false)),
    ];
    for (responses, expected) in cases {
        let mut responses = responses.into_iter();
        let mut signals = Vec::new();
        let outcome = termination(&clock, |terminate| {
            signals.push(terminate);
            responses.next().unwrap_or(Ok(()))
        });
        assert_eq!(outcome, expected);
        assert!(signals[0]);
        assert!(signals[1..].iter().all(|terminate| !terminate));
    }
}

struct Launches {
    pid: u32,
    start_error: bool,
    quit_error: bool,
}
impl Launcher for Launches {
    fn resolve(&self, _: &AppLaunchRequest) -> Result<Resolved, Fault> {
        Ok(Resolved {
            identity: AppIdentity {
                bundle_id: Some("test.app".into()),
                path: "/Test.app".into(),
            },
            running_pid: (self.pid != 0).then_some(self.pid),
            bundle_path: "/Test.app".into(),
        })
    }
    fn start(
        &self,
        _: &AppLaunchRequest,
        _: &Resolved,
        reply: Sender<Result<u32, Fault>>,
    ) -> Result<(), Fault> {
        if self.start_error {
            return Err(Fault::NotFound);
        }
        reply
            .send(if self.pid == 0 {
                Err(Fault::Permission)
            } else {
                Ok(self.pid)
            })
            .expect("receiver");
        Ok(())
    }
    fn identity(&self, _: u32) -> Result<AppIdentity, Fault> {
        Ok(AppIdentity {
            bundle_id: Some("test.app".into()),
            path: "/Test.app".into(),
        })
    }
    fn quit(&self, _: u32) -> Result<bool, Fault> {
        if self.quit_error {
            Err(Fault::Permission)
        } else {
            Ok(false)
        }
    }
}

struct Windows {
    fault: Option<crate::screen::Fault>,
    action: Result<(), crate::screen::ax::ActFault>,
    count: usize,
    calls: std::sync::atomic::AtomicUsize,
    fail_after_preflight: bool,
}
impl crate::screen::ax::Observer for Windows {
    fn windows(&self) -> Result<Vec<crate::screen::ax::WindowIdentity>, crate::screen::Fault> {
        let call = self
            .calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if self.fail_after_preflight && call > 0 {
            return if self.count == 0 {
                Err(crate::screen::Fault::Failed("discovery lost".into()))
            } else {
                Err(crate::screen::Fault::Permission)
            };
        }
        if let Some(fault) = &self.fault {
            return Err(fault.clone());
        }
        Ok((0..self.count)
            .map(|id| crate::screen::ax::WindowIdentity {
                pid: 7,
                window_id: u32::try_from(id + 9).expect("window id"),
                owner_pid: 7,
                title: "Test".into(),
                app: AppIdentity {
                    bundle_id: Some("test.app".into()),
                    path: "/Test.app".into(),
                },
                token: 0,
                origin: (0, 0),
                minimized: false,
            })
            .collect())
    }
    fn walk(
        &self,
        _: &crate::screen::ax::WindowIdentity,
        _: &crate::screen::ax::Bounds,
    ) -> Result<crate::screen::ax::Walk, crate::screen::Fault> {
        panic!("lifecycle does not walk")
    }
    fn act(
        &self,
        _: &crate::screen::ax::WindowIdentity,
        _: &[crate::screen::ax::Segment],
        _: crate::screen::ax::Admit<'_>,
        _: &crate::screen::ax::Action,
    ) -> Result<(), crate::screen::ax::ActFault> {
        panic!("lifecycle does not perform a ref action")
    }
    fn lifecycle(
        &self,
        _: &crate::screen::ax::WindowIdentity,
        _: bool,
    ) -> Result<(), crate::screen::ax::ActFault> {
        self.action.clone()
    }
}

fn lifecycle_screen() -> Screen {
    Screen::absent()
        .observing(Box::new(Windows {
            fault: None,
            action: Ok(()),
            count: 1,
            calls: std::sync::atomic::AtomicUsize::new(0),
            fail_after_preflight: false,
        }))
        .launching(Box::new(Launches {
            pid: 7,
            start_error: false,
            quit_error: false,
        }))
}

#[test]
fn launches_discover_windows_and_preserve_every_refusal() {
    let mut request = request();
    request.timeout_ms = Some(std::num::NonZeroU64::new(7).expect("nonzero"));
    assert_eq!(
        launch(&lifecycle_screen(), &request),
        json!({"status":"ok","pid":7,"windows":[{"pid":7,"windowId":9,"epoch":0}]})
    );
    assert_eq!(
        launch(
            &lifecycle_screen().excluding(vec!["test.app".into()]),
            &request
        ),
        Fault::Excluded.value()
    );
    let failed_completion = lifecycle_screen().launching(Box::new(Launches {
        pid: 0,
        start_error: false,
        quit_error: false,
    }));
    assert_eq!(
        launch(&failed_completion, &request),
        Fault::Permission.value()
    );
    let own = lifecycle_screen().launching(Box::new(Launches {
        pid: std::process::id(),
        start_error: false,
        quit_error: false,
    }));
    assert_eq!(launch(&own, &request), Fault::Excluded.value());
    let failed = lifecycle_screen().launching(Box::new(Launches {
        pid: 7,
        start_error: true,
        quit_error: false,
    }));
    assert_eq!(launch(&failed, &request), Fault::NotFound.value());
    for (fault, expected) in [
        (crate::screen::Fault::Permission, Fault::Permission),
        (
            crate::screen::Fault::Failed("read".into()),
            Fault::Failed("input_failed".into()),
        ),
    ] {
        let screen = lifecycle_screen().observing(Box::new(Windows {
            fault: Some(fault),
            action: Ok(()),
            count: 1,
            calls: std::sync::atomic::AtomicUsize::new(0),
            fail_after_preflight: false,
        }));
        assert_eq!(launch(&screen, &request), expected.value());
    }
    let unavailable = lifecycle_screen().launching(Box::new(Unavailable));
    assert_eq!(
        launch(&unavailable, &request),
        Fault::Unsupported("platform").value()
    );
    SystemClock.wait(Duration::ZERO);
}

#[test]
fn launch_receipt_survives_discovery_permission_loss() {
    for count in [0, 1] {
        let screen = lifecycle_screen().observing(Box::new(Windows {
            fault: None,
            action: Ok(()),
            count,
            calls: std::sync::atomic::AtomicUsize::new(0),
            fail_after_preflight: true,
        }));
        assert_eq!(
            launch(&screen, &request()),
            json!({"status":"ok","pid":7,"windows":[]})
        );
    }
}

#[test]
fn launch_preflight_refuses_missing_observer_before_start() {
    let screen = Screen::absent().launching(Box::new(Launches {
        pid: 7,
        start_error: false,
        quit_error: false,
    }));
    assert_eq!(
        launch(&screen, &request()),
        Fault::Unsupported("platform").value()
    );
}

#[test]
fn launch_window_list_bounds_wire_result_without_losing_epoch_updates() {
    for count in [512, 513] {
        let screen = lifecycle_screen().observing(Box::new(Windows {
            fault: None,
            action: Ok(()),
            count,
            calls: std::sync::atomic::AtomicUsize::new(0),
            fail_after_preflight: false,
        }));
        let result = launch(&screen, &request());
        assert_eq!(result["windows"].as_array().expect("windows").len(), 512);
        let decoded: oni_protocol::AppLaunchResult = oni_protocol::decode(result).expect("wire");
        assert_eq!(
            serde_json::to_value(decoded).expect("round trip")["status"],
            "ok"
        );
    }
}

#[test]
fn quitting_preserves_ownership_and_backend_outcome() {
    assert_eq!(
        quit(&lifecycle_screen(), 7),
        json!({"status":"ok","exited":false})
    );
    assert_eq!(
        quit(&lifecycle_screen().excluding(vec!["test.app".into()]), 7),
        Fault::Excluded.value()
    );
    let denied = lifecycle_screen().launching(Box::new(Launches {
        pid: 7,
        start_error: false,
        quit_error: true,
    }));
    assert_eq!(quit(&denied, 7), Fault::Permission.value());
    assert_eq!(
        quit(&lifecycle_screen().launching(Box::new(Unavailable)), 7),
        Fault::Unsupported("platform").value()
    );
}

#[test]
fn window_lifecycle_fences_targets_and_maps_native_failures() {
    use crate::screen::{ax::ActFault, Fault as ScreenFault};
    let target = Target {
        pid: 7,
        window_id: 9,
        epoch: Some(0),
    };
    assert_eq!(
        window(&Screen::absent(), target, false),
        Fault::Unsupported("platform").value()
    );
    assert_eq!(
        window(&lifecycle_screen(), target, false),
        json!({"status":"ok","closed":true})
    );
    assert_eq!(
        window(&lifecycle_screen(), target, true),
        json!({"status":"ok","parked":true})
    );
    assert_eq!(
        window(
            &lifecycle_screen(),
            Target {
                epoch: Some(1),
                ..target
            },
            false
        ),
        json!({"status":"refused","reason":"epoch_changed"})
    );
    assert_eq!(
        window(
            &lifecycle_screen().excluding(vec!["test.app".into()]),
            target,
            false
        ),
        Fault::Excluded.value()
    );
    for (fault, expected) in [
        (
            ScreenFault::Failed("read".into()),
            Fault::Failed("read".into()).value(),
        ),
        (ScreenFault::Permission, Fault::Permission.value()),
    ] {
        let screen = lifecycle_screen().observing(Box::new(Windows {
            fault: Some(fault),
            action: Ok(()),
            count: 1,
            calls: std::sync::atomic::AtomicUsize::new(0),
            fail_after_preflight: false,
        }));
        assert_eq!(window(&screen, target, false), expected);
    }
    for (fault, expected) in [
        (ActFault::Permission, Fault::Permission.value()),
        (
            ActFault::NotFound,
            json!({"status":"refused","reason":"window_not_found"}),
        ),
        (
            ActFault::Unsupported,
            Fault::Unsupported("platform").value(),
        ),
        (
            ActFault::Failed("close".into()),
            Fault::Failed("close".into()).value(),
        ),
    ] {
        let screen = lifecycle_screen().observing(Box::new(Windows {
            fault: None,
            action: Err(fault),
            count: 1,
            calls: std::sync::atomic::AtomicUsize::new(0),
            fail_after_preflight: false,
        }));
        assert_eq!(window(&screen, target, false), expected);
        assert_eq!(
            window(&screen, target, true),
            json!({"status":"ok","parked":false})
        );
    }
}

struct ReadOnly(Windows);
impl crate::screen::ax::Observer for ReadOnly {
    fn windows(&self) -> Result<Vec<crate::screen::ax::WindowIdentity>, crate::screen::Fault> {
        self.0.windows()
    }
    fn walk(
        &self,
        window: &crate::screen::ax::WindowIdentity,
        bounds: &crate::screen::ax::Bounds,
    ) -> Result<crate::screen::ax::Walk, crate::screen::Fault> {
        self.0.walk(window, bounds)
    }
    fn act(
        &self,
        window: &crate::screen::ax::WindowIdentity,
        path: &[crate::screen::ax::Segment],
        admit: crate::screen::ax::Admit<'_>,
        action: &crate::screen::ax::Action,
    ) -> Result<(), crate::screen::ax::ActFault> {
        self.0.act(window, path, admit, action)
    }
}

#[test]
fn read_only_observers_refuse_window_lifecycle() {
    let screen = Screen::absent().observing(Box::new(ReadOnly(Windows {
        fault: None,
        action: Ok(()),
        count: 1,
        calls: std::sync::atomic::AtomicUsize::new(0),
        fail_after_preflight: false,
    })));
    assert_eq!(
        window(
            &screen,
            Target {
                pid: 7,
                window_id: 9,
                epoch: Some(0)
            },
            false
        ),
        Fault::Unsupported("platform").value()
    );
}
