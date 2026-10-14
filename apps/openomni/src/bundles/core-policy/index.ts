import { Bundle, Core } from "@openomni/agent";
import type { PlainValue, PolicyRow } from "@openomni/protocol";
import { AppInvariantError } from "../../invariant";

/** The live policy plane's legacy `kind`/`phase` address of each #1251 point. */
const LEGACY_ADDRESS_BY_POINT: Readonly<Record<string, { kind: string; phase: PolicyRow.Phase }>> = {
  "ingress.pre": { kind: "ingress", phase: "pre" },
  "session.open": { kind: "session.configure", phase: "pre" },
  "prompt.pre": { kind: "prompt", phase: "pre" },
  "turn.pre": { kind: "turn", phase: "pre" },
  "turn.post": { kind: "turn", phase: "post" },
  "llm.pre": { kind: "llm", phase: "pre" },
  "llm.post": { kind: "llm", phase: "post" },
  "message.pre": { kind: "message", phase: "pre" },
  "tool.pre": { kind: "tool", phase: "pre" },
  "tool.post": { kind: "tool", phase: "post" },
  "compaction.pre": { kind: "compaction", phase: "pre" },
  "compaction.post": { kind: "compaction", phase: "post" },
  "alarm.fired": { kind: "alarm.fired", phase: "post" },
};

/**
 * The kernel's SYNCHRONOUS named services (#1256 r3 G-3): a gate row naming
 * one of these without its full obligation params is a malformed obligation,
 * never a consult seed — the live plane would otherwise look the name up in
 * the consultant table it can never join.
 */
const KERNEL_SYNC_SERVICES: ReadonlySet<string> = new Set([
  ...Core.KERNEL_POLICY_REGISTRY.transformers.map((entry) => entry.name),
  ...Core.KERNEL_POLICY_REGISTRY.obligations.map((entry) => entry.name),
]);

/** The generation's ASYNC consultant refs: handlers registered as consultants. */
function consultantRefs(generation: SeedGeneration): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const [name, handler] of generation.handlers)
    if (Bundle.isConsultantHandler(handler)) refs.add(name);
  return refs;
}

function paramsRecord(params: PlainValue | undefined): Readonly<Record<string, PlainValue>> {
  if (params === null || params === undefined || typeof params !== "object" || Array.isArray(params))
    return {};
  return params;
}

function gateRowVerdict(row: Bundle.BundleGateRow, consultants: ReadonlySet<string>): PlainValue {
  if (row.do === "gate" && row.how.ref !== undefined) {
    if (row.how.metric !== undefined && row.how.limit !== undefined)
      return { type: "obligation", ref: row.how.ref, metric: row.how.metric, limit: row.how.limit };
    if (KERNEL_SYNC_SERVICES.has(row.how.ref))
      throw new AppInvariantError(
        `gate row ${row.id} names the synchronous kernel service ${row.how.ref} without its obligation params; it has no live policy-plane seed shape`,
      );
    // #1256 r2 H-1: a consulted gate guard (hook rows) seeds the consult
    // verdict; the compiled snapshot resolves the named async service and
    // REFUSES the generation on an unregistered ref (unknown_ref, #1251) —
    // an unknown name never folds to allow.
    return { type: "consult", ref: row.how.ref, ...(row.how.params === undefined ? {} : { config: row.how.params }) };
  }
  if (row.do === "gate") {
    const verdict = row.how.verdict ?? "allow";
    return verdict === "require_approval" ? { type: verdict, reason: row.id } : { type: verdict };
  }
  // #1256: an observe hook row (PostToolUse) seeds the audit-only consult.
  if (row.do === "observe" && row.how.ref !== undefined)
    return { type: "consult", ref: row.how.ref, observe: true, ...(row.how.params === undefined ? {} : { config: row.how.params }) };
  if (row.do === "rewrite" && row.how.ref !== undefined) return rewriteRowVerdict(row, row.how.ref, consultants);
  throw new AppInvariantError(`gate row ${row.id} (${row.do}) has no live policy-plane seed shape`);
}

/**
 * #1256 r4 H-2: a rewrite row naming an ASYNC consultant (hook/process) seeds
 * the consult verdict with the rewrite flag — a transform seed would refuse
 * the generation (`unknown_ref`: consultants never join the sync transformer
 * table). The declared fields ride `config.fields`, where the compiled
 * projection recovers them.
 */
function rewriteRowVerdict(
  row: Bundle.BundleGateRow,
  ref: string,
  consultants: ReadonlySet<string>,
): PlainValue {
  if (consultants.has(ref))
    return {
      type: "consult",
      ref,
      rewrite: true,
      config: { ...paramsRecord(row.how.params), fields: [...(row.how.fields ?? [])] },
    };
  return { type: "transform", ref, ...(row.how.params === undefined ? {} : { config: row.how.params }) };
}

/**
 * Projects the composed generation's gate rows (#1255 S2, frozen #1251 shape)
 * onto the legacy rows the live policy plane seeds. The row id stays the
 * durable name, so a recompose re-seeding the same rows is the no-op write
 * `seedKernelPolicyRows` already recognizes.
 */
/** The slice of a composed generation the policy seeds read (#1256 r4 H-2). */
export type SeedGeneration = Pick<Bundle.Generation, "rows" | "handlers">;

export function gateRowPolicySeeds(
  generation: SeedGeneration,
): readonly Omit<PolicyRow.Row, "generation">[] {
  const consultants = consultantRefs(generation);
  return generation.rows.map((row) => {
    const address = LEGACY_ADDRESS_BY_POINT[row.on];
    if (address === undefined)
      throw new AppInvariantError(`gate row ${row.id} targets ${row.on}, which has no legacy policy address`);
    return {
      name: row.id,
      kind: address.kind,
      phase: address.phase,
      priority: row.order,
      match: { encodingVersion: 1 as const, value: { ...row.when } },
      verdict: { encodingVersion: 1 as const, value: gateRowVerdict(row, consultants) },
    };
  });
}
