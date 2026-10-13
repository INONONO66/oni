import { messageSource } from "./helpers/message-source";
import { PlainValueSchema } from "@openomni/protocol";
import { sessionTree } from "./helpers/session-tree";
import { testTurnDispatcher } from "./helpers/service-layers";
import { prepareChatFixture } from "./helpers/chat-services";
import { allowConfigure, isolatedRuntime, type SessionFixture as SessionRuntime, type SessionFixture, withSessionServices, } from "./helpers/session-services";
import type { RunInput, LlmSink as Sink } from "../src/core/llm";
import type { LedgerAction } from "@openomni/protocol";
import { Effect } from "effect";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { awaitSignal, boundedSignal } from "./helpers/g0-signals";
import { expect, test } from "bun:test";
import { seedPolicy } from "./helpers/seed-policy";
import * as SessionHandleStore from "../src/core/store/fence";
import { SessionTurn } from "@openomni/protocol";
import { closeSessions, type SessionRunnerInput } from "../src/core/run";
import { session } from "../src/testing/registry";
import { resolveSessionRuntime } from "../src/core/run";
import { createController } from "../src/testing/controller";
import { createSessionChatRunner } from "../src/core/run";
import { createAssistantMessage } from "../src/core/message-factory";
import { reopenableLedger } from "./helpers/reopenable-ledger";
import { commitReceivedMessage } from "./helpers/ingress";
import { uniqueEntropy } from "./helpers/time";

