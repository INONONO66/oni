use std::{
    io::{BufRead, BufReader, Read},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex, PoisonError},
    time::{Duration, Instant},
};

pub use super::{Config, Error};

pub struct Owned {
    pub id: String,
    server: Child,
    manager: Option<Mutex<Child>>,
}

impl Owned {
    pub fn window_manager_missing(&self) -> bool {
        let Some(manager) = &self.manager else {
            return true;
        };
        let mut manager = manager.lock().unwrap_or_else(PoisonError::into_inner);
        if !matches!(manager.try_wait(), Ok(None)) {
            return true;
        }
        !manager_ready(&self.id)
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        if let Some(manager) = &mut self.manager {
            stop(
                manager.get_mut().unwrap_or_else(PoisonError::into_inner),
                "window manager",
            );
        }
        stop(&mut self.server, "display");
    }
}

fn stop(child: &mut Child, name: &str) {
    if child.try_wait().is_ok_and(|status| status.is_some()) {
        return;
    }
    let terminated = i32::try_from(child.id()).ok().and_then(|id| {
        crate::app::termination(&crate::app::SystemClock, |terminate| {
            let pid = nix::unistd::Pid::from_raw(id);
            if terminate {
                return nix::sys::signal::kill(pid, Some(nix::sys::signal::Signal::SIGTERM));
            }
            exited(child.try_wait())
        })
        .ok()
    });
    if terminated != Some(true) {
        crate::app::linux::cleanup(child.kill(), &format!("{name} shutdown"));
        crate::app::linux::cleanup(child.wait(), &format!("{name} reap"));
    }
}

fn exited(
    status: std::io::Result<Option<std::process::ExitStatus>>,
) -> Result<(), nix::errno::Errno> {
    match status {
        Ok(Some(_)) => Err(nix::errno::Errno::ESRCH),
        Ok(None) => Ok(()),
        Err(_) => Err(nix::errno::Errno::EIO),
    }
}

pub fn available(path: &str) -> bool {
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .any(|directory| directory.join(path).is_file())
}

pub fn open(config: &Config) -> Result<Owned, Error> {
    super::validate(config, available("Xvfb"))?;
    let mut server = spawn_server(config)?;
    let stdout = server.stdout.take().ok_or(Error::Unavailable)?;
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout.take(16))
            .read_line(&mut line)
            .map(|_| line);
        let _ = send.send(result);
    });
    let mut owned = Owned {
        id: String::new(),
        server,
        manager: None,
    };
    let line = receive
        .recv_timeout(Duration::from_secs(3))
        .map_err(|_| Error::Unavailable)?
        .map_err(|_| Error::Unavailable)?;
    let number = line.trim().parse::<u16>().map_err(|_| Error::Unavailable)?;
    owned.id = format!(":{number}");
    await_ready(&mut owned)?;
    owned.manager = spawn_manager(config, &owned.id).map(Mutex::new);
    wait_manager_ready(&owned);
    Ok(owned)
}

fn spawn_server(config: &Config) -> Result<Child, Error> {
    Command::new("Xvfb")
        .args([
            "-displayfd",
            "1",
            "-screen",
            "0",
            &format!("{}x{}x24", config.width, config.height),
            "-dpi",
            &config.dpi.to_string(),
            "-nolisten",
            "tcp",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| Error::Unavailable)
}

fn await_ready(owned: &mut Owned) -> Result<(), Error> {
    if owned
        .server
        .try_wait()
        .map_err(|_| Error::Unavailable)?
        .is_some()
        || !crate::screen::probe::x11::handshake(&owned.id)
        || owned
            .server
            .try_wait()
            .map_err(|_| Error::Unavailable)?
            .is_some()
    {
        return Err(Error::Unavailable);
    }
    Ok(())
}

fn manager_ready(display: &str) -> bool {
    use x11rb::connection::Connection;
    let Ok((connection, index)) = crate::screen::probe::x11::connection(Some(display)) else {
        return false;
    };
    // The connection constructor validates its selected screen index.
    manager_property(&connection, connection.setup().roots[index].root).unwrap_or(false)
}

fn manager_property<S: x11rb::rust_connection::Stream>(
    connection: &x11rb::rust_connection::RustConnection<S>,
    root: u32,
) -> Result<bool, x11rb::errors::ReplyError> {
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt};
    let atom = connection
        .intern_atom(false, b"_NET_SUPPORTING_WM_CHECK")?
        .reply()?;
    let reply = connection
        .get_property(false, root, atom.atom, AtomEnum::WINDOW, 0, 1)?
        .reply()?;
    Ok(reply
        .value32()
        .and_then(|mut values| values.next())
        .is_some())
}

