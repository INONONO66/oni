//! Window accessibility trees (#1689). An [`Observer`] lists windows with
//! their owning process, walks one window's elements and performs an action
//! on one element addressed by its role path. The bounded walk and the path
//! resolver are shared here over a [`Tree`], so the headless [`fixture`]
//! and the native backend stop at the same bounds.

pub mod fixture;
#[cfg(target_os = "macos")]
pub mod native;
#[cfg(target_os = "macos")]
pub mod observer;

use std::{
    fmt,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use super::private::Focused;
use super::Fault;

/// The app that owns a window: its bundle id, if any, and executable path.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppIdentity {
    pub bundle_id: Option<String>,
    pub path: String,
}

/// `token` changes whenever the platform recreated the window under the
/// same id; `origin` is the window's top-left in global points, the origin
/// of its elements' window-local frames.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowIdentity {
    pub pid: u32,
    pub window_id: u32,
    pub owner_pid: u32,
    pub title: String,
    pub app: AppIdentity,
    pub token: u64,
    pub origin: (i64, i64),
    pub minimized: bool,
}

pub struct Bounds {
    pub max_elements: usize,
    pub max_visits: usize,
    pub budget: Duration,
}

/// A frame in window-local points.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

/// One element's attributes as the platform reports them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Attributes {
    pub role: String,
    pub label: Option<String>,
    pub value: Option<String>,
    pub actions: Vec<String>,
    pub frame: Frame,
    pub secure: bool,
    pub enabled: Option<bool>,
    pub selected: Option<bool>,
    pub checked: Option<bool>,
    pub expanded: Option<bool>,
    pub focused: bool,
}

/// A walked element; `parent` indexes an earlier node of the same walk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Node {
    pub attributes: Attributes,
    pub parent: Option<usize>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Walk {
    pub nodes: Vec<Node>,
    pub focused: Option<usize>,
    pub complete: bool,
}

/// One `role[index]` step: the `index`-th child whose role is `role`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Segment {
    pub role: String,
    pub index: usize,
}

