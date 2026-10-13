import { Journal, type PlainValue } from "@openomni/protocol";
import {
  AgentInvariantViolation,
  Capability,
  seam,
  type CapabilityDefinition,
  type SeamTag,
} from "../../core/api";

/**
 * The removable action capability: owns the `action` journal kind, admits
 * `action` as a `deliver` input and the `action.pre` point. The hook
 * capability and the product's delegation-policy bundle resolve it by NAME,
 * so `off: ["action"]` cascades them off with `action` as the root `because`.
 */

/** The seam a product bundle's `requires` resolves against at compose. */
export const ActionSeam: SeamTag = seam("@openomni/action/Action");

/** The reducer is identity because an action row is a deferred INPUT consumed by delivery, never folded session state. */
export function actionCapability(): CapabilityDefinition<"action", SeamTag, object> {
  const declaration = Journal.CAPABILITY_DECLARATIONS.find((entry) => entry.kind === "action");
  // Invariant, not a refusal: the protocol's closed kind list declares `action`.
  if (declaration === undefined) throw new AgentInvariantViolation("action kind not declared");
  return Capability.define({
    name: "action",
    requires: [],
    kinds: {
      action: {
        schema: declaration.schema,
        version: declaration.version,
        reduce: (state: PlainValue) => state,
      },
    },
    inputs: ["action"],
    points: ["action.pre"],
    verbs: {},
    seam: ActionSeam,
  });
}
