import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import * as SessionHandleStore from "../src/core/store/fence";
import { canonicalDigest, PlainObjectSchema, type Delivery, type LedgerAction, type LedgerSession, type SessionTransition, } from "@openomni/protocol";
import { sessionTree } from "./helpers/session-tree";
import { decideSessionAdmission } from "../src/core/admission";
import { decideRequestTransition } from "../src/core/request";
import { session } from "../src/testing/registry";
import { resolveSessionRuntime } from "../src/core/run";
import { createController } from "../src/testing/controller";
import { turnIntentAction } from "../src/core/commit";
import type { SessionRunner, SessionRunnerInput } from "../src/core/run";
import { createExecutor } from "../src/core/gate/decide";
import { CommitFailed } from "../src/core/failure";
import { armAction, firedAction } from "../src/core/alarm";
import { createSessionChatRunner } from "../src/core/run";
import { prepareChatFixture } from "./helpers/chat-services";
import { assistantStep } from "./helpers/dispatching-runner";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { queuePromptOnS } from "./helpers/ingress";
import { nth } from "./helpers/nth";
import { boundedBy2s, silentRuntime, withSessionServices, type SessionFixture } from "./helpers/session-services";
import { openRequest } from "./helpers/open-request";
import { seedPolicy } from "./helpers/seed-policy";
import { fixtureGeneration, fixtureNode, fixtureTerminal, fixtureOpenTurn, fixtureTurn, } from "./helpers/open-turn-fixture";
import { answerThenCompact } from "./helpers/effect-g2";
import { TEST_APPROVAL_POLICY } from "./helpers/approval-policy";

const row: LedgerSession.Row = {
  id: "S",
  parentId: null,
  role: "resident",
  fenceOwner: "owner",
  fence: 1,
  revision: 1,
  state: "running",
  toolsGeneration: 1,
  systemHash: "system",
  policyGeneration: 1,
};
const generation = fixtureGeneration;
const node = fixtureNode;
const turn = fixtureTurn;
const open: SessionHandleStore.OpenTurn = fixtureOpenTurn;
const terminal = fixtureTerminal;
function pendingRow(kind: Delivery.Kind, ordinal = 1): Delivery.Row {
  return {
    id: `I${ordinal}`,
    sessionId: "S",
    kind,
    content: kind,
    ordinal,
    createdAt: ordinal,
    status: "pending",
    consumedBy: null,
    consumedAt: null,
    origin: { encodingVersion: 1, value: { kind: "session", id: "S" } },
  };
}
const bounded = boundedBy2s;
const fixture = () => silentRuntime("fsm", "fsm");
/** Seeded runtime plus entry/release gates for runner-holding tests. */
function gatedFixture(): Effect.Effect<{
  runtime: SessionFixture;
  entered: Deferred.Deferred<void>;
  release: Deferred.Deferred<void>;
}> {
  return Effect.gen(function* () {
    seedPolicy();
    const runtime = fixture();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    return { runtime, entered, release };
  });
}
/** Materialize the canonical session "S" with configure action `actionId` at t=1. */
function materializeS(actionId: string) {
  return isolatedLedger().kernel.materialize({
    id: "S",
    parentId: null,
    role: "resident",
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: 1,
    actionId,
    at: 1,
  });
}

/** Adopt a strictly newer fence for a foreign owner and commit actions under it. */
function commitAsForeignOwner(
  owner: string,
  input: {
    readonly now: number;
    readonly expectedRevision?: number;
    readonly state?: LedgerSession.State;
    readonly actions: readonly LedgerAction.Append[];
  },
) {
  return Effect.gen(function* () {
    const kernel = isolatedLedger().kernel;
    const lease = yield* kernel.adoptFence({
      sessionId: "S",
      owner,
      fence: kernel.row("S").fence + 1,
    });
    yield* kernel.commit({
      sessionId: "S",
      owner,
      fence: lease.fence,
      now: input.now,
      expectedRevision: input.expectedRevision ?? kernel.row("S").revision,
      state: input.state ?? kernel.row("S").state,
      actions: [...input.actions],
    });
  });
}
function declare(runtime: SessionFixture, runner: SessionRunner, id = "S") {
  return withSessionServices(session({ id, role: "resident", runner }, runtime), runtime);
}

