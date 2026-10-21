import { sessionTree } from "../../../../packages/agent/test/store/helpers/session-tree";
import type { AppLedgerPlane } from "../../src/composition/cluster-runtime";

/** All received-message evidence in one session's chain (W5.2 delivery = prompt actions). */
export function receivedMessages(plane: AppLedgerPlane, sessionId: string) {
  return sessionTree(sessionId, plane.sessionStore(sessionId).actions)
    .filter((action) => action.kind === "prompt")
    .map((action) => ({
      id: action.id,
      content: (action.effect.value as { content?: string }).content ?? "",
      origin: { value: action.intent.value },
    }));
}
