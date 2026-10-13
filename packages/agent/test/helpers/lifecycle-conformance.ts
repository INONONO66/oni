/** #1348: the session lifecycle conformance harness (docs/session-lifecycle-contract.md section 6). */
import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, type Exit, Fiber, Scope } from "effect";
import { z } from "zod";
import { type BusEvent, canonicalDigest, type Delivery, type LedgerAction, type LedgerSession, L0Observation, type ObservationSink, type PlainValue, type PolicyRow, type SessionTransition, type SessionTurn, } from "@openomni/protocol";
import { AgentFailure, type ExecutionError, type SessionError } from "../../src/core/failure";
import type { SessionHandle } from "../../src/core/run";
import { openCatalogStore } from "../../src/core/store/catalog";
import { openSessionStore } from "../../src/core/store/session-file";
import * as SessionHandleStore from "../../src/core/store/fence";
import type { SessionKernel } from "../../src/core/entity";
import { createExecutor } from "../../src/core/gate/decide";
import type { ExecutionApprovals, ExecutionBatchResult, } from "../../src/core/gate/decide";
import { closeSessions, type SessionRunner, type SessionRunnerInput, } from "../../src/core/run";
import { session } from "../../src/testing/registry";
import type { createSessionRequests } from "../../src/core/request";
import { commitSessionRequest } from "../../src/core/request";
import { testBus } from "./bus";
import { sessionTree } from "./session-tree";
import { allowConfigure, isolatedRuntime, type SessionFixture as SessionRuntime, type SessionFixture, withSessionServices } from "./session-services";
import { isolated, isolatedLedger, type IsolatedLedgerHandle } from "./isolated";
import { failure } from "./effect-g1";
import { seedPolicy } from "./seed-policy";
import { receiveOutbound } from "./effect-g2";
import { reactivateSession } from "./wake-session";
import { TEST_APPROVAL_POLICY } from "./approval-policy";
const SIGNAL_TIMEOUT_MS = 2000;
export interface Signal<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
    reject(error: Error): void;
}
export function signal<T>(): Signal<T> {
    const resolvers = Promise.withResolvers<T>();
    return { promise: resolvers.promise, resolve: resolvers.resolve, reject: resolvers.reject };
}
const ToolEventCall = z.object({ toolCallId: z.string() }).loose();
/** The storage/runtime observation sink: a lossy post-commit tape, never truth. */
class TraceSink implements ObservationSink {
    published = 0;
    readonly committedEvents: L0Observation.ActionCommitted[] = [];
    readonly started: string[] = [];
    readonly completed: string[] = [];
    readonly waiters: ((committed: L0Observation.ActionCommitted) => void)[] = [];
    publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
        this.published += 1;
        if (event.name === L0Observation.ActionCommittedEvent.name) {
            const committed = L0Observation.ActionCommitted.parse(data);
            this.committedEvents.push(committed);
            for (const waiter of this.waiters.splice(0))
                waiter(committed);
            return;
        }
        const call = ToolEventCall.safeParse(data);
        if (!call.success)
            return;
        if (event.name === "tool.execution.started")
            this.started.push(call.data.toolCallId);
        if (event.name === "tool.execution.completed")
            this.completed.push(call.data.toolCallId);
    }
    resetToolTape(): void {
        this.started.length = 0;
        this.completed.length = 0;
    }
    subscribe(): () => void {
        return () => undefined;
    }
    /** Register before triggering: resolves on the first committed action satisfying `match`. */
    committed(match: (committed: L0Observation.ActionCommitted) => boolean): Promise<void> {
        const ready = signal<void>();
        const waiter = (committed: L0Observation.ActionCommitted) => {
            if (match(committed))
                ready.resolve();
            else
                this.waiters.push(waiter);
        };
        this.waiters.push(waiter);
        return ready.promise;
    }
}
export interface SessionSnapshot {
    readonly row: LedgerSession.Row;
    readonly actions: readonly LedgerAction.Node[];
    readonly deliveries: readonly Delivery.Row[];
    readonly requests: readonly SessionTransition.Request[];
    readonly outbound: readonly SessionTransition.Outbound[];
    readonly tail: SessionTurn.Snapshot;
}
export function kernel(): SessionKernel {
    return isolatedLedger().kernel;
}
function snapshotFrom(reads: SessionKernel, sessionId: string): SessionSnapshot | undefined {
    if (!reads.listRows().some((row: LedgerSession.Row) => row.id === sessionId))
        return undefined;
    return {
        row: reads.row(sessionId),
        actions: sessionTree(reads, sessionId),
        deliveries: reads.inputMessages(sessionId),
        requests: reads.requestRows(sessionId),
        outbound: reads.outboundRows(sessionId),
        tail: reads.getSnapshot(sessionId, 4),
    };
}
export function snapshotOf(sessionId: string): SessionSnapshot | undefined {
    return snapshotFrom(kernel(), sessionId);
}
export function objectValue(value: LedgerAction.Node["intent"]["value"]): Record<string, LedgerAction.Node["intent"]["value"]> | undefined {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return undefined;
    return value;
}
export function phaseOf(action: LedgerAction.Node): string | undefined {
    const phase = objectValue(action.effect.value)?.phase;
    return typeof phase === "string" ? phase : undefined;
}
function assertAppendOnly(before: SessionSnapshot | undefined, after: SessionSnapshot): void {
    if (before === undefined)
        return;
    expect(after.actions.slice(0, before.actions.length)).toEqual([...before.actions]);
    expect(after.deliveries.length).toBeGreaterThanOrEqual(before.deliveries.length);
}
function assertCausalLinks(after: SessionSnapshot): void {
    const seen = new Set<string>();
    for (const action of after.actions) {
        expect(action.sessionId).toBe(after.row.id);
        if (action.parentId !== null)
            expect(seen.has(action.parentId)).toBe(true);
        expect(seen.has(action.id)).toBe(false);
        seen.add(action.id);
    }
    expect(after.row.revision).toBe(after.actions.length);
}
function assertTerminalUniqueness(after: SessionSnapshot): void {
    const turnTerminals = new Map<string, number>();
    const toolResults = new Map<string, number>();
    for (const action of after.actions) {
        const terminal = SessionHandleStore.turnTerminal(action);
        if (terminal !== undefined)
            turnTerminals.set(terminal.turnId, (turnTerminals.get(terminal.turnId) ?? 0) + 1);
        if (action.kind === "tool" && phaseOf(action) === "result" && action.parentId !== null)
            toolResults.set(action.parentId, (toolResults.get(action.parentId) ?? 0) + 1);
    }
    for (const count of [...turnTerminals.values(), ...toolResults.values()])
        expect(count).toBe(1);
    for (const turn of SessionHandleStore.openTurns(after.actions))
        expect(turnTerminals.has(turn.turnId)).toBe(false);
}
function assertInputConsumption(after: SessionSnapshot): void {
    const deliveries = new Map<string, number>();
    for (const action of after.actions) {
        const delivery = SessionHandleStore.delivery(action);
        if (delivery !== undefined)
            deliveries.set(delivery.deliveryId, (deliveries.get(delivery.deliveryId) ?? 0) + 1);
    }
    for (const row of after.deliveries) {
        expect(after.actions.some((action: LedgerAction.Node) => action.id === row.id)).toBe(true);
        expect(deliveries.get(row.id) ?? 0).toBeLessThanOrEqual(1);
        // The chain is the queue: consumption is the delivery action itself.
        expect(deliveries.has(row.id)).toBe(row.status === "consumed");
    }
}
function assertObservations(before: SessionSnapshot | undefined, after: SessionSnapshot, events: readonly L0Observation.ActionCommitted[]): void {
    const appended = after.actions.slice(before?.actions.length ?? 0);
    // The store and executor may both notify one commit; two notifications are not two actions.
    const observed = events.filter((committed: L0Observation.ActionCommitted, index: number) => committed.sessionId === after.row.id &&
        events.findIndex((other: L0Observation.ActionCommitted) => other.id === committed.id) === index);
    expect(observed.map((committed: L0Observation.ActionCommitted) => [committed.id, committed.kind])).toEqual(appended.map((action: LedgerAction.Node) => [action.id, action.kind]));
    for (const committed of observed) {
        expect(committed.revision).toBeGreaterThan(before?.row.revision ?? 0);
        expect(committed.revision).toBeLessThanOrEqual(after.row.revision);
    }
}
interface TraceStep {
    readonly name: string;
    run(): Effect.Effect<void, SessionError | Error, Scope.Scope>;
}
export interface Trace {
    readonly sessions: readonly string[];
    readonly steps: readonly TraceStep[];
    /** Count of physical bodies/dispatches executed so far; replay must not move it. */
    readonly dispatched: () => number;
}
export interface TraceResult {
    readonly named: ReadonlyMap<string, ReadonlyMap<string, SessionSnapshot>>;
    readonly final: ReadonlyMap<string, SessionSnapshot>;
}
export interface HarnessState {
    sink: TraceSink;
    dbPath: string;
    directory: string;
    /** The injected clock; vectors move it between steps. */
    now: number;
    nextId: number;
    readonly runtimes: SessionRuntime[];
}
/** Per-trace mutable harness state; `traceTest` resets it for every vector. */
export const harness: HarnessState = { sink: new TraceSink(), dbPath: "", directory: "", now: 1000, nextId: 0, runtimes: [] };
export function runtimeFor(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
    const runtime: SessionRuntime = {
        ...isolatedRuntime(),
        observations: harness.sink,
        clock: () => harness.now,
        entropy: () => `id-${++harness.nextId}`,
        processId: "conformance",
        closeGraceMs: 0,
        authorizeConfigure: allowConfigure,
        authorizeApproval: () => Effect.succeed({
            kind: "owner" as const,
            principalId: "owner",
            evidenceId: "credential",
        }),
        ...overrides,
    };
    harness.runtimes.push(runtime);
    return runtime;
}
/** Entity-plane boot: every durable session is woken through its own activation. */
function reactivateAll(pick: (row: LedgerSession.Row) => SessionRunner, fixture: SessionFixture) {
    return Effect.forEach(kernel().listRows(), (row: LedgerSession.Row) =>
        withSessionServices(reactivateSession(row.id, pick(row), fixture), fixture), { discard: true });
}
/** Section 6 harness entry: runs the vector, checks every prefix, then proves effect-free replay. */
export function runLifecycleTrace(trace: Trace) {
    return Effect.gen(function* () {
        const named = new Map<string, ReadonlyMap<string, SessionSnapshot>>();
        const previous = new Map<string, SessionSnapshot>();
        for (const sessionId of trace.sessions) {
            const seed = snapshotOf(sessionId);
            if (seed === undefined)
                continue;
            assertCausalLinks(seed);
            previous.set(sessionId, seed);
        }
        for (const step of trace.steps) {
            const mark = harness.sink.committedEvents.length;
            yield* step.run();
            const events = harness.sink.committedEvents.slice(mark);
            const current = new Map<string, SessionSnapshot>();
            for (const sessionId of trace.sessions) {
                const after = snapshotOf(sessionId);
                if (after === undefined)
                    continue;
                const before = previous.get(sessionId);
                assertAppendOnly(before, after);
                assertCausalLinks(after);
                assertTerminalUniqueness(after);
                assertInputConsumption(after);
                assertObservations(before, after, events);
                current.set(sessionId, after);
                previous.set(sessionId, after);
            }
            named.set(step.name, current);
        }
        yield* replayEffectFree(previous, trace.dispatched);
        return { named, final: previous };
    });
}
/** Reopen the committed image: the fold equals the last prefix, dispatch and observations stay empty. */
export function replayEffectFree(expected: ReadonlyMap<string, SessionSnapshot>, dispatched: () => number) {
    return Effect.gen(function* () {
        for (const runtime of harness.runtimes.splice(0))
            (yield* toEffect(closeSessions(runtime)));
        const bodies = dispatched();
        const mark = harness.sink.committedEvents.length;
        const publications = harness.sink.published;
        harness.sink.resetToolTape();
        // A second independent handle over the same durable image (W5.2 F1):
        // opening it commits nothing, publishes nothing, dispatches nothing.
        const replaySink = new TraceSink();
        let replayNow = 0;
        const replayOptions = { now: () => (replayNow += 1), observationSink: replaySink };
        const reopenedSession = openSessionStore(harness.dbPath, replayOptions);
        const reopenedCatalog = openCatalogStore(`${harness.dbPath}.catalog`, replayOptions);
        const reopened = SessionHandleStore.createSessionKernel(reopenedSession, reopenedCatalog);
        try {
            for (const [sessionId, snapshot] of expected) {
                const replayed = snapshotFrom(reopened, sessionId);
                if (replayed === undefined)
                    throw new Error(`replay lost session ${sessionId}`);
                expect(replayed.actions).toEqual(snapshot.actions);
                expect(replayed.deliveries).toEqual(snapshot.deliveries);
                expect(replayed.requests).toEqual(snapshot.requests);
                expect(replayed.outbound).toEqual(snapshot.outbound);
                expect(replayed.tail.turns).toEqual(snapshot.tail.turns);
                // The whole row is durable now: owner and fence survive reopen verbatim.
                expect(replayed.row).toEqual(snapshot.row);
            }
            expect(replaySink.committedEvents).toEqual([]);
            expect(harness.sink.committedEvents.slice(mark)).toEqual([]);
            expect(harness.sink.published).toBe(publications);
            expect([harness.sink.started, harness.sink.completed]).toEqual([[], []]);
            expect(dispatched()).toBe(bodies);
        }
        finally {
            reopenedSession.close();
            reopenedCatalog.close();
        }
    });
}
export function kinds(snapshot: SessionSnapshot | undefined): string[] {
    return (snapshot?.actions ?? []).map((action: LedgerAction.Node) => action.kind);
}
/** `[kind, resolution]` of every action after the four-action request seed. */
export function resolutions(snapshot: SessionSnapshot | undefined): [
    string,
    PlainValue | undefined
][] {
    return (snapshot?.actions ?? [])
        .slice(4)
        .map((action: LedgerAction.Node) => [action.kind, objectValue(action.effect.value)?.resolution]);
}
export function hookOf(sessionId: string, actionId: string): string | undefined {
    const action = sessionTree(kernel(), sessionId).find((node: LedgerAction.Node) => node.id === actionId);
    const hook = action === undefined ? undefined : objectValue(action.intent.value)?.hook;
    return typeof hook === "string" ? hook : undefined;
}
// ---------------------------------------------------------------------------
// Whole-wave fixture (section 6.3): four parsed requests A,B,C,D through the
// real `createExecutor.runBatch`, run inside the durable session runner. B
// requires Owner approval; D is the sequential batch item.
// ---------------------------------------------------------------------------
export const WAVE = ["A", "B", "C", "D"] as const;
export type WaveCall = (typeof WAVE)[number];
export const approvalRule: Omit<PolicyRow.Row, "generation"> = {
    name: "B",
    kind: "tool",
    phase: "pre",
    match: { encodingVersion: 1, value: { op: "B" } },
    verdict: { encodingVersion: 1, value: { type: "require_approval", reason: "owner" } },
    priority: 1,
};
export interface WaveFixture {
    readonly handle: SessionHandle;
    readonly runtime: SessionRuntime;
    readonly tape: WaveCall[];
    readonly entered: Record<WaveCall, Signal<void>>;
    readonly gates: Record<WaveCall, Signal<void>>;
    readonly results: Signal<readonly ExecutionBatchResult[]>;
    readonly settled: Signal<Exit.Exit<readonly ExecutionBatchResult[], ExecutionError>>;
    readonly approvals: Signal<ExecutionApprovals>;
    dispatched(): number;
}
export function waveSession(id: string, overrides: Partial<SessionRuntime> = {}) {
    return Effect.gen(function* () {
        const tape: WaveCall[] = [];
        const entered = { A: signal<void>(), B: signal<void>(), C: signal<void>(), D: signal<void>() };
        const gates = { A: signal<void>(), B: signal<void>(), C: signal<void>(), D: signal<void>() };
        const results = signal<readonly ExecutionBatchResult[]>();
        const settled = signal<Exit.Exit<readonly ExecutionBatchResult[], ExecutionError>>();
        const approvals = signal<ExecutionApprovals>();
        const runtime = runtimeFor(overrides);
        const runner: SessionRunner = (input: SessionRunnerInput) => Effect.gen(function* () {
            const executor = yield* waveExecutor(input, runtime);
            if (executor.approvals === undefined)
                throw new Error("executor without approvals");
            input.bindApprovals?.(executor.approvals);
            approvals.resolve(executor.approvals);
            // The session owns this wave's fiber; interruption must finish its
            // durable terminal cleanup before the turn can seal.
            const wave = executor.runBatch(WAVE.map((call: WaveCall) => ({
                request: {
                    kind: "tool",
                    op: call,
                    intent: { value: call },
                    effect: { category: "query" },
                    toolObservation: { turnId: input.turnId, callId: call },
                },
                ...(call === "D" ? { sequential: true as const } : {}),
                body() {
                    return Effect.gen(function* () {
                        entered[call].resolve();
                        (yield* toEffect(gates[call].promise));
                        tape.push(call);
                        return { status: "success", output: call };
                    });
                },
            })), { signal: input.signal });
            // The Effect runner owns the wave lifetime; the session tracks its fibers directly.

            const outcome = yield* wave.pipe(Effect.onExit((exit: Exit.Exit<readonly ExecutionBatchResult[], ExecutionError>) => Effect.sync(() => settled.resolve(exit))));
            results.resolve(outcome);
            if (input.signal.aborted)
                return { kind: "interrupted" };
            return { kind: "result", text: outcome.map((slot: ExecutionBatchResult) => slot.terminal).join(",") };
        });
        const handle = (yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({ id, role: "resident", runner }, fixture), fixture); }));
        return {
            handle,
            runtime,
            tape,
            entered,
            gates,
            results,
            settled,
            approvals,
            dispatched: () => tape.length,
        };
    });
}
export function waveExecutor(input: SessionRunnerInput, runtime: SessionRuntime) {
    return createExecutor({ approvalPolicy: TEST_APPROVAL_POLICY,
        signal: input.signal,
        ledger: input.ledger,
        authorizeApproval: runtime.authorizeApproval,
        approvalTimeoutMs: runtime.approvalTimeoutMs,
        retainEffect: input.retainEffect,
        identity: {
            sessionId: input.sessionId,
            role: input.role,
            parentActionId: input.turnId,
            turnId: input.turnId,
            toolsGeneration: input.toolsGeneration,
            toolsHash: input.toolsHash,
            systemHash: input.systemHash,
        },
    });
}
/** A late approve after the wave settled must refuse as stale. */
export function expectStaleApprove(opened: Pick<Effect.Success<ReturnType<typeof openWaveAtApproval>>, "pending" | "approvals">): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    expect((yield* failure(opened.approvals.answer({
        request: opened.pending,
        credential: "owner-token",
        decision: "approve",
    })))).toMatchObject({ code: "stale_approval" });
  });
}

