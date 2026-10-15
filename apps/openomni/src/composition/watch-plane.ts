import { Effect } from "effect";
import { Core, Bundle } from "@openomni/agent";
import { parseJson } from "@openomni/protocol";
import { z } from "zod";
import { AppInvariantError } from "../invariant";
import { cronPurposes } from "../bundles/alarms/cron/index";
import { delegationPurposes, type DelegationDeadlineDeps } from "../bundles/delegation-policy/index";
import { monitorPurposes, type MonitorWakeDeps } from "../bundles/alarms/monitor/index";
import { createLiveArmRegistry, type LiveArmRegistry } from "../bundles/alarms/index";
import type { WatchSources } from "./watch-sources";
import type { AlarmIngress } from "./automation-alarm";
import { CHILD_WATCH, ChildWatch, childActivityPurposes } from "../bundles/child-activity/index";

/** The native-source alarm plane and its per-activation capability. */
export interface WatchPlane {
  readonly contract: Bundle.CapabilityDefinition<"alarm">;
  readonly wake: MonitorWakeDeps;
  readonly arms: LiveArmRegistry;
  readonly bind: (sources: WatchSources) => void;
  readonly capabilityFor: (
    onBundles: readonly string[],
  ) => Effect.Effect<Bundle.AlarmCapabilityDefinition, Bundle.AlarmComposeError>;
  readonly sendOccurrence: (
    deliver: (sessionId: string, occurrence: AlarmOccurrence) => Effect.Effect<void, Core.AlarmSendRefused>,
  ) => (sessionId: string, occurrence: AlarmOccurrence) => Effect.Effect<void, Core.AlarmSendRefused>;
  readonly onArmed: (notice: Core.AlarmArmNotice) => void;
  readonly retirePath: (sessionId: string, watchId: string) => Effect.Effect<void, Core.ArmRefused>;
  readonly installChild: (spec: ChildWatch, enabled?: boolean) => Effect.Effect<void, Bundle.WatchRefused>;
}

interface AlarmOccurrence {
  readonly occurrenceId: string;
  readonly purpose: string;
  readonly alarmId: string;
  readonly armSeq: number;
  readonly sourceKey: string;
  readonly payload: string;
  readonly fireAt: number;
  /** The moved time of a quiet re-send; absent on a committed occurrence. */
  readonly tick?: number;
}

const WatchCadencePayload = z.object({ watchId: z.string().min(1), child: ChildWatch.optional() }).strict();
const WATCH_CADENCE_MS = 1_000;

