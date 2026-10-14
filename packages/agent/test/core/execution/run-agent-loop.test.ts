import { messageSource } from "../../helpers/message-source";
import { sessionTree } from "../../helpers/session-tree";
import { testTurnDispatcher } from "../../helpers/service-layers";
import {
  fixtureConfigHead,
  fixtureTraceContext,
  prepareChatFixture,
} from "../../helpers/chat-services";
import {
  allowConfigure,
  isolatedRuntime,
  type SessionFixture as SessionRuntime,
  type SessionFixture,
  withSessionServices,
} from "../../helpers/session-services";
import { Effect, Fiber } from "effect";
import { isolated, isolatedLedger } from "../../helpers/isolated";
import { dispatchingRunner } from "../../helpers/effect-g2";
import { expect, test, spyOn } from "bun:test";
import { seedPolicy } from "../../helpers/seed-policy";
import { Message, canonicalDigest, type LedgerSession, type PlainValue } from "@openomni/protocol";
import { z } from "zod";
import { closeSessions } from "../../../src/core/session/run";
import { session } from "../../../src/testing/registry";
import { createSessionChatRunner } from "../../../src/core/session/run";
import {
  projectTools,
  defineTool,
  eraseTool,
} from "../../../src/core/loop/tool";
import { createAssistantMessage } from "../../../src/core/journal/message-factory";
import { reopenableLedger } from "../../helpers/reopenable-ledger";
import { restoreCompactionProjection } from "../../../src/plugins/compaction/durable";
import { assistantStep } from "../../helpers/dispatching-runner";
import { entropySource } from "../../helpers/time";

const object = (value: PlainValue) =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;

test("reopened SQLite hydrates exact tool-bearing assistant identities and rendered results", () => {
  const ledger = reopenableLedger("937-history-");
  // One id source spans the reopen: persisted action ids must stay unique.
  const ids = entropySource("history-run");
  return isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const definitions = [
          eraseTool(
            defineTool({
              name: "read",
              description: "read",
              category: "query",
              visibility: { model: ["resident"], cell: [] },
              input: z.object({}),
              output: z.number(),
              execute: async () => 42,
              render: (_input: Record<string, never>, value: number) => `verbatim:${value}`,
            }),
          ),
        ];
        let calls = 0;
        const inputs: Message.WithParts[][] = [];
        let runtime: SessionRuntime = {
          observations: { publish: () => undefined },
          authorizeConfigure: allowConfigure,
          entropy: ids.id,
          ...isolatedRuntime(),
        };
        const runner = dispatchingRunner(
          definitions,
          () => runtime,
          async (
            request: import("../../../src/core/ports/llm").RunInput,
            sink: import("../../../src/core/ports/llm").LlmSink,
            input: import("../../../src/core/session/run").SessionRunnerInput,
          ) => {
            inputs.push(structuredClone(request.messages));
            calls += 1;
            sink.onMessage(
              assistantStep(
                calls === 1 ? "working" : "finished",
                input.sessionId,
                request.messages.at(-1)?.info.id ?? "",
                calls === 1 ? { id: "tool-part", callID: "read-call", tool: "read" } : undefined,
              ),
            );
            return { type: "stop" };
          },
        );
        try {
          seedPolicy();
          const options = {
            id: "history",
            role: "resident" as const,
            runner,
            tools: projectTools(definitions).session,
          };
          const first = yield* Effect.gen(function* () {
            const fixture: SessionFixture = runtime;
            return yield* withSessionServices(session(options, fixture), fixture);
          });
          expect((yield* first.prompt("first"))?.kind).toBe("result");
          const preserved = inputs[1]?.find(
            (message: import("@openomni/protocol").Message.WithParts) =>
              message.parts.some(
                (part: import("@openomni/protocol").Message.WithParts["parts"][number]) =>
                  part.type === "tool",
              ),
          );
          expect(preserved?.parts).toContainEqual(
            expect.objectContaining({
              type: "tool",
              callID: "read-call",
              state: expect.objectContaining({ status: "completed", output: "verbatim:42" }),
            }),
          );
          yield* closeSessions(runtime);
          ledger.reopen();
          runtime = {
            observations: { publish: () => undefined },
            authorizeConfigure: allowConfigure,
            entropy: ids.id,
            ...isolatedRuntime(),
          };
          expect(
            (yield* (yield* Effect.gen(function* () {
              const fixture: SessionFixture = runtime;
              return yield* withSessionServices(session(options, fixture), fixture);
            })).prompt("after reopen"))?.kind,
          ).toBe("result");
          const restored = inputs[2]?.find(
            (message: import("@openomni/protocol").Message.WithParts) =>
              message.info.id === preserved?.info.id,
          );
          expect(restored).toEqual(preserved);
          expect(
            inputs[2]?.filter(
              (message: import("@openomni/protocol").Message.WithParts) =>
                message.info.id === preserved?.info.id,
            ),
          ).toHaveLength(1);
          expect(
            sessionTree(isolatedLedger().kernel, "history").filter(
              (action: import("@openomni/protocol").LedgerAction.Node) => action.kind === "message",
            ),
          ).not.toHaveLength(0);
        } finally {
          yield* closeSessions(runtime);
        }
      }),
    ),
    () => ledger,
  );
});

