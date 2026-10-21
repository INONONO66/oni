import { Effect, Result } from "effect";
import { type LedgerSession, type SessionGeneration, SessionTurn } from "@oni/protocol";
import type * as SessionHandleStore from "../src/core/store/fence";
import { runLedgerSync } from "../test/store/helpers/effect";
import { materializeSession } from "../test/store/helpers/session";

/** Populate two committed turn actions per turn through the fenced L0 commit. */
export function seedTurnHistory(
  kernel: SessionHandleStore.SessionKernel,
  id: string,
  count = 10,
): void {
  materializeSession(kernel, id);
  const generation = kernel.latestGenerationFor(id);
  let parentId = kernel.latestAction(id)?.id ?? null;
  for (let index = 0; index < count; index += 1) {
    const request = prepareTurnCommit(kernel, id, index, parentId, generation);
    Result.getOrThrowWith(runLedgerSync(Effect.result(kernel.commit(request))), (error) => error);
    parentId = request.actions.at(-1)?.id ?? null;
  }
}

/** Fence adoption and payload construction belong outside commit timing. */
export function prepareTurnCommit(
  kernel: SessionHandleStore.SessionKernel,
  id: string,
  index: number,
  parentId: string | null,
  generation: SessionGeneration.Snapshot,
): LedgerSession.Commit {
  const row = kernel.row(id);
  const turnId = `${id}:turn:${index}`;
  const resultId = `${turnId}:result`;
  const now = index + 2;
  const adopted =
    row.fenceOwner === "bench"
      ? { fence: row.fence }
      : Result.getOrThrowWith(
          runLedgerSync(
            Effect.result(
              kernel.adoptFence({ sessionId: id, owner: "bench", fence: row.fence + 1 }),
            ),
          ),
          (error) => error,
        );
  return {
    sessionId: id,
    owner: "bench",
    fence: adopted.fence,
    now,
    expectedRevision: row.revision,
    state: "idle",
    actions: [
      {
        id: turnId,
        sessionId: id,
        parentId,
        kind: "turn",
        ts: now,
        irreversible: true,
        intent: {
          encodingVersion: 1,
          value: SessionTurn.HistoricalIntent.parse({
            phase: "intent",
            resultId,
            deliveryIds: [],
            resumeCount: 0,
            boundaryActionId: null,
            toolsGeneration: generation.generation,
            toolsHash: generation.toolsHash,
            systemHash: generation.systemHash,
            policyGeneration: generation.policyGeneration,
          }),
        },
        effect: { encodingVersion: 1, value: { phase: "pending" } },
      },
      {
        id: resultId,
        sessionId: id,
        parentId: turnId,
        kind: "turn",
        ts: now,
        irreversible: true,
        intent: {
          encodingVersion: 1,
          value: SessionTurn.TerminalIntent.parse({ phase: "terminal", turnId }),
        },
        effect: {
          encodingVersion: 1,
          value: SessionTurn.Terminal.parse({
            phase: "terminal",
            turnId,
            kind: "result",
            text: `message ${index}`,
            boundaryActionId: turnId,
            resumeCount: 0,
          }),
        },
      },
    ],
  };
}
