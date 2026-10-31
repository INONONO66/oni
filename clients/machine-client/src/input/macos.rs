use super::{
    cg::{resolved_code, Command, State},
    delivery::Route,
    tag::ONI_EVENT_TAG,
    Driver, Event,
};
use core_foundation::{
    base::{CFType, CFTypeRef, TCFType},
    data::{CFData, CFDataRef},
    string::CFStringRef,
};
use core_graphics::{
    event::{
        CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField,
        ScrollEventUnit,
    },
    event_source::{CGEventSource, CGEventSourceStateID},
    geometry::CGPoint,
};
use std::collections::HashMap;
use std::ffi::c_void;

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn TISCopyCurrentKeyboardLayoutInputSource() -> CFTypeRef;
    static kTISPropertyUnicodeKeyLayoutData: CFStringRef;
    fn TISGetInputSourceProperty(source: CFTypeRef, key: CFStringRef) -> CFDataRef;
    fn LMGetKbdType() -> u8;
    fn UCKeyTranslate(
        layout: *const c_void,
        code: u16,
        action: u16,
        modifiers: u32,
        keyboard: u32,
        options: u32,
        dead: *mut u32,
        capacity: usize,
        length: *mut usize,
        text: *mut u16,
    ) -> i32;
}

fn layout() -> Option<Vec<(u16, String)>> {
    // SAFETY: the copy owns a retained input source; the property is borrowed from that source.
    let source = unsafe { TISCopyCurrentKeyboardLayoutInputSource() };
    if source.is_null() {
        return None;
    }
    // SAFETY: `source` is a non-null +1 CF object.
    let source = unsafe { CFType::wrap_under_create_rule(source) };
    // SAFETY: the documented Unicode layout property has CFData type and is retained below.
    let data = unsafe {
        TISGetInputSourceProperty(source.as_CFTypeRef(), kTISPropertyUnicodeKeyLayoutData)
    };
    if data.is_null() {
        return None;
    }
    // SAFETY: the property is a borrowed CFData; wrapping under the get rule retains it.
    let data = unsafe { CFData::wrap_under_get_rule(data) };
    Some(
        (0..128)
            .flat_map(|code| {
                [0, 2].into_iter().filter_map({
                    let data = &data;
                    move |modifier| translated(data, code, modifier).map(|text| (code, text))
                })
            })
            .collect(),
    )
}

fn translated(layout: &CFData, code: u16, modifiers: u32) -> Option<String> {
    let (mut dead, mut length, mut text) = (0, 0, [0_u16; 4]);
    // SAFETY: the retained CFData holds a system keyboard layout; all out buffers have the supplied lengths.
    let status = unsafe {
        UCKeyTranslate(
            layout.bytes().as_ptr().cast(),
            code,
            3,
            modifiers,
            u32::from(LMGetKbdType()),
            1,
            &mut dead,
            text.len(),
            &mut length,
            text.as_mut_ptr(),
        )
    };
    if status != 0 {
        return None;
    }
    String::from_utf16(text.get(..length)?).ok()
}

#[derive(Default)]
pub struct Native {
    states: HashMap<Route, State>,
    prepared: Option<Vec<(u16, String)>>,
}

fn convert(command: &Command, keys: Option<&[(u16, String)]>) -> Result<CGEvent, String> {
    let source = CGEventSource::new(CGEventSourceStateID::Private)
        .map_err(|()| "event source unavailable".to_owned())?;
    let event = match command {
        Command::Mouse {
            kind,
            button,
            x,
            y,
            flags,
            click,
        } => mouse(source, *kind, *button, *x, *y).inspect(|event| {
            event.set_flags(CGEventFlags::from_bits_truncate(*flags));
            event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, i64::from(*click));
        }),
        Command::Scroll { x, y, flags } => {
            CGEvent::new_scroll_event(source, ScrollEventUnit::LINE, 2, *y, *x, 0)
                .inspect(|event| event.set_flags(CGEventFlags::from_bits_truncate(*flags)))
        }
        Command::Key {
            down, text, flags, ..
        } => keyboard(
            source,
            resolved_code(command, keys).map_err(str::to_owned)?,
            *down,
            text,
            *flags,
        ),
    }
    .map_err(|()| "event allocation failed".to_owned())?;
    event.set_integer_value_field(EventField::EVENT_SOURCE_USER_DATA, ONI_EVENT_TAG);
    Ok(event)
}

