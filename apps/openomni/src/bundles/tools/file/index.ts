import { Bundle } from "@openomni/agent";
import { boundTool, ToolCapabilityPort } from "../../seams";
import { ABSENT_MACHINE_PORTS, type MachineToolPortsSource } from "../core/ports";
import { createEditTool } from "../edit/index";
import { createFindTool } from "../find/index";
import { createGrepTool } from "../grep/index";
import { createLsTool } from "../ls/index";
import { createReadTool } from "../read/index";
import { createWriteTool } from "../write/index";

/** The `file` bundle (#1561): the six machine-file tools, removable as one unit. */
export function fileBundle(ports: MachineToolPortsSource): Bundle.BundleContract<"file"> {
  return Bundle.define({
    name: "file",
    requires: [ToolCapabilityPort],
    tools: [createReadTool, createWriteTool, createEditTool, createLsTool, createFindTool, createGrepTool].map(
      (create) => boundTool(ports, ABSENT_MACHINE_PORTS, create),
    ),
  });
}
