//! The machine side of the signed handshake of machine contract v6 (#1832).
//! `machine.handshake` is the first call on every network door: the client
//! proves the key its enrollment pinned by signing the hello transcript with
//! its static P-256 key, the host proves the key `join` pinned by signing
//! the acceptance, and both derive the session keys of `seal` from one
//! X25519 agreement bound to the whole transcript. Every fold here mirrors
//! `packages/protocol/src/machine/handshake.ts`, `packages/machines/src/ipc/keys.ts`
//! and `packages/machines/src/handshake.ts` byte for byte; the pinned host
//! key is the only trust, never the first key seen.

use std::io::Cursor;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use oni_protocol::{HandshakeResult, HandshakeResultRefusedReason};
use ring::{
    agreement, hkdf,
    rand::{SecureRandom, SystemRandom},
    signature,
};
use rustls::pki_types::PrivateKeyDer;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::{
    connection::HostPin,
    framing::{FrameError, MAX_FRAME_BYTES},
    seal::{FrameSeal, SealKeys, KEY_BYTES},
};

pub const METHOD: &str = "machine.handshake";
pub const LABEL: &str = "oni-machine-handshake/6";
pub const FRAME_KEY_LABEL: &str = "oni-machine-frames/6";
pub const AAD_TO_HOST: &[u8] = b"c2h";
pub const AAD_TO_MACHINE: &[u8] = b"h2c";
const NONCE_BYTES: usize = 32;
const EPHEMERAL_KEY_BYTES: usize = 32;
const SIGNATURE_BYTES: usize = 64;
const REQUEST_ID: &str = "handshake";

/// The host's typed refusals, in the order it judges them.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Refusal {
    UnsupportedContract,
    Replay,
    NotAdmitted,
}

impl Refusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnsupportedContract => "unsupported_contract",
            Self::Replay => "replay",
            Self::NotAdmitted => "not_admitted",
        }
    }
}

