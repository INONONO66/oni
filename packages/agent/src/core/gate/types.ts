import {
  type Actor, type Gateway, type LedgerSession, type PlainValue, type Policy, type PolicyRow,
  type PolicyTransform, type RowVerdict, type GateRow, type EmitKind, type GateDecision,
  type GateVerdict, type GateAnnotation, type PointRecord, type PointId, NamedError, ComposeRejectionCode,
} from "@oni/protocol";
import type { Effect } from "effect";
import { z } from "zod";

export interface NamedTransformer {
  readonly name: string;
  readonly apply: (args: PlainValue, config: PlainValue) => PlainValue;
}

export interface NamedGuard {
  readonly name: string;
  readonly decide: GateHandler;
}

interface NamedObligation {
  readonly name: string;
}

export interface ConsultInput {
  readonly rowId: string;
  readonly point: string;
  readonly params: PlainValue;
  readonly value: PlainValue;
}

export interface NamedConsultant {
  readonly name: string;
  readonly consult: (input: ConsultInput) => Effect.Effect<GateHandlerResult>;
}

export interface HandlerTable {
  readonly transformers: readonly NamedTransformer[];
  readonly obligations: readonly NamedObligation[];
  readonly consultants?: readonly NamedConsultant[];
  readonly guards?: readonly NamedGuard[];
}

export type MessagePolicyContext =
  | {
      readonly sender: "external";
      readonly senderTier?: Actor.TrustTier;
      readonly addressee: "bot" | "owner" | "ambient";
      readonly identity: boolean;
      readonly grantTier: boolean;
      readonly egressBudget: boolean;
      readonly eventIdUnique: boolean;
      readonly replyCorrelation: boolean;
    }
  | {
      readonly sender: "session";
      readonly senderRole: LedgerSession.Role;
      readonly targetKind: Gateway.SendMessage["to"]["kind"];
      readonly targetRole?: LedgerSession.Role;
      readonly type: Gateway.SendMessage["type"];
      readonly parentChild: boolean;
      readonly fanout: number;
      readonly depth: number;
      readonly withinParentDeadline: boolean;
      readonly actorSendAllowed?: boolean;
      readonly identityGranted?: boolean;
      readonly replyAutoAllowed?: boolean;
      readonly consentGranted?: boolean;
    };

const CompileErrorCode = z.enum([
  "generation_mismatch",
  "mandatory_rule_missing",
  "unknown_kind",
  "invalid_match",
  "invalid_verdict",
  "unknown_ref",
  "snapshot_load_failed",
  "compose_rejected",
  "policy_row_migration_required",
]);
type PolicyCompileErrorCode = z.infer<typeof CompileErrorCode>;