fn wait_manager_ready(owned: &Owned) {
    wait_manager_ready_with(owned, manager_ready);
}

fn wait_manager_ready_with(owned: &Owned, ready: impl Fn(&str) -> bool) {
    use x11rb::connection::Connection;

    if owned.manager.is_none() || !manager_running(owned) || ready(&owned.id) {
        return;
    }
    let Ok((connection, index)) = x11rb::connect(Some(&owned.id)) else {
        return;
    };
    let root = connection.setup().roots[index].root;
    wait_manager_events(
        owned,
        &connection,
        root,
        &ready,
        poll_manager_event(&connection),
    );
}

fn poll_manager_event(
    connection: &x11rb::rust_connection::RustConnection<x11rb::rust_connection::DefaultStream>,
) -> impl FnMut() -> Result<Option<x11rb::protocol::Event>, x11rb::errors::ConnectionError> + '_ {
    use x11rb::connection::Connection;
    || connection.poll_for_event()
}

fn manager_running(owned: &Owned) -> bool {
    owned.manager.as_ref().is_some_and(|manager| {
        matches!(
            manager
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .try_wait(),
            Ok(None)
        )
    })
}

fn wait_manager_events(
    owned: &Owned,
    connection: &x11rb::rust_connection::RustConnection<x11rb::rust_connection::DefaultStream>,
    root: u32,
    ready: &impl Fn(&str) -> bool,
    mut next_event: impl FnMut()
        -> Result<Option<x11rb::protocol::Event>, x11rb::errors::ConnectionError>,
) {
    use rustix::event::{PollFd, PollFlags, Timespec};
    use x11rb::{
        connection::Connection,
        protocol::{
            xproto::{ChangeWindowAttributesAux, ConnectionExt, EventMask},
            Event,
        },
    };

    if connection
        .change_window_attributes(
            root,
            &ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE),
        )
        .ok()
        .and_then(|cookie| cookie.check().ok())
        .is_none()
        || connection.flush().is_err()
    {
        return;
    }
    // Subscribe before reading the property, so a manager starting between
    // those operations cannot leave the readiness transition unobserved.
    if ready(&owned.id) {
        return;
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        if !manager_running(owned) {
            return;
        }
        // Replies to the property probe can queue notifications in x11rb even
        // after the socket stops being readable; drain those before polling.
        loop {
            match next_event() {
                Ok(Some(Event::PropertyNotify(change))) if change.window == root => {
                    if ready(&owned.id) {
                        return;
                    }
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break,
            }
        }
        let timeout = Timespec {
            tv_sec: 0,
            tv_nsec: i64::from(remaining.min(Duration::from_millis(100)).subsec_nanos()),
        };
        if !matches!(
            rustix::event::poll(
                &mut [PollFd::new(connection.stream(), PollFlags::IN)],
                Some(&timeout)
            ),
            Ok(count) if count > 0
        ) {
            continue;
        }
    }
}

