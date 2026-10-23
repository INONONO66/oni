import {
  canonicalDigest, type PolicyRow, type PlainValue, PlainValueSchema, PolicyRef,
  CAPABILITY_POINT_RECORDS, CORE_POINT_RECORDS, EMIT_KINDS, type EmitKind,
  type GateRow, PointId, type PointRecord, Gateway, LedgerSession, RowVerdictRead,
  type RowVerdict, NamedError,
} from "@oni/protocol";
import { z } from "zod";
import { gateRowId } from "../ports/gate-rows";
import {
  GateComposeError, PolicyCompileError,
  type GatePointTable, type ComposePointTableOptions, type CapabilityPointRegistration,
  type HandlerTable, type NamedTransformer, type GateHandler, type CompiledRow,
  type CompiledEntry, type CompiledPolicySnapshot, type MessagePolicyContext,
  type PointRows, type PolicyRows, type DeepReadonly,
} from "./types";
export { GateComposeError, PolicyCompileError } from "./types";

export const HandlerTableError = NamedError.create(
  "HandlerTableError",
  z
    .object({
      code: z.enum(["invalid_ref", "duplicate_ref"]),
      ref: z.string(),
    })
    .strict(),
);

export function createHandlerTable(input: HandlerTable): HandlerTable {
  const names = new Set<string>();
  for (const entry of [
    ...input.transformers,
    ...input.obligations,
    ...(input.consultants ?? []),
    ...(input.guards ?? []),
  ]) {
    if (!PolicyRef.safeParse(entry.name).success)
      throw new HandlerTableError({ code: "invalid_ref", ref: entry.name });
    if (names.has(entry.name))
      throw new HandlerTableError({ code: "duplicate_ref", ref: entry.name });
    names.add(entry.name);
  }
  return Object.freeze({
    transformers: Object.freeze(
      input.transformers.map(({ name, apply }) => Object.freeze({ name, apply })),
    ),
    obligations: Object.freeze(input.obligations.map(({ name }) => Object.freeze({ name }))),
    consultants: Object.freeze(
      (input.consultants ?? []).map(({ name, consult }) => Object.freeze({ name, consult })),
    ),
    guards: Object.freeze(
      (input.guards ?? []).map(({ name, decide }) => Object.freeze({ name, decide })),
    ),
  });
}

const RedactConfig = z
  .object({
    paths: z.array(z.string().min(1)).default([]),
    replacement: PlainValueSchema.optional(),
  })
  .strict();

