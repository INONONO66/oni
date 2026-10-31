//! macOS accessibility through AXUIElement (#1689): attribute reads, the
//! window lookup and actions only. The walk, ref resolution and every
//! decision live in the cfg-free parent module.

use std::{
    cell::Cell,
    ffi::c_void,
    ptr,
    time::{Duration, Instant},
};

use accessibility_sys::{
    kAXErrorSuccess, kAXFocusedUIElementAttribute, kAXPressAction, kAXRoleAttribute,
    kAXSecureTextFieldSubrole, kAXSubroleAttribute, kAXValueAttribute, kAXValueTypeAXError,
    kAXValueTypeCGPoint, kAXValueTypeCGSize, kAXWindowsAttribute, AXError, AXIsProcessTrusted,
    AXUIElementCopyActionNames, AXUIElementCopyAttributeValue,
    AXUIElementCopyMultipleAttributeValues, AXUIElementCreateApplication, AXUIElementPerformAction,
    AXUIElementRef, AXUIElementSetAttributeValue, AXUIElementSetMessagingTimeout, AXValueGetType,
    AXValueGetTypeID, AXValueGetValue, AXValueRef,
};
use core_foundation::{
    array::{CFArray, CFArrayRef},
    base::{CFType, CFTypeRef, TCFType},
    boolean::CFBoolean,
    bundle::CFBundle,
    string::CFString,
    url::CFURL,
};
use xcap::Window as XWindow;

use super::{
    assemble, bundle_root, checked, items, performed, target, walk, ActFault, Action, Admit,
    AppIdentity, Attributes, Bounds, Observer, Raw, Segment, Tree, Walk, WindowIdentity,
    ATTRIBUTES,
};
use crate::screen::private::Focused;
use crate::screen::Fault;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn _AXUIElementGetWindow(element: AXUIElementRef, window: *mut u32) -> AXError;
}

unsafe extern "C" {
    fn proc_pidpath(pid: i32, buffer: *mut c_void, size: u32) -> i32;
}

const PATH_MAX: u32 = 4096;

thread_local! {
    static DEADLINE: Cell<Option<Instant>> = const { Cell::new(None) };
}

pub(super) fn bounded<T>(deadline: Instant, call: impl FnOnce() -> T) -> T {
    struct Reset(Option<Instant>);
    impl Drop for Reset {
        fn drop(&mut self) {
            DEADLINE.set(self.0);
        }
    }
    let _reset = Reset(DEADLINE.replace(Some(deadline)));
    call()
}

pub(super) fn within_deadline(element: AXUIElementRef) -> bool {
    let Some(deadline) = DEADLINE.get() else {
        return true;
    };
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return false;
    }
    // SAFETY: callers hold the AX element alive; the positive timeout bounds one IPC call.
    unsafe {
        AXUIElementSetMessagingTimeout(
            element,
            remaining.min(Duration::from_millis(25)).as_secs_f32(),
        ) == 0
    }
}

#[repr(C)]
#[derive(Default)]
struct Pair {
    first: f64,
    second: f64,
}

pub struct Native;

#[derive(Clone)]
pub(super) struct Element(CFType);

/// One CF value as the cfg-free assembly reads it.
fn raw(value: &CFType) -> Raw<Element> {
    if let Some(text) = value.downcast::<CFString>() {
        return Raw::Text(text.to_string());
    }
    if let Some(flag) = value.downcast::<CFBoolean>() {
        return Raw::Flag(flag.into());
    }
    if let Some(array) = value.downcast::<CFArray<*const c_void>>() {
        // SAFETY: every item of an AX element array is a live AXUIElement the array retains.
        let items = array
            .iter()
            .map(|item| unsafe { CFType::wrap_under_get_rule(*item) });
        return Raw::Items(items.map(Element).collect());
    }
    // SAFETY: an argument-free type id query.
    if value.type_of() != unsafe { AXValueGetTypeID() } {
        return Raw::Other;
    }
    let ax = value.as_CFTypeRef() as AXValueRef;
    // SAFETY: `ax` is a live AXValue.
    let kind = unsafe { AXValueGetType(ax) };
    let mut pair = Pair::default();
    let mut code: AXError = 0;
    let error = kind == kAXValueTypeAXError;
    let out = if error {
        ptr::from_mut(&mut code).cast()
    } else {
        ptr::from_mut(&mut pair).cast()
    };
    // SAFETY: `out` is the C layout `kind` names (CGPoint/CGSize as `Pair`, AXError as i32).
    let read = unsafe { AXValueGetValue(ax, kind, out) };
    if !read {
        Raw::Other
    } else if error {
        Raw::Error(code)
    } else if kind == kAXValueTypeCGPoint {
        Raw::Point(pair.first, pair.second)
    } else if kind == kAXValueTypeCGSize {
        Raw::Size(pair.first, pair.second)
    } else {
        Raw::Other
    }
}

