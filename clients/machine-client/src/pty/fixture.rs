//! Executable fake-tmux scripts for the terminal tests.
//!
//! The script is written by a `/bin/sh` child, never by the test process:
//! a write descriptor the test process held would be inherited by every
//! child another test thread forks before its exec, and Linux refuses to
//! exec a file that any process holds open for writing (`ETXTBSY`).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    let mut writer = Command::new("/bin/sh")
        .args(["-c", "cat > \"$1\" && chmod 700 \"$1\"", "sh"])
        .arg(&path)
        .stdin(Stdio::piped())
        .spawn()
        .expect("script writer");
    writer
        .stdin
        .take()
        .expect("stdin configured as piped")
        .write_all(body.as_bytes())
        .expect("script body");
    assert!(writer.wait().expect("script writer exit").success());
    path
}
