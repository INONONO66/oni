use std::{
    collections::HashMap,
    process::Command,
    sync::{mpsc::Sender, Arc, Condvar, Mutex, PoisonError},
    time::Duration,
};

use oni_protocol::{app_launch_request::AppLaunchRequestApp, AppLaunchRequest};

use super::{Fault, Launcher, Resolved};
use crate::screen::ax::AppIdentity;

pub struct Native {
    display: Option<String>,
    authority: Option<String>,
    isolated: bool,
    children: Mutex<HashMap<u32, Arc<Running>>>,
}

struct Running {
    identity: AppIdentity,
    exited: Mutex<bool>,
    changed: Condvar,
}

pub(crate) fn cleanup(result: std::io::Result<impl Sized>, action: &str) {
    if let Err(error) = result {
        eprintln!("{action}: {error}");
    }
}

fn terminate_owned(signal: Result<(), nix::errno::Errno>) -> Result<(), Fault> {
    match signal {
        Ok(()) | Err(nix::errno::Errno::ESRCH) => Ok(()),
        Err(error) => Err(Fault::Failed(error.to_string())),
    }
}

impl Native {
    pub fn new(display: Option<String>) -> Self {
        Self::selected(display, None, false)
    }

    pub fn selected(display: Option<String>, authority: Option<String>, isolated: bool) -> Self {
        Self {
            display,
            authority,
            isolated,
            children: Mutex::new(HashMap::new()),
        }
    }

    fn command(&self, request: &AppLaunchRequest, resolved: &Resolved) -> Command {
        let mut command = Command::new(&resolved.bundle_path);
        if let AppLaunchRequestApp::Variant1 { args, .. } = &request.app {
            command.args(args.iter().flatten().map(|argument| argument.as_str()));
        }
        command.env_clear();
        command.envs(super::launch_env::inherited(|name| std::env::var_os(name)));
        if let Some(env) = &request.env {
            for (key, value) in env {
                command.env(key.to_string(), value.as_str());
            }
        }
        super::launch_env::bind(
            &mut command,
            self.display.as_deref(),
            self.authority.as_deref(),
            self.isolated,
        );
        command
    }
}

impl Launcher for Native {
    fn resolve(&self, request: &AppLaunchRequest) -> Result<Resolved, Fault> {
        let AppLaunchRequestApp::Variant1 { path, .. } = &request.app else {
            return Err(Fault::Unsupported("platform"));
        };
        let executable = std::fs::canonicalize(path.as_str()).map_err(|_| Fault::NotFound)?;
        if !executable.is_file() {
            return Err(Fault::NotFound);
        }
        let path = executable.to_string_lossy().into_owned();
        Ok(Resolved {
            identity: AppIdentity {
                bundle_id: None,
                path: path.clone(),
            },
            running_pid: None,
            bundle_path: path,
        })
    }
    fn identity(&self, pid: u32) -> Result<AppIdentity, Fault> {
        if let Some(child) = self
            .children
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&pid)
        {
            return Ok(child.identity.clone());
        }
        let path =
            std::fs::read_link(format!("/proc/{pid}/exe")).map_err(|_| Fault::ProcessNotFound)?;
        Ok(AppIdentity {
            bundle_id: None,
            path: path.to_string_lossy().into_owned(),
        })
    }
    fn start(
        &self,
        request: &AppLaunchRequest,
        resolved: &Resolved,
        reply: Sender<Result<u32, Fault>>,
    ) -> Result<(), Fault> {
        let mut child = self
            .command(request, resolved)
            .spawn()
            .map_err(|error| Fault::Failed(error.to_string()))?;
        let pid = child.id();
        if reply.send(Ok(pid)).is_err() {
            cleanup(child.kill(), "launch rollback kill");
            cleanup(child.wait(), "launch rollback reap");
            return Err(Fault::Failed("launch completion disconnected".into()));
        }
        let running = Arc::new(Running {
            identity: resolved.identity.clone(),
            exited: Mutex::new(false),
            changed: Condvar::new(),
        });
        let mut children = self.children.lock().unwrap_or_else(PoisonError::into_inner);
        children.retain(|_, child| !*child.exited.lock().unwrap_or_else(PoisonError::into_inner));
        children.insert(pid, running.clone());
        std::thread::spawn(move || {
            cleanup(child.wait(), "launched child reap");
            let mut exited = running
                .exited
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            *exited = true;
            running.changed.notify_all();
        });
        Ok(())
    }
    fn quit(&self, id: u32) -> Result<bool, Fault> {
        self.quit_with(id, nix::sys::signal::kill)
    }
}

