import { Core } from "@oni/agent";
import type { createMachineEnrollmentStore } from "@oni/channels";
import { MachineRefusalError, type MachineHost } from "@oni/machines";
import { canonicalDigest, Machine, type BusEvent, type ToolExecutionContext } from "@oni/protocol";
import type { MachineOperation, MachineResult } from "./machine-schema";
import type { PermissionPort } from "../seams";

export interface MachinePort {
  readonly enrollments: ReturnType<typeof createMachineEnrollmentStore>;
  readonly host: Pick<MachineHost, "list" | "unenroll" | "peers">;
  readonly selfId: string;
  readonly events: BusEvent.Sink;
  readonly now: () => number;
}

export function executePermission(
  port: PermissionPort | undefined,
  operation: Extract<MachineOperation, { op: "permission_allow" | "permission_deny" }>,
  context: ToolExecutionContext,
): MachineResult {
  if (port === undefined) throw new Core.ToolRefused("provision", "agent permission port is not composed");
  if (operation.op === "permission_allow" && context.domainRevisions === undefined)
    return { op: operation.op, result: { type: "require_approval", id: operation.args.requestId } };
  const outcome = port.answer({
    sessionId: context.sessionId,
    ...operation.args,
    status: operation.op === "permission_allow" ? "allowed" : "denied",
  });
  if (outcome.kind === "not_owner")
    throw new Core.ToolRefused("provision", `no cli turn of this session owns agent session ${operation.args.agentSessionId}`);
  return { op: operation.op, result: outcome };
}

type ConsentedMachineOperation = Extract<
  MachineOperation,
  { op: "machine_add" | "machine_grant" | "machine_deny" | "machine_peer_lease" }
>;

/** #1841: a peer lease is the only machine-to-machine reach; the Owner issues it for two enrolled machines. */
function executePeerLease(
  port: MachinePort,
  operation: Extract<MachineOperation, { op: "machine_peer_lease" }>,
  caller: "owner" | `session:${string}`,
): MachineResult {
  const { from, to } = operation.args;
  if (caller !== "owner")
    return { op: operation.op, result: { type: "require_approval", id: from } };
  for (const machineId of [from, to])
    if (machineId !== port.selfId && port.enrollments.get(machineId)?.removedAt !== null)
      throw new Core.ToolRefused("provision", `machine is not enrolled: ${machineId}`);
  try {
    return { op: operation.op, result: { lease: port.host.peers.issue(operation.args) } };
  } catch (error) {
    if (error instanceof MachineRefusalError)
      throw new Core.ToolRefused("provision", error.message);
    throw error;
  }
}

export function executeMachine(
  port: MachinePort | undefined,
  operation: Exclude<MachineOperation, { op: "permission_allow" | "permission_deny" }>,
  caller: "owner" | `session:${string}`,
): MachineResult {
  if (port === undefined) throw new Core.ToolRefused("provision", "machine provisioning is not composed");
  if (operation.op === "machine_list") return { op: operation.op, result: { rows: port.host.list() } };
  if (operation.op === "machine_peer_lease") return executePeerLease(port, operation, caller);
  const { machineId } = operation.args;
  if (machineId === port.selfId) throw new Core.ToolRefused("provision", "self enrollment is configured at boot");
  switch (operation.op) {
    case "machine_add": {
      if (caller !== "owner") return { op: operation.op, result: { type: "require_approval", id: machineId } };
      const replacing = port.enrollments.get(machineId)?.removedAt === null;
      const time = port.now();
      const enrollment = { ...operation.args, enrolledAt: time };
      port.enrollments.put(enrollment);
      port.events.publish(Machine.Events.Enrolled, { machineId, time, enrollment });
      if (replacing) port.host.unenroll(machineId, "enrollment_replaced");
      return { op: operation.op, result: { enrollment } };
    }
    case "machine_remove": {
      const time = port.now();
      if (!port.enrollments.remove(machineId, time))
        throw new Core.ToolRefused("provision", `machine is not enrolled: ${machineId}`);
      port.events.publish(Machine.Events.Unenrolled, { machineId, time });
      port.host.unenroll(machineId);
      return { op: operation.op, result: { machineId } };
    }
    case "machine_grant": {
      if (caller !== "owner") return { op: operation.op, result: { type: "require_approval", id: machineId } };
      const time = port.now();
      const enrollment = port.enrollments.grant(machineId, operation.args.capabilities, time);
      if (enrollment === undefined) throw new Core.ToolRefused("provision", `machine capability request does not match: ${machineId}`);
      port.events.publish(Machine.Events.Enrolled, { machineId, time, enrollment });
      return { op: operation.op, result: { enrollment } };
    }
    case "machine_deny": {
      if (caller !== "owner") return { op: operation.op, result: { type: "require_approval", id: machineId } };
      if (!port.enrollments.deny(machineId)) throw new Core.ToolRefused("provision", `machine capability request not found: ${machineId}`);
      return { op: operation.op, result: { machineId } };
    }
  }
}

export function machineDomainRevisions(enrollments: MachinePort["enrollments"] | undefined, ...machineIds: string[]): Record<string, number> {
  return Object.fromEntries(machineIds.map((machineId) => [`machine:${machineId}`, enrollments?.get(machineId)?.revision ?? -1]));
}

/** Consent to a peer lease is bound to both machines' enrollments; every other machine op to its one machine. */
export function consentedMachineRevisions(enrollments: MachinePort["enrollments"] | undefined, operation: ConsentedMachineOperation): Record<string, number> {
  return operation.op === "machine_peer_lease"
    ? machineDomainRevisions(enrollments, operation.args.from, operation.args.to)
    : machineDomainRevisions(enrollments, operation.args.machineId);
}

/** The saved tool invocation holds the proposed key; revisions bind consent to current authority. */
export function executeApprovedMachine(
  port: MachinePort | undefined,
  operation: ConsentedMachineOperation,
  context: ToolExecutionContext,
): MachineResult {
  if (context.domainRevisions === undefined)
    return executeMachine(port, operation, `session:${context.sessionId}`);
  if (canonicalDigest({ ...context.domainRevisions }) !== canonicalDigest(consentedMachineRevisions(port?.enrollments, operation)))
    throw new Core.ToolRefused("provision", "domain revision changed");
  return executeMachine(port, operation, "owner");
}
