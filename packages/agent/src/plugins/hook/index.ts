import { Capability, port, type CapabilityDefinition, type PortTag } from "../../core/api";
import { hookProcessConsultant } from "./consultant";
import { acquireHookProcess, HOOK_PROCESS_REF } from "./process";

export { hookProcessConsultant } from "./consultant";

export {
  acquireHookProcess,
  HOOK_PROCESS_REF,
  HookGateVerdict,
  HookSpawnError,
  type HookCallInput,
  type HookChildProcess,
  type HookLateResult,
  type HookOutcome,
  type HookProcess,
  type HookProcessConfig,
} from "./process";

/**
 * The removable hook capability: no kind, point, input or model tool —
 * exactly one `how.ref` handler target (`hook/process`) plus the scoped
 * process-acquisition verb. `requires: ["action"]` is a capability NAME: hook
 * results re-enter only as `action` rows, so `action` off cascades `hook` off.
 */

/** The tag a product bundle's `requires` resolves against at compose. */
export const HookPort: PortTag = port("@openomni/hook/Hook");

/** The verbs the hook capability publishes over its port. */
export interface HookVerbs {
  /** Spawns ONE hook PID inside the caller's Scope — the generation lifetime. */
  readonly acquire: typeof acquireHookProcess;
}

export function hookCapability(): CapabilityDefinition<"hook", PortTag, HookVerbs> {
  return Capability.define({
    name: "hook",
    requires: ["action"],
    // The registration IS the consultant — compiled rows naming `hook/process`
    // consult the scoped process the composition acquires here.
    handlers: { [HOOK_PROCESS_REF]: { consultant: hookProcessConsultant } },
    verbs: { acquire: acquireHookProcess },
    port: HookPort,
  });
}
