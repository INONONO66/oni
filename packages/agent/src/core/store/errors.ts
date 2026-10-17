import { Data } from "effect";
import { AgentFailure } from "../ports/failure";

export { AgentFailure };

export class SessionNotFound extends Data.TaggedError("SessionNotFound")<{
  readonly sessionId: string;
}> {
  override get message(): string {
    return `session not found: ${this.sessionId}`;
  }
}

export class MaterializeRefused extends Data.TaggedError("MaterializeRefused")<{
  readonly sessionId: string;
  readonly reason: "input" | "configuration" | "state";
}> {}

/**
 * One creation refused: `duplicate` (the session file holds the id — the
 * idempotent outcome for a concurrent creator), `orphan_index` (a catalog row
 * with no session file behind it; fail closed), `invalid_id` (the id is not one
 * safe filename component) or `write` (the unit failed).
 */
export class CreateRefused extends Data.TaggedError("CreateRefused")<{
  readonly sessionId: string;
  readonly reason: "duplicate" | "orphan_index" | "invalid_id" | "write";
  readonly cause?: Error | LedgerError;
}> {
  override get message(): string {
    return `session creation refused (${this.reason}): ${this.sessionId}`;
  }
}

export class FenceRefused extends Data.TaggedError("FenceRefused")<{
  readonly sessionId: string;
  readonly reason: "held" | "stale";
  readonly holder: string | null;
  readonly fence: number;
  readonly expiresAt: number | null;
}> {}

export class CommitRefused extends Data.TaggedError("CommitRefused")<{
  readonly sessionId: string;
  readonly reason: "revision" | "fence" | "delivery";
  readonly expectedRevision: number;
  readonly currentRevision: number;
  readonly fence: number;
  readonly currentFence: number;
}> {}

export class PolicyGenerationRefused extends Data.TaggedError("PolicyGenerationRefused")<{
  readonly generation: number;
  readonly reason: "empty" | "conflict";
  readonly ruleName?: string;
}> {
  override get message(): string {
    return this.reason === "empty"
      ? "policy generation must not be empty"
      : `could not append policy row: ${this.ruleName}`;
  }
}

/**
 * Fail-closed journal write (): a row body that does not satisfy its
 * kind's declared schema refuses the whole commit; nothing partial lands.
 */
/**
 * Two producers, one tag: a fail-closed append names the refused row and its first schema issue; the throwing
 * JSON decoder (`parsePlainJson`) has no row and carries the parser's diagnostic as `detail` under `reason: "json"`.
 */
export class SchemaRefused extends Data.TaggedError("SchemaRefused")<{
  readonly sessionId?: string;
  readonly actionId?: string;
  readonly kind?: string;
  readonly reason: string;
  readonly detail?: string;
}> {
  override get message(): string {
    return this.detail === undefined
      ? `journal append refused: ${this.kind} row ${this.actionId} violates its declared schema (${this.reason})`
      : `invalid JSON: ${this.detail}`;
  }
}

export class StorageUnavailable extends Data.TaggedError("StorageUnavailable")<{
  readonly capability: "sessions" | "actions" | "policies" | "armed_alarms";
}> {
  override get message(): string {
    return `L0 storage capability is unavailable: ${this.capability}`;
  }
}

export class CorruptRecord extends Data.TaggedError("CorruptRecord")<{
  readonly operation: string;
  readonly id: string;
}> {}

export class SessionFileUnreadable extends Data.TaggedError("SessionFileUnreadable")<{
  readonly path: string;
  readonly code?: string;
  readonly errno?: number;
}> {}

/**
 * A broken programmer invariant on a synchronous ledger path — corrupt or
 * missing stored facts, a capability gap, or caller misuse. Thrown, never
 * `Effect.fail`ed: these paths are not Effect code and the condition is not a
 * caller-handleable refusal.
 */
export class LedgerInvariant extends Data.TaggedError("LedgerInvariant")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: Error;
}> {}

/** A catalog upgrade rejected by SQLite; its transaction leaves the old schema and rows intact. */
export class CatalogUpgradeRefused extends Data.TaggedError("CatalogUpgradeRefused")<{
  readonly fileVersion: number;
  readonly codeVersion: number;
  readonly cause: Error;
}> {
  override get message(): string {
    return `catalog schemaVersion ${this.fileVersion} could not upgrade to ${this.codeVersion}: ${this.cause.message}`;
  }
}

/**
 * SchemaVersion fence (): a store file whose `user_version` marker exceeds this build's was
 * written by newer code. A catalog opens read-only: reads work, Deliver (fence rotation) and fork
 * (session indexing) refuse with this error. A session file refuses at `openSessionStore`: nothing read or written.
 */
export class CatalogVersionRefused extends Data.TaggedError("CatalogVersionRefused")<{
  readonly fileVersion: number;
  readonly codeVersion: number;
  readonly operation:
    | "indexSession"
    | "rotateFence"
    | "markArmed"
    | "markRequests"
    | "openSessionStore";
}> {
  override get message(): string {
    const file = this.operation === "openSessionStore" ? "session file" : "catalog";
    return `${file} schemaVersion ${this.fileVersion} is newer than this build (${this.codeVersion}); ${this.operation} refused — ${file} is read-only`;
  }
}

export type LedgerError =
  | SessionNotFound
  | MaterializeRefused
  | CreateRefused
  | FenceRefused
  | CommitRefused
  | PolicyGenerationRefused
  | SchemaRefused
  | CatalogVersionRefused
  | StorageUnavailable
  | CorruptRecord
  | SessionFileUnreadable
  | AgentFailure;
