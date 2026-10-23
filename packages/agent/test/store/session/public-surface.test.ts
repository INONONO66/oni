/// <reference lib="es2022.object" />
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { LedgerAction, LedgerSession } from "@oni/protocol";
import * as ledgerExports from "../../../src/core/store/session-file";
import { bootstrapStoreDatabase } from "../../../src/core/store/session-file";
import { SESSION_FILE_SCHEMA } from "../../../src/core/store/session-file";

test("967 exports expose only canonical session authority", () => {
  expect(Object.hasOwn(ledgerExports, "Session")).toBe(false);
  // The legacy process-global storage plane is gone.
  for (const retired of ["Storage", "SqliteStorageAdapter", "ActorRegistry", "SurfaceKey"]) {
    expect(Object.hasOwn(ledgerExports, retired)).toBe(false);
  }
  const store = ledgerExports.openSessionStore(":memory:", { now: () => 1_700_000_000_000 });
  try {
    for (const retired of ["session", "message", "part", "inbox", "alarms"]) {
      expect(retired in store).toBe(false);
    }
    for (const canonical of ["sessions", "actions", "transaction"]) {
      expect(canonical in store).toBe(true);
    }
  } finally {
    store.close();
  }
});

// W5.2 review F6: the package index exports a narrow l0 write-kernel so no
// consumer needs deep imports for fenced commits.
test("L0Write commits a fenced action with its serialized payload", () => {
  const { L0Write } = ledgerExports;
  const db = new Database(":memory:");
  try {
    bootstrapStoreDatabase(db, SESSION_FILE_SCHEMA);
    const row: LedgerSession.Row = {
      id: "surface-session",
      parentId: null,
      role: "resident",
      fenceOwner: "runner:surface",
      fence: 1,
      revision: 0,
      state: "idle",
      toolsGeneration: 0,
      systemHash: "",
      policyGeneration: 0,
    };
    expect(L0Write.insertSession(db, row)).toBe(true);
    expect(L0Write.selectSession(db, "surface-session")).toEqual(row);
    const action: LedgerAction.Append = {
      id: "surface-turn",
      parentId: null,
      sessionId: "surface-session",
      kind: "turn",
      intent: { encodingVersion: 1, value: { phase: "terminal" } },
      effect: { encodingVersion: 1, value: { terminal: "result" } },
      irreversible: true,
      ts: 10,
    };
    const result = L0Write.commitSession(
      db,
      {
        sessionId: "surface-session",
        owner: "runner:surface",
        fence: 1,
        now: 10,
        expectedRevision: 0,
        actions: [action],
        state: "idle",
      },
      { rowByteCap: L0Write.DEFAULT_ROW_BYTE_CAP },
      (error) => {
        throw error;
      },
    );
    if (result?.ok !== true) throw new Error("surface commit was refused");
    const [receipt] = result.receipts;
    if (receipt === undefined) throw new Error("surface commit produced no receipt");
    expect(receipt.action).toEqual({ ...action, ordinal: 1 });
    expect(result.row.revision).toBe(1);
  } finally {
    db.close();
  }
});
