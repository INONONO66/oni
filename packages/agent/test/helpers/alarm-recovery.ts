/**
 * #1348: per-test fixtures for the crash-recovery alarm suites (#1254 S3,
 * #1347 strikes). Every factory mints fresh collectors; nothing here is
 * shared across two acquisitions.
 */
import { Effect, type Result } from "effect";
import { armAction, type AlarmCapability, type AlarmFired, type firedAction } from "../../src/core/ports/alarm";
import type { openCatalogStore } from "../../src/core/store/catalog";
import type { LedgerError } from "../../src/core/store/errors";
import type * as SessionHandleStore from "../../src/core/store/fence";
import { readChain, type sendAlarm, sessionFileFor, type TestClusterOptions } from "./cluster-runtime";
import { runAgent } from "./executor";
import { fencedSession, withSessionHandles, type ClusterHome } from "./seeded-session";

/**
 * #1254 S4: non-reserved purposes dispatch to the composed capability; an
 * unbound purpose folds stale. Recovery cases pin the RESEND path, so the
 * `note.due` purpose is registered with a wake that just accepts.
 */
export const noteCapability: AlarmCapability = {
  purposes: ["note.due"],
  wake: () => Effect.succeed("delivered" as const),
};

/** One `note.due` arm row for the chain `alarmId` at `armSeq`. */
export function noteArm(
  sessionId: string,
  alarmId: string,
  armSeq: number,
  at: number | null,
  supersedes: string | null = null,
) {
  return armAction({
    parentId: null,
    sessionId,
    purpose: "note.due",
    at,
    supersedes,
    alarmId,
    sourceKey: "note",
    payload: { note: `${alarmId}@${armSeq}` },
    armSeq,
    ts: 2,
  });
}

export interface ResendSignal {
  readonly options: Pick<TestClusterOptions, "onAlarmResend">;
  /** Settles once the activation resend of `occurrenceId` replied `delivered`. */
  readonly delivered: (occurrenceId: string) => Promise<void>;
}

/**
 * The deterministic "the resent occurrence was consumed" signal: settles on
 * the cluster's `onAlarmResend` receipt, never on elapsed time (the timeout is
 * a failure guard only).
 */
export function resendSignal(timeoutMs = 15_000): ResendSignal {
  const seen = new Map<string, () => void>();
  const settled = new Set<string>();
  return {
    options: {
      onAlarmResend: (_sessionId, occurrence, receipt) => {
        if (receipt.outcome !== "delivered") return;
        settled.add(occurrence.occurrenceId);
        seen.get(occurrence.occurrenceId)?.();
      },
    },
    delivered: (occurrenceId) =>
      new Promise<void>((resolve, reject) => {
        if (settled.has(occurrenceId)) return resolve();
        seen.set(occurrenceId, resolve);
        setTimeout(
          () => reject(new Error(`timed out waiting for resend of ${occurrenceId}`)),
          timeoutMs,
        ).unref?.();
      }),
  };
}

/** A wake that "crashes" the attempt: a defect after the strike committed, before any fired row. */
export function crashingCapability(): AlarmCapability & { readonly attempts: () => number } {
  let attempts = 0;
  return {
    purposes: ["note.due"],
    wake: () =>
      Effect.sync(() => {
        attempts += 1;
      }).pipe(Effect.andThen(Effect.die(new Error("simulated crash mid-attempt")))),
    attempts: () => attempts,
  };
}

/** Counts of the `delivered` and `stale` fired facts recorded for one occurrence. */
export function firedRows(
  home: ClusterHome,
  sessionId: string,
  occurrenceId: string,
): { readonly delivered: number; readonly stale: number } {
  const rows = readChain(sessionFileFor(home.sessionsDir, sessionId), sessionId);
  return {
    delivered: rows.filter((row) => row.id === `${occurrenceId}:delivered`).length,
    stale: rows.filter((row) => row.id === `${occurrenceId}:stale`).length,
  };
}

