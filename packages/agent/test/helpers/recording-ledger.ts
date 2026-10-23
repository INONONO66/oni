import type { LedgerAction } from "@oni/protocol";
import { Effect } from "effect";

/** One in-memory chain writer for executor and chat-loop fixtures. */
export function recordingLedger(committed: LedgerAction.Append[] = []) {
  let ordinal = 0;
  return {
    committed,
    entropy: () => `action-${ordinal + 1}`,
    ledger: {
      commit: (action: LedgerAction.Append) =>
        Effect.sync(() => {
          committed.push(action);
          ordinal += 1;
          // An Append plus the ordinal is a Node by construction; the type
          // annotation keeps that guarantee without a per-commit runtime parse,
          // which the paired benchmark gate measures inside the commit hot path.
          const node: LedgerAction.Node = { ...action, ordinal };
          return { action: node, revision: ordinal };
        }),
    },
  };
}
