import { configureAction, generationSnapshot } from "../../../src/core/store/configure";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Result } from "effect";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { SessionGeneration, type LedgerAction } from "@oni/protocol";
import { testNow, withDiskStores } from "../helpers/storage";
import { adoptWriter, materializeSession } from "../helpers/session";
import { CHILD, PARENT, useForkFixture } from "../helpers/fork-fixture";
import { RETIRED_ROLE, rawCatalogRows, writeOldCatalog } from "../helpers/old-catalog";
import { openCatalogStore } from "../../../src/core/store/catalog";
import * as SessionHandleStore from "../../../src/core/store/fence";
import { openSessionStore, readSessionFileSchemaVersion, SESSION_FILE_SCHEMA_VERSION } from "../../../src/core/store/session-file";
import { receivedMessageAction } from "../../../src/core/journal/delivery";
import { forkAncestryOf } from "../../../src/inspect/tree";
import { forkSession, isForkBoundary } from "../../../src/core/session/fork";
import { allowAllPolicy } from "../../helpers/compiled-policy";
import { answerThenCompaction } from "../../helpers/durable-compaction";
import { testExecutor } from "../../helpers/executor";
import { sessionTree } from "../../helpers/session-tree";
import { runLedgerSync } from "../helpers/effect";
import { CatalogVersionRefused, SessionFileUnreadable } from "../../../src/core/store/errors";

const { stores, child, fixture } = useForkFixture();

/** The child genesis pin, parsed with the protocol's `ForkAncestry` schema. */
const ForkGenesisIntent = z.looseObject({
  operation: z.literal("fork"),
  forkedFrom: SessionGeneration.ForkAncestry,
});
const DeliveryIntent = z.looseObject({ deliveryId: z.string() });

