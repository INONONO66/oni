import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { LedgerAction } from "@openomni/protocol";
import { SchemaRefused } from "../src/core/store/errors";
import { runLedgerSync } from "./store/helpers/effect";
import { adoptWriter, materializeSession } from "./store/helpers/session";
import { withDiskStores } from "./store/helpers/storage";

/**
 * Fail-closed writes: the production commit path (kernel.commit →
 * commitSession → appendAction) validates every row body against its kind's
 * declared schema and refuses the whole commit on mismatch — the journal is
 * byte-identical afterwards (exact row count and hash head).
 */

function journalState(path: string): { count: number; head: string | null } {
  const db = new Database(path, { readonly: true });
  try {
    const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM action").get()?.n ?? 0;
    const head =
      db
        .query<{ action_hash: string }, []>(
          "SELECT action_hash FROM action ORDER BY ordinal DESC LIMIT 1",
        )
        .get()?.action_hash ?? null;
    return { count, head };
  } finally {
    db.close();
  }
}

test("a schema-mismatching row refuses the whole production commit and leaves the journal unchanged", () => {
  withDiskStores("journal-fail-closed", ({ kernel, path }) => {
    materializeSession(kernel, "s1");
    const writer = adoptWriter(kernel, "s1", "owner-1");
    const commitOne = (action: LedgerAction.Append) =>
      kernel.commit({
        ...writer,
        now: action.ts,
        expectedRevision: kernel.row("s1").revision,
        state: "idle",
        actions: [action],
      });
    const badRows: readonly LedgerAction.Append[] = [
      {
        id: "s1:bad-request",
        parentId: "s1:configure",
        sessionId: "s1",
        kind: "request",
        intent: { encodingVersion: 1, value: { inputId: "i1" } },
        effect: { encodingVersion: 1, value: { phase: "replied" } },
        irreversible: true,
        ts: 2,
      },
      {
        id: "s1:bad-prompt",
        parentId: "s1:configure",
        sessionId: "s1",
        kind: "prompt",
        intent: { encodingVersion: 1, value: { deliveryId: "i2", delivery: "immediately" } },
        effect: { encodingVersion: 1, value: { deliveryKind: "prompt", content: "x" } },
        irreversible: true,
        ts: 3,
      },
    ];
    const before = journalState(path);
    expect(before.count).toBe(1); // the genesis configure row only
    for (const bad of badRows) {
      const error = runLedgerSync(commitOne(bad).pipe(Effect.flip));
      expect(error).toBeInstanceOf(SchemaRefused);
      if (error instanceof SchemaRefused) {
        expect(error.kind).toBe(bad.kind);
        expect(error.actionId).toBe(bad.id);
      }
    }
    // Nothing partial landed: exact row count and hash head are unchanged.
    expect(journalState(path)).toEqual(before);
    // The same commit path still accepts a conforming row.
    runLedgerSync(
      commitOne({
        id: "s1:good-prompt",
        parentId: "s1:configure",
        sessionId: "s1",
        kind: "prompt",
        intent: { encodingVersion: 1, value: { deliveryId: "i3", delivery: "followUp" } },
        effect: { encodingVersion: 1, value: { deliveryKind: "prompt", content: "ok" } },
        irreversible: true,
        ts: 4,
      }),
    );
    const after = journalState(path);
    expect(after.count).toBe(2);
    expect(after.head).not.toBe(before.head);
  });
});
