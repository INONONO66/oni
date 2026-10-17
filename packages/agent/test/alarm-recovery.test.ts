import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { firedAction, type AlarmCapability } from "../src/core/ports/alarm";
import { RETIRED_INGRESS_KIND, RETIRED_ROLE, rawCatalogRows, writeOldCatalog } from "./store/helpers/old-catalog";
import { openCatalogStore } from "../src/core/store/catalog";
import { CatalogVersionRefused } from "../src/core/store/errors";
import {
  armedOccurrence,
  crashingCapability,
  noteArm as arm,
  noteCapability,
  resendSignal,
  sessionFixture,
} from "./helpers/alarm-recovery";
import { clusterTempDir, readChain, runCluster, sendAlarm, sendKick, sendRescan, sessionFileFor } from "./helpers/cluster-runtime";
import { runAgent } from "./helpers/executor";

// Scheduling that survives a crash. The arm row's commit maintains
// the session file's `armed_alarms` index in the SAME transaction; the catalog
// `has_armed` flag is 1 before the arming commit and 0 only after the index is
// confirmed empty; an activation resends every armed row's ORIGINAL occurrence
// so the cluster's DeliverAt door (occurrence id = dedupe key) re-fires it.

const home = clusterTempDir("alarm-recovery-");
const { dir, sessionsDir, catalogFile } = home;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PAST_FIRE_AT = 1_000;

const { readSession, withSession, firedRows } = sessionFixture(home);

/** Post-run census: no armed rows remain in the session file and the catalog index agrees. */
const expectNothingArmed = (sessionId: string) =>
  readSession(sessionId, ({ kernel, catalog }) => {
    expect(kernel.armedCount()).toBe(0);
    expect(catalog.sessionIndex(sessionId)?.hasArmed).toBe(false);
  });

/** The exhausted terminal row landed exactly once and no fired row of either outcome exists. */
function expectExhaustedOnce(sessionId: string, occurrenceId: string) {
  const chain = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
  expect(chain.filter((row) => row.id === `${occurrenceId}:exhausted`)).toHaveLength(1);
  expect(firedRows(sessionId, occurrenceId)).toEqual({ delivered: 0, stale: 0 });
}

