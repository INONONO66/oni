import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Machine, type ToolExecutionContext } from "@oni/protocol";
import { createProvisionTool } from "../src/bundles/provision/provision";
import { executeMachine, machineDomainRevisions, type MachinePort } from "../src/bundles/provision/machines";
import { machineWire } from "../src/composition/machine-wire";
import { provisionPort } from "./helpers/provision-port";
import { testPlane } from "./helpers/ledger";
import { bounded, protectedDispatch } from "./helpers/protected-dispatch";
import { createMachineHost } from "../../../packages/machines/test/helpers/native";
import { attachMclient, mclientBinary } from "../../../packages/machines/test/helpers/mclient";
import { connectIpcTcpClient } from "../../../packages/machines/test/ipc/helpers/native";
import { eventCollector } from "../../../packages/machines/test/helpers/events";
import { captureError } from "../../../packages/machines/test/ipc/helpers/signal";
import { daemonIdentity, daemonFingerprint, hostIdentity, wrongIdentity, wrongFingerprint } from "../../../packages/machines/test/ipc/helpers/tls-fixtures";

const enrollment: Machine.Enrollment = {
  machineId: "worker-1", name: "Worker", tags: ["pool"],
  allowedCapabilities: ["kernel.py"], publicKey: "a".repeat(64), enrolledAt: 1,
};
const { enrolledAt: _enrolledAt, ...args } = enrollment;
const add = { op: "machine_add", args } as const;
const context: ToolExecutionContext = {
  sessionId: "resident", turnId: "turn", callId: "call", signal: new AbortController().signal,
};
beforeAll(mclientBinary, 300_000);

