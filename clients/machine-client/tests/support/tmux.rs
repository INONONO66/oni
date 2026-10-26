/// Stop a test's private tmux server; a server that never started (or whose
/// socket is already gone) counts as stopped.
pub async fn kill_server(socket: &str) {
    let output = tokio::process::Command::new("tmux")
        .args(["-L", socket, "kill-server"])
        .env("TERM", "xterm")
        .output()
        .await
        .expect("tmux cleanup");
    assert!(
        output.status.success() || {
            let stderr = String::from_utf8_lossy(&output.stderr);
            stderr.contains("no server running") || stderr.contains("error connecting")
        },
        "tmux cleanup: {output:?}"
    );
}
