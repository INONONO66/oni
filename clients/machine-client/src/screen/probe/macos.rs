use std::os::unix::fs::MetadataExt;

use super::MacEnv;

pub struct System;

impl MacEnv for System {
    fn console_uid(&self) -> Option<u32> {
        std::fs::metadata("/dev/console")
            .ok()
            .map(|meta| meta.uid())
    }
    fn process_uid(&self) -> u32 {
        nix::unistd::getuid().as_raw()
    }
    fn capture(&self) -> bool {
        use crate::screen::Source;
        crate::screen::native::Native.ready().is_ok()
    }
    fn accessibility(&self) -> bool {
        crate::screen::ax::native::trusted()
    }
    fn asleep(&self) -> bool {
        crate::input::tap::session().1
    }
}
