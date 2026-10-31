import { expect, test } from "bun:test";
import { type Ipc, Machine } from "@oni/protocol";
import type { ComputerHandle } from "../src";
import { createMachineHost } from "./helpers/native";
import { eventCollector } from "./helpers/events";
import { socketPath } from "./helpers/socket-path";
import { run } from "./ipc/helpers/effects";
import { connectIpcClient } from "./ipc/helpers/native";

async function forwarded(request: Parameters<ComputerHandle["pointer"]>[0]) {
  for (const contractVersion of [3, 4]) {
    const events = eventCollector();
    const host = await createMachineHost({
      listen: { unix: socketPath() }, events: events.sink, now: () => 0,
      enrollment: (machineId) => ({
        machineId, name: machineId, publicKey: "0".repeat(64), enrolledAt: 0,
        allowedCapabilities: [Machine.WellKnownCapability.computerUse],
      }),
      captureInput: (_request, forward) => forward,
    });
    const received: Array<{ method: string; params: Ipc.Request["params"] }> = [];
    const peer = await connectIpcClient(host.endpoints.unix ?? "", {
      onRequest: (method, params, respond) => {
        received.push({ method, params });
        respond({ status: "ok" });
      },
    });
    try {
      const attached = events.next(Machine.Events.Attached.name);
      expect(await peer.call(Machine.WireMethod.Attach, {
        machineId: "desk", daemonVersion: "test", platform: "linux-arm64", offeredAt: 0,
        peer: { kind: "client", contractVersion },
        offeredCapabilities: [Machine.WellKnownCapability.computerUse],
      })).toMatchObject({ status: "attached" });
      await attached;
      const computer = host.native.get("desk").computer;
      if (computer === undefined) throw new Error("missing attached computer");
      expect(await run(computer.pointer(request))).toEqual({ status: "ok" });
      expect(received).toEqual([{
        method: Machine.WireMethod.InputPointer,
        params: { ...request, requestId: "1-1" },
      }]);
    } finally {
      await peer.close();
      await host.close();
    }
  }
}

test("admitted peers retain the capture pointer form without legacy flattening", async () => {
  await forwarded({
    delivery: "foreground", kind: "click",
    at: { captureId: "cap-1", x: 10, y: 20 }, button: "left", count: 1,
  });
});

test("admitted peers retain the element pointer form they can observe", async () => {
  await forwarded({
    delivery: "foreground", kind: "move",
    at: { observationId: "o1", ref: "window[0]/button[2]" },
  });
});
