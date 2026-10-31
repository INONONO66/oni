#[cfg(target_os = "macos")]
use std::process::Stdio;
#[cfg(target_os = "macos")]
use std::time::Duration;
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Command,
};

use crate::config::JoinOptions;
use crate::screen::probe::{Need, Verdict};

pub const NAME: &str = "oni-machine-client.service";

fn xml(value: &Path) -> io::Result<String> {
    Ok(value
        .to_str()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "non-UTF8 service path"))?
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;"))
}

pub fn plist(binary: &Path, config: &Path, logs: &Path) -> io::Result<String> {
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <plist version=\"1.0\"><dict>\n\
         <key>Label</key><string>ai.oni.machine</string>\n\
         <key>ProgramArguments</key><array><string>{}</string><string>run</string>\
         <string>--config</string><string>{}</string></array>\n\
         <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n\
         <key>StandardOutPath</key><string>{}</string>\n\
         <key>StandardErrorPath</key><string>{}</string>\n\
         </dict></plist>\n",
        xml(binary)?,
        xml(config)?,
        xml(&logs.join("machine-client.log"))?,
        xml(&logs.join("machine-client.log"))?
    ))
}

fn systemd(value: &Path) -> io::Result<String> {
    let value = value
        .to_str()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "non-UTF8 service path"))?;
    Ok(value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%")
        .replace('$', "$$"))
}

pub fn unit(binary: &Path, config: &Path, user: bool) -> io::Result<String> {
    Ok(format!(
        "[Unit]\nDescription=Oni machine client\nWants=network-online.target\n\
         After=network-online.target\n\n[Service]\nType=simple\nExecStart=\"{}\" run --config \"{}\"\n\
         Restart=on-failure\nRestartSec=5s\n\n[Install]\nWantedBy={}\n",
        systemd(binary)?,
        systemd(config)?,
        if user {
            "default.target"
        } else {
            "multi-user.target"
        }
    ))
}

pub struct State {
    pub name: &'static str,
    pub state: &'static str,
}

fn command(program: &str, args: &[&str]) -> io::Result<()> {
    let result = Command::new(program).args(args).status()?;
    if result.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!("{program} {:?}: {result}", args)))
    }
}

fn put(path: &Path, contents: &str) -> io::Result<bool> {
    if fs::read_to_string(path).ok().as_deref() != Some(contents) {
        fs::write(path, contents)?;
        return Ok(true);
    }
    Ok(false)
}

pub fn unit_directory(home: &Path, root: bool, xdg_config_home: Option<&Path>) -> PathBuf {
    if root {
        PathBuf::from("/etc/systemd/system")
    } else {
        xdg_config_home
            .filter(|directory| directory.is_absolute())
            .map_or_else(|| home.join(".config"), Path::to_path_buf)
            .join("systemd/user")
    }
}

