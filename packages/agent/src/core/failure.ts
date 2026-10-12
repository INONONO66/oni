import { Data, Cause, Option } from "effect";
import type { StopVerdict } from "./turn";
import type { LedgerError } from "./store/errors";
import type { AdmissionFailure } from "./messages";
import type { LlmRunFailure } from "../model";
import type { LedgerSession } from "@openomni/protocol";

// ─── from errors.ts (#1247) ───
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

/** Journal- and model-facing text of a structured cause: an Error renders as `name: message`, a string verbatim. */
export function renderBodyCause(cause: string | Error): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : cause;
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

/** Agent-owned failure for a Cause without a typed error; `Failure.of` synthesizes it. */
export class AgentFailure extends Data.TaggedError("AgentFailure")<{
  readonly operation: string;
  readonly cause: string | Error;
}> {
  override get message(): string { return `${this.operation}: ${renderBodyCause(this.cause)}`; }
}

/** A context-restore the admission plane refused: the caller-selected compaction target is unknown or was never executed. */
export class ContextRestoreError extends Data.TaggedError("ContextRestoreError")<{
  readonly reason: "unknown_compaction" | "not_executed";
}> {
  override get message(): string { return `context restore refused: ${this.reason}`; }
}

/** A compaction execution the admission plane refused or whose recorded output no longer matches. */
export class CompactionExecutionError extends Data.TaggedError("CompactionExecutionError")<{
  readonly reason: string;
}> {
  override get message(): string { return `compaction execution refused: ${this.reason}`; }
}

/** A session commit the ledger refused; carries the full refusal verdict. */
export class SessionCommitError extends Data.TaggedError("SessionCommitError")<{
  readonly result: Exclude<LedgerSession.CommitResult, { readonly ok: true }>;
}> {
  override get message(): string { return `session commit ${this.result.reason}`; }
}

/** Named carrier for programmer-invariant violations thrown from non-Effect code paths. */
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

/**
 * Perimeter mail whose provenance the turn could not authenticate: the turn
 * runs with `evidence_only` authority and this fact is recorded as a
 * violation observation (issue #1245). A `missing_origin` prompt — one whose
 * action row records no origin at all — fails its turn instead (#1310): no
 * authority is granted without a recorded provenance. A recorded fact, never
 * a failure-channel value: tagged like `SessionPolicyRefusal`, not an `Error`.
 */
export class InboundAuthorityViolation {
  readonly _tag = "InboundAuthorityViolation";
  constructor(readonly reason: "unknown_origin" | "undeclared_treatment" | "missing_origin") {}
  get message(): string { return `inbound authority violation: ${this.reason}`; }
}

/** A turn whose executor sealed without any runner-produced output: a distinct typed result cause, not a policy refusal. */
export class RunnerOutputMissing {
  readonly _tag = "RunnerOutputMissing";
  constructor(readonly turnId: string) {}
  get message(): string { return `runner output missing: turn ${this.turnId}`; }
}

/**
 * A backlog admission the session entity refused: the durable views are
 * mutually inconsistent (e.g. a running session with no open turn). Recorded
 * as a typed refusal fact; drains report it instead of folding into a stop.
 */
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

// ─── from failure.ts (#1247) ───
/** The typed error a Cause carries, else `synthesize` applied to the pretty-printed Cause (defects and interrupts). */
export function fromCause<E, F>(cause: Cause.Cause<E>, synthesize: (pretty: string) => F): E | F {
  return Option.getOrElse(Cause.findErrorOption(cause), () => synthesize(pretty(cause)));
}

/**
 * `Cause.pretty` byte-for-byte, except that an Error whose `stack` is not a string renders as
 * `name: message`. Bun 1.4.1 materializes `new Error().stack` lazily and intermittently yields
 * `undefined` with `Error.stackTraceLimit` intact (always when the limit is 0), which made
 * effect's renderer return `""` or throw from `cause.stack.split`. This is the one Cause renderer
 * for this package and `apps/openomni`; `Cause.pretty` is not read there.
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

/** Agent profile: a Cause without a typed error becomes this package's AgentFailure for `operation`. */
export function of<E>(cause: Cause.Cause<E>, operation: string): E | AgentFailure {
  return fromCause(cause, (pretty) => new AgentFailure({ operation, cause: pretty }));
}
