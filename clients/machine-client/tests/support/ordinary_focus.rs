use oni_machine_client::screen::{
    ax::{
        ActFault, Action, Admit, AppIdentity, Attributes, Bounds, Node, Observer, Segment, Walk,
        WindowIdentity,
    },
    Fault, Screen, Source,
};

struct OrdinaryFocus {
    window_ids: Vec<u32>,
}

impl Observer for OrdinaryFocus {
    fn focused(
        &self,
        _: &WindowIdentity,
    ) -> Result<Option<oni_machine_client::screen::private::Focused>, Fault> {
        Ok(Some(oni_machine_client::screen::private::Focused {
            role: "AXButton".into(),
            secure: false,
        }))
    }
    fn windows(&self) -> Result<Vec<WindowIdentity>, Fault> {
        Ok(self
            .window_ids
            .iter()
            .map(|&window_id| WindowIdentity {
                pid: 1,
                window_id,
                owner_pid: 1,
                title: "Fixture".into(),
                app: AppIdentity {
                    bundle_id: None,
                    path: "/fixture".into(),
                },
                token: 0,
                origin: (0, 0),
                minimized: false,
            })
            .collect())
    }

    fn walk(&self, _: &WindowIdentity, _: &Bounds) -> Result<Walk, Fault> {
        Ok(Walk {
            nodes: vec![Node {
                attributes: Attributes {
                    role: "AXButton".into(),
                    focused: true,
                    ..Default::default()
                },
                parent: None,
            }],
            focused: Some(0),
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
        Err(ActFault::Unsupported)
    }
}

pub fn screen(source: impl Source + 'static, captures: usize, window_ids: &[u32]) -> Screen {
    Screen::new(Box::new(source), captures).observing(Box::new(OrdinaryFocus {
        window_ids: window_ids.to_vec(),
    }))
}
