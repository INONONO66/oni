import { Effect } from "effect";
import * as SessionHandleStore from "./store/fence";
import type { CommitReceipt } from "./store/services";
import type { LedgerError } from "./store/errors";
import type { SessionGeneration, Delivery, LedgerAction, LedgerSession } from "@openomni/protocol";
import { createExecutor, type ExecutionLedger, type ExecutionResult } from "./gate/decide";
import { AgentFailure, type SessionError } from "./failure";
import type { ResolvedSessionRuntime, SessionRunnerResult } from "./run";
import type { SessionKernel } from "./entity";
import { turnIntentAction, turnResumeAction, deliveryActions, generationForOpen } from "./commit";
import type { SessionTurnPorts } from "./admission";
import { hydrateSessionHistory } from "../inspect/history";

type RecoveryError = SessionError;

/**
 * Turn recovery and context restoration (#1310): the admission module owns
 * entering a turn; this module owns re-entering one (open-turn recovery,
 * interrupted-turn resume) and rebuilding model context from a recorded
 * compaction row. Restoration reaches the compaction plugin only through the
 * composed `runtime.compaction` seam (#1307) — absent seam, typed refusal.
 */
export function createSessionRecovery(
  kernel: SessionKernel,
  sessionId: string,
  runtime: ResolvedSessionRuntime,
  clock: () => number,
  entropy: () => string,
  ports: SessionTurnPorts<RecoveryError> & {
    readonly commitSession: (input: {
      readonly expectedRevision: number;
      readonly actions: readonly LedgerAction.Append[];
      readonly state: LedgerSession.State;
    }) => Effect.Effect<CommitReceipt, LedgerError>;
    readonly createExecutionLedger: (turnId?: string) => ExecutionLedger;
    readonly consumeNoopDeliveries: (items: readonly Delivery.Row[]) => Effect.Effect<void, RecoveryError>;
  },
) {
  const { awaitRetainedRunner, runTurn, seal, commitSession, createExecutionLedger, consumeNoopDeliveries } = ports;

  function restoreContextProjection(compactionId: string): Effect.Effect<ExecutionResult, RecoveryError> {
    return Effect.gen(function* () {
      yield* awaitRetainedRunner();
      const current = kernel.row(sessionId);
      return yield* Effect.scoped(Effect.gen(function* () {
        // #1307: restore is a compaction-owned projection — without the
        // composed seam the restore refuses typed instead of improvising.
        const seam = runtime.compaction;
        if (seam === undefined) return yield* new AgentFailure({ operation: "session.restore", cause: "compaction_seam_missing" });
        const plan = yield* seam.prepareRestore({
          sessionId,
          compactionId,
          action: kernel.actionById(compactionId),
          result: kernel.resultFor(sessionId, compactionId),
          history: hydrateSessionHistory(kernel, sessionId).history,
        });
        const captured = yield* runtime.generations.capture({ sessionId, generation: kernel.latestGenerationFor(sessionId).generation });
        const executor = yield* captured.provide(createExecutor({
          ledger: createExecutionLedger(),
          approvalPolicy: runtime.approvalPolicy,
          identity: { sessionId, role: current.role, parentActionId: compactionId },
        })).pipe(Effect.provide(runtime.services));
        return yield* captured.provide(executor.run(plan.request, () => Effect.succeed(plan.restored)));
      }));
    });
  }

  function resumeTurn(open: SessionHandleStore.OpenTurn): Effect.Effect<SessionRunnerResult, RecoveryError> {
    return Effect.gen(function* () {
      yield* awaitRetainedRunner();
      if (kernel.pendingMessages(sessionId).some((item) => item.kind === "interrupt" || item.kind === "cancel")) {
        const interrupted = { kind: "interrupted" as const };
        yield* seal(open, interrupted);
        return interrupted;
      }
      if (open.resumeCount >= SessionHandleStore.RESUME_BUDGET) {
        const exhausted = { kind: "error" as const, text: "session resume budget exhausted" };
        yield* seal(open, exhausted);
        return exhausted;
      }
      const generation = yield* generationForOpen(kernel, open);
      const resumeCount = open.resumeCount + 1;
      const resumeId = entropy();
      const resultId = open.resultId;
      const resume = turnResumeAction({ id: resumeId, parentId: open.boundaryActionId ?? open.action.id, sessionId, turnId: open.turnId, resultId, generation, resumeCount, boundaryActionId: open.boundaryActionId, at: clock() });
      yield* commitSession({ expectedRevision: kernel.row(sessionId).revision, actions: [resume], state: "running" });
      return yield* runTurn({ turnId: open.turnId, resultId, parentActionId: resumeId, boundaryActionId: open.boundaryActionId, resumeCount, generation, resume: true });
    });
  }

  function resumeInterrupted(item: Delivery.Row): Effect.Effect<SessionRunnerResult | undefined, RecoveryError> {
    return Effect.gen(function* () {
      yield* awaitRetainedRunner();
      const terminal = kernel.latestTurnTerminal(sessionId);
      if (terminal?.effect.kind !== "interrupted") {
        yield* consumeNoopDeliveries([item]);
        return undefined;
      }
      const current = kernel.row(sessionId);
      const generation = kernel.latestGenerationFor(sessionId);
      const resultId = entropy();
      const turnId = entropy();
      const resumeCount = terminal.effect.resumeCount + 1;
      const delivery = deliveryActions(
        [item],
        { kind: "turn", turnId },
        "before_llm",
        terminal.action.id,
      );
      const resume = turnIntentAction({ id: turnId, parentId: delivery.at(-1)?.id ?? terminal.action.id, sessionId, resultId, deliveryIds: [item.id], generation, resumeCount, boundaryActionId: terminal.effect.boundaryActionId, at: clock() });
      yield* commitSession({ expectedRevision: current.revision, actions: [...delivery, resume], state: "running" });
      return yield* runTurn({ turnId, resultId, parentActionId: resume.id, boundaryActionId: terminal.effect.boundaryActionId, resumeCount, generation, resume: true });
    });
  }

  return { resumeTurn, resumeInterrupted, restoreContextProjection };
}
