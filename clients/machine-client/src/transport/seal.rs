//! Post-handshake frame sealing of machine contract v6 (#1832), the mirror
//! of `packages/machines/src/ipc/seal.ts`: once the signed handshake derived
//! the session keys, every NDJSON frame travels as ONE base64 line of
//! `nonce || ciphertext || tag` under AES-256-GCM, so a relay, CDN or proxy
//! that terminated TLS sees only ciphertext. The nonce is the per-direction
//! frame counter and the receiver insists on the exact next one, so a
//! replayed, dropped or reordered frame ends the connection.

use std::{
    io,
    pin::Pin,
    task::{ready, Context, Poll},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use super::framing::MAX_FRAME_BYTES;

pub const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
/// A sealed line carrying the largest admissible plaintext frame.
const MAX_SEALED_LINE_CHARS: usize = (MAX_FRAME_BYTES + NONCE_BYTES + TAG_BYTES).div_ceil(3) * 4;

#[derive(Debug, thiserror::Error)]
pub enum SealError {
    #[error("sealed frame is not the base64 of nonce, ciphertext and tag")]
    Encoding,
    #[error("sealed frame counter is out of order")]
    Counter,
    #[error("sealed frame failed authentication")]
    Authentication,
    #[error("sealed frame exceeds maximum size of {MAX_FRAME_BYTES} bytes")]
    Oversize,
    #[error("the session's frame counter is exhausted")]
    Exhausted,
}

/// The two directional keys of one session with the associated data each
/// direction is sealed under; `handshake::derive` fills them for this peer.
pub struct SealKeys {
    pub send: [u8; KEY_BYTES],
    pub receive: [u8; KEY_BYTES],
    pub send_aad: &'static [u8],
    pub receive_aad: &'static [u8],
}

fn nonce_of(counter: u64) -> [u8; NONCE_BYTES] {
    let mut nonce = [0; NONCE_BYTES];
    nonce[NONCE_BYTES - 8..].copy_from_slice(&counter.to_be_bytes());
    nonce
}

pub struct FrameSeal {
    send: LessSafeKey,
    receive: LessSafeKey,
    send_aad: &'static [u8],
    receive_aad: &'static [u8],
    send_counter: u64,
    receive_counter: u64,
}

impl FrameSeal {
    pub fn new(keys: &SealKeys) -> Result<Self, SealError> {
        let key = |bytes: &[u8]| {
            UnboundKey::new(&AES_256_GCM, bytes)
                .map(LessSafeKey::new)
                .map_err(|_| SealError::Authentication)
        };
        Ok(Self {
            send: key(&keys.send)?,
            receive: key(&keys.receive)?,
            send_aad: keys.send_aad,
            receive_aad: keys.receive_aad,
            send_counter: 0,
            receive_counter: 0,
        })
    }

    /// One plaintext frame, trailing newline included, becomes one sealed line.
    pub fn seal(&mut self, frame: &[u8]) -> Result<Vec<u8>, SealError> {
        let nonce = nonce_of(self.send_counter);
        self.send_counter = self
            .send_counter
            .checked_add(1)
            .ok_or(SealError::Exhausted)?;
        let mut body = Vec::with_capacity(NONCE_BYTES + frame.len() + TAG_BYTES);
        body.extend_from_slice(&nonce);
        let mut in_out = frame.to_vec();
        self.send
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(self.send_aad),
                &mut in_out,
            )
            .map_err(|_| SealError::Authentication)?;
        body.extend_from_slice(&in_out);
        let mut line = BASE64.encode(body).into_bytes();
        line.push(b'\n');
        Ok(line)
    }

    /// One sealed line, without its newline, back to the plaintext frame bytes.
    pub fn open(&mut self, line: &[u8]) -> Result<Vec<u8>, SealError> {
        let mut body = BASE64.decode(line).map_err(|_| SealError::Encoding)?;
        if body.len() < NONCE_BYTES + TAG_BYTES || BASE64.encode(&body).as_bytes() != line {
            return Err(SealError::Encoding);
        }
        let mut nonce = [0; NONCE_BYTES];
        nonce.copy_from_slice(&body[..NONCE_BYTES]);
        let mut counter = [0; 8];
        counter.copy_from_slice(&nonce[NONCE_BYTES - 8..]);
        if nonce[..NONCE_BYTES - 8] != [0; 4] || u64::from_be_bytes(counter) != self.receive_counter
        {
            return Err(SealError::Counter);
        }
        let frame = self
            .receive
            .open_in_place(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(self.receive_aad),
                &mut body[NONCE_BYTES..],
            )
            .map_err(|_| SealError::Authentication)?
            .to_vec();
        self.receive_counter = self
            .receive_counter
            .checked_add(1)
            .ok_or(SealError::Exhausted)?;
        Ok(frame)
    }
}

