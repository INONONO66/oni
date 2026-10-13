import { testBus } from "./helpers/bus";
import { sessionTree } from "./helpers/session-tree";
import { allowConfigure, isolatedRuntime, type SessionFixture, withSessionServices } from "./helpers/session-services";
import type { Delivery, PolicyRow } from "@openomni/protocol";
import { Effect, Fiber, type Scope } from "effect";
import { isolated, isolatedLedger, type IsolatedLedgerHandle } from "./helpers/isolated";
import { awaitSignal, failure, boundedSignal as bounded } from "./helpers/g0-signals";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { seedPolicy } from "./helpers/seed-policy";
import { openRequest } from "./helpers/open-request";
import { commitReceivedMessage, type ReceivedMessageInput } from "./helpers/ingress";
import { reactivateSession } from "./helpers/wake-session";
import type { ExecutionApprovalRequest, ExecutionApprovals } from "../src/core/gate/decide";
import { closeSessions, type SessionCreateOptions, type SessionHandle, type SessionRunner, type SessionRunnerInput } from "../src/core/run";
import { session } from "../src/testing/registry";
import { AgentFailure, type LedgerError } from "../src/core/store/errors";
import { openCatalogStore } from "../src/core/store/catalog";
import { openSessionStore } from "../src/core/store/session-file";
import * as SessionHandleStore from "../src/core/store/fence";
import { type BusEvent, type LedgerAction, L0Observation, PlainValueSchema, type ObservationSink, type SessionGeneration, type SessionTransition, type SessionTurn, } from "@openomni/protocol";
import { CommitFailed } from "../src/core/failure";
import { GenerationOwnership } from "../src/core/ports";
import { GenerationRawSlots } from "../src/core/run";
import type { SessionKernel } from "../src/core/entity";
import { Bus } from "./helpers/bus";

// ---------------------------------------------------------------------------
// Ported to the entity plane (W5.2 #1197): handle-scoped kernels via
// `isolated()`, eager fence adoption at controller creation instead of TTL
// leases, the SQL delivery projection (`commitReceivedMessage`/`inputMessages`)
// instead of queue rows, and per-session `reactivateSession` instead of the
// boot sweep.
//
// Deleted with their planes, not ported:
// - "keeps the durable lease held through an ignored abort so no other
//   runtime can resume" and "reports typed lease contention from the
//   SQLite-backed session API": TTL lease-acquisition contention is
//   deleted - a successor activation adopts the next fence instead of being
//   refused, and the stale writer's commit dies at the fence CAS. Proven by
//   conformance T11, the owner_reclaimed_before_stale_transcript_flush crash
//   cell, and "does not overlap a resumed runner..." below.
// - "a retained runner whose lease lapsed does not wedge the handle": lease
//   TTL/expiry is deleted; there is no lapse. The surviving behavior (a
//   stubborn runner cannot wedge later turns) is covered by the resume and
//   close-grace tests below.
// - "a refused retained release surfaces once to the next turn start and then
//   clears": the empty lease-release commit is deleted; hibernation releases
//   no durable authority, so there is no release commit to refuse.
// - "heartbeat loss aborts the runner and the stale fence cannot seal its
//   result" and "default heartbeat uses an unreferenced timer and clears it
//   after the runner settles": the heartbeat scheduling plane is
//   deleted; fence adoption at activation is the takeover authority.
//   Stale-fence-cannot-seal is proven by conformance T11 and the
//   owner_reclaimed crash cell.
// - "watch installs its subscription before reading the initial snapshot":
//   the injectable storage-adapter seam it hooked is deleted,
//   and the ordering is structural now - `watchSnapshot` subscribes and takes
//   its initial snapshot inside one store transaction.
// ---------------------------------------------------------------------------

interface Signal<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function signal<T>(): Signal<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve: (value: T | PromiseLike<T>) => void) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

/** A runner that ignores abort and only settles once released; tracks its concurrency. */
function stubbornRunner(options: { readonly resumeAfterFirst?: boolean } = {}) {
  const entered = signal<void>();
  const abortSeen = signal<void>();
  const releaseRunner = signal<void>();
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const runner: SessionRunner = (input: SessionRunnerInput) =>
    Effect.gen(function* () {
      calls += 1;
      if (options.resumeAfterFirst && calls > 1) return { kind: "result", text: "resumed" };
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      input.signal.addEventListener("abort", () => abortSeen.resolve(), { once: true });
      const settled = releaseRunner.promise.then(() => {
        active -= 1;
      });
      input.retainEffect?.(settled);
      entered.resolve();
      yield* Effect.promise(() => settled);
      return { kind: "result", text: "late" };
    });
  return {
    runner,
    entered,
    abortSeen,
    releaseRunner,
    maximumActive: () => maximumActive,
    calls: () => calls,
  };
}

type StubbornRun = ReturnType<typeof stubbornRunner>;

/** Prompts, waits for the stubborn runner to enter, interrupts, and waits for the abort to reach it. */
function interruptStubborn(handle: SessionHandle, run: StubbornRun) {
  return Effect.gen(function* () {
    const running = yield* Effect.forkChild(handle.prompt("start"));
    yield* awaitSignal(bounded(run.entered.promise, "runner entry"));
    const interrupted = yield* Effect.forkChild(handle.interrupt());
    yield* awaitSignal(bounded(run.abortSeen.promise, "runner abort signal"));
    return { running, interrupted };
  });
}

