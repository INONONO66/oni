import { createHash, randomBytes } from "node:crypto";
import { Machine } from "@oni/protocol";
import { ephemeralKey, sharedSecret, signTranscript, staticKeyOf, verifyTranscript, type EphemeralKey } from "./ipc/keys";
import { deriveSealKeys, FrameSeal, type SealSchedule } from "./ipc/seal";
import type { IpcTlsIdentity } from "./ipc/tls";

/**
 * The host side of the signed handshake (#1832). The machine proves the key
 * its enrollment pinned, the host proves the key the machine pinned, both
 * inside the signed message rather than at TLS, and the accepted handshake
 * yields the `FrameSeal` under which every later frame of that connection
 * travels. `not_admitted` is one constant for an unknown machine, a key that
 * is not the enrolled one and a signature that does not verify, so the
 * refusal bytes never say which.
 */
export type HandshakeIdentity = {
  /** SubjectPublicKeyInfo DER of the P-256 key; its sha256 is the pin the machine holds. */
  readonly staticKey: Buffer;
  readonly privateKey: string;
};

export function handshakeIdentity(identity: IpcTlsIdentity): HandshakeIdentity | undefined {
  const staticKey = staticKeyOf(identity.certificate);
  return staticKey === undefined ? undefined : { staticKey, privateKey: identity.privateKey };
}

/** Accepted nonces in arrival order; the oldest leaves once `capacity` is exceeded. */
export class NonceLedger {
  private readonly accepted = new Set<string>();

  constructor(private readonly capacity: number) {}

  has(nonce: string): boolean {
    return this.accepted.has(nonce);
  }

  record(nonce: string): void {
    this.accepted.add(nonce);
    if (this.accepted.size <= this.capacity) return;
    const oldest = this.accepted.values().next().value;
    if (oldest !== undefined) this.accepted.delete(oldest);
  }
}

type AcceptFields = Omit<Machine.HandshakeAccepted, "status">;

/** The HKDF inputs of one session: both peers compute this from the same hello and acceptance. */
export function sealSchedule(own: EphemeralKey, peerEphemeralKey: string, hello: Machine.HandshakeHello, accept: AcceptFields): SealSchedule {
  return {
    sharedSecret: sharedSecret(own, Buffer.from(peerEphemeralKey, "base64")),
    salt: createHash("sha256").update(Machine.sessionTranscript(hello, accept)).digest(),
    info: Machine.frameKeyLabel,
    initiatorAad: Machine.frameAadToHost,
    responderAad: Machine.frameAadToMachine,
  };
}

type HandshakeRefused = Extract<Machine.HandshakeResult, { status: "refused" }>;

export type HandshakeOutcome =
  | {
    readonly status: "accepted";
    readonly result: Machine.HandshakeAccepted;
    readonly seal: FrameSeal;
    /** The fingerprint the machine proved, the one `machine.attach` is judged by. */
    readonly publicKey: Machine.KeyFingerprint;
  }
  | { readonly status: "refused"; readonly result: HandshakeRefused };

function refused(reason: HandshakeRefused["reason"]): HandshakeOutcome {
  return { status: "refused", result: { status: "refused", reason } };
}

export function respondHandshake(
  hello: Machine.HandshakeHello,
  identity: HandshakeIdentity,
  enrollment: Machine.Enrollment | undefined,
  nonces: NonceLedger,
): HandshakeOutcome {
  if (hello.peer.contractVersion < Machine.handshakeContractVersion) return refused("unsupported_contract");
  if (nonces.has(hello.nonce)) return refused("replay");
  const staticKey = Buffer.from(hello.staticKey, "base64");
  const publicKey = Machine.fingerprintOf(staticKey);
  const verified = verifyTranscript(staticKey, Machine.helloTranscript(hello), Buffer.from(hello.signature, "base64"));
  if (enrollment === undefined || enrollment.publicKey !== publicKey || !verified) return refused("not_admitted");
  const own = ephemeralKey();
  const accept = {
    staticKey: identity.staticKey.toString("base64"),
    ephemeralKey: own.publicKey.toString("base64"),
    nonce: randomBytes(32).toString("base64"),
  };
  const signature = signTranscript(identity.privateKey, Machine.acceptTranscript(hello, accept)).toString("base64");
  const schedule = sealSchedule(own, hello.ephemeralKey, hello, { ...accept, signature });
  nonces.record(hello.nonce);
  return {
    status: "accepted",
    result: { status: "accepted", ...accept, signature },
    seal: new FrameSeal(deriveSealKeys(schedule, "responder")),
    publicKey,
  };
}