test("provision enrolls and attaches a daemon without restarting, then removes its live authority", async () => {
  const directory = mkdtempSync(join(tmpdir(), "machine-provision-"));
  const plane = testPlane();
  const events = eventCollector();
  const enrollments = plane.stores.machineEnrollments;
  const socketPath = join(directory, "host.sock");
  const host = await createMachineHost({
    listen: { unix: socketPath },
    enrollment: (id) => {
      const row = enrollments.get(id);
      return row?.removedAt === null ? row.enrollment : undefined;
    },
    events: events.sink, now: () => 5,
  });
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
    const daemon = await attachMclient({ host, events, machineId: args.machineId, root: directory, exports: [] });
    try {
      const result = await tool.execute({ operation: { op: "machine_list", args: {} } }, context);
      expect(result).toEqual({ op: "machine_list", result: { rows: host.list() } });
      expect(result).toMatchObject({ op: "machine_list", result: { rows: [{
        machineId: "worker-1",
        generation: 1,
        peer: { kind: "client", contractVersion: Machine.contractVersion },
      }] } });
      expect(host.list()).toMatchObject([{ name: "Worker", tags: ["pool"] }]);
      expect(host.list()[0]?.resources?.cpus).toBeGreaterThan(0);
      expect(machineWire(JSON.stringify({ type: "machine_list", requestId: "rows" }), host.native))
        .toEqual({ type: "machine_listed", requestId: "rows", rows: host.list() });
      const detached = events.next("machine.detached");
      const unenrolled = events.next("machine.unenrolled");
      await tool.execute({ operation: { op: "machine_remove", args: { machineId: args.machineId } } }, context);
      expect((await bounded(detached)).payload).toEqual({ machineId: args.machineId, time: 5, reason: "enrollment_removed" });
      expect((await bounded(unenrolled)).payload).toEqual({ machineId: args.machineId, time: 5 });
      expect(host.list()).toEqual([]);
      await expect(host.get(args.machineId).peekCode("missing")).rejects.toMatchObject({ reason: "disconnected" });
    } finally { await daemon.stop(); }
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
  const records = plane.stores.machineEnrollments;
  records.seed([enrollment]);
  records.remove(enrollment.machineId, 2);
  plane.close();
  const reopened = testPlane({ catalogPath });
  try {
    const recovered = reopened.stores.machineEnrollments;
    recovered.seed([enrollment]);
    expect(recovered.list()).toEqual([]);
    expect(recovered.get(enrollment.machineId)).toMatchObject({ revision: 1, removedAt: 2 });
    recovered.put({ ...enrollment, name: "Re-added" });
    expect(recovered.get(enrollment.machineId)?.enrollment.name).toBe("Re-added");
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("replacing an active TLS enrollment revokes its old peer and admits only the new key", async () => {
  const plane = testPlane();
  const enrollments = plane.stores.machineEnrollments;
  const events = eventCollector();
  const host = await createMachineHost({
    listen: { tcp: { host: "127.0.0.1", port: 0 } }, tls: hostIdentity,
    enrollment: (id) => {
      const row = enrollments.get(id);
      return row?.removedAt === null ? row.enrollment : undefined;
    },
    events: events.sink, now: () => 5,
  });
  const machines: MachinePort = { enrollments, host: host.native, selfId: "self", events: events.sink, now: () => 5 };
  const original = { ...args, publicKey: daemonFingerprint, allowedCapabilities: ["kernel.py", "fs.read"] };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const peers: Awaited<ReturnType<typeof connectIpcTcpClient>>[] = [];
  const attach = async (machineId: string, identity: typeof daemonIdentity, hold = false) => {
    const peer = await connectIpcTcpClient({
      tcp: { host: "127.0.0.1", port: host.endpoints.tcp?.port ?? 0 },
      hostCertificate: hostIdentity.certificate, tls: identity,
    }, { onRequest: async (method, params, respond) => {
      if (method !== Machine.WireMethod.RunCode || !hold) throw new Error(`unexpected peer request: ${method}`);
      const request = Machine.CellRequest.parse(params);
      entered.resolve();
      await release.promise;
      respond({ status: "completed", cellId: request.cellId, output: { stdout: "", stderr: "" } });
    } });
    peers.push(peer);
    const attachment = await peer.call(Machine.WireMethod.Attach, {
      machineId, offeredCapabilities: original.allowedCapabilities, daemonVersion: "test",
      platform: "darwin-arm64", offeredAt: 2,
      peer: { kind: "client", contractVersion: Machine.contractVersion },
    });
    return attachment;
  };
  try {
    executeMachine(machines, { op: "machine_add", args: original }, "owner");
    executeMachine(machines, { op: "machine_add", args: { ...original, machineId: "other" } }, "owner");
    await attach(args.machineId, daemonIdentity, true);
    await attach("other", daemonIdentity);
    let settlements = 0;
    const pending = captureError(host.get(args.machineId).runCode({ cellId: "held", code: "x", timeoutMs: 60_000 }))
      .then((error) => { settlements += 1; return error; });
    await bounded(entered.promise);
    const detached = events.next("machine.detached");
    executeMachine(machines, {
      op: "machine_add", args: { ...original, publicKey: wrongFingerprint, allowedCapabilities: ["fs.read"] },
    }, "owner");
    expect((await bounded(detached)).payload).toEqual({ machineId: args.machineId, time: 5, reason: "enrollment_replaced" });
    expect(await bounded(pending)).toMatchObject({ _tag: "MachineRefusalError", reason: "disconnected" });
    expect(host.list().map((row) => row.machineId)).toEqual(["other"]);
    expect(await attach(args.machineId, daemonIdentity)).toEqual({ status: "refused", reason: "peer_key_mismatch" });
    expect(await attach(args.machineId, wrongIdentity)).toMatchObject({ status: "attached", effectiveCapabilities: ["fs.read"] });
    expect(host.list().find((row) => row.machineId === args.machineId)).toMatchObject({
      publicKey: wrongFingerprint, allowedCapabilities: ["fs.read"], capabilities: ["fs.read"],
    });
    expect(events.events.filter((event) => event.name === "machine.detached")).toHaveLength(1);
    expect(settlements).toBe(1);
  } finally {
    release.resolve();
    for (const peer of peers) await peer.close();
    await host.close();
    plane.close();
  }
});

test("durable unenrollment publishes its fact even when live disconnection throws", async () => {
  const plane = testPlane();
  const enrollments = plane.stores.machineEnrollments;
  const events = eventCollector();
  const failure = new Error("disconnect failed");
  const machines: MachinePort = {
    enrollments, selfId: "self", events: events.sink, now: () => 5,
    host: { list: () => [], unenroll: () => { throw failure; } },
  };
  enrollments.put(enrollment);
  const unenrolled = events.next("machine.unenrolled");
  try {
    expect(() => executeMachine(machines, { op: "machine_remove", args: { machineId: args.machineId } }, "owner"))
      .toThrow(failure);
    expect((await bounded(unenrolled)).payload).toEqual({ machineId: args.machineId, time: 5 });
    expect(enrollments.get(args.machineId)).toMatchObject({ removedAt: 5 });
    expect(enrollments.list()).toEqual([]);
    expect(events.events.filter((event) => event.name === "machine.unenrolled")).toHaveLength(1);
  } finally { plane.close(); }
});

test.each(["approve", "refuse", "changed"] as const)("machine key consent is bound to the current revision: %s", async (decision) => {
  const plane = testPlane();
  const enrollments = plane.stores.machineEnrollments;
  const machines: MachinePort = { enrollments, host: { list: () => [], unenroll: () => undefined }, selfId: "self", events: { publish: () => undefined }, now: () => 5 };
  const tool = createProvisionTool({ ...provisionPort(plane), machines }, () => 5);
  const dispatch = protectedDispatch(tool, { operation: add }, undefined, { plane });
  try {
    await bounded(dispatch.opened);
    if (decision === "changed") {
      executeMachine(machines, { ...add, args: { ...args, publicKey: "b".repeat(64) } }, "owner");
      await expect(dispatch.answer()).rejects.toMatchObject({ code: "stale_approval" });
      expect(enrollments.get(args.machineId)?.enrollment.publicKey).toBe("b".repeat(64));
    } else {
      expect((await dispatch.answer(decision)).isError === true).toBe(decision === "refuse");
      expect(enrollments.get(args.machineId)?.enrollment.publicKey).toBe(decision === "approve" ? args.publicKey : undefined);
    }
  } finally { await dispatch.close(); plane.close(); }
});

test("direct session calls never grant a key and stale consent cannot overwrite authority", async () => {
  const plane = testPlane();
  const enrollments = plane.stores.machineEnrollments;
  const machines: MachinePort = { enrollments, host: { list: () => [], unenroll: () => undefined }, selfId: "self", events: { publish: () => undefined }, now: () => 5 };
  const tool = createProvisionTool({ ...provisionPort(plane), machines }, () => 5);
  try {
    expect(await tool.execute({ operation: add }, context)).toEqual({ op: "machine_add", result: { type: "require_approval", id: args.machineId } });
    expect(enrollments.get(args.machineId)).toBeUndefined();
    const revisions = machineDomainRevisions(enrollments, args.machineId);
    executeMachine(machines, add, "owner");
    await expect(tool.execute({ operation: add }, { ...context, domainRevisions: revisions })).rejects.toThrow("domain revision changed");
    expect(() => executeMachine(machines, { ...add, args: { ...args, machineId: "self" } }, "owner")).toThrow("self enrollment");
    expect(() => executeMachine(machines, { op: "machine_remove", args: { machineId: "missing" } }, "owner")).toThrow("not enrolled");
    expect(() => executeMachine(undefined, add, "owner")).toThrow("not composed");
  } finally { plane.close(); }
});

test("machine enrollment and channel declarations have independent identities", async () => {
  const plane = testPlane();
  const port = provisionPort(plane);
  const enrollments = plane.stores.machineEnrollments;
  const id = "channel:telegram:main";
  const machine = { ...enrollment, machineId: id };
  enrollments.seed([machine]);
  const tool = createProvisionTool(port, () => 5);
  try {
    expect(plane.stores.instances.list()).toEqual([]);
    await tool.execute({ operation: { op: "channel_add", args: { id, provider: "telegram", identity: "bot", enabled: true, settings: {} } } }, context);
    await tool.execute({ operation: { op: "channel_disable", args: { instanceId: id } } }, context);
    expect(plane.stores.instances.get(id)).toMatchObject({ provider: "telegram", enabled: false });
    expect(enrollments.list()).toEqual([machine]);
  } finally { plane.close(); }
});
