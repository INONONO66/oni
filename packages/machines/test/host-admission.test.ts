import { expect, test } from "bun:test";
import { type Ipc, Machine } from "@oni/protocol";
import { Effect } from "effect";
import { createMemoryGenerationStore, type AttachGenerationStore } from "../src";
import { createMachineHost } from "./helpers/native";
import { eventCollector } from "./helpers/events";
import { socketPath } from "./helpers/socket-path";
import { run } from "./ipc/helpers/effects";
import { connectIpcClient } from "./ipc/helpers/native";
import { captureError, within } from "./ipc/helpers/signal";

const offer: Machine.Offer = {
  machineId: "worker", daemonVersion: "test", platform: "linux-arm64", offeredAt: 0,
  peer: { kind: "daemon", contractVersion: 3 }, offeredCapabilities: ["shell.exec"],
  resources: { cpus: 1, memoryBytes: 1024 },
};
const attached = (generation: number): Machine.AttachResult => ({
  status: "attached", generation, effectiveCapabilities: ["shell.exec"], effectiveExports: [],
});

async function fixture(options: { generations?: AttachGenerationStore; neverSupersede?: readonly string[] } = {}) {
  const events = eventCollector();
  const generations = options.generations ?? createMemoryGenerationStore();
  const host = await createMachineHost({
    ...options, generations, events: events.sink, now: () => 10, listen: { unix: socketPath() },
    enrollment: (machineId) => ({
      machineId, name: machineId, allowedCapabilities: ["shell.exec"], publicKey: "0".repeat(64), enrolledAt: 0,
    }),
  });
  const peers: Array<Awaited<ReturnType<typeof connectIpcClient>>> = [];
  async function connect(onDisconnect?: () => void) {
    const client = await connectIpcClient(host.endpoints.unix ?? "", { onDisconnect });
    peers.push(client);
    return client;
  }
  return {
    host, events, generations, connect,
    async close() { for (const peer of peers) await peer.close(); await host.close(); },
  };
}

test("v3 daemon and client fresh offers mint successive generations for one machine", async () => {
  const f = await fixture();
  try {
    const daemon = await f.connect();
    expect(await daemon.call(Machine.WireMethod.Attach, offer)).toEqual(attached(1));
    const client = await f.connect();
    const peer: Machine.Offer["peer"] = { kind: "client", contractVersion: 3 };
    expect(await client.call(Machine.WireMethod.Attach, { ...offer, peer })).toEqual(attached(2));
    expect(f.host.list()).toMatchObject([{ machineId: "worker", generation: 2, peer }]);
    const listed = f.host.list()[0];
    if (listed === undefined) throw new Error("missing attached machine");
    listed.peer.kind = "daemon";
    expect(f.host.list()[0]?.peer.kind).toBe("client");
  } finally { await f.close(); }
});

test("a current reconnect supersedes a live protected attachment without minting", async () => {
  const f = await fixture({ neverSupersede: ["worker"] });
  try {
    const first = await f.connect();
    expect(await first.call(Machine.WireMethod.Attach, offer)).toEqual(attached(1));
    const second = await f.connect();
    expect(await second.call(Machine.WireMethod.Attach, { ...offer, generation: 1 })).toEqual(attached(1));
    expect(await run(f.generations.current("worker"))).toBe(1);
    expect(f.events.events.map((event) => event.name)).toEqual(["machine.attached", "machine.detached", "machine.attached"]);
  } finally { await f.close(); }
});

test.each([
  { machineId: "worker", generation: 1 },
  { machineId: "worker", generation: 3 },
  { machineId: "unseen", generation: 1 },
])("reconnect skew is refused without minting: %j", async (reconnect) => {
  const generations = createMemoryGenerationStore();
  await run(generations.compareAndSet("worker", undefined, 2));
  const f = await fixture({ generations });
  try {
    const client = await f.connect();
    expect(await client.call(Machine.WireMethod.Attach, { ...offer, ...reconnect })).toEqual({ status: "refused", reason: "stale_generation" });
    expect(await run(generations.current("worker"))).toBe(2);
    expect(await run(generations.current("unseen"))).toBeUndefined();
    expect(f.host.list()).toEqual([]);
    expect(f.events.events).toEqual([]);
  } finally { await f.close(); }
});

test.each([1, 4])("contract %s is refused before generation admission", async (contractVersion) => {
  const f = await fixture();
  try {
    const client = await f.connect();
    expect(await client.call(Machine.WireMethod.Attach, { ...offer, peer: { kind: "client", contractVersion }, generation: 1 }))
      .toEqual({ status: "refused", reason: "unsupported_contract" });
    expect(await run(f.generations.current("worker"))).toBeUndefined();
    expect(f.host.list()).toEqual([]);
  } finally { await f.close(); }
});

