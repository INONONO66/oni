import type { GateRow, PlainValue, PointId } from "@openomni/protocol";
import { matchesMessage, type MessagePolicyContext } from "./match";
import { GateComposeError, type GatePointTable } from "../points";
import { compileGateRows, type CompiledGate } from "./compose";
import { pointOfRow } from "./migrate";
import type { CompiledRow, Match } from "./row-parse";
import type { HandlerTable } from "./registry";
import { gateRowId } from "./rows";

/** The gate is the single evaluator; this only formats its decision as a `PolicyEvaluation`. */
export interface ProjectedGeneration {
  readonly gate: CompiledGate<MessagePolicyContext>;
  readonly rowById: ReadonlyMap<string, CompiledRow>;
}

function projectedWhen(match: Match): Record<string, PlainValue> {
  const when: Record<string, PlainValue> = {};
  if (match.op !== undefined) when.op = match.op;
  if (match.operation !== undefined) when.operation = match.operation;
  if (match.role !== undefined) when.role = match.role;
  if (match.sessionId !== undefined) when.sessionId = match.sessionId;
  return when;
}

/** The first path segments a rewrite's transform touches. */
function transformFields(config: PlainValue | undefined): string[] {
  if (
    config === null ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    config === undefined
  )
    return [];
  const declared = Array.isArray(config.fields) ? config.fields : undefined;
  const paths = Array.isArray(config.paths) ? config.paths : undefined;
  const segments = (declared ?? paths ?? []).flatMap((entry) =>
    typeof entry === "string"
      ? [declared === undefined ? (entry.split(".")[0] ?? entry) : entry]
      : [],
  );
  return [...new Set(segments)];
}

function rewriteDoHow(verdict: { readonly ref: string; readonly config?: PlainValue }): Pick<GateRow, "do" | "how"> {
  return {
    do: "rewrite",
    how: {
      ref: verdict.ref,
      fields: transformFields(verdict.config),
      ...(verdict.config === undefined ? {} : { params: verdict.config }),
    },
  };
}

function projectedDoHow(row: CompiledRow): Pick<GateRow, "do" | "how"> {
  switch (row.verdict.type) {
    case "consult":
      // A consulted guard: `observe: true` projects audit-only, `rewrite: true`
      // the consulted rewrite (fields fail-closed).
      if (row.verdict.rewrite === true) {
        if (row.verdict.observe === true)
          throw new GateComposeError({
            code: "bad_action",
            point: `${row.kind}.${row.phase}`,
            ref: row.verdict.ref,
          });
        return rewriteDoHow(row.verdict);
      }
      return {
        do: row.verdict.observe === true ? "observe" : "gate",
        how: {
          ref: row.verdict.ref,
          ...(row.verdict.config === undefined ? {} : { params: row.verdict.config }),
        },
      };
    case "transform":
      return rewriteDoHow(row.verdict);
    case "obligation":
      return {
        do: "gate",
        how: {
          verdict: "allow",
          ref: row.verdict.ref,
          metric: row.verdict.metric,
          limit: row.verdict.limit,
        },
      };
    default:
      return { do: "gate", how: { verdict: row.verdict.type } };
  }
}

/** A wildcard `turn/post` row projects onto the compaction point too; op rows converted earlier. */
function projectedPoints(row: CompiledRow, table: GatePointTable): PointId[] {
  const point = pointOfRow(row.kind, row.phase);
  if (point === undefined || !table.has(point))
    throw new GateComposeError({ code: "unknown_point", point: `${row.kind}.${row.phase}` });
  if (point === "turn.post" && row.match.op === undefined && table.has("compaction.pre"))
    return [point, "compaction.pre"];
  return [point];
}

/** Legacy precedence order (priority desc, name asc); message rule tables become row matchers. */
export function projectGeneration(
  parsed: readonly CompiledRow[],
  generation: number,
  table: GatePointTable,
  registry: HandlerTable,
): ProjectedGeneration {
  const ordered = [...parsed].sort(
    (left, right) => right.priority - left.priority || left.name.localeCompare(right.name),
  );
  const gateRows: GateRow[] = [];
  const rowById = new Map<string, CompiledRow>();
  const matchers = new Map<string, (context: MessagePolicyContext | undefined) => boolean>();
  ordered.forEach((row, index) => {
    for (const point of projectedPoints(row, table)) {
      const id = gateRowId(row, point, index);
      gateRows.push({
        id,
        on: point,
        when: projectedWhen(row.match),
        ...projectedDoHow(row),
        order: index,
        generation,
      });
      rowById.set(id, row);
      const rule = row.match.message;
      if (rule !== undefined) matchers.set(id, (context) => matchesMessage(rule, context));
    }
  });
  const gate = compileGateRows<MessagePolicyContext>({
    table,
    rows: gateRows,
    handlers: [
      ...registry.transformers,
      ...registry.obligations,
      ...(registry.consultants ?? []),
      ...(registry.guards ?? []),
    ].map(({ name }) => name),
    generation,
    matchers,
  });
  return { gate, rowById };
}
