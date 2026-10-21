import { Bundle } from "@oni/agent";
import { Cron } from "@oni/protocol";
import { Effect } from "effect";
import { z } from "zod";

/**
 * The `cron` bundle (#1255, purposes from #1254): one `cron.tick` purpose
 * over the alarm capability (the `requires: alarm` edge is compose's
 * mechanics). A tick wakes with its grid time; the handler prompts once
 * (carrying the count of grid times missed while the host was down — there
 * is no catch-up storm), then re-arms the chain at the next grid time with
 * `supersedes`. State is the chain; nothing rides process memory.
 */
export const CRON_TICK = "cron.tick";
export const CRON_SOURCE = "cron";

/** The arm payload a cron chain carries from arm to arm. */
export const CronPayload = z
  .object({
    expr: z.string().min(1),
    tz: z.string().min(1),
    description: z.string(),
  })
  .strict();
export type CronPayload = z.infer<typeof CronPayload>;

function cronTick(prompt?: Bundle.WatchWakeDeps["prompt"]): Bundle.AlarmPurposeHandler {
  return ({ fired, ctx }) =>
    Effect.gen(function* () {
      const payload = yield* Effect.try({
        try: () => CronPayload.parse(JSON.parse(fired.payload)),
        catch: () => new Bundle.AlarmWakeError({ purpose: fired.purpose, reason: "payload" }),
      });
      const grid = yield* Effect.try({
        try: () => ({
          /** Grid instants in (fireAt, now] lost to downtime, capped with a saturation flag. */
          missed: Cron.missed(payload.expr, fired.fireAt, ctx.now, payload.tz),
          next: Cron.next(payload.expr, Math.max(ctx.now, fired.fireAt), payload.tz),
        }),
        catch: () => new Bundle.AlarmWakeError({ purpose: fired.purpose, reason: "cron_expr" }),
      });
      const input = {
        content: JSON.stringify({
          kind: CRON_TICK,
          description: payload.description,
          expr: payload.expr,
          firedAt: fired.fireAt,
          // Saturated means "at least this many" — the note says so to the model.
          missed: grid.missed.count,
          missedSaturated: grid.missed.saturated,
          ...(grid.missed.saturated
            ? { note: `at least ${grid.missed.count} grid instants missed (count saturated)` }
            : {}),
        }),
        payload: {
          expr: payload.expr,
          missed: grid.missed.count,
          missedSaturated: grid.missed.saturated,
        },
      };
      yield* prompt === undefined ? ctx.prompt(input) : prompt(fired, ctx, input);
      yield* ctx
        .arm({
          purpose: CRON_TICK,
          at: grid.next,
          alarmId: fired.alarmId,
          supersedes: fired.occurrenceId,
          sourceKey: CRON_SOURCE,
          payload,
        })
        .pipe(
          Effect.mapError(
            (refused) =>
              new Bundle.AlarmWakeError({ purpose: fired.purpose, reason: refused.code }),
          ),
        );
      return "delivered" as const;
    });
}

/** The cron bundle's purpose declaration for the capability composition. */
export function cronPurposes(prompt?: Bundle.WatchWakeDeps["prompt"]): Bundle.AlarmBundlePurposes {
  return { bundle: "cron", purposes: [{ name: CRON_TICK, handler: cronTick(prompt) }] };
}

/** The `cron` bundle contract (#1255 `Bundle.define`): the one tick purpose, no tools, no rows. */
export function cronBundle(prompt?: Bundle.WatchWakeDeps["prompt"]): Bundle.BundleContract<"cron", object, Bundle.AlarmPurposeHandler> {
  return Bundle.define({
    name: "cron",
    requires: [Bundle.AlarmPort],
    purposes: { [CRON_TICK]: cronTick(prompt) },
  });
}
