//! The headless adapter: a scripted display and window layout whose frames
//! are synthesized noise, so a machine without a display server (CI, Linux
//! headless) drives the same bounds, encode and pool path as native capture.

use super::{Display, Fault, Source, Window};

#[derive(Clone, Debug, Default)]
pub struct Fixture {
    pub displays: Vec<Display>,
    pub windows: Vec<Window>,
    pub denied: bool,
    pub failure: Option<String>,
}

impl Fixture {
    /// One primary display of `width` x `height` points at `scale`.
    pub fn display(width: u32, height: u32, scale: f32) -> Self {
        Self {
            displays: vec![Display {
                id: 1,
                x: 0,
                y: 0,
                width,
                height,
                scale,
                primary: true,
            }],
            ..Self::default()
        }
    }

    fn frame(
        &self,
        width: u32,
        height: u32,
        seed: u32,
        pixels: &mut Vec<u8>,
    ) -> Result<(u32, u32), Fault> {
        if let Some(failure) = &self.failure {
            return Err(Fault::Failed(failure.clone()));
        }
        pixels.clear();
        let mut state = seed.wrapping_mul(2_654_435_761) | 1;
        for _ in 0..u64::from(width) * u64::from(height) {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            pixels.extend_from_slice(&[state as u8, (state >> 8) as u8, (state >> 16) as u8, 255]);
        }
        Ok((width, height))
    }
}

fn pixels(points: u32, scale: f32) -> u32 {
    ((points as f32 * scale).round() as u32).max(1)
}

impl Source for Fixture {
    fn ready(&self) -> Result<(), Fault> {
        if self.denied {
            return Err(Fault::Permission);
        }
        Ok(())
    }

    fn displays(&self) -> Result<Vec<Display>, Fault> {
        Ok(self.displays.clone())
    }

    fn windows(&self) -> Result<Vec<Window>, Fault> {
        Ok(self.windows.clone())
    }

    fn capture_display(&self, display: u32, out: &mut Vec<u8>) -> Result<(u32, u32), Fault> {
        let found = self
            .displays
            .iter()
            .find(|candidate| candidate.id == display);
        let found = found.ok_or(Fault::DisplayNotFound)?;
        let (width, height) = (
            pixels(found.width, found.scale),
            pixels(found.height, found.scale),
        );
        self.frame(width, height, display, out)
    }

    fn capture_window(&self, window: u32, out: &mut Vec<u8>) -> Result<(u32, u32), Fault> {
        let found = self.windows.iter().find(|candidate| candidate.id == window);
        let found = found.ok_or(Fault::WindowNotFound)?;
        self.frame(found.width.max(1), found.height.max(1), window, out)
    }
}
