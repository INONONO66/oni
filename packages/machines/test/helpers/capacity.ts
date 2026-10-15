import { Machine } from "@openomni/protocol";
import { createMachineHost } from "./native";
import { eventCollector } from "./events";
import { socketPath } from "./socket-path";
import { connectIpcClient } from "../ipc/helpers/native";

function clock() {
  let now = 0;
  let cancelled: (() => void) | undefined;
  const entries: Array<{ at: number; delay: number; task: () => void; cancelled: boolean }> = [];
  return {
    entries,
    now: () => now,
    onCancel(callback: () => void) { cancelled = callback; },
    schedule(delay: number, task: () => void) {
      const entry = { at: now + delay, delay, task, cancelled: false };
      entries.push(entry);
      return () => {
        if (entry.cancelled) return;
        entry.cancelled = true;
        const callback = cancelled;
        cancelled = undefined;
        callback?.();
      };
    },
    advance(ms: number) {
      now += ms;
      for (const entry of entries) {
        if (!entry.cancelled && entry.at <= now) { entry.cancelled = true; entry.task(); }
      }
    },
  };
}
export const request: Machine.PlacementRequest = { tag: "worker", prefer: "spread" };
const resources = { cpus: 2, memoryBytes: 1024 ** 3 };
export async function fixture(capacity?: Machine.CapacityRow[], offered: Machine.Resources | null = resources) {
  const time = clock();
  const events = eventCollector();
  const host = await createMachineHost({
    listen: { unix: socketPath() }, now: time.now, scheduler: time, idleTtlMs: 10, staleAfterMs: 20,
    capacity, events: events.sink,
    enrollment: (machineId) => ({
      machineId, name: machineId, tags: ["worker"], allowedCapabilities: ["shell.exec"],
      publicKey: "0".repeat(64), enrolledAt: 0,
    }),
  });
  const clients: Array<Awaited<ReturnType<typeof connectIpcClient>>> = [];
  async function attach(machineId: string, offeredResources = offered) {
    const client = await connectIpcClient(host.endpoints.unix ?? "");
    clients.push(client);
    await client.call(Machine.WireMethod.Attach, {
      machineId, daemonVersion: "test", platform: "linux-arm64", offeredAt: 0,
      offeredCapabilities: ["shell.exec"], ...(offeredResources === null ? {} : { resources: offeredResources }),
    });
    return client;
  }
  const client = await attach("w");
  return {
    host, time, events, attach,
    report: (memoryAvailableBytes: number) => client.call(Machine.WireMethod.Report, {
      machineId: "w", reportedAt: time.now(), load: { loadAvg1: 0, inFlight: 0, memoryAvailableBytes },
    }),
    async close() { for (const peer of clients) await peer.close(); await host.close(); },
  };
}
export function pick(host: Awaited<ReturnType<typeof fixture>>["host"], workClass?: "job") {
  const outcome = host.place(request, workClass);
  if (outcome.kind !== "placed") throw new Error(`expected placed, got ${outcome.kind}`);
  return outcome.lease;
}
