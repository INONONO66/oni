import { sessionTree } from "../../helpers/session-tree";
import { dispatcherToolPorts, testTurnDispatcher } from "../../helpers/service-layers";
import { prepareChatFixture } from "../../helpers/chat-services";
import { allowConfigure, isolatedRuntime, type SessionFixture as SessionRuntime, type SessionFixture, withSessionServices, } from "../../helpers/session-services";
import { Effect, Queue } from "effect";
import { expect, test } from "bun:test";
import { SEEDED_POLICY_ROWS } from "../../../src/core/gate/compile";
import { z } from "zod";
import type { PolicyRow } from "@openomni/protocol";
import { closeSessions } from "../../../src/core/run";
import { session } from "../../../src/testing/registry";
import { defineTool, eraseTool, projectTools, } from "../../../src/core/tool";
import { createSessionChatRunner } from "../../../src/core/run";
import { assistantStep } from "../../helpers/dispatching-runner";
import { isolated, isolatedLedger } from "../../helpers/isolated";
import { collector } from "../../helpers/observation-collector";
import { commitReceivedMessage } from "../../helpers/ingress";
import { armAction } from "../../../src/core/alarm";

/**
 * The alarm table is gone: an armed alarm is an `alarm{arm}` chain row
 * (alarmId + armSeq, capability purpose) with no settling `fired` row.
 * Returns the committed action id the live-wait verdict names.
 */
function armAlarm(alarmId: string): string {
  const ledger = isolatedLedger();
  const now = Date.now();
  const armed = armAction({
    parentId: null,
    sessionId: "stop",
    purpose: "test.tick",
    at: now + 60_000,
    supersedes: null,
    alarmId,
    sourceKey: "test",
    payload: {},
    armSeq: 1,
    ts: now,
  });
  const appended = ledger.session.actions.append(armed.action, ledger.kernel.row("stop").revision);
  if (appended === undefined) throw new Error("alarm arm append refused");
  return armed.action.id;
}

