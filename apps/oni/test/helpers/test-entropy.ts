/** Deterministic injected id entropy for fixtures (#1245): no ambient crypto in tests. */
export function testIds(prefix: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}

import type { Effect } from "effect";
import { runEffect } from "./effect";

/** Injected channel-runtime seams for profile fixtures (#1245). */
export function testChannelDeps(prefix = "channel") {
  return {
    publish: () => undefined,
    now: () => 1000,
    id: testIds(prefix),
    random: () => 0.5,
    run: <A, E>(effect: Effect.Effect<A, E>) => runEffect(effect),
  };
}

/** Deterministic injected clock for fixtures (#1245): each read advances by one millisecond. */
export function testClock(start = 1_000): () => number {
  let now = start;
  return () => {
    now += 1;
    return now;
  };
}

/**
 * One process-wide default minter: fixtures that share a plane across several
 * runtimes must never re-mint an action id, so the default never restarts.
 */
const sharedIds = testIds("entropy");

/** Injected entropy pair for fixtures whose ids come from `id`. */
export function testEntropy(id: () => string = sharedIds): { readonly id: () => string; readonly random: () => number } {
  return { id, random: () => 0.5 };
}
