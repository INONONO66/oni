use super::*;
use oni_machine_client::{
    config::encode_pin,
    transport::{
        connection::{public_key_pin, HostPin, Identity},
        handshake::HandshakeError,
        ws,
    },
};
use support::fake_host::pin_of;
use tokio_tungstenite::tungstenite::{Bytes, Message};

fn identity<'a>(certificate: &'a str, private_key: &'a str) -> Identity<'a> {
    Identity {
        machine_id: "machine-test",
        certificate_pem: certificate.as_bytes(),
        private_key_pem: private_key.as_bytes(),
    }
}

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
        host.pin(),
        identity(&host.certificate, &host.private_key),
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
        host.pin(),
        identity(&host.certificate, &host.private_key),
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
async fn a_host_certificate_for_a_different_key_is_refused_before_any_frame() {
    let mut host = FakeHost::tls().await;
    let different = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()])
        .expect("different test key");
    let error = Client::connect_tls(
        &host.endpoint,
        "localhost",
        HostPin(pin_of(&different.cert.pem())),
        identity(&host.certificate, &host.private_key),
        handler(|_, _| async { Ok(json!(null)) }),
    )
    .await;
    assert!(matches!(error, Err(TransportError::HostKeyMismatch)));
    let observed = tokio::time::timeout(Duration::from_secs(5), host.incoming.recv())
        .await
        .expect("the host's accept loop ends within the bound after the refused handshake");
    assert_eq!(observed, None, "the handshake was all the host saw");
}

#[tokio::test]
async fn a_certificate_renewed_for_the_pinned_key_passes_the_pin() {
    let (mut host, replaced) = FakeHost::tls_renewed().await;
    assert_ne!(host.certificate, replaced);
    let pin = HostPin(pin_of(&replaced));
    assert_eq!(pin, host.pin());
    let (client, observed) = Client::connect_tls(
        &host.endpoint,
        "localhost",
        pin,
        identity(&host.certificate, &host.private_key),
        handler(|_, _| async { Ok(json!(null)) }),
    )
    .await
    .expect("the renewed certificate carries the pinned key");
    assert_eq!(observed.host_key, encode_pin(&pin.0));
    let exchange = async {
        let request = host.incoming.recv().await.expect("TLS request");
        host.send(json!({"v":2,"type":"response","id":request["id"],"result":"renewed"}))
            .await;
    };
    let (call, ()) = tokio::join!(client.call("ping", None), exchange);
    assert_eq!(call.expect("result"), Some(json!("renewed")));
}

/// The pin of the committed `host-cert.pem` fixture, computed once by
/// `openssl` and asserted by `packages/machines/test/ipc/network-tls.test.ts`
/// over the same file, so the two hashes are proven equal without a binary.
const HOST_FIXTURE_PIN: &str = "r9E1hURv+fC1akcg+pV4WrFyDYMF+bylOUOXJ0MOBs4=";

macro_rules! host_fixture {
    ($name:literal) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/machines/test/ipc/fixtures/",
            $name
        ))
    };
}

#[test]
fn the_committed_host_fixture_pin_is_one_literal_shared_with_the_typescript_test() {
    let encode = |pem: &str| oni_machine_client::config::encode_pin(&pin_of(pem));
    assert_eq!(encode(host_fixture!("host-cert.pem")), HOST_FIXTURE_PIN);
    assert_eq!(
        encode(host_fixture!("host-renewed-cert.pem")),
        HOST_FIXTURE_PIN
    );
    assert_eq!(encode(host_fixture!("host-chain.pem")), HOST_FIXTURE_PIN);
    assert_ne!(encode(host_fixture!("wrong-cert.pem")), HOST_FIXTURE_PIN);
}

