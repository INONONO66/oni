import { Gateway, type Storage as ProtocolStorage } from "@oni/protocol";
import { ChannelStoreInvariant } from "./errors";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { SqliteCount } from "./json";

/**
 * Atomically claims one item against a counted window (moved beside its only
 * consumer in #1317). The caller owns the persisted row and window projection;
 * this primitive owns the indivisible read/decision/append sequence.
 * `alreadyClaimed` makes retrying a deterministic claim idempotent without
 * charging the window twice.
 */
function claimWithinCountedWindow<State>(operations: {
  transaction<T>(operation: () => T): T;
  alreadyClaimed(): boolean;
  readWindowState(): State;
  canClaim(state: State): boolean;
  append(): void;
}): "claimed" | "refused" {
  return operations.transaction(() => {
    if (operations.alreadyClaimed()) return "claimed";
    const state = operations.readWindowState();
    if (!operations.canClaim(state)) return "refused";
    operations.append();
    return "claimed";
  });
}

const WindowRow = z.object({
  count_in_window: SqliteCount,
  notify_in_window: SqliteCount,
  converse_in_window: SqliteCount,
  last_send_at: z.number().nullable(),
});
const ClaimRow = z.object({
  sender_id: z.string(),
  target_actor_id: z.string(),
  class: Gateway.EgressDebitRow.shape.class,
  at: z.number(),
});

/**
 * Durable active-egress counted-window claims (#219, perimeter domain —
 * gateway-design §4). The projection read and admitted-row append run under
 * one BEGIN IMMEDIATE so two connections cannot both consume the same
 * remaining slot. Append-only: one row per ADMITTED proactive send.
 */
export function createSqliteEgressBudgetAdapter(
  db: Database,
  now: () => number,
): ProtocolStorage.EgressBudgetSubAdapter {
  const read: ProtocolStorage.EgressBudgetSubAdapter["read"] = (
    senderId,
    targetActorId,
    windowStartAt,
  ) => {
    const state = WindowRow.parse(
      db
        .query(`SELECT
      COUNT(*) FILTER (WHERE at >= ?) AS count_in_window,
      COUNT(*) FILTER (WHERE at >= ? AND class = 'notify') AS notify_in_window,
      COUNT(*) FILTER (WHERE at >= ? AND class = 'converse') AS converse_in_window,
      MAX(at) AS last_send_at
      FROM egress_debit WHERE sender_id = ? AND target_actor_id = ?`)
        .get(windowStartAt, windowStartAt, windowStartAt, senderId, targetActorId),
    );
    return Gateway.EgressDebitState.parse({
      countInWindow: state.count_in_window,
      notifyInWindow: state.notify_in_window,
      converseInWindow: state.converse_in_window,
      ...(state.last_send_at === null ? {} : { lastSendAt: state.last_send_at }),
    });
  };
  return {
    read,
    claim(row, windowStartAt, canClaim) {
      const parsed = Gateway.EgressDebitRow.parse(row);
      return claimWithinCountedWindow({
        transaction: (operation) => db.transaction(operation).immediate(),
        alreadyClaimed: () => {
          const existing = ClaimRow.nullable().parse(
            db
              .query(
                `SELECT sender_id, target_actor_id, class, at
               FROM egress_debit
               WHERE id = ?`,
              )
              .get(parsed.id),
          );
          if (existing === null) return false;
          if (
            existing.sender_id !== parsed.senderId ||
            existing.target_actor_id !== parsed.targetActorId ||
            existing.class !== parsed.class ||
            existing.at !== parsed.at
          ) {
            throw new ChannelStoreInvariant({
              operation: "egress.debit",
              message: `egress debit id ${parsed.id} already identifies a different claim`,
            });
          }
          return true;
        },
        readWindowState: () => read(parsed.senderId, parsed.targetActorId, windowStartAt),
        canClaim,
        append: () => {
          db.query(
            `INSERT INTO egress_debit (id, sender_id, target_actor_id, class, at, time_created)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(
            parsed.id,
            parsed.senderId,
            parsed.targetActorId,
            parsed.class,
            parsed.at,
            now(),
          );
        },
      });
    },
  };
}
