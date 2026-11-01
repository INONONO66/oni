use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use super::{
    ax::{Frame, Walk},
    observe::Target,
    Fault,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Focused {
    pub role: String,
    pub secure: bool,
}

pub fn focused(walk: &Walk) -> Option<Focused> {
    let attributes = &walk.nodes.get(walk.focused?)?.attributes;
    Some(Focused {
        role: attributes.role.clone(),
        secure: attributes.secure,
    })
}

#[derive(Debug, PartialEq, Eq)]
pub enum FocusState {
    Secure,
    Admits,
    Idle,
    Unknown(Fault),
}

/// Fail-closed reading of one focus observation. `Fault::Absent` is the
/// platform declining to observe focus at all (X11 carries no accessibility
/// focus): that keeps the window private without raising an accessibility
/// fault, which only a failing observer reports.
pub fn focus_state(focused: Result<Option<Focused>, Fault>) -> FocusState {
    match focused {
        Err(Fault::Absent) => FocusState::Secure,
        Err(fault) => FocusState::Unknown(fault),
        Ok(None) => FocusState::Idle,
        Ok(Some(focused)) if focused.secure || focused.role == "AXSecureTextField" => {
            FocusState::Secure
        }
        Ok(Some(_)) => FocusState::Admits,
    }
}

pub struct FocusRefresh {
    checked_at: Duration,
}

impl FocusRefresh {
    pub fn new(now: Duration) -> Self {
        Self { checked_at: now }
    }

    pub fn due(&mut self, now: Duration) -> bool {
        if now.saturating_sub(self.checked_at) < Duration::from_millis(250) {
            return false;
        }
        self.checked_at = now;
        true
    }

    pub fn next(&self) -> Duration {
        self.checked_at + Duration::from_millis(250)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Entered,
    Left,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    SecureFocus,
    SecureInputEnabled,
}

impl Reason {
    pub fn name(self) -> &'static str {
        match self {
            Self::SecureFocus => "secure_focus",
            Self::SecureInputEnabled => "secure_input_enabled",
        }
    }
}

#[derive(Default)]
pub struct SecureInput {
    checked_at: Option<Instant>,
    clear_reads: u8,
    active: bool,
}

impl SecureInput {
    pub fn refresh(&mut self, now: Instant, enabled: bool) -> bool {
        if enabled {
            self.active = true;
            self.clear_reads = 0;
            self.checked_at = Some(now);
        } else if self
            .checked_at
            .is_none_or(|at| now.saturating_duration_since(at) >= Duration::from_millis(250))
        {
            self.checked_at = Some(now);
            self.clear_reads = self.clear_reads.saturating_add(1);
            if self.clear_reads >= 2 {
                self.active = false;
            }
        }
        self.active
    }
}

#[cfg(target_os = "macos")]
#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn IsSecureEventInputEnabled() -> bool;
}

