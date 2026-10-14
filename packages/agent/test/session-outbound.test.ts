import { turnTerminal } from "../src/core/store/session-reads";
import { sessionTree } from "./helpers/session-tree";
import { allowConfigure, isolatedRuntime, type SessionFixture as SessionRuntime, type SessionFixture, withSessionServices, } from "./helpers/session-services";
import { Cause, Effect, Exit, Scope } from "effect";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { seedPolicy } from "./helpers/seed-policy";
import { receiveOutbound, failure, foreign } from "./helpers/effect-g2";
import { isolated, isolatedLedger } from "./helpers/isolated";

import { closeSessions, type SessionRunner } from "../src/core/session/run";
import { session } from "../src/testing/registry";
import { resolveSessionRuntime } from "../src/core/session/run";
import { createController } from "../src/testing/controller";
import { reopenableLedger } from "./helpers/reopenable-ledger";
import { canonicalDigest } from "@openomni/protocol";
import { createSessionRequests } from "../src/core/session/request";
import { fileRequest, planeAnswer } from "./helpers/session-request-plane";

/**
 * The deleted Storage-era wake/sweep equivalent (W5.2): recovery is a
 * fresh activation over the isolation's kernel driving its reconcile.
 */
function wake(id: string, runner: SessionRunner, fixture: SessionFixture) {
  return withSessionServices(
    Effect.gen(function* () {
      const resolved = yield* resolveSessionRuntime(fixture);
      const scope = yield* Effect.scope;
      const controller = yield* createController(
        isolatedLedger().kernel,
        id,
        runner,
        resolved,
        {
          reactivate: () => Effect.die(new Error("no reactivation in outbound tests")),
          release: () => undefined,
        },
        scope,
      );
      yield* controller.reconcile();
    }),
    fixture,
  );
}

/** The parent's pending commission answered by the child's outbound reply. */
function appendCommission(): void {
  const { session: store, kernel } = isolatedLedger();
  const receipt = store.actions.append(
    {
      id: "commission-action",
      parentId: null,
      sessionId: "parent",
      kind: "message",
      intent: {
        encodingVersion: 1,
        value: {
          phase: "intent",
          value: { messageId: "commission" },
          effectHash: canonicalDigest({}),
        },
      },
      effect: { encodingVersion: 1, value: { phase: "pending" } },
      ts: 100,
      irreversible: true,
    },
    kernel.row("parent").revision,
  );
  if (receipt === undefined) throw new Error("commission append refused");
}
const origin = {
  encodingVersion: 1 as const,
  value: {
    kind: "message",
    messageId: "commission",
    senderSessionId: "parent",
    sourceActionId: "commission-action",
  },
};
const parentRunner: SessionRunner = () => Effect.succeed({ kind: "result", text: "parent" });
const childRunner: SessionRunner = () => Effect.succeed({ kind: "result", text: "child answer" });
/** One session under the fixture services derived from the given runtime. */
function openSession(runtime: SessionRuntime, options: Parameters<typeof session>[0]) {
  return Effect.gen(function* () {
    const fixture: SessionFixture = runtime;
    return yield* withSessionServices(session(options, fixture), fixture);
  });
}

/** Durable-only parent: materialized and commissioned, with no live handle holding the fence. */
function commissionDurableParent() {
  return Effect.gen(function* () {
    yield* isolatedLedger().kernel.materialize({
      id: "parent",
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 1,
      actionId: "parent-init",
      at: 100,
    });
    appendCommission();
  });
}

/** The canonical outbound runtime: fixed clock, silent sink, given dispatch lane. */
function dispatchRuntime(dispatchOutbound: SessionRuntime["dispatchOutbound"]): SessionRuntime {
  return {
    observations: { publish: () => undefined },
    authorizeConfigure: allowConfigure,
    clock: () => 100,
    ...isolatedRuntime(),
    dispatchOutbound,
  };
}

