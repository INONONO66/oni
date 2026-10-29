use super::{Driver, Event};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Route {
    Foreground,
    Background(u32),
}

#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    ForegroundRequired,
}

pub struct Plan<'a> {
    pub route: Route,
    pub events: &'a [Event],
}

impl<'a> Plan<'a> {
    pub fn classify(
        route: Route,
        events: &'a [Event],
        pid_delivery: bool,
    ) -> Result<Self, Refusal> {
        if matches!(route, Route::Background(_))
            && (!pid_delivery
                || events
                    .iter()
                    .any(|event| !matches!(event, Event::Key { .. } | Event::Text(_))))
        {
            return Err(Refusal::ForegroundRequired);
        }
        Ok(Self { route, events })
    }
}

pub fn post(driver: &mut dyn Driver, route: Route, event: &Event) -> Result<(), String> {
    match route {
        Route::Foreground => driver.inject(event),
        Route::Background(pid) => driver.post_to_pid(pid, event),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::{Button, Key};

    #[test]
    fn classifies_every_event_before_dispatch() {
        let events = [
            Event::Text("hello".into()),
            Event::Key {
                key: Key::Char('x'),
                down: true,
            },
        ];
        let plan = Plan::classify(Route::Background(42), &events, true).expect("pid plan");
        assert_eq!(plan.route, Route::Background(42));
        assert_eq!(plan.events, events);
        assert!(matches!(
            Plan::classify(Route::Background(42), &events, false),
            Err(Refusal::ForegroundRequired)
        ));
        for pointer in [
            Event::Move {
                x: 1,
                y: 1,
                reference: None,
            },
            Event::Button {
                button: Button::Left,
                down: true,
                click: 1,
            },
            Event::Scroll {
                horizontal: false,
                delta: 1,
            },
        ] {
            let mixed = [Event::Text("hello".into()), pointer];
            assert!(matches!(
                Plan::classify(Route::Background(42), &mixed, true),
                Err(Refusal::ForegroundRequired)
            ));
            assert!(Plan::classify(Route::Foreground, &mixed, false).is_ok());
        }
    }
}