export function createWatchPlane(
  deps: { readonly delegation?: DelegationDeadlineDeps; readonly ingress?: AlarmIngress } = {},
): WatchPlane {
  let sources: WatchSources | undefined;
  const liveArms = new Map<string, Core.ArmVerb>();
  const cadence = new Map<string, { readonly occurrenceId: string; readonly purpose: string }>();
  const cadenceId = (watchId: string) => `${watchId}:watch`;
  const cadenceSource = (watchId: string) => `watch:${watchId}`;
  const live = (): WatchSources => {
    if (sources === undefined) throw new AppInvariantError("watch sources used before boot bound them");
    return sources;
  };
  const retirePath = (sessionId: string, watchId: string): Effect.Effect<void, Core.ArmRefused> =>
    Effect.suspend(() => {
      const latest = cadence.get(`${sessionId}:${watchId}`);
      const arm = liveArms.get(sessionId);
      if (latest === undefined || arm === undefined) return Effect.void;
      return arm({
        purpose: latest.purpose,
        at: null,
        alarmId: cadenceId(watchId),
        supersedes: latest.occurrenceId,
        sourceKey: cadenceSource(watchId),
        payload: { watchId },
      }).pipe(Effect.tap(() => Effect.sync(() => cadence.delete(`${sessionId}:${watchId}`))), Effect.asVoid);
    });
  const armCadence = (sessionId: string, watchId: string, child?: ChildWatch): Effect.Effect<void, Core.ArmRefused> =>
    Effect.gen(function* () {
      const arm = liveArms.get(sessionId);
      if (arm === undefined) return yield* new Core.ArmRefused({ code: "not_live" });
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      yield* arm({
        purpose: child === undefined ? "watch" : CHILD_WATCH,
        at: now + WATCH_CADENCE_MS,
        alarmId: cadenceId(watchId),
        sourceKey: cadenceSource(watchId),
        payload: { watchId, ...(child === undefined ? {} : { child }) },
      });
    });
  const restoreChild = (payload: z.infer<typeof WatchCadencePayload>, sessionId: string, purpose: string) =>
    Effect.gen(function* () {
      const child = payload.child;
      if (child === undefined) return;
      if (child.sessionId !== sessionId || child.id !== payload.watchId || purpose !== CHILD_WATCH)
        return yield* new Bundle.AlarmWakeError({ purpose, reason: "payload" });
      const restore = live().restoreChild;
      if (restore === undefined)
        return yield* new Bundle.AlarmWakeError({ purpose, reason: "source_missing" });
      yield* Effect.sync(() => restore(child));
    });
  const wake: MonitorWakeDeps = {
    close: (watchId) => void live().close(watchId),
    ...(deps.ingress === undefined ? {} : { prompt: deps.ingress }),
    cadence: ({ fired, ctx }) =>
      Effect.gen(function* () {
        const payload = parseJson(WatchCadencePayload, fired.payload);
        if (payload === undefined || fired.alarmId !== cadenceId(payload.watchId) ||
            fired.sourceKey !== cadenceSource(payload.watchId))
          return yield* new Bundle.AlarmWakeError({ purpose: fired.purpose, reason: "payload" });
        const latest = ctx.reads.latestArm(fired.alarmId);
        if (latest?.occurrenceId !== fired.occurrenceId || latest.at === null)
          return "exhausted" as const;
        yield* restoreChild(payload, ctx.sessionId, fired.purpose);
        const observed = yield* Effect.sync(() => sources?.observe(ctx.sessionId, payload.watchId) ?? false);
        // Reconcile only queues native hits; their monitor.hit occurrence owns
        // delivery and drain. A cadence tick itself never delivers a prompt:
        // while the source is live the tick is quiet (the core moves the
        // same occurrence forward, no rows); a gone source retires the chain.
        if (observed) return { outcome: "quiet" as const, at: ctx.now + WATCH_CADENCE_MS };
        yield* ctx.arm({
          purpose: fired.purpose,
          at: null,
          alarmId: fired.alarmId,
          supersedes: fired.occurrenceId,
          sourceKey: fired.sourceKey,
          payload,
        }).pipe(Effect.mapError((refused) =>
          new Bundle.AlarmWakeError({ purpose: fired.purpose, reason: refused.code }),
        ));
        return "exhausted" as const;
      }),
  };
  const registry = createLiveArmRegistry();
  const arms: LiveArmRegistry = {
    ...registry,
    onLive: (sessionId, verbs) => {
      liveArms.set(sessionId, verbs.arm);
      const release = registry.onLive(sessionId, verbs);
      return () => {
        if (liveArms.get(sessionId) === verbs.arm) liveArms.delete(sessionId);
        release();
      };
    },
  };
  const declared: readonly Bundle.AlarmBundlePurposes[] = [
    monitorPurposes(wake),
    ...(wake.cadence === undefined ? [] : [childActivityPurposes(wake.cadence)]),
    cronPurposes(deps.ingress),
    delegationPurposes(
      deps.delegation ?? {
        cancel: () => Effect.fail({ reason: "outbound cancel door is not composed" }),
      },
    ),
  ];
  const watch: Bundle.WatchInstallDeps = {
    install: ({ sessionId, watchId, spec, occurrence }) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () =>
            live().install({ sessionId, id: watchId, occurrence, base: { spec, notifications: 0 } }),
          catch: (error) =>
            new Bundle.WatchRefused({ reason: error instanceof Error ? error.message : String(error) }),
        });
        if (!("path" in spec.watch)) return;
        yield* armCadence(sessionId, watchId).pipe(
          Effect.mapError((refused) => new Bundle.WatchRefused({ reason: refused.code })),
        );
      }),
  };
  const capabilityFor = (onBundles: readonly string[]) =>
    Bundle.alarmCapability({
      bundles: declared.filter((declaration) => onBundles.includes(declaration.bundle)),
      watch,
      arm: arms.arm,
    });
  const contract = Bundle.alarmContract({ purposes: {}, arm: arms.arm, watch });
  const installFromOccurrence = (
    sessionId: string,
    occurrence: AlarmOccurrence,
  ): Effect.Effect<void, Core.AlarmSendRefused> =>
    Effect.suspend(() => {
      const payload = parseJson(Bundle.WatchHitPayload, occurrence.payload);
      if (payload === undefined)
        return Effect.fail(
          new Core.AlarmSendRefused({ reason: "native-source arm payload carries no watch spec" }),
        );
      const armed = {
        sessionId,
        id: occurrence.alarmId,
        occurrence: {
          occurrenceId: occurrence.occurrenceId,
          alarmId: occurrence.alarmId,
          armSeq: occurrence.armSeq,
        },
        base: { spec: payload.spec, notifications: payload.notifications },
      };
      if (live().refresh(armed)) return Effect.void;
      return Effect.tryPromise({
        try: () => live().install(armed),
        catch: (error) =>
          new Core.AlarmSendRefused({
            reason: error instanceof Error ? error.message : String(error),
          }),
      }).pipe(Effect.flatMap(() =>
        "path" in payload.spec.watch
          ? armCadence(sessionId, occurrence.alarmId).pipe(
              Effect.mapError((refused) => new Core.AlarmSendRefused({ reason: refused.code })),
            )
          : Effect.void,
      ));
    });
  return {
    contract,
    wake,
    arms,
    retirePath,
    installChild: (spec, enabled = true) => Effect.gen(function* () {
      if (!enabled) return yield* new Bundle.WatchRefused({ reason: "disabled" });
      const install = live().installChild;
      if (install === undefined) return yield* new Bundle.WatchRefused({ reason: "source_missing" });
      yield* Effect.tryPromise({
        try: () => install(spec),
        catch: (error) => new Bundle.WatchRefused({ reason: String(error) }),
      });
      yield* armCadence(spec.sessionId, spec.id, spec).pipe(
        Effect.mapError((error) => new Bundle.WatchRefused({ reason: error.code })),
      );
    }),
    bind: (bound) => {
      if (sources !== undefined) throw new AppInvariantError("watch sources are already bound");
      sources = bound;
    },
    capabilityFor,
    sendOccurrence: (deliver) => (sessionId, occurrence) =>
      occurrence.purpose === Bundle.MONITOR_HIT
        ? installFromOccurrence(sessionId, occurrence)
        : deliver(sessionId, occurrence),
    onArmed: (notice) => {
      if (notice.purpose === "watch" || notice.purpose === CHILD_WATCH) {
        const payload = WatchCadencePayload.safeParse(notice.payload);
        if (payload.success && notice.at !== null)
          cadence.set(`${notice.sessionId}:${payload.data.watchId}`, { occurrenceId: notice.occurrenceId, purpose: notice.purpose });
        else if (payload.success)
          cadence.delete(`${notice.sessionId}:${payload.data.watchId}`);
        return;
      }
      if (notice.purpose !== Bundle.MONITOR_HIT) return;
      if (notice.at === null) {
        void live().close(notice.alarmId);
        return;
      }
      const payload = Bundle.WatchHitPayload.safeParse(notice.payload);
      if (!payload.success) return;
      live().refresh({
        sessionId: notice.sessionId,
        id: notice.alarmId,
        occurrence: {
          occurrenceId: notice.occurrenceId,
          alarmId: notice.alarmId,
          armSeq: notice.armSeq,
        },
        base: { spec: payload.data.spec, notifications: payload.data.notifications },
      });
    },
  };
}

/** A stable capability face over a recomposable holder. */
export function alarmCapabilityView(holder: {
  current: Bundle.AlarmCapabilityDefinition;
}): Bundle.AlarmCapabilityDefinition {
  return {
    name: "alarm",
    points: ["alarm.fired"],
    get definition() {
      return holder.current.definition;
    },
    get registry() {
      return holder.current.registry;
    },
    get purposes() {
      return holder.current.purposes;
    },
    wake: (fired, ctx) => holder.current.wake(fired, ctx),
    verbs: {
      arm: (sessionId, turnId) => (input) => holder.current.verbs.arm(sessionId, turnId)(input),
      watch: (input) => holder.current.verbs.watch(input),
    },
  };
}
