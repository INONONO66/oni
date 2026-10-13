import type { PlainValue, PointId, PolicyRow } from "@openomni/protocol";
import { GateComposeError, type GatePointTable } from "../points";

/**
 * Historical generations keep their exact bytes; only the latest generation converts, while pinned
 * historical generations are projected the same way at compile time.
 */

const POINT_BY_KIND_PHASE: ReadonlyMap<string, PointId> = new Map([
  ["ingress\u0000pre", "ingress.pre"],
  ["prompt\u0000pre", "prompt.pre"],
  ["turn\u0000pre", "turn.pre"],
  ["turn\u0000post", "turn.post"],
  ["llm\u0000pre", "llm.pre"],
  ["llm\u0000post", "llm.post"],
  ["message\u0000pre", "message.pre"],
  // Configure gating's historical rows belong to the session-open point.
  ["session.configure\u0000pre", "session.open"],
  ["tool\u0000pre", "tool.pre"],
  ["tool\u0000post", "tool.post"],
  ["compaction\u0000pre", "compaction.pre"],
  ["compaction\u0000post", "compaction.post"],
  ["alarm.fired\u0000post", "alarm.fired"],
]);

/** The row's registered point, or undefined when it cannot map. */
export function pointOfRow(kind: string, phase: PolicyRow.Phase): PointId | undefined {
  return POINT_BY_KIND_PHASE.get(`${kind}\u0000${phase}`);
}

export type PolicyRowDraft = Omit<PolicyRow.Row, "generation">;

function matchValue(row: PolicyRowDraft): Readonly<Record<string, PlainValue>> {
  const value = row.match.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

/**
 * The retired v3 mapping consulted `turn/post` for every compaction operation; conversion inverts
 * it so each historical restriction lands on the compaction point with its real operation.
 */
const COMPACTION_OP_BY_LEGACY_OP: ReadonlyMap<string, string> = new Map([
  ["compaction", "compact"],
  ["restore_context_projection", "restore_context_projection"],
]);

/**
 * A `turn/post` row matching a historical compaction operation becomes a `compaction/pre` row, so a
 * base-era deny keeps refusing; a wildcard `turn/post` row stays and the compiler projects it onto
 * both points.
 */
export function translateLegacyPolicyRow<Row extends PolicyRowDraft>(row: Row): Row {
  if (row.kind !== "turn" || row.phase !== "post") return row;
  const match = matchValue(row);
  const op = typeof match.op === "string" ? COMPACTION_OP_BY_LEGACY_OP.get(match.op) : undefined;
  if (op === undefined) return row;
  return {
    ...row,
    kind: "compaction",
    phase: "pre",
    match: { encodingVersion: 1 as const, value: { ...match, op } },
  };
}

/** Inert marker: it only matches the reserved `point-registry` op, which no execution uses. */
export const POINT_GENERATION_ROW: PolicyRowDraft = Object.freeze({
  name: "point-registry",
  kind: "turn",
  phase: "pre",
  match: { encodingVersion: 1 as const, value: { op: "point-registry" } },
  verdict: { encodingVersion: 1 as const, value: { type: "allow", reasonCodes: ["point-registry-v1"] } },
  priority: 0,
});

/** Fail-closed `unknown_point` when any row cannot map. */
export function assertPointGenerationRows(
  rows: readonly PolicyRowDraft[],
  table: GatePointTable,
): void {
  for (const row of rows) {
    const point = pointOfRow(row.kind, row.phase);
    if (point === undefined || !table.has(point))
      throw new GateComposeError({ code: "unknown_point", point: `${row.kind}.${row.phase}` });
  }
}
