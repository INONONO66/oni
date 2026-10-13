import { APICallError } from "ai";
import { sessionTree } from "./helpers/session-tree";
import type { ResolvedExecutorOptions } from "../src/core/gate/decide";
import { turnTestLayer, catalogLayer } from "./helpers/service-layers";
import { allowConfigure, isolatedRuntime, type SessionFixture as SessionRuntime, type SessionFixture, withSessionServices } from "./helpers/session-services";
import { Effect, Fiber, Scope } from "effect";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { describe, expect, spyOn, test } from "bun:test";
import { runChatAttempts, answerThenCompact, nullRetryAlarm } from "./helpers/effect-g2";
import { armAction, firedAction } from "../src/core/alarm";
import { OutcomeUnknown, CommitFailed } from "../src/core/failure";
import { seedPolicy } from "./helpers/seed-policy";
import { approveWriteRow } from "./helpers/compiled-policy";
import * as SessionHandleStore from "../src/core/store/fence";
import { LlmRunFailure, type Run } from "../src/model";
import { Alarm, L0Observation, type PolicyRow, type SessionHistory } from "@openomni/protocol";
import { closeSessions, type SessionRunner } from "../src/core/run";
import { createTurnDispatcher } from "../src/plugins/tool";
import { resolveSessionRuntime } from "../src/core/run";
import { createController } from "../src/testing/controller";
import { commitReceivedMessage } from "./helpers/ingress";
import { foldSessionHistory } from "../src/inspect/history";
import { inspectSession } from "../src/inspect";
import { fencedTurnFixture } from "./helpers/fenced-writer";
import { session } from "../src/testing/registry";

const SECRET = "sk-live-credential-never-shown";

/**
 * The deleted Storage-era wake equivalent (W5.2): a fresh activation over the
 * isolation's kernel driving its reconcile.
 */
function wake(id: string, runner: SessionRunner, fixture: SessionFixture) {
  return withSessionServices(Effect.gen(function* () {
    const resolved = yield* resolveSessionRuntime(fixture);
    const wakeScope = yield* Effect.scope;
    const controller = yield* createController(
      isolatedLedger().kernel, id, runner, resolved,
      { reactivate: () => Effect.die(new Error("no reactivation in inspection tests")), release: () => undefined },
      wakeScope,
    );
    yield* controller.reconcile();
  }), fixture);
}
let nextId = 0;
let bodies = 0;
let scope: Scope.Scope;
const runtime: SessionRuntime = {
  authorizeConfigure: allowConfigure,
  observations: { publish: () => undefined },
  clock: () => 1_000,
  entropy: () => `inspect-id-${++nextId}`,
  processId: "inspection-test",
  retryAlarm: nullRetryAlarm,
  ...isolatedRuntime(),
  authorizeApproval: () =>
    Effect.sync(() => {
      return { kind: "owner", principalId: "owner", evidenceId: "auth-1" };
    }),
  dispatchOutbound({ message }: Parameters<NonNullable<SessionRuntime["dispatchOutbound"]>>[0]) {
    return Effect.gen(function* () {
      const received = yield* commitReceivedMessage(isolatedLedger().kernel, {
        id: message.messageId,
        sessionId: message.destinationSessionId,
        kind: "prompt",
        content: message.content,
        origin: { encodingVersion: 1, value: message },
        createdAt: 1_000,
        parentActionId: null,
      }).pipe(
        Effect.mapError(
          (error: import("../src/core/store/errors").LedgerError) => new CommitFailed({ error }),
        ),
      );
      yield* wake(message.destinationSessionId, parentRunner, runtime).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.orDie,
      );
      return received.receipt;
    });
  },
};

const rows: readonly Omit<PolicyRow.Row, "generation">[] = [
  {
    name: "refuse-forbidden",
    kind: "tool",
    phase: "pre",
    match: { encodingVersion: 1, value: { op: "forbidden" } },
    verdict: { encodingVersion: 1, value: { type: "deny", reason: "not_allowed" } },
    priority: 1,
  },
  approveWriteRow,
];