describe("Session.fork", () => {
  test("reads a persisted child fork anchor after reopening its file", () => {
    withDiskStores("fork-reopen", ({ kernel, catalog, directory }) => {
      materializeSession(kernel, PARENT);
      const authority = adoptWriter(kernel, PARENT);
      const anchor = "parent-prompt";
      Result.getOrThrowWith(runLedgerSync(Effect.result(kernel.commit({
        sessionId: PARENT,
        owner: authority.owner,
        fence: authority.fence,
        now: 2,
        expectedRevision: kernel.row(PARENT).revision,
        actions: [receivedMessageAction({
          id: anchor,
          sessionId: PARENT,
          kind: "prompt",
          content: "fork here",
          origin: { encodingVersion: 1, value: { source: "test" } },
          parentActionId: `${PARENT}:configure`,
          at: 2,
        })],
        state: "idle",
      }))), (error) => error);
      const childPath = join(directory, "child.sqlite");
      const childStore = openSessionStore(childPath, { now: testNow });
      try {
        Result.getOrThrowWith(runLedgerSync(Effect.result(forkSession({
          parent: kernel,
          parentSchemaVersion: SESSION_FILE_SCHEMA_VERSION,
          openChild: () => childStore,
          catalog,
        }, {
          from: PARENT,
          at: anchor,
          childId: CHILD,
          genesisActionId: `${CHILD}:genesis`,
          now: 3,
        }))), (error) => error);
      } finally {
        childStore.close();
      }
      const reopened = openSessionStore(childPath, { now: testNow });
      try {
        expect(forkAncestryOf(SessionHandleStore.createSessionKernel(reopened, catalog), CHILD)?.anchor).toBe(anchor);
      } finally {
        reopened.close();
      }
    });
  });

  test("a locked schema file retains SQLite errno rather than appearing unstamped", () => {
    const directory = mkdtempSync(join(tmpdir(), "fork-locked-"));
    const path = join(directory, "locked.sqlite");
    const db = new Database(path);
    try {
      db.run("PRAGMA user_version = 2");
      expect(readSessionFileSchemaVersion(join(directory, "missing.sqlite"))).toBe(0);
      db.run("BEGIN EXCLUSIVE");
      let refusal: SessionFileUnreadable | undefined;
      try {
        readSessionFileSchemaVersion(path);
      } catch (error) {
        if (error instanceof SessionFileUnreadable) refusal = error;
        else throw error;
      }
      expect(refusal).toMatchObject({
        _tag: "SessionFileUnreadable",
        code: "SQLITE_BUSY",
        errno: 5,
        path,
      });
      console.log(`A7 locked schema before=0 after_errno=${refusal?.errno}`);
    } finally {
      db.run("ROLLBACK");
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("forks at a turn terminal into an independent child history", () => {
    const parent = fixture.buildParent();
    const receipt = fixture.forked("turn-1:terminal");
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);

    expect(childKernel.latestAction(CHILD)?.id).toBe(receipt.head);
    expect(receipt.head).not.toBe(parent.head);

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
      anchor: "turn-1:terminal",
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
    // (the injected clock, never the catalog's own).
    expect(stores.catalog.sessionIndex(CHILD)).toMatchObject({ parentId: PARENT, createdAt: 100 });
    expect(stores.catalog.childSessionsPage(PARENT, "", 10).map((row) => row.id)).toEqual([CHILD]);

    // A later parent append leaves every copied child row unchanged.
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
    expect(sessionTree(childKernel, CHILD)).toEqual(nodes);
    expect(receipt.forkedFrom.parentHead).toBe(parent.head);
  });

  test("accepts prompt anchors; compaction actions are boundaries by rule", () => {
    fixture.buildParent();
    // A prompt row (here the pending msg-2) is a legal boundary anchor.
    const receipt = fixture.forked("msg-2");
    expect(receipt.forkedFrom.anchor).toBe("msg-2");
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);
    // The arm between terminal and msg-2 is still excluded from the copy.
    const nodes = childKernel.historyPage(CHILD, { afterRevision: 0, limit: 50 }).actions;
    expect(nodes.some((node) => node.kind === "alarm")).toBeFalse();
    // The boundary rule itself admits compaction rows (their writer is plugin-level).
    const compaction: LedgerAction.Node = {
      id: "cut", parentId: null, sessionId: PARENT, kind: "compaction",
      intent: { encodingVersion: 1, value: {} }, effect: { encodingVersion: 1, value: {} },
      irreversible: true, ts: 1, ordinal: 1,
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
    runLedgerSync(answerThenCompaction(executor, stores.kernel, PARENT, "compact summary"));
    // The executed compaction result row is a boundary anchor by rule.
    const compactionRow = sessionTree(stores.kernel, PARENT).find((node) => {
      const effect = node.effect.value;
      return node.kind === "compaction" && effect !== null && typeof effect === "object" &&
        !Array.isArray(effect) && effect.terminal === "executed";
    });
    if (compactionRow === undefined) throw new Error("no executed compaction row on the parent chain");
    expect(isForkBoundary(compactionRow)).toBeTrue();

    const receipt = fixture.forked(compactionRow.id);
    expect(receipt.forkedFrom.anchor).toBe(compactionRow.id);
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);
    expect(childKernel.latestAction(CHILD)?.id).toBe(receipt.head);
    // The anchor compaction row itself was copied and closes the child chain.
    const nodes = childKernel.historyPage(CHILD, { afterRevision: 0, limit: 50 }).actions;
    expect(nodes.at(-1)?.id).toBe(compactionRow.id);
    expect(nodes.filter((node) => node.kind === "compaction").length).toBeGreaterThanOrEqual(2);
    expect(nodes.some((node) => node.kind === "alarm")).toBeFalse();
  });

  test("refuses a mid-turn anchor and an unknown anchor", () => {
    fixture.buildParent();
    const armId = "alarm-1:arm:1";
    expect(fixture.refusalOf(fixture.fork(armId)).reason).toBe("anchor_not_boundary");
    expect(fixture.refusalOf(fixture.fork("no-such-action")).reason).toBe("anchor_not_found");
  });

  test("the copy cap is generation configuration: a pinned 16-byte cap refuses, the default accepts", () => {
    const parent = fixture.buildParent();
    const anchor = "turn-1:terminal";
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
    // The last bulk prompt is a legal boundary on page two.
    const receipt = fixture.forked("bulk-259");
    expect(receipt.forkedFrom.anchor).toBe("bulk-259");
    // 266 parent rows minus the excluded arm row were copied.
    expect(receipt.forkedFrom.copied).toBe(265);
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);
    expect(sessionTree(childKernel, CHILD)).toHaveLength(266);
    expect(childKernel.latestAction(CHILD)?.id).toBe(receipt.head);
  });

  test("refuses an unstamped parent file and leaves its bytes identical", () => {
    fixture.buildParent();
    // A real file on disk: tables and rows, but no
    // schemaVersion marker (user_version 0, not SESSION_FILE_SCHEMA_VERSION).
    const directory = mkdtempSync(join(tmpdir(), "fork-unstamped-"));
    try {
      const parentPath = join(directory, "unstamped-parent.sqlite");
      const raw = new Database(parentPath);
      raw.run("CREATE TABLE previous_actions (id TEXT PRIMARY KEY, payload TEXT)");
      raw.run("INSERT INTO previous_actions VALUES ('a-1', 'old-world row')");
      raw.close();
      const sha256 = () => createHash("sha256").update(readFileSync(parentPath)).digest("hex");
      const before = sha256();

      // The probe is read-only and sees an old version; the fork refuses on it.
      const probed = readSessionFileSchemaVersion(parentPath);
      expect(probed).not.toBe(SESSION_FILE_SCHEMA_VERSION);
      const refusal = fixture.refusalOf(
        fixture.fork("turn-1:terminal", { parentSchemaVersion: probed }),
      );
      expect(refusal.reason).toBe("schema_version");

      // Zero writes on the file: byte identity, no stamp, no WAL/SHM.
      expect(sha256()).toBe(before);
      expect(readSessionFileSchemaVersion(parentPath)).toBe(probed);
      expect(existsSync(`${parentPath}-wal`)).toBeFalse();
      expect(existsSync(`${parentPath}-shm`)).toBeFalse();
      // And no child was materialized anywhere.
      expect(child().sessions.get(CHILD)).toBeUndefined();
      expect(stores.catalog.sessionIndex(CHILD)).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses a stamped parent file at another version before fork writes", () => {
    fixture.buildParent();
    const directory = mkdtempSync(join(tmpdir(), "fork-v2-"));
    try {
      const path = join(directory, "parent.sqlite");
      const raw = new Database(path);
      raw.run("PRAGMA user_version = 2");
      raw.close();
      const before = readFileSync(path);
      const probed = readSessionFileSchemaVersion(path);
      expect(probed).toBe(2);
      const refusal = fixture.refusalOf(fixture.fork("turn-1:terminal", { parentSchemaVersion: probed }));
      expect(refusal).toMatchObject({ _tag: "ForkRefused", reason: "schema_version" });
      expect(readFileSync(path)).toEqual(before);
      expect(child().sessions.get(CHILD)).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("#1347 a newer-version session file refuses to open, typed, and is never downgraded", () => {
    const directory = mkdtempSync(join(tmpdir(), "fork-newer-"));
    try {
      const newerPath = join(directory, "newer.sqlite");
      const newer = new Database(newerPath);
      newer.run("CREATE TABLE future_rows (id TEXT PRIMARY KEY)");
      newer.run(`PRAGMA user_version = ${SESSION_FILE_SCHEMA_VERSION + 1}`);
      newer.close();
      const sha256 = () => createHash("sha256").update(readFileSync(newerPath)).digest("hex");
      const before = sha256();

      // Neither the probe nor a full open touches a newer file: the open refuses
      // with the typed store error before any DDL, stamp or table read, returns
      // no store, and the fork refuses.
      expect(readSessionFileSchemaVersion(newerPath)).toBe(SESSION_FILE_SCHEMA_VERSION + 1);
      let refusal: CatalogVersionRefused | undefined;
      try {
        openSessionStore(newerPath, { now: testNow });
      } catch (error) {
        expect(error).toBeInstanceOf(CatalogVersionRefused);
        if (error instanceof CatalogVersionRefused) refusal = error;
      }
      expect(refusal).toBeInstanceOf(CatalogVersionRefused);
      expect(refusal).toMatchObject({
        _tag: "CatalogVersionRefused",
        fileVersion: SESSION_FILE_SCHEMA_VERSION + 1,
        codeVersion: SESSION_FILE_SCHEMA_VERSION,
        operation: "openSessionStore",
      });
      expect(readSessionFileSchemaVersion(newerPath)).toBe(SESSION_FILE_SCHEMA_VERSION + 1);
      expect(sha256()).toBe(before);
      fixture.buildParent();
      expect(fixture.refusalOf(fixture.fork("turn-1:terminal", { parentSchemaVersion: SESSION_FILE_SCHEMA_VERSION + 1 })).reason).toBe("schema_version");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("forks over a parent indexed under the retired role in an upgraded catalog (#1351)", () => {
    const parent = fixture.buildParent();
    const directory = mkdtempSync(join(tmpdir(), "fork-upgraded-"));
    try {
      const catalogPath = join(directory, "catalog.sqlite");
      writeOldCatalog(catalogPath, {
        version: 3,
        roles: ["resident", "child", RETIRED_ROLE],
        kinds: ["prompt", "ingress"],
        sessions: [
          ["root", null, "resident"],
          [PARENT, "root", RETIRED_ROLE],
        ],
        policies: [],
      });
      const upgraded = openCatalogStore(catalogPath, { now: testNow });
      try {
        expect(upgraded.sessionIndex(PARENT)).toMatchObject({ parentId: "root", role: "child" });
        const receipt = fixture.forked("turn-1:terminal", { catalog: upgraded });
        expect(receipt.parentId).toBe(PARENT);
        // The child's role comes from the parent's session-file row, not the
        // catalog; its index row lands under the rebuilt CHECK beside the rewritten parent.
        expect(receipt.row.role).toBe(stores.kernel.row(PARENT).role);
        expect(upgraded.sessionIndex(CHILD)).toMatchObject({ parentId: PARENT, role: receipt.row.role });
      } finally {
        upgraded.close();
      }
      expect(rawCatalogRows(catalogPath)).toMatchObject({
        version: { user_version: 5 },
        sessions: [
          { id: CHILD, parent_id: PARENT, role: "resident" },
          { id: PARENT, parent_id: "root", role: "child" },
          { id: "root", parent_id: null, role: "resident" },
        ],
      });
      // The parent chain is untouched by the catalog rewrite.
      expect(stores.kernel.latestAction(PARENT)?.id).toBe(parent.head);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses an existing child id and leaves the first child history unchanged", () => {
    fixture.buildParent();
    const anchor = "turn-1:terminal";
    fixture.forked(anchor);
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);
    const before = sessionTree(childKernel, CHILD);
    expect(fixture.refusalOf(fixture.fork(anchor)).reason).toBe("child_exists");
    expect(sessionTree(childKernel, CHILD)).toEqual(before);
  });
});

describe("Session.fork generation pin", () => {
  test("the child pins the newest configure at or before the anchor, not the parent's later one", () => {
    const parent = fixture.buildParent();
    const pinned = stores.kernel.latestGenerationFor(PARENT);
    const late = generationSnapshot({
      generation: pinned.generation + 1, revertTo: pinned.generation,
      tools: [{ name: "late_tool", inputSchema: {}, category: "query" }],
      system: { preset: "", blocks: [] }, policyGeneration: pinned.policyGeneration,
    });
    fixture.commit(parent.authority, [configureAction({
      id: `${PARENT}:configure-late`, sessionId: PARENT,
      parentId: stores.kernel.latestAction(PARENT)?.id ?? null, operation: "compose", snapshot: late, at: 14,
    })]);
    const receipt = fixture.forked("turn-1:terminal");
    const childGeneration = SessionHandleStore.createSessionKernel(child(), stores.catalog).latestGenerationFor(CHILD);
    console.info(`A6 fork pin rowToolsGeneration=${receipt.row.toolsGeneration} childGeneration=${childGeneration.generation} parentLatest=${late.generation}`);
    expect([pinned.generation, late.generation]).toEqual([1, 2]);
    expect(stores.kernel.latestGenerationFor(PARENT).tools.map((tool) => tool.name)).toEqual(["late_tool"]);
    expect(receipt.row.toolsGeneration).toBe(childGeneration.generation);
    expect(receipt.row.toolsGeneration).toBe(pinned.generation);
    expect(childGeneration.toolsHash).toBe(pinned.toolsHash);
    expect(childGeneration.tools.map((tool) => tool.name)).not.toContain("late_tool");
    expect(receipt.row.systemHash).toBe(pinned.systemHash);
    expect(childGeneration.generation).toBe(pinned.generation);
    expect(childGeneration.tools.map((tool) => tool.name)).toEqual(pinned.tools.map((tool) => tool.name));
  });
});
