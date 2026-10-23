import { expect, test } from "bun:test";
import { SQLiteError } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { Core, Testing } from "../../../src";
import { openLedgerPlane } from "../../../src/core/session/host";
import type { CreateSessionInput } from "../../../src/core/session/create";
import { runAgentSync } from "../../helpers/isolated";

function fixture() {
  const plane = openLedgerPlane({ now: () => 17 });
  return { plane, [Symbol.dispose]: () => plane.close() };
}

const genesis = (id: string): CreateSessionInput["genesis"] => ({
  tools: [], bundles: ["resident"], system: { preset: "test", blocks: [] },
  policyGeneration: 0, actionId: `${id}:genesis`, at: 17,
  manifestHash: "manifest", settings: { steering: "one", followUp: "all" },
});

test.each([
  { id: "ingress", parentId: null, role: "resident" as const },
  { id: "child", parentId: "parent", role: "child" as const },
])("ledger.session creates $role genesis and indexes its parent", ({ id, parentId, role }) => {
  using state = fixture();
  const receipt = runAgentSync(state.plane.session(id).create({ parentId, role, genesis: genesis(id) }));
  expect(receipt.row).toMatchObject({ id, parentId, role, revision: 1, toolsGeneration: 1 });
  expect(state.plane.read.index(id)).toMatchObject({ id, parentId, role, createdAt: 17 });
  expect(state.plane.read.session(id).latestGenerationFor(id)).toMatchObject({
    manifestHash: "manifest", bundles: ["resident"],
  });
  expect(state.plane.read.session(id).latestSettings(id)).toEqual({ steering: "one", followUp: "all" });
});

test("ledger reads list and get committed sessions, actions and decision facts without write capabilities", () => {
  using state = fixture();
  runAgentSync(state.plane.session("s").create({ parentId: null, role: "resident", genesis: genesis("s") }));
  const fact = { key: "route:s", type: "route.decided", data: { accepted: true }, timeCreated: 19 };
  state.plane.session("s").decisions.record(fact);

  const reads = state.plane.read;
  expect(reads.sessions.list().map((row) => row.id)).toEqual(["s"]);
  expect(reads.sessions.get("s")).toMatchObject({ id: "s", revision: 1 });
  expect(reads.sessions.get("missing")).toBeUndefined();
  expect(reads.session("s").historyPage("s").actions.map((action) => action.id)).toEqual(["s:genesis"]);
  expect(reads.session("s").actionById("s:genesis")?.kind).toBe("session.configure");
  expect(reads.session("s").actionById("missing")).toBeUndefined();
  expect(reads.fact("s", fact.key)).toMatchObject(fact);
  expect(reads.fact("s", "missing")).toBeUndefined();
  expect("commit" in reads.session("s")).toBe(false);
  expect("adoptFence" in reads.session("s")).toBe(false);
});

test("ledger.session creation refuses a duplicate without replacing genesis", () => {
  using state = fixture();
  const input = { parentId: null, role: "resident" as const, genesis: genesis("s") };
  runAgentSync(state.plane.session("s").create(input));
  const result = runAgentSync(Effect.result(state.plane.session("s").create({
    ...input, genesis: { ...input.genesis, actionId: "replacement" },
  })));
  expect(Result.isFailure(result) ? result.failure : undefined).toMatchObject({
    _tag: "CreateRefused", reason: "duplicate",
  });
  expect(state.plane.read.session("s").latestAction("s")?.id).toBe("s:genesis");
});

function activeSession(plane: ReturnType<typeof openLedgerPlane>) {
  runAgentSync(plane.session("s").create({ parentId: null, role: "resident", genesis: genesis("s") }));
  const kernel = plane.openKernel("s");
  const fence = runAgentSync(Testing.adoptSessionAuthority(kernel, "s", "writer"));
  return { kernel, fence };
}

test("ledger.session fork copies the prefix and indexes the child through Core", () => {
  using state = fixture();
  const { kernel, fence } = activeSession(state.plane);
  runAgentSync(kernel.commit({
    sessionId: "s", owner: "writer", fence, now: 20, expectedRevision: 1, state: "idle",
    actions: [{
      id: "prompt", parentId: "s:genesis", sessionId: "s", kind: "prompt",
      intent: { encodingVersion: 1, value: { content: "hello" } },
      effect: { encodingVersion: 1, value: null }, irreversible: true, ts: 20,
    }],
  }));

  const fork = runAgentSync(state.plane.session("s").fork({
    at: "prompt", childId: "fork", genesisActionId: "fork:genesis", now: 21,
  }));
  expect(fork.forkedFrom).toMatchObject({ session: "s", anchor: "prompt", copied: 2 });
  expect(state.plane.read.index("fork")?.parentId).toBe("s");
  expect(state.plane.read.session("fork").historyPage("fork").actions).toHaveLength(3);
});

const configureRuntime = {
  authorizeConfigure: () => Effect.succeed(true),
  generations: { configure: <A>(_id: object, _snapshot: object, commit: Effect.Effect<A, Core.SessionError>) => commit },
  clock: () => 25,
  entropy: () => "configure",
};

test("ledger.session tools.add preserves the manifest and activation fence", () => {
  using state = fixture();
  const { fence } = activeSession(state.plane);
  const receipt = runAgentSync(state.plane.session("s").configureTools(
    [{ name: "read", inputSchema: {}, category: "query" }], configureRuntime,
  ));
  expect(receipt).toEqual({ generation: 2, revertTo: 1 });
  expect(state.plane.read.session("s").row("s")).toMatchObject({
    fenceOwner: "writer", fence, toolsGeneration: 2, revision: 2,
  });
  expect(state.plane.read.session("s").latestGenerationFor("s")).toMatchObject({
    manifestHash: "manifest", tools: [{ name: "read", inputSchema: {}, category: "query" }],
  });
});

test("ledger.session tools.add refuses authority changed during policy consultation", () => {
  using state = fixture();
  const { kernel } = activeSession(state.plane);
  const result = runAgentSync(Effect.result(state.plane.session("s").configureTools([], {
    ...configureRuntime,
    authorizeConfigure: () => Testing.adoptSessionAuthority(kernel, "s", "successor").pipe(Effect.as(true)),
  })));
  expect(Result.isFailure(result) ? result.failure : undefined).toMatchObject({
    _tag: "CommitFailed", error: { _tag: "CommitRefused" },
  });
  expect(state.plane.read.session("s").latestGenerationFor("s").generation).toBe(1);
});

test("Core catalog reads reject writes and close their handle", () => {
  const directory = mkdtempSync(join(tmpdir(), "ledger-read-"));
  const path = join(directory, "catalog.sqlite");
  const plane = openLedgerPlane({ now: () => 17, catalog: { path } });
  try {
    runAgentSync(plane.session("s").create({ parentId: null, role: "resident", genesis: genesis("s") }));
    const opened = Core.readCatalog(path, (database) => {
      expect(database.query("SELECT id FROM session_index").all()).toEqual([{ id: "s" }]);
      expect(() => database.run("DELETE FROM session_index")).toThrow(SQLiteError);
      return database;
    });
    expect(() => opened.query("SELECT 1").get()).toThrow(RangeError);
  } finally {
    plane.close();
    rmSync(directory, { recursive: true });
  }
});
