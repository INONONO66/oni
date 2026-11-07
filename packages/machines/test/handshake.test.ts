import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Machine } from "@oni/protocol";
import { sealSchedule } from "../src/handshake";
import { deriveSealKeys, FrameSeal } from "../src/ipc/seal";
import { eventCollector } from "./helpers/events";
import { createMachineHost } from "./helpers/native";
import { socketPath } from "./helpers/socket-path";
import { acceptedSeal, handshakeAs, helloFor, type HandshakePeer, type Hello } from "./ipc/helpers/handshake";
import { connectIpcClient, connectIpcPlainWsClient, connectIpcTcpClient, sequentialIds } from "./ipc/helpers/native";
import { daemonFingerprint, daemonIdentity, hostIdentity, hostPin, otherIdentity, wrongIdentity } from "./ipc/helpers/tls-fixtures";
import type { WireTap } from "./ipc/helpers/ws-client";

const silent = { publish: () => undefined };
const loopback = "127.0.0.1";

function enrollment(machineId: string, publicKey: Machine.KeyFingerprint): Machine.Enrollment {
  return { machineId, name: machineId, allowedCapabilities: ["fs.read"], allowedExports: ["docs"], publicKey, enrolledAt: 1 };
}

function offer(machineId: string, root: string): Machine.Offer {
  return {
    machineId,
    daemonVersion: "test",
    platform: "darwin-arm64",
    offeredCapabilities: ["fs.read"],
    exports: [{ name: "docs", path: root }],
    offeredAt: 2,
    peer: { kind: "client", contractVersion: Machine.contractVersion },
  };
}

/** A host whose only door is the TEST-ONLY plaintext `ws://` listener: no TLS, no pin, nothing but the handshake admits. */
async function plaintextHost(enrollments: (id: string) => Machine.Enrollment | undefined, events = eventCollector()) {
  const host = await createMachineHost({
    listen: { ws: { host: loopback, port: 0, plaintext: true } },
    tls: hostIdentity,
    enrollment: enrollments,
    events: events.sink,
    now: () => 3,
  });
  return { host, events, ws: { host: loopback, port: host.endpoints.ws?.port ?? 0 } };
}

function recorder() {
  const sent: Buffer[] = [];
  const received: Buffer[] = [];
  const tap: WireTap = (direction, bytes) => { (direction === "sent" ? sent : received).push(bytes); };
  return { sent, received, tap };
}

const pinned: HandshakePeer = { machineId: "pinned", identity: daemonIdentity, hostPin };

