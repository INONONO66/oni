import { DateTime, PrimaryKey, Schema } from "effect";
import { ClusterSchema, DeliverAt } from "effect/cluster";
import { Rpc } from "effect/rpc";
import { AdmissionFailure } from "../ports/failure";
export { AdmissionFailure } from "../ports/failure";

/**
 * The three writer RPCs are persisted and acked only after the ledger commit,
 * so a crash between commit and ack yields redelivery, never loss; handlers
 * dedupe by durable chain identity, folding at-least-once to exactly-once.
 */

const RequestReceipt = Schema.Struct({ resolution: Schema.String });

/** A policy refusal is ordinary session data, not an exception. */
export class SessionPolicyRefusal {
  readonly _tag = "SessionPolicyRefusal";
  readonly code = "session_policy_refused";

  constructor(readonly reason: string) {}

  get message(): string {
    return "session policy refused";
  }
}

/** A closed code set; a rejection appends nothing: zero journal facts ride a refused delivery. */
export class DeliverRefused extends Schema.TaggedError<DeliverRefused>(
  "@oni/agent/cluster/DeliverRefused",
)("DeliverRefused", {
  code: Schema.Literals([
    "unknown_kind",
    "missing_key",
    "closed",
    "denied",
    "idempotency_conflict",
    "seam_missing",
    "malformed_body",
  ]),
}) {}

/** Refused before the request authority runs, so a stale response appends no journal fact. */
export class ResolveRefused extends Schema.TaggedError<ResolveRefused>(
  "@oni/agent/cluster/ResolveRefused",
)("ResolveRefused", {
  code: Schema.Literals(["unknown_request", "already_resolved", "malformed_body"]),
}) {}

/** `existed` marks an idempotent replay. */
export const DeliverReceipt = Schema.Struct({
  seq: Schema.Number,
  existed: Schema.Boolean,
});
export type DeliverReceipt = typeof DeliverReceipt.Type;

/**
 * `kind` is checked against the activation's input registration table; `body`
 * is canonical JSON of `{content, control?, delivery?}`. `idempotencyKey` is the
 * durable row id and cluster primary key, so replays resolve to the original seq.
 */
export const DeliverRpc = Rpc.make("Deliver", {
  payload: {
    kind: Schema.String,
    body: Schema.String,
    source: Schema.String,
    idempotencyKey: Schema.String,
  },
  success: DeliverReceipt,
  error: Schema.Union([DeliverRefused, AdmissionFailure]),
  primaryKey: (payload) => payload.idempotencyKey,
}).annotate(ClusterSchema.Persisted, true);

/**
 * `payload` is canonical JSON of the resolution or the cancelling principal; `inputId` is the
 * idempotency key the request authority dedupes on.
 */
export const ResolveRpc = Rpc.make("Resolve", {
  payload: {
    requestId: Schema.String,
    outcome: Schema.Literals(["resolved", "cancelled"]),
    payload: Schema.String,
    inputId: Schema.String,
  },
  success: RequestReceipt,
  error: Schema.Union([ResolveRefused, AdmissionFailure]),
  primaryKey: (payload) => payload.inputId,
}).annotate(ClusterSchema.Persisted, true);

export const DeadlineAlarmBody = Schema.Struct({ requestId: Schema.String });

/**
 * `occurrenceId` is the cluster primary key and chain-guard identity; a superseded occurrence folds
 * to a recorded `fired{stale}` fact — a fact, not a rejection.
 * A quiet re-send carries `tick`: the key widens to `occurrenceId@tick` so the cluster
 * delivers it again instead of folding it into the settled original.
 */
export class AlarmOccurrence extends Schema.Class<AlarmOccurrence>(
  "@oni/agent/cluster/AlarmOccurrence",
)({
  occurrenceId: Schema.String,
  purpose: Schema.String,
  alarmId: Schema.String,
  armSeq: Schema.Number,
  sourceKey: Schema.String,
  payload: Schema.String,
  fireAt: Schema.Number,
  tick: Schema.optional(Schema.Number),
}) {
  [PrimaryKey.symbol](): string {
    return this.tick === undefined ? this.occurrenceId : `${this.occurrenceId}@${this.tick}`;
  }
  [DeliverAt.symbol](): DateTime.DateTime {
    return DateTime.makeUnsafe(this.tick ?? this.fireAt);
  }
}

export const AlarmReceipt = Schema.Struct({
  outcome: Schema.Literals(["delivered", "stale"]),
});
export type AlarmReceipt = typeof AlarmReceipt.Type;

export const AlarmRpc = Rpc.make("Alarm", {
  payload: AlarmOccurrence,
  success: AlarmReceipt,
  error: AdmissionFailure,
}).annotate(ClusterSchema.Persisted, true);

/** `delivery` selects the loop-consumption boundary (`steer | followUp`, default `followUp`). */
export const DeliverBody = Schema.Struct({
  content: Schema.String,
  control: Schema.optional(Schema.Literals(["interrupt", "resume", "cancel"])),
  delivery: Schema.optional(Schema.Literals(["steer", "followUp"])),
  /** `action` inputs: the journal ordinal the payload was computed against; past head = stale. */
  after: Schema.optional(Schema.Number),
});
export type DeliverBody = typeof DeliverBody.Type;

const ReadModelName = Schema.Literals([
  "history",
  "decisions",
  "requests",
  "alarms",
  "generations",
  "tree",
  "metrics",
  "control",
  "outbound",
]);

/** `nextCursor` is null when the page reached the chain head. */
export const ReadPage = Schema.Struct({
  body: Schema.String,
  nextCursor: Schema.NullOr(Schema.Number),
});
export type ReadPage = typeof ReadPage.Type;

/** A pure projection that appends nothing and never wakes the loop, so NOT cluster-persisted. */
export const ReadRpc = Rpc.make("Read", {
  payload: {
    model: ReadModelName,
    cursor: Schema.Number,
  },
  success: ReadPage,
  error: AdmissionFailure,
});