function scenario(mode: "repeat" | "stall" | "blocked" | "wait" | "progress" | "prior-alarm") {
  return isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime: SessionRuntime = {
          observations: { publish: () => undefined },
          authorizeConfigure: allowConfigure,
          ...isolatedRuntime(),
          ...(mode === "stall"
            ? {
                openIntent: () =>
                  Effect.succeed([{ actionId: "unanswered-message", kind: "message" as const }]),
              }
            : {}),
        };
        const rows: PolicyRow.Row[] = SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 }));
        if (mode === "blocked")
          rows.push({
            name: "deny-loop",
            kind: "tool",
            phase: "pre",
            generation: 1,
            priority: 1000,
            match: { encodingVersion: 1, value: { op: "loop" } },
            verdict: { encodingVersion: 1, value: { type: "deny", reason: "blocked" } },
          });
        for (const row of rows) isolatedLedger().catalog.policies.append(row);
        let calls = 0;
        let bodies = 0;
        // The tool's raw Promise is settled only after its exact durable side effect commits.
        const requests = yield* Queue.unbounded<{ resolve: (value: string) => void }>();
        const definitions = [
          eraseTool(
            defineTool({
              name: "loop",
              description: "loop",
              category: "mutation",
              input: z.object({}),
              output: z.string(),
              visibility: { model: ["resident"], cell: [] },
              execute: () =>
                new Promise<string>((resolve) => {
                  Queue.offerUnsafe(requests, { resolve });
                }),
              render: (_input, output) => output,
            }),
          ),
        ];
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              const request = yield* Queue.take(requests);
              bodies += 1;
              if (mode === "wait") yield* Effect.sync(() => armAlarm("current-alarm"));
              if (mode === "progress")
                yield* commitReceivedMessage(isolatedLedger().kernel, {
                  id: `progress-${bodies}`,
                  sessionId: "stop",
                  kind: "prompt",
                  content: `state ${bodies}`,
                  origin: { encodingVersion: 1, value: { source: "fixture" } },
                  createdAt: Date.now(),
                  parentActionId: null,
                  // Continuation input must steer to drain mid-turn.
                  delivery: "steer",
                });
              request.resolve("ok");
            }),
          ),
        );
        const runner = createSessionChatRunner({
          prepare: (input) =>
            Effect.gen(function* () {
              const dispatcher = yield* testTurnDispatcher(input, runtime, definitions);
              return prepareChatFixture({
                traceContext: {
                  traceId: "trace",
                  sessionId: input.sessionId,
                  runId: input.resultId,
                },
                config: {
                  events: collector(),
                  executor: dispatcher.executor,
                  model: { provider: "test", id: "test" },
                  ...dispatcherToolPorts(dispatcher, input),
                  llm: {
                    resolveModel: () =>
                      Effect.succeed({ providerID: "test", id: "test", name: "test" }),
                    run: (_request, sink) =>
                      Effect.sync(() => {
                        calls += 1;
                        const text =
                          mode === "stall" || mode === "blocked"
                            ? `attempt ${calls}`
                            : mode === "prior-alarm"
                              ? ""
                              : "same";
                        sink.onMessage(
                          assistantStep(
                            text,
                            input.sessionId,
                            "",
                            mode === "stall" || mode === "prior-alarm"
                              ? undefined
                              : { id: `tool-${calls}`, callID: `call-${calls}`, tool: "loop" },
                          ),
                        );
                        return { type: "stop" as const };
                      }),
                  },
                },
              });
            }),
        });
        const handle = yield* Effect.gen(function* () {
          const fixture: SessionFixture = runtime;
          return yield* withSessionServices(
            session(
              { id: "stop", role: "resident", runner, tools: projectTools(definitions).session },
              fixture,
            ),
            fixture,
          );
        });
        if (mode === "prior-alarm") armAlarm("old-alarm");
        const result = yield* handle.prompt("work");
        const outcome = {
          result,
          calls,
          bodies,
          snapshot: handle.get(),
          actions: sessionTree(isolatedLedger().kernel, handle.id),
        };
        yield* closeSessions(runtime);
        return outcome;
      }),
    ),
  );
}

for (const [mode, reason, count] of [
  ["repeat", "exact_repeat", 3],
  ["stall", "toolless_stall", 3],
  ["blocked", "blocked_recurrence", 3],
  ["progress", "continuation", 8],
] as const) {
  test(`real session ${mode} uses machine ${reason} with ${count} admitted steps`, async () => {
    const outcome = await scenario(mode);
    expect(outcome.result).toMatchObject({ kind: "error", cause: { code: "agent_stop", reason } });
    expect(outcome.calls).toBe(count);
    expect(outcome.snapshot.turns[0]?.terminal?.kind).toBe("error");
    if (mode === "blocked") expect(outcome.bodies).toBe(0);
    if (mode === "progress")
      expect(outcome.actions.filter((action) =>
        (action.kind === "prompt" || action.kind === "signal") &&
        (action.effect.value as { phase?: string } | null)?.phase === "delivery",
      )).toHaveLength(9);
  });
}
test("only a still-armed action created by this turn permits a waiting terminal", async () => {
  const current = await scenario("wait");
  expect(current.result).toMatchObject({
    kind: "waiting",
    reason: "live_wait",
    alarmIds: ["current-alarm:arm:1"],
  });
  expect(current.calls).toBe(1);
  expect(current.snapshot.turns[0]?.terminal?.kind).toBe("waiting");
  // W5.2: there is no lease release — the waiting session keeps its pinned owner; takeover is a higher-fence adoption.
  expect(current.snapshot.lease.owner).not.toBeNull();
  const prior = await scenario("prior-alarm");
  expect(prior.result?.kind).toBe("error");
  expect(prior.snapshot.turns[0]?.terminal?.kind).not.toBe("waiting");
});
