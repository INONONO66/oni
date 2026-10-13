import { describe, expect, test } from "bun:test";
import { Ingress } from "../src/ingress";

const record: Ingress.Automation = {
  id: "alerts",
  name: "Alert review",
  enabled: true,
  createdBy: "owner",
  triggers: [{ type: "on_demand" }],
  target: "new",
  kind: "action",
};

describe("automation gateway wire", () => {
  test("parses all six requests with request correlation and server minted IDs", () => {
    const inputs = [
      { type: "automation_add", record: { ...record, id: undefined } },
      { type: "automation_remove", id: "alerts" },
      { type: "automation_enable", id: "alerts" },
      { type: "automation_disable", id: "alerts" },
      { type: "automation_list" },
      { type: "automation_ledger", surface: "discord", decision: "filtered", recordId: "alerts", since: 100, until: 200 },
    ] as const;
    const parsed = inputs.map((input) => Ingress.AutomationRequest.parse({ ...input, requestId: "request-1" }));
    expect(parsed.map((input) => input.type)).toEqual(inputs.map((input) => input.type));
    expect(parsed.every((input) => input.requestId === "request-1")).toBe(true);
    expect(parsed.at(-1)).toMatchObject({ limit: 200, since: 100, until: 200 });
  });

  test.each([
    { type: "automation_add", record: { ...record, triggers: [] } },
    { type: "automation_add", record: { ...record, target: "existing" } },
    { type: "automation_enable", id: "" },
    { type: "automation_ledger", limit: 0 },
    { type: "automation_ledger", since: -1 },
    { type: "automation_ledger", decision: "fired" },
    { type: "automation_list", caller: "owner" },
  ])("refuses invalid request input %#", (input) => {
    expect(Ingress.AutomationRequest.safeParse({ ...input, requestId: "request-1" }).success).toBe(false);
  });

  test("preserves each success payload and rejects missing correlation", () => {
    const inputs = [
      { type: "automation_added" as const, record },
      { type: "automation_removed" as const, id: "alerts" },
      { type: "automation_enabled" as const, record },
      { type: "automation_disabled" as const, record },
      { type: "automation_listed" as const, records: [record] },
      { type: "automation_ledger_read" as const, rows: [] },
    ];
    for (const input of inputs) {
      const frame = { ...input, requestId: "request-2" };
      expect(Ingress.AutomationResponse.parse(frame)).toEqual(frame);
      expect(Ingress.AutomationResponse.safeParse(input).success).toBe(false);
    }
  });

  test("preserves typed refusals and validation issues for inline rendering", () => {
    for (const reason of Ingress.AutomationRefusalReason.options) {
      for (const type of Ingress.AutomationRefused.shape.type.options) {
        const frame = { type, requestId: "request-3", reason, detail: "Record refused", id: "alerts",
          issues: [{ path: ["triggers", 0], message: "Required", code: "too_small" }] };
        expect(Ingress.AutomationResponse.parse(frame)).toEqual(frame);
      }
    }
    expect(Ingress.AutomationRefusalReason.safeParse("storage").success).toBe(false);
  });

  test("validates ledger evidence without adding relationship fields", () => {
    const row: Ingress.RoutingDecisionPayload = {
      traceId: "trace-1", time: 100, inboundId: "event-1", surface: "discord", mode: "direct",
      stage: "automation", outcome: "record", decision: "grouped", by: "automation/alerts",
      reason: "firing:message-1", factsUsed: ["group:channel-1"], factsDigest: "sha256:one",
      runWhen: { verdict: "unknown", reason: "Insufficient evidence" },
    };
    const frame = { type: "automation_ledger_read" as const, requestId: "request-4", rows: [row] };
    expect(Ingress.AutomationResponse.parse(frame)).toEqual(frame);
    expect(Ingress.AutomationResponse.safeParse({ ...frame, rows: [{ ...row, originalEventId: "other" }] }).success).toBe(false);
    expect(Ingress.AutomationLedgerFilter.parse({})).toEqual({ limit: 200 });
  });
});
