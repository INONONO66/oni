import { Ingress } from "@oni/protocol";
import { z } from "zod";

export const PendingGroup = z.object({
  ruleId: z.string(), key: z.string(), openedAt: z.number(),
  windowSeconds: Ingress.WindowSeconds, when: Ingress.Rule.shape.when,
  inputs: z.array(Ingress.Message).min(1).max(64),
  verdict: Ingress.MatchContext.shape.verdict,
});
export type PendingGroup = z.infer<typeof PendingGroup>;

const RouteFields = Ingress.Rule.shape.outcome.options[2].omit({ kind: true, deliveryKind: true }).extend({
  ruleId: z.string(), target: z.string(), newSession: z.boolean(), conversation: z.boolean(),
});
export const Route = z.discriminatedUnion("kind", [
  RouteFields.extend({ kind: z.literal("prompt"), origin: Ingress.Message }),
  RouteFields.extend({ kind: z.literal("action"), source: z.literal("ingress"),
    handlerRef: z.string(), body: Ingress.MatchContext }),
]);
export type Route = z.infer<typeof Route>;

export function scheduleTickChannel(cron: string): string {
  return `cron:${cron}`;
}