fn spawn_manager(config: &Config, display: &str) -> Option<Child> {
    let manager = config
        .window_manager
        .as_ref()
        .map_or("openbox", |manager| manager.path.as_str());
    if !(available(manager) || Path::new(manager).is_file()) {
        return None;
    }
    let args = config
        .window_manager
        .as_ref()
        .map_or(&[][..], |manager| manager.args.as_slice());
    let mut command = Command::new(manager);
    command
        .env_clear()
        .envs(crate::app::launch_env::inherited(|name| {
            std::env::var_os(name)
        }));
    crate::app::launch_env::bind(&mut command, Some(display), None, true);
    command
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exit_probe_reports_wait_errors() {
        assert_eq!(
            exited(Err(std::io::Error::other("wait failure"))),
            Err(nix::errno::Errno::EIO)
        );
    }

    #[test]
    fn stubborn_child_is_killed_and_reaped_after_termination_deadline() {
        use std::os::unix::process::ExitStatusExt;
        let child = Command::new("/bin/sh")
            .args(["-c", "trap '' TERM; printf 'ready\\n'; read line"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("stubborn process");
        let mut owned = Owned {
            id: String::new(),
            server: child,
            manager: None,
        };
        assert!(owned.window_manager_missing());
        let output = owned.server.stdout.take().expect("readiness");
        let (ready, receipt) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut line = String::new();
            BufReader::new(output)
                .read_line(&mut line)
                .expect("ready receipt");
            ready.send(line).expect("readiness delivered");
        });
        assert_eq!(
            receipt.recv_timeout(Duration::from_secs(3)).expect("ready"),
            "ready\n"
        );
        reader.join().expect("reader joined");
        stop(&mut owned.server, "stubborn fixture");
        assert_eq!(
            owned
                .server
                .try_wait()
                .expect("reaped")
                .expect("exit")
                .signal(),
            Some(9)
        );
    }

    #[test]
    fn manager_probe_refuses_missing_display_and_invalid_window() {
        assert!(!manager_ready("host:0"));
        let mut owned = open(&config()).expect("display");
        let (connection, _) =
            crate::screen::probe::x11::connection(Some(&owned.id)).expect("connection");
        assert!(matches!(
            manager_property(&connection, 0),
            Err(x11rb::errors::ReplyError::X11Error(_))
        ));
        owned.server.kill().expect("server exits");
        owned.server.wait().expect("server exit barrier");
        assert!(matches!(
            manager_property(&connection, 0),
            Err(x11rb::errors::ReplyError::ConnectionError(_))
        ));
    }
    #[test]
    fn absent_binary_returns_typed_configuration_error() {
        let invalid = Config {
            kind: "unsupported".into(),
            width: 100,
            height: 100,
            dpi: 96,
            window_manager: None,
        };
        assert!(matches!(open(&invalid), Err(Error::Unavailable)));
        assert!(!available("missing-binary-that-does-not-exist"));
        let missing = Config {
            window_manager: Some(super::super::Manager {
                path: "/missing-window-manager".into(),
                args: vec![],
            }),
            ..config()
        };
        assert!(spawn_manager(&missing, ":unused").is_none());
    }

    fn config() -> Config {
        Config {
            kind: "xvfb".into(),
            width: 32,
            height: 24,
            dpi: 96,
            window_manager: Some(super::super::Manager {
                path: "/bin/true".into(),
                args: vec![],
            }),
        }
    }

    fn waiting_manager() -> Owned {
        let mut owned = open(&config()).expect("display");
        let manager = Command::new("/bin/sh")
            .args(["-c", "read line"])
            .stdin(Stdio::piped())
            .spawn()
            .expect("waiting manager");
        owned.manager = Some(Mutex::new(manager));
        owned
    }

    fn ready_on_call(
        calls: &std::cell::Cell<usize>,
        expected: usize,
    ) -> impl Fn(&str) -> bool + '_ {
        move |_| {
            calls.set(calls.get() + 1);
            calls.get() == expected
        }
    }

    #[test]
    fn readiness_probe_refuses_disconnected_display() {
        let mut owned = waiting_manager();
        owned.id = "not-a-display".into();
        let calls = std::cell::Cell::new(0);
        wait_manager_ready_with(&owned, |_| {
            calls.set(calls.get() + 1);
            false
        });
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn readiness_probe_refuses_invalid_subscription_root() {
        let owned = waiting_manager();
        let (connection, _) = x11rb::connect(Some(&owned.id)).expect("display connection");
        let calls = std::cell::Cell::new(0);
        wait_manager_events(
            &owned,
            &connection,
            0,
            &ready_on_call(&calls, 1),
            poll_manager_event(&connection),
        );
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn readiness_probe_sees_manager_after_event_subscription() {
        let owned = waiting_manager();
        let calls = std::cell::Cell::new(0);
        wait_manager_ready_with(&owned, ready_on_call(&calls, 2));
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn readiness_probe_drains_unrelated_and_not_yet_ready_events() {
        use std::collections::VecDeque;
        use x11rb::{
            connection::Connection,
            protocol::{xproto, Event},
        };
        let owned = waiting_manager();
        let (connection, index) = x11rb::connect(Some(&owned.id)).expect("display connection");
        let root = connection.setup().roots[index].root;
        let events = std::cell::RefCell::new(VecDeque::from([
            Event::Expose(xproto::ExposeEvent {
                response_type: xproto::EXPOSE_EVENT,
                sequence: 0,
                window: root,
                x: 0,
                y: 0,
                width: 1,
                height: 1,
                count: 0,
            }),
            Event::PropertyNotify(xproto::PropertyNotifyEvent {
                response_type: xproto::PROPERTY_NOTIFY_EVENT,
                sequence: 0,
                window: root,
                atom: u32::from(xproto::AtomEnum::WM_NAME),
                time: 0,
                state: xproto::Property::NEW_VALUE,
            }),
            Event::PropertyNotify(xproto::PropertyNotifyEvent {
                response_type: xproto::PROPERTY_NOTIFY_EVENT,
                sequence: 0,
                window: root,
                atom: u32::from(xproto::AtomEnum::WM_NAME),
                time: 0,
                state: xproto::Property::NEW_VALUE,
            }),
        ]));
        let calls = std::cell::Cell::new(0);
        wait_manager_events(
            &owned,
            &connection,
            root,
            &|_| {
                calls.set(calls.get() + 1);
                calls.get() == 3
            },
            || Ok(events.borrow_mut().pop_front()),
        );
        assert_eq!(calls.get(), 3);
        assert!(events.borrow().is_empty());
    }

    #[test]
    fn readiness_probe_rechecks_manager_after_empty_poll() {
        use x11rb::connection::Connection;
        let owned = waiting_manager();
        let (connection, index) = x11rb::connect(Some(&owned.id)).expect("display connection");
        let root = connection.setup().roots[index].root;
        let polls = std::cell::Cell::new(0);
        wait_manager_events(&owned, &connection, root, &|_| false, || {
            polls.set(polls.get() + 1);
            let mut manager = owned
                .manager
                .as_ref()
                .expect("waiting manager")
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            manager.kill().expect("manager exits");
            manager.wait().expect("manager exit receipt");
            Ok(None)
        });
        assert_eq!(polls.get(), 1);
        assert!(!manager_running(&owned));
    }

    #[test]
    fn concurrent_servers_receive_distinct_owned_displays() {
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let other = barrier.clone();
        let child = std::thread::spawn(move || {
            other.wait();
            open(&config()).expect("second display")
        });
        barrier.wait();
        let first = open(&config()).expect("first display");
        let second = child.join().expect("second owner");
        assert_ne!(first.id, second.id);
        assert!(crate::screen::probe::x11::handshake(&first.id));
        assert!(crate::screen::probe::x11::handshake(&second.id));
    }

    #[test]
    fn exited_server_cannot_claim_another_owners_ready_socket() {
        let owner = open(&config()).expect("live owner");
        let mut server = Command::new("/bin/true").spawn().expect("exited child");
        server.wait().expect("exit barrier");
        let mut loser = Owned {
            id: owner.id.clone(),
            server,
            manager: None,
        };
        assert!(matches!(await_ready(&mut loser), Err(Error::Unavailable)));
        assert!(crate::screen::probe::x11::handshake(&owner.id));
    }

    #[test]
    fn exited_manager_is_not_reported_present() {
        let owned = open(&config()).expect("display");
        owned
            .manager
            .as_ref()
            .expect("spawned manager")
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .wait()
            .expect("manager exit barrier");
        assert!(owned.window_manager_missing());
    }

    #[test]
    fn ready_manager_exit_changes_the_next_readiness_fact() {
        let owned = open(&Config {
            window_manager: None,
            ..config()
        })
        .expect("display with openbox");
        assert!(
            !owned.window_manager_missing(),
            "openbox must publish its EWMH readiness"
        );
        let mut manager = owned
            .manager
            .as_ref()
            .expect("manager")
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        manager.kill().expect("manager exits");
        manager.wait().expect("manager exit receipt");
        drop(manager);
        assert!(owned.window_manager_missing());
    }

    #[test]
    fn ready_virtual_desktop_is_available_without_claiming_observation() {
        let owned = open(&Config {
            window_manager: None,
            ..config()
        })
        .expect("display with openbox");
        let id = owned.id.clone();
        let manager = owned.manager.as_ref().map(|manager| {
            manager
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .try_wait()
        });
        let input = crate::input::Input::platform_on(Some(&id));
        let screen = crate::screen::Screen::platform_on(Some(&id)).virtualizing(owned);
        let verdict = screen.capability(input.ready());
        assert_eq!(
            verdict.verdict, "available",
            "{verdict:?}; manager={manager:?}"
        );
        assert!(verdict.display.isolated);
        assert!(!verdict.grants.accessibility);
    }

    #[test]
    fn manager_launch_discards_inherited_session_addresses() {
        const CASE: &str = "ONI_MANAGER_ENV_RECEIPT";
        if let Some(receipt) = std::env::var_os(CASE) {
            let owned = open(&Config {
                window_manager: Some(super::super::Manager {
                    path: "/bin/sh".into(),
                    args: vec![
                        "-c".into(),
                        "env > \"$1\"".into(),
                        "sh".into(),
                        receipt.to_string_lossy().into_owned(),
                    ],
                }),
                ..config()
            })
            .expect("isolated manager");
            owned
                .manager
                .as_ref()
                .expect("spawned manager")
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .wait()
                .expect("manager exit barrier");
            let environment = std::fs::read_to_string(receipt).expect("manager environment");
            let values: std::collections::HashMap<_, _> = environment
                .lines()
                .filter_map(|line| line.split_once('='))
                .collect();
            assert_eq!(values.get("DISPLAY"), Some(&owned.id.as_str()));
            for name in [
                "XAUTHORITY",
                "WAYLAND_DISPLAY",
                "XDG_SESSION_TYPE",
                "DBUS_SESSION_BUS_ADDRESS",
                "XDG_RUNTIME_DIR",
            ] {
                assert_eq!(values.get(name), Some(&""));
            }
            assert!(!values.contains_key("SESSION_MANAGER"));
            assert!(!values.contains_key("AT_SPI_BUS_ADDRESS"));
            return;
        }
        let directory = tempfile::tempdir().expect("environment fixture");
        let output = Command::new(std::env::current_exe().expect("test binary"))
            .args([
                "--exact",
                "display::xvfb::tests::manager_launch_discards_inherited_session_addresses",
                "--nocapture",
            ])
            .env(CASE, directory.path().join("environment"))
            .env("SESSION_MANAGER", "human-session-manager")
            .env("AT_SPI_BUS_ADDRESS", "unix:path=/human/a11y")
            .env("WAYLAND_DISPLAY", "human-wayland")
            .env("DBUS_SESSION_BUS_ADDRESS", "unix:path=/human/bus")
            .output()
            .expect("manager fixture process");
        assert!(output.status.success(), "{output:?}");
    }
}
