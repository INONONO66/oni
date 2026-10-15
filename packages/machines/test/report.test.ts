import { describe, expect, test } from "bun:test";
import { Machine } from "@openomni/protocol";
import { attachMachineDaemon, createMachineHost } from "./helpers/native";
import { connectIpcClient } from "./ipc/helpers/native";
import { socketPath } from "./helpers/socket-path";
import { eventCollector } from "./helpers/events";

/**
 * #1555 heartbeat proof: the daemon's cadence runs ONLY through the injected
 * scheduler and clock, the probe is a fake, and host staleness is judged by
 * the host's own injected clock — no sleeps, no polling, no OS reads.
 */
type Scheduled = { readonly delay: number; task: () => void; cancelled: boolean };
function fakeScheduler() {
  const entries: Scheduled[] = [];
  const waiters: Array<(entry: Scheduled) => void> = [];
  return {
    entries,
    schedule(delay: number, task: () => void): () => void {
      const entry: Scheduled = { delay, task, cancelled: false };
      entries.push(entry);
      for (const waiter of waiters.splice(0)) waiter(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    /** Resolves on the NEXT schedule() call (bounded by bun's test timeout). */
    nextScheduled(): Promise<Scheduled> {
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

const enrollment: Machine.Enrollment = {
  name: "worker",
  machineId: "w-1",
  allowedCapabilities: ["kernel.py"],
  publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  enrolledAt: 1,
};
function offer(changes: Partial<Machine.Offer> = {}): Machine.Offer {
  return { machineId: "w-1", daemonVersion: "test", platform: "linux-x64", offeredCapabilities: ["kernel.py"], offeredAt: 2, ...changes };
}
const resources: Machine.Resources = { cpus: 4, memoryBytes: 8 * 1024 ** 3 };
const probe = {
  resources: () => resources,
  load: () => ({ loadAvg1: 0.25, memoryAvailableBytes: 1024 }),
};

describe("machine.report heartbeat", () => {
  test("a reporting daemon probes its resources, beats on the injected cadence, and the host projects live load with host-clock staleness", async () => {
    const collector = eventCollector();
    let hostNow = 100;
    const host = await createMachineHost({ listen: { unix: socketPath() }, enrollment: () => enrollment, events: collector.sink, now: () => hostNow, staleAfterMs: 1000 });
    const clock = fakeScheduler();
    let daemonNow = 10;
    const firstBeat = clock.nextScheduled();
    const daemon = await attachMachineDaemon({
      socketPath: host.endpoints.unix ?? "",
      offer: offer(),
      report: { scheduler: clock, now: () => daemonNow, intervalMs: 2000, probe },
    });
    try {
      expect(daemon.attachment.status).toBe("attached");
      expect(host.list()).toMatchObject([{ machineId: "w-1", resources, os: "linux", arch: "x64" }]);
      expect(host.list()[0]?.live).toBeUndefined();

      // The first beat is scheduled at once; the next waits one interval after acceptance.
      const first = await firstBeat;
      expect(first.delay).toBe(0);
      const reported = collector.next("machine.reported");
      const secondBeat = clock.nextScheduled();
      first.task();
      expect((await reported).payload).toEqual({ machineId: "w-1", time: 10, load: { loadAvg1: 0.25, memoryAvailableBytes: 1024, inFlight: 0 } });
      expect((await secondBeat).delay).toBe(2000);
      expect(host.list()[0]?.live).toEqual({ reportedAt: 10, load: { loadAvg1: 0.25, memoryAvailableBytes: 1024, inFlight: 0 }, stale: false });

      // Staleness is the host clock's call: past staleAfterMs since receipt.
      hostNow = 1100;
      expect(host.list()[0]?.live?.stale).toBe(false);
      hostNow = 1101;
      expect(host.list()[0]?.live?.stale).toBe(true);

      daemonNow = 20;
      const second = clock.entries[1];
      const thirdBeat = clock.nextScheduled();
      second?.task();
      expect((await thirdBeat).delay).toBe(2000);
      expect(host.list()[0]?.live).toEqual({ reportedAt: 20, load: { loadAvg1: 0.25, memoryAvailableBytes: 1024, inFlight: 0 }, stale: false });
      expect(clock.entries).toHaveLength(3);
    } finally {
      await daemon.close();
      // Closing cancels the pending beat; nothing is scheduled afterwards.
      expect(clock.entries.at(-1)?.cancelled).toBe(true);
      await host.close();
    }
  });

  test("a configured resources block wins over the probe, a sub-second cadence is raised to the floor, and a daemon without report wiring offers none", async () => {
    const host = await createMachineHost({ listen: { unix: socketPath() }, enrollment: () => enrollment, events: { publish: () => undefined }, now: () => 0 });
    const configured = { cpus: 2, memoryBytes: 1024 };
    const clock = fakeScheduler();
    const firstBeat = clock.nextScheduled();
    const reporting = await attachMachineDaemon({ socketPath: host.endpoints.unix ?? "", offer: offer({ resources: configured }), report: { scheduler: clock, now: () => 0, intervalMs: 10, probe } });
    try {
      expect(host.list()[0]?.resources).toEqual(configured);
      const nextBeat = clock.nextScheduled();
      (await firstBeat).task();
      expect((await nextBeat).delay).toBe(1000);
    } finally {
      await reporting.close();
    }
    const silent = await attachMachineDaemon({ socketPath: host.endpoints.unix ?? "", offer: offer() });
    try {
      expect(host.list()[0]?.resources).toBeUndefined();
      expect(host.list()[0]?.live).toBeUndefined();
    } finally {
      await silent.close();
      await host.close();
    }
  });

  test("the host refuses a report from an unattached connection or for another machine and keeps nothing", async () => {
    const collector = eventCollector();
    const host = await createMachineHost({ listen: { unix: socketPath() }, enrollment: () => enrollment, events: collector.sink, now: () => 0 });
    const path = host.endpoints.unix ?? "";
    const load = { loadAvg1: 0, memoryAvailableBytes: 0, inFlight: 0 };
    const stranger = await connectIpcClient(path);
    const report = (machineId: string) => stranger.call(Machine.WireMethod.Report, { machineId, reportedAt: 1, load });
    try {
      expect(await report("w-1")).toEqual({ status: "refused", reason: "machine_not_attached" });
      expect(await stranger.call(Machine.WireMethod.Attach, offer())).toMatchObject({ status: "attached" });
      expect(await report("w-2")).toEqual({ status: "refused", reason: "machine_mismatch" });
      expect(host.list()[0]?.live).toBeUndefined();
      expect(collector.events.map((event) => event.name)).toEqual(["machine.attached"]);
      expect(await report("w-1")).toEqual({ status: "accepted" });
      expect(host.list()[0]?.live).toEqual({ reportedAt: 1, load, stale: false });
    } finally {
      await stranger.close();
      await host.close();
    }
  });

  test("a report the host refuses ends the cadence until the next attach", async () => {
    const hostPath = socketPath();
    const host = await createMachineHost({ listen: { unix: hostPath }, enrollment: () => enrollment, events: { publish: () => undefined }, now: () => 0 });
    const clock = fakeScheduler();
    const firstBeat = clock.nextScheduled();
    const daemon = await attachMachineDaemon({ socketPath: hostPath, offer: offer(), report: { scheduler: clock, now: () => 0, probe } });
    try {
      const first = await firstBeat;
      // Supersede the attachment from another connection: the first connection's beat is now unattached.
      const usurper = await attachMachineDaemon({ socketPath: hostPath, offer: offer() });
      try {
        first.task();
        // The refused beat schedules nothing; the daemon's close is the only later cancellation.
        await daemon.closed;
      } finally {
        await usurper.close();
      }
      expect(clock.entries).toHaveLength(1);
    } finally {
      await daemon.close();
      await host.close();
    }
  });
});
