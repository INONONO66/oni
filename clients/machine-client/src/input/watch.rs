use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

use super::tag::ONI_EVENT_TAG;

pub fn tagged(user_data: i64) -> bool {
    user_data == ONI_EVENT_TAG
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Pointer,
    Keyboard,
}

pub fn event_kind(kind: u32) -> Option<Kind> {
    match kind {
        1 | 2 | 3 | 4 | 5 | 6 | 7 | 22 | 23 | 25 | 26 | 27 => Some(Kind::Pointer),
        10..=12 => Some(Kind::Keyboard),
        _ => None,
    }
}

pub const EVENT_MASK: u64 = (1 << 1)
    | (1 << 2)
    | (1 << 3)
    | (1 << 4)
    | (1 << 5)
    | (1 << 6)
    | (1 << 7)
    | (1 << 10)
    | (1 << 11)
    | (1 << 12)
    | (1 << 22)
    | (1 << 23)
    | (1 << 25)
    | (1 << 26)
    | (1 << 27);

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InputEvent {
    #[serde(rename = "atMs")]
    pub at: u64,
    pub kind: Kind,
    pub tagged: bool,
}

pub trait EventFeed {
    fn next(&mut self) -> Option<InputEvent>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Availability {
    Available,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TapState {
    Running,
    DisabledByTimeout,
    DisabledByUser,
    RecoveryFailed,
    Recovered,
}

impl Availability {
    pub fn transition(self, state: TapState) -> Self {
        match state {
            TapState::Running | TapState::Recovered => Self::Available,
            TapState::DisabledByTimeout | TapState::DisabledByUser | TapState::RecoveryFailed => {
                Self::Unavailable
            }
        }
    }
}

struct State {
    detector: EdgeDetector,
    availability: Availability,
}

/// The producer folds rows even while detached. Only one edge can await delivery;
/// interval counts remain in the detector rather than in an event queue.
pub struct InputWatch {
    state: Arc<Mutex<State>>,
    edges: mpsc::Receiver<(u64, Source)>,
}

#[derive(Clone)]
pub struct InputProducer {
    state: Arc<Mutex<State>>,
    edges: mpsc::Sender<(u64, Source)>,
}

impl InputWatch {
    pub fn new() -> (Self, InputProducer) {
        let (edges, receiver) = mpsc::channel(1);
        let state = Arc::new(Mutex::new(State {
            detector: EdgeDetector::default(),
            availability: Availability::Unavailable,
        }));
        (
            Self {
                state: state.clone(),
                edges: receiver,
            },
            InputProducer { state, edges },
        )
    }

    pub fn consume(&self, epoch_now: u64, monotonic_now: u64) -> Option<HumanInput> {
        self.state
            .lock()
            .ok()?
            .detector
            .consume(epoch_now, monotonic_now)
    }

    pub fn available(&self) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| state.availability == Availability::Available)
    }

    pub async fn next_edge(&mut self) -> Option<(u64, Source)> {
        self.edges.recv().await
    }

    pub fn discard_edges(&mut self) {
        while self.edges.try_recv().is_ok() {}
    }
}

impl InputProducer {
    pub fn transition(&self, state: TapState) {
        if let Ok(mut current) = self.state.lock() {
            current.availability = current.availability.transition(state);
        }
    }

