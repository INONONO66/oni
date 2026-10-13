import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, type Fiber, } from "effect";
import { canonicalDigest, type Delivery, type LedgerAction, type L0Observation, type SessionTransition, type SessionTurn, } from "@openomni/protocol";
import { CommitFailed, type SessionError } from "../src/core/failure";
import * as SessionHandleStore from "../src/core/store/fence";
import type { ExecutionApprovalRequest, ExecutionApprovals, } from "../src/core/gate/decide";
import { closeSessions, type SessionRunner, type SessionRunnerInput, type SessionRunnerResult } from "../src/core/run";
import { session } from "../src/testing/registry";
import { createSessionRequests, } from "../src/core/request";
import { type SessionFixture, withSessionServices } from "./helpers/session-services";
import { failure } from "./helpers/effect-g1";
import { seedPolicy } from "./helpers/seed-policy";
import { reactivateSession } from "./helpers/wake-session";
import { sessionTree } from "./helpers/session-tree";
import {
  TURN_PREFIX,
  TURN_SUFFIX,
  WAVE,
  WAVE_INTENT,
  WAVE_PRE,
  approvalRule,
  assertLossBoundary,
  assertRequestRaces,
  cancelRequest,
  childParentFixture,
  expectStaleApprove,
  harness,
  hookOf,
  kernel,
  kinds,
  objectValue,
  openRequest,
  openWaveAtApproval,
  phaseOf,
  releaseBodies,
  replayEffectFree,
  reply,
  requestOf,
  resolutions,
  runLifecycleTrace,
  runtimeFor,
  seedCrashOpen,
  seedRequestSession,
  shape,
  signal,
  snapshotOf,
  toEffect,
  traceTest,
  waitFor,
  waveExecutor,
  waveSession,
} from "./helpers/lifecycle-conformance";
import type {
  SessionSnapshot,
  WaveCall,
} from "./helpers/lifecycle-conformance";
// ---------------------------------------------------------------------------
// HARNESS (docs/session-lifecycle-contract.md section 6): real ledger, session
// controller, executor waves, request transitions and outbound obligations on
// the entity plane (W5.2): handle-scoped kernels, fence adoption instead of
// TTL leases, chain-fold deliveries. Every step snapshots the complete durable
// product of each traced session, checks the standing invariants, and the
// finished trace is replayed from the file-backed SQLite image with zero
// dispatch.
//
// Deleted with their planes (W5.2 #1197), not ported:
// - "lifecycle v1 alarm takeover pause rearm and dedupe": the alarm-row
//   adapter (arm/fire/acquire/rearm/cancel/due, alarm fences, notification
//   budgets) is deleted; watch occurrences are chain actions now, proven by
//   the watch_fired_committed_before_entity_wake crash cell and the
//   cluster timer-delivery guards.
// - "T02 concurrent same-session wakes ...": in-process wake dedupe through
//   the lease-guarded live-controller registry is deleted; the surviving
//   invariant - a stale activation's commit is refused by the fence CAS and
//   exactly one turn terminal commits - is proven by T11 below and by the
//   owner_reclaimed_before_stale_transcript_flush crash cell.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 6.7 named registrations
// ---------------------------------------------------------------------------
describe("session lifecycle conformance", () => {
    test("lifecycle v1 ordinary and mixed-wave approved", () => traceTest(() => Effect.gen(function* () {
        seedPolicy([approvalRule]);
        const ordinary = runtimeFor();
        const gate = signal<void>();
        const plain = (yield* Effect.gen(function* () { const fixture: SessionFixture = ordinary; return yield* withSessionServices(session({
            id: "S",
            role: "resident",
            runner: () => Effect.gen(function* () {
                (yield* toEffect(gate.promise));
                return { kind: "result", text: "done" };
            }),
        }, fixture), fixture); }));
        const wave = (yield* waveSession("W"));
        let plainRunning: Fiber.Fiber<SessionRunnerResult | undefined, SessionError> | undefined;
        let wavePending: ExecutionApprovalRequest | undefined;
        let waveRunning: Fiber.Fiber<SessionRunnerResult | undefined, SessionError> | undefined;
        let waveApprovals: ExecutionApprovals | undefined;
        const result = yield* runLifecycleTrace({
            sessions: ["S", "W"],
            dispatched: wave.dispatched,
            steps: [
                { name: "BASE", run: () => Effect.gen(function* () {
                        return (yield* toEffect(undefined));
                    }) },
                {
                    name: "RUN",
                    run: () => Effect.gen(function* () {
                        const entered = harness.sink.committed((committed: L0Observation.ActionCommitted) => committed.sessionId === "S" && hookOf("S", committed.id) === "turn.pre");
                        plainRunning = (yield* Effect.forkScoped(plain.prompt("hello")));
                        (yield* waitFor(entered, "turn pre decision"));
                    }),
                },
                {
                    name: "DONE",
                    run: () => Effect.gen(function* () {
                        const sealed = harness.sink.committed((committed: L0Observation.ActionCommitted) => committed.sessionId === "S" &&
                            SessionHandleStore.turnTerminal(sessionTree(kernel(), "S").find((action: LedgerAction.Node) => action.id === committed.id)) !== undefined);
                        gate.resolve();
                        (yield* waitFor(sealed, "terminal result"));
                        expect((yield* waitFor(plainRunning ?? Promise.reject(new Error("no run")), "result"))).toEqual({
                            kind: "result",
                            text: "done",
                        });
                    }),
                },
                {
                    name: "WAIT",
                    run: () => Effect.gen(function* () {
                        const opened = (yield* toEffect(openWaveAtApproval(wave, "wave")));
                        wavePending = opened.pending;
                        waveRunning = opened.running;
                        waveApprovals = opened.approvals;
                    }),
                },
                {
                    name: "APPROVED",
                    run: () => Effect.gen(function* () {
                        if (wavePending === undefined || waveApprovals === undefined)
                            throw new Error("no wait");
                        (yield* toEffect(waveApprovals.answer({
                            request: wavePending,
                            credential: "owner-token",
                            decision: "approve",
                        })));
                    }),
                },
                {
                    name: "WAVE_APPROVED",
                    run: () => Effect.gen(function* () {
                        (yield* toEffect(releaseBodies(wave, ["C", "A", "B", "D"])));
                        expect((yield* waitFor(waveRunning ?? Promise.reject(new Error("no run")), "wave"))).toEqual({
                            kind: "result",
                            text: "executed,executed,executed,executed",
                        });
                        expect(harness.sink.completed).toEqual(["A", "B", "C", "D"]);
                    }),
                },
            ],
        });
        const done = result.named.get("DONE")?.get("S");
        expect(kinds(done)).toEqual([
            "session.configure",
            "prompt",
            "policy.decision",
            "prompt",
            "turn",
            "policy.decision",
            "policy.decision",
            "turn",
        ]);
        expect(done?.row).toMatchObject({
            revision: 8,
            state: "idle",
        });
        expect(done?.deliveries.map((row: Delivery.Row) => row.status)).toEqual(["consumed"]);
        expect(done?.tail.turns.at(-1)).toMatchObject({
            state: "idle",
            messages: [
                { role: "user", text: "hello" },
                { role: "assistant", text: "done" },
            ],
        });
        const wait = result.named.get("WAIT")?.get("W");
        expect(shape(wait)).toEqual([...TURN_PREFIX, ...WAVE_PRE, ...WAVE_INTENT, "request:open", "alarm:-"]);
        expect(wait?.requests.map((request: SessionTransition.Request) => request.state)).toEqual(["open"]);
        const approved = result.named.get("WAVE_APPROVED")?.get("W");
        expect(shape(approved)).toEqual([
            ...TURN_PREFIX,
            ...WAVE_PRE,
            ...WAVE_INTENT,
            "request:open",
            "alarm:-",
            "request:answered",
            "request:resolved",
            "alarm:-",
            ...WAVE.map(() => "tool:application"),
            ...WAVE.flatMap(() => ["policy.decision:result", "tool:result"]),
            ...TURN_SUFFIX,
        ]);
        expect(approved?.row.revision).toBe(33);
        expect(approved?.requests.map((request: SessionTransition.Request) => [request.state, request.outcome])).toEqual([
            ["resolved", "answered"],
        ]);
        const results = (yield* waitFor(wave.results.promise, "wave results"));
        expect(results).toEqual(WAVE.map((call: WaveCall) => ({ terminal: "executed", value: { status: "success", output: call } })));
        expect(wave.tape).toEqual(["C", "A", "B", "D"]);
        const resultsInOrder = (approved?.actions ?? [])
            .filter((action: LedgerAction.Node) => action.kind === "tool" && phaseOf(action) === "result")
            .map((action: LedgerAction.Node) => objectValue(action.effect.value)?.callId);
        expect(resultsInOrder).toEqual(["A", "B", "C", "D"]);
    })));
    test("lifecycle v1 refusal timeout and interrupt", () => traceTest(() => Effect.gen(function* () {
        seedPolicy([approvalRule]);
        const refused = (yield* waveSession("REFUSED"));
        const timed = (yield* waveSession("TIMED", { approvalTimeoutMs: 100 }));
        const interrupted = (yield* waveSession("INTERRUPTED"));
        const timedPort = (yield* Effect.gen(function* () { const fixture: SessionFixture = timed.runtime; return yield* withSessionServices(createSessionRequests(fixture), fixture); }));
        const runs = new Map<string, Fiber.Fiber<SessionRunnerResult | undefined, SessionError>>();
        const result = yield* runLifecycleTrace({
            sessions: ["REFUSED", "TIMED", "INTERRUPTED"],
            dispatched: () => refused.dispatched() + timed.dispatched() + interrupted.dispatched(),
            steps: [
                {
                    name: "REFUSE",
                    run: () => Effect.gen(function* () {
                        const opened = (yield* toEffect(openWaveAtApproval(refused, "refuse")));
                        runs.set("REFUSED", opened.running);
                        (yield* toEffect(opened.approvals.answer({
                            request: opened.pending,
                            credential: "owner-token",
                            decision: "refuse",
                        })));
                        yield* expectStaleApprove(opened);
                    }),
                },
                {
                    name: "WAVE_REFUSED",
                    run: () => Effect.gen(function* () {
                        (yield* toEffect(releaseBodies(refused, ["C", "A", "D"])));
                        (yield* waitFor(runs.get("REFUSED") ?? Promise.reject(new Error("no run")), "refused"));
                    }),
                },
                {
                    name: "TIMED",
                    run: () => Effect.gen(function* () {
                        const opened = (yield* toEffect(openWaveAtApproval(timed, "timeout")));
                        runs.set("TIMED", opened.running);
                        harness.now = 1100;
                        // The durable deadline fires once; the delayed duplicate timer and
                        // the late approve both lose to the committed expiry.
                        (yield* timedPort.timeout(opened.pending.id, harness.now));
                        (yield* timedPort.timeout(opened.pending.id, harness.now));
                        yield* waitFor(timed.entered.A.promise, "approval timeout observed by the wave");
                        yield* expectStaleApprove(opened);
                    }),
                },
                {
                    name: "WAVE_TIMEOUT",
                    run: () => Effect.gen(function* () {
                        (yield* toEffect(releaseBodies(timed, ["C", "A", "D"])));
                        (yield* waitFor(runs.get("TIMED") ?? Promise.reject(new Error("no run")), "timed"));
                    }),
                },
                {
                    name: "WAVE_INTERRUPTED",
                    run: () => Effect.gen(function* () {
                        harness.now = 1000;
                        const opened = (yield* toEffect(openWaveAtApproval(interrupted, "interrupt")));
                        const aborted = interrupted.settled.promise;
                        (yield* toEffect(interrupted.handle.interrupt()));
                        const exit = yield* waitFor(aborted, "interrupted wave");
                        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
                        (yield* waitFor(opened.running, "interrupted turn"));
                    }),
                },
            ],
        });
        // Bodies settle before the first post action; results then commit in slot
        // order A, B(blocked, no post), C, D. Refusal records the owner reply;
        // expiry records the single deadline input. Both then resolve once.
        const blockedTail = [
            "tool:application",
            "tool:application",
            "tool:application",
            "policy.decision:result",
            "tool:result",
            "tool:result",
            "policy.decision:result",
            "tool:result",
            "policy.decision:result",
            "tool:result",
            ...TURN_SUFFIX,
        ];
        for (const [id, reason, state] of [
            ["REFUSED", "approval_refused", "refused"],
            ["TIMED", "approval_timeout", "expired"],
        ] as const) {
            const final = result.final.get(id);
            expect(shape(final)).toEqual([
                ...TURN_PREFIX,
                ...WAVE_PRE,
                ...WAVE_INTENT,
                // #1254 S4: a deadline request opens with its alarm arm row
                // and its terminal transition retires the chain in-batch.
                ...(id === "REFUSED"
                    ? ["request:open", "alarm:-", "request:answered", "request:resolved", "alarm:-"]
                    : ["request:open", "alarm:-", "request:expired", "request:expired", "alarm:-"]),
                ...blockedTail,
            ]);
            expect(final?.row).toMatchObject({ revision: 31, state: "idle" });
            const blocked = final?.actions.find((action: LedgerAction.Node) => action.kind === "tool" && objectValue(action.effect.value)?.terminal === "blocked_pre");
            expect(blocked === undefined ? undefined : objectValue(blocked.effect.value)).toMatchObject({
                callId: "B",
                reason,
            });
            expect(final?.requests.map((request: SessionTransition.Request) => [request.state, request.outcome])).toEqual([
                [state, id === "REFUSED" ? "denied" : "outcome_unknown"],
            ]);
        }
        expect((yield* waitFor(refused.results.promise, "refused results"))).toMatchObject([
            { terminal: "executed" },
            { terminal: "blocked_pre", reason: "approval_refused" },
            { terminal: "executed" },
            { terminal: "executed" },
        ]);
        expect(refused.tape).toEqual(["C", "A", "D"]);
        expect(timed.tape).toEqual(["C", "A", "D"]);
        expect(interrupted.tape).toEqual([]);
        expect([harness.sink.started, harness.sink.completed]).toEqual([[], []]);
        // Interrupt at the gate: the interrupt input commits, the open request is
        // cancelled by the session principal and resolved, every slot is cancelled
        // without a body or post decision, then the turn seals as interrupted.
        const cancelled = result.final.get("INTERRUPTED");
        expect(shape(cancelled)).toEqual([
            ...TURN_PREFIX,
            ...WAVE_PRE,
            ...WAVE_INTENT,
            "request:open",
            "alarm:-",
            "signal:-",
            "request:resolved",
            "request:resolved",
            "alarm:-",
            ...WAVE.map(() => "tool:result"),
            "signal:delivery",
            "turn:terminal",
        ]);
        expect(cancelled?.row).toMatchObject({ revision: 26, state: "interrupted" });
        expect(cancelled?.requests.map((request: SessionTransition.Request) => [request.state, request.outcome])).toEqual([
            ["cancelled", "cancelled"],
        ]);
        expect(cancelled?.actions.flatMap((action: LedgerAction.Node) => action.kind === "tool" && phaseOf(action) === "result"
            ? [objectValue(action.effect.value)?.terminal]
            : [])).toEqual(["interrupted", "blocked_pre", "interrupted", "interrupted"]);
        expect(cancelled?.deliveries.map((row: Delivery.Row) => [row.kind, row.status])).toEqual([
            ["prompt", "consumed"],
            ["interrupt", "consumed"],
        ]);
    })));
    test("lifecycle v1 terminal resume differs from crash-open recovery", () => traceTest(() => Effect.gen(function* () {
        const runtime = runtimeFor();
        const entered = signal<SessionRunnerInput>();
        const aborted = signal<void>();
        const resumedEntry = signal<SessionRunnerInput>();
        let entries = 0;
        const runner: SessionRunner = (input: SessionRunnerInput) => Effect.gen(function* () {
            entries += 1;
            if (entries === 1) {
                input.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
                entered.resolve(input);
                (yield* toEffect(aborted.promise));
                return { kind: "result", text: "late" };
            }
            resumedEntry.resolve(input);
            return { kind: "result", text: "resumed" };
        });
        const handle = (yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({ id: "S", role: "resident", runner }, fixture), fixture); }));
        let firstInput: SessionRunnerInput | undefined;
        let recovered: SessionRunnerInput | undefined;
        const result = yield* runLifecycleTrace({
            sessions: ["S", "C"],
            dispatched: () => entries,
            steps: [
                {
                    name: "INTERRUPTED",
                    run: () => Effect.gen(function* () {
                        const running = (yield* Effect.forkScoped(handle.prompt("hello")));
                        firstInput = (yield* waitFor(entered.promise, "runner entry"));
                        (yield* toEffect(handle.interrupt()));
                        (yield* waitFor(running, "interrupted seal"));
                        expect(handle.get().state).toBe("interrupted");
                    }),
                },
                {
                    name: "RESUME_DONE",
                    run: () => Effect.gen(function* () {
                        harness.now = 1050;
                        (yield* toEffect(handle.system.blocks.set([{ id: "b", source: "fixture", content: "v2" }])));
                        (yield* toEffect(handle.resume()));
                        recovered = (yield* waitFor(resumedEntry.promise, "resumed entry"));
                    }),
                },
                {
                    name: "CRASH_OPEN",
                    run: () => Effect.gen(function* () {
                        (yield* seedCrashOpen("C"));
                    }),
                },
                {
                    name: "CRASH_DONE",
                    run: () => Effect.gen(function* () {
                        harness.now = 2000;
                        const swept = signal<SessionRunnerInput>();
                        // Entity-plane recovery: a fresh activation adopts the next
                        // fence over the dead owner and drives the open turn to idle.
                        (yield* waitFor(Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(reactivateSession("C", (input: SessionRunnerInput) => Effect.sync(() => {
                            swept.resolve(input);
                            return { kind: "result", text: "recovered" };
                        }), fixture), fixture); }), "entity wake"));
                        const input = (yield* waitFor(swept.promise, "wake entry"));
                        expect(input).toMatchObject({ resultId: "R", resumeCount: 1, toolsGeneration: 1 });
                        expect(kernel().row("C").toolsGeneration).toBe(2);
                        const dead = kernel().row("C");
                        const stale = () => kernel().commit({
                            sessionId: "C",
                            owner: "dead",
                            fence: 1,
                            now: harness.now,
                            expectedRevision: dead.revision,
                            actions: [],
                            state: "running",
                        });
                        expect(yield* failure(stale())).toMatchObject({ _tag: "CommitRefused", reason: "fence", currentFence: dead.fence });
                        expect(dead.fence).toBeGreaterThan(1);
                    }),
                },
            ],
        });
        const interrupted = result.named.get("INTERRUPTED")?.get("S");
        const terminal = interrupted?.actions.find((a: LedgerAction.Node) => SessionHandleStore.turnTerminal(a) !== undefined);
        expect(SessionHandleStore.turnTerminal(terminal)).toMatchObject({
            kind: "interrupted",
            resumeCount: 0,
        });
        expect(terminal?.id).toBe(firstInput?.resultId);
        expect(interrupted?.actions.some((a: LedgerAction.Node) => a.kind === "turn" &&
            phaseOf(a) === "terminal" &&
            objectValue(a.effect.value)?.text === "late")).toBe(false);
        const resumed = result.named.get("RESUME_DONE")?.get("S");
        expect(recovered?.turnId).not.toBe(firstInput?.turnId);
        expect(recovered?.resultId).not.toBe(firstInput?.resultId);
        // Resume keeps the interrupted turn's history: the new turn sees "hello".
        expect(recovered).toMatchObject({ resumeCount: 1, toolsGeneration: 2 });
        expect(recovered?.messages.map((message: SessionRunnerInput["messages"][number]) => [message.role, message.text])).toEqual([
            ["user", "hello"],
        ]);
        expect(resumed?.row).toMatchObject({ state: "idle", toolsGeneration: 2 });
        expect(resumed?.deliveries.map((row: Delivery.Row) => [row.kind, row.status])).toEqual([
            ["prompt", "consumed"],
            ["interrupt", "consumed"],
            ["resume", "consumed"],
        ]);
        expect(resumed?.tail.turns.map((turn: SessionTurn.Snapshot["turns"][number]) => turn.terminal?.kind)).toEqual([
            "interrupted",
            "result",
        ]);
        const crash = result.named.get("CRASH_DONE")?.get("C");
        expect(crash?.row).toMatchObject({
            state: "idle",
            revision: 7,
            toolsGeneration: 2,
        });
        expect(kinds(crash)).toEqual([
            "session.configure",
            "turn",
            "session.configure",
            "turn",
            "policy.decision",
            "policy.decision",
            "turn",
        ]);
        const crashTerminal = crash?.actions.at(-1);
        expect(crashTerminal?.id).toBe("R");
        expect(SessionHandleStore.turnTerminal(crashTerminal)).toMatchObject({
            turnId: "T",
            kind: "result",
            text: "recovered",
            resumeCount: 1,
        });
        expect(SessionHandleStore.turnResume(crash?.actions[3])).toMatchObject({
            turnId: "T",
            resultId: "R",
        });
    })));
    test("lifecycle v1 delayed timer cancel reply and duplicate input", () => traceTest(() => Effect.gen(function* () {
        const runtime = runtimeFor();
        const port = (yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(createSessionRequests(fixture), fixture); }));
        const ids = ["QLATE", "QCANCEL", "QANSWER", "QREJECT"] as const;
        const opened = new Map<string, SessionTransition.Request>();
        const parentChild = childParentFixture();
        const result = yield* runLifecycleTrace({
            sessions: [...ids, "PARENT", "CHILD"],
            dispatched: () => parentChild.consumed(),
            steps: [
                // The loss-boundary recovery wakes every open session in the store, so
                // it runs before the request fixtures open their own turns.
                { name: "CP_SEALED", run: () => Effect.gen(function* () {
                        return (yield* toEffect(parentChild.sealWithoutWake()));
                    }) },
                { name: "CP_RECEIVED", run: () => Effect.gen(function* () {
                        return (yield* toEffect(parentChild.recoverLosingAck()));
                    }) },
                { name: "CP_ACKED", run: () => Effect.gen(function* () {
                        return (yield* toEffect(parentChild.recoverAndAck()));
                    }) },
                {
                    name: "QOPEN",
                    run: () => Effect.gen(function* () {
                        harness.now = 1000;
                        for (const id of ids) {
                            (yield* seedRequestSession(id));
                            opened.set(id, (yield* openRequest(port, id)));
                        }
                    }),
                },
                {
                    name: "QLATE",
                    run: () => Effect.gen(function* () {
                        const q = requestOf(opened, "QLATE");
                        expect((yield* toEffect(port.answer(reply(q, "reply-1", 1100))))).toBe("late_unknown");
                        expect((yield* toEffect(port.answer(reply(q, "reply-1", 1100))))).toBe("late_unknown");
                        (yield* port.timeout(q.requestId, 1100));
                        (yield* port.timeout(q.requestId, 1100));
                    }),
                },
                {
                    name: "QCANCEL_REPLY",
                    run: () => Effect.gen(function* () {
                        const q = requestOf(opened, "QCANCEL");
                        expect((yield* cancelRequest(q, runtime))).toBe("cancelled");
                        expect((yield* toEffect(port.answer(reply(q, "reply-1", 1099))))).toBe("duplicate");
                    }),
                },
                {
                    name: "QANSWER",
                    run: () => Effect.gen(function* () {
                        const q = requestOf(opened, "QANSWER");
                        expect((yield* toEffect(port.answer(reply(q, "reply-1", 1099))))).toBe("resolved");
                        expect((yield* cancelRequest(q, runtime))).toBe("duplicate");
                        expect((yield* toEffect(port.answer(reply(q, "reply-1", 1099))))).toBe("resolved");
                        expect((yield* toEffect(port.answer({ ...reply(q, "reply-1", 1099), content: "altered" })))).toBe("rejected");
                    }),
                },
                {
                    name: "QREJECT",
                    run: () => Effect.gen(function* () {
                        const q = requestOf(opened, "QREJECT");
                        expect((yield* toEffect(port.answer({
                            ...reply(q, "reject-who", 1099),
                            principal: { kind: "session", principalId: "stranger", evidenceId: "e" },
                        })))).toBe("rejected");
                        expect((yield* toEffect(port.answer({
                            ...reply(q, "reject-input", 1099),
                            inputHash: canonicalDigest({ value: "altered" }),
                        })))).toBe("rejected");
                        expect((yield* toEffect(port.answer({
                            ...reply(q, "reject-domain", 1099),
                            domainRevisions: { person: 5 },
                        })))).toBe("rejected");
                    }),
                },
            ],
        });
        assertRequestRaces(result);
        assertLossBoundary(result, parentChild);
    })));
    test("lifecycle v1 product totality and effect-free prefix replay", () => traceTest(() => Effect.gen(function* () {
        const runtime = runtimeFor();
        const port = (yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(createSessionRequests(fixture), fixture); }));
        // Delivery ids are store-wide: a delivered reply keeps its input id, so each
        // session's contenders carry session-scoped input ids.
        const contenders = {
            answer: (q: SessionTransition.Request) => port.answer(reply(q, `${q.sessionId}:reply-1`, 1099)),
            refuse: (q: SessionTransition.Request) => port.answer({ ...reply(q, `${q.sessionId}:refuse-1`, 1099), decision: "refuse" }),
            cancel: (q: SessionTransition.Request) => cancelRequest(q, runtime),
            timeout: (q: SessionTransition.Request) => port.timeout(q.requestId, 1100).pipe(Effect.map(() => kernel().requestById(q.requestId)?.state ?? "missing")),
        } as const;
        const names = Object.keys(contenders) as (keyof typeof contenders)[];
        const pairs = names.flatMap((first: keyof typeof contenders) => names.filter((second: keyof typeof contenders) => second !== first).map((second: keyof typeof contenders) => [first, second] as const));
        const opened = new Map<string, SessionTransition.Request>();
        const sessions = pairs.map(([first, second]: readonly [keyof typeof contenders, keyof typeof contenders]) => `${first}-${second}`);
        const result = yield* runLifecycleTrace({
            sessions: [...sessions, "STALE"],
            dispatched: () => 0,
            steps: [
                {
                    name: "QOPEN",
                    run: () => Effect.gen(function* () {
                        for (const id of [...sessions, "STALE"]) {
                            (yield* seedRequestSession(id));
                            opened.set(id, (yield* openRequest(port, id)));
                        }
                    }),
                },
                {
                    name: "PRODUCT",
                    run: () => Effect.gen(function* () {
                        for (const [first, second] of pairs) {
                            const q = requestOf(opened, `${first}-${second}`);
                            (yield* toEffect(contenders[first](q)));
                            const winner = kernel().requestById(q.requestId);
                            const before = sessionTree(kernel(), q.sessionId).length;
                            const loser = (yield* toEffect(contenders[second](q)));
                            expect(kernel().requestById(q.requestId)).toMatchObject({
                                state: winner?.state,
                                outcome: winner?.outcome,
                                replies: winner?.replies,
                            });
                            expect(sessionTree(kernel(), q.sessionId).length).toBeLessThanOrEqual(before + 1);
                            expect(["duplicate", "late_unknown", winner?.state]).toContain(loser);
                        }
                    }),
                },
                {
                    name: "CORRUPT",
                    run: () => Effect.gen(function* () {
                        const q = requestOf(opened, "STALE");
                        const fresh = kernel().row(q.sessionId);
                        const corruptCommit = kernel().commit({
                            sessionId: q.sessionId,
                            owner: "stranger",
                            fence: fresh.fence,
                            now: 1099,
                            expectedRevision: fresh.revision,
                            actions: [],
                            state: fresh.state,
                        });
                        expect((yield* Effect.exit(corruptCommit))._tag).toBe("Failure");
                        expect((yield* toEffect(port.answer({ ...reply(q, "corrupt-binding", 1099), bindingDigest: "forged" })))).toBe("rejected");
                        expect((yield* toEffect(port.answer({ ...reply(q, "corrupt-generation", 1099), generation: 9 })))).toBe("rejected");
                        expect((yield* toEffect(port.answer({
                            ...reply(q, "corrupt-effect", 1099),
                            effectHash: canonicalDigest({}),
                        })))).toBe("rejected");
                        // Misrouted to a real session: refused there before any record, and
                        // never applied here. The destination row does not move at all.
                        const destination = kernel().row("answer-refuse");
                        const destinationTree = sessionTree(kernel(), "answer-refuse").length;
                        expect((yield* toEffect(port.answer({
                            ...reply(q, "corrupt-session", 1099),
                            sessionId: "answer-refuse",
                        })))).toBe("rejected");
                        expect(kernel().row("answer-refuse").revision).toBe(destination.revision);
                        expect(sessionTree(kernel(), "answer-refuse")).toHaveLength(destinationTree);
                        expect(kernel().requestById("answer-refuse:q")?.seenReplyIds).toEqual([
                            "answer-refuse:reply-1",
                            "answer-refuse:refuse-1",
                        ]);
                        expect((yield* failure(port.answer({ ...reply(q, "corrupt-missing", 1099), sessionId: "OTHER" })))).toBeInstanceOf(Error);
                        expect(kernel().requestById(q.requestId)?.state).toBe("open");
                        expect((yield* toEffect(port.answer(reply(q, "STALE:reply-1", 1099))))).toBe("resolved");
                        // The winning input id replayed by a different principal is a
                        // conflicting replay: refused without a record, the winner untouched.
                        const settled = sessionTree(kernel(), q.sessionId).length;
                        expect((yield* toEffect(port.answer({
                            ...reply(q, "STALE:reply-1", 1099),
                            principal: { kind: "session", principalId: "impostor", evidenceId: "other" },
                        })))).toBe("rejected");
                        expect(sessionTree(kernel(), q.sessionId)).toHaveLength(settled);
                        expect(kernel().requestById(q.requestId)?.replies.map((r: SessionTransition.Request["replies"][number]) => r.responderId)).toEqual(["child"]);
                    }),
                },
            ],
        });
        // Terminal uniqueness: exactly one `<requestId>:resolution` record per
        // session; the losing contender is exactly one duplicate record. No product
        // session ever holds a `rejected` record: only STALE is probed with
        // corrupt input, and a misrouted answer leaves nothing behind.
        for (const id of sessions) {
            const final = result.final.get(id);
            const records = resolutions(final);
            expect(records[0]).toEqual(["request", "opened"]);
            expect(final?.actions.filter((action: LedgerAction.Node) => action.id === `${id}:q:resolution`)).toHaveLength(1);
            expect(records.filter(([, resolution]: ReturnType<typeof resolutions>[number]) => resolution === "duplicate")).toHaveLength(1);
            expect(records.filter(([, resolution]: ReturnType<typeof resolutions>[number]) => !["opened", "duplicate", undefined].includes(resolution as string))).toHaveLength(2);
            expect(final?.requests[0]?.state).not.toBe("open");
        }
        const stale = result.final.get("STALE");
        expect(stale?.requests[0]).toMatchObject({ state: "resolved", outcome: "answered" });
        expect(resolutions(stale)).toEqual([
            ["request", "opened"],
            ["alarm", undefined],
            ["request", "rejected"],
            ["request", "rejected"],
            ["request", "rejected"],
            ["request", "resolved"],
            ["request", "resolved"],
            ["alarm", undefined],
            ["prompt", undefined],
        ]);
        // A misrouted answer is refused before any record: neither session keeps it.
        const misrouted = [...result.final.values()].flatMap((snapshot: SessionSnapshot) => snapshot.actions.filter((action: LedgerAction.Node) => action.id.includes("corrupt-session")));
        expect(misrouted).toEqual([]);
        expect(resolutions(result.final.get("answer-refuse")).at(-1)).toEqual(["request", "duplicate"]);
    })));
    test("T11 refused stale executor CAS runs zero bodies and publishes zero observations", () => traceTest(() => Effect.gen(function* () {
        const runtime = runtimeFor();
        const entered = signal<void>();
        const release = signal<void>();
        let bodies = 0;
        const handle = yield* withSessionServices(session({ id: "STALE-CAS", role: "resident", runner: (input) => Effect.gen(function* () {
            const executor = yield* waveExecutor(input, runtime);
            entered.resolve();
            yield* Effect.promise(() => release.promise);
            yield* executor.run({ kind: "tool", op: "stale", intent: {}, effect: {}, toolObservation: { turnId: input.turnId, callId: "stale" } }, () => Effect.sync(() => {
                bodies += 1;
                return { effect: "forbidden" };
            }));
            return { kind: "result", text: "forbidden" };
        }) }, runtime), runtime);
        const running = yield* Effect.forkScoped(handle.prompt("start"));
        yield* waitFor(entered.promise, "stale executor entered");
        // A successor activation adopts a strictly newer fence mid-turn (W5.2 F5):
        // the live runner's authority dies at that CAS, no timer involved.
        const prior = kernel().row(handle.id);
        yield* kernel().adoptFence({ sessionId: handle.id, owner: "successor", fence: prior.fence + 1 });
        const before = snapshotOf(handle.id);
        const observations = harness.sink.published;
        harness.sink.resetToolTape();
        release.resolve();
        expect(yield* failure(waitFor(running, "stale executor refused"))).toMatchObject({ _tag: "CommitFailed", error: { _tag: "CommitRefused" } });
        expect(snapshotOf(handle.id)).toEqual(before);
        expect(harness.sink.published).toBe(observations);
        expect([harness.sink.started, harness.sink.completed, bodies]).toEqual([[], [], 0]);
        // Close the owning fiber scope, not the graceful API: a stale process
        // cannot append a fresh interrupt and call it part of the rejected CAS.
        harness.runtimes.splice(harness.runtimes.indexOf(runtime), 1);
    })));
    test("pure replay uses recorded time IDs and retry jitter without invoking body or runtime providers", () => traceTest(() => Effect.gen(function* () {
        let clockReads = 0;
        let idReads = 0;
        let bodies = 0;
        const runtime = runtimeFor({ clock: () => { clockReads += 1; return harness.now; }, entropy: () => { idReads += 1; return `recorded-${++harness.nextId}`; } });
        const facts = { notBefore: 1250, deadline: 2000, jitter: 0.375, remainingBudget: 3, route: "provider/model", provenance: "retry-after" };
        const handle = yield* withSessionServices(session({ id: "REPLAY", role: "resident", runner: (input) => Effect.gen(function* () {
            bodies += 1;
            yield* input.ledger.commit({ id: "recorded-retry", sessionId: input.sessionId, parentId: input.turnId, kind: "llm", ts: 1025,
                intent: { encodingVersion: 1, value: { phase: "retry.scheduled", ...facts } },
                effect: { encodingVersion: 1, value: { phase: "scheduled", ...facts } }, irreversible: true }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
            return { kind: "result", text: "recorded" };
        }) }, runtime), runtime);
        yield* handle.prompt("start");
        yield* closeSessions(runtime);
        harness.runtimes.splice(harness.runtimes.indexOf(runtime), 1);
        const snapshot = snapshotOf("REPLAY");
        if (snapshot === undefined) throw new Error("missing replay snapshot");
        const providers = [clockReads, idReads, bodies];
        harness.now = 9000;
        yield* replayEffectFree(new Map([["REPLAY", snapshot]]), () => bodies);
        expect([clockReads, idReads, bodies]).toEqual(providers);
        expect(kernel().actionById("recorded-retry")).toMatchObject({ id: "recorded-retry", ts: 1025, intent: { value: facts } });
    })));
});
