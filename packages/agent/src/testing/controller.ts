import { Effect, Fiber, Option, type Scope } from "effect";
import { FenceRefused } from "../core/store/errors";
import type { Delivery, LedgerAction, LedgerSession } from "@openomni/protocol";
import { CommitFailed, ExecutionApprovalError, AgentFailure, type SessionError } from "../core/ports/failure";
import { toolSnapshot, internalOrigin, turnTerminalAction, receivedMessageAction } from "../core/journal/commit";
import { createSessionTurn } from "../core/session/run";
import { createSessionAdmission, decideSessionAdmission } from "../core/session/admission";
import { createSessionRecovery } from "../core/session/recovery";
import { commitSessionRequest } from "../core/session/request";
import { adoptSessionAuthority, createSessionConfiguration } from "../core/session/run";
import { dispatchSessionOutbound } from "../core/session/run";
import { inspectSession } from "../inspect";
import { createRawSlots } from "../core/loop/executor";
import { commitFoldBatch } from "../core/journal/commit";
import type { SessionController, SessionControllerLifecycle, ResolvedSessionRuntime, SessionRunner, SessionRunnerResult, SessionHandle, } from "../core/session/run";
import type { SessionControllerState } from "../core/session/run";
import { retryRevision, type SessionKernel } from "../core/session/entity";

/** Shutdown grace for settling raw slots; an explicit controller-owned default. */
const DEFAULT_CLOSE_GRACE_MS = 30_000;

