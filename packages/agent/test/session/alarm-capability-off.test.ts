/**
 * Capability-off conformance: with NO alarm capability composed, the two loop-owned purposes still work end to
 * end — a live `retry` occurrence delivers (drain wake) and a live `deadline` occurrence expires its open request
 * — and the whole flow is deterministic: two independently seeded worlds driven by the same injected clock
 * produce BYTE-EQUAL journals (every payload column identical).
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Alarm } from "@oni/protocol";
import { Effect } from "effect";
import {
  clusterTempDir,
  readChain,
  runCluster,
  sendAlarm,
  sessionFileFor,
  type ChainRow,
} from "../helpers/cluster-runtime";
import { runAgent } from "../helpers/executor";
import { openRequestDecision, pendingToolInvocation, retryAlarmEnvelope, retryAttemptChain } from "../helpers/seed-request";
import { fencedSession } from "../helpers/seeded-session";

const worlds = [clusterTempDir("w52-cap-off-a-"), clusterTempDir("w52-cap-off-b-")];

afterAll(() => {
  for (const world of worlds) rmSync(world.dir, { recursive: true, force: true });
});

const sessionId = "cap-off";
const requestId = "req-1";
// Already expired at the entity's injected now (5_000): the occurrence both
// delivers promptly (DeliverAt) and times the request out.
const SEED_DEADLINE = 2_000;
const ENTITY_NOW = 5_000;

/** Deterministic seed: materialize, retry arm, open request (deadline arm). */
function seedWorld(world: (typeof worlds)[number]): Effect.Effect<void> {
  return Effect.scoped(
    Effect.gen(function* () {
      const session = yield* fencedSession(world, sessionId, { commitNow: () => 100 });
      // The retried operation and its armed retry chain, then the pending invocation.
      yield* session.commit([
        ...retryAttemptChain(sessionId, `${sessionId}:materialize`),
        pendingToolInvocation(sessionId, requestId, 100),
      ]);
      const { actions } = openRequestDecision(session, requestId, {
        deadline: SEED_DEADLINE,
        createdAt: 1_000,
        at: 1_000,
      });
      yield* session.commit([...actions]);
    }),
  ).pipe(Effect.orDie);
}

/** Drive one world: retry fires, then the deadline expires the open request. */
function driveWorld(world: (typeof worlds)[number]): Promise<ChainRow[]> {
  return runCluster(
    { sessionsDir: world.sessionsDir, catalogFile: world.catalogFile, clock: () => ENTITY_NOW },
    Effect.gen(function* () {
      const retry = yield* sendAlarm(sessionId, retryAlarmEnvelope(sessionId, 100));
      expect(retry.outcome).toBe("delivered");
      const deadline = yield* sendAlarm(sessionId, {
        occurrenceId: Alarm.occurrenceId(sessionId, `${requestId}:deadline`, 1, "deadline"),
        purpose: "deadline",
        alarmId: `${requestId}:deadline`,
        armSeq: 1,
        sourceKey: "deadline",
        payload: JSON.stringify({ requestId }),
        // The occurrence id is the cluster dedupe key: this send attaches to
        // the activation-resent envelope (same identity, DeliverAt 2_000).
        fireAt: SEED_DEADLINE,
      });
      expect(deadline.outcome).toBe("delivered");
      return readChain(sessionFileFor(world.sessionsDir, sessionId), sessionId);
    }),
  );
}

test("retry + deadline fire with no capability composed; two worlds yield byte-equal journals", async () => {
  for (const world of worlds) await runAgent(seedWorld(world));
  const [chainA, chainB] = [await driveWorld(worlds[0] as (typeof worlds)[number]), await driveWorld(worlds[1] as (typeof worlds)[number])];

  // The loop-owned purposes ran without any capability: retry delivered and
  // the deadline timed the request out (terminal + chain retire + fired fact).
  const ids = chainA.map((row) => row.id);
  expect(ids).toContain(`${Alarm.occurrenceId(sessionId, "op:attempt:1:retry", 1, "retry")}:delivered`);
  expect(ids).toContain(`${requestId}:resolution`);
  expect(ids).toContain(`${requestId}:deadline:arm:2`);
  expect(ids).toContain(`${Alarm.occurrenceId(sessionId, `${requestId}:deadline`, 1, "deadline")}:delivered`);

  // Every stored row, including payload bytes, is identical across worlds.
  expect(chainA).toEqual(chainB);
});
