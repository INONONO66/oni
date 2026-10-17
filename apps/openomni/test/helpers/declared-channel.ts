import { Vault } from "@openomni/channels";
import { createAppLedger } from "./ledger";
import type { KekResolution } from "../../src/bundles/provision/vault-key";
import { putChannelCredential } from "./channel-credential";
import { testClock } from "./test-entropy";

/**
 * Seed the same declaration and sealed credential consumed by real app boot.
 * Returns the resolved vault key the booting config must carry (#1245: the
 * composition root resolves the key once at config load, never from the
 * ambient environment at mount time).
 */
export function declareChannel(
  catalogPath: string,
  provider: "telegram" | "github" | "linear" | "a2a",
  credentials: Record<string, string>,
  /** #1569: an Owner-identity row with its posture; the default is the bot row every earlier test declares. */
  owner?: { readonly settings: Record<string, string | number | boolean>; readonly outbound?: boolean },
  /** The bot row's slug: a second declaration of one provider (an a2a peer) names its own. */
  slug = "main",
): KekResolution {
  const key = new Uint8Array(32).fill(7);
  const plane = createAppLedger({ now: testClock(), catalogPath });
  try {
    const credentialRef = `secret:${provider}-${owner === undefined ? slug : "owner"}`;
    putChannelCredential(plane.stores.secrets, credentialRef, JSON.stringify(credentials), key, 1);
    plane.stores.instances.put({
      id: `channel:${provider}:${owner === undefined ? slug : "owner"}`,
      provider,
      identity: owner === undefined ? "bot" : "owner",
      enabled: true,
      settings: owner?.settings ?? {},
      credentialRef,
      ...(owner?.outbound === undefined ? {} : { grant: { outbound: owner.outbound } }),
      revision: 0,
      createdBy: "owner",
      updatedAt: 1,
    });
  } finally {
    plane.close();
  }
  return { kind: "ok", kek: Vault.kekOf(key) };
}

/**
 * Seed one Person the way `contact_add` would (#1569 lane 9c): boot
 * materializes it as the actor its endpoints name, at its tier.
 */
export function declarePerson(
  catalogPath: string | undefined,
  person: {
    readonly id: string;
    readonly displayName: string;
    readonly kind: "human" | "ai_agent" | "service";
    readonly trustTier: "owner" | "co_owner" | "manager" | "collaborator" | "observer" | "assigned_worker";
    readonly endpoints: readonly { readonly channel: string; readonly externalId: string }[];
    /** #1569 lane 8: the Owner's standing grant to be written to cold. */
    readonly reach?: boolean;
  },
): void {
  if (catalogPath === undefined) throw new Error("suite config is missing catalogPath");
  const plane = createAppLedger({ now: testClock(), catalogPath });
  try {
    plane.stores.persons.put({ ...person, endpoints: [...person.endpoints], revision: 0, createdBy: "owner", updatedAt: 1 });
  } finally {
    plane.close();
  }
}