/** Mutable witness threaded through the compaction probe's provider calls. */
interface CompactionProbe {
  calls: number;
  reopenedInput: Message.WithParts[];
  nextBoundary: Message.WithParts[];
  afterConcurrent: Message.WithParts[];
}

/** One provider turn of the compaction-reopen scenario, recorded on the probe. */
function compactionProbeStep(
  probe: CompactionProbe,
  sessionId: string,
  request: import("../../../src/core/ports/llm").RunInput,
  sink: import("../../../src/core/ports/llm").LlmSink,
): { type: "stop" } {
  probe.calls += 1;
  if (probe.calls === 3) probe.nextBoundary = structuredClone(request.messages);
  if (probe.calls === 4) probe.reopenedInput = structuredClone(request.messages);
  const message = createAssistantMessage(
    probe.calls < 3 ? "evidence ".repeat(1000) : "finished",
    "",
    sessionId,
    messageSource,
  );
  if (message.info.role !== "assistant") throw new Error("assistant required");
  message.info.tokens.input = probe.calls < 3 ? 6000 : 1;
  message.parts.push({
    id: `${message.info.id}:finish`,
    sessionID: sessionId,
    messageID: message.info.id,
    type: "step-finish",
    reason: "stop",
    tokens: message.info.tokens,
  });
  if (probe.calls === 3) probe.afterConcurrent = structuredClone([...request.messages, message]);
  sink.onMessage(message);
  return { type: "stop" };
}