export function openWaveAtApproval(fixture: WaveFixture, text: string) {
    return Effect.gen(function* () {
        harness.sink.resetToolTape();
        const requested = harness.sink.committed((committed: L0Observation.ActionCommitted) => committed.sessionId === fixture.handle.id && committed.kind === "request");
        const running = (yield* Effect.forkScoped(fixture.handle.prompt(text)));
        (yield* waitFor(requested, "approval request commit"));
        const approvals = (yield* waitFor(fixture.approvals.promise, "bound approvals"));
        const pending = approvals.pending()[0];
        if (pending === undefined)
            throw new Error("missing pending approval");
        expect(fixture.tape).toEqual([]);
        expect(harness.sink.started).toEqual([]);
        return { running, approvals, pending };
    });
}
export function releaseBodies(fixture: WaveFixture, order: readonly WaveCall[]) {
    return Effect.gen(function* () {
        const parallel = order.filter((call: WaveCall) => call !== "D");
        (yield* waitFor(Promise.all(parallel.map((call: WaveCall) => fixture.entered[call].promise)), "parallel body entry"));
        expect(harness.sink.started).toEqual([...parallel].sort());
        expect(harness.sink.completed).toEqual([]);
        for (const call of parallel)
            fixture.gates[call].resolve();
        (yield* waitFor(fixture.entered.D.promise, "sequential body entry after the parallel barrier"));
        expect(fixture.tape).toEqual([...parallel]);
        expect(sessionTree(kernel(), fixture.handle.id).some((action: LedgerAction.Node) => action.kind === "tool" && phaseOf(action) === "result")).toBe(false);
        fixture.gates.D.resolve();
    });
}
/** `kind:phase` per committed action: the shape of a named snapshot's history. */
export function shape(snapshot: SessionSnapshot | undefined): string[] {
    return (snapshot?.actions ?? []).map((action: LedgerAction.Node) => `${action.kind}:${phaseOf(action) ?? "-"}`);
}
/** cfg, P, prompt.pre, delivery, T, turn.pre: the six-action session wrapper of 6.3 (prompt has no post point, #1251). */
export const TURN_PREFIX = [
    "session.configure:configured",
    "prompt:-",
    "policy.decision:result",
    "prompt:delivery",
    "turn:pending",
    "policy.decision:result",
];
export const TURN_SUFFIX = ["policy.decision:result", "turn:terminal"];
export const WAVE_PRE = WAVE.map(() => "policy.decision:result");
export const WAVE_INTENT = WAVE.map(() => "tool:pending");
/** 6.4 request races: one resolution per request, every losing input recorded once or refused. */
export function assertRequestRaces(result: TraceResult): void {
    const late = result.final.get("QLATE");
    expect(late?.requests[0]).toMatchObject({
        state: "expired",
        outcome: "outcome_unknown",
        seenReplyIds: ["reply-1"],
    });
    // Late reply settles the request as outcome_unknown once; the delayed timer
    // is recorded once as a duplicate input, its retry commits nothing.
    expect(kinds(late).slice(4)).toEqual(["request", "alarm", "request", "request", "alarm", "request"]);
    expect(late?.actions.slice(4).map((action: LedgerAction.Node) => objectValue(action.effect.value)?.resolution)).toEqual(["opened", undefined, "late_unknown", "late_unknown", undefined, "duplicate"]);
    const cancelled = result.final.get("QCANCEL");
    expect(cancelled?.requests[0]).toMatchObject({
        state: "cancelled",
        outcome: "cancelled",
        seenReplyIds: ["reply-1"],
        replies: [],
    });
    expect(resolutions(cancelled)).toEqual([
        ["request", "opened"],
        ["alarm", undefined],
        ["request", "cancelled"],
        ["request", "cancelled"],
        ["alarm", undefined],
        ["request", "duplicate"],
    ]);
    expect(cancelled?.deliveries).toEqual([]);
    const answered = result.final.get("QANSWER");
    expect(answered?.requests[0]).toMatchObject({
        state: "resolved",
        outcome: "answered",
        replies: [{ replyId: "reply-1", responderId: "child", content: "ok", receivedAt: 1099 }],
    });
    // The winning reply is delivered to the turn as pending delivery input; the
    // later Owner cancel is recorded once as a duplicate and changes nothing.
    expect(resolutions(answered)).toEqual([
        ["request", "opened"],
        ["alarm", undefined],
        ["request", "resolved"],
        ["request", "resolved"],
        ["alarm", undefined],
        ["prompt", undefined],
        ["request", "duplicate"],
    ]);
    expect(answered?.deliveries.map((row: Delivery.Row) => [row.id, row.kind, row.status])).toEqual([
        ["reply-1", "prompt", "pending"],
    ]);
    const rejected = result.final.get("QREJECT");
    expect(rejected?.requests[0]).toMatchObject({ state: "open", seenReplyIds: [], replies: [] });
    expect(resolutions(rejected)).toEqual([
        ["request", "opened"],
        ["alarm", undefined],
        ["request", "rejected"],
        ["request", "rejected"],
        ["request", "rejected"],
    ]);
}
/** The complete snapshot of `sessionId` after the named step; a missing one fails the trace. */
function named(result: TraceResult, step: string, sessionId: string): SessionSnapshot {
    const snapshot = result.named.get(step)?.get(sessionId);
    if (snapshot === undefined)
        throw new Error(`no ${sessionId} snapshot after ${step}`);
    return snapshot;
}
/** 6.4 child/parent loss boundary: the reply is delivered once across two recoveries. */
export function assertLossBoundary(result: TraceResult, parentChild: ReturnType<typeof childParentFixture>): void {
    expect(named(result, "CP_SEALED", "CHILD").outbound).toMatchObject([
        { state: "pending", destinationReceipt: null },
    ]);
    expect(named(result, "CP_SEALED", "PARENT").deliveries).toEqual([]);
    expect(named(result, "CP_RECEIVED", "CHILD").outbound.map((row: SessionTransition.Outbound) => row.state)).toEqual([
        "pending",
    ]);
    const receivedParent = named(result, "CP_RECEIVED", "PARENT");
    expect(receivedParent.deliveries).toHaveLength(1);
    const ackedParent = named(result, "CP_ACKED", "PARENT");
    expect(ackedParent.actions).toEqual(receivedParent.actions);
    const [delivered] = named(result, "CP_ACKED", "CHILD").outbound;
    if (delivered === undefined)
        throw new Error("child lost its outbound obligation");
    expect(delivered).toMatchObject({
        state: "delivered",
        message: { replyTo: "mCR", destinationSessionId: "PARENT", terminal: "completed" },
    });
    expect(delivered.destinationReceipt?.id).toBe(delivered.message.messageId);
    expect(ackedParent.deliveries.map((row: Delivery.Row) => row.id)).toEqual([delivered.message.messageId]);
    expect(parentChild.sent()).toHaveLength(1);
    expect(parentChild.consumed()).toBe(1);
}
// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------
const owner: SessionTransition.Principal = {
    kind: "owner",
    principalId: "owner",
    evidenceId: "credential",
};
export function requestOf(map: ReadonlyMap<string, SessionTransition.Request>, id: string) {
    const request = map.get(id);
    if (request === undefined)
        throw new Error(`no request for ${id}`);
    return request;
}
/**
 * An Owner cancel issued from outside a live handle: a fresh fence adoption
 * around the shared request commit, exactly like the gateway port's own
 * transition. No release follows - the next writer adopts over this fence.
 */
