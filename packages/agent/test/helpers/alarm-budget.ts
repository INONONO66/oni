/**
 * #1348: per-test fixtures for the armed-alarm budget suites. Each call mints
 * a FRESH live-activation registry (the app-side `onLive` shape of #1254 H3)
 * and fresh collectors, so two consecutive acquisitions share nothing.
 */
import { Effect } from "effect";
import { type AlarmComposeError, composeAlarmPurposes, type ArmVerb } from "../../src/core/alarm";
import { alarmCapability, watchPurposes, type AlarmCapabilityDefinition, type WatchInstallDeps } from "../../src/plugins/alarm";
import type { TestClusterOptions } from "./cluster-runtime";

export interface LiveArmRegistry {
  /** The live activations' budgeted arm verbs, keyed by session id. */
  readonly verbs: Map<string, ArmVerb>;
  /** The cluster option that fills and empties `verbs` around each activation. */
  readonly onLive: NonNullable<TestClusterOptions["onLive"]>;
  /** The capability-side arm port: delegates to the live verb, defects when none is live. */
  readonly arm: (sessionId: string) => ArmVerb;
  /** The live verb of one session, as a typed defect when the activation is gone. */
  readonly live: (sessionId: string) => Effect.Effect<ArmVerb>;
}

/** A fresh H3 registry: activations hand their arm verb in; the capability delegates. */
export function liveArmRegistry(): LiveArmRegistry {
  const verbs = new Map<string, ArmVerb>();
  const live = (sessionId: string): Effect.Effect<ArmVerb> =>
    Effect.suspend(() => {
      const verb = verbs.get(sessionId);
      return verb === undefined
        ? Effect.die(new Error(`no live activation for ${sessionId}`))
        : Effect.succeed(verb);
    });
  return {
    verbs,
    onLive: (sessionId, activation) => {
      verbs.set(sessionId, activation.arm);
      return () => {
        verbs.delete(sessionId);
      };
    },
    arm: (sessionId) => (input) => live(sessionId).pipe(Effect.flatMap((verb) => verb(input))),
    live,
  };
}

export interface LiveWatchCapability {
  readonly definition: AlarmCapabilityDefinition;
  /** Watch ids whose native install ran, in order. */
  readonly installs: string[];
  /** Watch ids the handlers closed, in order. */
  readonly closed: string[];
}

/**
 * The monitor bundle composed over a live registry with fresh `installs` and
 * `closed` collectors; `install` defaults to recording the watch id.
 */
export function liveWatchCapability(
  registry: LiveArmRegistry,
  options: { readonly install?: WatchInstallDeps["install"] } = {},
): Effect.Effect<LiveWatchCapability, AlarmComposeError> {
  const installs: string[] = [];
  const closed: string[] = [];
  const install: WatchInstallDeps["install"] =
    options.install ??
    (({ watchId }) =>
      Effect.sync(() => {
        installs.push(watchId);
      }));
  return alarmCapability({
    bundles: [
      {
        bundle: "monitor",
        purposes: watchPurposes({
          close: (watchId) => {
            closed.push(watchId);
          },
        }),
      },
    ],
    compose: composeAlarmPurposes,
    arm: registry.arm,
    watch: { install },
  }).pipe(Effect.map((definition) => ({ definition, installs, closed })));
}
