import { beforeAll, expect, test } from "bun:test";
import { Machine } from "@oni/protocol";
import { createMachineHost } from "./helpers/native";
import { attachMclient, mclientBinary, mclientEnrollment } from "./helpers/mclient";
import { connectIpcClient } from "./ipc/helpers/native";
import { socketPath } from "./helpers/socket-path";
import { eventCollector } from "./helpers/events";
import { captureError, within } from "./ipc/helpers/signal";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeAll(mclientBinary, 300_000);

test("enrollment removal fails in-flight calls once while another real client remains attached", async () => {
  const root = mkdtempSync(join(tmpdir(), "oni-enrollment-"));
  const events = eventCollector();
  const worker = mclientEnrollment("worker", { allowedCapabilities: ["kernel.py"] });
  const records = new Map([["worker", worker], ["other", mclientEnrollment("other")]]);
  const host = await createMachineHost({
    listen: { unix: socketPath() }, enrollment: (id) => records.get(id), events: events.sink, now: () => 10,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const peer = await connectIpcClient(host.endpoints.unix ?? "", {
    onRequest: async (method, params, respond) => {
      if (method !== Machine.WireMethod.RunCode) throw new Error(`unexpected peer request: ${method}`);
      const request = Machine.CellRequest.parse(params);
      entered.resolve();
      await release.promise;
      respond({ status: "completed", cellId: request.cellId, output: { stdout: "", stderr: "" } });
    },
  });
  const attached = await peer.call(Machine.WireMethod.Attach, {
    machineId: "worker", daemonVersion: "simulated", platform: "darwin-arm64", offeredCapabilities: ["kernel.py"],
    offeredAt: 1, peer: { kind: "client", contractVersion: Machine.contractVersion },
  });
  expect(attached).toMatchObject({ status: "attached" });
  const other = await attachMclient({ host, events, machineId: "other", root });
  try {
    const reported = events.next(Machine.Events.Reported.name);
    expect(await peer.call(Machine.WireMethod.Report, {
      machineId: "worker", reportedAt: 1,
      screen: {
        verdict: "unavailable", blockers: [{ kind: "no_screen_backend" }],
        display: { kind: "none", isolated: false },
        grants: { capture: false, accessibility: false, input: false },
      },
      load: { loadAvg1: 0.5, memoryAvailableBytes: 4096, inFlight: 0 },
    })).toEqual({ status: "accepted" });
    await within(reported, "worker report");
    expect(host.list().find((row) => row.machineId === "worker")?.live?.stale).toBe(false);
    const pending = captureError(host.get("worker").runCode({ cellId: "held", code: "x", timeoutMs: 60_000 }));
    await within(entered.promise, "peer entered");
    const detached = events.next(Machine.Events.Detached.name);
    records.delete("worker");
    host.native.unenroll("worker");
    expect((await within(detached, "revocation")).payload).toMatchObject({ reason: "enrollment_removed" });
    expect(await within(pending, "pending disconnect")).toMatchObject({ reason: "disconnected" });
    expect(host.list().map((row) => row.machineId)).toEqual(["other"]);
    host.native.unenroll("worker");
    expect(events.events.filter((event) => event.name === Machine.Events.Detached.name)).toHaveLength(1);
    records.set("worker", worker);
    const replacement = await attachMclient({ host, events, machineId: "worker", root, exports: [] });
    try {
      expect(host.list().find((row) => row.machineId === "worker")).toMatchObject({
        generation: 2, peer: { kind: "client" },
      });
    } finally { await replacement.stop(); }
  } finally {
    release.resolve();
    await peer.close();
    await other.stop();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
