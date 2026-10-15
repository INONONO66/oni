import { afterAll, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { CommitRefused, StorageUnavailable } from "../../src/core/store/errors";
import { openCatalogStore } from "../../src/core/store/catalog";
import * as SessionHandleStore from "../../src/core/store/fence";
import { Effect } from "effect";
import { materializeSession as materializeUnindexed, type SessionHandles, sessionHandles } from "../helpers/seeded-session";
import { clusterTempDir, readChain, runCluster, sendDeliver, sendPrompt, sendResolve, sessionFileFor, } from "../helpers/cluster-runtime";
import type { ResolveRefused } from "../../src/core/journal/messages";
import { runAgent } from "../helpers/executor";

const { dir, sessionsDir, catalogFile } = clusterTempDir("w52-session-entity-coverage-");
const options = { sessionsDir, catalogFile };

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Materialize one UNINDEXED session file; `prepare` runs over its open handles. */
async function materializeSession(
  sessionId: string,
  prepare?: (handles: SessionHandles) => Promise<void>,
): Promise<void> {
  await runAgent(
    Effect.scoped(
      Effect.gen(function* () {
        const handles = yield* sessionHandles(options, sessionId);
        yield* materializeUnindexed(handles, sessionId, 1, { index: false });
        if (prepare !== undefined) yield* Effect.promise(() => prepare(handles));
      }),
    ),
  );
}

test("an unindexed session file self-heals before mailbox admission", async () => {
  const sessionId = "self-heal";
  await materializeSession(sessionId);
  const before = openCatalogStore(catalogFile, { now: () => 1 });
  try {
    expect(before.sessionIndex(sessionId)).toBeUndefined();
  } finally {
    before.close();
  }

  const result = await runCluster(
    options,
    Effect.gen(function* () {
      const prompt = yield* sendPrompt(sessionId, "self-heal-prompt", "recover the catalog index");
      yield* sendDeliver(sessionId, {
        kind: "signal",
        idempotencyKey: "self-heal-interrupt",
        content: "consume while idle",
        control: "interrupt",
      });
      // A cancel against a missing request is a typed `unknown_request`
      // rejection with zero new facts, not a folded "rejected" resolution.
      const cancellation = yield* sendResolve(sessionId, {
        requestId: "missing-request",
        outcome: "cancelled",
        payload: JSON.stringify({
          kind: "owner",
          principalId: "owner",
          evidenceId: "self-heal-cancel",
        }),
        inputId: "self-heal-cancel",
      }).pipe(Effect.flip);
      return { prompt, cancellation };
    }),
  );

  expect(result.prompt.existed).toBe(false);
  expect((result.cancellation as ResolveRefused).code).toBe("unknown_request");
  expect(
    readChain(sessionFileFor(sessionsDir, sessionId), sessionId).some(
      (row) => row.id === "self-heal-interrupt:delivery",
    ),
  ).toBe(true);
  const healed = openCatalogStore(catalogFile, { now: () => 1 });
  try {
    expect(healed.sessionIndex(sessionId)).toMatchObject({ id: sessionId, parentId: null, role: "resident", fence: 1 });
  } finally {
    healed.close();
  }
});

test("a stale activation yields until a later fence can adopt the session", async () => {
  const sessionId = "stale-fence";
  await materializeSession(sessionId, async ({ catalog, kernel }) => {
    catalog.indexSession({
      id: sessionId,
      parentId: null,
      role: "resident",
      createdAt: 1,
    });
    await runAgent(
      kernel.adoptFence({
        sessionId,
        owner: "later-activation",
        fence: 2,
      }),
    );
  });

  const reply = await runCluster(
    options,
    sendPrompt(sessionId, "stale-prompt", "must not enter a stale activation"),
  );

  expect(reply.existed).toBe(false);
  const catalog = openCatalogStore(catalogFile, { now: () => 1 });
  try {
    expect(catalog.sessionIndex(sessionId)?.fence).toBe(3);
  } finally {
    catalog.close();
  }
});

test("a failed detached turn re-drains an acknowledged prompt", async () => {
  const sessionId = "failed-detached-turn";
  const entered = Promise.withResolvers<void>();
  const fail = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  let calls = 0;
  await runCluster(
    {
      ...options,
      detachTurns: true,
      runner: () =>
        Effect.gen(function* () {
          calls += 1;
          if (calls === 1) {
            entered.resolve();
            yield* Effect.promise(() => fail.promise);
            return yield* Effect.fail(new StorageUnavailable({ capability: "actions" }));
          }
          if (calls === 3) delivered.resolve();
          return { kind: "result" as const, text: "delivered" };
        }),
    },
    Effect.gen(function* () {
      yield* sendPrompt(sessionId, "failed-first", "first");
      yield* Effect.promise(() => entered.promise);
      yield* sendPrompt(sessionId, "failed-backlog", "second");
      fail.resolve();
      yield* Effect.promise(() => delivered.promise).pipe(Effect.timeout("10 seconds"));
    }),
  );
  const chain = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
  expect(chain.some((row) => row.id === "failed-backlog:delivery")).toBe(true);
  expect(calls).toBe(3);
}, 60_000);

test("a received prompt retries exactly one revision refusal", async () => {
  const sessionId = "received-revision-race";
  const create = SessionHandleStore.createSessionKernel;
  let commits = 0;
  const spy = spyOn(SessionHandleStore, "createSessionKernel").mockImplementation((store, catalog) => {
    const kernel = create(store, catalog);
    return new Proxy(kernel, {
      get(target, property, receiver) {
        if (property !== "commit") return Reflect.get(target, property, receiver);
        const commit: typeof kernel.commit = (input) => {
          if (input.actions[0]?.id !== "received-race") return target.commit(input);
          commits += 1;
          if (commits === 1) {
            const row = target.row(input.sessionId);
            return Effect.fail(new CommitRefused({
              sessionId: input.sessionId, reason: "revision",
              expectedRevision: input.expectedRevision, currentRevision: row.revision + 1,
              fence: input.fence, currentFence: row.fence,
            }));
          }
          return target.commit(input);
        };
        return commit;
      },
    });
  });
  try {
    const receipt = await runCluster(options, sendPrompt(sessionId, "received-race", "retry"));
    expect(receipt.existed).toBe(false);
    expect(commits).toBe(2);
    expect(readChain(sessionFileFor(sessionsDir, sessionId), sessionId).filter((row) => row.id === "received-race")).toHaveLength(1);
  } finally {
    spy.mockRestore();
  }
});
