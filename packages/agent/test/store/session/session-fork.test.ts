import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Result } from "effect";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { PlainValueSchema, SessionGeneration, type LedgerAction } from "@openomni/protocol";
import { useMemoryStores, testNow } from "../helpers/storage";
import { CHILD, PARENT, forkFixture } from "../helpers/fork-fixture";
import * as SessionHandleStore from "../../../src/core/store/fence";
import { openSessionStore, readSessionFileSchemaVersion, SESSION_FILE_SCHEMA_VERSION, type SessionStore } from "../../../src/core/store/session-file";
import { receivedMessageAction } from "../../../src/core/commit";
import { forkSession, isForkBoundary } from "../../../src/core/fork";
import { createAssistantMessage } from "../../../src/core/message-factory";
import { foldSessionHistory } from "../../../src/inspect/history";
import { createCompactionPlan } from "../../../src/plugins/compaction/durable";
import { allowAllPolicy } from "../../helpers/compiled-policy";
import { testExecutor } from "../../helpers/executor";
import { messageSource } from "../../helpers/message-source";
import { sessionTree } from "../../helpers/session-tree";
import { runLedgerSync } from "../helpers/effect";

const stores = useMemoryStores();
let childStore: SessionStore | undefined;

beforeEach(() => {
  childStore = openSessionStore(":memory:", { now: testNow });
});

afterEach(() => {
  childStore?.close();
  childStore = undefined;
});

function child(): SessionStore {
  if (childStore === undefined) throw new Error("child store only exists inside a test");
  return childStore;
}

const fixture = forkFixture(stores, child);

/** The child genesis pin, parsed with the protocol's `ForkAncestry` schema. */
const ForkGenesisIntent = z.looseObject({
  operation: z.literal("fork"),
  forkedFrom: SessionGeneration.ForkAncestry,
});
const DeliveryIntent = z.looseObject({ deliveryId: z.string() });

