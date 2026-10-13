import type { LedgerAction } from "@openomni/protocol";
import { turnIntentAction as recordTurnIntent } from "../../../../packages/agent/src/core/journal/commit";
import type { SessionKernel } from "../../src/composition/cluster-runtime";

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
