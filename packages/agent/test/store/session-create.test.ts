// #1346: one creation door. `Core.createSession` writes the genesis configure
// row and the catalog index inside one enclosed write unit: a fault after
// genesis preparation but before the session file commits rolls the catalog
// index back with it, a duplicate id refuses typed without rewriting genesis,
// and supplied settings, generation, and action identity survive verbatim.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";
import { createSession, CreateRefused, type CreateSessionInput } from "../../src/core/create";
import { openLedgerPlane, type LedgerPlane } from "../../src/core/host";
import { MaterializeRefused } from "../../src/core/store/errors";
import { materializationSeed, generationSnapshot } from "../../src/core/store/fence";
import { runLedgerSync } from "./helpers/effect";
import { testNow } from "./helpers/storage";

function openPlane(): { plane: LedgerPlane; close: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "session-create-"));
  const plane = openLedgerPlane({
    now: testNow,
    catalog: { path: join(directory, "catalog.sqlite") },
    sessions: { dir: join(directory, "sessions") },
  });
  return {
    plane,
    close: () => {
      plane.close();
      rmSync(directory, { recursive: true });
    },
  };
}

const genesis: CreateSessionInput["genesis"] = {
  tools: [
    { name: "zeta", inputSchema: {}, category: "query" },
    { name: "alpha", inputSchema: {}, category: "mutation" },
  ],
  bundles: ["b2", "b1"],
  system: { preset: "preset", blocks: [{ id: "runner", content: "runner:process", source: "test" }] },
  policyGeneration: 3,
  settings: { steering: "one", followUp: "all", forkCopyByteCap: 4096 },
  actionId: "s-1:genesis",
  at: 17,
};

test("createSession writes genesis and catalog index together and preserves the supplied genesis", () => {
  const { plane, close } = openPlane();
  try {
    const receipt = runLedgerSync(
      createSession(plane, { id: "s-1", parentId: null, role: "resident", genesis }),
    );
    expect(receipt.row).toMatchObject({
      id: "s-1",
      parentId: null,
      role: "resident",
      fenceOwner: null,
      fence: 0,
      revision: 1,
      state: "idle",
      toolsGeneration: 1,
      policyGeneration: 3,
    });
    expect(receipt.genesis.action.id).toBe("s-1:genesis");
    expect(receipt.genesis.action.kind).toBe("session.configure");
    expect(receipt.genesis.action.ts).toBe(17);
    expect(plane.catalog.sessionIndex("s-1")).toMatchObject({ id: "s-1", parentId: null, role: "resident" });

    const kernel = plane.openKernel("s-1");
    const stored = kernel.latestGenerationFor("s-1");
    expect(stored.tools.map((tool) => tool.name)).toEqual(["alpha", "zeta"]);
    expect(stored.bundles).toEqual(["b1", "b2"]);
    expect(stored.systemPreset).toBe("preset");
    expect(stored.systemBlocks).toEqual([{ id: "runner", content: "runner:process", source: "test" }]);
    expect(stored.policyGeneration).toBe(3);
    expect(kernel.row("s-1").revision).toBe(1);
    const intent = kernel.latestAction("s-1")?.intent.value as { settings?: unknown };
    expect(intent.settings).toEqual({ steering: "one", followUp: "all", forkCopyByteCap: 4096 });
    expect(plane.listSessions().map((row) => row.id)).toEqual(["s-1"]);
  } finally {
    close();
  }
});

test("a duplicate id refuses typed without rewriting genesis or touching the index", () => {
  const { plane, close } = openPlane();
  try {
    const first = runLedgerSync(
      createSession(plane, { id: "s-dup", parentId: null, role: "resident", genesis }),
    );
    const again = Effect.runSyncExit(
      createSession(plane, {
        id: "s-dup",
        parentId: null,
        role: "resident",
        genesis: { ...genesis, actionId: "s-dup:second", at: 99 },
      }),
    );
    expect(Exit.isFailure(again)).toBe(true);
    const error = Exit.isFailure(again) ? Cause.squash(again.cause) : undefined;
    expect(error).toBeInstanceOf(CreateRefused);
    expect(error).toMatchObject({ sessionId: "s-dup", reason: "duplicate" });
    const kernel = plane.openKernel("s-dup");
    expect(kernel.row("s-dup").revision).toBe(1);
    expect(kernel.latestAction("s-dup")?.id).toBe(first.genesis.action.id);
    expect(plane.catalog.sessionIndex("s-dup")?.createdAt).toBe(testNow());
    expect(plane.listSessions()).toHaveLength(1);
  } finally {
    close();
  }
});

test("an index row that already exists refuses before any session file write", () => {
  const { plane, close } = openPlane();
  try {
    plane.catalog.indexSession({ id: "s-indexed", parentId: null, role: "resident", createdAt: 1 });
    const exit = Effect.runSyncExit(
      createSession(plane, { id: "s-indexed", parentId: null, role: "resident", genesis }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({
      _tag: "CreateRefused",
      reason: "duplicate",
    });
    expect(plane.sessionStore("s-indexed").sessions.get("s-indexed")).toBeUndefined();
    expect(plane.listSessions()).toHaveLength(0);
  } finally {
    close();
  }
});

test("a fault after genesis preparation but before commit leaves neither the index nor the genesis", () => {
  const { plane, close } = openPlane();
  try {
    const snapshot = generationSnapshot({
      generation: 1,
      revertTo: 0,
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 0,
    });
    const materialize = materializationSeed(
      { id: "s-fault", parentId: null, role: "resident", actionId: "s-fault:genesis", at: 1 },
      snapshot,
    );
    // The injected fault: the prepared genesis names a different session than
    // its row, so the session-file write refuses AFTER the catalog index row
    // was inserted inside the enclosing unit.
    const faulty = {
      ...materialize,
      initialAction: { ...materialize.initialAction, sessionId: "s-other" },
    };
    const store = plane.sessionStore("s-fault");
    const exit = Effect.runSyncExit(store.create({ materialize: faulty, index: plane.catalog }));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBeInstanceOf(MaterializeRefused);
    expect(plane.catalog.sessionIndex("s-fault")).toBeUndefined();
    expect(store.sessions.get("s-fault")).toBeUndefined();
    expect(plane.listSessions()).toHaveLength(0);

    // A storage-level throw (not a typed refusal) unwinds the same way.
    const broken = Object.create(store, {
      transaction: {
        value: () => {
          throw new Error("injected storage fault");
        },
      },
    }) as typeof store;
    const storageExit = Effect.runSyncExit(
      createSession(
        { catalog: plane.catalog, sessionStore: () => broken },
        { id: "s-fault", parentId: null, role: "resident", genesis },
      ),
    );
    expect(Exit.isFailure(storageExit)).toBe(true);
    expect(Exit.isFailure(storageExit) ? Cause.squash(storageExit.cause) : undefined).toMatchObject({
      _tag: "CreateRefused",
      reason: "write",
    });
    expect(plane.catalog.sessionIndex("s-fault")).toBeUndefined();
    expect(store.sessions.get("s-fault")).toBeUndefined();

    // The id is still free: the same creation succeeds once the fault is gone.
    const receipt = runLedgerSync(
      createSession(plane, { id: "s-fault", parentId: null, role: "resident", genesis }),
    );
    expect(receipt.row.revision).toBe(1);
    expect(plane.catalog.sessionIndex("s-fault")).toBeDefined();
  } finally {
    close();
  }
});
