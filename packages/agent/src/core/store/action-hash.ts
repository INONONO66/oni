import { createHash } from "node:crypto";
import type { LedgerAction } from "@openomni/protocol";
import type { ActionSqlRow } from "./storage/sqlite-l0-rows.js";

export const GENESIS_PREV_HASH = "openomni:l0:genesis:v1";

/** Canonical l0 chain hash over the committed action row (leaf module so the
 * session-file kernel and the SQLite write plane share it without a cycle). */
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

/**
 * The exact SQL row `appendAction` commits for one action at a chain position
 * (#1313): the single serialization both the writer and the replayed-key
 * comparison hash, so "same payload" is byte-equality of the committed row.
 */
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

/**
 * Serialized payload bytes of one action (#1347): intent + effect + revert
 * JSON, the one convention shared by fork copying, the restore tail budget
 * and the session-file row cap.
 */
export function actionPayloadBytes(action: LedgerAction.Append | LedgerAction.Node): number {
  const revert = "revert" in action ? JSON.stringify(action.revert.value) : "";
  return Buffer.byteLength(
    JSON.stringify(action.intent.value) + JSON.stringify(action.effect.value) + revert,
  );
}
