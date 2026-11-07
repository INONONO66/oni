use std::{io::Cursor, path::PathBuf, time::Duration};

use oni_machine_client::transport::{
    connection::{public_key_pin, HostPin},
    framing::{write_frame, Framed},
    ws::{self, WsEndpoint},
};
use rcgen::{
    BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair, PKCS_ECDSA_P256_SHA256,
};
use serde_json::Value;
use tokio::{
    io::{split, AsyncRead, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, UnixListener},
    sync::{mpsc, oneshot},
    task::JoinHandle,
};
use tokio_tungstenite::{
    tungstenite::{protocol::WebSocketConfig, Error as WsError},
    WebSocketStream,
};

/// Server side of the upgrade for the fake hosts (the client never accepts).
pub async fn accept<S>(stream: S) -> Result<WebSocketStream<S>, WsError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let config = WebSocketConfig::default().write_buffer_size(0);
    tokio_tungstenite::accept_async_with_config(stream, Some(config)).await
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Listener {
    Tls13,
    Tls12,
    WebSocket,
}

/// The pin of the key a PEM certificate (the first of a chain) carries.
pub fn pin_of(certificate: &str) -> [u8; 32] {
    let der = rustls_pemfile::certs(&mut Cursor::new(certificate.as_bytes()))
        .next()
        .expect("certificate")
        .expect("DER");
    public_key_pin(der.as_ref()).expect("pin")
}

fn host_key() -> KeyPair {
    KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("generate test key")
}

/// A fresh self-signed `localhost` certificate for `key`; each call carries a
/// new serial, so two of them are different certificates for one key.
fn self_signed(key: &KeyPair) -> String {
    CertificateParams::new(vec!["localhost".to_owned()])
        .expect("certificate params")
        .self_signed(key)
        .expect("self-signed test certificate")
        .pem()
}

/// An ACME-style chain for `key`: a `localhost` leaf signed by a fresh test
/// issuer, the issuer certificate appended.
fn issued_chain(key: &KeyPair) -> String {
    let issuer_key = host_key();
    let mut params = CertificateParams::new(Vec::<String>::new()).expect("issuer params");
    params
        .distinguished_name
        .push(DnType::CommonName, "oni-test-issuer");
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let issuer_pem = params
        .self_signed(&issuer_key)
        .expect("issuer certificate")
        .pem();
    let issuer = Issuer::new(params, issuer_key);
    let leaf = CertificateParams::new(vec!["localhost".to_owned()])
        .expect("leaf params")
        .signed_by(key, &issuer)
        .expect("issued test certificate");
    format!("{}{issuer_pem}", leaf.pem())
}

pub struct FakeHost {
    pub endpoint: String,
    pub certificate: String,
    pub private_key: String,
    pub incoming: mpsc::Receiver<Value>,
    outgoing: mpsc::Sender<(Value, oneshot::Sender<()>)>,
    task: JoinHandle<()>,
    _directory: Option<tempfile::TempDir>,
}

impl FakeHost {
    pub async fn unix() -> Self {
        Self::unix_in(tempfile::tempdir().expect("temporary socket directory")).await
    }

    pub async fn reopen(mut self) -> Self {
        let directory = self._directory.take().expect("Unix host directory");
        std::fs::remove_file(directory.path().join("host.sock")).expect("remove socket");
        drop(self);
        Self::unix_in(directory).await
    }

