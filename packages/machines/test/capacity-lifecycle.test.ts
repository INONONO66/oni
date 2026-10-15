import { expect, test } from "bun:test";
import { Effect, Exit, Fiber } from "effect";
import { fixture, pick, request } from "./helpers/capacity";
import { foreign } from "./helpers/native";
import { run } from "./ipc/helpers/effects";
import { fork } from "./helpers/effect";
import { createCapacity } from "../src/capacity";

test.each([4, null])("exclusive holder overlaps calls without another charge with %j slots", async (slots) => {
  const f = await fixture(slots === null ? [] : [{ machineId: "w", slots }], null);
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const finish = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  try {
    const picked = f.host.place({ ...request, prefer: "exclusive" });
    if (picked.kind !== "placed") throw new Error(`expected exclusive lease: ${picked.kind}`);
    const running = entered.map((signal, index) => run(picked.lease.renewWhile(foreign(async () => {
      signal.resolve();
      await finish[index]?.promise;
    }))));
    await Promise.all(entered.map((signal) => signal.promise));
    f.time.advance(100);
    picked.lease.release();
    expect(f.host.place(request)).toMatchObject({ kind: "machine_saturated", inFlight: slots ?? 1 });
    finish[0]?.resolve();
    await running[0];
    expect(f.host.place(request).kind).toBe("machine_saturated");
    finish[1]?.resolve();
    await running[1];
    expect(f.host.place(request).kind).toBe("placed");
  } finally { for (const signal of finish) signal.resolve(); await f.close(); }
});

test("an early timer rearms only the remaining idle duration", async () => {
  const f = await fixture([{ machineId: "w", slots: 1 }]);
  try {
    const lease = pick(f.host);
    f.time.advance(3);
    const timer = f.time.entries[0];
    if (timer === undefined) throw new Error("expected idle timer");
    timer.cancelled = true;
    timer.task();
    expect(f.time.entries.at(-1)?.delay).toBe(7);
    f.time.advance(6);
    expect(f.host.place(request).kind).toBe("machine_saturated");
    f.time.advance(1);
    expect(lease.signal.aborted).toBe(true);
    expect(f.host.place(request).kind).toBe("placed");
  } finally { await f.close(); }
});

test("interruption during acquisition still releases the charge and rearms expiry", async () => {
  const f = await fixture([{ machineId: "w", slots: 1 }]);
  let entered = false;
  try {
    const lease = pick(f.host);
    const interrupted = fork(Effect.withFiber((fiber) => {
      f.time.onCancel(() => fiber.interruptUnsafe());
      return lease.renewWhile(Effect.sync(() => { entered = true; }));
    }));
    const outcome = await run(Fiber.await(interrupted));
    expect(Exit.hasInterrupts(outcome)).toBe(true);
    expect(entered).toBe(false);
    f.time.advance(11);
    expect(f.host.place(request).kind).toBe("placed");
  } finally { await f.close(); }
});

test("renewal charges the operation class rather than the original pick class", async () => {
  const f = await fixture([{ tag: "worker", slots: 2, classCosts: { exec: 1, eval: 1, pty: 1, job: 2 } }]);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  try {
    const lease = pick(f.host);
    const running = run(lease.renewWhile(foreign(async () => { entered.resolve(); await finish.promise; }), "job"));
    await entered.promise;
    expect(f.host.place(request)).toMatchObject({ kind: "machine_saturated", inFlight: 2 });
    finish.resolve();
    await running;
    expect(f.host.place(request).kind).toBe("placed");
  } finally { finish.resolve(); await f.close(); }
});

test("overlapping opens of one terminal retain one releasable claim", async () => {
  const f = await fixture();
  const capacity = createCapacity({ rows: [], list: f.host.list, now: f.time.now, scheduler: f.time, events: f.events.sink, id: () => "terminal-owner" });
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const finish = Promise.withResolvers<void>();
  try {
    const placed = capacity.place({ ...request, prefer: "exclusive" });
    if (placed.kind !== "placed") throw new Error(`expected exclusive lease: ${placed.kind}`);
    const calls = entered.map((signal) => run(placed.lease.renewPtyWhile(foreign(async () => {
      signal.resolve();
      await finish.promise;
      return { status: "ok", cursor: "opened" } as const;
    }), { name: "shared", op: "open" })));
    await Promise.all(entered.map((signal) => signal.promise));
    finish.resolve();
    await Promise.all(calls);
    f.time.advance(20_000);
    expect(capacity.place(request).kind).toBe("machine_saturated");
    capacity.terminalClosed("w", "shared");
    placed.lease.release();
    expect(capacity.place(request).kind).toBe("placed");
  } finally { finish.resolve(); capacity.detach("w"); await f.close(); }
});
