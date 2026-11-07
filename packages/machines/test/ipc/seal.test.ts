import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { Machine } from "@oni/protocol";
import { IpcProtocolError } from "../../src/ipc/errors";
import { MAX_FRAME_BYTES } from "../../src/ipc/framing";
import { ephemeralKey, sharedSecret, signTranscript, staticKeyOf, verifyTranscript } from "../../src/ipc/keys";
import { deriveSealKeys, FrameSeal, SealedDecoder, type SealSchedule } from "../../src/ipc/seal";
import { NonceLedger } from "../../src/handshake";
import { connectIpcPlainWsClient, createIpcWsServer } from "./helpers/native";
import { daemonIdentity, hostIdentity, otherIdentity } from "./helpers/tls-fixtures";

function schedule(): { initiator: FrameSeal; responder: FrameSeal; keys: SealSchedule } {
  const a = ephemeralKey();
  const b = ephemeralKey();
  const keys: SealSchedule = {
    sharedSecret: sharedSecret(a, b.publicKey),
    salt: randomBytes(32),
    info: Machine.frameKeyLabel,
    initiatorAad: Machine.frameAadToHost,
    responderAad: Machine.frameAadToMachine,
  };
  expect(sharedSecret(b, a.publicKey).equals(keys.sharedSecret)).toBe(true);
  return { initiator: new FrameSeal(deriveSealKeys(keys, "initiator")), responder: new FrameSeal(deriveSealKeys(keys, "responder")), keys };
}

const frame = (text: string) => Buffer.from(`${text}\n`);

describe("frame sealing (#1832)", () => {
  test("the two roles derive mirror-image keys and open each other's frames in order", () => {
    const { initiator, responder, keys } = schedule();
    const mirror = deriveSealKeys(keys, "responder");
    const own = deriveSealKeys(keys, "initiator");
    expect(own.send.equals(mirror.receive)).toBe(true);
    expect(own.receive.equals(mirror.send)).toBe(true);
    expect(own.sendAad.toString()).toBe(Machine.frameAadToHost);
    expect(own.receiveAad.toString()).toBe(Machine.frameAadToMachine);
    const sealed = initiator.seal(frame('{"n":1}'));
    expect(sealed.at(-1)).toBe(0x0a);
    expect(Buffer.from(sealed).toString()).not.toContain('{"n":1}');
    const decoder = new SealedDecoder(responder);
    const line = Buffer.from(sealed).toString().slice(0, -1);
    expect(decoder.push(line.slice(0, 10))).toEqual([]);
    expect(decoder.push(`${line.slice(10)}\n\n`).map((bytes) => Buffer.from(bytes).toString())).toEqual(['{"n":1}\n']);
    expect(Buffer.from(responder.open(Buffer.from(initiator.seal(frame('{"n":2}'))).toString().trimEnd())).toString()).toBe('{"n":2}\n');
  });

  test("a frame is refused when it is not sealed bytes, out of order, tampered, or from the wrong direction", () => {
    const { initiator, responder } = schedule();
    expect(() => responder.open("not base64!")).toThrow(new IpcProtocolError({ message: "sealed frame is not the base64 of nonce, ciphertext and tag" }));
    expect(() => responder.open(Buffer.alloc(27).toString("base64"))).toThrow("sealed frame is not the base64 of nonce, ciphertext and tag");
    const first = Buffer.from(initiator.seal(frame("a"))).toString().trimEnd();
    const second = Buffer.from(initiator.seal(frame("b"))).toString().trimEnd();
    expect(() => responder.open(second)).toThrow("sealed frame counter is out of order");
    const highBits = Buffer.from(first, "base64");
    highBits[0] = 1;
    expect(() => responder.open(highBits.toString("base64"))).toThrow("sealed frame counter is out of order");
    const tampered = Buffer.from(first, "base64");
    tampered[12] = (tampered[12] as number) ^ 0xff;
    expect(() => responder.open(tampered.toString("base64"))).toThrow("sealed frame failed authentication");
    expect(Buffer.from(responder.open(first)).toString()).toBe("a\n");
    expect(() => responder.open(first)).toThrow("sealed frame counter is out of order");
    const fresh = schedule().responder;
    const mirrored = Buffer.from(fresh.seal(frame("c"))).toString().trimEnd();
    expect(() => fresh.open(mirrored)).toThrow("sealed frame failed authentication");
  });

  test("a sealed line longer than the largest admissible frame is refused before it is opened", () => {
    const { responder } = schedule();
    const decoder = new SealedDecoder(responder);
    const limit = Math.ceil((MAX_FRAME_BYTES + 28) / 3) * 4;
    expect(decoder.push("A".repeat(limit))).toEqual([]);
    expect(() => decoder.push("A")).toThrow(`sealed frame exceeds maximum size of ${MAX_FRAME_BYTES} bytes`);
    expect(decoder.push("")).toEqual([]);
  });

  test("the nonce ledger forgets its oldest entry past capacity", () => {
    const ledger = new NonceLedger(2);
    ledger.record("one");
    ledger.record("two");
    expect(ledger.has("one")).toBe(true);
    ledger.record("three");
    expect(ledger.has("one")).toBe(false);
    expect(ledger.has("two")).toBe(true);
    expect(ledger.has("three")).toBe(true);
  });
});