describe("signed machine handshake over a plaintext carrier (#1832)", () => {
  test("with no TLS pin, an unenrolled key is refused by the handshake alone and can attach nothing", async () => {
    const { host, ws } = await plaintextHost(() => undefined);
    try {
      expect(ws.port).toBeGreaterThan(0);
      const stranger = await connectIpcPlainWsClient(ws);
      try {
        expect(await handshakeAs(stranger, { machineId: "ghost", identity: daemonIdentity, hostPin })).toEqual({ status: "refused", reason: "not_admitted" });
        await expect(stranger.call(Machine.WireMethod.Attach, offer("ghost", "/tmp"))).rejects.toMatchObject({
          _tag: "IpcRemoteError", code: 1000, message: "IPC error 1000: machine.attach requires a completed machine.handshake on this connection",
        });
        expect(host.list()).toEqual([]);
      } finally {
        await stranger.close();
      }
    } finally {
      await host.close();
    }
  });

  test("a replayed hello is refused `replay` on a new connection and `invalid_method` on the sealed one", async () => {
    const { host, ws } = await plaintextHost((id) => (id === "pinned" ? enrollment("pinned", daemonFingerprint) : undefined));
    try {
      const sent = helloFor(pinned);
      const first = await connectIpcPlainWsClient(ws);
      const second = await connectIpcPlainWsClient(ws);
      try {
        expect(await handshakeAs(first, pinned, sent)).toMatchObject({ status: "accepted" });
        expect(await handshakeAs(second, pinned, sent)).toEqual({ status: "refused", reason: "replay" });
        await expect(first.call(Machine.WireMethod.Handshake, sent.hello)).rejects.toMatchObject({
          _tag: "IpcRemoteError", code: 1000, message: "IPC error 1000: machine.handshake already completed on this connection",
        });
        expect(await handshakeAs(second, pinned)).toMatchObject({ status: "accepted" });
      } finally {
        await second.close();
        await first.close();
      }
    } finally {
      await host.close();
    }
  });

  test("the unenrolled, key-mismatch and bad-signature refusals are byte-identical on the wire", async () => {
    const enrolled = enrollment("pinned", daemonFingerprint);
    const { host, ws } = await plaintextHost((id) => (id === "pinned" ? enrolled : undefined));
    try {
      const forged = helloFor(pinned);
      const signature = Buffer.from(forged.hello.signature, "base64");
      signature[7] = (signature[7] as number) ^ 0x01;
      const probes: ReadonlyArray<{ readonly peer: HandshakePeer; readonly hello?: Hello }> = [
        { peer: { machineId: "ghost", identity: daemonIdentity, hostPin } },
        { peer: { machineId: "pinned", identity: wrongIdentity, hostPin } },
        { peer: pinned, hello: { ...forged, hello: { ...forged.hello, signature: signature.toString("base64") } } },
      ];
      const replies: Buffer[] = [];
      for (const probe of probes) {
        const wire = recorder();
        const client = await connectIpcPlainWsClient(ws, { idSource: sequentialIds("probe") }, wire.tap);
        try {
          expect(await handshakeAs(client, probe.peer, probe.hello)).toEqual({ status: "refused", reason: "not_admitted" });
        } finally {
          await client.close();
        }
        expect(wire.received).toHaveLength(1);
        replies.push(wire.received[0] as Buffer);
      }
      expect(replies[0]?.toString()).toContain('"not_admitted"');
      expect(replies[1]?.equals(replies[0] as Buffer)).toBe(true);
      expect(replies[2]?.equals(replies[0] as Buffer)).toBe(true);
      expect(host.list()).toEqual([]);
    } finally {
      await host.close();
    }
  });

  test("an enrolled key attaches over plaintext ws:// and every frame after the acceptance is ciphertext", async () => {
    const root = mkdtempSync(join(tmpdir(), "om-sealed-"));
    writeFileSync(join(root, "note"), "sealed-note");
    const { host, ws } = await plaintextHost((id) => (id === "pinned" ? enrollment("pinned", daemonFingerprint) : undefined));
    const wire = recorder();
    try {
      const client = await connectIpcPlainWsClient(ws, { onRequest: (method, params, respond) => {
        expect(method).toBe(Machine.WireMethod.FsOp);
        expect(Machine.FsRequest.parse(params).op).toBe("read");
        respond({ status: "completed", value: { op: "read", data: Buffer.from("sealed-note").toString("base64"), bytesRead: 11, size: 11, truncated: false } });
      } }, wire.tap);
      try {
        expect(await handshakeAs(client, pinned)).toMatchObject({ status: "accepted" });
        expect(await client.call(Machine.WireMethod.Attach, offer("pinned", root))).toMatchObject({ status: "attached" });
        expect(host.list().map((machine) => machine.machineId)).toEqual(["pinned"]);
        const read = await host.get("pinned").fs.read(join(root, "note"));
        expect(Buffer.from(read.data).toString()).toBe("sealed-note");
      } finally {
        await client.close();
      }
      // The hello and the acceptance are the only plaintext frames either way.
      expect(wire.sent[0]?.toString()).toContain(`"${Machine.WireMethod.Handshake}"`);
      expect(wire.received[0]?.toString()).toContain('"accepted"');
      const sealedLine = /^[A-Za-z0-9+/]+={0,2}\n$/;
      const later = { sent: wire.sent.slice(1), received: wire.received.slice(1) };
      expect(later.sent.length).toBeGreaterThanOrEqual(2);
      expect(later.received.length).toBeGreaterThanOrEqual(2);
      for (const frame of [...later.sent, ...later.received]) expect(frame.toString()).toMatch(sealedLine);
      const plaintext = [`"${Machine.WireMethod.Attach}"`, '"attached"', `"${Machine.WireMethod.FsOp}"`, '"read"', Buffer.from("sealed-note").toString("base64"), "pinned", "machineId"];
      for (const frame of [...later.sent, ...later.received]) for (const marker of plaintext) expect(frame.toString()).not.toContain(marker);
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a frame sealed under the wrong key ends the connection and detaches the machine", async () => {
    const { host, events, ws } = await plaintextHost((id) => (id === "pinned" ? enrollment("pinned", daemonFingerprint) : undefined));
    try {
      let dropped: () => void = () => undefined;
      const disconnected = new Promise<void>((resolve) => { dropped = resolve; });
      const client = await connectIpcPlainWsClient(ws, { onDisconnect: () => dropped() });
      try {
        const sent = helloFor(pinned);
        const accepted = Machine.HandshakeResult.parse(await client.call(Machine.WireMethod.Handshake, sent.hello));
        if (accepted.status !== "accepted") throw new Error(`expected acceptance, got ${accepted.reason}`);
        client.native.seal(acceptedSeal(sent, accepted, hostPin));
        expect(await client.call(Machine.WireMethod.Attach, offer("pinned", "/tmp"))).toMatchObject({ status: "attached" });
        // The responder's keys are the mirror image: sealing with them is a frame the host cannot authenticate.
        client.native.seal(new FrameSeal(deriveSealKeys(sealSchedule(sent.ephemeral, accepted.ephemeralKey, sent.hello, accepted), "responder")));
        const detached = events.next(Machine.Events.Detached.name);
        await expect(client.call(Machine.WireMethod.Attach, offer("pinned", "/tmp"))).rejects.toMatchObject({ _tag: "IpcConnectionError" });
        await disconnected;
        expect(await detached).toMatchObject({ payload: { machineId: "pinned", reason: "connection_closed" } });
        expect(host.list()).toEqual([]);
      } finally {
        await client.close();
      }
    } finally {
      await host.close();
    }
  });

  test("a hello below the contract is refused `unsupported_contract`, as is the old peer's bare attach", async () => {
    const { host, ws } = await plaintextHost((id) => (id === "pinned" ? enrollment("pinned", daemonFingerprint) : undefined));
    try {
      const old = await connectIpcPlainWsClient(ws);
      try {
        expect(await handshakeAs(old, { ...pinned, contractVersion: Machine.handshakeContractVersion - 1 })).toEqual({ status: "refused", reason: "unsupported_contract" });
        const legacy = { ...offer("pinned", "/tmp"), peer: { kind: "client", contractVersion: Machine.handshakeContractVersion - 1 } };
        expect(await old.call(Machine.WireMethod.Attach, legacy)).toEqual({ status: "refused", reason: "unsupported_contract" });
        expect(host.list()).toEqual([]);
      } finally {
        await old.close();
      }
    } finally {
      await host.close();
    }
  });

  test("an enrollment rotated between the handshake and the attach is refused peer_key_mismatch", async () => {
    let current = enrollment("pinned", daemonFingerprint);
    const { host, ws } = await plaintextHost((id) => (id === "pinned" ? current : undefined));
    try {
      const client = await connectIpcPlainWsClient(ws);
      try {
        expect(await handshakeAs(client, pinned)).toMatchObject({ status: "accepted" });
        current = enrollment("pinned", "f".repeat(64));
        expect(await client.call(Machine.WireMethod.Attach, offer("pinned", "/tmp"))).toEqual({ status: "refused", reason: "peer_key_mismatch" });
        expect(host.list()).toEqual([]);
      } finally {
        await client.close();
      }
    } finally {
      await host.close();
    }
  });

  test("an acceptance signed by a key other than the pinned host is refused by the initiator", () => {
    const sent = helloFor(pinned);
    const wrongPin = { ...pinned, hostPin: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" };
    const accepted: Machine.HandshakeAccepted = {
      status: "accepted",
      staticKey: sent.hello.staticKey,
      ephemeralKey: sent.hello.ephemeralKey,
      nonce: sent.hello.nonce,
      signature: sent.hello.signature,
    };
    expect(() => acceptedSeal(sent, accepted, wrongPin.hostPin)).toThrow("host key mismatch inside the handshake");
    const ownPin = createHash("sha256").update(Buffer.from(accepted.staticKey, "base64")).digest("base64");
    expect(() => acceptedSeal(sent, accepted, ownPin)).toThrow("the host's handshake signature does not verify");
    expect(() => helloFor({ ...pinned, identity: otherIdentity })).toThrow("not a P-256 key");
  });
});

describe("signed machine handshake on the TLS and unix doors (#1832)", () => {
  test("the pinned mutual-TLS tcp door still demands the handshake before machine.attach", async () => {
    const host = await createMachineHost({
      listen: { tcp: { host: loopback, port: 0 } },
      tls: hostIdentity,
      enrollment: (id) => (id === "pinned" ? enrollment("pinned", daemonFingerprint) : undefined),
      events: silent,
      now: () => 3,
    });
    try {
      const port = host.endpoints.tcp?.port ?? 0;
      const eager = await connectIpcTcpClient({ tcp: { host: loopback, port }, tls: daemonIdentity, hostPin });
      try {
        await expect(eager.call(Machine.WireMethod.Attach, offer("pinned", "/tmp"))).rejects.toMatchObject({
          _tag: "IpcRemoteError", message: "IPC error 1000: machine.attach requires a completed machine.handshake on this connection",
        });
        await expect(eager.call(Machine.WireMethod.Report, {})).rejects.toMatchObject({
          _tag: "IpcRemoteError", message: "IPC error 1000: machine.report requires a completed machine.handshake on this connection",
        });
        expect(await handshakeAs(eager, pinned)).toMatchObject({ status: "accepted" });
        expect(await eager.call(Machine.WireMethod.Attach, offer("pinned", "/tmp"))).toMatchObject({ status: "attached" });
        expect(host.list().map((machine) => machine.machineId)).toEqual(["pinned"]);
      } finally {
        await eager.close();
      }
    } finally {
      await host.close();
    }
  });

  test("the unix door is the kernel's own socket: machine.handshake is not served there", async () => {
    const unix = socketPath();
    const host = await createMachineHost({
      listen: { unix },
      enrollment: (id) => (id === "local" ? enrollment("local", "0".repeat(64)) : undefined),
      events: silent,
      now: () => 3,
    });
    try {
      const local = await connectIpcClient(unix);
      try {
        await expect(local.call(Machine.WireMethod.Handshake, helloFor({ ...pinned, machineId: "local" }).hello)).rejects.toMatchObject({
          _tag: "IpcRemoteError", message: "IPC error 1000: machine.handshake is not served on the unix door",
        });
        expect(await local.call(Machine.WireMethod.Attach, offer("local", "/tmp"))).toMatchObject({ status: "attached" });
      } finally {
        await local.close();
      }
    } finally {
      await host.close();
    }
  });

  test("a host identity that cannot sign the handshake opens no network door", async () => {
    await expect(createMachineHost({
      listen: { tcp: { host: loopback, port: 0 } },
      tls: otherIdentity,
      enrollment: () => undefined,
      events: silent,
      now: () => 3,
    })).rejects.toThrow("the host tls identity must carry a P-256 key to sign the machine handshake");
  });
});
