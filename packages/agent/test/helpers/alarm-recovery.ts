/**
 * #1348: per-test fixtures for the crash-recovery alarm suites (#1254 S3,
 * #1347 strikes). Every factory mints fresh collectors; nothing here is
 * shared across two acquisitions.
 */
import { Effect } from "effect";
import { armAction, type AlarmCapability } from "../../src/core/alarm";
import { readChain, type sendAlarm, sessionFileFor, type TestClusterOptions } from "./cluster-runtime";
import { withSessionHandles, type ClusterHome } from "./seeded-session";

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

/** The durable armed index of one session: its row count and the catalog flag. */
function armedIndex(
  home: ClusterHome,
  sessionId: string,
): { readonly count: number; readonly hasArmed: boolean | undefined } {
  return withSessionHandles(home, sessionId, ({ kernel, catalog }) => ({
    count: kernel.armedCount(),
    hasArmed: catalog.sessionIndex(sessionId)?.hasArmed,
  }));
}