function providerFailure(): Run.Failure {
  return new LlmRunFailure({
    message: "overloaded",
    aborted: false,
    contextOverflow: false,
    visibleOutput: false,
    usage: {
      inputTokens: 1,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    cause: new APICallError({
      message: "overloaded", url: "https://provider.test/v1/messages", requestBodyValues: {},
      statusCode: 529, responseHeaders: { "retry-after-ms": "0" }, isRetryable: true,
    }),
  });
}

/** Waits for the next committed action of `kind` in `sessionId`, subscribed before the trigger. */
function committed(sessionId: string, kind: string): Promise<L0Observation.ActionCommitted> {
  return new Promise((resolve: (event: L0Observation.ActionCommitted) => void) => {
    const stop = isolatedLedger().bus.subscribe(
      L0Observation.ActionCommittedEvent,
      (event: L0Observation.ActionCommitted) => {
        if (event.kind !== kind) return;
        stop();
        resolve(event);
      },
      { match: { sessionId } },
    );
  });
}

/**
 * One real turn: a retried model call, a refused tool, an approved tool carrying a
 * credential, an effect whose outcome is unknown, an answer, and a compaction.
 */
const parentRunner: SessionRunner = (input: import("../src/core/run").SessionRunnerInput) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (input.messages.at(-1)?.text !== "hello") return { kind: "result", text: "noted" };
      const { executor } = (yield* Effect.gen(function* () { const turnInput: Parameters<typeof createTurnDispatcher>[0] & { readonly policy?: ResolvedExecutorOptions["policy"] } = input; const turnRuntime: Parameters<typeof createTurnDispatcher>[1] & Partial<Pick<ResolvedExecutorOptions, "clock" | "entropy" | "observations">> = runtime; return yield* createTurnDispatcher(turnInput, turnRuntime).pipe(Effect.provide(catalogLayer([])), Effect.provide(turnTestLayer(turnInput, turnRuntime))); }));
      let calls = 0;
      yield* runChatAttempts(executor, () =>
        Effect.gen(function* () {
          calls += 1;
          bodies += 1;
          if (calls === 1) return yield* Effect.fail(providerFailure());
          return { type: "stop" };
        }),
      );
      const opened = committed(input.sessionId, "request");
      const wave = yield* Effect.forkScoped(
        executor.runBatch(
          [
            {
              request: {
                kind: "tool",
                op: "forbidden",
                intent: { path: "/etc/shadow" },
                effect: { category: "mutation" },
                toolObservation: { turnId: input.turnId, callId: "call-forbidden" },
              },
              body() {
                return Effect.sync(() => {
                  bodies += 1;
                  return {};
                });
              },
            },
            {
              request: {
                kind: "tool",
                op: "write",
                intent: { path: "approved.txt", apiKey: SECRET },
                effect: { category: "mutation" },
                toolObservation: { turnId: input.turnId, callId: "call-write" },
              },
              body() {
                return Effect.sync(() => {
                  bodies += 1;
                  return { status: "success" };
                });
              },
            },
          ],
          { signal: new AbortController().signal },
        ),
      );
      yield* Effect.promise(() => opened).pipe(Effect.timeout("5 seconds"), Effect.orDie);
      const approvals = executor.approvals;
      const pending = approvals?.pending()[0];
      if (approvals === undefined || pending === undefined)
        throw new Error("approval never opened");
      yield* approvals.answer({ request: pending, credential: "owner", decision: "approve" });
      yield* Fiber.join(wave);
      const [unknown] = yield* executor.runBatch(
        [
          {
            request: {
              kind: "tool",
              op: "webhook",
              intent: { url: "https://example.test" },
              effect: { category: "mutation" },
              toolObservation: { turnId: input.turnId, callId: "call-webhook" },
            },
            body() {
              return Effect.gen(function* () {
                bodies += 1;
                return yield* new OutcomeUnknown({ reason: "webhook_unconfirmed" });
              });
            },
          },
        ],
        { signal: new AbortController().signal },
      );
      if (unknown?.terminal !== "outcome_unknown")
        throw new Error("webhook settlement must be uncertain");
      return yield* answerThenCompact(executor, input);
    }),
  );

