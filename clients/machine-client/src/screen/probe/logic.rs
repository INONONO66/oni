use super::{fold, Blocker, Display, Grants, Verdict};

pub trait LinuxEnv {
    fn variable(&self, name: &str) -> Option<String>;
    fn candidates(&self) -> Vec<String>;
    fn socket(&self, name: &str) -> bool;
    fn x11(&self, name: &str) -> X11;
    fn wayland(&self, name: &str) -> bool;
    fn atspi(&self) -> bool;
    fn library(&self, name: &str) -> bool;
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum X11 {
    Ready,
    Refused,
    Unreachable,
}

struct LinuxFacts {
    configured: Option<String>,
    forwarded: bool,
    socket: bool,
    x_ready: bool,
    wayland_ready: bool,
}

pub fn local_display(name: &str) -> Option<u16> {
    let display = name.strip_prefix(':')?;
    let (number, screen) = display.split_once('.').unwrap_or((display, "0"));
    if screen != "0" {
        return None;
    }
    number.parse().ok()
}

fn wayland_name(env: &impl LinuxEnv) -> Option<String> {
    env.variable("WAYLAND_DISPLAY").or_else(|| {
        (env.variable("XDG_SESSION_TYPE").as_deref() == Some("wayland")).then(|| "wayland-0".into())
    })
}

pub fn select_display(env: &impl LinuxEnv, preferred: Option<&str>) -> Option<String> {
    preferred
        .map(str::to_owned)
        .or_else(|| env.variable("DISPLAY"))
        .or_else(|| {
            if wayland_name(env).is_some() {
                return None;
            }
            let candidates = env.candidates();
            candidates
                .iter()
                .find(|name| env.socket(name) && env.x11(name) == X11::Ready)
                .cloned()
                .or_else(|| candidates.into_iter().find(|name| env.socket(name)))
        })
}

fn linux_sources(env: &impl LinuxEnv, configured: Option<String>) -> LinuxFacts {
    let forwarded = configured
        .as_deref()
        .is_some_and(|display| local_display(display).is_none());
    let reachable = configured
        .as_deref()
        .is_some_and(|display| !forwarded && env.socket(display));
    let status = configured
        .as_deref()
        .filter(|_| reachable)
        .map_or(X11::Unreachable, |display| env.x11(display));
    let socket = status != X11::Unreachable;
    let x_ready = status == X11::Ready;
    let wayland_ready = wayland_name(env)
        .as_deref()
        .is_some_and(|name| env.wayland(name));
    LinuxFacts {
        configured,
        forwarded,
        socket,
        x_ready,
        wayland_ready,
    }
}

fn linux_blockers(facts: &LinuxFacts, libraries: bool, accessibility: bool) -> Vec<Blocker> {
    let LinuxFacts {
        forwarded,
        socket,
        x_ready,
        wayland_ready,
        ..
    } = *facts;
    let mut blockers = Vec::new();
    if forwarded {
        blockers.push(Blocker {
            kind: "x_display_forwarded",
        });
    } else if socket && !x_ready {
        blockers.push(Blocker {
            kind: "x_auth_refused",
        });
    } else if !x_ready && wayland_ready {
        blockers.push(Blocker {
            kind: "wayland_only_no_x",
        });
    } else if !x_ready {
        blockers.push(Blocker {
            kind: "no_x_display",
        });
    }
    if x_ready && !libraries {
        blockers.push(Blocker {
            kind: "missing_x_libs",
        });
    }
    if x_ready && !accessibility {
        blockers.push(Blocker {
            kind: "no_atspi_bus",
        });
    }
    blockers
}

pub fn linux_ready(
    env: &impl LinuxEnv,
    binding: &Display,
    input_ready: bool,
    source_ready: bool,
) -> Verdict {
    let mut facts = linux_sources(env, binding.id.clone());
    if facts.x_ready && !source_ready {
        facts.x_ready = false;
        facts.socket = false;
    }
    let x_ready = facts.x_ready;
    let libs = ["libX11.so.6", "libXi.so.6", "libxkbcommon.so.0"]
        .iter()
        .all(|name| env.library(name));
    // The virtual desktop contract is capture/input plus a window manager,
    // not the person's session bus. Console observation still probes AT-SPI.
    let bus = x_ready && (binding.isolated || env.atspi());
    // Bus reachability cannot grant an observer the client does not implement.
    let accessibility = false;
    let mut blockers = linux_blockers(&facts, libs, bus);
    blockers.push(Blocker {
        kind: "surface_enumeration_unavailable",
    });
    if bus && !binding.isolated {
        blockers.push(Blocker {
            kind: "observer_unavailable",
        });
    }
    if x_ready && !input_ready {
        blockers.push(Blocker {
            kind: "input_backend_unavailable",
        });
    }
    let display = Display {
        kind: if binding.isolated {
            "virtual"
        } else if x_ready || facts.wayland_ready {
            "console"
        } else {
            "none"
        },
        id: facts.configured,
        isolated: binding.isolated,
    };
    let mut verdict = fold(
        display,
        Grants {
            capture: x_ready,
            accessibility,
            input: x_ready && input_ready,
        },
        blockers,
    );
    if facts.wayland_ready && !x_ready {
        verdict.verdict = "partial";
    }
    // An isolated X11 desktop is usable without an AX tree; console observation
    // remains partial. Screen adds the live manager blocker for virtual displays.
    if binding.isolated
        && x_ready
        && input_ready
        && verdict
            .blockers
            .iter()
            .all(|blocker| blocker.kind == "surface_enumeration_unavailable")
    {
        verdict.verdict = "available";
    }
    verdict.refresh_needs();
    verdict
}

pub trait MacEnv {
    fn console_uid(&self) -> Option<u32>;
    fn process_uid(&self) -> u32;
    fn capture(&self) -> bool;
    fn accessibility(&self) -> bool;
    fn asleep(&self) -> bool;
}

pub fn macos(env: &impl MacEnv, input: bool) -> Verdict {
    let console = env.console_uid().filter(|uid| *uid != 0);
    let process = env.process_uid();
    let same_user = console == Some(process);
    let asleep = env.asleep();
    let capture_granted = env.capture();
    let accessibility_granted = env.accessibility();
    let capture = same_user && capture_granted && !asleep;
    let accessibility = same_user && accessibility_granted;
    let blockers = macos_blockers(
        console,
        process,
        asleep,
        capture_granted,
        accessibility_granted,
    );
    let mut verdict = fold(
        Display {
            kind: "console",
            id: None,
            isolated: false,
        },
        Grants {
            capture,
            accessibility,
            input: same_user && input && accessibility_granted,
        },
        blockers,
    );
    if same_user && verdict.verdict == "unavailable" {
        verdict.verdict = "partial";
    }
    verdict.refresh_needs();
    verdict
}

fn macos_blockers(
    console: Option<u32>,
    process: u32,
    asleep: bool,
    capture: bool,
    accessibility: bool,
) -> Vec<Blocker> {
    let same_user = console == Some(process);
    let mut blockers = Vec::new();
    match console {
        None => blockers.push(Blocker {
            kind: "no_console_user",
        }),
        Some(uid) if uid != process => blockers.push(Blocker {
            kind: "other_console_user",
        }),
        _ => {}
    }
    if asleep {
        blockers.push(Blocker {
            kind: "display_asleep",
        });
    }
    if same_user && !capture {
        blockers.push(Blocker {
            kind: "screen_recording_denied",
        });
    }
    if same_user && !accessibility {
        blockers.push(Blocker {
            kind: "accessibility_denied",
        });
    }
    blockers
}

#[cfg(test)]
mod tests {
    use super::*;
    fn linux(env: &impl LinuxEnv, virtual_id: Option<&str>, input_ready: bool) -> Verdict {
        linux_ready(
            env,
            &Display {
                kind: "console",
                id: select_display(env, virtual_id),
                isolated: virtual_id.is_some(),
            },
            input_ready,
            true,
        )
    }
    struct X {
        display: Option<&'static str>,
        x: bool,
        socket: bool,
        a11y: bool,
        libs: bool,
        wayland: bool,
        session: bool,
    }
    impl LinuxEnv for X {
        fn variable(&self, name: &str) -> Option<String> {
            match name {
                "DISPLAY" => self.display.map(str::to_owned),
                "WAYLAND_DISPLAY" if self.wayland && !self.session => Some("wayland-0".into()),
                "XDG_SESSION_TYPE" if self.session => Some("wayland".into()),
                _ => None,
            }
        }
        fn candidates(&self) -> Vec<String> {
            vec![":41".into(), ":42".into()]
        }
        fn socket(&self, _: &str) -> bool {
            self.socket
        }
        fn x11(&self, name: &str) -> X11 {
            if self.x && name != ":41" {
                X11::Ready
            } else {
                X11::Refused
            }
        }
        fn wayland(&self, _: &str) -> bool {
            self.wayland
        }
        fn atspi(&self) -> bool {
            self.a11y
        }
        fn library(&self, _: &str) -> bool {
            self.libs
        }
    }
    #[test]
    fn linux_folds_console_virtual_grants_and_named_blockers() {
        let ready = X {
            display: Some(":1"),
            x: true,
            socket: true,
            a11y: true,
            libs: true,
            wayland: false,
            session: false,
        };
        assert_eq!(linux(&ready, None, true).verdict, "partial");
        assert!(!linux(&ready, None, true).grants.accessibility);
        assert_eq!(
            linux(&ready, None, true).blockers,
            vec![
                Blocker {
                    kind: "surface_enumeration_unavailable"
                },
                Blocker {
                    kind: "observer_unavailable"
                }
            ]
        );
        assert_eq!(linux(&ready, Some(":48"), true).verdict, "available");
        assert_eq!(
            linux(
                &X {
                    a11y: false,
                    ..ready
                },
                Some(":48"),
                true
            )
            .verdict,
            "available"
        );
        assert_eq!(
            linux(&ready, Some(":48"), true).blockers,
            vec![Blocker {
                kind: "surface_enumeration_unavailable"
            }]
        );
        assert!(linux(&ready, Some(":48"), true).needs.is_empty());
        assert!(linux(&ready, Some(":48"), true).display.isolated);
        let no_input = linux(&ready, Some(":48"), false);
        assert_eq!(no_input.verdict, "partial");
        assert_eq!(
            no_input.grants,
            Grants {
                capture: true,
                accessibility: false,
                input: false,
            }
        );
        assert_eq!(
            no_input.blockers,
            vec![
                Blocker {
                    kind: "surface_enumeration_unavailable"
                },
                Blocker {
                    kind: "input_backend_unavailable"
                }
            ]
        );
        oni_protocol::decode::<oni_protocol::Screen>(
            serde_json::to_value(no_input).expect("verdict"),
        )
        .expect("typed input blocker");
        assert_eq!(linux(&ready, None, false).verdict, "partial");
        let disconnected = linux_ready(
            &ready,
            &Display {
                kind: "console",
                id: Some(":1".into()),
                isolated: false,
            },
            true,
            false,
        );
        assert_eq!(disconnected.verdict, "unavailable");
        assert_eq!(
            disconnected.blockers,
            vec![
                Blocker {
                    kind: "no_x_display"
                },
                Blocker {
                    kind: "surface_enumeration_unavailable"
                }
            ]
        );
        assert_eq!(
            linux(
                &X {
                    a11y: false,
                    ..ready
                },
                None,
                true
            )
            .blockers[0]
                .kind,
            "no_atspi_bus"
        );
        assert_eq!(
            linux(
                &X {
                    libs: false,
                    ..ready
                },
                None,
                true
            )
            .blockers[0]
                .kind,
            "missing_x_libs"
        );
        assert_eq!(
            linux(&X { x: false, ..ready }, None, true).blockers[0].kind,
            "x_auth_refused"
        );
        assert_eq!(
            linux(
                &X {
                    socket: false,
                    ..ready
                },
                None,
                true
            )
            .blockers[0]
                .kind,
            "no_x_display"
        );
        assert_eq!(
            linux(
                &X {
                    display: Some("host:0"),
                    ..ready
                },
                None,
                true
            )
            .blockers[0]
                .kind,
            "x_display_forwarded"
        );
    }
    #[test]
    fn nonzero_and_forwarded_displays_never_enter_native_drivers() {
        assert_eq!(local_display(":2997.1"), None);
        assert_eq!(local_display("host:0"), None);
        assert_eq!(local_display(":2997.0"), Some(2997));
        assert_eq!(local_display(":bad"), None);
    }
    #[test]
    fn linux_distinguishes_absent_wayland_and_scanned_displays() {
        let none = X {
            display: None,
            x: false,
            socket: false,
            a11y: false,
            libs: true,
            wayland: false,
            session: false,
        };
        assert_eq!(linux(&none, None, false).verdict, "unavailable");
        assert_eq!(
            linux(
                &X {
                    session: true,
                    wayland: true,
                    ..none
                },
                None,
                false
            )
            .verdict,
            "partial"
        );
        assert_eq!(
            linux(
                &X {
                    wayland: true,
                    ..none
                },
                None,
                false
            )
            .verdict,
            "partial"
        );
        assert_eq!(
            linux(
                &X {
                    wayland: true,
                    ..none
                },
                None,
                false
            )
            .blockers[0]
                .kind,
            "wayland_only_no_x"
        );
        assert_eq!(
            linux(
                &X {
                    wayland: true,
                    ..none
                },
                None,
                false
            )
            .needs[0]
                .step,
            "x11_session"
        );
        assert_eq!(
            linux(
                &X {
                    x: true,
                    socket: true,
                    ..none
                },
                None,
                true
            )
            .display
            .id
            .as_deref(),
            Some(":42")
        );
        assert_eq!(
            linux(
                &X {
                    x: false,
                    socket: true,
                    ..none
                },
                None,
                false
            )
            .blockers[0]
                .kind,
            "x_auth_refused"
        );
    }
    struct M {
        console: Option<u32>,
        capture: bool,
        accessibility: bool,
        asleep: bool,
    }
    impl MacEnv for M {
        fn console_uid(&self) -> Option<u32> {
            self.console
        }
        fn process_uid(&self) -> u32 {
            501
        }
        fn capture(&self) -> bool {
            self.capture
        }
        fn accessibility(&self) -> bool {
            self.accessibility
        }
        fn asleep(&self) -> bool {
            self.asleep
        }
    }
    #[test]
    fn macos_folds_each_console_grant_and_sleep() {
        let ready = M {
            console: Some(501),
            capture: true,
            accessibility: true,
            asleep: false,
        };
        assert_eq!(macos(&ready, true).verdict, "available");
        assert_eq!(
            macos(
                &M {
                    console: None,
                    ..ready
                },
                true
            )
            .blockers[0]
                .kind,
            "no_console_user"
        );
        assert_eq!(
            macos(
                &M {
                    console: Some(0),
                    ..ready
                },
                true
            )
            .blockers[0]
                .kind,
            "no_console_user"
        );
        assert_eq!(
            macos(
                &M {
                    console: Some(502),
                    ..ready
                },
                true
            )
            .blockers[0]
                .kind,
            "other_console_user"
        );
    }
    #[test]
    fn macos_reports_each_grant_and_sleep_condition() {
        let ready = M {
            console: Some(501),
            capture: true,
            accessibility: true,
            asleep: false,
        };
        assert_eq!(
            macos(
                &M {
                    asleep: true,
                    ..ready
                },
                true
            )
            .blockers[0]
                .kind,
            "display_asleep"
        );
        assert_eq!(
            macos(
                &M {
                    capture: false,
                    ..ready
                },
                true
            )
            .blockers[0]
                .kind,
            "screen_recording_denied"
        );
        assert_eq!(
            macos(
                &M {
                    accessibility: false,
                    ..ready
                },
                true
            )
            .blockers[0]
                .kind,
            "accessibility_denied"
        );
        assert_eq!(macos(&ready, false).verdict, "partial");
        assert_eq!(
            macos(
                &M {
                    capture: false,
                    accessibility: false,
                    ..ready
                },
                false
            )
            .verdict,
            "partial"
        );
        assert!(
            !macos(
                &M {
                    accessibility: false,
                    ..ready
                },
                true
            )
            .grants
            .input
        );
    }

