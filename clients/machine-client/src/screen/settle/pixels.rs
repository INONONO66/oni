use std::time::Duration;

use serde_json::{json, Value};

use crate::app::Clock;

const CADENCE: Duration = Duration::from_millis(200);

/// A sample changes when more than one in 200 pixels differs in any RGB channel.
fn changed(previous: &[u8], next: &[u8]) -> bool {
    if previous.len() != next.len() {
        return true;
    }
    let samples = previous.len() / 4;
    previous
        .chunks_exact(4)
        .zip(next.chunks_exact(4))
        .filter(|(before, after)| {
            before[..3]
                .iter()
                .zip(&after[..3])
                .any(|(left, right)| left.abs_diff(*right) > 8)
        })
        .take(samples / 200 + 1)
        .count()
        > samples / 200
}

pub(super) fn run(
    clock: &impl Clock,
    quiet: Duration,
    timeout: Duration,
    mut sample: impl FnMut() -> Result<Vec<u8>, Value>,
    anchor: impl FnOnce() -> Value,
) -> Value {
    let started = clock.now();
    let end = started + timeout;
    let mut previous = match sample() {
        Ok(frame) => frame,
        Err(error) => return error,
    };
    let mut changes = 0;
    let mut last_change = None;
    let mut next_at = started + CADENCE;
    loop {
        let until = next_at.min(end);
        clock.wait(until.saturating_duration_since(clock.now()));
        let frame = match sample() {
            Ok(frame) => frame,
            Err(error) => return error,
        };
        let now = clock.now();
        if changed(&previous, &frame) {
            changes += 1;
            last_change = Some(now);
        } else if last_change.is_none_or(|at| now.saturating_duration_since(at) >= quiet) {
            return anchor();
        }
        previous = frame;
        if now >= end {
            return json!({"status":"pending","method":"pixels","changesInWindow":changes});
        }
        next_at = now + CADENCE;
    }
}

#[cfg(test)]
mod tests;