function commissionedChild(runtime: SessionRuntime) {
  return Effect.gen(function* () {
    seedPolicy();
    yield* Effect.addFinalizer(() => closeSessions(runtime).pipe(Effect.orDie));
    yield* openSession(runtime, { id: "parent", role: "resident", runner: parentRunner });
    appendCommission();
    const child = yield* openSession(runtime, { id: "child", parentId: "parent", role: "child", runner: childRunner });
    return yield* child.prompt("work", origin);
  });
}

test("a dropped receiving consumer leaves a sealed source obligation without mutating its parent", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = dispatchRuntime(() => Effect.fail(foreign("receiver", "unavailable")));
        seedPolicy();
        yield* Effect.addFinalizer(() => closeSessions(runtime).pipe(Effect.orDie));
        yield* openSession(runtime, { id: "parent", role: "resident", runner: parentRunner });
        const child = yield* openSession(runtime, { id: "child", parentId: "parent", role: "child", runner: childRunner });
        const kernel = isolatedLedger().kernel;
        const before = sessionTree(kernel, "parent");
        expect(yield* Effect.flip(child.prompt("work", origin))).toMatchObject({
          _tag: "AgentFailure",
          operation: "receiver",
          cause: "unavailable",
        });
        expect(sessionTree(kernel, "parent")).toEqual(before);
        expect(kernel.pendingMessages("parent")).toEqual([]);
        const source = sessionTree(kernel, "child");
        expect(
          source.filter(
            (action: import("@openomni/protocol").LedgerAction.Node) =>
              turnTerminal(action) !== undefined,
          ),
        ).toHaveLength(1);
        const obligations = kernel.outboundRows("child");
        expect(obligations).toHaveLength(1);
        expect(obligations[0]?.state).toBe("pending");
        expect(obligations[0]?.message.content).toBe("child answer");
      }),
    ),
  ));

test("restart after receiving commit reconciles exact bytes without dispatch or receiver execution", () => {
  const ledger = reopenableLedger("outbound-restart-");
  return isolated(
    Effect.scoped(
      Effect.gen(function* () {
        seedPolicy();
        const scope = yield* Effect.scope;
        const kernel = () => isolatedLedger().kernel;
        let consumed = 0;
        const receive: SessionRunner = () =>
          Effect.sync(() => {
            consumed += 1;
            return { kind: "result" as const, text: "received" };
          });
        const sent: string[] = [];
        const messageIds: string[] = [];
        function runtime(at: number, loseAck: boolean): SessionRuntime {
          const value: SessionRuntime = {
            observations: { publish: () => undefined },
            authorizeConfigure: allowConfigure,
            clock: () => at,
            ...isolatedRuntime(),
            dispatchOutbound: ({
              message,
            }: Parameters<NonNullable<SessionRuntime["dispatchOutbound"]>>[0]) =>
              Effect.gen(function* () {
                sent.push(JSON.stringify(message));
                messageIds.push(message.messageId);
                const received = yield* receiveOutbound(message, at);
                yield* wake(message.destinationSessionId, receive, value).pipe(
                  Effect.provideService(Scope.Scope, scope),
                  Effect.orDie,
                );
                if (loseAck) return yield* foreign("source.ack", "lost");
                return received.receipt;
              }),
          };
          return value;
        }
        let current = runtime(100, true);
        // The parent is durable only: a live parent handle would hold the fence
        // the recovery activation must adopt.
        yield* commissionDurableParent();
        const child = yield* Effect.gen(function* () {
          const fixture: SessionFixture = current;
          return yield* withSessionServices(
            session(
              {
                id: "child",
                parentId: "parent",
                role: "child",
                runner: () => Effect.succeed({ kind: "result", text: "exact answer" }),
              },
              fixture,
            ),
            fixture,
          );
        });
        expect(yield* Effect.flip(child.prompt("work", origin))).toMatchObject({
          _tag: "AgentFailure",
          operation: "source.ack",
          cause: "lost",
        });
        expect(consumed).toBe(1);
        const parentBefore = sessionTree(kernel(), "parent");
        expect(kernel().outboundRows("child")[0]?.state).toBe("pending");
        yield* closeSessions(current);
        ledger.reopen();
        current = runtime(200, false);
        // The startup sweep is gone with the Storage singleton: recovery is a
        // fresh activation over the reopened kernel driving its reconcile. The
        // receiver's durable commit is the proof; a sealed child never replays.
        yield* wake("child", () => Effect.die(new Error("sealed child replayed")), current);
        expect(sent).toHaveLength(1);
        expect(consumed).toBe(1);
        expect(sessionTree(kernel(), "parent")).toEqual(parentBefore);
        // Delivered exactly once: the message is one chain action in the parent.
        expect(
          sessionTree(kernel(), "parent").filter(({ id }) => id === messageIds[0]),
        ).toHaveLength(1);
        expect(kernel().outboundRows("child")[0]?.state).toBe("delivered");
        yield* closeSessions(current);
      }),
    ),
    () => ledger,
  );
});

