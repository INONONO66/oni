import type { Model } from "@openomni/protocol";

const ADVANCING_FAILURES: ReadonlySet<string> = new Set([
  "timeout",
  "transient_error",
  "validation_error",
]);

/** Select a fallback from decided provider failures; retry owns termination. */
export function selectModel(chain: readonly Model.Ref[], failures: readonly string[]) {
  if (chain.length === 0) throw new TypeError("requires a non-empty model chain");
  const advances = failures.filter((reason) => ADVANCING_FAILURES.has(reason)).length;
  const index = Math.min(advances, chain.length - 1);
  return { model: chain[index] as Model.Ref, index, exhausted: advances >= chain.length };
}