#[tokio::test]
async fn an_issued_chain_for_the_pinned_key_passes_the_pin() {
    let (mut host, replaced) = FakeHost::tls_chain().await;
    assert_eq!(host.certificate.matches("BEGIN CERTIFICATE").count(), 2);
    let pin = HostPin(pin_of(&replaced));
    let (client, observed) = Client::connect_tls(
        &host.endpoint,
        "localhost",
        pin,
        identity(&host.certificate, &host.private_key),
        handler(|_, _| async { Ok(json!(null)) }),
    )
    .await
    .expect("the chain's leaf carries the pinned key");
    assert_eq!(observed.host_key, encode_pin(&pin.0));
    let exchange = async {
        let request = host.incoming.recv().await.expect("TLS request");
        host.send(json!({"v":2,"type":"response","id":request["id"],"result":"chain"}))
            .await;
    };
    let (call, ()) = tokio::join!(client.call("ping", None), exchange);
    assert_eq!(call.expect("result"), Some(json!("chain")));
}

#[tokio::test]
async fn tls12_host_key_pin_verifies_handshake_signature() {
    let mut host = FakeHost::tls12().await;
    let (client, _) = Client::connect_tls(
        &host.endpoint,
        "localhost",
        host.pin(),
        identity(&host.certificate, &host.private_key),
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
        host.pin(),
        identity(&host.certificate, &host.private_key),
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
async fn explicit_pin_refuses_a_different_host_key() {
    let host = FakeHost::tls().await;
    let result = Client::connect_tls(
        &host.endpoint,
        "localhost",
        HostPin([0; 32]),
        identity(&host.certificate, &host.private_key),
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
        HostPin(pin),
        identity(&host.certificate, &host.private_key),
        handler(|_, _| async { Ok(json!(null)) }),
    )
    .await
    .expect("pinned connection");
    assert_eq!(observed.host_key, encode_pin(&pin));
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

fn service() -> oni_machine_client::transport::client::Handler {
    handler(|_, _| async { Ok(json!(null)) })
}

async fn exchange_over(client: &Client, host: &mut FakeHost, result: serde_json::Value) {
    let exchange = async {
        let request = host.incoming.recv().await.expect("wss request");
        host.send(json!({"v":2,"type":"response","id":request["id"],"result":result}))
            .await;
    };
    let (call, ()) = tokio::join!(client.call("ping", None), exchange);
    assert_eq!(call.expect("result"), Some(json!(result)));
}

#[tokio::test]
async fn wss_fake_host_authenticates_and_pins_the_same_host_key() {
    let mut host = FakeHost::ws().await;
    let (client, pin) = Client::connect_wss(
        &host.ws_endpoint(),
        None,
        host.pin(),
        identity(&host.certificate, &host.private_key),
        service(),
    )
    .await
    .expect("mutual TLS over the WebSocket carrier");
    let certificate = rustls_pemfile::certs(&mut io::Cursor::new(host.certificate.as_bytes()))
        .next()
        .expect("host certificate")
        .expect("valid PEM");
    assert_eq!(
        pin.host_key,
        encode_pin(&public_key_pin(certificate.as_ref()).expect("host public key pin"))
    );
    exchange_over(&client, &mut host, json!({"carrier":"wss"})).await;
}

#[tokio::test]
async fn wss_dial_tunnels_through_the_connect_proxy() {
    let mut host = FakeHost::ws().await;
    let mut proxy = proxy::FakeProxy::start(proxy::ProxyAnswer::Tunnel).await;
    let (client, _) = Client::connect_wss(
        &host.ws_endpoint(),
        Some(&proxy.address),
        host.pin(),
        identity(&host.certificate, &host.private_key),
        service(),
    )
    .await
    .expect("wss through CONNECT");
    assert_eq!(proxy.connects.recv().await, Some(host.endpoint.clone()));
    exchange_over(&client, &mut host, json!(7)).await;
}

async fn proxy_failure(answer: proxy::ProxyAnswer) -> (String, TransportError) {
    let host = FakeHost::ws().await;
    let mut proxy = proxy::FakeProxy::start(answer).await;
    let error = Client::connect_wss(
        &host.ws_endpoint(),
        Some(&proxy.address),
        host.pin(),
        identity(&host.certificate, &host.private_key),
        service(),
    )
    .await
    .err()
    .expect("failed tunnel");
    assert_eq!(proxy.connects.recv().await, Some(host.endpoint.clone()));
    (host.endpoint.clone(), error)
}

#[tokio::test]
async fn wss_dial_reports_a_proxy_refusal() {
    let (_, error) = proxy_failure(proxy::ProxyAnswer::Refuse).await;
    assert!(matches!(
        error,
        TransportError::Proxy(ws::ProxyFailure::Refused { status: 403 })
    ));
}

#[tokio::test]
async fn wss_dial_refuses_a_proxy_that_hangs_up_before_answering() {
    let (_, error) = proxy_failure(proxy::ProxyAnswer::HangUp).await;
    assert!(matches!(
        error,
        TransportError::Proxy(ws::ProxyFailure::ClosedEarly)
    ));
}

#[tokio::test]
async fn wss_dial_refuses_an_oversized_proxy_answer() {
    let (_, error) = proxy_failure(proxy::ProxyAnswer::Flood).await;
    assert!(matches!(
        error,
        TransportError::Proxy(ws::ProxyFailure::HeadTooLarge)
    ));
}

#[tokio::test]
async fn wss_dial_refuses_a_proxy_answer_without_a_status_line() {
    let (_, error) = proxy_failure(proxy::ProxyAnswer::Garbage).await;
    assert!(matches!(
        error,
        TransportError::Proxy(ws::ProxyFailure::Malformed)
    ));
}

#[tokio::test]
async fn wss_text_message_is_refused_as_invalid_data() {
    let host = proxy::TextHost::start(vec![
        Message::Ping(Bytes::new()),
        Message::Text("{}".into()),
    ])
    .await;
    let endpoint = host.endpoint();
    let connect = Client::connect_wss(
        &endpoint,
        None,
        HostPin(pin_of(&host.certificate)),
        identity(&host.certificate, &host.private_key),
        service(),
    );
    let (result, delivered) = tokio::join!(connect, host.delivered);
    delivered.expect("messages sent");
    assert!(matches!(
        result.err(),
        Some(TransportError::Handshake(HandshakeError::Io(error)))
            if error.kind() == io::ErrorKind::InvalidData
                && error.to_string() == "the machine wire carries binary frames only"
    ));
}

#[test]
fn proxy_address_normalizes_the_environment_value() {
    let address = |value: Option<&str>| ws::proxy_address(value).expect("proxy address");
    assert_eq!(address(None), None);
    assert_eq!(address(Some("  ")), None);
    assert_eq!(address(Some("http://")), None);
    assert_eq!(
        address(Some("http://proxy.example:3128/")),
        Some("proxy.example:3128".to_owned())
    );
    assert_eq!(
        address(Some("10.0.0.1:8080")),
        Some("10.0.0.1:8080".to_owned())
    );
    assert_eq!(
        address(Some("http://proxy.example")),
        Some("proxy.example:80".to_owned())
    );
    assert_eq!(address(Some("[::1]:3128")), Some("[::1]:3128".to_owned()));
    for unsupported in [
        "https://proxy.example:3128",
        "http://user:pass@proxy.example:3128",
    ] {
        assert!(matches!(
            ws::proxy_address(Some(unsupported)),
            Err(ws::ProxyFailure::Unsupported)
        ));
    }
}

/// The handshake at the connection level (#1832): what the host saw in the
/// hello, and the typed outcome of every answer it can give, on both carriers.
mod signed_handshake {
    use super::*;
    use oni_machine_client::transport::handshake::{Handshaken, Refusal};
    use support::fake_host::FakeHost;
    use support::responder::Answer;

    async fn dial(host: &FakeHost, wss: bool) -> Result<(Client, Handshaken), TransportError> {
        let identity = identity(&host.certificate, &host.private_key);
        if wss {
            Client::connect_wss(&host.ws_endpoint(), None, host.pin(), identity, service()).await
        } else {
            Client::connect_tls(&host.endpoint, "localhost", host.pin(), identity, service()).await
        }
    }

    /// The handshake error a dial ended with; an accepted dial is the failure.
    fn handshake_error(dialed: Result<(Client, Handshaken), TransportError>) -> HandshakeError {
        match dialed {
            Err(TransportError::Handshake(error)) => error,
            Err(other) => panic!("expected a handshake error, got {other:?}"),
            Ok(_) => panic!("the host accepted a handshake it should have refused"),
        }
    }

    #[tokio::test]
    async fn the_hello_names_the_machine_the_contract_and_fresh_material_under_a_valid_signature() {
        for wss in [false, true] {
            let mut host = if wss {
                FakeHost::ws().await
            } else {
                FakeHost::tls().await
            };
            let (client, _) = dial(&host, wss).await.expect("accepted");
            let seen = host.handshake_seen().expect("the host saw the hello");
            assert!(seen.signature_verified);
            assert_eq!(seen.hello.machine_id, "machine-test");
            assert_eq!(seen.hello.contract_version, oni_protocol::CONTRACT_VERSION);
            assert_eq!(seen.hello.ephemeral_key.len(), 44);
            assert_eq!(seen.hello.nonce.len(), 44);
            assert_ne!(seen.hello.ephemeral_key, seen.hello.nonce);
            assert!(!seen.hello.static_key.is_empty());
            exchange_over(&client, &mut host, json!({"sealed": wss})).await;
            drop(client);
            let again = if wss {
                FakeHost::ws().await
            } else {
                FakeHost::tls().await
            };
            let (_client, _) = dial(&again, wss).await.expect("accepted again");
            let fresh = again.handshake_seen().expect("the second hello");
            assert_ne!(
                fresh.hello.nonce, seen.hello.nonce,
                "every hello carries a fresh nonce"
            );
            assert_ne!(
                fresh.hello.ephemeral_key, seen.hello.ephemeral_key,
                "and a fresh ephemeral"
            );
        }
    }

    #[tokio::test]
    async fn every_refusal_reason_is_typed_and_ends_the_connection_before_any_frame() {
        for (reason, expected) in [
            ("not_admitted", Refusal::NotAdmitted),
            ("replay", Refusal::Replay),
            ("unsupported_contract", Refusal::UnsupportedContract),
        ] {
            for wss in [false, true] {
                let host = if wss {
                    FakeHost::ws_answering(Answer::Refuse(reason)).await
                } else {
                    FakeHost::tls_answering(Answer::Refuse(reason)).await
                };
                let error = handshake_error(dial(&host, wss).await);
                assert!(
                    matches!(&error, HandshakeError::Refused(refusal) if *refusal == expected),
                    "{reason} over {}: {error:?}",
                    if wss { "wss" } else { "tcp" }
                );
                assert_eq!(
                    error.to_string(),
                    format!("the host refused the handshake: {reason}")
                );
            }
        }
    }

    #[tokio::test]
    async fn an_acceptance_under_a_key_the_client_never_pinned_is_refused() {
        for wss in [false, true] {
            let host = if wss {
                FakeHost::ws_answering(Answer::ForeignKey).await
            } else {
                FakeHost::tls_answering(Answer::ForeignKey).await
            };
            let error = handshake_error(dial(&host, wss).await);
            assert!(matches!(error, HandshakeError::HostKey), "{error:?}");
        }
    }

    #[tokio::test]
    async fn an_acceptance_whose_signature_does_not_verify_is_refused() {
        for wss in [false, true] {
            let host = if wss {
                FakeHost::ws_answering(Answer::BadSignature).await
            } else {
                FakeHost::tls_answering(Answer::BadSignature).await
            };
            let error = handshake_error(dial(&host, wss).await);
            assert!(matches!(error, HandshakeError::HostSignature), "{error:?}");
        }
    }

    #[tokio::test]
    async fn a_host_that_hangs_up_on_the_hello_is_a_closed_handshake() {
        for wss in [false, true] {
            let host = if wss {
                FakeHost::ws_answering(Answer::Close).await
            } else {
                FakeHost::tls_answering(Answer::Close).await
            };
            let error = handshake_error(dial(&host, wss).await);
            assert!(matches!(error, HandshakeError::Closed), "{error:?}");
        }
    }
}
