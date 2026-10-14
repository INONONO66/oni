import { Bundle, Core } from "@openomni/agent";
import { Effect } from "effect";
import {
  blockingRunner,
  clusterMessages,
  clusterTempDir,
  runCluster,
  sendPrompt,
} from "../../../../packages/agent/test/helpers/cluster-runtime";
import { createAlarmMonitorPorts, createLiveArmRegistry } from "../../src/bundles/alarms/index";
import { cronPurposes } from "../../src/bundles/alarms/cron/index";
import { monitorBundle, monitorPurposes } from "../../src/bundles/alarms/monitor/index";
import type { AppLedgerPlane, SessionKernel } from "../../src/composition/cluster-runtime";
import { createAppLedger } from "./ledger";
import type { MonitorPorts } from "../../src/bundles/alarms/monitor/ports";
import type { ArmedWatch, WatchSources } from "../../src/composition/watch-sources";
import { gateRowPolicySeeds } from "../../src/bundles/core-policy/index";
import { seedKernelPolicyRows } from "../../src/composition/policy";
import { runEffect } from "./effect";
import { adoptTestFence } from "./ledger";
import { testClock } from "./test-entropy";

interface WatchFixture {
  readonly plane: AppLedgerPlane;
  readonly kernel: SessionKernel;
  readonly fence: number;
  readonly sources: WatchSources;
  readonly installed: ArmedWatch[];
  readonly refreshed: ArmedWatch[];
  readonly closed: string[];
}

/** One real session and observable fake source lifecycle for monitor tests. */
export async function watchFixture(sessionId: string, owner: string): Promise<WatchFixture> {
  const plane = createAppLedger({ now: testClock() });
  const installed: ArmedWatch[] = [];
  const refreshed: ArmedWatch[] = [];
  const closed: string[] = [];
  const live = new Set<string>();
  const sources: WatchSources = {
    install: (spec) => {
      installed.push(spec);
      live.add(spec.id);
      return Promise.resolve();
    },
    refresh: (spec) => {
      if (!live.has(spec.id)) return false;
      refreshed.push(spec);
      return true;
    },
    observe: () => false,
    close: (id) => {
      closed.push(id);
      live.delete(id);
      return Promise.resolve();
    },
    closeAll: () => Promise.resolve(),
  };
  seedKernelPolicyRows(plane.catalog.policies, gateRowPolicySeeds({
    rows: monitorBundle({ close: () => undefined }, () => undefined).rows,
    handlers: new Map(),
  }));
  const kernel = plane.openKernel(sessionId);
  await runEffect(
    kernel.materialize({
      id: sessionId,
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: kernel.currentPolicyGeneration(),
      actionId: "configure",
      at: 1,
    }),
  );
  const fence = await runEffect(adoptTestFence(kernel, sessionId, owner));
  return { plane, kernel, fence, sources, installed, refreshed, closed };
}

/**
 * Pure fold seeding (#1254 r2 M2): commit one `alarm{arm}` LEDGER FACT
 * directly through the fixture's adopted fence. This seeds history for the
 * fold/projection tests only — it emulates no verb, schedules nothing and
 * notifies nobody; lifecycle behavior is tested through the real entity in
 * `withEntityAlarmPorts`.
 */
export async function commitArm(
  state: Pick<WatchFixture, "kernel" | "fence">,
  sessionId: string,
  input: {
    readonly purpose: string;
    readonly at: number | null;
    readonly alarmId: string;
    readonly supersedes?: string;
    readonly sourceKey: string;
    readonly payload: Parameters<typeof Core.armAction>[0]["payload"];
    readonly ts?: number;
  },
): Promise<{ readonly alarmId: string; readonly occurrenceId: string; readonly armSeq: number }> {
  const { kernel } = state;
  const row = kernel.row(sessionId);
  const owner = row.fenceOwner;
  if (owner === null) throw new Error(`fold seeding without an adopted fence: ${sessionId}`);
  const armSeq = row.revision + 1;
  const { action, occurrenceId } = Core.armAction({
    parentId: kernel.latestAction(sessionId)?.id ?? null,
    sessionId,
    purpose: input.purpose,
    at: input.at,
    supersedes: input.supersedes ?? null,
    alarmId: input.alarmId,
    sourceKey: input.sourceKey,
    payload: input.payload,
    armSeq,
    ts: input.ts ?? 1000,
  });
  await runEffect(
    kernel.commit({
      sessionId,
      owner,
      fence: state.fence,
      now: input.ts ?? 1000,
      expectedRevision: row.revision,
      actions: [action],
      state: row.state,
    }),
  );
  return { alarmId: input.alarmId, occurrenceId, armSeq };
}

