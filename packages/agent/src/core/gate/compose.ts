import {
  type GateDecision,
  type EmitKind,
  type GateRow,
  type PlainValue,
  type PointId,
  canonicalDigest,
} from "@openomni/protocol";
import { GateComposeError, type GatePointTable } from "../points";
import { admitRow } from "./admit";
import {
  applyRow,
  initialFoldState,
  type GateEmission,
  type GateHandler,
  type PreparedResults,
} from "./fold";
import { clonePlain } from "./match";

export type { GateHandler, GateHandlerResult, PreparedResults } from "./fold";

/** Compiles the row contract against the merged point table, rejecting fail-closed, and folds every matching row into one decision per point: deny beats approval beats allow. */

interface GateDecideInput<Context> {
  readonly when: Readonly<Record<string, PlainValue>>;
  readonly value: PlainValue;
  /** Opaque consultation context for compiled per-row matchers (message rule tables). */
  readonly context?: Context;
}

interface GateDecideOptions {
  readonly handlers?: (ref: string) => GateHandler | undefined;
  /** Same input hash replays it verbatim. */
  readonly recorded?: GateDecision;
  readonly prepared?: PreparedResults;
  /** The fold STOPS at the first matched consult row listed here without a prepared result and surfaces `GateOutcome.pending` carrying the value AT THAT ROW'S POSITION. */
  readonly pendingAsync?: ReadonlySet<string>;
}

export interface PendingConsult {
  readonly rowId: string;
  readonly ref: string;
  readonly params: PlainValue;
  /** Folded by every row BEFORE this one (isolated copy). */
  readonly value: PlainValue;
}

interface GateOutcome {
  readonly decision: GateDecision;
  readonly value: PlainValue;
  readonly emissions: readonly GateEmission[];
  readonly replayed: boolean;
  /** A pending outcome is a PARTIAL fold: resolve the consultant, add it to `prepared` and decide again — never commit this decision. */
  readonly pending?: PendingConsult;
}

export interface CompiledGate<Context = never> {
  readonly generation: number;
  rowsAt(point: PointId): readonly GateRow[];
  decide(point: PointId, input: GateDecideInput<Context>, options?: GateDecideOptions): GateOutcome;
}

export interface CompileGateRowsOptions<Context = never> {
  readonly table: GatePointTable;
  readonly rows: readonly GateRow[];
  readonly handlers: readonly string[];
  readonly generation: number;
  /** The compiled form of conditions the exact-equality `when` cannot express. */
  readonly matchers?: ReadonlyMap<string, (context: Context | undefined) => boolean>;
}

interface CompiledGateRow<Context> {
  readonly row: GateRow;
  readonly emit: EmitKind | undefined;
  readonly matcher: ((context: Context | undefined) => boolean) | undefined;
}

export function compileGateRows<Context = never>(
  options: CompileGateRowsOptions<Context>,
): CompiledGate<Context> {
  const handlers = new Set(options.handlers);
  const seen = new Set<string>();
  const byPoint = new Map<string, CompiledGateRow<Context>[]>();
  for (const row of options.rows) {
    if (seen.has(row.id)) throw new GateComposeError({ code: "duplicate", rowId: row.id, point: row.on });
    seen.add(row.id);
    const emit = admitRow(row, options.table, handlers);
    const bucket = byPoint.get(row.on) ?? [];
    bucket.push({ row, emit, matcher: options.matchers?.get(row.id) });
    byPoint.set(row.on, bucket);
  }
  for (const bucket of byPoint.values()) {
    bucket.sort(
      (left, right) => left.row.order - right.row.order || left.row.id.localeCompare(right.row.id),
    );
  }

  function matches(entry: CompiledGateRow<Context>, input: GateDecideInput<Context>): boolean {
    const whenMatch = Object.entries(entry.row.when).every(
      ([field, expected]) => canonicalDigest(input.when[field] ?? null) === canonicalDigest(expected),
    );
    return whenMatch && (entry.matcher === undefined || entry.matcher(input.context));
  }

  function replays(
    point: PointId,
    input: GateDecideInput<Context>,
    entries: readonly CompiledGateRow<Context>[],
    inputHash: string,
    recorded: GateDecision | undefined,
  ): boolean {
    // Matcher context is a decision input, and a decision is bound to its policy
    // generation: a record from another generation never replays.
    return (
      recorded !== undefined &&
      recorded.generation === options.generation &&
      recorded.point === point &&
      recorded.inputHash === inputHash &&
      entries.every(
        (entry) =>
          entry.matcher === undefined ||
          matches(entry, input) === recorded.rowIds.includes(entry.row.id),
      )
    );
  }

  /** Undefined when the row folds inline. */
  function awaitedConsultRef(
    entry: CompiledGateRow<Context>,
    pendingAsync: ReadonlySet<string> | undefined,
    prepared: PreparedResults | undefined,
  ): string | undefined {
    const ref = entry.row.how.ref;
    return pendingAsync !== undefined &&
      ref !== undefined &&
      entry.emit === undefined &&
      entry.row.how.verdict === undefined &&
      pendingAsync.has(ref) &&
      prepared?.has(entry.row.id) !== true
      ? ref
      : undefined;
  }

  function decide(
    point: PointId,
    input: GateDecideInput<Context>,
    decideOptions: GateDecideOptions = {},
  ): GateOutcome {
    const inputHash = canonicalDigest({ point, when: { ...input.when }, value: input.value });
    const entries = byPoint.get(point) ?? [];
    const recorded = decideOptions.recorded;
    if (recorded !== undefined && replays(point, input, entries, inputHash, recorded)) {
      return { decision: recorded, value: recorded.output, emissions: [], replayed: true };
    }
    const state = initialFoldState(input.value);
    const decisionOf = (): GateDecision => ({
      point,
      verdict: state.verdict,
      rowIds: state.rowIds,
      obligations: state.obligations,
      consulted: state.consulted,
      annotations: state.annotations,
      facts: state.facts,
      output: state.value,
      inputHash,
      generation: options.generation,
    });
    for (const entry of entries) {
      if (!matches(entry, input)) continue;
      // An async consult row pauses the ordered fold HERE, so its consultant
      // receives the value every earlier row already folded.
      const awaited = awaitedConsultRef(entry, decideOptions.pendingAsync, decideOptions.prepared);
      if (awaited !== undefined) {
        return {
          decision: decisionOf(),
          value: state.value,
          emissions: state.emissions,
          replayed: false,
          pending: {
            rowId: entry.row.id,
            ref: awaited,
            params: entry.row.how.params ?? null,
            value: clonePlain(state.value),
          },
        };
      }
      applyRow(entry.row, entry.emit, state, inputHash, decideOptions.handlers, input.when, decideOptions.prepared);
    }
    return { decision: decisionOf(), value: state.value, emissions: state.emissions, replayed: false };
  }

  return {
    generation: options.generation,
    rowsAt: (point) => (byPoint.get(point) ?? []).map((entry) => entry.row),
    decide,
  };
}