test("compaction projection and lossless revert survive SQLite reopen without deleting originals", () => {
  const ledger = reopenableLedger("937-compaction-reopen-");
  // One id source spans the reopen: persisted action ids must stay unique.
  const ids = entropySource("compact-run");
  return isolated(
    Effect.scoped(
      Effect.gen(function* () {
        let runtime: SessionRuntime = {
          observations: { publish: () => undefined },
          authorizeConfigure: allowConfigure,
          entropy: ids.id,
          ...isolatedRuntime(),
        };
        const probe: CompactionProbe = {
          calls: 0,
          reopenedInput: [],
          nextBoundary: [],
          afterConcurrent: [],
        };
        const summarizing = Promise.withResolvers<void>();
        const summary = Promise.withResolvers<string>();
        const runner = createSessionChatRunner({
          prepare: (input: import("../../../src/core/session/run").SessionRunnerInput) =>
            Effect.gen(function* () {
              const dispatcher = yield* testTurnDispatcher(input, runtime);
              return prepareChatFixture({
                traceContext: fixtureTraceContext(input),
                config: {
                  ...fixtureConfigHead(dispatcher.executor),
                  compaction: {
                    contextWindowTokens: 10000,
                    protectRecentMessages: 1,
                    speculate: false,
                    onSummarize: () =>
                      Effect.gen(function* () {
                        summarizing.resolve();
                        return yield* Effect.promise(() => summary.promise);
                      }),
                  },
                  llm: {
                    resolveModel: () =>
                      Effect.succeed({
                        providerID: "test",
                        id: "test",
                        name: "test",
                        limit: { context: 10000 },
                      }),
                    run: (
                      request: import("../../../src/core/ports/llm").RunInput,
                      sink: import("../../../src/core/ports/llm").LlmSink,
                    ) =>
                      Effect.sync(() => compactionProbeStep(probe, input.sessionId, request, sink)),
                  },
                },
              });
            }),
        });
        try {
          seedPolicy();
          const options = { id: "compact", role: "resident" as const, runner };
          const handle = yield* Effect.gen(function* () {
            const fixture: SessionFixture = runtime;
            return yield* withSessionServices(session(options, fixture), fixture);
          });
          yield* handle.prompt("first");
          const second = yield* Effect.forkScoped(handle.prompt("second"));
          yield* Effect.promise(() => summarizing.promise).pipe(Effect.timeout("5 seconds"));
          const admitted = Promise.withResolvers<void>();
          // W5.2: the input-queue table is gone; ingress is a committed `prompt`
          // chain action, so the durable-admission tap rides kernel.commit.
          const kernel = isolatedLedger().kernel;
          const commit = kernel.commit.bind(kernel);
          let count = 0;
          const tap = spyOn(kernel, "commit").mockImplementation((input: LedgerSession.Commit) =>
            commit(input).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  const during = input.actions.filter(
                    (action) =>
                      action.kind === "prompt" &&
                      String(object(action.effect.value)?.content ?? "").startsWith("during-"),
                  ).length;
                  count += during;
                  if (during > 0 && count >= 2) admitted.resolve();
                }),
              ),
            ),
          );
          yield* Effect.addFinalizer(() => Effect.sync(() => tap.mockRestore()));
          const concurrent = yield* Effect.forEach(["during-1", "during-2"], (content: string) =>
            Effect.forkScoped(handle.prompt(content)),
          );
          yield* Effect.promise(() => admitted.promise).pipe(Effect.timeout("5 seconds"));
          const pending = kernel.pendingMessages("compact");
          expect(pending.map((item) => item.content)).toEqual(["during-1", "during-2"]);
          summary.resolve("checkpoint");
          yield* Effect.forEach([second, ...concurrent], Fiber.join);
          const before = sessionTree(kernel, "compact");
          const node = [...before]
            .reverse()
            .find(
              (action: import("@openomni/protocol").LedgerAction.Node) =>
                action.kind === "compaction" &&
                object(action.effect.value)?.terminal === "executed",
            );
          const payload = object(object(node?.effect.value ?? null)?.result ?? null);
          if (payload === undefined || !Array.isArray(payload.projection))
            throw new Error("missing compaction projection");
          const projection = payload.projection.map(
            (entry: import("@openomni/protocol").PlainValue) => Message.WithParts.parse(entry),
          );
          expect(probe.nextBoundary.slice(0, -2)).toEqual(projection);
          expect(
            probe.nextBoundary
              .slice(-2)
              .map((message: import("@openomni/protocol").Message.WithParts) => message.info.id),
          ).toEqual(pending.map((item) => item.id));
          const record = z
            .object({
              summary: z.string(),
              firstKeptEntryId: z.string(),
              tokensBefore: z.number(),
              discarded: z.object({
                firstEntryId: z.string(),
                lastEntryId: z.string(),
                count: z.number(),
                sha256: z.string(),
              }),
              revert: z.object({
                removedEntries: z.array(Message.WithParts),
                priorAnchorEntryId: z.string().nullable(),
              }),
            })
            .parse(payload);
          const restored = restoreCompactionProjection(projection, record);
          expect(canonicalDigest(record.revert.removedEntries)).toBe(record.discarded.sha256);
          expect(restored.slice(0, record.discarded.count)).toEqual(record.revert.removedEntries);
          yield* closeSessions(runtime);
          ledger.reopen();
          runtime = {
            observations: { publish: () => undefined },
            authorizeConfigure: allowConfigure,
            entropy: ids.id,
            ...isolatedRuntime(),
          };
          yield* (yield* Effect.gen(function* () {
            const fixture: SessionFixture = runtime;
            return yield* withSessionServices(session(options, fixture), fixture);
          })).prompt("reopened");
          expect(probe.reopenedInput.slice(0, -1)).toEqual(probe.afterConcurrent);
          expect(sessionTree(isolatedLedger().kernel, "compact").slice(0, before.length)).toEqual(
            before,
          );
        } finally {
          yield* closeSessions(runtime);
        }
      }),
    ),
    () => ledger,
  );
});
