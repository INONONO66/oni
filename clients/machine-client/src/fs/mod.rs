mod confine;
mod op;
mod stream;

use std::{collections::HashMap, path::PathBuf};

use oni_protocol::{
    fs_result::{FsResultRefusedMessage, FsResultRefusedReason},
    fs_stream_result::{FsStreamResultRefusedMessage, FsStreamResultRefusedReason},
    FsRequest, FsResult, FsStreamRequest, FsStreamResult,
};

use confine::ExportRoot;
use stream::Transfer;

pub const READ_MAX_BYTES: usize = 262_144;
pub const WRITE_MAX_BYTES: usize = 262_144;
const LIST_MAX_ENTRIES: usize = 1_000;
const MAX_OPEN_TRANSFERS: usize = 32;

#[derive(Debug, thiserror::Error)]
pub enum FsError {
    #[error("cannot open filesystem export {name}: {source}")]
    OpenExport {
        name: String,
        source: std::io::Error,
    },
}

#[derive(Debug)]
pub struct FsDriver {
    roots: HashMap<String, ExportRoot>,
    transfers: HashMap<String, Transfer>,
}

impl FsDriver {
    pub fn open(exports: impl IntoIterator<Item = (String, PathBuf)>) -> Result<Self, FsError> {
        let mut roots = HashMap::new();
        for (name, path) in exports {
            let root = ExportRoot::open(&path).map_err(|source| FsError::OpenExport {
                name: name.clone(),
                source,
            })?;
            roots.insert(name, root);
        }
        Ok(Self {
            roots,
            transfers: HashMap::new(),
        })
    }

    pub fn execute(&self, request: &FsRequest) -> FsResult {
        op::execute(&self.roots, request)
    }

    pub fn stream(&mut self, request: &FsStreamRequest) -> FsStreamResult {
        stream::execute(&self.roots, &mut self.transfers, request)
    }

    /// Open transfers, each holding a file descriptor and its replay cache.
    pub fn retained(&self) -> usize {
        self.transfers.len()
    }

    /// Bytes held in memory by the open transfers' replay caches.
    pub fn retained_bytes(&self) -> usize {
        self.transfers.values().map(Transfer::retained_bytes).sum()
    }

    pub fn abort_all(&mut self) {
        stream::clear(&mut self.transfers);
    }
}

impl Drop for FsDriver {
    fn drop(&mut self) {
        self.abort_all();
    }
}

fn refusal(reason: FsResultRefusedReason) -> FsResult {
    let message =
        FsResultRefusedMessage::try_from(reason.to_string()).expect("refusal reason is nonempty");
    FsResult::Refused { message, reason }
}

fn stream_refusal(reason: FsStreamResultRefusedReason) -> FsStreamResult {
    let message = FsStreamResultRefusedMessage::try_from(reason.to_string())
        .expect("refusal reason is nonempty");
    FsStreamResult::Refused { message, reason }
}

fn stream_reason(reason: FsResultRefusedReason) -> FsStreamResultRefusedReason {
    match reason {
        FsResultRefusedReason::ExportNotAvailable => {
            FsStreamResultRefusedReason::ExportNotAvailable
        }
        FsResultRefusedReason::PathEscapesExport => FsStreamResultRefusedReason::PathEscapesExport,
        FsResultRefusedReason::NotFound => FsStreamResultRefusedReason::NotFound,
        FsResultRefusedReason::WrongKind => FsStreamResultRefusedReason::WrongKind,
        FsResultRefusedReason::IoError => FsStreamResultRefusedReason::IoError,
        FsResultRefusedReason::TooLarge => FsStreamResultRefusedReason::TooLarge,
        FsResultRefusedReason::AmbiguousExport => FsStreamResultRefusedReason::AmbiguousExport,
        FsResultRefusedReason::MachineNotAttached => {
            FsStreamResultRefusedReason::MachineNotAttached
        }
        FsResultRefusedReason::FsNotAvailable => FsStreamResultRefusedReason::FsNotAvailable,
        FsResultRefusedReason::AlreadyExists => FsStreamResultRefusedReason::AlreadyExists,
    }
}

fn wire_size(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_refusal_conversion_covers_all_operation_reasons() {
        for reason in [
            FsResultRefusedReason::ExportNotAvailable,
            FsResultRefusedReason::PathEscapesExport,
            FsResultRefusedReason::NotFound,
            FsResultRefusedReason::WrongKind,
            FsResultRefusedReason::IoError,
            FsResultRefusedReason::TooLarge,
            FsResultRefusedReason::AmbiguousExport,
            FsResultRefusedReason::MachineNotAttached,
            FsResultRefusedReason::FsNotAvailable,
            FsResultRefusedReason::AlreadyExists,
        ] {
            assert_eq!(stream_reason(reason).to_string(), reason.to_string());
        }
    }
}
