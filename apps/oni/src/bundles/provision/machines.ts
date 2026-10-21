import { Core } from "@oni/agent";
import type { createMachineEnrollmentStore } from "@oni/channels";
import type { MachineHost } from "@oni/machines";
import { canonicalDigest, Machine, type BusEvent, type ToolExecutionContext } from "@oni/protocol";
import type { MachineOperation, MachineResult } from "./machine-schema";

export interface MachinePort {
  readonly enrollments: ReturnType<typeof createMachineEnrollmentStore>;
  readonly host: Pick<MachineHost, "list" | "unenroll">;
  readonly selfId: string;
  readonly events: BusEvent.Sink;
  readonly now: () => number;
}

export function executeMachine(
  port: MachinePort | undefined,
  operation: MachineOperation,
  caller: "owner" | `session:${string}`,
): MachineResult {
  if (port === undefined) throw new Core.ToolRefused("provision", "machine provisioning is not composed");
  if (operation.op === "machine_list") return { op: operation.op, result: { rows: port.host.list() } };
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
  }
}

export function machineDomainRevisions(enrollments: MachinePort["enrollments"] | undefined, machineId: string): Record<string, number> {
  return { [`machine:${machineId}`]: enrollments?.get(machineId)?.revision ?? -1 };
}

/** The saved tool invocation holds the proposed key; revisions bind consent to current authority. */
export function executeApprovedMachine(
  port: MachinePort | undefined,
  operation: Extract<MachineOperation, { op: "machine_add" }>,
  context: ToolExecutionContext,
): MachineResult {
  if (context.domainRevisions === undefined)
    return executeMachine(port, operation, `session:${context.sessionId}`);
  if (canonicalDigest({ ...context.domainRevisions }) !== canonicalDigest(machineDomainRevisions(port?.enrollments, operation.args.machineId)))
    throw new Core.ToolRefused("provision", "domain revision changed");
  return executeMachine(port, operation, "owner");
}