describe("handshake key primitives (#1832)", () => {
  test("static keys are P-256 SPKI, signatures are 64-byte p1363 over the transcript", () => {
    const spki = staticKeyOf(daemonIdentity.certificate);
    if (spki === undefined) throw new Error("daemon fixture is P-256");
    expect(Machine.fingerprintOf(spki)).toMatch(/^[0-9a-f]{64}$/);
    expect(staticKeyOf(otherIdentity.certificate)).toBeUndefined();
    const transcript = Buffer.from("transcript");
    const signature = signTranscript(daemonIdentity.privateKey, transcript);
    expect(signature).toHaveLength(64);
    expect(verifyTranscript(spki, transcript, signature)).toBe(true);
    expect(verifyTranscript(spki, Buffer.from("other transcript"), signature)).toBe(false);
    expect(verifyTranscript(spki, transcript, signature.subarray(1))).toBe(false);
    expect(verifyTranscript(Buffer.from("not an spki"), transcript, signature)).toBe(false);
    const ed25519 = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
    expect(verifyTranscript(ed25519, transcript, signature)).toBe(false);
    const hostKey = staticKeyOf(hostIdentity.certificate);
    if (hostKey === undefined) throw new Error("host fixture is P-256");
    expect(verifyTranscript(hostKey, transcript, signature)).toBe(false);
  });
});

describe("sealing a server connection (#1832)", () => {
  test("seal arms once per live connection and refuses unknown, sealed or closed ones", async () => {
    const { initiator, responder } = schedule();
    let connection: string | undefined;
    const server = await createIpcWsServer({ host: "127.0.0.1", port: 0 }, (method, _params, respond, _notify, connectionId) => {
      connection = connectionId;
      respond({ method });
      // As the host does after the acceptance: the reply is the last plaintext frame, sealing is armed right after it.
      if (method === "arm") {
        expect(server.native.seal(connectionId, responder)).toBe(true);
        expect(server.native.seal(connectionId, responder)).toBe(false);
      }
    });
    try {
      expect(server.native.seal("ws:999", responder)).toBe(false);
      const client = await connectIpcPlainWsClient({ host: "127.0.0.1", port: server.port });
      try {
        expect(server.peerFingerprintOf(connection ?? "")).toBeUndefined();
        expect(await client.call("arm")).toEqual({ method: "arm" });
        client.native.seal(initiator);
        expect(await client.call("sealed")).toEqual({ method: "sealed" });
        expect(server.peerFingerprintOf(connection ?? "")).toBeUndefined();
      } finally {
        await client.close();
      }
    } finally {
      await server.close();
    }
  });
});