/** Parent turn, commissioned child whose answer wakes the parent, then a monitor wake. */
/** One single-action commit on "parent" under the monitor-writer fence at t=1000. */
function monitorCommit(
  kernel: ReturnType<typeof isolatedLedger>["kernel"],
  fence: number,
  action: Parameters<typeof kernel.commit>[0]["actions"][number],
) {
  return kernel.commit({
    sessionId: "parent", owner: "monitor-writer", fence, now: 1_000,
    expectedRevision: kernel.row("parent").revision, state: kernel.row("parent").state,
    actions: [action],
  });
}

/** A 300-link message chain rooted at `rootParent`, committed in one batch. */
function commitLongChain(
  kernel: ReturnType<typeof isolatedLedger>["kernel"],
  input: { readonly sessionId: string; readonly owner: string; readonly fence: number; readonly rootParent: string },
) {
  return kernel.commit({
    sessionId: input.sessionId, owner: input.owner, fence: input.fence, now: 1_000,
    expectedRevision: kernel.row(input.sessionId).revision, state: kernel.row(input.sessionId).state,
    actions: Array.from({ length: 300 }, (_, index) => ({
      id: `link-${index}`, sessionId: input.sessionId,
      parentId: index === 0 ? input.rootParent : `link-${index - 1}`,
      kind: "message" as const,
      intent: { encodingVersion: 1 as const, value: {} },
      effect: { encodingVersion: 1 as const, value: { phase: "pending" } },
      ts: 1_000, irreversible: true,
    })),
  });
}

/** A one-action tail page must attribute exactly and stay within bounded window reads. */
function expectBoundedTailPage(
  kernel: ReturnType<typeof isolatedLedger>["kernel"],
  sessionId: string,
  turnId: string | null,
): void {
  const head = kernel.row(sessionId).revision;
  const pointReads = spyOn(kernel, "actionById");
  const pageReads = spyOn(kernel, "historyPage");
  try {
    const page = inspectSession(kernel, sessionId, { depth: 0, cursor: head - 1, limit: 1 });
    expect(page.transitions).toHaveLength(1);
    expect(page.transitions[0]?.actionId).toBe("link-299");
    expect(page.transitions[0]?.turnId).toBe(turnId);
    expect(pointReads).toHaveBeenCalledTimes(0);
    // The page itself plus at most ceil(301/256) = 2 ancestry windows.
    expect(pageReads.mock.calls.length).toBeLessThanOrEqual(3);
  } finally {
    pointReads.mockRestore();
    pageReads.mockRestore();
  }
}

