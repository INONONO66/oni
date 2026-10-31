use super::{ActFault, Action, Admit, Bounds, Observer, Segment, Walk, WindowIdentity};
use crate::screen::{Fault, Source};

pub struct Native(pub Option<String>);

impl Observer for Native {
    fn focused(
        &self,
        _: &WindowIdentity,
    ) -> Result<Option<crate::screen::private::Focused>, Fault> {
        Err(Fault::Absent)
    }

    fn windows(&self) -> Result<Vec<WindowIdentity>, Fault> {
        let source = crate::screen::x11::Native::open(self.0.as_deref())?;
        Ok(source
            .windows()?
            .into_iter()
            .filter_map(|window| {
                let pid = window.pid?;
                let app = window.app?;
                Some(WindowIdentity {
                    pid,
                    window_id: window.id,
                    owner_pid: pid,
                    title: window.title,
                    app,
                    token: u64::from(window.id),
                    origin: (i64::from(window.x), i64::from(window.y)),
                    minimized: false,
                })
            })
            .collect())
    }
    fn walk(&self, _: &WindowIdentity, _: &Bounds) -> Result<Walk, Fault> {
        Err(Fault::Absent)
    }
    fn act(
        &self,
        _: &WindowIdentity,
        _: &[Segment],
        _: Admit<'_>,
        _: &Action,
    ) -> Result<(), ActFault> {
        Err(ActFault::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_observer_refuses_unimplemented_walk_and_action() {
        let observer = Native(None);
        let window = WindowIdentity {
            pid: 1,
            owner_pid: 1,
            window_id: 1,
            title: String::new(),
            app: super::super::AppIdentity {
                bundle_id: None,
                path: "/bin/sh".into(),
            },
            token: 1,
            origin: (0, 0),
            minimized: false,
        };
        let bounds = Bounds {
            max_elements: 10,
            max_visits: 10,
            budget: std::time::Duration::from_secs(1),
        };
        assert_eq!(observer.walk(&window, &bounds), Err(Fault::Absent));
        assert_eq!(observer.focused(&window), Err(Fault::Absent));
        assert_eq!(
            observer.act(&window, &[], &|_| true, &Action::Press),
            Err(ActFault::Unsupported)
        );
    }
}