/** The original occurrence of one armed row, as the cluster's DeliverAt door would send it. */
export function armedOccurrence(home: ClusterHome, sessionId: string): Parameters<typeof sendAlarm>[1] {
  return withSessionHandles(home, sessionId, ({ kernel }) => {
    const [row] = kernel.armedAlarms();
    if (row === undefined) throw new Error(`no armed row for ${sessionId}`);
    return { ...row, fireAt: row.fireAt };
  });
}

/**
 * #1477: a wake whose FIRST attempt is quiet at `at` and every later attempt
 * delivers; `seen` records the fired view (with its `tick`) of each attempt.
 */
export function quietCapability(at: number): AlarmCapability & {
  readonly attempts: () => number;
  readonly seen: () => readonly (number | undefined)[];
} {
  const ticks: (number | undefined)[] = [];
  return {
    purposes: ["note.due"],
    wake: (fired) =>
      Effect.sync(() => {
        ticks.push(fired.tick);
        return ticks.length === 1 ? { outcome: "quiet" as const, at } : ("delivered" as const);
      }),
    attempts: () => ticks.length,
    seen: () => [...ticks],
  };
}

export interface HeldSends {
  readonly options: Pick<TestClusterOptions, "wrapSendAlarm">;
  /** Every occurrence the entity tried to send, in order; none left the process. */
  readonly sent: () => readonly AlarmFired[];
  /** Settles on the first held send of `occurrenceId` with a tick; the timeout is a failure guard only. */
  readonly ticked: (occurrenceId: string, timeoutMs?: number) => Promise<void>;
}

/** Holds every entity-side alarm send; the quiet re-send is forked after the wake receipt, so await `ticked` first. */
export function heldSends(): HeldSends {
  const sent: AlarmFired[] = [];
  const waiters = new Map<string, () => void>();
  return {
    options: {
      wrapSendAlarm: () => (_sessionId, occurrence) =>
        Effect.sync(() => {
          sent.push(occurrence);
          if (occurrence.tick !== undefined) waiters.get(occurrence.occurrenceId)?.();
        }),
    },
    sent: () => [...sent],
    ticked: (occurrenceId, timeoutMs = 15_000) =>
      new Promise<void>((resolve, reject) => {
        if (sent.some((row) => row.occurrenceId === occurrenceId && row.tick !== undefined)) return resolve();
        waiters.set(occurrenceId, resolve);
        setTimeout(() => reject(new Error(`timed out waiting for the quiet re-send of ${occurrenceId}`)), timeoutMs).unref?.();
      }),
  };
}

/** Per-suite session handles: fresh reads, a fenced writer, the fired census. */
export function sessionFixture(home: ClusterHome): {
  readonly readSession: (
    sessionId: string,
    use: (input: {
      readonly catalog: ReturnType<typeof openCatalogStore>;
      readonly kernel: SessionHandleStore.SessionKernel;
    }) => Promise<void> | void,
  ) => Promise<void>;
  readonly withSession: (
    sessionId: string,
    use: (input: {
      readonly catalog: ReturnType<typeof openCatalogStore>;
      readonly kernel: SessionHandleStore.SessionKernel;
      readonly commit: (
        actions: readonly ReturnType<typeof firedAction>[],
      ) => Promise<
        Result.Result<Effect.Success<ReturnType<SessionHandleStore.SessionKernel["commit"]>>, LedgerError>
      >;
    }) => Promise<void>,
  ) => Promise<void>;
  readonly firedRows: (sessionId: string, occurrenceId: string) => ReturnType<typeof firedRows>;
} {
  return {
    readSession: async (sessionId, use) => {
      await withSessionHandles(home, sessionId, ({ catalog, kernel }) => use({ catalog, kernel }));
    },
    withSession: (sessionId, use) =>
      runAgent(
        Effect.scoped(
          fencedSession(home, sessionId, { owner: "arm-writer", fence: 1, commitNow: () => 2 }).pipe(
            Effect.flatMap((seeded) =>
              Effect.promise(() =>
                use({
                  catalog: seeded.catalog,
                  kernel: seeded.kernel,
                  commit: (actions) => runAgent(Effect.result(seeded.commit([...actions]))),
                }),
              ),
            ),
          ),
        ),
      ),
    firedRows: (sessionId, occurrenceId) => firedRows(home, sessionId, occurrenceId),
  };
}
