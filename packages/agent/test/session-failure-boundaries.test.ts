import { sessionTree } from "./helpers/session-tree";
import {
  allowConfigure,
  isolatedRuntime,
  type SessionFixture,
  withSessionServices,
} from "./helpers/session-services";
import { expect, spyOn, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { PlainObjectSchema, type LedgerAction, type LedgerSession } from "@oni/protocol";
import type { SessionHandle, SessionRunnerInput } from "../src/core/session/run";
import { session } from "../src/testing/registry";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { openRequest } from "./helpers/open-request";
import { seedPolicy } from "./helpers/seed-policy";

// W5.2: lease TTL/expiry is gone; writer authority is the adopted fence. The old
// "expired lease" boundaries reshape onto foreign fence adoption (takeover), and a
// waiting/idle terminal keeps `lease.owner` durable (there is no release plane).
/** Foreign takeover, then a request transition must refuse as stale without appending rows. */
function usurpedTransitionRefusal(handle: SessionHandle, turnId: string) {
  return Effect.gen(function* () {
    const kernel = isolatedLedger().kernel;
    yield* kernel.adoptFence({
      sessionId: handle.id,
      owner: "other",
      fence: kernel.row(handle.id).fence + 1,
    });
    const before = kernel.row(handle.id);
    const request = openRequest({
      requestId: "request",
      sessionId: handle.id,
      turnId,
      callId: "call",
    });
    expect(
      yield* Effect.flip(
        handle.requests.transition({ kind: "request.open", request }, "open", 100),
      ),
    ).toMatchObject({
      _tag: "CommitFailed",
      error: { _tag: "FenceRefused", reason: "stale", holder: "other", fence: before.fence },
    });
    expect(kernel.row(handle.id)).toEqual(before);
    expect(kernel.requestRows(handle.id)).toEqual([]);
    return before;
  });
}

/** One pending tool intent under the runner's turn; commit failures are defects here. */
function commitPendingTool(input: SessionRunnerInput, id: string) {
  return input.ledger
    .commit({
      id,
      sessionId: input.sessionId,
      parentId: input.turnId,
      kind: "tool",
      intent: { encodingVersion: 1, value: { phase: "intent", turnId: input.turnId } },
      effect: { encodingVersion: 1, value: { phase: "pending" } },
      ts: 100,
      irreversible: true,
    })
    .pipe(Effect.orDie);
}

/** Fork the first prompt and wait until the runner has entered. */
function promptUntilEntered(handle: SessionHandle, entered: Deferred.Deferred<SessionRunnerInput>) {
  return Effect.gen(function* () {
    const running = yield* Effect.forkChild(handle.prompt("start"));
    const input = yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"));
    return { running, input };
  });
}

/** Zero-grace close fixture plus the runner-entry gate. */
function zeroGraceFixture(): Effect.Effect<{ entered: Deferred.Deferred<SessionRunnerInput>; fixture: SessionFixture }> {
  return Effect.gen(function* () {
    seedPolicy();
    const entered = yield* Deferred.make<SessionRunnerInput>();
    const fixture: SessionFixture = { ...runtime(), closeGraceMs: 0 };
    return { entered, fixture };
  });
}

function runtime(): SessionFixture {
  return {
    authorizeConfigure: allowConfigure,
    observations: { publish: (): void => undefined },
    clock: (): number => 100,
    ...isolatedRuntime(),
  };
}

test("a completed turn's captured ledger rejects late writes without appending", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        seedPolicy();
        const entered = yield* Deferred.make<SessionRunnerInput>();
        const fixture = runtime();
        const handle = yield* withSessionServices(
          session(
            {
              id: "late-write",
              role: "resident",
              runner: (input: SessionRunnerInput) =>
                Deferred.succeed(entered, input).pipe(
                  Effect.as({ kind: "result" as const, text: "done" }),
                ),
            },
            fixture,
          ),
          fixture,
        );
        yield* handle.prompt("start");
        const input = yield* Deferred.await(entered);
        const kernel = isolatedLedger().kernel;
        const before = sessionTree(kernel, handle.id);
        const action: LedgerAction.Append = {
          id: "late",
          sessionId: handle.id,
          parentId: input.turnId,
          kind: "tool",
          intent: { encodingVersion: 1, value: {} },
          effect: { encodingVersion: 1, value: {} },
          ts: 100,
          irreversible: true,
        };
        expect(yield* Effect.flip(input.ledger.commit(action))).toMatchObject({
          _tag: "CommitRefused",
          sessionId: handle.id,
          reason: "fence",
        });
        expect(sessionTree(kernel, handle.id)).toEqual(before);
      }),
    ),
  ));

