use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use tempfile::TempDir;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

pub struct BlockedShell {
    pub root: TempDir,
    pub command: String,
    started: Mutex<JoinHandle<[u8; 1]>>,
    unblock: File,
    _release: File,
}

fn fifo(path: &Path) -> File {
    assert!(std::process::Command::new("/usr/bin/mkfifo")
        .arg(path)
        .status()
        .expect("create FIFO")
        .success());
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .expect("open FIFO without blocking")
}

impl BlockedShell {
    pub fn new(close_output: bool) -> Self {
        let root = tempfile::tempdir().expect("export");
        let unblock = fifo(&root.path().join("started"));
        let mut reader = unblock.try_clone().expect("startup reader");
        let started = Mutex::new(tokio::task::spawn_blocking(move || {
            let mut marker = [0];
            reader.read_exact(&mut marker).expect("startup byte");
            marker
        }));
        let release = fifo(&root.path().join("release"));
        let command = format!(
            "{}printf x > '{}'; IFS= read -r line < '{}'",
            if close_output { "exec 1>&- 2>&-; " } else { "" },
            root.path().join("started").display(),
            root.path().join("release").display()
        );
        Self {
            root,
            command,
            started,
            unblock,
            _release: release,
        }
    }

    pub async fn started(&self) {
        let marker = (&mut *self.started.lock().await)
            .await
            .expect("startup observer");
        assert_eq!(marker, *b"x");
    }

    pub fn release(&self) {
        (&self._release)
            .write_all(b"\n")
            .expect("release blocked shell");
    }
}

impl Drop for BlockedShell {
    fn drop(&mut self) {
        // Release the observer even when an assertion cancels the execution.
        self.unblock
            .write_all(b"x")
            .expect("release startup observer");
        self.release();
    }
}
