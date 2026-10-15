import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine, ToolExecutionContext } from "@openomni/protocol";
import { createProvisionTool } from "../src/bundles/provision/provision";
import { machineEnrollments } from "../src/bundles/provision/machine-enrollment";
import { executeMachine, type MachinePort } from "../src/bundles/provision/machines";
import { machineWire } from "../src/composition/machine-wire";
import { provisionPort } from "./helpers/provision-port";
import { testPlane } from "./helpers/ledger";
import { bounded, protectedDispatch } from "./helpers/protected-dispatch";
import { attachMachineDaemon, createMachineHost } from "../../../packages/machines/test/helpers/native";
import { eventCollector } from "../../../packages/machines/test/helpers/events";

const enrollment: Machine.Enrollment = {
  machineId: "worker-1", name: "Worker", tags: ["pool"],
  allowedCapabilities: ["kernel.py"], publicKey: "a".repeat(64), enrolledAt: 1,
};
const { enrolledAt: _enrolledAt, ...args } = enrollment;
const add = { op: "machine_add", args } as const;
const context: ToolExecutionContext = {
  sessionId: "resident", turnId: "turn", callId: "call", signal: new AbortController().signal,
};

test("provision enrolls and attaches a daemon without restarting, then removes its live authority", async () => {
  const directory = mkdtempSync(join(tmpdir(), "machine-provision-"));
  const plane = testPlane();
  const events = eventCollector();
  const enrollments = machineEnrollments(plane.stores.instances);
  const socketPath = join(directory, "host.sock");
  const host = await createMachineHost({ listen: { unix: socketPath }, enrollment: enrollments.get, events: events.sink, now: () => 5 });
  const machines: MachinePort = { enrollments, host: host.native, selfId: "self", events: events.sink, now: () => 5 };
  const port = { ...provisionPort(plane), machines };
  const tool = createProvisionTool(port, () => 5);
  const dispatch = protectedDispatch(tool, { operation: add }, undefined, { plane });
  try {
    await bounded(dispatch.opened);
    expect(enrollments.get(enrollment.machineId)).toBeUndefined();
    const enrolled = events.next("machine.enrolled");
    expect((await dispatch.answer()).structuredContent).toMatchObject({ op: "machine_add", result: { enrollment: { machineId: args.machineId } } });
    expect((await bounded(enrolled)).payload).toMatchObject({ machineId: "worker-1", enrollment: { publicKey: args.publicKey } });
    const attached = events.next("machine.attached");
    const daemon = await attachMachineDaemon({
      socketPath,
      offer: { machineId: args.machineId, offeredCapabilities: ["kernel.py"], daemonVersion: "test", platform: "darwin-arm64", offeredAt: 2, resources: { cpus: 4, memoryBytes: 8192 } },
    });
    try {
      await bounded(attached);
      const result = await tool.execute({ operation: { op: "machine_list", args: {} } }, context);
      expect(result).toEqual({ op: "machine_list", result: { rows: host.list() } });
      expect(host.list()).toMatchObject([{ name: "Worker", tags: ["pool"], resources: { cpus: 4 } }]);
      expect(machineWire(JSON.stringify({ type: "machine_list", requestId: "rows" }), host.native))
        .toEqual({ type: "machine_listed", requestId: "rows", rows: host.list() });
      const detached = events.next("machine.detached");
      const unenrolled = events.next("machine.unenrolled");
      await tool.execute({ operation: { op: "machine_remove", args: { machineId: args.machineId } } }, context);
      expect((await bounded(detached)).payload).toEqual({ machineId: args.machineId, time: 5, reason: "enrollment_removed" });
      expect((await bounded(unenrolled)).payload).toEqual({ machineId: args.machineId, time: 5 });
      expect(host.list()).toEqual([]);
      await expect(host.get(args.machineId).peekCode("missing")).rejects.toMatchObject({ reason: "disconnected" });
    } finally { await daemon.close(); }
  } finally {
    await dispatch.close();
    await host.close();
    plane.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("removed boot seeds remain removed after reopening the provisioning store", () => {
  const directory = mkdtempSync(join(tmpdir(), "machine-seeds-"));
  const catalogPath = join(directory, "catalog.sqlite");
  const plane = testPlane({ catalogPath });
  const records = machineEnrollments(plane.stores.instances);
  records.seed([enrollment]);
  records.remove(enrollment.machineId, 2);
  plane.close();
  const reopened = testPlane({ catalogPath });
  try {
    const recovered = machineEnrollments(reopened.stores.instances);
    recovered.seed([enrollment]);
    expect(recovered.get(enrollment.machineId)).toBeUndefined();
    expect(Object.values(recovered.revisions(enrollment.machineId))).toEqual([1]);
    recovered.add({ ...enrollment, name: "Re-added" });
    expect(recovered.get(enrollment.machineId)?.name).toBe("Re-added");
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["approve", "refuse", "changed"] as const)("machine key consent is bound to the current revision: %s", async (decision) => {
  const plane = testPlane();
  const enrollments = machineEnrollments(plane.stores.instances);
  const machines: MachinePort = { enrollments, host: { list: () => [], unenroll: () => undefined }, selfId: "self", events: { publish: () => undefined }, now: () => 5 };
  const tool = createProvisionTool({ ...provisionPort(plane), machines }, () => 5);
  const dispatch = protectedDispatch(tool, { operation: add }, undefined, { plane });
  try {
    await bounded(dispatch.opened);
    if (decision === "changed") {
      executeMachine(machines, { ...add, args: { ...args, publicKey: "b".repeat(64) } }, "owner");
      await expect(dispatch.answer()).rejects.toMatchObject({ code: "stale_approval" });
      expect(enrollments.get(args.machineId)?.publicKey).toBe("b".repeat(64));
    } else {
      expect((await dispatch.answer(decision)).isError === true).toBe(decision === "refuse");
      expect(enrollments.get(args.machineId)?.publicKey).toBe(decision === "approve" ? args.publicKey : undefined);
    }
  } finally { await dispatch.close(); plane.close(); }
});

test("direct session calls never grant a key and stale consent cannot overwrite authority", async () => {
  const plane = testPlane();
  const enrollments = machineEnrollments(plane.stores.instances);
  const machines: MachinePort = { enrollments, host: { list: () => [], unenroll: () => undefined }, selfId: "self", events: { publish: () => undefined }, now: () => 5 };
  const tool = createProvisionTool({ ...provisionPort(plane), machines }, () => 5);
  try {
    expect(await tool.execute({ operation: add }, context)).toEqual({ op: "machine_add", result: { type: "require_approval", id: args.machineId } });
    expect(enrollments.get(args.machineId)).toBeUndefined();
    const revisions = enrollments.revisions(args.machineId);
    executeMachine(machines, add, "owner");
    await expect(tool.execute({ operation: add }, { ...context, domainRevisions: revisions })).rejects.toThrow("domain revision changed");
    expect(() => executeMachine(machines, { ...add, args: { ...args, machineId: "self" } }, "owner")).toThrow("self enrollment");
    expect(() => executeMachine(machines, { op: "machine_remove", args: { machineId: "missing" } }, "owner")).toThrow("not enrolled");
    expect(() => executeMachine(undefined, add, "owner")).toThrow("not composed");
  } finally { plane.close(); }
});

test("channel operations cannot replace or enable reserved machine declarations", async () => {
  const plane = testPlane();
  const port = provisionPort(plane);
  const enrollments = machineEnrollments(plane.stores.instances);
  enrollments.seed([enrollment]);
  const id = plane.stores.instances.list()[0]?.id;
  if (id === undefined) throw new Error("missing declaration");
  const tool = createProvisionTool(port, () => 5);
  try {
    await expect(tool.execute({ operation: { op: "channel_add", args: { id, provider: "telegram", enabled: true, settings: {} } } }, context))
      .rejects.toThrow("machine declarations require machine_add");
    await expect(tool.execute({ operation: { op: "channel_enable", args: { instanceId: id } } }, context))
      .rejects.toThrow("machine declarations require");
    expect(enrollments.get(args.machineId)).toEqual(enrollment);
  } finally { plane.close(); }
});