/**
 * The caller-facing interrupt completes at the sealed terminal, not when the
 * abort-ignoring runner finally settles; the activation keeps its fence
 * pinned until then.
 */
function settleStubborn(
  handle: SessionHandle,
  run: StubbornRun,
  pending: Effect.Success<ReturnType<typeof interruptStubborn>>,
  hibernated: Signal<void>,
) {
  return Effect.gen(function* () {
    yield* awaitSignal(bounded(pending.interrupted, "interrupt receipt before runner settlement"));
    expect(kernel().row(handle.id).fenceOwner).not.toBeNull();
    run.releaseRunner.resolve();
    yield* awaitSignal(
      bounded(
        Effect.all([awaitSignal(pending.running), awaitSignal(hibernated.promise)], {
          concurrency: "unbounded",
        }),
        "runner settlement + hibernation",
      ),
    );
  });
}

/** A runner that records every input it receives and answers `text`. */
function recordingRunner(text: string): { runner: SessionRunner; inputs: SessionRunnerInput[] } {
  const inputs: SessionRunnerInput[] = [];
  const runner: SessionRunner = (input: SessionRunnerInput) =>
    Effect.sync(() => {
      inputs.push(input);
      return { kind: "result", text };
    });
  return { runner, inputs };
}

/**
 * While the stubborn runner lives exactly one writer runs and this
 * activation's fence stays pinned; once it settles no overlap ever happened.
 * (The old lease-contention probe is gone with the TTL plane; a successor
 * would adopt fence+1, so an unchanged fence IS the no-takeover witness.)
 */
function expectSingleWriterUntilSettled(
  handle: SessionHandle,
  run: StubbornRun,
  pending: Effect.Success<ReturnType<typeof interruptStubborn>>,
  hibernated: Signal<void>,
  fence: number = handle.get().lease.fence,
) {
  return Effect.gen(function* () {
    expect(handle.get().lease.fence).toBe(fence);
    expect(run.maximumActive()).toBe(1);
    yield* awaitSignal(settleStubborn(handle, run, pending, hibernated));
    expect(kernel().row(handle.id).fence).toBe(fence);
    expect(run.maximumActive()).toBe(1);
  });
}

/** Declares `id` with a runtime whose hibernation resolves the returned signal. */
function hibernatingSession(
  id: string,
  runner: SessionRunner,
  extra: Partial<SessionFixture> = {},
) {
  return Effect.gen(function* () {
    const hibernated = signal<void>();
    const fixture = track({
      ...runtime,
      ...extra,
      onHibernate: () => Effect.sync(() => hibernated.resolve()),
    });
    const handle = yield* declare(residentOptions(id, runner), fixture);
    return { handle, hibernated };
  });
}

interface TestObservationSink extends ObservationSink {
  dropNextCommit: boolean;
  onCommit: ((committed: L0Observation.ActionCommitted) => void) | undefined;
}

function testObservationSink(): TestObservationSink {
  return {
    dropNextCommit: false,
    onCommit: undefined,
    publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
      if (event.name === L0Observation.ActionCommittedEvent.name) {
        if (this.dropNextCommit) {
          this.dropNextCommit = false;
          return;
        }
        this.onCommit?.(L0Observation.ActionCommittedEvent.schema.parse(data));
      }
      Bus.publish(event, data);
    },
    subscribe: Bus.subscribe,
  };
}

const tool = (name: string): SessionGeneration.Tool => ({
  name,
  category: "query",
  inputSchema: { type: "object", properties: {} },
});

const system = {
  preset: "resident preset",
  blocks: [{ id: "rules", source: "test", content: "Stay deterministic." }],
} as const;

let now = 1_000;
let nextId = 0;
let sink: TestObservationSink;
let runtime: SessionFixture;
const fixtures: SessionFixture[] = [];

/** Every fixture object that owned a registry gets closed by the test's teardown. */
function track<T extends SessionFixture>(fixture: T): T {
  fixtures.push(fixture);
  return fixture;
}

function kernel(): SessionKernel {
  return isolatedLedger().kernel;
}

function tree(sessionId: string): LedgerAction.Node[] {
  return sessionTree(kernel(), sessionId);
}

/** The SQL delivery projection (#1257): the old input-queue table is the chain now. */
function deliveryRows(sessionId: string): Delivery.Row[] {
  return kernel().inputMessages(sessionId);
}

function pendingDeliveries(sessionId: string): Delivery.Row[] {
  return kernel().pendingMessages(sessionId);
}

/** Out-of-band ingress onto the received-message chain, error-mapped like the handle plane. */
function commitDelivery(input: ReceivedMessageInput) {
  return commitReceivedMessage(kernel(), input).pipe(
    Effect.mapError((error: LedgerError) => new CommitFailed({ error })),
  );
}

function declare(options: SessionCreateOptions, fixture: SessionFixture = runtime) {
  return withSessionServices(session(options, fixture), fixture);
}

