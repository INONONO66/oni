import { Bundle } from "@oni/agent";
import { approvalPolicyBundle } from "./bundles/approval-policy/index";
import { cronBundle } from "./bundles/alarms/cron/index";
import { compactionBundle, compactionSummarizerBundle } from "./bundles/compaction/index";
import { delegationPolicyBundle } from "./bundles/delegation-policy/index";
import { hooksJsonBundle, type HooksJsonInput } from "./bundles/hooks-json/index";
import { monitorBundle } from "./bundles/alarms/monitor/index";
import { ToolCapabilityPort } from "./bundles/seams";
import type { MonitorPorts } from "./bundles/alarms/monitor/ports";
import { sendMessageBundle } from "./bundles/messaging/send-message/index";
import { childActivityBundle } from "./bundles/child-activity/index";
import { provisionBundle } from "./bundles/provision/provision";
import { bashBundle } from "./bundles/tools/bash/index";
import { completionBundle } from "./bundles/tools/completion/index";
import { evalBundle } from "./bundles/tools/eval/index";
import { fileBundle } from "./bundles/tools/file/index";
import { AppInvariantError } from "./invariant";
import type { ToolPorts } from "./composition/catalog";
import { SHIPPED_OWNER_POLICY, type OwnerPolicy } from "./composition/policy";

/**
 * The tool-capability contract (#1255 P3, #1316): the dispatcher lives in
 * `plugins/tool` (surfaced through the `Bundle` barrel), and this declaration
 * OWNS the `tool.pre` / `tool.post` points plus the kernel budget-clamp
 * handler bundle rows may consult. Every tool bundle requires its seam, so
 * `off: ["tool"]` cascades all of them off.
 */
export const toolCapability = Bundle.Capability.define({
  name: "tool",
  requires: [],
  points: ["tool.pre", "tool.post"],
  handlers: { "kernel/budget-clamp": {} },
  verbs: {},
  port: ToolCapabilityPort,
});

/**
 * The product manifest (#1255): THE one place oni lists what is on —
 * its capabilities and its bundles — as plain data for `compose`. Boot is
 * config → manifest → compose → runtime; nothing else enumerates bundles.
 *
 * The action capability comes from the agent `Bundle` namespace (#1304): the
 * plugin owns the `action` kind, input, `action.pre` point and `ActionPort`;
 * the manifest only composes it, so `off: ["action"]` still cascades `hook`,
 * `hooks-json` and `delegation-policy` off with `action` as the root.
 *
 * `off` comes from the Owner's `ONI_BUNDLES_OFF` tuple (`config.off`,
 * #1306): capability names (`alarm`, `action`, `hook`, `compaction`, `tool`)
 * and bundle names ride the same list; compose owns the transitive
 * off-cascade semantics and `Manifest.define` refuses a name nothing
 * declares (typed `DefineRefused` `unknown`).
 */
export interface AppManifestInput {
  /** The composed alarm capability's frozen `Capability.define` contract. */
  readonly alarm: Bundle.CapabilityDefinition<"alarm">;
  /** The watch wake dependencies the monitor bundle's purposes close over. */
  readonly wake: import("./bundles/alarms/monitor/index").MonitorWakeDeps;
  /** The live alarm ports the monitor tool executes against, late-bound (#1308). */
  readonly alarms: () => MonitorPorts | undefined;
  /** The live ports every tool bundle executes against, late-bound like `alarms` (#1561). */
  readonly tools: () => ToolPorts | undefined;
  /** Validated external tool bundles, compiled before the runtime starts. */
  readonly toolPacks?: readonly Bundle.BundleContract[];
  /** The parsed hooks JSON config (#1256); absent composes zero hook rows. */
  readonly hooks?: HooksJsonInput;
  /** The Owner policy compiled once at boot. */
  readonly policy?: OwnerPolicy;
  /** Owner-configured off names (capabilities and bundles); absent means everything declared is on. */
  readonly off?: readonly string[];
}

export function appManifest(input: AppManifestInput): Bundle.ManifestDefinition {
  const productBundles = [
    fileBundle(input.tools),
    bashBundle(input.tools),
    evalBundle(input.tools),
    monitorBundle(input.wake, input.alarms),
    ...(input.wake.cadence === undefined ? [] : [childActivityBundle(input.wake.cadence)]),
    cronBundle(input.wake.prompt),
    hooksJsonBundle(input.hooks),
    delegationPolicyBundle((input.policy ?? SHIPPED_OWNER_POLICY).delegationRows),
    approvalPolicyBundle(() => input.tools()?.provisioning?.computer?.guard),
    sendMessageBundle(input.tools),
    provisionBundle(input.tools),
    completionBundle(input.tools),
    compactionSummarizerBundle(),
    compactionBundle(),
  ];
  const builtInTools = new Set(productBundles.flatMap((bundle) => bundle.tools.map((tool) => tool.name)));
  const builtInBundles = new Set<string>(productBundles.map((bundle) => bundle.name));
  for (const pack of input.toolPacks ?? []) {
    if (builtInBundles.has(pack.name))
      throw new AppInvariantError(`tool pack bundle ${pack.name} collides with a built-in`, "tool_name_collision");
    for (const tool of pack.tools)
      if (builtInTools.has(tool.name))
        throw new AppInvariantError(`tool pack tool ${tool.name} collides with a built-in`, "tool_name_collision");
  }
  return Bundle.Manifest.define({
    // #1307: compaction is a declared, removable capability; `off:
    // ["compaction"]` records the typed disabled entry and the kernel runs
    // without it instead of falling back silently.
    capabilities: [
      toolCapability,
      Bundle.actionCapability(),
      Bundle.hookCapability(),
      Bundle.compactionCapability(),
      input.alarm,
    ],
    bundles: [...productBundles, ...(input.toolPacks ?? [])],
    off: input.off ?? [],
  });
}