test("request transitions refuse a usurped fence beneath a live runner without appending rows", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        seedPolicy();
        const entered = yield* Deferred.make<SessionRunnerInput>();
        const release = yield* Deferred.make<void>();
        const fixture = runtime();
        const handle = yield* withSessionServices(
          session(
            {
              id: "usurped-transition",
              role: "resident",
              runner: (input: SessionRunnerInput) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, input);
                  yield* Deferred.await(release);
                  return { kind: "result", text: "done" };
                }),
            },
            fixture,
          ),
          fixture,
        );
        const { running, input } = yield* promptUntilEntered(handle, entered);
        const kernel = isolatedLedger().kernel;
        // Foreign takeover: a strictly newer fence adoption makes the live writer stale.
        const before = yield* usurpedTransitionRefusal(handle, input.turnId);
        yield* Deferred.succeed(release, undefined);
        // The usurped writer can never seal its turn: the fenced commit refuses durably.
        expect(yield* Effect.flip(Fiber.join(running))).toMatchObject({ _tag: "CommitFailed" });
        expect(kernel.row(handle.id)).toEqual(before);
      }),
    ),
  ));

test("an idle request transition preserves a competing owner's fence and typed refusal", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        seedPolicy();
        const fixture = runtime();
        const handle = yield* withSessionServices(
          session(
            {
              id: "held-transition",
              role: "resident",
              runner: () => Effect.succeed({ kind: "result", text: "unused" }),
            },
            fixture,
          ),
          fixture,
        );
        yield* usurpedTransitionRefusal(handle, "turn");
      }),
    ),
  ));

for (const count of [1, 257]) {
  test(`zero-grace shutdown seals ${count} open turns and pending tools under the retained fence`, () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const { entered, fixture } = yield* zeroGraceFixture();
          const handle = yield* withSessionServices(
            session(
              {
                id: "shutdown-pending",
                role: "resident",
                runner: (input: SessionRunnerInput) =>
                  Effect.gen(function* () {
                    const turn = input.kernel.actionById(input.turnId);
                    if (turn === undefined) throw new Error("missing active turn");
                    const intent = PlainObjectSchema.parse(turn.intent.value);
                    for (let index = 1; index < count; index += 1) {
                      yield* input.ledger
                        .commit({
                          id: `open-turn:${index}`,
                          sessionId: input.sessionId,
                          parentId: input.turnId,
                          kind: "turn",
                          intent: {
                            encodingVersion: 1,
                            value: { ...intent, resultId: `open-turn:${index}:result` },
                          },
                          effect: { encodingVersion: 1, value: { phase: "pending" } },
                          ts: 100,
                          irreversible: true,
                        })
                        .pipe(Effect.orDie);
                    }
                    // All operations belong to the oldest turn, beyond the first reverse page.
                    for (let index = 0; index < count; index += 1) {
                      yield* commitPendingTool(input, `pending-tool:${index}`);
                    }
                    yield* Deferred.succeed(entered, input);
                    return yield* Effect.never;
                  }),
              },
              fixture,
            ),
            fixture,
          );
          const { running, input } = yield* promptUntilEntered(handle, entered);
          yield* handle.close();
          yield* Fiber.join(running);
          const kernel = isolatedLedger().kernel;
          for (let index = 0; index < count; index += 1) {
            expect(kernel.resultFor(handle.id, `pending-tool:${index}`)?.effect.value).toEqual({
              phase: "result",
              terminal: "outcome_unknown",
              reason: "shutdown_grace_exhausted",
            });
            const turnId = index === 0 ? input.turnId : `open-turn:${index}`;
            expect(kernel.turnTerminalFor(handle.id, turnId)?.kind).toBe("interrupted");
          }
          expect(kernel.openTurnsPage(handle.id)).toEqual([]);
          expect(kernel.openOperationsPage(handle.id, input.turnId)).toEqual([]);
          // No release plane: the adopted fence owner stays durable after shutdown.
          expect(kernel.row(handle.id).fenceOwner).not.toBeNull();
        }),
      ),
    ));
}

