use serde::Serialize;

use crate::screen::Fault;
#[cfg(any(target_os = "linux", test))]
mod auth;
mod logic;
pub use logic::{linux_ready, local_display, X11};
pub use logic::{macos as macos_verdict, select_display as linux_display, LinuxEnv, MacEnv};

#[cfg(target_os = "linux")]
mod atspi;
#[cfg(target_os = "linux")]
mod deadline;
#[cfg(target_os = "linux")]
mod libs;
#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "linux")]
mod wayland;
#[cfg(target_os = "linux")]
pub(crate) mod x11;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blocker {
    pub kind: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub isolated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Grants {
    pub capture: bool,
    pub accessibility: bool,
    pub input: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Verdict {
    pub verdict: &'static str,
    pub blockers: Vec<Blocker>,
    pub display: Display,
    pub grants: Grants,
}

pub fn fold(display: Display, grants: Grants, blockers: Vec<Blocker>) -> Verdict {
    let usable = [grants.capture, grants.accessibility, grants.input]
        .iter()
        .filter(|&&ready| ready)
        .count();
    let verdict = match usable {
        3 if blockers.is_empty() => "available",
        0 => "unavailable",
        _ => "partial",
    };
    Verdict {
        verdict,
        blockers,
        display,
        grants,
    }
}

pub fn capture_grant(probe: Option<Result<(), Fault>>) -> bool {
    matches!(probe, Some(Ok(())))
}

/// Injected backends report their own facts, never the host's native grants.
pub fn injected(source: Option<Result<(), Fault>>, observer: bool, input: bool) -> Verdict {
    let mut blockers = Vec::new();
    match &source {
        None | Some(Err(Fault::Absent | Fault::Failed(_))) => blockers.push(Blocker {
            kind: "no_screen_backend",
        }),
        Some(Err(Fault::Permission)) => blockers.push(Blocker {
            kind: "screen_recording_denied",
        }),
        Some(Err(_)) => blockers.push(Blocker {
            kind: "no_screen_backend",
        }),
        Some(Ok(())) if !observer => blockers.push(Blocker {
            kind: "observer_unavailable",
        }),
        Some(Ok(())) => {}
    }
    if source.is_some() && !input {
        blockers.push(Blocker {
            kind: "accessibility_denied",
        });
    }
    let display = Display {
        kind: if source.is_some() { "console" } else { "none" },
        id: None,
        isolated: false,
    };
    fold(
        display,
        Grants {
            capture: capture_grant(source),
            accessibility: observer,
            input,
        },
        blockers,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injected_backends_report_their_grants_without_native_permission_state() {
        use crate::{
            input::{recorder::Recorder, Input},
            screen::{fixture::Fixture, Screen},
        };
        let absent = Screen::absent().capability(Input::absent().ready());
        assert_eq!(absent.verdict, "unavailable");
        assert_eq!(
            absent.blockers,
            vec![Blocker {
                kind: "no_screen_backend"
            }]
        );
        assert_eq!(
            absent.grants,
            Grants {
                capture: false,
                accessibility: false,
                input: false
            }
        );
        let recorder = Recorder::default();
        recorder.deny(true);
        let input = Input::new(recorder.clone());
        let denied = Screen::new(
            Box::new(Fixture {
                denied: true,
                ..Fixture::default()
            }),
            1,
        );
        let denied = denied.capability(input.ready());
        assert_eq!(
            denied.grants,
            Grants {
                capture: false,
                accessibility: false,
                input: false
            }
        );
        assert_eq!(
            denied.blockers,
            vec![
                Blocker {
                    kind: "screen_recording_denied"
                },
                Blocker {
                    kind: "accessibility_denied"
                }
            ]
        );
        recorder.deny(false);
        let ready = Screen::new(Box::new(Fixture::display(16, 16, 1.0)), 1);
        let ready = ready.capability(input.ready());
        assert_eq!(
            ready.grants,
            Grants {
                capture: true,
                accessibility: false,
                input: true
            }
        );
        assert_eq!(
            ready.blockers,
            vec![Blocker {
                kind: "observer_unavailable"
            }]
        );
    }

    #[test]
    fn folds_each_grant_combination() {
        let display = Display {
            kind: "virtual",
            id: Some(":48".into()),
            isolated: true,
        };
        let grants = |capture, accessibility, input| Grants {
            capture,
            accessibility,
            input,
        };
        assert_eq!(
            fold(display.clone(), grants(true, true, true), vec![]).verdict,
            "available"
        );
        assert_eq!(
            fold(
                display.clone(),
                grants(true, false, true),
                vec![Blocker {
                    kind: "no_atspi_bus"
                }]
            )
            .verdict,
            "partial"
        );
        assert_eq!(
            fold(
                display,
                grants(false, false, false),
                vec![Blocker {
                    kind: "no_x_display"
                }]
            )
            .verdict,
            "unavailable"
        );
        assert!(!capture_grant(Some(Err(Fault::Permission))));
        assert!(!capture_grant(None));
        assert!(capture_grant(Some(Ok(()))));
    }

    #[test]
    fn injected_observer_and_source_failures_keep_distinct_grants() {
        let ready = injected(Some(Ok(())), true, true);
        assert_eq!(ready.verdict, "available");
        assert!(ready.blockers.is_empty());
        for fault in [Fault::Failed("backend".into()), Fault::DisplayNotFound] {
            let denied = injected(Some(Err(fault)), false, true);
            assert!(!denied.grants.capture);
            assert_eq!(
                denied.blockers,
                vec![Blocker {
                    kind: "no_screen_backend"
                }]
            );
        }
    }
}
