import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlainObjectSchema } from "@oni/protocol";
import { z } from "zod";
import { withPeerLeaseReceipts } from "../src/peer-lease-receipts";
import { testPlane } from "./helpers/ledger";
import { createMachineHost } from "../../../packages/machines/test/helpers/native";
import { eventCollector } from "../../../packages/machines/test/helpers/events";

const Row = z.object({ lease_id: z.string(), kind: z.string(), data: z.string() });
const request = { from: "worker-1", to: "self", ops: ["exec" as const], ttlMs: 1_000, delegationId: "delegation-1" };

test("every peer lease fact is a catalog row before it is a bus event, and the rows outlive the host (#1841 r1 H2)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "peer-lease-receipts-"));
  const plane = testPlane();
  const events = eventCollector();
  let now = 5;
  const host = await createMachineHost({
    listen: { unix: join(directory, "host.sock") },
    enrollment: () => undefined,
    events: withPeerLeaseReceipts(events.sink, plane.stores.recordPeerLease),
    now: () => now,
    id: () => "lease-1",
  });
  try {
    const lease = host.peers.issue(request);
    now = 6;
    expect(host.peers.peerLease("worker-1", "self", "exec")).toEqual(lease);
    expect(host.peers.peerLease("worker-1", "self", "fs")).toBeUndefined();
    now = 7;
    expect(host.peers.revoke(lease.id)).toEqual(lease);
    expect(events.events.map((event) => event.name)).toEqual([
      "machine.peer_lease_issued",
      "machine.peer_lease_used",
      "machine.peer_lease_ended",
    ]);
  } finally {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
  const rows = Row.array()
    .parse(plane.catalogDatabase.query("SELECT lease_id, kind, data FROM peer_lease_receipt ORDER BY seq").all())
    .map((row) => ({ leaseId: row.lease_id, kind: row.kind, data: PlainObjectSchema.parse(JSON.parse(row.data)) }));
  plane.close();
  expect(rows).toEqual([
    { leaseId: "lease-1", kind: "issued", data: { kind: "issued", machineId: "worker-1", time: 5, lease: { ...request, id: "lease-1", expiresAt: 1_005 } } },
    { leaseId: "lease-1", kind: "used", data: { kind: "used", machineId: "worker-1", time: 6, leaseId: "lease-1", to: "self", op: "exec" } },
    { leaseId: "lease-1", kind: "ended", data: { kind: "ended", machineId: "worker-1", time: 7, leaseId: "lease-1", to: "self", reason: "revoked" } },
  ]);
});

test("a refused receipt write issues no lease and publishes no event (#1841 r1 H2)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "peer-lease-receipts-refused-"));
  const events = eventCollector();
  const host = await createMachineHost({
    listen: { unix: join(directory, "host.sock") },
    enrollment: () => undefined,
    events: withPeerLeaseReceipts(events.sink, () => {
      throw new Error("catalog is read-only");
    }),
    now: () => 5,
  });
  try {
    expect(() => host.peers.issue(request)).toThrow("catalog is read-only");
    expect(host.peers.list()).toEqual([]);
    expect(host.peers.peerTargets("worker-1")).toEqual([]);
    expect(events.events).toEqual([]);
  } finally {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
