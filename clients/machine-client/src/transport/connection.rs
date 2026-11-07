use std::{future::Future, io::Cursor, path::Path, sync::Arc, time::Duration};

use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms},
    pki_types::{CertificateDer, ServerName, UnixTime},
    CertificateError, ClientConfig, DigitallySignedStruct, Error, SignatureScheme,
};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::{TcpStream, UnixStream},
    time::timeout,
};
use tokio_rustls::{client::TlsStream, TlsConnector};

use super::{
    client::{Client, Handler, TransportError},
    handshake::{self, Handshaken, StaticKey},
    seal::Sealed,
    ws::{self, WsEndpoint},
};

const CONNECT_TIMEOUT: Duration = Duration::from_millis(5_000);

/// The one trust a client holds for the host: the sha256 over the
/// SubjectPublicKeyInfo DER of the certificate the host presents. It names
/// the key, never the certificate, so a certificate reissued for the same
/// key (an ACME renewal, a chain with new intermediates) keeps the pin and
/// a different key never matches it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostPin(pub [u8; 32]);

struct HostKeyVerifier {
    expected: [u8; 32],
    algorithms: WebPkiSupportedAlgorithms,
}

impl std::fmt::Debug for HostKeyVerifier {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("HostKeyVerifier")
    }
}

pub fn public_key_pin(der: &[u8]) -> Result<[u8; 32], Error> {
    let (rest, cert) = x509_parser::parse_x509_certificate(der)
        .map_err(|_| Error::InvalidCertificate(CertificateError::BadEncoding))?;
    if !rest.is_empty() {
        return Err(Error::InvalidCertificate(CertificateError::BadEncoding));
    }
    Ok(Sha256::digest(cert.tbs_certificate.subject_pki.raw).into())
}

impl ServerCertVerifier for HostKeyVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        let observed = public_key_pin(end_entity.as_ref())?;
        if observed != self.expected {
            return Err(Error::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

fn classify_handshake_error(error: std::io::Error) -> TransportError {
    if matches!(
        error
            .get_ref()
            .and_then(|source| source.downcast_ref::<Error>()),
        Some(Error::InvalidCertificate(
            CertificateError::ApplicationVerificationFailure
        ))
    ) {
        TransportError::HostKeyMismatch
    } else {
        TransportError::Connect(error)
    }
}

fn tls_connector(
    pin: HostPin,
    client_cert_pem: &[u8],
    client_key_pem: &[u8],
) -> Result<TlsConnector, TransportError> {
    let certs =
        rustls_pemfile::certs(&mut Cursor::new(client_cert_pem)).collect::<Result<Vec<_>, _>>()?;
    let key = rustls_pemfile::private_key(&mut Cursor::new(client_key_pem))?
        .ok_or(TransportError::Closed)?;
    let algorithms = rustls::crypto::ring::default_provider().signature_verification_algorithms;
    let config = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(HostKeyVerifier {
            expected: pin.0,
            algorithms,
        }))
        .with_client_auth_cert(certs, key)?;
    Ok(TlsConnector::from(Arc::new(config)))
}

async fn secure<E: Into<TransportError>>(
    connector: &TlsConnector,
    server_name: &str,
    tcp: impl Future<Output = Result<TcpStream, E>>,
) -> Result<(TlsStream<TcpStream>, [u8; 32]), TransportError> {
    let name = ServerName::try_from(server_name.to_owned()).map_err(|_| TransportError::Closed)?;
    let stream = timeout(CONNECT_TIMEOUT, async {
        let tcp = tcp.await.map_err(Into::into)?;
        connector
            .connect(name, tcp)
            .await
            .map_err(classify_handshake_error)
    })
    .await
    .map_err(|_| TransportError::ConnectTimeout)??;
    let pin = stream
        .get_ref()
        .1
        .peer_certificates()
        .and_then(|certs| certs.first())
        .ok_or(TransportError::HostCertificate)
        .and_then(|cert| public_key_pin(cert.as_ref()).map_err(TransportError::Tls))?;
    Ok((stream, pin))
}

/// The identity a network connection carries: the TLS client certificate
/// and the same key signing the handshake hello.
#[derive(Clone, Copy)]
pub struct Identity<'a> {
    pub machine_id: &'a str,
    pub certificate_pem: &'a [u8],
    pub private_key_pem: &'a [u8],
}

/// A network door before the upgrade: the TCP address, through a proxy for
/// `wss`, and the name TLS verifies.
pub enum Door {
    Tcp {
        address: String,
        server_name: String,
    },
    Wss {
        endpoint: WsEndpoint,
        proxy: Option<String>,
    },
}

async fn secure_door(
    door: &Door,
    pin: HostPin,
    identity: Identity<'_>,
) -> Result<(TlsStream<TcpStream>, [u8; 32]), TransportError> {
    let connector = tls_connector(pin, identity.certificate_pem, identity.private_key_pem)?;
    match door {
        Door::Tcp {
            address,
            server_name,
        } => secure(&connector, server_name, TcpStream::connect(address)).await,
        Door::Wss { endpoint, proxy } => {
            let tcp = async move {
                match proxy {
                    Some(proxy) => ws::connect_through_proxy(proxy, &endpoint.address).await,
                    None => Ok(TcpStream::connect(&endpoint.address).await?),
                }
            };
            secure(&connector, &endpoint.server_name, tcp).await
        }
    }
}

/// Connects once to verify the host key TLS presents against `pin` and hangs
/// up without a handshake: what `join` does before the operator approves the
/// key, when the machine is not yet enrolled and no handshake could succeed.
pub async fn verify_host_key(
    door: &Door,
    pin: HostPin,
    identity: Identity<'_>,
) -> Result<[u8; 32], TransportError> {
    let (stream, observed) = secure_door(door, pin, identity).await?;
    drop(stream);
    Ok(observed)
}

