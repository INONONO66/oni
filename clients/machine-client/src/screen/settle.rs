use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use oni_protocol::ScreenSettleRequest;
use serde_json::{json, Value};

use super::{ax, encode, observe, Fault, Screen, Source};
use crate::app;

pub mod observer;
mod pixels;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Notification {
    Changed,
    Destroyed,
    Unresolved,
    Resolved,
    Lost,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unsupported {
    AccessibilityNotGranted,
    NoObserver,
    WindowNotFound,
}

pub struct Sample {
    pub windows: Vec<ax::WindowIdentity>,
    pub walk: ax::Walk,
    pub private: bool,
}

pub trait Subscription {
    fn now(&self) -> Instant;
    fn receive_until(&mut self, deadline: Instant) -> Option<(Instant, Notification)>;
    /// Returns only after notifications delivered during the sample have
    /// been queued. The caller drains those before committing the sample.
    fn sample(&mut self, deadline: Instant) -> Result<Sample, observe::Refusal>;
    fn commit_if_current(&mut self, commit: Box<dyn FnOnce() -> Value + '_>) -> Option<Value>;
}

pub trait Notifications: Send + Sync {
    fn subscribe(
        &self,
        pid: u32,
        window_id: u32,
        started: Instant,
        deadline: Instant,
        observer: Arc<dyn ax::Observer>,
    ) -> Result<Box<dyn Subscription>, Unsupported>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct State {
    last_change: Instant,
    changes: u64,
    unresolved: bool,
    destroyed: bool,
    lost: bool,
}

impl State {
    fn new(ready: Instant) -> Self {
        Self {
            last_change: ready,
            changes: 0,
            unresolved: false,
            destroyed: false,
            lost: false,
        }
    }

    fn event(&mut self, at: Instant, event: Notification) {
        match event {
            Notification::Changed => {
                self.last_change = self.last_change.max(at);
                self.changes += 1;
            }
            Notification::Destroyed => self.destroyed = true,
            Notification::Unresolved => self.unresolved = true,
            Notification::Resolved => {
                self.unresolved = false;
                self.last_change = self.last_change.max(at);
            }
            Notification::Lost => self.lost = true,
        }
    }

    fn quiet(&self, at: Instant, quiet: Duration) -> bool {
        !self.unresolved && at.saturating_duration_since(self.last_change) >= quiet
    }

    fn drain(&mut self, subscription: &mut dyn Subscription) {
        let fence = subscription.now();
        while let Some((at, event)) = subscription.receive_until(fence) {
            self.event(at, event);
        }
    }
}

fn refusal(reason: &str) -> Value {
    json!({"status": "refused", "reason": reason})
}

fn no_observer() -> Value {
    json!({"status": "unsupported", "blocker": "no_observer"})
}

fn sample_refusal(error: observe::Refusal) -> Value {
    match error {
        observe::Refusal::EpochChanged => refusal("epoch_changed"),
        observe::Refusal::WindowNotFound => refusal("window_not_found"),
        observe::Refusal::Permission => refusal("permission_denied"),
        _ => no_observer(),
    }
}

impl Screen {
    pub fn settle(&self, request: &ScreenSettleRequest) -> Value {
        let target = observe::target(
            request.target.pid.get(),
            request.target.window_id,
            Some(request.target.epoch),
        );
        let (Ok(pid), Ok(window_id)) = (u32::try_from(target.pid), u32::try_from(target.window_id))
        else {
            return refusal("window_not_found");
        };
        let surface = self.observations.surface(target);
        let (Some(notifications), Some(observer)) =
            (self.notifications.as_deref(), self.observer.as_ref())
        else {
            return self.settle_pixels(request, pid, window_id);
        };
        let started = Instant::now();
        let end = started + Duration::from_millis(request.timeout_ms.unsigned_abs());
        let mut subscription =
            match notifications.subscribe(pid, window_id, started, end, Arc::clone(observer)) {
                Ok(subscription) => subscription,
                Err(Unsupported::WindowNotFound) if surface => {
                    self.observations.destroy(target);
                    return json!({"status": "destroyed"});
                }
                Err(Unsupported::NoObserver | Unsupported::AccessibilityNotGranted) => {
                    return self.settle_pixels(request, pid, window_id)
                }
                Err(Unsupported::WindowNotFound) => return refusal("window_not_found"),
            };
        let quiet = Duration::from_millis(request.quiet_ms.unwrap_or(200).unsigned_abs());
        self.settle_subscribed(subscription.as_mut(), target, quiet, end, surface)
    }

