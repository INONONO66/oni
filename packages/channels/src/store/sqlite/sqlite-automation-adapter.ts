import type { Database } from "bun:sqlite";
import { z } from "zod";
import { Ingress } from "@openomni/protocol";
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
      return DecisionRow.array().parse(db.query("SELECT data FROM automation_ledger WHERE inbound_id = ? ORDER BY seq").all(inboundId))
        .map((row) => Ingress.Events.RoutingDecision.schema.parse(JSON.parse(row.data)));
    },
    pendingDelivery(inboundId) {
      const row = DecisionRow.nullable().parse(db.query(
        "SELECT data FROM automation_delivery WHERE inbound_id = ? AND completed = 0",
      ).get(inboundId));
      return row === null ? undefined : Route.parse(JSON.parse(row.data));
    },
    completeDelivery(inboundId) {
      db.query("UPDATE automation_delivery SET completed = 1 WHERE inbound_id = ?").run(inboundId);
    },
    groups() {
      return DecisionRow.array().parse(db.query("SELECT data FROM automation_group WHERE closed_at IS NULL ORDER BY id").all())
        .map((row) => StoredGroup.parse(JSON.parse(row.data)));
    },
    closeGroup(id, at, matched) {
      db.query("UPDATE automation_group SET closed_at = ?, matched = ? WHERE id = ?")
        .run(at, Number(matched), id);
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
