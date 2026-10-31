use std::{
    future::Future,
    time::{Duration, Instant},
};

/// Own the operation until completion or cancellation, including connect/auth.
/// A scoped thread also permits synchronous startup inside the client's executor.
pub fn run<T: Send>(operation: impl Future<Output = T> + Send) -> Option<T> {
    let deadline = Instant::now() + Duration::from_millis(500);
    std::thread::scope(|scope| {
        scope
            .spawn(move || {
                let executor = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .ok()?;
                executor.block_on(async {
                    tokio::time::timeout_at(deadline.into(), operation)
                        .await
                        .ok()
                })
            })
            .join()
            .ok()
            .flatten()
    })
}
