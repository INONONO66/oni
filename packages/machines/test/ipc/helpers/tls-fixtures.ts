import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import { certificateKeyFingerprint } from "../../../src";
import type { Machine } from "@oni/protocol";

function fixture(name: string): string {
  return fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}
function fingerprintOfPem(certPem: string): Machine.KeyFingerprint {
  return certificateKeyFingerprint(new X509Certificate(certPem).raw);
}

/** The committed TLS pin fixtures (#1270): host/daemon/wrong identities and their pins. */
export const hostIdentity = { certificate: fixture("host-cert.pem"), privateKey: fixture("host-key.pem") };
export const daemonIdentity = { certificate: fixture("daemon-cert.pem"), privateKey: fixture("daemon-key.pem") };
export const wrongIdentity = { certificate: fixture("wrong-cert.pem"), privateKey: fixture("wrong-key.pem") };
/** A leaf with its OWN key but SIGNED by host-key.pem: the chain validates against host-cert.pem, so only the pin can refuse it. */
export const hostIssuedIdentity = { certificate: fixture("host-issued-cert.pem"), privateKey: fixture("host-issued-key.pem") };
export const hostFingerprint = fingerprintOfPem(hostIdentity.certificate);
export const daemonFingerprint = fingerprintOfPem(daemonIdentity.certificate);
export const wrongFingerprint = fingerprintOfPem(wrongIdentity.certificate);
export const hostIssuedFingerprint = fingerprintOfPem(hostIssuedIdentity.certificate);
