import { Effect } from "effect";
import type { Gateway } from "@openomni/protocol";
import type { ProviderTypingRoute } from "../provider/contract.js";

/** Refresh a provider's ephemeral indicator until the owning turn scope closes. */
export function typingPulse(
  route: ProviderTypingRoute,
  externalId: string,
  conversation?: Gateway.Conversation,
): Effect.Effect<never> {
  return Effect.forever(Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => route(externalId, conversation),
      catch: () => undefined,
    }).pipe(Effect.ignore);
    yield* Effect.sleep("4 seconds");
  }));
}
