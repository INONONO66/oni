import type { Channel } from "@oni/protocol";

/** Exact instance or the sole mounted account on a platform; never choose among peers. */
export function resolveInstance(
  routes: ReadonlyMap<string, Channel.Instance>,
  platform: string,
  identity: Channel.Identity,
  instance?: string,
): { readonly instance: string } | {
  readonly code: "target_stale" | "target_ambiguous" | "identity_not_granted";
  readonly reason: string;
} {
  if (instance !== undefined) {
    const route = routes.get(instance);
    if (route === undefined || route.platform !== platform)
      return { code: "target_stale", reason: `no mounted ${platform} instance ${instance}` };
    if (route.identity !== identity)
      return { code: "identity_not_granted", reason: `${instance} does not send as ${identity}` };
    return { instance };
  }
  const matches = [...routes].filter(([, route]) => route.platform === platform && route.identity === identity);
  const [match] = matches;
  if (match === undefined)
    return { code: "target_stale", reason: `no mounted ${platform} instance sends as ${identity}` };
  if (matches.length > 1)
    return { code: "target_ambiguous", reason: `${matches.length} ${platform} instances send as ${identity}; name an instance` };
  return { instance: match[0] };
}
