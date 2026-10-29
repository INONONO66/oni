use oni_machine_client::transport::framing::write_frame;
use tokio::{io::split, sync::mpsc::UnboundedReceiver, time::timeout};

use super::*;

/// A client whose handler parks every `machine.run_code` cell on `gate` and
/// reports each start on the returned channel; other methods answer at once.
fn parked_cells(
    wire: tokio::io::DuplexStream,
    gate: &Arc<Semaphore>,
) -> (Client, UnboundedReceiver<()>) {
    let (started, received) = mpsc::unbounded_channel();
    let gate = gate.clone();
    let handler = handler(move |method, _| {
        let started = started.clone();
        let gate = gate.clone();
        async move {
            if method == "machine.run_code" {
                started.send(()).expect("host listening");
                let _permit = gate.acquire().await.expect("open gate");
            }
            Ok(json!({"method":method}))
        }
    });
    (Client::from_stream(wire, handler), received)
}

async fn send_cells(writer: &mut tokio::io::WriteHalf<tokio::io::DuplexStream>, count: usize) {
    for id in 0..count {
        write_frame(writer, &json!({"v":2,"type":"request","id":id.to_string(),"method":"machine.run_code","params":{}}))
            .await
            .expect("cell request");
    }
}

async fn await_started(received: &mut UnboundedReceiver<()>, count: usize) {
    for _ in 0..count {
        timeout(Duration::from_secs(5), received.recv())
            .await
            .expect("cell dispatched")
            .expect("started");
    }
}

async fn next_response(responses: &mut Framed) -> serde_json::Value {
    timeout(Duration::from_secs(5), responses.next())
        .await
        .expect("response in time")
        .expect("frame")
        .expect("response")
}

#[tokio::test]
async fn sixteen_running_cells_leave_callback_and_cancel_slots_available() {
    let (wire, host) = tokio::io::duplex(1 << 20);
    let (reader, mut writer) = split(host);
    let mut responses = Framed::new(reader);
    let gate = Arc::new(Semaphore::new(0));
    let (_client, mut received) = parked_cells(wire, &gate);
    send_cells(&mut writer, 16).await;
    await_started(&mut received, 16).await;
    write_frame(
        &mut writer,
        &json!({"v":2,"type":"request","id":"callback","method":"machine.cancel_code","params":{}}),
    )
    .await
    .expect("cancel request");
    let reply = next_response(&mut responses).await;
    assert_eq!(reply["id"], "callback");
    assert_eq!(reply["result"]["method"], "machine.cancel_code");
    gate.add_permits(16);
}

#[tokio::test]
async fn sixty_fifth_pending_cell_is_refused_without_closing_the_connection() {
    let (wire, host) = tokio::io::duplex(1 << 20);
    let (reader, mut writer) = split(host);
    let mut responses = Framed::new(reader);
    let gate = Arc::new(Semaphore::new(0));
    let (_client, mut received) = parked_cells(wire, &gate);
    send_cells(&mut writer, 64).await;
    await_started(&mut received, 64).await;
    write_frame(
        &mut writer,
        &json!({"v":2,"type":"request","id":"overflow","method":"machine.run_code","params":{}}),
    )
    .await
    .expect("overflow request");
    let refused = next_response(&mut responses).await;
    assert_eq!(refused["id"], "overflow");
    assert_eq!(refused["error"]["code"], 4001);
    assert_eq!(
        refused["error"]["message"],
        "IPC inbound cell limit reached"
    );
    write_frame(
        &mut writer,
        &json!({"v":2,"type":"request","id":"callback","method":"machine.cancel_code","params":{}}),
    )
    .await
    .expect("callback");
    let callback = next_response(&mut responses).await;
    assert_eq!(callback["id"], "callback");
    gate.add_permits(64);
}

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
async fn ping_answers_while_all_ordinary_execution_slots_are_occupied() {
    let (wire, host) = tokio::io::duplex(1 << 20);
    let (reader, mut writer) = split(host);
    let mut responses = Framed::new(reader);
    let permits = Arc::new(Semaphore::new(0));
    let (started, mut entered) = mpsc::unbounded_channel();
    let waiting = permits.clone();
    let client = Client::from_stream(
        wire,
        handler(move |method, _| {
            let started = started.clone();
            let permits = waiting.clone();
            async move {
                if method == "machine.ping" {
                    return Ok(json!({"status":"alive"}));
                }
                started.send(()).expect("host observing starts");
                let _permit = permits.acquire().await.expect("open gate");
                Ok(json!(true))
            }
        }),
    );
    for id in 0..80 {
        write_frame(
            &mut writer,
            &json!({"v":2,"type":"request","id":id.to_string(),"method":"machine.exec","params":{}}),
        )
        .await
        .expect("ordinary request");
    }
    for _ in 0..16 {
        entered.recv().await.expect("ordinary work entered");
    }
    write_frame(
        &mut writer,
        &json!({"v":2,"type":"request","id":"probe","method":"machine.ping","params":{}}),
    )
    .await
    .expect("ping request");
    let reply = next_response(&mut responses).await;
    assert_eq!(reply["id"], "probe");
    assert_eq!(reply["result"]["status"], "alive");
    permits.add_permits(16);
    drop(client);
}

#[tokio::test]
async fn socket_rejects_invalid_ping_params() {
    let mut host = FakeHost::unix().await;
    let _client = Client::connect_unix(
        Path::new(&host.endpoint),
        handler(|_, _| async { Ok(json!({"status":"alive"})) }),
    )
    .await
    .expect("connect");
    host.send(json!({"v":2,"type":"request","id":"invalid","method":"machine.ping","params":{"extra":true}}))
        .await;

    let answer = host.incoming.recv().await.expect("invalid ping answer");

    assert_eq!(answer["id"], "invalid");
    assert_eq!(answer["error"]["code"], 1000);
}

#[tokio::test]
async fn socket_refuses_ninth_pending_ping() {
    let mut host = FakeHost::unix().await;
    let (started, mut pending) = mpsc::unbounded_channel();
    let (release, released) = tokio::sync::watch::channel(false);
    let _client = Client::connect_unix(
        Path::new(&host.endpoint),
        handler(move |_, _| {
            let started = started.clone();
            let mut released = released.clone();
            async move {
                started.send(()).expect("control started");
                released
                    .wait_for(|ready| *ready)
                    .await
                    .expect("control released");
                Ok(json!({"status":"alive"}))
            }
        }),
    )
    .await
    .expect("connect");
    for index in 0..8 {
        host.send(json!({"v":2,"type":"request","id":format!("held-{index}"),"method":"machine.ping","params":{}}))
            .await;
        pending.recv().await.expect("control started");
    }
    host.send(json!({"v":2,"type":"request","id":"overflow","method":"machine.ping","params":{}}))
        .await;

    let answer = host.incoming.recv().await.expect("overflow answer");

    assert_eq!(answer["id"], "overflow");
    assert_eq!(answer["error"]["code"], 4001);
    release.send(true).expect("controls still subscribed");
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