    async fn unix_in(directory: tempfile::TempDir) -> Self {
        let path: PathBuf = directory.path().join("host.sock");
        let listener = UnixListener::bind(&path).expect("bind Unix socket");
        let (events, incoming) = mpsc::channel(256);
        let (outgoing, frames) = mpsc::channel(256);
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept Unix peer");
            serve(stream, events, frames).await;
        });
        Self {
            endpoint: path.to_string_lossy().into_owned(),
            certificate: String::new(),
            private_key: String::new(),
            incoming,
            outgoing,
            task,
            _directory: Some(directory),
        }
    }

    pub async fn tls() -> Self {
        let key = host_key();
        Self::listen(Listener::Tls13, self_signed(&key), key.serialize_pem()).await
    }

    pub async fn tls12() -> Self {
        let key = host_key();
        Self::listen(Listener::Tls12, self_signed(&key), key.serialize_pem()).await
    }

    pub async fn ws() -> Self {
        let key = host_key();
        Self::listen(Listener::WebSocket, self_signed(&key), key.serialize_pem()).await
    }

    /// A host that reissued its certificate for the key a client pinned
    /// earlier: the host serving the new certificate, and the one it replaced.
    pub async fn tls_renewed() -> (Self, String) {
        let key = host_key();
        let replaced = self_signed(&key);
        let host = Self::listen(Listener::Tls13, self_signed(&key), key.serialize_pem()).await;
        (host, replaced)
    }

    /// A host that moved from a self-signed certificate to an issued chain for
    /// the same key: the host serving the chain, and the certificate it replaced.
    pub async fn tls_chain() -> (Self, String) {
        let key = host_key();
        let replaced = self_signed(&key);
        let host = Self::listen(Listener::Tls13, issued_chain(&key), key.serialize_pem()).await;
        (host, replaced)
    }

    /// The pin of the key this host presents.
    pub fn pin(&self) -> HostPin {
        HostPin(pin_of(&self.certificate))
    }

    pub fn ws_endpoint(&self) -> WsEndpoint {
        WsEndpoint {
            address: self.endpoint.clone(),
            server_name: "localhost".to_owned(),
            path: ws::PATH.to_owned(),
        }
    }

    /// Serves `certificate` (a leaf, or a chain leaf first) for `private_key`;
    /// the one client it accepts must present an identity those certificates
    /// anchor, which is why tests hand the host's own identity to the client.
    async fn listen(listener_kind: Listener, certificate: String, private_key: String) -> Self {
        let versions = match listener_kind {
            Listener::Tls12 => &[&rustls::version::TLS12][..],
            Listener::Tls13 | Listener::WebSocket => &[&rustls::version::TLS13][..],
        };
        let acceptor = super::tls::acceptor(&certificate, &private_key, versions);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind TCP socket");
        let endpoint = listener.local_addr().expect("listener address").to_string();
        let (events, incoming) = mpsc::channel(256);
        let (outgoing, frames) = mpsc::channel(256);
        let task = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.expect("accept TCP peer");
            let Ok(stream) = acceptor.accept(tcp).await else {
                return;
            };
            if listener_kind == Listener::WebSocket {
                let Ok(socket) = accept(stream).await else {
                    return;
                };
                serve(ws::Frames::new(socket), events, frames).await;
            } else {
                serve(stream, events, frames).await;
            }
        });
        Self {
            endpoint,
            certificate,
            private_key,
            incoming,
            outgoing,
            task,
            _directory: None,
        }
    }

    pub async fn send(&self, frame: Value) {
        let (sent, written) = oneshot::channel();
        self.outgoing
            .send((frame, sent))
            .await
            .expect("fake host connected");
        tokio::time::timeout(Duration::from_secs(5), written)
            .await
            .expect("fake host write completed")
            .expect("fake host frame written");
    }
}

impl Drop for FakeHost {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn serve<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    stream: S,
    events: mpsc::Sender<Value>,
    mut frames: mpsc::Receiver<(Value, oneshot::Sender<()>)>,
) {
    let (reader, mut writer) = split(stream);
    let mut reader = Framed::new(reader);
    loop {
        tokio::select! {
            received = reader.next() => match received {
                Ok(Some(frame)) => {
                    if events.send(frame).await.is_err() { return; }
                }
                Ok(None) | Err(_) => return,
            },
            outgoing = frames.recv() => match outgoing {
                Some((frame, sent)) => {
                    if write_frame(&mut writer, &frame).await.is_err() { return; }
                    if writer.flush().await.is_err() { return; }
                    sent.send(()).expect("fake host write receipt awaited");
                }
                None => return,
            }
        }
    }
}
