/** #1348: the shared durable-session-handle suite plane (state, runners, kernel reads, program runner). */
import { afterEach, beforeEach, expect } from "bun:test";
import { Effect, type Scope } from "effect";
import type { Delivery, PolicyRow } from "@openomni/protocol";
import { type BusEvent, type LedgerAction, L0Observation, type ObservationSink, type SessionGeneration, type SessionTransition, type SessionTurn } from "@openomni/protocol";
import type { ExecutionApprovalRequest } from "../../src/core/gate/decide";
import { closeSessions, type SessionCreateOptions, type SessionHandle, type SessionRunner, type SessionRunnerInput } from "../../src/core/run";
import { session } from "../../src/testing/registry";
import type { LedgerError } from "../../src/core/store/errors";
import { openCatalogStore } from "../../src/core/store/catalog";
import { openSessionStore } from "../../src/core/store/session-file";
import * as SessionHandleStore from "../../src/core/store/fence";
import { CommitFailed } from "../../src/core/failure";
import type { SessionKernel } from "../../src/core/entity";
import { Bus, testBus } from "./bus";
import { sessionTree } from "./session-tree";
import { allowConfigure, isolatedRuntime, type SessionFixture, withSessionServices } from "./session-services";
import { isolated, isolatedLedger, type IsolatedLedgerHandle } from "./isolated";
import { awaitSignal, boundedSignal as bounded } from "./g0-signals";
import { seedPolicy } from "./seed-policy";
import { openRequest } from "./open-request";
import { commitReceivedMessage, type ReceivedMessageInput } from "./ingress";
import { reactivateSession } from "./wake-session";

export interface Signal<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export function signal<T>(): Signal<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve: (value: T | PromiseLike<T>) => void) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

