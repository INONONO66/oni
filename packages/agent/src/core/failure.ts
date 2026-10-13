import { Data, Cause, Option } from "effect";
import type { StopVerdict } from "./turn";
import type { LedgerError } from "./store/errors";
import { AdmissionFailure } from "./messages";
import type { LlmRunFailure } from "../model";
import type { LedgerSession } from "@openomni/protocol";

/** Machine stop verdicts are typed execution failures, never defects. */
export class AgentStopError extends Data.TaggedError("AgentStopError")<{
  readonly reason: Extract<StopVerdict, { kind: "error" }>["reason"];
}> {
  readonly code = "agent_stop";
  override get message(): string {
    return `agent stop: ${this.reason}`;
  }
}

export class ContextAdmissionError extends Data.TaggedError("ContextAdmissionError")<Record<never, never>> {}

export function renderBodyCause(cause: string | Error): string {
  if (typeof cause === "string") return cause;
  if (cause.message === "") return cause.name;
  return cause.name === "" ? cause.message : `${cause.name}: ${cause.message}`;
}

/** `instanceof`/`String()` may throw again (a revoked Proxy), so the fallback names only the `typeof` and runs no user code. */
export function thrownAsError<T>(cause: T): Error {
  try {
    return cause instanceof Error ? cause : new Error(String(cause));
  } catch {
    return new Error(`sink threw an unrepresentable ${typeof cause}`);
  }
}

export class PolicyDenied extends Data.TaggedError("PolicyDenied")<{
  readonly phase: "pre" | "post";
  readonly ruleIds: readonly string[];
}> {}

export class ToolBodyFailed extends Data.TaggedError("ToolBodyFailed")<{
  readonly tool: string;
  readonly cause: string | Error;
}> {}

export class InvocationClosed extends Data.TaggedError("InvocationClosed")<{
  readonly tool: string;
  readonly reason: "settled" | "failed" | "interrupted";
}> {}

export class Interrupted extends Data.TaggedError("Interrupted")<Record<never, never>> {}

export class CommitFailed extends Data.TaggedError("CommitFailed")<{
  readonly error: LedgerError;
}> {
  override get message(): string {
    return this.error.message === "" ? this.error._tag : `${this.error._tag}: ${this.error.message}`;
  }
}

export class OutcomeUnknown extends Data.TaggedError("OutcomeUnknown")<{
  readonly reason: string;
}> {}

export class AgentFailure extends Data.TaggedError("AgentFailure")<{
  readonly operation: string;
  readonly cause: string | Error;
}> {
  override get message(): string { return `${this.operation}: ${renderBodyCause(this.cause)}`; }
}

/** The caller-selected compaction target is unknown or was never executed. */
export class ContextRestoreError extends Data.TaggedError("ContextRestoreError")<{
  readonly reason: "unknown_compaction" | "not_executed";
}> {
  override get message(): string { return `context restore refused: ${this.reason}`; }
}

export class CompactionExecutionError extends Data.TaggedError("CompactionExecutionError")<{
  readonly reason: string;
}> {
  override get message(): string { return `compaction execution refused: ${this.reason}`; }
}

export class SessionCommitError extends Data.TaggedError("SessionCommitError")<{
  readonly result: Exclude<LedgerSession.CommitResult, { readonly ok: true }>;
}> {
  override get message(): string { return `session commit ${this.result.reason}`; }
}

export class AgentInvariantViolation extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AgentInvariantViolation";
  }
}

export class SessionMissing extends Data.TaggedError("SessionMissing")<{
  readonly sessionId: string;
}> {}

export class LeaseLost extends Data.TaggedError("LeaseLost")<{
  readonly sessionId: string;
  readonly fence: number;
}> {}

export class GenerationUnavailable extends Data.TaggedError("GenerationUnavailable")<{
  readonly generation: number;
}> {}

export class GenerationUnsettled extends Data.TaggedError("GenerationUnsettled")<{
  readonly sessionId: string;
  readonly generation: number;
  readonly owners: number;
}> {
  override get message(): string {
    return `session ${this.sessionId} generation ${this.generation} has ${this.owners} live owner(s)`;
  }
}

