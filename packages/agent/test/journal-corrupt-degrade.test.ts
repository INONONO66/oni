import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Journal, type BusEvent } from "@oni/protocol";
import { runLedgerSync } from "./store/helpers/effect";
import { adoptWriter, materializeSession } from "./store/helpers/session";
import { type LedgerStores, withDiskStores } from "./store/helpers/storage";

/**
 * One session file holding `s1:configure` + `s1:prompt`, with the stored bytes
 * of the prompt row then corrupted directly (bypassing the fail-closed write
 * CHECKs, as on-disk corruption would) so its decode must fail.
 */
function withCorruptedPrompt(
  corruptSql: string,
  body: (input: {
    session: LedgerStores["session"];
    path: string;
    corrupt: Journal.Corrupt[];
  }) => void,
): void {
  const corrupt: Journal.Corrupt[] = [];
  const sink = {
    publish<T>(event: BusEvent.Descriptor<T>, data: T) {
      if (event.name === "journal.corrupt") corrupt.push(Journal.Corrupt.parse(data));
    },
  };
  withDiskStores("journal-corrupt", ({ session, kernel, path }) => {
    const row = materializeSession(kernel, "s1");
    runLedgerSync(
      kernel.commit({
        ...adoptWriter(kernel, "s1", "owner-1"),
        now: 2,
        expectedRevision: row.revision,
        state: "idle",
        actions: [
          {
            id: "s1:prompt",
            parentId: "s1:configure",
            sessionId: "s1",
            kind: "prompt",
            intent: { encodingVersion: 1, value: { origin: "human" } },
            effect: { encodingVersion: 1, value: { deliveryKind: "prompt", content: "hello" } },
            irreversible: true,
            ts: 2,
          },
        ],
      }),
    );
    const raw = new Database(path);
    try {
      raw.run("PRAGMA ignore_check_constraints = ON");
      raw.run(corruptSql);
    } finally {
      raw.close();
    }
    body({ session, path, corrupt });
  }, { session: { observationSink: sink } });
}

/**
 * Read degradation: a journal row whose stored payload no longer decodes
 * is kept verbatim on disk, emits exactly one `journal.corrupt{seq, kind,
 * reason}` observation, and folds as opaque — one bad row never blocks
 * session load.
 */
test("a corrupt row degrades to opaque with one journal.corrupt observation and the session still loads", () => {
  withCorruptedPrompt("UPDATE action SET encoding_version = 99 WHERE id = 's1:prompt'", ({ session, path, corrupt }) => {
    const loaded = session.actions.range("s1", 0, 256);
    // Session load survives: the undecodable row stays verbatim on disk,
    // folds as opaque (skipped from the projection) and blocks nothing.
    expect(loaded.map((action) => action.id)).toEqual(["s1:configure"]);
    // Exactly one journal.corrupt observation names the row, and its reason is
    // the decoder's own schema diagnostic naming the rejected field — never a
    // fabricated "append refused" from the write path.
    expect(corrupt).toMatchObject([{ seq: 2, kind: "prompt" }]);
    expect(corrupt[0]?.reason).toContain('"encodingVersion"');
    expect(corrupt[0]?.reason).not.toContain("append refused");

    // Projection read ports degrade too: the corrupt prompt row is
    // the only pending message candidate, so the port answers the exact empty
    // page instead of throwing, with exactly one more journal.corrupt
    // carrying the same diagnostic.
    const foldReason = corrupt[0]?.reason;
    corrupt.length = 0;
    expect(session.actions.pendingMessages("s1")).toEqual([]);
    expect(corrupt).toMatchObject([{ seq: 2, kind: "prompt", reason: foldReason }]);
    // Verbatim on disk: the degraded read rewrote nothing.
    const after = new Database(path, { readonly: true });
    try {
      expect(
        after.query("SELECT intent, encoding_version FROM action WHERE id = 's1:prompt'").get(),
      ).toMatchObject({ encoding_version: 99 });
    } finally {
      after.close();
    }
  });
});

/**
 * Malformed payload bytes: the `journal.corrupt` reason carries the JSON parser's own diagnostic for the stored
 * text, rendered as `invalid JSON: <message>` with no fabricated row identity, and the row still folds as opaque
 * with its raw intent text carried as a string value. The `revert` column is the corruptible one here:
 * `intent`/`effect` sit under `json_extract` expression indexes that refuse malformed bytes.
 */
test("malformed JSON bytes report the parser diagnostic as the journal.corrupt reason", () => {
  const parserMessage = (() => {
    try {
      JSON.parse("{");
    } catch (cause) {
      if (cause instanceof SyntaxError) return cause.message;
    }
    throw new Error("JSON.parse('{') must throw a SyntaxError");
  })();

  withCorruptedPrompt("UPDATE action SET revert = '{' WHERE id = 's1:prompt'", ({ session, path, corrupt }) => {
    const loaded = session.actions.range("s1", 0, 256);
    expect(loaded.map((action) => action.id)).toEqual(["s1:configure", "s1:prompt"]);
    expect(loaded[1]?.intent.value).toBe('{"origin":"human"}');
    expect(corrupt).toEqual([{ seq: 2, kind: "prompt", reason: `invalid JSON: ${parserMessage}` }]);
    expect(corrupt[0]?.reason).not.toContain("append refused");
    // Verbatim on disk: the degraded read rewrote nothing.
    const after = new Database(path, { readonly: true });
    try {
      expect(after.query("SELECT revert FROM action WHERE id = 's1:prompt'").get()).toEqual({ revert: "{" });
    } finally {
      after.close();
    }
  });
});
/**
 * The single-row reads degrade the same way as range: a configure row whose
 * payload no longer decodes yields `undefined` plus exactly one
 * `journal.corrupt` observation for that row, never a throw.
 */
test("a corrupt configure row degrades a single-row read to undefined with one journal.corrupt observation", () => {
  withCorruptedPrompt("UPDATE action SET encoding_version = 99 WHERE id = 's1:configure'", ({ session, corrupt }) => {
    expect(session.actions.generationFor("s1", 1)).toBeUndefined();
    expect(corrupt).toMatchObject([{ kind: "session.configure" }]);
    expect(corrupt[0]?.reason).toContain('"encodingVersion"');
  });
});