impl Element {
    pub(super) unsafe fn retain(element: AXUIElementRef) -> Self {
        // SAFETY: the caller guarantees a live AXUIElement for this retain.
        Self(unsafe { CFType::wrap_under_get_rule(element.cast()) })
    }

    pub(super) fn raw(&self) -> AXUIElementRef {
        self.0.as_CFTypeRef() as AXUIElementRef
    }

    /// `names` read in one batched call; a value the element could not
    /// supply is `Raw::Error` in its place.
    fn values(&self, names: &[&str]) -> Result<Vec<Raw<Self>>, Fault> {
        if !within_deadline(self.raw()) {
            return Err(Fault::Failed("accessibility deadline exceeded".to_owned()));
        }
        let names: Vec<CFString> = names.iter().map(|name| CFString::new(name)).collect();
        let names = CFArray::from_CFTypes(&names);
        let mut values: CFArrayRef = ptr::null();
        // SAFETY: `self` holds a live AXUIElement; on success `values` is a +1 array.
        let error = unsafe {
            AXUIElementCopyMultipleAttributeValues(
                self.raw(),
                names.as_concrete_TypeRef(),
                0,
                &mut values,
            )
        };
        checked(error)?;
        // SAFETY: a successful copy hands over ownership of a non-null array of CF values.
        let array: CFArray<CFType> = unsafe { CFArray::wrap_under_create_rule(values) };
        Ok(array.iter().map(|value| raw(&value)).collect())
    }

    fn actions(&self) -> Result<Vec<String>, AXError> {
        if !within_deadline(self.raw()) {
            return Err(-25202);
        }
        let mut names: CFArrayRef = ptr::null();
        // SAFETY: `self` holds a live AXUIElement; on success `names` is a +1 array of CFStrings.
        let error = unsafe { AXUIElementCopyActionNames(self.raw(), &mut names) };
        if error != kAXErrorSuccess {
            return Err(error);
        }
        // SAFETY: ownership of the successfully copied array passes to `array`.
        let array: CFArray<CFString> = unsafe { CFArray::wrap_under_create_rule(names) };
        Ok(array.iter().map(|name| name.to_string()).collect())
    }

    pub(super) fn window_id(&self) -> Option<u32> {
        if !within_deadline(self.raw()) {
            return None;
        }
        let mut id = 0;
        // SAFETY: `self` holds a live AXUIElement and `id` is a valid out pointer.
        let error = unsafe { _AXUIElementGetWindow(self.raw(), &mut id) };
        (error == kAXErrorSuccess).then_some(id)
    }
}

struct Window {
    origin: (f64, f64),
}

impl Tree for Window {
    type Item = Element;

    fn read(&self, item: &Element) -> Result<(Attributes, Vec<Element>), Fault> {
        assemble(item.values(&ATTRIBUTES)?, item.actions(), self.origin)
    }
}

pub(crate) fn trusted() -> bool {
    // SAFETY: an argument-free query with no preconditions.
    unsafe { AXIsProcessTrusted() }
}

pub(crate) fn app(pid: u32) -> Option<AppIdentity> {
    let mut buffer = vec![0_u8; PATH_MAX as usize];
    // SAFETY: `buffer` holds `PATH_MAX` writable bytes.
    let length = unsafe {
        proc_pidpath(
            i32::try_from(pid).ok()?,
            buffer.as_mut_ptr().cast(),
            PATH_MAX,
        )
    };
    buffer.truncate(usize::try_from(length).ok().filter(|length| *length > 0)?);
    let path = String::from_utf8(buffer).ok()?;
    let bundle_id = bundle_root(&path).and_then(bundle_identifier);
    Some(AppIdentity { bundle_id, path })
}

