import { beforeAll, describe, expect, test } from "bun:test";
import { Machine } from "@oni/protocol";
import { createMachineHost } from "./helpers/native";
import { attachMclient, mclientBinary, mclientEnrollment } from "./helpers/mclient";
import { connectIpcClient } from "./ipc/helpers/native";
import { socketPath } from "./helpers/socket-path";
import { eventCollector } from "./helpers/events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeAll(mclientBinary, 300_000);

describe("machine.report heartbeat", () => {
  test("the real client reports load and the host judges staleness on its own clock", async () => {
    const root = mkdtempSync(join(tmpdir(), "oni-report-"));
    const events = eventCollector();
    let hostNow = 100;
    const host = await createMachineHost({
      listen: { unix: socketPath() }, enrollment: (id) => id === "w-1" ? mclientEnrollment(id) : undefined,
      events: events.sink, now: () => hostNow, staleAfterMs: 1000,
    });
    const client = await attachMclient({ host, events, machineId: "w-1", root });
    try {
      const first = host.list()[0];
      expect(first).toMatchObject({ machineId: "w-1", peer: { kind: "client" } });
      expect(first?.resources?.cpus).toBeGreaterThan(0);
      expect(first?.live?.stale).toBe(false);
      if (process.platform === "darwin") {
        expect(first?.live?.screen?.permission === "granted" || first?.live?.screen?.permission === "denied").toBe(true);
      } else {
        expect(first?.live?.screen).toEqual({ permission: "unsupported" });
      }
      hostNow = 1101;
      expect(host.list()[0]?.live?.stale).toBe(true);
    } finally {
      const detached = events.next(Machine.Events.Detached.name);
      await client.stop();
      await detached;
      expect(host.list()).toEqual([]);
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the host rejects unattached and wrong-machine reports", async () => {
    const events = eventCollector();
    const host = await createMachineHost({
      listen: { unix: socketPath() }, enrollment: (id) => id === "w-1" ? mclientEnrollment(id) : undefined,
      events: events.sink, now: () => 0,
    });
    const peer = await connectIpcClient(host.endpoints.unix ?? "");
    const load = { loadAvg1: 0, memoryAvailableBytes: 0, inFlight: 0 };
    const screen = { permission: "denied" } as const;
    const report = (machineId: string) => peer.call(Machine.WireMethod.Report, { machineId, reportedAt: 1, load, screen });
    try {
      expect(await report("w-1")).toEqual({ status: "refused", reason: "machine_not_attached" });
      expect(await peer.call(Machine.WireMethod.Attach, {
        machineId: "w-1", daemonVersion: "simulated", platform: "darwin-arm64", offeredCapabilities: ["kernel.py"],
        offeredAt: 1, peer: { kind: "client", contractVersion: Machine.contractVersion },
      })).toMatchObject({ status: "attached" });
      expect(await report("other")).toEqual({ status: "refused", reason: "machine_mismatch" });
      expect(host.list()[0]?.live).toBeUndefined();
      expect(await report("w-1")).toEqual({ status: "accepted" });
      expect(host.list()[0]?.live).toEqual({ reportedAt: 1, load, screen, stale: false });
    } finally {
      await peer.close();
      await host.close();
    }
  });

  test("a screenless client report retains the live row without a screen key", async () => {
    const host = await createMachineHost({
      listen: { unix: socketPath() }, enrollment: (id) => id === "w-1" ? mclientEnrollment(id) : undefined,
      events: eventCollector().sink, now: () => 10,
    });
    const peer = await connectIpcClient(host.endpoints.unix ?? "");
    const load = { loadAvg1: 0.25, memoryAvailableBytes: 4096, inFlight: 0 };
    try {
      expect(await peer.call(Machine.WireMethod.Attach, {
        machineId: "w-1", daemonVersion: "old-client", platform: "linux-arm64", offeredCapabilities: ["kernel.py"],
        offeredAt: 1, peer: { kind: "client", contractVersion: Machine.contractVersion },
      })).toMatchObject({ status: "attached" });
      expect(await peer.call(Machine.WireMethod.Report, {
        machineId: "w-1", reportedAt: 2, load,
      })).toEqual({ status: "accepted" });
      expect(host.list()[0]?.live).toEqual({ reportedAt: 2, load, stale: false });
    } finally {
      await peer.close();
      await host.close();
    }
  });
});
