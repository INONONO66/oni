import type { OpenTurn } from "../store/session-reads";
import { Effect } from "effect";
import * as SessionHandleStore from "../store/fence";
import type { CommitReceipt } from "../store/services";
import type { LedgerError } from "../store/errors";
import type { Delivery, LedgerAction, LedgerSession } from "@oni/protocol";
import { createExecutor, type ExecutionLedger, type ExecutionResult } from "../loop/executor";
import { AgentFailure, type SessionError } from "../ports/failure";
import type { ResolvedSessionRuntime, SessionRunnerResult } from "./run";
import type { SessionKernel } from "./entity";
import { turnIntentAction, turnResumeAction } from "../journal/turn-rows";
import { deliveryActions } from "../journal/delivery";
import { generationForOpen } from "../journal/commit";
import type { SessionTurnPorts } from "./admission";
import { hydrateSessionHistory, restoreSessionHistory, RestoreRefused, type HydratedSessionHistory } from "../../inspect/history";

type RecoveryError = SessionError;

/**
 * Admission owns entering a turn; this module owns re-entering one and rebuilding context from a
 * recorded compaction row through the composed port only.
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
        // Restore is a compaction-owned projection: without the port it refuses typed.
        const compaction = runtime.compaction;
        if (compaction === undefined) return yield* new AgentFailure({ operation: "session.restore", cause: "compaction_seam_missing" });
        const plan = yield* compaction.prepareRestore({
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

  function resumeTurn(open: OpenTurn): Effect.Effect<SessionRunnerResult, RecoveryError> {
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

/** The four restore log annotations: the telemetry's only consumer. */
function restoreAnnotations(telemetry: HydratedSessionHistory["telemetry"]) {
  return {
    restoreRows: telemetry.rows,
    restoreBytes: telemetry.bytes,
    restorePages: telemetry.pages,
    restoreMs: telemetry.ms,
  };
}

/**
 * The activation restore: fold the suffix after the latest checkpoint under `maxTailBytes` once and log
 * the cost. A typed budget refusal (a tail grown past a row-cap-refused checkpoint) logs the work done once
 * and the activation proceeds. Never fatal.
 */
export function logRestoredHistory(kernel: SessionKernel, sessionId: string, now: () => number): Effect.Effect<void> {
  return restoreSessionHistory(kernel, sessionId, { now }).pipe(
    Effect.flatMap(({ telemetry }) =>
      Effect.annotateLogs(
        Effect.logInfo(`session restored: ${sessionId}`),
        restoreAnnotations(telemetry),
      ),
    ),
    Effect.catchIf(RestoreRefused.isInstance, (refused) =>
      Effect.annotateLogs(
        Effect.logWarning(`session restore refused (${refused.data.code}): ${sessionId}`),
        restoreAnnotations(refused.data.telemetry),
      ),
    ),
    Effect.catchCause((cause) => Effect.logError(`session restore failed: ${sessionId}`, cause)),
  );
}