function redact(args: PlainValue, config: PlainValue): PlainValue {
  const { paths, replacement } = RedactConfig.parse(config ?? {});
  const output = structuredClone(args);
  for (const path of paths) {
    const fields = path.split(".");
    const leaf = fields.pop();
    if (leaf === undefined || leaf.length === 0) continue;
    let parent: PlainValue | undefined = output;
    for (const field of fields) {
      parent =
        parent !== null &&
        typeof parent === "object" &&
        !Array.isArray(parent) &&
        Object.getOwnPropertyDescriptor(parent, field) !== undefined
          ? parent[field]
          : undefined;
    }
    if (
      parent === undefined ||
      parent === null ||
      Array.isArray(parent) ||
      typeof parent !== "object"
    )
      continue;
    if (replacement === undefined) delete parent[leaf];
    else
      Object.defineProperty(parent, leaf, {
        value: structuredClone(replacement),
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  return output;
}

export const KERNEL_POLICY_REGISTRY: HandlerTable = createHandlerTable({
  transformers: [{ name: "kernel/redact", apply: redact }],
  obligations: [{ name: "kernel/budget-clamp" }],
});

function wrapTransformer(transformer: NamedTransformer): GateHandler {
  return (input) => {
    const output = transformer.apply(freezeOwned(input.value), input.params ?? null);
    return {
      value: output,
      payload: { ref: transformer.name, output: canonicalDigest(output) },
    };
  };
}
const capabilityRecords = new Map(CAPABILITY_POINT_RECORDS.map((record) => [record.id, record]));

export function policyPoint(kind: string, phase: PolicyRow.Phase): PointId | undefined {
  const id = kind === "session.configure" && phase === "pre" ? "session.open"
    : kind === "alarm.fired" && phase === "post" ? "alarm.fired" : `${kind}.${phase}`;
  const parsed = PointId.safeParse(id);
  return parsed.success ? parsed.data : undefined;
}

export function composePointTable(options: ComposePointTableOptions): GatePointTable {
  const core = options.core ?? CORE_POINT_RECORDS;
  for (const sealed of CORE_POINT_RECORDS) {
    if (!core.some((record) => record.id === sealed.id))
      throw new GateComposeError({ code: "builtin_removed", point: sealed.id });
  }
  const table = new Map<string, PointRecord>();
  for (const record of core) {
    if (table.has(record.id)) throw new GateComposeError({ code: "duplicate", point: record.id });
    table.set(record.id, record);
  }
  for (const capability of options.capabilities) {
    for (const id of capability.points) {
      const record = capabilityRecords.get(id);
      if (record === undefined)
        throw new GateComposeError({ code: "unknown_point", point: id, bundle: capability.bundle });
      if (table.has(id))
        throw new GateComposeError({ code: "duplicate", point: id, bundle: capability.bundle });
      table.set(id, record);
    }
  }
  return table;
}

export const KERNEL_CAPABILITY_POINTS: readonly CapabilityPointRegistration[] = Object.freeze([
  Object.freeze({ bundle: "tool", points: Object.freeze(["tool.pre", "tool.post"] as const) }),
  Object.freeze({
    bundle: "compaction",
    points: Object.freeze(["compaction.pre", "compaction.post"] as const),
  }),
  Object.freeze({ bundle: "alarm", points: Object.freeze(["alarm.fired"] as const) }),
  Object.freeze({ bundle: "action", points: Object.freeze(["action.pre"] as const) }),
]);

function reject(code: GateComposeError["data"]["code"], row: GateRow, detail?: string): never {
  throw new GateComposeError({
    code,
    rowId: row.id,
    point: row.on,
    ...(detail === undefined ? {} : { ref: detail }),
  });
}

function validateAction(row: GateRow, record: PointRecord): void {
  if (record.allowedDo.includes(row.do)) return;
  if (row.do === "emit" && record.end === true) reject("post_end_emit", row);
  reject("bad_action", row, row.do);
}

function validateFields(row: GateRow, record: PointRecord): void {
  for (const field of Object.keys(row.when)) {
    if (!record.whenFields.includes(field)) reject("bad_field", row, field);
  }
  if (row.do !== "rewrite") return;
  const fields = row.how.fields ?? [];
  if (fields.length === 0) reject("bad_field", row, "fields");
  if (record.rewriteOpen === true) return;
  for (const field of fields) {
    if (!record.rewritableFields.includes(field)) reject("bad_field", row, field);
  }
}

function validateEmit(row: GateRow, record: PointRecord): EmitKind | undefined {
  if (row.do !== "emit") return undefined;
  if (record.end === true) reject("post_end_emit", row);
  const kind = EMIT_KINDS.find((candidate) => candidate === row.how.emit);
  if (kind === undefined) reject("bad_action", row, row.how.emit ?? "emit");
  return kind;
}

function validateObserve(row: GateRow): void {
  if (
    row.how.ref === undefined ||
    row.how.verdict !== undefined ||
    row.how.metric !== undefined ||
    row.how.limit !== undefined ||
    row.how.fields !== undefined ||
    row.how.emit !== undefined
  )
    reject("bad_action", row, "how");
}

function validateGate(row: GateRow): void {
  if (row.how.metric !== undefined) {
    if (row.how.verdict !== "allow") reject("bad_action", row, "how");
    return;
  }
  if ((row.how.verdict !== undefined) === (row.how.ref !== undefined))
    reject("bad_action", row, "how");
}

function validateHow(row: GateRow, handlers: ReadonlySet<string>): void {
  if ((row.how.metric === undefined) !== (row.how.limit === undefined))
    reject("bad_field", row, "limit");
  if (row.do === "observe") validateObserve(row);
  if (row.do === "gate") validateGate(row);
  if (
    row.do === "rewrite" &&
    (row.how.ref === undefined || row.how.verdict !== undefined || row.how.metric !== undefined)
  )
    reject("bad_action", row, "how");
  if (
    row.do === "emit" &&
    (row.how.ref !== undefined ||
      row.how.verdict !== undefined ||
      row.how.metric !== undefined ||
      row.how.fields !== undefined)
  )
    reject("bad_action", row, "how");
  for (const ref of [row.how.ref, ...(row.how.requires ?? [])]) {
    if (ref !== undefined && !handlers.has(ref)) reject("unknown_handler", row, ref);
  }
}

function admitRow(
  row: GateRow,
  table: GatePointTable,
  handlers: ReadonlySet<string>,
): EmitKind | undefined {
  const record = table.get(row.on);
  if (record === undefined) reject("unknown_point", row);
  validateAction(row, record);
  validateFields(row, record);
  const emit = validateEmit(row, record);
  validateHow(row, handlers);
  return emit;
}
const DEFAULT_COMPILE_KINDS = ["prompt", "turn", "llm", "tool", "message", "compaction", "session.configure", "ingress"];
const Match = z
  .object({
    op: z.string().min(1).optional(),
    operation: z.string().min(1).optional(),
    role: LedgerSession.Role.optional(),
    sessionId: z.string().min(1).optional(),
    message: z.union([Gateway.RuleTableA, Gateway.RuleTableB]).optional(),
  })
  .strict();

function rowKey(row: Pick<PolicyRow.Row, "name" | "kind" | "phase">): string {
  return `${row.name}\u0000${row.kind}\u0000${row.phase}`;
}

function parseRow(
  row: PolicyRow.Row,
  generation: number,
  kinds: ReadonlySet<string>,
  registry: HandlerTable,
): CompiledRow {
  if (row.generation !== generation) {
    throw new PolicyCompileError({
      code: "generation_mismatch",
      generation,
      ruleName: row.name,
      kind: row.kind,
      phase: row.phase,
    });
  }
  if (!kinds.has(row.kind)) {
    throw new PolicyCompileError({
      code: "unknown_kind",
      generation,
      ruleName: row.name,
      kind: row.kind,
      phase: row.phase,
    });
  }
  const match = Match.safeParse(row.match.value);
  if (!match.success) {
    throw new PolicyCompileError({
      code: "invalid_match",
      generation,
      ruleName: row.name,
      kind: row.kind,
      phase: row.phase,
    });
  }
  const verdict = readVerdict(row);
  if (
    row.kind === "message" &&
    match.data.op !== "assistant" &&
    row.phase === "post" &&
    verdict.type !== "allow" &&
    verdict.type !== "obligation"
  ) {
    throw new PolicyCompileError({
      code: "invalid_verdict",
      generation,
      ruleName: row.name,
      kind: row.kind,
      phase: row.phase,
    });
  }
  return Object.freeze({
    name: row.name,
    kind: row.kind,
    phase: row.phase,
    priority: row.priority,
    match: freezeOwned(match.data),
    verdict: resolveVerdict(immutableVerdict(verdict), row, generation, registry),
  });
}

function readVerdict(row: PolicyRow.Row): RowVerdict {
  const verdict = RowVerdictRead.safeParse(row.verdict.value);
  if (!verdict.success) {
    throw new PolicyCompileError({
      code: "invalid_verdict",
      generation: row.generation,
      ruleName: row.name,
      kind: row.kind,
      phase: row.phase,
    });
  }
  return verdict.data;
}

function immutableVerdict(verdict: RowVerdict): RowVerdict {
  const copy = structuredClone(verdict);
  freezeOwned(copy);
  return copy;
}

function unknownRef(row: PolicyRow.Row, generation: number, ref: string): PolicyCompileError {
  return new PolicyCompileError({
    code: "unknown_ref",
    generation,
    ruleName: row.name,
    kind: row.kind,
    phase: row.phase,
    ref,
  });
}

function resolveVerdict(
  verdict: RowVerdict,
  row: PolicyRow.Row,
  generation: number,
  registry: HandlerTable,
): RowVerdict {
  switch (verdict.type) {
    case "transform": {
      const transformer = registry.transformers.find(({ name }) => name === verdict.ref);
      if (transformer === undefined)
        throw unknownRef(row, generation, verdict.ref);
      return Object.freeze(verdict);
    }
    case "obligation":
      if (!registry.obligations.some(({ name }) => name === verdict.ref))
        throw unknownRef(row, generation, verdict.ref);
      return Object.freeze(verdict);
    case "consult":
      if (
        !(registry.consultants ?? []).some(({ name }) => name === verdict.ref) &&
        !(registry.guards ?? []).some(({ name }) => name === verdict.ref)
      )
        throw unknownRef(row, generation, verdict.ref);
      return Object.freeze(verdict);
    case "allow":
    case "deny":
    case "require_approval":
      return Object.freeze(verdict);
  }
}

function contentIdentity(rows: readonly PolicyRow.Row[]): PlainValue {
  return [...rows]
    .sort((left, right) => rowKey(left).localeCompare(rowKey(right)))
    .map((row) => ({
      name: row.name,
      kind: row.kind,
      phase: row.phase,
      match: row.match,
      verdict: row.verdict,
      priority: row.priority,
    }));
}
function transformFields(config: DeepReadonly<PlainValue> | undefined): string[] {
  if (
    config === null ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    config === undefined
  )
    return [];
  const fields = "fields" in config ? config.fields : undefined;
  const pathValues = "paths" in config ? config.paths : undefined;
  const declared = Array.isArray(fields) ? fields : undefined;
  const paths = Array.isArray(pathValues) ? pathValues : undefined;
  const segments = (declared ?? paths ?? []).flatMap((entry) =>
    typeof entry === "string"
      ? [declared === undefined ? (entry.split(".")[0] ?? entry) : entry]
      : [],
  );
  return [...new Set(segments)];
}

function rewriteDoHow(verdict: { readonly ref: string; readonly config?: DeepReadonly<PlainValue> }): Pick<GateRow, "do" | "how"> {
  return {
    do: "rewrite",
    how: {
      ref: verdict.ref,
      fields: transformFields(verdict.config),
      ...(verdict.config === undefined ? {} : { params: PlainValueSchema.parse(verdict.config) }),
    },
  };
}

function projectedDoHow(row: CompiledRow): Pick<GateRow, "do" | "how"> {
  switch (row.verdict.type) {
    case "consult":
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
          ...(row.verdict.config === undefined ? {} : { params: PlainValueSchema.parse(row.verdict.config) }),
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

export function compile<Context = MessagePolicyContext>(
  options: PolicyRows | PointRows<Context>,
  handlerTable: HandlerTable,
): CompiledPolicySnapshot<Context> {
  const registry = createHandlerTable(handlerTable);
  const table = options.table ?? composePointTable({ capabilities: KERNEL_CAPABILITY_POINTS });
  const handlers = new Map([
    ...registry.transformers.map((entry) => [entry.name, wrapTransformer(entry)] as const),
    ...(registry.guards ?? []).map((entry) => [entry.name, entry.decide] as const),
  ]);
  const names = new Set([
    ...handlers.keys(), ...registry.obligations.map((entry) => entry.name),
    ...(registry.consultants ?? []).map((entry) => entry.name),
  ]);
  const byPoint = new Map<string, CompiledEntry<Context>[]>();
  const rowById = new Map<string, CompiledRow>();
  const seen = new Set<string>();
  function insert(row: GateRow, policy?: CompiledRow) {
    if (seen.has(row.id)) throw new GateComposeError({ code: "duplicate", rowId: row.id, point: row.on });
    seen.add(row.id);
    if (policy !== undefined) rowById.set(row.id, policy);
    const emit = admitRow(row, table, names);
    const bucket = byPoint.get(row.on) ?? [];
    bucket.push(Object.freeze({ row: freezeOwned(row), emit, matcher: options.pointRows ? options.matchers?.get(row.id) : undefined,
      ...(policy === undefined ? {} : { policy }) }));
    byPoint.set(row.on, bucket);
  }
  function compileStored(sourceRows: PolicyRows): void {
    for (const name of new Set(["compaction", ...(sourceRows.mandatory ?? [])])) {
      if (!sourceRows.rows.some((row) => row.name === name))
        throw new PolicyCompileError({ code: "mandatory_rule_missing", generation: sourceRows.generation, ruleName: name });
    }
    const kinds = new Set([...(sourceRows.kinds ?? DEFAULT_COMPILE_KINDS), "ingress"]);
    const ordered = sourceRows.rows.map((row, rowIndex) => ({ row, rowIndex }))
      .sort((a, b) => b.row.priority - a.row.priority || a.row.name.localeCompare(b.row.name));
    try {
      ordered.forEach(({ row: source, rowIndex }, order) => {
        refuseLegacyRow(source, rowIndex);
        const row = parseRow(source, sourceRows.generation, kinds, registry);
        const point = policyPoint(row.kind, row.phase);
        if (point === undefined || !table.has(point))
          throw new GateComposeError({ code: "unknown_point", point: `${row.kind}.${row.phase}` });
        const points = point === "turn.post" && row.match.op === undefined && table.has("compaction.pre")
          ? [point, "compaction.pre" as const] : [point];
        const { message: _message, ...when } = row.match;
        for (const on of points)
          insert({ id: gateRowId(row, on, order), on, when, ...projectedDoHow(row), order, generation: sourceRows.generation }, row);
      });
    } catch (cause) {
      if (!GateComposeError.isInstance(cause)) throw cause;
      throw new PolicyCompileError({ code: "compose_rejected", generation: sourceRows.generation,
        composeCode: cause.data.code,
        ...(cause.data.point === undefined ? {} : { kind: cause.data.point }),
        ...(cause.data.ref === undefined ? {} : { ref: cause.data.ref }),
      });
    }
  }
  if (options.pointRows) {
    for (const row of options.rows) insert(structuredClone(row));
    for (const bucket of byPoint.values()) bucket.sort((a, b) => a.row.order - b.row.order || a.row.id.localeCompare(b.row.id));

  } else {
    compileStored(options);
  }

  for (const bucket of byPoint.values()) Object.freeze(bucket);
  return Object.freeze({
    generation: options.generation,
    contentHash: canonicalDigest(options.pointRows ? options.rows.map((row) => ({ ...row })) : contentIdentity(options.rows)),
    pointTable: immutableMap(new Map([...table].map(([key, value]) => [key, freezeOwned(structuredClone(value))] as const))),
    byPoint: immutableMap(byPoint), rowById: immutableMap(rowById), handlers: immutableMap(handlers),
    consultants: immutableMap(new Map((registry.consultants ?? []).map((entry) => [entry.name, entry]))),
  });
}

function immutableMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const map = Object.freeze(new Map(source));
  const view: ReadonlyMap<K, V> = Object.freeze({
    get size() { return map.size; },
    get: (key: K) => map.get(key),
    has: (key: K) => map.has(key),
    keys: () => map.keys(), values: () => map.values(),
    entries: () => map.entries(), [Symbol.iterator]: () => map[Symbol.iterator](),
    forEach: (callback: (value: V, key: K, owner: ReadonlyMap<K, V>) => void, thisArg?: object) => map.forEach((value, key) => {
      callback.call(thisArg, value, key, view);
    }),
  });
  return view;
}

function freezeOwned<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freezeOwned(item);
    Object.freeze(value);
  }
  return value;
}

function refuseLegacyRow(row: Omit<PolicyRow.Row, "generation"> & { readonly generation?: number }, rowIndex: number): void {
  const match = row.match.value;
  if (row.kind === "turn" && row.phase === "post" && match !== null && typeof match === "object" && !Array.isArray(match)
    && (match.op === "compaction" || match.op === "restore_context_projection"))
    throw new PolicyCompileError({ code: "policy_row_migration_required", generation: row.generation ?? 0,
      rowIndex, ruleName: row.name, procedureId: "policy-point-rows-v1" });
}

export function assertPolicyRows(rows: readonly Omit<PolicyRow.Row, "generation">[], table: GatePointTable): void {
  rows.forEach((row, rowIndex) => {
    refuseLegacyRow(row, rowIndex);
    const point = policyPoint(row.kind, row.phase);
    if (point === undefined || !table.has(point))
      throw new GateComposeError({ code: "unknown_point", point: `${row.kind}.${row.phase}` });
  });
}
type PolicyRowDraft = Omit<PolicyRow.Row, "generation">;
export const SEEDED_POLICY_ROWS: readonly PolicyRowDraft[] = Object.freeze([
  { name: "compaction", kind: "compaction", phase: "pre" as const, match: { encodingVersion: 1 as const, value: {} },
    verdict: { encodingVersion: 1 as const, value: { type: "allow" } }, priority: 1_000 },
  ...([
    ["continuation-cap", "turn", "post", "continue", "continuation", 8],
    ["fanout-cap", "tool", "pre", "send_message", "fanout", 8],
    ["exact-repeat-cap", "turn", "post", "exact_repeat", "exact_repeat", 3],
    ["toolless-stall-cap", "turn", "post", "toolless_stall", "toolless_stall", 3],
    ["blocked-recurrence-cap", "turn", "post", "blocked_recurrence", "blocked_recurrence", 3],
    ["resume-budget", "turn", "pre", "resume", "resume", 10],
  ] as const).map(([name, kind, phase, op, metric, limit]) => ({
    name, kind, phase, match: { encodingVersion: 1 as const, value: { op } },
    verdict: { encodingVersion: 1 as const, value: { type: "obligation", ref: "kernel/budget-clamp", metric, limit } }, priority: 900,
  })),
]);
export const POINT_GENERATION_ROW: PolicyRowDraft = Object.freeze({
  name: "point-registry",
  kind: "turn",
  phase: "pre",
  match: { encodingVersion: 1 as const, value: { op: "point-registry" } },
  verdict: { encodingVersion: 1 as const, value: { type: "allow", reasonCodes: ["point-registry-v1"] } },
  priority: 0,
});
