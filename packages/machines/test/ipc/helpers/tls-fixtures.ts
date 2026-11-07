import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import type tls from "node:tls";
import { certificateKeyFingerprint, hostPinOf, type IpcTlsIdentity } from "../../../src";
import type { Machine } from "@oni/protocol";

function fixture(name: string): string {
  return fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}
function fingerprintOfPem(certPem: string): Machine.KeyFingerprint {
  return certificateKeyFingerprint(new X509Certificate(certPem).raw);
}
function hostPinOfPem(certPem: string): string {
  return hostPinOf(new X509Certificate(certPem).raw);
}

/** The committed TLS pin fixtures (#1270): host/daemon/wrong identities and their pins. */
export const hostIdentity = { certificate: fixture("host-cert.pem"), privateKey: fixture("host-key.pem") };
/** host-key.pem reissued self-signed: the certificate changed, the key and so the pin did not. */
export const hostRenewedIdentity = { certificate: fixture("host-renewed-cert.pem"), privateKey: hostIdentity.privateKey };
/** An ACME-style chain for host-key.pem: a leaf signed by a test issuer, the issuer appended. */
export const hostChainIdentity = { certificate: fixture("host-chain.pem"), privateKey: hostIdentity.privateKey };
export const daemonIdentity = { certificate: fixture("daemon-cert.pem"), privateKey: fixture("daemon-key.pem") };
export const wrongIdentity = { certificate: fixture("wrong-cert.pem"), privateKey: fixture("wrong-key.pem") };
/** A leaf with its OWN key but SIGNED by host-key.pem: a familiar issuer, a different key, so only the pin refuses it. */
export const hostIssuedIdentity = { certificate: fixture("host-issued-cert.pem"), privateKey: fixture("host-issued-key.pem") };
/** An Ed25519 identity (#1832): not a P-256 key, so it can neither sign nor be verified in the machine handshake. */
export const otherIdentity = { certificate: fixture("other-cert.pem"), privateKey: fixture("other-key.pem") };
/** The pin every client holds for the host: base64 SPKI sha256 of host-key.pem's public key. */
export const hostPin = hostPinOfPem(hostIdentity.certificate);
export const wrongPin = hostPinOfPem(wrongIdentity.certificate);
export const hostIssuedPin = hostPinOfPem(hostIssuedIdentity.certificate);
export const daemonFingerprint = fingerprintOfPem(daemonIdentity.certificate);
export const wrongFingerprint = fingerprintOfPem(wrongIdentity.certificate);

/**
 * The one place test code opens TLS without CA validation: a raw probe that
 * judges the peer by its pin, or deliberately not at all, to observe exactly
 * what the host presents or how it refuses.
 */
export function unverifiedTlsOptions(identity?: IpcTlsIdentity): tls.ConnectionOptions & tls.TlsOptions {
  return {
    ...(identity === undefined ? {} : { cert: identity.certificate, key: identity.privateKey }),
    rejectUnauthorized: false,
  };
}