impl Native {
    fn quit_with(
        &self,
        id: u32,
        signal: fn(
            nix::unistd::Pid,
            Option<nix::sys::signal::Signal>,
        ) -> Result<(), nix::errno::Errno>,
    ) -> Result<bool, Fault> {
        let pid =
            nix::unistd::Pid::from_raw(i32::try_from(id).map_err(|_| Fault::ProcessNotFound)?);
        let running = self
            .children
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&id)
            .cloned();
        if let Some(running) = running {
            let exited = running
                .exited
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if *exited {
                return Ok(true);
            }
            terminate_owned(signal(pid, Some(nix::sys::signal::Signal::SIGTERM)))?;
            let (exited, _) = running
                .changed
                .wait_timeout_while(exited, Duration::from_secs(2), |done| !*done)
                .unwrap_or_else(PoisonError::into_inner);
            return Ok(*exited);
        }
        super::termination(&super::SystemClock, |terminate| {
            signal(pid, terminate.then_some(nix::sys::signal::Signal::SIGTERM))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_resolution_and_external_process_identity_are_typed() {
        let launcher = Native::new(None);
        let request = oni_protocol::decode(json!({"app":{"path":"/"},"activate":false}))
            .expect("directory request");
        assert!(matches!(launcher.resolve(&request), Err(Fault::NotFound)));
        let current = launcher
            .identity(std::process::id())
            .expect("external identity");
        assert_eq!(
            current.path,
            std::fs::read_link("/proc/self/exe")
                .expect("executable")
                .to_string_lossy()
        );
        assert_eq!(launcher.identity(u32::MAX), Err(Fault::ProcessNotFound));
        assert_eq!(
            launcher.quit(u32::try_from(i32::MAX).expect("positive PID")),
            Err(Fault::ProcessNotFound)
        );
        let request = oni_protocol::decode(
            json!({"app":{"bundleId":"example"},"activate":false,"env":{"LANG":"C.UTF-8"}}),
        )
        .expect("bundle request");
        let resolved = Resolved {
            identity: current,
            running_pid: None,
            bundle_path: "/bin/true".into(),
        };
        let command = launcher.command(&request, &resolved);
        assert_eq!(command.get_args().count(), 0);
        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == "LANG")
                .and_then(|(_, value)| value),
            Some(std::ffi::OsStr::new("C.UTF-8"))
        );
    }

    #[test]
    fn vanished_executable_refuses_resolution_and_spawn() {
        let directory = tempfile::tempdir().expect("executable fixture");
        let path = directory.path().join("app");
        std::fs::copy("/bin/true", &path).expect("executable");
        let request = oni_protocol::decode(json!({"app":{"path":path},"activate":false}))
            .expect("path request");
        let launcher = Native::new(None);
        let resolved = launcher.resolve(&request).expect("resolve live executable");
        std::fs::remove_file(path).expect("remove executable before spawn");
        let (reply, _receipt) = std::sync::mpsc::channel();
        assert_eq!(
            launcher.start(&request, &resolved, reply),
            Err(Fault::Failed(
                std::io::Error::from(nix::errno::Errno::ENOENT).to_string()
            ))
        );
        assert!(matches!(launcher.resolve(&request), Err(Fault::NotFound)));
    }

