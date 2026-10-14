import type { Database } from "bun:sqlite";
import { canonicalJson, PlainObjectSchema } from "@openomni/protocol";
import { z } from "zod";
import { LedgerInvariant } from "../errors";
import { parsePlainJson } from "../storage/sqlite-l0-rows";

/** One armed occurrence restored from the `armed_alarms` index ( S3). */
export interface ArmedAlarmRow {
  readonly alarmId: string;
  readonly occurrenceId: string;
  readonly fireAt: number;
  readonly purpose: string;
  readonly armSeq: number;
  readonly sourceKey: string;
  /** Canonical JSON of the arm's payload. */
  readonly payload: string;
  /** Delivery attempts already consumed (schema v2). */
  readonly strikes: number;
  /** Set once a quiet fire moved the occurrence; the activation resend re-delivers at it. */
  readonly tick?: number;
}

/** The current occurrence of one alarm chain, read by its primary key without the arm-row join. */
export interface ArmedOccurrence {
  readonly occurrenceId: string;
  readonly fireAt: number;
}

const ArmedAlarmSqlRow = z.object({
  alarm_id: z.string(),
  occurrence_id: z.string(),
  fire_at: z.number(),
  strikes: z.number().int().nonnegative(),
  arm_id: z.string(),
  intent: z.string(),
});
const StrikeRow = z.object({ strikes: z.number().int().positive() }).nullable();

const ArmIntentView = z.object({
  at: z.number(),
  purpose: z.string().min(1),
  sourceKey: z.string().min(1),
  payload: PlainObjectSchema.optional(),
});
const RequeueRow = z.object({ fire_at: z.number() }).nullable();

const ArmedOccurrenceRow = z.object({ occurrence_id: z.string(), fire_at: z.number() }).nullable();

const ArmedCountRow = z.object({ count: z.number().int().nonnegative() });

function armSeqFromArmRowId(armRowId: string): number {
  const marker = armRowId.lastIndexOf(":arm:");
  const seq = marker < 0 ? Number.NaN : Number(armRowId.slice(marker + ":arm:".length));
  if (!Number.isInteger(seq) || seq < 0)
    throw new LedgerInvariant({
      operation: "alarm.armedAlarms",
      message: `arm row id does not carry an armSeq: ${armRowId}`,
    });
  return seq;
}

/** `armed_alarms` ports; `strikeArmedAlarm`/`requeueArmedAlarm` write index state only, no row. */
export function createArmedAlarmPorts(db: Database): {
  armedAlarms(): readonly ArmedAlarmRow[];
  armedAlarm(alarmId: string): ArmedOccurrence | undefined;
  armedCount(): number;
  strikeArmedAlarm(occurrenceId: string): number | undefined;
  requeueArmedAlarm(occurrenceId: string, at: number): boolean;
} {
  return {
    armedAlarms() {
      const rows = ArmedAlarmSqlRow.array().parse(
        db
          .query(`
        SELECT aa.alarm_id, aa.occurrence_id, aa.fire_at, aa.strikes, a.id AS arm_id, a.intent AS intent
        FROM armed_alarms aa
        JOIN action a ON a.kind = 'alarm'
          AND json_extract(a.intent, '$.op') = 'arm'
          AND json_extract(a.effect, '$.occurrenceId') = aa.occurrence_id
        ORDER BY aa.fire_at, aa.alarm_id`)
          .all(),
      );
      return rows.map((row): ArmedAlarmRow => {
        const intent = ArmIntentView.parse(parsePlainJson(row.intent));
        return {
          alarmId: row.alarm_id,
          occurrenceId: row.occurrence_id,
          fireAt: row.fire_at,
          purpose: intent.purpose,
          armSeq: armSeqFromArmRowId(row.arm_id),
          sourceKey: intent.sourceKey,
          payload: canonicalJson(intent.payload ?? {}),
          strikes: row.strikes,
          ...(row.fire_at === intent.at ? {} : { tick: row.fire_at }),
        };
      });
    },
    armedAlarm(alarmId) {
      const row = ArmedOccurrenceRow.parse(
        db.query("SELECT occurrence_id, fire_at FROM armed_alarms WHERE alarm_id = ?").get(alarmId),
      );
      return row === null ? undefined : { occurrenceId: row.occurrence_id, fireAt: row.fire_at };
    },
    armedCount() {
      return ArmedCountRow.parse(
        db.query("SELECT COUNT(*) AS count FROM armed_alarms").get(),
      ).count;
    },
    strikeArmedAlarm(occurrenceId) {
      return db
        .transaction(
          () =>
            StrikeRow.parse(
              db
                .query("UPDATE armed_alarms SET strikes = strikes + 1 WHERE occurrence_id = ? RETURNING strikes")
                .get(occurrenceId),
            )?.strikes,
        )
        .immediate();
    },
    requeueArmedAlarm(occurrenceId, at) {
      return db
        .transaction(
          () =>
            RequeueRow.parse(
              db
                .query("UPDATE armed_alarms SET fire_at = ?, strikes = 0 WHERE occurrence_id = ? RETURNING fire_at")
                .get(at, occurrenceId),
            ) !== null,
        )
        .immediate();
    },
  };
}
