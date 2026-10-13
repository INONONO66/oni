import { AutomationConfigurationError } from "@openomni/channels";
import { Ingress } from "@openomni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import { AutomationRefused, executeAutomation, type AutomationPort } from "../provisioning/automation";
import { AutomationOperation } from "../provisioning/automation-schema";

const successes = {
  automation_add: "automation_added",
  automation_remove: "automation_removed",
  automation_enable: "automation_enabled",
  automation_disable: "automation_disabled",
  automation_list: "automation_listed",
} as const;

function automationResponse(port: AutomationPort | undefined, request: Ingress.AutomationRequest,
  caller: "owner" | `session:${string}`): Ingress.AutomationResponse {
  if (request.type === "automation_ledger") {
    if (port === undefined)
      throw new AutomationRefused({ type: "error", reason: "store_unconfigured" });
    const { type: _type, requestId, ...query } = request;
    return { type: "automation_ledger_read", requestId, rows: port.store.ledger(query) };
  }
  const { type, requestId, ...args } = request;
  const operation = AutomationOperation.parse({ op: type, args });
  const { result } = executeAutomation(port, operation, caller);
  if ("type" in result)
    throw new AutomationRefused({ type: "error", reason: "require_approval", id: result.id });
  return Ingress.AutomationResponse.parse({ type: successes[type], requestId, ...result });
}

/** The desktop and session socket use the same provisioning implementation as the tool. */
export function automationWire(port: AutomationPort | undefined) {
  return (request: Ingress.AutomationRequest, caller: "owner" | `session:${string}`) =>
    Effect.sync((): Ingress.AutomationResponse => {
      const refuse = (reason: Ingress.AutomationRefusalReason, detail: string, id?: string) =>
        Ingress.AutomationRefused.parse({
          type: `${request.type}_refused`, requestId: request.requestId, reason, detail,
          ...(id === undefined ? {} : { id }),
        });
      try {
        return automationResponse(port, request, caller);
      } catch (error) {
        if (error instanceof AutomationRefused)
          return refuse(error.refusal.reason, error.message, error.refusal.id);
        if (error instanceof AutomationConfigurationError)
          return refuse(error.reason === "store_unconfigured" ? error.reason : "invalid_record", error.reason);
        if (error instanceof z.ZodError)
          return { ...refuse("invalid_record", "Invalid automation record"),
            issues: error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message, code: issue.code })) };
        throw error;
      }
    });
}