fn bundle_identifier(root: &str) -> Option<String> {
    let bundle = CFBundle::new(CFURL::from_path(root, true)?)?;
    let info = bundle.info_dictionary();
    let identifier = info.find(CFString::new("CFBundleIdentifier"))?;
    Some(identifier.downcast::<CFString>()?.to_string())
}

fn identity(window: &XWindow) -> Option<WindowIdentity> {
    let pid = window.pid().ok()?;
    let mut identity = WindowIdentity {
        pid,
        window_id: window.id().ok()?,
        owner_pid: pid,
        title: window.title().ok()?,
        app: app(pid)?,
        token: 0,
        origin: (window.x().ok()?.into(), window.y().ok()?.into()),
        minimized: false,
    };
    identity.minimized = root(&identity)
        .ok()
        .flatten()
        .and_then(|root| match root.values(&["AXMinimized"]).ok()?.pop()? {
            Raw::Flag(flag) => Some(flag),
            _ => None,
        })
        .unwrap_or(false);
    Some(identity)
}

pub(super) fn root(window: &WindowIdentity) -> Result<Option<Element>, Fault> {
    let pid = i32::try_from(window.pid).map_err(|_| Fault::WindowNotFound)?;
    // SAFETY: creating an application element has no preconditions; the result is +1.
    let application =
        unsafe { CFType::wrap_under_create_rule(AXUIElementCreateApplication(pid) as CFTypeRef) };
    let windows = Element(application).values(&[kAXWindowsAttribute])?;
    Ok(items(windows.into_iter().next())?
        .into_iter()
        .find(|candidate| candidate.window_id() == Some(window.window_id)))
}

fn perform(element: &Element, action: &Action) -> AXError {
    let set = |value: &str| {
        let (name, value) = (CFString::new(kAXValueAttribute), CFString::new(value));
        // SAFETY: `element` holds a live AXUIElement; both CF values outlive the call.
        unsafe {
            AXUIElementSetAttributeValue(
                element.raw(),
                name.as_concrete_TypeRef(),
                value.as_CFTypeRef(),
            )
        }
    };
    let press = |name: &str| {
        let name = CFString::new(name);
        // SAFETY: `element` holds a live AXUIElement; `name` outlives the call.
        unsafe { AXUIElementPerformAction(element.raw(), name.as_concrete_TypeRef()) }
    };
    match action {
        Action::Press => press(kAXPressAction),
        Action::Perform(name) => press(name),
        Action::SetValue(value) => set(value),
    }
}

/// The window's element, its children and its origin in global points.
fn opened(window: &WindowIdentity) -> Result<(Vec<Element>, (f64, f64)), Fault> {
    if !trusted() {
        return Err(Fault::Permission);
    }
    let root = root(window)?.ok_or(Fault::WindowNotFound)?;
    let (attributes, children) = Window { origin: (0.0, 0.0) }.read(&root)?;
    let origin = (attributes.frame.x as f64, attributes.frame.y as f64);
    Ok((children, origin))
}

