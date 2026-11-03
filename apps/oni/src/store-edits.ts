import type { Database } from "bun:sqlite";
import { Ingress, Provisioning } from "@oni/protocol";
import { z } from "zod";

const Edit = z.object({
  id: z.string().min(1),
  requestId: z.string().min(1),
  time: z.number().int().nonnegative(),
  caller: z.literal("owner"),
  change: z.discriminatedUnion("type", [
    z.object({
      type: z.enum(["rule_added", "rule_moved", "rule_enabled", "rule_disabled"]),
      record: Ingress.Rule,
    }).strict(),
    z.object({ type: z.literal("rule_removed"), id: z.string().min(1) }).strict(),
    z.object({ type: z.enum(["agent_added", "agent_disabled"]), record: Provisioning.Agent }).strict(),
  ]),
}).strict();
type Edit = z.infer<typeof Edit>;

/** Configuration receipts share the catalog transaction with the rows they describe. */
export function createStoreEditWriter(database: Database) {
  database.run(`CREATE TABLE IF NOT EXISTS store_edit (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL CHECK (json_valid(data))
  )`);
  return (input: Edit): void => {
    const edit = Edit.parse(input);
    database.query("INSERT INTO store_edit (id, data) VALUES (?, ?)").run(edit.id, JSON.stringify(edit));
  };
}

export interface StoreEditPort {
  readonly transaction: <T>(body: () => T) => T;
  readonly record: ReturnType<typeof createStoreEditWriter>;
  readonly now: () => number;
  readonly id: () => string;
}