/// A carrier whose every line is sealed: plaintext frames written through it
/// leave as sealed lines, and sealed lines read from it arrive as plaintext
/// frames. A line that fails to open is an `InvalidData` error that ends the
/// connection, as on the host: there is no honest way to produce one.
pub struct Sealed<S> {
    inner: S,
    seal: FrameSeal,
    partial_plaintext: Vec<u8>,
    sealed_outbound: Vec<u8>,
    sealed_inbound: Vec<u8>,
    opened: Vec<u8>,
    ended: bool,
}

impl<S> Sealed<S> {
    /// Wraps the carrier after the acceptance; `carried` is whatever the
    /// handshake read past the acceptance line, already sealed.
    pub fn new(inner: S, seal: FrameSeal, carried: Vec<u8>) -> Self {
        Self {
            inner,
            seal,
            partial_plaintext: Vec::new(),
            sealed_outbound: Vec::new(),
            sealed_inbound: carried,
            opened: Vec::new(),
            ended: false,
        }
    }

    fn invalid(error: SealError) -> io::Error {
        io::Error::new(io::ErrorKind::InvalidData, error)
    }

    fn open_lines(&mut self) -> io::Result<()> {
        while let Some(end) = self
            .sealed_inbound
            .iter()
            .position(|byte| *byte == b'\n')
        {
            let line = self.sealed_inbound.drain(..=end).collect::<Vec<u8>>();
            let line = &line[..line.len() - 1];
            if line.is_empty() {
                continue;
            }
            let frame = self.seal.open(line).map_err(Self::invalid)?;
            self.opened.extend_from_slice(&frame);
        }
        if self.sealed_inbound.len() > MAX_SEALED_LINE_CHARS {
            self.sealed_inbound.clear();
            return Err(Self::invalid(SealError::Oversize));
        }
        Ok(())
    }

    fn seal_lines(&mut self) -> io::Result<()> {
        while let Some(end) = self
            .partial_plaintext
            .iter()
            .position(|byte| *byte == b'\n')
        {
            let frame = self
                .partial_plaintext
                .drain(..=end)
                .collect::<Vec<u8>>();
            let line = self.seal.seal(&frame).map_err(Self::invalid)?;
            self.sealed_outbound.extend_from_slice(&line);
        }
        Ok(())
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Sealed<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        while this.opened.is_empty() {
            if this.ended {
                return Poll::Ready(Ok(()));
            }
            let mut chunk = [0; 16 * 1024];
            let mut read = ReadBuf::new(&mut chunk);
            ready!(Pin::new(&mut this.inner).poll_read(cx, &mut read))?;
            if read.filled().is_empty() {
                this.ended = true;
            } else {
                this.sealed_inbound.extend_from_slice(read.filled());
            }
            this.open_lines()?;
        }
        let count = this.opened.len().min(buf.remaining());
        buf.put_slice(&this.opened[..count]);
        this.opened.drain(..count);
        Poll::Ready(Ok(()))
    }
}

