use std::{
    cell::Cell,
    ffi::{c_char, c_void},
    ptr,
    sync::mpsc,
    time::Instant,
};

use super::watch::{event_kind, tagged, InputEvent, InputProducer, TapState, EVENT_MASK};

type Ref = *const c_void;
type EventRef = *mut c_void;
type TapCallback = unsafe extern "C" fn(*mut c_void, u32, EventRef, *mut c_void) -> EventRef;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        mask: u64,
        callback: TapCallback,
        info: *mut c_void,
    ) -> Ref;
    fn CGEventGetIntegerValueField(event: EventRef, field: u32) -> i64;
    #[cfg(test)]
    fn CGEventSetIntegerValueField(event: EventRef, field: u32, value: i64);
    #[cfg(test)]
    fn CGEventCreateKeyboardEvent(source: Ref, key: u16, down: bool) -> EventRef;
    fn CGEventTapEnable(port: Ref, enable: bool);
    fn CGEventTapIsEnabled(port: Ref) -> bool;
    fn CGSessionCopyCurrentDictionary() -> Ref;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayIsAsleep(display: u32) -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFMachPortCreateRunLoopSource(allocator: Ref, port: Ref, order: i64) -> Ref;
    fn CFRunLoopGetCurrent() -> Ref;
    fn CFRunLoopAddSource(run_loop: Ref, source: Ref, mode: Ref);
    fn CFRunLoopRun();
    fn CFRelease(value: Ref);
    fn CFDictionaryGetValue(dictionary: Ref, key: Ref) -> Ref;
    fn CFStringCreateWithCString(allocator: Ref, bytes: *const c_char, encoding: u32) -> Ref;
    fn CFBooleanGetValue(value: Ref) -> bool;
    static kCFRunLoopCommonModes: Ref;
}

struct Context {
    producer: InputProducer,
    start: Instant,
    port: Cell<Ref>,
}

const EVENT_SOURCE_USER_DATA: u32 = 42;
const DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
const DISABLED_BY_USER: u32 = 0xFFFF_FFFF;

fn is_tagged(event: EventRef) -> bool {
    // SAFETY: CoreGraphics supplied a live event, and 42 names its user-data field.
    tagged(unsafe { CGEventGetIntegerValueField(event, EVENT_SOURCE_USER_DATA) })
}

unsafe extern "C" fn observe(
    _proxy: *mut c_void,
    kind: u32,
    event: EventRef,
    info: *mut c_void,
) -> EventRef {
    // SAFETY: the run-loop thread owns this box for the entire life of the tap.
    let context = unsafe { &*(info.cast::<Context>()) };
    match kind {
        DISABLED_BY_TIMEOUT => {
            context.producer.transition(TapState::DisabledByTimeout);
            // SAFETY: the callback runs on the thread owning the live tap port.
            unsafe { CGEventTapEnable(context.port.get(), true) };
            // SAFETY: the port is retained until the run loop exits.
            if unsafe { CGEventTapIsEnabled(context.port.get()) } {
                context.producer.transition(TapState::Recovered);
            } else {
                context.producer.transition(TapState::RecoveryFailed);
            }
        }
        DISABLED_BY_USER => context.producer.transition(TapState::DisabledByUser),
        _ => {
            if let Some(kind) = event_kind(kind) {
                let at = u64::try_from(context.start.elapsed().as_millis()).unwrap_or(u64::MAX);
                context.producer.accept(InputEvent {
                    at,
                    kind,
                    tagged: is_tagged(event),
                });
            }
        }
    }
    event
}

pub fn start(start: Instant, producer: InputProducer) {
    let (ready, result) = mpsc::sync_channel(1);
    std::thread::spawn(move || run(producer, start, ready));
    let _ = result.recv();
}

fn run(producer: InputProducer, start: Instant, ready: mpsc::SyncSender<bool>) {
    let context = Box::into_raw(Box::new(Context {
        producer,
        start,
        port: Cell::new(ptr::null()),
    }));
    // SAFETY: context remains owned by this thread until its run loop exits.
    let port = unsafe { CGEventTapCreate(1, 0, 1, EVENT_MASK, observe, context.cast()) };
    if port.is_null() {
        // SAFETY: no callback can have been registered on creation failure.
        drop(unsafe { Box::from_raw(context) });
        let _ = ready.send(false);
        return;
    }
    // SAFETY: the context belongs to this run-loop thread until its final release.
    unsafe { (*context).port.set(port) };
    // SAFETY: the port is a live retained CoreFoundation object.
    let source = unsafe { CFMachPortCreateRunLoopSource(ptr::null(), port, 0) };
    if source.is_null() {
        // SAFETY: there is no run-loop callback after source creation failed.
        unsafe {
            CFRelease(port);
            drop(Box::from_raw(context));
        }
        let _ = ready.send(false);
        return;
    }
    // SAFETY: source, run loop and mode are valid for this thread.
    unsafe { CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes) };
    // SAFETY: the context is still owned by this thread and the source is installed.
    unsafe { (*context).producer.transition(TapState::Running) };
    let _ = ready.send(true);
    // SAFETY: the source is registered on this thread and remains alive until exit.
    unsafe {
        CFRunLoopRun();
        CFRelease(source);
        CFRelease(port);
        drop(Box::from_raw(context));
    }
}

pub fn session() -> (bool, bool) {
    // SAFETY: the system returns a retained dictionary or null outside a console session.
    let dictionary = unsafe { CGSessionCopyCurrentDictionary() };
    let locked = if dictionary.is_null() {
        false
    } else {
        // SAFETY: the key is a constant NUL-terminated UTF-8 string.
        let key = unsafe {
            CFStringCreateWithCString(
                ptr::null(),
                c"CGSSessionScreenIsLocked".as_ptr(),
                0x0800_0100,
            )
        };
        let value = if key.is_null() {
            ptr::null()
        } else {
            // SAFETY: dictionary and key remain live until the lookup completes.
            unsafe { CFDictionaryGetValue(dictionary, key) }
        };
        let locked = !value.is_null() && unsafe { CFBooleanGetValue(value) };
        // SAFETY: these are owned references returned by the two copy/create calls.
        unsafe {
            if !key.is_null() {
                CFRelease(key);
            }
            CFRelease(dictionary);
        }
        locked
    };
    // SAFETY: the display id is obtained from the same CoreGraphics framework.
    (locked, unsafe { CGDisplayIsAsleep(CGMainDisplayID()) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::tag::ONI_EVENT_TAG;

    #[test]
    fn tagged_native_event_reads_the_user_data_field() {
        // SAFETY: this unposted event is owned by the test until CFRelease.
        let event = unsafe { CGEventCreateKeyboardEvent(ptr::null(), 0, true) };
        assert!(!event.is_null());
        // SAFETY: a live event permits setting and reading its integer fields.
        unsafe { CGEventSetIntegerValueField(event, EVENT_SOURCE_USER_DATA, ONI_EVENT_TAG) };
        assert!(is_tagged(event));
        // SAFETY: CGEventCreateKeyboardEvent returned an owned reference.
        unsafe { CFRelease(event) };
    }
}
