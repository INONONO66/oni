import { createHash } from "node:crypto";
import { type Gateway, Ingress } from "@openomni/protocol";
import type { ChannelStores } from "./stores.js";
import { recordRouteDecided } from "./route-record.js";
import { inboundIdOf } from "./inbound-id.js";
import type { GatewayRouterPorts } from "./message-ports.js";

/** The fact paths a filter rule may cite; each reads its typed value off the facts object. */
const factReaders = {
  "author.isBot": (facts: Gateway.IngressFacts) => facts.author?.isBot,
  event: (facts: Gateway.IngressFacts) => facts.event,
} as const;
type FactPath = keyof typeof factReaders;
type FactValue = ReturnType<(typeof factReaders)[FactPath]>;

/** sha256 over a canonical (sorted-key) encoding of exactly the facts named in `factsUsed`. */
function factsDigestOf(facts: Gateway.IngressFacts, factsUsed: readonly FactPath[]): string {
  const subset: Partial<Record<FactPath, FactValue>> = {};
  for (const path of [...factsUsed].sort()) subset[path] = factReaders[path](facts);
  return createHash("sha256").update(JSON.stringify(subset)).digest("hex");
}

/** Record the intentional temporary ignore before routing can mint a session. */
export function filterIngress(
  stores: ChannelStores,
  facts: Gateway.IngressFacts,
  sink: GatewayRouterPorts["sink"],
  at: number,
  id: () => string,
): Gateway.IngestResult | undefined {
  // Webhook ingress always reports isBot: true (#1339 non-goal: no matcher
  // yet to tell a real automation from a bot-flagged webhook record), so the
  // bot_author rule is exempted for that surface until #1340 lands; see
  // pr-1410-body-notes.md.
  const reason =
    facts.author?.isBot === true && facts.surface !== "webhook"
      ? "bot_author"
      : facts.event === "reaction"
        ? "reaction_unrouted"
        : undefined;
  if (reason === undefined) return undefined;
  const inboundId = inboundIdOf(facts);
  const factsUsed: readonly FactPath[] = [reason === "bot_author" ? "author.isBot" : "event"];
  const decision = Ingress.Events.RoutingDecision.schema.parse({
    traceId: id(),
    time: at,
    inboundId,
    surface: facts.surface,
    mode: "direct",
    stage: "automation",
    outcome: "record",
    decision: "filtered",
    by: reason === "bot_author" ? "rule/bot-author" : "rule/reaction-unrouted",
    reason,
    factsUsed,
    factsDigest: factsDigestOf(facts, factsUsed),
  });
  const effective = recordRouteDecided(
    stores,
    Ingress.routeStreamId({
      surface: facts.surface,
      workspace: facts.workspaceId,
      channel: facts.channelId,
      id: inboundId,
    }),
    decision,
    at,
  );
  sink(Ingress.Events.RoutingDecision, effective);
  return { status: "blocked_pre", reasonCode: reason };
}
