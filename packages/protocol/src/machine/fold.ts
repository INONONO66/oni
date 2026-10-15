import type { CapabilityId, Enrollment, ExportName, MachineId, Offer } from "./schema.js";
import { z } from "zod";
import { CapabilityId as CapabilityIdSchema, MachineId as MachineIdSchema, type Resources } from "./schema.js";
import { sha256Hex } from "../sha256.js";

/**
 * Placement is deliberately a fold over host facts and the codemode's
 * pick-time lease counts. Stale members never receive work. A member without
 * capacity facts remains eligible, but ranks after members whose capacity is
 * known. `sticky` uses rendezvous hashing: removing one member only remaps
 * keys that were assigned to that member.
 */
function intersect<T extends string>(allowed: readonly T[], offered: readonly T[]): T[] {
  const permitted = new Set(allowed);
  return [...new Set(offered.filter((value) => permitted.has(value)))].sort();
}

export type EffectiveOutcome =
  | {
      /** The capability set every placement/authorization decision reads. */
      kind: "effective";
      machineId: MachineId;
      /** enrollment ∩ offer — deduped and sorted here, for stable comparison. */
      capabilities: readonly CapabilityId[];
    }
  | {
      /** An offer for a different machine never intersects — it refuses. */
      kind: "machine_mismatch";
      enrolled: MachineId;
      offered: MachineId;
    };

/**
 * effective = enrollment ∩ offer (docs/machines-and-delegation.md §2).
 * Pure and clockless: the Owner's allowlist caps what the daemon claims,
 * so neither side can grant itself a capability the other never named.
 */
export function effectiveCapabilities(enrollment: Enrollment, offer: Offer): EffectiveOutcome {
  if (enrollment.machineId !== offer.machineId)
    return { kind: "machine_mismatch", enrolled: enrollment.machineId, offered: offer.machineId };
  return { kind: "effective", machineId: enrollment.machineId, capabilities: intersect(enrollment.allowedCapabilities, offer.offeredCapabilities) };
}

export type EffectiveExportsOutcome =
  | {
      /** The negotiated confinement-root identifiers. */
      kind: "effective";
      machineId: MachineId;
      /** enrollment ∩ offer — deduped and sorted here, for stable comparison. */
      exports: readonly ExportName[];
    }
  | {
      kind: "machine_mismatch";
      enrolled: MachineId;
      offered: MachineId;
    };

/**
 * effective = enrollment ∩ offer, the same fold as capabilities but over export
 * names. Both sides are optional on the wire and BOTH default to empty: an
 * enrollment that names no export publishes nothing, and a daemon that offers
 * none serves nothing. No implicit filesystem authority is granted.
 */
export function effectiveExports(enrollment: Enrollment, offer: Offer): EffectiveExportsOutcome {
  if (enrollment.machineId !== offer.machineId)
    return { kind: "machine_mismatch", enrolled: enrollment.machineId, offered: offer.machineId };
  return { kind: "effective", machineId: enrollment.machineId, exports: intersect(enrollment.allowedExports ?? [], (offer.exports ?? []).map((entry) => entry.name)) };
}

export const PlacementRequest = z
  .object({
    tag: z.string().min(1),
    requires: z.array(CapabilityIdSchema).optional(),
    prefer: z.union([
      z.enum(["spread", "pack", "exclusive"]),
      z.object({ sticky: z.string().min(1) }).strict(),
    ]),
  })
  .strict();
export type PlacementRequest = z.infer<typeof PlacementRequest>;

export const PlacementOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("placed"), machineId: MachineIdSchema }).strict(),
  z.object({ kind: z.literal("no_member") }).strict(),
  z.object({ kind: z.literal("all_stale") }).strict(),
  z.object({ kind: z.literal("machine_saturated") }).strict(),
]);
export type PlacementOutcome = z.infer<typeof PlacementOutcome>;

