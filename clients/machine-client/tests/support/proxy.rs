use std::{io::Cursor, sync::Arc};

use futures_util::SinkExt;
use oni_machine_client::transport::ws;
use rustls::ServerConfig;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot},
    task::JoinHandle,
};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::Message;

use crate::support::fake_host::accept;

pub struct TextHost {
    pub endpoint: String,
    pub certificate: String,
    pub private_key: String,
    pub delivered: oneshot::Receiver<()>,
}

impl TextHost {
    pub async fn start(messages: Vec<Message>) -> Self {
        let identity = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()])
            .expect("generate test identity");
        let certificate = identity.cert.pem();
        let private_key = identity.signing_key.serialize_pem();
        let certs = rustls_pemfile::certs(&mut Cursor::new(certificate.as_bytes()))
            .collect::<Result<Vec<_>, _>>()
            .expect("parse test certificate");
        let key = rustls_pemfile::private_key(&mut Cursor::new(private_key.as_bytes()))
            .expect("parse test key")
            .expect("test key present");
        let config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(certs, key)
            .expect("TLS server config");
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind TCP socket");
        let endpoint = listener.local_addr().expect("listener address").to_string();
        let (sent, delivered) = oneshot::channel();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.expect("accept TCP peer");
            let stream = acceptor.accept(tcp).await.expect("TLS accept");
            let mut socket = accept(stream).await.expect("upgrade");
            for message in messages {
                socket.send(message).await.expect("send");
            }
            socket.flush().await.expect("flush");
            sent.send(()).expect("delivery awaited");
            std::future::pending::<()>().await;
        });
        Self {
            endpoint,
            certificate,
            private_key,
            delivered,
        }
    }

    pub fn endpoint(&self) -> ws::WsEndpoint {
        ws::WsEndpoint {
            address: self.endpoint.clone(),
            server_name: "localhost".to_owned(),
            path: ws::PATH.to_owned(),
        }
    }
}

#[derive(Clone, Copy)]
pub enum ProxyAnswer {
    Tunnel,
    Refuse,
    HangUp,
    Flood,
    Garbage,
}

pub struct FakeProxy {
    pub address: String,
    pub connects: mpsc::Receiver<String>,
    task: JoinHandle<()>,
}

impl FakeProxy {
    pub async fn start(answer: ProxyAnswer) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind proxy socket");
        let address = listener.local_addr().expect("proxy address").to_string();
        let (targets, connects) = mpsc::channel(8);
        let task = tokio::spawn(async move {
            let mut parked = Vec::new();
            loop {
                let (mut client, _) = listener.accept().await.expect("accept proxy peer");
                let target = read_connect_target(&mut client).await;
                targets.send(target.clone()).await.expect("target recorded");
                match answer {
                    ProxyAnswer::Tunnel => {
                        let mut upstream = TcpStream::connect(&target).await.expect("dial target");
                        client
                            .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                            .await
                            .expect("tunnel established");
                        tokio::spawn(async move {
                            let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
                        });
                    }
                    ProxyAnswer::Refuse => client
                        .write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n")
                        .await
                        .expect("refusal written"),
                    ProxyAnswer::HangUp => drop(client),
                    ProxyAnswer::Garbage => client
                        .write_all(b"nonsense\r\n\r\n")
                        .await
                        .expect("garbage written"),
                    ProxyAnswer::Flood => {
                        let mut head = b"HTTP/1.1 200 ".to_vec();
                        head.resize(17 * 1024, b'x');
                        client.write_all(&head).await.expect("flood written");
                        parked.push(client);
                    }
                }
            }
        });
        Self {
            address,
            connects,
            task,
        }
    }
}

impl Drop for FakeProxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn read_connect_target(client: &mut TcpStream) -> String {
    let mut head = Vec::new();
    let mut byte = [0_u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        assert_ne!(client.read(&mut byte).await.expect("read"), 0);
        head.push(byte[0]);
    }
    let head = String::from_utf8(head).expect("ASCII request");
    let request = head.lines().next().expect("request line");
    let mut words = request.split(' ');
    assert_eq!(words.next(), Some("CONNECT"));
    let target = words.next().expect("target").to_owned();
    assert_eq!(words.next(), Some("HTTP/1.1"));
    assert!(head.contains(&format!("Host: {target}\r\n")));
    target
}
