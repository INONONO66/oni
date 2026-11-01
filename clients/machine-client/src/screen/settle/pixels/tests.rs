use std::{cell::Cell, time::Instant};

use super::*;

struct ClockAt(Cell<Instant>);

impl Clock for ClockAt {
    fn now(&self) -> Instant {
        self.0.get()
    }

    fn wait(&self, duration: Duration) {
        self.0.set(self.now() + duration);
    }
}

fn frame(changed: usize) -> Vec<u8> {
    let mut pixels = vec![0; 400 * 4];
    for pixel in pixels.as_chunks_mut::<4>().0.iter_mut().take(changed) {
        pixel[0] = 9;
    }
    pixels
}

#[test]
fn pixel_change_requires_more_than_half_percent_outside_tolerance() {
    assert!(!changed(&frame(0), &frame(2)));
    assert!(changed(&frame(0), &frame(3)));
    assert!(changed(&frame(0), &frame(0)[..4]));
    let mut within_tolerance = frame(0);
    within_tolerance[0] = 8;
    assert!(!changed(&frame(0), &within_tolerance));
}

#[test]
fn pixel_settle_waits_for_quiet_after_last_changed_frame() {
    let clock = ClockAt(Cell::new(Instant::now()));
    let started = clock.now();
    let result = run(
        &clock,
        Duration::from_millis(500),
        Duration::from_millis(1500),
        || {
            let ms = clock.now().duration_since(started).as_millis();
            Ok(if ms < 200 {
                frame(0)
            } else if ms < 400 {
                frame(3)
            } else {
                frame(6)
            })
        },
        || json!({"status":"settled","method":"pixels","captureId":"cap-1"}),
    );
    assert_eq!(result["captureId"], "cap-1");
    assert_eq!(
        clock.now().duration_since(started),
        Duration::from_millis(1000)
    );
}

#[test]
fn pixel_settle_accepts_identical_first_pair_and_reports_changes_at_deadline() {
    let clock = ClockAt(Cell::new(Instant::now()));
    let started = clock.now();
    assert_eq!(
        run(
            &clock,
            Duration::from_millis(500),
            Duration::from_millis(1000),
            || Ok(frame(0)),
            || json!({"status":"settled"}),
        )["status"],
        "settled"
    );
    assert_eq!(
        clock.now().duration_since(started),
        Duration::from_millis(200)
    );

    let clock = ClockAt(Cell::new(Instant::now()));
    let started = clock.now();
    let result = run(
        &clock,
        Duration::from_millis(500),
        Duration::from_millis(500),
        || {
            Ok(frame(
                (clock.now().duration_since(started).as_millis() / 200) as usize * 3,
            ))
        },
        || panic!("changing frames must not settle"),
    );
    assert_eq!(
        result,
        json!({"status":"pending","method":"pixels","changesInWindow":2})
    );
    assert_eq!(
        clock.now().duration_since(started),
        Duration::from_millis(500)
    );
}

#[test]
fn pixel_settle_reports_target_disappearance_and_other_sample_faults() {
    for (failure_at, error, expected) in [
        (
            0,
            json!({"status":"refused","reason":"window_not_found"}),
            "refused",
        ),
        (
            1,
            json!({"status":"refused","reason":"window_not_found"}),
            "destroyed",
        ),
        (
            1,
            json!({"status":"refused","reason":"permission_denied"}),
            "refused",
        ),
    ] {
        let clock = ClockAt(Cell::new(Instant::now()));
        let mut count = 0;
        let result = run(
            &clock,
            Duration::from_millis(500),
            Duration::from_millis(1000),
            || {
                let current = count;
                count += 1;
                if current == failure_at {
                    Err(error.clone())
                } else {
                    Ok(frame(0))
                }
            },
            || panic!("sample faults must not settle"),
        );
        assert_eq!(result["status"], expected);
    }
}
