import type { Gateway } from "@openomni/protocol";
import type { PerimeterPosture } from "../../automation/rules.js";
import type { ChannelStores } from "../stores.js";
import { type ingressInput, ingressSurfaceKey } from "./input.js";

/**
 * The surface grant's mention-only posture for one inbound. "Addressed"
 * widens the matcher's mention fact with the two ways a reader addresses a
 * bot without naming it: quoting its message, or writing into a thread the
 * Resident already answers in (a thread label the surface map knows). A
 * channel label alone never counts, or one mention would open the channel.
 */
export function mentionOnlyPosture(
  stores: ChannelStores,
  facts: Gateway.IngressFacts,
  ingress: ReturnType<typeof ingressInput>,
): PerimeterPosture {
  const quotesResident = facts.context?.quoted?.author === "assistant";
  const answeredThread = facts.reply?.threadId !== undefined &&
    stores.surfaceKeys.lookup(ingressSurfaceKey(facts)) !== undefined;
  return {
    mentionOnly: ingress.channel?.grant.mentionOnly === true,
    addressed: ingress.addressed || quotesResident || answeredThread,
  };
}
