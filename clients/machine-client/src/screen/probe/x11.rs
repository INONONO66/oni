use std::{
    io,
    os::unix::net::UnixStream,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use x11rb::{
    errors::ConnectError,
    rust_connection::{DefaultStream, PollMode, RustConnection, Stream},
    utils::RawFdContainer,
};

use super::auth;

const DEADLINE: Duration = Duration::from_millis(500);

pub struct BoundedStream {
    stream: DefaultStream,
    deadline: Instant,
    established: AtomicBool,
}

impl BoundedStream {
    fn remaining(&self) -> io::Result<Duration> {
        if self.established.load(Ordering::Relaxed) {
            return Ok(DEADLINE);
        }
        self.deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "X11 setup deadline"))
    }
    fn poll_with(
        &self,
        mode: PollMode,
        mut poll: impl FnMut(
            rustix::event::PollFlags,
            &rustix::event::Timespec,
        ) -> Result<usize, rustix::io::Errno>,
    ) -> io::Result<()> {
        use rustix::event::{PollFlags, Timespec};
        let mut flags = PollFlags::empty();
        if mode.readable() {
            flags |= PollFlags::IN;
        }
        if mode.writable() {
            flags |= PollFlags::OUT;
        }
        loop {
            let remaining = self.remaining()?;
            let timeout = Timespec::try_from(remaining).map_err(io::Error::other)?;
            match poll(flags, &timeout) {
                Ok(0) => {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "X11 reply deadline",
                    ))
                }
                Ok(_) => return Ok(()),
                Err(rustix::io::Errno::INTR) => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
}

impl Stream for BoundedStream {
    fn poll(&self, mode: PollMode) -> io::Result<()> {
        self.poll_with(mode, |flags, timeout| {
            rustix::event::poll(
                &mut [rustix::event::PollFd::new(&self.stream, flags)],
                Some(timeout),
            )
        })
    }
    fn read(&self, bytes: &mut [u8], fds: &mut Vec<RawFdContainer>) -> io::Result<usize> {
        self.remaining()?;
        self.stream.read(bytes, fds)
    }
    fn write(&self, bytes: &[u8], fds: &mut Vec<RawFdContainer>) -> io::Result<usize> {
        self.remaining()?;
        self.stream.write(bytes, fds)
    }
}

pub type Connection = RustConnection<BoundedStream>;

fn setup(
    stream: UnixStream,
    secret: Vec<u8>,
    deadline: Instant,
) -> Result<Connection, ConnectError> {
    let (stream, _) = DefaultStream::from_unix_stream(stream)?;
    let name = if secret.is_empty() {
        vec![]
    } else {
        b"MIT-MAGIC-COOKIE-1".to_vec()
    };
    let connection = RustConnection::connect_to_stream_with_auth_info(
        BoundedStream {
            stream,
            deadline,
            established: AtomicBool::new(false),
        },
        0,
        name,
        secret,
    )?;
    connection
        .stream()
        .established
        .store(true, Ordering::Relaxed);
    Ok(connection)
}

fn connect(path: &str) -> io::Result<UnixStream> {
    use rustix::net::{
        connect as connect_socket, socket_with, AddressFamily, SocketAddrUnix, SocketFlags,
        SocketType,
    };
    let fd = socket_with(
        AddressFamily::UNIX,
        SocketType::STREAM,
        SocketFlags::NONBLOCK | SocketFlags::CLOEXEC,
        None,
    )?;
    connect_socket(&fd, &SocketAddrUnix::new(path)?)?;
    Ok(UnixStream::from(fd))
}

pub(crate) fn selected(name: &str) -> Result<(Connection, usize, Option<String>), ConnectError> {
    let number = super::local_display(name).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "nonlocal X11 display or nonzero screen",
        )
    })?;
    let deadline = Instant::now() + DEADLINE;
    let files = [
        std::env::var_os("XAUTHORITY")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from),
        auth::server_file(std::path::Path::new("/proc"), &format!(":{number}")),
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".Xauthority")),
    ];
    let path = format!("/tmp/.X11-unix/X{number}");
    let mut secrets = vec![(None, vec![])];
    for file in files.into_iter().flatten() {
        if let Some(secret) = std::fs::read(&file)
            .ok()
            .and_then(|bytes| auth::cookie(&bytes, number))
        {
            secrets.insert(
                secrets.len() - 1,
                (Some(file.to_string_lossy().into_owned()), secret),
            );
        }
    }
    authenticate(&path, secrets, deadline)
}

