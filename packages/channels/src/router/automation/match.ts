import type { Ingress } from "@oni/protocol";
import { Effect } from "effect";
import type { ChannelError } from "../../errors.js";

export interface Match {
  readonly rule: Ingress.Rule;
  readonly factsUsed: readonly string[];
  readonly verdict?: "yes";
}

/** Rule order is policy. A failed or unavailable judgment never matches. */
export function match(
  message: Ingress.Message,
  rules: readonly Ingress.Rule[],
  judge?: (question: string, message: Ingress.Message) => Effect.Effect<"yes" | "no" | "unknown", ChannelError>,
): Effect.Effect<Match | undefined, ChannelError> {
  return Effect.gen(function* () {
    for (const rule of [...rules].sort((left, right) => left.position - right.position)) {
      const when = rule.when;
      if (!rule.enabled || when.instance !== message.instance ||
          (when.channel !== undefined && when.channel !== message.channelId) ||
          (when.dm !== undefined && when.dm !== message.dm) ||
          (when.event !== undefined && when.event !== (message.event === "reaction" ? "reaction" : "message")) ||
          (when.from?.includes(message.from ?? "") === false) ||
          (when.addressed !== undefined && when.addressed !== message.addressed) ||
          (when.isBot !== undefined && when.isBot !== message.author?.isBot)) continue;
      if (rule.judge !== undefined &&
          (judge === undefined || (yield* judge(rule.judge, message)) !== "yes")) continue;
      return { rule, factsUsed: Object.keys(when), ...(rule.judge === undefined ? {} : { verdict: "yes" as const }) };
    }
    return undefined;
  });
}