/** A runner that ignores abort and only settles once released; tracks its concurrency. */
export function stubbornRunner(options: { readonly resumeAfterFirst?: boolean } = {}) {
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

export type StubbornRun = ReturnType<typeof stubbornRunner>;

/** Prompts, waits for the stubborn runner to enter, interrupts, and waits for the abort to reach it. */
export function interruptStubborn(handle: SessionHandle, run: StubbornRun) {
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
export function settleStubborn(
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
export function recordingRunner(text: string): { runner: SessionRunner; inputs: SessionRunnerInput[] } {
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
export function expectSingleWriterUntilSettled(
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
export function hibernatingSession(
  id: string,
  runner: SessionRunner,
  extra: Partial<SessionFixture> = {},
) {
  return Effect.gen(function* () {
    const hibernated = signal<void>();
    const fixture = track({
      ...suite.runtime,
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

export const tool = (name: string): SessionGeneration.Tool => ({
  name,
  category: "query",
  inputSchema: { type: "object", properties: {} },
});

export const system = {
  preset: "resident preset",
  blocks: [{ id: "rules", source: "test", content: "Stay deterministic." }],
} as const;

/** The fixed suite clock; nothing advances it. */
export const now = 1_000;

export interface SuiteState {
  nextId: number;
  sink: TestObservationSink;
  runtime: SessionFixture;
  readonly fixtures: SessionFixture[];
}

/** Per-test mutable suite state; `useSessionHandleSuite` resets it before every test. */
export const suite: SuiteState = freshState();

function freshState(): SuiteState {
  const sink = testObservationSink();
  return { nextId: 0, sink, runtime: freshRuntime(sink), fixtures: [] };
}

function freshRuntime(sink: TestObservationSink): SessionFixture {
  return {
    ...isolatedRuntime(),
    authorizeConfigure: allowConfigure,
    observations: sink,
    clock: () => now,
    entropy: () => `session-test-id-${++suite.nextId}`,
    processId: "session-test-process",
    // Teardown must not burn the shutdown grace waiting on retained runners.
    closeGraceMs: 0,
  };
}

/** Every fixture object that owned a registry gets closed by the test's teardown. */
export function track<T extends SessionFixture>(fixture: T): T {
  suite.fixtures.push(fixture);
  return fixture;
}

export function kernel(): SessionKernel {
  return isolatedLedger().kernel;
}

export function tree(sessionId: string): LedgerAction.Node[] {
  return sessionTree(kernel(), sessionId);
}

/** The SQL delivery projection (#1257): the old input-queue table is the chain now. */
export function deliveryRows(sessionId: string): Delivery.Row[] {
  return kernel().inputMessages(sessionId);
}

export function pendingDeliveries(sessionId: string): Delivery.Row[] {
  return kernel().pendingMessages(sessionId);
}

/** Out-of-band ingress onto the received-message chain, error-mapped like the handle plane. */
export function commitDelivery(input: ReceivedMessageInput) {
  return commitReceivedMessage(kernel(), input).pipe(
    Effect.mapError((error: LedgerError) => new CommitFailed({ error })),
  );
}

export function declare(options: SessionCreateOptions, fixture: SessionFixture = suite.runtime) {
  return withSessionServices(session(options, fixture), fixture);
}

export function reactivate(id: string, runner: SessionRunner, fixture: SessionFixture = suite.runtime) {
  return withSessionServices(reactivateSession(id, runner, fixture), fixture);
}

/** Registers the suite's per-test reset: fresh bus, sink, id counter and tracked runtime. */
export function useSessionHandleSuite(): void {
  beforeEach(() => {
    Bus.reset();
    suite.nextId = 0;
    suite.sink = testObservationSink();
    suite.fixtures.length = 0;
    suite.runtime = track(freshRuntime(suite.sink));
  });
  afterEach(() => Bus.reset());
}

export interface TestProgramOptions {
  readonly policies?: readonly Omit<PolicyRow.Row, "generation">[];
  readonly seedPolicies?: boolean;
}

export function testProgram<A, E>(
  program: Effect.Effect<A, E, Scope.Scope>,
  options: TestProgramOptions = {},
) {
  return isolated(
    Effect.scoped(
      Effect.gen(function* () {
        if (options.seedPolicies !== false) seedPolicy(options.policies ?? []);
        return yield* program.pipe(
          Effect.ensuring(
            Effect.forEach(suite.fixtures.splice(0), (fixture) => closeSessions(fixture), {
              discard: true,
            }).pipe(Effect.orDie),
          ),
        );
      }),
    ),
    (): IsolatedLedgerHandle => {
      let storeNow = 0;
      const storeOptions = { now: () => (storeNow += 1), observationSink: suite.sink };
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

export function residentOptions(id: string, runner: SessionRunner): SessionCreateOptions {
  return { id, role: "resident", runner, tools: [tool("read")], system };
}

export function policyHook(action: Pick<LedgerAction.Append, "kind" | "intent">): string | undefined {
  if (action.kind !== "policy.decision") return undefined;
  const value = action.intent.value;
  if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  return typeof value.hook === "string" ? value.hook : undefined;
}

export function policyGeneration(action: LedgerAction.Node): number | undefined {
  if (action.kind !== "policy.decision") return undefined;
  const value = action.intent.value;
  if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  return typeof value.generation === "number" ? value.generation : undefined;
}

export function deliveries(sessionId: string): SessionTurn.Delivery[] {
  return tree(sessionId)
    .map(SessionHandleStore.delivery)
    .filter((delivery): delivery is SessionTurn.Delivery => delivery !== undefined);
}

export function terminals(sessionId: string): SessionTurn.Terminal[] {
  return tree(sessionId)
    .map(SessionHandleStore.turnTerminal)
    .filter((terminal): terminal is SessionTurn.Terminal => terminal !== undefined);
}

/**
 * A crashed activation's durable trace: materialized session, the dead
 * owner's adopted fence, and one open turn pinned to the recorded generation.
 */
export function commitOpenTurn(input: {
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

export function durableRequest(sessionId: string, turnId: string): SessionTransition.Request {
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

export function approvalRequest(sessionId: string, turnId: string): ExecutionApprovalRequest {
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

