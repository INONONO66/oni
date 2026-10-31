//! Every machine fixture exported by `packages/protocol` must parse into the
//! generated type its file name names: valid fixtures round-trip to the same
//! JSON value, invalid fixtures are refused.

use std::fs;
use std::path::{Path, PathBuf};

use oni_protocol::DecodeError;
use serde_json::Value;

const SCHEMA_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/protocol/schema/machine"
);
const FIXTURE_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/protocol/fixtures/machine"
);

/// Decodes `value` as the wire root named `name` before applying `on_valid`.
/// `None` means the name is not one of the generated types.
macro_rules! decode_by_name {
    ($name:expr, $value:expr, $on_valid:expr, [$($ty:ident,)*]) => {
        match $name {
            $(stringify!($ty) => Some(
                oni_protocol::decode::<oni_protocol::$ty>($value).map($on_valid),
            ),)*
            _ => None,
        }
    };
}

macro_rules! decode_fixture {
    ($name:expr, $value:expr, $on_valid:expr) => {
        decode_by_name!(
            $name,
            $value,
            $on_valid,
            [
                AbsolutePath,
                AgentPermissionDecision,
                AgentPermissionRequest,
                AgentSessionCursor,
                AgentSessionInfo,
                AgentSessionListRequest,
                AgentSessionListResult,
                AgentSessionOpenRequest,
                AgentSessionOpenResult,
                AgentSessionSendRequest,
                AgentSessionSendResult,
                AgentSessionStopRequest,
                AgentSessionStopResult,
                AgentSessionTailRequest,
                AgentSessionTailResult,
                AgentTranscriptRecord,
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
                EventHumanInput,
                EventLeaseRefused,
                EventPrivate,
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
                HumanInput,
                HumanInputNotification,
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
                PingResult,
                PlacementOutcome,
                PlacementRequest,
                PrivateEvent,
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
                Release,
                ReleaseArtifact,
                ReleaseResult,
                Request,
                Resources,
                Response,
                Screen,
                ScreenBlocker,
                ScreenReadRequest,
                ScreenReadResult,
                ScreenRegion,
                Session,
                ToolCall,
                ToolCallResult,
                TransportFacts,
                TransportFailureClass,
                WireMethod,
                // Computer use (#1662).
                ComputerCancelled,
                ComputerCloseRequest,
                ComputerCloseResult,
                ComputerExclusion,
                ComputerKeep,
                ComputerLease,
                ComputerRefusal,
                ComputerRequest,
                ComputerWindow,
                CdpChunk,
                CdpChunkResult,
                CdpCloseRequest,
                CdpCloseResult,
                CdpOpenRequest,
                CdpOpenResult,
                InputKeyRequest,
                InputPointerRequest,
                InputRequestId,
                InputStatusRequest,
                InputStatusResult,
                InputTextRequest,
                ScreenCaptureRequest,
                ScreenCaptureResult,
                ScreenDisplay,
                ScreenListRequest,
                ScreenListResult,
                ScreenWindow,
                StreamCloseRequest,
                StreamCloseResult,
                StreamId,
                StreamObservation,
                StreamOpenRequest,
                StreamOpenResult,
                StreamSignalRequest,
                StreamSignalResult,
                // Window-bound observation (#1689).
                AppIdentity,
                InputActionRequest,
                ObservedElement,
                ScreenObserveRequest,
                ScreenObserveResult,
                ScreenSettleRequest,
                ScreenSettleResult,
                WindowTarget,
                AppLaunchRequest,
                AppLaunchResult,
                AppQuitRequest,
                AppQuitResult,
                WindowCloseRequest,
                WindowCloseResult,
                WindowParkRequest,
                WindowParkResult,
            ]
        )
    };
}

fn index() -> Value {
    serde_json::from_reader(
        fs::File::open(Path::new(SCHEMA_DIR).join("index.json")).expect("open schema index"),
    )
    .expect("parse schema index")
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
            decode_fixture!(name, Value::Null, |_| ()).is_some(),
            "{name} is missing from the fixture match"
        );
    }
}

#[test]
fn valid_fixtures_round_trip() -> Result<(), Box<dyn std::error::Error>> {
    let valid = fixtures("valid");
    assert!(!valid.is_empty());
    for (name, path) in valid {
        let value: Value = serde_json::from_reader(fs::File::open(&path)?)?;
        match decode_fixture!(name.as_str(), value.clone(), |parsed| {
            serde_json::to_value(parsed).expect("wire shape serializes")
        }) {
            None => panic!("{}: unknown schema name {name}", path.display()),
            Some(Err(error)) => panic!("{}: refused: {error}", path.display()),
            Some(Ok(back)) => assert_eq!(back, value, "{} does not round-trip", path.display()),
        }
    }
    Ok(())
}

#[test]
fn invalid_fixtures_are_refused() -> Result<(), Box<dyn std::error::Error>> {
    let invalid = fixtures("invalid");
    assert!(!invalid.is_empty());
    for (name, path) in invalid {
        let value = serde_json::from_reader(fs::File::open(&path)?)?;
        assert!(
            matches!(
                decode_fixture!(name.as_str(), value, |_| ()),
                Some(Err(DecodeError::Schema { .. }))
            ),
            "{} must fail schema validation",
            path.display()
        );
    }
    Ok(())
}

#[test]
fn json_equality_distinguishes_adjacent_large_integers() {
    let left = serde_json::json!(9007199254740992_u64);
    let right = serde_json::json!(9007199254740993_u64);
    assert_ne!(left, right);
    assert_ne!(serde_json::json!(1), serde_json::json!(1.0));
    assert_eq!(
        oni_protocol::decode::<oni_protocol::ToolCallResult>(
            serde_json::json!({"status": "completed", "value": right.clone()})
        )
        .map(|parsed| serde_json::to_value(parsed).expect("wire shape serializes"))
        .expect("valid arbitrary JSON"),
        serde_json::json!({"status": "completed", "value": right})
    );
}
