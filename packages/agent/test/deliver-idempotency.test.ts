/**
 * `deliver` idempotency: the required caller key is the durable row id. A missing
 * key is a typed `missing_key` rejection; a replayed key with a matching payload
 * returns the original seq (`{seq, existed: true}`); a differing payload is the typed
 * `idempotency_conflict`; an unbound `inputRegistrations` port is `seam_missing`. None appends a fact.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Effect } from "effect";
import { L0Observation } from "@openomni/protocol";
import {
  boundedAwait,
  clusterTempDir,
  completionSignal,
  readChain,
  refusedDeliverAfterSeed,
  runCluster,
  sendDeliver,
  sendRead,
  sessionFileFor,
  type TestClusterOptions,
} from "./helpers/cluster-runtime";
import { receivedMessageAction } from "../src/core/journal/commit";
import { runAgent } from "./helpers/executor";
import { fencedSession } from "./helpers/seeded-session";
import type { DeliverRefused } from "../src/core/journal/messages";

const { dir, sessionsDir, catalogFile } = clusterTempDir("w52-deliver-idempotency-");
const options = { sessionsDir, catalogFile };

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a blank idempotency key is missing_key and appends nothing", async () => {
  const { refusal, seeded, after } = await refusedDeliverAfterSeed(options, "idem-missing-key", {
    kind: "prompt",
    idempotencyKey: "  ",
    content: "keyless",
  });
  expect((refusal as DeliverRefused).code).toBe("missing_key");
  expect(after).toBe(seeded);
});

test("a replayed key resolves to the original seq with zero new facts", async () => {
  const sessionId = "idem-replay";
  const { first, replay, divergent, between, after } = await runCluster(
    options,
    Effect.gen(function* () {
      const first = yield* sendDeliver(sessionId, {
        kind: "prompt",
        idempotencyKey: "p1",
        content: "original",
      });
      const between = readChain(sessionFileFor(sessionsDir, sessionId), sessionId).length;
      // Same key, same envelope shape: the cluster replays the recorded
      // response — the receipt is byte-identical to the first and nothing runs.
      const replay = yield* sendDeliver(sessionId, {
        kind: "prompt",
        idempotencyKey: "p1",
        content: "original",
      });
      // Divergent content under the same key still resolves to the original row.
      const divergent = yield* sendDeliver(sessionId, {
        kind: "prompt",
        idempotencyKey: "p1",
        content: "something else entirely",
      });
      const after = readChain(sessionFileFor(sessionsDir, sessionId), sessionId).length;
      return { first, replay, divergent, between, after };
    }),
  );
  expect(first.existed).toBe(false);
  expect(replay).toEqual(first);
  expect(divergent).toEqual(first);
  expect(after).toBe(between);
});

/**
 * Seed one prompt input row straight onto the chain: the handler-level dedup
 * (not the cluster envelope store) must resolve or refuse the replayed key.
 */
async function seedPromptRow(sessionId: string, key: string, content: string): Promise<void> {
  await runAgent(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* fencedSession(options, sessionId);
        yield* session.commit(
          [
            receivedMessageAction({
              id: key,
              sessionId,
              kind: "prompt",
              content,
              origin: {
                encodingVersion: 1,
                value: { kind: "message", messageId: key, senderSessionId: sessionId, sourceActionId: key },
              },
              parentActionId: null,
              at: 2,
            }),
          ],
          2,
        );
      }),
    ),
  );
}

test("a key already accepted on the journal returns {seq, existed: true} as success", async () => {
  const sessionId = "idem-journal-replay";
  await seedPromptRow(sessionId, "seeded-key", "seeded");
  const seeded = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
  const seq = seeded.find((chainRow) => chainRow.id === "seeded-key")?.ordinal;
  const receipt = await runCluster(
    options,
    sendDeliver(sessionId, { kind: "prompt", idempotencyKey: "seeded-key", content: "seeded" }),
  );
  expect(receipt).toEqual({ seq: seq as number, existed: true });
  // The activation drain runs the seeded prompt's turn; the replayed key
  // itself appends no new input row — exactly one "seeded-key" row exists.
  const chain = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
  expect(chain.filter((chainRow) => chainRow.id === "seeded-key")).toHaveLength(1);
  expect(
    chain.filter((chainRow) => chainRow.kind === "prompt" && !chainRow.id.endsWith(":delivery")),
  ).toHaveLength(1);
});

test("a replayed key with a different payload is idempotency_conflict and appends nothing", async () => {
  const sessionId = "idem-conflict";
  await seedPromptRow(sessionId, "conflict-key", "original");
  // Settle the seeded prompt's turn first (the activation drain runs it), so
  // the row count the refusal must leave unchanged is a quiescent chain.
  const turnSealed = completionSignal();
  const settleOptions: TestClusterOptions = {
    sessionsDir,
    catalogFile,
    observationSink: {
      publish: (event, data) => {
        if (event.name !== L0Observation.ActionCommittedEvent.name) return;
        if (L0Observation.ActionCommitted.parse(data).id.endsWith(":result")) turnSealed.fire();
      },
    },
  };
  await runCluster(
    settleOptions,
    Effect.gen(function* () {
      yield* sendRead(sessionId, { model: "history", cursor: 0 });
      yield* Effect.promise(() => boundedAwait("seeded turn sealed", turnSealed.done));
    }),
  );
  const before = readChain(sessionFileFor(sessionsDir, sessionId), sessionId).length;
  const refusal = await runCluster(
    options,
    sendDeliver(sessionId, {
      kind: "prompt",
      idempotencyKey: "conflict-key",
      content: "something else entirely",
    }).pipe(Effect.flip),
  );
  expect((refusal as DeliverRefused).code).toBe("idempotency_conflict");
  const chain = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
  expect(chain.length).toBe(before);
  expect(chain.filter((chainRow) => chainRow.id === "conflict-key")).toHaveLength(1);
});

test("an unbound inputRegistrations port is seam_missing and appends nothing", async () => {
  const sessionId = "idem-seam";
  const unbound = { sessionsDir, catalogFile, inputRegistrations: "unbound" as const };
  const first = await runCluster(
    unbound,
    sendDeliver(sessionId, { kind: "prompt", idempotencyKey: "s1", content: "x" }).pipe(
      Effect.flip,
    ),
  );
  expect((first as DeliverRefused).code).toBe("seam_missing");
  const afterFirst = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
  expect(afterFirst.some((chainRow) => chainRow.kind === "prompt")).toBe(false);
  const second = await runCluster(
    unbound,
    sendDeliver(sessionId, { kind: "prompt", idempotencyKey: "s2", content: "y" }).pipe(
      Effect.flip,
    ),
  );
  expect((second as DeliverRefused).code).toBe("seam_missing");
  expect(readChain(sessionFileFor(sessionsDir, sessionId), sessionId).length).toBe(
    afterFirst.length,
  );
});
