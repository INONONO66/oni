pub fn accept(name: &str) -> bool {
    let base = std::env::var("XDG_RUNTIME_DIR").unwrap_or_default();
    let path = std::path::Path::new(&base).join(name);
    super::deadline::run(async { tokio::net::UnixStream::connect(path).await.is_ok() })
        .unwrap_or(false)
}
