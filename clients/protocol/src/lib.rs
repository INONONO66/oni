//! Machine wire contract types for oni clients.
//!
//! Shapes are generated from `packages/protocol/schema/machine/`.
//! Clients accept wire values only through [`decode`], which enforces the
//! embedded schema before deserializing the generated shape.

use std::fmt;

use serde::de::DeserializeOwned;

mod presence;

include!(concat!(env!("OUT_DIR"), "/machine.rs"));

/// A generated wire root with its embedded draft-07 validator.
pub trait WireRoot: DeserializeOwned {
    fn validator() -> &'static jsonschema::Validator;
}

/// A schema refusal or a mismatch between a schema and its generated shape.
#[derive(Debug)]
pub enum DecodeError {
    Schema {
        instance_path: String,
        message: String,
    },
    Shape(serde_json::Error),
}

impl fmt::Display for DecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Schema {
                instance_path,
                message,
            } => write!(formatter, "{instance_path}: {message}"),
            Self::Shape(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for DecodeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Schema { .. } => None,
            Self::Shape(error) => Some(error),
        }
    }
}

/// Validates a wire value against its root schema, then decodes its shape.
///
/// # Errors
/// Returns [`DecodeError::Schema`] for the first schema violation, or
/// [`DecodeError::Shape`] if the generated representation cannot decode it.
pub fn decode<T: WireRoot>(value: serde_json::Value) -> Result<T, DecodeError> {
    T::validator()
        .validate(&value)
        .map_err(|error| DecodeError::Schema {
            instance_path: error.instance_path().to_string(),
            message: error.to_string(),
        })?;
    serde_json::from_value(value).map_err(DecodeError::Shape)
}
