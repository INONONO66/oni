import { Bundle } from "@oni/agent";
import type { ToolPorts } from "../../src/composition/catalog";
import { toolPortsSlot } from "../../src/composition/composed";
import { alarmPortsSlot, composedHolderOf, type ComposedHolder } from "../../src/composition/composed";
import { approvalPolicyBundle } from "../../src/bundles/approval-policy/index";
import { sendMessageBundle } from "../../src/bundles/messaging/send-message/index";
import { provisionBundle } from "../../src/bundles/provision/provision";
import { bashBundle } from "../../src/bundles/tools/bash/index";
import { completionBundle } from "../../src/bundles/tools/completion/index";
import { evalBundle } from "../../src/bundles/tools/eval/index";
import { fileBundle } from "../../src/bundles/tools/file/index";
import { toolCapability } from "../../src/manifest";
import { testIds } from "./test-entropy";

/** Explicit absent-capability fixture; individual tests supply only the ports they exercise. */
export const testToolPorts: ToolPorts = {
  messages: undefined,
  machines: undefined,
  cells: undefined,
  llm: undefined,
  provisioning: undefined,
  clock: () => 0,
  id: testIds("tool"),
};

/** The product tool bundles over fixed ports, in manifest order (#1561). */
export function toolBundles(ports: ToolPorts): readonly Bundle.BundleContract[] {
  return sourcedToolBundles(() => ports);
}

function sourcedToolBundles(source: () => ToolPorts | undefined): readonly Bundle.BundleContract[] {
  return [
    fileBundle(source),
    bashBundle(source),
    evalBundle(source),
    completionBundle(source),
    provisionBundle(source),
    sendMessageBundle(source),
  ];
}

/** Every product tool the bundles declare, bound to `ports`. */
export function bundleTools(ports: ToolPorts): readonly Bundle.BundleTool[] {
  return toolBundles(ports).flatMap((bundle) => bundle.tools);
}

/** The tool capability plus the product tool bundles, composed (send-message requires the approval seam). */
export function toolComposition(ports: ToolPorts) {
  return composeTools(() => ports);
}

function composeTools(source: () => ToolPorts | undefined) {
  const manifest = Bundle.Manifest.define({
    capabilities: [toolCapability],
    bundles: [...sourcedToolBundles(source), approvalPolicyBundle()],
    off: [],
  });
  return { manifest, generation: Bundle.composeSync(manifest) };
}

/** A composed holder whose tool bundles read the ports the runtime later binds into its slot. */
export function boundToolHolder(): ComposedHolder {
  const tools = toolPortsSlot();
  return composedHolderOf(composeTools(tools.current), alarmPortsSlot(), tools);
}