type AdmissionSnapshot = Parameters<typeof decideSessionAdmission>[0];
type AdmissionKind = ReturnType<typeof decideSessionAdmission>["kind"];

function expectedAdmissionKind(
  snapshot: AdmissionSnapshot,
  fallback: AdmissionKind,
): AdmissionKind {
  if (snapshot.open !== undefined) return snapshot.row.state === "idle" ? "refused" : "recover";
  if (
    snapshot.row.state === "interrupted" &&
    snapshot.pending[0]?.kind === "resume" &&
    snapshot.terminal?.effect.kind === "interrupted"
  )
    return "resume";
  return fallback;
}

function expectIdentitySubstitutionsRefused(snapshot: AdmissionSnapshot, event: Delivery.Kind): void {
  const foreignTerminal = terminal("interrupted");
  const substitutions: readonly AdmissionSnapshot[] = [
    { ...snapshot, pending: [{ ...pendingRow(event), sessionId: "foreign" }] },
    { ...snapshot, pending: [{ ...pendingRow(event), status: "consumed" }] },
    { ...snapshot, open: { ...open, action: { ...turn, sessionId: "foreign" } } },
    {
      ...snapshot,
      terminal: {
        ...foreignTerminal,
        action: { ...foreignTerminal.action, sessionId: "foreign" },
      },
    },
  ];
  for (const substituted of substitutions) {
    expect(decideSessionAdmission(substituted).kind).toBe("refused");
  }
}

// The table is the controller's production decision, not a test-only substitute FSM.
describe("T02/T05/T07/T08/T10 admission Cartesian product", () => {
  const states = ["idle", "running", "interrupted"] as const;
  const events = ["prompt", "interrupt", "resume"] as const;
  const terminals = [undefined, terminal("result"), terminal("interrupted")];
  const expected = {
    idle: { prompt: "start", interrupt: "consume", resume: "consume" },
    running: { prompt: "refused", interrupt: "refused", resume: "refused" },
    interrupted: { prompt: "stop", interrupt: "stop", resume: "consume" },
  } as const;
  for (const state of states)
    for (const event of events)
      for (const hasOpen of [false, true]) {
        test(`${state} x ${event} x open=${hasOpen}: all terminal and identity products`, () => {
          for (const prior of terminals) {
            const snapshot = {
              row: { ...row, state },
              pending: [pendingRow(event)],
              capabilityKinds: ["tool", "compaction"] as const,
              open: hasOpen ? open : undefined,
              terminal: prior,
            };
            expect(decideSessionAdmission(snapshot).kind).toBe(
              expectedAdmissionKind(snapshot, expected[state][event]),
            );
            expectIdentitySubstitutionsRefused(snapshot, event);
          }
        });
      }
  test("empty pending queue and control prefix have explicit decisions without consuming a following prompt", () => {
    expect(
      decideSessionAdmission({ row: { ...row, state: "idle" }, pending: [], capabilityKinds: ["tool", "compaction"] }),
    ).toEqual({
      kind: "stop",
    });
    const control = pendingRow("resume");
    expect(
      decideSessionAdmission({
        row: { ...row, state: "idle" },
        pending: [control, pendingRow("prompt", 2)],
        capabilityKinds: ["tool", "compaction"],
      }),
    ).toEqual({ kind: "consume", items: [control] });
    expect(decideSessionAdmission({ row, pending: [], capabilityKinds: ["tool", "compaction"] }).kind).toBe("refused");
  });
});

