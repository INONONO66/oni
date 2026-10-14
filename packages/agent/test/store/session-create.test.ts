import { materializationSeed, generationSnapshot } from "../../src/core/store/configure";
// One creation door. `Core.createSession` writes the genesis configure
// row and the catalog index inside one enclosed write unit: a fault after
// genesis preparation but before the session file commits rolls the catalog
// index back with it, a duplicate id refuses typed without rewriting genesis,
// and supplied settings, generation, and action identity survive verbatim.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { SessionGeneration } from "@openomni/protocol";
import { createSession, CreateRefused, type CreateSessionInput } from "../../src/core/session/create";
import { openLedgerPlane, OpenRefused, type LedgerPlane } from "../../src/core/session/host";
import { MaterializeRefused } from "../../src/core/store/errors";

import { runLedgerSync } from "./helpers/effect";
import { testNow } from "./helpers/storage";

function openPlane(): { plane: LedgerPlane; sessionsDir: string; close: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "session-create-"));
  const sessionsDir = join(directory, "sessions");
  const plane = openLedgerPlane({
    now: testNow,
    catalog: { path: join(directory, "catalog.sqlite") },
    sessions: { dir: sessionsDir },
  });
  return {
    plane,
    sessionsDir,
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
    // The index stamp is the caller's genesis time, not the catalog clock.
    expect(plane.catalog.sessionIndex("s-1")).toMatchObject({ id: "s-1", parentId: null, role: "resident", createdAt: 17 });

    const kernel = plane.openKernel("s-1");
    const stored = kernel.latestGenerationFor("s-1");
    expect(stored.tools.map((tool) => tool.name)).toEqual(["alpha", "zeta"]);
    expect(stored.bundles).toEqual(["b1", "b2"]);
    expect(stored.systemPreset).toBe("preset");
    expect(stored.systemBlocks).toEqual([{ id: "runner", content: "runner:process", source: "test" }]);
    expect(stored.policyGeneration).toBe(3);
    expect(kernel.row("s-1").revision).toBe(1);
    const intent = SessionGeneration.ConfigureIntent.parse(kernel.latestAction("s-1")?.intent.value);
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
    const again = runLedgerSync(Effect.result(
      createSession(plane, {
        id: "s-dup",
        parentId: null,
        role: "resident",
        genesis: { ...genesis, actionId: "s-dup:second", at: 99 },
      }),
    ));
    expect(Result.isFailure(again)).toBe(true);
    const error = Result.isFailure(again) ? again.failure : undefined;
    expect(error).toBeInstanceOf(CreateRefused);
    expect(error).toMatchObject({ sessionId: "s-dup", reason: "duplicate" });
    expect(error?.message).toBe("session creation refused (duplicate): s-dup");
    const kernel = plane.openKernel("s-dup");
    expect(kernel.row("s-dup").revision).toBe(1);
    expect(kernel.latestAction("s-dup")?.id).toBe(first.genesis.action.id);
    expect(plane.catalog.sessionIndex("s-dup")?.createdAt).toBe(17);
    expect(plane.listSessions()).toHaveLength(1);
  } finally {
    close();
  }
});

test("an orphan index row (no session file) refuses typed as orphan_index before any session file write", () => {
  const { plane, close } = openPlane();
  try {
    plane.catalog.indexSession({ id: "s-indexed", parentId: null, role: "resident", createdAt: 1 });
    const exit = runLedgerSync(Effect.result(
      createSession(plane, { id: "s-indexed", parentId: null, role: "resident", genesis }),
    ));
    expect(Result.isFailure(exit)).toBe(true);
    // Distinct from `duplicate` — a caller treating duplicates as
    // the idempotent outcome must not continue against a session with no genesis.
    expect(Result.isFailure(exit) ? exit.failure : undefined).toMatchObject({
      _tag: "CreateRefused",
      reason: "orphan_index",
    });
    expect(plane.sessionStore("s-indexed").sessions.get("s-indexed")).toBeUndefined();
    expect(() => plane.listSessions()).toThrow(OpenRefused);
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
    const exit = runLedgerSync(Effect.result(store.create({ materialize: faulty, index: plane.catalog, createdAt: 1 })));
    expect(Result.isFailure(exit)).toBe(true);
    expect(Result.isFailure(exit) ? exit.failure : undefined).toBeInstanceOf(MaterializeRefused);
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
    const storageExit = runLedgerSync(Effect.result(
      createSession(
        { catalog: plane.catalog, sessionStore: () => broken },
        { id: "s-fault", parentId: null, role: "resident", genesis },
      ),
    ));
    expect(Result.isFailure(storageExit)).toBe(true);
    expect(Result.isFailure(storageExit) ? storageExit.failure : undefined).toMatchObject({
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

test("a failed catalog index leaves no session file and retry creates the same id", () => {
  const { plane, sessionsDir, close } = openPlane();
  const path = join(sessionsDir, "s-index-fail.sqlite");
  const index = plane.catalog.indexSession.bind(plane.catalog);
  try {
    plane.catalog.indexSession = () => {
      throw new Error("injected index failure");
    };
    const result = runLedgerSync(Effect.result(
      createSession(plane, { id: "s-index-fail", parentId: null, role: "resident", genesis }),
    ));
    expect(Result.isFailure(result)).toBe(true);
    expect(Result.isFailure(result) ? result.failure : undefined).toBeInstanceOf(CreateRefused);
    expect(plane.catalog.sessionIndex("s-index-fail")).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(
      readdirSync(sessionsDir)
        .filter((name) => name.endsWith(".sqlite"))
        .map((name) => name.slice(0, -".sqlite".length))
        .sort(),
    ).toEqual(plane.catalog.sessionIds());
    console.info(`A2 failed create filesOnDisk=0 session_index=0`);
    plane.catalog.indexSession = index;
    const created = runLedgerSync(
      createSession(plane, { id: "s-index-fail", parentId: null, role: "resident", genesis }),
    );
    expect(created.row.id).toBe("s-index-fail");
  } finally {
    plane.catalog.indexSession = index;
    close();
  }
});

test("the session file commits before its index row; a thrown index commit leaves neither", () => {
  const { plane, sessionsDir, close } = openPlane();
  const transaction = plane.catalog.transaction;
  let fileBeforeIndex: boolean | undefined;
  Object.defineProperty(plane.catalog, "transaction", {
    configurable: true,
    value: <T>(operation: () => T): T => transaction(() => {
      fileBeforeIndex = plane.sessionStore("s-order").sessions.get("s-order") !== undefined;
      operation();
      throw new Error("injected index commit fault");
    }),
  });
  try {
    const result = runLedgerSync(Effect.result(
      createSession(plane, { id: "s-order", parentId: null, role: "resident", genesis }),
    ));
    expect(Result.isFailure(result) ? result.failure : undefined).toMatchObject({ _tag: "CreateRefused", reason: "write" });
    expect(fileBeforeIndex).toBe(true);
    expect(plane.catalog.sessionIndex("s-order")).toBeUndefined();
    expect(existsSync(join(sessionsDir, "s-order.sqlite"))).toBe(false);
    expect(plane.listSessions()).toEqual([]);
    console.info(`A6 create order fileBeforeIndex=${fileBeforeIndex} session_index=0 listSessions=0`);
    Object.defineProperty(plane.catalog, "transaction", { configurable: true, value: transaction });
    expect(runLedgerSync(createSession(plane, { id: "s-order", parentId: null, role: "resident", genesis })).row.revision).toBe(1);
  } finally {
    close();
  }
});