test.each([
  { kind: "other", contractVersion: 3 },
  { kind: "daemon", contractVersion: 0 },
  { kind: "daemon", contractVersion: 3, extra: true },
  null,
])("malformed peer fails at the offer parse boundary: %j", async (peer) => {
  const f = await fixture();
  try {
    const client = await f.connect();
    await expect(client.call(Machine.WireMethod.Attach, { ...offer, peer })).rejects.toMatchObject({ _tag: "IpcRemoteError" });
    const { peer: _peer, ...missingPeer } = offer;
    await expect(client.call(Machine.WireMethod.Attach, missingPeer)).rejects.toMatchObject({ _tag: "IpcRemoteError" });
    expect(f.events.events).toEqual([]);
  } finally { await f.close(); }
});

test.each([1, 2])("fresh admission retries one CAS conflict, refusing after two: %s", async (conflicts) => {
  const memory = createMemoryGenerationStore();
  const reads: Array<number | undefined> = [];
  let attempts = 0;
  const generations: AttachGenerationStore = {
    current: (id) => memory.current(id).pipe(Effect.tap((value) => Effect.sync(() => { reads.push(value); }))),
    compareAndSet: (id, expected, next) => Effect.gen(function* () {
      attempts += 1;
      if (attempts > conflicts) return yield* memory.compareAndSet(id, expected, next);
      yield* memory.compareAndSet(id, expected, next + 1);
      return false;
    }),
  };
  const f = await fixture({ generations });
  try {
    const client = await f.connect();
    expect(await client.call(Machine.WireMethod.Attach, offer))
      .toEqual(conflicts === 1 ? attached(3) : { status: "refused", reason: "stale_generation" });
    expect(attempts).toBe(2);
    expect(reads).toEqual([undefined, 2]);
    expect(f.host.list()).toHaveLength(conflicts === 1 ? 1 : 0);
  } finally { await f.close(); }
});

test("supersession closes the incumbent and fences its released leases before running work", async () => {
  const f = await fixture();
  const closed = Promise.withResolvers<void>();
  try {
    const first = await f.connect(closed.resolve);
    await first.call(Machine.WireMethod.Attach, offer);
    const placed = f.host.place({ machineId: "worker" });
    if (placed.kind !== "placed") throw new Error(placed.kind);
    const lease = placed.lease;
    await run(lease.renewPtyWhile(Effect.succeed({ status: "ok" as const }), { op: "open", name: "retained" }));
    expect(f.host.place({ machineId: "worker" }).kind).toBe("machine_saturated");
    const detached = f.events.next("machine.detached");
    const next = await f.connect();
    expect(await next.call(Machine.WireMethod.Attach, offer)).toEqual(attached(2));
    expect((await detached).payload).toEqual({ machineId: "worker", time: 10, reason: "superseded" });
    await closed.promise;
    expect(first.connected).toBe(false);
    expect(lease.signal.aborted).toBe(true);
    let executions = 0;
    const operation = Effect.sync(() => { executions += 1; return { status: "ok" as const }; });
    for (const action of [
      lease.renewWhile(operation).pipe(Effect.asVoid),
      lease.renewPtyWhile(operation, { name: "retained", op: "use" }).pipe(Effect.asVoid),
      lease.renewWhile(Effect.sync(() => f.host.place({ machineId: "worker" }))).pipe(Effect.asVoid),
    ]) await expect(run(action)).rejects.toMatchObject({ _tag: "MachineRefusalError", status: "refused", reason: "stale_generation" });
    expect(executions).toBe(0);
    const replacement = f.host.place({ machineId: "worker" });
    expect(replacement.kind).toBe("placed");
    if (replacement.kind === "placed") replacement.lease.release();
  } finally { await f.close(); }
});

test("neverSupersede refuses fresh offers without minting or disconnecting the incumbent", async () => {
  const f = await fixture({ neverSupersede: ["worker"] });
  try {
    const first = await f.connect();
    await first.call(Machine.WireMethod.Attach, offer);
    const next = await f.connect();
    expect(await next.call(Machine.WireMethod.Attach, offer)).toEqual({ status: "refused", reason: "already_attached" });
    expect(await run(f.generations.current("worker"))).toBe(1);
    expect(first.connected).toBe(true);
    expect(f.events.events).toHaveLength(1);
  } finally { await f.close(); }
});

test("fresh re-attach on one connection replaces its attachment and fences its old lease", async () => {
  const f = await fixture();
  try {
    const client = await f.connect();
    await client.call(Machine.WireMethod.Attach, offer);
    const placed = f.host.place({ machineId: "worker" });
    if (placed.kind !== "placed") throw new Error(placed.kind);
    const params: Ipc.Request["params"] = { ...offer, machineId: "replacement" };
    expect(await client.call(Machine.WireMethod.Attach, params)).toEqual(attached(1));
    expect(f.host.list().map((entry) => entry.machineId)).toEqual(["replacement"]);
    await expect(run(placed.lease.renewWhile(Effect.void))).rejects.toMatchObject({ reason: "stale_generation" });
    expect(client.connected).toBe(true);
  } finally { await f.close(); }
});

