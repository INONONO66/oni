import { generationSnapshot, configureAction } from "../../src/core/store/configure";
import { PlainValueSchema, type LedgerAction } from "@openomni/protocol";
import { turnTerminalAction } from "../../src/core/journal/turn-rows";
import { requireCommit } from "../../src/testing/commit";
import type { ExecutionLedger } from "../../src/core/loop/executor";
import { Effect } from "effect";
import { AgentFailure } from "../../src/core/ports/failure";
import { testExecutor } from "./executor";
import { runAgent } from "./executor";
import { RunEvents } from "../../src/core/loop/turn";
import { executeCompaction } from "../../src/plugins/compaction/execute-cut";
import { Entropy } from "../../src/core/ports/ports";
import { hydrateSessionHistory } from "../../src/inspect/history";
import { compiledPolicy } from "./compiled-policy";
import { textMessage } from "./messages";
import { isolatedLedger } from "./isolated";
import { requestLedger } from "./request-ledger";
import { seedPolicy } from "./seed-policy";

export const reconstructionSession = "crash-session";
type Recording = ReturnType<typeof requestLedger>;

export function paddingActions(
  sessionId: string,
  parentId: string,
  count: number,
  prefix = "padding",
): LedgerAction.Append[] {
  return Array.from({ length: count }, (_value: never, index: number) => ({
    id: `${sessionId}:${prefix}:${index}`,
    sessionId,
    parentId,
    kind: "message",
    ts: 100,
    irreversible: true,
    intent: { encodingVersion: 1, value: { op: "audit" } },
    effect: { encodingVersion: 1, value: { phase: "record" } },
  }));
}

export async function reconstructionFixture(
  intercept?: (
    action: LedgerAction.Append,
    recording: Recording,
    bodies: readonly string[],
    publications: readonly string[],
  ) => ReturnType<ExecutionLedger["commit"]>,
  scale = { updates: 90, padding: 256 },
) {
  seedPolicy();
  const prior = requestLedger({
    id: reconstructionSession,
    turnId: "prior-turn",
    resultId: "prior-result",
  });
  requireCommit(
    prior.commitBatch(
      [
        turnTerminalAction({
          id: "prior-result",
          parentId: "prior-turn",
          sessionId: reconstructionSession,
          turnId: "prior-turn",
          result: { kind: "result", text: "prior terminal" },
          resumeCount: 0,
          boundaryActionId: null,
          at: 100,
        }),
      ],
      { state: "idle" },
    ),
  );
  const recording = requestLedger({ id: reconstructionSession });
  const bodies: string[] = [];
  const publications: string[] = [];
  const ledger =
    intercept === undefined
      ? recording.ledger
      : {
          ...recording.ledger,
          commit: (action: LedgerAction.Append) =>
            intercept(action, recording, bodies, publications),
        };
  const executor = testExecutor({
    ...recording,
    ledger,
    policy: compiledPolicy(),
    observations: { publish: () => undefined },
  });
  for (let index = 0; index < scale.updates; index += 1) {
    const message = textMessage(
      "assistant",
      `snapshot ${index} ${"evidence ".repeat(100)}`,
      reconstructionSession,
      index < scale.updates - 1 ? "same-id" : "answer",
    );
    await runAgent(executor.run({ kind: "message", op: "assistant", intent: {}, effect: {} }, () =>
      Effect.succeed(PlainValueSchema.parse(message)),
    ));
  }
  const tool = textMessage(
    "assistant",
    "tool-bearing snapshot",
    reconstructionSession,
    "tool-message",
  );
  tool.parts.push({
    id: "tool-part",
    sessionID: reconstructionSession,
    messageID: tool.info.id,
    type: "tool",
    tool: "read",
    callID: "open-call",
    state: { status: "pending", input: {} },
  });
  await runAgent(executor.run({ kind: "message", op: "assistant", intent: {}, effect: {} }, () =>
    Effect.succeed(PlainValueSchema.parse(tool)),
  ));
  const padded = recording.commitBatch(
    paddingActions(reconstructionSession, recording.identity.turnId, scale.padding),
  );
  requireCommit(padded);
  await runAgent(executor.run(
    {
      kind: "tool",
      op: "read",
      intent: {},
      effect: {},
      toolObservation: { turnId: recording.identity.turnId, callId: "open-call" },
      toolResult: () => ({
        id: "open-call",
        toolCallId: "open-call",
        toolName: "read",
        output: "settled",
        isError: false,
      }),
    },
    () => Effect.sync(() => {
      bodies.push("tool");
      return "settled";
    }),
  ));
  const generation = generationSnapshot({
    generation: 2,
    revertTo: 1,
    tools: [],
    system: {
      preset: "new generation",
      blocks: [{ id: "new", source: "test", content: "new system" }],
    },
    policyGeneration: 1,
  });
  const changed = recording.commitBatch(
    [
      configureAction({
        id: "generation-two",
        sessionId: reconstructionSession,
        parentId: recording.identity.turnId,
        operation: "system.blocks.set",
        snapshot: generation,
        at: 100,
      }),
    ],
    { generation: { toolsGeneration: 2, systemHash: generation.systemHash, policyGeneration: 1 } },
  );
  requireCommit(changed);
  const compact = (summarize = async () => "durable summary") =>
    runAgent(executeCompaction({
      history: hydrateSessionHistory(isolatedLedger().kernel, reconstructionSession).history,
      executor,
      events: {
        publish(event) {
          if (event.name === RunEvents.CompactionCompleted.name) publications.push(event.name);
        },
      },
      options: {
        contextWindowTokens: 10_000,
        protectRecentMessages: 2,
        onSummarize: () => Effect.gen(function* () {
          bodies.push("summary");
          return yield* Effect.tryPromise({ try: summarize, catch: (cause) => new AgentFailure({ operation: "test.summarize", cause: String(cause) }) });
        }),
      },
      identity: { traceId: "restart", sessionId: reconstructionSession },
      dispatch: { trigger: "yield" },
    }).pipe(Effect.provide(Entropy.layer({ id: recording.entropy, random: () => 0 }))));
  const suffix = () =>
    runAgent(executor.run({ kind: "message", op: "assistant", intent: {}, effect: {} }, () =>
      Effect.succeed(PlainValueSchema.parse(textMessage("assistant", "suffix", reconstructionSession, "suffix"))),
    ));
  return { recording, executor, bodies, publications, compact, suffix };
}