function reactivate(id: string, runner: SessionRunner, fixture: SessionFixture = runtime) {
  return withSessionServices(reactivateSession(id, runner, fixture), fixture);
}

beforeEach(() => {
  Bus.reset();
  now = 1_000;
  nextId = 0;
  sink = testObservationSink();
  fixtures.length = 0;
  runtime = track({
    ...isolatedRuntime(),
    authorizeConfigure: allowConfigure,
    observations: sink,
    clock: () => now,
    entropy: () => `session-test-id-${++nextId}`,
    processId: "session-test-process",
    // Teardown must not burn the shutdown grace waiting on retained runners.
    closeGraceMs: 0,
  });
});

afterEach(() => Bus.reset());

interface TestProgramOptions {
  readonly policies?: readonly Omit<PolicyRow.Row, "generation">[];
  readonly seedPolicies?: boolean;
}

function testProgram<A, E>(
  program: Effect.Effect<A, E, Scope.Scope>,
  options: TestProgramOptions = {},
) {
  return isolated(
    Effect.scoped(
      Effect.gen(function* () {
        if (options.seedPolicies !== false) seedPolicy(options.policies ?? []);
        return yield* program.pipe(
          Effect.ensuring(
            Effect.forEach(fixtures.splice(0), (fixture) => closeSessions(fixture), {
              discard: true,
            }).pipe(Effect.orDie),
          ),
        );
      }),
    ),
    (): IsolatedLedgerHandle => {
      let storeNow = 0;
      const storeOptions = { now: () => (storeNow += 1), observationSink: sink };
      const sessionStore = openSessionStore(":memory:", storeOptions);
      const catalogStore = openCatalogStore(":memory:", storeOptions);
      const testKernel = SessionHandleStore.createSessionKernel(sessionStore, catalogStore);
      return {
        kernel: testKernel,
        openKernel: () => testKernel,
        listSessions: () => testKernel.listRows(),
        session: sessionStore,
        catalog: catalogStore,
        bus: testBus(),
        close: () => {
          sessionStore.close();
          catalogStore.close();
        },
      };
    },
  );
}

function residentOptions(id: string, runner: SessionRunner): SessionCreateOptions {
  return { id, role: "resident", runner, tools: [tool("read")], system };
}

function policyHook(action: Pick<LedgerAction.Append, "kind" | "intent">): string | undefined {
  if (action.kind !== "policy.decision") return undefined;
  const value = action.intent.value;
  if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  return typeof value.hook === "string" ? value.hook : undefined;
}

function policyGeneration(action: LedgerAction.Node): number | undefined {
  if (action.kind !== "policy.decision") return undefined;
  const value = action.intent.value;
  if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  return typeof value.generation === "number" ? value.generation : undefined;
}

function deliveries(sessionId: string): SessionTurn.Delivery[] {
  return tree(sessionId)
    .map(SessionHandleStore.delivery)
    .filter((delivery): delivery is SessionTurn.Delivery => delivery !== undefined);
}

function terminals(sessionId: string): SessionTurn.Terminal[] {
  return tree(sessionId)
    .map(SessionHandleStore.turnTerminal)
    .filter((terminal): terminal is SessionTurn.Terminal => terminal !== undefined);
}

/**
 * A crashed activation's durable trace: materialized session, the dead
 * owner's adopted fence, and one open turn pinned to the recorded generation.
 */
function commitOpenTurn(input: {
  readonly sessionId: string;
  readonly resultId: string;
  readonly resumeCount: number;
  readonly toolsHash?: string;
}) {
  return Effect.gen(function* () {
    const created = yield* kernel().materialize({
      id: input.sessionId,
      parentId: null,
      role: "resident",
      tools: [tool("read")],
      system,
      policyGeneration: kernel().currentPolicyGeneration(),
      actionId: `${input.sessionId}:configure`,
      at: now,
    });
    const generation = SessionHandleStore.latestGeneration(tree(input.sessionId));
    const adopted = yield* kernel().adoptFence({
      sessionId: input.sessionId,
      owner: "crashed-owner",
      fence: created.row.fence + 1,
    });
    yield* kernel().commit({
      sessionId: input.sessionId,
      owner: "crashed-owner",
      fence: adopted.fence,
      now,
      expectedRevision: created.row.revision,
      actions: [
        {
          id: `${input.sessionId}:turn`,
          parentId: tree(input.sessionId).at(-1)?.id ?? null,
          sessionId: input.sessionId,
          kind: "turn",
          intent: {
            encodingVersion: 1,
            value: {
              phase: "intent",
              resultId: input.resultId,
              deliveryIds: [],
              toolsGeneration: generation.generation,
              toolsHash: input.toolsHash ?? generation.toolsHash,
              systemHash: generation.systemHash,
              policyGeneration: generation.policyGeneration,
              resumeCount: input.resumeCount,
              boundaryActionId: null,
            },
          },
          effect: { encodingVersion: 1, value: { phase: "pending" } },
          irreversible: true,
          ts: now,
        },
      ],
      state: "running",
    });
  });
}

