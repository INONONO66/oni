import { Ingress } from "@oni/protocol";
import { createGatewayChatTransport } from "../../src/renderer/chat/gateway-transport";

export const automationRecord: Ingress.Automation = {
  id: "alerts", name: "Review alerts", enabled: true, createdBy: "owner",
  triggers: [{ type: "message", surface: "discord", event: "mention" }],
  target: "new", kind: "action",
};

export const ledgerRows: Ingress.RoutingDecisionPayload[] = [
  ...(["matched", "filtered", "refused", "deduped", "grouped", "superseded"] as const).map((decision, index) => ({
    traceId: "trace-1", inboundId: decision === "deduped" ? "matched" : decision === "superseded" ? "conversation" : decision,
    time: 600 - index * 10, surface: "discord", mode: "direct" as const, stage: "automation" as const,
    outcome: "record" as const, decision, by: "automation/alerts", factsDigest: "sha256:digest",
    // advanceGroups / closeRows share the stored group id, not the delivery message id.
    factsUsed: decision === "grouped" || decision === "matched" || decision === "deduped"
      ? ["grouping", 'group:["alerts","thread-1","grouped"]'] : ["channels"],
    reason: {
      grouped: "firing:gateway-message-42", deduped: "event_id_dedupe", filtered: "channels",
      refused: "dispatch:target_not_found", superseded: "conversation", matched: "matched",
    }[decision],
    ...(decision === "grouped" || decision === "deduped" ? { target: "session:action-session" } : {}),
    ...(decision === "matched" ? { target: "session:action-session", actionSeq: 4 } : {}),
    ...(decision === "superseded" ? { target: "session:prompt-winner" } : {}),
    ...(decision === "filtered" ? { runWhen: { verdict: "no" as const, reason: "Outside working hours" } } : {}),
    ...(decision === "refused" ? { runWhen: { verdict: "unknown" as const, reason: "Missing event evidence" } } : {}),
  })),
];

export function createAutomationFixture(
  initial = [automationRecord],
  rows = ledgerRows,
  intercept?: (request: Ingress.AutomationRequest) => Ingress.AutomationResponse | "close" | "hold" | undefined,
) {
  const records = new Map(initial.map((record) => [record.id, record]));
  const requests: Ingress.AutomationRequest[] = [];
  let sequence = 0;
  let refusal: Ingress.AutomationRefusalReason | null = null;
  const sockets: FixtureSocket[] = [];
  const served = new Set<(request: Ingress.AutomationRequest) => void>();
  function respond(request: Ingress.AutomationRequest): Ingress.AutomationResponse {
    const requestId = request.requestId;
    if (refusal !== null) return {
      type: `${request.type}_refused`, requestId, reason: refusal, detail: "Fixture refusal",
      issues: [{ path: ["triggers"], message: "Invalid trigger", code: "invalid_value" }],
    };
    switch (request.type) {
      case "automation_list": return { type: "automation_listed", requestId, records: [...records.values()] };
      case "automation_add": {
        const record = { ...request.record, id: request.record.id ?? `record-${++sequence}` };
        records.set(record.id, record);
        return { type: "automation_added", requestId, record };
      }
      case "automation_ledger":
        return { type: "automation_ledger_read", requestId, rows: rows.filter((row) =>
          (request.surface === undefined || row.surface === request.surface) &&
          (request.decision === undefined || row.stage === "automation" && row.decision === request.decision) &&
          (request.recordId === undefined || row.stage === "automation" && row.by === `automation/${request.recordId}`) &&
          (request.since === undefined || row.time >= request.since) &&
          (request.until === undefined || row.time <= request.until),
        ).slice(0, request.limit) };
      default: {
        const record = records.get(request.id);
        if (record === undefined) return { type: `${request.type}_refused`, requestId, reason: "not_found", detail: "Missing record", id: request.id };
        if (request.type === "automation_remove") {
          records.delete(request.id);
          return { type: "automation_removed", requestId, id: request.id };
        }
        const next = { ...record, enabled: request.type === "automation_enable" };
        records.set(request.id, next);
        return { type: request.type === "automation_enable" ? "automation_enabled" : "automation_disabled", requestId, record: next };
      }
    }
  }
  class FixtureSocket {
    readyState = 0;
    readonly events = { open: new Set<() => void>(), close: new Set<() => void>(), error: new Set<() => void>() };
    readonly messages = new Set<(event: { data: string | ArrayBuffer | Blob }) => void>();
    constructor() {
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; for (const listener of this.events.open) listener(); });
    }
    addEventListener(...args:
      | ["open" | "close" | "error", () => void]
      | ["message", (event: { data: string | ArrayBuffer | Blob }) => void]
    ) {
      if (args[0] === "message") this.messages.add(args[1]);
      else this.events[args[0]].add(args[1]);
    }
    send(raw: string) {
      const request = Ingress.AutomationRequest.parse(JSON.parse(raw));
      requests.push(request);
      const response = intercept?.(request) ?? respond(request);
      queueMicrotask(() => {
        if (response === "close") this.close();
        else if (response !== "hold") this.deliver(response);
        for (const listener of served) listener(request);
      });
    }
    deliver(response: Ingress.AutomationResponse) {
      this.deliverRaw(JSON.stringify(Ingress.AutomationResponse.parse(response)));
    }
    deliverRaw(data: string) {
      for (const listener of this.messages) listener({ data });
    }
    close() {
      this.readyState = 3;
      for (const listener of this.events.close) listener();
    }
  }
  return {
    records, requests, sockets,
    nextRequest: () => new Promise<Ingress.AutomationRequest>((resolve) => {
      const listener = (request: Ingress.AutomationRequest) => { served.delete(listener); resolve(request); };
      served.add(listener);
    }),
    WebSocketImpl: FixtureSocket,
    refuse: (reason: Ingress.AutomationRefusalReason | null) => { refusal = reason; },
    transport: createGatewayChatTransport({ url: "ws://fixture", id: () => `request-${++sequence}`, WebSocketImpl: FixtureSocket }),
  };
}
