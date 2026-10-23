import type { LedgerAction, PlainValue } from "@oni/protocol";

export function messageExecutionReceipt(
  id: string,
  sessionId: string,
  intent: PlainValue,
): LedgerAction.Receipt {
  return {
    action: {
      id,
      sessionId,
      parentId: null,
      kind: "message",
      intent: { encodingVersion: 1, value: { value: intent } },
      effect: { encodingVersion: 1, value: {} },
      irreversible: true,
      ordinal: 1,
      ts: 1,
    },
    revision: 1,
  };
}
