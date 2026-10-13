import { Ingress } from "@openomni/protocol";
import { Effect } from "effect";
import { automationLedger, executeAutomation, type AutomationPort } from "../provisioning/automation";
import { AutomationOperation, type AutomationRefusal } from "../provisioning/automation-schema";

const successes = {
  automation_add: "automation_added",
  automation_remove: "automation_removed",
  automation_enable: "automation_enabled",
  automation_disable: "automation_disabled",
  automation_list: "automation_listed",
} as const;

/** Every refusal, including schema failures, answers the request it correlates with. */
function refused(request: Ingress.AutomationRequest, refusal: AutomationRefusal,
  issues?: Ingress.AutomationRefused["issues"]): Ingress.AutomationRefused {
  return Ingress.AutomationRefused.parse({
    type: `${request.type}_refused`, requestId: request.requestId, reason: refusal.reason, detail: refusal.reason,
    ...(refusal.id === undefined ? {} : { id: refusal.id }),
    ...(issues === undefined ? {} : { issues }),
  });
}

function automationResponse(port: AutomationPort | undefined, request: Ingress.AutomationRequest,
  caller: "owner" | `session:${string}`): Ingress.AutomationResponse {
  if (request.type === "automation_ledger") {
    const { type: _type, requestId, ...query } = request;
    const rows = automationLedger(port, query);
    return "type" in rows ? refused(request, rows) : { type: "automation_ledger_read", requestId, rows };
  }
  const { type, requestId, ...args } = request;
  const operation = AutomationOperation.safeParse({ op: type, args });
  if (!operation.success)
    return refused(request, { type: "error", reason: "invalid_record" }, operation.error.issues.map((issue) =>
      ({ path: issue.path.map(String), message: issue.message, code: issue.code })));
  const outcome = executeAutomation(port, operation.data, caller);
  if ("type" in outcome) return refused(request, outcome);
  const { result } = outcome;
  if ("type" in result) return refused(request, { type: "error", reason: "require_approval", id: result.id });
  return Ingress.AutomationResponse.parse({ type: successes[type], requestId, ...result });
}

/** The desktop and session socket use the same provisioning implementation as the tool. */
export function automationWire(port: AutomationPort | undefined) {
  return (request: Ingress.AutomationRequest, caller: "owner" | `session:${string}`) =>
    Effect.sync(() => automationResponse(port, request, caller));
}
