import {
  Gateway,
  LedgerSession,
  NamedError,
  type PlainValue,
  type RowVerdict,
  RowVerdictRead,
  type PolicyRow,
} from "@openomni/protocol";
import { z } from "zod";
import { freezePlain } from "./match";
import type { HandlerTable, NamedTransformer } from "./registry";

/**
 * Historical row decoding (#1251): the compile error contract and the parser
 * that turns one persisted policy row into its validated compiled form
 * (match, verdict, resolved named services). Projection onto the gate lives
 * in `project.ts`.
 */

export const MANDATORY_RULE_NAMES = ["compaction"] as const;
export type RuleName = (typeof MANDATORY_RULE_NAMES)[number];

const CORE_ACTION_KINDS = ["prompt", "turn", "llm", "tool", "message"] as const;

const CompileErrorCode = z.enum([
  "generation_mismatch",
  "mandatory_rule_missing",
  "unknown_kind",
  "invalid_match",
  "invalid_verdict",
  "unknown_ref",
  "snapshot_load_failed",
  /** The fourteen-point registry rejected the generation; `composeCode` carries the #1255 code. */
  "compose_rejected",
]);
type PolicyCompileErrorCode = z.infer<typeof CompileErrorCode>;

export const CompileErrorData = z
  .object({
    code: CompileErrorCode,
    generation: z.number().int().nonnegative(),
    message: z.string(),
    ruleName: z.string().optional(),
    kind: z.string().optional(),
    phase: z.enum(["pre", "post"]).optional(),
    ref: z.string().optional(),
    composeCode: z.string().optional(),
  })
  .strict();

const PolicyCompileErrorBase = NamedError.create("PolicyCompileError", CompileErrorData);

type CompileErrorOptions = Omit<z.input<typeof CompileErrorData>, "message"> & {
  readonly message?: string;
};

export class PolicyCompileError extends PolicyCompileErrorBase {
  static isInstance<Input>(input: Input): input is Input & PolicyCompileError {
    return input instanceof PolicyCompileError && PolicyCompileErrorBase.isInstance(input);
  }

  constructor(options: CompileErrorOptions) {
    super({
      ...options,
      message: options.message ?? compileErrorMessage(options),
    });
  }

  get code(): PolicyCompileErrorCode {
    return this.data.code;
  }

  get generation(): number {
    return this.data.generation;
  }

  get ruleName(): string | undefined {
    return this.data.ruleName;
  }
}

function compileErrorMessage(options: CompileErrorOptions): string {
  switch (options.code) {
    case "generation_mismatch":
      return `policy row ${options.ruleName ?? "<unnamed>"} does not belong to generation ${options.generation}`;
    case "mandatory_rule_missing":
      return `policy generation ${options.generation} is missing mandatory rule ${options.ruleName ?? "<unnamed>"}`;
    case "unknown_kind":
      return `policy rule ${options.ruleName ?? "<unnamed>"} references unregistered kind ${options.kind ?? "<missing>"}`;
    case "invalid_match":
      return `policy rule ${options.ruleName ?? "<unnamed>"} has an invalid match`;
    case "invalid_verdict":
      return `policy rule ${options.ruleName ?? "<unnamed>"} has an invalid verdict`;
    case "unknown_ref":
      return `policy rule ${options.ruleName ?? "<unnamed>"} references unregistered policy ${options.ref ?? "<missing>"}`;
    case "snapshot_load_failed":
      return `policy generation ${options.generation} could not be loaded`;
    case "compose_rejected":
      return `policy generation ${options.generation} was rejected by the point registry (${options.composeCode ?? "unknown"}${options.ref === undefined ? "" : `: ${options.ref}`})`;
  }
}

/**
 * #1315 versioned role read: durable gate rows written before the role
 * rename persist the retired role byte; compile folds it to `child` so a
 * pinned historical generation keeps compiling. Named generic preprocessor:
 * an inline callback parameter would be contextually typed `unknown`.
 */
function foldMatchRoles<Input>(input: Input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) =>
      (key === "senderRole" || key === "targetRole") && typeof value === "string"
        ? [key, LedgerSession.foldLegacyRole(value)]
        : [key, value],
    ),
  );
}

const FoldedRole = z
  .string()
  .transform((role) => LedgerSession.foldLegacyRole(role))
  .pipe(LedgerSession.Role);

export const Match = z
  .object({
    op: z.string().min(1).optional(),
    /** The `operation.op` discriminator inside a multi-operation tool input. */
    operation: z.string().min(1).optional(),
    role: FoldedRole.optional(),
    sessionId: z.string().min(1).optional(),
    message: z
      .preprocess(foldMatchRoles, z.union([Gateway.RuleTableA, Gateway.RuleTableB]))
      .optional(),
  })
  .strict();
export type Match = z.infer<typeof Match>;

type CompiledVerdict =
  | Exclude<RowVerdict, { type: "transform" }>
  | (Extract<RowVerdict, { type: "transform" }> & { readonly apply: NamedTransformer["apply"] });

export interface CompiledRow {
  readonly name: string;
  readonly kind: string;
  readonly phase: PolicyRow.Phase;
  readonly priority: number;
  readonly match: Match;
  readonly verdict: CompiledVerdict;
}

export const DEFAULT_COMPILE_KINDS = [...CORE_ACTION_KINDS, "compaction", "session.configure"] as const;

function rowKey(row: Pick<PolicyRow.Row, "name" | "kind" | "phase">): string {
  return `${row.name}\u0000${row.kind}\u0000${row.phase}`;
}

export function parseRow(
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
    match: Object.freeze(match.data),
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
  freezePlain(copy);
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
): CompiledVerdict {
  switch (verdict.type) {
    case "transform": {
      const transformer = registry.transformers.find(({ name }) => name === verdict.ref);
      if (transformer === undefined)
        throw unknownRef(row, generation, verdict.ref);
      return Object.freeze({ ...verdict, apply: transformer.apply });
    }
    case "obligation":
      if (!registry.obligations.some(({ name }) => name === verdict.ref))
        throw unknownRef(row, generation, verdict.ref);
      return Object.freeze(verdict);
    case "consult":
      // One consulted-row vocabulary (#1256/#1258): async consultant or sync guard; unregistered refuses.
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

export function contentIdentity(rows: readonly PolicyRow.Row[]): PlainValue {
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