export function cancelRequest(q: SessionTransition.Request, runtime: SessionRuntime) {
    return Effect.gen(function* () {
        const controller = `conformance:control:${++harness.nextId}`;
        const row = kernel().row(q.sessionId);
        const adopted = (yield* kernel().adoptFence({
            sessionId: q.sessionId,
            owner: controller,
            fence: row.fence + 1,
        }));
        return (yield* commitSessionRequest(kernel(), q.sessionId, { owner: controller, fence: adopted.fence }, { kind: "request.cancel", requestId: q.requestId, principal: owner }, `cancel-1:${q.sessionId}`, 1099, runtime)).resolution;
    });
}
export function reply(q: SessionTransition.Request, inputId: string, receivedAt: number): SessionTransition.Answer {
    return {
        inputId,
        requestId: q.requestId,
        sessionId: q.sessionId,
        receivedAt,
        principal: { kind: "session", principalId: "child", evidenceId: "child-credential" },
        bindingDigest: q.bindingDigest,
        inputHash: q.inputHash,
        effectHash: q.effectHash,
        generation: q.generation,
        toolsHash: q.toolsHash,
        domainRevisions: q.domainRevisions,
        decision: "answer",
        allowedAction: "report_result",
        content: "ok",
    };
}
/** The pending turn every 6.x seed opens under its `cfg` boundary at the given generation. */
function pendingTurn(sessionId: string, turnId: string, boundaryActionId: string, resultId: string, generation: ReturnType<typeof SessionHandleStore.latestGeneration>): LedgerAction.Append {
    return {
        id: turnId,
        sessionId,
        parentId: boundaryActionId,
        kind: "turn",
        intent: {
            encodingVersion: 1,
            value: {
                phase: "intent",
                resultId,
                deliveryIds: [],
                resumeCount: 0,
                boundaryActionId,
                toolsGeneration: generation.generation,
                toolsHash: generation.toolsHash,
                systemHash: generation.systemHash,
                policyGeneration: 1,
            },
        },
        effect: { encodingVersion: 1, value: { phase: "pending" } },
        ts: harness.now,
        irreversible: true,
    };
}
/** A fresh resident at G1 whose fence `owner` adopted: the seed every request fixture starts from. */
function seedLeasedResident(id: string, actionId: string, owner: string) {
    return Effect.gen(function* () {
        const created = (yield* kernel().materialize({
            id,
            parentId: null,
            role: "resident",
            tools: [],
            system: { preset: "", blocks: [] },
            policyGeneration: 1,
            actionId,
            at: harness.now,
        }));
        const generation = SessionHandleStore.latestGeneration(sessionTree(kernel(), id));
        const lease = (yield* kernel().adoptFence({
            sessionId: id,
            owner,
            fence: created.row.fence + 1,
        }));
        return { created, generation, lease };
    });
}
/** The immutable request prefix of 6.4: cfg, T, q-pre, q (a real tool intent with value {value:"B"}). */
export function seedRequestSession(id: string) {
    return Effect.gen(function* () {
        const { created, generation, lease } = (yield* seedLeasedResident(id, `${id}:cfg`, "o"));
        const turn = `${id}:T`;
        const _committed = (yield* kernel().commit({
            sessionId: id,
            owner: "o",
            fence: lease.fence,
            now: harness.now,
            expectedRevision: created.row.revision,
            state: "running",
            actions: [
                pendingTurn(id, turn, `${id}:cfg`, `${id}:R`, generation),
                {
                    id: `${id}:q-pre`,
                    sessionId: id,
                    parentId: turn,
                    kind: "policy.decision",
                    intent: {
                        encodingVersion: 1,
                        value: {
                            hook: "tool.pre",
                            op: "B",
                            generation: 1,
                            matchedRuleIds: [],
                            verdict: "allow",
                            inputHash: canonicalDigest({ value: "B" }),
                        },
                    },
                    effect: { encodingVersion: 1, value: { phase: "result", reason: null } },
                    ts: harness.now,
                    irreversible: true,
                },
                {
                    id: `${id}:q`,
                    sessionId: id,
                    parentId: turn,
                    kind: "tool",
                    intent: {
                        encodingVersion: 1,
                        value: {
                            phase: "intent",
                            op: "B",
                            value: { value: "B" },
                            effectHash: canonicalDigest({ category: "query" }),
                            callId: "B",
                            turnId: turn,
                            waveId: `${id}:q`,
                        },
                    },
                    effect: { encodingVersion: 1, value: { phase: "pending" } },
                    ts: harness.now,
                    irreversible: true,
                },
            ],
        }));
    });
}
export function openRequest(port: Effect.Success<ReturnType<typeof createSessionRequests>>, id: string) {
    return Effect.gen(function* () {
        const request = yield* port.open({
            requestId: `${id}:q`,
            sessionId: id,
            expectedResponders: ["child"],
            correlation: { channelId: "ch", replyToMessageId: "platform-1" },
            allowedActions: ["report_result"],
            resolution: "first",
            threshold: 1,
            deadline: 1100,
            at: harness.now,
        });
        expect(request.state).toBe("open");
        return request;
    });
}
/** Crash-open seed of 6.2: dead owner, T pinned to G1 while the row already points at G2. */
export function seedCrashOpen(id: string) {
    return Effect.gen(function* () {
        const { created, generation, lease } = (yield* seedLeasedResident(id, "cfg", "dead"));
        const g2 = SessionHandleStore.generationSnapshot({
            generation: generation.generation + 1,
            revertTo: generation.generation,
            tools: [],
            system: { preset: "", blocks: [{ id: "b", source: "fixture", content: "v2" }] },
            policyGeneration: 1,
        });
        const _committed = (yield* kernel().commit({
            sessionId: id,
            owner: "dead",
            fence: lease.fence,
            now: harness.now,
            expectedRevision: created.row.revision,
            state: "running",
            generation: {
                toolsGeneration: g2.generation,
                systemHash: g2.systemHash,
                policyGeneration: g2.policyGeneration,
            },
            actions: [
                pendingTurn(id, "T", "cfg", "R", generation),
                SessionHandleStore.configureAction({
                    id: "cfg2",
                    sessionId: id,
                    parentId: "T",
                    operation: "system.blocks.set",
                    snapshot: g2,
                    at: harness.now + 1,
                }),
            ],
        }));
    });
}
/** Child/parent loss boundary of 6.4 on two real session histories and the real outbound path. */
export function childParentFixture() {
    const sent: string[] = [];
    let consumed = 0;
    const parentRunner: SessionRunner = () => Effect.sync(() => {
        consumed += 1;
        return { kind: "result", text: "received" };
    });
    function runtime(loseAck: boolean, dispatch: boolean, scope: Scope.Scope): SessionRuntime {
        const value = runtimeFor({
            dispatchOutbound({ message }: Parameters<NonNullable<SessionRuntime["dispatchOutbound"]>>[0]) {
                return Effect.gen(function* () {
                    if (!dispatch)
                        throw new Error("process died before wake");
                    sent.push(JSON.stringify(message));
                    const received = (yield* receiveOutbound(message, harness.now));
                    yield* Effect.gen(function* () { const fixture: SessionFixture = value; return yield* withSessionServices(reactivateSession(message.destinationSessionId, parentRunner, fixture), fixture); }).pipe(
                        Effect.provideService(Scope.Scope, scope),
                        Effect.mapError((error: SessionError) => new AgentFailure({ operation: "reactivateSession", cause: error.message })),
                    );
                    if (loseAck)
                        throw new Error("source ack lost");
                    return received.receipt;
                });
            },
        });
        return value;
    }
    return {
        sent: () => sent,
        consumed: () => consumed,
        sealWithoutWake() {
            return Effect.scoped(Effect.gen(function* () {
                const first = runtime(false, false, yield* Effect.scope);
                (yield* Effect.gen(function* () { const fixture: SessionFixture = first; return yield* withSessionServices(session({ id: "PARENT", role: "resident", runner: parentRunner }, fixture), fixture); }));
                const child = (yield* Effect.gen(function* () { const fixture: SessionFixture = first; return yield* withSessionServices(session({
                    id: "CHILD",
                    parentId: "PARENT",
                    role: "child",
                    runner: () => Effect.succeed({ kind: "result" as const, text: "done" }),
                }, fixture), fixture); }));
                // The parent's real source action: the reply observation resolves it.
                const source = sessionTree(kernel(), "PARENT")[0]?.id;
                if (source === undefined)
                    throw new Error("parent has no source action");
                expect((yield* failure(child.prompt("hello", {
                    encodingVersion: 1,
                    value: {
                        kind: "message",
                        messageId: "mCR",
                        senderSessionId: "PARENT",
                        sourceActionId: source,
                    },
                })))).toBeInstanceOf(Error);
                // Process loss closes fiber ownership, not the graceful session
                // API, which would append a new interrupt to the parent queue.
                harness.runtimes.splice(harness.runtimes.indexOf(first), 1);
            }));
        },
        recoverLosingAck() {
            return Effect.scoped(Effect.gen(function* () {
                harness.now = 2000;
                const second = runtime(true, true, yield* Effect.scope);
                expect((yield* failure(Effect.gen(function* () { const fixture: SessionFixture = second; return yield* reactivateAll((row: LedgerSession.Row) => (row.id === "PARENT" ? parentRunner : rejectReplay), fixture); })))).toBeInstanceOf(Error);
                harness.runtimes.splice(harness.runtimes.indexOf(second), 1);
            }));
        },
        recoverAndAck() {
            return Effect.gen(function* () {
                harness.now = 33000;
                const third = runtime(false, true, yield* Effect.scope);
                (yield* toEffect(Effect.gen(function* () { const fixture: SessionFixture = third; return yield* reactivateAll((row: LedgerSession.Row) => (row.id === "PARENT" ? parentRunner : rejectReplay), fixture); })));
                (yield* toEffect(closeSessions(third)));
                harness.runtimes.splice(harness.runtimes.indexOf(third), 1);
            });
        },
    };
}
const rejectReplay: SessionRunner = () => Effect.die(new Error("sealed child replayed"));