/** Deterministic far-future clock base: every live arm schedules beyond the test's wall time. */
export const FIXTURE_BASE = 4_102_444_800_000;

/** What `withEntityAlarmPorts` hands the test body — the REAL entity is live underneath. */
export interface EntityAlarmFixture {
  readonly sessionId: string;
  /** The open (held) turn's id — the valid turn token for tool-facing arms. */
  readonly turnId: string;
  readonly catalogFile: string;
  readonly plane: AppLedgerPlane;
  readonly kernel: SessionKernel;
  readonly ports: MonitorPorts;
  readonly capability: Bundle.AlarmCapabilityDefinition;
  /** The production registry verb (not_live / stale_turn authority). */
  readonly registryArm: (sessionId: string, turnId: string) => Bundle.ArmVerb;
  /** The raw live entity verb, as the entity's own wake context holds it. */
  readonly entityArm: Core.ArmVerb;
  readonly installed: ArmedWatch[];
  readonly closed: string[];
}

/** Completed persisted DeliverAt sends per fixture, keyed by catalog file (#1254 r4 M2). */
interface PersistedSendLog {
  readonly sent: Set<number>;
  readonly waiters: Map<number, Array<() => void>>;
}

const persistedSends = new Map<string, PersistedSendLog>();

/** Buffers one completed persisted send and wakes its awaiters (no lost signal). */
function recordPersistedSend(catalogFile: string, fireAt: number): void {
  const log = persistedSends.get(catalogFile);
  if (log === undefined) return;
  log.sent.add(fireAt);
  const pending = log.waiters.get(fireAt) ?? [];
  log.waiters.delete(fireAt);
  for (const wake of pending) wake();
}

/**
 * #1254 r2 M2: the alarm-plane lifecycle fixture over the REAL session entity.
 * One cluster activation holds a turn open (blocking detached runner), its
 * `onLive` verbs register in the production `createLiveArmRegistry`, and the
 * monitor ports commit every arm through the entity's one committing door.
 */
