import type { z } from "zod";
import type { ToolExecutionContext } from "@openomni/protocol";
import type { ProvisionInput } from "./provision";
import { contactDomainRevisions } from "./contact-mutations";
import {
  approvalRequirement,
  executePersonDeclare,
  executePersonRemove,
  mutateContact,
  refusal,
} from "./contacts";
import {
  executeChannelDeclare,
  executeChannelEnable,
  executeChannelDisable,
  executeSecretRotate,
  type ProvisionPort,
} from "./channels";
import { executeBundleDisable, executeBundleEnable } from "./bundles";
import { executeProvisionStatus } from "./status";
import { automationApproval, executeApprovedAutomation, executeAutomationTool } from "./automation";
import { executeApprovedMachine, executeMachine, machineDomainRevisions } from "./machines";
function provisionExecutors(port: ProvisionPort, now: () => number) {
  return {
    contact_add: executePersonDeclare(port, now),
    contact_remove: executePersonRemove(port),
    channel_add: executeChannelDeclare(port, now),
    channel_enable: executeChannelEnable(port, now),
    channel_disable: executeChannelDisable(port, now),
    secret_rotate: executeSecretRotate(port, now),
    bundle_enable: executeBundleEnable(port.bundles),
    bundle_disable: executeBundleDisable(port.bundles),
    status: executeProvisionStatus(port),
  };
}

export function executeProvision(port: ProvisionPort | undefined, now: () => number) {
  const composed = port === undefined ? undefined : provisionExecutors(port, now);
  const executors = () => composed ?? refusal("provision", "provisioning is not composed");
  return async ({ operation }: z.output<typeof ProvisionInput>, context: ToolExecutionContext) => {
    switch (operation.op) {
      case "machine_add":
        return executeApprovedMachine(port?.machines, operation, context);
      case "machine_remove":
      case "machine_list":
        return executeMachine(port?.machines, operation, `session:${context.sessionId}`);
      case "automation_add":
      case "automation_enable":
        return executeApprovedAutomation(port?.automations, operation, context);
      case "automation_remove":
      case "automation_disable":
      case "automation_list":
        return executeAutomationTool(port?.automations, operation, `session:${context.sessionId}`);
    }
    if (operation.op === "contact_promote" || operation.op === "contact_merge") {
      if (port === undefined) return refusal("provision", "provisioning is not composed");
      return mutateContact(port, operation, context.domainRevisions);
    }
    const run = executors();
    switch (operation.op) {
      case "contact_add":
        return {
          op: operation.op,
          result: await run.contact_add(operation.args, context.domainRevisions),
        };
      case "contact_remove":
        return { op: operation.op, ...(await run.contact_remove(operation.args)) };
      case "channel_add":
        return { op: operation.op, ...(await run.channel_add(operation.args)) };
      case "channel_enable":
        return {
          op: operation.op,
          ...(await run.channel_enable(operation.args)),
          action: "enabled" as const,
        };
      case "channel_disable":
        return {
          op: operation.op,
          ...(await run.channel_disable(operation.args)),
          action: "disabled" as const,
        };
      case "secret_rotate":
        return { op: operation.op, ...(await run.secret_rotate(operation.args)) };
      case "bundle_enable":
        return { op: operation.op, ...(await run.bundle_enable(operation.args)) };
      case "bundle_disable":
        return { op: operation.op, ...(await run.bundle_disable(operation.args)) };
      case "status":
        return { op: operation.op, ...(await run.status(operation.args)) };
    }
  };
}

export function provisionApproval(port: ProvisionPort | undefined) {
  const automation = automationApproval(port?.automations);
  return ({ operation }: z.output<typeof ProvisionInput>, context?: ToolExecutionContext, prepare = false) => {
    if (operation.op === "machine_add")
      return { required: true, domainRevisions: machineDomainRevisions(port?.machines?.enrollments, operation.args.machineId) };
    if ((operation.op === "automation_add" || operation.op === "automation_enable") && context !== undefined)
      return automation(operation, context, prepare);
    if (operation.op === "contact_promote" || operation.op === "contact_merge") {
      if (port === undefined) return { required: false, domainRevisions: {} };
      return { required: false, domainRevisions: contactDomainRevisions(port.actors, operation) };
    }
    if (operation.op !== "contact_add" || port === undefined)
      return { required: false, domainRevisions: {} };
    const manifest = {
      ...operation.args.manifest,
      displayName: operation.args.manifest.displayName ?? operation.args.manifest.id,
    };
    const existing = port.persons.get(manifest.id);
    return {
      required: approvalRequirement(existing, manifest) !== undefined,
      domainRevisions: { [manifest.id]: existing?.revision ?? -1 },
      timeoutMs: operation.args.timeoutMs,
    };
  };
}
