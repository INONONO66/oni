use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom, Write},
    num::NonZeroU64,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use oni_protocol::{
    fs_request::FsRequestExclusiveCreate,
    fs_result::{
        FsResultCompletedValue as Value, FsResultCompletedValueListEntriesItem as Entry,
        FsResultCompletedValueListEntriesItemKind as Kind,
        FsResultCompletedValueListEntriesItemName as EntryName, FsResultCompletedValueReadData,
        FsResultCompletedValueStatKind, FsResultRefusedReason as Reason,
    },
    FsRequest, FsResult,
};
use rustix::fs::{self, AtFlags, OFlags};

use super::{
    confine::ExportRoot, refusal, wire_size, LIST_MAX_ENTRIES, READ_MAX_BYTES, WRITE_MAX_BYTES,
};

pub(super) fn execute(roots: &HashMap<String, ExportRoot>, request: &FsRequest) -> FsResult {
    let export = match request {
        FsRequest::Read { export, .. } => export.as_str(),
        FsRequest::Write { export, .. } => export.as_str(),
        FsRequest::List { export, .. } => export.as_str(),
        FsRequest::Stat { export, .. } => export.as_str(),
    };
    let Some(root) = roots.get(export) else {
        return refusal(Reason::ExportNotAvailable);
    };
    let result = match request {
        FsRequest::Read {
            path,
            offset,
            limit,
            ..
        } => read(root, path, *offset, *limit),
        FsRequest::Write {
            path, data, create, ..
        } => write(
            root,
            path,
            data,
            matches!(create, Some(FsRequestExclusiveCreate::Exclusive)),
        ),
        FsRequest::List { path, .. } => list(root, path),
        FsRequest::Stat { path, .. } => stat(root, path),
    };
    match result {
        Ok(value) => FsResult::Completed { value },
        Err(reason) => refusal(reason),
    }
}

fn read(
    root: &ExportRoot,
    path: &str,
    offset: Option<i64>,
    limit: Option<NonZeroU64>,
) -> Result<Value, Reason> {
    let mut file = root.target(path, OFlags::RDONLY)?;
    let metadata = file.metadata().map_err(|_| Reason::IoError)?;
    if !metadata.is_file() {
        return Err(Reason::WrongKind);
    }
    let offset = u64::try_from(offset.unwrap_or(0)).map_err(|_| Reason::IoError)?;
    let available = metadata.len().saturating_sub(offset);
    let count = available
        .min(limit.map_or(READ_MAX_BYTES as u64, NonZeroU64::get))
        .min(READ_MAX_BYTES as u64);
    let mut data = vec![0; usize::try_from(count).map_err(|_| Reason::TooLarge)?];
    file.seek(SeekFrom::Start(offset))
        .and_then(|_| file.read_exact(&mut data))
        .map_err(|_| Reason::IoError)?;
    Ok(Value::Read {
        bytes_read: wire_size(data.len() as u64),
        data: FsResultCompletedValueReadData::try_from(BASE64.encode(data))
            .map_err(|_| Reason::IoError)?,
        size: wire_size(metadata.len()),
        truncated: available > count,
    })
}

fn write(root: &ExportRoot, path: &str, encoded: &str, exclusive: bool) -> Result<Value, Reason> {
    let data = BASE64.decode(encoded).map_err(|_| Reason::IoError)?;
    if data.len() > WRITE_MAX_BYTES {
        return Err(Reason::TooLarge);
    }
    let create = if exclusive {
        OFlags::CREATE | OFlags::EXCL
    } else {
        OFlags::CREATE
    };
    let mut file = root.target(path, OFlags::WRONLY | create)?;
    if !file.metadata().map_err(|_| Reason::IoError)?.is_file() {
        return Err(Reason::WrongKind);
    }
    file.set_len(0).map_err(|_| Reason::IoError)?;
    file.write_all(&data).map_err(|_| Reason::IoError)?;
    Ok(Value::Write {
        bytes_written: wire_size(data.len() as u64),
    })
}

fn list(root: &ExportRoot, path: &str) -> Result<Value, Reason> {
    let directory = root.target(path, OFlags::RDONLY | OFlags::DIRECTORY)?;
    let mut stream = fs::Dir::read_from(&directory).map_err(|_| Reason::IoError)?;
    let mut names = Vec::new();
    while let Some(entry) = stream.read() {
        let entry = entry.map_err(|_| Reason::IoError)?;
        let raw_name = entry.file_name();
        if raw_name.to_bytes() == b"." || raw_name.to_bytes() == b".." {
            continue;
        }
        names.push(raw_name.to_str().map_err(|_| Reason::IoError)?.to_owned());
    }
    names.sort();
    let truncated = names.len() > LIST_MAX_ENTRIES;
    let mut entries = Vec::new();
    for raw_name in names.into_iter().take(LIST_MAX_ENTRIES) {
        let raw_name = raw_name.as_str();
        let stat = fs::statat(&directory, raw_name, AtFlags::SYMLINK_NOFOLLOW)
            .map_err(|_| Reason::IoError)?;
        let kind = fs::FileType::from_raw_mode(stat.st_mode);
        let name = EntryName::try_from(raw_name.to_owned()).map_err(|_| Reason::IoError)?;
        let size = if kind == fs::FileType::RegularFile {
            Some(wire_size(u64::try_from(stat.st_size).unwrap_or(0)))
        } else {
            None
        };
        entries.push(Entry {
            name,
            size,
            kind: if kind == fs::FileType::Symlink {
                Kind::Symlink
            } else if kind == fs::FileType::RegularFile {
                Kind::File
            } else if kind == fs::FileType::Directory {
                Kind::Dir
            } else {
                Kind::Other
            },
        });
    }
    Ok(Value::List { entries, truncated })
}

fn stat(root: &ExportRoot, path: &str) -> Result<Value, Reason> {
    let metadata = root.metadata(path)?;
    let file_type = fs::FileType::from_raw_mode(metadata.st_mode);
    let kind = if file_type == fs::FileType::RegularFile {
        FsResultCompletedValueStatKind::File
    } else if file_type == fs::FileType::Directory {
        FsResultCompletedValueStatKind::Dir
    } else if file_type == fs::FileType::Symlink {
        FsResultCompletedValueStatKind::Symlink
    } else {
        FsResultCompletedValueStatKind::Other
    };
    let modified = metadata.st_mtime as f64 * 1_000.0 + metadata.st_mtime_nsec as f64 / 1_000_000.0;
    Ok(Value::Stat {
        kind,
        size: wire_size(u64::try_from(metadata.st_size).unwrap_or(0)),
        mtime_ms: serde_json::Number::from_f64(modified).expect("integer-derived mtime is finite"),
    })
}
