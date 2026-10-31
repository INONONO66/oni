use oni_machine_client::screen::{
    ax::{linux::Native, ActFault, Action, Admit, Bounds, Observer, Segment, Walk, WindowIdentity},
    private::Focused,
    Fault, Screen,
};

/// The synthetic fixture window has ordinary focus; its inventory and
/// unsupported accessibility operations still use the native X11 observer.
struct Ordinary(Native);

impl Observer for Ordinary {
    fn focused(&self, _: &WindowIdentity) -> Result<Option<Focused>, Fault> {
        Ok(Some(Focused {
            role: "AXButton".into(),
            secure: false,
        }))
    }

    fn windows(&self) -> Result<Vec<WindowIdentity>, Fault> {
        self.0.windows()
    }

    fn walk(&self, window: &WindowIdentity, bounds: &Bounds) -> Result<Walk, Fault> {
        self.0.walk(window, bounds)
    }

    fn act(
        &self,
        window: &WindowIdentity,
        path: &[Segment],
        admit: Admit<'_>,
        action: &Action,
    ) -> Result<(), ActFault> {
        self.0.act(window, path, admit, action)
    }
}

pub fn screen(screen: Screen, display: &str) -> Screen {
    screen.observing(Box::new(Ordinary(Native(Some(display.into())))))
}
