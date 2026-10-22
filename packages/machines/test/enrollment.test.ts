import { expect, test } from "bun:test";
import type { Machine } from "@oni/protocol";
import { attachMachineDaemon, createMachineHost } from "./helpers/native";
import { socketPath } from "./helpers/socket-path";
import { eventCollector } from "./helpers/events";
import { captureError, within } from "./ipc/helpers/signal";

test("enrollment removal drops reports and fails in-flight calls once while other peers remain attached", async () => {
  const path = socketPath();
  const events = eventCollector();
  const enrollment: Machine.Enrollment = { machineId: "worker", name: "Worker", allowedCapabilities: ["kernel.py"], publicKey: "a".repeat(64), enrolledAt: 1 };
  const records = new Map([["worker", enrollment], ["other", { ...enrollment, machineId: "other" }]]);
  const host = await createMachineHost({ listen: { unix: path }, enrollment: (id) => records.get(id), events: events.sink, now: () => 10 });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const beat = Promise.withResolvers<() => void>();
  const reported = events.next("machine.reported");
  const offer: Omit<Machine.Offer, "peer" | "generation"> = { machineId: "worker", daemonVersion: "test", offeredCapabilities: ["kernel.py"], offeredAt: 2, platform: "darwin-arm64" };
  const daemon = await attachMachineDaemon({
    socketPath: path, offer,
    report: {
      now: () => 10,
      scheduler: { schedule: (_delay, callback) => { beat.resolve(callback); return () => undefined; } },
      probe: { resources: () => ({ cpus: 4, memoryBytes: 8192 }), load: () => ({ loadAvg1: 0.5, memoryAvailableBytes: 4096 }) },
    },
    runner: {
      runCode: async (request) => {
        entered.resolve();
        await release.promise;
        return { status: "completed", cellId: request.cellId, output: { stdout: "", stderr: "" } };
      },
      peekCode: () => ({ stdout: "", stderr: "" }),
      close: async () => undefined,
    },
  });
  const other = await attachMachineDaemon({ socketPath: path, offer: { ...offer, machineId: "other" } });
  try {
    (await beat.promise)();
    await within(reported, "first report");
    expect(host.list().find((row) => row.machineId === "worker")?.live?.stale).toBe(false);
    const pending = captureError(host.get("worker").runCode({ cellId: "held", code: "x", timeoutMs: 60_000 }));
    await within(entered.promise, "runner entered");
    const detached = events.next("machine.detached");
    records.delete("worker");
    host.native.unenroll("worker");
    expect((await within(detached, "revocation")).payload).toMatchObject({ reason: "enrollment_removed" });
    expect(await within(pending, "pending disconnect")).toMatchObject({ reason: "disconnected" });
    expect(host.list().map((row) => row.machineId)).toEqual(["other"]);
    host.native.unenroll("worker");
    expect(events.events.filter((event) => event.name === "machine.detached")).toHaveLength(1);
    records.set("worker", enrollment);
    const replacement = await attachMachineDaemon({ socketPath: path, offer });
    try {
      expect(host.list().find((row) => row.machineId === "worker")?.live).toBeUndefined();
    } finally { await replacement.close(); }
  } finally {
    release.resolve();
    await daemon.close();
    await other.close();
    await host.close();
  }
});
