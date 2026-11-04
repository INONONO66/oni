//! The WebSocket carrier of the machine wire: the `wss://host[:port]/machine`
//! dial runs over the same TLS identity and host pin as the raw TLS-TCP dial,
//! optionally through an HTTP CONNECT proxy. One NDJSON frame travels as
//! exactly one BINARY message whose payload is the frame's bytes, newline
//! included, so the frame reader on either end sees the TCP carrier's bytes.

use std::{
    io,
    pin::Pin,
    task::{ready, Context, Poll},
};

use futures_core::Stream;
use futures_sink::Sink;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf},
    net::TcpStream,
};
use tokio_tungstenite::{
    tungstenite::{protocol::WebSocketConfig, Bytes, Error as WsError, Message},
    WebSocketStream,
};

use super::framing::MAX_FRAME_BYTES;

pub const PATH: &str = "/machine";
const MAX_PROXY_HEAD: usize = 16 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WsEndpoint {
    pub address: String,
    pub server_name: String,
    pub path: String,
}

impl WsEndpoint {
    pub fn url(&self) -> String {
        format!("wss://{}{}", self.address, self.path)
    }
}

pub fn proxy_address(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    let bare = value
        .strip_prefix("http://")
        .unwrap_or(value)
        .trim_end_matches('/');
    (!bare.is_empty()).then(|| bare.to_owned())
}

pub fn proxy_from_env() -> Option<String> {
    ["HTTPS_PROXY", "https_proxy"]
        .iter()
        .find_map(|name| proxy_address(std::env::var(name).ok().as_deref()))
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// Opens a tunnel to `target` through the HTTP proxy at `proxy` (CONNECT);
/// the head is read byte by byte so the target's first byte stays in the
/// returned stream, which then carries TLS unchanged.
pub async fn connect_through_proxy(proxy: &str, target: &str) -> io::Result<TcpStream> {
    let mut stream = TcpStream::connect(proxy).await?;
    let request = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n");
    stream.write_all(request.as_bytes()).await?;
    let mut head = Vec::new();
    let mut byte = [0_u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= MAX_PROXY_HEAD {
            return Err(invalid("proxy response head too large"));
        }
        if stream.read(&mut byte).await? == 0 {
            return Err(invalid("proxy closed before answering CONNECT"));
        }
        head.push(byte[0]);
    }
    let status = std::str::from_utf8(&head)
        .ok()
        .and_then(|text| text.split(' ').nth(1)?.parse::<u16>().ok());
    if status != Some(200) {
        return Err(io::Error::new(
            io::ErrorKind::ConnectionRefused,
            "proxy refused CONNECT",
        ));
    }
    Ok(stream)
}

fn config() -> WebSocketConfig {
    WebSocketConfig::default()
        .write_buffer_size(0)
        .max_message_size(Some(MAX_FRAME_BYTES + 1))
}

pub async fn upgrade<S>(stream: S, endpoint: &WsEndpoint) -> Result<WebSocketStream<S>, WsError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (socket, _response) =
        tokio_tungstenite::client_async_with_config(endpoint.url(), stream, Some(config())).await?;
    Ok(socket)
}

pub async fn accept<S>(stream: S) -> Result<WebSocketStream<S>, WsError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    tokio_tungstenite::accept_async_with_config(stream, Some(config())).await
}

/// NDJSON over a WebSocket as `AsyncRead + AsyncWrite`: every complete line
/// written is sent as one BINARY message and every BINARY message received
/// is read as its bytes. A text message is a typed refusal; a Close message
/// or the stream's end reads as EOF.
pub struct Frames<S> {
    socket: WebSocketStream<S>,
    inbound: Bytes,
    outbound: Vec<u8>,
}

