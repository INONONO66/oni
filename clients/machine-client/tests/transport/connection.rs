use super::*;
use oni_machine_client::transport::connection::HostTrust;

#[tokio::test]
async fn request_timeout_releases_pending_entry() {
    let host = FakeHost::unix().await;
    let client = Client::connect_unix(
        Path::new(&host.endpoint),
        handler(|_, _| async { Ok(json!(null)) }),
    )
    .await
    .expect("connect");
    assert!(matches!(
        client.call_with_timeout("wait", None, Duration::ZERO).await,
        Err(CallError::Timeout(_))
    ));
    assert_eq!(client.pending_calls(), 0);
}

#[tokio::test]
async fn unix_fake_host_exchanges_request_response() {
    let mut host = FakeHost::unix().await;
    let client = Client::connect_unix(
        Path::new(&host.endpoint),
        handler(|_, _| async { Ok(json!(null)) }),
    )
    .await
    .expect("connect");
    let exchange = async {
        let received = host.incoming.recv().await.expect("outbound request");
        assert_eq!(received["id"], "c1");
        host.send(json!({"v":2,"type":"response","id":"c1","result":{"ok":true}}))
            .await;
    };
    let (call, ()) = tokio::join!(client.call("ping", None), exchange);
    assert_eq!(call.expect("result"), Some(json!({"ok":true})));
}

#[tokio::test]
async fn fake_host_send_writes_the_frame_before_immediate_drop() {
    let host = FakeHost::unix().await;
    let stream = tokio::net::UnixStream::connect(&host.endpoint)
        .await
        .expect("connect");
    let response = json!({"v":2,"type":"response","id":"c1","result":true});

    host.send(response.clone()).await;
    drop(host);
    let mut reader = Framed::new(stream);
    let received = tokio::time::timeout(Duration::from_secs(5), reader.next())
        .await
        .expect("frame arrived")
        .expect("valid frame");

    assert_eq!(received, Some(response));
}

#[tokio::test]
async fn remote_error_settles_call_without_retaining_waiter() {
    let mut host = FakeHost::unix().await;
    let client = Client::connect_unix(
        Path::new(&host.endpoint),
        handler(|_, _| async { Ok(json!(null)) }),
    )
    .await
    .expect("connect");
    let exchange = async {
        let request = host.incoming.recv().await.expect("request");
        host.send(envelope::error(
            request["id"].as_str().expect("id"),
            1000,
            "refused",
        ))
        .await;
    };
    let (call, ()) = tokio::join!(client.call("ping", Some(json!({"x":1}))), exchange);
    assert!(matches!(call, Err(CallError::Remote(_))));
    assert_eq!(client.pending_calls(), 0);
}

#[tokio::test]
async fn peer_disconnect_fails_pending_request_and_cleans_table() {
    let mut host = FakeHost::unix().await;
    let client = Client::connect_unix(
        Path::new(&host.endpoint),
        handler(|_, _| async { Ok(json!(null)) }),
    )
    .await
    .expect("connect");
    let disconnect = async {
        host.incoming.recv().await.expect("request reached host");
        drop(host);
    };
    let (call, ()) = tokio::join!(client.call("ping", None), disconnect);
    assert!(matches!(call, Err(CallError::Disconnected)));
    assert_eq!(client.pending_calls(), 0);
}

#[tokio::test]
async fn notifications_invoke_handler_without_reply() {
    let mut host = FakeHost::unix().await;
    let (observed, mut methods) = mpsc::channel(1);
    let client = Client::connect_unix(
        Path::new(&host.endpoint),
        handler(move |method, params| {
            let observed = observed.clone();
            async move {
                observed
                    .send((method, params))
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(json!(null))
            }
        }),
    )
    .await
    .expect("connect");
    host.send(json!({"v":2,"type":"notification","method":"event","params":{"n":3}}))
        .await;
    assert_eq!(
        methods.recv().await,
        Some(("event".into(), Some(json!({"n":3}))))
    );
    client
        .notify("outbound", Some(json!({"n":4})))
        .await
        .expect("send notification");
    assert_eq!(
        host.incoming.recv().await.expect("outbound notification")["params"]["n"],
        4
    );
    drop(client);
}

