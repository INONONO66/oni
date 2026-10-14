import { turnTerminal, openTurns } from "../src/core/store/session-reads";
import { describe, expect, test } from "bun:test";
import { Effect, } from "effect";
import type { SessionTurn } from "@openomni/protocol";
import type { SessionRunner, SessionRunnerInput } from "../src/core/session/run";

import { awaitSignal, boundedSignal as bounded } from "./helpers/g0-signals";
import {
  commitDelivery,
  commitOpenTurn,
  declare,
  deliveries,
  deliveryRows,
  kernel,
  now,
  pendingDeliveries,
  policyHook,
  reactivate,
  residentOptions,
  signal,
  suite,
  testProgram,
  tree,
  useSessionHandleSuite,
} from "./helpers/session-handle-suite";

// #1348: split from session-handle.test.ts — crash recovery and observation.

useSessionHandleSuite();

describe("session crash recovery and observation", () => {
  test("reactivation resumes with the original pre-minted result id", () =>
    testProgram(
      Effect.gen(function* () {
        yield* commitOpenTurn({
          sessionId: "crashed-turn",
          resultId: "preminted-result",
          resumeCount: 0,
        });
        const entered = signal<SessionRunnerInput>();
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.sync(() => {
            entered.resolve(input);
            return { kind: "result", text: "recovered" };
          });

        const waking = yield* Effect.forkChild(reactivate("crashed-turn", runner));
        const input = yield* awaitSignal(bounded(entered.promise, "recovered runner entry"));
        yield* awaitSignal(bounded(waking, "reactivation terminal"));

        expect(input.resultId).toBe("preminted-result");
        expect(input.resumeCount).toBe(1);
        const terminal = tree("crashed-turn").find(
          (action) => turnTerminal(action) !== undefined,
        );
        expect(terminal?.id).toBe("preminted-result");
        expect(openTurns(tree("crashed-turn"))).toEqual([]);
      }),
    ));

  test("reactivation refuses an open turn whose pinned generation no longer matches the ledger", () =>
    testProgram(
      Effect.gen(function* () {
        yield* commitOpenTurn({
          sessionId: "drifted-turn",
          resultId: "drifted-result",
          resumeCount: 0,
          toolsHash: "not-the-recorded-tools",
        });
        let runs = 0;
        const waking = yield* Effect.forkChild(
          reactivate("drifted-turn", () =>
            Effect.sync(() => {
              runs += 1;
              return { kind: "result", text: "must not run" };
            }),
          ),
        );
        expect(yield* Effect.flip(awaitSignal(waking))).toMatchObject({
          _tag: "GenerationUnavailable",
          generation: 1,
        });
        expect(runs).toBe(0);
        expect(openTurns(tree("drifted-turn"))).toHaveLength(1);
      }),
    ));

  test("a prompt denied at a mid-turn boundary is consumed and fails the runner's drain", () =>
    testProgram(
      Effect.gen(function* () {
        yield* commitOpenTurn({
          sessionId: "boundary-deny",
          resultId: "boundary-result",
          resumeCount: 0,
        });
        const drained = signal<Effect.Error<ReturnType<SessionRunnerInput["boundary"]>>>();
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.gen(function* () {
            // #1253: a steer row is the mid-turn consumable; followUp waits for turn end.
            yield* commitDelivery({
              id: "boundary-deny:late",
              sessionId: input.sessionId,
              kind: "prompt",
              content: "late prompt",
              origin: { encodingVersion: 1, value: { source: "test" } },
              createdAt: now,
              parentActionId: tree(input.sessionId).at(-1)?.id ?? null,
              delivery: "steer",
            });
            const boundary = yield* Effect.result(input.boundary("after_tools"));
            if (boundary._tag === "Failure") {
              drained.resolve(boundary.failure);
              return yield* Effect.fail(boundary.failure);
            }
            return { kind: "result", text: JSON.stringify(boundary.success) };
          });
        yield* awaitSignal(bounded(reactivate("boundary-deny", runner), "reactivation terminal"));
        expect(yield* awaitSignal(bounded(drained.promise, "boundary refusal"))).toMatchObject({
          _tag: "AgentFailure",
          operation: "session.prompt",
          cause: "late prompt refused",
        });
        const actions = tree("boundary-deny");
        expect(
          turnTerminal(
            actions.find((action) => action.id === "boundary-result"),
          ),
        ).toMatchObject({ kind: "error" });
        expect(
          actions.filter((action) => action.kind === "policy.decision").map(policyHook),
        ).toEqual(["turn.pre", "prompt.pre"]);
        // The chain is the queue: consuming the blocked prompt IS a delivery
        // action, bound to its durable delivery identity instead of the open turn.
        expect(deliveries("boundary-deny")).toMatchObject([
          { turnId: "boundary-deny:late", deliveryId: "boundary-deny:late", kind: "prompt" },
        ]);
        expect(deliveryRows("boundary-deny").map((row) => row.status)).toEqual(["consumed"]);
      }),
      {
        policies: [
          {
            name: "deny-boundary-prompt",
            kind: "prompt",
            phase: "pre",
            match: { encodingVersion: 1, value: { op: "delivery", sessionId: "boundary-deny" } },
            verdict: {
              encodingVersion: 1,
              value: { type: "deny", reason: "late prompt refused" },
            },
            priority: 2_000,
          },
        ],
      },
    ));

  test("reactivation seals a durable interrupt before admitting an open turn", () =>
    testProgram(
      Effect.gen(function* () {
        yield* commitOpenTurn({
          sessionId: "cancelled-turn",
          resultId: "cancelled-result",
          resumeCount: 0,
        });
        yield* commitDelivery({
          id: "cancel-request",
          sessionId: "cancelled-turn",
          kind: "interrupt",
          content: "",
          createdAt: now,
          origin: { encodingVersion: 1, value: { kind: "sdk" } },
          parentActionId: "cancelled-turn:turn",
        });
        const prefix = tree("cancelled-turn");
        let runnerEntries = 0;
        yield* awaitSignal(
          bounded(
            reactivate("cancelled-turn", () =>
              Effect.sync(() => {
                runnerEntries += 1;
                return { kind: "result", text: "must not run" };
              }),
            ),
            "cancelled open turn seal",
          ),
        );
        expect(runnerEntries).toBe(0);
        const actions = tree("cancelled-turn");
        expect(actions.slice(0, prefix.length)).toEqual(prefix);
        expect(
          turnTerminal(
            actions.find((action) => action.id === "cancelled-result"),
          ),
        ).toMatchObject({ kind: "interrupted", turnId: "cancelled-turn:turn", resumeCount: 0 });
        expect(pendingDeliveries("cancelled-turn")).toEqual([]);
      }),
    ));

  test("reactivation seals error at resume budget ten without entering the runner", () =>
    testProgram(
      Effect.gen(function* () {
        yield* commitOpenTurn({
          sessionId: "poison-turn",
          resultId: "poison-result",
          resumeCount: 10,
        });
        let runnerEntries = 0;
        const runner: SessionRunner = () =>
          Effect.sync(() => {
            runnerEntries += 1;
            return { kind: "result", text: "must not run" };
          });

        yield* awaitSignal(bounded(reactivate("poison-turn", runner), "resume budget terminal"));

        expect(runnerEntries).toBe(0);
        const terminalAction = tree("poison-turn").find(
          (action) => action.id === "poison-result",
        );
        expect(turnTerminal(terminalAction)).toMatchObject({
          kind: "error",
          resumeCount: 10,
        });
      }),
    ));

  test("a resume for an interrupted session without any terminal is consumed as a no-op", () =>
    testProgram(
      Effect.gen(function* () {
        const runs: string[] = [];
        const handle = yield* declare(
          residentOptions("interrupted-without-terminal", (input: SessionRunnerInput) =>
            Effect.sync(() => {
              runs.push(input.turnId);
              return { kind: "result", text: "never" };
            }),
          ),
        );
        // An earlier activation left the durable state interrupted with no open
        // turn and no terminal; the mark rides the live activation's authority.
        const row = kernel().row(handle.id);
        if (row.fenceOwner === null) throw new Error("activation owns no fence");
        yield* kernel().commit({
          sessionId: handle.id,
          owner: row.fenceOwner,
          fence: row.fence,
          now,
          expectedRevision: row.revision,
          actions: [],
          state: "interrupted",
        });

        expect(
          yield* awaitSignal(bounded(handle.resume(), "resume without terminal")),
        ).toBeUndefined();
        expect(runs).toEqual([]);
        expect(handle.get().state).toBe("interrupted");
        expect(pendingDeliveries(handle.id)).toEqual([]);
        // Exactly one delivery: the consumed resume, bound to its own delivery
        // identity rather than to any turn.
        const [delivery, ...rest] = deliveries(handle.id);
        expect(rest).toEqual([]);
        if (delivery === undefined) throw new Error("resume produced no delivery");
        expect(delivery).toMatchObject({ kind: "resume", boundary: "before_llm" });
        expect(delivery.turnId).toBe(delivery.deliveryId);
        expect(deliveryRows(handle.id).map((row) => ({ id: row.id, status: row.status }))).toEqual([
          { id: delivery.deliveryId, status: "consumed" },
        ]);
      }),
    ));

  test("watch reports a revision gap and get replaces state after a dropped observation", () =>
    testProgram(
      Effect.gen(function* () {
        const handle = yield* declare(
          residentOptions("watched-session", () =>
            Effect.sync(() => {
              return { kind: "result", text: "unused" };
            }),
          ),
        );
        const configureId = tree(handle.id)[0]?.id;
        if (configureId === undefined) throw new Error("missing configure action");
        const watch = handle.watch();
        const observed = signal<SessionTurn.Observation>();
        const stop = watch.subscribe(observed.resolve);
        suite.sink.dropNextCommit = true;

        yield* commitDelivery({
          id: "watched-session:prompt-1",
          sessionId: "watched-session",
          kind: "prompt",
          content: "first",
          origin: { encodingVersion: 1, value: { source: "test" } },
          createdAt: now + 1,
          parentActionId: configureId,
        });
        yield* commitDelivery({
          id: "watched-session:prompt-2",
          sessionId: "watched-session",
          kind: "prompt",
          content: "second",
          origin: { encodingVersion: 1, value: { source: "test" } },
          createdAt: now + 2,
          parentActionId: "watched-session:prompt-1",
        });

        expect(yield* awaitSignal(bounded(observed.promise, "revision gap"))).toEqual({
          kind: "gap",
          sessionId: "watched-session",
          from: watch.snapshot.revision,
          to: 3,
        });
        expect(handle.get().revision).toBe(3);
        stop();
        watch.unsubscribe();
      }),
    ));
});
