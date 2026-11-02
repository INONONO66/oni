import type { ProviderTypingRoute } from "@oni/channels";
import type { Channel } from "@oni/protocol";

/**
 * Typing follows the originating instance. An Owner instance that does not
 * auto-reply never pulses: the answer is a draft, and a pulse would promise one.
 */
export function typingRouteFor(
  routes: ReadonlyMap<string, ProviderTypingRoute>,
  autoReplies: ReadonlySet<string>,
  instances: ReadonlyMap<string, Channel.Instance>,
): (surface: string) => ProviderTypingRoute | undefined {
  return (surface) => {
    const instance = instances.get(surface);
    return instance?.identity === "bot" || autoReplies.has(surface) ? routes.get(surface) : undefined;
  };
}
