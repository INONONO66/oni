import type { Database } from "bun:sqlite";
import { z } from "zod";
import { Ingress } from "@oni/protocol";
import type { AutomationAdapter, StoredAutomation } from "../automation/index.js";
import { StoredGroup } from "../automation/group.js";
import { Route } from "../../automation/matcher.js";

const EntryRow = z.object({ data: z.string(), approved: z.number().int() });
const DecisionRow = z.object({ data: z.string() });
const CountRow = z.object({ count: z.number().int() });

function decodeEntry(row: z.infer<typeof EntryRow>): StoredAutomation {
  return { record: Ingress.Automation.parse(JSON.parse(row.data)), approved: row.approved === 1 };
}

export function createSqliteAutomationAdapter(db: Database, now: () => number): AutomationAdapter {
  return {
    get(id) {
      const row = EntryRow.nullable().parse(db.query("SELECT data, approved FROM automation WHERE id = ?").get(id));
      return row === null ? undefined : decodeEntry(row);
    },
    set(entry) {
      const at = now();
      db.query(`INSERT INTO automation (id, data, approved, enabled, time_created, time_updated)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, approved = excluded.approved,
          enabled = excluded.enabled, time_updated = excluded.time_updated`)
        .run(entry.record.id, JSON.stringify(entry.record), Number(entry.approved), Number(entry.record.enabled), at, at);
    },
    remove(id) {
      return db.query("DELETE FROM automation WHERE id = ?").run(id).changes > 0;
    },
    list() {
      return EntryRow.array().parse(db.query("SELECT data, approved FROM automation ORDER BY time_created, id").all())
        .map(decodeEntry);
    },
    record(decision, group, route) {
      const row = Ingress.Events.RoutingDecision.schema.parse(decision);
      if (row.stage !== "automation") return;
      db.transaction(() => {
        db.query(`INSERT INTO automation_ledger (inbound_id, automation_id, decision, time, data)
          VALUES (?, ?, ?, ?, ?)`)
          .run(row.inboundId, row.by, row.decision, row.time, JSON.stringify(row));
        if (group !== undefined) {
          db.query(`INSERT INTO automation_group (id, automation_id, data) VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET data = excluded.data`)
            .run(group.id, group.pending.automationId, JSON.stringify(group));
        }
        if (route !== undefined) {
          db.query("INSERT INTO automation_delivery (inbound_id, data) VALUES (?, ?)")
            .run(row.inboundId, JSON.stringify(route));
        }
      }).immediate();
    },
    decisions(inboundId) {
      return DecisionRow.array().parse(db.query(`
        SELECT data, 0 AS phase, seq AS position FROM automation_ledger WHERE inbound_id = ?
        UNION ALL
        SELECT data, 1 AS phase, 0 AS position FROM automation_group_close WHERE inbound_id = ?
        ORDER BY phase, position`).all(inboundId, inboundId))
        .map((row) => Ingress.Events.RoutingDecision.schema.parse(JSON.parse(row.data)));
    },
    pendingDelivery(inboundId) {
      const row = DecisionRow.nullable().parse(db.query(
        "SELECT data FROM automation_delivery WHERE inbound_id = ? AND completed = 0",
      ).get(inboundId));
      return row === null ? undefined : Route.parse(JSON.parse(row.data));
    },
    ledger(query) {
      return DecisionRow.array().parse(db.query(`
        SELECT data FROM (
          SELECT data, time, seq AS position FROM automation_ledger
          UNION ALL
          SELECT data, json_extract(data, '$.time') AS time, rowid AS position FROM automation_group_close
        ) WHERE (? IS NULL OR json_extract(data, '$.surface') = ?)
          AND (? IS NULL OR json_extract(data, '$.decision') = ?)
          AND (? IS NULL OR json_extract(data, '$.by') = ?)
          AND (? IS NULL OR time >= ?) AND (? IS NULL OR time <= ?)
        ORDER BY time DESC, position DESC LIMIT ?`).all(
          query.surface ?? null, query.surface ?? null,
          query.decision ?? null, query.decision ?? null,
          query.recordId ?? null, `automation/${query.recordId}`,
          query.since ?? null, query.since ?? null,
          query.until ?? null, query.until ?? null, query.limit,
        )).map((row) => Ingress.Events.RoutingDecision.schema.parse(JSON.parse(row.data)));
    },
    delivered(inboundId, sessionId, actionSeq) {
      db.transaction(() => {
        for (const table of ["automation_ledger", "automation_group_close"]) {
          db.query(`UPDATE ${table} SET data = json_set(data, '$.target', ?, '$.sessionId', ?, '$.actionSeq', ?)
            WHERE inbound_id = ? AND json_extract(data, '$.decision') IN ('matched', 'grouped')`)
            .run(`session:${sessionId}`, sessionId, actionSeq, inboundId);
        }
      }).immediate();
    },
    refused(inboundId, reason) {
      db.transaction(() => {
        db.query(`UPDATE automation_ledger SET decision = 'refused',
            data = json_set(data, '$.decision', 'refused', '$.reason', ?)
          WHERE inbound_id = ? AND decision = 'matched'`).run(reason, inboundId);
        db.query(`UPDATE automation_group_close SET data = json_set(data, '$.decision', 'refused', '$.reason', ?)
          WHERE inbound_id = ? AND json_extract(data, '$.decision') = 'matched'`).run(reason, inboundId);
        db.query("UPDATE automation_delivery SET completed = 1 WHERE inbound_id = ?").run(inboundId);
      }).immediate();
    },
    completeDelivery(inboundId) {
      db.query("UPDATE automation_delivery SET completed = 1 WHERE inbound_id = ?").run(inboundId);
    },
    groups() {
      return DecisionRow.array().parse(db.query("SELECT data FROM automation_group WHERE closed_at IS NULL ORDER BY id").all())
        .map((row) => StoredGroup.parse(JSON.parse(row.data)));
    },
    closeGroup(id, at, matched, decisions) {
      return db.transaction(() => {
        const closed = db.query("UPDATE automation_group SET closed_at = ?, matched = ? WHERE id = ? AND closed_at IS NULL")
          .run(at, Number(matched), id);
        if (closed.changes === 0) return [];
        const firing = decisions.find((decision) => decision.stage === "automation" && decision.decision === "matched");
        const receipt = firing === undefined ? null : DecisionRow.nullable().parse(db.query(
          "SELECT data FROM automation_ledger WHERE inbound_id = ? AND json_extract(data, '$.actionSeq') IS NOT NULL LIMIT 1",
        ).get(firing.inboundId));
        const delivered = receipt === null ? undefined : Ingress.Events.RoutingDecision.schema.parse(JSON.parse(receipt.data));
        const rows = decisions.map((decision) => {
          return Ingress.Events.RoutingDecision.schema.parse({
            ...decision,
            ...(delivered?.stage === "automation" && decision.stage === "automation" &&
              (decision.decision === "matched" || decision.decision === "grouped")
              ? { target: delivered.target, sessionId: delivered.sessionId, actionSeq: delivered.actionSeq } : {}),
          });
        });
        for (const row of rows) {
          db.query("INSERT INTO automation_group_close (group_id, inbound_id, data) VALUES (?, ?, ?)")
            .run(id, row.inboundId, JSON.stringify(row));
        }
        return rows;
      }).immediate();
    },
    matchedSince(id, start, end) {
      return CountRow.parse(db.query(`SELECT
        (SELECT COUNT(*) FROM automation_ledger
          WHERE automation_id = ? AND decision = 'matched' AND time >= ? AND time < ?) +
        (SELECT COUNT(*) FROM automation_group
          WHERE automation_id = ? AND matched = 1 AND closed_at >= ? AND closed_at < ?) AS count`)
        .get(`automation/${id}`, start, end, id, start, end)).count;
    },
  };
}
