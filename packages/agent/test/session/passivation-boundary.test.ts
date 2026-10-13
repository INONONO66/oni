/**
 * KeepAlive/passivation boundary against the REAL Session entity: a live detached turn holds the keep-alive
 * latch (observed through `onKeepAlive`) and releases it when the turn ends; an activation closing with
 * unconsumed input arms the reserved `resume` purpose (`<sessionId>:resume`, at = close + idleMs) and persists the
 * occurrence through the cluster's discard door so the NEXT runtime recovers the open turn; a close with nothing pending arms nothing.
 */
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { L0Observation } from "@openomni/protocol";
import { Effect } from "effect";
import { openCatalogStore } from "../../src/core/store/catalog";
import { openSessionStore } from "../../src/core/store/session-file";
import * as SessionHandleStore from "../../src/core/store/fence";
import {
  blockingRunner,
  boundedAwait,
  clusterMessages,
  clusterTempDir,
  completionSignal,
  readChain,
  resolvedRunner,
  runCluster,
  sendPrompt,
  sessionFileFor,
} from "../helpers/cluster-runtime";

const { dir, sessionsDir, catalogFile } = clusterTempDir("w52-passivation-");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sessionId = "passivation-resume";

/** Short-lived kernel over the on-disk session: post-close assertions. */
async function withKernel<A>(read: (kernel: SessionHandleStore.SessionKernel) => A): Promise<A> {
  const catalog = openCatalogStore(catalogFile, { now: () => Date.now() });
  const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), { now: () => Date.now() });
  try {
    return read(SessionHandleStore.createSessionKernel(store, catalog));
  } finally {
    store.close();
    catalog.close();
  }
}

test("passivation arms resume for unconsumed input; the resume wake continues the session", async () => {
  const keepAliveToggles: boolean[] = [];
  // Created before the runner is installed; fired from inside the runner when
  // p1's turn enters (the intent + delivery chain commit already happened).
  const turnEntered = completionSignal();
  const closedAround = Date.now();

  // ── Activation 1: p1's turn detaches and blocks; p2 arrives while the turn
  // is live, so the close leaves one pending row behind.
  await runCluster(
    {
      sessionsDir,
      catalogFile,
      detachTurns: true,
      // Short idle budget: the resume occurrence (DeliverAt = close + idleMs)
      // comes due quickly under the second runtime.
      idleMs: 1_000,
      runner: blockingRunner(() => turnEntered.fire()),
      onKeepAlive: (enabled) => keepAliveToggles.push(enabled),
    },
    Effect.gen(function* () {
      const first = yield* sendPrompt(sessionId, "p1", "start the long turn");
      expect(first.existed).toBe(false);
      yield* Effect.promise(() => boundedAwait("turn entered", turnEntered.done));
      const second = yield* sendPrompt(sessionId, "p2", "arrives during the live turn");
      expect(second.existed).toBe(false);
    }),
  );

  // The live turn held the latch; the close released it.
  expect(keepAliveToggles).toEqual([true, false]);

  // The close committed the resume arm and indexed it durably.
  const armed = await withKernel((kernel) => kernel.armedAlarms());
  const resume = armed.find((row) => row.alarmId === `${sessionId}:resume`);
  if (resume === undefined) throw new Error(`no resume arm in ${JSON.stringify(armed)}`);
  expect(resume.purpose).toBe("resume");
  // at = close instant + idleMs: strictly after the first send's instant.
  expect(resume.fireAt).toBeGreaterThan(closedAround);
  const armRows = readChain(sessionFileFor(sessionsDir, sessionId), sessionId).filter((row) =>
    row.id.startsWith(`${sessionId}:resume:arm:`),
  );
  expect(armRows).toHaveLength(1);

  // ── Activation 2: the closing activation already PERSISTED the resume
  // occurrence (discard door, DeliverAt = close + idleMs); the next runtime
  // delivers it with no new send, recovers p1's open turn and starts p2's.
  // Subscribed BEFORE the runtime starts: the injected store sink publishes
  // `ledger.action.committed` post-commit for every chain row, so the
  // delivered occurrence row fires the signal the moment it is committed.
  const deliveredId = `${resume.occurrenceId}:delivered`;
  const resumeDelivered = completionSignal();
  await runCluster(
    {
      sessionsDir,
      catalogFile,
      runner: resolvedRunner("resumed"),
      observationSink: {
        publish: (event, data) => {
          if (event.name !== L0Observation.ActionCommittedEvent.name) return;
          if (L0Observation.ActionCommitted.parse(data).id === deliveredId) resumeDelivered.fire();
        },
      },
    },
    Effect.promise(() => boundedAwait("resume occurrence delivered", resumeDelivered.done)),
  );

  const chain = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
  expect(chain.find((row) => row.id === deliveredId)?.kind).toBe("alarm");
  // p1's interrupted turn sealed and p2's follow-up turn ran to its result.
  expect(chain.some((row) => row.id === "p2:turn:result")).toBe(true);

  // The delivered wake retired the resume row from the durable index, and the
  // second close (empty backlog) armed nothing new.
  const after = await withKernel((kernel) => kernel.armedAlarms());
  expect(after.find((row) => row.alarmId === `${sessionId}:resume`)).toBeUndefined();
  const armRowsAfter = readChain(sessionFileFor(sessionsDir, sessionId), sessionId).filter((row) =>
    row.id.startsWith(`${sessionId}:resume:arm:`),
  );
  expect(armRowsAfter).toHaveLength(1);
});

