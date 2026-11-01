use super::{Button, Event, Key, Named};

#[derive(Debug, PartialEq)]
pub enum Command {
    Mouse {
        kind: u32,
        button: u32,
        x: i32,
        y: i32,
        flags: u64,
        click: u32,
    },
    Scroll {
        x: i32,
        y: i32,
        flags: u64,
        position: (i32, i32),
    },
    Key {
        code: u16,
        down: bool,
        text: String,
        flags: u64,
    },
}

#[derive(Clone, Default)]
pub struct State {
    pub position: (i32, i32),
    flags: u64,
    buttons: Vec<Button>,
}

const NAMED: [(Named, u16); 19] = [
    (Named::Enter, 36),
    (Named::Tab, 48),
    (Named::Escape, 53),
    (Named::Backspace, 51),
    (Named::Delete, 117),
    (Named::Space, 49),
    (Named::ArrowUp, 126),
    (Named::ArrowDown, 125),
    (Named::ArrowLeft, 123),
    (Named::ArrowRight, 124),
    (Named::Home, 115),
    (Named::End, 119),
    (Named::PageUp, 116),
    (Named::PageDown, 121),
    (Named::CapsLock, 57),
    (Named::Shift, 56),
    (Named::Control, 59),
    (Named::Alt, 58),
    (Named::Meta, 55),
];
const FUNCTION: [u16; 12] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111];

pub fn keycode(key: Key) -> u16 {
    match key {
        Key::Char(_) => 0,
        Key::Named(Named::F(number)) => FUNCTION[usize::from(number.clamp(1, 12)) - 1],
        Key::Named(named) => NAMED
            .iter()
            .find(|(name, _)| *name == named)
            .map_or(0, |(_, code)| *code),
    }
}

pub fn layout_code(text: &str, keys: &[(u16, String)]) -> Option<u16> {
    keys.iter()
        .find(|(_, value)| value == text)
        .map(|(code, _)| *code)
}

pub fn resolved_code(
    command: &Command,
    keys: Option<&[(u16, String)]>,
) -> Result<u16, &'static str> {
    match command {
        Command::Key { text, flags, .. } if !text.is_empty() && *flags != 0 => keys
            .and_then(|keys| layout_code(text, keys))
            .ok_or("key absent from active keyboard layout"),
        Command::Key { code, .. } => Ok(*code),
        _ => Err("not a key command"),
    }
}

fn modifier(key: Key) -> u64 {
    match key {
        Key::Named(Named::Shift) => 1 << 17,
        Key::Named(Named::Control) => 1 << 18,
        Key::Named(Named::Alt) => 1 << 19,
        Key::Named(Named::Meta) => 1 << 20,
        Key::Named(Named::CapsLock) => 1 << 16,
        _ => 0,
    }
}

