use std::sync::mpsc::Sender;

use block2::RcBlock;
use core_foundation::{bundle::CFBundle, url::CFURL};
use objc2::rc::Retained;
use objc2_app_kit::{NSRunningApplication, NSWorkspace, NSWorkspaceOpenConfiguration};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSString, NSURL};
use oni_protocol::{app_launch_request::AppLaunchRequestApp, AppLaunchRequest};

use super::{Fault, Launcher, Resolved};

pub struct Native;

fn configuration(request: &AppLaunchRequest) -> Retained<NSWorkspaceOpenConfiguration> {
    let config = NSWorkspaceOpenConfiguration::configuration();
    config.setActivates(false);
    config.setHides(false);
    config.setCreatesNewApplicationInstance(request.fresh_instance.unwrap_or(false));
    config.setPromptsUserIfNeeded(false);
    let arguments = match &request.app {
        AppLaunchRequestApp::Variant0 { .. } => Vec::new(),
        AppLaunchRequestApp::Variant1 { args, .. } => args
            .iter()
            .flatten()
            .map(|value| NSString::from_str(value))
            .collect(),
    };
    config.setArguments(&NSArray::from_retained_slice(&arguments));
    let (keys, values): (Vec<_>, Vec<_>) = request
        .env
        .iter()
        .flat_map(|env| env.iter())
        .map(|(key, value)| {
            (
                NSString::from_str(&key.to_string()),
                NSString::from_str(value),
            )
        })
        .unzip();
    let keys: Vec<_> = keys.iter().map(|key| &**key).collect();
    config.setEnvironment(&NSDictionary::from_retained_objects(&keys, &values));
    config
}

fn running_pid(workspace: &NSWorkspace, bundle_path: &str) -> Option<u32> {
    let running: Vec<u32> = workspace
        .runningApplications()
        .iter()
        .filter_map(|app| {
            let path = std::fs::canonicalize(app.bundleURL()?.path()?.to_string()).ok()?;
            (path == std::path::Path::new(bundle_path))
                .then(|| u32::try_from(app.processIdentifier()).ok())
                .flatten()
        })
        .collect();
    running
        .iter()
        .copied()
        .find(|pid| *pid == std::process::id())
        .or_else(|| running.first().copied())
}

impl Launcher for Native {
    fn resolve(&self, request: &AppLaunchRequest) -> Result<Resolved, Fault> {
        let workspace = NSWorkspace::sharedWorkspace();
        let url = match &request.app {
            AppLaunchRequestApp::Variant0 { bundle_id } => workspace
                .URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle_id))
                .ok_or(Fault::NotFound)?,
            AppLaunchRequestApp::Variant1 { path, .. } => {
                NSURL::fileURLWithPath(&NSString::from_str(path))
            }
        };
        let bundle_path = std::fs::canonicalize(url.path().ok_or(Fault::NotFound)?.to_string())
            .map_err(|_| Fault::NotFound)?
            .to_string_lossy()
            .into_owned();
        let bundle = CFBundle::new(CFURL::from_path(&bundle_path, true).ok_or(Fault::NotFound)?)
            .ok_or(Fault::NotFound)?;
        let executable = bundle
            .executable_url()
            .and_then(|url| url.to_path())
            .ok_or(Fault::NotFound)?;
        let identity = crate::screen::ax::AppIdentity {
            bundle_id: bundle
                .info_dictionary()
                .find(core_foundation::string::CFString::new("CFBundleIdentifier"))
                .and_then(|id| id.downcast::<core_foundation::string::CFString>())
                .map(|id| id.to_string()),
            path: executable.to_string_lossy().into_owned(),
        };
        let running_pid = running_pid(&workspace, &bundle_path);
        Ok(Resolved {
            identity,
            running_pid,
            bundle_path,
        })
    }
    fn identity(&self, pid: u32) -> Result<crate::screen::ax::AppIdentity, Fault> {
        crate::screen::ax::native::app(pid).ok_or(Fault::ProcessNotFound)
    }
    fn start(
        &self,
        request: &AppLaunchRequest,
        resolved: &Resolved,
        reply: Sender<Result<u32, Fault>>,
    ) -> Result<(), Fault> {
        let workspace = NSWorkspace::sharedWorkspace();
        let url = NSURL::fileURLWithPath(&NSString::from_str(&resolved.bundle_path));
        let config = configuration(request);
        let completed = RcBlock::new(move |app: *mut NSRunningApplication, error: *mut NSError| {
            // SAFETY: AppKit supplies nullable objects that remain alive during this completion.
            let error =
                unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string());
            // SAFETY: the successful completion supplies a live application for this callback.
            let pid =
                unsafe { app.as_ref() }.and_then(|app| u32::try_from(app.processIdentifier()).ok());
            let result = super::completion(pid, error);
            if let Err(error) = reply.send(result) {
                eprintln!("launch completion receiver closed: {error}");
            }
        });
        workspace.openApplicationAtURL_configuration_completionHandler(
            &url,
            &config,
            Some(&completed),
        );
        Ok(())
    }

    fn quit(&self, pid: u32) -> Result<bool, Fault> {
        use nix::{
            sys::signal::{kill, Signal},
            unistd::Pid,
        };
        let pid = Pid::from_raw(i32::try_from(pid).map_err(|_| Fault::ProcessNotFound)?);
        super::termination(&super::SystemClock, |terminate| {
            kill(pid, terminate.then_some(Signal::SIGTERM))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn launch_configuration_never_activates_hides_or_prompts() {
        for fresh in [false, true] {
            let request = oni_protocol::decode(json!({
                "app": {"path": "/Applications/Fixture.app", "args": ["--check"]},
                "activate": false, "freshInstance": fresh, "env": {"LANG": "C"}
            }))
            .expect("request");
            let config = configuration(&request);
            assert!(!config.activates());
            assert!(!config.hides());
            assert!(!config.promptsUserIfNeeded());
            assert_eq!(config.createsNewApplicationInstance(), fresh);
            assert_eq!(config.arguments().count(), 1);
            assert_eq!(config.environment().count(), 1);
        }
    }
}
