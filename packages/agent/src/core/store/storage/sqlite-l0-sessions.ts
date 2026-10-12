import type { Database } from "bun:sqlite";
import { LedgerSession, type ObservationSink } from "@openomni/protocol";
import {
  CommitRefused,
  CorruptRecord,
  FenceRefused,
  MaterializeRefused,
  SessionNotFound,
} from "../errors";
import type { SessionWriteAdapter } from "../services";
import { type SessionSqlRow, decodeSession } from "./sqlite-l0-rows.js";
import {
  type AppendLimits,
  sessionSelect,
  insertSession,
  selectSession,
  appendAction,
  commitSession,
} from "./sqlite-l0-write.js";
import { reportCommitted, type ObservationFailurePort } from "./sqlite-l0-observation.js";
import { writeEffect, type RefuseWrite } from "./write-effect";

export function materializeSession(
  db: Database,
  parsed: LedgerSession.Materialize,
  limits: AppendLimits,
  refuse: RefuseWrite,
): LedgerSession.MaterializeResult {
  if (
    parsed.initialAction.sessionId !== parsed.row.id ||
    parsed.initialAction.kind !== "session.configure" ||
    parsed.initialAction.parentId !== null ||
    parsed.row.revision !== 0
  )
    return refuse(new MaterializeRefused({ sessionId: parsed.row.id, reason: "input" }));
  if (!insertSession(db, parsed.row)) {
    const existing = selectSession(db, parsed.row.id);
    if (existing === undefined)
      return refuse(new MaterializeRefused({ sessionId: parsed.row.id, reason: "state" }));
    return { created: false, row: existing };
  }
  const receipt = appendAction(db, parsed.initialAction, 0, limits, refuse);
  if (receipt === undefined)
    return refuse(new MaterializeRefused({ sessionId: parsed.row.id, reason: "configuration" }));
  const row = selectSession(db, parsed.row.id);
  if (row === undefined)
    return refuse(new CorruptRecord({ operation: "materialize", id: parsed.row.id }));
  return { created: true, row, receipt };
}

function staleLeaseRefusal(current: LedgerSession.Row): FenceRefused {
  return new FenceRefused({
    sessionId: current.id,
    reason: "stale",
    holder: current.fenceOwner,
    fence: current.fence,
    expiresAt: null,
  });
}

/**
 * Fence adoption (W5.2 F5): the authority transfer. Writes the
 * catalog-allocated fence into the session file's single row, under the same
 * file lock every fenced commit serializes behind — so an old-fence commit
 * either lands strictly before this CAS (accepted, durable, visible to the
 * successor) or after it (refused "stale" by `commitSession`). Idempotent for
 * the current owner+fence pair; a file fence at or beyond the target means a
 * later activation already won.
 */
function adoptFence(db: Database, request: LedgerSession.AdoptFence, refuse: RefuseWrite) {
  const current = selectSession(db, request.sessionId);
  if (current === undefined) return refuse(new SessionNotFound({ sessionId: request.sessionId }));
  if (current.fenceOwner === request.owner && current.fence === request.fence) {
    return { ok: true as const, fence: request.fence };
  }
  if (current.fence >= request.fence) return refuse(staleLeaseRefusal(current));
  const updated = db
    .query(
      `UPDATE session SET lease_owner = ?, lease_fence = ?
       WHERE id = ? AND lease_fence < ? AND role IS NOT NULL`,
    )
    .run(request.owner, request.fence, request.sessionId, request.fence);
  if (updated.changes !== 1) return refuse(staleLeaseRefusal(current));
  return { ok: true as const, fence: request.fence };
}

export function createSessions(
  db: Database,
  transaction: <T>(operation: () => T) => T,
  observationSink: ObservationSink,
  onObservationFailure: ObservationFailurePort,
  limits: AppendLimits,
): SessionWriteAdapter {
  return {
    create: (row) =>
      writeEffect("session.create", () =>
        transaction(() => insertSession(db, LedgerSession.Row.parse(row))),
      ),
    materialize: (input) =>
      writeEffect("session.materialize", (refuse) => {
        const result = transaction(() =>
          materializeSession(db, LedgerSession.Materialize.parse(input), limits, refuse),
        );
        if (result.created)
          reportCommitted(db, observationSink, onObservationFailure, result.receipt);
        return result;
      }),
    get(id) {
      const row = db.query<SessionSqlRow, [string]>(`${sessionSelect} WHERE id = ?`).get(id);
      return row === null ? undefined : decodeSession(row);
    },
    list() {
      const rows = db
        .query<SessionSqlRow, []>(`${sessionSelect} WHERE role IS NOT NULL ORDER BY id`)
        .all();
      return rows.map(decodeSession);
    },
    adoptFence: (input) =>
      writeEffect("session.adoptFence", (refuse) =>
        transaction(() => adoptFence(db, LedgerSession.AdoptFence.parse(input), refuse)),
      ),
    commit: (input) =>
      writeEffect("session.commit", (refuse) => {
        const outcome = transaction(() => {
          const request = LedgerSession.Commit.parse(input);
          const result = commitSession(db, request, limits, refuse);
          if (result === undefined)
            return refuse(new SessionNotFound({ sessionId: request.sessionId }));
          if (!result.ok)
            return refuse(
              new CommitRefused({
                sessionId: request.sessionId,
                reason: result.reason === "stale" ? "fence" : result.reason,
                expectedRevision: request.expectedRevision,
                currentRevision: result.currentRevision,
                fence: request.fence,
                currentFence: result.currentFence,
              }),
            );
          return result;
        });
        for (const receipt of outcome.receipts)
          reportCommitted(db, observationSink, onObservationFailure, receipt);
        return outcome;
      }),
  };
}
