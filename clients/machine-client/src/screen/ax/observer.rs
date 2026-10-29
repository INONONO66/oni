use std::{
    cell::RefCell,
    ffi::c_void,
    ptr,
    sync::{Arc, Mutex, PoisonError},
    time::Instant,
};

use accessibility_sys::{
    kAXChildrenAttribute, kAXErrorAttributeUnsupported, kAXFocusedUIElementChangedNotification,
    kAXLayoutChangedNotification, kAXMovedNotification, kAXResizedNotification,
    kAXSelectedChildrenChangedNotification, kAXSelectedTextChangedNotification,
    kAXTitleChangedNotification, kAXUIElementDestroyedNotification, kAXValueChangedNotification,
    AXIsProcessTrusted, AXObserverAddNotification, AXObserverCreate, AXObserverGetRunLoopSource,
    AXObserverRef, AXUIElementCopyAttributeValue, AXUIElementRef,
};
use core_foundation::{
    array::CFArray,
    base::{CFEqual, CFType, CFTypeRef, TCFType},
    runloop::{kCFRunLoopDefaultMode, CFRunLoop, CFRunLoopSource},
    string::{CFString, CFStringRef},
};

use super::{native, AppIdentity, Observer, WindowIdentity};
use crate::screen::{
    observe,
    settle::{
        observer::{self, Driver, Event, Kind, Registration},
        Notifications, Sample, Subscription, Unsupported,
    },
};

pub struct Native;

const WATCHED: [(&str, Kind); 9] = [
    (kAXUIElementDestroyedNotification, Kind::Destroyed),
    (kAXValueChangedNotification, Kind::Changed),
    (kAXTitleChangedNotification, Kind::Changed),
    (kAXMovedNotification, Kind::Changed),
    (kAXResizedNotification, Kind::Changed),
    (kAXSelectedChildrenChangedNotification, Kind::Structure),
    (kAXSelectedTextChangedNotification, Kind::Changed),
    (kAXFocusedUIElementChangedNotification, Kind::Changed),
    (kAXLayoutChangedNotification, Kind::Structure),
];

struct Signals {
    events: RefCell<Vec<Event<native::Element>>>,
    revision: Arc<Mutex<u64>>,
}

struct RunLoop {
    observer: CFType,
    source: CFRunLoopSource,
    signals: Box<Signals>,
}

impl Drop for RunLoop {
    fn drop(&mut self) {
        // SAFETY: the source was added on this same thread and all fields still live.
        CFRunLoop::get_current().remove_source(&self.source, unsafe { kCFRunLoopDefaultMode });
        // Fields drop in declaration order: observer/source before callback storage.
    }
}

unsafe extern "C" fn received(
    _: AXObserverRef,
    element: AXUIElementRef,
    notification: CFStringRef,
    refcon: *mut c_void,
) {
    // SAFETY: the boxed callback storage lives until its observer and source are released.
    let signals = unsafe { &*refcon.cast::<Signals>() };
    // SAFETY: AX retains both callback arguments; wrappers take their own retain.
    let name = unsafe { CFString::wrap_under_get_rule(notification) };
    let element = unsafe { native::Element::retain(element) };
    let kind = WATCHED
        .iter()
        .find(|(watched, _)| name == *watched)
        .map(|(_, kind)| *kind)
        .unwrap_or(Kind::Changed);
    let mut revision = signals
        .revision
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    *revision += 1;
    signals.events.borrow_mut().push(Event {
        at: Instant::now(),
        element,
        kind,
    });
}

fn create(pid: u32, revision: Arc<Mutex<u64>>) -> Result<RunLoop, Unsupported> {
    let ffi_pid = i32::try_from(pid).map_err(|_| Unsupported::NoObserver)?;
    let mut raw = ptr::null_mut();
    // SAFETY: raw is a writable out-pointer; the callback is valid for the observer lifetime.
    let status = unsafe { AXObserverCreate(ffi_pid, received, &mut raw) };
    if status != 0 || raw.is_null() {
        return Err(Unsupported::NoObserver);
    }
    // SAFETY: successful creation owns a non-null CF object.
    let observer = unsafe { CFType::wrap_under_create_rule(raw.cast()) };
    // SAFETY: the retained observer owns this source; get-rule takes a retain.
    let source = unsafe { CFRunLoopSource::wrap_under_get_rule(AXObserverGetRunLoopSource(raw)) };
    // SAFETY: this is the worker's current run loop and the source remains retained.
    CFRunLoop::get_current().add_source(&source, unsafe { kCFRunLoopDefaultMode });
    Ok(RunLoop {
        observer,
        source,
        signals: Box::new(Signals {
            events: RefCell::new(Vec::new()),
            revision,
        }),
    })
}

fn add(observer: &CFType, element: &native::Element, name: &str, signals: &Signals) -> bool {
    let name = CFString::new(name);
    // SAFETY: every CF object is retained; signals stays boxed until the source is removed.
    unsafe {
        AXObserverAddNotification(
            observer.as_CFTypeRef().cast_mut().cast(),
            element.raw(),
            name.as_concrete_TypeRef(),
            ptr::from_ref(signals).cast_mut().cast(),
        ) == 0
    }
}

