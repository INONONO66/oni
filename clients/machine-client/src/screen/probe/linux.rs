use super::LinuxEnv;
use super::{atspi, libs, wayland, x11};

pub struct System;

impl LinuxEnv for System {
    fn variable(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }
    fn candidates(&self) -> Vec<String> {
        x11::candidates()
    }
    fn socket(&self, name: &str) -> bool {
        x11::socket(name)
    }
    fn x11(&self, name: &str) -> super::X11 {
        x11::status(name)
    }
    fn wayland(&self, name: &str) -> bool {
        wayland::accept(name)
    }
    fn atspi(&self) -> bool {
        atspi::ready()
    }
    fn library(&self, name: &str) -> bool {
        libs::available(name)
    }
}
