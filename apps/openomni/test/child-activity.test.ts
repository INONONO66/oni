import { expect, spyOn, test } from "bun:test";
import { Core } from "@openomni/agent";
import { Effect, Schema } from "effect";
import { join } from "node:path";
import { admit } from "../src/bundles/child-activity/admit";
import { decodeSpool } from "../src/bundles/child-activity/spool";
import { ChildRow, reconcile } from "../src/bundles/child-activity/reconcile";
import { fixture, identity, pack, reference, spec } from "./helpers/child-activity";
import { runEffect, runRuntimeEffect } from "./helpers/effect";
import { residentSuite, fakeProviderModel } from "./helpers/resident-suite";
import { planeOf } from "./helpers/ledger";
import { materializeResident } from "./helpers/resident-materialize";
import { parseJson } from "@openomni/protocol";

const suite = residentSuite();
class Refused extends Schema.TaggedError<Refused>()("DeliverRefused", {
  code: Schema.Literals(["idempotency_conflict", "denied"]),
}) {}

test("daemon reads reach real entity Deliver and the app exposes the persisted child view", async () => {
  const config = suite.config("child-activity-");
  const root = config.machines?.self.exports[0]?.path;
  if (root === undefined) throw new Error("fixture export missing");
  const app = await suite.boot({
    config,
    clusterClock: "injected",
    sessionRuntime: { clock: () => 100 },
    llm: { resolveModel: fakeProviderModel, run: () => Effect.succeed({ type: "stop" as const }) },
  });
  const plane = await planeOf(app.runtime);
  await materializeResident(plane, spec.sessionId, plane.openKernel("gateway-ingress").currentPolicyGeneration());
  const text = `${fixture("live", "requested")}\n`;
  const spoolPath = join(root, "spool.jsonl");
  const transcriptPath = join(root, "transcript.jsonl");
  await Bun.write(spoolPath, text);
  await Bun.write(transcriptPath, `${fixture("transcript", "requested")}\n`);
  if (spec.spool === undefined || spec.transcript === undefined) throw new Error("source fixture missing");
  const watched = { ...spec, spool: { ...spec.spool, path: spoolPath }, transcript: { ...spec.transcript, path: transcriptPath } };
  await app.childActivity.install(watched);
  expect(app.childActivity.state(spec.sessionId, identity.child, identity.turn)?.fact).toEqual({
    ...identity, phase: "requested", toolUseId: "toolu_redacted",
  });
  await app.childActivity.close(spec.id);
  await app.childActivity.install(watched);
  await app.childActivity.close(spec.id);
  const rows = plane.openKernel(spec.sessionId).historyPage(spec.sessionId, { afterRevision: 0 }).actions.flatMap((row) => {
    const value = row.effect.value;
    if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.content !== "string") return [];
    const parsed = parseJson(ChildRow, value.content);
    return parsed !== undefined && parsed.key === row.id ? [parsed] : [];
  });
  expect(rows.filter((row) => row.kind === "child_fact")).toHaveLength(1);
  expect(rows.filter((row) => row.kind === "child_receipt")).toHaveLength(2);
  const kernel = plane.openKernel(spec.sessionId);
  const historyPage = kernel.historyPage;
  const paged = spyOn(kernel, "historyPage").mockImplementation((sessionId, request) =>
    historyPage(sessionId, { ...request, limit: 1 }),
  );
  try {
    expect(app.childActivity.state(spec.sessionId, identity.child, identity.turn)?.source).toBe("hook");
    expect(paged.mock.calls.length).toBeGreaterThan(1);
  } finally {
    paged.mockRestore();
  }
  const client = await runRuntimeEffect(app.runtime, Core.SessionEntity.client);
  const replay = reconcile(decodeSpool({ ...identity, pack, ref: reference(text), chunk: Buffer.from(text) }).observations, []);
  await runRuntimeEffect(app.runtime, admit(client, spec.sessionId, replay.filter((row) => row.kind === "child_fact")));
  expect(app.childActivity.state(spec.sessionId, identity.child, identity.turn)?.source).toBe("hook");
});

test("the admission writer surfaces a typed idempotency conflict through the same Deliver door", async () => {
  const calls: Parameters<ReturnType<Parameters<typeof admit>[0]>["Deliver"]>[0][] = [];
  const text = `${fixture("live", "requested")}\n`;
  const rows = reconcile(decodeSpool({ ...identity, pack, ref: reference(text), chunk: Buffer.from(text) }).observations, []);
  const client: Parameters<typeof admit>[0] = () => ({
    Deliver: (payload) => {
      calls.push(payload);
      return calls.length === 1
        ? Effect.fail(new Refused({ code: "idempotency_conflict" }))
        : Effect.succeed({ seq: calls.length, existed: false });
    },
  });
  const result = await runEffect(admit(client, "parent", rows));
  expect(result.map((row) => row.kind)).toEqual(["child_conflict", "child_receipt"]);
  expect(calls.every((call) => call.kind === "action")).toBe(true);
  expect(calls[1]?.idempotencyKey).toBe(result[0]?.key);
  const denied: Parameters<typeof admit>[0] = () => ({
    Deliver: () => Effect.fail(new Refused({ code: "denied" })),
  });
  await expect(runEffect(admit(denied, "parent", rows))).rejects.toMatchObject({ code: "denied" });
});
