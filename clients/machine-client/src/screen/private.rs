use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use super::{
    ax::{Frame, Walk},
    observe::Target,
    Fault,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Focused {
    pub role: String,
    pub secure: bool,
}

pub fn focused(walk: &Walk) -> Option<Focused> {
    let attributes = &walk.nodes.get(walk.focused?)?.attributes;
    Some(Focused {
        role: attributes.role.clone(),
        secure: attributes.secure,
    })
}

pub fn focus_is_secure(focused: Result<Option<Focused>, Fault>) -> bool {
    match focused {
        Err(_) => true,
        Ok(None) => false,
        Ok(Some(focused)) => focused.secure || focused.role == "AXSecureTextField",
    }
}

pub fn focus_admits_input(focused: &Result<Option<Focused>, Fault>) -> bool {
    matches!(focused, Ok(Some(focused)) if !focused.secure && focused.role != "AXSecureTextField")
}

pub struct FocusRefresh {
    checked_at: Duration,
}

impl FocusRefresh {
    pub fn new(now: Duration) -> Self {
        Self { checked_at: now }
    }

    pub fn due(&mut self, now: Duration) -> bool {
        if now.saturating_sub(self.checked_at) < Duration::from_millis(250) {
            return false;
        }
        self.checked_at = now;
        true
    }

    pub fn next(&self) -> Duration {
        self.checked_at + Duration::from_millis(250)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Entered,
    Left,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    SecureFocus,
    SecureInputEnabled,
}

impl Reason {
    pub fn name(self) -> &'static str {
        match self {
            Self::SecureFocus => "secure_focus",
            Self::SecureInputEnabled => "secure_input_enabled",
        }
    }
}

#[derive(Default)]
pub struct SecureInput {
    checked_at: Option<Instant>,
    clear_reads: u8,
    active: bool,
}

impl SecureInput {
    pub fn refresh(&mut self, now: Instant, enabled: bool) -> bool {
        if enabled {
            self.active = true;
            self.clear_reads = 0;
            self.checked_at = Some(now);
        } else if self
            .checked_at
            .is_none_or(|at| now.saturating_duration_since(at) >= Duration::from_millis(250))
        {
            self.checked_at = Some(now);
            self.clear_reads = self.clear_reads.saturating_add(1);
            if self.clear_reads >= 2 {
                self.active = false;
            }
        }
        self.active
    }
}

#[cfg(target_os = "macos")]
#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn IsSecureEventInputEnabled() -> bool;
}