#[tokio::test]
async fn inbound_handler_failure_returns_typed_remote_error() {
    let mut host = FakeHost::unix().await;
    let client = Client::connect_unix(
        Path::new(&host.endpoint),
        handler(|_, _| async { Err("unavailable".into()) }),
    )
    .await
    .expect("connect");
    host.send(envelope::request("h1", "missing", None)).await;
    let response = host.incoming.recv().await.expect("handler error");
    assert_eq!(response["id"], "h1");
    assert_eq!(response["error"]["code"], 1000);
    drop(client);
}

#[tokio::test]
async fn tls_fake_host_authenticates_and_exchanges_frames() {
    let mut host = FakeHost::tls().await;
    let (client, _) = Client::connect_tls(
        &host.endpoint,
        "localhost",
        HostTrust::CertPem(host.certificate.as_bytes().to_vec()),
        host.certificate.as_bytes(),
        host.private_key.as_bytes(),
        handler(|_, _| async { Ok(json!(null)) }),
    )
    .await
    .expect("mutual TLS");
    let exchange = async {
        let request = host.incoming.recv().await.expect("TLS request");
        host.send(json!({"v":2,"type":"response","id":request["id"],"result":5}))
            .await;
    };
    let (call, ()) = tokio::join!(client.call("ping", None), exchange);
    assert_eq!(call.expect("result"), Some(json!(5)));
}

#[tokio::test]
async fn tls_host_key_pin_does_not_depend_on_hostname() {
    let mut host = FakeHost::tls().await;
    let (client, _) = Client::connect_tls(
        &host.endpoint,
        "different.example",
        HostTrust::CertPem(host.certificate.as_bytes().to_vec()),
        host.certificate.as_bytes(),
        host.private_key.as_bytes(),
        handler(|_, _| async { Ok(json!(null)) }),
    )
    .await
    .expect("matching public key permits the host");
    let exchange = async {
        let request = host.incoming.recv().await.expect("TLS request");
        host.send(json!({"v":2,"type":"response","id":request["id"],"result":true}))
            .await;
    };
    let (call, ()) = tokio::join!(client.call("ping", None), exchange);
    assert_eq!(call.expect("result"), Some(json!(true)));
}

#[tokio::test]
async fn tls_host_key_mismatch_refuses_connection() {
    let host = FakeHost::tls().await;
    let different = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()])
        .expect("different test key");
    let error = Client::connect_tls(
        &host.endpoint,
        "localhost",
        HostTrust::CertPem(different.cert.pem().into_bytes()),
        host.certificate.as_bytes(),
        host.private_key.as_bytes(),
        handler(|_, _| async { Ok(json!(null)) }),
    )
    .await;
    assert!(matches!(error, Err(TransportError::HostKeyMismatch)));
}

#[tokio::test]
async fn tls12_host_key_pin_verifies_handshake_signature() {
    let mut host = FakeHost::tls12().await;
    let (client, _) = Client::connect_tls(
        &host.endpoint,
        "localhost",
        HostTrust::CertPem(host.certificate.as_bytes().to_vec()),
        host.certificate.as_bytes(),
        host.private_key.as_bytes(),
        handler(|_, _| async { Ok(json!(null)) }),
    )
    .await
    .expect("TLS 1.2 handshake");
    let exchange = async {
        let request = host.incoming.recv().await.expect("TLS request");
        host.send(json!({"v":2,"type":"response","id":request["id"],"result":12}))
            .await;
    };
    let (call, ()) = tokio::join!(client.call("ping", None), exchange);
    assert_eq!(call.expect("result"), Some(json!(12)));
}

