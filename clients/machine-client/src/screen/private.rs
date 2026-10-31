use std::{collections::HashMap, time::Duration};

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

#[derive(Default)]
pub struct States(HashMap<(u64, u64, Option<u64>), bool>);

impl States {
    pub fn update(&mut self, target: Target, private: bool) -> Option<Edge> {
        match self
            .0
            .insert((target.pid, target.window_id, target.epoch), private)
        {
            Some(previous) if previous != private => {
                Some(if private { Edge::Entered } else { Edge::Left })
            }
            None if private => Some(Edge::Entered),
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
        assert_eq!(states.update(target, false), None);
        assert_eq!(states.update(target, true), Some(Edge::Entered));
        assert_eq!(states.update(target, true), None);
        assert_eq!(states.update(target, false), Some(Edge::Left));
        assert_eq!(
            states.update(
                Target {
                    epoch: Some(3),
                    ..target
                },
                true
            ),
            Some(Edge::Entered)
        );
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
