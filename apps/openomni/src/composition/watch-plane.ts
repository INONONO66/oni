import { Effect } from "effect";
import { Core, Bundle } from "@openomni/agent";
import { parseJson } from "@openomni/protocol";
import { AppInvariantError } from "../invariant";
import { cronPurposes } from "../bundles/cron";
import { delegationPurposes, type DelegationDeadlineDeps } from "../bundles/delegation-policy";
import { monitorPurposes } from "../bundles/monitor";
import { createLiveArmRegistry, type LiveArmRegistry } from "./alarm-plane";
import type { WatchSources } from "./watch-sources";
import type { AlarmIngress } from "./automation-alarm";

/**
 * The native-source alarm plane (#1255 P3): everything that knows WHICH
 * bundles register alarm purposes and WHICH purpose rides a native source
 * instead of a time delivery lives here — `index.ts` composes through this
 * bundle-neutral seam and never names a bundle.
 *
 * Two alarm capability instances exist on purpose:
 * - `contract` carries NO purposes — the manifest's bundle contracts declare
 *   theirs, and `compose` rejects a duplicate purpose registration.
 * - `capabilityFor(onBundles)` is the LIVE wake router/arm guard, registering
 *   exactly the on-bundles' purposes (recomputed on every recompose).
 */
export interface WatchPlane {
  /** The purpose-free `Capability.define` contract the manifest lists. */
  readonly contract: Bundle.CapabilityDefinition<"alarm">;
  /** Wake deps the bundle contracts close over (late-bound to the live sources). */
  readonly wake: Bundle.WatchWakeDeps;
  /** #1254 H3: activations register their budgeted arm verbs here. */
  readonly arms: LiveArmRegistry;
  /** Binds the live native sources once boot creates them. */
  readonly bind: (sources: WatchSources) => void;
  /** Builds the live capability for one composed on-set. */
  readonly capabilityFor: (
    onBundles: readonly string[],
  ) => Effect.Effect<Bundle.AlarmCapabilityDefinition, Core.AlarmComposeError>;
  /**
   * #1254 S3/H2: resends one armed occurrence. A native-source purpose's send
   * is the source (re)install, never a time delivery; everything else goes
   * through the injected persisted DeliverAt door.
   */
  readonly sendOccurrence: (
    deliver: (
      sessionId: string,
      occurrence: AlarmOccurrence,
    ) => Effect.Effect<void, Core.AlarmSendRefused>,
  ) => (
    sessionId: string,
    occurrence: AlarmOccurrence,
  ) => Effect.Effect<void, Core.AlarmSendRefused>;
  /**
   * #1254 H1: post-commit arm notices — a native-source re-arm moves the live
   * handle onto the new occurrence; a retiring arm closes it. Other purposes
   * are time-delivered and take no native action.
   */
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
    // #1258: the delegation deadline purpose; the cancel door is injected by
    // the boot (entity deliver), fail-closed until bound.
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
      compose: Core.composeAlarmPurposes,
      watch,
      arm: arms.arm,
    });
  // The manifest's contract is purpose-free (bundles declare theirs) and
  // needs no registry: the raw arm verb is the live activation's own guard.
  const contract = Bundle.alarmContract({ purposes: {}, arm: arms.arm, watch });
  // #1254 H2: a `monitor.hit` send (activation resend or fresh-arm forward)
  // is the native-source plane's (re)install, never a time delivery: a live
  // holder adopts the occurrence; a missing one is installed from the
  // committed arm payload. An uninstallable or unparseable spec is the typed
  // PERMANENT refusal the entity answers by retiring the chain.
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

/**
 * A stable `AlarmCapabilityDefinition` face over a recomposable holder: the
 * monitor tool ports and the entity's capability port are wired once at boot,
 * while `provision{bundle_enable|bundle_disable}` swaps the composed instance
 * underneath (#1255 P4).
 */
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
