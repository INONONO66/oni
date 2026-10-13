import { z } from "zod";
import type { Database } from "bun:sqlite";
import { Journal, LedgerAction, type LedgerSession } from "@openomni/protocol";
import { actionPayloadBytes, computeActionHash, GENESIS_PREV_HASH, storedActionRow } from "../action-hash.js";
import { SessionSqlRow, decodeSession } from "./sqlite-l0-rows";
import { CorruptRecord, SchemaRefused } from "../errors";
import type { RefuseWrite } from "./write-effect";

export const sessionSelect = `SELECT id, parent_id, role, lease_owner, lease_fence,
  revision, state, tools_generation, system_hash, policy_generation FROM session`;

export function insertSession(db: Database, row: LedgerSession.Row): boolean {
  const result = db
    .query(
      `INSERT INTO session (
         id, parent_id, role, lease_owner, lease_fence, revision, state,
         tools_generation, system_hash, policy_generation
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      row.id,
      row.parentId,
      row.role,
      row.fenceOwner,
      row.fence,
      row.revision,
      row.state,
      row.toolsGeneration,
      row.systemHash,
      row.policyGeneration,
    );
  return result.changes === 1;
}

function selectSessionSql(db: Database, id: string): SessionSqlRow | undefined {
  const row = SessionSqlRow.nullable().parse(db.query(`${sessionSelect} WHERE id = ?`).get(id));
  return row === null ? undefined : row;
}

export function selectSession(db: Database, id: string): LedgerSession.Row | undefined {
  const row = selectSessionSql(db, id);
  return row === undefined ? undefined : decodeSession(row);
}

/** Append-boundary limits of one session file, injected at open. */
export interface AppendLimits {
  /** Serialized payload bytes (`actionPayloadBytes`) one row may carry, checkpoint rows included. */
  readonly rowByteCap: number;
}

/** Payload one row may carry: 1 MiB, the figure the row cap is stated in. */
const ROW_PAYLOAD_CAP = 1024 * 1024;

/**
 * Headroom for the journal's own framing around a payload at the cap: the
 * gate's decision metadata on a `policy.decision` row (hashes, verdict,
 * matched ids, obligations) and the executor's result envelope on a `tool`
 * row (`phase`, `effect`, `resultHash`). `actionPayloadBytes` cannot separate
 * framing from payload, so a payload of exactly 1 MiB (the bounded-projection
 * measurement fixture) is admitted with its envelope: 529 and 224 bytes there.
 */
const ROW_FRAMING_ALLOWANCE = 4 * 1024;

/** Default row cap at the append boundary: a 1 MiB payload plus its framing. */
export const DEFAULT_ROW_BYTE_CAP = ROW_PAYLOAD_CAP + ROW_FRAMING_ALLOWANCE;

/**
 * Fail-closed write (#1252): every journal row body must satisfy its kind's
 * declared schema and the row byte cap before anything touches the chain.
 * `fold.checkpoint` is outside the declaration table (schema-exempt) but
 * never outside the byte cap.
 */
function refuseRow(
  action: LedgerAction.Append,
  limits: AppendLimits,
  refuse: RefuseWrite | undefined,
): void {
  const declaration = Journal.declarationFor(action.kind);
  if (declaration !== undefined) {
    const body = declaration.schema.safeParse({ intent: action.intent, effect: action.effect });
    if (!body.success) {
      throwRefusal(action, body.error.issues[0]?.message ?? "schema mismatch", refuse);
    }
  }
  if (actionPayloadBytes(action) > limits.rowByteCap) throwRefusal(action, "row_bytes", refuse);
}

function throwRefusal(action: LedgerAction.Append, reason: string, refuse: RefuseWrite | undefined): never {
  const error = new SchemaRefused({
    sessionId: action.sessionId,
    actionId: action.id,
    kind: action.kind,
    reason,
  });
  if (refuse !== undefined) refuse(error);
  throw error;
}

// ─── #1254 S3: armed_alarms index delta, derived from the alarm row itself ───

const ArmDeltaIntent = z.object({
  op: z.literal("arm"),
  alarmId: z.string().min(1),
  at: z.number().nullable(),
});
const ArmDeltaEffect = z.object({ occurrenceId: z.string().min(1) });
const FiredDeltaIntent = z.object({ op: z.literal("fired"), occurrenceId: z.string().min(1) });

/** What one committed `alarm` row does to the session file's `armed_alarms` index. */
type ArmedAlarmDelta =
  | { readonly op: "upsert"; readonly alarmId: string; readonly occurrenceId: string; readonly fireAt: number }
  | { readonly op: "retire"; readonly alarmId: string }
  | { readonly op: "fired"; readonly occurrenceId: string };

/**
 * Derives the `armed_alarms` delta from the appended row (#1254 S3, decision 6
 * in delta-g010: callers supply nothing — a caller-supplied delta could desync
 * from the row). Pre-#1254 alarm rows (watch lifecycle, retry.scheduled
 * evidence) carry no `alarmId`/`occurrenceId` and yield no delta.
 */
export function armedAlarmDelta(action: LedgerAction.Append): ArmedAlarmDelta | undefined {
  if (action.kind !== "alarm") return undefined;
  const arm = ArmDeltaIntent.safeParse(action.intent.value);
  if (arm.success) {
    if (arm.data.at === null) return { op: "retire", alarmId: arm.data.alarmId };
    const effect = ArmDeltaEffect.safeParse(action.effect.value);
    if (!effect.success) return undefined;
    return {
      op: "upsert",
      alarmId: arm.data.alarmId,
      occurrenceId: effect.data.occurrenceId,
      fireAt: arm.data.at,
    };
  }
  const fired = FiredDeltaIntent.safeParse(action.intent.value);
  return fired.success ? { op: "fired", occurrenceId: fired.data.occurrenceId } : undefined;
}

/** Applies the derived delta inside the SAME transaction that appended the row. */
function applyArmedAlarmDelta(db: Database, delta: ArmedAlarmDelta): void {
  switch (delta.op) {
    case "upsert":
      db.query(
        `INSERT INTO armed_alarms (alarm_id, occurrence_id, fire_at) VALUES (?, ?, ?)
         ON CONFLICT(alarm_id) DO UPDATE SET occurrence_id = excluded.occurrence_id,
           fire_at = excluded.fire_at, strikes = 0`,
      ).run(delta.alarmId, delta.occurrenceId, delta.fireAt);
      return;
    case "retire":
      db.query("DELETE FROM armed_alarms WHERE alarm_id = ?").run(delta.alarmId);
      return;
    case "fired":
      db.query("DELETE FROM armed_alarms WHERE occurrence_id = ?").run(delta.occurrenceId);
      return;
  }
}

/**
 * Single append outside a batch: validates the one-action batch (existence +
 * parent ownership live in `validActionBatch`, the single query site per
 * check — #1314) and then appends.
 */
export function appendAction(
  db: Database,
  action: LedgerAction.Append,
  expectedRevision: number,
  limits: AppendLimits,
  refuse?: RefuseWrite,
): LedgerAction.Receipt | undefined {
  // #1252 fail-closed order (review r1 H2): the schema refusal runs BEFORE
  // the existence/parent checks, exactly as pre-#1314 — a duplicate-id (or
  // foreign-parent) action that is ALSO schema-mismatched throws the typed
  // `SchemaRefused`, never a silent `undefined`.
  refuseRow(action, limits, refuse);
  if (!validActionBatch(db, [action], action.sessionId)) return undefined;
  return appendValidatedAction(db, action, expectedRevision, limits, refuse);
}

/**
 * #1314: the write after validation. Callers guarantee `validActionBatch`
 * already covered this action inside the same transaction; no existence or
 * parent re-query happens here.
 */
function appendValidatedAction(
  db: Database,
  action: LedgerAction.Append,
  expectedRevision: number,
  limits: AppendLimits,
  refuse?: RefuseWrite,
): LedgerAction.Receipt | undefined {
  refuseRow(action, limits, refuse);
  const revision = expectedRevision + 1;
  const updated = db
    .query(
      `UPDATE session SET revision = ?
       WHERE id = ? AND revision = ? AND role IS NOT NULL`,
    )
    .run(revision, action.sessionId, expectedRevision);
  if (updated.changes !== 1) return undefined;
  const head = db
    .query<{ action_hash: string }, [string]>(
      "SELECT action_hash FROM action WHERE session_id = ? ORDER BY ordinal DESC LIMIT 1",
    )
    .get(action.sessionId);
  const prevHash = head === null ? GENESIS_PREV_HASH : z.string().parse(head.action_hash);
  const stored = storedActionRow(action, prevHash, revision);
  const actionHash = computeActionHash(stored);
  db.query(
    `INSERT INTO action (
         id, parent_id, session_id, kind, intent, effect, revert, irreversible,
         encoding_version, ts, ordinal, prev_hash, action_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    stored.id,
    stored.parent_id,
    stored.session_id,
    stored.kind,
    stored.intent,
    stored.effect,
    stored.revert,
    stored.irreversible,
    stored.encoding_version,
    stored.ts,
    stored.ordinal,
    prevHash,
    actionHash,
  );
  const delta = armedAlarmDelta(action);
  if (delta !== undefined) applyArmedAlarmDelta(db, delta);
  const node = LedgerAction.Node.parse({ ...action, ordinal: revision, prevHash, actionHash });
  return { action: node, revision };
}

/**
 * Fenced chain commit (W5.2): the session file is the single fence authority.
 * Authority is owner + fence equality against the single session row plus the
 * expected revision, inside this file's write lock — the same lock the
 * successor's `adoptFence` CAS takes, so there are exactly two interleavings
 * and both are correct: an old-fence commit landing before adoption is
 * accepted, durable, and visible to the successor (adoption is strictly
 * later in the same serialized file); one landing after adoption is refused
 * "stale". The catalog only allocates fence numbers; no lease-expiry clock
 * enters the predicate.
 */
export function commitSession(
  db: Database,
  request: LedgerSession.Commit,
  limits: AppendLimits,
  refuse: RefuseWrite,
): LedgerSession.CommitResult | undefined {
  const current = selectSession(db, request.sessionId);
  if (current === undefined) return undefined;
  const refusal = sessionAuthorityRefusal(db, request, current);
  if (refusal !== undefined) return refusal;
  if (!validActionBatch(db, request.actions, request.sessionId)) {
    return refusedSessionCommit("revision", current);
  }

  const receipts: LedgerAction.Receipt[] = [];
  let revision = current.revision;
  for (const action of request.actions) {
    // `validActionBatch` above already ran the existence and parent checks.
    const receipt = appendValidatedAction(db, action, revision, limits, refuse);
    if (receipt === undefined) return refusedSessionCommit("revision", current);
    receipts.push(receipt);
    revision = receipt.revision;
  }
  const generation = request.generation ?? current;
  const updated = db
    .query(
      `UPDATE session SET state = ?, tools_generation = ?, system_hash = ?,
         policy_generation = ?
       WHERE id = ? AND lease_owner = ? AND lease_fence = ? AND revision = ?
         AND role IS NOT NULL`,
    )
    .run(
      request.state,
      generation.toolsGeneration,
      generation.systemHash,
      generation.policyGeneration,
      request.sessionId,
      request.owner,
      request.fence,
      revision,
    );
  if (updated.changes !== 1) return refusedSessionCommit("stale", current);
  const row = selectSession(db, request.sessionId);
  if (row === undefined)
    return refuse(new CorruptRecord({ operation: "session.commit", id: request.sessionId }));
  return { ok: true, row, receipts };
}

function sessionAuthorityRefusal(
  db: Database,
  request: LedgerSession.Commit,
  current: LedgerSession.Row,
): LedgerSession.CommitResult | undefined {
  if (current.fenceOwner !== request.owner || current.fence !== request.fence) {
    return refusedSessionCommit("stale", current);
  }
  if (current.revision !== request.expectedRevision) {
    return refusedSessionCommit("revision", current);
  }
  if (
    request.requestCount !== undefined &&
    pendingRequestCount(db, request.requestCount.since) !== request.requestCount.count
  ) {
    return refusedSessionCommit("revision", current);
  }
  return undefined;
}

function validActionBatch(
  db: Database,
  actions: readonly LedgerAction.Append[],
  sessionId: string,
): boolean {
  const ids = new Set<string>();
  for (const action of actions) {
    if (action.sessionId !== sessionId || ids.has(action.id) || actionExists(db, action.id)) {
      return false;
    }
    if (
      action.parentId !== null &&
      !ids.has(action.parentId) &&
      !parentBelongsToSession(db, action.parentId, sessionId)
    ) {
      return false;
    }
    ids.add(action.id);
  }
  return true;
}

function refusedSessionCommit(
  reason: "stale" | "revision",
  current: LedgerSession.Row,
): LedgerSession.CommitResult {
  return {
    ok: false,
    reason,
    currentFence: current.fence,
    currentRevision: current.revision,
  };
}

function actionExists(db: Database, id: string): boolean {
  return db.query("SELECT 1 FROM action WHERE id = ?").get(id) !== null;
}

function parentBelongsToSession(db: Database, parentId: string | null, sessionId: string): boolean {
  if (parentId === null) return true;
  const row = z
    .object({ session_id: z.string() })
    .nullable()
    .parse(db.query("SELECT session_id FROM action WHERE id = ?").get(parentId));
  return row?.session_id === sessionId;
}

function pendingRequestCount(db: Database, since: number): number {
  const row = z.object({ count: z.number() }).parse(
    db
      .query(`
    SELECT COUNT(*) AS count FROM (
      SELECT effect, ROW_NUMBER() OVER (
        PARTITION BY json_extract(effect, '$.request.requestId') ORDER BY ordinal DESC
      ) AS latest
      FROM action
      WHERE kind = 'request'
    )
    WHERE latest = 1
      AND json_extract(effect, '$.request.state') = 'open'
      AND json_extract(effect, '$.request.mode') = 'approval'
      AND json_extract(effect, '$.request.createdAt') > ?
  `)
      .get(since),
  );
  return row.count;
}
