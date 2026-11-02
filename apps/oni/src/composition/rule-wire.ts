import { RuleConfigurationError, RuleEnableRefused } from "@oni/channels";
import { Ingress } from "@oni/protocol";
import { Effect, Result } from "effect";
import { z } from "zod";
import { ThrownError } from "../thrown";
import type { ProvisionPort } from "../bundles/provision/channels";

type RulePort = ProvisionPort["rules"];

function refused(request: Ingress.RuleRequest, reason: Ingress.RuleRefusalReason, detail: string = reason): Ingress.RuleRefused {
  return Ingress.RuleRefused.parse({ type: `${request.type}_refused`, requestId: request.requestId, reason, detail });
}

function respond(port: RulePort, request: Ingress.RuleRequest,
  caller: "owner" | `session:${string}`): Ingress.RuleResponse {
  const { store } = port;
  const { requestId } = request;
  switch (request.type) {
    case "rule_add": {
      const id = request.record.id ?? port.id();
      if (caller !== "owner" && store.get(id) !== undefined) return refused(request, "require_approval");
      // A session's row lands disabled, awaiting the Owner's enable; the answer carries it so the proposal is addressable.
      const entry = store.add({ ...request.record, id, createdBy: caller,
        enabled: caller === "owner" && request.record.enabled }, caller === "owner");
      return { type: "rule_added", requestId, record: entry.record };
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
      return refused(request, error.reason === "not_authorized" ? "require_approval" : error.reason);
    if (error instanceof RuleConfigurationError) return refused(request, "store_unconfigured");
    if (error instanceof z.ZodError) return refused(request, "invalid_record", error.message);
    // Any other failure is the store's, not the record's: the frame names the cause so nothing reads as a bad request.
    return refused(request, "store_failed", error.message);
  });
}