export interface PlacementMachine {
  readonly machineId: string;
  readonly tags: readonly string[];
  readonly capabilities: readonly string[];
  readonly resources?: z.infer<typeof Resources>;
  readonly live?: { readonly stale: boolean; readonly load?: { readonly memoryAvailableBytes?: number } };
  readonly leases: number;
  readonly slots?: number;
}

function hashScore(key: string, machineId: string): string {
  return sha256Hex(`${key}\0${machineId}`);
}

function hasCredit(machine: PlacementMachine): boolean {
  return machine.slots === undefined
    ? machine.resources === undefined || machine.leases < machine.resources.cpus
    : machine.leases < machine.slots;
}

function slotsOf(machine: PlacementMachine): number | undefined {
  return machine.slots ?? machine.resources?.cpus;
}

function freeMemoryOf(machine: PlacementMachine): number {
  return machine.live?.load?.memoryAvailableBytes ?? machine.resources?.memoryBytes ?? -1;
}

function compareCandidates(
  prefer: "spread" | "pack" | "exclusive",
  best: PlacementMachine,
  machine: PlacementMachine,
): PlacementMachine {
  const bestSlots = slotsOf(best);
  const machineSlots = slotsOf(machine);
  if (prefer === "pack" && machine.leases !== best.leases)
    return machine.leases > best.leases ? machine : best;
  if (prefer === "spread" && machineSlots !== undefined && bestSlots !== undefined) {
    const machineRatio = machine.leases / machineSlots;
    const bestRatio = best.leases / bestSlots;
    if (machineRatio !== bestRatio) return machineRatio < bestRatio ? machine : best;
  }
  if (machine.leases !== best.leases) return machine.leases < best.leases ? machine : best;
  if (prefer === "spread" && freeMemoryOf(machine) !== freeMemoryOf(best))
    return freeMemoryOf(machine) > freeMemoryOf(best) ? machine : best;
  return machine.machineId.localeCompare(best.machineId) < 0 ? machine : best;
}

export function place(
  request: PlacementRequest,
  machines: readonly PlacementMachine[],
): PlacementOutcome {
  const parsed = PlacementRequest.parse(request);
  const tagged = machines.filter((machine) => machine.tags.includes(parsed.tag));
  if (tagged.length === 0) return { kind: "no_member" };
  const live = tagged.filter((machine) => machine.live?.stale !== true);
  if (live.length === 0) return { kind: "all_stale" };
  const required = parsed.requires ?? [];
  const capable = live.filter((machine) => required.every((capability) => machine.capabilities.includes(capability)));
  if (capable.length === 0) return { kind: "no_member" };
  const credited = capable.filter(hasCredit);
  if (credited.length === 0) return { kind: "machine_saturated" };
  const known = credited.filter((machine) => slotsOf(machine) !== undefined);
  const candidates = known.length > 0 ? known : credited;

  if (typeof parsed.prefer === "object" && parsed.prefer !== null) {
    const sticky = parsed.prefer.sticky;
    const selected = candidates.reduce((best, machine) =>
      best === undefined || hashScore(sticky, machine.machineId) > hashScore(sticky, best.machineId)
        ? machine
        : best, undefined as PlacementMachine | undefined);
    return selected === undefined ? { kind: "machine_saturated" } : { kind: "placed", machineId: selected.machineId };
  }

  const exclusive = parsed.prefer === "exclusive" ? credited.filter((machine) => machine.leases === 0) : credited;
  if (exclusive.length === 0) return { kind: "machine_saturated" };
  const exclusiveKnown = exclusive.filter((machine) => slotsOf(machine) !== undefined);
  const exclusiveCandidates = exclusiveKnown.length > 0 ? exclusiveKnown : exclusive;
  const prefer = parsed.prefer as "spread" | "pack" | "exclusive";
  const selected = exclusiveCandidates.reduce((best, machine) =>
    best === undefined ? machine : compareCandidates(prefer, best, machine),
  undefined as PlacementMachine | undefined);
  return selected === undefined ? { kind: "machine_saturated" } : { kind: "placed", machineId: selected.machineId };
}