export function toEffect<A, E = never, R = never>(value: Effect.Effect<A, E, R> | Promise<A> | A): Effect.Effect<A, E, R> {
 return Effect.isEffect(value) ? value : value instanceof Promise ? Effect.promise(() => value) : Effect.succeed(value);
}
export function waitFor<A, E = never>(value: Promise<A> | Fiber.Fiber<A, E> | Effect.Effect<A, E, Scope.Scope>, label: string): Effect.Effect<A, E | Error, Scope.Scope> {
 const program = value instanceof Promise ? Effect.promise(() => value) : Fiber.isFiber(value) ? Fiber.join(value) : value;
 return program.pipe(Effect.timeoutOrElse({duration: SIGNAL_TIMEOUT_MS, orElse: () => Effect.fail(new Error(label))}));
}
export function traceTest(body: () => Effect.Effect<void, SessionError | Error, Scope.Scope>) {
 return isolated(Effect.scoped(Effect.gen(function* () {
 harness.now = 1_000; harness.nextId = 0;
 seedPolicy();
 try { yield* body(); } finally {
 for (const runtime of harness.runtimes.splice(0)) yield* closeSessions(runtime);
 }
 })), (): IsolatedLedgerHandle => {
 harness.sink = new TraceSink();
 harness.directory = mkdtempSync(join(tmpdir(), "lifecycle-conformance-")); harness.dbPath = join(harness.directory, "ledger.sqlite");
 let storeNow = 0;
 const storeOptions = { now: () => (storeNow += 1), observationSink: harness.sink };
 const sessionStore = openSessionStore(harness.dbPath, storeOptions);
 const catalogStore = openCatalogStore(`${harness.dbPath}.catalog`, storeOptions);
 const traceKernel = SessionHandleStore.createSessionKernel(sessionStore, catalogStore);
 return {
  kernel: traceKernel, openKernel: () => traceKernel, listSessions: () => traceKernel.listRows(),
  session: sessionStore, catalog: catalogStore, bus: testBus(),
  close: () => { sessionStore.close(); catalogStore.close(); rmSync(harness.directory, {recursive: true, force: true}); },
 };
 });
}