pub fn platform_secure_input_enabled() -> bool {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: HIToolbox exposes an argument-free query of the process-wide input state.
        unsafe { IsSecureEventInputEnabled() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[derive(Default)]
pub struct States(HashMap<(u64, u64, Option<u64>), Option<Reason>>);

impl States {
    pub fn update(&mut self, target: Target, reason: Option<Reason>) -> Option<(Edge, Reason)> {
        match self
            .0
            .insert((target.pid, target.window_id, target.epoch), reason)
        {
            Some(None) | None if reason.is_some() => Some((Edge::Entered, reason?)),
            Some(Some(previous)) if reason.is_none() => Some((Edge::Left, previous)),
            _ => None,
        }
    }
}

pub fn blank_rect(
    pixels: &mut [u8],
    frame_size: (u32, u32),
    display_size: (u32, u32),
    rect: Frame,
) {
    let scale = |value: i64, source: u32, target: u32, upper: bool| {
        let scaled = value.max(0) as u64 * u64::from(target);
        let pixels = if upper {
            scaled.div_ceil(u64::from(source))
        } else {
            scaled / u64::from(source)
        };
        pixels.min(u64::from(target)) as usize
    };
    let left = scale(rect.x, display_size.0, frame_size.0, false);
    let top = scale(rect.y, display_size.1, frame_size.1, false);
    let right = scale(rect.x + rect.width, display_size.0, frame_size.0, true);
    let bottom = scale(rect.y + rect.height, display_size.1, frame_size.1, true);
    for row in top..bottom {
        let start = (row * frame_size.0 as usize + left) * 4;
        let end = (row * frame_size.0 as usize + right) * 4;
        pixels[start..end].fill(0);
    }
}

pub fn overlaps(left: Frame, right: Frame) -> bool {
    left.x < right.x + right.width
        && right.x < left.x + left.width
        && left.y < right.y + right.height
        && right.y < left.y + left.height
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    use super::*;
    use crate::{
        input::{recorder::Recorder, Input},
        screen::{
            ax::{self, Attributes, Node, Observer, WindowIdentity},
            fixture::Fixture,
            Screen, Window,
        },
    };
    use oni_protocol::{InputWriteRequest, ScreenCaptureRequest, ScreenReadRequest};
    use serde_json::json;

    struct UnreadableFocus(Arc<AtomicBool>);

    impl ax::Observer for UnreadableFocus {
        fn windows(&self) -> Result<Vec<WindowIdentity>, Fault> {
            Ok(vec![WindowIdentity {
                pid: 7,
                window_id: 9,
                owner_pid: 7,
                title: "Editor".into(),
                app: ax::AppIdentity {
                    bundle_id: None,
                    path: "/fixture/editor".into(),
                },
                token: 0,
                origin: (0, 0),
                minimized: false,
                surface: None,
            }])
        }

        fn focused(&self, _: &WindowIdentity) -> Result<Option<Focused>, Fault> {
            if self.0.load(Ordering::Relaxed) {
                Err(Fault::Permission)
            } else {
                Ok(Some(Focused {
                    role: "AXTextField".into(),
                    secure: false,
                }))
            }
        }

        fn walk(&self, _: &WindowIdentity, _: &ax::Bounds) -> Result<Walk, Fault> {
            Err(Fault::Permission)
        }

        fn act(
            &self,
            _: &WindowIdentity,
            _: &[ax::Segment],
            _: ax::Admit<'_>,
            _: &ax::Action,
        ) -> Result<(), ax::ActFault> {
            Err(ax::ActFault::Permission)
        }
    }

    #[test]
    fn focused_reads_the_named_node_and_refuses_an_absent_focus() {
        let walk = Walk {
            nodes: vec![Node {
                attributes: Attributes {
                    role: "AXSecureTextField".into(),
                    secure: true,
                    ..Attributes::default()
                },
                parent: None,
            }],
            focused: Some(0),
            complete: true,
        };
        assert_eq!(
            focused(&walk),
            Some(Focused {
                role: "AXSecureTextField".into(),
                secure: true,
            })
        );
        assert_eq!(
            focused(&Walk {
                focused: None,
                ..walk
            }),
            None
        );
    }

    #[test]
    fn focus_distinguishes_secure_admitting_idle_absent_and_unknown() {
        for (focused, state) in [
            (
                Err(Fault::Permission),
                FocusState::Unknown(Fault::Permission),
            ),
            (Err(Fault::Absent), FocusState::Secure),
            (Ok(None), FocusState::Idle),
            (
                Ok(Some(Focused {
                    role: "AXTextField".into(),
                    secure: true,
                })),
                FocusState::Secure,
            ),
            (
                Ok(Some(Focused {
                    role: "AXSecureTextField".into(),
                    secure: false,
                })),
                FocusState::Secure,
            ),
            (
                Ok(Some(Focused {
                    role: "AXButton".into(),
                    secure: false,
                })),
                FocusState::Admits,
            ),
        ] {
            assert_eq!(focus_state(focused), state);
        }
    }

    #[test]
    fn unreadable_focus_observer_refuses_walk_and_action() {
        let observer = UnreadableFocus(Arc::new(AtomicBool::new(true)));
        let window = observer.windows().expect("fixture window").remove(0);
        let bounds = ax::Bounds {
            max_elements: 1,
            max_visits: 1,
            budget: Duration::from_secs(1),
        };
        assert_eq!(observer.walk(&window, &bounds), Err(Fault::Permission));
        assert_eq!(
            observer.act(&window, &[], &|_| true, &ax::Action::Press),
            Err(ax::ActFault::Permission)
        );
    }

    #[test]
    fn unreadable_focus_keeps_capture_unmasked_and_refuses_input_as_accessibility() {
        let mut source = Fixture::display(8, 8, 1.0);
        source.windows.push(Window {
            id: 9,
            display: 1,
            title: "Editor".into(),
            owner: "fixture".into(),
            pid: Some(7),
            app: None,
            x: 0,
            y: 0,
            width: 8,
            height: 8,
        });
        let mut baseline_source = source.clone();
        baseline_source.windows.clear();
        let baseline = Screen::new(Box::new(baseline_source), 1);
        let unreadable = Arc::new(AtomicBool::new(true));
        let screen = Screen::new(Box::new(source), 1)
            .observing(Box::new(UnreadableFocus(Arc::clone(&unreadable))))
            .with_secure_input(|| false);
        let capture: ScreenCaptureRequest = oni_protocol::decode(json!({
            "target": {"kind":"display","display":1},
            "encoding": {"format":"png"}
        }))
        .expect("capture request");
        let display = screen.capture(&capture);
        assert_eq!(display["status"], "ok");
        assert_eq!(display["accessibilityUnavailable"], true);
        let window: ScreenCaptureRequest = oni_protocol::decode(json!({
            "target": {"kind":"window","windowId":"9"},
            "encoding": {"format":"png"}
        }))
        .expect("window request");
        assert_eq!(
            screen.capture(&window),
            json!({"status":"refused","reason":"accessibility_unavailable"})
        );
        let read: ScreenReadRequest = oni_protocol::decode(json!({})).expect("read request");
        let captured = screen.read(&read);
        let unmasked = baseline.read(&read);
        assert_eq!(captured["status"], "ok");
        assert_eq!(captured["png"], unmasked["png"]);
        assert_eq!(captured["accessibilityUnavailable"], true);
        let verdict = screen.capability(true);
        assert!(!verdict.grants.accessibility);
        assert!(verdict
            .blockers
            .iter()
            .any(|blocker| blocker.kind == "accessibility_unavailable"));
        assert_eq!(
            screen.input_private(None),
            Err(Fault::AccessibilityUnavailable)
        );
        assert_eq!(
            screen.input_private(Some((4, 4))),
            Err(Fault::AccessibilityUnavailable)
        );
        let input: InputWriteRequest = oni_protocol::decode(json!({
            "captureId": captured["captureId"],
            "actions": [{"key": {"name": "A"}}]
        }))
        .expect("input request");
        let recorder = Recorder::default();
        let result = Input::new(recorder.clone()).write(&screen, &input);
        assert_eq!(
            result,
            json!({"status":"refused","reason":"accessibility_unavailable"})
        );
        assert!(recorder.events().is_empty());
        unreadable.store(false, Ordering::Relaxed);
        assert_eq!(screen.window_private(9), Ok(false));
        assert!(screen.capability(true).grants.accessibility);
    }

    #[test]
    fn blanks_only_scaled_rectangle() {
        let mut pixels = vec![255; 4 * 4 * 4];
        blank_rect(
            &mut pixels,
            (4, 4),
            (8, 8),
            Frame {
                x: 2,
                y: 2,
                width: 4,
                height: 4,
            },
        );
        assert_eq!(&pixels[20..28], &[0; 8]);
        assert_eq!(&pixels[..16], &[255; 16]);
    }

    #[test]
    fn blanks_every_partially_intersected_pixel_after_a_crop() {
        let mut pixels = vec![255; 3 * 3 * 4];
        blank_rect(
            &mut pixels,
            (3, 3),
            (2, 2),
            Frame {
                x: 0,
                y: 0,
                width: 1,
                height: 1,
            },
        );
        for row in 0..3 {
            for column in 0..3 {
                let pixel = &pixels[(row * 3 + column) * 4..(row * 3 + column + 1) * 4];
                assert_eq!(
                    pixel,
                    if row < 2 && column < 2 {
                        &[0; 4]
                    } else {
                        &[255; 4]
                    }
                );
            }
        }
    }

    #[test]
    fn overlap_requires_positive_area() {
        let window = Frame {
            x: 10,
            y: 20,
            width: 120,
            height: 80,
        };
        assert!(overlaps(
            window,
            Frame {
                x: 20,
                y: 30,
                width: 10,
                height: 10
            }
        ));
        assert!(!overlaps(
            window,
            Frame {
                x: 130,
                y: 20,
                width: 10,
                height: 10
            }
        ));
        assert!(!overlaps(
            window,
            Frame {
                x: 10,
                y: 100,
                width: 10,
                height: 10
            }
        ));
    }

    #[test]
    fn emits_only_private_state_edges() {
        let target = Target {
            pid: 7,
            window_id: 9,
            epoch: Some(2),
        };
        let mut states = States::default();
        assert_eq!(states.update(target, None), None);
        assert_eq!(
            states.update(target, Some(Reason::SecureFocus)),
            Some((Edge::Entered, Reason::SecureFocus))
        );
        assert_eq!(
            states.update(target, Some(Reason::SecureInputEnabled)),
            None
        );
        assert_eq!(
            states.update(target, None),
            Some((Edge::Left, Reason::SecureInputEnabled))
        );
        assert_eq!(
            states.update(
                Target {
                    epoch: Some(3),
                    ..target
                },
                Some(Reason::SecureFocus)
            ),
            Some((Edge::Entered, Reason::SecureFocus))
        );
    }

    #[test]
    fn system_secure_input_requires_two_distinct_clear_refreshes() {
        let start = Instant::now();
        let mut state = SecureInput::default();
        assert!(!state.refresh(start, false));
        assert!(state.refresh(start, true));
        assert!(state.refresh(start, false));
        assert!(state.refresh(start + Duration::from_millis(249), false));
        assert!(state.refresh(start + Duration::from_millis(250), false));
        assert!(state.refresh(start + Duration::from_millis(499), false));
        assert!(!state.refresh(start + Duration::from_millis(500), false));
        assert!(state.refresh(start + Duration::from_millis(501), true));
    }

    #[test]
    fn focus_refresh_is_due_each_quarter_second() {
        let mut refresh = FocusRefresh::new(Duration::from_millis(100));
        assert!(!refresh.due(Duration::from_millis(349)));
        assert!(refresh.due(Duration::from_millis(350)));
        assert!(!refresh.due(Duration::from_millis(599)));
        assert!(refresh.due(Duration::from_millis(600)));
    }
}
