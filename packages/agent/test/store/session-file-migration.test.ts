import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openSessionStore } from "../../src/core/store/session-file";
import { ActionSqlRow } from "../../src/core/store/storage/sqlite-l0-rows";
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
