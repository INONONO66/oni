import { canonicalDigest, emittedRowKey, NamedError, PlainValueSchema, Policy, type PlainValue, type GateRow, type GateDecision, type GateVerdict, type EmitKind, type Gateway, type PointId } from "@oni/protocol";
import { z } from "zod";
import { policyPoint } from "./compile";
import type {
  CompiledPolicySnapshot, CompiledEntry, PolicyEvaluationInput,
  PolicyEvaluation, PointInput, EvaluationOptions, GateOutcome,
  GateHandler, GateHandlerResult, PreparedResults, FoldState,
  MessagePolicyContext, CompiledRow, DeepReadonly,
} from "./types";

type HandlerResolver = ((ref: string) => GateHandler | undefined) | undefined;
const GateRequirementError = NamedError.create(
  "GateRequirementError",
  z.object({ rowId: z.string(), ref: z.string() }).strict(),
);

function matchesMessage(
  rule: Gateway.RuleTableA | Gateway.RuleTableB,
  context: MessagePolicyContext | undefined,
): boolean {
  if (context === undefined) return false;
  switch (rule.table) {
    case "A": return matchesExternal(rule, context);
    case "B": return matchesSession(rule, context);
  }
}

function matchesExternal(
  rule: Gateway.RuleTableA,
  context: MessagePolicyContext,
): boolean {
  if (context.sender !== "external") return false;
  if (rule.senderTier !== undefined && rule.senderTier !== context.senderTier) return false;
  if (rule.addressee !== undefined && rule.addressee !== context.addressee) return false;
  const checks = {
    identity: context.identity,
    grant_tier: context.grantTier,
    egress_budget: context.egressBudget,
    event_id_dedupe: context.eventIdUnique,
    reply_correlation: context.replyCorrelation,
  };
  return checks[rule.check] === (rule.effect === "allow");
}

function matchesSession(
  rule: Gateway.RuleTableB,
  context: MessagePolicyContext,
): boolean {
  if (context.sender !== "session" || rule.senderRole !== context.senderRole) return false;
  if (rule.targetKind !== undefined && rule.targetKind !== context.targetKind) return false;
  if (rule.targetRole !== undefined && rule.targetRole !== context.targetRole) return false;
  if (rule.type !== undefined && rule.type !== context.type) return false;
  if (rule.check.kind === "type") return true;
  return sessionCheck(rule.check, context) === (rule.effect === "allow");
}

function sessionCheck(
  check: Exclude<Gateway.RuleTableB["check"], { kind: "type" }>,
  context: Extract<MessagePolicyContext, { sender: "session" }>,
): boolean {
  switch (check.kind) {
    case "parent_child": return context.parentChild;
    case "fanout": return context.fanout < check.max;
    case "depth": return context.depth <= check.max;
    case "deadline": return context.withinParentDeadline;
    case "actor_send": return context.actorSendAllowed === true;
    case "identity": return context.identityGranted === true;
    case "reply_auto": return context.replyAutoAllowed === true;
    case "consent": return context.consentGranted === true;
  }
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

function initialFoldState(value: PlainValue): FoldState {
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

function applyRow(
  row: DeepReadonly<GateRow>,
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
      intent: PlainValueSchema.parse(row.how.intent ?? null),
    });
    return;
  }
  if (row.how.verdict !== undefined) {
    state.verdict = foldVerdict(state.verdict, row.how.verdict);
    return;
  }
  if (row.how.ref !== undefined) consultRow(row, row.how.ref, state, handlers, when, prepared);
}

function invokeGuarded(
  row: DeepReadonly<GateRow>,
  handler: GateHandler,
  value: PlainValue,
  handlers: HandlerResolver,
  when: Readonly<Record<string, PlainValue>>,
): GateHandlerResult {
  const allowed = new Set([row.how.ref, ...(row.how.requires ?? [])]);
  return handler({
    value: structuredClone(value),
    params: PlainValueSchema.parse(row.how.params ?? null),
    when: Object.freeze({ ...when }),
    service: (requested) => {
      const resolved = allowed.has(requested) ? handlers?.(requested) : undefined;
      if (resolved === undefined) throw new GateRequirementError({ rowId: row.id, ref: requested });
      return resolved;
    },
  });
}

