import type { Actor } from "@oni/protocol";
import { ledger, resetLedger } from "./ledger";

export function resetGrantStore(): void {
  resetLedger();
}

export function registerChannelGrant(overrides: Partial<Actor.ChannelGrant> = {}): void {
  ledger().stores.channelGrants.put({
    id: "grant",
    surface: "discord",
    kind: "trusted_channel",
    createdBy: "owner",
    ...overrides,
  });
}