test("a destination receipt for different bytes is refused and the obligation stays pending", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const prompted = commissionedChild(dispatchRuntime(({
            message,
          }: Parameters<NonNullable<SessionRuntime["dispatchOutbound"]>>[0]) =>
            receiveOutbound({ ...message, content: "tampered answer" }, 100).pipe(
              Effect.map(
                (received: Effect.Success<ReturnType<typeof receiveOutbound>>) => received.receipt,
              ),
            ),
        ));
        expect(yield* failure(prompted)).toBeInstanceOf(Error);
        const kernel = isolatedLedger().kernel;
        expect(kernel.outboundRows("child")).toMatchObject([{ state: "pending" }]);
        expect(
          kernel
            .pendingMessages("parent")
            .map((row: import("@openomni/protocol").Delivery.Row) => row.content),
        ).toEqual(["tampered answer"]);
      }),
    ),
  ));

// W5.2: the lease-release plane is gone, so a steal surfaces exactly one
// stale-fence refusal (the ack commit); there is no release defect anymore.
test("a fence stolen during dispatch surfaces the ack refusal and never marks delivery", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const prompted = commissionedChild(dispatchRuntime(({
            message,
          }: Parameters<NonNullable<SessionRuntime["dispatchOutbound"]>>[0]) =>
            Effect.gen(function* () {
              // W5.2: the lease-TTL plane is gone; a foreign adoption of a
              // strictly newer fence is the steal.
              const kernel = isolatedLedger().kernel;
              yield* kernel
                .adoptFence({
                  sessionId: message.sourceSessionId,
                  owner: "other-runtime",
                  fence: kernel.row(message.sourceSessionId).fence + 1,
                })
                .pipe(Effect.orDie);
              return (yield* receiveOutbound(message, 100)).receipt;
            }),
        ));
        const exit = yield* Effect.exit(prompted);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) throw new Error("expected lost-fence failures");
        expect([
          ...exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error),
          ...exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect),
        ]).toMatchObject([
          {
            _tag: "CommitFailed",
            error: { _tag: "CommitRefused", reason: "fence", sessionId: "child" },
          },
        ]);
        const kernel = isolatedLedger().kernel;
        expect(kernel.outboundRows("child")).toMatchObject([{ state: "pending" }]);
        expect(kernel.row("child").fenceOwner).toBe("other-runtime");
      }),
    ),
  ));

test("outbound insert failure rolls back the source terminal in the same SQLite transaction", () =>
  fileRequest((dbPath) =>
    Effect.gen(function* () {
      using raw = new Database(dbPath);
      raw.run(`CREATE TRIGGER refuse_outbound BEFORE INSERT ON action
    WHEN NEW.kind = 'message' AND json_extract(NEW.intent, '$.op') = 'open'
    BEGIN SELECT RAISE(ABORT, 'test outbound fault'); END`);
      const runtime: SessionFixture = {
        authorizeConfigure: allowConfigure,
        observations: { publish: () => undefined },
        clock: () => 100,
        ...isolatedRuntime(),
        dispatchOutbound: () => Effect.die("dispatch before durable obligation"),
      };
      expect(yield* Effect.flip(commissionedChild(runtime))).toMatchObject({
        _tag: "CommitFailed",
        error: { _tag: "AgentFailure" },
      });
      const kernel = isolatedLedger().kernel;
      expect(
        sessionTree(kernel, "child").filter(
          (action) => turnTerminal(action) !== undefined,
        ),
      ).toEqual([]);
      expect(kernel.outboundRows("child")).toEqual([]);
      expect(kernel.pendingMessages("parent")).toEqual([]);
      expect(kernel.latestOpenTurn("child")).toBeDefined();
      yield* closeSessions(runtime);
    }),
  ));

