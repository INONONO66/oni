import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createMachineHost, foreign } from "./helpers/native";
import { socketPath } from "./helpers/socket-path";
import { run } from "./ipc/helpers/effects";
import { fixture, pick, request } from "./helpers/capacity";

test("exhausted slots refuse with decision credit and an exact bus fact", async () => {
  const f = await fixture([{ tag: "worker", slots: 1 }]);
  try {
    pick(f.host);
    const event = f.events.next("machine.lease_refused");
    expect(f.host.place(request)).toEqual({ kind: "machine_saturated", machineId: "w", reason: "slots", slots: 1, inFlight: 1 });
    expect((await event).payload).toEqual({ machineId: "w", reason: "slots", slots: 1, inFlight: 1, time: 0 });
  } finally { await f.close(); }
});

test("effective rows default from offers and exact selectors override matching tags", async () => {
  const f = await fixture([
    { machineId: "w", slots: 3 }, { tag: "worker", slots: 1, memReserveBytes: 5 },
    { tag: "later", slots: 7 },
  ]);
  try {
    expect(f.host.capacity()).toEqual([{ machineId: "w", slots: 3, memReserveBytes: 5, classCosts: { exec: 1, eval: 1, pty: 1, job: 1 } }]);
    expect(f.host.place({ ...request, tag: "missing" })).toEqual({ kind: "no_member" });
    expect(f.host.place({ ...request, requires: ["kernel.py"] })).toEqual({ kind: "no_member" });
  } finally { await f.close(); }
  const defaults = await fixture();
  try {
    expect(defaults.host.capacity()).toEqual([{ machineId: "w", slots: 2, memReserveBytes: 0, classCosts: { exec: 1, eval: 1, pty: 1, job: 1 } }]);
  } finally { await defaults.close(); }
});

test("reserve admission and renewal read the latest report before running an operation", async () => {
  const f = await fixture([{ tag: "worker", memReserveBytes: 200 * 1024 ** 2 }]);
  try {
    const lease = pick(f.host);
    await f.report(100 * 1024 ** 2);
    const expected = { machineId: "w", reason: "memory", slots: 2, inFlight: 1, memoryAvailableBytes: 100 * 1024 ** 2, memReserveBytes: 200 * 1024 ** 2 } as const;
    expect(f.host.place(request)).toEqual({ kind: "machine_saturated", ...expected });
    // This would send machine.exec to a peer with no request handler if admitted.
    await expect(run(lease.renewWhile(f.host.native.get("w").exec("exit 0", "/")))).rejects.toMatchObject({ reason: "machine_saturated", credit: expected });
    await f.report(300 * 1024 ** 2);
    expect(await run(lease.renewWhile(Effect.succeed("admitted")))).toBe("admitted");
  } finally { await f.close(); }
});

test("stale memory is unknown and ranks after a member with current resources", async () => {
  const f = await fixture([{ tag: "worker", memReserveBytes: 200 }]);
  try {
    await f.report(100);
    f.time.advance(21);
    await f.attach("fresh");
    expect(f.host.place(request)).toMatchObject({ kind: "placed", machineId: "fresh" });
    expect(f.host.place(request)).toMatchObject({ kind: "placed", machineId: "fresh" });
    expect(f.host.place(request)).toMatchObject({ kind: "placed", machineId: "w" });
  } finally { await f.close(); }
});

test("unknown offered capacity remains eligible and reports unknown slot credit", async () => {
  const f = await fixture([{ tag: "worker", memReserveBytes: 10 }], null);
  try {
    expect(f.host.capacity()[0]?.slots).toBeNull();
    pick(f.host);
    await f.report(5);
    expect(f.host.place(request)).toMatchObject({ kind: "machine_saturated", slots: null, reason: "memory" });
  } finally { await f.close(); }
});

