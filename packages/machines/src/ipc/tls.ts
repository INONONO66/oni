import { X509Certificate } from "node:crypto";
import { Machine } from "@oni/protocol";

/**
 * The PEM identity one peer presents during the mutual-TLS handshake (#1270).
 * Self-signed is the norm: trust comes from the pinned key fingerprint on the
 * other side, never from a CA chain or DNS identity.
 */
export type IpcTlsIdentity = {
  readonly certificate: string;
  readonly privateKey: string;
};

/**
 * The ONE pin form of a presented certificate: the canonical
 * `Machine.KeyFingerprint` (sha256 hex) over its SubjectPublicKeyInfo DER.
 * Both transport ends and the enrollment record compare this exact string.
 */
export function certificateKeyFingerprint(certificateDer: Uint8Array): Machine.KeyFingerprint {
  const certificate = new X509Certificate(Buffer.from(certificateDer));
  return Machine.fingerprintOf(certificate.publicKey.export({ type: "spki", format: "der" }));
}
