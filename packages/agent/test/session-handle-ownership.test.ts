import { describe, expect, test } from "bun:test";
import { Effect, Fiber, } from "effect";
import { type L0Observation, PlainValueSchema } from "@openomni/protocol";
import type { ExecutionApprovals } from "../src/core/gate/decide";
import type { ExecutionApprovalRequest } from "../src/core/gate/decide";
import type { SessionHandle } from "../src/core/run";
import type { SessionFixture } from "./helpers/session-services";
import type { SessionRunner, SessionRunnerInput } from "../src/core/run";
import * as SessionHandleStore from "../src/core/store/fence";
import { GenerationOwnership } from "../src/core/ports";
import { GenerationRawSlots } from "../src/core/run";
import { awaitSignal, failure, boundedSignal as bounded } from "./helpers/g0-signals";
import {
  approvalRequest,
  commitDelivery,
  declare,
  deliveries,
  deliveryRows,
  expectSingleWriterUntilSettled,
  hibernatingSession,
  interruptStubborn,
  kernel,
  now,
  pendingDeliveries,
  recordingRunner,
  residentOptions,
  settleStubborn,
  signal,
  stubbornRunner,
  suite,
  system,
  terminals,
  testProgram,
  tool,
  track,
  tree,
  useSessionHandleSuite,
} from "./helpers/session-handle-suite";

// #1348: split from session-handle.test.ts — ownership, generation rotation, hibernation and approval routing.

useSessionHandleSuite();

