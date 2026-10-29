use std::{fs, path::PathBuf, sync::mpsc::Sender};

use oni_protocol::{app_launch_request::AppLaunchRequestApp, AppLaunchRequest};
use serde::Deserialize;
use serde_json::json;

use super::{Fault, Launcher, Resolved};
use crate::computer::append;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct App {
    pub bundle_id: Option<String>,
    pub path: Option<String>,
    pub pid: u32,
    #[serde(default)]
    pub windows: Vec<u32>,
}

#[derive(Deserialize)]
struct Layout {
    #[serde(default)]
    apps: Vec<App>,
}

pub struct Scripted {
    pub layout: PathBuf,
    pub recorder: PathBuf,
}

impl Scripted {
    fn apps(&self) -> Result<Vec<App>, Fault> {
        let text = fs::read(&self.layout).map_err(|error| Fault::Failed(error.to_string()))?;
        let layout: Layout =
            serde_json::from_slice(&text).map_err(|error| Fault::Failed(error.to_string()))?;
        Ok(layout.apps)
    }
}

impl Launcher for Scripted {
    fn resolve(&self, request: &AppLaunchRequest) -> Result<Resolved, Fault> {
        let app = self
            .apps()?
            .into_iter()
            .find(|app| match &request.app {
                AppLaunchRequestApp::Variant0 { bundle_id } => {
                    app.bundle_id.as_deref() == Some(bundle_id.as_str())
                }
                AppLaunchRequestApp::Variant1 { path, .. } => {
                    app.path.as_deref() == Some(path.as_str())
                }
            })
            .ok_or(Fault::NotFound)?;
        Ok(Resolved {
            identity: crate::screen::ax::AppIdentity {
                bundle_id: app.bundle_id,
                path: app
                    .path
                    .clone()
                    .unwrap_or_else(|| format!("/fixture/{}", app.pid)),
            },
            running_pid: Some(app.pid),
            bundle_path: app.path.unwrap_or_else(|| format!("/fixture/{}", app.pid)),
        })
    }
    fn identity(&self, pid: u32) -> Result<crate::screen::ax::AppIdentity, Fault> {
        let app = self
            .apps()?
            .into_iter()
            .find(|app| app.pid == pid)
            .ok_or(Fault::ProcessNotFound)?;
        Ok(crate::screen::ax::AppIdentity {
            bundle_id: app.bundle_id,
            path: app.path.unwrap_or_else(|| format!("/fixture/{pid}")),
        })
    }
    fn start(
        &self,
        request: &AppLaunchRequest,
        resolved: &Resolved,
        reply: Sender<Result<u32, Fault>>,
    ) -> Result<(), Fault> {
        let pid = resolved.running_pid.ok_or(Fault::NotFound)?;
        append(&self.recorder, &json!({"kind":"app_launch","pid":pid,"activate":false,"freshInstance":request.fresh_instance.unwrap_or(false)}))
            .map_err(|error| Fault::Failed(error.to_string()))?;
        reply
            .send(Ok(pid))
            .map_err(|error| Fault::Failed(error.to_string()))
    }

    fn quit(&self, pid: u32) -> Result<bool, Fault> {
        if !self.apps()?.iter().any(|app| app.pid == pid) {
            return Err(Fault::ProcessNotFound);
        }
        append(&self.recorder, &json!({"kind":"app_quit","pid":pid}))
            .map_err(|error| Fault::Failed(error.to_string()))?;
        Ok(true)
    }
}
