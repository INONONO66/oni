import { Core } from "@oni/agent";
import { canonicalDigest, type ToolExecutionContext } from "@oni/protocol";
import type { ComputerPort } from "../seams";
import type { ComputerOperation, ComputerResult } from "./computer-schema";

export function computerDomainRevisions(port: ComputerPort | undefined, sessionId: string, operation: ComputerOperation): Record<string, number> {
  if (operation.op !== "computer_request") return {};
  return { [`computer:${operation.args.machineId}`]: port?.store.get(sessionId, operation.args.machineId)?.revision ?? 0 };
}

export function computerApproval(port: ComputerPort | undefined, operation: ComputerOperation, context?: ToolExecutionContext) {
  return {
    required: operation.op === "computer_request" || operation.op === "computer_exclude",
    domainRevisions: computerDomainRevisions(port, context?.sessionId ?? "", operation),
  };
}

export function executeComputer(
  port: ComputerPort | undefined,
  operation: ComputerOperation,
  context: ToolExecutionContext,
): ComputerResult {
  if (port === undefined) throw new Core.ToolRefused("provision", "computer provisioning is not composed");
  const { sessionId } = context;
  switch (operation.op) {
    case "computer_request": {
      const { machineId, ...request } = operation.args;
      if (context.domainRevisions === undefined) return { op: operation.op, result: { type: "require_approval", id: machineId } };
      if (canonicalDigest(context.domainRevisions) !== canonicalDigest(computerDomainRevisions(port, sessionId, operation)))
        throw new Core.ToolRefused("provision", "computer lease revision changed");
      const prior = port.store.get(sessionId, machineId);
      const expiresAt = port.now() + request.minutes * 60_000;
      const lease = port.store.put({
        sessionId, machineId, apps: request.apps, clipboard: request.clipboard, expiresAt,
        budget: { actionsPerHour: Math.min(request.budget?.actionsPerHour ?? 1500, port.store.ceiling(machineId)) },
        admittedAt: [],
        ...(request.foreground === undefined ? {} : { foreground: { ...request.foreground, expiresAt } }),
        state: "active", revision: (prior?.revision ?? 0) + 1,
      });
      port.watch(machineId);
      return { op: operation.op, result: lease };
    }
    case "computer_list":
      return { op: operation.op, result: {
        leases: port.store.list().filter((lease) => lease.sessionId === sessionId)
          .map((lease) => ({ ...lease, usage: port.store.usage(lease, port.now()) })),
        exclusions: port.store.exclusions(),
      } };
    case "computer_end":
      port.end(sessionId, operation.args.machineId);
      return { op: operation.op, result: port.store.get(sessionId, operation.args.machineId) ?? null };
    case "computer_exclude":
      return { op: operation.op, result: context.domainRevisions === undefined
        ? { type: "require_approval", id: operation.args.machineId }
        : port.store.exclude(operation.args) };
    case "computer_keep":
      port.keep(sessionId, context.turnId, operation.args);
      return { op: operation.op, result: operation.args };
  }
}
