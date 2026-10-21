/**
 * Entity-crash child process (args: sessionsDir catalogFile sessionId crash|restart). `crash` boots the
 * runtime with a runner that reports entry then blocks forever, prints "APPENDED turn=<id>" and leaves the
 * envelope unacknowledged until the parent SIGKILLs it. `restart` boots on the SAME files with a completing
 * runner and prints REDELIVERED (chain dedupe), SHAPES (real turn kinds) and DELIVER_AT (recorded clocks, never wall time).
 */
import { L0Observation } from "@oni/protocol";
import { Clock, Effect } from "effect";
import {
  blockingRunner,
  boundedAwait,
  clusterMessages,
  completionSignal,
  readChain,
  resolvedRunner,
  runCluster,
  sendDeadline,
  sendPrompt,
  sessionFileFor,
  verifyChain,
  waitUntil,
} from "./cluster-runtime";

const CRASH_MESSAGE_ID = "crash-m1";

function usage(): never {
  console.error(
    "usage: bun test/helpers/cluster-crash-child.ts <sessionsDir> <catalogFile> <sessionId> crash|restart",
  );
  process.exit(2);
}

const [sessionsDir, catalogFile, sessionId, mode] = process.argv.slice(2);
if (
  sessionsDir === undefined ||
  catalogFile === undefined ||
  sessionId === undefined ||
  (mode !== "crash" && mode !== "restart")
) {
  usage();
}

const sessionFile = sessionFileFor(sessionsDir, sessionId);

if (mode === "crash") {
  // The deliver ack never arrives (the runner blocks forever); the process
  // stays alive inside runCluster until the parent SIGKILLs it.
  await runCluster(
    {
      sessionsDir,
      catalogFile,
      runner: blockingRunner((turnId) => {
        console.log(`APPENDED turn=${turnId} message=${CRASH_MESSAGE_ID}`);
      }),
    },
    Effect.gen(function* () {
      yield* Effect.forkScoped(sendPrompt(sessionId, CRASH_MESSAGE_ID, "crash me"));
      yield* Effect.never;
    }),
  );
} else {
  // Signals are created BEFORE the sink that fires them is installed and
  // resolved from the exact committed fact.
  const turnSealed = completionSignal();
  await runCluster(
    {
      sessionsDir,
      catalogFile,
      runner: resolvedRunner("recovered"),
      observationSink: {
        publish: (event, data) => {
          if (event.name !== L0Observation.ActionCommittedEvent.name) return;
          if (L0Observation.ActionCommitted.parse(data).kind === "turn") turnSealed.fire();
        },
      },
    },
    Effect.gen(function* () {
      // 1. The unacknowledged envelope from the crashed process is redelivered
      //    and processed on this runner (bounded DB-row wait, check2 pattern).
      yield* Effect.promise(() =>
        waitUntil(
          "crashed Session envelope processed after restart",
          () => clusterMessages(catalogFile, "Session").some((row) => row.processed === 1),
          30_000,
        ),
      );

      // 2. The chain deduped the replay: exactly one action for the messageId.
      const appended = readChain(sessionFile, sessionId).filter(
        (row) => row.id === CRASH_MESSAGE_ID,
      );
      const first = appended[0];
      if (appended.length !== 1 || first === undefined) {
        throw new Error(`expected one chain row for ${CRASH_MESSAGE_ID}, got ${appended.length}`);
      }
      console.log(
        `REDELIVERED count=${appended.length} ordinal=${first.ordinal} action_hash=${first.action_hash}`,
      );

      // 3. Real action shapes committed by the entity turn (F12 chain-level
      //    evidence) and the whole chain re-verifies hash-by-hash. The seal is
      //    awaited as the exact committed turn fact from the observation sink.
      yield* Effect.promise(() => boundedAwait("turn actions sealed on the chain", turnSealed.done, 30_000));
      const kinds = readChain(sessionFile, sessionId).map((row) => row.kind);
      console.log(`SHAPES count=${kinds.length} kinds=${kinds.join(",")}`);
      console.log(`CHAIN_OK ${verifyChain(sessionFile, sessionId)}`);

      // 4. DeliverAt: a deadline occurrence for an unknown request folds to a
      //    recorded stale alarm fact, but must not be handed to the
      //    entity before its not-before instant. The Alarm RPC replies only
      //    after the fold, so the recorded fact exists here; its commit clock
      //    time is the fired instant — no elapsed-time measurement.
      const armedAt = yield* Clock.currentTimeMillis;
      yield* sendDeadline(sessionId, "no-such-request", armedAt + 1500);
      const fact = readChain(sessionFile, sessionId).find(
        (row) => row.id === "no-such-request:deadline:stale",
      );
      if (fact === undefined) throw new Error("missing recorded stale alarm fact");
      console.log(`DELIVER_AT fired_at=${fact.ts} armed_at=${armedAt}`);
    }),
  );
  process.exit(0);
}
