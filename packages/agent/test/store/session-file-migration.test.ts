import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Effect, Result } from "effect";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerAction } from "@oni/protocol";
import { z } from "zod";
import { forkSession } from "../../src/core/session/fork";
import { configureAction, generationSnapshot } from "../../src/core/store/configure";
import { openCatalogStore } from "../../src/core/store/catalog";
import { createSessionKernel } from "../../src/core/store/fence";
import { storedActionRow } from "../../src/core/store/action-row";
import { openSessionStore } from "../../src/core/store/session-file";
import { ActionSqlRow } from "../../src/core/store/storage/sqlite-l0-rows";
import { forkAncestryOf } from "../../src/inspect/tree";
import { runLedgerSync } from "./helpers/effect";
import { materializeRow, residentRow } from "./helpers/ledger";
import { testNow } from "./helpers/storage";

test("v2 session file migrates to v3 with payload rows intact and obsolete columns removed", () => {
  const directory = mkdtempSync(join(tmpdir(), "session-v2-"));
  const path = join(directory, "session.sqlite");
  try {
    using raw = new Database(path);
    raw.exec(readFileSync(join(import.meta.dir, "helpers/session-v2.sql"), "utf8"));
    const before = ActionSqlRow.array().parse(raw.query("SELECT * FROM action ORDER BY ordinal").all());
    const sessionBefore = raw.query("SELECT * FROM session").all();
    const alarmsBefore = raw.query("SELECT * FROM armed_alarms").all();
    const store = openSessionStore(path, { now: testNow });
    try {
      expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
      const columns = (table: string) => z.array(z.object({ name: z.string() }))
        .parse(raw.query(`PRAGMA table_info(${table})`).all()).map((row) => row.name);
      expect(columns("action")).toEqual([
        "id", "parent_id", "session_id", "kind", "intent", "effect", "revert",
        "irreversible", "encoding_version", "ts", "ordinal",
      ]);
      expect(columns("decision_fact")).toEqual(["key", "type", "data", "time_created"]);
      expect(raw.prepare("SELECT * FROM action ORDER BY ordinal").all()).toEqual(before);
      expect(raw.query("SELECT * FROM session").all()).toEqual(sessionBefore);
      expect(raw.query("SELECT * FROM armed_alarms").all()).toEqual(alarmsBefore);
      expect(store.actions.range("legacy", 0, 10)).toEqual([
        {
          id: "first", parentId: null, sessionId: "legacy", kind: "prompt",
          intent: { encodingVersion: 1, value: { source: "test" } },
          effect: { encodingVersion: 1, value: { deliveryKind: "prompt", content: "first" } },
          irreversible: true, ts: 10, ordinal: 1,
        },
        {
          id: "second", parentId: "first", sessionId: "legacy", kind: "tool",
          intent: { encodingVersion: 1, value: { op: "read" } },
          effect: { encodingVersion: 1, value: { result: "kept" } },
          revert: { encodingVersion: 1, value: { undo: "kept" } }, ts: 20, ordinal: 2,
        },
      ]);
      expect(store.decisionFacts.head("fact"))
        .toEqual({ key: "fact", type: "test", data: { kept: true }, timeCreated: 30 });
    } finally {
      store.close();
    }
    const reopened = openSessionStore(path, { now: testNow });
    try {
      expect(reopened.actions.latestAction("legacy", 2)?.id).toBe("second");
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("fresh v3 session file appends and reads one action", () => {
  const directory = mkdtempSync(join(tmpdir(), "session-v3-"));
  const path = join(directory, "session.sqlite");
  try {
    const store = openSessionStore(path, { now: testNow });
    try {
      materializeRow(store.sessions, residentRow("fresh"));
      const action = {
        id: "prompt", parentId: "fresh:configure", sessionId: "fresh", kind: "prompt" as const,
        intent: { encodingVersion: 1 as const, value: { source: "test" } },
        effect: { encodingVersion: 1 as const, value: { deliveryKind: "prompt", content: "hello" } },
        irreversible: true as const, ts: 42,
      };
      const receipt = store.actions.append(action, 1);
      expect(receipt).toEqual({ action: { ...action, ordinal: 2 }, revision: 2 });
      expect(store.actions.actionById(action.id)).toEqual(receipt?.action);
      using raw = new Database(path, { readonly: true });
      expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});

const snapshot = generationSnapshot({
  generation: 1, revertTo: 0, tools: [], system: { preset: "test", blocks: [] },
  policyGeneration: 0,
});

function seedForkFile(path: string, id: string, parentId: string | null, actions: readonly LedgerAction.Append[]) {
  using raw = new Database(path);
  raw.exec(readFileSync(join(import.meta.dir, "helpers/session-v2.sql"), "utf8"));
  raw.run("DELETE FROM action");
  raw.run("DELETE FROM session");
  raw.query("INSERT INTO session (id, parent_id, role, revision) VALUES (?, ?, ?, ?)")
    .run(id, parentId, parentId === null ? "resident" : "child", actions.length);
  const hashes = new Map<string, string>();
  let previous = "oni:l0:genesis:v1";
  const insert = raw.prepare(
    `INSERT INTO action (id, parent_id, session_id, kind, intent, effect, revert,
       irreversible, encoding_version, ts, ordinal, prev_hash, action_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [index, action] of actions.entries()) {
    const row = storedActionRow(action, index + 1);
    const hash = createHash("sha256").update(JSON.stringify([
      previous, row.id, row.parent_id, row.session_id, row.kind, row.intent,
      row.effect, row.revert, row.irreversible, row.encoding_version, row.ts, row.ordinal,
    ])).digest("hex");
    insert.run(row.id, row.parent_id, row.session_id, row.kind, row.intent, row.effect,
      row.revert, row.irreversible, row.encoding_version, row.ts, row.ordinal, previous, hash);
    hashes.set(action.id, hash);
    previous = hash;
  }
  return hashes;
}

for (const order of [["parent", "child"], ["child", "parent"]] as const) {
  test(`v2 fork pins migrate to action ids when opened ${order.join(" then ")}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "session-fork-v2-"));
    const rootPath = join(directory, "root.sqlite");
    const parentPath = join(directory, "parent.sqlite");
    const childPath = join(directory, "child.sqlite");
    const rootConfigure = configureAction({
      id: "root:configure", sessionId: "root", parentId: null,
      operation: "create", snapshot, at: 1,
    });
    const rootPrompt: LedgerAction.Append = {
      id: "root-prompt", parentId: "root:configure", sessionId: "root",
      kind: "prompt", intent: { encodingVersion: 1, value: { source: "test" } },
      effect: { encodingVersion: 1, value: { deliveryKind: "prompt", content: "root" } },
      irreversible: true, ts: 2,
    };
    const parentPrompt: LedgerAction.Append = {
      id: "parent-prompt", parentId: "parent:configure", sessionId: "parent",
      kind: "prompt", intent: { encodingVersion: 1, value: { source: "test" } },
      effect: { encodingVersion: 1, value: { deliveryKind: "prompt", content: "anchor" } },
      irreversible: true, ts: 2,
    };
    const parentTail: LedgerAction.Append = {
      ...parentPrompt, id: "parent-tail", parentId: "parent-prompt", ts: 3,
      effect: { encodingVersion: 1, value: { deliveryKind: "prompt", content: "tail" } },
    };
    try {
      const rootHashes = seedForkFile(rootPath, "root", null, [rootConfigure, rootPrompt]);
      const rootAnchor = rootHashes.get("root-prompt");
      if (rootAnchor === undefined) throw new Error("historical root hash missing");
      const parentPin = {
        session: "root", anchor: rootAnchor, parentSeq: 2, parentHead: rootAnchor, copied: 2,
      };
      const parentConfigure = configureAction({
        id: "parent:configure", sessionId: "parent", parentId: null,
        operation: "fork", snapshot, forkedFrom: parentPin, at: 1,
      });
      const hashes = seedForkFile(parentPath, "parent", "root", [parentConfigure, parentPrompt, parentTail]);
      const anchor = hashes.get("parent-prompt");
      const head = hashes.get("parent-tail");
      if (anchor === undefined || head === undefined) throw new Error("historical fork hashes missing");
      const forkedFrom = { session: "parent", anchor, parentSeq: 2, parentHead: head, copied: 2 };
      const childConfigure = configureAction({
        id: "child:configure", sessionId: "child", parentId: null,
        operation: "fork", snapshot, forkedFrom, at: 4,
      });
      const copiedConfigure = configureAction({
        id: "copied:configure", sessionId: "child", parentId: "child:configure",
        operation: "fork", snapshot, forkedFrom: parentPin, at: 5,
      });
      seedForkFile(childPath, "child", "parent", [childConfigure, copiedConfigure]);
      const catalog = openCatalogStore(":memory:", { now: testNow });
      try {
        catalog.indexSession({ id: "root", parentId: null, role: "resident", createdAt: 1 });
        catalog.indexSession({ id: "parent", parentId: "root", role: "child", createdAt: 1 });
        catalog.indexSession({ id: "child", parentId: "parent", role: "child", createdAt: 4 });
        if (order[0] === "parent") {
          const root = openSessionStore(rootPath, { now: testNow });
          root.close();
        }
        for (const id of order) {
          const store = openSessionStore(id === "parent" ? parentPath : childPath, { now: testNow });
          store.close();
        }
        if (order[0] === "child") {
          const root = openSessionStore(rootPath, { now: testNow });
          root.close();
        }
        const parent = openSessionStore(parentPath, { now: testNow });
        const child = openSessionStore(childPath, { now: testNow });
        try {
          const childKernel = createSessionKernel(child, catalog);
          expect(forkAncestryOf(childKernel, "child")).toEqual({
            session: "parent", anchor: "parent-prompt", parentSeq: 2,
            parentHead: "parent-tail", copied: 2,
          });
          expect(child.actions.actionById("copied:configure")?.intent.value).toMatchObject({
            forkedFrom: { session: "root", anchor: "root-prompt", parentHead: "root-prompt" },
          });
          const parentKernel = createSessionKernel(parent, catalog);
          expect(forkAncestryOf(parentKernel, "parent")).toMatchObject({
            session: "root", anchor: "root-prompt", parentHead: "root-prompt",
          });
          const newChild = openSessionStore(join(directory, "new-child.sqlite"), { now: testNow });
          try {
            const forked = Result.getOrThrowWith(runLedgerSync(Effect.result(forkSession({
              parent: parentKernel, parentSchemaVersion: 3, openChild: () => newChild, catalog,
            }, {
              from: "parent", at: "parent-prompt", childId: "new-child",
              genesisActionId: "new-child:configure", now: 6,
            }))), (error) => error);
            expect(forked.forkedFrom).toMatchObject({ anchor: "parent-prompt", parentHead: "parent-tail" });
          } finally {
            newChild.close();
          }
        } finally {
          parent.close();
          child.close();
        }
        const reopened = openSessionStore(childPath, { now: testNow });
        try {
          expect(forkAncestryOf(createSessionKernel(reopened, catalog), "child")?.anchor).toBe("parent-prompt");
        } finally {
          reopened.close();
        }
      } finally {
        catalog.close();
      }
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
}
