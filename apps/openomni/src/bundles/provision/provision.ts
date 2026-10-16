import { z } from "zod";
import { Bundle, Core } from "@openomni/agent";
import { boundTool, ToolCapabilityPort } from "../seams";
const defineTool = Core.defineTool;
import { AutomationOperation, AutomationResult } from "./automation-schema";
import { MachineOperation, MachineResult } from "./machine-schema";
import { ContactOperation, ContactResult } from "./contact-mutations";
import {
  PERSON_DECLARE_INPUT,
  PERSON_REMOVE_INPUT,
  PersonDeclareResult,
} from "./contacts";
import { ChannelOperation, ChannelResult, type ProvisionPort } from "./channels";
import { BundleOperation, BundleResult } from "./bundles";
import { executeProvision, provisionApproval } from "./execution";
import { EMPTY_INPUT, ProvisionStatusOutput, renderProvision } from "./status";

const ProvisionOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("contact_add"), args: PERSON_DECLARE_INPUT }).strict(),
  z.object({ op: z.literal("contact_remove"), args: PERSON_REMOVE_INPUT }).strict(),
  ...ContactOperation.options,
  ...ChannelOperation.options,
  ...BundleOperation.options,
  ...AutomationOperation.options,
  ...MachineOperation.options,
  z.object({ op: z.literal("status"), args: EMPTY_INPUT }).strict(),
]);
export const ProvisionInput = z.object({ operation: ProvisionOperation }).strict();
export const ProvisionOutput = z.discriminatedUnion("op", [
  z.object({ op: z.literal("contact_add"), result: PersonDeclareResult }).strict(),
  z.object({ op: z.literal("contact_remove"), id: z.string() }).strict(),
  ...ContactResult.options,
  ...ChannelResult.options,
  ...BundleResult.options,
  ...AutomationResult.options,
  ...MachineResult.options,
  ProvisionStatusOutput.extend({ op: z.literal("status") }),
]);

/** The catalog is static: without a composed provisioning port the tool exists and refuses. */
export function createProvisionTool(port: ProvisionPort | undefined, now: () => number) {
  return defineTool(
    {
      name: "provision",
      category: "mutation",
      description:
        "Administer contacts, channels, credentials, automations, machines, and provisioning status. Use op=contact_add|contact_remove|contact_promote|contact_merge|channel_add|channel_enable|channel_disable|secret_rotate|bundle_enable|bundle_disable|automation_add|automation_remove|automation_enable|automation_disable|automation_list|machine_add|machine_remove|machine_list|status. Authority changes, machine public keys, Owner-account channel instances and their outbound grant require Owner consent. Session-created automations remain disabled until the Owner enables them.",
      input: ProvisionInput,
      output: ProvisionOutput,
      visibility: { model: ["resident"], cell: ["resident"] },
      execute: executeProvision(port, now),
      render: (_args, value) => renderProvision(value),
    },
    provisionApproval(port),
  );
}
/** The `provision` bundle (#1561): Owner administration, bundle toggles included. */
export interface ProvisionToolPorts {
  readonly provisioning: ProvisionPort | undefined;
  readonly clock: () => number;
}

const ABSENT_PROVISION_PORTS: ProvisionToolPorts = { provisioning: undefined, clock: () => 0 };

export function provisionBundle(ports: () => ProvisionToolPorts | undefined): Bundle.BundleContract<"provision"> {
  return Bundle.define({
    name: "provision",
    requires: [ToolCapabilityPort],
    tools: [boundTool(ports, ABSENT_PROVISION_PORTS, (live) => createProvisionTool(live.provisioning, live.clock))],
  });
}