test("zero-grace shutdown rescans when an executor terminal lands after its seal scan", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const { entered, fixture } = yield* zeroGraceFixture();
        const handle = yield* withSessionServices(
          session(
            {
              id: "shutdown-race",
              role: "resident",
              runner: (input: SessionRunnerInput) =>
                Effect.gen(function* () {
                  yield* commitPendingTool(input, "racing-tool");
                  yield* Deferred.succeed(entered, input);
                  return yield* Effect.never;
                }),
            },
            fixture,
          ),
          fixture,
        );
        const { running, input } = yield* promptUntilEntered(handle, entered);
        const kernel = isolatedLedger().kernel;
        const sessions = isolatedLedger().session.sessions;
        const commit = sessions.commit;
        const terminalReason = (action: LedgerAction.Append) =>
          action.parentId === "racing-tool" && action.kind === "tool"
            ? PlainObjectSchema.parse(action.effect.value).reason
            : undefined;
        let sealAttempts = 0;
        const executorTerminal: LedgerAction.Append = {
          id: "racing-tool:result",
          sessionId: handle.id,
          parentId: "racing-tool",
          kind: "tool",
          intent: { encodingVersion: 1, value: { phase: "result" } },
          effect: {
            encodingVersion: 1,
            value: {
              phase: "result",
              terminal: "outcome_unknown",
              reason: "raw_body_unsettled_after_grace",
            },
          },
          ts: 100,
          irreversible: true,
        };
        // The executor's own grace terminal for the pending tool lands between the seal's scan and its CAS commit.
        const race = spyOn(sessions, "commit").mockImplementation((batch: LedgerSession.Commit) => {
          if (!batch.actions.map(terminalReason).includes("shutdown_grace_exhausted"))
            return commit(batch);
          sealAttempts += 1;
          const current = kernel.row(handle.id);
          return commit({
            sessionId: handle.id,
            owner: batch.owner,
            fence: batch.fence,
            now: batch.now,
            expectedRevision: current.revision,
            actions: [executorTerminal],
            state: current.state,
          }).pipe(Effect.andThen(commit(batch)));
        });
        try {
          yield* handle.close().pipe(Effect.timeout("5 seconds"));
        } finally {
          race.mockRestore();
        }
        yield* Fiber.join(running);
        expect(sealAttempts).toBe(1);
        const toolRows = sessionTree(kernel, handle.id).filter(
          (action) => action.kind === "tool" && action.parentId === "racing-tool",
        );
        expect(toolRows.map(terminalReason)).toEqual(["raw_body_unsettled_after_grace"]);
        expect(kernel.turnTerminalFor(handle.id, input.turnId)?.kind).toBe("interrupted");
        expect(kernel.openTurnsPage(handle.id)).toEqual([]);
        expect(kernel.openOperationsPage(handle.id, input.turnId)).toEqual([]);
        expect(
          sessionTree(kernel, handle.id)
            .filter(
              (action) =>
                (action.kind === "prompt" || action.kind === "signal") &&
                PlainObjectSchema.parse(action.effect.value).deliveryKind !== undefined,
            )
            .map((action) => PlainObjectSchema.parse(action.effect.value).deliveryKind),
        ).toEqual(["prompt", "interrupt"]);
        // No release plane: the adopted fence owner stays durable after shutdown.
        expect(kernel.row(handle.id).fenceOwner).not.toBeNull();
      }),
    ),
  ));