function observeRow(
  row: DeepReadonly<GateRow>,
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
  row: DeepReadonly<GateRow>,
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
    state.facts.push({ rowId: row.id, ref, code: "unrecorded_response" });
    return;
  }
  state.consulted.push({ ref, digest: canonicalDigest(result.payload), payload: result.payload });
  if (row.do === "rewrite") {
    const fields = row.how.fields ?? [];
    if (consulted !== undefined) {
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
  if (result.verdict === undefined) {
    state.facts.push({ rowId: row.id, ref, code: "incompatible_response" });
    state.verdict = foldVerdict(state.verdict, "deny");
    return;
  }
  state.verdict = foldVerdict(state.verdict, result.verdict);
}
function decide<Context>(snapshot: CompiledPolicySnapshot<Context>, input: PointInput<Context>, options: EvaluationOptions): GateOutcome {
  function matches(entry: CompiledEntry<Context>, input: PointInput<Context>): boolean {
    const whenMatch = Object.entries(entry.row.when).every(
      ([field, expected]) => canonicalDigest(input.when[field] ?? null) === canonicalDigest(expected),
    );
    const messageRule = entry.policy?.match.message;
    return whenMatch && (messageRule === undefined || matchesMessage(messageRule, input.message))
      && (entry.matcher === undefined || entry.matcher(input.context));
  }

  function replays(
    point: PointId,
    input: PointInput<Context>,
    entries: readonly CompiledEntry<Context>[],
    inputHash: string,
    recorded: GateDecision | undefined,
  ): boolean {
    return (
      recorded !== undefined &&
      recorded.generation === snapshot.generation &&
      recorded.point === point &&
      recorded.inputHash === inputHash &&
      entries.every(
        (entry) =>
          (entry.matcher === undefined && entry.policy?.match.message === undefined) ||
          matches(entry, input) === recorded.rowIds.includes(entry.row.id),
      )
    );
  }

  function awaitedConsultRef(
    entry: CompiledEntry<Context>,
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

  function decidePoint(
    point: PointId,
    input: PointInput<Context>,
    decideOptions: EvaluationOptions = {},
  ): GateOutcome {
    const inputHash =
      decideOptions.inputHash ??
      canonicalDigest({ point, when: { ...input.when }, value: input.value });
    const entries = snapshot.byPoint.get(point) ?? [];
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
      generation: snapshot.generation,
    });
    for (const entry of entries) {
      if (!matches(entry, input)) continue;
      const awaited = awaitedConsultRef(entry, decideOptions.pendingAsync, decideOptions.prepared);
      if (awaited !== undefined) {
        return {
          decision: decisionOf(),
          value: state.value,
          emissions: state.emissions,
          replayed: false,
          pending: {
            point,
            rowId: entry.row.id,
            ref: awaited,
            params: PlainValueSchema.parse(entry.row.how.params ?? null),
            value: structuredClone(state.value),
          },
        };
      }
      applyRow(entry.row, entry.emit, state, inputHash, decideOptions.handlers ?? ((ref) => snapshot.handlers.get(ref)), input.when, decideOptions.prepared);
    }
    return { decision: decisionOf(), value: state.value, emissions: state.emissions, replayed: false };
  }

  return decidePoint(input.point, input, options);
}
function innerOperation(value: PlainValue): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const operation = value.operation;
  if (operation === null || typeof operation !== "object" || Array.isArray(operation))
    return undefined;
  return typeof operation.op === "string" ? operation.op : undefined;
}

function projectedWhenOf(input: PolicyEvaluationInput): Record<string, PlainValue> {
  const when: Record<string, PlainValue> = {};
  if (input.op !== undefined) when.op = input.op;
  const operation = innerOperation(input.value);
  if (operation !== undefined) when.operation = operation;
  if (input.role !== undefined) when.role = input.role;
  if (input.sessionId !== undefined) when.sessionId = input.sessionId;
  return when;
}

