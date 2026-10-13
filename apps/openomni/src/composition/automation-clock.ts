import type { ChannelError, GatewayRouter } from "@openomni/channels";
import { Effect, Schedule } from "effect";

/** The app scope owns this clock; router windows also recover on its first tick after boot. */
export function automationClock(
  router: Pick<GatewayRouter, "advance">,
  now: () => number,
  failure: (error: ChannelError) => void,
) {
  return Effect.suspend(() => router.advance(now())).pipe(
    Effect.catch((error) => Effect.sync(() => failure(error))),
    Effect.repeat(Schedule.spaced("1 second")),
    Effect.asVoid,
  );
}
