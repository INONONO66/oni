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
pub fn screen(no_open: bool, binary: &Path) -> io::Result<String> {
    if !no_open {
        let _ = Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .status();
    }
    Ok(format!("screen recording: the service requests it on first start — allow the macOS prompt, or add {} under System Settings > Privacy & Security > Screen Recording, then run: launchctl kickstart -k gui/{}/ai.oni.machine", binary.to_str().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "non-UTF8 service path"))?, nix::unistd::getuid()))
}

#[cfg(not(target_os = "macos"))]
pub fn screen(_no_open: bool, _binary: &Path) -> io::Result<String> {
    Ok("screen recording: unsupported".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
