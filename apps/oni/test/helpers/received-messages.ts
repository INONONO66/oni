import { sessionTree } from "../../../../packages/agent/test/store/helpers/session-tree";
import { Delivery } from "@oni/protocol";
import { z } from "zod";
import type { TestLedgerPlane as AppLedgerPlane } from "./ledger";

/** All received-message evidence in one session's chain (W5.2 delivery = prompt actions). */
export function receivedMessages(plane: AppLedgerPlane, sessionId: string) {
  return sessionTree(sessionId, plane.sessionStore(sessionId).actions)
    .filter((action) => action.kind === "prompt")
    .map((action) => ({
      id: action.id,
      content: Delivery.text(z.object({ content: Delivery.Content }).parse(action.effect.value).content),
      origin: { value: action.intent.value },
    }));
}
