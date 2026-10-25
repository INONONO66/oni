use std::{io::Cursor, path::Path, sync::Arc, time::Duration};

use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms},
    pki_types::{CertificateDer, ServerName, UnixTime},
    CertificateError, ClientConfig, DigitallySignedStruct, Error, SignatureScheme,
};
use sha2::{Digest, Sha256};
use tokio::{
    net::{TcpStream, UnixStream},
    time::timeout,
};
use tokio_rustls::TlsConnector;

use super::client::{Client, Handler, TransportError};

const CONNECT_TIMEOUT: Duration = Duration::from_millis(5_000);

struct HostKeyVerifier {
    expected: Option<[u8; 32]>,
    algorithms: WebPkiSupportedAlgorithms,
}

pub enum HostTrust {
    Pin([u8; 32]),
    CertPem(Vec<u8>),
    TrustOnFirstUse,
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
        if let Some(expected) = self.expected {
            if observed != expected {
                return Err(Error::InvalidCertificate(
                    CertificateError::ApplicationVerificationFailure,
                ));
            }
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

impl Client {
    pub async fn connect_unix(path: &Path, handler: Handler) -> Result<Self, TransportError> {
        let stream = timeout(CONNECT_TIMEOUT, UnixStream::connect(path))
            .await
            .map_err(|_| TransportError::ConnectTimeout)??;
        Ok(Self::from_stream(stream, handler))
    }

    pub async fn connect_tls(
        address: &str,
        server_name: &str,
        trust: HostTrust,
        client_cert_pem: &[u8],
        client_key_pem: &[u8],
        handler: Handler,
    ) -> Result<(Self, [u8; 32]), TransportError> {
        let expected = match trust {
            HostTrust::Pin(pin) => Some(pin),
            HostTrust::CertPem(pem) => {
                let cert = rustls_pemfile::certs(&mut Cursor::new(pem))
                    .next()
                    .transpose()?
                    .ok_or(TransportError::HostCertificate)?;
                Some(public_key_pin(cert.as_ref())?)
            }
            HostTrust::TrustOnFirstUse => None,
        };
        let certs = rustls_pemfile::certs(&mut Cursor::new(client_cert_pem))
            .collect::<Result<Vec<_>, _>>()?;
        let key = rustls_pemfile::private_key(&mut Cursor::new(client_key_pem))?
            .ok_or(TransportError::Closed)?;
        let algorithms = rustls::crypto::ring::default_provider().signature_verification_algorithms;
        let config = ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(HostKeyVerifier {
                expected,
                algorithms,
            }))
            .with_client_auth_cert(certs, key)?;
        let connector = TlsConnector::from(Arc::new(config));
        let name =
            ServerName::try_from(server_name.to_owned()).map_err(|_| TransportError::Closed)?;
        let stream = timeout(CONNECT_TIMEOUT, async {
            let tcp = TcpStream::connect(address).await?;
            connector.connect(name, tcp).await
        })
        .await
        .map_err(|_| TransportError::ConnectTimeout)?
        .map_err(classify_handshake_error)?;
        let pin = stream
            .get_ref()
            .1
            .peer_certificates()
            .and_then(|certs| certs.first())
            .ok_or(TransportError::HostCertificate)
            .and_then(|cert| public_key_pin(cert.as_ref()).map_err(TransportError::Tls))?;
        Ok((Self::from_stream(stream, handler), pin))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifier_debug_name_omits_public_key_material() {
        let verifier = HostKeyVerifier {
            expected: Some([0; 32]),
            algorithms: rustls::crypto::ring::default_provider().signature_verification_algorithms,
        };
        assert_eq!(format!("{verifier:?}"), "HostKeyVerifier");
    }

    #[test]
    fn malformed_presented_certificate_is_refused() {
        let verifier = HostKeyVerifier {
            expected: Some([0; 32]),
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
            expected: Some(public_key_pin(der.as_ref()).expect("valid certificate")),
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
            expected: Some([0; 32]),
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