fn mouse(source: CGEventSource, kind: u32, button: u32, x: i32, y: i32) -> Result<CGEvent, ()> {
    let kind = match kind {
        1 => CGEventType::LeftMouseDown,
        2 => CGEventType::LeftMouseUp,
        3 => CGEventType::RightMouseDown,
        4 => CGEventType::RightMouseUp,
        6 => CGEventType::LeftMouseDragged,
        7 => CGEventType::RightMouseDragged,
        25 => CGEventType::OtherMouseDown,
        26 => CGEventType::OtherMouseUp,
        27 => CGEventType::OtherMouseDragged,
        _ => CGEventType::MouseMoved,
    };
    let button = match button {
        1 => CGMouseButton::Right,
        2 => CGMouseButton::Center,
        _ => CGMouseButton::Left,
    };
    CGEvent::new_mouse_event(
        source,
        kind,
        CGPoint::new(f64::from(x), f64::from(y)),
        button,
    )
}

fn keyboard(
    source: CGEventSource,
    code: u16,
    down: bool,
    text: &str,
    flags: u64,
) -> Result<CGEvent, ()> {
    CGEvent::new_keyboard_event(source, code, down).inspect(|event| {
        event.set_flags(CGEventFlags::from_bits_truncate(flags));
        event.set_string(text);
    })
}

impl Native {
    fn post(&mut self, route: Route, event: &Event) -> Result<(), String> {
        for command in self.states.entry(route).or_default().commands(event) {
            let event = convert(&command, self.prepared.as_deref())?;
            match route {
                Route::Foreground => event.post(CGEventTapLocation::HID),
                Route::Background(pid) => {
                    event.post_to_pid(i32::try_from(pid).map_err(|error| error.to_string())?)
                }
            }
        }
        Ok(())
    }
}

impl Driver for Native {
    fn prepare(&mut self, route: Route, events: &[Event]) -> Result<(), String> {
        let keys = layout();
        let mut state = self.states.get(&route).cloned().unwrap_or_default();
        for event in events {
            for command in state.commands(event) {
                if matches!(command, Command::Key { .. }) {
                    resolved_code(&command, keys.as_deref()).map_err(str::to_owned)?;
                }
            }
        }
        self.prepared = keys;
        Ok(())
    }
    fn permitted(&self) -> bool {
        // SAFETY: an argument-free Accessibility grant query has no preconditions.
        unsafe { accessibility_sys::AXIsProcessTrusted() }
    }
    fn pid_delivery(&self) -> bool {
        true
    }
    fn inject(&mut self, event: &Event) -> Result<(), String> {
        self.post(Route::Foreground, event)
    }
    fn post_to_pid(&mut self, pid: u32, event: &Event) -> Result<(), String> {
        self.post(Route::Background(pid), event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::{Button, Key, Named};

    #[test]
    fn constructed_pointer_events_keep_modifiers_and_click_ordinals() {
        let mut state = State::default();
        state.commands(&Event::Key {
            key: Key::Named(Named::Shift),
            down: true,
        });
        for (click, down) in [(1, true), (1, false), (2, true), (2, false)] {
            let command = state
                .commands(&Event::Button {
                    button: Button::Left,
                    down,
                    click,
                })
                .remove(0);
            let event = convert(&command, None).expect("event");
            assert_eq!(
                event.get_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE),
                i64::from(click)
            );
            assert_eq!(event.get_flags().bits() & (1 << 17), 1 << 17);
        }
        let scroll = state
            .commands(&Event::Scroll {
                horizontal: false,
                delta: 1,
            })
            .remove(0);
        assert_eq!(
            convert(&scroll, None).expect("scroll").get_flags().bits() & (1 << 17),
            1 << 17
        );
    }
}