impl<S: AsyncWrite + Unpin> Sealed<S> {
    fn drain_outbound(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        while !self.sealed_outbound.is_empty() {
            let written =
                ready!(Pin::new(&mut self.inner).poll_write(cx, &self.sealed_outbound))?;
            if written == 0 {
                return Poll::Ready(Err(io::Error::from(io::ErrorKind::WriteZero)));
            }
            self.sealed_outbound.drain(..written);
        }
        Poll::Ready(Ok(()))
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Sealed<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        ready!(this.drain_outbound(cx))?;
        this.partial_plaintext.extend_from_slice(buf);
        this.seal_lines()?;
        if let Poll::Ready(Err(error)) = this.drain_outbound(cx) {
            return Poll::Ready(Err(error));
        }
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        ready!(this.drain_outbound(cx))?;
        Pin::new(&mut this.inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        ready!(this.drain_outbound(cx))?;
        Pin::new(&mut this.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> (FrameSeal, FrameSeal) {
        let initiator = SealKeys {
            send: [1; KEY_BYTES],
            receive: [2; KEY_BYTES],
            send_aad: b"c2h",
            receive_aad: b"h2c",
        };
        let responder = SealKeys {
            send: [2; KEY_BYTES],
            receive: [1; KEY_BYTES],
            send_aad: b"h2c",
            receive_aad: b"c2h",
        };
        (
            FrameSeal::new(&initiator).expect("initiator keys"),
            FrameSeal::new(&responder).expect("responder keys"),
        )
    }

    #[test]
    fn a_sealed_line_is_the_base64_of_counter_nonce_ciphertext_and_tag() {
        let (mut initiator, mut responder) = pair();
        let first = initiator.seal(b"{\"v\":2}\n").expect("seal");
        let second = initiator.seal(b"{\"v\":2}\n").expect("seal");
        assert_eq!(first.last(), Some(&b'\n'));
        let body = BASE64.decode(&first[..first.len() - 1]).expect("base64 body");
        assert_eq!(body.len(), NONCE_BYTES + 8 + TAG_BYTES);
        assert_eq!(&body[..NONCE_BYTES], &[0; NONCE_BYTES]);
        let second_body = BASE64.decode(&second[..second.len() - 1]).expect("base64 body");
        assert_eq!(second_body[NONCE_BYTES - 1], 1);
        assert_ne!(body[NONCE_BYTES..], second_body[NONCE_BYTES..]);
        assert_eq!(
            responder.open(&first[..first.len() - 1]).expect("open"),
            b"{\"v\":2}\n"
        );
        assert_eq!(
            responder.open(&second[..second.len() - 1]).expect("open"),
            b"{\"v\":2}\n"
        );
    }

    #[test]
    fn a_replayed_reordered_or_forged_line_is_a_typed_refusal() {
        let (mut initiator, mut responder) = pair();
        let first = initiator.seal(b"a\n").expect("seal");
        let second = initiator.seal(b"b\n").expect("seal");
        let first = &first[..first.len() - 1];
        let second = &second[..second.len() - 1];
        assert!(matches!(responder.open(second), Err(SealError::Counter)));
        responder.open(first).expect("the first line opens once");
        assert!(matches!(responder.open(first), Err(SealError::Counter)));
        let mut forged = BASE64.decode(second).expect("body");
        let last = forged.len() - 1;
        forged[last] ^= 1;
        assert!(matches!(
            responder.open(BASE64.encode(forged).as_bytes()),
            Err(SealError::Authentication)
        ));
        assert!(matches!(
            responder.open(b"not base64!"),
            Err(SealError::Encoding)
        ));
        assert!(matches!(
            responder.open(BASE64.encode([0; 8]).as_bytes()),
            Err(SealError::Encoding)
        ));
        let mut own = initiator.seal(b"c\n").expect("seal");
        own.pop();
        assert!(matches!(
            initiator.open(&own),
            Err(SealError::Counter | SealError::Authentication)
        ));
    }

    #[test]
    fn a_non_canonical_base64_line_is_refused_before_it_is_opened() {
        let (mut initiator, mut responder) = pair();
        let line = initiator.seal(b"a\n").expect("seal");
        let mut padded = line[..line.len() - 1].to_vec();
        padded.push(b'=');
        assert!(matches!(responder.open(&padded), Err(SealError::Encoding)));
    }

    #[tokio::test]
    async fn the_sealed_carrier_round_trips_whole_lines_and_ends_on_a_bad_one() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (initiator, responder) = pair();
        let (left, right) = tokio::io::duplex(64 * 1024);
        let mut client = Sealed::new(left, initiator, Vec::new());
        let mut host = Sealed::new(right, responder, Vec::new());
        client.write_all(b"{\"id\":1}\n{\"id\":").await.expect("write");
        client.write_all(b"2}\n").await.expect("write");
        client.flush().await.expect("flush");
        let mut buf = vec![0; 64];
        let count = host.read(&mut buf).await.expect("read");
        assert_eq!(&buf[..count], b"{\"id\":1}\n{\"id\":2}\n");
        host.write_all(b"{\"ok\":true}\n").await.expect("write");
        host.flush().await.expect("flush");
        let count = client.read(&mut buf).await.expect("read");
        assert_eq!(&buf[..count], b"{\"ok\":true}\n");
        host.inner.write_all(b"AAAA\n").await.expect("raw write");
        host.inner.flush().await.expect("raw flush");
        let error = client.read(&mut buf).await.expect_err("a forged line ends the read");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[tokio::test]
    async fn bytes_carried_past_the_acceptance_are_opened_first() {
        use tokio::io::AsyncReadExt;
        let (initiator, mut responder) = pair();
        let carried = responder.seal(b"{\"early\":true}\n").expect("seal");
        let (left, _right) = tokio::io::duplex(1024);
        let mut client = Sealed::new(left, initiator, carried);
        let mut buf = vec![0; 64];
        let count = client.read(&mut buf).await.expect("read");
        assert_eq!(&buf[..count], b"{\"early\":true}\n");
    }
}
