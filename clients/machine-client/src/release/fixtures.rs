use std::{fs, path::Path, process::Command};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::Layout;

pub(super) fn fixture(directory: &Path, body: &str, extra: &str) -> Vec<u8> {
    let mut writer = Command::new("/bin/sh")
        .args([
            "-c",
            "mkdir -p pkg && cat > pkg/mclient && chmod 755 pkg/mclient && eval \"$1\" && tar -czf archive.tgz -C pkg .",
            "sh",
            extra,
        ])
        .current_dir(directory)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .expect("archive writer");
    std::io::Write::write_all(&mut writer.stdin.take().expect("stdin"), body.as_bytes())
        .expect("script body");
    assert!(writer.wait().expect("archive writer exit").success());
    fs::read(directory.join("archive.tgz")).expect("archive")
}

pub(super) fn staged(version: &str, probe: u8) -> String {
    format!(
        "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '{{\"version\":\"{version}\",\"contractVersion\":2}}'; exit 0; fi\nprintf '%s ' \"$@\" > \"$(dirname \"$0\")/probe.args\"\nexit {probe}\n"
    )
}

pub(super) fn release_for(archive: &[u8], version: &str, url: &str) -> Value {
    json!({
        "version": version,
        "contractVersion": 2,
        "artifacts": {"linux-x86_64": {
            "name": "mclient-linux-x86_64.tar.gz",
            "bytes": archive.len(),
            "sha256": hex::encode(Sha256::digest(archive)),
            "url": url,
        }},
    })
}

pub(super) fn layout(directory: &Path) -> Layout {
    Layout::new(directory.join(".oni"))
}
