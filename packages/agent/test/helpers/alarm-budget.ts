import { Effect } from "effect";
import type { ArmVerb } from "../../src/core/alarm";
import { type AlarmComposeError, alarmCapability, watchPurposes, type AlarmCapabilityDefinition, type WatchInstallDeps } from "../../src/plugins/alarm";
import type { TestClusterOptions } from "./cluster-runtime";

export interface LiveArmRegistry {
  readonly verbs: Map<string, ArmVerb>;
  readonly onLive: NonNullable<TestClusterOptions["onLive"]>;
  readonly arm: (sessionId: string) => ArmVerb;
  readonly live: (sessionId: string) => Effect.Effect<ArmVerb>;
}

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
  readonly installs: string[];
  readonly closed: string[];
}

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
    arm: registry.arm,
    watch: { install },
  }).pipe(Effect.map((definition) => ({ definition, installs, closed })));
}