test("idle expiry releases credit and invalidates the old handle", async () => {
  const f = await fixture([{ machineId: "w", slots: 1 }]);
  try {
    const lease = pick(f.host);
    f.time.advance(9);
    expect(f.host.place(request).kind).toBe("machine_saturated");
    f.time.advance(2);
    expect(f.host.place(request).kind).toBe("placed");
    await expect(run(lease.renewWhile(Effect.void))).rejects.toMatchObject({ reason: "lease_expired" });
  } finally { await f.close(); }
});

test("renewal holds credit through execution and starts idle TTL only after settlement", async () => {
  const f = await fixture([{ machineId: "w", slots: 1 }]);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  try {
    const lease = pick(f.host);
    const running = run(lease.renewWhile(foreign(async () => { entered.resolve(); await finish.promise; })));
    await entered.promise;
    f.time.advance(100);
    expect(f.host.place(request).kind).toBe("machine_saturated");
    await expect(run(lease.renewWhile(Effect.void))).rejects.toMatchObject({ reason: "machine_saturated" });
    finish.resolve();
    await running;
    f.time.advance(9);
    expect(f.host.place(request).kind).toBe("machine_saturated");
    f.time.advance(2);
    expect(f.host.place(request).kind).toBe("placed");
  } finally { finish.resolve(); await f.close(); }
});

test("release during concurrent calls retains their credit until both finish", async () => {
  const f = await fixture();
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const finish = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  try {
    const lease = pick(f.host);
    const running = entered.map((signal, index) => run(lease.renewWhile(foreign(async () => { signal.resolve(); await finish[index]?.promise; }))));
    await Promise.all(entered.map((signal) => signal.promise));
    lease.release();
    expect(f.host.place(request).kind).toBe("machine_saturated");
    finish[0]?.resolve(); await running[0];
    expect(f.host.place(request).kind).toBe("placed");
    finish[1]?.resolve(); await running[1];
    expect(f.host.place(request).kind).toBe("placed");
  } finally { for (const signal of finish) signal.resolve(); await f.close(); }
});

test("job costs reserve weighted credit and exclusive selection requires an empty member", async () => {
  const f = await fixture([{ tag: "worker", slots: 3, classCosts: { exec: 1, eval: 1, pty: 1, job: 2 } }]);
  try {
    const snapshot = f.host.capacity()[0];
    if (snapshot === undefined) throw new Error("expected attached capacity");
    snapshot.classCosts.job = 1;
    const lease = pick(f.host, "job");
    expect(f.host.place(request, "job")).toMatchObject({ kind: "machine_saturated", inFlight: 2 });
    expect(f.host.place({ ...request, prefer: "exclusive" })).toMatchObject({ kind: "machine_saturated", inFlight: 2 });
    lease.release();
    const exclusive = f.host.place({ ...request, prefer: "exclusive" });
    expect(exclusive.kind).toBe("placed");
    expect(f.host.place(request)).toMatchObject({ kind: "machine_saturated", inFlight: 3 });
    if (exclusive.kind === "placed") {
      expect(await run(exclusive.lease.renewWhile(Effect.succeed("owned")))).toBe("owned");
      exclusive.lease.release();
    }
    expect(f.host.place(request).kind).toBe("placed");
  } finally { await f.close(); }
});

test("reattachment invalidates old leases instead of charging the replacement", async () => {
  const f = await fixture([{ machineId: "w", slots: 1 }]);
  try {
    const lease = pick(f.host);
    await f.attach("w");
    expect(f.host.place(request).kind).toBe("placed");
    await expect(run(lease.renewWhile(Effect.void))).rejects.toMatchObject({ reason: "lease_expired" });
  } finally { await f.close(); }
});

test.each([
  { capacity: [{ machineId: "w", slots: 0 }] },
  { capacity: [{ machineId: "w" }, { machineId: "w" }] },
])("invalid capacity rows fail before opening a listener: %j", async ({ capacity }) => {
  await expect(createMachineHost({ listen: { unix: socketPath() }, enrollment: () => undefined, events: { publish: () => undefined }, now: () => 0, capacity })).rejects.toMatchObject({ operation: "capacity.decode" });
});
