import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Effect, Result } from "effect";
import {
  armedOccurrence,
  heldSends,
  noteArm as arm,
  quietCapability,
  resendSignal,
  sessionFixture,
} from "./helpers/alarm-recovery";
import { clusterTempDir, readChain, runCluster, sendAlarm, sendRescan, sessionFileFor } from "./helpers/cluster-runtime";

// #1477: a fire that produced nothing moves the SAME occurrence forward in the
// armed index and re-sends it keyed on the new time. No fired row, no re-arm
// row: an empty cadence tick costs the journal nothing, and the chain still
// settles exactly once when something finally happens.

const home = clusterTempDir("alarm-quiet-");
const { dir, sessionsDir, catalogFile } = home;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PAST_FIRE_AT = 1_000;
const QUIET_AT = 1_500;

const { readSession, withSession, firedRows } = sessionFixture(home);

/** Chain census: one arm row, `delivered` fired rows, nothing stale or exhausted. */
function expectOneArm(sessionId: string, occurrenceId: string, delivered: 0 | 1) {
  const chain = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
  expect(chain.filter((row) => row.id.includes(":arm:"))).toHaveLength(1);
  expect(chain.filter((row) => row.id === `${occurrenceId}:exhausted`)).toHaveLength(0);
  expect(firedRows(sessionId, occurrenceId)).toEqual({ delivered, stale: 0 });
}

async function armOne(sessionId: string, alarmId: string): Promise<{ occurrenceId: string; revision: number }> {
  let occurrenceId = "";
  let revision = 0;
  await withSession(sessionId, async ({ kernel, commit }) => {
    const armed = arm(sessionId, alarmId, 1, PAST_FIRE_AT);
    occurrenceId = armed.occurrenceId;
    expect(Result.isSuccess(await commit([armed.action]))).toBe(true);
    revision = kernel.row(sessionId).revision;
  });
  return { occurrenceId, revision };
}

describe("#1477 quiet re-arm", () => {
  test("a quiet wake moves the occurrence in the index with no journal row, and the next activation resends the moved time", async () => {
    const sessionId = "quiet-move";
    const { occurrenceId, revision } = await armOne(sessionId, "due-q");
    const occurrence = armedOccurrence(home, sessionId);

    // Phase 1 — the quiet fire: the re-send is held inside the process so the
    // durable state after passivation is exactly "moved, not yet re-fired".
    const capability = quietCapability(QUIET_AT);
    const held = heldSends();
    await runCluster(
      { sessionsDir, catalogFile, alarmCapability: capability, ...held.options },
      Effect.gen(function* () {
        const receipt = yield* sendAlarm(sessionId, occurrence);
        expect(receipt.outcome).toBe("delivered");
        expect(capability.seen()).toEqual([undefined]);
        yield* Effect.promise(() => held.ticked(occurrenceId));
      }),
    );
    // The activation walked the armed row first (the original key, which the
    // cluster folds into the in-flight delivery); the quiet re-send is the one
    // keyed on the moved time.
    const sent = held.sent().map((row) => [row.occurrenceId, row.tick, row.fireAt]);
    expect(sent.filter((row) => row[1] === undefined)).toEqual([[occurrenceId, undefined, PAST_FIRE_AT]]);
    expect(sent.filter((row) => row[1] !== undefined)).toEqual([[occurrenceId, QUIET_AT, PAST_FIRE_AT]]);
    expectOneArm(sessionId, occurrenceId, 0);
    await readSession(sessionId, ({ kernel, catalog }) => {
      // Index state only: the row moved, strikes reset, revision untouched.
      expect(kernel.armedAlarms().map((row) => [row.occurrenceId, row.fireAt, row.tick, row.strikes])).toEqual([
        [occurrenceId, QUIET_AT, QUIET_AT, 0],
      ]);
      expect(kernel.row(sessionId).revision).toBe(revision);
      expect(catalog.sessionIndex(sessionId)?.hasArmed).toBe(true);
    });

    // Phase 2 — boot: the activation resend carries the moved time, so the
    // cluster fires it again instead of folding it into the settled original.
    const next = quietCapability(QUIET_AT);
    const signal = resendSignal();
    const observed: (number | undefined)[] = [];
    await runCluster(
      {
        sessionsDir,
        catalogFile,
        alarmCapability: { purposes: next.purposes, wake: () => Effect.succeed("delivered" as const) },
        ...signal.options,
        wrapSendAlarm: (send) => (id, sent) =>
          Effect.sync(() => {
            observed.push(sent.tick);
          }).pipe(Effect.andThen(send(id, sent))),
      },
      Effect.gen(function* () {
        yield* sendRescan(sessionId, `${sessionId}:rescan:quiet-1`, PAST_FIRE_AT);
        yield* Effect.promise(() => signal.delivered(occurrenceId));
      }),
    );
    expect(observed).toEqual([QUIET_AT]);
    expect(firedRows(sessionId, occurrenceId)).toEqual({ delivered: 1, stale: 0 });
    await readSession(sessionId, ({ kernel, catalog }) => {
      expect(kernel.armedCount()).toBe(0);
      expect(catalog.sessionIndex(sessionId)?.hasArmed).toBe(false);
    });
  }, 30_000);

  test("the moved key is strictly forward; the settled original and a tick the index does not name fold with zero rows", async () => {
    const sessionId = "quiet-fold";
    const { occurrenceId } = await armOne(sessionId, "due-f");
    const occurrence = armedOccurrence(home, sessionId);
    // A quiet `at` not past the fire time would key the re-send on this very
    // delivery; the entity moves it one past instead.
    const capability = quietCapability(PAST_FIRE_AT);
    // The forked re-send fires at once (its time is past) and the second
    // attempt delivers: the receipt of the send keyed on the moved time is the
    // ordering signal (the activation resend of the original replies first).
    let settleTick: (() => void) | undefined;
    const moved = new Promise<void>((resolve) => {
      settleTick = resolve;
    });
    await runCluster(
      {
        sessionsDir,
        catalogFile,
        alarmCapability: capability,
        onAlarmResend: (_sessionId, sent, receipt) => {
          if (sent.tick === PAST_FIRE_AT + 1 && receipt.outcome === "delivered") settleTick?.();
        },
      },
      Effect.gen(function* () {
        const first = yield* sendAlarm(sessionId, occurrence);
        expect(first.outcome).toBe("delivered");
        yield* Effect.promise(() => moved);
        expect(capability.seen()).toEqual([undefined, PAST_FIRE_AT + 1]);
        // The original key folds at the cluster: settled receipt, no execution.
        const duplicate = yield* sendAlarm(sessionId, occurrence);
        expect(duplicate.outcome).toBe("delivered");
        // A tick the index no longer names is dropped without a stale row.
        const stale = yield* sendAlarm(sessionId, { ...occurrence, tick: PAST_FIRE_AT + 7 });
        expect(stale.outcome).toBe("stale");
        expect(capability.attempts()).toBe(2);
      }),
    );
    expectOneArm(sessionId, occurrenceId, 1);
    await readSession(sessionId, ({ kernel }) => {
      expect(kernel.armedCount()).toBe(0);
    });
  }, 30_000);
});