export class BundleError extends Data.TaggedError("BundleError")<{
  readonly code: "namespace" | "duplicate" | "requirement" | "metadata" | "missing_output" | "acquisition" | "policy" | "selection";
  readonly bundle: string;
  readonly detail: string;
}> {
  override get message(): string { return `${this.code}: ${this.bundle}: ${this.detail}`; }
}

export class ExecutionApprovalError extends Data.TaggedError("ExecutionApprovalError")<{
  readonly code: "stale_approval" | "approval_authority_unavailable" | "unauthenticated";
}> {}

/** Unauthenticated provenance runs with `evidence_only` authority and is recorded as a violation fact — tagged like `SessionPolicyRefusal`, not an `Error`; a `missing_origin` prompt fails its turn instead. */
export class InboundAuthorityViolation {
  readonly _tag = "InboundAuthorityViolation";
  constructor(readonly reason: "unknown_origin" | "undeclared_treatment" | "missing_origin") {}
  get message(): string { return `inbound authority violation: ${this.reason}`; }
}

/** A distinct typed result cause, not a policy refusal. */
export class RunnerOutputMissing {
  readonly _tag = "RunnerOutputMissing";
  constructor(readonly turnId: string) {}
  get message(): string { return `runner output missing: turn ${this.turnId}`; }
}

/** Mutually inconsistent durable views (a running session with no open turn): drains report the typed refusal instead of folding into a stop. */
export class SessionAdmissionRefused {
  readonly _tag = "SessionAdmissionRefused";
  constructor(readonly sessionId: string) {}
  get message(): string { return `session admission refused: ${this.sessionId}`; }
}

export type ExecutionError =
  | LlmRunFailure
  | AgentFailure
  | PolicyDenied
  | ToolBodyFailed
  | InvocationClosed
  | GenerationUnavailable
  | Interrupted
  | ContextAdmissionError
  | CommitFailed
  | OutcomeUnknown
  | AgentFailure
  | CompactionExecutionError
  | ExecutionApprovalError
  | AgentStopError;

export type SessionError = ExecutionError | SessionMissing | LeaseLost | GenerationUnavailable | GenerationUnsettled | LedgerError | BundleError | ContextRestoreError | AdmissionFailure;
export { AdmissionFailure };

export function fromCause<E, F>(cause: Cause.Cause<E>, synthesize: (pretty: string) => F): E | F {
  return Option.getOrElse(Cause.findErrorOption(cause), () => synthesize(pretty(cause)));
}

/**
 * `Cause.pretty` byte-for-byte, except an Error whose `stack` is not a string
 * renders as `name: message`: Bun 1.4.1 materializes `stack` lazily and can
 * yield `undefined`, which made effect's renderer return `""` or throw.
 */
export function pretty<E>(cause: Cause.Cause<E>): string {
  return Cause.prettyErrors(cause).map(renderPrettyError).join("\n");
}

function stackOf(error: Error): string {
  return typeof error.stack === "string" ? error.stack : `${error.name}: ${error.message}`;
}

function renderPrettyError(error: Error): string {
  const head = stackOf(error);
  return "cause" in error && error.cause instanceof Error ? `${head} {\n${renderErrorCause(error.cause, "  ")}\n}` : head;
}

function renderErrorCause(cause: Error, prefix: string): string {
  const [first, ...rest] = stackOf(cause).split("\n");
  const lines = [`${prefix}[cause]: ${first}`, ...rest.map((line) => `${prefix}${line}`)].join("\n");
  return "cause" in cause && cause.cause instanceof Error ? `${lines} {\n${renderErrorCause(cause.cause, `${prefix}  `)}\n${prefix}}` : lines;
}

export function of<E>(cause: Cause.Cause<E>, operation: string): E | AgentFailure {
  return fromCause(cause, (pretty) => new AgentFailure({ operation, cause: pretty }));
}
