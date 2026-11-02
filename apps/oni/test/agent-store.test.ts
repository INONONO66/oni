import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Provisioning } from "@oni/protocol";
import { Bundle } from "@oni/agent";
import { ComposedGeneration } from "../src/composition/composed";
import { runAppEffect } from "../src/gateway";
import { planeOf } from "./helpers/ledger";
import { residentSuite } from "./helpers/resident-suite";
import { createAgentStore } from "../src/agents";
import { seedAgents } from "../src/composition/resident";

const profile = { id: "x", prompt: { identity: "IDENTITY", mandate: "MANDATE" }, tools: ["read"], model: "fixture/family/model" };
const suite = residentSuite();

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

test("boot seeds refuse disable for both personas", () => {
  using database = new Database(":memory:");
  const store = createAgentStore(database);
  seedAgents(store, [
    { name: "shared", visibility: { model: ["resident", "child"], cell: [] } },
    { name: "resident-cell", visibility: { model: [], cell: ["resident"] } },
  ]);
  expect(store.get("resident").tools).toEqual(["shared", "resident-cell"]);
  expect(store.get("child").tools).toEqual(["shared"]);
  for (const id of ["resident", "child"]) {
    expect(() => store.disable(id)).toThrow(Provisioning.AgentError);
    expect(() => store.disable(id)).toThrow(expect.objectContaining({
      data: { code: "seed_protected", id, message: `seed agent cannot be disabled: ${id}` },
    }));
  }
});

test("a second boot refreshes seeds from the real manifest without changing user profiles", async () => {
  const config = suite.config("agent-seeds-reboot-", { compactionSummarizer: false });
  const first = await suite.boot({ config });
  const firstPlane = await planeOf(first.runtime);
  firstPlane.stores.agents.add(profile);
  const firstComposed = await runAppEffect(first.runtime, ComposedGeneration);
  const template = firstComposed.current().generation.tools.find((tool) => tool.name === "eval");
  if (template === undefined) throw new Error("manifest must declare eval");
  const original = firstPlane.stores.agents.get("resident");
  firstPlane.stores.agents.seed({ ...original, id: "resident", prompt: profile.prompt });
  await first.stop();

  const second = await suite.boot({
    config,
    bundles: [Bundle.define({ name: "later-pack", requires: [], tools: [{ ...template, name: "later_tool" }] })],
  });
  const plane = await planeOf(second.runtime);
  const composed = await runAppEffect(second.runtime, ComposedGeneration);
  const tools = composed.current().manifest.bundles.flatMap((bundle) => bundle.tools);
  for (const role of ["resident", "child"] as const) {
    const expected = [...new Set(tools.filter((tool) =>
      tool.visibility.model.includes(role) || tool.visibility.cell.includes(role),
    ).map((tool) => tool.name))].sort();
    expect([...plane.stores.agents.get(role).tools].sort()).toEqual(expected);
    expect(plane.stores.agents.get(role).tools).toContain("later_tool");
  }
  expect(original.tools).not.toContain("later_tool");
  expect(plane.stores.agents.get("resident").prompt).toEqual(original.prompt);
  expect(plane.stores.agents.get("x")).toEqual({ ...profile, enabled: true });
});

test("agent rows validate prompt sections and provider/model references", () => {
  using database = new Database(":memory:");
  const store = createAgentStore(database);
  expect(() => store.add({ ...profile, model: "unqualified" })).toThrow();
  expect(() => store.add({ ...profile, prompt: { identity: "", mandate: "MANDATE" } })).toThrow();
  expect(store.list()).toEqual([]);
});
