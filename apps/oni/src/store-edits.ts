import type { Database } from "bun:sqlite";
import type { Ingress, Provisioning } from "@oni/protocol";

type WithoutCorrelation<T> = T extends object ? Omit<T, "requestId"> : never;

/** The success frame the Owner received for a mutation, minus its correlation; derived, never re-declared. */
type StoreEditChange =
  | WithoutCorrelation<Extract<Ingress.RuleResponse, { type: "rule_added" | "rule_moved" | "rule_enabled" | "rule_disabled" | "rule_removed" }>>
  | WithoutCorrelation<Extract<Provisioning.AgentResponse, { type: "agent_added" | "agent_disabled" }>>;

export interface StoreEdit {
  readonly id: string;
  readonly requestId: string;
  readonly time: number;
  readonly caller: "owner";
  readonly change: StoreEditChange;
}

/** Configuration receipts share the catalog transaction with the rows they describe. */
export function createStoreEditWriter(database: Database) {
  database.run(`CREATE TABLE IF NOT EXISTS store_edit (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL CHECK (json_valid(data))
  )`);
  return (edit: StoreEdit): void => {
    database.query("INSERT INTO store_edit (id, data) VALUES (?, ?)").run(edit.id, JSON.stringify(edit));
  };
}

export interface StoreEditPort {
  readonly transaction: <T>(body: () => T) => T;
  readonly record: ReturnType<typeof createStoreEditWriter>;
  readonly now: () => number;
  readonly id: () => string;
}
