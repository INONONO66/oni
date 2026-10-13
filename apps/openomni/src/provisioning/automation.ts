import { Core } from "@openomni/agent";
import { canonicalDigest, type ToolExecutionContext } from "@openomni/protocol";
import { AutomationConfigurationError, type createAutomationStore } from "@openomni/channels";
import type { AutomationOperation, AutomationResult, AutomationRefusal } from "./automation-schema";

export class AutomationRefused extends Core.ToolRefused {
  constructor(readonly refusal: AutomationRefusal) {
    super("provision", refusal.reason);
  }
}

export interface AutomationPort {
  readonly store: ReturnType<typeof createAutomationStore>;
  readonly id: () => string;
}

function ownerEnable(store: AutomationPort["store"], id: string) {
  store.approve(id);
  return { record: store.enable(id).record };
}

function addAutomation(
  port: AutomationPort,
  operation: Extract<AutomationOperation, { op: "automation_add" }>,
  caller: "owner" | `session:${string}`,
): AutomationResult {
  const record = {
    ...operation.args.record,
    id: operation.args.record.id ?? port.id(),
    createdBy: caller,
    enabled: caller === "owner" && operation.args.record.enabled,
  };
  // Session callers cannot replace an approved record with their own bytes.
  const existing = port.store.get(record.id);
  if (caller !== "owner" && existing !== undefined) {
    if (canonicalDigest(existing.record) !== canonicalDigest(record))
      throw new AutomationRefused({ type: "error", reason: "invalid_record", id: record.id });
    return { op: operation.op, result: { type: "require_approval", id: record.id } };
  }
  try {
    port.store.add(record, caller === "owner");
  } catch (error) {
    if (!(error instanceof AutomationConfigurationError)) throw error;
    throw new AutomationRefused({
      type: "error", reason: error.reason === "store_unconfigured" ? error.reason : "invalid_record", id: record.id,
    });
  }
  return { op: operation.op, result: caller === "owner"
    ? { record } : { type: "require_approval", id: record.id } };
}

/** Both gateway and tool callers enter here; creator and approval are never caller data. */
export function executeAutomation(
  port: AutomationPort | undefined,
  operation: AutomationOperation,
  caller: "owner" | `session:${string}`,
): AutomationResult {
  if (port === undefined)
    throw new AutomationRefused({ type: "error", reason: "store_unconfigured" });
  const { store } = port;
  switch (operation.op) {
    case "automation_add":
      return addAutomation(port, operation, caller);
    case "automation_list":
      return { op: operation.op, result: { records: store.list().map((entry) => entry.record) } };
    case "automation_remove":
    case "automation_enable":
    case "automation_disable": {
      const { id } = operation.args;
      if (store.get(id) === undefined)
        throw new AutomationRefused({ type: "error", reason: "not_found", id });
      if (operation.op === "automation_remove") {
        store.remove(id);
        return { op: operation.op, result: { id } };
      }
      if (operation.op === "automation_disable")
        return { op: operation.op, result: { record: store.disable(id).record } };
      if (caller !== "owner")
        return { op: operation.op, result: { type: "require_approval", id } };
      return { op: operation.op, result: ownerEnable(store, id) };
    }
  }
}

/** A session proposal's id survives approval recovery without minting another draft. */
export function automationId(operation: AutomationOperation, context: {
  readonly sessionId: string; readonly turnId: string | null; readonly callId: string;
}): string {
  switch (operation.op) {
    case "automation_add":
      return operation.args.record.id ?? `automation:${canonicalDigest([context.sessionId, context.turnId, context.callId])}`;
    case "automation_list":
      return "";
    default:
      return operation.args.id;
  }
}

export function automationDomainRevisions(port: AutomationPort | undefined, id: string): Record<string, number> {
  return { [`automation:${id}:${canonicalDigest(port?.store.get(id) ?? null)}`]: 0 };
}

/** Prepare a disabled draft once, then bind consent to its exact stored revision. */
export function automationApproval(port: AutomationPort | undefined) {
  return (
    operation: Extract<AutomationOperation, { op: "automation_add" | "automation_enable" }>,
    context: ToolExecutionContext,
    prepare: boolean,
  ) => {
    const id = automationId(operation, context);
    if (prepare)
      executeAutomation(port, operation.op === "automation_add"
        ? { ...operation, args: { record: { ...operation.args.record, id } } }
        : operation, `session:${context.sessionId}`);
    return { required: true, domainRevisions: automationDomainRevisions(port, id) };
  };
}

/** Consent only spends the exact record the Owner saw, never a subsequently edited one. */
export function executeApprovedAutomation(
  port: AutomationPort | undefined,
  operation: Extract<AutomationOperation, { op: "automation_add" | "automation_enable" }>,
  context: ToolExecutionContext,
): AutomationResult {
  const id = automationId(operation, context);
  const scoped = operation.op === "automation_add"
    ? { ...operation, args: { record: { ...operation.args.record, id } } } : operation;
  if (context.domainRevisions === undefined)
    return executeAutomation(port, scoped, `session:${context.sessionId}`);
  if (port === undefined)
    throw new AutomationRefused({ type: "error", reason: "store_unconfigured" });
  if (canonicalDigest({ ...context.domainRevisions }) !== canonicalDigest(automationDomainRevisions(port, id)))
    throw new Core.ToolRefused(operation.op, "domain revision changed");
  return { op: operation.op, result: ownerEnable(port.store, id) };
}