impl Observer for Native {
    fn lifecycle(&self, window: &WindowIdentity, park: bool) -> Result<(), ActFault> {
        if !trusted() {
            return Err(ActFault::Permission);
        }
        let root = root(window)
            .map_err(ActFault::from)?
            .ok_or(ActFault::NotFound)?;
        if park {
            // SAFETY: the PID fits pid_t and the created application is retained until the setter returns.
            let application = unsafe {
                CFType::wrap_under_create_rule(AXUIElementCreateApplication(
                    i32::try_from(window.pid).map_err(|_| ActFault::NotFound)?,
                ) as CFTypeRef)
            };
            let name = CFString::new("AXHidden");
            // SAFETY: application, attribute and boolean are live CF values of the required types.
            return performed(unsafe {
                AXUIElementSetAttributeValue(
                    application.as_CFTypeRef() as AXUIElementRef,
                    name.as_concrete_TypeRef(),
                    CFBoolean::true_value().as_CFTypeRef(),
                )
            });
        }
        let close = items(root.values(&["AXCloseButton"])?.pop())?
            .into_iter()
            .next()
            .ok_or(ActFault::Unsupported)?;
        performed(perform(&close, &Action::Press))
    }
    fn focused(&self, window: &WindowIdentity) -> Result<Option<Focused>, Fault> {
        if !trusted() {
            return Err(Fault::Permission);
        }
        let pid = i32::try_from(window.pid).map_err(|_| Fault::WindowNotFound)?;
        // SAFETY: the created application element is retained until the attribute copy returns.
        let app = unsafe {
            CFType::wrap_under_create_rule(AXUIElementCreateApplication(pid) as CFTypeRef)
        };
        let name = CFString::new(kAXFocusedUIElementAttribute);
        let mut value: CFTypeRef = ptr::null();
        // SAFETY: app and name are live CF values and value is a valid output pointer.
        checked(unsafe {
            AXUIElementCopyAttributeValue(
                app.as_CFTypeRef() as AXUIElementRef,
                name.as_concrete_TypeRef(),
                &mut value,
            )
        })?;
        if value.is_null() {
            return Ok(None);
        }
        // SAFETY: a successful copy transfers ownership of a live AX element.
        let element = Element(unsafe { CFType::wrap_under_create_rule(value) });
        if element.window_id() != Some(window.window_id) {
            return Ok(None);
        }
        let fields = element.values(&[kAXRoleAttribute, kAXSubroleAttribute])?;
        let role = match fields.first() {
            Some(Raw::Text(role)) => role.clone(),
            _ => String::new(),
        };
        let secure = matches!(fields.get(1), Some(Raw::Text(subrole)) if subrole == kAXSecureTextFieldSubrole);
        Ok(Some(Focused { role, secure }))
    }
    fn windows(&self) -> Result<Vec<WindowIdentity>, Fault> {
        if !trusted() {
            return Err(Fault::Permission);
        }
        let all = XWindow::all().map_err(|error| Fault::Failed(error.to_string()))?;
        Ok(all.iter().filter_map(identity).collect())
    }

    fn walk(&self, window: &WindowIdentity, bounds: &Bounds) -> Result<Walk, Fault> {
        let (children, origin) = opened(window)?;
        walk(&Window { origin }, children, bounds)
    }

    fn act(
        &self,
        window: &WindowIdentity,
        path: &[Segment],
        admit: Admit<'_>,
        action: &Action,
    ) -> Result<(), ActFault> {
        self.act_guarded(window, path, admit, action, &|| true)
    }

    fn act_guarded(
        &self,
        window: &WindowIdentity,
        path: &[Segment],
        admit: Admit<'_>,
        action: &Action,
        before_dispatch: &dyn Fn() -> bool,
    ) -> Result<(), ActFault> {
        let (children, origin) = opened(window)?;
        let (element, _) = target(&Window { origin }, children, path, admit)?;
        if !before_dispatch() {
            return Err(ActFault::NotFound);
        }
        performed(perform(&element, action))
    }
}

#[cfg(test)]
mod tests {
    use accessibility_sys::AXValueCreate;
    use core_foundation::number::CFNumber;

    use super::*;

    fn ax<T>(kind: u32, value: &T) -> CFType {
        // SAFETY: `value` has the C layout `kind` names; the result is +1.
        unsafe {
            CFType::wrap_under_create_rule(
                AXValueCreate(kind, ptr::from_ref(value).cast()) as CFTypeRef
            )
        }
    }

    #[test]
    fn cf_values_convert_without_an_accessibility_grant() {
        assert!(
            matches!(raw(&CFString::new("AXButton").as_CFType()), Raw::Text(text) if text == "AXButton")
        );
        assert!(matches!(
            raw(&CFBoolean::true_value().as_CFType()),
            Raw::Flag(true)
        ));
        assert!(matches!(raw(&CFNumber::from(3).as_CFType()), Raw::Other));
        let point = Pair {
            first: 1.5,
            second: 2.0,
        };
        assert!(
            matches!(raw(&ax(kAXValueTypeCGPoint, &point)), Raw::Point(x, y) if (x, y) == (1.5, 2.0))
        );
        assert!(
            matches!(raw(&ax(kAXValueTypeCGSize, &point)), Raw::Size(w, h) if (w, h) == (1.5, 2.0))
        );
        let code: AXError = -25212;
        assert!(matches!(
            raw(&ax(kAXValueTypeAXError, &code)),
            Raw::Error(-25212)
        ));
        let empty: CFArray<CFType> = CFArray::from_CFTypes(&[]);
        assert!(matches!(raw(&empty.as_CFType()), Raw::Items(items) if items.is_empty()));
    }
}
