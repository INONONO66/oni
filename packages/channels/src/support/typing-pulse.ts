import { Effect } from "effect";
import type { Gateway } from "@oni/protocol";
import type { ProviderTypingRoute } from "../provider/contract.js";

/**
 * Refresh a provider's ephemeral indicator until the owning turn scope closes:
 * the conversation is opened once, then pulsed on the provider's own cadence.
 * A refused open ends the pulse silently; a refused pulse skips one beat.
 */
export function typingPulse(
  route: ProviderTypingRoute,
  externalId: string,
  conversation?: Gateway.Conversation,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const opened = yield* Effect.tryPromise({
      try: () => route.open(externalId, conversation),
      catch: () => undefined,
    }).pipe(Effect.option);
    if (opened._tag === "None") return;
    yield* Effect.forever(Effect.gen(function* () {
      yield* Effect.tryPromise({ try: () => route.pulse(opened.value), catch: () => undefined }).pipe(Effect.ignore);
      yield* Effect.sleep(route.everyMs);
    }));
  });
}