fn children(element: &native::Element) -> Result<Vec<native::Element>, Unsupported> {
    if !native::within_deadline(element.raw()) {
        return Err(Unsupported::NoObserver);
    }
    let mut value: CFTypeRef = ptr::null();
    let name = CFString::new(kAXChildrenAttribute);
    // SAFETY: element and name are retained; value receives a +1 CF reference on success.
    let error = unsafe {
        AXUIElementCopyAttributeValue(element.raw(), name.as_concrete_TypeRef(), &mut value)
    };
    if error == kAXErrorAttributeUnsupported {
        return Ok(Vec::new());
    }
    if error != 0 || value.is_null() {
        return Err(Unsupported::NoObserver);
    }
    // SAFETY: successful copy returned an owned object.
    let value = unsafe { CFType::wrap_under_create_rule(value) };
    let array = value
        .downcast::<CFArray<*const c_void>>()
        .ok_or(Unsupported::NoObserver)?;
    // SAFETY: AXChildren contains retained AX elements; each wrapper takes its own retain.
    Ok(array
        .iter()
        .map(|item| unsafe { native::Element::retain(item.cast_mut().cast()) })
        .collect())
}

fn same(left: &native::Element, right: &native::Element) -> bool {
    // SAFETY: both AX identities remain retained, including destroyed proxies.
    unsafe { CFEqual(left.raw().cast(), right.raw().cast()) != 0 }
}

impl Driver for RunLoop {
    type Element = native::Element;
    fn now(&self) -> Instant {
        Instant::now()
    }
    fn granted(&self) -> bool {
        // SAFETY: argument-free permission query.
        unsafe { AXIsProcessTrusted() }
    }
    fn same(&self, left: &Self::Element, right: &Self::Element) -> bool {
        same(left, right)
    }
    fn window(&self, element: &Self::Element, deadline: Instant) -> Option<u32> {
        native::bounded(deadline, || element.window_id())
    }
    fn open(
        &mut self,
        pid: u32,
        window_id: u32,
        deadline: Instant,
    ) -> Result<Self::Element, Unsupported> {
        let window = WindowIdentity {
            pid,
            window_id,
            owner_pid: pid,
            title: String::new(),
            app: AppIdentity {
                bundle_id: None,
                path: String::new(),
            },
            token: 0,
            origin: (0, 0),
            minimized: false,
        };
        native::bounded(deadline, || native::root(&window))
            .map_err(|_| Unsupported::NoObserver)?
            .ok_or(Unsupported::WindowNotFound)
    }
    fn children(
        &self,
        element: &Self::Element,
        deadline: Instant,
    ) -> Result<Vec<Self::Element>, Unsupported> {
        native::bounded(deadline, || children(element))
    }
    fn register(
        &self,
        element: &Self::Element,
        deadline: Instant,
    ) -> Result<Registration, Unsupported> {
        native::bounded(deadline, || {
            let mut registration = Registration::default();
            for (name, kind) in WATCHED {
                if !native::within_deadline(element.raw()) {
                    return Err(Unsupported::NoObserver);
                }
                registration.record(kind, add(&self.observer, element, name, &self.signals));
            }
            Ok(registration)
        })
    }
    fn pump(&mut self, until: Instant) -> Vec<Event<Self::Element>> {
        // SAFETY: the mode constant is valid and this thread owns the run loop.
        CFRunLoop::run_in_mode(
            unsafe { kCFRunLoopDefaultMode },
            until.saturating_duration_since(Instant::now()),
            false,
        );
        std::mem::take(&mut *self.signals.events.borrow_mut())
    }
    fn sample(
        &self,
        source: &dyn Observer,
        pid: u32,
        window: u32,
        deadline: Instant,
    ) -> Result<Sample, observe::Refusal> {
        native::bounded(deadline, || {
            observer::sample(source, pid, window, deadline, Instant::now)
        })
    }
}

impl Notifications for Native {
    fn subscribe(
        &self,
        pid: u32,
        window: u32,
        started: Instant,
        deadline: Instant,
        source: Arc<dyn Observer>,
    ) -> Result<Box<dyn Subscription>, Unsupported> {
        observer::subscribe(
            move |revision| create(pid, revision),
            pid,
            window,
            started,
            deadline,
            source,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use accessibility_sys::AXUIElementCreateApplication;

    #[test]
    fn distinct_proxies_compare_by_accessibility_identity() {
        // SAFETY: application constructors return owned references, no grant needed.
        let first =
            unsafe { CFType::wrap_under_create_rule(AXUIElementCreateApplication(42).cast()) };
        let second =
            unsafe { CFType::wrap_under_create_rule(AXUIElementCreateApplication(42).cast()) };
        assert_ne!(first.as_CFTypeRef(), second.as_CFTypeRef());
        // SAFETY: both owners remain live through this comparison.
        let left = unsafe { native::Element::retain(first.as_CFTypeRef().cast_mut().cast()) };
        let right = unsafe { native::Element::retain(second.as_CFTypeRef().cast_mut().cast()) };
        assert!(same(&left, &right));
    }
}
