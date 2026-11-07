//! The host side of the signed handshake (#1832) for the fake hosts: reads
//! the client's `machine.handshake`, answers as `Answer` says, and on an
//! acceptance seals the carrier with the responder keys, exactly as the real
//! host does after writing its acceptance.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use oni_machine_client::transport::{
    handshake::{
        accept_transcript, decode_fixed, derive_frame_keys, hello_transcript, random_nonce,
        read_line, session_transcript, verify_with_spki, Accept, Ephemeral, Hello, SealKeys,
        StaticKey, EPHEMERAL_KEY_BYTES,
    },
    seal::{FrameSeal, Sealed},
};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};

/// How a fake host answers the hello.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    /// Signs the acceptance with the key its certificate names, as the real host does.
    Accept,
    /// Refuses with this reason, as the real host refuses an unenrolled key or a replay.
    Refuse(&'static str),
    /// Accepts under a key the client never pinned: an impostor behind a relay.
    ForeignKey,
    /// Accepts under the pinned key with a signature that does not verify.
    BadSignature,
    /// Hangs up on the hello.
    Close,
}

/// What the fake host read off the hello, after checking its signature under
/// the static key it names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Seen {
    pub hello: Hello,
    pub signature_verified: bool,
}

async fn write_line<S: AsyncWrite + Unpin>(stream: &mut S, frame: &Value) -> Option<()> {
    let mut line = frame.to_string().into_bytes();
    line.push(b'\n');
    stream.write_all(&line).await.ok()?;
    stream.flush().await.ok()
}

fn hello_of(request: &Value) -> Option<(Hello, String)> {
    let params = request.get("params")?;
    let text = |name: &str| params.get(name)?.as_str().map(str::to_owned);
    let hello = Hello {
        machine_id: text("machineId")?,
        contract_version: u32::try_from(params["peer"]["contractVersion"].as_u64()?).ok()?,
        static_key: text("staticKey")?,
        ephemeral_key: text("ephemeralKey")?,
        nonce: text("nonce")?,
    };
    Some((hello, text("signature")?))
}

/// Answers the hello on a freshly accepted carrier. `Some` carries the sealed
/// carrier the fake host serves frames over; `None` ends the connection, which
/// is what every refusal and every failure to parse the hello does.
pub async fn respond<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    certificate_pem: &str,
    private_key_pem: &str,
    answer: Answer,
    seen: &tokio::sync::watch::Sender<Option<Seen>>,
) -> Option<Sealed<S>> {
    let (line, carried) = read_line(&mut stream).await.ok()?;
    let request: Value = serde_json::from_slice(&line).ok()?;
    if request["method"] != "machine.handshake" {
        return None;
    }
    let (hello, hello_signature) = hello_of(&request)?;
    let signature_verified = BASE64
        .decode(&hello.static_key)
        .ok()
        .zip(BASE64.decode(&hello_signature).ok())
        .is_some_and(|(spki, signature)| {
            verify_with_spki(&spki, &hello_transcript(&hello), &signature).is_ok()
        });
    seen.send_replace(Some(Seen {
        hello: hello.clone(),
        signature_verified,
    }));
    let foreign;
    let key = match answer {
        Answer::Close => return None,
        Answer::Refuse(reason) => {
            write_line(
                &mut stream,
                &json!({"v": 2, "type": "response", "id": request["id"], "result": {"status": "refused", "reason": reason}}),
            )
            .await;
            return None;
        }
        Answer::ForeignKey => {
            foreign = super::fake_host::foreign_identity();
            StaticKey::from_pem(foreign.0.as_bytes(), foreign.1.as_bytes()).ok()?
        }
        Answer::Accept | Answer::BadSignature => {
            StaticKey::from_pem(certificate_pem.as_bytes(), private_key_pem.as_bytes()).ok()?
        }
    };
    let own = Ephemeral::generate().ok()?;
    let accept = Accept {
        static_key: BASE64.encode(key.spki()),
        ephemeral_key: BASE64.encode(&own.public),
        nonce: BASE64.encode(random_nonce().ok()?),
    };
    let mut signature = key.sign(&accept_transcript(&hello, &accept)).ok()?;
    if answer == Answer::BadSignature {
        signature[0] ^= 0x80;
    }
    let accept_signature = BASE64.encode(&signature);
    write_line(
        &mut stream,
        &json!({"v": 2, "type": "response", "id": request["id"], "result": {
            "status": "accepted",
            "staticKey": accept.static_key,
            "ephemeralKey": accept.ephemeral_key,
            "nonce": accept.nonce,
            "signature": accept_signature,
        }}),
    )
    .await?;
    let peer = decode_fixed(&hello.ephemeral_key, EPHEMERAL_KEY_BYTES).ok()?;
    let okm = derive_frame_keys(
        own,
        &peer,
        &session_transcript(&hello, &hello_signature, &accept, &accept_signature),
    )
    .ok()?;
    let seal = FrameSeal::new(&SealKeys::responder(&okm)).ok()?;
    Some(Sealed::new(stream, seal, carried))
}
