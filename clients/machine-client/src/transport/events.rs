use std::{
    collections::hash_map::DefaultHasher,
    future::Future,
    hash::{Hash, Hasher},
    io,
    time::Duration,
};
use tokio::sync::mpsc;

use super::retry::{drift, Event};

trait RetrySource: Send + 'static {
    fn recv(&mut self) -> impl Future<Output = Option<()>> + Send;
}

impl RetrySource for tokio::signal::unix::Signal {
    fn recv(&mut self) -> impl Future<Output = Option<()>> + Send {
        self.recv()
    }
}

pub struct Events {
    wall: Duration,
    monotonic: Duration,
    interfaces: u64,
}

impl Events {
    pub fn new(wall: Duration, monotonic: Duration, interfaces: u64) -> Self {
        Self {
            wall,
            monotonic,
            interfaces,
        }
    }

    pub fn sample(
        &mut self,
        wall: Duration,
        monotonic: Duration,
        interfaces: u64,
    ) -> Option<Event> {
        let event = drift(self.wall, self.monotonic, wall, monotonic)
            .or_else(|| (interfaces != self.interfaces).then_some(Event::NetworkChanged));
        self.wall = wall;
        self.monotonic = monotonic;
        self.interfaces = interfaces;
        event
    }
}

pub fn interfaces() -> io::Result<u64> {
    let mut values = nix::ifaddrs::getifaddrs()
        .map_err(io::Error::other)?
        .map(|interface| {
            format!(
                "{}:{}",
                interface.interface_name,
                interface
                    .address
                    .map_or_else(String::new, |address| address.to_string())
            )
        })
        .collect::<Vec<_>>();
    values.sort_unstable();
    let mut hash = DefaultHasher::new();
    values.hash(&mut hash);
    Ok(hash.finish())
}

pub fn subscribe(
    wake: bool,
) -> io::Result<(mpsc::UnboundedReceiver<Event>, tokio::task::JoinHandle<()>)> {
    subscribe_with(
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::user_defined1())?,
        wake,
    )
}

fn subscribe_with(
    mut retry_signal: impl RetrySource,
    wake: bool,
) -> io::Result<(mpsc::UnboundedReceiver<Event>, tokio::task::JoinHandle<()>)> {
    let (sender, receiver) = mpsc::unbounded_channel();
    #[cfg(target_os = "macos")]
    if wake {
        super::wake::subscribe(sender.clone())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = wake;
    let clock = tokio::time::Instant::now();
    let observations = Events::new(
        Duration::from_millis(crate::attach::now_ms()),
        Duration::ZERO,
        interfaces()?,
    );
    let feed = tokio::spawn(async move {
        let (retry_sender, retry_receiver) = mpsc::channel(1);
        let mut events = tokio::task::JoinSet::new();
        events.spawn(run_feed(retry_receiver, sender, observations, clock));
        while retry_signal.recv().await.is_some() {
            if retry_sender.send(()).await.is_err() {
                break;
            }
        }
    });
    Ok((receiver, feed))
}

async fn run_feed(
    mut retry_signal: mpsc::Receiver<()>,
    sender: mpsc::UnboundedSender<Event>,
    mut observations: Events,
    clock: tokio::time::Instant,
) {
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    loop {
        let event = tokio::select! {
            Some(()) = retry_signal.recv() => Some(Event::Retry),
            _ = tick.tick() => interfaces().ok().and_then(|interfaces| {
                observations.sample(Duration::from_millis(crate::attach::now_ms()), clock.elapsed(), interfaces)
            }),
        };
        if let Some(event) = event {
            if sender.send(event).is_err() {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeRetry(mpsc::Receiver<()>);

    impl RetrySource for FakeRetry {
        fn recv(&mut self) -> impl Future<Output = Option<()>> + Send {
            self.0.recv()
        }
    }

    #[test]
    fn unchanged_interfaces_have_a_stable_fingerprint() {
        let initial = interfaces().expect("enumerate interfaces");
        for _ in 0..16 {
            assert_eq!(interfaces().expect("enumerate interfaces"), initial);
        }
    }

    #[test]
    fn network_and_clock_events_emit_only_on_changed_facts() {
        let mut events = Events::new(Duration::ZERO, Duration::ZERO, 4);
        assert_eq!(
            events.sample(Duration::from_secs(5), Duration::from_secs(5), 4),
            None
        );
        assert_eq!(
            events.sample(Duration::from_secs(10), Duration::from_secs(10), 5),
            Some(Event::NetworkChanged)
        );
        assert_eq!(
            events.sample(Duration::from_secs(20), Duration::from_secs(10), 5),
            Some(Event::Wake)
        );
        assert_eq!(
            events.sample(Duration::from_secs(20), Duration::from_secs(20), 5),
            Some(Event::Suspend)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn retry_signal_is_forwarded_and_closed_receiver_stops_feed() {
        let (retry_sender, retry_receiver) = mpsc::channel(1);
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let clock = tokio::time::Instant::now();
        let observations = Events::new(
            Duration::from_millis(crate::attach::now_ms()),
            Duration::ZERO,
            interfaces().expect("enumerate interfaces"),
        );
        let feed = tokio::spawn(run_feed(retry_receiver, sender, observations, clock));
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(5)).await;
        assert!(receiver.try_recv().is_err());
        retry_sender.send(()).await.expect("retry sent");
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), receiver.recv())
                .await
                .expect("retry forwarded"),
            Some(Event::Retry)
        );
        drop(receiver);
        retry_sender.send(()).await.expect("second retry sent");
        tokio::time::timeout(Duration::from_secs(5), feed)
            .await
            .expect("feed stopped")
            .expect("feed completed");
    }

    #[tokio::test(start_paused = true)]
    async fn injected_retry_is_forwarded_to_event_receiver() {
        let (retry_sender, retry_receiver) = mpsc::channel(1);
        let (mut receiver, feed) =
            subscribe_with(FakeRetry(retry_receiver), false).expect("subscribe");
        retry_sender.send(()).await.expect("retry sent");

        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), receiver.recv())
                .await
                .expect("retry forwarded"),
            Some(Event::Retry)
        );
        feed.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn closed_retry_source_stops_forwarding() {
        let (retry_sender, retry_receiver) = mpsc::channel(1);
        let (_receiver, feed) =
            subscribe_with(FakeRetry(retry_receiver), false).expect("subscribe");
        drop(retry_sender);

        tokio::time::timeout(Duration::from_secs(5), feed)
            .await
            .expect("feed stopped")
            .expect("feed completed");
    }

    #[tokio::test(start_paused = true)]
    async fn closed_event_receiver_makes_next_retry_stop_forwarding() {
        let (retry_sender, retry_receiver) = mpsc::channel(1);
        let (receiver, feed) = subscribe_with(FakeRetry(retry_receiver), false).expect("subscribe");
        drop(receiver);
        retry_sender.send(()).await.expect("first retry");
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(5)).await;
        retry_sender.send(()).await.expect("second retry");

        tokio::time::timeout(Duration::from_secs(5), feed)
            .await
            .expect("feed stopped")
            .expect("feed completed");
    }

    #[tokio::test]
    async fn subscribe_registers_signal_feed() {
        let (receiver, feed) = subscribe(false).expect("subscribe");
        drop(receiver);
        feed.abort();
    }
}