function lifecycle() {
  return Effect.gen(function* () {
    nextId = 0;
    bodies = 0;
    seedPolicy(rows);
    scope = yield* Effect.scope;
    yield* Effect.addFinalizer(() => closeSessions(runtime).pipe(Effect.orDie));
    const parent = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({ id: "parent", role: "resident", runner: parentRunner }, fixture), fixture); });
    yield* parent.prompt("hello");
    const child = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({
        id: "child",
        parentId: "parent",
        role: "child",
        runner: () =>
          Effect.sync(() => {
            return { kind: "result", text: "child answer" };
          }),
      }, fixture), fixture); });
    const commission = sessionTree(isolatedLedger().kernel, "parent").find(
      (action: import("@openomni/protocol").LedgerAction.Node) =>
        SessionHandleStore.turnTerminal(action) !== undefined,
    );
    if (commission === undefined) throw new Error("parent turn never sealed");
    yield* child.prompt("work", {
      encodingVersion: 1,
      value: {
        kind: "message",
        messageId: "commission",
        senderSessionId: "parent",
        sourceActionId: commission.id,
      },
    });
    // A watch is an `alarm{arm}` chain row plus the `alarm{fired}` row
    // that settles its occurrence; the wake is the fired row's received
    // message plus a fresh activation.
    const kernel = isolatedLedger().kernel;
    const monitorWriter = yield* kernel.adoptFence({
      sessionId: "parent", owner: "monitor-writer", fence: kernel.row("parent").fence + 1,
    });
    const monitorArm = armAction({
      parentId: null, sessionId: "parent", purpose: "monitor.hit", at: 1_000, supersedes: null,
      alarmId: "monitor", sourceKey: "timer:1000", payload: {}, armSeq: 1, ts: 1_000,
    });
    yield* monitorCommit(kernel, monitorWriter.fence, monitorArm.action);
    const monitorFire = firedAction({
      parentId: monitorArm.action.id, sessionId: "parent", purpose: "monitor.hit", alarmId: "monitor",
      occurrenceId: monitorArm.occurrenceId, outcome: "delivered", ts: 1_000,
    });
    const woke = committed("parent", "turn");
    yield* monitorCommit(kernel, monitorWriter.fence, monitorFire);
    yield* commitReceivedMessage(kernel, {
      id: "monitor-woke", sessionId: "parent", kind: "prompt", content: "monitor woke",
      origin: { encodingVersion: 1, value: { kind: "alarm", alarmId: "monitor" } },
      createdAt: 1_000, parentActionId: monitorFire.id,
    });
    yield* wake("parent", parentRunner, runtime);
    yield* Effect.promise(() => woke).pipe(Effect.timeout("5 seconds"));
    return parent;
  });
}