export function evaluate<Context>(snapshot: CompiledPolicySnapshot<Context>, input: PointInput<Context>, options?: EvaluationOptions): GateOutcome;
export function evaluate(snapshot: CompiledPolicySnapshot, input: PolicyEvaluationInput, options?: EvaluationOptions): PolicyEvaluation;
export function evaluate<Context>(snapshot: CompiledPolicySnapshot<Context>, input: PolicyEvaluationInput | PointInput<Context>, options: EvaluationOptions = {}): GateOutcome | PolicyEvaluation {
  if ("point" in input) return decide(snapshot, input, options);
  const { generation, contentHash, pointTable: table } = snapshot;
  const { recorded, ...identity } = input;
  const inputHash = canonicalDigest(identity);
  const refused = (reason: string): PolicyEvaluation =>
    Object.freeze({
      generation,
      snapshotHash: contentHash,
      inputHash,
      matchedRuleIds: Object.freeze([]),
      transforms: Object.freeze([]),
      verdict: "deny" as const,
      reason,
      value: structuredClone(input.value),
      effects: Object.freeze([]),
      obligations: Object.freeze([]),
    });
  const point = policyPoint(input.kind, input.phase);
  if (point === undefined || !table.has(point)) return refused("unknown_point");
  if (input.kind === "message" && input.op === "send_message" && input.message === undefined)
    return refused("message_context_missing");

  const when = projectedWhenOf(input);

  const outcome = decide(snapshot,
    { point, when, value: structuredClone(input.value), message: input.message },
    { ...options, ...(recorded === undefined ? {} : { recorded }), inputHash },
  );
  const matched = outcome.decision.rowIds.flatMap((id) => {
    const row = snapshot.rowById.get(id);
    return row === undefined ? [] : [row];
  });
  const transforms = matched.flatMap((row) =>
    row.verdict.type === "transform" ? [Object.freeze({ ruleId: row.name, ref: row.verdict.ref })] : [],
  );
  const obligations = matched.flatMap((row) =>
    row.verdict.type === "obligation"
      ? [{ ref: row.verdict.ref, metric: row.verdict.metric, limit: row.verdict.limit }]
      : [],
  );
  const effects = matched.flatMap((row) =>
    row.verdict.type === "allow" ? (row.verdict.effects ?? []).map((effect) => Policy.PolicyEffect.parse(effect)) : [],
  );
  const verdict: PolicyEvaluation["verdict"] =
    outcome.decision.verdict !== "allow"
      ? outcome.decision.verdict
      : transforms.length > 0
        ? "transform"
        : obligations.length > 0
          ? "obligation"
          : "allow";
  const reason =
    projectedReason(outcome.decision.verdict, matched) ??
    consultedReason(outcome.decision);

  return Object.freeze({
    generation,
    snapshotHash: contentHash,
    inputHash,
    matchedRuleIds: Object.freeze(matched.map((row) => row.name)),
    transforms: Object.freeze(transforms),
    ...(transforms.length === 1 ? { ref: transforms[0]?.ref } : {}),
    verdict,
    ...(reason === undefined ? {} : { reason }),
    value: outcome.value,
    effects: Object.freeze(effects),
    obligations: Object.freeze(obligations),
    gate: outcome.decision,
    replayed: outcome.replayed,
    ...(outcome.pending === undefined ? {} : { pending: outcome.pending }),
  });
}

function projectedReason(
  verdict: "deny" | "require_approval" | "allow",
  matched: readonly CompiledRow[],
): string | undefined {
  for (const row of matched) {
    if (row.verdict.type !== verdict) continue;
    if (row.verdict.type === "deny") return row.verdict.reason ?? "denied";
    if (row.verdict.type === "require_approval") return row.verdict.reason;
    if (row.verdict.type === "allow") {
      const reason = row.verdict.reason ?? row.verdict.reasonCodes?.[0];
      if (reason !== undefined) return reason;
    }
  }
  return undefined;
}

function consultedReason(decision: GateDecision): string | undefined {
  for (const entry of decision.consulted) {
    const payload = entry.payload;
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      const reason = payload.reason;
      if (typeof reason === "string" && reason.length > 0) return reason;
    }
  }
  if (decision.verdict === "deny") return decision.facts[0]?.code;
  return undefined;
}