/** A pending-backlog activation in its own throwaway world (fault-injection tests). */
async function closeWithPendingBacklog(
  world: ReturnType<typeof clusterTempDir>,
  sessionId: string,
  beforeClose: () => void,
): Promise<void> {
  const turnEntered = completionSignal();
  await runCluster(
    {
      sessionsDir: world.sessionsDir,
      catalogFile: world.catalogFile,
      detachTurns: true,
      idleMs: 1_000,
      runner: blockingRunner(() => turnEntered.fire()),
    },
    Effect.gen(function* () {
      yield* sendPrompt(sessionId, "p1", "start the long turn");
      yield* Effect.promise(() => boundedAwait("turn entered", turnEntered.done));
      yield* sendPrompt(sessionId, "p2", "arrives during the live turn");
      yield* Effect.sync(beforeClose);
    }),
  );
}

test("a refused resume-arm commit at passivation is a logged fact: the close completes, nothing is armed", async () => {
  const world = clusterTempDir("w52-passivation-arm-fault-");
  const sessionId = "passivation-arm-fault";
  try {
    // The injected fault: the session file itself refuses the resume arm row —
    // the commit (and its same-transaction armed_alarms upsert) rolls back.
    await closeWithPendingBacklog(world, sessionId, () => {
      const db = new Database(sessionFileFor(world.sessionsDir, sessionId));
      db.exec(
        "CREATE TRIGGER refuse_resume_arm BEFORE INSERT ON action WHEN NEW.id LIKE '%:resume:arm:%' BEGIN SELECT RAISE(ABORT, 'injected resume arm refusal'); END",
      );
      db.close();
    });
    // The close completed (no thrown finalizer) and left no resume state behind.
    const chain = readChain(sessionFileFor(world.sessionsDir, sessionId), sessionId);
    expect(chain.filter((row) => row.id.includes(":resume:arm:"))).toHaveLength(0);
    const catalog = openCatalogStore(world.catalogFile, { now: () => Date.now() });
    const store = openSessionStore(sessionFileFor(world.sessionsDir, sessionId), { now: () => Date.now() });
    try {
      const kernel = SessionHandleStore.createSessionKernel(store, catalog);
      expect(kernel.armedAlarms()).toEqual([]);
    } finally {
      store.close();
      catalog.close();
    }
  } finally {
    rmSync(world.dir, { recursive: true, force: true });
  }
});

test("a refused resume occurrence persist is a logged fact: the committed arm row still stands", async () => {
  const world = clusterTempDir("w52-passivation-send-fault-");
  const sessionId = "passivation-send-fault";
  try {
    // The injected fault: the cluster mailbox refuses the Alarm envelope —
    // the discard-door send fails AFTER the arm row committed durably.
    await closeWithPendingBacklog(world, sessionId, () => {
      const db = new Database(world.catalogFile);
      db.exec(
        "CREATE TRIGGER refuse_resume_send BEFORE INSERT ON cluster_messages WHEN NEW.tag = 'Alarm' BEGIN SELECT RAISE(ABORT, 'injected resume send refusal'); END",
      );
      db.close();
    });
    // The arm row and its durable index entry survived the failed send: the
    // boot sweep is the recovery of last resort for exactly this window.
    const chain = readChain(sessionFileFor(world.sessionsDir, sessionId), sessionId);
    expect(chain.filter((row) => row.id.startsWith(`${sessionId}:resume:arm:`))).toHaveLength(1);
    const catalog = openCatalogStore(world.catalogFile, { now: () => Date.now() });
    const store = openSessionStore(sessionFileFor(world.sessionsDir, sessionId), { now: () => Date.now() });
    try {
      const kernel = SessionHandleStore.createSessionKernel(store, catalog);
      expect(kernel.armedAlarms().map((row) => row.alarmId)).toEqual([`${sessionId}:resume`]);
    } finally {
      store.close();
      catalog.close();
    }
    // No Alarm envelope was persisted: the refused send left no mailbox row.
    expect(clusterMessages(world.catalogFile, "Session").filter((row) => row.tag === "Alarm")).toHaveLength(0);
  } finally {
    rmSync(world.dir, { recursive: true, force: true });
  }
});
