use super::*;

#[tokio::test]
async fn seventeenth_request_starts_after_one_of_sixteen_completes() {
    let mut host = FakeHost::unix().await;
    let (started, mut executions) = mpsc::channel(17);
    let permits = Arc::new(Semaphore::new(0));
    let waiting = permits.clone();
    let client = Client::connect_unix(
        Path::new(&host.endpoint),
        handler(move |method, _| {
            let started = started.clone();
            let permits = waiting.clone();
            async move {
                started
                    .send(method)
                    .await
                    .map_err(|error| error.to_string())?;
                let permit = permits.acquire().await.map_err(|error| error.to_string())?;
                permit.forget();
                Ok(json!(true))
            }
        }),
    )
    .await
    .expect("connect");
    for id in 1..=17 {
        host.send(envelope::request(
            &format!("h{id}"),
            &format!("request-{id}"),
            None,
        ))
        .await;
    }
    for _ in 0..16 {
        assert!(executions.recv().await.is_some());
    }
    assert!(executions.try_recv().is_err());
    permits.add_permits(1);
    assert!(host.incoming.recv().await.is_some());
    assert_eq!(executions.recv().await.as_deref(), Some("request-17"));
    drop(client);
}

#[tokio::test]
async fn inbound_queue_replies_4001_on_eighty_first_request() {
    let mut host = FakeHost::unix().await;
    let permits = Arc::new(Semaphore::new(0));
    let wait = permits.clone();
    let mut client = Client::connect_unix(
        Path::new(&host.endpoint),
        handler(move |_, _| {
            let permits = wait.clone();
            async move {
                let permit = permits.acquire().await.map_err(|error| error.to_string())?;
                permit.forget();
                Ok(json!(true))
            }
        }),
    )
    .await
    .expect("connect");
    for id in 1..=81 {
        host.send(json!({"v":2,"type":"request","id":format!("h{id}"),"method":"block"}))
            .await;
    }
    let refusal = host.incoming.recv().await.expect("overload reply");
    assert_eq!(refusal["id"], "h81");
    assert_eq!(refusal["error"]["code"], 4001);
    assert!(matches!(
        client.closed().await,
        Err(TransportError::QueueFull)
    ));
}

#[tokio::test]
async fn outbound_writer_stops_accepting_at_256_queued_frames() {
    let (_host, peer) = tokio::io::duplex(1);
    let client = Client::from_stream(peer, handler(|_, _| async { Ok(json!(null)) }));
    for _ in 0..257 {
        client
            .notify("event", None)
            .await
            .expect("bounded frame accepted");
    }
    assert_eq!(client.writer_remaining(), 0);
    let next = client.notify("event", None);
    tokio::pin!(next);
    assert!(
        std::future::poll_fn(|cx| {
            match next.as_mut().poll(cx) {
                std::task::Poll::Pending => std::task::Poll::Ready(true),
                std::task::Poll::Ready(_) => std::task::Poll::Ready(false),
            }
        })
        .await
    );
}