impl State {
    pub fn commands(&mut self, event: &Event) -> Vec<Command> {
        match event {
            Event::Move { x, y, .. } => {
                self.position = (*x, *y);
                let kind = match self.buttons.last() {
                    Some(Button::Left) => 6,
                    Some(Button::Right) => 7,
                    Some(Button::Middle) => 27,
                    None => 5,
                };
                vec![Command::Mouse {
                    kind,
                    button: 0,
                    x: *x,
                    y: *y,
                    flags: self.flags,
                    click: 0,
                }]
            }
            Event::Button {
                button,
                down,
                click,
            } => {
                self.buttons.retain(|held| held != button);
                if *down {
                    self.buttons.push(*button);
                }
                let (code, pressed, released) = match button {
                    Button::Left => (0, 1, 2),
                    Button::Right => (1, 3, 4),
                    Button::Middle => (2, 25, 26),
                };
                vec![Command::Mouse {
                    kind: if *down { pressed } else { released },
                    button: code,
                    x: self.position.0,
                    y: self.position.1,
                    flags: self.flags,
                    click: *click,
                }]
            }
            Event::Scroll { horizontal, delta } => {
                vec![Command::Scroll {
                    x: if *horizontal { *delta } else { 0 },
                    y: if *horizontal { 0 } else { *delta },
                    flags: self.flags,
                    position: self.position,
                }]
            }
            Event::Key { key, down } => {
                let flag = modifier(*key);
                if *down {
                    self.flags |= flag;
                } else {
                    self.flags &= !flag;
                }
                let text = match key {
                    Key::Char(character) => character.to_string(),
                    Key::Named(_) => String::new(),
                };
                vec![Command::Key {
                    code: keycode(*key),
                    down: *down,
                    text,
                    flags: self.flags,
                }]
            }
            Event::Text(text) => text
                .chars()
                .flat_map(|character| {
                    [true, false].map(|down| Command::Key {
                        code: match character {
                            '\n' => 36,
                            '\t' => 48,
                            _ => 0,
                        },
                        down,
                        text: match character {
                            '\n' | '\t' => String::new(),
                            _ => character.to_string(),
                        },
                        flags: 0,
                    })
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_named_keycodes_are_distinct() {
        let mut codes: Vec<_> = NAMED
            .iter()
            .map(|(key, _)| keycode(Key::Named(*key)))
            .chain((1..=12).map(|n| keycode(Key::Named(Named::F(n)))))
            .collect();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), 31);
        assert_eq!(keycode(Key::Char('한')), 0);
        assert_eq!(keycode(Key::Named(Named::F(0))), 122);
        assert_eq!(keycode(Key::Named(Named::F(99))), 111);
        assert_eq!(layout_code("c", &[(8, "c".into())]), Some(8));
        assert_eq!(layout_code("x", &[(8, "c".into())]), None);
    }

    #[test]
    fn native_commands_preserve_pointer_buttons_and_scroll() {
        let mut state = State::default();
        assert_eq!(
            state.commands(&Event::Move {
                x: 4,
                y: 5,
                reference: None
            }),
            vec![Command::Mouse {
                kind: 5,
                button: 0,
                x: 4,
                y: 5,
                flags: 0,
                click: 0,
            }]
        );
        for (button, code, press, release, drag) in [
            (Button::Left, 0, 1, 2, 6),
            (Button::Right, 1, 3, 4, 7),
            (Button::Middle, 2, 25, 26, 27),
        ] {
            assert_eq!(
                state.commands(&Event::Button {
                    button,
                    down: true,
                    click: 1
                }),
                vec![Command::Mouse {
                    kind: press,
                    button: code,
                    x: 4,
                    y: 5,
                    flags: 0,
                    click: 1,
                }]
            );
            assert_eq!(
                state.commands(&Event::Move {
                    x: 4,
                    y: 5,
                    reference: None
                }),
                vec![Command::Mouse {
                    kind: drag,
                    button: 0,
                    x: 4,
                    y: 5,
                    flags: 0,
                    click: 0,
                }]
            );
            assert_eq!(
                state.commands(&Event::Button {
                    button,
                    down: false,
                    click: 1,
                }),
                vec![Command::Mouse {
                    kind: release,
                    button: code,
                    x: 4,
                    y: 5,
                    flags: 0,
                    click: 1,
                }]
            );
        }
        assert_eq!(
            state.commands(&Event::Scroll {
                horizontal: true,
                delta: 2
            }),
            vec![Command::Scroll {
                x: 2,
                y: 0,
                flags: 0,
                position: (4, 5),
            }]
        );
        assert_eq!(
            state.commands(&Event::Scroll {
                horizontal: false,
                delta: 3
            }),
            vec![Command::Scroll {
                x: 0,
                y: 3,
                flags: 0,
                position: (4, 5),
            }]
        );
    }

    #[test]
    fn native_commands_preserve_unicode_and_modifiers() {
        let mut state = State::default();
        for (key, flag) in [
            (Named::Shift, 1 << 17),
            (Named::Control, 1 << 18),
            (Named::Alt, 1 << 19),
            (Named::Meta, 1 << 20),
            (Named::CapsLock, 1 << 16),
        ] {
            state.commands(&Event::Key {
                key: Key::Named(key),
                down: true,
            });
            assert_eq!(state.flags, flag);
            state.commands(&Event::Key {
                key: Key::Named(key),
                down: false,
            });
            assert_eq!(state.flags, 0);
        }
        assert_eq!(
            state.commands(&Event::Key {
                key: Key::Char('é'),
                down: true
            }),
            vec![Command::Key {
                code: 0,
                down: true,
                text: "é".into(),
                flags: 0
            }]
        );
        assert_eq!(
            state.commands(&Event::Text("한".into())),
            vec![
                Command::Key {
                    code: 0,
                    down: true,
                    text: "한".into(),
                    flags: 0
                },
                Command::Key {
                    code: 0,
                    down: false,
                    text: "한".into(),
                    flags: 0
                },
            ]
        );
        assert_eq!(
            state.commands(&Event::Text("\n\t".into())),
            vec![
                Command::Key {
                    code: 36,
                    down: true,
                    text: String::new(),
                    flags: 0
                },
                Command::Key {
                    code: 36,
                    down: false,
                    text: String::new(),
                    flags: 0
                },
                Command::Key {
                    code: 48,
                    down: true,
                    text: String::new(),
                    flags: 0
                },
                Command::Key {
                    code: 48,
                    down: false,
                    text: String::new(),
                    flags: 0
                },
            ]
        );
    }

    #[test]
    fn modifier_flags_follow_pointer_scroll_and_release_per_route() {
        let mut foreground = State::default();
        let mut background = State::default();
        foreground.commands(&Event::Key {
            key: Key::Named(Named::Shift),
            down: true,
        });
        assert!(
            matches!(foreground.commands(&Event::Move { x: 2, y: 3, reference: None })[0],
            Command::Mouse { flags, .. } if flags == 1 << 17)
        );
        assert!(
            matches!(foreground.commands(&Event::Scroll { horizontal: false, delta: 1 })[0],
            Command::Scroll { flags, .. } if flags == 1 << 17)
        );
        assert!(matches!(
            background.commands(&Event::Move {
                x: 2,
                y: 3,
                reference: None
            })[0],
            Command::Mouse { flags: 0, .. }
        ));
        foreground.commands(&Event::Key {
            key: Key::Named(Named::Shift),
            down: false,
        });
        assert!(matches!(
            foreground.commands(&Event::Move {
                x: 2,
                y: 3,
                reference: None
            })[0],
            Command::Mouse { flags: 0, .. }
        ));
    }

    #[test]
    fn explicit_double_click_retains_both_down_and_up_ordinals() {
        let mut state = State::default();
        for (click, down, kind) in [(1, true, 1), (1, false, 2), (2, true, 1), (2, false, 2)] {
            assert_eq!(
                state.commands(&Event::Button {
                    button: Button::Left,
                    down,
                    click,
                }),
                vec![Command::Mouse {
                    kind,
                    button: 0,
                    x: 0,
                    y: 0,
                    flags: 0,
                    click,
                }]
            );
        }
    }

    #[test]
    fn modified_character_requires_one_sampled_layout_before_dispatch() {
        let command = Command::Key {
            code: 0,
            down: true,
            text: "x".into(),
            flags: 1 << 17,
        };
        assert_eq!(resolved_code(&command, Some(&[(7, "x".into())])), Ok(7));
        assert!(resolved_code(&command, Some(&[(7, "z".into())])).is_err());
        assert!(resolved_code(&command, None).is_err());
        assert_eq!(
            resolved_code(
                &Command::Key {
                    code: 36,
                    down: true,
                    text: String::new(),
                    flags: 0,
                },
                None,
            ),
            Ok(36)
        );
        assert!(resolved_code(
            &Command::Scroll {
                x: 0,
                y: 1,
                flags: 0,
                position: (0, 0),
            },
            None
        )
        .is_err());
    }
}