export async function withEntityAlarmPorts<A>(
  sessionId: string,
  body: (fx: EntityAlarmFixture) => Promise<A>,
  watchPlane?: import("../../src/composition/watch-plane").WatchPlane,
): Promise<A> {
  const { sessionsDir, catalogFile } = clusterTempDir("entity-alarm-");
  const registry = createLiveArmRegistry();
  const rawVerbs = new Map<string, Core.ArmVerb>();
  const installed: ArmedWatch[] = [];
  const closed: string[] = [];
  const capability = await runEffect(
    Bundle.alarmCapability({
      bundles: [
        monitorPurposes({
          close: (id) => {
            closed.push(id);
          },
        }),
        cronPurposes(),
      ],
      arm: registry.arm,
      watch: {
        install: ({ sessionId: armedSession, watchId, spec, occurrence }) =>
          Effect.sync(() => {
            installed.push({
              sessionId: armedSession,
              id: watchId,
              occurrence,
              base: { spec, notifications: 0 },
            });
          }),
      },
    }),
  );
  const plane = createAppLedger({ now: () => FIXTURE_BASE, catalogPath: catalogFile, sessionsDir });
  // The persisted-send recorder subscribes BEFORE any arm: completions buffer
  // in `sent`, so a signal fired before awaitScheduled is called still lands.
  persistedSends.set(catalogFile, { sent: new Set(), waiters: new Map() });
  try {
    return await runCluster(
      {
        sessionsDir,
        catalogFile,
        clock: () => FIXTURE_BASE,
        runner: blockingRunner(() => undefined),
        detachTurns: true,
        alarmCapability: capability,
        // #1254 r4 M2: forward through the entity client's REAL persisted
        // `{discard: true}` Alarm send — its completion IS the transport
        // persistence barrier (Runners.ts awaits `storage.saveRequest` before
        // the discard notification returns) — and record the durable
        // deliver_at so `awaitScheduled` never polls.
        wrapSendAlarm: (_send, sendPersisted) => (armedSession, occurrence) =>
          sendPersisted(armedSession, occurrence).pipe(
            Effect.tap(() =>
              Effect.sync(() => recordPersistedSend(catalogFile, occurrence.fireAt)),
            ),
          ),
        // Mirrors the app root's onArmed follower (#1254 H1): a retiring
        // monitor.hit arm closes the native handle at the commit.
        onArmed: (notice) => {
          watchPlane?.onArmed(notice);
          if (notice.purpose !== Bundle.MONITOR_HIT || notice.at !== null) return;
          closed.push(notice.alarmId);
        },
        onLive: (id, verbs) => {
          rawVerbs.set(id, verbs.arm);
          const release = registry.onLive(id, verbs);
          const releaseWatch = watchPlane?.arms.onLive(id, verbs);
          return () => {
            rawVerbs.delete(id);
            releaseWatch?.();
            release();
          };
        },
      },
      Effect.gen(function* () {
        // The held prompt turn: boundary committed (the send acks), body open.
        yield* sendPrompt(sessionId, `${sessionId}:hold`, "hold the turn open");
        const entityArm = rawVerbs.get(sessionId);
        if (entityArm === undefined)
          return yield* Effect.die(new Error(`no live activation for ${sessionId}`));
        const ports = createAlarmMonitorPorts({
          capability,
          openKernel: plane.openKernel,
          clock: () => FIXTURE_BASE,
          entropy: () => "minted",
          run: (effect) => runEffect(effect),
        });
        return yield* Effect.promise(() =>
          body({
            sessionId,
            turnId: `${sessionId}:hold:turn`,
            catalogFile,
            plane,
            kernel: plane.openKernel(sessionId),
            ports,
            capability,
            registryArm: registry.arm,
            entityArm,
            installed,
            closed,
          }),
        );
      }),
    );
  } finally {
    persistedSends.delete(catalogFile);
    plane.close();
  }
}

const SCHEDULE_SEND_CAP_MS = 15_000;

/** Bounded (failure guard, never a synchronizer) wait for one recorded persisted send. */
function awaitPersistedSend(log: PersistedSendLog, deliverAt: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`timed out awaiting the persisted Alarm send with deliver_at ${deliverAt}`),
      );
    }, SCHEDULE_SEND_CAP_MS);
    const pending = log.waiters.get(deliverAt) ?? [];
    pending.push(() => {
      clearTimeout(timer);
      resolve();
    });
    log.waiters.set(deliverAt, pending);
  });
}

/**
 * Exact completion seam for the entity's forked DeliverAt forward (#1254 r4
 * M2, replacing the sqlite poll): resolves once the REAL persisted
 * `{discard: true}` Alarm send carrying this `deliver_at` has COMPLETED —
 * installed Effect cluster/Runners.ts awaits `storage.saveRequest` before the
 * discard notification returns, so the envelope row is durable here. The
 * fixture's recorder is wired at cluster construction (before any arm) and
 * buffers completions, so no signal is lost. The mailbox is then inspected
 * exactly once.
 */
export async function awaitScheduled(catalogFile: string, deliverAt: number): Promise<void> {
  const log = persistedSends.get(catalogFile);
  if (log === undefined)
    throw new Error(`awaitScheduled outside withEntityAlarmPorts: ${catalogFile}`);
  if (!log.sent.has(deliverAt)) await awaitPersistedSend(log, deliverAt);
  if (!scheduledAt(catalogFile, deliverAt))
    throw new Error(
      `persisted Alarm send completed but no envelope carries deliver_at ${deliverAt}`,
    );
}

/** True when some Alarm envelope carries the given deliver_at (deny-path zero checks). */
export function scheduledAt(catalogFile: string, deliverAt: number): boolean {
  return clusterMessages(catalogFile, "Session").some(
    (row) => row.tag === "Alarm" && row.deliver_at === deliverAt,
  );
}
