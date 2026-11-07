import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, sign, verify, X509Certificate, type KeyObject } from "node:crypto";

/**
 * The asymmetric primitives of the signed handshake (#1832), fixed so the
 * Rust peer verifies and produces the same bytes: static identities are the
 * EC P-256 keys the TLS doors already present, transcript signatures are
 * ECDSA over sha256 in the fixed 64-byte `r || s` form, ephemerals are raw
 * 32-byte X25519 public keys.
 */
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
export const EPHEMERAL_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;
const STATIC_CURVE = "prime256v1";

export type EphemeralKey = {
  readonly publicKey: Buffer;
  readonly privateKey: KeyObject;
};

export function ephemeralKey(): EphemeralKey {
  const pair = generateKeyPairSync("x25519");
  const spki = pair.publicKey.export({ type: "spki", format: "der" });
  return { publicKey: Buffer.from(spki.subarray(spki.length - EPHEMERAL_KEY_BYTES)), privateKey: pair.privateKey };
}

export function sharedSecret(own: EphemeralKey, peerPublicKey: Uint8Array): Buffer {
  const peer = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, peerPublicKey]), format: "der", type: "spki" });
  return diffieHellman({ privateKey: own.privateKey, publicKey: peer });
}

function isStaticKey(key: KeyObject): boolean {
  return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === STATIC_CURVE;
}

/** The SPKI DER of a PEM certificate's key, or undefined when that key cannot sign the handshake. */
export function staticKeyOf(certificatePem: string): Buffer | undefined {
  const key = new X509Certificate(certificatePem).publicKey;
  return isStaticKey(key) ? key.export({ type: "spki", format: "der" }) : undefined;
}

export function signTranscript(privateKeyPem: string, transcript: Uint8Array): Buffer {
  return sign("sha256", transcript, { key: createPrivateKey(privateKeyPem), dsaEncoding: "ieee-p1363" });
}

export function verifyTranscript(staticKeySpki: Uint8Array, transcript: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== SIGNATURE_BYTES) return false;
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(staticKeySpki), format: "der", type: "spki" });
  } catch {
    return false;
  }
  if (!isStaticKey(key)) return false;
  return verify("sha256", transcript, { key, dsaEncoding: "ieee-p1363" }, signature);
}
