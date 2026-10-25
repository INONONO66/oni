use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    num::NonZeroU64,
    os::fd::OwnedFd,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use oni_protocol::{
    fs_result::FsResultRefusedReason,
    fs_stream_request::{FsStreamRequestExclusiveCreate, FsStreamRequestExclusiveMode},
    fs_stream_result::{
        FsStreamResultChunkData, FsStreamResultChunkDigest, FsStreamResultRefusedReason as Reason,
    },
    FsStreamRequest, FsStreamResult,
};
use rustix::fs::{self, AtFlags, Mode, OFlags, RenameFlags};
use sha2::{Digest, Sha256};

use super::{
    confine::{open_reason, target_kind, vacant, ExportRoot},
    stream_reason, stream_refusal, wire_size, MAX_OPEN_TRANSFERS, WRITE_MAX_BYTES,
};

#[derive(Debug)]
struct Destination {
    directory: OwnedFd,
    target: String,
    staged: String,
    exclusive: bool,
}

#[derive(Debug)]
enum TransferMode {
    Read,
    Write(Destination),
}

#[derive(Debug)]
pub(super) struct Transfer {
    file: File,
    mode: TransferMode,
    begin: String,
    size: u64,
    offset: u64,
    remaining: u64,
    seq: i64,
    digest: Sha256,
    terminal: bool,
    last_request: Option<(String, FsStreamResult)>,
}

impl Transfer {
    /// Bytes the idempotent-replay cache keeps: the serialized last request
    /// (a write carries its base64 chunk) and, for a read, the chunk it sent.
    pub(super) fn retained_bytes(&self) -> usize {
        self.last_request
            .as_ref()
            .map_or(0, |(key, result)| match result {
                FsStreamResult::Chunk { data, .. } => key.len() + data.len(),
                _ => key.len(),
            })
    }
}

struct Begin<'a> {
    id: &'a str,
    export: &'a str,
    path: &'a str,
    mode: FsStreamRequestExclusiveMode,
    exclusive: bool,
    offset: Option<i64>,
    limit: Option<NonZeroU64>,
    key: String,
}

type Opened = (File, TransferMode, u64, u64);

pub(super) fn execute(
    roots: &HashMap<String, ExportRoot>,
    transfers: &mut HashMap<String, Transfer>,
    request: &FsStreamRequest,
) -> FsStreamResult {
    match request {
        FsStreamRequest::Begin {
            transfer_id,
            export,
            path,
            mode,
            create,
            offset,
            limit,
        } => begin(
            roots,
            transfers,
            Begin {
                id: transfer_id,
                export,
                path,
                mode: *mode,
                exclusive: matches!(create, Some(FsStreamRequestExclusiveCreate::Exclusive)),
                offset: *offset,
                limit: *limit,
                key: serde_json::to_string(request).expect("typed request serializes"),
            },
        ),
        FsStreamRequest::Read { transfer_id, seq } => chunk(transfers, transfer_id, *seq, request),
        FsStreamRequest::Write {
            transfer_id, seq, ..
        } => chunk(transfers, transfer_id, *seq, request),
        FsStreamRequest::Finish { transfer_id } => finish(transfers, transfer_id),
        FsStreamRequest::Abort { transfer_id } => {
            if let Some(transfer) = transfers.remove(transfer_id.as_str()) {
                release(transfer, false);
            }
            FsStreamResult::Finished
        }
    }
}

fn begin(
    roots: &HashMap<String, ExportRoot>,
    transfers: &mut HashMap<String, Transfer>,
    request: Begin<'_>,
) -> FsStreamResult {
    if let Some(previous) = transfers.get(request.id) {
        return if previous.begin == request.key && previous.seq == 0 {
            FsStreamResult::Begun {
                seq: 0,
                size: wire_size(previous.size),
            }
        } else {
            stream_refusal(Reason::InvalidSequence)
        };
    }
    if transfers.len() >= MAX_OPEN_TRANSFERS {
        return stream_refusal(Reason::TooLarge);
    }
    let Some(root) = roots.get(request.export) else {
        return stream_refusal(Reason::ExportNotAvailable);
    };
    let opened = match request.mode {
        FsStreamRequestExclusiveMode::Read => open_read(root, request.path, request.offset),
        FsStreamRequestExclusiveMode::Write => {
            open_write(root, request.path, request.id, request.exclusive)
        }
    };
    let (file, mode, size, start) = match opened {
        Ok(value) => value,
        Err(reason) => return stream_refusal(stream_reason(reason)),
    };
    transfers.insert(
        request.id.to_owned(),
        Transfer {
            file,
            mode,
            begin: request.key,
            size,
            offset: start,
            remaining: size
                .saturating_sub(start)
                .min(request.limit.map_or(u64::MAX, NonZeroU64::get)),
            seq: 0,
            digest: Sha256::new(),
            terminal: false,
            last_request: None,
        },
    );
    FsStreamResult::Begun {
        seq: 0,
        size: wire_size(size),
    }
}

