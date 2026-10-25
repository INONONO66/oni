//! Per-session replay and bounded live output, addressed by opaque cursors.

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

use tokio::sync::Notify;

const RETAIN: usize = 1_048_576;
const READ_MAX: usize = 262_144;
pub const MAX_SESSIONS: usize = 1_000;

#[derive(Debug)]
pub struct Record {
    pub name: String,
    pub pane: Option<String>,
    pub window: Option<String>,
    pub replay: Vec<u8>,
    live: VecDeque<u8>,
    dropped: usize,
    pub lost: bool,
    pub poisoned: bool,
    pub notify: Arc<Notify>,
}

impl Record {
    fn new(name: String) -> Self {
        Self {
            name,
            pane: None,
            window: None,
            replay: Vec::new(),
            live: VecDeque::new(),
            dropped: 0,
            lost: false,
            poisoned: false,
            notify: Arc::new(Notify::new()),
        }
    }

    pub fn append(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.live.extend(bytes);
        while self.live.len() > RETAIN {
            self.live.pop_front();
            self.dropped += 1;
        }
        self.notify.notify_waiters();
    }

    /// Bytes held in memory: the captured replay plus the live window.
    pub fn retained(&self) -> usize {
        self.replay.len() + self.live.len()
    }

    /// Free every retained byte; cursors keep their offsets and a reader
    /// behind the new edge sees a truncated read.
    fn release(&mut self) -> usize {
        let released = self.retained();
        self.dropped += released;
        self.replay = Vec::new();
        self.live = VecDeque::new();
        released
    }

    pub fn read(&self, generation: &str, token: Option<&str>) -> View {
        let replay_len = self.replay.len();
        let end = replay_len + self.dropped + self.live.len();
        let requested = token
            .and_then(|token| parse_cursor(token, generation))
            .unwrap_or(replay_len);
        let requested = if token.is_none() { 0 } else { requested };
        let position = requested.min(end);
        let edge = replay_len + self.dropped;
        let gap = self.dropped > 0 && position < edge;
        let start = if position >= replay_len {
            position.max(edge)
        } else {
            position
        };
        let mut data = self.replay.get(start..).unwrap_or_default().to_vec();
        let skip = start.saturating_sub(edge);
        data.extend(self.live.iter().skip(skip));
        let capped = data.len() > READ_MAX;
        if capped {
            data.drain(..data.len() - READ_MAX);
        }
        View {
            data,
            cursor: format!("p1:{generation}:{end}"),
            truncated: gap || capped,
        }
    }
}

#[derive(Debug)]
pub struct View {
    pub data: Vec<u8>,
    pub cursor: String,
    pub truncated: bool,
}

pub fn parse_cursor(token: &str, generation: &str) -> Option<usize> {
    let mut parts = token.split(':');
    if parts.next()? != "p1" || parts.next()? != generation {
        return None;
    }
    let offset = parts.next()?;
    if parts.next().is_some()
        || offset.is_empty()
        || !offset.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    offset.parse().ok()
}

#[derive(Debug)]
pub struct Registry {
    pub generation: String,
    pub records: BTreeMap<String, Record>,
}

impl Registry {
    pub fn new(generation: String) -> Self {
        Self {
            generation,
            records: BTreeMap::new(),
        }
    }
    pub fn register(&mut self, name: &str) -> Option<&mut Record> {
        if !self.records.contains_key(name) && self.records.len() >= MAX_SESSIONS {
            return None;
        }
        Some(
            self.records
                .entry(name.to_owned())
                .or_insert_with(|| Record::new(name.to_owned())),
        )
    }
    pub fn remove(&mut self, name: &str) {
        if let Some(record) = self.records.remove(name) {
            record.notify.notify_waiters();
        }
    }
    pub fn append(&mut self, pane: &str, data: &[u8]) {
        if let Some(record) = self
            .records
            .values_mut()
            .find(|record| record.pane.as_deref() == Some(pane))
        {
            record.append(data);
        }
    }
    pub fn retained(&self) -> usize {
        self.records.values().map(Record::retained).sum()
    }

    /// Release the record retaining the most output; the bytes released.
    pub fn shed(&mut self) -> usize {
        self.records
            .values_mut()
            .max_by_key(|record| record.retained())
            .map_or(0, Record::release)
    }

    pub fn lost(&mut self) {
        for record in self.records.values_mut() {
            record.lost = true;
            record.notify.notify_waiters();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cursor_replay_and_truncation_when_live_exceeds_retention() {
        let mut registry = Registry::new("abc".into());
        let record = registry.register("test").expect("space in registry");
        record.replay = b"old\n".to_vec();
        assert_eq!(record.read("abc", None).data, b"old\n");
        assert_eq!(record.read("abc", Some("p1:other:0")).data, b"");
        for token in [
            "p2:abc:0",
            "p1:abc:-1",
            "p1:abc:1.5",
            "p1:abc:1:2",
            "p1:abc:",
            "p1:abc:999999999999999999999",
        ] {
            assert_eq!(parse_cursor(token, "abc"), None);
        }
        record.append(&vec![b'x'; RETAIN + 1]);
        let view = record.read("abc", Some("p1:abc:0"));
        assert_eq!(view.data.len(), READ_MAX);
        assert!(view.truncated);
        assert_eq!(view.cursor, format!("p1:abc:{}", RETAIN + 5));
    }

    #[test]
    fn registry_rejects_new_sessions_at_capacity() {
        let mut registry = Registry::new("g".into());
        for index in 0..MAX_SESSIONS {
            registry
                .register(&format!("session-{index}"))
                .expect("space before limit");
        }
        assert!(registry.register("overflow").is_none());
        assert!(registry.register("session-0").is_some());
        registry.remove("session-0");
        assert!(registry.register("overflow").is_some());
    }

    #[test]
    fn shed_releases_the_largest_record_and_keeps_cursors() {
        let mut registry = Registry::new("g".into());
        assert_eq!(registry.shed(), 0);
        registry.register("small").expect("space").append(b"ab");
        let large = registry.register("large").expect("space");
        large.replay = b"old\n".to_vec();
        large.append(b"live");
        assert_eq!(registry.retained(), 10);
        assert_eq!(registry.shed(), 8);
        assert_eq!(registry.retained(), 2);
        let large = &registry.records["large"];
        let behind = large.read("g", Some("p1:g:2"));
        assert!(behind.truncated);
        assert!(behind.data.is_empty());
        assert_eq!(behind.cursor, "p1:g:8");
        assert!(!large.read("g", Some("p1:g:8")).truncated);
        let large = registry.records.get_mut("large").expect("large");
        large.append(b"new");
        let after = large.read("g", Some("p1:g:8"));
        assert_eq!((after.data, after.truncated), (b"new".to_vec(), false));
    }

    #[test]
    fn empty_output_does_not_advance_cursor() {
        let mut registry = Registry::new("g".into());
        let record = registry.register("sample").expect("space");
        record.append(b"");
        assert_eq!(record.read("g", None).cursor, "p1:g:0");
    }
}