test("a child answers the original request once and reconciles a lost ACK after SQLite reopen", () => {
  const ledger = reopenableLedger("outbound-restart-");
  return isolated(
    Effect.scoped(
      Effect.gen(function* () {
        seedPolicy();
        let received = 0;
        let sends = 0;
        let childBodies = 0;
        const scope = yield* Effect.scope;
        const kernel = () => isolatedLedger().kernel;
        const receive: SessionRunner = () =>
          Effect.sync(() => {
            received += 1;
            return { kind: "result" as const, text: "received" };
          });
        const runtime: SessionFixture = {
          authorizeConfigure: allowConfigure,
          observations: { publish: () => undefined },
          clock: () => 100,
          ...isolatedRuntime(),
          dispatchOutbound: ({ message }) =>
            Effect.gen(function* () {
              sends += 1;
              const request = kernel().requestById(message.requestId);
              if (request === undefined) throw new Error("request missing");
              const port = yield* withSessionServices(createSessionRequests(runtime), runtime);
              expect(
                yield* port.answer({
                  ...planeAnswer(request, "child", message.messageId),
                  content: message.content,
                  outbound: message,
                }),
              ).toBe("resolved");
              yield* wake("parent", receive, runtime).pipe(Effect.orDie);
              return yield* foreign("source.ack", "lost");
            }).pipe(Effect.provideService(Scope.Scope, scope)),
        };
        // The parent is durable only (no live handle): the reply intake and its
        // consuming wake own the parent fence in turn.
        yield* commissionDurableParent();
        const port = yield* withSessionServices(createSessionRequests(runtime), runtime);
        const request = yield* port.open({
          requestId: "commission-action",
          sessionId: "parent",
          expectedResponders: ["child"],
          correlation: {},
          allowedActions: ["report_result"],
          resolution: "first",
          threshold: 1,
          deadline: 1000,
          at: 100,
        });
        const child = yield* withSessionServices(
          session(
            {
              id: "child",
              parentId: "parent",
              role: "child",
              runner: () =>
                Effect.sync(() => {
                  childBodies += 1;
                  return { kind: "result" as const, text: "original answer" };
                }),
            },
            runtime,
          ),
          runtime,
        );
        expect(yield* Effect.flip(child.prompt("work", origin))).toMatchObject({
          _tag: "AgentFailure",
          operation: "source.ack",
        });
        expect(kernel().requestById(request.requestId)?.state).toBe("resolved");
        expect(kernel().pendingMessages("parent")).toEqual([]);
        const terminals = sessionTree(kernel(), "child").filter(
          (action) => turnTerminal(action) !== undefined,
        );
        const parentBefore = sessionTree(kernel(), "parent");
        yield* closeSessions(runtime);
        ledger.reopen();
        // No receiver is available on restart: the committed receipt must suffice.
        const recovered: SessionFixture = {
          authorizeConfigure: allowConfigure,
          observations: runtime.observations,
          clock: () => 200,
          ...isolatedRuntime(),
        };
        yield* wake("child", () => Effect.die("child replayed"), recovered);
        expect({ received, sends, childBodies }).toEqual({ received: 1, sends: 1, childBodies: 1 });
        expect(sessionTree(kernel(), "parent")).toEqual(parentBefore);
        expect(
          sessionTree(kernel(), "child").filter(
            (action) => turnTerminal(action) !== undefined,
          ),
        ).toEqual(terminals);
        expect(kernel().outboundRows("child")).toMatchObject([{ state: "delivered" }]);
        yield* closeSessions(recovered);
      }),
    ),
    () => ledger,
  );
});
