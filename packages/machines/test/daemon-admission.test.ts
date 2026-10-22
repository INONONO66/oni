import { describe, expect, test } from "bun:test";
import { Machine } from "@oni/protocol";
import { attachMachineDaemon } from "./helpers/native";
import { createIpcServer } from "./ipc/helpers/native";
import { captureError, deferred, within } from "./ipc/helpers/signal";
import { socketPath } from "./helpers/socket-path";

const offer = {
  machineId: "m-1",
  daemonVersion: "test",
  platform: "darwin-arm64",
  offeredCapabilities: [],
  offeredAt: 1,
};
const admitted: Machine.AttachResult = {
  status: "attached",
  generation: 7,
  effectiveCapabilities: [],
  effectiveExports: [],
};

function scheduler() {
  const entries: Array<{ readonly task: () => void; cancelled: boolean }> = [];
  const scheduled = deferred();
  return {
    entries,
    scheduled: scheduled.promise,
    schedule(_delay: number, task: () => void) {
      const entry = { task, cancelled: false };
      entries.push(entry);
      scheduled.resolve();
      return () => { entry.cancelled = true; };
    },
  };
}

describe("daemon admission generation", () => {
  test("first offer identifies the daemon and reconnect presents the last accepted generation", async () => {
    const offers: Machine.Offer[] = [];
    const second = deferred();
    let connectionId = "";
    const server = await createIpcServer(socketPath(), (method, params, respond, _notify, id) => {
      expect(method).toBe(Machine.WireMethod.Attach);
      connectionId = id;
      offers.push(Machine.Offer.parse(params));
      respond(admitted);
      if (offers.length === 2) second.resolve();
    });
    const clock = scheduler();
    const daemon = await attachMachineDaemon({
      socketPath: server.socketPath,
      offer,
      reconnect: { scheduler: clock, random: () => 0 },
    });
    try {
      expect(daemon.attachment).toEqual(admitted);
      expect(offers).toEqual([{ ...offer, peer: { kind: "daemon", contractVersion: 2 } }]);

      server.native.disconnect(connectionId);
      await within(clock.scheduled, "reconnect schedule");
      clock.entries[0]?.task();
      await within(second.promise, "reconnect offer");
      expect(offers[1]).toEqual({ ...offer, peer: { kind: "daemon", contractVersion: 2 }, generation: 7 });
      expect(daemon.attachment).toEqual(admitted);
    } finally {
      await daemon.close();
      await server.close();
    }
  });

  for (const reason of ["stale_generation", "unsupported_contract"] as const) {
    test(`${reason} on reconnect closes with a typed admission failure and schedules no retry`, async () => {
      let connectionId = "";
      let attempts = 0;
      const server = await createIpcServer(socketPath(), (method, _params, respond, _notify, id) => {
        expect(method).toBe(Machine.WireMethod.Attach);
        connectionId = id;
        attempts += 1;
        respond(attempts === 1 ? admitted : { status: "refused", reason });
      });
      const clock = scheduler();
      const daemon = await attachMachineDaemon({
        socketPath: server.socketPath,
        offer,
        reconnect: { scheduler: clock, random: () => 0 },
      });
      try {
        const closed = captureError(daemon.closed);
        server.native.disconnect(connectionId);
        await within(clock.scheduled, "reconnect schedule");
        clock.entries[0]?.task();
        expect(await within(closed, "terminal admission failure")).toMatchObject({
          _tag: "MachinesFailure",
          operation: "daemon.attach",
          cause: reason,
        });
        expect(daemon.attachment).toEqual({ status: "refused", reason });
        expect(attempts).toBe(2);
        expect(clock.entries).toHaveLength(1);
      } finally {
        await daemon.close();
        await server.close();
      }
    });

    test(`${reason} on first attach fails with a typed admission error`, async () => {
      const server = await createIpcServer(socketPath(), (_method, _params, respond) => {
        respond({ status: "refused", reason });
      });
      try {
        expect(await captureError(attachMachineDaemon({ socketPath: server.socketPath, offer }))).toMatchObject({
          _tag: "MachinesFailure",
          operation: "daemon.attach",
          cause: reason,
        });
      } finally {
        await server.close();
      }
    });
  }

  test("other initial refusals remain inspectable as attachment results", async () => {
    const server = await createIpcServer(socketPath(), (_method, _params, respond) => {
      respond({ status: "refused", reason: "machine_not_enrolled" });
    });
    const daemon = await attachMachineDaemon({ socketPath: server.socketPath, offer });
    try {
      expect(daemon.attachment).toEqual({ status: "refused", reason: "machine_not_enrolled" });
    } finally {
      await daemon.close();
      await server.close();
    }
  });
});
