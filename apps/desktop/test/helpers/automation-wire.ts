import { Ingress } from "@oni/protocol";
import { createGatewayChatTransport } from "../../src/renderer/chat/gateway-transport";

export const automationRecord = {
  id: "alerts", position: 0, enabled: true, createdBy: "owner",
  when: { instance: "channel:discord:main", addressed: true },
  outcome: { kind: "deliver", target: "new", deliveryKind: "action", reply: "auto" },
} satisfies Ingress.Rule;

export const ledgerRows: Ingress.RoutingDecisionPayload[] = [
  ...(["matched", "filtered", "refused", "deduped", "grouped", "superseded"] as const).map((decision, index) => ({
    traceId: "trace-1", inboundId: decision === "deduped" ? "matched" : decision === "superseded" ? "conversation" : decision,
    time: 600 - index * 10, surface: "discord", mode: "direct" as const, stage: "automation" as const,
    outcome: "record" as const, decision, by: "rule/alerts", factsDigest: "sha256:digest",
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
    ...(decision === "filtered" ? { verdict: "no" as const } : {}),
    ...(decision === "refused" ? { verdict: "unknown" as const } : {}),
  })),
];

export function createAutomationFixture(
  initial: readonly Ingress.Rule[] = [automationRecord],
  rows = ledgerRows,
  intercept?: (request: Ingress.RuleRequest) => Ingress.RuleResponse | "close" | "hold" | undefined,
) {
  const records = new Map(initial.map((record) => [record.id, record]));
  const requests: Ingress.RuleRequest[] = [];
  let sequence = 0;
  let refusal: Ingress.RuleRefusalReason | null = null;
  const sockets: FixtureSocket[] = [];
  const served = new Set<(request: Ingress.RuleRequest) => void>();
  function respond(request: Ingress.RuleRequest): Ingress.RuleResponse {
    const requestId = request.requestId;
    if (refusal !== null) return {
      type: `${request.type}_refused`, requestId, reason: refusal, detail: "Fixture refusal",
      issues: [{ path: ["triggers"], message: "Invalid trigger", code: "invalid_value" }],
    };
    switch (request.type) {
      case "rule_list": return { type: "rule_listed", requestId, records: [...records.values()] };
      case "rule_add": {
        const record = { ...request.record, id: request.record.id ?? `record-${++sequence}` };
        records.set(record.id, record);
        return { type: "rule_added", requestId, record };
      }
      case "rule_ledger":
        return { type: "rule_ledger_read", requestId, rows: rows.filter((row) =>
          (request.surface === undefined || row.surface === request.surface) &&
          (request.decision === undefined || row.stage === "automation" && row.decision === request.decision) &&
          (request.recordId === undefined || row.stage === "automation" && row.by === `rule/${request.recordId}`) &&
          (request.since === undefined || row.time >= request.since) &&
          (request.until === undefined || row.time <= request.until),
        ).slice(0, request.limit) };
      case "rule_move": {
        const record = records.get(request.id);
        if (record === undefined) return { type: "rule_move_refused", requestId, reason: "not_found", detail: "Missing record" };
        const ordered = [...records.values()].sort((a, b) => a.position - b.position).filter((row) => row.id !== request.id);
        ordered.splice(request.position, 0, record);
        for (const [position, row] of ordered.entries()) records.set(row.id, { ...row, position });
        return { type: "rule_moved", requestId, record: { ...record, position: request.position } };
      }
      default: {
        const record = records.get(request.id);
        if (record === undefined) return { type: `${request.type}_refused`, requestId, reason: "not_found", detail: "Missing record", id: request.id };
        if (request.type === "rule_remove") {
          if (record.seed === true) return { type: "rule_remove_refused", requestId, reason: "seed_protected", detail: "Seed rows can only be disabled" };
          records.delete(request.id);
          return { type: "rule_removed", requestId, id: request.id };
        }
        const next = { ...record, enabled: request.type === "rule_enable" };
        records.set(request.id, next);
        return { type: request.type === "rule_enable" ? "rule_enabled" : "rule_disabled", requestId, record: next };
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
      const request = Ingress.RuleRequest.parse(JSON.parse(raw));
      requests.push(request);
      const response = intercept?.(request) ?? respond(request);
      queueMicrotask(() => {
        if (response === "close") this.close();
        else if (response !== "hold") this.deliver(response);
        for (const listener of served) listener(request);
      });
    }
    deliver(response: Ingress.RuleResponse) {
      this.deliverRaw(JSON.stringify(Ingress.RuleResponse.parse(response)));
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
    nextRequest: () => new Promise<Ingress.RuleRequest>((resolve) => {
      const listener = (request: Ingress.RuleRequest) => { served.delete(listener); resolve(request); };
      served.add(listener);
    }),
    WebSocketImpl: FixtureSocket,
    refuse: (reason: Ingress.RuleRefusalReason | null) => { refusal = reason; },
    transport: createGatewayChatTransport({ url: "ws://fixture", id: () => `request-${++sequence}`, WebSocketImpl: FixtureSocket }),
  };
}