test("disconnect during generation admission cannot publish a ghost or route into another peer", async () => {
  const memory = createMemoryGenerationStore();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let reads = 0;
  const generations: AttachGenerationStore = {
    current: (id) => Effect.gen(function* () {
      reads += 1;
      if (reads === 2) {
        entered.resolve();
        yield* Effect.promise(() => resume.promise);
      }
      return yield* memory.current(id);
    }),
    compareAndSet: memory.compareAndSet,
  };
  const f = await fixture({ generations });
  let survivorCalls = 0;
  try {
    const worker = await f.connect();
    expect(await worker.call(Machine.WireMethod.Attach, offer)).toEqual(attached(1));
    const pending = captureError(worker.call(Machine.WireMethod.Attach, offer));
    await within(entered.promise, "deferred generation read");
    const detached = f.events.next("machine.detached");
    await worker.close();
    await within(detached, "worker disconnect");
    const survivor = await connectIpcClient(f.host.endpoints.unix ?? "", {
      onRequest: (method, _params, respond) => {
        expect(method).toBe(Machine.WireMethod.Exec);
        survivorCalls += 1;
        respond({ status: "completed", stdout: "", stderr: "", exitCode: 0, signal: null, truncated: false });
      },
    });
    try {
      resume.resolve();
      expect(await survivor.call(Machine.WireMethod.Attach, { ...offer, machineId: "survivor" })).toEqual(attached(1));
      expect((await within(pending, "closed worker request")).name).toBe("IpcConnectionError");
      expect(f.host.list().map(({ machineId }) => machineId)).toEqual(["survivor"]);
      expect(f.events.events.map(({ name }) => name)).toEqual(["machine.attached", "machine.detached", "machine.attached"]);
      await expect(f.host.get("worker").exec("probe", "/")).rejects.toMatchObject({ reason: "disconnected" });
      expect(survivorCalls).toBe(0);
    } finally { await survivor.close(); }
  } finally { resume.resolve(); await f.close(); }
});

test.each(["renewWhile", "renewPtyWhile"] as const)("supersession cancels an entered %s before it can place or call", async (method) => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let placedAfterFence = 0;
  try {
    const first = await f.connect();
    await first.call(Machine.WireMethod.Attach, offer);
    const placed = f.host.place({ machineId: "worker" });
    if (placed.kind !== "placed") throw new Error(placed.kind);
    const operation = Effect.gen(function* () {
      entered.resolve();
      yield* Effect.promise(() => resume.promise);
      placedAfterFence += 1;
      return { status: "ok" as const, value: f.host.place({ machineId: "worker" }) };
    });
    const running = run(method === "renewWhile" ? placed.lease.renewWhile(operation) :
      placed.lease.renewPtyWhile(operation, { op: "open", name: "pending" }));
    const outcome = captureError(running);
    await within(entered.promise, "lease operation entry");
    const second = await f.connect();
    expect(await second.call(Machine.WireMethod.Attach, offer)).toEqual(attached(2));
    resume.resolve();
    expect(await within(outcome, "fenced lease operation")).toMatchObject({
      _tag: "MachineRefusalError", status: "refused", reason: "stale_generation",
    });
    expect(placedAfterFence).toBe(0);
    expect(placed.lease.signal.aborted).toBe(true);
    expect(f.host.place({ machineId: "worker" }).kind).toBe("placed");
  } finally { resume.resolve(); await f.close(); }
});

test.each(["unenroll", "close"] as const)("%s during pending generation read prevents publication and mint", async (action) => {
  const memory = createMemoryGenerationStore();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const generations: AttachGenerationStore = {
    current: (id) => Effect.gen(function* () {
      entered.resolve();
      yield* Effect.promise(() => resume.promise);
      return yield* memory.current(id);
    }),
    compareAndSet: memory.compareAndSet,
  };
  const f = await fixture({ generations });
  try {
    const peer = await f.connect();
    const pending = peer.call(Machine.WireMethod.Attach, offer).then(
      (reply) => reply,
      (error: Error) => error,
    );
    await within(entered.promise, "pending admission");
    if (action === "unenroll") f.host.native.unenroll("worker");
    else await f.host.close();
    resume.resolve();
    const outcome = await within(pending, "pending request teardown");
    if (action === "unenroll") expect(outcome).toEqual({ status: "refused", reason: "machine_not_enrolled" });
    else expect(outcome).toMatchObject({ name: "IpcConnectionError" });
    expect(await run(memory.current("worker"))).toBeUndefined();
    expect(f.host.list()).toEqual([]);
    expect(f.events.events).toEqual([]);
  } finally { resume.resolve(); await f.close(); }
});
