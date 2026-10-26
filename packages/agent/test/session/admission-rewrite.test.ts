import { expect, test } from "bun:test";
import { canonicalJson, type PlainValue } from "@oni/protocol";
import { Deferred, Effect } from "effect";
import { createHandlerTable, KERNEL_POLICY_REGISTRY, SEEDED_POLICY_ROWS } from "../../src/core/gate/compile";
import { appendReceived, createEntityTurn, deliver } from "../../src/core/session/entity-delivery";
import { policySnapshot } from "../helpers/compiled-policy";
import { runAgent } from "../helpers/isolated";
import { toolTurnWorld } from "../helpers/tool-turn";

function rewritePolicy(body: PlainValue, onlyQueued = false) {
  return policySnapshot({
    registry: createHandlerTable({
      transformers: [
        ...KERNEL_POLICY_REGISTRY.transformers,
        {
          name: "test/rewrite-prompt",
          apply: (value) => value !== null && typeof value === "object" && !Array.isArray(value)
            ? onlyQueued && (value.body === undefined || canonicalJson(value.body) !== canonicalJson([{ kind: "text", text: "queued" }]))
              ? value
              : { ...value, body }
            : value,
        },
      ],
      obligations: [...KERNEL_POLICY_REGISTRY.obligations],
    }),
    generation: 1,
    rows: [
      ...SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })),
      {
        name: "rewrite-prompt",
        kind: "prompt",
        phase: "pre",
        priority: 500,
        generation: 1,
        match: { encodingVersion: 1, value: {} },
        verdict: { encodingVersion: 1, value: {
          type: "transform", ref: "test/rewrite-prompt", config: { fields: ["body"] },
        } },
      },
    ],
  });
}

test.each([
  { name: "string", body: "REDACTED" },
  { name: "empty parts", body: [] },
] satisfies readonly { readonly name: string; readonly body: PlainValue }[])("initial admission refuses a $name prompt rewrite without running the model", ({ body }) =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    let calls = 0;
    const world = yield* toolTurnWorld({
      policy: rewritePolicy(body),
      runner: () => Effect.sync(() => {
        calls++;
        return { kind: "result" as const, text: "unexpected" };
      }),
    });
    yield* appendReceived(world.handle, "prompt", {
      messageId: "invalid-rewrite",
      content: [{ kind: "text", text: "act" }],
      origin: canonicalJson({ kind: "external", inboundTreatment: "full_access" }),
    });
    const { admission } = createEntityTurn(
      world.kernel, world.handle.authority, () => Effect.sync(() => {
        calls++;
        return { kind: "result" as const, text: "unexpected" };
      }), world.runtime, world.handle.scope,
    );
    const result = yield* admission.startTurn();
    expect(result).toMatchObject({
      kind: "error",
      cause: { _tag: "SessionPolicyRefusal", code: "session_policy_refused", reason: "invalid_output" },
    });
    expect(world.kernel.pendingMessages(world.sessionId)).toEqual([]);
    expect(world.kernel.latestTurnTerminal(world.sessionId)).toBeUndefined();
    expect(world.kernel.historyPage(world.sessionId).actions.filter((row) => row.kind === "turn")).toEqual([]);
    expect(calls).toBe(0);
  }))));

test("initial admission delivers a valid rewritten parts prompt", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const observed: string[][] = [];
    const world = yield* toolTurnWorld({
      policy: rewritePolicy([{ kind: "text", text: "REDACTED" }, { kind: "text", text: "MORE" }]),
      runner: (input) => Effect.sync(() => {
        observed.push(input.history?.flatMap((entry) =>
          entry.parts.flatMap((part) => part.type === "text" ? [part.text] : [])) ?? []);
        return { kind: "result" as const, text: "done" };
      }),
    });
    yield* world.prompt();
    yield* world.settled;
    expect(observed).toEqual([["REDACTED", "MORE"]]);
  }))));

test("step-boundary drain refuses an empty rewritten prompt before delivery", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const proceed = yield* Deferred.make<void>();
    let calls = 0;
    const world = yield* toolTurnWorld({
      policy: rewritePolicy([], true),
      runner: (input) => {
        calls++;
        return Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(proceed)),
          Effect.andThen(input.boundary("after_tools")),
          Effect.as({ kind: "result" as const, text: "unexpected" }),
        );
      },
    });
    yield* world.prompt();
    yield* Deferred.await(entered);
    yield* deliver(world.handle, {
      kind: "prompt",
      body: canonicalJson({ content: [{ kind: "text", text: "queued" }], delivery: "steer" }),
      source: canonicalJson({ kind: "external", inboundTreatment: "full_access" }),
      idempotencyKey: "queued-rewrite",
    });
    yield* Deferred.succeed(proceed, undefined);
    yield* world.settled;
    expect(calls).toBe(1);
    expect(world.kernel.pendingMessages(world.sessionId)).toEqual([]);
    expect(world.kernel.latestTurnTerminal(world.sessionId)?.effect).toMatchObject({
      kind: "error",
      text: expect.stringContaining("invalid_output"),
    });
  }))));
