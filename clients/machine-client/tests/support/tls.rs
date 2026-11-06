//! The TLS side of a test host: a fresh self-signed identity and an acceptor
//! that asks for a client certificate as the real host does. `fake_host.rs`
//! serves frames over it; `cli.rs` only needs a `mclient join` child to reach
//! a verified host, so it binds this directly.
use std::{io::Cursor, sync::Arc};

use rustls::{server::WebPkiClientVerifier, RootCertStore, ServerConfig, SupportedProtocolVersion};
use tokio_rustls::TlsAcceptor;

/// A self-signed `localhost` identity as PEM: `(certificate, private_key)`.
pub fn identity() -> (String, String) {
    let identity = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()])
        .expect("generate test identity");
    (identity.cert.pem(), identity.signing_key.serialize_pem())
}

/// An acceptor serving `certificate` with `private_key` on `versions`; it
/// trusts only that certificate's signer for client certificates, so a
/// client whose key the host never enrolled fails the handshake server-side
/// after the server certificate has already been carried to it.
pub fn acceptor(
    certificate: &str,
    private_key: &str,
    versions: &[&'static SupportedProtocolVersion],
) -> TlsAcceptor {
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
    let config =
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_protocol_versions(versions)
            .expect("TLS version")
            .with_client_cert_verifier(verifier)
            .with_single_cert(certs, key)
            .expect("TLS server config");
    TlsAcceptor::from(Arc::new(config))
}
