import { createHash } from "node:crypto";
import { Ingress } from "@oni/protocol";

/** The surface grant's posture toward an inbound that does not address the Resident. */
export interface PerimeterPosture {
  /** The resolved grant carries `mentionOnly`. */
  readonly mentionOnly: boolean;
  /** The inbound addresses the Resident: DM, mention, reply to its message, or a thread it answers in. */
  readonly addressed: boolean;
}

/** Surfaces whose authors are automation by nature: neither the bot-echo rule nor the granted-direct automation's `includeBots: false` applies. */
export const BOT_AUTHORED_SURFACES: ReadonlySet<string> = new Set(["webhook", "alarm", "a2a"]);

/** Pre-session rules share the matcher's input and ledger vocabulary. */
export function matchPerimeterRules(
  input: Ingress.Input, at: number, posture?: PerimeterPosture,
): Ingress.RoutingDecisionPayload | undefined {
  // The bot-echo rule is for chat platforms. A webhook, an alarm and an A2A peer (#1569 lane 9c:
  // an agent admitted by its declared bearer, whose authority is its registered actor and tier)
  // are automation by nature and pass to the grant.
  const rule = input.author.isBot && !BOT_AUTHORED_SURFACES.has(input.surface) ? {
    reason: "bot_author", by: "rule/bot-author", factsUsed: ["author.isBot"],
  } : input.event === "reaction" ? {
    reason: "reaction_unrouted", by: "rule/reaction-unrouted", factsUsed: ["event"],
  } : posture?.mentionOnly === true && !input.dm && !posture.addressed ? {
    reason: "mention_only", by: "rule/mention-only", factsUsed: ["channel.mentionOnly", "dm", "mentionsBot"],
  } : undefined;
  if (rule === undefined) return undefined;
  return Ingress.Events.RoutingDecision.schema.parse({
    traceId: input.eventId, time: at, inboundId: input.eventId, surface: input.surface,
    mode: "direct", stage: "automation", outcome: "record", decision: "filtered",
    ...rule,
    factsDigest: createHash("sha256").update(input.eventId + input.surface).digest("hex"),
  });
}
