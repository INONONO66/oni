import { expect, spyOn, test } from "bun:test";
import { Machine, Operational, parseJson, type Tool } from "@oni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";
import { bounded } from "./helpers/protected-dispatch";
import { attachMachineDaemon } from "../../../packages/machines/test/helpers/native";
import { createFileGenerationStore } from "@oni/machines";
import { nextFrame } from "./helpers/ws";
import { machineWire } from "../src/composition/machine-wire";
import { MachineResult } from "../src/bundles/provision/machine-schema";
import minimalInfo from "../../../packages/protocol/fixtures/machine/valid/Info.minimal.json";
import { planeOf, testPlane } from "./helpers/ledger";
import { Bus } from "./helpers/bus";
import { runEffect } from "./helpers/effect";

const suite = residentSuite();

test("the authenticated gateway returns the live host list before chat", async () => {
  const config = suite.config("machine-wire-", { wsToken: "owner-token", compactionSummarizer: false });
  if (config.machines === undefined) throw new Error("missing machine plane");
  const machines = { ...config.machines, enrolled: [{
    machineId: "wire-worker", name: "Wire worker", allowedCapabilities: ["kernel.py"], publicKey: "c".repeat(64), enrolledAt: 1,
  }] };
  const execution = Promise.withResolvers<Tool.Result>();
  const app = await suite.boot({
    config: { ...config, machines },
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        const result = requestToolStep(input, sink, { id: "list", tool: "provision", input: { operation: { op: "machine_list", args: {} } } });
        if (result !== undefined) {
          execution.resolve(result);
          sink.onMessage(assistantMessage(input, { text: "done" }));
        }
        return { type: "stop" as const };
      }),
    },
  });
  if (config.machineGenerationsPath === undefined) throw new Error("missing generation store path");
  expect(await runEffect(createFileGenerationStore({ path: config.machineGenerationsPath }).current("self"))).toBe(1);
  const daemon = await attachMachineDaemon({
    socketPath: machines.listen.unix ?? "",
    offer: { machineId: "wire-worker", daemonVersion: "test", offeredCapabilities: ["kernel.py"], offeredAt: 2, platform: "linux-arm64" },
  });
  suite.defer(() => daemon.close());
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "owner-token"]);
  const response = nextFrame(socket, (frame) => frame.requestId === "machines");
  socket.send(JSON.stringify({ type: "machine_list", requestId: "machines" }));
  const reply = Machine.Response.parse(await response);
  expect(reply.type).toBe("machine_listed");
  if (reply.type !== "machine_listed") throw new Error(reply.detail);
  expect(reply.rows.map((row) => row.machineId)).toEqual(["self", "wire-worker"]);
  expect(reply.rows.find((row) => row.machineId === "wire-worker")).toMatchObject({
    generation: 1, peer: { kind: "daemon", contractVersion: Machine.contractVersion },
  });
  socket.send(JSON.stringify({ text: "List attached machines", eventId: "list-machines" }));
  const result = await bounded(execution.promise);
  expect(result.isError).not.toBe(true);
  if (result.content === undefined) throw new Error("missing machine list result");
  const listed = parseJson(z.object({ rows: z.array(Machine.Info) }), result.content)?.rows;
  expect(listed).toEqual(reply.rows);
  expect(listed?.find((row) => row.machineId === "wire-worker")).toMatchObject({
    generation: 1, peer: { kind: "daemon", contractVersion: Machine.contractVersion },
  });
});

test("machine wire refuses malformed and unavailable requests while leaving other frames alone", () => {
  expect(machineWire("invalid json", undefined)).toBeUndefined();
  expect(machineWire(Buffer.from('{"type":"machine_list","requestId":"bad","extra":true}'), undefined))
    .toMatchObject({ type: "machine_list_refused", requestId: "bad", reason: "invalid_request" });
  expect(machineWire('{"type":"machine_list"}', undefined))
    .toMatchObject({ type: "machine_list_refused", requestId: "invalid", reason: "invalid_request" });
  expect(machineWire('{"type":"machine_list","requestId":"absent"}', undefined))
    .toMatchObject({ type: "machine_list_refused", requestId: "absent", reason: "unavailable" });
  expect(machineWire('{"type":"automation_list","requestId":"other"}', undefined)).toBeUndefined();
});

test("legacy machine lists omit generation and peer on both app read surfaces", () => {
  const gateway = Machine.Response.parse({ type: "machine_listed", requestId: "legacy", rows: [minimalInfo] });
  const provision = MachineResult.parse({ op: "machine_list", result: { rows: [minimalInfo] } });
  expect(gateway.type).toBe("machine_listed");
  if (gateway.type !== "machine_listed") throw new Error(gateway.detail);
  expect(gateway.rows[0]).toEqual(minimalInfo);
  if (provision.op !== "machine_list") throw new Error("unexpected machine result");
  expect(provision.result.rows[0]).toEqual(minimalInfo);
});

test("boot warns once for a changed live enrollment seed without overwriting stored authority", async () => {
  const config = suite.config("machine-seed-warning-", { compactionSummarizer: false });
  if (config.machines === undefined) throw new Error("missing machine plane");
  const original = Machine.Enrollment.parse({
    machineId: "changed", name: "Worker", allowedCapabilities: ["kernel.py"], publicKey: "a".repeat(64), enrolledAt: 1,
  });
  const same = { ...original, machineId: "same" };
  const removed = { ...original, machineId: "removed" };
  const fresh = { ...original, machineId: "fresh" };
  const persisted = testPlane({ catalogPath: config.catalogPath });
  try {
    persisted.stores.machineEnrollments.seed([original, same, removed]);
    persisted.stores.machineEnrollments.remove(removed.machineId, 2);
  } finally { persisted.close(); }
  const published = spyOn(Bus, "publish");
  try {
    const app = await suite.boot({
      config: {
        ...config,
        machines: { ...config.machines, enrolled: [{ ...original, publicKey: "b".repeat(64) }, same, removed, fresh] },
      },
    });
    const warnings = published.mock.calls.flatMap(([descriptor, data]) =>
      descriptor.name === Operational.Events.Warn.name ? [Operational.Events.Warn.schema.parse(data)] : [],
    ).filter((event) => event.context?.reason === "enrollment_seed_ignored");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.context).toEqual({ machineId: "changed", reason: "enrollment_seed_ignored", op: "machine_add" });
    const records = (await planeOf(app.runtime)).stores.machineEnrollments;
    expect(records.get("changed")?.enrollment).toEqual(original);
    expect(records.get("removed")?.removedAt).toBe(2);
    expect(records.get("fresh")?.enrollment).toEqual(fresh);
  } finally { published.mockRestore(); }
});