impl From<HandshakeResultRefusedReason> for Refusal {
    fn from(reason: HandshakeResultRefusedReason) -> Self {
        match reason {
            HandshakeResultRefusedReason::UnsupportedContract => Self::UnsupportedContract,
            HandshakeResultRefusedReason::Replay => Self::Replay,
            HandshakeResultRefusedReason::NotAdmitted => Self::NotAdmitted,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum HandshakeError {
    #[error("the client certificate carries no P-256 key the handshake can sign with")]
    ClientKey,
    #[error("the system random source is unavailable")]
    Random,
    #[error("the host refused the handshake: {}", .0.as_str())]
    Refused(Refusal),
    #[error("the host's acceptance does not carry the pinned key")]
    HostKey,
    #[error("the host's acceptance signature does not verify against the pinned key")]
    HostSignature,
    #[error("the host answered the handshake with {0}")]
    Malformed(String),
    #[error("the connection ended before the host answered the handshake")]
    Closed,
    #[error(transparent)]
    Frame(#[from] FrameError),
    #[error("IPC connection failed: {0}")]
    Io(#[from] std::io::Error),
}

/// What an accepted handshake proved, kept in the attach receipt.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Handshaken {
    pub contract_version: u32,
    /// The pinned host key the acceptance was signed with, as `join` encodes pins.
    pub host_key: String,
}

/// The static identity the client signs with: the enrollment key pair
/// `join` generated, read from `client-cert.pem` and `client-key.pem`.
pub struct ClientKey {
    static_key_spki: Vec<u8>,
    key_pair: signature::EcdsaKeyPair,
}

impl ClientKey {
    pub fn from_pem(certificate_pem: &[u8], private_key_pem: &[u8]) -> Result<Self, HandshakeError> {
        let certificate = rustls_pemfile::certs(&mut Cursor::new(certificate_pem))
            .next()
            .ok_or(HandshakeError::ClientKey)?
            .map_err(|_| HandshakeError::ClientKey)?;
        let (_, parsed) = x509_parser::parse_x509_certificate(certificate.as_ref())
            .map_err(|_| HandshakeError::ClientKey)?;
        let static_key_spki = parsed.tbs_certificate.subject_pki.raw.to_vec();
        let private_key = rustls_pemfile::private_key(&mut Cursor::new(private_key_pem))
            .map_err(|_| HandshakeError::ClientKey)?
            .ok_or(HandshakeError::ClientKey)?;
        let PrivateKeyDer::Pkcs8(pkcs8) = private_key else {
            return Err(HandshakeError::ClientKey);
        };
        let key_pair = signature::EcdsaKeyPair::from_pkcs8(
            &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            pkcs8.secret_pkcs8_der(),
            &SystemRandom::new(),
        )
        .map_err(|_| HandshakeError::ClientKey)?;
        Ok(Self {
            static_key_spki,
            key_pair,
        })
    }

    /// The sha256 hex fingerprint of the SPKI, the identity the host enrolls.
    pub fn fingerprint(&self) -> String {
        hex::encode(Sha256::digest(&self.static_key_spki))
    }

    fn sign(&self, transcript: &[u8]) -> Result<Vec<u8>, HandshakeError> {
        self.key_pair
            .sign(&SystemRandom::new(), transcript)
            .map(|signature| signature.as_ref().to_vec())
            .map_err(|_| HandshakeError::Random)
    }
}

/// The hello the client sends, without its signature.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Hello {
    pub machine_id: String,
    pub contract_version: u32,
    pub static_key: String,
    pub ephemeral_key: String,
    pub nonce: String,
}

/// The acceptance the host answers with, without its signature.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Accept {
    pub static_key: String,
    pub ephemeral_key: String,
    pub nonce: String,
}

fn field(transcript: &mut Vec<u8>, value: &str) {
    let bytes = value.as_bytes();
    transcript.extend_from_slice(&u32::try_from(bytes.len()).unwrap_or(u32::MAX).to_be_bytes());
    transcript.extend_from_slice(bytes);
}

pub fn hello_transcript(hello: &Hello) -> Vec<u8> {
    let mut transcript = format!("{LABEL}\nhello\n").into_bytes();
    field(&mut transcript, &hello.machine_id);
    field(&mut transcript, "client");
    field(&mut transcript, &hello.contract_version.to_string());
    field(&mut transcript, &hello.static_key);
    field(&mut transcript, &hello.ephemeral_key);
    field(&mut transcript, &hello.nonce);
    transcript
}

pub fn accept_transcript(hello: &Hello, accept: &Accept) -> Vec<u8> {
    let mut transcript = format!("{LABEL}\naccept\n").into_bytes();
    transcript.extend_from_slice(&hello_transcript(hello));
    field(&mut transcript, &accept.static_key);
    field(&mut transcript, &accept.ephemeral_key);
    field(&mut transcript, &accept.nonce);
    transcript
}

pub fn session_transcript(
    hello: &Hello,
    hello_signature: &str,
    accept: &Accept,
    accept_signature: &str,
) -> Vec<u8> {
    let mut transcript = accept_transcript(hello, accept);
    field(&mut transcript, hello_signature);
    field(&mut transcript, accept_signature);
    transcript
}

/// The initiator's keys: it sends under the first half of the HKDF output
/// with the machine-to-host associated data, and receives under the second.
pub fn derive_initiator_keys(
    own: agreement::EphemeralPrivateKey,
    peer_ephemeral_key: &[u8],
    session_transcript: &[u8],
) -> Result<SealKeys, HandshakeError> {
    struct Length(usize);
    impl hkdf::KeyType for Length {
        fn len(&self) -> usize {
            self.0
        }
    }
    let peer = agreement::UnparsedPublicKey::new(&agreement::X25519, peer_ephemeral_key);
    let salt = Sha256::digest(session_transcript);
    let okm = agreement::agree_ephemeral(own, &peer, |shared| {
        let mut okm = [0; KEY_BYTES * 2];
        hkdf::Salt::new(hkdf::HKDF_SHA256, &salt)
            .extract(shared)
            .expand(&[FRAME_KEY_LABEL.as_bytes()], Length(okm.len()))
            .and_then(|output| output.fill(&mut okm))
            .map(|()| okm)
    })
    .map_err(|_| HandshakeError::HostSignature)?
    .map_err(|_| HandshakeError::HostSignature)?;
    let mut send = [0; KEY_BYTES];
    let mut receive = [0; KEY_BYTES];
    send.copy_from_slice(&okm[..KEY_BYTES]);
    receive.copy_from_slice(&okm[KEY_BYTES..]);
    Ok(SealKeys {
        send,
        receive,
        send_aad: AAD_TO_HOST,
        receive_aad: AAD_TO_MACHINE,
    })
}

fn decode_fixed(value: &str, length: usize) -> Result<Vec<u8>, HandshakeError> {
    let bytes = BASE64
        .decode(value)
        .map_err(|_| HandshakeError::Malformed(format!("a field that is not base64: {value}")))?;
    if bytes.len() != length {
        return Err(HandshakeError::Malformed(format!(
            "a {}-byte field where {length} bytes were expected",
            bytes.len()
        )));
    }
    Ok(bytes)
}

/// Verifies the host's acceptance against the pinned key: the SPKI it names
/// must hash to the pin, and its signature over the accept transcript must
/// verify under that SPKI's P-256 point.
pub fn verify_accept(
    pin: HostPin,
    hello: &Hello,
    accept: &Accept,
    signature: &str,
) -> Result<(), HandshakeError> {
    let static_key = BASE64
        .decode(&accept.static_key)
        .map_err(|_| HandshakeError::Malformed("a static key that is not base64".to_owned()))?;
    let observed: [u8; 32] = Sha256::digest(&static_key).into();
    if observed != pin.0 {
        return Err(HandshakeError::HostKey);
    }
    let signature = decode_fixed(signature, SIGNATURE_BYTES)?;
    let (_, spki) = x509_parser::x509::SubjectPublicKeyInfo::from_der(&static_key)
        .map_err(|_| HandshakeError::HostSignature)?;
    signature::UnparsedPublicKey::new(
        &signature::ECDSA_P256_SHA256_FIXED,
        spki.subject_public_key.data.as_ref(),
    )
    .verify(&accept_transcript(hello, accept), &signature)
    .map_err(|_| HandshakeError::HostSignature)
}

fn random_bytes<const N: usize>() -> Result<[u8; N], HandshakeError> {
    let mut bytes = [0; N];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| HandshakeError::Random)?;
    Ok(bytes)
}

/// Reads one line from the carrier; whatever follows it stays `carried`.
async fn read_line<S: AsyncRead + Unpin>(
    stream: &mut S,
) -> Result<(Vec<u8>, Vec<u8>), HandshakeError> {
    let mut pending = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        if let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
            let carried = pending.split_off(end + 1);
            pending.pop();
            return Ok((pending, carried));
        }
        if pending.len() > MAX_FRAME_BYTES {
            return Err(FrameError::Oversize.into());
        }
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Err(HandshakeError::Closed);
        }
        pending.extend_from_slice(&chunk[..read]);
    }
}

