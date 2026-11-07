import { createHash, randomBytes } from "node:crypto";
import { Machine } from "@oni/protocol";
import type { IpcClient as NativeClient, IpcTlsIdentity } from "../../../src";
import { sealSchedule } from "../../../src/handshake";
import { ephemeralKey, signTranscript, staticKeyOf, verifyTranscript, type EphemeralKey } from "../../../src/ipc/keys";
import { deriveSealKeys, FrameSeal } from "../../../src/ipc/seal";

/**
 * The machine side of the signed handshake (#1832), as the Rust client runs
 * it: build and sign the hello, judge the acceptance against the host pin
 * and the accept transcript, derive the initiator seal.
 */
export type HandshakePeer = {
  readonly machineId: string;
  readonly identity: IpcTlsIdentity;
  readonly hostPin: string;
  readonly contractVersion?: number;
  readonly nonce?: string;
};

export type Hello = {
  readonly hello: Machine.HandshakeHello;
  readonly ephemeral: EphemeralKey;
};

export function helloFor(peer: HandshakePeer): Hello {
  const staticKey = staticKeyOf(peer.identity.certificate);
  if (staticKey === undefined) throw new Error("the test identity is not a P-256 key");
  const ephemeral = ephemeralKey();
  const unsigned = {
    machineId: peer.machineId,
    peer: { kind: "client", contractVersion: peer.contractVersion ?? Machine.contractVersion },
    staticKey: staticKey.toString("base64"),
    ephemeralKey: ephemeral.publicKey.toString("base64"),
    nonce: peer.nonce ?? randomBytes(32).toString("base64"),
  } as const;
  const signature = signTranscript(peer.identity.privateKey, Machine.helloTranscript(unsigned)).toString("base64");
  return { hello: { ...unsigned, signature }, ephemeral };
}

export function acceptedSeal(sent: Hello, accepted: Machine.HandshakeAccepted, hostPin: string): FrameSeal {
  const staticKey = Buffer.from(accepted.staticKey, "base64");
  const pin = createHash("sha256").update(staticKey).digest("base64");
  if (pin !== hostPin) throw new Error(`host key mismatch inside the handshake: expected ${hostPin}, presented ${pin}`);
  if (!verifyTranscript(staticKey, Machine.acceptTranscript(sent.hello, accepted), Buffer.from(accepted.signature, "base64"))) {
    throw new Error("the host's handshake signature does not verify");
  }
  return new FrameSeal(deriveSealKeys(sealSchedule(sent.ephemeral, accepted.ephemeralKey, sent.hello, accepted), "initiator"));
}

type HandshakeClient = {
  readonly native: Pick<NativeClient, "seal">;
  call(method: string, params?: Machine.HandshakeHello): Promise<unknown>;
};

/** Runs the handshake on a connected client and, once accepted, seals its frames. */
export async function handshakeAs(client: HandshakeClient, peer: HandshakePeer, sent: Hello = helloFor(peer)): Promise<Machine.HandshakeResult> {
  const result = Machine.HandshakeResult.parse(await client.call(Machine.WireMethod.Handshake, sent.hello));
  if (result.status === "accepted") client.native.seal(acceptedSeal(sent, result, peer.hostPin));
  return result;
}