describe("armed_alarms index in the append transaction", () => {
  test("arm upserts, retire deletes, fired deletes — all visible through the kernel reads", async () => {
    const sessionId = "idx-lifecycle";
    await withSession(sessionId, async ({ kernel, commit, catalog }) => {
      const first = arm(sessionId, "a1", 1, PAST_FIRE_AT);
      expect(Result.isSuccess(await commit([first.action]))).toBe(true);
      expect(kernel.armedCount()).toBe(1);
      expect(kernel.armedAlarms()).toEqual([
        {
          alarmId: "a1",
          occurrenceId: first.occurrenceId,
          fireAt: PAST_FIRE_AT,
          purpose: "note.due",
          armSeq: 1,
          sourceKey: "note",
          payload: JSON.stringify({ note: "a1@1" }),
          strikes: 0,
        },
      ]);
      expect(catalog.sessionIndex(sessionId)?.hasArmed).toBe(true);

      // Re-arm supersedes in place: still one row, now the new occurrence.
      const second = arm(sessionId, "a1", 2, PAST_FIRE_AT + 1, first.occurrenceId);
      expect(Result.isSuccess(await commit([second.action]))).toBe(true);
      expect(kernel.armedAlarms().map((row) => row.occurrenceId)).toEqual([second.occurrenceId]);

      // A stale firing of the OLD occurrence touches nothing (deletes by its
      // occurrence id, which no longer indexes a row); has_armed stays 1.
      const stale = firedAction({
        parentId: null,
        sessionId,
        purpose: "note.due",
        alarmId: "a1",
        occurrenceId: first.occurrenceId,
        outcome: "stale",
        ts: 2,
      });
      expect(Result.isSuccess(await commit([stale]))).toBe(true);
      expect(kernel.armedAlarms().map((row) => row.occurrenceId)).toEqual([second.occurrenceId]);
      expect(catalog.sessionIndex(sessionId)?.hasArmed).toBe(true);

      // The delivered firing of the live occurrence empties the index and only
      // then clears has_armed.
      const delivered = firedAction({
        parentId: null,
        sessionId,
        purpose: "note.due",
        alarmId: "a1",
        occurrenceId: second.occurrenceId,
        outcome: "delivered",
        ts: 2,
      });
      expect(Result.isSuccess(await commit([delivered]))).toBe(true);
      expect(kernel.armedCount()).toBe(0);
      expect(catalog.sessionIndex(sessionId)?.hasArmed).toBe(false);

      // Retire (arm at: null) deletes by alarm id.
      const third = arm(sessionId, "a1", 3, PAST_FIRE_AT);
      expect(Result.isSuccess(await commit([third.action]))).toBe(true);
      expect(kernel.armedCount()).toBe(1);
      const retire = arm(sessionId, "a1", 4, null, third.occurrenceId);
      expect(Result.isSuccess(await commit([retire.action]))).toBe(true);
      expect(kernel.armedCount()).toBe(0);
      expect(catalog.sessionIndex(sessionId)?.hasArmed).toBe(false);
    });
  });

  test("same transaction: a refused later row rolls back the arm AND its index write", async () => {
    const sessionId = "idx-rollback";
    await withSession(sessionId, async ({ kernel, commit }) => {
      const revisionBefore = kernel.row(sessionId).revision;
      const armed = arm(sessionId, "a-roll", 1, PAST_FIRE_AT);
      // A second alarm row with a schema-invalid op refuses the whole batch
      // (a constructor-built row with its intent corrupted in memory: the
      // store's write-side schema check is the subject here, not the writer).
      const invalid = {
        ...arm(sessionId, "a-roll-invalid", 1, PAST_FIRE_AT).action,
        intent: { encodingVersion: 1 as const, value: { op: "explode" } },
      };
      const result = await commit([armed.action, invalid]);
      expect(Result.isFailure(result)).toBe(true);
      expect(kernel.armedCount()).toBe(0);
      expect(kernel.row(sessionId).revision).toBe(revisionBefore);
      expect(kernel.actionById("a-roll:arm:1")).toBeUndefined();
    });
  });

  test("has_armed is 1 BEFORE the arming commit lands: a refused commit leaves the flag up", async () => {
    const sessionId = "idx-flag-first";
    await withSession(sessionId, async ({ kernel, catalog }) => {
      const armed = arm(sessionId, "a-flag", 1, PAST_FIRE_AT);
      const refused = await runAgent(
        Effect.result(
          kernel.commit({
            sessionId,
            owner: "someone-else", // not the fence owner: the commit itself refuses
            fence: 999,
            now: 2,
            expectedRevision: kernel.row(sessionId).revision,
            actions: [armed.action],
            state: "idle",
          }),
        ),
      );
      expect(Result.isFailure(refused)).toBe(true);
      // The journal shows no arm, yet the catalog intent was already durable:
      // exactly the crash window the boot rescan exists for.
      expect(kernel.actionById("a-flag:arm:1")).toBeUndefined();
      expect(kernel.armedCount()).toBe(0);
      expect(catalog.sessionIndex(sessionId)?.hasArmed).toBe(true);
    });
  });
});