fn authenticate(
    path: &str,
    secrets: Vec<(Option<String>, Vec<u8>)>,
    deadline: Instant,
) -> Result<(Connection, usize, Option<String>), ConnectError> {
    let mut failure = io::Error::new(io::ErrorKind::NotConnected, "X11 unreachable").into();
    for (authority, secret) in secrets {
        if Instant::now() >= deadline {
            break;
        }
        match setup(connect(path)?, secret, deadline) {
            Ok(connection) => return Ok((connection, 0, authority)),
            Err(error) => failure = error,
        }
    }
    Err(failure)
}

pub(crate) fn connection(name: Option<&str>) -> Result<(Connection, usize), ConnectError> {
    let display = name
        .map(str::to_owned)
        .or_else(|| std::env::var("DISPLAY").ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no X11 display"))?;
    selected(&display).map(|(connection, index, _)| (connection, index))
}

pub fn candidates() -> Vec<String> {
    let mut rows: Vec<_> = std::fs::read_dir("/tmp/.X11-unix")
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_prefix('X'))
                .map(|number| format!(":{number}"))
        })
        .collect();
    rows.sort();
    rows
}

pub fn socket(name: &str) -> bool {
    super::local_display(name)
        .is_some_and(|number| connect(&format!("/tmp/.X11-unix/X{number}")).is_ok())
}

pub fn handshake(name: &str) -> bool {
    connection(Some(name)).is_ok()
}

