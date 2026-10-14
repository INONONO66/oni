import { Bundle } from "@openomni/agent";
import { approvalPolicyBundle } from "./bundles/approval-policy/index";
import { cronBundle } from "./bundles/alarms/cron/index";
import { compactionBundle, compactionSummarizerBundle } from "./bundles/compaction/index";
import { delegationPolicyBundle } from "./bundles/delegation-policy/index";
import { hooksJsonBundle, type HooksJsonInput } from "./bundles/hooks-json/index";
import { monitorBundle } from "./bundles/alarms/monitor/index";
import { ToolCapabilitySeam } from "./bundles/seams";
import type { MonitorPorts } from "./bundles/tools/core/watch";
import { sendMessageBundle } from "./bundles/messaging/send-message/index";

/**
 * The tool-capability contract (#1255 P3, #1316): the dispatcher lives in
 * `plugins/tool` (surfaced through the `Bundle` barrel), and this declaration
 * OWNS the `tool.pre` / `tool.post` points plus the kernel budget-clamp
 * handler bundle rows may consult. `monitor` (wake-budget row on `tool.pre`)
 * and `send-message` require its seam, so `off: ["tool"]` cascades both off.
 */
export const toolCapability = Bundle.Capability.define({
  name: "tool",
  requires: [],
  points: ["tool.pre", "tool.post"],
  handlers: { "kernel/budget-clamp": {} },
  verbs: {},
  port: ToolCapabilitySeam,
});

/**
 * The product manifest (#1255): THE one place openomni lists what is on —
 * its capabilities and its bundles — as plain data for `compose`. Boot is
 * config → manifest → compose → runtime; nothing else enumerates bundles.
 *
 * The action capability comes from the agent `Bundle` namespace (#1304): the
 * plugin owns the `action` kind, input, `action.pre` point and `ActionPort`;
 * the manifest only composes it, so `off: ["action"]` still cascades `hook`,
 * `hooks-json` and `delegation-policy` off with `action` as the root.
 *
 * `off` comes from the Owner's `OPENOMNI_BUNDLES_OFF` tuple (`config.off`,
 * #1306): capability names (`alarm`, `action`, `hook`, `compaction`, `tool`)
 * and bundle names ride the same list; compose owns the transitive
 * off-cascade semantics and ignores names the manifest never declared.
 */
export interface AppManifestInput {
  /** The composed alarm capability's frozen `Capability.define` contract. */
  readonly alarm: Bundle.CapabilityDefinition<"alarm">;
  /** The watch wake dependencies the monitor bundle's purposes close over. */
  readonly wake: import("./bundles/alarms/monitor/index").MonitorWakeDeps;
  /** The live alarm ports the monitor tool executes against, late-bound (#1308). */
  readonly alarms: () => MonitorPorts | undefined;
  /** The parsed hooks JSON config (#1256); absent composes zero hook rows. */
  readonly hooks?: HooksJsonInput;
  /** Owner-configured off names (capabilities and bundles); absent means everything declared is on. */
  readonly off?: readonly string[];
}

export function appManifest(input: AppManifestInput): Bundle.ManifestDefinition {
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
    bundles: [
      monitorBundle(input.wake, input.alarms),
      cronBundle(input.wake.prompt),
      hooksJsonBundle(input.hooks),
      sendMessageBundle(),
      delegationPolicyBundle(),
      // #1309: the approval/budget product values; `send-message` requires its seam.
      approvalPolicyBundle(),
      // The binding requires the summarizer; dropping the provider refuses `seam_missing`.
      compactionSummarizerBundle(),
      compactionBundle(),
    ],
    off: input.off ?? [],
  });
}