fn open_read(
    root: &ExportRoot,
    path: &str,
    offset: Option<i64>,
) -> Result<Opened, FsResultRefusedReason> {
    let file = root.target(path, OFlags::RDONLY)?;
    let metadata = file
        .metadata()
        .map_err(|_| FsResultRefusedReason::IoError)?;
    if !metadata.is_file() {
        return Err(FsResultRefusedReason::WrongKind);
    }
    let start = u64::try_from(offset.unwrap_or(0)).map_err(|_| FsResultRefusedReason::IoError)?;
    Ok((file, TransferMode::Read, metadata.len(), start))
}

fn open_write(
    root: &ExportRoot,
    path: &str,
    id: &str,
    exclusive: bool,
) -> Result<Opened, FsResultRefusedReason> {
    let (directory, target) = root.parent(path, !exclusive)?;
    if exclusive {
        vacant(&directory, &target)?;
    } else {
        target_kind(&directory, &target)?;
    }
    let staged = format!(
        ".oni-transfer-{}",
        &hex::encode(Sha256::digest(id.as_bytes()))[..32]
    );
    let fd = fs::openat(
        &directory,
        staged.as_str(),
        OFlags::WRONLY
            | OFlags::CREATE
            | OFlags::EXCL
            | OFlags::NOFOLLOW
            | OFlags::CLOEXEC
            | OFlags::NONBLOCK,
        Mode::RUSR | Mode::WUSR,
    )
    .map_err(open_reason)?;
    Ok((
        File::from(fd),
        TransferMode::Write(Destination {
            directory,
            target,
            staged,
            exclusive,
        }),
        0,
        0,
    ))
}

fn chunk(
    transfers: &mut HashMap<String, Transfer>,
    id: &str,
    seq: i64,
    request: &FsStreamRequest,
) -> FsStreamResult {
    let Some(transfer) = transfers.get_mut(id) else {
        return stream_refusal(Reason::TransferNotFound);
    };
    let key = serde_json::to_string(request).expect("typed request serializes");
    if seq == transfer.seq - 1 {
        return transfer
            .last_request
            .as_ref()
            .filter(|(previous, _)| previous == &key)
            .map_or_else(
                || stream_refusal(Reason::InvalidSequence),
                |(_, result)| result.clone(),
            );
    }
    if seq != transfer.seq || transfer.terminal {
        return stream_refusal(Reason::InvalidSequence);
    }
    let result = match (&transfer.mode, request) {
        (TransferMode::Read, FsStreamRequest::Read { .. }) => read_chunk(transfer, seq),
        (
            TransferMode::Write(_),
            FsStreamRequest::Write {
                data, digest, last, ..
            },
        ) => write_chunk(
            transfer,
            seq,
            data,
            digest.as_deref().map(String::as_str),
            *last,
        ),
        _ => stream_refusal(Reason::InvalidSequence),
    };
    if !matches!(result, FsStreamResult::Refused { .. }) {
        transfer.last_request = Some((key, result.clone()));
        transfer.seq += 1;
    }
    result
}

fn read_chunk(transfer: &mut Transfer, seq: i64) -> FsStreamResult {
    let count = transfer.remaining.min(WRITE_MAX_BYTES as u64);
    let mut data = vec![0; usize::try_from(count).expect("chunk bounded by WRITE_MAX_BYTES")];
    if transfer
        .file
        .seek(SeekFrom::Start(transfer.offset))
        .is_err()
        || transfer.file.read_exact(&mut data).is_err()
    {
        return stream_refusal(Reason::IoError);
    }
    transfer.digest.update(&data);
    transfer.offset += count;
    transfer.remaining -= count;
    let last = transfer.remaining == 0;
    transfer.terminal = last;
    let digest = if last {
        Some(
            FsStreamResultChunkDigest::try_from(hex::encode(transfer.digest.clone().finalize()))
                .expect("SHA-256 is 64 lowercase hex digits"),
        )
    } else {
        None
    };
    FsStreamResult::Chunk {
        data: FsStreamResultChunkData::try_from(BASE64.encode(data))
            .expect("base64 encoded chunk fits wire bound"),
        digest,
        last,
        seq,
    }
}

