//! macOS capture through xcap (CoreGraphics). Screen-recording permission is
//! preflighted before every listing and capture, because an unpermitted
//! CoreGraphics capture returns the wallpaper instead of failing.

use xcap::{image::RgbaImage, Monitor, Window as XWindow, XCapError};

use super::{Display, Fault, Source, Window};

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
}

pub struct Native;

fn failed(error: XCapError) -> Fault {
    Fault::Failed(error.to_string())
}

fn display(monitor: &Monitor) -> Result<Display, Fault> {
    Ok(Display {
        id: monitor.id().map_err(failed)?,
        x: monitor.x().map_err(failed)?,
        y: monitor.y().map_err(failed)?,
        width: monitor.width().map_err(failed)?,
        height: monitor.height().map_err(failed)?,
        scale: monitor.scale_factor().map_err(failed)?,
        primary: monitor.is_primary().map_err(failed)?,
    })
}

fn window(window: &XWindow) -> Result<Window, Fault> {
    let pid = window.pid().map_err(failed)?;
    Ok(Window {
        pid: Some(pid),
        app: super::ax::native::app(pid),
        id: window.id().map_err(failed)?,
        display: window
            .current_monitor()
            .and_then(|monitor| monitor.id())
            .map_err(failed)?,
        title: window.title().map_err(failed)?,
        owner: window.app_name().map_err(failed)?,
        x: window.x().map_err(failed)?,
        y: window.y().map_err(failed)?,
        width: window.width().map_err(failed)?,
        height: window.height().map_err(failed)?,
    })
}

fn fill(image: &RgbaImage, pixels: &mut Vec<u8>) -> (u32, u32) {
    pixels.clear();
    pixels.extend_from_slice(image.as_raw());
    image.dimensions()
}

impl Source for Native {
    fn ready(&self) -> Result<(), Fault> {
        // SAFETY: an argument-free CoreGraphics query with no preconditions.
        let permitted = unsafe { CGPreflightScreenCaptureAccess() };
        permitted.then_some(()).ok_or(Fault::Permission)
    }

    fn displays(&self) -> Result<Vec<Display>, Fault> {
        Monitor::all()
            .map_err(failed)?
            .iter()
            .map(display)
            .collect()
    }

    /// Windows that vanish or are minimized while being enumerated are skipped.
    fn windows(&self) -> Result<Vec<Window>, Fault> {
        let all = XWindow::all().map_err(failed)?;
        let shown = all
            .iter()
            .filter(|window| window.is_minimized().is_ok_and(|minimized| !minimized));
        Ok(shown.filter_map(|found| window(found).ok()).collect())
    }

    fn capture_display(&self, id: u32, pixels: &mut Vec<u8>) -> Result<(u32, u32), Fault> {
        let monitors = Monitor::all().map_err(failed)?;
        let monitor = monitors
            .iter()
            .find(|monitor| monitor.id().is_ok_and(|found| found == id));
        let image = monitor
            .ok_or(Fault::DisplayNotFound)?
            .capture_image()
            .map_err(failed)?;
        Ok(fill(&image, pixels))
    }

    fn capture_window(&self, id: u32, pixels: &mut Vec<u8>) -> Result<(u32, u32), Fault> {
        let windows = XWindow::all().map_err(failed)?;
        let found = windows
            .iter()
            .find(|window| window.id().is_ok_and(|found| found == id));
        let image = found
            .ok_or(Fault::WindowNotFound)?
            .capture_image()
            .map_err(failed)?;
        Ok(fill(&image, pixels))
    }
}
