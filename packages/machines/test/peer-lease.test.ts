import { beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { Machine } from "@oni/protocol";
import { createPeerLeases } from "../src/peer-lease";
import { MachineRefusalError } from "../src/errors";
import { createMachineHost } from "./helpers/native";
import { eventCollector } from "./helpers/events";
import { attachMclient, mclientBinary } from "./helpers/mclient";
import { socketPath } from "./helpers/socket-path";

beforeAll(mclientBinary, 300_000);

function store(options: { scheduler?: boolean } = {}) {
  let now = 100;
  let n = 0;
  const pending: Array<() => void> = [];
  const events = eventCollector();
  const leases = createPeerLeases({
    id: () => {
      n += 1;
      return `lease-${n}`;
    },
    now: () => now,
    events: events.sink,
    ...(options.scheduler === false
      ? {}
      : {
          scheduler: {
            schedule(_delay: number, task: () => void) {
              pending.push(task);
              return () => undefined;
            },
          },
        }),
  });
  const receipts = () => events.events.map((event) => ({ name: event.name, ...event.payload }));
  return {
    leases,
    receipts,
    pending,
    tick: (to: number) => {
      now = to;
    },
  };
}
const request = {
  from: "A",
  to: "B",
  ops: ["exec", "fs"] as Machine.PeerLeaseOp[],
  ttlMs: 50,
  delegationId: "d-1",
};

test("issue journals the lease, use journals each routed op class and the scheduled expiry journals the end", async () => {
  const { leases, receipts, pending, tick } = store();
  const lease = leases.issue(request);
  expect(lease).toEqual({ id: "lease-1", expiresAt: 150, ...request });
  expect(leases.list()).toEqual([lease]);
  expect(leases.peerTargets("A")).toEqual(["B"]);
  expect(leases.peerTargets("B")).toEqual([]);
  expect(leases.peerLease("A", "B", "exec")).toEqual(lease);
  expect(leases.peerLease("A", "B", "pty")).toBeUndefined();
  expect(leases.peerLease("B", "A", "exec")).toBeUndefined();
  tick(120);
  for (const task of pending.splice(0)) task();
  expect(leases.list()).toEqual([lease]);
  tick(150);
  for (const task of pending.splice(0)) task();
  expect(leases.list()).toEqual([]);
  expect(leases.peerLease("A", "B", "exec")).toBeUndefined();
  expect(receipts()).toEqual([
    { name: "machine.peer_lease_issued", machineId: "A", time: 100, lease },
    {
      name: "machine.peer_lease_used",
      machineId: "A",
      time: 100,
      leaseId: "lease-1",
      to: "B",
      op: "exec",
    },
    {
      name: "machine.peer_lease_ended",
      machineId: "A",
      time: 150,
      leaseId: "lease-1",
      to: "B",
      reason: "expired",
    },
  ]);
  for (const task of pending.splice(0)) task();
  expect(receipts()).toHaveLength(3);
});

test("without a scheduler an expired lease still ends, exactly once, when the store is next read", () => {
  const { leases, receipts, tick } = store({ scheduler: false });
  leases.issue(request);
  tick(150);
  expect(leases.peerTargets("A")).toEqual([]);
  expect(leases.revoke("lease-1")).toBeUndefined();
  expect(receipts().map((event) => event.name)).toEqual([
    "machine.peer_lease_issued",
    "machine.peer_lease_ended",
  ]);
});

test("revoke ends a live lease with a revoked receipt and a later scheduled expiry is a no-op", () => {
  const { leases, receipts, pending } = store();
  const lease = leases.issue(request);
  expect(leases.revoke("missing")).toBeUndefined();
  expect(leases.revoke(lease.id)).toEqual(lease);
  expect(leases.revoke(lease.id)).toBeUndefined();
  for (const task of pending.splice(0)) task();
  expect(receipts().slice(1)).toEqual([
    {
      name: "machine.peer_lease_ended",
      machineId: "A",
      time: 100,
      leaseId: "lease-1",
      to: "B",
      reason: "revoked",
    },
  ]);
});

test("issue refuses a self lease and a record the contract rejects as peer_lease_invalid", () => {
  const { leases, receipts } = store();
  expect(() => leases.issue({ ...request, to: "A" })).toThrow(
    new MachineRefusalError({
      reason: "peer_lease_invalid",
      message: "peer_lease_invalid: a machine needs no lease to itself",
    }),
  );
  const invalid = (() => {
    try {
      leases.issue({ ...request, ttlMs: 0, ops: [] });
      return undefined;
    } catch (error) {
      return error;
    }
  })();
  expect(invalid).toBeInstanceOf(MachineRefusalError);
  expect(invalid).toMatchObject({
    reason: "peer_lease_invalid",
    message: expect.stringContaining("peer_lease_invalid: "),
  });
  expect(leases.list()).toEqual([]);
  expect(receipts()).toEqual([]);
});

test("the host attributes a cell's tool call to the attachment that delivered it", async () => {
  const events = eventCollector();
  const calls: Machine.ToolCall[] = [];
  const host = await createMachineHost({
    listen: { unix: socketPath() },
    enrollment: (id) => ({
      machineId: id,
      name: id,
      allowedCapabilities: ["kernel.py"],
      publicKey: "0".repeat(64),
      enrolledAt: 1,
    }),
    events: events.sink,
    now: () => 7,
    callTool: async (call) => {
      calls.push(call);
      return { status: "completed", value: "stamped" };
    },
  });
  const client = await attachMclient({
    host,
    events,
    machineId: "m-1",
    root: tmpdir(),
    exports: [],
  });
  try {
    expect(
      await host
        .get("m-1")
        .runCode({ cellId: "probe", code: "tool.probe(x=1)", timeoutMs: 15_000 }),
    ).toMatchObject({ status: "completed" });
    expect(calls).toEqual([
      {
        cellId: "probe",
        name: "probe",
        arguments: { x: 1 },
        source: { kind: "machine", machineId: "m-1" },
      },
    ]);
    expect(host.peers.list()).toEqual([]);
  } finally {
    await client.stop();
    await host.close();
  }
});
