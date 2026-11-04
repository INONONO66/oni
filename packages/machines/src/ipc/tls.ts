import { createHash, X509Certificate } from "node:crypto";
import { Machine } from "@oni/protocol";

/**
 * The PEM identity one peer presents during the mutual-TLS handshake (#1270).
 * Trust comes from the pinned key on the other side, never from a CA chain or
 * DNS identity, so the host's `certificate` may be a self-signed leaf or an
 * ACME-issued chain (leaf first, then its intermediates): either is served
 * as presented, and a renewal that keeps the key keeps every client's pin.
 */
export type IpcTlsIdentity = {
  readonly certificate: string;
  readonly privateKey: string;
};

function subjectPublicKeyInfo(certificateDer: Uint8Array): Buffer {
  return new X509Certificate(Buffer.from(certificateDer)).publicKey.export({ type: "spki", format: "der" });
}

/**
 * The pin the host holds for a client: the canonical `Machine.KeyFingerprint`
 * (sha256 hex) over the presented certificate's SubjectPublicKeyInfo DER,
 * the exact string an enrollment's `publicKey` carries.
 */
export function certificateKeyFingerprint(certificateDer: Uint8Array): Machine.KeyFingerprint {
  return Machine.fingerprintOf(subjectPublicKeyInfo(certificateDer));
}

/**
 * The pin a client holds for the host: the base64 sha256 over the presented
 * certificate's SubjectPublicKeyInfo DER. It names the key, never the
 * certificate, so a certificate reissued for the same key (an ACME renewal)
 * carries the same pin and a different key never does.
 */
export function hostPinOf(certificateDer: Uint8Array): string {
  return createHash("sha256").update(subjectPublicKeyInfo(certificateDer)).digest("base64");
}