fn write_chunk(
    transfer: &mut Transfer,
    seq: i64,
    data: &str,
    digest: Option<&str>,
    last: bool,
) -> FsStreamResult {
    // The wire pattern admits non-canonical trailing bits the decoder refuses.
    let Ok(decoded) = BASE64.decode(data) else {
        return stream_refusal(Reason::IoError);
    };
    if decoded.len() > WRITE_MAX_BYTES {
        return stream_refusal(Reason::TooLarge);
    }
    if last != digest.is_some()
        || digest.is_some_and(|value| {
            value != hex::encode(transfer.digest.clone().chain_update(&decoded).finalize())
        })
    {
        return stream_refusal(Reason::DigestMismatch);
    }
    if transfer.file.write_all(&decoded).is_err() {
        return stream_refusal(Reason::IoError);
    }
    transfer.offset += decoded.len() as u64;
    transfer.digest.update(&decoded);
    transfer.terminal = last;
    FsStreamResult::Written {
        bytes_written: wire_size(transfer.offset),
        last,
        seq,
    }
}

fn finish(transfers: &mut HashMap<String, Transfer>, id: &str) -> FsStreamResult {
    let Some(transfer) = transfers.get(id) else {
        return stream_refusal(Reason::TransferNotFound);
    };
    if !transfer.terminal {
        return stream_refusal(Reason::InvalidSequence);
    }
    let transfer = transfers.remove(id).expect("terminal transfer exists");
    let published = match &transfer.mode {
        TransferMode::Write(destination) => publish(&transfer.file, destination),
        TransferMode::Read => Ok(()),
    };
    release(transfer, published.is_ok());
    match published {
        Ok(()) => FsStreamResult::Finished,
        Err(reason) => stream_refusal(reason),
    }
}

/// Exclusive publication never replaces a leaf created after begin; the
/// pinned parent also keeps a directory swap from redirecting it.
fn publish(file: &File, destination: &Destination) -> Result<(), Reason> {
    file.sync_all().map_err(|_| Reason::IoError)?;
    let flags = if destination.exclusive {
        RenameFlags::NOREPLACE
    } else {
        RenameFlags::empty()
    };
    fs::renameat_with(
        &destination.directory,
        destination.staged.as_str(),
        &destination.directory,
        destination.target.as_str(),
        flags,
    )
    .map_err(|error| match error {
        rustix::io::Errno::EXIST => Reason::AlreadyExists,
        _ => Reason::IoError,
    })
}

fn release(transfer: Transfer, published: bool) {
    if let TransferMode::Write(destination) = &transfer.mode {
        if !published {
            let _ = fs::unlinkat(
                &destination.directory,
                destination.staged.as_str(),
                AtFlags::empty(),
            );
        }
    }
}

pub(super) fn clear(transfers: &mut HashMap<String, Transfer>) {
    for (_, transfer) in transfers.drain() {
        release(transfer, false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transfer(file: File) -> Transfer {
        Transfer {
            file,
            mode: TransferMode::Read,
            begin: String::new(),
            size: 0,
            offset: 0,
            remaining: 0,
            seq: 0,
            digest: Sha256::new(),
            terminal: false,
            last_request: None,
        }
    }

    fn refused(result: FsStreamResult) -> Option<Reason> {
        match result {
            FsStreamResult::Refused { reason, .. } => Some(reason),
            _ => None,
        }
    }

    // The file-level io failure has no trigger through the driver; the other
    // outcomes run here too so this copy of write_chunk is fully exercised.
    #[test]
    fn write_chunk_refuses_without_advancing_offset_and_writes_otherwise() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let path = temp.path().join("file");
        std::fs::write(&path, []).expect("seed file");
        let data = BASE64.encode(b"data");
        let mut readonly = transfer(File::open(&path).expect("open fd"));
        let failed = write_chunk(&mut readonly, 0, &data, None, false);
        assert_eq!(refused(failed), Some(Reason::IoError));
        assert_eq!(readonly.offset, 0);
        let mut writable = transfer(File::create(&path).expect("create file"));
        let oversize = BASE64.encode(vec![0; WRITE_MAX_BYTES + 1]);
        let too_large = write_chunk(&mut writable, 0, &oversize, None, false);
        assert_eq!(refused(too_large), Some(Reason::TooLarge));
        let non_canonical = write_chunk(&mut writable, 0, "QR==", None, false);
        assert_eq!(refused(non_canonical), Some(Reason::IoError));
        let mismatch = write_chunk(&mut writable, 0, &data, None, true);
        assert_eq!(refused(mismatch), Some(Reason::DigestMismatch));
        assert_eq!(writable.offset, 0);
        let written = write_chunk(&mut writable, 0, &data, None, false);
        assert_eq!(refused(written), None);
        assert_eq!(writable.offset, 4);
        assert_eq!(std::fs::read(&path).expect("read back"), b"data");
    }
}