describe("Session.fork", () => {
  test("forks at a turn terminal into an independently verifiable child chain", () => {
    const parent = fixture.buildParent();
    const receipt = fixture.forked(parent.hashOf("turn-1:terminal"));
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);

    // The child chain verifies on its own hashes, with its own head.
    const verdict = childKernel.verifyChain(CHILD);
    if (verdict.kind !== "intact") throw new Error("child chain not intact");
    expect(verdict.head).toBe(receipt.head);
    expect(verdict.head).not.toBe(parent.head);

    // Genesis pins the parent, the anchor, its ordinal and the parent head.
    const nodes = childKernel.historyPage(CHILD, { afterRevision: 0, limit: 50 }).actions;
    const genesis = nodes[0];
    if (genesis === undefined) throw new Error("child genesis missing");
    expect(genesis.kind).toBe("session.configure");
    expect(genesis.parentId).toBeNull();
    // Parsed through the protocol's fork pin schema — no type assertions.
    const intent = ForkGenesisIntent.parse(genesis.intent.value);
    expect(intent.operation).toBe("fork");
    expect(intent.forkedFrom).toEqual({
      session: PARENT,
      anchor: parent.hashOf("turn-1:terminal"),
      parentSeq: 4,
      parentHead: parent.head,
      copied: 4,
    });
    expect(receipt.forkedFrom).toEqual(intent.forkedFrom);

    // Copied rows: parent genesis + input + delivery + terminal; arm and msg-2 (post-anchor) absent.
    expect(nodes.map((node) => node.id)).toEqual([
      `${CHILD}:genesis`,
      `${PARENT}:configure`,
      `fork:${PARENT}:msg-1`,
      `fork:${PARENT}:msg-1:delivery`,
      "turn-1:terminal",
    ]);

    // The delivery row moved into the fork namespace with the renamed input
    // (consumption re-mints `msg-1:delivery`, so the copy must free the slot),
    // and its references were remapped alongside.
    const delivery = nodes.find((node) => node.id === `fork:${PARENT}:msg-1:delivery`);
    expect(DeliveryIntent.parse(delivery?.intent.value).deliveryId).toBe(`fork:${PARENT}:msg-1`);
    // Consumption still folds: the copied, delivered input is not pending again.
    expect(childKernel.pendingMessages(CHILD)).toEqual([]);

    // The catalog projects the ancestry edge, stamped with the fork's `now`
    // (#1346 M4: the injected clock, never the catalog's own).
    expect(stores.catalog.sessionIndex(CHILD)).toMatchObject({ parentId: PARENT, createdAt: 100 });
    expect(stores.catalog.childSessionsPage(PARENT, "", 10).map((row) => row.id)).toEqual([CHILD]);

    // A later parent append is independent: the pinned child chain still verifies.
    fixture.commit(parent.authority, [
      receivedMessageAction({
        id: "msg-3",
        sessionId: PARENT,
        kind: "prompt",
        content: "post-fork",
        origin: { encodingVersion: 1, value: { source: "test" } },
        parentActionId: "msg-2",
        at: 6,
      }),
    ]);
    expect(childKernel.verifyChain(CHILD)).toEqual({ kind: "intact", head: receipt.head, length: 5 });
    expect(receipt.forkedFrom.parentHead).toBe(parent.head);
  });

  test("accepts prompt anchors; compaction hashes are boundaries by rule", () => {
    const parent = fixture.buildParent();
    // A prompt row (here the pending msg-2) is a legal boundary anchor.
    const receipt = fixture.forked(parent.hashOf("msg-2"));
    expect(receipt.forkedFrom.anchor).toBe(parent.hashOf("msg-2"));
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);
    const verdict = childKernel.verifyChain(CHILD);
    expect(verdict.kind).toBe("intact");
    // The arm between terminal and msg-2 is still excluded from the copy.
    const nodes = childKernel.historyPage(CHILD, { afterRevision: 0, limit: 50 }).actions;
    expect(nodes.some((node) => node.kind === "alarm")).toBeFalse();
    // The boundary rule itself admits compaction rows (their writer is plugin-level).
    const compaction: LedgerAction.Node = {
      id: "cut", parentId: null, sessionId: PARENT, kind: "compaction",
      intent: { encodingVersion: 1, value: {} }, effect: { encodingVersion: 1, value: {} },
      irreversible: true, ts: 1, ordinal: 1, prevHash: "p", actionHash: "h",
    };
    expect(isForkBoundary(compaction)).toBeTrue();
    expect(isForkBoundary({ ...compaction, kind: "alarm" })).toBeFalse();
  });

  test("forks at a real compaction journal row written by the compaction writer", () => {
    const parent = fixture.buildParent();
    // The real compaction writer: the durable executor committing onto the
    // parent chain through the fixture's fenced kernel commit.
    let sequence = 0;
    const executor = testExecutor({
      policy: allowAllPolicy,
      retryAlarm: { arm: () => Effect.void, wait: () => Effect.void, settle: () => Effect.void },
      ledger: {
        commit: (action: LedgerAction.Append) =>
          Effect.sync(() => {
            const receipt = fixture.commit(parent.authority, [action]).receipts.at(-1);
            if (receipt === undefined) throw new Error("kernel commit returned no receipt");
            return receipt;
          }),
      },
      observations: { publish: () => undefined },
      identity: { sessionId: PARENT, role: "resident", parentActionId: "turn-1:terminal" },
      clock: () => 7,
      entropy: () => {
        sequence += 1;
        return `exec-${sequence}`;
      },
      random: () => 0,
    });
    runLedgerSync(
      Effect.gen(function* () {
        const answer = createAssistantMessage("compact summary", "", PARENT, messageSource);
        yield* executor.run(
          { kind: "message", op: "assistant", intent: { messageId: answer.info.id }, effect: {} },
          () => Effect.sync(() => PlainValueSchema.parse(answer)),
        );
        const prior = foldSessionHistory(PARENT, sessionTree(stores.kernel, PARENT));
        const plan = createCompactionPlan(prior, [answer], 100);
        yield* executor.run(
          {
            kind: "compaction",
            op: "compact",
            intent: { trigger: "threshold" },
            effect: {},
            revertData: () => PlainValueSchema.parse(plan.record.revert),
          },
          () =>
            Effect.sync(() => PlainValueSchema.parse({ ...plan.record, projection: plan.projection })),
        );
      }),
    );
    // The executed compaction result row is a boundary anchor by rule.
    const compactionRow = sessionTree(stores.kernel, PARENT).find((node) => {
      const effect = node.effect.value;
      return node.kind === "compaction" && effect !== null && typeof effect === "object" &&
        !Array.isArray(effect) && effect.terminal === "executed";
    });
    if (compactionRow === undefined) throw new Error("no executed compaction row on the parent chain");
    expect(isForkBoundary(compactionRow)).toBeTrue();

    const receipt = fixture.forked(compactionRow.actionHash);
    expect(receipt.forkedFrom.anchor).toBe(compactionRow.actionHash);
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);
    const verdict = childKernel.verifyChain(CHILD);
    if (verdict.kind !== "intact") throw new Error("child chain not intact");
    expect(verdict.head).toBe(receipt.head);
    // The anchor compaction row itself was copied and closes the child chain.
    const nodes = childKernel.historyPage(CHILD, { afterRevision: 0, limit: 50 }).actions;
    expect(nodes.at(-1)?.id).toBe(compactionRow.id);
    expect(nodes.filter((node) => node.kind === "compaction").length).toBeGreaterThanOrEqual(2);
    expect(nodes.some((node) => node.kind === "alarm")).toBeFalse();
  });

  test("refuses a mid-turn anchor and an unknown anchor", () => {
    const parent = fixture.buildParent();
    const armHash = parent.hashOf("alarm-1:arm:1");
    expect(fixture.refusalOf(fixture.fork(armHash)).reason).toBe("anchor_not_boundary");
    expect(fixture.refusalOf(fixture.fork("no-such-hash")).reason).toBe("anchor_not_found");
  });

  test("the copy cap is generation configuration: a pinned 16-byte cap refuses, the default accepts", () => {
    const parent = fixture.buildParent();
    const anchor = parent.hashOf("turn-1:terminal");
    // Under the default generation (no pinned cap) the same fork is accepted.
    expect(fixture.forked(anchor).childId).toBe(CHILD);
    // Pin a 16-byte cap on the parent generation: a real configure row, the
    // same way the composition root's resolved startup value arrives.
    fixture.pinForkCap(parent.authority, 16);
    const overCap = fixture.refusalOf(fixture.fork(anchor, {}, { childId: "child-capped" }));
    expect(overCap.reason).toBe("byte_cap");
    // The surfaced Error message carries the typed reason and the parent id as tokens.
    expect(overCap.message).toContain("byte_cap");
    expect(overCap.message).toContain(PARENT);
  });

  test("refuses a fork when the parent session row is missing", () => {
    const result = runLedgerSync(
      Effect.result(
        forkSession(fixture.ports(), {
          from: "ghost",
          at: "irrelevant",
          childId: CHILD,
          genesisActionId: `${CHILD}:genesis`,
          now: 100,
        }),
      ),
    );
    const refusal = fixture.refusalOf(result);
    expect(refusal.reason).toBe("parent_not_found");
    expect(refusal.sessionId).toBe("ghost");
    // Refused before any child write or catalog index row.
    expect(child().sessions.get(CHILD)).toBeUndefined();
    expect(stores.catalog.sessionIndex(CHILD)).toBeUndefined();
  });

  test("finds a boundary anchor beyond the first 256-row history page", () => {
    const parent = fixture.buildParent();
    // 260 chained prompt rows push the anchor past the 256-row page the
    // prefix reader walks, forcing it onto the second page.
    const extras: LedgerAction.Append[] = [];
    let previous = "msg-2";
    for (let i = 0; i < 260; i += 1) {
      const id = `bulk-${i}`;
      extras.push(
        receivedMessageAction({
          id,
          sessionId: PARENT,
          kind: "prompt",
          content: `bulk ${i}`,
          origin: { encodingVersion: 1, value: { source: "test" } },
          parentActionId: previous,
          at: 10 + i,
        }),
      );
      previous = id;
    }
    fixture.commit(parent.authority, extras);
    const verdict = stores.kernel.verifyChain(PARENT);
    if (verdict.kind !== "intact" || verdict.head === null)
      throw new Error("parent chain not intact after bulk append");

    // The chain head is the last bulk prompt: a legal boundary on page two.
    const receipt = fixture.forked(verdict.head);
    expect(receipt.forkedFrom.anchor).toBe(verdict.head);
    // 266 parent rows minus the excluded arm row were copied.
    expect(receipt.forkedFrom.copied).toBe(265);
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);
    expect(childKernel.verifyChain(CHILD)).toEqual({
      kind: "intact",
      head: receipt.head,
      length: 266,
    });
  });

  test("refuses a real old-schemaVersion parent file and leaves its bytes identical", () => {
    const parent = fixture.buildParent();
    // A REAL legacy fixture file on disk: tables and rows, but no
    // schemaVersion marker (user_version 0, not SESSION_FILE_SCHEMA_VERSION).
    const directory = mkdtempSync(join(tmpdir(), "fork-legacy-"));
    try {
      const legacyPath = join(directory, "legacy-parent.sqlite");
      const legacy = new Database(legacyPath);
      legacy.run("CREATE TABLE legacy_actions (id TEXT PRIMARY KEY, payload TEXT)");
      legacy.run("INSERT INTO legacy_actions VALUES ('a-1', 'old-world row')");
      legacy.close();
      const sha256 = () => createHash("sha256").update(readFileSync(legacyPath)).digest("hex");
      const before = sha256();

      // The probe is read-only and sees an old version; the fork refuses on it.
      const probed = readSessionFileSchemaVersion(legacyPath);
      expect(probed).not.toBe(SESSION_FILE_SCHEMA_VERSION);
      const refusal = fixture.refusalOf(
        fixture.fork(parent.hashOf("turn-1:terminal"), { parentSchemaVersion: probed }),
      );
      expect(refusal.reason).toBe("schema_version");

      // Zero writes on the legacy file: byte identity, no stamp, no WAL/SHM.
      expect(sha256()).toBe(before);
      expect(readSessionFileSchemaVersion(legacyPath)).toBe(probed);
      expect(existsSync(`${legacyPath}-wal`)).toBeFalse();
      expect(existsSync(`${legacyPath}-shm`)).toBeFalse();
      // And no child was materialized anywhere.
      expect(child().sessions.get(CHILD)).toBeUndefined();
      expect(stores.catalog.sessionIndex(CHILD)).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("#1347 a real version-1 parent file upgrades to v2 before the fork's read-only probe", () => {
    const parent = fixture.buildParent();
    const directory = mkdtempSync(join(tmpdir(), "fork-v1-"));
    try {
      // A REAL v1 session file: this build's DDL minus `strikes`, stamped 1,
      // with one armed occurrence waiting in the index.
      const v1Path = join(directory, "v1-parent.sqlite");
      const v1 = new Database(v1Path);
      v1.run("CREATE TABLE armed_alarms (alarm_id TEXT PRIMARY KEY, occurrence_id TEXT NOT NULL UNIQUE, fire_at INTEGER NOT NULL)");
      v1.run("INSERT INTO armed_alarms VALUES ('alarm-1', 'occ-1', 500)");
      v1.run("PRAGMA user_version = 1");
      v1.close();
      const rawUserVersion = () => {
        const raw = new Database(v1Path, { readonly: true });
        try {
          return z.object({ user_version: z.number() }).parse(raw.query("PRAGMA user_version").get()).user_version;
        } finally {
          raw.close();
        }
      };
      expect(rawUserVersion()).toBe(1);

      // The probe the fork executor calls upgrades a stamped older file through
      // the guarded path (column added inside the stamping transaction), then
      // reports the current marker, so the fork admits the parent.
      const probed = readSessionFileSchemaVersion(v1Path);
      expect(probed).toBe(SESSION_FILE_SCHEMA_VERSION);
      expect(rawUserVersion()).toBe(2);
      const upgraded = new Database(v1Path, { readonly: true });
      const Column = z.object({ name: z.string() });
      expect(Column.array().parse(upgraded.query("PRAGMA table_info(armed_alarms)").all()).map((c) => c.name)).toEqual(["alarm_id", "occurrence_id", "fire_at", "strikes"]);
      expect(upgraded.query("SELECT strikes FROM armed_alarms WHERE occurrence_id = 'occ-1'").get()).toEqual({ strikes: 0 });
      upgraded.close();
      expect(Result.getOrThrowWith(fixture.fork(parent.hashOf("turn-1:terminal"), { parentSchemaVersion: probed }), (error) => error).forkedFrom.copied).toBe(4);

      // Idempotent: a second probe is a pure read-only read of the stamp.
      const sha256 = () => createHash("sha256").update(readFileSync(v1Path)).digest("hex");
      const settled = sha256();
      expect(readSessionFileSchemaVersion(v1Path)).toBe(SESSION_FILE_SCHEMA_VERSION);
      expect(sha256()).toBe(settled);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("#1347 a newer-version session file opens read-only and is never downgraded", () => {
    const directory = mkdtempSync(join(tmpdir(), "fork-newer-"));
    try {
      const newerPath = join(directory, "newer.sqlite");
      const newer = new Database(newerPath);
      newer.run("CREATE TABLE future_rows (id TEXT PRIMARY KEY)");
      newer.run(`PRAGMA user_version = ${SESSION_FILE_SCHEMA_VERSION + 1}`);
      newer.close();
      const sha256 = () => createHash("sha256").update(readFileSync(newerPath)).digest("hex");
      const before = sha256();

      // Neither the upgrade helper nor a full open touches a newer file; the
      // open yields a query-only store (no DDL, no stamp) and the fork refuses.
      expect(readSessionFileSchemaVersion(newerPath)).toBe(SESSION_FILE_SCHEMA_VERSION + 1);
      const store = openSessionStore(newerPath, { now: testNow });
      expect(store.armedCount).toThrow(/no such table: armed_alarms/);
      store.close();
      expect(readSessionFileSchemaVersion(newerPath)).toBe(SESSION_FILE_SCHEMA_VERSION + 1);
      expect(sha256()).toBe(before);
      const parent = fixture.buildParent();
      expect(fixture.refusalOf(fixture.fork(parent.hashOf("turn-1:terminal"), { parentSchemaVersion: SESSION_FILE_SCHEMA_VERSION + 1 })).reason).toBe("schema_version");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses an existing child id and leaves the first chain intact", () => {
    const parent = fixture.buildParent();
    const anchor = parent.hashOf("turn-1:terminal");
    const first = fixture.forked(anchor);
    expect(fixture.refusalOf(fixture.fork(anchor)).reason).toBe("child_exists");
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);
    expect(childKernel.verifyChain(CHILD)).toEqual({ kind: "intact", head: first.head, length: 5 });
  });
});
