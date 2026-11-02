import { RuleConfigurationError, RuleEnableRefused } from "@oni/channels";
import { Ingress } from "@oni/protocol";
import { Effect, Result } from "effect";
import { ThrownError } from "../thrown";
import type { ProvisionPort } from "../bundles/provision/channels";

type RulePort = ProvisionPort["rules"];

function refused(request: Ingress.RuleRequest, reason: Ingress.RuleRefusalReason): Ingress.RuleRefused {
  return Ingress.RuleRefused.parse({ type: `${request.type}_refused`, requestId: request.requestId, reason, detail: reason });
}

function respond(port: RulePort, request: Ingress.RuleRequest,
  caller: "owner" | `session:${string}`): Ingress.RuleResponse {
  const { store } = port;
  const { requestId } = request;
  switch (request.type) {
    case "rule_add": {
      const id = request.record.id ?? port.id();
      if (caller !== "owner" && store.get(id) !== undefined) return refused(request, "require_approval");
      const entry = store.add({ ...request.record, id, createdBy: caller,
        seed: caller === "owner" && request.record.seed === true,
        enabled: caller === "owner" && request.record.enabled }, caller === "owner");
      return caller === "owner" ? { type: "rule_added", requestId, record: entry.record } : refused(request, "require_approval");
    }
    case "rule_list": return { type: "rule_listed", requestId, records: store.list().map((entry) => entry.record) };
    case "rule_ledger": {
      const { type: _type, requestId: _id, ...query } = request;
      return { type: "rule_ledger_read", requestId, rows: store.ledger(query) };
    }
    case "rule_remove":
      if (caller !== "owner") return refused(request, "require_approval");
      return store.remove(request.id) ? { type: "rule_removed", requestId, id: request.id } : refused(request, "not_found");
    case "rule_enable":
      if (caller !== "owner") return refused(request, "require_approval");
      store.approve(request.id);
      return { type: "rule_enabled", requestId, record: store.enable(request.id).record };
    case "rule_disable":
      if (caller !== "owner") return refused(request, "require_approval");
      return { type: "rule_disabled", requestId, record: store.disable(request.id).record };
    case "rule_move":
      if (caller !== "owner") return refused(request, "require_approval");
      return { type: "rule_moved", requestId, record: store.move(request.id, request.position).record };
  }
}

/** The rule API is a store door, not a model tool. */
export function ruleWire(port: RulePort | undefined) {
  return (request: Ingress.RuleRequest, caller: "owner" | `session:${string}`) => Effect.sync(() => {
    if (port === undefined) return refused(request, "store_unconfigured");
    const result = Result.try({ try: () => respond(port, request, caller), catch: ThrownError.parse });
    if (Result.isSuccess(result)) return result.success;
    const error = result.failure;
    if (error instanceof RuleEnableRefused)
      return refused(request, error.reason === "approval_required" ? "require_approval" : error.reason);
    return refused(request, error instanceof RuleConfigurationError ? "store_unconfigured" : "invalid_record");
  });
}