impl<S> Frames<S> {
    pub fn new(socket: WebSocketStream<S>) -> Self {
        Self {
            socket,
            inbound: Bytes::new(),
            outbound: Vec::new(),
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for Frames<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        while this.inbound.is_empty() {
            match ready!(Pin::new(&mut this.socket).poll_next(cx)) {
                Some(Ok(Message::Binary(bytes))) => this.inbound = bytes,
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {}
                Some(Ok(Message::Text(_))) => {
                    return Poll::Ready(Err(invalid(
                        "the machine wire carries binary frames only",
                    )));
                }
                Some(Ok(Message::Close(_))) | None => return Poll::Ready(Ok(())),
                Some(Err(error)) => return Poll::Ready(Err(io::Error::other(error))),
            }
        }
        let taken = buf.remaining().min(this.inbound.len());
        buf.put_slice(&this.inbound.split_to(taken));
        Poll::Ready(Ok(()))
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for Frames<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        ready!(Pin::new(&mut this.socket).poll_ready(cx)).map_err(io::Error::other)?;
        this.outbound.extend_from_slice(buf);
        while let Some(end) = this.outbound.iter().position(|byte| *byte == b'\n') {
            let line = this.outbound.drain(..=end).collect::<Vec<u8>>();
            Pin::new(&mut this.socket)
                .start_send(Message::Binary(line.into()))
                .map_err(io::Error::other)?;
        }
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().socket)
            .poll_flush(cx)
            .map_err(io::Error::other)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().socket)
            .poll_close(cx)
            .map_err(io::Error::other)
    }
}

#[cfg(test)]
mod tests {
    use futures_util::{SinkExt, StreamExt};
    use tokio::io::{duplex, DuplexStream};
    use tokio_tungstenite::tungstenite::protocol::Role;

    use super::*;

    async fn pair() -> (Frames<DuplexStream>, WebSocketStream<DuplexStream>) {
        let (client, server) = duplex(1024);
        let client = WebSocketStream::from_raw_socket(client, Role::Client, Some(config())).await;
        let server = WebSocketStream::from_raw_socket(server, Role::Server, Some(config())).await;
        (Frames::new(client), server)
    }

    #[tokio::test]
    async fn every_written_line_is_one_binary_message() {
        let (mut frames, mut server) = pair().await;
        frames.write_all(b"{\"a\":1}").await.expect("partial line");
        frames.flush().await.expect("flush");
        frames.write_all(b"\n{\"b\":2}\n").await.expect("two ends");
        frames.flush().await.expect("flush");
        assert_eq!(
            server.next().await.expect("first").expect("frame"),
            Message::Binary(Bytes::from_static(b"{\"a\":1}\n"))
        );
        assert_eq!(
            server.next().await.expect("second").expect("frame"),
            Message::Binary(Bytes::from_static(b"{\"b\":2}\n"))
        );
        frames.shutdown().await.expect("close");
        assert!(matches!(
            server.next().await.expect("close").expect("frame"),
            Message::Close(None)
        ));
    }

    #[tokio::test]
    async fn binary_messages_read_as_their_bytes_across_small_buffers() {
        let (mut frames, mut server) = pair().await;
        server
            .send(Message::Ping(Bytes::new()))
            .await
            .expect("ping");
        server
            .send(Message::Binary(Bytes::from_static(b"{\"n\":42}\n")))
            .await
            .expect("frame");
        server.send(Message::Close(None)).await.expect("close");
        let mut buffer = [0_u8; 4];
        let mut received = Vec::new();
        loop {
            let read = frames.read(&mut buffer).await.expect("read");
            if read == 0 {
                break;
            }
            received.extend_from_slice(&buffer[..read]);
        }
        assert_eq!(received, b"{\"n\":42}\n");
    }

    #[tokio::test]
    async fn a_text_message_is_invalid_data() {
        let (mut frames, mut server) = pair().await;
        server.send(Message::Text("{}".into())).await.expect("text");
        let error = frames.read(&mut [0_u8; 8]).await.expect_err("refused");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(
            error.to_string(),
            "the machine wire carries binary frames only"
        );
    }

    #[tokio::test]
    async fn a_protocol_error_is_an_other_io_error() {
        let (mut frames, mut server) = pair().await;
        server
            .get_mut()
            .write_all(&[0x8B, 0x00])
            .await
            .expect("reserved control frame");
        let error = frames.read(&mut [0_u8; 8]).await.expect_err("refused");
        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert_eq!(
            error.to_string(),
            "WebSocket protocol error: Encountered invalid opcode: 11"
        );
    }
}
