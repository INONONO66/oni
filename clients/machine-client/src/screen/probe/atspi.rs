pub fn ready() -> bool {
    let address = std::env::var("DBUS_SESSION_BUS_ADDRESS")
        .ok()
        .filter(|address| !address.is_empty())
        .or_else(|| {
            std::env::var("XDG_RUNTIME_DIR")
                .ok()
                .filter(|path| !path.is_empty())
                .map(|path| format!("unix:path={path}/bus"))
        });
    ready_on(address.as_deref())
}

fn ready_on(address: Option<&str>) -> bool {
    super::deadline::run(check(address)).is_some_and(|result| result.is_ok())
}

async fn check(address: Option<&str>) -> zbus::Result<()> {
    let builder = match address {
        Some(address) => zbus::connection::Builder::address(address),
        None => zbus::connection::Builder::session(),
    };
    let bus = builder?.build().await?;
    let reply = bus
        .call_method(
            Some("org.a11y.Bus"),
            "/org/a11y/bus",
            Some("org.a11y.Bus"),
            "GetAddress",
            &(),
        )
        .await?;
    let address = reply.body().deserialize::<String>()?;
    let accessibility = zbus::connection::Builder::address(address.as_str())?
        .build()
        .await?;
    drop(accessibility);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader},
        process::{Child, Command, Stdio},
        time::Duration,
    };

    struct Bus(String);
    #[zbus::interface(name = "org.a11y.Bus")]
    impl Bus {
        fn get_address(&self) -> String {
            self.0.clone()
        }
    }
    struct Daemon(Child);
    impl Drop for Daemon {
        fn drop(&mut self) {
            self.0.kill().expect("stop fixture bus");
            self.0.wait().expect("reap fixture bus");
        }
    }

    fn daemon() -> (Daemon, String) {
        let child = Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--print-address=1"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("session bus");
        let mut daemon = Daemon(child);
        let stdout = daemon.0.stdout.take().expect("address stream");
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut address = String::new();
            BufReader::new(stdout)
                .read_line(&mut address)
                .expect("bus readiness");
            send.send(address).expect("address receipt");
        });
        let address = receive
            .recv_timeout(Duration::from_secs(3))
            .expect("bus address");
        (daemon, address.trim().to_owned())
    }

    #[test]
    fn environment_selects_explicit_and_runtime_bus_addresses() {
        const CASE: &str = "ONI_BUS_ENV_FIXTURE";
        if std::env::var_os(CASE).is_some() {
            assert!(!ready());
            return;
        }
        let directory = tempfile::tempdir().expect("empty runtime directory");
        let runtime = directory.path().to_string_lossy();
        let missing = format!("unix:path={}/missing", directory.path().display());
        for (address, runtime) in [
            ("", runtime.as_ref()),
            (missing.as_str(), runtime.as_ref()),
            ("", ""),
        ] {
            let status = Command::new(std::env::current_exe().expect("test binary"))
                .args(["--exact", "screen::probe::atspi::tests::environment_selects_explicit_and_runtime_bus_addresses", "--nocapture"])
                .env(CASE, "1")
                .env("DBUS_SESSION_BUS_ADDRESS", address)
                .env("XDG_RUNTIME_DIR", runtime)
                .status().expect("isolated bus environment");
            assert!(status.success());
        }
    }

    #[test]
    fn accessibility_bus_requires_both_address_service_and_reachable_bus() {
        let (_daemon, address) = daemon();
        let address = address.as_str();
        assert!(!ready_on(Some(address)));
        let service = zbus::blocking::connection::Builder::address(address)
            .expect("address")
            .name("org.a11y.Bus")
            .expect("name")
            .serve_at("/org/a11y/bus", Bus(address.into()))
            .expect("service")
            .build()
            .expect("registered service");
        assert!(ready_on(Some(address)));
        assert!(!ready_on(Some("unix:path=/missing-accessibility-bus")));
        drop(service);
    }

    fn withheld_auth(address: String, listener: std::os::unix::net::UnixListener) {
        use std::{io::Read, sync::mpsc, thread};
        let (accepted, acceptance) = mpsc::channel();
        let (closed, closure) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("probe connection");
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("read deadline");
            accepted.send(()).expect("acceptance");
            let mut auth = Vec::new();
            socket
                .read_to_end(&mut auth)
                .expect("cancelled probe closes its socket");
            closed.send(auth).expect("closure receipt");
            released
                .recv_timeout(Duration::from_secs(2))
                .expect("fixture release");
        });
        let (finished, completion) = mpsc::channel();
        let client = thread::spawn(move || {
            finished
                .send(ready_on(Some(&address)))
                .expect("probe result")
        });
        acceptance
            .recv_timeout(Duration::from_secs(2))
            .expect("accepted before deadline");
        assert!(!completion
            .recv_timeout(Duration::from_secs(2))
            .expect("probe deadline before server release"));
        assert!(!closure
            .recv_timeout(Duration::from_secs(2))
            .expect("socket released by cancellation")
            .is_empty());
        release.send(()).expect("release fixture");
        client.join().expect("probe joined");
        server.join().expect("fixture joined");
    }

    #[test]
    fn session_bus_authentication_expires_and_closes_the_accepted_socket() {
        let directory = tempfile::tempdir().expect("bus fixture");
        let path = directory.path().join("session");
        let listener = std::os::unix::net::UnixListener::bind(&path).expect("accepting socket");
        withheld_auth(format!("unix:path={}", path.display()), listener);
    }

    #[test]
    fn accessibility_bus_authentication_shares_the_probe_deadline() {
        let (_daemon, address) = daemon();
        let directory = tempfile::tempdir().expect("bus fixture");
        let path = directory.path().join("accessibility");
        let listener = std::os::unix::net::UnixListener::bind(&path).expect("accepting socket");
        let _service = zbus::blocking::connection::Builder::address(address.as_str())
            .expect("session address")
            .name("org.a11y.Bus")
            .expect("name")
            .serve_at(
                "/org/a11y/bus",
                Bus(format!("unix:path={}", path.display())),
            )
            .expect("address service")
            .build()
            .expect("registered service");
        withheld_auth(address, listener);
    }
}
