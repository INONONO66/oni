#[cfg(target_os = "linux")]
use std::path::PathBuf;
use std::{fs, io, path::Path, process::Command};

use crate::config::JoinOptions;

pub const NAME: &str = "oni-machine-client.service";

fn xml(value: &Path) -> String {
    value
        .to_string_lossy()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub fn plist(binary: &Path, config: &Path, logs: &Path) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <plist version=\"1.0\"><dict>\n\
         <key>Label</key><string>ai.oni.machine</string>\n\
         <key>ProgramArguments</key><array><string>{}</string><string>run</string>\
         <string>--config</string><string>{}</string></array>\n\
         <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n\
         <key>StandardOutPath</key><string>{}</string>\n\
         <key>StandardErrorPath</key><string>{}</string>\n\
         </dict></plist>\n",
        xml(binary),
        xml(config),
        xml(&logs.join("machine-client.log")),
        xml(&logs.join("machine-client.log"))
    )
}

pub fn unit(binary: &Path, config: &Path, user: bool) -> String {
    format!(
        "[Unit]\nDescription=Oni machine client\nWants=network-online.target\n\
         After=network-online.target\n\n[Service]\nType=simple\nExecStart={} run --config {}\n\
         Restart=on-failure\nRestartSec=5s\n\n[Install]\nWantedBy={}\n",
        binary.display(),
        config.display(),
        if user {
            "default.target"
        } else {
            "multi-user.target"
        }
    )
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

fn put(path: &Path, contents: &str) -> io::Result<()> {
    if fs::read_to_string(path).ok().as_deref() != Some(contents) {
        fs::write(path, contents)?;
    }
    Ok(())
}

pub fn install(options: &JoinOptions, home: &Path, config: &Path) -> io::Result<State> {
    if options.no_service {
        return Ok(State {
            name: "none",
            state: "skipped",
        });
    }
    let binary = std::env::current_exe()?;
    let dry_run = options.service_dir.is_some();
    #[cfg(target_os = "macos")]
    {
        let directory = options
            .service_dir
            .clone()
            .unwrap_or_else(|| home.join("Library/LaunchAgents"));
        fs::create_dir_all(&directory)?;
        let logs = home.join(".oni/logs");
        fs::create_dir_all(&logs)?;
        let path = directory.join("ai.oni.machine.plist");
        put(&path, &plist(&binary, config, &logs))?;
        if !dry_run {
            let domain = format!("gui/{}", nix::unistd::getuid());
            let target = format!("{domain}/ai.oni.machine");
            // An absent job is normal on the first install.
            let path = path
                .to_str()
                .ok_or_else(|| io::Error::other("non-UTF8 service path"))?;
            let _ = Command::new("launchctl")
                .args(["bootout", &domain, path])
                .status();
            command("launchctl", &["bootstrap", &domain, path])?;
            command("launchctl", &["kickstart", "-k", &target])?;
        }
        Ok(State {
            name: "ai.oni.machine",
            state: if dry_run {
                "written (dry run)"
            } else {
                "running"
            },
        })
    }
    #[cfg(target_os = "linux")]
    {
        let user = nix::unistd::getuid().as_raw() != 0;
        let directory = options.service_dir.clone().unwrap_or_else(|| {
            if user {
                home.join(".config/systemd/user")
            } else {
                PathBuf::from("/etc/systemd/system")
            }
        });
        fs::create_dir_all(&directory)?;
        let path = directory.join(NAME);
        let existed = path.exists();
        put(&path, &unit(&binary, config, user))?;
        if !dry_run {
            let prefix: &[&str] = if user { &["--user"] } else { &[] };
            command("systemctl", &[prefix, &["daemon-reload"]].concat())?;
            command("systemctl", &[prefix, &["enable", "--now", NAME]].concat())?;
            if existed {
                command("systemctl", &[prefix, &["restart", NAME]].concat())?;
            }
        }
        Ok(State {
            name: NAME,
            state: if dry_run {
                "written (dry run)"
            } else {
                "running"
            },
        })
    }
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
pub fn screen(no_open: bool, dry_run: bool) -> String {
    if dry_run {
        return "screen recording: skipped (dry run)".to_owned();
    }
    // SAFETY: CoreGraphics accepts no arguments and returns a boolean permission result.
    if unsafe { CGRequestScreenCaptureAccess() } {
        "screen recording: granted".to_owned()
    } else {
        if !no_open {
            let _ = Command::new("open")
                .arg(
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
                )
                .status();
        }
        format!("screen recording: denied — enable it in System Settings > Privacy & Security > Screen Recording, then run: launchctl kickstart -k gui/{}/ai.oni.machine", nix::unistd::getuid())
    }
}

#[cfg(not(target_os = "macos"))]
pub fn screen(_no_open: bool, _dry_run: bool) -> String {
    "screen recording: unsupported".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_documents_include_binary_config_and_restart_policy() {
        let binary = Path::new("/opt/oni/mclient");
        let config = Path::new("/home/a/.oni/machine-client/client.json");
        let logs = Path::new("/home/a/.oni/logs");
        let launch = plist(binary, config, logs);
        assert!(launch.contains("<key>KeepAlive</key><true/>"));
        assert!(launch.contains("<string>/opt/oni/mclient</string>"));
        assert!(launch.contains("<string>/home/a/.oni/logs/machine-client.log</string>"));
        let system = unit(binary, config, false);
        assert!(system.contains(
            "ExecStart=/opt/oni/mclient run --config /home/a/.oni/machine-client/client.json"
        ));
        assert!(system.contains("WantedBy=multi-user.target"));
        assert!(unit(binary, config, true).contains("WantedBy=default.target"));
    }
}