export function createController(
  kernel: SessionKernel,
  sessionId: string,
  runner: SessionRunner,
  runtime: ResolvedSessionRuntime,
  lifecycle: SessionControllerLifecycle,
  scope: Scope.Scope,
): Effect.Effect<SessionController, SessionError> {
  return Effect.gen(function* () {
    const clock = runtime.clock;
    const entropy = runtime.entropy;
    const owner = `${runtime.processId ?? String(process.pid)}:${entropy()}`;
    // Entity authority model (W5.2 F5): one fence adoption per activation. Every
    // commit rides this fence; a later adopter's CAS makes this writer stale.
    const fence = yield* adoptSessionAuthority(kernel, sessionId, owner).pipe(
      Effect.mapError((error) => new CommitFailed({ error })),
    );
    const state: SessionControllerState = {
      active: undefined, controller: undefined, fence,
      closed: false, terminalFrozen: false, released: false, successor: undefined,
      retainedRunner: undefined,
      rawSlots: createRawSlots(), activeApprovals: undefined,
    };
    const { configure } = createSessionConfiguration(kernel, sessionId, runtime, state, owner, clock, entropy, { hibernate });
    const { runTurn, seal } = createSessionTurn(kernel, sessionId, runner, runtime, state, owner, clock, entropy, scope, {
      createExecutionLedger: (...args) => admission.createExecutionLedger(...args),
      evaluatePromptPolicies: (...args) => admission.evaluatePromptPolicies(...args),
      consumePolicyBlockedDeliveries: (...args) => admission.consumePolicyBlockedDeliveries(...args),
      hibernate,
    });
    const admission = createSessionAdmission(kernel, sessionId, runtime, state, owner, clock, entropy, {
      awaitRetainedRunner, runTurn, seal,
    });
    const recovery = createSessionRecovery(kernel, sessionId, runtime, clock, entropy, {
      awaitRetainedRunner, runTurn, seal,
      commitSession: admission.commitSession, createExecutionLedger: admission.createExecutionLedger, consumeNoopDeliveries: admission.consumeNoopDeliveries,
    });
    function replacement(): Effect.Effect<SessionHandle | undefined, SessionError> {
      return Effect.gen(function* () {
        if (state.closed) return yield* new AgentFailure({ operation: "session.handle", cause: "closed" });
        if (!state.released) return undefined;
        state.successor ??= yield* lifecycle.reactivate();
        return state.successor;
      });
    }
    const tools: SessionHandle["tools"] = {
      add: (additions) => Effect.gen(function* () {
        const nextHandle = yield* replacement();
        if (nextHandle !== undefined) return yield* nextHandle.tools.add(additions);
        const current = kernel.latestGenerationFor(sessionId);
        return yield* configure("tools.add", [...current.tools, ...additions.map(toolSnapshot)],
          { preset: current.systemPreset, blocks: current.systemBlocks });
      }),
      remove: (names) => Effect.gen(function* () {
        const nextHandle = yield* replacement();
        if (nextHandle !== undefined) return yield* nextHandle.tools.remove(names);
        const current = kernel.latestGenerationFor(sessionId);
        return yield* configure("tools.remove", current.tools.filter((tool) => !names.includes(tool.name)),
          { preset: current.systemPreset, blocks: current.systemBlocks });
      }),
    };
    const blocks: SessionHandle["system"]["blocks"] = {
      set: (nextBlocks) => Effect.gen(function* () {
        const nextHandle = yield* replacement();
        if (nextHandle !== undefined) return yield* nextHandle.system.blocks.set(nextBlocks);
        const current = kernel.latestGenerationFor(sessionId);
        return yield* configure("system.blocks.set", current.tools, { preset: current.systemPreset, blocks: nextBlocks });
      }),
    };
    const settleClose = () => Effect.gen(function* () {
      const active = state.active;
      if (active !== undefined) yield* Fiber.await(active);
      yield* state.rawSlots.awaitSettled;
    });
    const releasedClose = () => Effect.gen(function* () {
      state.closed = true;
      if (state.successor !== undefined) yield* state.successor.close();
    });
    const releaseAfterClose = () => Effect.sync(() => {
      if (state.active !== undefined || state.rawSlots.pending() > 0) return;
      state.released = true;
      lifecycle.release();
    });
    const handle: SessionHandle = {
      id: sessionId, tools, system: { blocks },
      requests: {
        transition: (payload, inputId, at, admission) => Effect.gen(function* () {
          const current = kernel.row(sessionId);
          // A foreign adoption over this activation makes every commit stale;
          // the pinned fence is never silently re-adopted beneath a live turn.
          if (current.fenceOwner !== owner || current.fence !== state.fence)
            return yield* Effect.fail(new CommitFailed({ error: new FenceRefused({
              sessionId, reason: "stale", holder: current.fenceOwner, fence: current.fence, expiresAt: null,
            }) }));
          return yield* commitSessionRequest(kernel, sessionId, { owner, fence: state.fence }, payload, inputId, Math.max(at, clock()), runtime, admission).pipe(
            Effect.tap((decision) => Effect.sync(() => {
              if (decision.request !== undefined) state.activeApprovals?.notify?.(decision.request);
            })),
          );
        }),
      },
      approvals: {
        pending: () => state.activeApprovals?.pending() ?? [],
        answer: (answer) => Effect.suspend(() => state.activeApprovals === undefined
          ? Effect.fail(new ExecutionApprovalError({ code: "stale_approval" })) : state.activeApprovals.answer(answer)),
      },
      prompt: (content, origin = internalOrigin(sessionId)) => Effect.gen(function* () {
        const next = yield* replacement();
        return yield* (next === undefined ? enqueue("prompt", content, origin) : next.prompt(content, origin));
      }),
      interrupt: (origin = internalOrigin(sessionId)) => Effect.gen(function* () {
        const next = yield* replacement();
        yield* (next === undefined ? enqueue("interrupt", "", origin) : next.interrupt(origin));
      }),
      resume: (origin = internalOrigin(sessionId)) => Effect.gen(function* () {
        const next = yield* replacement();
        yield* (next === undefined ? enqueue("resume", "", origin) : next.resume(origin));
      }),
      restoreContext: (id) => Effect.gen(function* () {
        const next = yield* replacement();
        return yield* (next === undefined ? recovery.restoreContextProjection(id) : next.restoreContext(id));
      }),
      get: (options = {}) => kernel.getSnapshot(sessionId, options.turns ?? 1),
      watch: (options = {}) => kernel.watchSnapshot(sessionId, options.turns ?? 1, runtime.observations),
      history: (request = {}) => kernel.historyPage(sessionId, request),
      inspect: (request = {}) => inspectSession(kernel, sessionId, request, runtime.openKernel),
      close: () => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        if (state.closed) return;
        if (state.released) return yield* releasedClose();
        // Durable cancellation precedes interruption. Shutdown never transfers a
        // live raw slot's authority, including the zero-grace case.
        yield* recordIngress("interrupt", "", internalOrigin(sessionId));
        state.closed = true;
        state.controller?.abort();
        const grace = runtime.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
        // Only the grace wait is interruptible: the timeout must be able to abandon a
        // still-pending raw slot while the surrounding shutdown stays uninterruptible.
        const completion = grace <= 0 ? Option.none<void>() : yield* restore(settleClose().pipe(Effect.timeoutOption(grace)));
        if (Option.isNone(completion)) yield* sealUnknown();
        yield* releaseAfterClose();
      })),
    };

    /**
     * Ingress is a fenced received-message chain action (the input-queue table is
     * gone). An interrupt under a running turn lands its durable interrupted
     * mark in the same commit; the abort below still fires either way.
     */
    function recordIngress(kind: Delivery.Kind, content: string, origin: Delivery.Origin) {
      return Effect.gen(function* () {
        const current = kernel.row(sessionId);
        const received = receivedMessageAction({
          id: entropy(), sessionId, kind, content, origin, at: clock(),
          parentActionId: kernel.latestAction(sessionId)?.id ?? null,
        });
        const interrupted = kind === "interrupt" && current.state === "running";
        yield* kernel.commit({
          sessionId, owner, fence: state.fence, now: clock(), expectedRevision: current.revision,
          actions: [received], state: interrupted ? "interrupted" : current.state,
        }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
        if (interrupted) state.controller?.abort();
      });
    }

    function enqueue(kind: Delivery.Kind, content: string, origin: Delivery.Origin) {
      return Effect.gen(function* () {
        if (state.closed) return yield* new AgentFailure({ operation: "session.enqueue", cause: "closed" });
        const running = kernel.row(sessionId).state === "running";
        yield* recordIngress(kind, content, origin);
        if (kind === "resume" && running) return undefined;
        return yield* reconcile();
      });
    }

    function reconcile(): Effect.Effect<SessionRunnerResult | undefined, SessionError> {
      return Effect.gen(function* () {
        if (kernel.pendingMessages(sessionId).some((item) => item.kind === "interrupt")) state.controller?.abort();
        if (state.closed || state.released) return undefined;
        if (state.active === undefined) {
          state.active = yield* Effect.forkIn(driveAvailable().pipe(Effect.onExit(() => Effect.gen(function* () {
            state.active = undefined;
            yield* hibernate(kernel.row(sessionId)).pipe(Effect.orDie);
          }))), scope);
        }
        return yield* Fiber.join(state.active);
      });
    }

    function driveBacklog(): Effect.Effect<{ readonly stop: boolean; readonly result?: SessionRunnerResult }, SessionError> {
      return Effect.gen(function* () {
        const decision = decideSessionAdmission({
          row: kernel.row(sessionId),
          pending: kernel.pendingMessages(sessionId),
          open: kernel.latestOpenTurn(sessionId),
          terminal: kernel.latestTurnTerminal(sessionId),
          // The testing controller composes exactly the built-in capabilities;
          // admission refuses a snapshot that declares none.
          capabilityKinds: ["tool", "compaction"],
        });
        switch (decision.kind) {
          case "stop": return { stop: true };
          case "refused": return yield* new AgentFailure({ operation: "session.admission", cause: "invalid_state" });
          case "start": return { stop: false, result: yield* admission.startTurn() };
          case "recover": return { stop: false, result: yield* recovery.resumeTurn(decision.open) };
          case "resume": return { stop: false, result: yield* recovery.resumeInterrupted(decision.item) };
          case "consume":
            yield* admission.consumeNoopDeliveries(decision.items);
            return { stop: false };
        }
      });
    }

    function driveAvailable(): Effect.Effect<SessionRunnerResult | undefined, SessionError> {
      return Effect.gen(function* () {
        let result: SessionRunnerResult | undefined;
        while (!state.closed) {
          if (kernel.outboundRows(sessionId).some((item) => item.state === "pending"))
            yield* dispatchSessionOutbound(kernel, sessionId, runtime, owner, state.fence, clock);
          const next = yield* driveBacklog();
          if (next.stop) break;
          result = next.result ?? result;
        }
        return result;
      });
    }

    function awaitRetainedRunner(): Effect.Effect<void, SessionError> {
      return Effect.suspend(() =>
        state.retainedRunner === undefined ? Effect.void : Fiber.join(state.retainedRunner),
      );
    }

    function hibernate(_current: LedgerSession.Row): Effect.Effect<void, SessionError> {
      return Effect.suspend(() => {
        if (state.released || state.active !== undefined || state.rawSlots.pending() > 0) return Effect.void;
        if (!state.closed && kernel.pendingMessages(sessionId).length > 0) return Effect.void;
        state.released = true;
        lifecycle.release();
        return runtime.onHibernate?.(sessionId) ?? Effect.void;
      });
    }

    // The revision is read before the scan so any executor terminal that lands after
    // the read refuses this commit's CAS; the fresh rescan then sees that terminal.
    // Each rescan needs a foreign commit under a closed session; the bounded `retryRevision` caps
    // shutdown (exhaustion = `AdmissionFailure{code: revision}`).
    function sealUnknown(): Effect.Effect<void, SessionError> {
      return retryRevision(() => Effect.gen(function* () {
        const current = kernel.row(sessionId);
        const openTurns = [...openSessionTurns(kernel, sessionId)];
        const unresolved = shutdownOperations(kernel, sessionId);
        const pending: LedgerAction.Append[] = unresolved.map((action) => ({
          id: entropy(), parentId: action.id, sessionId, kind: action.kind,
          intent: { encodingVersion: 1, value: { phase: "result", op: "shutdown" } },
          effect: { encodingVersion: 1, value: { phase: "result", terminal: "outcome_unknown", reason: "shutdown_grace_exhausted" } },
          ts: clock(), irreversible: true,
        }));
        for (const open of openTurns) pending.push(turnTerminalAction({
          id: open.resultId, parentId: pending.at(-1)?.id ?? kernel.latestAction(sessionId)?.id ?? open.action.id,
          sessionId, turnId: open.turnId, result: { kind: "interrupted" }, resumeCount: open.resumeCount,
          boundaryActionId: open.boundaryActionId, at: clock(),
        }));
        if (pending.length === 0) return;
        yield* commitFoldBatch(kernel, {
          sessionId, owner, fence: state.fence, now: clock(), expectedRevision: current.revision,
          actions: pending, state: "interrupted",
        }, runtime.compaction);
        state.terminalFrozen = true;
      }));
    }
    return { handle, owner, reconcile };
  });
}

