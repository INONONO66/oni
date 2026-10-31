use std::{fs, io, os::unix::fs::PermissionsExt, path::PathBuf};

use serde::{Deserialize, Serialize};

use crate::{
    config,
    screen::probe::{self, Blocker, Verdict},
};

const HOUR_MS: u64 = 3_600_000;
const MAX_RESTARTS: usize = 3;

#[derive(Default, Deserialize, Serialize)]
struct History {
    at: Vec<u64>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    None,
    Restart,
    Bound,
}

pub struct GrantRestart {
    path: PathBuf,
    denied: bool,
    blocked: bool,
}

impl GrantRestart {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            denied: false,
            blocked: false,
        }
    }

    pub fn tick(&mut self, screen: &mut Verdict, preflight: fn() -> bool, at: u64) -> Decision {
        let denied_now = screen
            .blockers
            .iter()
            .any(|blocker| blocker.kind == "screen_recording_denied");
        if !self.denied && !denied_now && !self.blocked {
            return Decision::None;
        }
        if !preflight() {
            self.denied = denied_now;
            self.blocked = false;
            return Decision::None;
        }
        if self.blocked {
            return self.bound(screen);
        }

        let mut history = match fs::read(&self.path) {
            Ok(bytes) => match serde_json::from_slice::<History>(&bytes) {
                Ok(history) => history,
                Err(_) => return self.bound(screen),
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => History::default(),
            Err(_) => return self.bound(screen),
        };
        history.at.retain(|&time| time <= at && at - time < HOUR_MS);
        let bound = history.at.len() >= MAX_RESTARTS;
        if bound {
            return self.bound(screen);
        }
        history.at.push(at);
        let saved = self.path.parent().map(|directory| {
            fs::create_dir_all(directory)
                .and_then(|()| fs::set_permissions(directory, fs::Permissions::from_mode(0o700)))
                .and_then(|()| serde_json::to_vec(&history).map_err(io::Error::other))
                .and_then(|bytes| config::write_private(&self.path, &bytes))
        });
        if !matches!(saved, Some(Ok(()))) {
            return self.bound(screen);
        }

        self.denied = false;
        screen
            .blockers
            .retain(|blocker| blocker.kind != "screen_recording_denied");
        screen.grants.capture = true;
        *screen = probe::fold(
            screen.display.clone(),
            screen.grants.clone(),
            screen.blockers.clone(),
        );
        Decision::Restart
    }

    fn bound(&mut self, screen: &mut Verdict) -> Decision {
        self.denied = false;
        self.blocked = true;
        screen
            .blockers
            .retain(|blocker| blocker.kind != "screen_recording_denied");
        screen.blockers.push(Blocker {
            kind: "restart_bound",
        });
        screen.grants.capture = true;
        *screen = probe::fold(
            screen.display.clone(),
            screen.grants.clone(),
            screen.blockers.clone(),
        );
        Decision::Bound
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn granted() -> bool {
        true
    }

    fn screen(denied: bool) -> Verdict {
        probe::fold(
            probe::Display {
                kind: "console",
                id: None,
                isolated: false,
            },
            probe::Grants {
                capture: !denied,
                accessibility: true,
                input: true,
            },
            if denied {
                vec![Blocker {
                    kind: "screen_recording_denied",
                }]
            } else {
                vec![]
            },
        )
    }

    #[test]
    fn grant_edge_flushes_updated_fact_and_records_restart() {
        let home = tempfile::tempdir().expect("isolated state");
        let path = home.path().join("state/grant-restarts.json");
        let mut restart = GrantRestart::new(path.clone());
        let mut denied = screen(true);
        assert_eq!(restart.tick(&mut denied, || false, 100), Decision::None);
        assert!(!denied.grants.capture);

        let mut granted = screen(false);
        assert_eq!(
            restart.tick(&mut granted, self::granted, 105),
            Decision::Restart
        );
        assert!(granted.grants.capture);
        assert!(granted.blockers.is_empty());
        assert_eq!(granted.verdict, "available");
        assert_eq!(
            serde_json::from_slice::<History>(&fs::read(path).expect("saved restarts"))
                .expect("valid history")
                .at,
            vec![105]
        );
    }

    #[test]
    fn three_persisted_restarts_in_one_hour_bound_the_next_process() {
        let home = tempfile::tempdir().expect("isolated state");
        let path = home.path().join("state/grant-restarts.json");
        for at in [100, 200, 300] {
            let mut restart = GrantRestart::new(path.clone());
            let mut denied = screen(true);
            assert_eq!(restart.tick(&mut denied, granted, at), Decision::Restart);
        }
        let mut restart = GrantRestart::new(path.clone());
        let mut denied = screen(true);
        assert_eq!(restart.tick(&mut denied, granted, 400), Decision::Bound);
        assert!(denied.grants.capture);
        assert_eq!(denied.verdict, "partial");
        assert_eq!(
            denied.blockers,
            vec![Blocker {
                kind: "restart_bound"
            }]
        );
        let mut next = screen(false);
        assert_eq!(restart.tick(&mut next, granted, 405), Decision::Bound);
        assert_eq!(
            next.blockers,
            vec![Blocker {
                kind: "restart_bound"
            }]
        );
        assert_eq!(
            serde_json::from_slice::<History>(&fs::read(&path).expect("history"))
                .expect("valid history")
                .at,
            vec![100, 200, 300]
        );

        let mut fresh = GrantRestart::new(path);
        let mut denied = screen(true);
        assert_eq!(
            fresh.tick(&mut denied, granted, HOUR_MS + 100),
            Decision::Restart
        );
    }

    #[test]
    fn no_denial_and_revoked_grant_never_restart() {
        let home = tempfile::tempdir().expect("isolated state");
        let path = home.path().join("state/grant-restarts.json");
        let mut restart = GrantRestart::new(path.clone());
        let mut granted = screen(false);
        assert_eq!(restart.tick(&mut granted, self::granted, 0), Decision::None);
        let mut denied = screen(true);
        assert_eq!(restart.tick(&mut denied, || false, 1), Decision::None);
        assert!(!path.exists());
    }

    #[test]
    fn malformed_history_keeps_reporting_restart_bound() {
        let home = tempfile::tempdir().expect("isolated state");
        let path = home.path().join("grant-restarts.json");
        fs::write(&path, b"{").expect("malformed history");
        let mut restart = GrantRestart::new(path);
        let mut report = screen(true);
        assert_eq!(restart.tick(&mut report, granted, 1), Decision::Bound);
        assert_eq!(
            report.blockers,
            vec![Blocker {
                kind: "restart_bound"
            }]
        );
    }

    #[test]
    fn unwritable_history_keeps_reporting_restart_bound() {
        let home = tempfile::tempdir().expect("isolated state");
        let mut restart = GrantRestart::new(home.path().join("missing/grant-restarts.json"));
        fs::write(home.path().join("missing"), b"not a directory").expect("blocked path");
        let mut report = screen(true);
        assert_eq!(restart.tick(&mut report, granted, 1), Decision::Bound);
        assert_eq!(
            report.blockers,
            vec![Blocker {
                kind: "restart_bound"
            }]
        );
    }

    #[test]
    fn missing_state_directory_keeps_reporting_restart_bound() {
        let mut restart = GrantRestart::new(PathBuf::new());
        let mut report = screen(true);
        assert_eq!(restart.tick(&mut report, granted, 1), Decision::Bound);
        assert_eq!(
            report.blockers,
            vec![Blocker {
                kind: "restart_bound"
            }]
        );
    }
}