fn result_of(line: &[u8]) -> Result<HandshakeResult, HandshakeError> {
    let frame: Value = serde_json::from_slice(line).map_err(FrameError::Json)?;
    if frame.get("id").and_then(Value::as_str) != Some(REQUEST_ID) {
        return Err(HandshakeError::Malformed(
            "a frame that does not answer the handshake".to_owned(),
        ));
    }
    if let Some(error) = frame.get("error") {
        return Err(HandshakeError::Malformed(format!("error {error}")));
    }
    let result = frame
        .get("result")
        .cloned()
        .ok_or_else(|| HandshakeError::Malformed("a response without a result".to_owned()))?;
    oni_protocol::decode::<HandshakeResult>(result)
        .map_err(|error| HandshakeError::Malformed(error.to_string()))
}

/// Runs the handshake on a freshly connected carrier and returns the seal of
/// the session with the bytes the host sent past its acceptance.
pub async fn initiate<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    machine_id: &str,
    key: &ClientKey,
    pin: HostPin,
) -> Result<(FrameSeal, Vec<u8>, Handshaken), HandshakeError> {
    let own = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &SystemRandom::new())
        .map_err(|_| HandshakeError::Random)?;
    let ephemeral_key = own
        .compute_public_key()
        .map_err(|_| HandshakeError::Random)?;
    let hello = Hello {
        machine_id: machine_id.to_owned(),
        contract_version: oni_protocol::CONTRACT_VERSION,
        static_key: BASE64.encode(&key.static_key_spki),
        ephemeral_key: BASE64.encode(ephemeral_key.as_ref()),
        nonce: BASE64.encode(random_bytes::<NONCE_BYTES>()?),
    };
    let hello_signature = BASE64.encode(key.sign(&hello_transcript(&hello))?);
    let request = json!({
        "v": 2,
        "type": "request",
        "id": REQUEST_ID,
        "method": METHOD,
        "params": {
            "machineId": hello.machine_id,
            "peer": {"kind": "client", "contractVersion": hello.contract_version},
            "staticKey": hello.static_key,
            "ephemeralKey": hello.ephemeral_key,
            "nonce": hello.nonce,
            "signature": hello_signature,
        }
    });
    let mut line = request.to_string().into_bytes();
    line.push(b'\n');
    stream.write_all(&line).await?;
    stream.flush().await?;
    let (answer, carried) = read_line(stream).await?;
    let (accept, accept_signature) = match result_of(&answer)? {
        HandshakeResult::Refused { reason } => return Err(HandshakeError::Refused(reason.into())),
        HandshakeResult::Accepted {
            ephemeral_key,
            nonce,
            signature,
            static_key,
        } => (
            Accept {
                static_key: static_key.to_string(),
                ephemeral_key: ephemeral_key.to_string(),
                nonce: nonce.to_string(),
            },
            signature.to_string(),
        ),
    };
    verify_accept(pin, &hello, &accept, &accept_signature)?;
    let peer_ephemeral_key = decode_fixed(&accept.ephemeral_key, EPHEMERAL_KEY_BYTES)?;
    let keys = derive_initiator_keys(
        own,
        &peer_ephemeral_key,
        &session_transcript(&hello, &hello_signature, &accept, &accept_signature),
    )?;
    let seal = FrameSeal::new(&keys).map_err(|_| HandshakeError::HostSignature)?;
    Ok((
        seal,
        carried,
        Handshaken {
            contract_version: hello.contract_version,
            host_key: crate::config::encode_pin(&pin.0),
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello() -> Hello {
        Hello {
            machine_id: "m-1".to_owned(),
            contract_version: 6,
            static_key: "c3Bk".to_owned(),
            ephemeral_key: "ZXBo".to_owned(),
            nonce: "bm9uY2U=".to_owned(),
        }
    }

    #[test]
    fn the_hello_transcript_is_the_label_and_length_prefixed_fields() {
        let transcript = hello_transcript(&hello());
        let mut expected = b"oni-machine-handshake/6\nhello\n".to_vec();
        for value in ["m-1", "client", "6", "c3Bk", "ZXBo", "bm9uY2U="] {
            expected.extend_from_slice(&(value.len() as u32).to_be_bytes());
            expected.extend_from_slice(value.as_bytes());
        }
        assert_eq!(transcript, expected);
    }

    #[test]
    fn the_accept_and_session_transcripts_extend_the_hello_in_order() {
        let accept = Accept {
            static_key: "aG9zdA==".to_owned(),
            ephemeral_key: "aGVwaA==".to_owned(),
            nonce: "aG5vbmNl".to_owned(),
        };
        let transcript = accept_transcript(&hello(), &accept);
        let mut expected = b"oni-machine-handshake/6\naccept\n".to_vec();
        expected.extend_from_slice(&hello_transcript(&hello()));
        for value in ["aG9zdA==", "aGVwaA==", "aG5vbmNl"] {
            expected.extend_from_slice(&(value.len() as u32).to_be_bytes());
            expected.extend_from_slice(value.as_bytes());
        }
        assert_eq!(transcript, expected);
        let session = session_transcript(&hello(), "c2ln", &accept, "YXNpZw==");
        let mut expected = transcript;
        for value in ["c2ln", "YXNpZw=="] {
            expected.extend_from_slice(&(value.len() as u32).to_be_bytes());
            expected.extend_from_slice(value.as_bytes());
        }
        assert_eq!(session, expected);
    }

    #[test]
    fn a_pinned_host_key_is_the_only_one_an_acceptance_may_carry() {
        let certified = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()])
            .expect("host key");
        let pem = certified.cert.pem();
        let der = rustls_pemfile::certs(&mut Cursor::new(pem.as_bytes()))
            .next()
            .expect("certificate")
            .expect("DER");
        let (_, parsed) = x509_parser::parse_x509_certificate(der.as_ref()).expect("X.509");
        let spki = parsed.tbs_certificate.subject_pki.raw.to_vec();
        let pin = HostPin(Sha256::digest(&spki).into());
        let accept = Accept {
            static_key: BASE64.encode(&spki),
            ephemeral_key: BASE64.encode([7; 32]),
            nonce: BASE64.encode([9; 32]),
        };
        let signature = BASE64.encode([0; 64]);
        assert!(matches!(
            verify_accept(HostPin([0; 32]), &hello(), &accept, &signature),
            Err(HandshakeError::HostKey)
        ));
        assert!(matches!(
            verify_accept(pin, &hello(), &accept, &signature),
            Err(HandshakeError::HostSignature)
        ));
        assert!(matches!(
            verify_accept(pin, &hello(), &accept, "c2hvcnQ="),
            Err(HandshakeError::Malformed(_))
        ));
    }

    #[test]
    fn the_client_key_is_the_joined_certificate_and_its_pkcs8_key() {
        let certified = rcgen::generate_simple_self_signed(vec!["machine".to_owned()])
            .expect("client key");
        let key = ClientKey::from_pem(
            certified.cert.pem().as_bytes(),
            certified.signing_key.serialize_pem().as_bytes(),
        )
        .expect("client key pair");
        assert_eq!(key.fingerprint().len(), 64);
        let signature = key.sign(b"transcript").expect("signature");
        assert_eq!(signature.len(), SIGNATURE_BYTES);
        let (_, spki) = x509_parser::x509::SubjectPublicKeyInfo::from_der(&key.static_key_spki)
            .expect("SPKI");
        signature::UnparsedPublicKey::new(
            &signature::ECDSA_P256_SHA256_FIXED,
            spki.subject_public_key.data.as_ref(),
        )
        .verify(b"transcript", &signature)
        .expect("the signature verifies under the certificate's key");
        assert!(matches!(
            ClientKey::from_pem(b"not a certificate", b"not a key"),
            Err(HandshakeError::ClientKey)
        ));
    }

    #[test]
    fn refusals_keep_the_host_s_names() {
        assert_eq!(Refusal::NotAdmitted.as_str(), "not_admitted");
        assert_eq!(Refusal::Replay.as_str(), "replay");
        assert_eq!(Refusal::UnsupportedContract.as_str(), "unsupported_contract");
        assert_eq!(
            Refusal::from(HandshakeResultRefusedReason::Replay),
            Refusal::Replay
        );
    }
}
