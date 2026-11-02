import "../src/bundles/prompt/roles";
import { afterEach, expect, test } from "bun:test";
import { Core } from "@oni/agent";
import { canonicalJson, Message, type LedgerAction } from "@oni/protocol";
import { z } from "zod";
import { deliver } from "../../../packages/agent/src/core/session/entity-delivery";
import { compiledPolicy } from "../../../packages/agent/test/helpers/compiled-policy";
import { toolTurnWorld } from "../../../packages/agent/test/helpers/tool-turn";
import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { createLiveSessionRunner, type LiveEvent } from "../src/composition/live-session";
import { acquireSyncEffect, closeAcquiredEffects, runEffect } from "./helpers/effect";
import { scriptedLive } from "./helpers/scripted-live";

afterEach(closeAcquiredEffects);

function snapshots(rows: readonly LedgerAction.Node[]) {
  return rows.flatMap((row) => {
    const effect = row.effect.value;
    if (row.kind !== "message" || effect === null || typeof effect !== "object" || Array.isArray(effect)) return [];
    const parsed = Message.WithParts.safeParse(effect.result);
    return parsed.success ? [parsed.data] : [];
  });
}

function fixture(steps: Parameters<typeof scriptedLive>[0], denyMessage = false) {
  const bodies: number[] = [];
  const probe = Core.defineTool({
    name: "probe", description: "Return a number", category: "query",
    input: z.object({ n: z.number() }), output: z.object({ n: z.number() }),
    visibility: { model: ["resident"], cell: ["resident"] },
    execute: (input) => { bodies.push(input.n); return Promise.resolve(input); },
    render: (_input, output) => JSON.stringify(output),
  });
  const world = acquireSyncEffect(toolTurnWorld({
    definitions: [probe, { ...probe, name: "denied_probe" }],
    policy: compiledPolicy([{
      name: "deny-live", kind: denyMessage ? "message" : "tool", phase: "pre",
      match: { encodingVersion: 1, value: { op: denyMessage ? "assistant" : "denied_probe" } },
      verdict: { encodingVersion: 1, value: { type: "deny", reason: "fixture_denied" } },
      priority: 1, generation: 1,
    }]),
  }));
  const stream = scriptedLive(steps);
  world.run(createLiveSessionRunner(stream.live, world.runtime));
  const rows = () => sessionTree(world.sessionId, world.plane.sessionStore(world.sessionId).actions);
  const run = async (origin?: Parameters<typeof world.prompt>[0]) => {
    await runEffect(world.prompt(origin));
    await runEffect(world.settled);
  };
  return { world, stream, rows, run, bodies };
}

test("C002 commits one utterance and continues after the same dispatcher denial as text", async () => {
  let f: ReturnType<typeof fixture>;
  const revisions: number[] = [];
  f = fixture([
    { type: "utterance_start" },
    () => { revisions.push(f.rows().length); },
    { type: "utterance_delta", text: "Before " },
    { type: "utterance_delta", text: "tools." },
    { type: "audio_out", part: { kind: "audio", ref: "sha256:audio-fixture", mime: "audio/pcm" } },
    () => { revisions.push(f.rows().length); },
    { type: "tool_call", call: { id: "allowed", tool: "probe", input: { n: 1 } } },
    { type: "tool_call", call: { id: "denied", tool: "denied_probe", input: { n: 2 } } },
    { type: "utterance_delta", text: "Still speaking." },
    () => { expect(snapshots(f.rows())).toHaveLength(0); },
    { type: "utterance_end" },
  ]);
  await f.run();

  expect(revisions[0]).toBe(revisions[1]);
  expect(f.bodies).toEqual([1]);
  expect(f.stream.sent).toMatchObject([
    { type: "tool", callID: "allowed", state: { status: "completed", output: '{"n":1}' } },
    { type: "tool", callID: "denied", state: { status: "error", error: "denied_probe refused: fixture_denied" } },
  ]);
  expect(f.stream.output).toMatchObject([{ type: "file", kind: "audio", ref: "sha256:audio-fixture" }]);
  expect(snapshots(f.rows())).toMatchObject([{
    parts: [{ type: "text", text: "Before tools." }, { type: "file" },
      { type: "tool" }, { type: "tool" }, { type: "text", text: "Still speaking." }],
  }]);
  // The denial is the executor's own pre-gate row: one policy.decision with
  // the deny verdict and zero tool rows, exactly what a text turn commits.
  const decisions = f.rows().filter((row) => row.kind === "policy.decision");
  expect(decisions.map((row) => row.intent.value)).toContainEqual(expect.objectContaining({
    hook: "tool.pre", op: "denied_probe", verdict: "deny", matchedRuleIds: ["deny-live"],
  }));
  expect(decisions.map((row) => row.effect.value)).toContainEqual(expect.objectContaining({
    reason: "fixture_denied", terminal: "blocked_pre",
    evidence: { failures: [{ tag: "PolicyDenied", phase: "pre", ruleIds: ["deny-live"] }], defects: [], interrupted: false },
  }));
  expect(f.rows().filter((row) => row.kind === "tool").map((row) => row.intent.value)).toMatchObject([
    { phase: "intent", op: "probe", value: { n: 1 } }, { phase: "result", op: "probe" },
  ]);
  expect(f.stream.closed()).toBe(true);
});

