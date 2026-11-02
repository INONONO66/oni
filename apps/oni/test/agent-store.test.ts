import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Provisioning } from "@oni/protocol";
import { createAgentStore } from "../src/agents";
import { seedAgents } from "../src/composition/resident";

const profile = { id: "x", prompt: { identity: "IDENTITY", mandate: "MANDATE" }, tools: ["read"], model: "fixture/family/model" };

test("agent declarations round-trip and disable without deleting their configuration", () => {
  using database = new Database(":memory:");
  const store = createAgentStore(database);
  const added = store.add(profile);
  store.disable("x");
  const reopened = createAgentStore(database);
  expect(reopened.list()).toEqual([{ ...added, enabled: false }]);
  expect(reopened.get("x")).toEqual({ ...profile, enabled: false });
});

test("duplicate and missing agent operations are typed refusals", () => {
  using database = new Database(":memory:");
  const store = createAgentStore(database);
  store.add(profile);
  for (const [code, operation] of [
    ["duplicate", () => store.add(profile)],
    ["not_found", () => store.get("missing")],
    ["not_found", () => store.disable("missing")],
  ] as const) {
    expect(operation).toThrow(Provisioning.AgentError);
    expect(operation).toThrow(expect.objectContaining({ data: expect.objectContaining({ code }) }));
  }
});

test("boot seeds retain their rows and refuse disable for both personas", () => {
  using database = new Database(":memory:");
  const store = createAgentStore(database);
  seedAgents(store, [
    { name: "shared", visibility: { model: ["resident", "child"], cell: [] } },
    { name: "resident-cell", visibility: { model: [], cell: ["resident"] } },
  ]);
  const seeded = store.list();
  seedAgents(store, []);
  expect(store.list()).toEqual(seeded);
  expect(store.get("resident").tools).toEqual(["shared", "resident-cell"]);
  expect(store.get("child").tools).toEqual(["shared"]);
  for (const id of ["resident", "child"]) {
    expect(() => store.disable(id)).toThrow(Provisioning.AgentError);
    expect(() => store.disable(id)).toThrow(expect.objectContaining({
      data: { code: "seed_protected", id, message: `seed agent cannot be disabled: ${id}` },
    }));
  }
});

test("agent rows validate prompt sections and provider/model references", () => {
  using database = new Database(":memory:");
  const store = createAgentStore(database);
  expect(() => store.add({ ...profile, model: "unqualified" })).toThrow();
  expect(() => store.add({ ...profile, prompt: { identity: "", mandate: "MANDATE" } })).toThrow();
  expect(store.list()).toEqual([]);
});
