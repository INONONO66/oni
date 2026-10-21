import { runAgentSync } from "../../helpers/executor";
import { catalogLayer } from "../../helpers/service-layers";
import { expect, it } from "bun:test";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { isolated } from "../../helpers/isolated";

import { Tool } from "@oni/protocol";
import { createDispatcher, defineTool } from "../../helpers/effect-g3-dispatcher";
import { z } from "zod";
import { dispatchEcho } from "../../helpers/echo-dispatch";
import { expectFailedToolCommit } from "../../helpers/execution-assertions";
import { recordingExecutor, recordingLedger } from "../../helpers/effect-g3";
import { createExecutionRecord } from "../../../src/core/loop/record";
import {
  actionCommitGate,
  compiledPolicy,
  recordingToolObservations,
} from "../../helpers/compiled-policy";

function echoTool(execute: (text: string, signal: AbortSignal) => Promise<string>) {
  return defineTool({
    name: "echo",
    description: "Echo text",
    category: "query",
    input: z.object({ text: z.string() }).strict(),
    output: z.string(),
    visibility: { model: ["resident"], cell: ["resident"] },
    execute: async ({ text }, { signal }) => execute(text, signal),
    render: (_input, output) => output,
  });
}

it("publishes no lifecycle event when pre policy blocks before tool intent", async () => {
  const observations = recordingToolObservations();
  const recording = recordingExecutor({
    policy: compiledPolicy([
      {
        name: "deny-echo",
        kind: "tool",
        phase: "pre",
        match: { encodingVersion: 1, value: { op: "echo" } },
        verdict: { encodingVersion: 1, value: { type: "deny", reason: "blocked" } },
        priority: 1,
        generation: 1,
      },
    ]),
    onObservation: observations.observe,
    clock: () => 10,
  });
  let bodyCalls = 0;
  const dispatcher = runAgentSync(createDispatcher({ executor: recording.executor }).pipe(Effect.provide(catalogLayer([
      echoTool(async (text) => {
        bodyCalls += 1;
        return text;
      }),
    ]))));

  const result = await isolated(dispatcher.execute(
    { id: "call-1", tool: "echo", input: { text: "blocked" } },
    { sessionId: "session-1", turnId: "turn-1" },
  ));

  expect(result).toMatchObject({ isError: true, errorKind: "precondition_failed" });
  expect(bodyCalls).toBe(0);
  expect(recording.committed.filter((action) => action.kind === "tool")).toEqual([]);
  expect(observations.names).toEqual([]);
});

it("publishes Started after intent commit and Completed after result commit", async () => {
  const intentCommit = actionCommitGate("echo:intent");
  const resultCommit = actionCommitGate("echo:result");
  const startedSeen = Promise.withResolvers<void>();
  const completedSeen = Promise.withResolvers<void>();
  const observations = recordingToolObservations((name) => {
    if (name === Tool.Events.Started.name) startedSeen.resolve();
    if (name === Tool.Events.Completed.name) completedSeen.resolve();
  });
  const recording = recordingExecutor({
    onCommit: async (action) => {
      await intentCommit.onCommit(action);
      await resultCommit.onCommit(action);
    },
    onObservation: observations.observe,
    clock: () => 10,
  });
  const dispatcher = runAgentSync(createDispatcher({
    executor: recording.executor,
  }).pipe(Effect.provide(catalogLayer([echoTool(async (text) => text)]))));

  const running = isolated(dispatcher.execute(
    { id: "call-1", tool: "echo", input: { text: "ok" } },
    { sessionId: "session-1", turnId: "turn-1" },
  ));
  await intentCommit.reached;
  expect(observations.names).toEqual([]);

  intentCommit.release();
  await startedSeen.promise;
  expect(observations.names).toEqual([Tool.Events.Started.name]);

  await resultCommit.reached;
  expect(observations.names).toEqual([Tool.Events.Started.name]);
  resultCommit.release();
  await Promise.all([running, completedSeen.promise]);
  expect(observations.names).toEqual([Tool.Events.Started.name, Tool.Events.Completed.name]);
});

it("publishes one error completion after a failed tool result commits", async () => {
  const observations = recordingToolObservations();
  const recording = recordingExecutor({
    onObservation: observations.observe,
    clock: () => 10,
  });
  const dispatcher = runAgentSync(createDispatcher({
    executor: recording.executor,
  }).pipe(Effect.provide(catalogLayer([echoTool(() => Promise.reject(new TypeError("failed")))]))));

  const result = await isolated(dispatchEcho(dispatcher, "fail"));

  expectFailedToolCommit(result, recording.committed);
  expect(observations.names).toEqual([Tool.Events.Started.name, Tool.Events.Completed.name]);
});

it("publishes TimedOut and Completed exactly once after the timeout result commits", () => isolated(
  Effect.gen(function* () {
    const resultCommit = actionCommitGate("echo:result");
    const bodyEntered = Promise.withResolvers<void>();
    const observations = recordingToolObservations();
    const recording = recordingExecutor({
      onCommit: resultCommit.onCommit,
      onObservation: observations.observe,
      clock: () => 10,
    });
    const dispatcher = runAgentSync(createDispatcher({ executor: recording.executor, timeoutMs: 50 }).pipe(Effect.provide(catalogLayer([echoTool((_text, signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      bodyEntered.resolve();
    }))]))));
    const control = Effect.gen(function* () {
      yield* Effect.promise(() => bodyEntered.promise).pipe(Effect.timeout("5 seconds"));
      yield* TestClock.adjust(50);
      yield* Effect.promise(() => resultCommit.reached).pipe(Effect.timeout("5 seconds"));
      expect(observations.names).toEqual([Tool.Events.Started.name]);
      resultCommit.release();
    });
    const [result] = yield* Effect.all([dispatchEcho(dispatcher, "stall"), control], { concurrency: "unbounded" });
    expectFailedToolCommit(result, recording.committed);
    expect(observations.names).toEqual([
      Tool.Events.Started.name,
      Tool.Events.TimedOut.name,
      Tool.Events.Completed.name,
    ]);
  }).pipe(Effect.provide(TestClock.layer())),
));

it("publishes tool lifecycle events to a sink without scope", () => {
  const observations = recordingToolObservations();
  const record = createExecutionRecord({
    ...recordingLedger(),
    identity: { sessionId: "session-1", role: "resident", parentActionId: null },
    observations: { publish: (event) => observations.observe(event.name) },
    clock: () => 10,
  });
  const request = {
    kind: "tool",
    op: "echo",
    intent: {},
    effect: {},
    toolObservation: { turnId: "turn-1", callId: "call-1" },
  };

  const startedAt = record.publishToolStarted(request);
  record.publishToolTerminal(request, startedAt, "success");

  expect(observations.names).toEqual([Tool.Events.Started.name, Tool.Events.Completed.name]);
});
