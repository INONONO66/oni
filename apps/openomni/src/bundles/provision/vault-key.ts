import { existsSync, readFileSync } from "node:fs";
import { Result } from "effect";
import { join } from "node:path";
import { Vault } from "@openomni/channels";

/**
 * KEK sourcing (docs/provisioning-and-providers.md §3.3): the key encryption
 * key never lives in the database it protects. Resolution order is
 * `OPENOMNI_VAULT_KEY` (base64, 32 bytes) then `~/.openomni/vault.key`
 * (base64 text file, 0600). Every failure shape is `locked` with a reason —
 * a locked vault refuses credentialed channels, it never mounts them empty
 * (§8.4), and the boot proceeds on the credential-less loopback surface.
 */

export type KekResolution =
  | { readonly kind: "ok"; readonly kek: Vault.Kek }
  | { readonly kind: "locked"; readonly reason: string };

export function vaultKeyPath(home: string): string {
  return join(home, ".openomni", "vault.key");
}

function kekFromBase64(encoded: string, source: string): KekResolution {
  // Buffer.from(_, "base64") never throws — bad characters shrink the output,
  // and a wrong-length result is exactly what kekOf refuses below.
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
  const kek = Result.try({ try: () => Vault.kekOf(bytes), catch: String });
  return Result.isSuccess(kek)
    ? { kind: "ok", kek: kek.success }
    : { kind: "locked", reason: `${source}: ${kek.failure}` };
}

export function resolveKek(env: Record<string, string | undefined>, home: string): KekResolution {
  const fromEnv = env.OPENOMNI_VAULT_KEY?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return kekFromBase64(fromEnv, "OPENOMNI_VAULT_KEY");
  }
  const path = vaultKeyPath(home);
  if (!existsSync(path)) {
    return { kind: "locked", reason: `no OPENOMNI_VAULT_KEY and no key file at ${path}` };
  }
  return kekFromBase64(readFileSync(path, "utf-8").trim(), path);
}