pub fn status(name: &str) -> super::X11 {
    match connection(Some(name)) {
        Ok(_) => super::X11::Ready,
        Err(ConnectError::SetupFailed(_) | ConnectError::SetupAuthenticate(_)) => {
            super::X11::Refused
        }
        Err(_) => super::X11::Unreachable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn authentication_preserves_the_servers_setup_refusal() {
        let directory = tempfile::tempdir().expect("X11 fixture");
        let path = directory.path().join("socket");
        let listener = std::os::unix::net::UnixListener::bind(&path).expect("listener");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accepted");
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("bounded read");
            let mut request = [0; 12];
            stream.read_exact(&mut request).expect("setup request");
            let mut refusal = [0; 12];
            refusal[1] = 4;
            refusal[2..4].copy_from_slice(&11_u16.to_ne_bytes());
            refusal[6..8].copy_from_slice(&1_u16.to_ne_bytes());
            refusal[8..].copy_from_slice(b"deny");
            stream.write_all(&refusal).expect("setup refusal");
        });
        assert!(matches!(
            authenticate(
                path.to_str().expect("socket path"),
                vec![(None, vec![])],
                Instant::now() + DEADLINE
            ),
            Err(ConnectError::SetupFailed(_))
        ));
        server.join().expect("server joined");
    }

    #[test]
    fn poll_retries_interrupts_and_preserves_terminal_errors() {
        use rustix::{event::PollFlags, io::Errno};
        for (mode, established, responses, expected, count) in [
            (
                PollMode::Readable,
                true,
                vec![Err(Errno::INTR), Ok(1)],
                Ok(()),
                2,
            ),
            (
                PollMode::Writable,
                true,
                vec![Err(Errno::BADF)],
                Err(io::Error::from(Errno::BADF).kind()),
                1,
            ),
            (
                PollMode::ReadAndWritable,
                true,
                vec![Ok(0)],
                Err(io::ErrorKind::TimedOut),
                1,
            ),
            (
                PollMode::Readable,
                false,
                vec![],
                Err(io::ErrorKind::TimedOut),
                0,
            ),
        ] {
            let (client, _server) = UnixStream::pair().expect("pair");
            let stream = BoundedStream {
                stream: DefaultStream::from_unix_stream(client).expect("stream").0,
                deadline: Instant::now() - DEADLINE,
                established: AtomicBool::new(established),
            };
            let mut replies = responses.into_iter();
            let mut calls = 0;
            let result = stream.poll_with(mode, |flags, _| {
                assert_eq!(flags.contains(PollFlags::IN), mode.readable());
                assert_eq!(flags.contains(PollFlags::OUT), mode.writable());
                calls += 1;
                replies.next().expect("scripted poll result")
            });
            assert_eq!(result.map_err(|error| error.kind()), expected);
            assert_eq!(calls, count);
        }
    }

    #[test]
    fn implicit_display_reports_missing_and_invalid_environment() {
        const CASE: &str = "ONI_X11_IMPLICIT_DISPLAY";
        if let Ok(mode) = std::env::var(CASE) {
            let expected = if mode == "missing" {
                io::ErrorKind::NotFound
            } else {
                io::ErrorKind::InvalidInput
            };
            assert!(
                matches!(connection(None), Err(ConnectError::IoError(error)) if error.kind() == expected)
            );
            return;
        }
        for mode in ["missing", "invalid"] {
            let mut child =
                std::process::Command::new(std::env::current_exe().expect("test binary"));
            child.args(["--exact", "screen::probe::x11::tests::implicit_display_reports_missing_and_invalid_environment", "--nocapture"])
                .env(CASE, mode).env_remove("DISPLAY");
            if mode == "invalid" {
                child.env("DISPLAY", "host:0");
            }
            assert!(child
                .status()
                .expect("isolated display environment")
                .success());
        }
    }

    #[test]
    fn invalid_display_and_expired_authority_attempt_are_typed() {
        assert!(
            matches!(selected("host:0"), Err(ConnectError::IoError(error))
            if error.kind() == io::ErrorKind::InvalidInput)
        );
        assert!(matches!(status("host:0"), super::super::X11::Unreachable));
        assert!(matches!(
            authenticate("/unused", vec![(None, vec![])], Instant::now()),
            Err(ConnectError::IoError(error)) if error.kind() == io::ErrorKind::NotConnected
        ));
        let (client, _server) = UnixStream::pair().expect("pair");
        let expired = BoundedStream {
            stream: DefaultStream::from_unix_stream(client).expect("stream").0,
            deadline: Instant::now() - DEADLINE,
            established: AtomicBool::new(false),
        };
        let error = expired
            .read(&mut [0; 1], &mut vec![])
            .expect_err("expired setup");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }

    #[test]
    fn exhausted_descriptors_refuse_socket_creation() {
        const CASE: &str = "ONI_X11_DESCRIPTOR_EXHAUSTION";
        if std::env::var_os(CASE).is_some() {
            let mut files = Vec::new();
            while let Ok(file) = std::fs::File::open("/dev/null") {
                files.push(file);
            }
            let error = connect("/unused").expect_err("socket descriptor exhaustion");
            assert_eq!(
                error.raw_os_error(),
                Some(rustix::io::Errno::MFILE.raw_os_error())
            );
            return;
        }
        let status = std::process::Command::new("/bin/sh")
            .args(["-c", "ulimit -n 32; exec \"$1\" --exact screen::probe::x11::tests::exhausted_descriptors_refuse_socket_creation --nocapture", "sh"])
            .arg(std::env::current_exe().expect("test binary"))
            .env(CASE, "1")
            .status().expect("bounded descriptor fixture");
        assert!(status.success());
    }

    #[test]
    fn accepted_socket_without_setup_reply_expires_before_server_release() {
        let (client, mut server) = UnixStream::pair().expect("socket pair");
        let (accepted, receipt) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let peer = std::thread::spawn(move || {
            let mut request = [0; 12];
            server.read_exact(&mut request).expect("setup request");
            accepted.send(()).expect("acceptance receipt");
            wait.recv_timeout(Duration::from_secs(3)).expect("release");
        });
        let probe = std::thread::spawn(move || setup(client, vec![], Instant::now() + DEADLINE));
        receipt
            .recv_timeout(Duration::from_secs(2))
            .expect("accepted setup");
        assert!(
            matches!(probe.join().expect("probe"), Err(ConnectError::IoError(error))
            if error.kind() == io::ErrorKind::TimedOut)
        );
        release.send(()).expect("release server");
        peer.join().expect("server");
    }
}
