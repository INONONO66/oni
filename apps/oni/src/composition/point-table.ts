import { Core } from "@oni/agent";
import { Context } from "effect";

/**
 * The merged point registration table of THIS composition (#1251): derived
 * from the capability registrations the composition root actually selects.
 * A capability omitted from the composition has no points, so its rows
 * reject fail-closed at boot seeding and at generation compile.
 */
export class AppPointTable extends Context.Service<AppPointTable, Core.GatePointTable>()(
  "@oni/oni/AppPointTable",
) {}

/** Composes the table from the selected capabilities; the default selection is every built-in this app ships. */
export function composedPointTable(
  capabilities: readonly Core.CapabilityPointRegistration[] = Core.KERNEL_CAPABILITY_POINTS,
): Core.GatePointTable {
  return Core.composePointTable({ capabilities });
}