describe("catalog schema v4 (#1351 retired-byte rewrite)", () => {
  test("a v1 catalog upgrades in place: column added, marker bumped, rows intact", () => {
    const directory = mkdtempSync(join(tmpdir(), "catalog-v1-"));
    const path = join(directory, "catalog.sqlite");
    try {
      writeOldCatalog(path, {
        version: 1,
        roles: ["resident", RETIRED_ROLE],
        kinds: [],
        sessions: [["s-old", null, "resident"]],
        policies: [],
      });

      const store = openCatalogStore(path, { now: () => 1 });
      try {
        expect(store.sessionIndex("s-old")).toEqual({
          id: "s-old",
          parentId: null,
          role: "resident",
          fence: 2,
          createdAt: 5,
          hasArmed: false,
        });
        store.markArmed("s-old", true);
        expect(store.armedSessionIds()).toEqual(["s-old"]);
        store.markArmed("s-old", false);
        expect(store.armedSessionIds()).toEqual([]);
      } finally {
        store.close();
      }
      expect(rawCatalogRows(path).version).toEqual({ user_version: 5 });
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  for (const version of [2, 3] as const) {
    test(`a v${version} catalog rewrites retired role and kind bytes in one transaction, keeps every row and stamps 4`, () => {
      const directory = mkdtempSync(join(tmpdir(), `catalog-v${version}-`));
      const path = join(directory, "catalog.sqlite");
      try {
        writeOldCatalog(path, {
          version,
          roles: version === 2 ? ["resident", RETIRED_ROLE] : ["resident", "child", RETIRED_ROLE],
          kinds:
            version === 2
              ? ["prompt", "alarm.fired", RETIRED_INGRESS_KIND]
              : ["prompt", "alarm.fired", "ingress", RETIRED_INGRESS_KIND],
          sessions: [
            ["s-legacy", "s-parent", RETIRED_ROLE],
            ["s-parent", null, "resident"],
          ],
          policies: [
            ["ingress-screen", RETIRED_INGRESS_KIND, "pre", 1],
            ["fired-notice", "alarm.fired", "post", 1],
            ["prompt-allow", "prompt", "pre", 1],
          ],
        });

        const store = openCatalogStore(path, { now: () => 1 });
        try {
          expect(store.sessionIndex("s-legacy")).toEqual({
            id: "s-legacy",
            parentId: "s-parent",
            role: "child",
            fence: 2,
            createdAt: 5,
            hasArmed: false,
          });
          expect(store.policies.rows().map((row) => [row.name, row.kind, row.phase])).toEqual([
            ["fired-notice", "alarm.fired", "post"],
            ["ingress-screen", "ingress", "pre"],
            ["prompt-allow", "prompt", "pre"],
          ]);
          // The rebuilt CHECK admits the current vocabulary.
          store.indexSession({ id: "s-new", parentId: "s-legacy", role: "child", createdAt: 9 });
          expect(store.sessionIndex("s-new")?.role).toBe("child");
        } finally {
          store.close();
        }

        const expected = {
          version: { user_version: 5 },
          sessions: [
            { id: "s-legacy", parent_id: "s-parent", role: "child", fence: 2, created_at: 5 },
            { id: "s-new", parent_id: "s-legacy", role: "child", fence: 0, created_at: 9 },
            { id: "s-parent", parent_id: null, role: "resident", fence: 3, created_at: 6 },
          ],
          policies: [
            { name: "fired-notice", kind: "alarm.fired", phase: "post", generation: 1 },
            { name: "ingress-screen", kind: "ingress", phase: "pre", generation: 1 },
            { name: "prompt-allow", kind: "prompt", phase: "pre", generation: 1 },
          ],
        };
        // The rewrite is persisted, not folded at read time...
        expect(rawCatalogRows(path)).toEqual(expected);
        // ...the rebuilt CHECKs refuse both retired bytes outright...
        const rebuilt = new Database(path);
        try {
          expect(() =>
            rebuilt.run(
              `INSERT INTO policy (name, kind, phase, match, verdict, encoding_version, priority, generation)
               VALUES ('late', '${RETIRED_INGRESS_KIND}', 'pre', '{}', '{"type":"allow"}', 1, 0, 2)`,
            ),
          ).toThrow("CHECK constraint failed");
          expect(() =>
            rebuilt.run(
              `INSERT INTO session_index (id, parent_id, role, created_at) VALUES ('late', NULL, '${RETIRED_ROLE}', 1)`,
            ),
          ).toThrow("CHECK constraint failed");
        } finally {
          rebuilt.close();
        }
        // ...and a second open is idempotent: nothing rebuilds, nothing changes.
        openCatalogStore(path, { now: () => 1 }).close();
        expect(rawCatalogRows(path)).toEqual(expected);
      } finally {
        rmSync(directory, { recursive: true });
      }
    });
  }

  test("a newer (v6) catalog opens read-only: markArmed refuses typed", () => {
    const directory = mkdtempSync(join(tmpdir(), "catalog-v6-"));
    const path = join(directory, "catalog.sqlite");
    try {
      const created = openCatalogStore(path, { now: () => 1 });
      created.close();
      const stamped = new Database(path);
      stamped.run("PRAGMA user_version = 6");
      stamped.close();

      const reopened = openCatalogStore(path, { now: () => 1 });
      try {
        let refusal: Error | undefined;
        try {
          reopened.markArmed("s-any", true);
        } catch (error) {
          refusal = error instanceof Error ? error : new Error(String(error));
        }
        expect(refusal).toBeInstanceOf(CatalogVersionRefused);
        if (refusal instanceof CatalogVersionRefused) {
          expect(refusal.operation).toBe("markArmed");
          expect(refusal.fileVersion).toBe(6);
          expect(refusal.codeVersion).toBe(5);
        }
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});

// ─── crash → activation resend, through the real cluster door ───

describe("#1347 occurrence strikes in the session file", () => {
  test("the strike commits before the handler, without a journal row; a re-arm resets it", async () => {
    const sessionId = "strike-ledger";
    await withSession(sessionId, async ({ kernel, commit }) => {
      const first = arm(sessionId, "s1", 1, PAST_FIRE_AT);
      expect(Result.isSuccess(await commit([first.action]))).toBe(true);
      const revision = kernel.row(sessionId).revision;
      const head = kernel.latestAction(sessionId)?.id;
      expect(kernel.strikeArmedAlarm(first.occurrenceId)).toBe(1);
      expect(kernel.strikeArmedAlarm(first.occurrenceId)).toBe(2);
      expect(kernel.armedAlarms().map((row) => row.strikes)).toEqual([2]);
      // No journal row and no revision moved: the strike is index state only.
      expect(kernel.row(sessionId).revision).toBe(revision);
      expect(kernel.latestAction(sessionId)?.id).toBe(head);
      // An unknown or retired occurrence consumes nothing.
      expect(kernel.strikeArmedAlarm("never-armed")).toBeUndefined();
      // Superseding re-arm starts the new occurrence at zero strikes.
      const second = arm(sessionId, "s1", 2, PAST_FIRE_AT + 1, first.occurrenceId);
      expect(Result.isSuccess(await commit([second.action]))).toBe(true);
      expect(kernel.armedAlarms().map((row) => [row.occurrenceId, row.strikes])).toEqual([[second.occurrenceId, 0]]);
    });
  });

  test("a handler that crashes on every attempt is redelivered twice, then the third attempt folds fired{exhausted} once and runs nothing", async () => {
    const sessionId = "strike-exhaust";
    let occurrenceId = "";
    await withSession(sessionId, async ({ commit }) => {
      const armed = arm(sessionId, "due-x", 1, PAST_FIRE_AT);
      occurrenceId = armed.occurrenceId;
      expect(Result.isSuccess(await commit([armed.action]))).toBe(true);
    });
    const occurrence = armedOccurrence(home, sessionId);
    const capability = crashingCapability();
    await runCluster(
      { sessionsDir, catalogFile, alarmCapability: capability },
      Effect.gen(function* () {
        // The cluster redelivers the persisted occurrence after each entity
        // defect; each delivery consumed one strike before the handler ran,
        // so the third delivery settled the occurrence without executing.
        const receipt = yield* sendAlarm(sessionId, occurrence);
        expect(receipt.outcome).toBe("delivered");
        expect(capability.attempts()).toBe(2);
        // A later duplicate folds at the cluster's dedupe key: the settled
        // receipt again, zero execution, no further strike.
        const duplicate = yield* sendAlarm(sessionId, occurrence);
        expect(duplicate.outcome).toBe("delivered");
        expect(capability.attempts()).toBe(2);
      }),
    );
    expectExhaustedOnce(sessionId, occurrenceId);
    await expectNothingArmed(sessionId);
  }, 30_000);

  test("process death after the increment, before execution: the restart sees the strike and the resend exhausts on the third attempt", async () => {
    const sessionId = "strike-restart";
    let occurrenceId = "";
    // The pre-crash world: the arm committed and one strike consumed in its
    // own transaction — the exact durable state of a process that died
    // between the increment and the handler (no fired row, row still armed).
    await withSession(sessionId, async ({ kernel, commit }) => {
      const armed = arm(sessionId, "due-r", 1, PAST_FIRE_AT);
      occurrenceId = armed.occurrenceId;
      expect(Result.isSuccess(await commit([armed.action]))).toBe(true);
      expect(kernel.strikeArmedAlarm(occurrenceId)).toBe(1);
    });
    await readSession(sessionId, ({ kernel }) => {
      expect(kernel.armedAlarms().map((row) => [row.occurrenceId, row.strikes])).toEqual([[occurrenceId, 1]]);
    });

    // Boot: the activation resend is attempt two (crashes), its redelivery is
    // attempt three — exhausted before execution, one row, and the loop ends.
    const capability = crashingCapability();
    const signal = resendSignal();
    await runCluster(
      { sessionsDir, catalogFile, alarmCapability: capability, ...signal.options },
      Effect.gen(function* () {
        yield* sendRescan(sessionId, `${sessionId}:rescan:boot-2`, PAST_FIRE_AT);
        yield* Effect.promise(() => signal.delivered(occurrenceId));
      }),
    );
    expect(capability.attempts()).toBe(1);
    expectExhaustedOnce(sessionId, occurrenceId);
    await expectNothingArmed(sessionId);
  }, 30_000);
});

describe("crash recovery through the cluster", () => {
  test("crash after arm, before DeliverAt: the rescan wake resends and exactly one fired{delivered} lands", async () => {
    const sessionId = "crash-resend";
    let occurrenceId = "";
    // Phase 1 — the pre-crash world: arm committed, process gone before the
    // cluster ever saw the occurrence.
    await withSession(sessionId, async ({ commit }) => {
      const armed = arm(sessionId, "due-1", 1, PAST_FIRE_AT);
      occurrenceId = armed.occurrenceId;
      expect(Result.isSuccess(await commit([armed.action]))).toBe(true);
    });

    // Phase 2 — boot: the sweep's rescan occurrence wakes the entity; the
    // activation resend re-fires the original occurrence.
    const signal = resendSignal();
    await runCluster(
      { sessionsDir, catalogFile, alarmCapability: noteCapability, ...signal.options },
      Effect.gen(function* () {
        const receipt = yield* sendRescan(sessionId, `${sessionId}:rescan:boot-1`, PAST_FIRE_AT);
        expect(receipt.outcome).toBe("delivered");
        yield* Effect.promise(() => signal.delivered(occurrenceId));
        // Bounded termination: once the index is empty a second sweep's wake
        // converges — it replies delivered, resends nothing, appends nothing
        // (the chain census below pins the zero-effect claim).
        const second = yield* sendRescan(sessionId, `${sessionId}:rescan:boot-1b`, PAST_FIRE_AT);
        expect(second.outcome).toBe("delivered");
      }),
    );

    expect(firedRows(sessionId, occurrenceId)).toEqual({ delivered: 1, stale: 0 });
    const chain = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
    // The rescan wake itself appended nothing.
    expect(chain.filter((row) => row.id.includes(":rescan"))).toHaveLength(0);
    await expectNothingArmed(sessionId);
  }, 30_000);

  test("resend is bounded: N armed rows resend exactly N occurrences, once per activation", async () => {
    const sessionId = "crash-resend-bounded";
    const occurrences: string[] = [];
    await withSession(sessionId, async ({ commit }) => {
      for (const alarmId of ["due-n1", "due-n2", "due-n3"]) {
        const armed = arm(sessionId, alarmId, 1, PAST_FIRE_AT);
        occurrences.push(armed.occurrenceId);
        expect(Result.isSuccess(await commit([armed.action]))).toBe(true);
      }
    });

    const resends: string[] = [];
    const signal = resendSignal();
    await runCluster(
      {
        sessionsDir,
        catalogFile,
        alarmCapability: noteCapability,
        onAlarmResend: (innerSessionId, occurrence, receipt) => {
          resends.push(occurrence.occurrenceId);
          signal.options.onAlarmResend?.(innerSessionId, occurrence, receipt);
        },
      },
      Effect.gen(function* () {
        yield* sendRescan(sessionId, `${sessionId}:rescan:boot-n`, PAST_FIRE_AT);
        for (const occurrenceId of occurrences) {
          yield* Effect.promise(() => signal.delivered(occurrenceId));
        }
        // A second rescan on the SAME activation resends nothing: the resend
        // ran exactly once and every delivered row already left the index.
        const second = yield* sendRescan(sessionId, `${sessionId}:rescan:boot-n2`, PAST_FIRE_AT);
        expect(second.outcome).toBe("delivered");
      }),
    );

    // Exactly N resends — not N per rescan, not a self-retriggering storm.
    expect([...resends].sort()).toEqual([...occurrences].sort());
    for (const occurrenceId of occurrences) {
      expect(firedRows(sessionId, occurrenceId)).toEqual({ delivered: 1, stale: 0 });
    }
    await expectNothingArmed(sessionId);
  }, 30_000);

  test("supersede then crash: the new occurrence fires, the late old one folds stale with zero execution", async () => {
    const sessionId = "crash-supersede";
    let oldOccurrence = "";
    let newOccurrence = "";
    await withSession(sessionId, async ({ commit }) => {
      const first = arm(sessionId, "due-2", 1, PAST_FIRE_AT);
      oldOccurrence = first.occurrenceId;
      expect(Result.isSuccess(await commit([first.action]))).toBe(true);
      const second = arm(sessionId, "due-2", 2, PAST_FIRE_AT + 1, first.occurrenceId);
      newOccurrence = second.occurrenceId;
      expect(Result.isSuccess(await commit([second.action]))).toBe(true);
    });

    const signal = resendSignal();
    await runCluster(
      { sessionsDir, catalogFile, alarmCapability: noteCapability, ...signal.options },
      Effect.gen(function* () {
        yield* sendRescan(sessionId, `${sessionId}:rescan:boot-2`, PAST_FIRE_AT);
        yield* Effect.promise(() => signal.delivered(newOccurrence));
        // The old occurrence arrives late (it was never registered before the
        // crash): the chain guard folds it to a recorded stale fact.
        const late = yield* sendAlarm(sessionId, {
          occurrenceId: oldOccurrence,
          purpose: "note.due",
          alarmId: "due-2",
          armSeq: 1,
          sourceKey: "note",
          payload: JSON.stringify({ note: "due-2@1" }),
          fireAt: PAST_FIRE_AT,
        });
        expect(late.outcome).toBe("stale");
      }),
    );

    expect(firedRows(sessionId, newOccurrence)).toEqual({ delivered: 1, stale: 0 });
    expect(firedRows(sessionId, oldOccurrence)).toEqual({ delivered: 0, stale: 1 });
    await expectNothingArmed(sessionId);
  }, 30_000);
});

/**
 * A capability arm commits through the entity's commit door, and the minted
 * occurrence is forwarded to DeliverAt from the committed row itself (not from
 * the index the activation resend reads). Its `payload` must be the arm's
 * canonical JSON bytes — non-empty, because `{}` hides a wrong serializer.
 */
describe("live arm forward through the cluster", () => {
  test("ctx.arm's forwarded occurrence carries the arm payload as parseable canonical JSON", async () => {
    const sessionId = "live-forward";
    await withSession(sessionId, async ({ commit }) => {
      expect(Result.isSuccess(await commit([arm(sessionId, "seed", 1, PAST_FIRE_AT).action]))).toBe(true);
    });
    const payloads: string[] = [];
    let resolveChained: () => void = () => undefined;
    const chained = new Promise<void>((resolve) => {
      resolveChained = resolve;
    });
    const capability: AlarmCapability = {
      purposes: ["note.due"],
      wake: (fired, ctx) =>
        Effect.gen(function* () {
          payloads.push(fired.payload);
          if (fired.alarmId === "seed") {
            yield* ctx.arm({
              purpose: "note.due",
              at: ctx.now - 1,
              payload: { note: "live", attempt: 2, tags: ["z", "a"] },
              sourceKey: "note",
              alarmId: "chained",
            }).pipe(Effect.orDie);
          } else resolveChained();
          return "delivered" as const;
        }),
    };
    await runCluster(
      { sessionsDir, catalogFile, alarmCapability: capability },
      Effect.gen(function* () {
        yield* sendKick(sessionId);
        yield* Effect.promise(() => chained);
      }),
    );
    expect(payloads.map((payload) => JSON.parse(payload))).toEqual([
      { note: "seed@1" },
      { note: "live", attempt: 2, tags: ["z", "a"] },
    ]);
    expect(payloads[1]).toBe('{"attempt":2,"note":"live","tags":["z","a"]}');
  });
});
