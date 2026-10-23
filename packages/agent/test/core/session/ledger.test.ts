import { expect, test } from "bun:test";
import { SQLiteError } from "bun:sqlite";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Result } from "effect";
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

test("ledger reads committed sessions and actions without write capabilities", () => {
  using state = fixture();
  runAgentSync(state.plane.session("s").create({ parentId: null, role: "resident", genesis: genesis("s") }));
  const reads = state.plane.read;
  expect(reads.sessions.list().map((row) => row.id)).toEqual(["s"]);
  expect(reads.session("s").historyPage("s").actions.map((action) => action.id)).toEqual(["s:genesis"]);
  expect(reads.session("s").actionById("s:genesis")?.kind).toBe("session.configure");
  expect(reads.session("s").actionById("missing")).toBeUndefined();
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
  commitFailure: (error: Core.LedgerError) => new Core.AgentFailure({
    operation: "session.configure", cause: String(error),
  }),
  missingAuthority: (id: string) => new Error(`session has no activation authority: ${id}`),
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

test.each(["fence", "revision"] as const)("ledger.session tools.add preserves the facade failure on stale %s", (stale) => {
  using state = fixture();
  const { kernel } = activeSession(state.plane);
  const result = runAgentSync(Effect.result(state.plane.session("s").configureTools([], {
    ...configureRuntime,
    authorizeConfigure: () => (stale === "fence"
      ? Testing.adoptSessionAuthority(kernel, "s", "successor").pipe(Effect.asVoid)
      : kernel.commit({
        sessionId: "s", owner: "writer", fence: kernel.row("s").fence,
        expectedRevision: 1, state: "idle", now: 24,
        actions: [{
          id: "intervening", parentId: "s:genesis", sessionId: "s", kind: "prompt",
          intent: { encodingVersion: 1, value: { content: "hello" } },
          effect: { encodingVersion: 1, value: null }, irreversible: true, ts: 24,
        }],
      }).pipe(Effect.asVoid)).pipe(Effect.as(true)),
  })));
  expect(Result.isFailure(result) ? result.failure : undefined).toMatchObject({
    _tag: "AgentFailure", operation: "session.configure",
    cause: String(new Core.CommitRefused({
      sessionId: "s", reason: stale, expectedRevision: 1,
      currentRevision: stale === "revision" ? 2 : 1,
      fence: 1, currentFence: stale === "fence" ? 2 : 1,
    })),
  });
  expect(state.plane.read.session("s").latestGenerationFor("s").generation).toBe(1);
});

test("ledger.session tools.add dies with the supplied facade invariant when authority is absent", () => {
  using state = fixture();
  runAgentSync(state.plane.session("s").create({ parentId: null, role: "resident", genesis: genesis("s") }));
  const invariant = new Error("missing activation");
  const exit = runAgentSync(Effect.exit(state.plane.session("s").configureTools([], {
    ...configureRuntime,
    missingAuthority: () => invariant,
    authorizeConfigure: () => Effect.die(new Error("policy must not run without authority")),
  })));
  expect(Exit.isFailure(exit) ? exit.cause : undefined).toEqual(Cause.die(invariant));
  expect(state.plane.read.session("s").row("s").revision).toBe(1);
});

test("ledger activity reads file metadata and leaves absent timestamps to the application", () => {
  using state = fixture();
  expect(state.plane.read.activityAt("memory")).toBeUndefined();
  const directory = mkdtempSync(join(tmpdir(), "ledger-activity-"));
  const plane = openLedgerPlane({ now: () => 17, sessions: { dir: directory } });
  try {
    expect(plane.read.activityAt("missing")).toBeUndefined();
    runAgentSync(plane.session("s").create({ parentId: null, role: "resident", genesis: genesis("s") }));
    const path = Core.sessionFilePath(directory, "s");
    utimesSync(path, 20, 25);
    expect(plane.read.activityAt("s")).toBe(25_000);
    plane.close();
    rmSync(directory, { recursive: true });
    writeFileSync(directory, "not a directory");
    expect(() => plane.read.activityAt("s")).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
  } finally {
    plane.close();
    rmSync(directory, { recursive: true, force: true });
  }
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