const request = openRequest({ requestId: "Q", sessionId: "S", turnId: "T", callId: "call" });
const invocation = node({
  id: "Q",
  sessionId: "S",
  parentId: "T",
  kind: "tool",
  ts: 1,
  irreversible: true,
  intent: {
    encodingVersion: 1,
    value: { phase: "intent", value: request.parsedInput, effectHash: request.effectHash },
  },
  effect: { encodingVersion: 1, value: { phase: "pending" } },
});
function answer(): SessionTransition.Answer {
  return {
    inputId: "input",
    requestId: "Q",
    sessionId: "S",
    receivedAt: 20,
    principal: { kind: "owner", principalId: "owner", evidenceId: "credential" },
    bindingDigest: request.bindingDigest,
    inputHash: request.inputHash,
    effectHash: request.effectHash,
    generation: 1,
    toolsHash: request.toolsHash,
    domainRevisions: {},
    decision: "approve",
    allowedAction: "report_result",
    content: "",
  };
}
const payloads: readonly SessionTransition.Payload[] = [
  { kind: "request.open", request },
  { kind: "request.answer", answer: answer() },
  { kind: "request.cancel", requestId: "Q", principal: answer().principal },
  { kind: "request.timeout", requestId: "Q" },
  {
    kind: "request.delivery",
    receipt: {
      inputId: "input",
      requestId: "Q",
      sessionId: "S",
      sourceActionId: "Q",
      value: "accepted",
      at: 20,
    },
  },
];
function command(payload: SessionTransition.Payload): SessionTransition.Command {
  return {
    version: 1,
    sessionId: "S",
    inputId: "input",
    at: 20,
    expectedRevision: 1,
    authority: { owner: "owner", fence: 1 },
    payload,
  };
}
const outcomes = {
  open: null,
  resolved: "answered",
  refused: "denied",
  expired: "outcome_unknown",
  cancelled: "cancelled",
} as const;

type RequestState = keyof typeof outcomes | undefined;

function expectedResolution(
  state: RequestState,
  payload: SessionTransition.Payload,
): SessionTransition.Resolution {
  if (state === undefined) return payload.kind === "request.open" ? "opened" : "rejected";
  if (payload.kind === "request.delivery") return "delivery_recorded";
  if (payload.kind === "request.open") return "rejected";
  if (state !== "open") return "duplicate";
  if (payload.kind === "request.answer") return "resolved";
  if (payload.kind === "request.cancel") return "cancelled";
  return "rejected";
}

function invalidCommands(valid: SessionTransition.Command): readonly SessionTransition.Command[] {
  return [
    { ...valid, sessionId: "foreign" },
    { ...valid, expectedRevision: 0 },
    { ...valid, authority: { owner: "foreign", fence: 1 } },
    // W5.2: the lease-TTL plane is deleted, so a late `at` alone no longer
    // rejects; expiry is the request deadline (T13 below).
    { ...valid, authority: { owner: "owner", fence: 2 } },
  ];
}

describe("T12/T13 request source x event x authority product", () => {
  for (const state of [undefined, "open", "resolved", "refused", "expired", "cancelled"] as const) {
    for (const payload of payloads)
      test(`${state ?? "absent"} x ${payload.kind}`, () => {
        const snapshot = {
          row,
          invocation,
          request:
            state === undefined ? undefined : { ...request, state, outcome: outcomes[state] },
        };
        const valid = command(payload);
        const result = decideRequestTransition(valid, snapshot, TEST_APPROVAL_POLICY.recentOpen);
        expect(result.resolution).toBe(expectedResolution(state, payload));
        for (const contender of invalidCommands(valid)) {
          expect(decideRequestTransition(contender, snapshot, TEST_APPROVAL_POLICY.recentOpen)).toEqual({
            resolution: "rejected",
            actions: [],
          });
        }
      });
  }
  test("T12 exact invocation, delivery input and replay record identities cannot be substituted", () => {
    expect(
      decideRequestTransition(command(nth(payloads, 0)), {
        row,
        invocation: { ...invocation, id: "other" },
      }, TEST_APPROVAL_POLICY.recentOpen),
    ).toEqual({ resolution: "rejected", actions: [] });
    const delivery = nth(payloads, 4);
    expect(
      decideRequestTransition({ ...command(delivery), inputId: "other" }, { row, request }, TEST_APPROVAL_POLICY.recentOpen),
    ).toEqual({ resolution: "rejected", actions: [] });
    const input = command({ kind: "request.answer", answer: answer() });
    const resolved = decideRequestTransition(input, { row, request }, TEST_APPROVAL_POLICY.recentOpen);
    const recorded = node(nth(resolved.actions, 0));
    const snapshot = { row, request: resolved.request, inputRecord: recorded };
    expect(decideRequestTransition(input, snapshot, TEST_APPROVAL_POLICY.recentOpen)).toMatchObject({
      resolution: "resolved",
      actions: [],
    });
    for (const altered of [
      { ...recorded, sessionId: "foreign" },
      { ...recorded, parentId: "other" },
      { ...recorded, id: "other" },
      {
        ...recorded,
        intent: {
          encodingVersion: 1 as const,
          value: { ...PlainObjectSchema.parse(recorded.intent.value), inputId: "other" },
        },
      },
    ])
      expect(decideRequestTransition(input, { ...snapshot, inputRecord: altered }, TEST_APPROVAL_POLICY.recentOpen)).toEqual({
        resolution: "rejected",
        actions: [],
      });
  });
  test("T13 captured commit time at the deadline wins over a backdated answer", () => {
    const result = decideRequestTransition(
      { ...command({ kind: "request.answer", answer: answer() }), at: request.deadline },
      { row, request },
      TEST_APPROVAL_POLICY.recentOpen,
    );
    expect(result.resolution).toBe("late_unknown");
    expect(result.receive).toBeUndefined();
    expect(result.request?.state).toBe("expired");
    // The terminal transition also retires the deadline alarm chain
    // (an `at: null` arm row) in the same decision batch.
    expect(result.actions.map((action) => action.ts)).toEqual([
      request.deadline,
      request.deadline,
      request.deadline,
    ]);
    expect(result.actions.at(-1)?.id).toBe(`${request.requestId}:deadline:arm:2`);
  });
});