describe("action-based history and diagnostic projections", () => {
  test("inspection pages more than 256 actions without enumerating session rows", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const parent = yield* lifecycle();
          const kernel = isolatedLedger().kernel;
          const firstRevision = kernel.row("parent").revision;
          const adopted = yield* kernel.adoptFence({
            sessionId: "parent", owner: "inspection-page", fence: kernel.row("parent").fence + 1,
          });
          yield* kernel.commit({
            sessionId: "parent", owner: "inspection-page", fence: adopted.fence, now: 1_000,
            expectedRevision: firstRevision, state: kernel.row("parent").state,
            actions: Array.from({ length: 300 }, (_, index) => ({
              id: `inspection-page-${index}`, sessionId: "parent", parentId: null,
              kind: "alarm" as const,
              intent: { encodingVersion: 1 as const, value: { alarmId: `inspect-${index}` } },
              effect: { encodingVersion: 1 as const, value: { phase: "pending" } },
              ts: 1_000, irreversible: true,
            })),
          });
          const listRows = spyOn(kernel, "listRows");
          try {
            const first = parent.inspect({ depth: 1, cursor: firstRevision, limit: 256 });
            expect(first.transitions).toHaveLength(256);
            expect(first.nextCursor).toBe(firstRevision + 256);
            expect(first.nextChildrenCursor).toBe("");
            const second = parent.inspect({ depth: 1, cursor: first.nextCursor ?? 0, limit: 256 });
            expect(second.transitions).toHaveLength(44);
            expect(second.nextCursor).toBeNull();
            expect(second.transitions[0]?.revision).toBe(firstRevision + 257);
            expect(second.children.map((child) => child.sessionId)).toEqual(["child"]);
            expect(listRows).toHaveBeenCalledTimes(0);
          } finally {
            listRows.mockRestore();
          }
        }),
      ),
    ));

  test("every transition of a request spanning child, retry, refusal, approval, wake and compaction traces to a committed cause", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const parent = yield* lifecycle();
          const inspection = parent.inspect({ depth: 1 });
          const tree = sessionTree(isolatedLedger().kernel, "parent");
          expect(
            inspection.transitions.map(
              (
                entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
              ) => entry.actionId,
            ),
          ).toEqual(tree.map((a: import("@openomni/protocol").LedgerAction.Node) => a.id));
          expect(
            inspection.transitions.map(
              (
                entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
              ) => entry.revision,
            ),
          ).toEqual(
            tree.map((action: import("@openomni/protocol").LedgerAction.Node) => action.ordinal),
          );
          const known = new Set(
            tree.map((action: import("@openomni/protocol").LedgerAction.Node) => action.id),
          );
          // W5.2: the input-queue table is gone; received-message chain
          // actions (kind "prompt") are the delivered rows.
          const delivered = new Set(
            tree
              .filter((action: import("@openomni/protocol").LedgerAction.Node) => action.kind === "prompt")
              .map((action: import("@openomni/protocol").LedgerAction.Node) => action.id),
          );
          for (const transition of inspection.transitions) {
            switch (transition.cause.kind) {
              case "action":
                expect(known.has(transition.cause.actionId)).toBe(true);
                break;
              case "delivery":
                for (const id of transition.cause.deliveryIds) expect(delivered.has(id)).toBe(true);
                break;
              case "root":
                expect(transition.parentId).toBeNull();
                expect(["session.configure", "alarm"]).toContain(transition.kind);
                break;
              default:
                throw new Error("unreachable cause");
            }
          }
          const byOp = (op: string, phase: SessionHistory.Phase) =>
            inspection.transitions.filter(
              (
                entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
              ) => entry.op === op && entry.phase === phase,
            );
          // Attempts share the llm kind; an attempt intent is the llm
          // row carrying its attempt ordinal.
          const attemptActionIds = new Set(
            tree
              .filter(
                (action: import("@openomni/protocol").LedgerAction.Node) =>
                  action.kind === "llm" &&
                  typeof (action.intent.value as { attempt?: number })?.attempt === "number",
              )
              .map((action: import("@openomni/protocol").LedgerAction.Node) => action.id),
          );
          expect(
            byOp("chat", "intent").filter(
              (
                entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
              ) => entry.kind === "llm" && attemptActionIds.has(entry.actionId),
            ),
          ).toHaveLength(2);
          expect(
            byOp("chat", "result").map(
              (
                entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
              ) => entry.outcome,
            ),
          ).toEqual(["executed", "executed", "executed"]);
          const attemptResults = tree.filter(
            (action: import("@openomni/protocol").LedgerAction.Node) =>
              action.kind === "llm" &&
              attemptActionIds.has(action.parentId ?? "") &&
              action.effect.value !== null &&
              typeof action.effect.value === "object" &&
              !Array.isArray(action.effect.value) &&
              action.effect.value.phase === "result",
          );
          expect(attemptResults[0]?.effect.value).toMatchObject({
            evidence: { failures: [{ tag: "LlmRunFailure" }], defects: [], interrupted: false },
          });
          expect(byOp("forbidden", "intent")).toEqual([]);
          expect(
            byOp("forbidden", "decision").map(
              (
                entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
              ) => [entry.outcome, entry.reason],
            ),
          ).toEqual([["blocked_pre", "not_allowed"]]);
          expect(
            byOp("write", "result").map(
              (
                entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
              ) => entry.outcome,
            ),
          ).toEqual(["executed"]);
          expect(
            byOp("webhook", "result").map(
              (
                entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
              ) => entry.outcome,
            ),
          ).toEqual(["outcome_unknown"]);
          expect(inspection.requests).toMatchObject([
            { mode: "approval", callId: "call-write", state: "resolved", outcome: "executed" },
          ]);
          expect(inspection.compactions).toHaveLength(1);
          expect(inspection.compactions[0]?.discarded.count).toBeGreaterThan(0);
          expect(inspection.compactions[0]?.restoredBy).toEqual([]);
          // A fired alarm row's cause is its chain lineage (its arm
          // action); the dedicated alarm cause variant is gone.
          const monitorFire = `${Alarm.occurrenceId("parent", "monitor", 1, "timer:1000")}:delivered`;
          const woke = inspection.transitions.find(
            (
              entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
            ) => entry.actionId === monitorFire,
          );
          expect(woke?.kind).toBe("alarm");
          expect(woke?.cause).toEqual({ kind: "action", actionId: "monitor:arm:1" });
          const wakePrompt = inspection.transitions.find(
            (
              entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
            ) => entry.kind === "prompt" && entry.parentId === monitorFire,
          );
          expect(wakePrompt?.cause).toEqual({ kind: "action", actionId: monitorFire });
          const fromChild = inspection.transitions.find(
            (
              entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
            ) => entry.kind === "prompt" && entry.peerSessionId === "child",
          );
          expect(
            inspection.children.map(
              (child: import("@openomni/protocol").SessionHistory.Inspection) => child.sessionId,
            ),
          ).toEqual(["child"]);
          const outbound = inspection.children[0]?.transitions.filter(
            (e: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number]) =>
              e.kind === "message",
          );
          expect(
            outbound?.map(
              (
                entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
              ) => [entry.peerSessionId, entry.outcome],
            ),
          ).toEqual([
            ["parent", "pending"],
            ["parent", "executed"],
          ]);
          const obligation = isolatedLedger().kernel.outboundRows("child")[0];
          expect(fromChild?.actionId).toBe(obligation?.message.messageId ?? "");
          expect(fromChild?.cause).toEqual({
            kind: "delivery",
            deliveryIds: [fromChild?.actionId ?? ""],
          });
          expect(inspection.children[0]?.children).toEqual([]);
          expect(parent.inspect({ depth: 0 }).children).toEqual([]);
        }),
      ),
    ));

  test("policy decisions carry generation, rule and verdict and never carry payloads", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const parent = yield* lifecycle();
          const inspection = parent.inspect();
          expect(
            inspection.policy.filter(
              (
                decision: import("@openomni/protocol").SessionHistory.Inspection["policy"][number],
              ) => decision.verdict === "deny",
            ),
          ).toMatchObject([
            { op: "forbidden", hook: "tool.pre", matchedRuleIds: ["refuse-forbidden"] },
          ]);
          expect(
            inspection.policy.filter(
              (
                decision: import("@openomni/protocol").SessionHistory.Inspection["policy"][number],
              ) => decision.matchedRuleIds.includes("approve-write"),
            ),
          ).toMatchObject([{ verdict: "require_approval", reason: "owner", generation: 1 }]);
          expect(
            inspection.policy.every(
              (
                decision: import("@openomni/protocol").SessionHistory.Inspection["policy"][number],
              ) => decision.generation === 1,
            ),
          ).toBe(true);
          for (const decision of inspection.policy) {
            if (decision.subjectActionId === null) continue;
            expect(
              inspection.transitions.some(
                (
                  e: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
                ) => e.actionId === decision.subjectActionId,
              ),
            ).toBe(true);
          }
          const rendered = JSON.stringify(inspection);
          expect(JSON.stringify(sessionTree(isolatedLedger().kernel, "parent"))).toContain(SECRET);
          expect(rendered).not.toContain(SECRET);
          expect(rendered).not.toContain("/etc/shadow");
        }),
      ),
    ));

  test("inspection and history are pure reads: no body runs and no action is appended", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const parent = yield* lifecycle();
          const kernel = isolatedLedger().kernel;
          const before = sessionTree(kernel, "parent");
          const ran = bodies;
          parent.inspect({ depth: 2 });
          parent.history({ limit: 5 });
          expect(bodies).toBe(ran);
          expect(sessionTree(kernel, "parent")).toEqual(before);
          expect(sessionTree(kernel, "child")).toEqual(sessionTree(kernel, "child"));
        }),
      ),
    ));

  test("a materialized tail rebuilt from bounded pages equals the canonical fold", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const parent = yield* lifecycle();
          const before = sessionTree(isolatedLedger().kernel, "parent");
          const rebuilt: typeof before = [];
          let page = parent.history({ afterRevision: 0, limit: 4 });
          for (;;) {
            expect(page.actions.length).toBeLessThanOrEqual(4);
            rebuilt.push(...page.actions);
            if (page.nextRevision === null) break;
            page = parent.history({ afterRevision: page.nextRevision, limit: 4 });
          }
          expect(page.headRevision).toBe(parent.get().revision);
          expect(rebuilt).toEqual(before);
          expect(parent.inspect({ depth: 0 }).children).toEqual([]);
          expect(foldSessionHistory("parent", rebuilt)).toEqual(
            foldSessionHistory("parent", before),
          );
        }),
      ),
    ));
});

