import type { Gateway } from "@oni/protocol";
import type { ChannelStores } from "../stores.js";

/** Existing surface labels are migrated to records without changing their session id. */
export function grantedDirectSession(
  stores: ChannelStores, event: Gateway.DeliveredEvent, key: string,
): string | undefined {
  const sessionId = stores.surfaceKeys.lookup(key);
  if (sessionId === undefined || event.channel === undefined || event.userId === undefined)
    return sessionId;
  return stores.automations.migrateGrantedDirect({
    surfaceKey: key, surface: event.surface, channelId: event.channel,
    sessionId,
  }).target.slice("session:".length);
}

/** A new surface label is claimed once, then the record owns the routed target. */
export function claimGrantedDirect(
  stores: ChannelStores, event: Gateway.DeliveredEvent, key: string, candidate: string,
): string {
  const sessionId = stores.surfaceKeys.claim(key, candidate);
  if (event.channel === undefined || event.userId === undefined) return sessionId;
  return stores.automations.migrateGrantedDirect({
    surfaceKey: key, surface: event.surface, channelId: event.channel,
    sessionId,
  }).target.slice("session:".length);
}