pub fn platform_secure_input_enabled() -> bool {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: HIToolbox exposes an argument-free query of the process-wide input state.
        unsafe { IsSecureEventInputEnabled() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[derive(Default)]
pub struct States(HashMap<(u64, u64, Option<u64>), Option<Reason>>);

impl States {
    pub fn update(&mut self, target: Target, reason: Option<Reason>) -> Option<(Edge, Reason)> {
        match self
            .0
            .insert((target.pid, target.window_id, target.epoch), reason)
        {
            Some(None) | None if reason.is_some() => Some((Edge::Entered, reason?)),
            Some(Some(previous)) if reason.is_none() => Some((Edge::Left, previous)),
            _ => None,
        }
    }
}

pub fn blank_rect(
    pixels: &mut [u8],
    frame_size: (u32, u32),
    display_size: (u32, u32),
    rect: Frame,
) {
    let scale = |value: i64, source: u32, target: u32, upper: bool| {
        let scaled = value.max(0) as u64 * u64::from(target);
        let pixels = if upper {
            scaled.div_ceil(u64::from(source))
        } else {
            scaled / u64::from(source)
        };
        pixels.min(u64::from(target)) as usize
    };
    let left = scale(rect.x, display_size.0, frame_size.0, false);
    let top = scale(rect.y, display_size.1, frame_size.1, false);
    let right = scale(rect.x + rect.width, display_size.0, frame_size.0, true);
    let bottom = scale(rect.y + rect.height, display_size.1, frame_size.1, true);
    for row in top..bottom {
        let start = (row * frame_size.0 as usize + left) * 4;
        let end = (row * frame_size.0 as usize + right) * 4;
        pixels[start..end].fill(0);
    }
}

pub fn overlaps(left: Frame, right: Frame) -> bool {
    left.x < right.x + right.width
        && right.x < left.x + left.width
        && left.y < right.y + right.height
        && right.y < left.y + left.height
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::ax::{Attributes, Node};

    #[test]
    fn focused_reads_the_named_node_and_refuses_an_absent_focus() {
        let walk = Walk {
            nodes: vec![Node {
                attributes: Attributes {
                    role: "AXSecureTextField".into(),
                    secure: true,
                    ..Attributes::default()
                },
                parent: None,
            }],
            focused: Some(0),
            complete: true,
        };
        assert_eq!(
            focused(&walk),
            Some(Focused {
                role: "AXSecureTextField".into(),
                secure: true,
            })
        );
        assert_eq!(
            focused(&Walk {
                focused: None,
                ..walk
            }),
            None
        );
    }

    #[test]
    fn secure_focus_fails_closed() {
        for (focused, private, admitted) in [
            (Err(Fault::Permission), true, false),
            (Ok(None), false, false),
            (
                Ok(Some(Focused {
                    role: "AXTextField".into(),
                    secure: true,
                })),
                true,
                false,
            ),
            (
                Ok(Some(Focused {
                    role: "AXSecureTextField".into(),
                    secure: false,
                })),
                true,
                false,
            ),
            (
                Ok(Some(Focused {
                    role: "AXButton".into(),
                    secure: false,
                })),
                false,
                true,
            ),
        ] {
            assert_eq!(focus_is_secure(focused.clone()), private);
            assert_eq!(focus_admits_input(&focused), admitted);
        }
    }

    #[test]
    fn blanks_only_scaled_rectangle() {
        let mut pixels = vec![255; 4 * 4 * 4];
        blank_rect(
            &mut pixels,
            (4, 4),
            (8, 8),
            Frame {
                x: 2,
                y: 2,
                width: 4,
                height: 4,
            },
        );
        assert_eq!(&pixels[20..28], &[0; 8]);
        assert_eq!(&pixels[..16], &[255; 16]);
    }

    #[test]
    fn blanks_every_partially_intersected_pixel_after_a_crop() {
        let mut pixels = vec![255; 3 * 3 * 4];
        blank_rect(
            &mut pixels,
            (3, 3),
            (2, 2),
            Frame {
                x: 0,
                y: 0,
                width: 1,
                height: 1,
            },
        );
        for row in 0..3 {
            for column in 0..3 {
                let pixel = &pixels[(row * 3 + column) * 4..(row * 3 + column + 1) * 4];
                assert_eq!(
                    pixel,
                    if row < 2 && column < 2 {
                        &[0; 4]
                    } else {
                        &[255; 4]
                    }
                );
            }
        }
    }

    #[test]
    fn overlap_requires_positive_area() {
        let window = Frame {
            x: 10,
            y: 20,
            width: 120,
            height: 80,
        };
        assert!(overlaps(
            window,
            Frame {
                x: 20,
                y: 30,
                width: 10,
                height: 10
            }
        ));
        assert!(!overlaps(
            window,
            Frame {
                x: 130,
                y: 20,
                width: 10,
                height: 10
            }
        ));
        assert!(!overlaps(
            window,
            Frame {
                x: 10,
                y: 100,
                width: 10,
                height: 10
            }
        ));
    }

    #[test]
    fn emits_only_private_state_edges() {
        let target = Target {
            pid: 7,
            window_id: 9,
            epoch: Some(2),
        };
        let mut states = States::default();
        assert_eq!(states.update(target, None), None);
        assert_eq!(
            states.update(target, Some(Reason::SecureFocus)),
            Some((Edge::Entered, Reason::SecureFocus))
        );
        assert_eq!(
            states.update(target, Some(Reason::SecureInputEnabled)),
            None
        );
        assert_eq!(
            states.update(target, None),
            Some((Edge::Left, Reason::SecureInputEnabled))
        );
        assert_eq!(
            states.update(
                Target {
                    epoch: Some(3),
                    ..target
                },
                Some(Reason::SecureFocus)
            ),
            Some((Edge::Entered, Reason::SecureFocus))
        );
    }

    #[test]
    fn system_secure_input_requires_two_distinct_clear_refreshes() {
        let start = Instant::now();
        let mut state = SecureInput::default();
        assert!(!state.refresh(start, false));
        assert!(state.refresh(start, true));
        assert!(state.refresh(start, false));
        assert!(state.refresh(start + Duration::from_millis(249), false));
        assert!(state.refresh(start + Duration::from_millis(250), false));
        assert!(state.refresh(start + Duration::from_millis(499), false));
        assert!(!state.refresh(start + Duration::from_millis(500), false));
        assert!(state.refresh(start + Duration::from_millis(501), true));
    }

    #[test]
    fn focus_refresh_is_due_each_quarter_second() {
        let mut refresh = FocusRefresh::new(Duration::from_millis(100));
        assert!(!refresh.due(Duration::from_millis(349)));
        assert!(refresh.due(Duration::from_millis(350)));
        assert!(!refresh.due(Duration::from_millis(599)));
        assert!(refresh.due(Duration::from_millis(600)));
    }
}