describe("bounded inspection pages keep advancing and keep causal attribution (review F3/F4)", () => {
  test("limits 1 and 2 advance children from an empty root page and every continuation advances or terminates", () =>
    isolated(
      Effect.gen(function* () {
        const kernel = isolatedLedger().kernel;
        const materialize = (id: string, parentId: string | null) =>
          kernel.materialize({
            id, parentId, role: "resident", tools: [], system: { preset: "", blocks: [] },
            policyGeneration: 1, actionId: `${id}:configure`, at: 1_000,
          });
        yield* materialize("root", null);
        yield* materialize("child-a", "root");
        yield* materialize("child-b", "root");
        const head = kernel.row("root").revision;
        // limit 1: the mandatory root response must not consume the descendant budget.
        const first = inspectSession(kernel, "root", { depth: 1, cursor: head, limit: 1 });
        expect(first.transitions).toEqual([]);
        expect(first.nextCursor).toBeNull();
        expect(first.children.map((child) => child.sessionId)).toEqual(["child-a"]);
        expect(first.children[0]?.transitions.map((entry) => entry.actionId)).toEqual([
          "child-a:configure",
        ]);
        expect(first.nextChildrenCursor).toBe("child-a");
        const second = inspectSession(kernel, "root", {
          depth: 1, cursor: head, limit: 1, childrenCursor: first.nextChildrenCursor ?? "",
        });
        expect(second.children.map((child) => child.sessionId)).toEqual(["child-b"]);
        expect(second.nextChildrenCursor).toBe("child-b");
        const third = inspectSession(kernel, "root", {
          depth: 1, cursor: head, limit: 1, childrenCursor: second.nextChildrenCursor ?? "",
        });
        expect(third.children).toEqual([]);
        expect(third.nextChildrenCursor).toBeNull();
        // limit 2: both children fit; the advertised continuation then terminates.
        const wide = inspectSession(kernel, "root", { depth: 1, cursor: head, limit: 2 });
        expect(wide.children.map((child) => child.sessionId)).toEqual(["child-a", "child-b"]);
        expect(wide.nextChildrenCursor).toBe("child-b");
        const done = inspectSession(kernel, "root", {
          depth: 1, cursor: head, limit: 2, childrenCursor: wide.nextChildrenCursor ?? "",
        });
        expect(done.children).toEqual([]);
        expect(done.nextChildrenCursor).toBeNull();
      }),
    ));

  test("a page boundary between a turn and its tool intent preserves the tool's turn attribution", () =>
    isolated(
      Effect.gen(function* () {
        const kernel = isolatedLedger().kernel;
        const fixture = yield* fencedTurnFixture(kernel, {
          id: "attribution", clock: () => 1_000, turnId: "turn-1",
        });
        yield* kernel.commit({
          sessionId: "attribution", owner: fixture.owner, fence: fixture.fence, now: 1_000,
          expectedRevision: kernel.row("attribution").revision, state: kernel.row("attribution").state,
          actions: [{
            id: "tool-1", sessionId: "attribution", parentId: "turn-1", kind: "tool",
            intent: {
              encodingVersion: 1,
              value: { phase: "intent", op: "write", value: { path: "approved.txt" } },
            },
            effect: { encodingVersion: 1, value: { phase: "pending" } },
            ts: 1_000, irreversible: true,
          }],
        });
        const complete = inspectSession(kernel, "attribution");
        const full = complete.transitions.find((entry) => entry.actionId === "tool-1");
        expect(full?.turnId).toBe("turn-1");
        // The boundary falls between turn-1 (revision 2) and tool-1 (revision 3).
        const paged = inspectSession(kernel, "attribution", { depth: 0, cursor: 2, limit: 1 });
        expect(paged.transitions).toHaveLength(1);
        const boundary = paged.transitions[0];
        expect(boundary?.actionId).toBe("tool-1");
        expect(boundary?.turnId).toBe("turn-1");
        expect(boundary?.revision).toBe(full?.revision ?? -1);
        expect(boundary?.digest).toBe(full?.digest ?? "");
      }),
    ));
  // Review F4 continuation: a page whose first action sits two hops below its
  // turn (result -> tool intent -> turn) must walk THROUGH the intermediate
  // ancestor that carries no turn id of its own to reach the turn.
  test("a page opening below a tool's result attributes the turn across multi-hop ancestry", () =>
    isolated(
      Effect.gen(function* () {
        const kernel = isolatedLedger().kernel;
        const fixture = yield* fencedTurnFixture(kernel, {
          id: "deep-attribution", clock: () => 1_000, turnId: "turn-1",
        });
        const commitTool = (id: string, parentId: string, phase: "intent" | "result") =>
          kernel.commit({
            sessionId: "deep-attribution", owner: fixture.owner, fence: fixture.fence, now: 1_000,
            expectedRevision: kernel.row("deep-attribution").revision,
            state: kernel.row("deep-attribution").state,
            actions: [{
              id, sessionId: "deep-attribution", parentId, kind: "tool",
              intent: { encodingVersion: 1, value: { phase, op: "write" } },
              effect: {
                encodingVersion: 1,
                value: phase === "intent"
                  ? { phase: "pending" }
                  : { phase: "result", terminal: "executed" },
              },
              ts: 1_000, irreversible: true,
            }],
          });
        yield* commitTool("tool-1", "turn-1", "intent");
        yield* commitTool("tool-1:result", "tool-1", "result");
        // The page holds only the result (revision 4): tool-1 carries no own
        // turn id, so attribution must continue up its parent chain to turn-1.
        const paged = inspectSession(kernel, "deep-attribution", { depth: 0, cursor: 3, limit: 1 });
        expect(paged.transitions).toHaveLength(1);
        expect(paged.transitions[0]?.actionId).toBe("tool-1:result");
        expect(paged.transitions[0]?.turnId).toBe("turn-1");
      }),
    ));

  // Review r2 F5: a one-action page must never trigger an unbounded ancestor
  // scan. Ancestry is resolved through bounded descending history windows, so
  // a 300-link turn-less chain costs a handful of page reads and zero
  // per-ancestor point reads while the attribution stays exact (null because
  // the walk reached the root, not because anything was truncated).
  test("a one-action page over a 300-link turn-less chain resolves null attribution in bounded window reads", () =>
    isolated(
      Effect.gen(function* () {
        const kernel = isolatedLedger().kernel;
        yield* kernel.materialize({
          id: "long-chain", parentId: null, role: "resident", tools: [],
          system: { preset: "", blocks: [] }, policyGeneration: 1,
          actionId: "long-chain:configure", at: 1_000,
        });
        const adopted = yield* kernel.adoptFence({
          sessionId: "long-chain", owner: "chain-writer",
          fence: kernel.row("long-chain").fence + 1,
        });
        yield* commitLongChain(kernel, {
          sessionId: "long-chain", owner: "chain-writer", fence: adopted.fence,
          rootParent: "long-chain:configure",
        });
        expectBoundedTailPage(kernel, "long-chain", null);
      }),
    ));

  // The same bounded lookup must still attribute correctly when the long
  // chain DOES descend from a turn: the null above is a derived fact, not a
  // budget truncation (that would reintroduce the r1 attribution bug).
  test("a one-action page over a 300-link chain under a turn attributes the turn in bounded window reads", () =>
    isolated(
      Effect.gen(function* () {
        const kernel = isolatedLedger().kernel;
        const fixture = yield* fencedTurnFixture(kernel, {
          id: "long-turn-chain", clock: () => 1_000, turnId: "turn-1",
        });
        yield* commitLongChain(kernel, {
          sessionId: "long-turn-chain", owner: fixture.owner, fence: fixture.fence,
          rootParent: "turn-1",
        });
        expectBoundedTailPage(kernel, "long-turn-chain", "turn-1");
      }),
    ));
});
