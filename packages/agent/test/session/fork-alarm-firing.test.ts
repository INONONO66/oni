/**
 * #1257 r3 M-1 — fork alarm exclusion against the REAL entity plane: a parent
 * arms an alarm BEFORE the fork anchor, the fork copies the pre-anchor chain,
 * and then real activations deliver. The parent's occurrence fires exactly
 * once (a duplicate delivery of the settled occurrence folds to the recorded
 * `stale` fact), and the forked child registers and receives ZERO alarms —
 * its activation rescan finds an empty armed index and resends nothing.
 *
 * Determinism (#1254 pattern): the injected entity clock — not the wall clock
 * — supplies every instant; the arm's `fireAt` is already due, so the
 * DeliverAt door releases immediately; the only waits are the committed-fact
 * barriers (`onAlarmResend` fires AFTER the delivery's Alarm RPC replied, and
 * each explicit `sendAlarm` ack follows its committed fired fact).
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Effect } from "effect";
import { z } from "zod";
import { armAction, type AlarmCapability } from "../../src/core/alarm";
import { clusterTempDir, runCluster, sendAlarm, sendPrompt } from "../helpers/cluster-runtime";
import { runAgent } from "../helpers/executor";
import { boundaryTerminal, forkAtAction } from "../helpers/fork-seed";
import { fencedSession, withSessionHandles } from "../helpers/seeded-session";

const home = clusterTempDir("w52-fork-alarm-firing-");
const { dir, sessionsDir, catalogFile } = home;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PARENT_ID = "fork-fire-parent";
const CHILD_ID = "fork-fire-child";
/** Injected entity clock: the test decides "now"; the arm below is already due. */
const NOW = 2_000;
const FIRE_AT = 1_000;

const FiredIntent = z.looseObject({
  op: z.literal("fired"),
  occurrenceId: z.string(),
  outcome: z.string(),
});

test("the parent's pre-anchor alarm fires exactly once and the forked child registers and receives zero", async () => {
  // Seed the parent: materialize, then ONE commit with the arm BEFORE the
  // boundary anchor (`turn-1:terminal`) the fork uses.
  const seeded = await runAgent(
    Effect.scoped(
      Effect.gen(function* () {
        const parent = yield* fencedSession(home, PARENT_ID);
        const row = parent.kernel.row(PARENT_ID);
        const armed = armAction({
          parentId: `${PARENT_ID}:materialize`,
          sessionId: PARENT_ID,
          purpose: "cron.tick",
          at: FIRE_AT,
          supersedes: null,
          alarmId: "cron-1",
          sourceKey: "cron",
          payload: {},
          armSeq: row.revision + 1,
          ts: 2,
        });
        yield* parent.commit([armed.action, boundaryTerminal(PARENT_ID, armed.action.id)], 3);
        // Fork at the boundary: the arm precedes the anchor, yet is excluded.
        const { receipt, child } = yield* forkAtAction(home, parent, { childId: CHILD_ID, anchorId: "turn-1:terminal" });
        return { occurrenceId: armed.occurrenceId, armSeq: row.revision + 1, receipt, childArmed: child.armedAlarms() };
      }),
    ),
  );
  // The durable registration fact: the child's armed-alarm index is empty.
  expect(seeded.childArmed).toEqual([]);
  expect(seeded.receipt.forkedFrom.session).toBe(PARENT_ID);

  // Real plane: activate the child first (its rescan resends nothing), then
  // the parent (its rescan resends the due occurrence, which delivers once).
  const wakes: { readonly occurrenceId: string; readonly alarmId: string }[] = [];
  const resends: { readonly sessionId: string; readonly occurrenceId: string }[] = [];
  let resolveParentDelivery: (outcome: "delivered" | "stale") => void = () => undefined;
  const parentDelivery = new Promise<"delivered" | "stale">((resolve) => {
    resolveParentDelivery = resolve;
  });
  const capability: AlarmCapability = {
    purposes: ["cron.tick"],
    wake: (fired) =>
      Effect.sync(() => {
        wakes.push({ occurrenceId: fired.occurrenceId, alarmId: fired.alarmId });
        return "delivered" as const;
      }),
  };
  const outcome = await runCluster(
    {
      sessionsDir,
      catalogFile,
      alarmCapability: capability,
      clock: () => NOW,
      onAlarmResend: (sessionId, occurrence, receipt) => {
        resends.push({ sessionId, occurrenceId: occurrence.occurrenceId });
        if (sessionId === PARENT_ID && occurrence.occurrenceId === seeded.occurrenceId) {
          resolveParentDelivery(receipt.outcome);
        }
      },
    },
    Effect.gen(function* () {
      // Child activation: a real Deliver turn; the rescan finds zero arms.
      yield* sendPrompt(CHILD_ID, `${CHILD_ID}:m-1`, "hello child");
      // Parent activation: the rescan resends the armed occurrence, the
      // DeliverAt door releases the due instant, and the wake runs. The
      // `onAlarmResend` signal follows the committed fired fact.
      yield* sendPrompt(PARENT_ID, `${PARENT_ID}:m-1`, "hello parent");
      const first = yield* Effect.promise(() => parentDelivery).pipe(
        Effect.timeout("15 seconds"),
        Effect.orDie,
      );
      // A duplicate envelope for the SAME settled occurrence: the occurrence
      // id is the cluster dedupe key, so the transport replays the recorded
      // ack instead of delivering again — the wake and fired-fact counts
      // below prove zero re-execution.
      const duplicate = yield* sendAlarm(PARENT_ID, {
        occurrenceId: seeded.occurrenceId,
        purpose: "cron.tick",
        alarmId: "cron-1",
        armSeq: seeded.armSeq,
        sourceKey: "cron",
        payload: JSON.stringify({}),
        fireAt: FIRE_AT,
      }).pipe(Effect.timeout("15 seconds"), Effect.orDie);
      return { first, duplicate };
    }),
  );
  expect(outcome.first).toBe("delivered");
  expect(outcome.duplicate).toMatchObject({ outcome: "delivered" });
  // Exactly one wake, for the parent's occurrence; nothing woke for the child.
  expect(wakes).toEqual([{ occurrenceId: seeded.occurrenceId, alarmId: "cron-1" }]);
  // Zero child resends: every activation resend names the parent.
  expect(resends.length).toBeGreaterThan(0);
  expect(resends.filter((entry) => entry.sessionId === CHILD_ID)).toEqual([]);

  // Durable facts: one delivered fired row in the parent; the child chain
  // holds NO alarm rows at all and its armed index stayed empty.
  const after = withSessionHandles(home, PARENT_ID, (parent) =>
    withSessionHandles(home, CHILD_ID, (child) => ({
      deliveredFired: parent.kernel
        .historyPage(PARENT_ID, { afterRevision: 0, limit: 256 })
        .actions.filter((action) => {
          if (action.kind !== "alarm") return false;
          const fired = FiredIntent.safeParse(action.intent.value);
          return fired.success && fired.data.occurrenceId === seeded.occurrenceId && fired.data.outcome === "delivered";
        }).length,
      childAlarmRows: child.kernel
        .historyPage(CHILD_ID, { afterRevision: 0, limit: 256 })
        .actions.filter((action) => action.kind === "alarm").length,
      childArmed: child.store.armedAlarms(),
    })),
  );
  expect(after.deliveredFired).toBe(1);
  expect(after.childAlarmRows).toBe(0);
  expect(after.childArmed).toEqual([]);
});
