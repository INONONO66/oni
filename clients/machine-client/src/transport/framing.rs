use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("IPC frame exceeds maximum size of {MAX_FRAME_BYTES} bytes")]
    Oversize,
    #[error("IPC frame is not UTF-8")]
    Utf8(#[from] std::str::Utf8Error),
    #[error("IPC frame is not valid JSON")]
    Json(#[from] serde_json::Error),
    #[error("IPC stream ended with an incomplete frame")]
    Incomplete,
    #[error("IPC I/O failed: {0}")]
    Io(#[from] std::io::Error),
}

pub struct Framed {
    reader: Box<dyn AsyncRead + Unpin + Send>,
    pending: Vec<u8>,
    scanned: usize,
}

impl Framed {
    pub fn new(reader: impl AsyncRead + Unpin + Send + 'static) -> Self {
        Self {
            reader: Box::new(reader),
            pending: Vec::new(),
            scanned: 0,
        }
    }

    pub async fn next(&mut self) -> Result<Option<serde_json::Value>, FrameError> {
        loop {
            if let Some(relative) = self.pending[self.scanned..]
                .iter()
                .position(|byte| *byte == b'\n')
            {
                let end = self.scanned + relative;
                if end > MAX_FRAME_BYTES {
                    return Err(FrameError::Oversize);
                }
                let line = self.pending.drain(..=end).collect::<Vec<_>>();
                self.scanned = 0;
                let text = std::str::from_utf8(&line[..end])?;
                if text.trim().is_empty() {
                    continue;
                }
                return Ok(Some(serde_json::from_str(text)?));
            }
            if self.pending.len() > MAX_FRAME_BYTES {
                return Err(FrameError::Oversize);
            }
            self.scanned = self.pending.len();
            let mut chunk = [0; 8192];
            let count = self.reader.read(&mut chunk).await?;
            if count == 0 {
                return if self.pending.is_empty() {
                    Ok(None)
                } else {
                    Err(FrameError::Incomplete)
                };
            }
            self.pending.extend_from_slice(&chunk[..count]);
        }
    }
}

pub async fn write_frame(
    writer: &mut (dyn AsyncWrite + Unpin + Send),
    value: &serde_json::Value,
) -> Result<(), FrameError> {
    let encoded = value.to_string().into_bytes();
    if encoded.len() > MAX_FRAME_BYTES {
        return Err(FrameError::Oversize);
    }
    writer.write_all(&encoded).await?;
    writer.write_all(b"\n").await?;
    Ok(())
}
