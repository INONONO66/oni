use std::error::Error;

use oni_protocol::{decode, DecodeError, PtyResizeRequest, WireRoot};
use serde::Deserialize;
use serde_json::json;

#[test]
fn schema_refusal_retains_the_first_error_and_instance_path() {
    let value = json!({"name": "build", "cols": 1001, "rows": 24});

    let error = decode::<PtyResizeRequest>(value).expect_err("cols exceeds maximum");

    let DecodeError::Schema {
        instance_path,
        message,
    } = &error
    else {
        panic!("schema refusal must precede shape decoding");
    };
    assert_eq!(instance_path, "/cols");
    assert_eq!(message, "1001 is greater than the maximum of 1000");
    assert_eq!(error.to_string(), format!("{instance_path}: {message}"));
    assert!(error.source().is_none());
}

// Deliberately mismatched with the real root's schema to exercise generation
// drift: schema acceptance must not disguise a serde shape failure.
#[derive(Debug, Deserialize)]
struct IncompatibleShape;

impl WireRoot for IncompatibleShape {
    fn validator() -> &'static jsonschema::Validator {
        PtyResizeRequest::validator()
    }
}

#[test]
fn schema_shape_mismatch_retains_the_serde_error() {
    let value = json!({"name": "build", "cols": 1000, "rows": 24});

    let error = decode::<IncompatibleShape>(value).expect_err("shape differs from schema");

    let DecodeError::Shape(source) = &error else {
        panic!("schema-valid data must reach the shape decoder");
    };
    assert!(source.is_data());
    assert_eq!(error.to_string(), source.to_string());
    assert_eq!(
        error
            .source()
            .expect("serde source is retained")
            .to_string(),
        source.to_string()
    );
}