describe("T01-T15 real controller transition witnesses", () => {
  test("T01 stable identity is recorded once; conflicting durable redeclaration enters no body", () =>
    isolated(
      Effect.gen(function* () {
        seedPolicy();
        const runtime = fixture();
        let bodies = 0;
        const runner: SessionRunner = () =>
          Effect.sync(() => {
            bodies += 1;
            return { kind: "result", text: "" };
          });
        const handle = yield* declare(runtime, runner);
        expect(yield* declare(runtime, runner)).toBe(handle);
        const before = sessionTree(isolatedLedger().kernel, "S");
        const other = fixture();
        const conflict = yield* Effect.exit(
          withSessionServices(
            session({ id: "S", role: "child", parentId: "parent", runner }, other),
            other,
          ),
        );
        expect(conflict._tag).toBe("Failure");
        expect(sessionTree(isolatedLedger().kernel, "S")).toEqual(before);
        expect(before.map((action) => action.kind)).toEqual(["session.configure"]);
        expect(bodies).toBe(0);
      }),
    ));

  test("T02/T05/T07 intent and result ID precede entry; idle controls and running resume enter no extra runner", () =>
    isolated(
      Effect.gen(function* () {
        seedPolicy();
        const runtime = fixture();
        const entered = yield* Deferred.make<SessionRunnerInput>();
        const release = yield* Deferred.make<void>();
        let bodies = 0;
        const handle = yield* declare(runtime, (input) =>
          Effect.gen(function* () {
            bodies += 1;
            expect(isolatedLedger().kernel.latestOpenTurn("S")).toMatchObject({
              turnId: input.turnId,
              resultId: input.resultId,
            });
            expect(isolatedLedger().kernel.pendingMessages("S")).toEqual([]);
            yield* Deferred.succeed(entered, input);
            yield* Deferred.await(release);
            return { kind: "result", text: "done" };
          }),
        );
        yield* handle.interrupt();
        yield* handle.resume();
        expect(bodies).toBe(0);
        const running = yield* Effect.forkScoped(handle.prompt("start"));
        const input = yield* bounded(Deferred.await(entered));
        yield* handle.resume();
        expect(bodies).toBe(1);
        yield* Deferred.succeed(release, undefined);
        yield* bounded(Fiber.join(running));
        expect(isolatedLedger().kernel.latestTurnTerminal("S")?.action.id).toBe(input.resultId);
        expect(isolatedLedger().kernel.pendingMessages("S")).toEqual([]);
      }),
    ));

  for (const boundary of ["before_llm", "after_llm", "after_tools"] as const) {
    test(`T03/T04 ordered distinct prompts drain only at ${boundary} with unchanged pins`, () =>
      isolated(
        Effect.gen(function* () {
          const { runtime, entered, release } = yield* gatedFixture();
          const drained: string[][] = [];
          const handle = yield* declare(runtime, (input) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              const pins = [input.turnId, input.resultId, input.toolsHash, input.systemHash];
              const batch = yield* input.boundary(boundary);
              drained.push(batch.messages.map((message) => message.text));
              expect(batch.interrupted).toBe(false);
              expect([input.turnId, input.resultId, input.toolsHash, input.systemHash]).toEqual(
                pins,
              );
              return { kind: "result", text: "done" };
            }),
          );
          const running = yield* Effect.forkScoped(handle.prompt("start"));
          yield* bounded(Deferred.await(entered));
          // Durable ingress is independent of the runner, including compaction/approval waits.
          // A steer row is consumable at the tool.post boundary; the
          // followUp row waits for turn end in every case.
          for (const [ordinal, [content, delivery]] of (
            [
              ["one", "steer"],
              ["two", "followUp"],
            ] as const
          ).entries())
            yield* queuePromptOnS(isolatedLedger().kernel, ordinal, content, delivery);
          expect(
            isolatedLedger()
              .kernel.pendingMessages("S")
              .map((item) => item.content),
          ).toEqual(["one", "two"]);
          expect(drained).toEqual([]);
          yield* Deferred.succeed(release, undefined);
          yield* bounded(Fiber.join(running));
          // Boundary rule: only the steer row drains mid-turn, and only
          // at the tool.post boundary; the followUp row waits for turn end,
          // where the leftover backlog feeds one follow-up turn.
          expect(drained).toEqual([boundary === "after_tools" ? ["one"] : [], []]);
          expect(isolatedLedger().kernel.pendingMessages("S")).toEqual([]);
        }),
      ));
  }

  test("T06/T08 interruption fixes its terminal; settled resume branches with fresh IDs and current G", () =>
    isolated(
      Effect.gen(function* () {
        seedPolicy();
        const runtime = fixture();
        const entered = yield* Deferred.make<SessionRunnerInput>();
        const inputs: SessionRunnerInput[] = [];
        const handle = yield* declare(runtime, (input) =>
          Effect.gen(function* () {
            inputs.push(input);
            if (inputs.length === 1) {
              yield* Deferred.succeed(entered, input);
              return yield* Effect.never;
            }
            return { kind: "result", text: "resumed" };
          }),
        );
        const running = yield* Effect.forkScoped(handle.prompt("start"));
        const first = yield* bounded(Deferred.await(entered));
        yield* bounded(handle.interrupt());
        yield* bounded(Fiber.join(running));
        const fixed = isolatedLedger().kernel.latestTurnTerminal("S");
        expect(fixed?.action.id).toBe(first.resultId);
        expect(fixed?.effect.kind).toBe("interrupted");
        yield* handle.system.blocks.set([{ id: "new", source: "test", content: "new" }]);
        yield* handle.resume();
        expect(inputs).toHaveLength(2);
        expect(inputs[1]?.turnId).not.toBe(first.turnId);
        expect(inputs[1]?.resultId).not.toBe(first.resultId);
        expect(inputs[1]?.toolsGeneration).toBe(2);
        expect(isolatedLedger().kernel.actionById(first.resultId)).toEqual(fixed?.action);
      }),
    ));

  for (const kind of ["result", "error"] as const)
    test(`T09 ${kind} seals exactly one pre-minted terminal and releases its lease`, () =>
      isolated(
        Effect.gen(function* () {
          seedPolicy();
          const runtime = fixture();
          const handle = yield* declare(runtime, () => Effect.succeed({ kind, text: "terminal" }));
          yield* handle.prompt("start");
          const actions = sessionTree(isolatedLedger().kernel, "S");
          const intent = actions.find(
            (action) => SessionHandleStore.turnIntent(action) !== undefined,
          );
          const endings = actions.filter(
            (action) => SessionHandleStore.turnTerminal(action) !== undefined,
          );
          expect(endings).toHaveLength(1);
          expect(endings[0]?.id).toBe(SessionHandleStore.turnIntent(intent)?.resultId);
          expect(SessionHandleStore.turnTerminal(endings[0])?.kind).toBe(kind);
          // W5.2: terminals keep the fence owner durable; there is no lease release.
          expect(isolatedLedger().kernel.row("S").state).toBe("idle");
          expect(isolatedLedger().kernel.row("S").fenceOwner).not.toBeNull();
        }),
      ));

  for (const source of ["current", "prior", "cancelled"] as const)
    test(`T09 live_wait requires a still-armed action from this turn: ${source}`, () =>
      isolated(
        Effect.gen(function* () {
          seedPolicy();
          const runtime = fixture();
          // W5.2: the alarms table is gone; an armed alarm is an `alarm{arm}`
          // chain row (alarmId + armSeq, capability purpose) with no
          // settling `fired` row for its occurrence (session-stop-evidence).
          const armed = armAction({
            parentId: null,
            sessionId: "S",
            purpose: "test.tick",
            at: 100,
            supersedes: null,
            alarmId: "alarm",
            sourceKey: "test",
            payload: {},
            armSeq: 1,
            ts: 20,
          });
          const alarmAction = (
            op: "arm" | "fired",
            _id: string,
            parentId: string | null,
          ): LedgerAction.Append =>
            op === "arm"
              ? { ...armed.action, parentId }
              : firedAction({
                  parentId,
                  sessionId: "S",
                  purpose: "test.tick",
                  alarmId: "alarm",
                  occurrenceId: armed.occurrenceId,
                  outcome: "delivered",
                  ts: 20,
                });
          const runner = createSessionChatRunner({
            prepare: (input) =>
              Effect.gen(function* () {
                if (source !== "prior")
                  yield* input.ledger
                    .commit(alarmAction("arm", "alarm", input.turnId))
                    .pipe(Effect.mapError((error) => new CommitFailed({ error })));
                if (source === "cancelled")
                  yield* input.ledger
                    .commit(alarmAction("fired", "alarm:fired", "alarm"))
                    .pipe(Effect.mapError((error) => new CommitFailed({ error })));
                const executor = yield* createExecutor({ approvalPolicy: TEST_APPROVAL_POLICY,
                  ledger: input.ledger,
                  identity: { sessionId: "S", role: "resident", parentActionId: input.turnId },
                });
                return prepareChatFixture({
                  traceContext: { traceId: "trace", sessionId: "S", runId: input.resultId },
                  config: {
                    events: runtime.observations,
                    executor,
                    model: { provider: "test", id: "test" },
                    tools: [],
                    llm: {
                      resolveModel: () =>
                        Effect.succeed({ providerID: "test", id: "test", name: "test" }),
                      run: (_request, sink) =>
                        Effect.sync(() => {
                          sink.onMessage(assistantStep("", "S", ""));
                          return { type: "stop" as const };
                        }),
                    },
                  },
                });
              }),
          });
          if (source === "prior") {
            // Armed before this turn opened: an out-of-turn fence adoption commit,
            // before the handle activates (a live activation adopts strictly newer).
            yield* materializeS("prior-cfg");
            yield* commitAsForeignOwner("prior-arm", { now: 20, actions: [alarmAction("arm", "alarm", null)] });
          }
          const handle = yield* declare(runtime, runner);
          const result = yield* handle.prompt("start");
          if (source === "current")
            expect(result).toMatchObject({
              kind: "waiting",
              reason: "live_wait",
              alarmIds: [armed.action.id],
            });
          else expect(result?.kind).toBe("error");
          expect(isolatedLedger().kernel.latestTurnTerminal("S")?.effect.kind).toBe(
            source === "current" ? "waiting" : "error",
          );
          // W5.2: waiting/error terminals keep the fence owner durable.
          expect(isolatedLedger().kernel.row("S").fenceOwner).not.toBeNull();
        }),
      ));

  for (const resumeCount of [0, SessionHandleStore.RESUME_BUDGET])
    test(`T10 recovery budget ${resumeCount} keeps captured IDs and G`, () =>
      isolated(
        Effect.gen(function* () {
          seedPolicy();
          const runtime = fixture();
          const kernel = isolatedLedger().kernel;
          yield* materializeS("cfg");
          yield* commitAsForeignOwner("dead", { now: 1, expectedRevision: 1, state: "running", actions: [
              turnIntentAction({
                id: "T",
                parentId: "cfg",
                sessionId: "S",
                resultId: "R",
                deliveryIds: [],
                generation,
                resumeCount,
                boundaryActionId: "cfg",
                at: 1,
              }),
            ],
          });
          const inputs: SessionRunnerInput[] = [];
          // W5.2: the boot-sweep wake plane is gone; waking is a fresh activation
          // over the durable kernel driving its reconcile (the recover path).
          yield* Effect.scoped(
            withSessionServices(
              Effect.gen(function* () {
                const resolved = yield* resolveSessionRuntime(runtime);
                const scope = yield* Effect.scope;
                const controller = yield* createController(
                  kernel,
                  "S",
                  (input) =>
                    Effect.sync(() => {
                      inputs.push(input);
                      return { kind: "result", text: "recovered" };
                    }),
                  resolved,
                  { reactivate: () => Effect.die("no reactivation"), release: () => undefined },
                  scope,
                );
                yield* controller.reconcile();
              }),
              runtime,
            ),
          );
          expect(inputs).toHaveLength(resumeCount === 0 ? 1 : 0);
          if (resumeCount === 0)
            expect(inputs[0]).toMatchObject({
              turnId: "T",
              resultId: "R",
              toolsGeneration: 1,
              resumeCount: 1,
            });
          expect(isolatedLedger().kernel.latestTurnTerminal("S")?.action.id).toBe("R");
          expect(isolatedLedger().kernel.latestTurnTerminal("S")?.effect.kind).toBe(
            resumeCount === 0 ? "result" : "error",
          );
        }),
      ));

  test("T14 in-flight pins stay fixed and the next turn captures the appended generation", () =>
    isolated(
      Effect.gen(function* () {
        const { runtime, entered, release } = yield* gatedFixture();
        const inputs: SessionRunnerInput[] = [];
        const handle = yield* declare(runtime, (input) =>
          Effect.gen(function* () {
            inputs.push(input);
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return { kind: "result", text: "done" };
          }),
        );
        const running = yield* Effect.forkScoped(handle.prompt("first"));
        yield* bounded(Deferred.await(entered));
        const selected = yield* handle.system.blocks.set([
          { id: "block", source: "test", content: "v2" },
        ]);
        expect(selected).toEqual({ generation: 2, revertTo: 1 });
        expect(inputs[0]?.toolsGeneration).toBe(1);
        yield* Deferred.succeed(release, undefined);
        yield* bounded(Fiber.join(running));
        yield* handle.prompt("second");
        expect(inputs[1]?.toolsGeneration).toBe(2);
        expect(inputs[1]?.systemHash).not.toBe(inputs[0]?.systemHash);
      }),
    ));

  test("T15 restoration appends a branch, preserves original facts and refuses missing sources", () =>
    isolated(
      Effect.gen(function* () {
        seedPolicy();
        const runtime = fixture();
        const handle = yield* declare(runtime, (input) =>
          Effect.gen(function* () {
            const executor = yield* createExecutor({ approvalPolicy: TEST_APPROVAL_POLICY,
              ledger: input.ledger,
              identity: { sessionId: "S", role: "resident", parentActionId: input.turnId },
            });
            return yield* answerThenCompact(executor, input);
          }),
        );
        yield* handle.prompt("start");
        const before = sessionTree(isolatedLedger().kernel, "S");
        const compaction = before.find(
          (action) =>
            action.kind === "compaction" &&
            PlainObjectSchema.parse(action.intent.value).op === "compact",
        );
        if (compaction === undefined) throw new Error("missing compaction");
        expect((yield* Effect.exit(handle.restoreContext("missing")))._tag).toBe("Failure");
        expect(sessionTree(isolatedLedger().kernel, "S")).toEqual(before);
        const foreign = yield* declare(
          runtime,
          () => Effect.succeed({ kind: "result", text: "" }),
          "FOREIGN",
        );
        const foreignBefore = sessionTree(isolatedLedger().kernel, "FOREIGN");
        expect((yield* Effect.exit(foreign.restoreContext(compaction.id)))._tag).toBe("Failure");
        expect(sessionTree(isolatedLedger().kernel, "FOREIGN")).toEqual(foreignBefore);
        expect((yield* handle.restoreContext(compaction.id)).terminal).toBe("executed");
        expect(sessionTree(isolatedLedger().kernel, "S").slice(0, before.length)).toEqual(before);
        // W5.2: no lease release; the restore's fence owner stays durable.
        expect(isolatedLedger().kernel.row("S").fenceOwner).not.toBeNull();
        expect(canonicalDigest(sessionTree(isolatedLedger().kernel, "S"))).not.toBe(
          canonicalDigest(before),
        );
      }),
    ));
});