    fn settle_subscribed(
        &self,
        subscription: &mut dyn Subscription,
        target: observe::Target,
        quiet: Duration,
        end: Instant,
        surface: bool,
    ) -> Value {
        let mut state = State::new(subscription.now());
        let baseline = self.settle_sample(subscription, target, end);
        state.drain(subscription);
        if let Some(terminal) = self.settle_terminal(&state, target) {
            return terminal;
        }
        match baseline {
            Ok(prepared) => {
                self.observations.commit(prepared, None);
            }
            Err(observe::Refusal::WindowNotFound) if surface => {
                self.observations.destroy(target);
                return json!({"status": "destroyed"});
            }
            Err(error) => return sample_refusal(error),
        }
        // The wire's extra second includes the final sample and teardown.
        // A sample after the quiet/deadline decision has a fixed 500ms ceiling.
        let finish = end + Duration::from_millis(500);
        loop {
            state.drain(subscription);
            if let Some(terminal) = self.settle_terminal(&state, target) {
                return terminal;
            }
            let now = subscription.now();
            if now < end && !state.quiet(now, quiet) {
                let until = if state.unresolved {
                    end
                } else {
                    (state.last_change + quiet).min(end)
                };
                if let Some((at, event)) = subscription.receive_until(until) {
                    state.event(at, event);
                }
                continue;
            }
            let before = state;
            let deadline = (subscription.now() + Duration::from_millis(500)).min(finish);
            let prepared = self.settle_sample(subscription, target, deadline);
            state.drain(subscription);
            if let Some(terminal) = self.settle_terminal(&state, target) {
                return terminal;
            }
            let prepared = match prepared {
                Ok(prepared) => prepared,
                Err(observe::Refusal::WindowNotFound) if surface => {
                    self.observations.destroy(target);
                    return json!({"status": "destroyed"});
                }
                Err(error) => return sample_refusal(error),
            };
            let settled = state == before
                && state.quiet(subscription.now(), quiet)
                && state.last_change + quiet <= end;
            if !settled && subscription.now() < end {
                continue;
            }
            if settled {
                if let Some(result) = subscription.commit_if_current(Box::new(|| {
                    let observation = self.observations.commit(prepared, None);
                    json!({"status": "settled", "method":"accessibility", "observationId": observation["observationId"]})
                })) {
                    return result;
                }
            } else {
                let observation = self.observations.commit(prepared, None);
                return json!({"status": "pending", "method":"accessibility", "observationId": observation["observationId"],
                    "changesInWindow": state.changes});
            }
        }
    }

    fn settle_terminal(&self, state: &State, target: observe::Target) -> Option<Value> {
        if state.destroyed {
            self.observations.destroy(target);
            Some(json!({"status": "destroyed"}))
        } else if state.lost {
            Some(no_observer())
        } else {
            None
        }
    }

    fn settle_sample(
        &self,
        subscription: &mut dyn Subscription,
        target: observe::Target,
        deadline: Instant,
    ) -> Result<observe::Prepared, observe::Refusal> {
        let sample = subscription.sample(deadline)?;
        self.observations
            .prepare_sample(target, sample.windows, sample.walk, sample.private)
    }

    fn settle_pixels(&self, request: &ScreenSettleRequest, pid: u32, window_id: u32) -> Value {
        self.settle_pixels_with_clock(request, pid, window_id, &app::SystemClock)
    }

    fn settle_pixels_with_clock(
        &self,
        request: &ScreenSettleRequest,
        pid: u32,
        window_id: u32,
        clock: &impl app::Clock,
    ) -> Value {
        let source = match self.source() {
            Ok(source) => source,
            Err(Fault::Absent) => return no_observer(),
            Err(Fault::Permission) => return refusal("permission_denied"),
            Err(_) => return refusal("window_not_found"),
        };
        pixels::run(
            clock,
            Duration::from_millis(request.quiet_ms.unwrap_or(500).unsigned_abs()),
            Duration::from_millis(request.timeout_ms.unsigned_abs()),
            || self.pixel_sample(source, pid, window_id, request.target.epoch),
            || self.pixel_anchor(window_id),
        )
    }

    fn pixel_sample(
        &self,
        source: &dyn Source,
        pid: u32,
        window_id: u32,
        epoch: i64,
    ) -> Result<Vec<u8>, Value> {
        let windows = source.windows().map_err(|fault| fault.refusal())?;
        let window = windows
            .iter()
            .find(|window| window.id == window_id && window.pid == Some(pid))
            .ok_or_else(|| refusal("window_not_found"))?;
        if app::excluded(
            pid,
            window.app.as_ref().unwrap_or(&ax::AppIdentity {
                bundle_id: None,
                path: String::new(),
            }),
            &self.excluded_owners,
        ) {
            return Err(refusal("excluded"));
        }
        if self.observer.is_some() {
            self.window_target(observe::target(
                u64::from(pid),
                i64::from(window_id),
                Some(epoch),
            ))
            .map_err(sample_refusal)?;
            match self.window_private(window_id) {
                Ok(true) => return Err(refusal("paused:private")),
                Ok(false) | Err(Fault::Permission) => {}
                Err(fault) => return Err(fault.refusal()),
            }
        } else if epoch != 0 {
            return Err(refusal("epoch_changed"));
        }
        let mut raw = Vec::new();
        let size = source
            .capture_window(window_id, &mut raw)
            .map_err(|fault| fault.refusal())?;
        if size.0 == 0 || size.1 == 0 || raw.len() != size.0 as usize * size.1 as usize * 4 {
            return Err(refusal("permission_denied"));
        }
        let mut thumbnail = Vec::new();
        encode::thumbnail(&raw, size, &mut thumbnail);
        Ok(thumbnail)
    }

    fn pixel_anchor(&self, window_id: u32) -> Value {
        let encoding = encode::Encoding {
            format: encode::Format::Png,
            quality: 0,
            max_bytes: super::MAX_BYTES,
            max_dimension: 256,
        };
        self.shoot(
            &super::Target::Window(window_id.to_string()),
            &encoding,
            |shot| json!({"status":"settled","method":"pixels","captureId":shot.id}),
        )
        .unwrap_or_else(|fault| match fault {
            Fault::WindowNotFound => json!({"status":"destroyed"}),
            other => other.refusal(),
        })
    }
}

#[cfg(test)]
mod tests;