    #[test]
    fn macos_needs_match_probed_grants_and_console_user() {
        let ready = M {
            console: Some(501),
            capture: true,
            accessibility: true,
            asleep: false,
        };
        assert!(macos(&ready, true).needs.is_empty());
        let denied = macos(
            &M {
                capture: false,
                accessibility: false,
                ..ready
            },
            true,
        );
        assert_eq!(
            denied.needs.iter().map(|row| row.step).collect::<Vec<_>>(),
            ["screen_recording_grant", "accessibility_grant"]
        );
        assert!(denied
            .needs
            .iter()
            .all(|row| row.on_screen && row.blocker.is_some()));
        let absent = macos(
            &M {
                console: None,
                ..ready
            },
            true,
        );
        assert_eq!(absent.needs[0].step, "console_login");
    }

    #[test]
    fn linux_needs_x11_only_when_wayland_has_no_x() {
        let ready = X {
            display: Some(":48"),
            x: true,
            socket: true,
            a11y: false,
            libs: true,
            wayland: false,
            session: false,
        };
        assert!(linux(&ready, Some(":48"), true).needs.is_empty());
        let wayland = linux(
            &X {
                display: None,
                x: false,
                socket: false,
                wayland: true,
                ..ready
            },
            None,
            false,
        );
        assert_eq!(wayland.needs.len(), 1);
        assert_eq!(wayland.needs[0].step, "x11_session");
        assert_eq!(wayland.needs[0].blocker, Some("wayland_only_no_x"));
        assert!(!wayland.needs[0].on_screen);
    }
}
