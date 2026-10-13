/**
 * #1348: per-test stubs for the pure alarm-capability suites (#1254 P1).
 * Every call mints fresh collectors (`calls`, `prompts`, `chains`); the
 * capability definition composes once per call through the real
 * `composeAlarmPurposes`, so nothing is cached across cases.
 */
import { Effect } from "effect";
import type { Alarm } from "@openomni/protocol";
import { composeAlarmPurposes } from "../../src/core/alarm";
import type { AlarmFired, AlarmWakeContext, ArmRefused, ArmVerb } from "../../src/core/api";
import {
  alarmCapability,
  MONITOR_HIT,
  MONITOR_SOURCE,
  MONITOR_TIMEOUT,
  watchPurposes,
  WatchRefused,
  type AlarmCapabilityDefinition,
} from "../../src/plugins/alarm";
import { runTestSync } from "./isolated";

export type ArmCall = Parameters<ArmVerb>[0];

/** In-test chain pages keyed by alarmId — the latest committed arm row per chain. */
export type ChainRows = Record<string, { occurrenceId: string; at: number | null }>;

export interface PromptCall {
  readonly content: string;
}

/** A persistent log watch allowing two notifications. */
export const WATCH_SPEC: Alarm.WatchSpec = {
  watch: { command: "tail -f log", description: "log watch", persistent: true },
  policyGeneration: 1,
  notificationLimit: 2,
};

/** The same budget over a one-minute timed build watch. */
export const TIMED_WATCH_SPEC: Alarm.WatchSpec = {
  ...WATCH_SPEC,
  watch: { command: "make build", description: "build watch", timeout_ms: 60_000 },
};

/** An arm verb recording every call; `refuse` fails every call, `chains` mirrors committed rows. */
export function stubArm(calls: ArmCall[], refuse?: ArmRefused, chains?: ChainRows): ArmVerb {
  return (input) => {
    if (refuse !== undefined) return Effect.fail(refuse);
    calls.push(input);
    const alarmId = input.alarmId ?? "minted-alarm";
    const occurrenceId = `occ-${calls.length}`;
    if (chains !== undefined) chains[alarmId] = { occurrenceId, at: input.at };
    return Effect.succeed({ alarmId, occurrenceId, armSeq: calls.length });
  };
}

/** A wake context over `session-1` at t=5000 whose prompts land in `prompts`. */
export function stubContext(input: {
  readonly arm: ArmVerb;
  readonly prompts?: PromptCall[];
  readonly chains?: ChainRows;
}): AlarmWakeContext {
  const prompts = input.prompts ?? [];
  return {
    sessionId: "session-1",
    reads: { latestArm: (alarmId) => input.chains?.[alarmId], settled: () => false },
    arm: input.arm,
    now: 5_000,
    prompt: ({ content }) =>
      Effect.sync(() => {
        prompts.push({ content });
        return { seq: prompts.length };
      }),
  };
}

/** One fired `monitor.hit` occurrence of `watch-1` (armSeq 7) with the given payload. */
export function fired(input: Partial<AlarmFired> & { readonly payload: string }): AlarmFired {
  return {
    occurrenceId: "occ-live",
    purpose: MONITOR_HIT,
    alarmId: "watch-1",
    armSeq: 7,
    sourceKey: MONITOR_SOURCE,
    fireAt: 4_000,
    ...input,
  };
}

/** The composed monitor capability over a stub arm; every collector is the caller's own. */
export function stubCapability(input: {
  readonly arm: ArmVerb;
  readonly closed?: string[];
  readonly installs?: string[];
  /** When set, every native install refuses with this reason. */
  readonly refuseInstall?: string;
  readonly extra?: readonly { readonly bundle: string; readonly purposes: readonly string[] }[];
}): AlarmCapabilityDefinition {
  const closed = input.closed ?? [];
  return runTestSync(
    alarmCapability({
      bundles: [
        { bundle: "monitor", purposes: watchPurposes({ close: (watchId) => closed.push(watchId) }) },
        ...(input.extra ?? []).map((declaration) => ({
          bundle: declaration.bundle,
          purposes: declaration.purposes.map((name) => ({
            name,
            handler: () => Effect.succeed("delivered" as const),
          })),
        })),
      ],
      compose: composeAlarmPurposes,
      arm: () => input.arm,
      watch: {
        install: ({ watchId }) =>
          input.refuseInstall === undefined
            ? Effect.sync(() => {
                (input.installs ?? []).push(watchId);
              })
            : Effect.fail(new WatchRefused({ reason: input.refuseInstall })),
      },
    }),
  );
}

/** Wake the definition with a `monitor.hit` payload: the watch spec, the count so far, and the native hit. */
export function wakeHit(
  definition: AlarmCapabilityDefinition,
  body: {
    readonly spec?: Alarm.WatchSpec;
    readonly notifications: number;
    readonly hit?: { readonly content: string; readonly terminal: boolean; readonly detail: string };
  },
  context: AlarmWakeContext,
) {
  return definition.wake(fired({ payload: JSON.stringify({ spec: WATCH_SPEC, ...body }) }), context);
}

/** Fresh collectors plus a stub capability whose source closes land in `closed`. */
function wakeCollectors() {
  const closed: string[] = [];
  const calls: ArmCall[] = [];
  const prompts: PromptCall[] = [];
  return { closed, calls, prompts, definition: stubCapability({ arm: stubArm([]), closed }) };
}

/** Runs one `monitor.hit` wake of a fresh stub capability over `chains`; returns the outcome with every collector. */
export function hitOutcome(body: Parameters<typeof wakeHit>[1], chains?: ChainRows) {
  const { closed, calls, prompts, definition } = wakeCollectors();
  const outcome = runTestSync(
    wakeHit(definition, body, stubContext({ arm: stubArm(calls, undefined, chains), prompts, chains })),
  );
  return { outcome, calls, closed, prompts };
}

/** Runs one `monitor.timeout` wake of a fresh stub capability over `chains`; returns the outcome with every collector. */
export function timeoutOutcome(chains: ChainRows) {
  const { closed, calls, prompts, definition } = wakeCollectors();
  const outcome = runTestSync(wakeTimeout(definition, stubContext({ arm: stubArm(calls), prompts, chains })));
  return { outcome, calls, closed, prompts };
}

/** Wake the definition with the `monitor.timeout` companion of `watch-1`. */
function wakeTimeout(definition: AlarmCapabilityDefinition, context: AlarmWakeContext) {
  return definition.wake(
    fired({
      purpose: MONITOR_TIMEOUT,
      alarmId: "watch-1:timeout",
      payload: JSON.stringify({ watchId: "watch-1" }),
    }),
    context,
  );
}

/** Arm `watch-9` on turn-1 of session-1 at t=1000 under `spec`. */
export function watchVerb(definition: AlarmCapabilityDefinition, spec: Alarm.WatchSpec = TIMED_WATCH_SPEC) {
  return definition.verbs.watch({ sessionId: "session-1", turnId: "turn-1", watchId: "watch-9", spec, now: 1_000 });
}
