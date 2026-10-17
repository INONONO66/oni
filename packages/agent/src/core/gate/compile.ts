import { canonicalDigest, type PolicyRow, type PlainValue } from "@openomni/protocol";
import { Effect } from "effect";
import { composePointTable, GateComposeError, KERNEL_CAPABILITY_POINTS, type GatePointTable } from "./points";
import { translateLegacyPolicyRow } from "./migrate";
import {
  contentIdentity,
  DEFAULT_COMPILE_KINDS,
  MANDATORY_RULE_NAMES,
  parseRow,
  PolicyCompileError,
  type RuleName,
} from "./row-parse";
import { createHandlerTable, wrapTransformer, type HandlerTable } from "./registry";
import { projectGeneration, type ProjectedGeneration } from "./project";
import { evaluateProjected, nextProjectedConsult, type CompiledPolicySnapshot, type PolicyEvaluationInput } from "./evaluate";
import type { GateHandlerResult } from "./compose";

export { createHandlerTable, HandlerTableError, KERNEL_POLICY_REGISTRY, type HandlerTable, type NamedTransformer, type NamedConsultant, type ConsultInput, type NamedGuard } from "./registry";
export { PolicyCompileError } from "./row-parse";
export type { CompiledPolicySnapshot, PolicyEvaluation, PolicyEvaluationInput } from "./evaluate";

/**
 * Validates historical rows (`row-parse.ts`), projects them onto the gate (`project.ts`) and
 * exposes the compatibility evaluator (`evaluate.ts`).
 */

export interface CompilePolicySnapshotOptions {
  readonly registry: HandlerTable;
  readonly generation: number;
  readonly rows: readonly PolicyRow.Row[];
  readonly mandatory?: readonly RuleName[];
  readonly kinds?: readonly string[];
  /** Defaults to the kernel's built-in capabilities. */
  readonly table?: GatePointTable;
}

function kernelPointTable(): GatePointTable {
  return composePointTable({ capabilities: KERNEL_CAPABILITY_POINTS });
}

export function compilePolicySnapshot(
  options: CompilePolicySnapshotOptions,
): CompiledPolicySnapshot {
  const mandatory = new Set([...MANDATORY_RULE_NAMES, ...(options.mandatory ?? [])]);
  for (const name of mandatory) {
    if (!options.rows.some((row) => row.name === name)) {
      throw new PolicyCompileError({
        code: "mandatory_rule_missing",
        generation: options.generation,
        ruleName: name,
      });
    }
  }
  // `ingress` is the ingress.pre point's own policy address, not a journal
  // kind, so it is always compilable regardless of the caller's set.
  const kinds = new Set([...(options.kinds ?? DEFAULT_COMPILE_KINDS), "ingress"]);
  const registry = createHandlerTable(options.registry);
  const table = options.table ?? kernelPointTable();
  // Historical compaction rows convert onto the compaction point before
  // evaluation, so a base-era `turn/post {op: compaction}` deny keeps refusing.
  const translated = options.rows.map(translateLegacyPolicyRow);
  const rows = translated.map((row) => parseRow(row, options.generation, kinds, registry));
  let projected: ProjectedGeneration;
  try {
    projected = projectGeneration(rows, options.generation, table, registry);
  } catch (cause) {
    if (!GateComposeError.isInstance(cause)) throw cause;
    throw new PolicyCompileError({
      code: "compose_rejected",
      generation: options.generation,
      composeCode: cause.data.code,
      ...(cause.data.point === undefined ? {} : { kind: cause.data.point }),
      ...(cause.data.ref === undefined ? {} : { ref: cause.data.ref }),
    });
  }
  const handlers = new Map([
    ...registry.transformers.map(
      (transformer) => [transformer.name, wrapTransformer(transformer)] as const,
    ),
    // Guards are already gate handlers: consulted, verdict-bearing.
    ...(registry.guards ?? []).map((guard) => [guard.name, guard.decide] as const),
  ]);
  const consultants = new Map((registry.consultants ?? []).map((entry) => [entry.name, entry]));
  const contentHash = canonicalDigest(contentIdentity(options.rows));
  const evaluate = (input: PolicyEvaluationInput, prepared?: Parameters<typeof evaluateProjected>[6]) =>
    evaluateProjected(projected, handlers, options.generation, contentHash, table, input, prepared);
  return Object.freeze({
    generation: options.generation,
    contentHash,
    pointTable: table,
    evaluate: (input: PolicyEvaluationInput) => evaluate(input),
    // Async consultants resolve IN ROW ORDER through the probe fold, so a later
    // guard judges the value an earlier rewrite sends; inputHash stays the
    // input's identity, so replay is untouched.
    evaluateEffect: (input: PolicyEvaluationInput) =>
      Effect.suspend(() => {
        if (consultants.size === 0) return Effect.sync(() => evaluate(input));
        const asyncRefs = new Set(consultants.keys());
        const prepared = new Map<string, GateHandlerResult>();
        const step: Effect.Effect<ReturnType<typeof evaluate>> = Effect.suspend(() => {
          const pending = nextProjectedConsult(projected, handlers, table, input, asyncRefs, prepared);
          if (pending === undefined)
            return Effect.sync(() => evaluate(input, prepared.size === 0 ? undefined : prepared));
          const consultant = consultants.get(pending.ref);
          if (consultant === undefined) return Effect.die(`unregistered consultant ${pending.ref}`);
          return consultant
            .consult({
              rowId: pending.rowId,
              point: pending.point,
              params: pending.params,
              value: pending.value,
            })
            .pipe(
              Effect.flatMap((result) => {
                prepared.set(pending.rowId, result);
                return step;
              }),
            );
        });
        return step;
      }),
  });
}

