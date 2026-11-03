import { parseJson, PlainValueSchema, Provisioning } from "@oni/protocol";
import { Result } from "effect";
import type { AgentStore } from "../agents";
import type { StoreEditPort } from "../store-edits";
import { ThrownError } from "../thrown";

type Refused = Extract<Provisioning.AgentResponse, { reason: string }>;

function respond(store: AgentStore, edits: StoreEditPort, request: Provisioning.AgentRequest): Provisioning.AgentResponse {
  if (request.type === "agent_list")
    return { type: "agent_listed", requestId: request.requestId, records: store.list() };
  return edits.transaction(() => {
    const record = request.type === "agent_add" ? store.add(request.record) : store.get(request.id);
    if (request.type === "agent_disable") store.disable(request.id);
    const change = request.type === "agent_add"
      ? { type: "agent_added" as const, record }
      : { type: "agent_disabled" as const, record: { ...record, enabled: false } };
    edits.record({ id: edits.id(), time: edits.now(), caller: "owner", requestId: request.requestId, change });
    return { ...change, requestId: request.requestId };
  });
}

/** Agent declarations are settings, separate from the machine's live agent-session methods. */
export function agentWire(store: AgentStore | undefined, edits: StoreEditPort) {
  return (
    data: string | Buffer,
    access: { readonly authenticated: boolean; readonly caller: "owner" | `session:${string}` },
  ): Provisioning.AgentResponse | undefined => {
    const document = parseJson(PlainValueSchema, typeof data === "string" ? data : data.toString());
    if (document === null || typeof document !== "object" || Array.isArray(document)) return undefined;
    const method = Provisioning.AgentRequest.options.find((option) => option.shape.type.value === document.type)?.shape.type.value;
    if (method === undefined) return undefined;
    const requestId = typeof document.requestId === "string" && document.requestId.length > 0 ? document.requestId : "invalid";
    const refused = (reason: Refused["reason"], detail: string): Refused =>
      ({ type: `${method}_refused`, requestId, reason, detail });
    if (!access.authenticated || access.caller !== "owner")
      return refused("owner_auth_required", "Owner authentication is required");
    const parsed = Provisioning.AgentRequest.safeParse(document);
    if (!parsed.success) return refused("invalid_record", parsed.error.message);
    if (store === undefined) return refused("store_unconfigured", "Agent store is not configured");
    const result = Result.try({
      try: () => Provisioning.AgentResponse.parse(respond(store, edits, parsed.data)),
      catch: ThrownError.parse,
    });
    if (Result.isSuccess(result)) return result.success;
    const error = result.failure;
    return refused(error instanceof Provisioning.AgentError ? error.data.code : "store_failed", error.message);
  };
}