function durableRequest(sessionId: string, turnId: string): SessionTransition.Request {
  const generation = SessionHandleStore.latestGeneration(tree(sessionId));
  return openRequest({
    requestId: `${sessionId}:request`,
    sessionId,
    turnId,
    callId: `${sessionId}:call`,
    toolsGeneration: generation.generation,
    toolsHash: generation.toolsHash,
    systemHash: generation.systemHash,
    deadline: now + 1_000,
    createdAt: now,
  });
}

function approvalRequest(sessionId: string, turnId: string): ExecutionApprovalRequest {
  const durable = durableRequest(sessionId, turnId);
  return {
    durable,
    id: durable.requestId,
    sessionId,
    turnId,
    callId: durable.callId,
    inputHash: durable.inputHash,
    generation: 1,
    revision: 1,
    policyDecisionId: `${sessionId}:decision`,
    intent: {},
  };
}

describe("durable session handle", () => {
  test("records prompt and turn policy once at their existing durable envelopes", () =>
    testProgram(
      Effect.gen(function* () {
        const observedBeforeCommit: string[] = [];
        const observedDecisionIds = new Set<string>();
        sink.onCommit = (committed: L0Observation.ActionCommitted) => {
          if (committed.kind !== "policy.decision") return;
          observedDecisionIds.add(committed.id);
          if (!tree("policy-topology").some((action) => action.id === committed.id)) {
            observedBeforeCommit.push(committed.id);
          }
        };
        const policies = isolatedLedger().catalog.policies;
        const runner: SessionRunner = () =>
          Effect.sync(() => {
            for (const row of policies.rows(1)) policies.append({ ...row, generation: 2 });
            policies.append({
              name: "deny-new-generation-turn-post",
              kind: "turn",
              phase: "post",
              match: { encodingVersion: 1, value: { op: "session" } },
              verdict: { encodingVersion: 1, value: { type: "deny", reason: "new generation" } },
              priority: 2_000,
              generation: 2,
            });
            return { kind: "result", text: "complete" };
          });
        const handle = yield* declare(residentOptions("policy-topology", runner));

        const result = yield* awaitSignal(handle.prompt("run once"));

        const actions = tree(handle.id);
        // #1252: the delivery row shares the prompt kind; the admission row has no delivery phase.
        const isAdmittedPrompt = (action: (typeof actions)[number]) =>
          action.kind === "prompt" &&
          (action.effect.value as { phase?: string } | null)?.phase !== "delivery";
        const prompt = actions.find(isAdmittedPrompt);
        const turn = actions.find((action) => SessionHandleStore.turnIntent(action) !== undefined);
        const decisions = actions.filter((action) => action.kind === "policy.decision");
        expect(result).toEqual({ kind: "result", text: "complete" });
        expect(actions.filter(isAdmittedPrompt)).toHaveLength(1);
        expect(actions.filter((action) => action.kind === "turn")).toHaveLength(2);
        // Prompt has no post point (#1251): the executor consults prompt.pre only.
        expect(decisions.map(policyHook).sort()).toEqual([
          "prompt.pre",
          "turn.post",
          "turn.pre",
        ]);
        expect(
          decisions
            .filter((action) => policyHook(action)?.startsWith("prompt."))
            .every((action) => action.parentId === prompt?.id),
        ).toBe(true);
        expect(
          decisions
            .filter((action) => policyHook(action)?.startsWith("turn."))
            .every((action) => action.parentId === turn?.id),
        ).toBe(true);
        expect(decisions.map(policyGeneration)).toEqual([1, 1, 1]);
        expect(observedDecisionIds).toEqual(new Set(decisions.map((action) => action.id)));
        expect(observedBeforeCommit).toEqual([]);
      }),
    ));

  /** Runs one prompt against an isolation whose only extra policy row denies prompts at `phase`. */
  function promptDeniedAt(
    phase: "pre" | "post",
    reason: string,
    assertOutcome: (outcome: {
      readonly hooks: (string | undefined)[];
      readonly deliveries: Delivery.Row["status"][];
    }) => void,
  ) {
    return testProgram(
      Effect.gen(function* () {
        let calls = 0;
        const handle = yield* declare(
          residentOptions(`prompt-${phase}-deny`, () =>
            Effect.sync(() => {
              calls += 1;
              return { kind: "result", text: "must not run" };
            }),
          ),
        );
        const result = yield* awaitSignal(handle.prompt("blocked prompt"));
        expect(result).toMatchObject({
          kind: "error",
          cause: { _tag: "SessionPolicyRefusal", reason },
        });
        expect(calls).toBe(0);
        expect(tree(handle.id).filter((action) => action.kind === "turn")).toEqual([]);
        assertOutcome({
          hooks: tree(handle.id)
            .filter((action) => action.kind === "policy.decision")
            .map(policyHook),
          deliveries: deliveryRows(handle.id).map((row) => row.status),
        });
      }),
      {
        policies: [
          {
            name: `deny-prompt-${phase}`,
            kind: "prompt",
            phase,
            match: { encodingVersion: 1, value: { op: "delivery" } },
            verdict: { encodingVersion: 1, value: { type: "deny", reason } },
            priority: 2_000,
          },
        ],
      },
    );
  }

  test("a prompt pre denial consumes the pending row without constructing or running a turn", () =>
    promptDeniedAt("pre", "prompt refused", ({ hooks, deliveries }) => {
      expect(hooks).toEqual(["prompt.pre"]);
      expect(deliveries).toEqual(["consumed"]);
    }));

  // Prompt has no post point (#1251): a generation carrying a prompt post row
  // is rejected wholesale by the point registry at compile, and every
  // execution against the rejected generation fails closed.
  test("a generation with a prompt post row fails closed: the registry rejects it and no turn runs", () =>
    testProgram(
      Effect.gen(function* () {
        let calls = 0;
        const handle = yield* declare(
          residentOptions("prompt-post-rejected", () =>
            Effect.sync(() => {
              calls += 1;
              return { kind: "result", text: "must not run" };
            }),
          ),
        );
        const result = yield* awaitSignal(handle.prompt("rejected generation"));
        expect(result).toMatchObject({
          kind: "error",
          cause: { _tag: "SessionPolicyRefusal", reason: "unknown_point" },
        });
        expect(calls).toBe(0);
        expect(tree(handle.id).filter((action) => action.kind === "turn")).toEqual([]);
      }),
      {
        policies: [
          {
            name: "deny-prompt-post",
            kind: "prompt",
            phase: "post",
            match: { encodingVersion: 1, value: { op: "delivery" } },
            verdict: { encodingVersion: 1, value: { type: "deny", reason: "prompt post refused" } },
            priority: 2_000,
          },
        ],
      },
    ));

  for (const path of ["result.usage", "result.text"] as const) {
    test(`accepts a turn post transform of ${path} only when the result still satisfies its contract`, () =>
      testProgram(
        Effect.gen(function* () {
          let calls = 0;
          const handle = yield* declare(
            residentOptions(`turn-transform-${path}`, () =>
              Effect.sync(() => {
                calls += 1;
                return {
                  kind: "result",
                  text: "typed result",
                  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
                };
              }),
            ),
          );

          const result = yield* awaitSignal(handle.prompt("transform turn result"));

          expect(calls).toBe(1);
          if (path === "result.usage") {
            expect(result).toEqual({ kind: "result", text: "typed result" });
          } else {
            expect(result).toMatchObject({
              kind: "error",
              cause: { _tag: "SessionPolicyRefusal", reason: "invalid_output" },
            });
          }
        }),
        {
          policies: [
            {
              name: `transform-turn-${path}`,
              kind: "turn",
              phase: "post",
              match: { encodingVersion: 1, value: { op: "session" } },
              verdict: {
                encodingVersion: 1,
                value: { type: "transform", name: "redact", paths: [path] },
              },
              priority: 2_000,
            },
          ],
        },
      ));
  }

  for (const sample of [
    {
      name: "required counters",
      valid: true,
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    },
    {
      name: "optional counters",
      valid: true,
      usage: {
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
        reasoningTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
      },
    },
    { name: "missing required counter", valid: false, usage: { inputTokens: 4, outputTokens: 5 } },
    {
      name: "invalid optional counter",
      valid: false,
      usage: {
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
        reasoningTokens: "invalid",
      },
    },
    {
      name: "unknown counter",
      valid: false,
      usage: {
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
        unknownTokens: 1,
      },
    },
  ] as const) {
    test(`validates transformed session usage with ${sample.name}`, () =>
      testProgram(
        Effect.gen(function* () {
          const handle = yield* declare(
            residentOptions("usage-transform", () =>
              Effect.sync(() => {
                return {
                  kind: "result",
                  text: "result",
                  finishReason: "stop",
                  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
                };
              }),
            ),
          );
          const result = yield* awaitSignal(
            bounded(handle.prompt("measure"), "transformed usage terminal"),
          );
          if (sample.valid) {
            expect(result).toEqual({
              kind: "result",
              text: "result",
              finishReason: "stop",
              usage: sample.usage,
            });
          } else {
            expect(result).toMatchObject({
              kind: "error",
              cause: { _tag: "SessionPolicyRefusal", reason: "invalid_output" },
            });
          }
          expect(terminals(handle.id)).toMatchObject([{ kind: sample.valid ? "result" : "error" }]);
        }),
        {
          policies: [
            {
              name: "transform-usage",
              kind: "turn",
              phase: "post",
              match: { encodingVersion: 1, value: { op: "session" } },
              verdict: {
                encodingVersion: 1,
                value: {
                  type: "transform",
                  name: "redact",
                  paths: ["result.usage"],
                  replacement: PlainValueSchema.parse(sample.usage),
                },
              },
              priority: 2_000,
            },
          ],
        },
      ));
  }

  for (const phase of ["pre", "post"] as const) {
    test(`turn ${phase} policy denial distinguishes body-zero pre from irreversible post`, () =>
      testProgram(
        Effect.gen(function* () {
          let calls = 0;
          const handle = yield* declare(
            residentOptions(`turn-${phase}-deny`, () =>
              Effect.sync(() => {
                calls += 1;
                return { kind: "result", text: "body result" };
              }),
            ),
          );

          const result = yield* awaitSignal(handle.prompt("start the turn"));

          const hooks = tree(handle.id)
            .filter((action) => action.kind === "policy.decision")
            .map(policyHook);
          expect(result).toMatchObject({
            kind: "error",
            cause: { _tag: "SessionPolicyRefusal", reason: `turn ${phase} refused` },
          });
          expect(calls).toBe(phase === "pre" ? 0 : 1);
          expect(hooks).toEqual(
            phase === "pre"
              ? ["prompt.pre", "turn.pre"]
              : ["prompt.pre", "turn.pre", "turn.post"],
          );
          expect(terminals(handle.id).at(0)).toMatchObject({ kind: "error" });
        }),
        {
          policies: [
            {
              name: `deny-turn-${phase}`,
              kind: "turn",
              phase,
              match: { encodingVersion: 1, value: { op: "session" } },
              verdict: {
                encodingVersion: 1,
                value: { type: "deny", reason: `turn ${phase} refused` },
              },
              priority: 2_000,
            },
          ],
        },
      ));
  }

  test("refuses a turn when its pinned generation has no mandatory policy row", () =>
    testProgram(
      Effect.gen(function* () {
        let calls = 0;
        const handle = yield* declare(
          residentOptions("missing-policy", () =>
            Effect.sync(() => {
              calls += 1;
              return { kind: "result", text: "ran" };
            }),
          ),
        );

        const result = yield* awaitSignal(handle.prompt("must be refused"));

        expect(calls).toBe(0);
        expect(result).toMatchObject({
          kind: "error",
          cause: { _tag: "SessionPolicyRefusal", code: "session_policy_refused" },
        });
      }),
      { seedPolicies: false },
    ));

  test("serializes one runner and drains concurrent prompts as distinct ordered messages", () =>
    testProgram(
      Effect.gen(function* () {
        const entered = signal<SessionRunnerInput>();
        const releaseBoundary = signal<void>();
        let active = 0;
        let maximumActive = 0;
        let runs = 0;
        const drained: SessionRunnerInput["messages"][] = [];
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.gen(function* () {
            const treeAtEntry = tree(input.sessionId);
            const intent = treeAtEntry.find((action) => action.id === input.turnId);
            expect(SessionHandleStore.turnIntent(intent)?.resultId).toBe(input.resultId);
            expect(treeAtEntry.some((action) => action.id === input.resultId)).toBe(false);
            runs += 1;
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            entered.resolve(input);
            yield* awaitSignal(releaseBoundary.promise);
            drained.push([...(yield* awaitSignal(input.boundary("after_llm"))).messages]);
            active -= 1;
            return { kind: "result", text: "done" };
          });
        const handle = yield* declare(residentOptions("single-flight", runner));

        const first = yield* Effect.forkChild(handle.prompt("first prompt"));
        const firstInput = yield* awaitSignal(bounded(entered.promise, "runner entry"));
        const secondCommitted = signal<void>();
        const thirdCommitted = signal<void>();
        sink.onCommit = () => {
          const rows = deliveryRows(handle.id);
          if (rows.some((row) => row.content === "second prompt")) secondCommitted.resolve();
          if (rows.some((row) => row.content === "third prompt")) thirdCommitted.resolve();
        };
        const second = yield* Effect.forkChild(handle.prompt("second prompt"));
        yield* bounded(secondCommitted.promise, "second prompt committed");
        const third = yield* Effect.forkChild(handle.prompt("third prompt"));
        yield* bounded(thirdCommitted.promise, "third prompt committed");
        releaseBoundary.resolve();
        yield* awaitSignal(
          bounded(
            Effect.all([awaitSignal(first), awaitSignal(second), awaitSignal(third)], {
              concurrency: "unbounded",
            }),
            "serialized prompt completion",
          ),
        );

        // #1253: the mid-turn backlog is followUp by default, so the first
        // turn's boundary drains nothing and the queued prompts feed one
        // follow-up turn at turn end — still a single serialized runner.
        expect(runs).toBe(2);
        expect(maximumActive).toBe(1);
        expect(firstInput.messages).toEqual([
          { id: deliveryRows(handle.id)[0]?.id, role: "user", text: "first prompt" },
        ]);
        expect(drained).toEqual([[], []]);
        expect(deliveryRows(handle.id).map((row) => [row.content, row.status])).toEqual([
          ["first prompt", "consumed"],
          ["second prompt", "consumed"],
          ["third prompt", "consumed"],
        ]);
        expect(deliveries(handle.id).map((delivery) => delivery.deliveryId)).toEqual(
          deliveryRows(handle.id).map((row) => row.id),
        );
      }),
    ));

  test("a turn's ledger refuses a request transition once that turn has sealed", () =>
    testProgram(
      Effect.gen(function* () {
        const entered = signal<SessionRunnerInput>();
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.sync(() => {
            entered.resolve(input);
            return { kind: "result", text: "done" };
          });
        const handle = yield* declare(residentOptions("late-transition", runner));
        yield* awaitSignal(bounded(handle.prompt("first prompt"), "prompt completion"));
        const input = yield* awaitSignal(bounded(entered.promise, "runner entry"));
        const request = durableRequest(handle.id, input.turnId);
        const before = tree(handle.id);
        if (input.ledger.transition === undefined) throw new Error("missing transition port");
        const late = input.ledger.transition({ kind: "request.open", request }, "late:open", now);
        const refused = yield* Effect.flip(late);
        expect(refused).toMatchObject({
          _tag: "AgentFailure",
          operation: "session.request.transition",
          cause: "stale",
        });
        expect(tree(handle.id)).toEqual(before);
        expect(kernel().requestRows()).toEqual([]);
      }),
    ));

  test("an interrupt landing during turn.pre admission seals interrupted without entering the runner", () =>
    testProgram(
      Effect.gen(function* () {
        let runs = 0;
        const handle = yield* declare(
          residentOptions("interrupt-before-body", () =>
            Effect.sync(() => {
              runs += 1;
              return { kind: "result", text: "ran" };
            }),
          ),
        );
        const admitted = signal<void>();
        const interrupted = signal<void>();
        const target = kernel();
        const commit = target.commit.bind(target);
        const gate = spyOn(target, "commit").mockImplementation(
          (input: Parameters<typeof commit>[0]) =>
            Effect.gen(function* () {
              const receipt = yield* commit(input);
              if (input.state === "interrupted") interrupted.resolve();
              if (
                input.actions.some(
                  (action: LedgerAction.Append) => policyHook(action) === "turn.pre",
                )
              ) {
                admitted.resolve();
                yield* Effect.promise(() => interrupted.promise);
              }
              return receipt;
            }),
        );
        let result: Effect.Success<ReturnType<SessionHandle["prompt"]>>;
        try {
          const prompt = yield* Effect.forkChild(handle.prompt("never reaches the runner"));
          yield* bounded(admitted.promise, "turn.pre committed");
          const interrupt = yield* Effect.forkChild(handle.interrupt());
          result = yield* bounded(prompt, "prompt completion");
          yield* bounded(interrupt, "interrupt receipt");
        } finally {
          gate.mockRestore();
        }
        expect(result).toEqual({ kind: "interrupted", text: "" });
        expect(runs).toBe(0);
        expect(handle.get().state).toBe("interrupted");
        expect(SessionHandleStore.openTurns(tree(handle.id))).toEqual([]);
      }),
    ));

  test("a storage failure during turn admission seals the turn as an error", () =>
    testProgram(
      Effect.gen(function* () {
        let runs = 0;
        const handle = yield* declare(
          residentOptions("admission-storage-failure", () =>
            Effect.sync(() => {
              runs += 1;
              return { kind: "result", text: "ran" };
            }),
          ),
        );
        const target = kernel();
        const commit = target.commit.bind(target);
        const explode = spyOn(target, "commit").mockImplementation(
          (input: Parameters<typeof commit>[0]) => {
            const decision = input.actions.find(
              (action: LedgerAction.Append) => action.kind === "policy.decision",
            );
            if (decision === undefined || policyHook(decision) !== "turn.pre") return commit(input);
            explode.mockRestore();
            return Effect.fail(
              new AgentFailure({ operation: "session.commit", cause: "admission fixture" }),
            );
          },
        );
        const result = yield* awaitSignal(
          bounded(handle.prompt("admission fails"), "prompt completion"),
        );
        expect(result).toMatchObject({
          kind: "error",
          cause: {
            _tag: "CommitFailed",
            error: {
              _tag: "AgentFailure",
              operation: "session.commit",
              cause: "admission fixture",
            },
          },
        });
        expect(runs).toBe(0);
        expect(handle.get().state).toBe("idle");
        expect(SessionHandleStore.openTurns(tree(handle.id))).toEqual([]);
      }),
    ));

  test("records an idle interrupt as a no-op without resuming the next prompt", () =>
    testProgram(
      Effect.gen(function* () {
        const { runner, inputs } = recordingRunner("ran once");
        const handle = yield* declare(residentOptions("idle-interrupt", runner));
        yield* commitDelivery({
          id: "idle-interrupt:interrupt",
          sessionId: handle.id,
          kind: "interrupt",
          content: "",
          origin: { encodingVersion: 1, value: { source: "test" } },
          createdAt: now,
          parentActionId: tree(handle.id).at(-1)?.id ?? null,
        });

        const result = yield* awaitSignal(handle.prompt("run after the no-op"));

        expect(result).toEqual({ kind: "result", text: "ran once" });
        expect(inputs).toHaveLength(1);
        expect(inputs[0]?.resumeCount).toBe(0);
        expect(SessionHandleStore.openTurns(tree(handle.id))).toEqual([]);
        expect(
          tree(handle.id).filter((action) => SessionHandleStore.turnResume(action) !== undefined),
        ).toEqual([]);
      }),
    ));

  test("seals a queued prompt followed by an interrupt without entering the runner", () =>
    testProgram(
      Effect.gen(function* () {
        let entries = 0;
        const runner: SessionRunner = () =>
          Effect.sync(() => {
            entries += 1;
            return { kind: "result", text: "must not run" };
          });
        yield* kernel().materialize({
          id: "queued-interrupt",
          parentId: null,
          role: "resident",
          tools: [tool("read")],
          system,
          policyGeneration: kernel().currentPolicyGeneration(),
          actionId: "queued-interrupt:configure",
          at: now,
        });
        yield* commitDelivery({
          id: "queued-interrupt:prompt",
          sessionId: "queued-interrupt",
          kind: "prompt",
          content: "do not run",
          origin: { encodingVersion: 1, value: { source: "test" } },
          createdAt: now,
          parentActionId: tree("queued-interrupt").at(-1)?.id ?? null,
        });
        yield* commitDelivery({
          id: "queued-interrupt:interrupt",
          sessionId: "queued-interrupt",
          kind: "interrupt",
          content: "",
          origin: { encodingVersion: 1, value: { source: "test" } },
          createdAt: now + 1,
          parentActionId: tree("queued-interrupt").at(-1)?.id ?? null,
        });

        yield* awaitSignal(reactivate("queued-interrupt", runner));

        expect(entries).toBe(0);
        expect(SessionHandleStore.openTurns(tree("queued-interrupt"))).toEqual([]);
        expect(kernel().getSnapshot("queued-interrupt", 4)).toMatchObject({
          state: "interrupted",
          turns: [{ terminal: { kind: "interrupted" } }],
        });
      }),
    ));

  test("a leading idle interrupt is consumed before a later prompt starts", () =>
    testProgram(
      Effect.gen(function* () {
        const { runner, inputs } = recordingRunner("ran once");
        yield* kernel().materialize({
          id: "leading-idle-interrupt",
          parentId: null,
          role: "resident",
          tools: [tool("read")],
          system,
          policyGeneration: kernel().currentPolicyGeneration(),
          actionId: "leading-idle-interrupt:configure",
          at: now,
        });
        yield* commitDelivery({
          id: "leading-idle-interrupt:interrupt",
          sessionId: "leading-idle-interrupt",
          kind: "interrupt",
          content: "",
          origin: { encodingVersion: 1, value: { source: "test" } },
          createdAt: now,
          parentActionId: tree("leading-idle-interrupt").at(-1)?.id ?? null,
        });
        yield* commitDelivery({
          id: "leading-idle-interrupt:prompt",
          sessionId: "leading-idle-interrupt",
          kind: "prompt",
          content: "run afterward",
          origin: { encodingVersion: 1, value: { source: "test" } },
          createdAt: now + 1,
          parentActionId: tree("leading-idle-interrupt").at(-1)?.id ?? null,
        });

        yield* awaitSignal(reactivate("leading-idle-interrupt", runner));

        expect(inputs).toHaveLength(1);
        expect(inputs[0]?.resumeCount).toBe(0);
        expect(inputs[0]?.messages).toEqual([
          {
            id: deliveryRows("leading-idle-interrupt").find((row) => row.kind === "prompt")?.id,
            role: "user",
            text: "run afterward",
          },
        ]);
      }),
    ));

  test("consumes a running interrupt and seals interrupted rather than error", () =>
    testProgram(
      Effect.gen(function* () {
        const ready = signal<AbortSignal>();
        const aborted = signal<void>();
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.gen(function* () {
            input.signal.addEventListener(
              "abort",
              () => {
                aborted.resolve();
              },
              { once: true },
            );
            ready.resolve(input.signal);
            yield* awaitSignal(aborted.promise);
            return { kind: "result", text: "late result must not commit" };
          });
        const handle = yield* declare(residentOptions("interrupt", runner));

        const running = yield* Effect.forkChild(handle.prompt("start"));
        const runnerSignal = yield* awaitSignal(
          bounded(ready.promise, "interrupt listener installation"),
        );
        const interrupted = yield* Effect.forkChild(handle.interrupt());
        yield* awaitSignal(bounded(aborted.promise, "runner abort"));
        yield* awaitSignal(
          bounded(
            Effect.all([awaitSignal(running), awaitSignal(interrupted)], {
              concurrency: "unbounded",
            }),
            "interrupted terminal",
          ),
        );

        expect(runnerSignal.aborted).toBe(true);
        expect(deliveryRows(handle.id).map((row) => row.status)).toEqual(["consumed", "consumed"]);
        expect(terminals(handle.id)).toHaveLength(1);
        expect(terminals(handle.id)[0]?.kind).toBe("interrupted");
        expect(handle.get().state).toBe("interrupted");
      }),
    ));

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
        sink.onCommit = () => {
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
        sink.onCommit = (committed: L0Observation.ActionCommitted) => {
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
        runtime = track({
          ...runtime,
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
        runtime = track({ ...runtime, onHibernate: () => Effect.sync(() => hibernated.resolve()) });
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
            ...runtime,
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
          (action) => SessionHandleStore.turnTerminal(action) !== undefined,
        );
        expect(terminal?.id).toBe("preminted-result");
        expect(SessionHandleStore.openTurns(tree("crashed-turn"))).toEqual([]);
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
        expect(SessionHandleStore.openTurns(tree("drifted-turn"))).toHaveLength(1);
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
          SessionHandleStore.turnTerminal(
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
          SessionHandleStore.turnTerminal(
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
        expect(SessionHandleStore.turnTerminal(terminalAction)).toMatchObject({
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
        sink.dropNextCommit = true;

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