function* openSessionTurns(kernel: SessionKernel, sessionId: string) {
  let cursor = 0;
  for (;;) {
    const page = kernel.openTurnsPage(sessionId, cursor);
    yield* page;
    if (page.length < 256) return;
    const last = page.at(-1);
    if (last !== undefined) cursor = kernel.actionById(last.turnId)?.ordinal ?? cursor;
  }
}

function shutdownOperations(kernel: SessionKernel, sessionId: string): LedgerAction.Node[] {
  const pending: LedgerAction.Node[] = [];
  let cursor = kernel.row(sessionId).revision + 1;
  for (;;) {
    const page = kernel.turnIntentsPage(sessionId, cursor);
    for (const turn of page) pending.push(...unresolvedOperations(kernel, sessionId, turn.id));
    if (page.length < 256) return pending;
    cursor = page.at(-1)?.ordinal ?? cursor;
  }
}

function unresolvedOperations(kernel: SessionKernel, sessionId: string, turnId: string): LedgerAction.Node[] {
  const operations = new Map<string, LedgerAction.Node>();
  for (const read of [kernel.openOperationsPage, kernel.guardedOperationsPage]) {
    let cursor = 0;
    for (;;) {
      const page = read(sessionId, turnId, cursor);
      for (const action of page) {
        const value = action.effect.value;
        if (value !== null && typeof value === "object" && !Array.isArray(value) && value.phase === "pending" && kernel.resultFor(sessionId, action.id) === undefined)
          operations.set(action.id, action);
      }
      if (page.length < 256) break;
      cursor = page.at(-1)?.ordinal ?? cursor;
    }
  }
  return [...operations.values()];
}
