import { createHash } from "node:crypto";
import type { LedgerAction } from "@oni/protocol";
import type { ActionSqlRow } from "./storage/sqlite-l0-rows.js";

export const GENESIS_PREV_HASH = "oni:l0:genesis:v1";

/** Leaf module so the session-file kernel and the SQLite write plane share it without a cycle. */
export function computeActionHash(input: Omit<ActionSqlRow, "action_hash">): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.prev_hash,
        input.id,
        input.parent_id,
        input.session_id,
        input.kind,
        input.intent,
        input.effect,
        input.revert,
        input.irreversible,
        input.encoding_version,
        input.ts,
        input.ordinal,
      ]),
    )
    .digest("hex");
}

/** The one serialization writer and replay compare: "same payload" = byte-equal row. */
export function storedActionRow(
  action: LedgerAction.Append,
  prevHash: string,
  ordinal: number,
): Omit<ActionSqlRow, "action_hash"> {
  const revert = "revert" in action ? action.revert : undefined;
  return {
    prev_hash: prevHash,
    id: action.id,
    parent_id: action.parentId,
    session_id: action.sessionId,
    kind: action.kind,
    intent: JSON.stringify(action.intent.value),
    effect: JSON.stringify(action.effect.value),
    revert: revert === undefined ? null : JSON.stringify(revert.value),
    irreversible: "irreversible" in action ? (1 as const) : (0 as const),
    encoding_version: action.intent.encodingVersion,
    ts: action.ts,
    ordinal,
  };
}

/** Payload bytes of one action: intent + effect + revert JSON, shared by fork copy, restore tail and row cap. */
export function actionPayloadBytes(action: LedgerAction.Append | LedgerAction.Node): number {
  const revert = "revert" in action ? JSON.stringify(action.revert.value) : "";
  return Buffer.byteLength(
    JSON.stringify(action.intent.value) + JSON.stringify(action.effect.value) + revert,
  );
}
