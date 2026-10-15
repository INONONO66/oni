// W5.1 check1 as a package test (plan §4): the real Session entity boots on a
// SingleRunner with sql storage, prompts append to OUR hash chain in
// per-session files, and the cluster catalog holds the 5 cluster_* tables.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { L0Write } from "../../src/core/store/session-file";
import { Effect } from "effect";
import { clusterTempDir, clusterMessages, readChain, runCluster, sendPrompt, sessionFileFor, verifyChain, } from "../helpers/cluster-runtime";

const { dir, sessionsDir, catalogFile } = clusterTempDir("w52-entity-boot-");
const options = { sessionsDir, catalogFile };

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("boot creates exactly the 5 cluster_* tables in the catalog", async () => {
  await runCluster(options, Effect.void);
  const db = new Database(catalogFile, { readonly: true });
  try {
    const names = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cluster_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(names).toEqual([
      "cluster_locks",
      "cluster_messages",
      "cluster_migrations",
      "cluster_replies",
      "cluster_runners",
    ]);
  } finally {
    db.close();
  }
});

test("prompts reply with chain receipts; the chain links from genesis and the envelope is processed", async () => {
  const [first, second] = await runCluster(
    options,
    Effect.gen(function* () {
      // Ack evidence: sql storage sets the processed flag in the transaction
      // that saves the reply, before the reply reaches this caller.
      const processed = () => clusterMessages(catalogFile, "Session").map((row) => row.processed);
      const a = yield* sendPrompt("s1", "boot-m1", "hello");
      expect(processed()).toEqual([1]);
      const b = yield* sendPrompt("s1", "boot-m2", "hello again");
      expect(processed()).toEqual([1, 1]);
      return [a, b] as const;
    }),
  );

  expect(first.seq).toBeGreaterThanOrEqual(1);
  expect(first.existed).toBe(false);
  expect(second.seq).toBeGreaterThan(first.seq);
  expect(second.existed).toBe(false);

  const file = sessionFileFor(sessionsDir, "s1");
  const chain = readChain(file, "s1");
  expect(chain[0]?.prev_hash).toBe(L0Write.GENESIS_PREV_HASH);
  // Idempotency keys (plan D3): one chain action per messageId, hash-linked.
  const m1 = chain.filter((row) => row.id === "boot-m1");
  const m2 = chain.filter((row) => row.id === "boot-m2");
  expect(m1).toHaveLength(1);
  expect(m2).toHaveLength(1);
  expect(m1[0]?.ordinal).toBe(first.seq);
  expect(m2[0]?.ordinal).toBe(second.seq);
  expect(m1[0]?.action_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(m2[0]?.action_hash).toMatch(/^[0-9a-f]{64}$/);
  // Every hash recomputes and every prev_hash links (verifyChain throws else).
  expect(verifyChain(file, "s1")).toBe(chain.length);
});

test("each session gets its own ledger file", async () => {
  const reply = await runCluster(options, sendPrompt("s2", "boot-s2-m1", "own file"));
  expect(reply.existed).toBe(false);

  const s1 = sessionFileFor(sessionsDir, "s1");
  const s2 = sessionFileFor(sessionsDir, "s2");
  expect(s2).not.toBe(s1);
  expect(existsSync(s1)).toBe(true);
  expect(existsSync(s2)).toBe(true);
  const chain = readChain(s2, "s2");
  expect(chain[0]?.prev_hash).toBe(L0Write.GENESIS_PREV_HASH);
  expect(chain.some((row) => row.id === "boot-s2-m1")).toBe(true);
});
