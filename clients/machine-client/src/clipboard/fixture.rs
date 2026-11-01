//! An in-memory pasteboard for tests: one shared `Contents` cell whose change
//! count advances on every replacement, so a test can play the human by
//! editing the cell directly.

use std::sync::{Arc, Mutex};

use super::{Contents, Entry, Source};

#[derive(Clone)]
pub struct Fixture(pub Arc<Mutex<Contents>>);

pub fn text(data: &str) -> Arc<Mutex<Contents>> {
    Arc::new(Mutex::new(Contents {
        change_count: 1,
        entries: vec![Entry {
            format: "public.utf8-plain-text".into(),
            data: data.as_bytes().to_vec(),
        }],
    }))
}

impl Source for Fixture {
    fn snapshot(&mut self) -> Result<Contents, &'static str> {
        Ok(self.0.lock().expect("fixture").clone())
    }
    fn replace(&mut self, entries: &[Entry]) -> Result<u64, &'static str> {
        let mut contents = self.0.lock().expect("fixture");
        contents.change_count += 1;
        contents.entries = entries.to_vec();
        Ok(contents.change_count)
    }
    fn change_count(&mut self) -> u64 {
        self.0.lock().expect("fixture").change_count
    }
}
