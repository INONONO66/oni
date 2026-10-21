import type { ProviderTypingRoute } from "@oni/channels";

/**
 * The route a turn's typing pulse rides (#1569; #1600 lane R3): the
 * platform's bot instance, else its identity-less surface, else — where the
 * platform is reached only through an Owner account whose declaration
 * auto-replies, so the answer will leave as that account — the Owner
 * instance. An Owner instance that does not auto-reply never pulses: the
 * answer is a draft, and a pulse would promise one.
 */
export function typingRouteFor(
  routes: ReadonlyMap<string, ProviderTypingRoute>,
  autoReplies: ReadonlySet<string>,
): (surface: string) => ProviderTypingRoute | undefined {
  return (surface) =>
    routes.get(`${surface}:bot`) ??
    routes.get(surface) ??
    (autoReplies.has(`${surface}:owner`) ? routes.get(`${surface}:owner`) : undefined);
}
