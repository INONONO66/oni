import type { LedgerAction } from "@oni/protocol";
import { turnIntentAction as recordTurnIntent } from "../../../../packages/agent/src/core/journal/turn-rows";
type SessionKernel = import("@oni/agent").Core.SessionKernel;

/** A committed-shape turn intent action rooted at the session's configure action. */
export function turnIntentAction(
  kernel: SessionKernel,
  sessionId: string,
  id: string,
  ts: number,
): LedgerAction.Append {
  return recordTurnIntent({
    id,
    parentId: `${sessionId}:configure`,
    sessionId,
    resultId: `${id}:result`,
    deliveryIds: [],
    generation: kernel.latestGenerationFor(sessionId),
    resumeCount: 0,
    boundaryActionId: null,
    at: ts,
  });
}