async fn sealed<S>(
    mut stream: S,
    pin: HostPin,
    identity: Identity<'_>,
) -> Result<(Sealed<S>, Handshaken), TransportError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let key = StaticKey::from_pem(identity.certificate_pem, identity.private_key_pem)
        .map_err(TransportError::Handshake)?;
    let (seal, carried, handshaken) = timeout(
        CONNECT_TIMEOUT,
        handshake::initiate(&mut stream, identity.machine_id, &key, pin),
    )
    .await
    .map_err(|_| TransportError::ConnectTimeout)??;
    Ok((Sealed::new(stream, seal, carried), handshaken))
}

impl Client {
    pub async fn connect_unix(path: &Path, handler: Handler) -> Result<Self, TransportError> {
        let stream = timeout(CONNECT_TIMEOUT, UnixStream::connect(path))
            .await
            .map_err(|_| TransportError::ConnectTimeout)??;
        Ok(Self::from_stream(stream, handler))
    }

    /// Connects through a network door: TLS pinned to `pin`, then the signed
    /// handshake, then every frame sealed (#1832).
    pub async fn connect(
        door: &Door,
        pin: HostPin,
        identity: Identity<'_>,
        handler: Handler,
    ) -> Result<(Self, Handshaken), TransportError> {
        let (stream, _) = secure_door(door, pin, identity).await?;
        match door {
            Door::Tcp { .. } => {
                let (stream, handshaken) = sealed(stream, pin, identity).await?;
                Ok((Self::from_stream(stream, handler), handshaken))
            }
            Door::Wss { endpoint, .. } => {
                let socket = timeout(CONNECT_TIMEOUT, ws::upgrade(stream, endpoint))
                    .await
                    .map_err(|_| TransportError::ConnectTimeout)?
                    .map_err(TransportError::Upgrade)?;
                let (stream, handshaken) = sealed(ws::Frames::new(socket), pin, identity).await?;
                Ok((Self::from_stream(stream, handler), handshaken))
            }
        }
    }

    pub async fn connect_tls(
        address: &str,
        server_name: &str,
        pin: HostPin,
        identity: Identity<'_>,
        handler: Handler,
    ) -> Result<(Self, Handshaken), TransportError> {
        Self::connect(
            &Door::Tcp {
                address: address.to_owned(),
                server_name: server_name.to_owned(),
            },
            pin,
            identity,
            handler,
        )
        .await
    }

    pub async fn connect_wss(
        endpoint: &WsEndpoint,
        proxy: Option<&str>,
        pin: HostPin,
        identity: Identity<'_>,
        handler: Handler,
    ) -> Result<(Self, Handshaken), TransportError> {
        Self::connect(
            &Door::Wss {
                endpoint: endpoint.clone(),
                proxy: proxy.map(str::to_owned),
            },
            pin,
            identity,
            handler,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifier_debug_name_omits_public_key_material() {
        let verifier = HostKeyVerifier {
            expected: [0; 32],
            algorithms: rustls::crypto::ring::default_provider().signature_verification_algorithms,
        };
        assert_eq!(format!("{verifier:?}"), "HostKeyVerifier");
    }

    #[test]
    fn malformed_presented_certificate_is_refused() {
        let verifier = HostKeyVerifier {
            expected: [0; 32],
            algorithms: rustls::crypto::ring::default_provider().signature_verification_algorithms,
        };
        let server_name = ServerName::try_from("localhost").expect("server name");
        let bad_der = CertificateDer::from(vec![0xff]);
        assert!(matches!(
            verifier.verify_server_cert(&bad_der, &[], &server_name, &[], UnixTime::now(),),
            Err(Error::InvalidCertificate(CertificateError::BadEncoding))
        ));
    }

    #[test]
    fn matching_presented_key_is_accepted() {
        let identity = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()])
            .expect("test identity");
        let der = CertificateDer::from(identity.cert.der().as_ref().to_vec());
        let verifier = HostKeyVerifier {
            expected: public_key_pin(der.as_ref()).expect("valid certificate"),
            algorithms: rustls::crypto::ring::default_provider().signature_verification_algorithms,
        };
        let name = ServerName::try_from("localhost").expect("server name");
        assert!(verifier
            .verify_server_cert(&der, &[], &name, &[], UnixTime::now())
            .is_ok());
    }

    #[test]
    fn different_presented_key_is_refused() {
        let identity = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()])
            .expect("test identity");
        let der = CertificateDer::from(identity.cert.der().as_ref().to_vec());
        let verifier = HostKeyVerifier {
            expected: [0; 32],
            algorithms: rustls::crypto::ring::default_provider().signature_verification_algorithms,
        };
        let name = ServerName::try_from("localhost").expect("server name");
        assert!(matches!(
            verifier.verify_server_cert(&der, &[], &name, &[], UnixTime::now()),
            Err(Error::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure
            ))
        ));
    }

    #[test]
    fn malformed_certificate_and_trailing_bytes_are_refused() {
        assert!(matches!(
            public_key_pin(b"invalid"),
            Err(Error::InvalidCertificate(CertificateError::BadEncoding))
        ));
        let identity = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()])
            .expect("test identity");
        let mut der = identity.cert.der().as_ref().to_vec();
        der.push(0);
        assert!(matches!(
            public_key_pin(&der),
            Err(Error::InvalidCertificate(CertificateError::BadEncoding))
        ));
    }
}
