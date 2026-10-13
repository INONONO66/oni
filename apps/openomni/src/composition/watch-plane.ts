import { Effect } from "effect";
import { Core, Bundle } from "@openomni/agent";
import { parseJson } from "@openomni/protocol";
import { AppInvariantError } from "../invariant";
import { cronPurposes } from "../bundles/alarms/cron/index";
import { delegationPurposes, type DelegationDeadlineDeps } from "../bundles/delegation-policy/index";
import { monitorPurposes } from "../bundles/alarms/monitor/index";
import { createLiveArmRegistry, type LiveArmRegistry } from "../bundles/alarms/index";
import type { WatchSources } from "./watch-sources";
import type { AlarmIngress } from "./automation-alarm";

/** The native-source alarm plane and its per-activation capability. */
export interface WatchPlane {
  readonly contract: Bundle.CapabilityDefinition<"alarm">;
  readonly wake: Bundle.WatchWakeDeps;
  readonly arms: LiveArmRegistry;
  readonly bind: (sources: WatchSources) => void;
  readonly capabilityFor: (
    onBundles: readonly string[],
  ) => Effect.Effect<Bundle.AlarmCapabilityDefinition, Bundle.AlarmComposeError>;
  readonly sendOccurrence: (
    deliver: (sessionId: string, occurrence: AlarmOccurrence) => Effect.Effect<void, Core.AlarmSendRefused>,
  ) => (sessionId: string, occurrence: AlarmOccurrence) => Effect.Effect<void, Core.AlarmSendRefused>;
  readonly onArmed: (notice: Core.AlarmArmNotice) => void;
}

interface AlarmOccurrence {
  readonly occurrenceId: string;
  readonly purpose: string;
  readonly alarmId: string;
  readonly armSeq: number;
  readonly sourceKey: string;
  readonly payload: string;
  readonly fireAt: number;
}

export function createWatchPlane(
  deps: { readonly delegation?: DelegationDeadlineDeps; readonly ingress?: AlarmIngress } = {},
): WatchPlane {
  let sources: WatchSources | undefined;
  const live = (): WatchSources => {
    if (sources === undefined) throw new AppInvariantError("watch sources used before boot bound them");
    return sources;
  };
  const wake: Bundle.WatchWakeDeps = {
    close: (watchId) => void live().close(watchId),
    ...(deps.ingress === undefined ? {} : { prompt: deps.ingress }),
  };
  const arms = createLiveArmRegistry();
  const declared: readonly Bundle.AlarmBundlePurposes[] = [
    monitorPurposes(wake),
    cronPurposes(deps.ingress),
    delegationPurposes(
      deps.delegation ?? {
        cancel: () => Effect.fail({ reason: "outbound cancel door is not composed" }),
      },
    ),
  ];
  const watch: Bundle.WatchInstallDeps = {
    install: ({ sessionId, watchId, spec, occurrence }) =>
      Effect.tryPromise({
        try: () =>
          live().install({ sessionId, id: watchId, occurrence, base: { spec, notifications: 0 } }),
        catch: (error) =>
          new Bundle.WatchRefused({ reason: error instanceof Error ? error.message : String(error) }),
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
      });
    });
  return {
    contract,
    wake,
    arms,
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
