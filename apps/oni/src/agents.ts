import type { Database } from "bun:sqlite";
import { Provisioning } from "@oni/protocol";
import { z } from "zod";

const AgentRow = z.object({
  data: z.string().transform((value) => Provisioning.Agent.parse(JSON.parse(value))),
}).transform((row) => row.data);

/** The app's declarations share the catalog connection with provisioning rows. */
export function createAgentStore(database: Database) {
  database.run(`CREATE TABLE IF NOT EXISTS agent (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL CHECK (json_valid(data))
  )`);
  return {
    seed(input: Provisioning.Agent & { readonly id: "resident" | "child" }): void {
      database.query("INSERT INTO agent (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
        .run(input.id, JSON.stringify(input));
    },
    list: (): Provisioning.Agent[] =>
      AgentRow.array().parse(database.query("SELECT data FROM agent ORDER BY id").all()),
    get(id: string): Provisioning.Agent {
      const row = AgentRow.nullable().parse(database.query("SELECT data FROM agent WHERE id = ?").get(id));
      if (row === null)
        throw new Provisioning.AgentError({ code: "not_found", id, message: `agent not found: ${id}` });
      return row;
    },
    add(input: z.input<typeof Provisioning.Agent>): Provisioning.Agent {
      const agent = Provisioning.Agent.parse(input);
      const inserted = database.query("INSERT INTO agent (id, data) VALUES (?, ?) ON CONFLICT(id) DO NOTHING")
        .run(agent.id, JSON.stringify(agent));
      if (inserted.changes === 0)
        throw new Provisioning.AgentError({ code: "duplicate", id: agent.id, message: `agent already exists: ${agent.id}` });
      return agent;
    },
    disable(id: string): void {
      if (id === "resident" || id === "child")
        throw new Provisioning.AgentError({ code: "seed_protected", id, message: `seed agent cannot be disabled: ${id}` });
      const updated = database.query("UPDATE agent SET data = json_set(data, '$.enabled', json('false')) WHERE id = ?").run(id);
      if (updated.changes === 0)
        throw new Provisioning.AgentError({ code: "not_found", id, message: `agent not found: ${id}` });
    },
  };
}

export type AgentStore = ReturnType<typeof createAgentStore>;
