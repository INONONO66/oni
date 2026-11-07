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
use oni_protocol::{handshake_result::HandshakeResultRefusedReason, HandshakeResult};
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
pub const NONCE_BYTES: usize = 32;
pub const EPHEMERAL_KEY_BYTES: usize = 32;
pub const SIGNATURE_BYTES: usize = 64;
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
    #[error("the certificate carries no P-256 key the handshake can sign with")]
    StaticKey,
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
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Handshaken {
    pub contract_version: u32,
    /// The pinned host key the acceptance was signed with, as `join` encodes pins.
    pub host_key: String,
}

/// A static P-256 identity: the SPKI a certificate names and the PKCS#8 key
/// that signs for it. The client's is the enrollment pair `join` generated.
pub struct StaticKey {
    spki: Vec<u8>,
    key_pair: signature::EcdsaKeyPair,
}

impl StaticKey {
    pub fn from_pem(
        certificate_pem: &[u8],
        private_key_pem: &[u8],
    ) -> Result<Self, HandshakeError> {
        let certificate = rustls_pemfile::certs(&mut Cursor::new(certificate_pem))
            .next()
            .ok_or(HandshakeError::StaticKey)?
            .map_err(|_| HandshakeError::StaticKey)?;
        let (_, parsed) = x509_parser::parse_x509_certificate(certificate.as_ref())
            .map_err(|_| HandshakeError::StaticKey)?;
        let spki = parsed.tbs_certificate.subject_pki.raw.to_vec();
        let private_key = rustls_pemfile::private_key(&mut Cursor::new(private_key_pem))
            .map_err(|_| HandshakeError::StaticKey)?
            .ok_or(HandshakeError::StaticKey)?;
        let PrivateKeyDer::Pkcs8(pkcs8) = private_key else {
            return Err(HandshakeError::StaticKey);
        };
        let key_pair = signature::EcdsaKeyPair::from_pkcs8(
            &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            pkcs8.secret_pkcs8_der(),
            &SystemRandom::new(),
        )
        .map_err(|_| HandshakeError::StaticKey)?;
        Ok(Self { spki, key_pair })
    }

    pub fn spki(&self) -> &[u8] {
        &self.spki
    }

    /// The sha256 hex fingerprint of the SPKI, the identity the host enrolls.
    pub fn fingerprint(&self) -> String {
        hex::encode(Sha256::digest(&self.spki))
    }

    pub fn sign(&self, transcript: &[u8]) -> Result<Vec<u8>, HandshakeError> {
        self.key_pair
            .sign(&SystemRandom::new(), transcript)
            .map(|signature| signature.as_ref().to_vec())
            .map_err(|_| HandshakeError::Random)
    }
}

/// Verifies a p1363 P-256/SHA-256 signature under the key an SPKI names.
pub fn verify_with_spki(
    spki: &[u8],
    message: &[u8],
    signature: &[u8],
) -> Result<(), HandshakeError> {
    let (_, parsed) = <x509_parser::x509::SubjectPublicKeyInfo as x509_parser::prelude::FromDer<
        x509_parser::error::X509Error,
    >>::from_der(spki)
    .map_err(|_| HandshakeError::HostSignature)?;
    signature::UnparsedPublicKey::new(
        &signature::ECDSA_P256_SHA256_FIXED,
        parsed.subject_public_key.data.as_ref(),
    )
    .verify(message, signature)
    .map_err(|_| HandshakeError::HostSignature)
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

pub struct Ephemeral {
    private: agreement::EphemeralPrivateKey,
    pub public: Vec<u8>,
}

impl Ephemeral {
    pub fn generate() -> Result<Self, HandshakeError> {
        let private =
            agreement::EphemeralPrivateKey::generate(&agreement::X25519, &SystemRandom::new())
                .map_err(|_| HandshakeError::Random)?;
        let public = private
            .compute_public_key()
            .map_err(|_| HandshakeError::Random)?
            .as_ref()
            .to_vec();
        Ok(Self { private, public })
    }
}

/// The 64 bytes of HKDF output both peers derive: `salt = sha256(session
/// transcript)`, `ikm = X25519(own, peer)`, `info = FRAME_KEY_LABEL`. The
/// initiator sends under the first half and receives under the second.
pub fn derive_frame_keys(
    own: Ephemeral,
    peer_ephemeral_key: &[u8],
    session_transcript: &[u8],
) -> Result<[u8; KEY_BYTES * 2], HandshakeError> {
    struct Length;
    impl hkdf::KeyType for Length {
        fn len(&self) -> usize {
            KEY_BYTES * 2
        }
    }
    let peer = agreement::UnparsedPublicKey::new(&agreement::X25519, peer_ephemeral_key);
    let salt = Sha256::digest(session_transcript);
    agreement::agree_ephemeral(own.private, &peer, |shared| {
        let mut okm = [0; KEY_BYTES * 2];
        hkdf::Salt::new(hkdf::HKDF_SHA256, &salt)
            .extract(shared)
            .expand(&[FRAME_KEY_LABEL.as_bytes()], Length)
            .and_then(|output| output.fill(&mut okm))
            .map(|()| okm)
    })
    .map_err(|_| HandshakeError::HostSignature)?
    .map_err(|_| HandshakeError::HostSignature)
}

fn halves(okm: &[u8; KEY_BYTES * 2]) -> ([u8; KEY_BYTES], [u8; KEY_BYTES]) {
    let mut first = [0; KEY_BYTES];
    let mut second = [0; KEY_BYTES];
    first.copy_from_slice(&okm[..KEY_BYTES]);
    second.copy_from_slice(&okm[KEY_BYTES..]);
    (first, second)
}

impl SealKeys {
    pub fn initiator(okm: &[u8; KEY_BYTES * 2]) -> Self {
        let (send, receive) = halves(okm);
        Self {
            send,
            receive,
            send_aad: AAD_TO_HOST,
            receive_aad: AAD_TO_MACHINE,
        }
    }

    pub fn responder(okm: &[u8; KEY_BYTES * 2]) -> Self {
        let (receive, send) = halves(okm);
        Self {
            send,
            receive,
            send_aad: AAD_TO_MACHINE,
            receive_aad: AAD_TO_HOST,
        }
    }
}

pub fn decode_fixed(value: &str, length: usize) -> Result<Vec<u8>, HandshakeError> {
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
    verify_with_spki(&static_key, &accept_transcript(hello, accept), &signature)
}

pub fn random_nonce() -> Result<[u8; NONCE_BYTES], HandshakeError> {
    let mut bytes = [0; NONCE_BYTES];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| HandshakeError::Random)?;
    Ok(bytes)
}

