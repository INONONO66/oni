//! Every machine fixture exported by `packages/protocol` must parse into the
//! generated type its file name names: valid fixtures round-trip to the same
//! JSON value, invalid fixtures are refused.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

const SCHEMA_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/protocol/schema/machine"
);
const FIXTURE_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/protocol/fixtures/machine"
);

/// Parses `value` as the generated type named `name` and serializes it back.
/// `None` means the name is not one of the generated types.
macro_rules! round_trip_by_name {
    ($name:expr, $value:expr, [$($ty:ident,)*]) => {
        match $name {
            $(stringify!($ty) => Some(
                serde_json::from_value::<oni_protocol::$ty>($value)
                    .map_err(|error| error.to_string())
                    .and_then(|parsed| serde_json::to_value(parsed).map_err(|error| error.to_string())),
            ),)*
            _ => None,
        }
    };
}

fn round_trip(name: &str, value: Value) -> Option<Result<Value, String>> {
    round_trip_by_name!(
        name,
        value,
        [
            AbsolutePath,
            AttachResult,
            CancelCode,
            CancelResult,
            CapabilityId,
            CapacityRow,
            CapacityRows,
            CellOutput,
            CellRequest,
            CellResult,
            CellState,
            CompletionRequest,
            Enrollment,
            EventAttached,
            EventDetached,
            EventEnrolled,
            EventLeaseRefused,
            EventPtyOutput,
            EventReported,
            EventUnenrolled,
            ExecRequest,
            ExecResult,
            ExportName,
            FsRequest,
            FsResult,
            FsStreamRequest,
            FsStreamResult,
            Info,
            InputAction,
            InputWriteRequest,
            InputWriteResult,
            KeyFingerprint,
            LeaseRefusal,
            Load,
            MachineId,
            Offer,
            PeekAnswer,
            PeekCode,
            PeekRefused,
            PeekResult,
            PlacementOutcome,
            PlacementRequest,
            PtyCloseRequest,
            PtyCloseResult,
            PtyCursor,
            PtyListRequest,
            PtyListResult,
            PtyOpenRequest,
            PtyOpenResult,
            PtyOutput,
            PtyReadParams,
            PtyReadRequest,
            PtyReadResult,
            PtyReadScreenRequest,
            PtyResizeRequest,
            PtyResizeResult,
            PtyScreenResult,
            PtySessionInfo,
            PtySessionName,
            PtyWriteRequest,
            PtyWriteResult,
            Report,
            ReportResult,
            Request,
            Resources,
            Response,
            ScreenReadRequest,
            ScreenReadResult,
            ScreenRegion,
            ToolCall,
            ToolCallResult,
            WireMethod,
        ]
    )
}

/// JSON value equality where numbers compare by value: a `number` field is an
/// `f64` in Rust, so a fixture's `1` serializes back as `1.0`.
fn same_json(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| same_json(left, right))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .all(|(key, value)| right.get(key).is_some_and(|other| same_json(value, other)))
        }
        _ => left == right,
    }
}

fn read_json(path: &Path) -> Value {
    let text =
        fs::read_to_string(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn index() -> Value {
    read_json(&Path::new(SCHEMA_DIR).join("index.json"))
}

/// Fixture files of one kind as (schema name, path), sorted by file name.
fn fixtures(kind: &str) -> Vec<(String, PathBuf)> {
    let dir = Path::new(FIXTURE_DIR).join(kind);
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("read {}: {error}", dir.display()))
        .map(|entry| entry.expect("directory entry").path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|path| {
            let file = path
                .file_name()
                .and_then(|file| file.to_str())
                .expect("utf-8 file name");
            let name = file
                .split('.')
                .next()
                .expect("schema name prefix")
                .to_owned();
            (name, path)
        })
        .collect()
}

#[test]
fn contract_version_matches_index() {
    assert_eq!(
        Some(u64::from(oni_protocol::CONTRACT_VERSION)),
        index()["contractVersion"].as_u64()
    );
}

#[test]
fn every_index_schema_has_a_generated_type() {
    let schemas = index()["schemas"]
        .as_array()
        .expect("schemas array")
        .clone();
    assert!(!schemas.is_empty());
    for schema in schemas {
        let name = schema["name"].as_str().expect("schema name");
        assert!(
            round_trip(name, Value::Null).is_some(),
            "{name} is missing from the fixture match"
        );
    }
}

#[test]
fn valid_fixtures_round_trip() {
    let valid = fixtures("valid");
    assert!(!valid.is_empty());
    for (name, path) in valid {
        let value = read_json(&path);
        match round_trip(&name, value.clone()) {
            None => panic!("{}: unknown schema name {name}", path.display()),
            Some(Err(error)) => panic!("{}: refused: {error}", path.display()),
            Some(Ok(back)) => assert!(
                same_json(&back, &value),
                "{} does not round-trip: {back} != {value}",
                path.display()
            ),
        }
    }
}

#[test]
fn invalid_fixtures_are_refused() {
    let invalid = fixtures("invalid");
    assert!(!invalid.is_empty());
    let mut accepted = Vec::new();
    for (name, path) in invalid {
        match round_trip(&name, read_json(&path)) {
            None => panic!("{}: unknown schema name {name}", path.display()),
            Some(Ok(parsed)) => accepted.push(format!("{}: accepted as {parsed}", path.display())),
            Some(Err(_)) => {}
        }
    }
    assert!(
        accepted.is_empty(),
        "invalid fixtures accepted:\n{}",
        accepted.join("\n")
    );
}
