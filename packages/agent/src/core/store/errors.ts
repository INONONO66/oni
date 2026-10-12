import { Data } from "effect";
import { AgentFailure } from "../failure";

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
 * Fail-closed journal write (#1252): a row body that does not satisfy its
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

/**
 * Catalog schemaVersion fence (#1252): a catalog file whose `user_version`
 * marker is greater than this build's `CATALOG_SCHEMA_VERSION` was written by
 * newer code. It opens read-only: reads work, Deliver (fence rotation) and
 * fork (session indexing) are refused with this error, bytes stay untouched.
 */
export class CatalogVersionRefused extends Data.TaggedError("CatalogVersionRefused")<{
  readonly fileVersion: number;
  readonly codeVersion: number;
  readonly operation: "indexSession" | "rotateFence" | "markArmed";
}> {
  override get message(): string {
    return `catalog schemaVersion ${this.fileVersion} is newer than this build (${this.codeVersion}); ${this.operation} refused — catalog is read-only`;
  }
}

export type LedgerError =
  | SessionNotFound
  | MaterializeRefused
  | FenceRefused
  | CommitRefused
  | PolicyGenerationRefused
  | SchemaRefused
  | CatalogVersionRefused
  | StorageUnavailable
  | CorruptRecord
  | AgentFailure;
