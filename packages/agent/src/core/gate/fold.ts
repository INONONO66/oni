import {
  NamedError,
  type EmitKind,
  type GateAnnotation,
  type GateRow,
  type GateVerdict,
  type PlainValue,
  canonicalDigest,
  emittedRowKey,
} from "@openomni/protocol";
import { z } from "zod";
import { clonePlain } from "./match";

/** The compiler in `compose.ts` owns admission, matching and replay; this module owns everything a row does once it matches. */

export type HandlerResolver = ((ref: string) => GateHandler | undefined) | undefined;

/** Recorded as a fact at call time. */
const GateRequirementError = NamedError.create(
  "GateRequirementError",
  z.object({ rowId: z.string(), ref: z.string() }).strict(),
);

interface GateHandlerInput {
  readonly value: PlainValue;
  readonly params: PlainValue;
  readonly when: Readonly<Record<string, PlainValue>>;
  /** Only `how.ref` and declared `how.requires` resolve. */
  readonly service: (ref: string) => GateHandler;
}

export interface GateHandlerResult {
  readonly verdict?: GateVerdict;
  readonly value?: PlainValue;
  /** An undefined payload is observe-only. */
  readonly payload?: PlainValue;
}

/** An asynchronous consultant runs at ITS ROW'S POSITION in the ordered fold and its settled result folds exactly like a sync handler response. */
export type PreparedResults = ReadonlyMap<string, GateHandlerResult>;

export type GateHandler = (input: GateHandlerInput) => GateHandlerResult;

export interface GateEmission {
  readonly key: string;
  readonly kind: EmitKind;
  readonly rowId: string;
  readonly intent: PlainValue;
}

function foldVerdict(folded: GateVerdict, next: GateVerdict): GateVerdict {
  if (folded === "deny" || next === "deny") return "deny";
  if (folded === "require_approval" || next === "require_approval") return "require_approval";
  return "allow";
}

function plainRecord(value: PlainValue): Readonly<Record<string, PlainValue>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

/** A declared field absent from the output is removed (redaction). */
function applyRewrite(prior: PlainValue, fields: readonly string[], output: PlainValue): PlainValue {
  const base = plainRecord(prior);
  if (base === undefined) return prior;
  const source = plainRecord(output) ?? {};
  const next = { ...base };
  for (const field of fields) {
    const replacement = source[field];
    if (replacement === undefined) delete next[field];
    else next[field] = replacement;
  }
  return next;
}

export interface FoldState {
  verdict: GateVerdict;
  readonly rowIds: string[];
  readonly obligations: { metric: string; limit: number }[];
  readonly consulted: { ref: string; digest: string; payload: PlainValue }[];
  readonly annotations: GateAnnotation[];
  readonly facts: { rowId: string; ref: string; code: string }[];
  value: PlainValue;
  readonly emissions: GateEmission[];
}

export function initialFoldState(value: PlainValue): FoldState {
  return {
    verdict: "allow",
    rowIds: [],
    obligations: [],
    consulted: [],
    annotations: [],
    facts: [],
    value,
    emissions: [],
  };
}

export function applyRow(
  row: GateRow,
  emit: EmitKind | undefined,
  state: FoldState,
  inputHash: string,
  handlers: HandlerResolver,
  when: Readonly<Record<string, PlainValue>>,
  prepared?: PreparedResults,
): void {
  state.rowIds.push(row.id);
  if (row.do === "observe") {
    observeRow(row, state, handlers, when, prepared);
    return;
  }
  if (row.how.metric !== undefined && row.how.limit !== undefined)
    state.obligations.push({ metric: row.how.metric, limit: row.how.limit });
  if (emit !== undefined) {
    state.emissions.push({
      key: emittedRowKey(inputHash, row.id, state.emissions.length),
      kind: emit,
      rowId: row.id,
      intent: row.how.intent ?? null,
    });
    return;
  }
  // Admission guarantees one execution mode per row: a verdict here is a
  // constant row or an obligation row's projection-fixed allow.
  if (row.how.verdict !== undefined) {
    state.verdict = foldVerdict(state.verdict, row.how.verdict);
    return;
  }
  if (row.how.ref !== undefined) consultRow(row, row.how.ref, state, handlers, when, prepared);
}

