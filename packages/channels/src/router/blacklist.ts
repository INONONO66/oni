import type { Actor } from "@oni/protocol";
import type { ChannelStores } from "./stores.js";

interface BlacklistMatchInput {
  readonly actorId?: string;
  readonly endpointId?: string;
  readonly channel?: string;
  readonly candidates?: readonly string[];
}

function isActive(entry: Actor.BlacklistEntry, now: number): boolean {
  return entry.expiresAt === undefined || entry.expiresAt > now;
}

function wildcardMatches(pattern: string, candidate: string): boolean {
  if (pattern === "*") return true;
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === candidate;

  let offset = 0;
  for (const [index, part] of parts.entries()) {
    if (part === "") continue;
    const found = candidate.indexOf(part, offset);
    if (found === -1) return false;
    if (index === 0 && found !== 0) return false;
    offset = found + part.length;
  }

  const last = parts[parts.length - 1];
  return last === "" || candidate.endsWith(last ?? "");
}

function entryMatches(entry: Actor.BlacklistEntry, input: BlacklistMatchInput): boolean {
  const candidates = input.candidates ?? [];
  if (entry.kind === "actor") return entry.value === input.actorId;
  if (entry.kind === "endpoint") return entry.value === input.endpointId;
  if (entry.kind === "channel") {
    return entry.value === input.channel || candidates.includes(entry.value);
  }
  return candidates.some((candidate) => wildcardMatches(entry.value, candidate));
}

/** Matches raw blacklist facts at the perimeter, where deny authority lives. */
export function matchBlacklist(
  stores: ChannelStores,
  input: BlacklistMatchInput,
  now: number,
): Actor.BlacklistEntry | undefined {
  return stores.blacklist.list().find((entry) => isActive(entry, now) && entryMatches(entry, input));
}
