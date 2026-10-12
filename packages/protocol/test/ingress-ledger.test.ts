import { expect, test } from "bun:test";
import { Ingress } from "../src/ingress/index.js";

const schema = Ingress.Events.RoutingDecision.schema;
const base = {
  traceId: "trace-1",
  time: 1_750_000_000_000,
  inboundId: "event-1",
  surface: "discord",
  mode: "direct" as const,
  stage: "automation" as const,
  outcome: "record" as const,
  reason: "event-1",
  factsUsed: ["event.kind", "author.isBot"],
  by: "automation/alerts",
  factsDigest: "sha256:123",
};

for (const decision of ["matched", "filtered", "refused", "deduped", "grouped", "superseded"] as const) {
  test(`round-trips ${decision} ledger decision`, () => {
    const value = { ...base, decision, runWhen: { verdict: "unknown" as const, reason: "not enough facts" }, target: "session:1", actionSeq: 2 };
    expect(schema.parse(value)).toEqual(value);
    expect(Ingress.recordedRoutingDecision(value)).toEqual(value);
  });
}

test("the ledger row refuses full message bodies and invalid provenance", () => {
  expect(schema.safeParse({ ...base, decision: "matched", body: "full text" }).success).toBe(false);
  expect(schema.safeParse({ ...base, decision: "matched", payload: { body: "full text" } }).success).toBe(false);
  expect(schema.safeParse({ ...base, decision: "matched", by: "external/x" }).success).toBe(false);
  expect(schema.safeParse({ ...base, decision: "matched", factsDigest: "" }).success).toBe(false);
});

test("persisted routing rows still upcast historical fields", () => {
  const legacy = {
    traceId: "trace-1",
    time: 1_750_000_000_000,
    inboundId: "event-1",
    surface: "discord",
    mode: "direct",
    stage: "request_correlation",
    outcome: "ambiguous",
    reason: "multiple",
    factsUsed: [],
    candidateInteractionIds: ["pending_ask:a", "pending_interaction:b"],
    runId: "retired",
    pendingInteractionId: "retired",
  };
  const { runId, pendingInteractionId, ...upcast } = legacy;
  expect(Object.entries(Ingress.recordedRoutingDecision(legacy) ?? {}).sort()).toEqual(Object.entries(upcast).sort());
  expect(schema.safeParse(upcast).success).toBe(false);
});
