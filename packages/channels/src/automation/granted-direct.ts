import type { Gateway } from "@openomni/protocol";
import type { ChannelStores } from "../router/stores.js";
import { resolveChannelGrant } from "../router/channel-grant.js";

function currentGrant(stores: ChannelStores, event: Gateway.DeliveredEvent) {
  return resolveChannelGrant(stores, {
    surface: event.surface, workspace: event.workspace, channel: event.channel,
    ...(event.userId === undefined ? {} : { sender: event.userId }),
  });
}

/** Existing surface labels are migrated to records without changing their session id. */
export function grantedDirectSession(
  stores: ChannelStores, event: Gateway.DeliveredEvent, key: string,
): string | undefined {
  const sessionId = stores.surfaceKeys.lookup(key);
  if (sessionId === undefined || event.channel === undefined || event.userId === undefined)
    return sessionId;
  const grant = currentGrant(stores, event);
  if (grant === undefined || grant.inboundTreatment === "drop") return sessionId;
  const users = grant.grant.allowedSenders;
  return stores.automations.migrateGrantedDirect({
    surfaceKey: key, surface: event.surface, channelId: event.channel,
    ...(users === undefined ? {} : { users }), sessionId,
  }).target.slice("session:".length);
}

/** A new surface label is claimed once, then the record owns the routed target. */
export function claimGrantedDirect(
  stores: ChannelStores, event: Gateway.DeliveredEvent, key: string, candidate: string,
): string {
  const sessionId = stores.surfaceKeys.claim(key, candidate);
  if (event.channel === undefined || event.userId === undefined) return sessionId;
  const users = currentGrant(stores, event)?.grant.allowedSenders;
  return stores.automations.migrateGrantedDirect({
    surfaceKey: key, surface: event.surface, channelId: event.channel,
    ...(users === undefined ? {} : { users }), sessionId,
  }).target.slice("session:".length);
}
