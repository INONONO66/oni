use std::ffi::OsString;

const ALLOWED: [&str; 9] = [
    "HOME",
    "PATH",
    "LANG",
    "DISPLAY",
    "XAUTHORITY",
    "WAYLAND_DISPLAY",
    "XDG_SESSION_TYPE",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
];

pub fn inherited(get: impl Fn(&str) -> Option<OsString>) -> Vec<(String, OsString)> {
    ALLOWED
        .iter()
        .map(|name| (name.to_string(), get(name).unwrap_or_default()))
        .collect()
}

/// Apply the selected binding last, after caller overrides, so a virtual launch
/// cannot reconnect to the person's compositor or session bus.
pub fn bind(
    command: &mut std::process::Command,
    display: Option<&str>,
    authority: Option<&str>,
    isolated: bool,
) {
    if let Some(display) = display {
        command.env("DISPLAY", display);
        command.env("XAUTHORITY", authority.unwrap_or(""));
    }
    if isolated {
        for name in [
            "WAYLAND_DISPLAY",
            "XDG_SESSION_TYPE",
            "DBUS_SESSION_BUS_ADDRESS",
            "XDG_RUNTIME_DIR",
        ] {
            command.env(name, "");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allows_only_session_variables_and_empties_absent_values() {
        let rows = inherited(|name| (name == "DISPLAY").then(|| OsString::from(":42")));
        assert_eq!(rows.len(), 9);
        assert_eq!(
            rows.iter()
                .find(|(name, _)| name == "DISPLAY")
                .map(|(_, value)| value.as_os_str()),
            Some(std::ffi::OsStr::new(":42"))
        );
        assert_eq!(
            rows.iter()
                .find(|(name, _)| name == "XAUTHORITY")
                .map(|(_, value)| value.as_os_str()),
            Some(std::ffi::OsStr::new(""))
        );
        assert!(!rows.iter().any(|(name, _)| name == "AWS_SECRET_ACCESS_KEY"));
    }

    #[test]
    fn isolated_binding_overrides_human_and_requested_session() {
        let mut command = std::process::Command::new("/bin/sh");
        command
            .env_clear()
            .envs(inherited(|_| Some(OsString::from("human-session"))));
        for name in ALLOWED.iter().skip(3) {
            command.env(name, "requested-human-session");
        }
        bind(&mut command, Some(":42"), Some("/virtual/auth"), true);
        command.args(["-c", "printf '%s|%s|%s|%s|%s|%s' \"$DISPLAY\" \"$XAUTHORITY\" \"$WAYLAND_DISPLAY\" \"$XDG_SESSION_TYPE\" \"$DBUS_SESSION_BUS_ADDRESS\" \"$XDG_RUNTIME_DIR\""]);
        let output = command.output().expect("isolated launch");
        assert!(output.status.success());
        assert_eq!(output.stdout, b":42|/virtual/auth||||");
    }
}
