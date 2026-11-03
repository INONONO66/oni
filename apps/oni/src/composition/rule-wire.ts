import { RuleConfigurationError, RuleEnableRefused } from "@oni/channels";
import { Ingress } from "@oni/protocol";
import { Effect, Result } from "effect";
import { z } from "zod";
import { ThrownError } from "../thrown";
import type { ProvisionPort } from "../bundles/provision/channels";
import type { StoreEditPort } from "../store-edits";

type RulePort = ProvisionPort["rules"];

function refused(request: Ingress.RuleRequest, reason: Ingress.RuleRefusalReason, detail: string = reason): Ingress.RuleRefused {
  return Ingress.RuleRefused.parse({ type: `${request.type}_refused`, requestId: request.requestId, reason, detail });
}

function respond(port: RulePort, request: Ingress.RuleRequest): Ingress.RuleResponse {
  const { store } = port;
  const { requestId } = request;
  switch (request.type) {
    case "rule_add": {
      const id = request.record.id ?? port.id();
      const entry = store.add({ ...request.record, id, createdBy: "owner" }, true);
      return { type: "rule_added", requestId, record: entry.record };
    }
    case "rule_list": return { type: "rule_listed", requestId, records: store.list().map((entry) => entry.record) };
    case "rule_ledger": {
      const { type: _type, requestId: _id, ...query } = request;
      return { type: "rule_ledger_read", requestId, rows: store.ledger(query) };
    }
    case "rule_remove":
      return store.remove(request.id) ? { type: "rule_removed", requestId, id: request.id } : refused(request, "not_found");
    case "rule_enable":
      store.approve(request.id);
      return { type: "rule_enabled", requestId, record: store.enable(request.id).record };
    case "rule_disable":
      return { type: "rule_disabled", requestId, record: store.disable(request.id).record };
    case "rule_move":
      return { type: "rule_moved", requestId, record: store.move(request.id, request.position).record };
  }
}

function auditedResponse(port: RulePort, request: Ingress.RuleRequest, edits: StoreEditPort): Ingress.RuleResponse {
  return edits.transaction(() => {
    const response = respond(port, request);
    switch (response.type) {
      case "rule_added":
      case "rule_moved":
      case "rule_enabled":
      case "rule_disabled":
      case "rule_removed": {
        const { requestId, ...change } = response;
        edits.record({ id: edits.id(), time: edits.now(), caller: "owner", requestId, change });
      }
    }
    return response;
  });
}

function failureResponse(request: Ingress.RuleRequest, error: Error): Ingress.RuleRefused {
  if (error instanceof RuleEnableRefused)
    return refused(request, error.reason === "not_authorized" ? "require_approval" : error.reason);
  if (error instanceof RuleConfigurationError) return refused(request, "store_unconfigured");
  if (error instanceof z.ZodError) return refused(request, "invalid_record", error.message);
  return refused(request, "store_failed", error.message);
}

/** The rule API is a store door, not a model tool. */
export function ruleWire(port: RulePort | undefined, edits: StoreEditPort) {
  return (request: Ingress.RuleRequest, caller: "owner" | `session:${string}`) => Effect.sync(() => {
    if (caller !== "owner") return refused(request, "require_approval", "Owner authentication is required");
    if (port === undefined) return refused(request, "store_unconfigured");
    const result = Result.try({ try: () => auditedResponse(port, request, edits), catch: ThrownError.parse });
    return Result.isSuccess(result) ? result.success : failureResponse(request, result.failure);
  });
}