/** An escape throws; the handler receives an isolated copy, so in-place mutation can never reach the decision. */
function invokeGuarded(
  row: GateRow,
  handler: GateHandler,
  value: PlainValue,
  handlers: HandlerResolver,
  when: Readonly<Record<string, PlainValue>>,
): GateHandlerResult {
  const allowed = new Set([row.how.ref, ...(row.how.requires ?? [])]);
  return handler({
    value: clonePlain(value),
    params: row.how.params ?? null,
    when: Object.freeze({ ...when }),
    service: (requested) => {
      const resolved = allowed.has(requested) ? handlers?.(requested) : undefined;
      if (resolved === undefined) throw new GateRequirementError({ rowId: row.id, ref: requested });
      return resolved;
    },
  });
}

/** Audit-only: nothing an observer returns, mutates, or throws can change the verdict or value — a failure is recorded as a fact and the decision stands. */
function observeRow(
  row: GateRow,
  state: FoldState,
  handlers: HandlerResolver,
  when: Readonly<Record<string, PlainValue>>,
  prepared?: PreparedResults,
): void {
  const ref = row.how.ref;
  if (ref === undefined) return;
  let result: GateHandlerResult;
  const consulted = prepared?.get(row.id);
  if (consulted !== undefined) {
    if (consulted.payload === undefined) {
      state.facts.push({ rowId: row.id, ref, code: "unrecorded_response" });
      return;
    }
    state.annotations.push({ rowId: row.id, ref, payload: consulted.payload });
    return;
  }
  const handler = handlers?.(ref);
  if (handler === undefined) {
    state.facts.push({ rowId: row.id, ref, code: "handler_unavailable" });
    return;
  }
  try {
    result = invokeGuarded(row, handler, state.value, handlers, when);
  } catch (cause) {
    if (GateRequirementError.isInstance(cause))
      state.facts.push({ rowId: row.id, ref: cause.data.ref, code: "requirement_escape" });
    else state.facts.push({ rowId: row.id, ref, code: "observer_failed" });
    return;
  }
  if (result.payload === undefined) {
    state.facts.push({ rowId: row.id, ref, code: "unrecorded_response" });
    return;
  }
  state.annotations.push({ rowId: row.id, ref, payload: result.payload });
}

function consultRow(
  row: GateRow,
  ref: string,
  state: FoldState,
  handlers: HandlerResolver,
  when: Readonly<Record<string, PlainValue>>,
  prepared?: PreparedResults,
): void {
  let result: GateHandlerResult;
  const consulted = prepared?.get(row.id);
  if (consulted !== undefined) {
    result = consulted;
  } else {
    const handler = handlers?.(ref);
    if (handler === undefined) {
      state.facts.push({ rowId: row.id, ref, code: "handler_unavailable" });
      state.verdict = foldVerdict(state.verdict, "deny");
      return;
    }
    try {
      result = invokeGuarded(row, handler, state.value, handlers, when);
    } catch (cause) {
      if (!GateRequirementError.isInstance(cause)) throw cause;
      state.facts.push({ rowId: row.id, ref: cause.data.ref, code: "requirement_escape" });
      state.verdict = foldVerdict(state.verdict, "deny");
      return;
    }
  }
  if (result.payload === undefined) {
    // Unrecorded response: observe-only.
    state.facts.push({ rowId: row.id, ref, code: "unrecorded_response" });
    return;
  }
  state.consulted.push({ ref, digest: canonicalDigest(result.payload), payload: result.payload });
  if (row.do === "rewrite") {
    const fields = row.how.fields ?? [];
    if (consulted !== undefined) {
      // An ASYNC consultant's rewrite is contained fail-closed: anything but a plain
      // record touching ONLY the declared fields is one recorded fact, deny. The
      // sync path below returns the full object, clipped by `applyRewrite`.
      const output = plainRecord(result.value ?? null);
      if (output === undefined || Object.keys(output).some((key) => !fields.includes(key))) {
        state.facts.push({ rowId: row.id, ref, code: "incompatible_response" });
        state.verdict = foldVerdict(state.verdict, "deny");
        return;
      }
    }
    state.value = applyRewrite(state.value, fields, result.value ?? null);
    return;
  }
  // A consulted gate row is FAIL-CLOSED: a response without a verdict is
  // incompatible with its row — one recorded fact, deny. Missing verdict
  // NEVER folds to allow.
  if (result.verdict === undefined) {
    state.facts.push({ rowId: row.id, ref, code: "incompatible_response" });
    state.verdict = foldVerdict(state.verdict, "deny");
    return;
  }
  state.verdict = foldVerdict(state.verdict, result.verdict);
}
