import { z } from "zod";

/**
 * The fourteen fixed hook points (#1251): eight core points the agent core
 * always provides plus six capability points that exist only while their
 * owning capability (removable built-in plugin: tool, compaction, alarm,
 * action) is composed. Policy rows target these ids; a row on an id missing
 * from the merged registration table rejects at compose (`unknown_point`).
 * New points require a record here.
 */
export const PointId = z.enum([
  "ingress.pre",
  "session.open",
  "prompt.pre",
  "turn.pre",
  "turn.post",
  "llm.pre",
  "llm.post",
  "message.pre",
  "tool.pre",
  "tool.post",
  "compaction.pre",
  "compaction.post",
  "alarm.fired",
  "action.pre",
]);
export type PointId = z.infer<typeof PointId>;

export const PointOwner = z.enum(["core", "tool", "compaction", "alarm", "action"]);
export type PointOwner = z.infer<typeof PointOwner>;

/** The four row actions (`do`); a point's record enumerates which it allows. */
export const PointDo = z.enum(["gate", "rewrite", "emit", "observe"]);
export type PointDo = z.infer<typeof PointDo>;

export interface PointRecord {
  readonly id: PointId;
  readonly owner: PointOwner;
  readonly allowedDo: readonly PointDo[];
  readonly rewritableFields: readonly string[];
  readonly whenFields: readonly string[];
  /** Turn end: nothing may be emitted at or after this point (post-end emit rejects). */
  readonly end?: boolean;
  /**
   * The consulted value at this point is caller-shaped (a tool's own input or
   * output), so a rewrite row's declared fields are validated nonempty but
   * not against a fixed field list.
   */
  readonly rewriteOpen?: boolean;
}

/**
 * Condition fields every consultation supplies today (the v3 execution
 * context); every point accepts them in `when` alongside its own fields.
 */
const CONTEXT_WHEN_FIELDS: readonly string[] = ["op", "operation", "role", "sessionId"];

function point(
  id: PointId,
  owner: PointOwner,
  allowedDo: readonly PointDo[],
  rewritableFields: readonly string[],
  whenFields: readonly string[],
  flags?: { end?: boolean; rewriteOpen?: boolean },
): PointRecord {
  return Object.freeze({
    id,
    owner,
    allowedDo: Object.freeze([...allowedDo]),
    rewritableFields: Object.freeze([...rewritableFields]),
    whenFields: Object.freeze([
      ...CONTEXT_WHEN_FIELDS,
      ...whenFields.filter((field) => !CONTEXT_WHEN_FIELDS.includes(field)),
    ]),
    ...(flags?.end === true ? { end: true } : {}),
    ...(flags?.rewriteOpen === true ? { rewriteOpen: true } : {}),
  });
}

/** Eight core points: fixed loop locations the agent core always registers. */
export const CORE_POINT_RECORDS: readonly PointRecord[] = Object.freeze([
  point("ingress.pre", "core", ["gate", "rewrite", "observe"], ["visibility"], ["kind", "channel", "actor", "grant"]),
  // `gate` is allowed at session.open: the core's configure authority
  // evaluates historical `session.configure` rows at this point (#1251);
  // #1252/#1255 own reshaping configuration gating.
  point("session.open", "core", ["gate", "emit", "observe"], [], ["generation"]),
  point("prompt.pre", "core", ["gate", "rewrite", "emit", "observe"], ["body", "visibility"], ["kind", "origin", "delivery"]),
  point("turn.pre", "core", ["gate", "rewrite", "emit", "observe"], ["budget"], ["kind"]),
  // `result` is the v3 stop-judge surface a turn-post rewrite may touch.
  point("turn.post", "core", ["gate", "rewrite", "observe"], ["budget", "stop", "result"], ["kind", "stopReason", "metric"], { end: true }),
  point("llm.pre", "core", ["gate", "rewrite", "emit", "observe"], ["messages", "model", "tools"], ["model"]),
  point("llm.post", "core", ["gate", "rewrite", "emit", "observe"], ["finishReason", "classify"], ["finishReason", "classify"]),
  point("message.pre", "core", ["gate", "rewrite", "observe"], ["body", "to"], ["to", "kind"]),
]);

/** Six capability points, present only while their owner is composed. */
export const CAPABILITY_POINT_RECORDS: readonly PointRecord[] = Object.freeze([
  // `origin` (#1841): the kind of caller the dispatcher attributed the call to
  // (`session` or `machine`), so a row can fence machine-originated calls.
  point("tool.pre", "tool", ["gate", "rewrite", "emit", "observe"], ["input"], ["op", "origin", "annotations"], { rewriteOpen: true }),
  point("tool.post", "tool", ["gate", "rewrite", "emit", "observe"], ["output"], ["op", "status"], { rewriteOpen: true }),
  point("compaction.pre", "compaction", ["gate", "rewrite", "emit", "observe"], ["summary"], ["reason"]),
  point("compaction.post", "compaction", ["emit", "observe"], [], []),
  point("alarm.fired", "alarm", ["emit", "observe"], [], ["tag", "payloadPath"]),
  point("action.pre", "action", ["gate", "rewrite", "observe"], ["body", "delivery"], ["handlerRef", "source"]),
]);

export const POINT_RECORDS: readonly PointRecord[] = Object.freeze([
  ...CORE_POINT_RECORDS,
  ...CAPABILITY_POINT_RECORDS,
]);

/**
 * The only row intents an `emit` row may journal: `message`, armed `alarm`,
 * `compaction` (intent). Inputs (prompt, signal) enter solely through the
 * session entity's `deliver` RPC and are rejected at compose.
 */
export const EMIT_KINDS = Object.freeze(["message", "alarm", "compaction"] as const);
export type EmitKind = (typeof EMIT_KINDS)[number];