    #[test]
    fn owned_termination_preserves_signal_errors_and_already_exited_children() {
        assert_eq!(terminate_owned(Err(nix::errno::Errno::ESRCH)), Ok(()));
        assert_eq!(
            terminate_owned(Err(nix::errno::Errno::EPERM)),
            Err(Fault::Failed(nix::errno::Errno::EPERM.to_string()))
        );
        let launcher = Native::new(None);
        launcher.children.lock().expect("children").insert(
            42,
            Arc::new(Running {
                identity: AppIdentity {
                    bundle_id: None,
                    path: "/fixture".into(),
                },
                exited: Mutex::new(false),
                changed: Condvar::new(),
            }),
        );
        assert_eq!(
            launcher.quit_with(42, |_, _| Err(nix::errno::Errno::EPERM)),
            Err(Fault::Failed(nix::errno::Errno::EPERM.to_string()))
        );
    }

    #[test]
    fn cleanup_failure_is_reported_without_panicking() {
        const CASE: &str = "ONI_CLEANUP_FAILURE";
        if std::env::var_os(CASE).is_some() {
            cleanup(
                Err::<(), _>(std::io::Error::other("injected-cleanup-fault")),
                "fixture",
            );
            return;
        }
        let output = Command::new(std::env::current_exe().expect("test binary"))
            .args([
                "--exact",
                "app::linux::tests::cleanup_failure_is_reported_without_panicking",
                "--nocapture",
            ])
            .env(CASE, "1")
            .output()
            .expect("cleanup fixture");
        assert!(output.status.success());
        assert!(String::from_utf8(output.stderr)
            .expect("diagnostic")
            .contains("injected-cleanup-fault"));
    }

    #[test]
    fn bundle_id_refusal_round_trips_the_public_launch_result() {
        let screen = crate::screen::Screen::absent().launching(Box::new(Native::new(None)));
        let request =
            oni_protocol::decode(json!({"app":{"bundleId":"example.invalid"}, "activate":false}))
                .expect("request");
        let result = crate::app::launch(&screen, &request);
        assert_eq!(
            result,
            json!({"status":"refused","reason":"unsupported","blocker":"platform"})
        );
        oni_protocol::decode::<oni_protocol::AppLaunchResult>(result).expect("wire refusal");
    }

    #[test]
    fn natural_child_exit_is_reaped_without_another_launch() {
        let directory = tempfile::tempdir().expect("fixture");
        let fifo = directory.path().join("release");
        assert!(Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .expect("fifo")
            .success());
        let launcher = Native::new(None);
        let request = oni_protocol::decode(
            json!({"app":{"path":"/bin/sh","args":["-c","read line < \"$1\"","sh",fifo]},
            "activate":false}),
        )
        .expect("request");
        let resolved = launcher.resolve(&request).expect("resolve");
        let (send, receive) = std::sync::mpsc::channel();
        launcher.start(&request, &resolved, send).expect("start");
        let pid = receive
            .recv_timeout(Duration::from_secs(2))
            .expect("receipt")
            .expect("pid");
        let running = launcher
            .children
            .lock()
            .expect("children")
            .get(&pid)
            .expect("running")
            .clone();
        std::fs::write(&fifo, b"done\n").expect("release child");
        let (done, timeout) = running
            .changed
            .wait_timeout_while(
                running.exited.lock().expect("state"),
                Duration::from_secs(2),
                |done| !*done,
            )
            .expect("reaper completion");
        assert!(!timeout.timed_out() && *done);
        drop(done);
        assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
        let screen = crate::screen::Screen::absent().launching(Box::new(launcher));
        assert_eq!(
            crate::app::quit(&screen, pid),
            json!({"status":"ok","exited":true})
        );
        // A later launch retires the reaped entry and retains its new live child.
        let (send, receive) = std::sync::mpsc::channel();
        screen
            .launcher
            .start(&request, &resolved, send)
            .expect("next launch");
        let next = receive
            .recv_timeout(Duration::from_secs(2))
            .expect("next receipt")
            .expect("pid");
        assert_eq!(screen.launcher.quit(next), Ok(true));
        let (send, receive) = std::sync::mpsc::channel();
        drop(receive);
        assert_eq!(
            screen.launcher.start(&request, &resolved, send),
            Err(Fault::Failed("launch completion disconnected".into()))
        );
    }
}
