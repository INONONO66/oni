import { beforeAll, expect, test } from "bun:test";
import net from "node:net";
import { tmpdir } from "node:os";
import { Ipc, Machine } from "@oni/protocol";
import { createMachineHost } from "./helpers/native";
import { createMemoryGenerationStore } from "../src";
import { run } from "./ipc/helpers/effects";
import { attachMclient, mclientBinary } from "./helpers/mclient";
import { eventCollector } from "./helpers/events";
import { startProxy } from "./helpers/proxy";
import { socketPath } from "./helpers/socket-path";
import { captureError, within } from "./ipc/helpers/signal";

beforeAll(mclientBinary, 300_000);

test("drop fails pending once, reconnect preserves the handle, and stale generation keeps the service available", async () => {
  const events = eventCollector();
  const generations = createMemoryGenerationStore();
  const host = await createMachineHost({
    listen: { unix: socketPath() },
    generations,
    enrollment: (id) => ({
      machineId: id, name: id, allowedCapabilities: ["kernel.py"],
      publicKey: "0".repeat(64), enrolledAt: 1,
    }),
    events: events.sink, now: () => Date.now(),
    callTool: async () => {
      entered.resolve();
      await release.promise;
      return { status: "completed", value: "released" };
    },
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const proxyPath = socketPath();
  const reoffer = Promise.withResolvers<void>();
  let stale = false;
  const proxy = await startProxy(proxyPath, () => net.connect(host.endpoints.unix ?? ""), (line) => {
    const frame = Ipc.Request.safeParse(JSON.parse(line));
    if (stale && frame.success && frame.data.method === Machine.WireMethod.Attach) reoffer.resolve();
    return false;
  });
  const client = await attachMclient({ host, events, machineId: "m-1", root: tmpdir(), exports: [], unix: proxyPath });
  try {
    const handle = host.get("m-1");
    const pending = captureError(handle.runCode({ cellId: "orphan", code: "tool.block()", timeoutMs: 15_000 }));
    await within(entered.promise, "real client tool callback", 5_000);
    const detached = events.next(Machine.Events.Detached.name);
    const attached = events.next(Machine.Events.Attached.name);
    const reported = events.next(Machine.Events.Reported.name);
    proxy.sever();
    expect(await within(pending, "disconnected cell", 5_000)).toMatchObject({ _tag: "MachineRefusalError", reason: "disconnected" });
    await within(detached, "host detach", 5_000);
    expect(await captureError(handle.runCode({ cellId: "window", code: "1", timeoutMs: 1_000 })))
      .toMatchObject({ _tag: "MachineRefusalError", reason: "disconnected" });
    release.resolve();
    await within(attached, "replacement attach", 5_000);
    await within(reported, "replacement report", 5_000);
    expect(await handle.runCode({ cellId: "fresh", code: "'fresh'", timeoutMs: 5_000 }))
      .toMatchObject({ status: "completed", value: "'fresh'" });

    expect(await run(generations.compareAndSet("m-1", 1, 2))).toBe(true);
    const lost = events.next(Machine.Events.Detached.name);
    stale = true;
    proxy.sever();
    await within(lost, "terminal detach", 5_000);
    await within(Promise.race([
      reoffer.promise,
      client.exited.then(() => { throw new Error("service exited after stale generation"); }),
    ]), "stale-generation re-probe", 5_000);
    expect(host.list()).toEqual([]);
  } finally {
    release.resolve();
    await client.stop();
    await proxy.stop();
    await host.close();
  }
});
