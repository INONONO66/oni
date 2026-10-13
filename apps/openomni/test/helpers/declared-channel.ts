import { Vault } from "@openomni/channels";
import { createAppLedger } from "./ledger";
import type { KekResolution } from "../../src/provisioning/vault-key";
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
  provider: "telegram" | "github",
  credentials: Record<string, string>,
): KekResolution {
  const key = new Uint8Array(32).fill(7);
  const plane = createAppLedger({ now: testClock(), catalogPath });
  try {
    const credentialRef = `secret:${provider}`;
    putChannelCredential(plane.stores.secrets, credentialRef, JSON.stringify(credentials), key, 1);
    plane.stores.instances.put({
      id: `channel:${provider}:main`, provider, enabled: true, settings: {}, credentialRef,
      revision: 0, createdBy: "owner", updatedAt: 1,
    });
  } finally {
    plane.close();
  }
  return { kind: "ok", kek: Vault.kekOf(key) };
}
