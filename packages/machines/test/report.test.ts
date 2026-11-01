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
import { Queue } from "effect";
import { run } from "./ipc/helpers/effects";
import v3Report from "../../protocol/fixtures/machine/report-v3.json";
import foldedReport from "../../protocol/fixtures/machine/valid/Report.v3-folded.json";

beforeAll(mclientBinary, 300_000);

describe("machine.report heartbeat", () => {
  test("ping request reaches an opted client and its reply keeps the attachment", async () => {
    const events = eventCollector();
    const ticks = await run(Queue.unbounded<void>());
    let now = 0;
    const host = await createMachineHost({
      listen: { unix: socketPath() }, enrollment: (id) => id === "w-1" ? mclientEnrollment(id) : undefined,
      events: events.sink, now: () => now, pingTick: Queue.take(ticks),
    });
    const ping = Promise.withResolvers<string>();
    const peer = await connectIpcClient(host.endpoints.unix ?? "", {
      onRequest: (method, _params, respond) => {
        ping.resolve(method);
        respond({ status: "alive" });
      },
    });
    try {
      expect(await peer.call(Machine.WireMethod.Attach, {
        machineId: "w-1", daemonVersion: "new-client", platform: "linux-arm64",
        offeredCapabilities: [], offeredAt: 1, capabilities: ["ping"],
        peer: { kind: "client", contractVersion: Machine.contractVersion },
      })).toMatchObject({ status: "attached" });
      await run(Queue.offer(ticks, undefined));
      expect(await ping.promise).toBe(Machine.WireMethod.Ping);
      now = 5_000;
      expect(host.list()).toHaveLength(1);
    } finally {
      await peer.close();
      await host.close();
    }
  });

  test("a slow valid ping reply keeps its own deadline despite later probe ticks", async () => {
    const events = eventCollector();
    const ticks = await run(Queue.unbounded<void>());
    let now = 0;
    const host = await createMachineHost({
      listen: { unix: socketPath() }, enrollment: (id) => id === "w-1" ? mclientEnrollment(id) : undefined,
      events: events.sink, now: () => now, pingTick: Queue.take(ticks),
    });
    const first = Promise.withResolvers<(result: { status: "alive" }) => void>();
    const second = Promise.withResolvers<void>();
    let count = 0;
    const peer = await connectIpcClient(host.endpoints.unix ?? "", {
      onRequest: (method, _params, respond) => {
        if (method !== Machine.WireMethod.Ping) return;
        count++;
        if (count === 1) first.resolve(respond);
        else { respond({ status: "alive" }); second.resolve(); }
      },
    });
    try {
      expect(await peer.call(Machine.WireMethod.Attach, {
        machineId: "w-1", daemonVersion: "new-client", platform: "linux-arm64",
        offeredCapabilities: [], offeredAt: 1, capabilities: ["ping"],
        peer: { kind: "client", contractVersion: Machine.contractVersion },
      })).toMatchObject({ status: "attached" });
      now = 5_000;
      await run(Queue.offer(ticks, undefined));
      const respond = await first.promise;
      now = 10_000;
      await run(Queue.offer(ticks, undefined));
      expect(count).toBe(1);
      now = 11_000;
      respond({ status: "alive" });
      expect(await peer.call(Machine.WireMethod.Report, {
        machineId: "w-1", reportedAt: 11_000,
        load: { loadAvg1: 0, memoryAvailableBytes: 0, inFlight: 0 },
      })).toEqual({ status: "accepted" });
      now = 15_000;
      await run(Queue.offer(ticks, undefined));
      await second.promise;
      expect(host.list()).toHaveLength(1);
    } finally {
      await peer.close();
      await host.close();
    }
  });

  test("ping is opt-in and a silent opted peer detaches after fifteen seconds", async () => {
    const events = eventCollector();
    const ticks = await run(Queue.unbounded<void>());
    let now = 0;
    const host = await createMachineHost({
      listen: { unix: socketPath() }, enrollment: (id) => id === "w-1" ? mclientEnrollment(id) : undefined,
      events: events.sink, now: () => now, pingTick: Queue.take(ticks),
    });
    const peer = await connectIpcClient(host.endpoints.unix ?? "");
    try {
      expect(await peer.call(Machine.WireMethod.Attach, {
        machineId: "w-1", daemonVersion: "old-client", platform: "linux-arm64",
        offeredCapabilities: [], offeredAt: 1,
        peer: { kind: "client", contractVersion: Machine.contractVersion },
      })).toMatchObject({ status: "attached" });
      await run(Queue.offer(ticks, undefined));
      expect(host.list()).toHaveLength(1);
      const superseded = events.next(Machine.Events.Detached.name);
      expect(await peer.call(Machine.WireMethod.Attach, {
        machineId: "w-1", daemonVersion: "new-client", platform: "linux-arm64",
        offeredCapabilities: [], offeredAt: 2, capabilities: ["ping"],
        peer: { kind: "client", contractVersion: Machine.contractVersion },
      })).toMatchObject({ status: "attached" });
      expect(await superseded).toMatchObject({ payload: { reason: "superseded" } });
      const detached = events.next(Machine.Events.Detached.name);
      now = 15_001;
      await run(Queue.offer(ticks, undefined));
      expect(await detached).toMatchObject({ payload: { reason: "ping_timeout" } });
      expect(host.list()).toEqual([]);
    } finally {
      await peer.close();
      await host.close();
    }
  });

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
        expect(first?.live?.screen?.display.isolated).toBe(false);
        expect(first?.live?.screen?.display.kind).toBe("console");
      } else {
        expect(first?.live?.screen?.grants.accessibility).toBe(false);
        expect(first?.live?.humanInput).toBeUndefined();
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

  test("the host folds v3 heartbeats and preserves live facts on malformed reports", async () => {
    const events = eventCollector();
    const host = await createMachineHost({
      listen: { unix: socketPath() }, enrollment: (id) => id === "w-1" ? mclientEnrollment(id) : undefined,
      events: events.sink, now: () => 0,
    });
    const peer = await connectIpcClient(host.endpoints.unix ?? "");
    const load = { loadAvg1: 0, memoryAvailableBytes: 0, inFlight: 0 };
    const screen = { verdict: "unavailable", blockers: [{ kind: "screen_recording_denied" }],
      needs: [{ step: "screen_recording_grant", action: "Open System Settings > Privacy & Security > Screen Recording.", onScreen: true, blocker: "screen_recording_denied" }],
      display: { kind: "console", isolated: false },
      grants: { capture: false, accessibility: false, input: false } } satisfies Machine.Screen;
    const report = (machineId: string) => peer.call(Machine.WireMethod.Report, { machineId, reportedAt: 1, load, screen });
    try {
      expect(await report("w-1")).toEqual({ status: "refused", reason: "machine_not_attached" });
      expect(await peer.call(Machine.WireMethod.Report, {
        machineId: "w-1", reportedAt: 1, load, screen: { permission: "denied" },
      })).toEqual({ status: "refused", reason: "machine_not_attached" });
      expect(await peer.call(Machine.WireMethod.Attach, {
        machineId: "w-1", daemonVersion: "simulated", platform: "darwin-arm64", offeredCapabilities: ["kernel.py"],
        offeredAt: 1, peer: { kind: "client", contractVersion: 3 },
      })).toMatchObject({ status: "attached" });
      expect(await peer.call(Machine.WireMethod.Report, { ...v3Report, machineId: "other" }))
        .toEqual({ status: "refused", reason: "machine_mismatch" });
      expect(host.list()[0]?.live).toBeUndefined();
      expect(await peer.call(Machine.WireMethod.Report, v3Report)).toEqual({ status: "accepted" });
      const { machineId: _machineId, streams: _streams, ...live } = Machine.Report.parse(foldedReport);
      expect(host.list()[0]?.live).toEqual({ ...live, stale: false });
      await expect(peer.call(Machine.WireMethod.Report, {
        ...v3Report, screen: { permission: "invalid" },
      })).rejects.toMatchObject({ _tag: "IpcRemoteError", method: Machine.WireMethod.Report, code: 1000, message: "IPC error 1000: invalid_report" });
      expect(host.list()[0]?.live).toEqual({ ...live, stale: false });
      await peer.close();
      const current = await connectIpcClient(host.endpoints.unix ?? "");
      try {
        expect(await current.call(Machine.WireMethod.Attach, {
          machineId: "w-1", daemonVersion: "simulated", platform: "darwin-arm64", offeredCapabilities: ["kernel.py"],
          offeredAt: 1, peer: { kind: "client", contractVersion: 4 },
        })).toMatchObject({ status: "attached" });
        expect(await current.call(Machine.WireMethod.Report, v3Report)).toEqual({ status: "refused", reason: "invalid_report" });
        expect(await current.call(Machine.WireMethod.Report, {
          machineId: "w-1", reportedAt: 2, load, screen, transport: { lastFailure: "timeout", attempts: 3 },
        }))
          .toEqual({ status: "accepted" });
        expect(host.list()[0]?.live?.transport).toEqual({ lastFailure: "timeout", attempts: 3 });
        expect(host.list()[0]?.live?.screen?.needs).toEqual(screen.needs);
      } finally {
        await current.close();
      }
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

  test("only the attached peer's human-input notification publishes a content-free event", async () => {
    const events = eventCollector();
    const host = await createMachineHost({
      listen: { unix: socketPath() }, enrollment: (id) => id === "w-1" ? mclientEnrollment(id) : undefined,
      events: events.sink, now: () => 300,
    });
    const peer = await connectIpcClient(host.endpoints.unix ?? "");
    const stranger = await connectIpcClient(host.endpoints.unix ?? "");
    try {
      expect(await peer.call(Machine.WireMethod.Attach, {
        machineId: "w-1", daemonVersion: "simulated", platform: "darwin-arm64",
        offeredCapabilities: ["kernel.py"], offeredAt: 1,
        peer: { kind: "client", contractVersion: Machine.contractVersion },
      })).toMatchObject({ status: "attached" });
      const load = { loadAvg1: 0, memoryAvailableBytes: 0, inFlight: 0 };
      await stranger.notify(Machine.WireMethod.EventHumanInput, { machineId: "w-1", at: 100, source: "keyboard" });
      expect(await stranger.call(Machine.WireMethod.Report, { machineId: "w-1", reportedAt: 1, load }))
        .toEqual({ status: "refused", reason: "machine_not_attached" });
      expect(events.events.filter((event) => event.name === Machine.Events.HumanInput.name)).toHaveLength(0);
      await peer.notify(Machine.WireMethod.EventHumanInput, { machineId: "wrong", at: 200, source: "keyboard" });
      expect(await peer.call(Machine.WireMethod.Report, { machineId: "wrong", reportedAt: 2, load }))
        .toEqual({ status: "refused", reason: "machine_mismatch" });
      expect(events.events.filter((event) => event.name === Machine.Events.HumanInput.name)).toHaveLength(0);
      const fact = { machineId: "w-1", at: 250, source: "pointer" } as const;
      const delivered = events.next(Machine.Events.HumanInput.name);
      await peer.notify(Machine.WireMethod.EventHumanInput, fact);
      expect((await delivered).payload).toEqual({ ...fact, time: 300 });
      expect(events.events.filter((event) => event.name === Machine.Events.HumanInput.name)).toHaveLength(1);
    } finally {
      await stranger.close();
      await peer.close();
      await host.close();
    }
  });
});