const CompileErrorData = z
  .object({
    code: CompileErrorCode,
    generation: z.number().int().nonnegative(),
    message: z.string(),
    ruleName: z.string().optional(),
    kind: z.string().optional(),
    phase: z.enum(["pre", "post"]).optional(),
    ref: z.string().optional(),
    composeCode: z.string().optional(),
    rowIndex: z.number().int().nonnegative().optional(),
    procedureId: z.literal("policy-point-rows-v1").optional(),
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
    case "policy_row_migration_required":
      return `policy row ${options.rowIndex} (${options.ruleName}) requires migration policy-point-rows-v1`;
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

export type GatePointTable = ReadonlyMap<string, PointRecord>;

export const GateComposeError = NamedError.create(
  "GateComposeError",
  z
    .object({
      code: ComposeRejectionCode,
      point: z.string().optional(),
      ref: z.string().optional(),
      rowId: z.string().optional(),
      bundle: z.string().optional(),
    })
    .strict(),
);
export type GateComposeError = InstanceType<typeof GateComposeError>;

export interface CapabilityPointRegistration {
  readonly bundle: string;
  readonly points: readonly PointId[];
}

export interface ComposePointTableOptions {
  readonly capabilities: readonly CapabilityPointRegistration[];
  readonly core?: readonly PointRecord[];
}

interface GateHandlerInput {
  readonly value: PlainValue;
  readonly params: PlainValue;
  readonly when: Readonly<Record<string, PlainValue>>;
  readonly service: (ref: string) => GateHandler;
}

export interface GateHandlerResult {
  readonly verdict?: GateVerdict;
  readonly value?: PlainValue;
  readonly payload?: PlainValue;
}

export type PreparedResults = ReadonlyMap<string, GateHandlerResult>;

export type GateHandler = (input: GateHandlerInput) => GateHandlerResult;

interface GateEmission {
  readonly key: string;
  readonly kind: EmitKind;
  readonly rowId: string;
  readonly intent: PlainValue;
}

export interface PolicyEvaluationInput {
  readonly kind: string;
  readonly phase: PolicyRow.Phase;
  readonly op?: string;
  readonly role?: "resident" | "child";
  readonly sessionId?: string;
  readonly message?: MessagePolicyContext;
  readonly value: PlainValue;
  readonly recorded?: GateDecision;
}

interface CompiledObligation {
  readonly ref: string;
  readonly metric: Extract<RowVerdict, { type: "obligation" }>["metric"];
  readonly limit: number;
}

type EffectiveRowVerdict = "allow" | "deny" | "require_approval" | "transform" | "obligation";

export interface PolicyEvaluation {
  readonly generation: number;
  readonly snapshotHash: string;
  readonly inputHash: string;
  readonly matchedRuleIds: readonly string[];
  readonly transforms: readonly PolicyTransform[];
  readonly ref?: string;
  readonly verdict: EffectiveRowVerdict;
  readonly reason?: string;
  readonly value: PlainValue;
  readonly effects: readonly Policy.PolicyEffect[];
  readonly obligations: readonly CompiledObligation[];
  readonly gate?: GateDecision;
  readonly replayed?: boolean;
  readonly error?: Readonly<z.infer<typeof CompileErrorData>>;
  readonly pending?: PendingConsult;
}

export interface PolicyBinding {
  readonly generation: number;
  readonly contentHash: string;
  readonly pointTable: GatePointTable;
  evaluate(input: PolicyEvaluationInput): PolicyEvaluation;
  evaluateEffect?(input: PolicyEvaluationInput): Effect.Effect<PolicyEvaluation>;
}

export interface CompiledRow {
  readonly name: string;
  readonly kind: string;
  readonly phase: PolicyRow.Phase;
  readonly priority: number;
  readonly match: {
    readonly op?: string;
    readonly operation?: string;
    readonly role?: LedgerSession.Role;
    readonly sessionId?: string;
    readonly message?: DeepReadonly<Gateway.RuleTableA | Gateway.RuleTableB>;
  };
  readonly verdict: DeepReadonly<RowVerdict>;
}

export type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export interface CompiledEntry<Context> {
  readonly row: DeepReadonly<GateRow>;
  readonly emit: EmitKind | undefined;
  readonly matcher: ((context: Context | undefined) => boolean) | undefined;
  readonly policy?: CompiledRow;
}

export interface CompiledPolicySnapshot<Context = MessagePolicyContext> {
  readonly generation: number;
  readonly contentHash: string;
  readonly pointTable: GatePointTable;
  readonly byPoint: ReadonlyMap<string, readonly CompiledEntry<Context>[]>;
  readonly rowById: ReadonlyMap<string, CompiledRow>;
  readonly handlers: ReadonlyMap<string, GateHandler>;
  readonly consultants: ReadonlyMap<string, NamedConsultant>;
}

export interface PolicyRows {
  readonly rows: readonly PolicyRow.Row[];
  readonly generation: number;
  readonly kinds?: readonly string[];
  readonly mandatory?: readonly "compaction"[];
  readonly table?: GatePointTable;
  readonly pointRows?: false;
}

export interface PointRows<Context> {
  readonly rows: readonly GateRow[];
  readonly generation: number;
  readonly table: GatePointTable;
  readonly matchers?: ReadonlyMap<string, (context: Context | undefined) => boolean>;
  readonly pointRows: true;
}

export interface PointInput<Context> {
  readonly point: PointId;
  readonly when: Readonly<Record<string, PlainValue>>;
  readonly value: PlainValue;
  readonly context?: Context;
  readonly message?: MessagePolicyContext;
}

export interface EvaluationOptions {
  readonly handlers?: (ref: string) => GateHandler | undefined;
  readonly recorded?: GateDecision;
  readonly prepared?: PreparedResults;
  readonly pendingAsync?: ReadonlySet<string>;
  readonly inputHash?: string;
}

interface PendingConsult extends ConsultInput {
  readonly ref: string;
}

export interface GateOutcome {
  readonly decision: GateDecision;
  readonly value: PlainValue;
  readonly emissions: readonly GateEmission[];
  readonly replayed: boolean;
  readonly pending?: PendingConsult;
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