test("a steer drained at the tool boundary reaches the live model through the port", async () => {
  let f: ReturnType<typeof fixture>;
  const steer = async () => {
    const receipt = await runEffect(deliver(f.world.handle, {
      kind: "prompt", idempotencyKey: "steer-1",
      body: JSON.stringify({ content: [{ kind: "text", text: "Louder." }, { kind: "image", ref: "sha256:steer-image" }], delivery: "steer" }),
      source: canonicalJson({ kind: "external", inboundTreatment: "full_access" }),
    }));
    expect(receipt.existed).toBe(false);
  };
  f = fixture([
    { type: "utterance_start" },
    steer,
    { type: "tool_call", call: { id: "call", tool: "probe", input: { n: 3 } } },
    { type: "utterance_end" },
  ]);
  await f.run();
  expect(f.stream.sent).toMatchObject([
    { type: "tool", callID: "call" },
    { type: "text", text: "Louder.", messageID: "steer-1" },
    { type: "file", kind: "image", ref: "sha256:steer-image", messageID: "steer-1" },
  ]);
  const consumed = f.rows().filter((row) => row.kind === "prompt").map((row) => row.effect.value);
  expect(consumed).toContainEqual(expect.objectContaining({ phase: "delivery", deliveryId: "steer-1", boundary: "after_tools" }));
});

test("separate utterance boundaries persist separate assistant messages", async () => {
  const f = fixture([
    { type: "utterance_start" }, { type: "utterance_delta", text: "One." }, { type: "utterance_end" },
    { type: "utterance_start" }, { type: "utterance_delta", text: "Two." }, { type: "utterance_end" },
  ]);
  await f.run();
  expect(snapshots(f.rows()).map((message) => message.parts)).toMatchObject([
    [{ text: "One." }], [{ text: "Two." }],
  ]);
});

test.each([
  ["overlapping utterance", [{ type: "utterance_start" }, { type: "utterance_start" }]],
  ["event outside utterance", [{ type: "utterance_end" }]],
  ["unfinished utterance", [{ type: "utterance_start" }, { type: "utterance_delta", text: "partial" }]],
  ["invalid live event", [{ type: "audio_out", part: { kind: "audio", ref: "" } }]],
] satisfies readonly (readonly [string, readonly LiveEvent[]])[])("refuses %s without committing partial speech", async (cause, steps) => {
  const f = fixture(steps);
  await f.run();
  expect(snapshots(f.rows())).toEqual([]);
  expect(f.world.kernel.latestTurnTerminal(f.world.sessionId)?.effect).toMatchObject({ kind: "error" });
  expect(JSON.stringify(f.rows())).toContain(cause);
  expect(f.stream.closed()).toBe(true);
});

test("evidence-only input cannot execute a live model's tools", async () => {
  const f = fixture([
    { type: "utterance_start" },
    { type: "tool_call", call: { id: "evidence", tool: "probe", input: { n: 1 } } },
    { type: "utterance_end" },
  ]);
  await f.run({ kind: "external", inboundTreatment: "evidence_only" });
  expect(f.bodies).toEqual([]);
  expect(f.stream.sent).toMatchObject([{ state: { status: "error", error: "probe refused: evidence-only message" } }]);
});

test("assistant policy refusal fails the turn without persisting speech", async () => {
  const f = fixture([
    { type: "utterance_start" }, { type: "utterance_delta", text: "blocked" }, { type: "utterance_end" },
  ], true);
  await f.run();
  expect(snapshots(f.rows())).toEqual([]);
  expect(JSON.stringify(f.rows())).toContain("assistant refused: fixture_denied");
});

test.each(["send", "output"] as const)("a failed %s port closes the stream without a partial assistant", async (port) => {
  const f = fixture([
    { type: "utterance_start" },
    port === "send"
      ? { type: "tool_call", call: { id: "call", tool: "probe", input: { n: 1 } } }
      : { type: "audio_out", part: { kind: "audio", ref: "sha256:audio" } },
    { type: "utterance_end" },
  ]);
  const reject = () => Promise.reject(new Error("transport closed"));
  f.world.run(createLiveSessionRunner({
    ...f.stream.live,
    port: { ...f.stream.live.port, send: port === "send" ? reject : f.stream.live.port.send },
    output: port === "output" ? reject : f.stream.live.output,
  }, f.world.runtime));
  await f.run();
  expect(snapshots(f.rows())).toEqual([]);
  expect(JSON.stringify(f.rows())).toContain("transport closed");
});

test("a stream failure seals an error rather than saving the unfinished utterance", async () => {
  const f = fixture([{ type: "utterance_start" }, () => { throw new Error("stream failed"); }]);
  await f.run();
  expect(snapshots(f.rows())).toEqual([]);
  expect(JSON.stringify(f.rows())).toContain("stream failed");
});
