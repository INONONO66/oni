import type { Actor } from "@oni/protocol";

export function effectiveTrustTier(
  actorTier: Actor.TrustTier | undefined,
  defaultTier: Actor.TrustTier | undefined,
): Actor.TrustTier | undefined {
  return actorTier ?? defaultTier;
}