impl fmt::Display for Segment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}[{}]", self.role, self.index)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Press,
    SetValue(String),
    Perform(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActFault {
    NotFound,
    Unsupported,
    Permission,
    Failed(String),
}

impl From<Fault> for ActFault {
    fn from(fault: Fault) -> Self {
        match fault {
            Fault::Permission => Self::Permission,
            Fault::WindowNotFound => Self::NotFound,
            Fault::Failed(message) => Self::Failed(message),
            other => Self::Failed(other.reason().to_owned()),
        }
    }
}

/// Whether an element the backend just resolved still carries the identity
/// it was observed with; the backend dispatches only on an admitted element.
pub type Admit<'a> = &'a dyn Fn(&Attributes) -> bool;

pub trait Observer: Send + Sync {
    fn lifecycle(&self, _: &WindowIdentity, _: bool) -> Result<(), ActFault> {
        Err(ActFault::Unsupported)
    }
    fn windows(&self) -> Result<Vec<WindowIdentity>, Fault>;
    fn walk(&self, window: &WindowIdentity, bounds: &Bounds) -> Result<Walk, Fault>;
    /// Resolves `path` once, asks `admit` about that element and performs
    /// `action` on that same element; an element `admit` refuses is
    /// `ActFault::NotFound` and nothing executes.
    fn focused(&self, window: &WindowIdentity) -> Result<Option<Focused>, Fault>;
    fn act(
        &self,
        window: &WindowIdentity,
        path: &[Segment],
        admit: Admit<'_>,
        action: &Action,
    ) -> Result<(), ActFault>;
    fn act_guarded(
        &self,
        window: &WindowIdentity,
        path: &[Segment],
        admit: Admit<'_>,
        action: &Action,
        before_dispatch: &dyn Fn() -> bool,
    ) -> Result<(), ActFault> {
        if !before_dispatch() {
            return Err(ActFault::NotFound);
        }
        self.act(window, path, admit, action)
    }
}

/// An element tree a backend reads one element at a time: each read is the
/// element's attributes and its children, or the fault that stopped it.
pub trait Tree {
    type Item;
    fn read(&self, item: &Self::Item) -> Result<(Attributes, Vec<Self::Item>), Fault>;
}

/// Depth-first, document order, from `roots`. Stops at `max_elements`
/// nodes, `max_visits` element reads or the time budget, whichever comes
/// first, and then reports `complete: false`; a failed read fails the walk.
pub fn walk<T: Tree>(tree: &T, roots: Vec<T::Item>, bounds: &Bounds) -> Result<Walk, Fault> {
    let deadline = Instant::now() + bounds.budget;
    let mut pending: Vec<(T::Item, Option<usize>)> =
        roots.into_iter().rev().map(|item| (item, None)).collect();
    let mut walk = Walk {
        nodes: Vec::new(),
        focused: None,
        complete: true,
    };
    while let Some((item, parent)) = pending.pop() {
        let limit = walk.nodes.len() == bounds.max_elements.min(bounds.max_visits);
        if limit || Instant::now() >= deadline {
            walk.complete = false;
            break;
        }
        let (attributes, children) = tree.read(&item)?;
        if attributes.focused {
            walk.focused = Some(walk.nodes.len());
        }
        let index = walk.nodes.len();
        walk.nodes.push(Node { attributes, parent });
        pending.extend(children.into_iter().rev().map(|child| (child, Some(index))));
    }
    Ok(walk)
}

/// The element `path` names below `roots` and its attributes, if every
/// step exists.
pub fn resolve<T: Tree>(
    tree: &T,
    roots: Vec<T::Item>,
    path: &[Segment],
) -> Result<Option<(T::Item, Attributes)>, Fault> {
    let mut items = roots;
    let mut found = None;
    for segment in path {
        let mut index = 0;
        let mut next = None;
        for item in items {
            let (attributes, children) = tree.read(&item)?;
            if slug(&attributes.role) != segment.role {
                continue;
            }
            if index == segment.index {
                next = Some((item, attributes, children));
                break;
            }
            index += 1;
        }
        let Some((item, attributes, children)) = next else {
            return Ok(None);
        };
        items = children;
        found = Some((item, attributes));
    }
    Ok(found)
}

/// The one element an action dispatches on: `path` resolved once below
/// `roots` and admitted by `admit`.
pub fn target<T: Tree>(
    tree: &T,
    roots: Vec<T::Item>,
    path: &[Segment],
    admit: Admit<'_>,
) -> Result<(T::Item, Attributes), ActFault> {
    resolve(tree, roots, path)?
        .filter(|(_, attributes)| admit(attributes))
        .ok_or(ActFault::NotFound)
}

const NO_VALUE: i32 = -25212;
const ATTRIBUTE_UNSUPPORTED: i32 = -25205;
const ACTION_UNSUPPORTED: i32 = -25206;
const NOT_IMPLEMENTED: i32 = -25208;
const API_DISABLED: i32 = -25211;
const INVALID_ELEMENT: i32 = -25202;

/// A failed AX read (`AXError` `code`): an attribute the element lacks
/// (no value, unsupported, not implemented) is `Ok`, a disabled API is
/// `Fault::Permission`, anything else a read failure.
pub fn absent(code: i32) -> Result<(), Fault> {
    match code {
        NO_VALUE | ATTRIBUTE_UNSUPPORTED | NOT_IMPLEMENTED => Ok(()),
        API_DISABLED => Err(Fault::Permission),
        other => Err(Fault::Failed(format!("AXError {other}"))),
    }
}

/// An AX call that must succeed: `0` is success, anything else a fault.
pub fn checked(code: i32) -> Result<(), Fault> {
    match code {
        0 => Ok(()),
        API_DISABLED => Err(Fault::Permission),
        other => Err(Fault::Failed(format!("AXError {other}"))),
    }
}

/// The outcome of performing an action or setting a value.
pub fn performed(code: i32) -> Result<(), ActFault> {
    match code {
        0 => Ok(()),
        API_DISABLED => Err(ActFault::Permission),
        ACTION_UNSUPPORTED | ATTRIBUTE_UNSUPPORTED => Err(ActFault::Unsupported),
        INVALID_ELEMENT => Err(ActFault::NotFound),
        other => Err(ActFault::Failed(format!("AXError {other}"))),
    }
}

/// The attributes one batched read asks every element for, in this order.
pub const ATTRIBUTES: [&str; 12] = [
    "AXRole",
    "AXSubrole",
    "AXTitle",
    "AXDescription",
    "AXValue",
    "AXPosition",
    "AXSize",
    "AXEnabled",
    "AXSelected",
    "AXExpanded",
    "AXFocused",
    "AXChildren",
];
const SECURE_SUBROLE: &str = "AXSecureTextField";

/// One attribute value as the backend converted it; `Error` carries the
/// `AXError` a batched read reported in that attribute's place.
#[derive(Clone, Debug, PartialEq)]
pub enum Raw<I> {
    Text(String),
    Flag(bool),
    Point(f64, f64),
    Size(f64, f64),
    Items(Vec<I>),
    Error(i32),
    Other,
}

/// The items of an element-array read: an absent attribute has none.
pub fn items<I>(raw: Option<Raw<I>>) -> Result<Vec<I>, Fault> {
    match raw {
        Some(Raw::Items(items)) => Ok(items),
        Some(Raw::Error(code)) => absent(code).map(|()| Vec::new()),
        _ => Ok(Vec::new()),
    }
}

/// Folds one element's batched read (`values` in [`ATTRIBUTES`] order) and
/// its action-name read into its attributes and children. Positions are
/// made local to `origin`; an attribute the element lacks is absent and any
/// other read error fails the element.
pub fn assemble<I>(
    values: Vec<Raw<I>>,
    actions: Result<Vec<String>, i32>,
    origin: (f64, f64),
) -> Result<(Attributes, Vec<I>), Fault> {
    let mut slots: Vec<Option<Raw<I>>> = Vec::with_capacity(ATTRIBUTES.len());
    for value in values {
        if let Raw::Error(code) = value {
            absent(code)?;
            slots.push(None);
        } else {
            slots.push(Some(value));
        }
    }
    slots.resize_with(ATTRIBUTES.len(), || None);
    let actions = match actions {
        Ok(names) => names,
        Err(code) => absent(code).map(|()| Vec::new())?,
    };
    let mut take = |at: usize| slots[at].take();
    let text = |raw: Option<Raw<I>>| match raw {
        Some(Raw::Text(text)) => Some(text),
        _ => None,
    };
    let flag = |raw: Option<Raw<I>>| match raw {
        Some(Raw::Flag(flag)) => Some(flag),
        _ => None,
    };
    let role = text(take(0)).unwrap_or_default();
    let secure = text(take(1)).as_deref() == Some(SECURE_SUBROLE);
    let title = text(take(2)).filter(|title| !title.is_empty());
    let label = title.or_else(|| text(take(3)));
    let value = text(take(4));
    let (x, y) = match take(5) {
        Some(Raw::Point(x, y)) => (x, y),
        _ => origin,
    };
    let (width, height) = match take(6) {
        Some(Raw::Size(width, height)) => (width, height),
        _ => (0.0, 0.0),
    };
    let attributes = Attributes {
        role,
        label,
        value,
        actions,
        frame: Frame {
            x: (x - origin.0).round() as i64,
            y: (y - origin.1).round() as i64,
            width: width.round() as i64,
            height: height.round() as i64,
        },
        secure,
        enabled: flag(take(7)),
        selected: flag(take(8)),
        checked: None,
        expanded: flag(take(9)),
        focused: flag(take(10)).unwrap_or(false),
    };
    Ok((attributes, items(take(11))?))
}

/// A role as a ref step spells it: without the `/`, `[` and `]` the
/// grammar reserves, at most 128 characters.
pub fn slug(role: &str) -> String {
    role.chars()
        .filter(|character| !matches!(character, '/' | '[' | ']'))
        .take(128)
        .collect()
}

/// The `.app` bundle directory that encloses an executable path, if any.
pub fn bundle_root(path: &str) -> Option<&str> {
    path.find(".app/").map(|at| &path[..at + 4])
}

/// Parses a wire ref (`role[i]/role[i]`) into its steps.
pub fn segments(reference: &str) -> Option<Vec<Segment>> {
    reference
        .split('/')
        .map(|step| {
            let (role, index) = step.strip_suffix(']')?.rsplit_once('[')?;
            Some(Segment {
                role: role.to_owned(),
                index: index.parse().ok()?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::{
        cell::Cell,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use super::*;

    struct DefaultGuard(AtomicUsize);

    impl Observer for DefaultGuard {
        fn windows(&self) -> Result<Vec<WindowIdentity>, Fault> {
            Ok(Vec::new())
        }

        fn focused(&self, _: &WindowIdentity) -> Result<Option<Focused>, Fault> {
            Ok(None)
        }

        fn walk(&self, _: &WindowIdentity, _: &Bounds) -> Result<Walk, Fault> {
            Ok(Walk {
                nodes: Vec::new(),
                focused: None,
                complete: true,
            })
        }

        fn act(
            &self,
            _: &WindowIdentity,
            _: &[Segment],
            _: Admit<'_>,
            _: &Action,
        ) -> Result<(), ActFault> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[test]
    fn default_guard_refuses_before_dispatch_and_delegates_after_admission() {
        let observer = DefaultGuard(AtomicUsize::new(0));
        let window = WindowIdentity {
            pid: 7,
            window_id: 9,
            owner_pid: 7,
            title: "Editor".into(),
            app: fixture::fixture_app(7),
            token: 0,
            origin: (0, 0),
            minimized: false,
        };
        let path = segments("AXButton[0]").expect("a ref");
        assert_eq!(observer.windows().expect("no windows"), Vec::new());
        let walk = observer
            .walk(&window, &bounds(8, Duration::from_millis(50)))
            .expect("empty walk");
        assert!(walk.nodes.is_empty() && walk.focused.is_none() && walk.complete);
        assert_eq!(
            observer.act_guarded(&window, &path, &|_| true, &Action::Press, &|| false),
            Err(ActFault::NotFound)
        );
        assert_eq!(observer.0.load(Ordering::SeqCst), 0);
        assert_eq!(
            observer.act_guarded(&window, &path, &|_| true, &Action::Press, &|| true),
            Ok(())
        );
        assert_eq!(observer.0.load(Ordering::SeqCst), 1);
    }

    #[derive(Clone)]
    struct Item {
        role: &'static str,
        focused: bool,
        children: Vec<Item>,
    }

    /// Fails the read of every item whose role is `failing`.
    struct Items {
        failing: &'static str,
    }

    const ITEMS: Items = Items { failing: "" };

    impl Tree for Items {
        type Item = Item;
        fn read(&self, item: &Item) -> Result<(Attributes, Vec<Item>), Fault> {
            if item.role == self.failing {
                return Err(Fault::Failed("read".into()));
            }
            let attributes = Attributes {
                role: item.role.to_owned(),
                focused: item.focused,
                ..Attributes::default()
            };
            Ok((attributes, item.children.clone()))
        }
    }

    fn leaf(role: &'static str) -> Item {
        Item {
            role,
            focused: false,
            children: Vec::new(),
        }
    }

    fn roots() -> Vec<Item> {
        let mut field = leaf("AXTextField");
        field.focused = true;
        vec![Item {
            role: "AXGroup",
            focused: false,
            children: vec![leaf("AXButton"), leaf("AXButton"), field],
        }]
    }

    fn bounds(max_elements: usize, budget: Duration) -> Bounds {
        Bounds {
            max_elements,
            max_visits: 5000,
            budget,
        }
    }

    #[test]
    fn walks_depth_first_with_parents_and_focus() {
        let walk = walk(&ITEMS, roots(), &bounds(10, Duration::from_secs(5))).expect("walk");
        let roles: Vec<_> = walk
            .nodes
            .iter()
            .map(|node| (node.attributes.role.as_str(), node.parent))
            .collect();
        assert_eq!(
            roles,
            [
                ("AXGroup", None),
                ("AXButton", Some(0)),
                ("AXButton", Some(0)),
                ("AXTextField", Some(0))
            ]
        );
        assert_eq!((walk.focused, walk.complete), (Some(3), true));
    }

    #[test]
    fn element_and_time_bounds_cut_the_walk_and_a_failed_read_fails_it() {
        let cut = walk(&ITEMS, roots(), &bounds(2, Duration::from_secs(5))).expect("walk");
        assert_eq!((cut.nodes.len(), cut.complete), (2, false));
        let late = walk(&ITEMS, roots(), &bounds(10, Duration::ZERO)).expect("walk");
        assert_eq!((late.nodes.len(), late.complete), (0, false));
        let failing = Items {
            failing: "AXTextField",
        };
        assert_eq!(
            walk(&failing, roots(), &bounds(10, Duration::from_secs(5))),
            Err(Fault::Failed("read".into()))
        );
    }

    #[test]
    fn resolves_role_paths_by_same_role_index() {
        let path = segments("AXGroup[0]/AXButton[1]").expect("a ref");
        assert_eq!(path[1].to_string(), "AXButton[1]");
        let (found, attributes) = resolve(&ITEMS, roots(), &path)
            .expect("read")
            .expect("the second button");
        assert_eq!(
            (found.role, attributes.role.as_str()),
            ("AXButton", "AXButton")
        );
        let missing = segments("AXGroup[0]/AXButton[2]").expect("a ref");
        assert!(resolve(&ITEMS, roots(), &missing).expect("read").is_none());
        assert!(resolve(&ITEMS, roots(), &[]).expect("read").is_none());
        let failing = Items {
            failing: "AXButton",
        };
        assert_eq!(
            resolve(&failing, roots(), &path).err(),
            Some(Fault::Failed("read".into()))
        );
    }

    #[test]
    fn a_target_is_resolved_once_and_admitted_by_its_identity() {
        let path = segments("AXGroup[0]/AXTextField[0]").expect("a ref");
        let asked = Cell::new(0);
        let admit = |attributes: &Attributes| {
            asked.set(asked.get() + 1);
            attributes.focused
        };
        let (found, _) = target(&ITEMS, roots(), &path, &admit).expect("admitted");
        assert_eq!((found.role, asked.get()), ("AXTextField", 1));
        let button = segments("AXGroup[0]/AXButton[0]").expect("a ref");
        assert_eq!(
            target(&ITEMS, roots(), &button, &admit).err(),
            Some(ActFault::NotFound)
        );
        let failing = Items { failing: "AXGroup" };
        assert_eq!(
            target(&failing, roots(), &button, &admit).err(),
            Some(ActFault::Failed("read".into()))
        );
    }

    #[test]
    fn faults_map_onto_action_faults() {
        assert_eq!(ActFault::from(Fault::Permission), ActFault::Permission);
        assert_eq!(ActFault::from(Fault::WindowNotFound), ActFault::NotFound);
        assert_eq!(
            ActFault::from(Fault::Failed("x".into())),
            ActFault::Failed("x".into())
        );
        assert_eq!(
            ActFault::from(Fault::Absent),
            ActFault::Failed("screen_not_available".into())
        );
    }

    #[test]
    fn ax_errors_classify_absent_attributes_apart_from_failures() {
        for code in [NO_VALUE, ATTRIBUTE_UNSUPPORTED, NOT_IMPLEMENTED] {
            assert_eq!(absent(code), Ok(()));
        }
        assert_eq!(absent(API_DISABLED), Err(Fault::Permission));
        assert_eq!(
            absent(INVALID_ELEMENT),
            Err(Fault::Failed("AXError -25202".into()))
        );
        assert_eq!(checked(0), Ok(()));
        assert_eq!(checked(API_DISABLED), Err(Fault::Permission));
        assert_eq!(
            checked(NO_VALUE),
            Err(Fault::Failed("AXError -25212".into()))
        );
        assert_eq!(performed(0), Ok(()));
        assert_eq!(performed(API_DISABLED), Err(ActFault::Permission));
        assert_eq!(performed(ACTION_UNSUPPORTED), Err(ActFault::Unsupported));
        assert_eq!(performed(ATTRIBUTE_UNSUPPORTED), Err(ActFault::Unsupported));
        assert_eq!(performed(INVALID_ELEMENT), Err(ActFault::NotFound));
        assert_eq!(
            performed(-25204),
            Err(ActFault::Failed("AXError -25204".into()))
        );
    }

    fn batch(values: &[(usize, Raw<u8>)]) -> Vec<Raw<u8>> {
        let mut all = vec![Raw::Error(NO_VALUE); ATTRIBUTES.len()];
        for (at, value) in values {
            all[*at] = value.clone();
        }
        all
    }

    #[test]
    fn a_batched_read_assembles_local_attributes_and_children() {
        let values = batch(&[
            (0, Raw::Text("AXTextField".into())),
            (1, Raw::Text("AXSecureTextField".into())),
            (2, Raw::Text(String::new())),
            (3, Raw::Text("Password".into())),
            (4, Raw::Text("hunter2".into())),
            (5, Raw::Point(110.4, 60.6)),
            (6, Raw::Size(40.5, 20.0)),
            (7, Raw::Flag(true)),
            (8, Raw::Other),
            (9, Raw::Flag(false)),
            (10, Raw::Flag(true)),
            (11, Raw::Items(vec![1, 2])),
        ]);
        let (attributes, children) =
            assemble(values, Ok(vec!["AXConfirm".into()]), (100.0, 50.0)).expect("assembled");
        assert_eq!(
            attributes,
            Attributes {
                role: "AXTextField".into(),
                label: Some("Password".into()),
                value: Some("hunter2".into()),
                actions: vec!["AXConfirm".into()],
                frame: Frame {
                    x: 10,
                    y: 11,
                    width: 41,
                    height: 20
                },
                secure: true,
                enabled: Some(true),
                selected: None,
                checked: None,
                expanded: Some(false),
                focused: true,
            }
        );
        assert_eq!(children, vec![1, 2]);

        let titled = batch(&[
            (2, Raw::Text("OK".into())),
            (3, Raw::Text("ignored".into())),
        ]);
        let (attributes, children) =
            assemble(titled, Err(NO_VALUE), (5.0, 5.0)).expect("absent values");
        assert_eq!(
            (attributes.label.as_deref(), attributes.role.as_str()),
            (Some("OK"), "")
        );
        assert_eq!(
            (attributes.frame, attributes.focused),
            (Frame::default(), false)
        );
        assert!(attributes.actions.is_empty() && children.is_empty());
        let short = assemble::<u8>(Vec::new(), Ok(Vec::new()), (0.0, 0.0)).expect("short");
        assert_eq!(short.0, Attributes::default());
    }

    #[test]
    fn a_failed_read_in_a_batch_fails_the_element() {
        let denied = batch(&[(4, Raw::Error(API_DISABLED))]);
        assert_eq!(
            assemble(denied, Ok(Vec::new()), (0.0, 0.0)).err(),
            Some(Fault::Permission)
        );
        let failed = batch(&[(11, Raw::Error(-25204))]);
        assert_eq!(
            assemble(failed, Ok(Vec::new()), (0.0, 0.0)).err(),
            Some(Fault::Failed("AXError -25204".into()))
        );
        assert_eq!(
            assemble(batch(&[]), Err(-25204), (0.0, 0.0)).err(),
            Some(Fault::Failed("AXError -25204".into()))
        );
        assert_eq!(items::<u8>(None), Ok(Vec::new()));
        assert_eq!(items::<u8>(Some(Raw::Other)), Ok(Vec::new()));
        assert_eq!(items(Some(Raw::Items(vec![3_u8]))), Ok(vec![3]));
        assert_eq!(items::<u8>(Some(Raw::Error(NO_VALUE))), Ok(Vec::new()));
        assert_eq!(
            items::<u8>(Some(Raw::Error(API_DISABLED))),
            Err(Fault::Permission)
        );
    }

    #[test]
    fn refuses_malformed_refs_and_slugs_reserved_characters() {
        assert_eq!(segments("AXButton"), None);
        assert_eq!(segments("AXButton[x]"), None);
        assert_eq!(segments("AXButton0]"), None);
        assert_eq!(slug("AX/Odd[Role]"), "AXOddRole");
        assert_eq!(slug(&"r".repeat(200)).len(), 128);
    }

    #[test]
    fn an_executable_inside_a_bundle_names_the_bundle_root() {
        assert_eq!(
            bundle_root("/Applications/Editor.app/Contents/MacOS/Editor"),
            Some("/Applications/Editor.app")
        );
        assert_eq!(bundle_root("/usr/bin/vim"), None);
    }
}