for (const mode of ["interrupted", "crash-open"] as const) {
  test(`reopened SQLite ${mode} chooses the correct IDs and generation with no stale-fence writes`, () => {
    const ledger = reopenableLedger("937-resume-");
    return isolated(
      Effect.scoped(
        Effect.gen(function* () {
          let runtime: SessionRuntime = {
            authorizeConfigure: allowConfigure,
            observations: { publish: () => undefined },
            clock: () => 1000,
            entropy: uniqueEntropy("boot1"),
            ...isolatedRuntime(),
          };
          const entered = Promise.withResolvers<void>();
          const inputs: SessionRunnerInput[] = [];
          let opening = mode === "interrupted";
          const runner = createSessionChatRunner({
            prepare: (input: SessionRunnerInput) =>
              Effect.gen(function* () {
                inputs.push(input);
                return prepareChatFixture({
                  traceContext: {
                    traceId: "trace",
                    sessionId: input.sessionId,
                    runId: input.resultId,
                  },
                  config: {
                    events: { publish: () => undefined },
                    executor: (yield* testTurnDispatcher(input, runtime)).executor,
                    model: { provider: "test", id: "test" },
                    llm: {
                      resolveModel: () =>
                        Effect.sync(() => {
                          return { id: "test", name: "test", providerID: "test" };
                        }),
                      run: (_request: RunInput, sink: Sink) =>
                        Effect.gen(function* () {
                          if (opening) {
                            opening = false;
                            entered.resolve();
                            return yield* Effect.never;
                          }
                          sink.onMessage(createAssistantMessage("recovered", "", input.sessionId, messageSource));
                          return { type: "stop" };
                        }),
                    },
                  },
                });
              }),
          });
          seedPolicy();
          let originalTurn = "crashed-turn";
          let originalResult = "crashed-result";
          const kernel = () => isolatedLedger().kernel;
          if (mode === "interrupted") {
            const handle = yield* Effect.gen(function* () {
              const fixture: SessionFixture = runtime;
              return yield* withSessionServices(
                session({ id: "resume", role: "resident", runner }, fixture),
                fixture,
              );
            });
            const first = yield* Effect.forkChild(handle.prompt("original"));
            yield* boundedSignal(entered.promise, "provider entered");
            yield* awaitSignal(handle.interrupt());
            expect((yield* awaitSignal(first))?.kind).toBe("interrupted");
            const captured = inputs[0];
            if (captured === undefined) throw new Error("missing first invocation");
            originalTurn = captured.turnId;
            originalResult = captured.resultId;
            yield* awaitSignal(
              handle.system.blocks.set([
                { id: "new", source: "fixture", content: "generation two" },
              ]),
            );
            yield* commitReceivedMessage(kernel(), {
              id: "resume-request",
              sessionId: "resume",
              kind: "resume",
              content: "",
              createdAt: 1001,
              origin: { encodingVersion: 1, value: { source: "fixture" } },
              parentActionId: kernel().latestAction("resume")?.id ?? null,
            });
          } else {
            yield* kernel().materialize({
              id: "resume",
              role: "resident",
              parentId: null,
              tools: [],
              system: { preset: "", blocks: [] },
              policyGeneration: 1,
              actionId: "initial",
              at: 1,
            });
            const generation = SessionHandleStore.latestGeneration(sessionTree(kernel(), "resume"));
            const lease = yield* kernel().adoptFence({
              sessionId: "resume",
              owner: "crashed",
              fence: kernel().row("resume").fence + 1,
            });
            const newer = SessionHandleStore.generationSnapshot({
              generation: 2,
              revertTo: 1,
              tools: [],
              system: {
                preset: "",
                blocks: [{ id: "new", source: "fixture", content: "generation two" }],
              },
              policyGeneration: 1,
            });
            yield* kernel().commit({
              sessionId: "resume",
              owner: "crashed",
              fence: lease.fence,
              now: 2,
              expectedRevision: kernel().row("resume").revision,
              state: "running",
              generation: {
                toolsGeneration: 2,
                systemHash: newer.systemHash,
                policyGeneration: 1,
              },
              actions: [
                {
                  id: originalTurn,
                  sessionId: "resume",
                  parentId: "initial",
                  kind: "turn",
                  intent: {
                    encodingVersion: 1,
                    value: PlainValueSchema.parse(
                      SessionTurn.DecodeIntent.parse({
                        phase: "intent",
                        resultId: originalResult,
                        deliveryIds: [],
                        resumeCount: 0,
                        boundaryActionId: "initial",
                        toolsGeneration: 1,
                        toolsHash: generation.toolsHash,
                        systemHash: generation.systemHash,
                        policyGeneration: 1,
                      }),
                    ),
                  },
                  effect: { encodingVersion: 1, value: { phase: "pending" } },
                  irreversible: true,
                  ts: 2,
                },
                SessionHandleStore.configureAction({
                  id: "newer",
                  sessionId: "resume",
                  parentId: originalTurn,
                  operation: "system.blocks.set",
                  snapshot: newer,
                  at: 3,
                }),
              ],
            });
          }
          const immutable = sessionTree(kernel(), "resume");
          yield* awaitSignal(closeSessions(runtime));
          ledger.reopen();
          runtime = {
            observations: { publish: () => undefined },
            clock: () => 2000,
            entropy: uniqueEntropy("boot2"),
            authorizeConfigure: allowConfigure,
            ...isolatedRuntime(),
          };
          // The startup sweep is gone with the Storage singleton: recovery is a
          // fresh activation over the reopened kernel driving its reconcile.
          yield* awaitSignal(
            Effect.gen(function* () {
              const fixture: SessionFixture = runtime;
              yield* withSessionServices(
                Effect.gen(function* () {
                  const resolved = yield* resolveSessionRuntime(fixture);
                  const scope = yield* Effect.scope;
                  const controller = yield* createController(
                    kernel(),
                    "resume",
                    runner,
                    resolved,
                    {
                      reactivate: () => Effect.die("no reactivation in recovery test"),
                      release: () => undefined,
                    },
                    scope,
                  );
                  yield* controller.reconcile();
                }),
                fixture,
              );
            }),
          );
          const recovered = inputs.at(-1);
          if (recovered === undefined) throw new Error("missing recovered invocation");
          expect(recovered.toolsGeneration).toBe(mode === "crash-open" ? 1 : 2);
          if (mode === "crash-open") {
            expect(recovered.turnId).toBe(originalTurn);
            expect(recovered.resultId).toBe(originalResult);
          } else {
            expect(recovered.turnId).not.toBe(originalTurn);
            expect(recovered.resultId).not.toBe(originalResult);
          }
          const tree = sessionTree(kernel(), "resume");
          expect(tree.slice(0, immutable.length)).toEqual(immutable);
          expect(
            tree.filter(
              (action: LedgerAction.Node) =>
                SessionHandleStore.turnTerminal(action)?.turnId === recovered.turnId,
            ),
          ).toHaveLength(1);
          const stale = kernel().commit({
            sessionId: "resume",
            owner: "crashed",
            fence: 1,
            now: 2000,
            expectedRevision: kernel().row("resume").revision,
            actions: [],
            state: "running",
          });
          expect(yield* Effect.flip(stale)).toMatchObject({
            _tag: "CommitRefused",
            reason: "fence",
          });
          expect(sessionTree(kernel(), "resume")).toEqual(tree);
        }),
      ),
      () => ledger,
    );
  });
}
