import { z } from "zod";
import { refusal } from "./contacts";

/**
 * Dynamic generations (#1255 P4): `provision{op: bundle_enable|bundle_disable}`
 * edits the manifest off-list and re-runs compose. The swap is atomic — a
 * compose refusal (unknown handler, missing seam, cycle) leaves the previous
 * composition current, so rollback is "nothing happened". In-flight turns keep
 * their captured generation; sessions adopt the new hash at their next turn
 * start (core rotation, #1255 S3).
 */
const BUNDLE_INPUT = z
  .object({ name: z.string().min(1).describe("The declared bundle name, e.g. monitor.") })
  .strict();

export const BundleOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("bundle_enable"), args: BUNDLE_INPUT }).strict(),
  z.object({ op: z.literal("bundle_disable"), args: BUNDLE_INPUT }).strict(),
]);

const offList = z.array(z.string()).describe("The complete off-list after this operation.");
export const BundleResult = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("bundle_enable"),
      name: z.string(),
      action: z.literal("enabled"),
      off: offList,
    })
    .strict(),
  z
    .object({
      op: z.literal("bundle_disable"),
      name: z.string(),
      action: z.literal("disabled"),
      off: offList,
    })
    .strict(),
]);

/** Boot's recompose seam: names/off read the CURRENT manifest, set() composes and swaps. */
export interface BundlePort {
  readonly names: () => readonly string[];
  readonly off: () => readonly string[];
  /** Compose the manifest with this off-list and swap the holder; throws on compose refusal. */
  readonly set: (off: readonly string[]) => Promise<void>;
}

function bundleToggleExecutor<const A extends "enabled" | "disabled">(port: BundlePort, action: A) {
  const enabled = action === "enabled";
  const tool = enabled ? "bundle_enable" : "bundle_disable";
  return async (input: z.output<typeof BUNDLE_INPUT>) => {
    if (!port.names().includes(input.name))
      return refusal(tool, `bundle ${input.name} is not declared`);
    const off = enabled
      ? port.off().filter((name) => name !== input.name)
      : [...new Set([...port.off(), input.name])].sort();
    // A refused compose propagates as the tool refusal; the previous
    // composition is still current (atomic swap = rollback for free).
    await port.set(off).catch((error: Error) => refusal(tool, error.message));
    return { name: input.name, action, off: [...off] };
  };
}

export function executeBundleEnable(port: BundlePort) {
  return bundleToggleExecutor(port, "enabled");
}

export function executeBundleDisable(port: BundlePort) {
  return bundleToggleExecutor(port, "disabled");
}
