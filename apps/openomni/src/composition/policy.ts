import { Core } from "@openomni/agent";
import type { PolicyRow, Storage as ProtocolStorage } from "@openomni/protocol";
import { MESSAGE_POLICY_ROWS } from "../bundles/messaging/index";
import { PROVISION_POLICY_ROWS } from "../bundles/provision/provision";
import { composedPointTable } from "./point-table";

const { SEEDED_POLICY_ROWS, assertPointGenerationRows, POINT_GENERATION_ROW, translateLegacyPolicyRow } = Core;

/**
 * The kernel's mandatory rows: the agent seed, message routing, provisioning
 * consent. Bundle-owned rows (the monitor wake budget, #1255 P2) arrive
 * through the `bundleRows` argument — the bundle, not the kernel, owns them.
 */
const KERNEL_POLICY_ROWS: readonly Omit<PolicyRow.Row, "generation">[] = [
  ...SEEDED_POLICY_ROWS,
  ...MESSAGE_POLICY_ROWS,
  ...PROVISION_POLICY_ROWS,
  POINT_GENERATION_ROW,
];

/**
 * Seeds the kernel's mandatory generation into the catalog's policy plane and
 * converts the latest generation once into a validated fourteen-point
 * generation (#1251): historical generations keep their exact bytes, and a
 * latest row that cannot map to a registered point rejects the whole write
 * unit, failing the boot.
 */
export function seedKernelPolicyRows(
  policies: ProtocolStorage.PolicyRowSubAdapter,
  bundleRows: readonly Omit<PolicyRow.Row, "generation">[] = [],
  /** The composition's merged point table (#1251); the default is the full built-in composition this app ships. */
  table: Core.GatePointTable = composedPointTable(),
): number {
  return policies.appendGeneration((current) => {
    // Convert the latest generation's semantics onto the fourteen-point
    // contract and validate every row BEFORE any early return: a completed
    // generation carrying an unmappable custom row still rejects the boot.
    const converted = current.map((row) => translateLegacyPolicyRow(row));
    assertPointGenerationRows(converted, table);
    const next = new Map([...KERNEL_POLICY_ROWS, ...bundleRows].map((row) => [policyId(row), row]));
    // Preserve existing policy values and site-specific ids; fill missing mandatory ids.
    for (const row of converted) next.set(policyId(row), row);
    // The rows this boot writes must themselves map onto the composition's
    // points: a composition without a capability refuses its rows at seed.
    assertPointGenerationRows([...next.values()], table);
    // Identity compares the STORED rows: a conversion that changed any row's
    // point identity must land as a new generation even when the converted
    // set already matches the target.
    const storedIds = new Set(current.map(policyId));
    if (storedIds.size === next.size && [...next.keys()].every((id) => storedIds.has(id))) {
      return undefined;
    }
    return [...next.values()];
  });
}

function policyId(row: Omit<PolicyRow.Row, "generation">): string {
  return JSON.stringify([row.name, row.kind, row.phase]);
}
