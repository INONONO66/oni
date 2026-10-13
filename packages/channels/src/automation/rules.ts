import { createHash } from "node:crypto";
import { Ingress } from "@openomni/protocol";

/** Pre-session rules share the matcher's input and ledger vocabulary. */
export function matchPerimeterRules(input: Ingress.Input, at: number): Ingress.RoutingDecisionPayload | undefined {
  const rule = input.author.isBot && input.surface !== "webhook" && input.surface !== "alarm" ? {
    reason: "bot_author", by: "rule/bot-author", factsUsed: ["author.isBot"],
  } : input.event === "reaction" ? {
    reason: "reaction_unrouted", by: "rule/reaction-unrouted", factsUsed: ["event"],
  } : undefined;
  if (rule === undefined) return undefined;
  return Ingress.Events.RoutingDecision.schema.parse({
    traceId: input.eventId, time: at, inboundId: input.eventId, surface: input.surface,
    mode: "direct", stage: "automation", outcome: "record", decision: "filtered",
    ...rule,
    factsDigest: createHash("sha256").update(input.eventId + input.surface).digest("hex"),
  });
}