#[tokio::test]
async fn tls_transport_error_is_distinct_from_a_host_key_mismatch() {
    let host = FakeHost::tls().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("plain TCP listener");
    let address = listener.local_addr().expect("listener address").to_string();
    let connect = Client::connect_tls(
        &address,
        "localhost",
        HostTrust::CertPem(host.certificate.as_bytes().to_vec()),
        host.certificate.as_bytes(),
        host.private_key.as_bytes(),
        handler(|_, _| async { Ok(json!(null)) }),
    );
    let disconnect = async {
        let (stream, _) = listener.accept().await.expect("accept plain TCP");
        drop(stream);
    };
    let (result, ()) = tokio::join!(connect, disconnect);
    assert!(matches!(result, Err(TransportError::Connect(_))));
}

#[tokio::test]
async fn empty_host_certificate_is_refused_before_connecting() {
    let host = FakeHost::tls().await;
    let result = Client::connect_tls(
        &host.endpoint,
        "localhost",
        HostTrust::CertPem(vec![]),
        host.certificate.as_bytes(),
        host.private_key.as_bytes(),
        handler(|_, _| async { Ok(json!(null)) }),
    )
    .await;
    assert!(matches!(result, Err(TransportError::HostCertificate)));
}

#[tokio::test]
async fn trust_on_first_use_returns_observed_pin_for_subsequent_connections() {
    let host = FakeHost::tls().await;
    let (_, pin) = Client::connect_tls(
        &host.endpoint,
        "localhost",
        HostTrust::TrustOnFirstUse,
        host.certificate.as_bytes(),
        host.private_key.as_bytes(),
        handler(|_, _| async { Ok(json!(null)) }),
    )
    .await
    .expect("first connection");
    drop(host);
    let host = FakeHost::tls().await;
    let result = Client::connect_tls(
        &host.endpoint,
        "localhost",
        HostTrust::Pin(pin),
        host.certificate.as_bytes(),
        host.private_key.as_bytes(),
        handler(|_, _| async { Ok(json!(null)) }),
    )
    .await;
    assert!(matches!(result, Err(TransportError::HostKeyMismatch)));
}

#[tokio::test]
async fn explicit_pin_accepts_matching_host_key() {
    let host = FakeHost::tls().await;
    let certificate = rustls_pemfile::certs(&mut std::io::Cursor::new(host.certificate.as_bytes()))
        .next()
        .expect("certificate")
        .expect("DER");
    let (_, parsed) = x509_parser::parse_x509_certificate(certificate.as_ref()).expect("X.509");
    use sha2::Digest;
    let pin: [u8; 32] = sha2::Sha256::digest(parsed.tbs_certificate.subject_pki.raw).into();
    let (_, observed) = Client::connect_tls(
        &host.endpoint,
        "localhost",
        HostTrust::Pin(pin),
        host.certificate.as_bytes(),
        host.private_key.as_bytes(),
        handler(|_, _| async { Ok(json!(null)) }),
    )
    .await
    .expect("pinned connection");
    assert_eq!(observed, pin);
}

#[tokio::test]
async fn reopened_unix_host_accepts_a_new_client_at_the_same_endpoint() {
    let host = FakeHost::unix().await;
    let endpoint = host.endpoint.clone();
    let mut host = host.reopen().await;
    assert_eq!(host.endpoint, endpoint);
    let client = Client::connect_unix(
        Path::new(&endpoint),
        handler(|_, _| async { Ok(json!(null)) }),
    )
    .await
    .expect("connect");
    let exchange = async {
        let received = host.incoming.recv().await.expect("request");
        host.send(json!({"v":2,"type":"response","id":received["id"],"result":1}))
            .await;
    };
    let (call, ()) = tokio::join!(client.call("ping", None), exchange);
    assert_eq!(call.expect("result"), Some(json!(1)));
}
