import { Effect, Schema } from "effect";
import { parsePlainJson } from "../../core/api";
import { Alarm } from "@openomni/protocol";
import { z } from "zod";
import {
  AlarmWakeError,
  type ArmRefused,
  type AlarmFired,
  type AlarmWakeContext,
  type AlarmWakeOutcome,
  type ArmVerb,
} from "../../core/api";

/**
 * A watch is an armed alarm (`alarmId = watchId`, `sourceKey: "monitor"`)
 * whose payload carries the sealed spec and the wake budget spent so far;
 * re-arm is `arm` with `supersedes`, retire is an `at: null` arm.
 */

export const MONITOR_HIT = "monitor.hit";
export const MONITOR_TIMEOUT = "monitor.timeout";
export const MONITOR_SOURCE = "monitor";

export type AlarmPurposeHandler = (input: {
  readonly fired: AlarmFired;
  readonly ctx: AlarmWakeContext;
}) => Effect.Effect<AlarmWakeOutcome, AlarmWakeError>;

export interface AlarmPurposeDeclaration {
  readonly name: string;
  readonly handler: AlarmPurposeHandler;
}

/** `notifications` is the budget consumed by committed wakes; it rides the chain, not memory. */
export const WatchHitPayload = z
  .object({
    spec: Alarm.WatchSpec,
    notifications: z.number().int().nonnegative(),
    hit: z
      .object({
        content: z.string(),
        terminal: z.boolean(),
        /** Transport detail, never an id. */
        detail: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WatchHitPayload = z.infer<typeof WatchHitPayload>;

const WatchTimeoutPayload = z.object({ watchId: z.string().min(1) }).strict();

export class WatchRefused extends Schema.TaggedError<WatchRefused>(
  "@openomni/agent/plugins/alarm/WatchRefused",
)("WatchRefused", {
  reason: Schema.String,
}) {}

/** Origin `alarm` is fixed by the core. */
export type AlarmPromptVerb = AlarmWakeContext["prompt"];

export interface WatchWakeDeps {
  /** Fire-and-forget. */
  readonly close: (watchId: string) => void;
  /** Product routing for an observed wake; absent keeps the local prompt behavior. */
  readonly prompt?: (
    fired: AlarmFired,
    ctx: AlarmWakeContext,
    input: Parameters<AlarmPromptVerb>[0],
  ) => Effect.Effect<void, AlarmWakeError>;
}

function promptWake(deps: WatchWakeDeps, fired: AlarmFired, ctx: AlarmWakeContext, input: Parameters<AlarmPromptVerb>[0]) {
  return deps.prompt === undefined ? ctx.prompt(input).pipe(Effect.asVoid) : deps.prompt(fired, ctx, input);
}

/**
 * Settles only once the source has subscribed, so the watch verb returns after subscription and no
 * line between the tool's return and the subscribe is lost.
 */
export interface WatchInstallDeps {
  readonly install: (input: {
    readonly sessionId: string;
    readonly watchId: string;
    readonly spec: Alarm.WatchSpec;
    /** The cluster dedupes on it. */
    readonly occurrence: {
      readonly occurrenceId: string;
      readonly alarmId: string;
      readonly armSeq: number;
    };
  }) => Effect.Effect<void, WatchRefused>;
}

function parsePayload<S extends z.ZodType>(
  schema: S,
  fired: AlarmFired,
): Effect.Effect<z.infer<S>, AlarmWakeError> {
  return Effect.try({
    try: () => schema.parse(parsePlainJson(fired.payload)),
    catch: () => new AlarmWakeError({ purpose: fired.purpose, reason: "payload" }),
  });
}

function armToWake(fired: AlarmFired): (refused: ArmRefused) => AlarmWakeError {
  return (refused) => new AlarmWakeError({ purpose: fired.purpose, reason: refused.code });
}

function retire(
  ctx: AlarmWakeContext,
  fired: AlarmFired,
  alarmId: string,
  supersedes: string,
  reason: string,
): Effect.Effect<void, AlarmWakeError> {
  return ctx
    .arm({
      purpose: MONITOR_HIT,
      at: null,
      alarmId,
      supersedes,
      sourceKey: MONITOR_SOURCE,
      payload: { reason },
    })
    .pipe(Effect.mapError(armToWake(fired)), Effect.asVoid);
}

/** A settled watch leaves no armed row: retire the timeout companion while it is still armed. */
function retireTimeoutCompanion(
  ctx: AlarmWakeContext,
  fired: AlarmFired,
): Effect.Effect<void, AlarmWakeError> {
  const companionId = `${fired.alarmId}:timeout`;
  const companion = ctx.reads.latestArm(companionId);
  if (companion === undefined || companion.at === null) return Effect.void;
  return ctx
    .arm({
      purpose: MONITOR_TIMEOUT,
      at: null,
      alarmId: companionId,
      supersedes: companion.occurrenceId,
      sourceKey: MONITOR_SOURCE,
      payload: { watchId: fired.alarmId },
    })
    .pipe(Effect.mapError(armToWake(fired)), Effect.asVoid);
}

/**
 * Commit the wake prompt, then retire (terminal hit), exhaust (the core records
 * `fired{exhausted}`), or re-arm with `supersedes` and the spent budget.
 */
function monitorHit(deps: WatchWakeDeps): AlarmPurposeHandler {
  return ({ fired, ctx }) =>
    Effect.gen(function* () {
      const payload = yield* parsePayload(WatchHitPayload, fired);
      const hit = payload.hit;
      if (hit === undefined)
        return yield* new AlarmWakeError({ purpose: fired.purpose, reason: "missing_hit" });
      yield* promptWake(deps, fired, ctx, { content: hit.content, payload: { watchId: fired.alarmId, detail: hit.detail } });
      if (hit.terminal) {
        yield* retire(ctx, fired, fired.alarmId, fired.occurrenceId, "fired");
        yield* retireTimeoutCompanion(ctx, fired);
        deps.close(fired.alarmId);
        return "delivered" as const;
      }
      const notifications = payload.notifications + 1;
      if (notifications >= payload.spec.notificationLimit) {
        yield* retire(ctx, fired, fired.alarmId, fired.occurrenceId, "exhausted");
        yield* retireTimeoutCompanion(ctx, fired);
        deps.close(fired.alarmId);
        return "exhausted" as const;
      }
      yield* ctx
        .arm({
          purpose: MONITOR_HIT,
          at: ctx.now,
          alarmId: fired.alarmId,
          supersedes: fired.occurrenceId,
          sourceKey: MONITOR_SOURCE,
          payload: { spec: payload.spec, notifications },
        })
        .pipe(Effect.mapError(armToWake(fired)));
      return "delivered" as const;
    });
}

/** A settled main chain gets no prompt and no arm; it lapses `exhausted`, never woken again. */
function monitorTimeout(deps: WatchWakeDeps): AlarmPurposeHandler {
  return ({ fired, ctx }) =>
    Effect.gen(function* () {
      const payload = yield* parsePayload(WatchTimeoutPayload, fired);
      const latest = ctx.reads.latestArm(payload.watchId);
      if (latest === undefined || latest.at === null) return "exhausted" as const;
      yield* promptWake(deps, fired, ctx, {
        content: JSON.stringify({ watchId: payload.watchId, reason: "timeout" }),
        payload: { watchId: payload.watchId, reason: "timeout" },
      });
      yield* retire(ctx, fired, payload.watchId, latest.occurrenceId, "timeout");
      deps.close(payload.watchId);
      return "delivered" as const;
    });
}

export function watchPurposes(deps: WatchWakeDeps): readonly AlarmPurposeDeclaration[] {
  return [
    { name: MONITOR_HIT, handler: monitorHit(deps) },
    { name: MONITOR_TIMEOUT, handler: monitorTimeout(deps) },
  ];
}

export type WatchVerb = (input: {
  readonly sessionId: string;
  /** The arm authority check rides the calling turn's token. */
  readonly turnId: string;
  readonly watchId: string;
  readonly spec: Alarm.WatchSpec;
  readonly now: number;
}) => Effect.Effect<
  { readonly alarmId: string; readonly occurrenceId: string; readonly armSeq: number },
  ArmRefused | WatchRefused
>;

/** Best effort, never masking: a refused compensating retire is logged; the original wins. */
function retireCommitted(
  arm: ArmVerb,
  chain: {
    readonly purpose: string;
    readonly alarmId: string;
    readonly supersedes: string;
    readonly payload: Parameters<ArmVerb>[0]["payload"];
  },
): Effect.Effect<void> {
  return arm({
    purpose: chain.purpose,
    at: null,
    alarmId: chain.alarmId,
    supersedes: chain.supersedes,
    sourceKey: MONITOR_SOURCE,
    payload: chain.payload,
  }).pipe(
    Effect.asVoid,
    Effect.catch((refused) =>
      Effect.logWarning(`watch create compensation retire refused: ${chain.alarmId} (${refused.code})`),
    ),
  );
}

export function createWatchVerb(
  armFor: (sessionId: string, turnId: string) => ArmVerb,
  deps: WatchInstallDeps,
): WatchVerb {
  return (input) => {
    // Mint the authorizing arm when the verb is INVOKED, before any suspension:
    // the registry binds authority at mint time, so an effect executed after a
    // successor registered refuses `stale_activation` instead of committing
    // through it. This one verb authorizes the arms AND the retires below.
    const arm = armFor(input.sessionId, input.turnId);
    return Effect.gen(function* () {
      const parsed = Alarm.WatchSpec.safeParse(input.spec);
      if (!parsed.success)
        return yield* new WatchRefused({
          reason: parsed.error.issues[0]?.message ?? "invalid watch spec",
        });
      const spec = parsed.data;
      // Before the first commit succeeds nothing needs compensation.
      const main = yield* arm({
        purpose: MONITOR_HIT,
        at: input.now,
        alarmId: input.watchId,
        sourceKey: MONITOR_SOURCE,
        payload: { spec, notifications: 0 },
      });
      // A refusal anywhere past the first successful arm retires exactly the
      // chains that committed, so a partially created watch never stays armed
      // and the caller receives the ORIGINAL typed refusal.
      const committed: { timeout?: { alarmId: string; occurrenceId: string } } = {};
      const remainder = Effect.gen(function* () {
        if (spec.watch.timeout_ms !== undefined)
          committed.timeout = yield* arm({
            purpose: MONITOR_TIMEOUT,
            at: input.now + spec.watch.timeout_ms,
            alarmId: `${input.watchId}:timeout`,
            sourceKey: MONITOR_SOURCE,
            payload: { watchId: input.watchId },
          });
        // A chain whose native source never subscribed is retired, not left armed.
        yield* deps.install({
          sessionId: input.sessionId,
          watchId: input.watchId,
          spec,
          occurrence: main,
        });
      });
      yield* remainder.pipe(
        Effect.catch((refused) =>
          Effect.gen(function* () {
            yield* retireCommitted(arm, {
              purpose: MONITOR_HIT,
              alarmId: input.watchId,
              supersedes: main.occurrenceId,
              payload: { reason: refused instanceof WatchRefused ? "install" : "create" },
            });
            if (committed.timeout !== undefined)
              yield* retireCommitted(arm, {
                purpose: MONITOR_TIMEOUT,
                alarmId: committed.timeout.alarmId,
                supersedes: committed.timeout.occurrenceId,
                payload: { watchId: input.watchId },
              });
            return yield* Effect.fail(refused);
          }),
        ),
      );
      return main;
    });
  };
}
