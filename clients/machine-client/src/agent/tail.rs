//! Server-minted transcript positions. A position is a byte offset that ends
//! a complete source line plus a session-bound hash of all bytes before it.
//! A tail from an acknowledged offset reads only the source bytes after it;
//! replaying a cursor over an unchanged source yields the same page; a
//! rewritten prefix or a file shrunk below the offset is refused. Nothing here
//! deduplicates effects downstream of a page.

use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
};

use oni_protocol::AgentTranscriptRecord;
use serde_json::json;
use sha2::{Digest, Sha256};

use super::manifest::Format;

/// Records per page; the wire caps a tail result at this many.
pub const MAX_RECORDS: usize = 32;
pub const MAX_BYTES: usize = 256 * 1024;
const SCAN: usize = 64 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum TailError {
    #[error("invalid_cursor")]
    InvalidCursor,
    #[error("transcript I/O: {0}")]
    Io(#[from] io::Error),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Position {
    pub byte_offset: u64,
    pub record_hash: String,
}

#[derive(Debug)]
pub struct Page {
    pub records: Vec<AgentTranscriptRecord>,
    pub position: Position,
    pub has_more: bool,
}

/// The position before the first record of any transcript.
pub fn origin(session_id: &str, generation: u64) -> Position {
    Position {
        byte_offset: 0,
        record_hash: hex::encode(digest(session_id, generation, 0).finalize()),
    }
}

fn digest(session_id: &str, generation: u64, offset: u64) -> Sha256 {
    let mut hash = Sha256::new();
    hash.update(
        u64::try_from(session_id.len())
            .expect("session id length fits in u64")
            .to_be_bytes(),
    );
    hash.update(session_id.as_bytes());
    hash.update(generation.to_be_bytes());
    hash.update(offset.to_be_bytes());
    hash
}

fn hash_before(
    file: &mut File,
    offset: u64,
    session_id: &str,
    generation: u64,
) -> io::Result<String> {
    let mut hash = digest(session_id, generation, offset);
    file.seek(SeekFrom::Start(0))?;
    let mut remaining = offset;
    let mut buffer = [0; SCAN];
    while remaining > 0 {
        let count = usize::try_from(remaining.min(SCAN as u64)).expect("bounded by SCAN");
        file.read_exact(&mut buffer[..count])?;
        hash.update(&buffer[..count]);
        remaining -= u64::try_from(count).expect("buffer count fits in u64");
    }
    Ok(hex::encode(hash.finalize()))
}

fn truncated(line: &[u8], original: u64) -> AgentTranscriptRecord {
    super::record(json!({
        "kind": "truncated",
        "originalBytes": original,
        "prefix": super::excerpt(line),
    }))
}

fn position(
    file: &mut File,
    byte_offset: u64,
    session_id: &str,
    generation: u64,
) -> io::Result<Position> {
    Ok(Position {
        byte_offset,
        record_hash: hash_before(file, byte_offset, session_id, generation)?,
    })
}

/// Read the page after `from`. The position must still name the same bytes
/// it was minted over; anything else is [`TailError::InvalidCursor`].
pub fn read(
    path: &Path,
    format: Format,
    from: &Position,
    session_id: &str,
    generation: u64,
) -> Result<Page, TailError> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    validate(&mut file, len, from, session_id, generation)?;
    file.seek(SeekFrom::Start(from.byte_offset))?;
    let remaining = len - from.byte_offset;
    let available = usize::try_from(remaining.min(MAX_BYTES as u64)).expect("bounded by MAX_BYTES");
    let mut bytes = vec![0; available];
    file.read_exact(&mut bytes)?;
    let Some(last) = bytes.iter().rposition(|byte| *byte == b'\n') else {
        return oversized(&mut file, from, len, &bytes, session_id, generation);
    };
    let (records, end, capped) = assemble(format, &bytes, last);
    let byte_offset = from.byte_offset + end;
    Ok(Page {
        records,
        position: position(&mut file, byte_offset, session_id, generation)?,
        has_more: capped || remaining > available as u64,
    })
}

/// The cursor must lie inside the file, hash to the bytes before it and sit
/// right after a line end.
fn validate(
    file: &mut File,
    len: u64,
    from: &Position,
    session_id: &str,
    generation: u64,
) -> Result<(), TailError> {
    if from.byte_offset > len
        || hash_before(file, from.byte_offset, session_id, generation)? != from.record_hash
    {
        return Err(TailError::InvalidCursor);
    }
    if from.byte_offset > 0 {
        file.seek(SeekFrom::Start(from.byte_offset - 1))?;
        let mut previous = [0];
        file.read_exact(&mut previous)?;
        if previous[0] != b'\n' {
            return Err(TailError::InvalidCursor);
        }
    }
    Ok(())
}

/// Whole lines up to `last`, capped at [`MAX_RECORDS`]: the records, the
/// page end relative to the read window, and whether the cap cut the page.
fn assemble(format: Format, bytes: &[u8], last: usize) -> (Vec<AgentTranscriptRecord>, u64, bool) {
    let mut groups: Vec<(u64, u64, Vec<AgentTranscriptRecord>)> = Vec::new();
    for parsed in format.parse(&bytes[..=last]) {
        match groups.last_mut() {
            Some((_, end, records)) if *end == parsed.end => records.push(parsed.record),
            _ => groups.push((parsed.start, parsed.end, vec![parsed.record])),
        }
    }
    let mut records = Vec::new();
    let mut end = u64::try_from(last + 1).expect("offset fits");
    let mut capped = false;
    for (start, line_end, mut line) in groups {
        if records.len() + line.len() <= MAX_RECORDS {
            records.extend(line);
            continue;
        }
        capped = true;
        if records.is_empty() {
            let span = usize::try_from(start).expect("offset fits")
                ..usize::try_from(line_end).expect("offset fits");
            line.truncate(MAX_RECORDS - 1);
            line.push(truncated(&bytes[span], line_end - start));
            records = line;
            end = line_end;
        } else {
            end = start;
        }
        break;
    }
    (records, end, capped)
}

/// No line ends inside the read window: either the last line is still being
/// written, or one line is longer than a page and is reported as truncated.
fn oversized(
    file: &mut File,
    from: &Position,
    len: u64,
    head: &[u8],
    session_id: &str,
    generation: u64,
) -> Result<Page, TailError> {
    let unchanged = || Page {
        records: Vec::new(),
        position: from.clone(),
        has_more: false,
    };
    if head.len() < MAX_BYTES {
        return Ok(unchanged());
    }
    let mut scanned = from.byte_offset + head.len() as u64;
    let mut chunk = vec![0; SCAN];
    while scanned < len {
        let take = usize::try_from((len - scanned).min(SCAN as u64)).expect("bounded by SCAN");
        file.seek(SeekFrom::Start(scanned))?;
        file.read_exact(&mut chunk[..take])?;
        if let Some(newline) = chunk[..take].iter().position(|byte| *byte == b'\n') {
            let end = scanned + newline as u64 + 1;
            return Ok(Page {
                records: vec![truncated(head, end - from.byte_offset)],
                position: position(file, end, session_id, generation)?,
                has_more: end < len,
            });
        }
        scanned += take as u64;
    }
    Ok(unchanged())
}