    pub fn accept(&self, event: InputEvent) {
        if let Ok(mut state) = self.state.lock() {
            if state.availability == Availability::Available {
                if let Some(edge) = state.detector.accept(event) {
                    // A pending notification already represents the human-input edge.
                    let _ = self.edges.try_send(edge);
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Pointer,
    Keyboard,
    Both,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanInput {
    pub last_at: u64,
    pub source: Source,
    pub events: u64,
}

#[derive(Default)]
pub struct EdgeDetector {
    last_at: Option<u64>,
    last_edge: Option<u64>,
    pending: Option<HumanInput>,
}

impl EdgeDetector {
    pub fn accept(&mut self, event: InputEvent) -> Option<(u64, Source)> {
        if event.tagged {
            return None;
        }
        let edge = self
            .last_at
            .is_none_or(|at| event.at.saturating_sub(at) > 2_000)
            && self
                .last_edge
                .is_none_or(|at| event.at.saturating_sub(at) >= 250);
        self.last_at = Some(event.at);
        let source = match event.kind {
            Kind::Pointer => Source::Pointer,
            Kind::Keyboard => Source::Keyboard,
        };
        self.pending = Some(match self.pending {
            Some(previous) => HumanInput {
                last_at: event.at,
                source: if previous.source == source {
                    source
                } else {
                    Source::Both
                },
                events: previous.events.saturating_add(1),
            },
            None => HumanInput {
                last_at: event.at,
                source,
                events: 1,
            },
        });
        if edge {
            self.last_edge = Some(event.at);
            Some((event.at, source))
        } else {
            None
        }
    }

    pub fn consume(&mut self, epoch_now: u64, monotonic_now: u64) -> Option<HumanInput> {
        self.pending.take().map(|fact| HumanInput {
            last_at: epoch_now.saturating_sub(monotonic_now.saturating_sub(fact.last_at)),
            ..fact
        })
    }

    pub fn drain(&mut self, feed: &mut impl EventFeed) -> Vec<(u64, Source)> {
        let mut edges = Vec::new();
        while let Some(event) = feed.next() {
            if let Some(edge) = self.accept(event) {
                edges.push(edge);
            }
        }
        edges
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(std::vec::IntoIter<InputEvent>);
    impl EventFeed for Fixture {
        fn next(&mut self) -> Option<InputEvent> {
            self.0.next()
        }
    }

    #[test]
    fn tagged_events_never_change_the_human_fact() {
        let mut detector = EdgeDetector::default();
        assert!(tagged(ONI_EVENT_TAG));
        assert!(!tagged(0));
        assert_eq!(
            detector.accept(InputEvent {
                at: 10,
                kind: Kind::Pointer,
                tagged: true
            }),
            None
        );
        assert_eq!(detector.consume(100, 10), None);
        assert_eq!(
            detector.accept(InputEvent {
                at: 11,
                kind: Kind::Keyboard,
                tagged: false
            }),
            Some((11, Source::Keyboard))
        );
    }

    #[test]
    fn fixture_edges_require_quiet_and_throttle() {
        let events = [
            (1_000, Kind::Pointer),
            (1_050, Kind::Keyboard),
            (3_051, Kind::Pointer),
            (3_052, Kind::Keyboard),
            (5_053, Kind::Pointer),
            (5_400, Kind::Keyboard),
            (7_401, Kind::Keyboard),
        ];
        let mut feed = Fixture(
            events
                .into_iter()
                .map(|(at, kind)| InputEvent {
                    at,
                    kind,
                    tagged: false,
                })
                .collect::<Vec<_>>()
                .into_iter(),
        );
        let mut detector = EdgeDetector::default();
        assert_eq!(
            detector.drain(&mut feed),
            vec![
                (1_000, Source::Pointer),
                (3_051, Source::Pointer),
                (5_053, Source::Pointer),
                (7_401, Source::Keyboard),
            ]
        );
        assert_eq!(
            detector.consume(20_000, 7_500),
            Some(HumanInput {
                last_at: 19_901,
                source: Source::Both,
                events: 7,
            })
        );
        assert_eq!(detector.consume(20_100, 7_600), None);
    }

    #[test]
    fn edge_throttle_does_not_count_tagged_events() {
        let mut detector = EdgeDetector::default();
        assert_eq!(
            detector.accept(InputEvent {
                at: 10,
                kind: Kind::Pointer,
                tagged: false
            }),
            Some((10, Source::Pointer))
        );
        assert_eq!(
            detector.accept(InputEvent {
                at: 20,
                kind: Kind::Keyboard,
                tagged: true
            }),
            None
        );
        assert_eq!(
            detector.accept(InputEvent {
                at: 2_011,
                kind: Kind::Keyboard,
                tagged: false
            }),
            Some((2_011, Source::Keyboard))
        );
        assert_eq!(
            detector.accept(InputEvent {
                at: 4_012,
                kind: Kind::Keyboard,
                tagged: false
            }),
            Some((4_012, Source::Keyboard))
        );
    }

    #[test]
    fn fixture_replays_tagged_and_human_rows() {
        let rows: Vec<InputEvent> =
            serde_json::from_str(include_str!("../../tests/fixtures/human.json"))
                .expect("typed fixture rows");
        let mut feed = Fixture(rows.into_iter());
        let mut detector = EdgeDetector::default();
        assert_eq!(
            detector.drain(&mut feed),
            vec![(1_000, Source::Pointer), (3_401, Source::Keyboard)]
        );
        assert_eq!(
            detector.consume(5_000, 3_401),
            Some(HumanInput {
                last_at: 5_000,
                source: Source::Both,
                events: 3,
            })
        );
    }

    #[test]
    fn event_types_have_only_pointer_and_keyboard_sources() {
        for kind in [1, 2, 3, 4, 5, 6, 7, 22, 23, 25, 26, 27] {
            assert_eq!(event_kind(kind), Some(Kind::Pointer));
        }
        for kind in [10, 11, 12] {
            assert_eq!(event_kind(kind), Some(Kind::Keyboard));
        }
        assert_eq!(event_kind(0), None);
        assert_eq!(event_kind(8), None);
        assert_eq!(event_kind(31), None);
        for kind in 0..64 {
            assert_eq!(
                (EVENT_MASK & (1_u64 << kind)) != 0,
                event_kind(kind).is_some()
            );
        }
    }

    #[tokio::test]
    async fn producer_folds_disconnected_rows_and_bounds_pending_edges() {
        let (mut watch, producer) = InputWatch::new();
        producer.transition(TapState::Running);
        for at in [1_000, 3_100, 5_200] {
            producer.accept(InputEvent {
                at,
                kind: Kind::Pointer,
                tagged: false,
            });
        }
        assert_eq!(watch.next_edge().await, Some((1_000, Source::Pointer)));
        assert_eq!(
            watch.consume(10_000, 5_200),
            Some(HumanInput {
                last_at: 10_000,
                source: Source::Pointer,
                events: 3
            })
        );
        watch.discard_edges();
        producer.accept(InputEvent {
            at: 7_300,
            kind: Kind::Keyboard,
            tagged: false,
        });
        assert_eq!(watch.next_edge().await, Some((7_300, Source::Keyboard)));
        assert_eq!(
            watch.consume(12_000, 7_300),
            Some(HumanInput {
                last_at: 12_000,
                source: Source::Keyboard,
                events: 1
            })
        );
    }

    #[test]
    fn disabled_tap_reports_unavailable_until_recovered() {
        let (watch, producer) = InputWatch::new();
        assert!(!watch.available());
        producer.transition(TapState::Running);
        assert!(watch.available());
        producer.transition(TapState::DisabledByTimeout);
        assert!(!watch.available());
        producer.accept(InputEvent {
            at: 1,
            kind: Kind::Pointer,
            tagged: false,
        });
        assert_eq!(watch.consume(2, 1), None);
        producer.transition(TapState::RecoveryFailed);
        assert!(!watch.available());
        producer.transition(TapState::Recovered);
        assert!(watch.available());
        producer.transition(TapState::DisabledByUser);
        assert!(!watch.available());
    }

    #[test]
    fn poisoned_state_drops_accepted_events() {
        let (mut watch, producer) = InputWatch::new();
        let state = producer.state.clone();
        assert!(std::thread::spawn(move || {
            let _guard = state.lock().expect("state");
            panic!("poison state");
        })
        .join()
        .is_err());

        producer.accept(InputEvent {
            at: 1,
            kind: Kind::Pointer,
            tagged: false,
        });

        assert!(watch.edges.try_recv().is_err());
    }

    #[test]
    fn poisoned_state_ignores_availability_transition() {
        let (watch, producer) = InputWatch::new();
        let state = producer.state.clone();
        assert!(std::thread::spawn(move || {
            let _guard = state.lock().expect("state");
            panic!("poison state");
        })
        .join()
        .is_err());

        producer.transition(TapState::Running);

        assert!(!watch.available());
    }
}