/// Add only setup work the installed service can actually use.
pub fn setup_needs(
    verdict: &mut Verdict,
    home: &Path,
    service_dir: Option<&Path>,
    no_service: bool,
) {
    if no_service {
        return;
    }
    #[cfg(target_os = "macos")]
    let installed = service_dir
        .map_or_else(|| home.join("Library/LaunchAgents"), Path::to_path_buf)
        .join("ai.oni.machine.plist")
        .exists();
    #[cfg(target_os = "linux")]
    let installed = {
        let root = nix::unistd::getuid().as_raw() == 0;
        let xdg = std::env::var_os("XDG_CONFIG_HOME");
        service_dir
            .map_or_else(
                || unit_directory(home, root, xdg.as_deref().map(Path::new)),
                Path::to_path_buf,
            )
            .join(NAME)
            .exists()
    };
    if !installed {
        if verdict.verdict == "available" {
            verdict.verdict = "partial";
        }
        verdict.add_need(Need {
            step: "service_install",
            action: "Run mclient join <host> to install and start the machine service.",
            on_screen: false,
            blocker: None,
        });
    }
    #[cfg(target_os = "linux")]
    if nix::unistd::getuid().as_raw() != 0 && installed {
        if let Ok(Some(user)) = nix::unistd::User::from_uid(nix::unistd::getuid()) {
            if !Path::new("/var/lib/systemd/linger")
                .join(&user.name)
                .exists()
            {
                if verdict.verdict == "available" {
                    verdict.verdict = "partial";
                }
                verdict.add_need(Need {
                    step: "linger_enable",
                    action: "Run sudo loginctl enable-linger \"$(id -un)\".",
                    on_screen: false,
                    blocker: None,
                });
            }
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let _ = (verdict, home, service_dir);
}

pub fn install(
    options: &JoinOptions,
    home: &Path,
    config: &Path,
    binary: &Path,
) -> io::Result<State> {
    if options.no_service {
        return Ok(State {
            name: "none",
            state: "skipped",
        });
    }
    #[cfg(target_os = "macos")]
    {
        let directory = options
            .service_dir
            .clone()
            .unwrap_or_else(|| home.join("Library/LaunchAgents"));
        let logs = home.join(".oni/logs");
        let contents = plist(binary, config, &logs)?;
        fs::create_dir_all(&directory)?;
        let path = directory.join("ai.oni.machine.plist");
        let changed = put(&path, &contents)?;
        fs::create_dir_all(&logs)?;
        let domain = format!("gui/{}", nix::unistd::getuid());
        let target = format!("{domain}/ai.oni.machine");
        let path = path
            .to_str()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "non-UTF8 service path"))?;
        let loaded = Command::new("launchctl")
            .args(["print", &target])
            .stderr(Stdio::null())
            .status()?
            .success();
        if loaded && !changed {
            command("launchctl", &["kickstart", "-k", &target])?;
        } else {
            if loaded {
                let args = ["bootout", &domain, path];
                let status = Command::new("launchctl")
                    .args(args)
                    .stderr(Stdio::null())
                    .status()?;
                if !status.success() {
                    return Err(io::Error::other(format!("launchctl {args:?}: {status}")));
                }
                let mut removed = false;
                for _ in 0..20 {
                    if !Command::new("launchctl")
                        .args(["print", &target])
                        .stderr(Stdio::null())
                        .status()?
                        .success()
                    {
                        removed = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                if !removed {
                    return Err(io::Error::other("launchctl bootout: job still loaded"));
                }
            }
            command("launchctl", &["bootstrap", &domain, path])?;
        }
        Ok(State {
            name: "ai.oni.machine",
            state: "started",
        })
    }
    #[cfg(target_os = "linux")]
    {
        let root = nix::unistd::getuid().as_raw() == 0;
        let xdg_config_home = std::env::var_os("XDG_CONFIG_HOME");
        let directory = options.service_dir.clone().unwrap_or_else(|| {
            unit_directory(home, root, xdg_config_home.as_deref().map(Path::new))
        });
        let contents = unit(binary, config, !root)?;
        fs::create_dir_all(&directory)?;
        let path = directory.join(NAME);
        let existed = path.exists();
        let changed = put(&path, &contents)?;
        let prefix: &[&str] = if root { &[] } else { &["--user"] };
        if changed {
            command("systemctl", &[prefix, &["daemon-reload"]].concat())?;
            command("systemctl", &[prefix, &["enable", "--now", NAME]].concat())?;
        }
        if existed {
            command("systemctl", &[prefix, &["restart", NAME]].concat())?;
        }
        Ok(State {
            name: NAME,
            state: "started",
        })
    }
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
pub fn request_screen() {
    // SAFETY: both CoreGraphics functions accept no arguments. The request
    // runs in the launched client so its responsible process owns the grant.
    if !unsafe { CGPreflightScreenCaptureAccess() } {
        // SAFETY: this function accepts no arguments and returns the TCC decision.
        let _ = unsafe { CGRequestScreenCaptureAccess() };
    }
}

#[cfg(target_os = "macos")]
pub fn screen_granted() -> bool {
    // SAFETY: this argument-free CoreGraphics preflight has no preconditions.
    unsafe { CGPreflightScreenCaptureAccess() }
}

#[cfg(target_os = "macos")]
pub fn screen(no_open: bool, binary: &Path) -> io::Result<String> {
    if !no_open {
        let _ = Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .status();
    }
    Ok(format!("screen recording: the service requests it on first start — allow the macOS prompt, or add {} under System Settings > Privacy & Security > Screen Recording; the service restarts itself once the grant lands", binary.to_str().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "non-UTF8 service path"))?))
}

#[cfg(not(target_os = "macos"))]
pub fn screen(_no_open: bool, _binary: &Path) -> io::Result<String> {
    Ok("screen recording: unsupported".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    static LINGER_TEST: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn setup_skips_service_needs_when_service_is_disabled() {
        let home = tempfile::tempdir().expect("home");
        let mut screen = crate::screen::probe::fold(
            crate::screen::probe::Display {
                kind: "virtual",
                id: None,
                isolated: true,
            },
            crate::screen::probe::Grants {
                capture: true,
                accessibility: true,
                input: true,
            },
            vec![],
        );
        setup_needs(&mut screen, home.path(), Some(home.path()), true);
        assert_eq!(screen.verdict, "available");
        assert!(screen.needs.is_empty());
    }

    #[test]
    fn setup_only_requests_install_for_an_absent_service() {
        let directory = tempfile::tempdir().expect("service directory");
        let mut verdict = crate::screen::probe::fold(
            crate::screen::probe::Display {
                kind: "virtual",
                id: None,
                isolated: true,
            },
            crate::screen::probe::Grants {
                capture: true,
                accessibility: true,
                input: true,
            },
            vec![],
        );
        setup_needs(
            &mut verdict,
            directory.path(),
            Some(directory.path()),
            false,
        );
        assert_eq!(verdict.verdict, "partial");
        assert_eq!(verdict.needs.len(), 1);
        assert_eq!(verdict.needs[0].step, "service_install");
        assert!(!verdict.needs[0].on_screen);
    }

    #[test]
    fn service_documents_include_binary_config_and_restart_policy() {
        let binary = Path::new("/opt/oni /mclient%$");
        let config = Path::new("/home/a/.oni/client \"one\".json");
        let logs = Path::new("/home/a/.oni/logs");
        let launch = plist(binary, config, logs).expect("valid paths");
        assert!(launch.contains("<key>KeepAlive</key><true/>"));
        assert!(launch.contains("<string>/opt/oni /mclient%$</string>"));
        assert!(launch.contains("<string>/home/a/.oni/logs/machine-client.log</string>"));
        let system = unit(binary, config, false).expect("valid paths");
        assert!(system.contains(
            "ExecStart=\"/opt/oni /mclient%%$$\" run --config \"/home/a/.oni/client \\\"one\\\".json\""
        ));
        assert!(system.contains("WantedBy=multi-user.target"));
        assert!(unit(binary, config, true)
            .expect("user unit")
            .contains("WantedBy=default.target"));
        assert_eq!(
            unit_directory(Path::new("/home/a"), true, Some(Path::new("/xdg"))),
            Path::new("/etc/systemd/system")
        );
        assert_eq!(
            unit_directory(Path::new("/home/a"), false, None),
            Path::new("/home/a/.config/systemd/user")
        );
        assert_eq!(
            unit_directory(Path::new("/home/a"), false, Some(Path::new("/xdg"))),
            Path::new("/xdg/systemd/user")
        );
        assert_eq!(
            unit_directory(Path::new("/home/a"), false, Some(Path::new("relative"))),
            Path::new("/home/a/.config/systemd/user")
        );
        #[cfg(target_os = "linux")]
        assert_eq!(
            screen(true, binary).expect("screen state"),
            "screen recording: unsupported"
        );
    }

    #[test]
    fn service_documents_reject_non_utf8_paths() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;
        let invalid = PathBuf::from(OsString::from_vec(vec![b'/', 0xff]));
        assert_eq!(
            unit(&invalid, Path::new("/config"), false)
                .expect_err("invalid binary")
                .kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            plist(&invalid, Path::new("/config"), Path::new("/logs"))
                .expect_err("invalid binary")
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn non_root_service_reports_missing_linger_and_uses_user_unit_directory() {
        use std::os::unix::{fs::PermissionsExt, process::CommandExt};

        const CASE: &str = "ONI_NON_ROOT_SERVICE_FIXTURE";
        if let Some(home) = std::env::var_os(CASE) {
            let home = PathBuf::from(home);
            let directory = unit_directory(&home, false, None);
            if !directory.exists() {
                fs::create_dir_all(&directory).expect("unit directory");
                fs::set_permissions(&directory, fs::Permissions::from_mode(0o777))
                    .expect("fixture directory shared by test users");
            }
            if !directory.join(NAME).exists() {
                fs::write(directory.join(NAME), "existing service").expect("installed unit");
            }
            let mut verdict = crate::screen::probe::fold(
                crate::screen::probe::Display {
                    kind: "virtual",
                    id: None,
                    isolated: true,
                },
                crate::screen::probe::Grants {
                    capture: true,
                    accessibility: true,
                    input: true,
                },
                vec![],
            );
            setup_needs(&mut verdict, &home, None, false);
            let needs_linger = nix::unistd::User::from_uid(nix::unistd::getuid())
                .expect("user lookup")
                .is_some_and(|user| {
                    !Path::new("/var/lib/systemd/linger")
                        .join(user.name)
                        .exists()
                });
            assert_eq!(
                verdict
                    .needs
                    .iter()
                    .any(|need| need.step == "linger_enable"),
                needs_linger
            );
            assert_eq!(
                verdict.verdict,
                if needs_linger { "partial" } else { "available" }
            );
            if needs_linger {
                setup_needs(&mut verdict, &home, None, false);
                assert_eq!(verdict.verdict, "partial");
            }
            let options = JoinOptions {
                host: "localhost".into(),
                json: false,
                name: None,
                tags: vec![],
                exports: vec![],
                no_service: false,
                service_dir: None,
                no_open: true,
                host_cert: None,
                host_pin: None,
                trust_on_first_use: false,
                unix: None,
                memory_budget_mb: 96,
            };
            if needs_linger {
                let state = install(
                    &options,
                    &home,
                    &home.join("client.json"),
                    Path::new("/opt/oni/mclient"),
                )
                .expect("user service installed");
                assert_eq!(state.name, NAME);
                assert!(fs::read_to_string(directory.join(NAME))
                    .expect("unit")
                    .contains("WantedBy=default.target"));
            }
            return;
        }
        let _serial = LINGER_TEST.lock().expect("linger fixture");
        let home = tempfile::tempdir().expect("isolated home");
        fs::set_permissions(home.path(), fs::Permissions::from_mode(0o777))
            .expect("child can create unit");
        let manager = home.path().join("systemctl");
        fs::write(&manager, "#!/bin/sh\nexit 0\n").expect("fake service manager");
        fs::set_permissions(&manager, fs::Permissions::from_mode(0o755))
            .expect("executable manager");
        for uid in if nix::unistd::getuid().as_raw() == 0 {
            vec![65534, 60000]
        } else {
            vec![nix::unistd::getuid().as_raw()]
        } {
            let mut child = Command::new(std::env::current_exe().expect("test binary"));
            child
                .args([
                    "--exact",
                    "service::tests::non_root_service_reports_missing_linger_and_uses_user_unit_directory",
                ])
                .env(CASE, home.path())
                .env("PATH", home.path())
                .env_remove("XDG_CONFIG_HOME");
            if nix::unistd::getuid().as_raw() == 0 {
                child.uid(uid);
            }
            let output = child.output().expect("non-root service test");
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert_eq!(output.status.code(), Some(0), "{stdout}\n{stderr}");
        }
        if nix::unistd::getuid().as_raw() == 0
            && std::env::var_os("ONI_NON_ROOT_SERVICE_PARENT").is_none()
        {
            let output = Command::new(std::env::current_exe().expect("test binary"))
                .args([
                    "--exact",
                    "service::tests::non_root_service_reports_missing_linger_and_uses_user_unit_directory",
                ])
                .env("ONI_NON_ROOT_SERVICE_PARENT", "1")
                .uid(65534)
                .output()
                .expect("unprivileged parent test");
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert_eq!(output.status.code(), Some(0), "{stdout}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn installed_linger_does_not_request_service_setup() {
        use std::os::unix::fs::PermissionsExt;

        let _serial = LINGER_TEST.lock().expect("linger fixture");
        let marker = Path::new("/var/lib/systemd/linger/nobody");
        assert!(
            !marker.exists(),
            "fixture must not replace an existing linger grant"
        );
        let home = tempfile::tempdir().expect("isolated home");
        fs::set_permissions(home.path(), fs::Permissions::from_mode(0o777))
            .expect("nobody can access fixture");
        let directory = marker.parent().expect("linger directory");
        assert!(Command::new("sudo")
            .args([
                "-n",
                "install",
                "-d",
                directory.to_str().expect("directory")
            ])
            .status()
            .expect("prepare linger directory")
            .success());
        assert!(Command::new("sudo")
            .args(["-n", "touch", marker.to_str().expect("marker")])
            .status()
            .expect("enable fixture linger")
            .success());
        let case = format!("ONI_NON_ROOT_SERVICE_FIXTURE={}", home.path().display());
        let profile_file = home.path().join("linger.profraw");
        let profile = format!("LLVM_PROFILE_FILE={}", profile_file.display());
        let binary = home.path().join("service-test");
        fs::copy(std::env::current_exe().expect("test binary"), &binary)
            .expect("copy test binary into accessible fixture");
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755))
            .expect("unprivileged user can execute fixture");
        let output = Command::new("sudo")
            .args(["-n", "-u", "nobody", "env", &case, &profile])
            .arg(binary)
            .args([
                "--exact",
                "service::tests::non_root_service_reports_missing_linger_and_uses_user_unit_directory",
            ])
            .output()
            .expect("unprivileged service probe");
        let cleanup = Command::new("sudo")
            .args(["-n", "rm", marker.to_str().expect("marker")])
            .status()
            .expect("remove fixture linger");
        assert!(cleanup.success());
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(0), "{stdout}\n{stderr}");
        if profile_file.exists() {
            let inherited =
                PathBuf::from(std::env::var_os("LLVM_PROFILE_FILE").unwrap_or_default());
            let directory = inherited.parent().unwrap_or(Path::new("."));
            fs::copy(&profile_file, directory.join("linger-nobody.profraw"))
                .expect("include unprivileged coverage");
        }
        assert!(!marker.exists());
    }
}
