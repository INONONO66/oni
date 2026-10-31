pub fn available(name: &str) -> bool {
    // SAFETY: opening a named shared library retains no symbols and drops the handle immediately.
    unsafe { libloading::Library::new(name).is_ok() }
}