type PolicyRowDraft = Omit<PolicyRow.Row, "generation">;

function seeded(
  name: string,
  kind: string,
  phase: PolicyRow.Phase,
  match: PlainValue,
  verdict: PlainValue,
  priority: number,
): PolicyRowDraft {
  return {
    name,
    kind,
    phase,
    match: { encodingVersion: 1, value: match },
    verdict: { encodingVersion: 1, value: verdict },
    priority,
  };
}

/** The numeric limits are read from these rows. */
export const SEEDED_POLICY_ROWS: readonly PolicyRowDraft[] = Object.freeze([
  seeded("compaction", "compaction", "pre", {}, { type: "allow" }, 1_000),
  seeded(
    "continuation-cap",
    "turn",
    "post",
    { op: "continue" },
    { type: "obligation", ref: "kernel/budget-clamp", metric: "continuation", limit: 8 },
    900,
  ),
  seeded(
    "fanout-cap",
    "tool",
    "pre",
    { op: "send_message" },
    { type: "obligation", ref: "kernel/budget-clamp", metric: "fanout", limit: 8 },
    900,
  ),
  seeded(
    "exact-repeat-cap",
    "turn",
    "post",
    { op: "exact_repeat" },
    { type: "obligation", ref: "kernel/budget-clamp", metric: "exact_repeat", limit: 3 },
    900,
  ),
  seeded(
    "toolless-stall-cap",
    "turn",
    "post",
    { op: "toolless_stall" },
    { type: "obligation", ref: "kernel/budget-clamp", metric: "toolless_stall", limit: 3 },
    900,
  ),
  seeded(
    "blocked-recurrence-cap",
    "turn",
    "post",
    { op: "blocked_recurrence" },
    { type: "obligation", ref: "kernel/budget-clamp", metric: "blocked_recurrence", limit: 3 },
    900,
  ),
  seeded(
    "resume-budget",
    "turn",
    "pre",
    { op: "resume" },
    { type: "obligation", ref: "kernel/budget-clamp", metric: "resume", limit: 10 },
    900,
  ),
]);