describe("durable session handle: ownership and generations", () => {
  test("does not overlap a resumed runner when the interrupted runner ignores abort", () =>
    testProgram(
      Effect.gen(function* () {
        const firstEntered = signal<void>();
        const firstAborted = signal<void>();
        const releaseFirst = signal<void>();
        let entries = 0;
        let active = 0;
        let maximumActive = 0;
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.gen(function* () {
            entries += 1;
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            if (entries === 1) {
              input.signal.addEventListener("abort", () => firstAborted.resolve(), { once: true });
              const settled = releaseFirst.promise.then(() => {
                active -= 1;
              });
              input.retainEffect?.(settled);
              firstEntered.resolve();
              yield* Effect.promise(() => settled);
            } else {
              active -= 1;
            }
            return { kind: "result", text: `run ${entries}` };
          });
        const handle = yield* declare(residentOptions("non-cooperative-interrupt", runner));

        const first = yield* Effect.forkChild(handle.prompt("start"));
        yield* awaitSignal(bounded(firstEntered.promise, "first runner entry"));
        const interrupted = yield* Effect.forkChild(handle.interrupt());
        yield* awaitSignal(bounded(firstAborted.promise, "first runner abort signal"));
        const resumeCommitted = signal<void>();
        suite.sink.onCommit = () => {
          if (pendingDeliveries(handle.id).some((row) => row.kind === "resume"))
            resumeCommitted.resolve();
        };
        const resumed = yield* Effect.forkChild(handle.resume());
        yield* bounded(resumeCommitted.promise, "resume committed while raw runner retained");
        expect(entries).toBe(1);
        expect(maximumActive).toBe(1);
        releaseFirst.resolve();
        yield* awaitSignal(
          bounded(
            Effect.all([awaitSignal(first), awaitSignal(interrupted), awaitSignal(resumed)], {
              concurrency: "unbounded",
            }),
            "serialized resume completion",
          ),
        );

        expect(entries).toBe(2);
        expect(maximumActive).toBe(1);
      }),
    ));

  test("retained turn ownership holds the generation until released", () =>
    testProgram(
      Effect.gen(function* () {
        const retained = signal<{ readonly release: () => void; readonly pending: () => number }>();
        const runner: SessionRunner = () =>
          Effect.gen(function* () {
            const ownership = yield* GenerationOwnership;
            const owners = yield* ownership.provide(GenerationRawSlots);
            // Admission and the running turn each own a capture.
            const before = owners.pending();
            const release = ownership.retain();
            retained.resolve({ release, pending: owners.pending });
            expect(before).toBe(2);
            expect(owners.pending()).toBe(before + 1);
            return { kind: "result", text: "retained" };
          });
        const { handle, hibernated } = yield* hibernatingSession("retained-generation", runner);
        const result = yield* bounded(handle.prompt("retain ownership"), "retained turn terminal");
        const owner = yield* bounded(retained.promise, "generation retained");
        try {
          expect(result).toEqual({ kind: "result", text: "retained" });
          expect(owner.pending()).toBe(1);
          expect(kernel().row(handle.id).fenceOwner).not.toBeNull();
        } finally {
          owner.release();
        }
        expect(owner.pending()).toBe(0);
        yield* bounded(hibernated.promise, "retained ownership released");
      }),
    ));

  test("configure during the ignored-abort window keeps the fence pinned by the live runner", () =>
    testProgram(
      Effect.gen(function* () {
        const run = stubbornRunner();
        const { handle, hibernated } = yield* hibernatingSession(
          "configure-in-interrupt-window",
          run.runner,
        );
        const pending = yield* awaitSignal(interruptStubborn(handle, run));
        expect(handle.get().state).toBe("interrupted");
        const fenceBefore = handle.get().lease.fence;

        // A configure while the abort-ignoring runner is still alive must not
        // rotate the fence: the live activation still owns its authority.
        const receipt = yield* awaitSignal(
          bounded(handle.tools.add([tool("search")]), "configure receipt"),
        );
        expect(receipt.generation).toBeGreaterThan(0);
        const afterConfigure = handle.get();
        expect(afterConfigure.lease.fence).toBe(fenceBefore);
        expect(afterConfigure.lease.owner).not.toBeNull();
        yield* awaitSignal(
          expectSingleWriterUntilSettled(
            handle,
            run,
            pending,
            hibernated,
            afterConfigure.lease.fence,
          ),
        );
      }),
    ));

  test("configure re-entered from the interrupted seal observation still sees the fence as pinned", () =>
    testProgram(
      Effect.gen(function* () {
        const run = stubbornRunner();
        const { entered } = run;
        const { handle, hibernated } = yield* hibernatingSession(
          "configure-from-seal-observation",
          run.runner,
        );
        // Capture the interrupted seal, then submit configure before releasing the
        // retained raw runner; both operations must observe the same pinned fence.
        const reentered = signal<() => ReturnType<SessionHandle["tools"]["add"]>>();
        let fenceAtSeal = -1;
        suite.sink.onCommit = (committed: L0Observation.ActionCommitted) => {
          if (committed.kind !== "turn" || fenceAtSeal !== -1) return;
          const row = kernel().row(handle.id);
          if (row.state !== "interrupted") return;
          fenceAtSeal = row.fence;
          const configured = handle.tools.add([tool("search")]);
          reentered.resolve(() => configured);
        };

        const running = yield* Effect.forkChild(handle.prompt("start"));
        yield* awaitSignal(bounded(entered.promise, "runner entry"));
        const interrupted = yield* Effect.forkChild(handle.interrupt());
        const reentrant = yield* awaitSignal(bounded(reentered.promise, "seal observation"));
        yield* awaitSignal(bounded(reentrant(), "re-entrant configure"));

        const row = kernel().row(handle.id);
        expect(row.fence).toBe(fenceAtSeal);
        expect(row.fenceOwner).not.toBeNull();

        yield* awaitSignal(settleStubborn(handle, run, { running, interrupted }, hibernated));
        expect(kernel().row(handle.id).fence).toBe(fenceAtSeal);
        expect(run.maximumActive()).toBe(1);
      }),
    ));

  test("close() returns once a positive grace window lapses while the runner still ignores abort", () =>
    testProgram(
      Effect.gen(function* () {
        const { runner, entered, releaseRunner } = stubbornRunner();
        const { handle, hibernated } = yield* hibernatingSession(
          "close-after-positive-grace",
          runner,
          { closeGraceMs: 1 },
        );

        const running = yield* Effect.forkChild(handle.prompt("start"));
        yield* awaitSignal(bounded(entered.promise, "runner entry"));
        // The interrupt seals the turn while the abort-ignoring runner stays retained,
        // so close() can only return once the grace timer lapses.
        yield* awaitSignal(bounded(handle.interrupt(), "interrupt receipt"));
        try {
          yield* bounded(
            Effect.forkDetach(handle.close()).pipe(Effect.flatMap(Fiber.join)),
            "close after grace lapse",
          );
          expect(kernel().row(handle.id).fenceOwner).not.toBeNull();
        } finally {
          releaseRunner.resolve();
          yield* bounded(
            Effect.all([awaitSignal(running), awaitSignal(hibernated.promise)], {
              concurrency: "unbounded",
            }),
            "runner settlement + hibernation",
          );
        }
      }),
    ));

  test("close() returns after the zero grace window while the runner settles its turn durably", () =>
    testProgram(
      Effect.gen(function* () {
        const { runner, entered, releaseRunner, maximumActive } = stubbornRunner();
        const { handle, hibernated } = yield* hibernatingSession(
          "close-detaches-after-grace",
          runner,
          { closeGraceMs: 0 },
        );

        const running = yield* Effect.forkChild(handle.prompt("start"));
        yield* awaitSignal(bounded(entered.promise, "runner entry"));
        yield* awaitSignal(bounded(handle.close(), "close with zero grace"));

        // Detached from the caller only: this activation still holds its fence,
        // so no second executor can have overlapped.
        expect(kernel().row(handle.id).fenceOwner).not.toBeNull();

        // Once the runner settles, the retained continuation finishes durably.
        releaseRunner.resolve();
        yield* awaitSignal(
          bounded(
            Effect.all([awaitSignal(running), awaitSignal(hibernated.promise)], {
              concurrency: "unbounded",
            }),
            "runner settlement + hibernation",
          ),
        );
        expect(maximumActive()).toBe(1);
      }),
    ));

  test("pins generation N while configure commits generation N+1", () =>
    testProgram(
      Effect.gen(function* () {
        const firstEntered = signal<SessionRunnerInput>();
        const secondEntered = signal<SessionRunnerInput>();
        const releaseFirst = signal<void>();
        const inputs: SessionRunnerInput[] = [];
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.gen(function* () {
            inputs.push(input);
            if (inputs.length === 1) {
              firstEntered.resolve(input);
              yield* awaitSignal(releaseFirst.promise);
            } else {
              secondEntered.resolve(input);
            }
            return { kind: "result", text: `generation ${input.toolsGeneration}` };
          });
        const handle = yield* declare(residentOptions("configure-pinning", runner));

        const firstTurn = yield* Effect.forkChild(handle.prompt("turn one"));
        const pinned = yield* awaitSignal(bounded(firstEntered.promise, "generation N runner"));
        const receipt = yield* awaitSignal(handle.tools.add([tool("search")]));
        releaseFirst.resolve();
        yield* awaitSignal(bounded(firstTurn, "generation N terminal"));
        const secondTurn = yield* Effect.forkChild(handle.prompt("turn two"));
        const next = yield* awaitSignal(bounded(secondEntered.promise, "generation N+1 runner"));
        yield* awaitSignal(bounded(secondTurn, "generation N+1 terminal"));

        expect(receipt).toEqual({ generation: 2, revertTo: 1 });
        expect(pinned.toolsGeneration).toBe(1);
        expect(pinned.tools.map((entry) => entry.name)).toEqual(["read"]);
        expect(next.toolsGeneration).toBe(2);
        expect(next.tools.map((entry) => entry.name)).toEqual(["read", "search"]);
        expect(next.systemHash).toBe(pinned.systemHash);
      }),
    ));

  test("immediate configure interrupts the old turn before selecting and resuming the new generation", () =>
    testProgram(
      Effect.gen(function* () {
        const entered = signal<void>();
        const inputs: SessionRunnerInput[] = [];
        const runner: SessionRunner = (input) =>
          Effect.gen(function* () {
            inputs.push(input);
            if (inputs.length === 1) {
              entered.resolve();
              yield* Effect.never;
            }
            return { kind: "result", text: "resumed" };
          });
        const handle = yield* declare(residentOptions("immediate-configure", runner));
        const running = yield* Effect.forkChild(handle.prompt("start"));
        yield* awaitSignal(bounded(entered.promise, "old generation entry"));
        yield* handle.interrupt();
        expect(yield* awaitSignal(bounded(running, "interrupted old turn"))).toMatchObject({
          kind: "interrupted",
        });
        expect(handle.get().state).toBe("interrupted");
        yield* handle.tools.add([tool("search")]);
        expect(inputs).toHaveLength(1);
        yield* handle.resume();
        expect(inputs.map((input) => [input.toolsGeneration, input.resumeCount])).toEqual([
          [1, 0],
          [2, 1],
        ]);
        expect(inputs[1]?.tools.map((entry) => entry.name)).toEqual(["read", "search"]);
        const actions = tree(handle.id);
        const terminal = actions.find(
          (action) => SessionHandleStore.turnTerminal(action)?.kind === "interrupted",
        );
        const selected = actions.find(
          (action) => action.kind === "session.configure" && action.ordinal > 1,
        );
        const resumed = actions.find(
          (action) => SessionHandleStore.turnIntent(action)?.toolsGeneration === 2,
        );
        if (terminal === undefined || selected === undefined || resumed === undefined)
          throw new Error("missing immediate configure boundary");
        expect(terminal.ordinal).toBeLessThan(selected.ordinal);
        expect(selected.ordinal).toBeLessThan(resumed.ordinal);
        expect(deliveryRows(handle.id).map((item) => item.kind)).toEqual([
          "prompt",
          "interrupt",
          "resume",
        ]);
      }),
    ));

  test("rejects an existing tool name before committing a configure action", () =>
    testProgram(
      Effect.gen(function* () {
        const runner: SessionRunner = () =>
          Effect.sync(() => {
            return { kind: "result", text: "unused" };
          });
        const handle = yield* declare(residentOptions("duplicate-tool", runner));
        const before = handle.get();

        expect(yield* failure(awaitSignal(handle.tools.add([tool("read")])))).toMatchObject({
          name: "SessionConfigureError",
          data: { code: "duplicate_tool" },
        });

        expect(handle.get()).toEqual(before);
        expect(
          tree(handle.id).filter((action) => action.kind === "session.configure"),
        ).toHaveLength(1);
      }),
    ));

  test("a reactivated handle removes a tool from the next runner generation", () =>
    testProgram(
      Effect.gen(function* () {
        const { runner, inputs } = recordingRunner("complete");
        const handle = yield* declare({
          ...residentOptions("remove-after-reactivation", runner),
          tools: [tool("read"), tool("search")],
        });

        yield* awaitSignal(handle.prompt("hibernate the original controller"));
        const receipt = yield* awaitSignal(handle.tools.remove(["read"]));
        yield* awaitSignal(handle.prompt("use the configured generation"));

        expect(receipt).toEqual({ generation: 2, revertTo: 1 });
        expect(inputs.at(-1)?.tools.map((entry) => entry.name)).toEqual(["search"]);
      }),
    ));

  test("a reactivated handle replaces system blocks for the next runner generation", () =>
    testProgram(
      Effect.gen(function* () {
        const { runner, inputs } = recordingRunner("complete");
        const handle = yield* declare(residentOptions("blocks-after-reactivation", runner));
        const nextBlocks = [{ id: "safety", source: "operator", content: "Use the safe path." }];

        yield* awaitSignal(handle.prompt("hibernate the original controller"));
        const receipt = yield* awaitSignal(handle.system.blocks.set(nextBlocks));
        yield* awaitSignal(handle.prompt("use the configured generation"));

        expect(receipt).toEqual({ generation: 2, revertTo: 1 });
        expect(inputs).toHaveLength(2);
        expect(inputs[1]?.systemHash).not.toBe(inputs[0]?.systemHash);
        expect(inputs[1]?.tools.map((entry) => entry.name)).toEqual(["read"]);
        expect(SessionHandleStore.latestGeneration(tree(handle.id)).systemBlocks).toEqual(
          nextBlocks,
        );
      }),
    ));

  test("evicts idle runtime state while a retained handle can rehydrate it", () =>
    testProgram(
      Effect.gen(function* () {
        let hibernations = 0;
        const hibernated = signal<void>();
        suite.runtime = track({
          ...suite.runtime,
          onHibernate: () =>
            Effect.sync(() => {
              hibernations += 1;
              hibernated.resolve();
            }),
        });
        const runner: SessionRunner = () =>
          Effect.sync(() => {
            return { kind: "result", text: "complete" };
          });
        const options = residentOptions("hibernate", runner);
        const first = yield* declare(options);

        yield* awaitSignal(first.prompt("sleep after this"));
        yield* awaitSignal(bounded(hibernated.promise, "runtime hibernation"));
        const snapshot = first.get();
        const fenceBeforeGet = snapshot.lease.fence;
        const reopened = yield* declare(options);

        expect(snapshot.state).toBe("idle");
        expect(snapshot.turns.at(-1)?.messages).toEqual([
          { role: "user", text: "sleep after this" },
          { role: "assistant", text: "complete" },
        ]);
        expect(hibernations).toBe(1);
        expect(reopened).not.toBe(first);
        // Redeclaring installs a fresh activation, which adopts the next fence eagerly.
        expect(first.get().lease.fence).toBe(fenceBeforeGet + 1);
        yield* awaitSignal(first.prompt("wake again"));
        expect(first.get().lease.fence).toBe(fenceBeforeGet + 1);
        expect(hibernations).toBe(2);
      }),
    ));

  test("a hibernated handle routes restore and close through its live successor", () =>
    testProgram(
      Effect.gen(function* () {
        const hibernated = signal<void>();
        suite.runtime = track({ ...suite.runtime, onHibernate: () => Effect.sync(() => hibernated.resolve()) });
        const runner: SessionRunner = () =>
          Effect.sync(() => {
            return { kind: "result", text: "complete" };
          });
        const options = residentOptions("hibernate-successor", runner);
        const first = yield* declare(options);
        yield* awaitSignal(bounded(first.prompt("sleep after this"), "first prompt"));
        yield* awaitSignal(bounded(hibernated.promise, "runtime hibernation"));
        const successor = yield* declare(options);
        expect(successor).not.toBe(first);

        expect(
          yield* Effect.flip(first.restoreContext("missing-compaction")),
        ).toMatchObject({
          _tag: "ContextRestoreError",
          reason: "unknown_compaction",
        });
        yield* awaitSignal(bounded(first.close(), "close through successor"));
        expect(yield* Effect.flip(successor.prompt("after close"))).toMatchObject({
          _tag: "AgentFailure",
          operation: "session.handle",
          cause: "closed",
        });
        expect(yield* Effect.flip(first.prompt("after close"))).toMatchObject({
          _tag: "AgentFailure",
          operation: "session.handle",
          cause: "closed",
        });
      }),
    ));

  test("approval answers reach only a turn's live approvals", () =>
    testProgram(
      Effect.gen(function* () {
        const answers: Parameters<ExecutionApprovals["answer"]>[0][] = [];
        const entered = signal<void>();
        const release = signal<void>();
        const livePending: ExecutionApprovalRequest[] = [];
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.gen(function* () {
            input.bindApprovals?.({
              pending: () => livePending,
              notify: () => undefined,
              answer: (answer: Parameters<ExecutionApprovals["answer"]>[0]) =>
                Effect.sync(() => {
                  answers.push(answer);
                }),
            });
            entered.resolve();
            yield* awaitSignal(release.promise);
            return { kind: "result", text: "done" };
          });
        const handle = yield* declare(residentOptions("approval-routing", runner));
        const request = approvalRequest(handle.id, "turn");
        livePending.push(request);
        const answer = {
          request,
          credential: "owner-token",
          decision: "approve",
        } as const;
        expect(handle.approvals.pending()).toEqual([]);
        expect(yield* Effect.flip(awaitSignal(handle.approvals.answer(answer)))).toMatchObject({
          code: "stale_approval",
        });
        const prompted = yield* Effect.forkChild(handle.prompt("needs approval"));
        yield* awaitSignal(bounded(entered.promise, "runner entry"));
        expect(handle.approvals.pending()).toBe(livePending);
        yield* awaitSignal(bounded(handle.approvals.answer(answer), "routed answer"));
        expect(answers).toEqual([answer]);
        release.resolve();
        yield* awaitSignal(bounded(prompted, "prompt completion"));
      }),
    ));

  test("resume after interruption carries no prompt content into the runner", () =>
    testProgram(
      Effect.gen(function* () {
        const firstEntered = signal<SessionRunnerInput>();
        const firstAborted = signal<void>();
        const resumed = signal<SessionRunnerInput>();
        let entries = 0;
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.gen(function* () {
            entries += 1;
            if (entries === 1) {
              firstEntered.resolve(input);
              input.signal.addEventListener("abort", () => firstAborted.resolve(), { once: true });
              yield* awaitSignal(firstAborted.promise);
              return { kind: "interrupted" };
            }
            resumed.resolve(input);
            return { kind: "result", text: "resumed" };
          });
        const handle = yield* declare(residentOptions("content-free-resume", runner));

        const first = yield* Effect.forkChild(handle.prompt("original prompt"));
        const firstInput = yield* awaitSignal(
          bounded(firstEntered.promise, "initial runner entry"),
        );
        yield* awaitSignal(handle.interrupt());
        yield* awaitSignal(bounded(first, "interrupted turn"));
        const resume = yield* Effect.forkChild(handle.resume());
        const resumedInput = yield* awaitSignal(bounded(resumed.promise, "resumed runner entry"));
        yield* awaitSignal(bounded(resume, "resumed turn"));

        expect(resumedInput.messages).toEqual(firstInput.messages);
        expect(resumedInput.resumeCount).toBe(1);
        expect(
          deliveries(handle.id)
            .filter((item) => item.kind === "resume")
            .map((item) => item.content),
        ).toEqual([""]);
      }),
    ));

  test.each(["result", "error", "interrupted"] as const)(
    "child %s terminal offers the original parent letter to the atomic commit port",
    (kind: "interrupted" | "error" | "result") =>
      testProgram(
        Effect.gen(function* () {
          const parent = yield* declare(
            residentOptions("request-parent", () =>
              Effect.sync(() => {
                return { kind: "result", text: "parent" };
              }),
            ),
          );
          // The parent's original letter, appended under its live activation's authority.
          const parentRow = kernel().row(parent.id);
          if (parentRow.fenceOwner === null) throw new Error("parent activation owns no fence");
          yield* kernel().commit({
            sessionId: parent.id,
            owner: parentRow.fenceOwner,
            fence: parentRow.fence,
            now,
            expectedRevision: parentRow.revision,
            state: parentRow.state,
            actions: [
              {
                id: "original-send",
                sessionId: parent.id,
                parentId: tree(parent.id).at(-1)?.id ?? null,
                kind: "message",
                intent: { encodingVersion: 1, value: { phase: "intent", messageId: "request" } },
                effect: { encodingVersion: 1, value: { phase: "pending" } },
                irreversible: true,
                ts: now,
              },
            ],
          });
          let commits = 0;
          const childRuntime = track({
            ...suite.runtime,
            dispatchOutbound: ({
              message,
            }: Parameters<NonNullable<SessionFixture["dispatchOutbound"]>>[0]) =>
              Effect.gen(function* () {
                commits += 1;
                expect(
                  tree(message.sourceSessionId).some(
                    (action) => SessionHandleStore.turnTerminal(action) !== undefined,
                  ),
                ).toBe(true);
                expect(kernel().outboundRows(message.sourceSessionId)[0]?.state).toBe("pending");
                expect(deliveryRows(parent.id)).toEqual([]);
                expect(message).toMatchObject({
                  requestId: "original-send",
                  replyTo: "original-binding",
                  sourceSessionId: "reply-child",
                  terminal: kind === "result" ? "completed" : kind,
                });
                return (yield* commitDelivery({
                  id: message.messageId,
                  sessionId: message.destinationSessionId,
                  kind: "prompt",
                  content: message.content,
                  createdAt: now,
                  parentActionId: tree(message.destinationSessionId).at(-1)?.id ?? null,
                  origin: { encodingVersion: 1, value: PlainValueSchema.parse(message) },
                })).receipt;
              }),
          });
          const child = yield* declare(
            {
              id: "reply-child",
              parentId: parent.id,
              role: "child",
              tools: [],
              system,
              runner: () =>
                Effect.sync(() => {
                  return { kind, text: "terminal-text" };
                }),
            },
            childRuntime,
          );
          yield* awaitSignal(
            child.prompt("work", {
              encodingVersion: 1,
              value: {
                kind: "message",
                messageId: "request",
                senderSessionId: parent.id,
                sourceActionId: "original-send",
                replyTo: "original-binding",
                deadline: now + 1000,
              },
            }),
          );
          expect(commits).toBe(1);
          expect(deliveryRows(parent.id).map((row) => row.content)).toEqual(["terminal-text"]);
          expect(terminals(child.id).map((terminal) => terminal.kind)).toEqual([kind]);
        }),
      ),
  );

  test("materializes a child as a parent-linked session with an independent fence", () =>
    testProgram(
      Effect.gen(function* () {
        const runner: SessionRunner = () =>
          Effect.sync(() => {
            return { kind: "result", text: "done" };
          });
        const parent = yield* declare(residentOptions("resident-parent", runner));
        const child = yield* declare({
          id: "child-session",
          parentId: parent.id,
          role: "child",
          runner,
          tools: [tool("read")],
          system,
        });

        yield* awaitSignal(child.prompt("do the work"));

        expect(child.id.startsWith("delegation-")).toBe(false);
        expect(child.get()).toMatchObject({ parentId: parent.id, role: "child" });
        // Each activation adopted its own first fence; neither borrowed the other's.
        expect(kernel().row(parent.id).fence).toBe(1);
        expect(kernel().row(child.id).fence).toBe(1);
      }),
    ));
});