/// Reads one line from the carrier; whatever follows it stays `carried`.
pub async fn read_line<S: AsyncRead + Unpin>(
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

pub fn hello_request(hello: &Hello, signature: &str) -> Value {
    json!({
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
            "signature": signature,
        }
    })
}

/// Runs the handshake on a freshly connected carrier and returns the seal of
/// the session with the bytes the host sent past its acceptance.
pub async fn initiate<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    machine_id: &str,
    key: &StaticKey,
    pin: HostPin,
) -> Result<(FrameSeal, Vec<u8>, Handshaken), HandshakeError> {
    let own = Ephemeral::generate()?;
    let hello = Hello {
        machine_id: machine_id.to_owned(),
        contract_version: oni_protocol::CONTRACT_VERSION,
        static_key: BASE64.encode(key.spki()),
        ephemeral_key: BASE64.encode(&own.public),
        nonce: BASE64.encode(random_nonce()?),
    };
    let hello_signature = BASE64.encode(key.sign(&hello_transcript(&hello))?);
    let mut line = hello_request(&hello, &hello_signature)
        .to_string()
        .into_bytes();
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
    let okm = derive_frame_keys(
        own,
        &peer_ephemeral_key,
        &session_transcript(&hello, &hello_signature, &accept, &accept_signature),
    )?;
    let seal = FrameSeal::new(&SealKeys::initiator(&okm)).map_err(|_| HandshakeError::Random)?;
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

    fn with_fields(mut transcript: Vec<u8>, values: &[&str]) -> Vec<u8> {
        for value in values {
            transcript.extend_from_slice(&(value.len() as u32).to_be_bytes());
            transcript.extend_from_slice(value.as_bytes());
        }
        transcript
    }

    #[test]
    fn the_hello_transcript_is_the_label_and_length_prefixed_fields() {
        assert_eq!(
            hello_transcript(&hello()),
            with_fields(
                b"oni-machine-handshake/6\nhello\n".to_vec(),
                &["m-1", "client", "6", "c3Bk", "ZXBo", "bm9uY2U="]
            )
        );
    }

    #[test]
    fn the_accept_and_session_transcripts_extend_the_hello_in_order() {
        let accept = Accept {
            static_key: "aG9zdA==".to_owned(),
            ephemeral_key: "aGVwaA==".to_owned(),
            nonce: "aG5vbmNl".to_owned(),
        };
        let mut expected = b"oni-machine-handshake/6\naccept\n".to_vec();
        expected.extend_from_slice(&hello_transcript(&hello()));
        let expected = with_fields(expected, &["aG9zdA==", "aGVwaA==", "aG5vbmNl"]);
        assert_eq!(accept_transcript(&hello(), &accept), expected);
        assert_eq!(
            session_transcript(&hello(), "c2ln", &accept, "YXNpZw=="),
            with_fields(expected, &["c2ln", "YXNpZw=="])
        );
    }

    #[test]
    fn both_roles_derive_mirror_keys_from_one_agreement() {
        let client = Ephemeral::generate().expect("client ephemeral");
        let host = Ephemeral::generate().expect("host ephemeral");
        let client_public = client.public.clone();
        let host_public = host.public.clone();
        let client_okm = derive_frame_keys(client, &host_public, b"transcript").expect("okm");
        let host_okm = derive_frame_keys(host, &client_public, b"transcript").expect("okm");
        assert_eq!(client_okm, host_okm);
        let initiator = SealKeys::initiator(&client_okm);
        let responder = SealKeys::responder(&host_okm);
        assert_eq!(initiator.send, responder.receive);
        assert_eq!(initiator.receive, responder.send);
        assert_ne!(initiator.send, initiator.receive);
        assert_eq!(initiator.send_aad, b"c2h");
        assert_eq!(responder.send_aad, b"h2c");
        let other = Ephemeral::generate().expect("other ephemeral");
        let other_okm = derive_frame_keys(other, &host_public, b"transcript").expect("okm");
        assert_ne!(other_okm, client_okm);
    }

    fn generated() -> (StaticKey, [u8; 32]) {
        let certified =
            rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).expect("test key");
        let key = StaticKey::from_pem(
            certified.cert.pem().as_bytes(),
            certified.signing_key.serialize_pem().as_bytes(),
        )
        .expect("static key");
        let pin = Sha256::digest(key.spki()).into();
        (key, pin)
    }

    #[test]
    fn a_pinned_host_key_is_the_only_one_an_acceptance_may_carry() {
        let (host, pin) = generated();
        let accept = Accept {
            static_key: BASE64.encode(host.spki()),
            ephemeral_key: BASE64.encode([7; 32]),
            nonce: BASE64.encode([9; 32]),
        };
        let signed = BASE64.encode(
            host.sign(&accept_transcript(&hello(), &accept))
                .expect("signature"),
        );
        verify_accept(HostPin(pin), &hello(), &accept, &signed).expect("the pinned key verifies");
        assert!(matches!(
            verify_accept(HostPin([0; 32]), &hello(), &accept, &signed),
            Err(HandshakeError::HostKey)
        ));
        let forged = BASE64.encode([0; 64]);
        assert!(matches!(
            verify_accept(HostPin(pin), &hello(), &accept, &forged),
            Err(HandshakeError::HostSignature)
        ));
        assert!(matches!(
            verify_accept(HostPin(pin), &hello(), &accept, "c2hvcnQ="),
            Err(HandshakeError::Malformed(_))
        ));
        let mut other = hello();
        other.nonce = BASE64.encode([1; 32]);
        assert!(matches!(
            verify_accept(HostPin(pin), &other, &accept, &signed),
            Err(HandshakeError::HostSignature)
        ));
    }

    #[test]
    fn the_static_key_is_the_certificate_and_its_pkcs8_key() {
        let (key, _) = generated();
        assert_eq!(key.fingerprint().len(), 64);
        let signature = key.sign(b"transcript").expect("signature");
        assert_eq!(signature.len(), SIGNATURE_BYTES);
        verify_with_spki(key.spki(), b"transcript", &signature)
            .expect("the signature verifies under the certificate's key");
        assert!(matches!(
            verify_with_spki(key.spki(), b"other", &signature),
            Err(HandshakeError::HostSignature)
        ));
        assert!(matches!(
            StaticKey::from_pem(b"not a certificate", b"not a key"),
            Err(HandshakeError::StaticKey)
        ));
    }

    #[test]
    fn refusals_keep_the_host_s_names() {
        assert_eq!(Refusal::NotAdmitted.as_str(), "not_admitted");
        assert_eq!(Refusal::Replay.as_str(), "replay");
        assert_eq!(
            Refusal::UnsupportedContract.as_str(),
            "unsupported_contract"
        );
        assert_eq!(
            Refusal::from(HandshakeResultRefusedReason::Replay),
            Refusal::Replay
        );
    }

    #[tokio::test]
    async fn read_line_keeps_what_follows_the_first_newline() {
        let mut stream = Cursor::new(b"first\nsecond\nthird".to_vec());
        let (line, carried) = read_line(&mut stream).await.expect("line");
        assert_eq!(line, b"first");
        assert_eq!(carried, b"second\nthird");
        let mut empty = Cursor::new(b"no newline".to_vec());
        assert!(matches!(
            read_line(&mut empty).await,
            Err(HandshakeError::Closed)
        ));
    }
}
