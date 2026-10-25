use std::{io::Cursor, path::PathBuf, sync::Arc, time::Duration};

use oni_machine_client::transport::framing::{write_frame, Framed};
use rustls::{server::WebPkiClientVerifier, RootCertStore, ServerConfig};
use serde_json::Value;
use tokio::{
    io::{split, AsyncRead, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, UnixListener},
    sync::{mpsc, oneshot},
    task::JoinHandle,
};
use tokio_rustls::TlsAcceptor;

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
        Self::tls_with_version(false).await
    }

    pub async fn tls12() -> Self {
        Self::tls_with_version(true).await
    }

    async fn tls_with_version(only_tls12: bool) -> Self {
        let identity = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()])
            .expect("generate test identity");
        let certificate = identity.cert.pem();
        let private_key = identity.signing_key.serialize_pem();
        let mut roots = RootCertStore::empty();
        for cert in rustls_pemfile::certs(&mut Cursor::new(certificate.as_bytes())) {
            roots
                .add(cert.expect("test certificate"))
                .expect("trust test certificate");
        }
        let verifier = WebPkiClientVerifier::builder(Arc::new(roots))
            .build()
            .expect("client certificate verifier");
        let certs = rustls_pemfile::certs(&mut Cursor::new(certificate.as_bytes()))
            .collect::<Result<Vec<_>, _>>()
            .expect("parse test certificate");
        let key = rustls_pemfile::private_key(&mut Cursor::new(private_key.as_bytes()))
            .expect("parse test key")
            .expect("test key present");
        let versions = if only_tls12 {
            &[&rustls::version::TLS12][..]
        } else {
            &[&rustls::version::TLS13][..]
        };
        let config =
            ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_protocol_versions(versions)
                .expect("TLS version")
                .with_client_cert_verifier(verifier)
                .with_single_cert(certs, key)
                .expect("TLS server config");
        let acceptor = TlsAcceptor::from(Arc::new(config));
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
            serve(stream, events, frames).await;
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
