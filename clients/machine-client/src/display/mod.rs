use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub kind: String,
    pub width: u16,
    pub height: u16,
    pub dpi: u16,
    pub window_manager: Option<Manager>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manager {
    pub path: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("display_unavailable")]
    Unavailable,
}

pub fn validate(config: &Config, binary_present: bool) -> Result<(), Error> {
    if config.kind == "xvfb"
        && config.width > 0
        && config.height > 0
        && config.dpi > 0
        && binary_present
    {
        Ok(())
    } else {
        Err(Error::Unavailable)
    }
}

#[cfg(target_os = "linux")]
pub mod xvfb;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_each_invalid_virtual_display_configuration() {
        let valid = Config {
            kind: "xvfb".into(),
            width: 100,
            height: 80,
            dpi: 96,
            window_manager: None,
        };
        assert!(validate(&valid, true).is_ok());
        assert!(matches!(validate(&valid, false), Err(Error::Unavailable)));
        assert!(matches!(
            validate(
                &Config {
                    kind: "other".into(),
                    ..valid.clone()
                },
                true
            ),
            Err(Error::Unavailable)
        ));
        assert!(matches!(
            validate(
                &Config {
                    width: 0,
                    ..valid.clone()
                },
                true
            ),
            Err(Error::Unavailable)
        ));
        assert!(matches!(
            validate(
                &Config {
                    height: 0,
                    ..valid.clone()
                },
                true
            ),
            Err(Error::Unavailable)
        ));
        assert!(matches!(
            validate(&Config { dpi: 0, ..valid }, true),
            Err(Error::Unavailable)
        ));
    }
}
