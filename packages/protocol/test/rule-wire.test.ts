import { describe, expect, test } from "bun:test";
import { Ingress } from "../src/ingress";

const record: Ingress.Rule = {
  id: "alerts",
  position: 0,
  enabled: true,
  createdBy: "owner",
  when: { instance: "chat" },
  outcome: { kind: "deliver", target: "new", deliveryKind: "action", reply: "none" },
};

describe("automation gateway wire", () => {
  test("parses all six requests with request correlation and server minted IDs", () => {
    const inputs = [
      { type: "rule_add", record: { ...record, id: undefined } },
      { type: "rule_remove", id: "alerts" },
      { type: "rule_enable", id: "alerts" },
      { type: "rule_disable", id: "alerts" },
      { type: "rule_list" },
      { type: "rule_move", id: "alerts", position: 0 },
      { type: "rule_ledger", surface: "discord", decision: "filtered", recordId: "alerts", since: 100, until: 200 },
    ] as const;
    const parsed = inputs.map((input) => Ingress.RuleRequest.parse({ ...input, requestId: "request-1" }));
    expect(parsed.map((input) => input.type)).toEqual(inputs.map((input) => input.type));
    expect(parsed.every((input) => input.requestId === "request-1")).toBe(true);
    expect(parsed.at(-1)).toMatchObject({ limit: 200, since: 100, until: 200 });
  });

  test.each([
    { type: "rule_add", record: { ...record, triggers: [] } },
    { type: "rule_add", record: { ...record, target: "existing" } },
    { type: "rule_enable", id: "" },
    { type: "rule_ledger", limit: 0 },
    { type: "rule_ledger", since: -1 },
    { type: "rule_ledger", decision: "fired" },
    { type: "rule_list", caller: "owner" },
  ])("refuses invalid request input %#", (input) => {
    expect(Ingress.RuleRequest.safeParse({ ...input, requestId: "request-1" }).success).toBe(false);
  });

  test("preserves each success payload and rejects missing correlation", () => {
    const inputs = [
      { type: "rule_added" as const, record },
      { type: "rule_removed" as const, id: "alerts" },
      { type: "rule_enabled" as const, record },
      { type: "rule_disabled" as const, record },
      { type: "rule_listed" as const, records: [record] },
      { type: "rule_moved" as const, record },
      { type: "rule_ledger_read" as const, rows: [] },
    ];
    for (const input of inputs) {
      const frame = { ...input, requestId: "request-2" };
      expect(Ingress.RuleResponse.parse(frame)).toEqual(frame);
      expect(Ingress.RuleResponse.safeParse(input).success).toBe(false);
    }
  });

  test("preserves typed refusals and validation issues for inline rendering", () => {
    for (const reason of Ingress.RuleRefusalReason.options) {
      for (const type of Ingress.RuleRefused.shape.type.options) {
        const frame = { type, requestId: "request-3", reason, detail: "Record refused", id: "alerts",
          issues: [{ path: ["triggers", 0], message: "Required", code: "too_small" }] };
        expect(Ingress.RuleResponse.parse(frame)).toEqual(frame);
      }
    }
    expect(Ingress.RuleRefusalReason.safeParse("storage").success).toBe(false);
  });

  test("validates ledger evidence without adding relationship fields", () => {
    const row: Ingress.RoutingDecisionPayload = {
      traceId: "trace-1", time: 100, inboundId: "event-1", surface: "discord", mode: "direct",
      stage: "automation", outcome: "record", decision: "grouped", by: "rule/alerts",
      reason: "firing:message-1", factsUsed: ["group:channel-1"], factsDigest: "sha256:one",
      verdict: "unknown",
    };
    const frame = { type: "rule_ledger_read" as const, requestId: "request-4", rows: [row] };
    expect(Ingress.RuleResponse.parse(frame)).toEqual(frame);
    expect(Ingress.RuleResponse.safeParse({ ...frame, rows: [{ ...row, originalEventId: "other" }] }).success).toBe(false);
    expect(Ingress.RuleLedgerFilter.parse({})).toEqual({ limit: 200 });
  });
});
