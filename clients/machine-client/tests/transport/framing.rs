use super::*;

struct BrokenStream {
    writes: usize,
}

impl AsyncRead for BrokenStream {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        _buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "read failed",
        )))
    }
}

impl AsyncWrite for BrokenStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.writes += 1;
        if self.writes == 1 {
            Poll::Ready(Ok(bytes.len()))
        } else {
            Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "write failed",
            )))
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

#[tokio::test]
async fn stream_read_and_second_write_fail_with_typed_io_error() {
    let mut reader = Framed::new(BrokenStream { writes: 0 });
    assert!(matches!(reader.next().await, Err(FrameError::Io(_))));
    let mut writer = BrokenStream { writes: 0 };
    assert!(matches!(
        oni_machine_client::transport::framing::write_frame(&mut writer, &json!({"ok":true})).await,
        Err(FrameError::Io(_))
    ));
    assert_eq!(writer.writes, 2);
}

#[tokio::test]
async fn first_frame_write_failure_is_typed() {
    let mut writer = BrokenStream { writes: 1 };
    assert!(matches!(
        oni_machine_client::transport::framing::write_frame(&mut writer, &json!({"ok":true})).await,
        Err(FrameError::Io(_))
    ));
    assert_eq!(writer.writes, 2);
}

#[tokio::test]
async fn framing_preserves_split_utf8_and_frame_boundary() {
    let (mut tx, rx) = tokio::io::duplex(128);
    let writer = tokio::spawn(async move {
        tx.write_all(b"{\"word\":\"\xE2\x82")
            .await
            .expect("first bytes");
        tx.write_all(b"\xAC\"}\n{\"next\":true}\n")
            .await
            .expect("remaining bytes");
    });
    let mut frames = Framed::new(rx);
    assert_eq!(
        frames.next().await.expect("first frame"),
        Some(json!({"word":"€"}))
    );
    assert_eq!(
        frames.next().await.expect("second frame"),
        Some(json!({"next":true}))
    );
    assert_eq!(frames.next().await.expect("EOF"), None);
    writer.await.expect("writer");
}

#[tokio::test]
async fn framing_skips_blank_lines_and_delivers_next_frame() {
    let (mut tx, rx) = tokio::io::duplex(64);
    tx.write_all(b"\n  \n{\"ok\":true}\n")
        .await
        .expect("frames");
    drop(tx);
    assert_eq!(
        Framed::new(rx).next().await.expect("frame"),
        Some(json!({"ok":true}))
    );
}

#[tokio::test]
async fn oversized_complete_frame_closes_with_typed_error() {
    let (mut tx, rx) = tokio::io::duplex(8192);
    let writer = tokio::spawn(async move {
        tx.write_all(&vec![b'x'; MAX_FRAME_BYTES + 1])
            .await
            .expect("oversize bytes");
        tx.write_all(b"\n").await.expect("newline");
    });
    let failure = Framed::new(rx).next().await.expect_err("oversize rejected");
    assert!(matches!(failure, FrameError::Oversize));
    writer.abort();
}

#[tokio::test]
async fn oversized_pending_buffer_closes_client() {
    let (mut host, peer) = tokio::io::duplex(8192);
    let mut client = Client::from_stream(peer, handler(|_, _| async { Ok(json!(null)) }));
    let writer = tokio::spawn(async move {
        host.write_all(&vec![b'x'; MAX_FRAME_BYTES + 1])
            .await
            .expect("oversize pending bytes");
    });
    assert!(matches!(
        client.closed().await,
        Err(TransportError::Frame(FrameError::Oversize))
    ));
    writer.await.expect("host writer");
}

#[tokio::test]
async fn invalid_utf8_json_and_partial_frames_have_typed_failures() {
    for (bytes, expected) in [
        (vec![0xff, b'\n'], "utf8"),
        (b"{bad}\n".to_vec(), "json"),
        (b"{\"partial\":".to_vec(), "incomplete"),
    ] {
        let (mut tx, rx) = tokio::io::duplex(32);
        tx.write_all(&bytes).await.expect("frame bytes");
        drop(tx);
        let error = Framed::new(rx).next().await.expect_err("bad frame");
        assert!(match expected {
            "utf8" => matches!(error, FrameError::Utf8(_)),
            "json" => matches!(error, FrameError::Json(_)),
            "incomplete" => matches!(error, FrameError::Incomplete),
            _ => false,
        });
    }
}

#[tokio::test]
async fn outbound_oversize_is_refused_before_writing() {
    let (mut writer, mut reader) = tokio::io::duplex(32);
    let error = oni_machine_client::transport::framing::write_frame(
        &mut writer,
        &json!({"data": "x".repeat(MAX_FRAME_BYTES)}),
    )
    .await
    .expect_err("outbound oversize");
    assert!(matches!(error, FrameError::Oversize));
    drop(writer);
    assert_eq!(
        reader.read_u8().await.err().map(|error| error.kind()),
        Some(std::io::ErrorKind::UnexpectedEof)
    );
}
