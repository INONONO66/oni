// Review F3 + R1 as a package test (plan §4): entityMaxIdleTime passivates the
// entity (activation finalizer closes the session file), the next message
// reactivates it (fence rotates, F5), and a DeliverAt scheduled beyond the
// idle window is not stranded — its delivery reactivates the entity.
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Effect, Fiber } from "effect";
import {
  boundedAwait,
  clusterTempDir,
  completionSignal,
  persistDeadline,
  runCluster,
  sendDeadline,
  sendPrompt,
  sessionFence,
  type TestClusterOptions,
} from "../helpers/cluster-runtime";
import { advancingClock } from "../helpers/time";

const { dir, sessionsDir, catalogFile } = clusterTempDir("w52-entity-passivation-");
/** effect/cluster's entityReaper sweeps no faster than every 5s, whatever idleMs is. */
const REAPER_FLOOR_MS = 5000;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * One cluster on an advancing clock whose `closed` signal fires when the
 * passivation finalizer closes `sessionId`'s store — the witness is the
 * close call itself, subscribed before the reaper is moved.
 */
function passivatingCluster(sessionId: string) {
  const time = advancingClock();
  const closed = completionSignal();
  const options: TestClusterOptions = {
    sessionsDir,
    catalogFile,
    idleMs: 500,
    clock: time.now,
    effectClock: time.clock,
    wrapStore: (id, store) => {
      if (id !== sessionId) return store;
      const close = store.close.bind(store);
      Object.defineProperty(store, "close", {
        value: () => {
          close();
          closed.fire();
        },
      });
      return store;
    },
  };
  const passivate = Effect.promise(() => {
    time.advance(REAPER_FLOOR_MS);
    return boundedAwait("session store closed by the passivation finalizer", closed.done);
  });
  return { time, options, passivate };
}

test("F3: idle passivation closes the session file; the next message reactivates and rotates the fence", async () => {
  const sessionId = "s-idle";
  const { options, passivate } = passivatingCluster(sessionId);
  const [fenceAfterFirst, fenceAfterSecond] = await runCluster(
    options,
    Effect.gen(function* () {
      yield* sendPrompt(sessionId, "idle-m1", "activate");
      const first = sessionFence(catalogFile, sessionId);
      yield* passivate;
      // Reactivation: the next message wakes the entity; activation rotates
      // the catalog fence (F5), proving a fresh activation served it.
      yield* sendPrompt(sessionId, "idle-m2", "wake up");
      return [first, sessionFence(catalogFile, sessionId)] as const;
    }),
  );
  expect(fenceAfterFirst).toBeGreaterThanOrEqual(1);
  expect(fenceAfterSecond).toBe((fenceAfterFirst ?? 0) + 1);
}, 60_000);

test("R1: a DeliverAt beyond the idle window survives passivation and reactivates the entity", async () => {
  const sessionId = "s-timer";
  const { time, options, passivate } = passivatingCluster(sessionId);
  const residual = await runCluster(
    options,
    Effect.gen(function* () {
      yield* sendPrompt(sessionId, "timer-m1", "activate");
      const fenceBefore = sessionFence(catalogFile, sessionId);
      const tSend = time.now();
      // The timer is durable 9s out — beyond the passivation instant — before
      // the reaper is moved, so passivation happens with it in flight.
      const deliverAt = tSend + 9000;
      yield* persistDeadline(sessionId, "timer-request", deliverAt);
      yield* passivate;
      // The same occurrence id joins the persisted envelope: its reply resolves
      // only after delivery reactivated the entity at the not-before instant.
      const pending = yield* Effect.forkScoped(sendDeadline(sessionId, "timer-request", deliverAt));
      time.advance(deliverAt - time.now());
      yield* Fiber.join(pending);
      const fenceAfter = sessionFence(catalogFile, sessionId);
      expect(fenceAfter).toBe((fenceBefore ?? 0) + 1);
      return time.now() - tSend;
    }),
  );
  expect(residual).toBeGreaterThanOrEqual(9000);
  expect(residual).toBeLessThan(20_000);
}, 60_000);
