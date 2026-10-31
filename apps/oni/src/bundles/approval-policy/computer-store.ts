import { Core } from "@oni/agent";
import { Machine } from "@oni/protocol";
import { z } from "zod";

type PauseReason = Extract<Machine.ComputerLease, { state: "paused" }>["pauseReason"];
type EndReason = Extract<Machine.ComputerLease, { state: "ended" }>["endReason"];
const LEASE = "computer_use.lease";
const EXCLUSION = "computer_use.exclusion";
const HUMAN_QUIET = "computer_use.humanQuietMs";
const MAX_WAIT = "computer_use.maxWaitMs";
const key = (sessionId: string, machineId: string) => JSON.stringify([sessionId, machineId]);

export function computerStore(rows: Core.LedgerHost["policyState"]) {
  function get(sessionId: string, machineId: string): Machine.ComputerLease | undefined {
    const row = rows.get(LEASE, key(sessionId, machineId));
    return row === undefined ? undefined : Machine.ComputerLease.parse(row.value);
  }
  function put(lease: Machine.ComputerLease): Machine.ComputerLease {
    const value = Machine.ComputerLease.parse(lease);
    if (!rows.put(LEASE, { key: key(value.sessionId, value.machineId), revision: value.revision - 1, value }))
      throw new Core.ToolRefused("provision", "computer lease revision changed");
    return value;
  }
  function active(lease: Machine.ComputerLease) {
    const { sessionId, machineId, apps, expiresAt, foreground, revision } = lease;
    return { sessionId, machineId, apps, expiresAt, ...(foreground === undefined ? {} : { foreground }), revision: revision + 1 };
  }
  return {
    get,
    put,
    humanQuietMs: () => z.number().int().positive().parse(rows.get(HUMAN_QUIET, "default")?.value ?? 5000),
    maxWaitMs: () => z.number().int().positive().parse(rows.get(MAX_WAIT, "default")?.value ?? 20000),
    list: () => rows.list(LEASE).map((row) => Machine.ComputerLease.parse(row.value)),
    pause(sessionId: string, machineId: string, pauseReason: PauseReason) {
      const lease = get(sessionId, machineId);
      if (lease === undefined || lease.state === "ended" || (lease.state === "paused" && lease.pauseReason === pauseReason)) return lease;
      return put({ ...active(lease), state: "paused", pauseReason });
    },
    resume(sessionId: string, machineId: string) {
      const lease = get(sessionId, machineId);
      return lease?.state === "paused" ? put({ ...active(lease), state: "active" }) : lease;
    },
    end(sessionId: string, machineId: string, endReason: EndReason) {
      const lease = get(sessionId, machineId);
      return lease === undefined || lease.state === "ended" ? lease : put({ ...active(lease), state: "ended", endReason });
    },
    exclusions: () => rows.list(EXCLUSION).map((row) => Machine.ComputerExclusion.parse(row.value)),
    exclude(value: Machine.ComputerExclusion) {
      const address = key(value.machineId, value.app);
      const prior = rows.get(EXCLUSION, address);
      if (prior === undefined) rows.put(EXCLUSION, { key: address, revision: 0, value });
      return value;
    },
  };
}
export type ComputerStore = ReturnType<typeof computerStore>;
