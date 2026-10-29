use std::time::Duration;

use super::classes::FailureClass;

const INITIAL: Duration = Duration::from_secs(2);
const MAXIMUM: Duration = Duration::from_secs(300);
const WAKE_WINDOW: Duration = Duration::from_secs(30);
const RESET_AFTER: Duration = Duration::from_secs(30);
const REPROBE: Duration = Duration::from_secs(300);

pub trait Random {
    fn upper_half(&mut self, ceiling_ms: u64) -> u64;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Event {
    Failed(FailureClass),
    Connected,
    Disconnected,
    Wake,
    Suspend,
    NetworkChanged,
    Retry,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Next {
    Attempt,
    Wait(Duration),
    Suspended,
}

#[derive(Debug, Default)]
pub struct Retry {
    ceiling: Duration,
    wake_until: Option<Duration>,
    connected_at: Option<Duration>,
    deadline: Option<Duration>,
    suspended: bool,
    pub attempts: u64,
    pub last_failure: Option<FailureClass>,
}

impl Retry {
    pub fn event(&mut self, at: Duration, event: Event, random: &mut impl Random) -> Next {
        match event {
            Event::Suspend => {
                self.suspended = true;
                self.wake_until = None;
                self.deadline = None;
            }
            Event::Wake => {
                self.suspended = false;
                self.wake_until = Some(at.saturating_add(WAKE_WINDOW));
                self.deadline = Some(at);
            }
            Event::NetworkChanged if self.suspended => {}
            Event::NetworkChanged | Event::Retry => {
                self.suspended = false;
                self.deadline = Some(at);
                if matches!(event, Event::Retry) {
                    self.ceiling = Duration::ZERO;
                    self.last_failure = None;
                }
            }
            Event::Connected => {
                self.connected_at = Some(at);
                self.last_failure = None;
                self.deadline = None;
            }
            Event::Disconnected => {
                if self
                    .connected_at
                    .take()
                    .is_some_and(|since| at.saturating_sub(since) >= RESET_AFTER)
                {
                    self.ceiling = Duration::ZERO;
                    self.attempts = 0;
                }
                self.deadline = Some(at);
            }
            Event::Failed(class) => {
                self.connected_at = None;
                if class != FailureClass::Superseded {
                    self.attempts = self.attempts.saturating_add(1);
                    self.last_failure = Some(class);
                }
                let delay =
                    if class.retries() {
                        if self.wake_until.is_some_and(|until| at < until) {
                            INITIAL
                        } else {
                            self.ceiling = if self.ceiling.is_zero() {
                                INITIAL
                            } else {
                                self.ceiling.saturating_mul(2).min(MAXIMUM)
                            };
                            Duration::from_millis(random.upper_half(
                                self.ceiling.as_millis().try_into().unwrap_or(u64::MAX),
                            ))
                        }
                    } else {
                        REPROBE
                    };
                self.deadline = Some(at.saturating_add(delay));
            }
        }
        self.next(at)
    }

    pub fn next(&self, at: Duration) -> Next {
        if self.suspended {
            return Next::Suspended;
        }
        match self.deadline {
            Some(deadline) if deadline <= at => Next::Attempt,
            Some(deadline) => Next::Wait(deadline - at),
            None => Next::Suspended,
        }
    }
}

pub fn drift(
    previous_wall: Duration,
    previous_monotonic: Duration,
    wall: Duration,
    monotonic: Duration,
) -> Option<Event> {
    let wall_elapsed = wall.saturating_sub(previous_wall);
    let monotonic_elapsed = monotonic.saturating_sub(previous_monotonic);
    if wall_elapsed > monotonic_elapsed.saturating_add(Duration::from_secs(5)) {
        Some(Event::Wake)
    } else if monotonic_elapsed > wall_elapsed.saturating_add(Duration::from_secs(5)) {
        Some(Event::Suspend)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Seeded(u64);
    impl Random for Seeded {
        fn upper_half(&mut self, ceiling: u64) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            ceiling / 2 + (self.0 % (ceiling - ceiling / 2 + 1))
        }
    }

    #[test]
    fn exponential_window_is_seeded_bounded_and_resets_after_connected() {
        let mut retry = Retry::default();
        let mut random = Seeded(4);
        let mut at = Duration::ZERO;
        let mut ceilings = vec![];
        for _ in 0..10 {
            let next = retry.event(
                at,
                Event::Failed(FailureClass::HostUnreachable),
                &mut random,
            );
            ceilings.push(retry.ceiling);
            assert!(
                matches!(next, Next::Wait(delay) if delay >= retry.ceiling / 2 && delay <= retry.ceiling),
                "{next:?}"
            );
            at += retry.ceiling;
            assert_eq!(retry.next(at), Next::Attempt);
        }
        assert_eq!(ceilings[0], INITIAL);
        assert_eq!(ceilings[9], MAXIMUM);
        retry.event(at, Event::Connected, &mut random);
        retry.event(at + RESET_AFTER, Event::Disconnected, &mut random);
        assert_eq!(retry.attempts, 0);
        retry.event(
            at + RESET_AFTER,
            Event::Failed(FailureClass::Timeout),
            &mut random,
        );
        assert_eq!(retry.ceiling, INITIAL);
    }

    #[test]
    fn wake_window_is_flat_then_exponential_and_suspend_cancels_timers() {
        let mut retry = Retry::default();
        let mut random = Seeded(9);
        assert_eq!(
            retry.event(Duration::ZERO, Event::Wake, &mut random),
            Next::Attempt
        );
        assert_eq!(
            retry.event(
                Duration::ZERO,
                Event::Failed(FailureClass::Timeout),
                &mut random
            ),
            Next::Wait(INITIAL)
        );
        assert_eq!(
            retry.event(
                Duration::from_secs(29),
                Event::Failed(FailureClass::Timeout),
                &mut random
            ),
            Next::Wait(INITIAL)
        );
        assert_eq!(
            retry.event(Duration::from_secs(30), Event::Suspend, &mut random),
            Next::Suspended
        );
        assert_eq!(retry.next(Duration::from_secs(500)), Next::Suspended);
        assert_eq!(
            retry.event(Duration::from_secs(501), Event::NetworkChanged, &mut random),
            Next::Suspended
        );
        assert_eq!(
            retry.event(Duration::from_secs(501), Event::Wake, &mut random),
            Next::Attempt
        );
        let next = retry.event(
            Duration::from_secs(532),
            Event::Failed(FailureClass::Timeout),
            &mut random,
        );
        assert!(
            matches!(next, Next::Wait(delay) if delay >= INITIAL / 2 && delay <= INITIAL),
            "{next:?}"
        );
    }

    #[test]
    fn explicit_retry_and_network_change_attempt_immediately() {
        let mut retry = Retry::default();
        let mut random = Seeded(2);
        retry.event(
            Duration::ZERO,
            Event::Failed(FailureClass::Authentication),
            &mut random,
        );
        assert_eq!(
            retry.next(Duration::from_secs(3)),
            Next::Wait(Duration::from_secs(297))
        );
        assert_eq!(
            retry.event(Duration::from_secs(3), Event::NetworkChanged, &mut random),
            Next::Attempt
        );
        retry.event(
            Duration::from_secs(3),
            Event::Failed(FailureClass::Configuration),
            &mut random,
        );
        assert_eq!(
            retry.event(Duration::from_secs(4), Event::Retry, &mut random),
            Next::Attempt
        );
        assert_eq!(retry.last_failure, None);
    }

    #[test]
    fn superseded_is_neutral_and_drift_is_directional() {
        let mut retry = Retry::default();
        let mut random = Seeded(0);
        assert_eq!(
            retry.event(
                Duration::ZERO,
                Event::Failed(FailureClass::Superseded),
                &mut random
            ),
            Next::Wait(REPROBE)
        );
        assert_eq!(retry.attempts, 0);
        assert_eq!(
            drift(
                Duration::ZERO,
                Duration::ZERO,
                Duration::from_secs(6),
                Duration::ZERO
            ),
            Some(Event::Wake)
        );
        assert_eq!(
            drift(
                Duration::ZERO,
                Duration::ZERO,
                Duration::ZERO,
                Duration::from_secs(6)
            ),
            Some(Event::Suspend)
        );
        assert_eq!(
            drift(
                Duration::ZERO,
                Duration::ZERO,
                Duration::from_secs(5),
                Duration::ZERO
            ),
            None
        );
    }
}
