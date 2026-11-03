import { expect, test } from "bun:test";
import { Ingress } from "@oni/protocol";
import { requireRoutedDecision } from "../../../src/composition/ingress-execution.js";
import { IngressRoutingError } from "@oni/channels";

const base = { traceId: "trace", time: 1, inboundId: "input", surface: "chat", mode: "direct", reason: "refused", factsUsed: [] };

test.each([
  { stage: "request_correlation", outcome: "block" },
  { stage: "automation", outcome: "record", decision: "filtered", by: "rule/none", factsDigest: "digest" },
  { stage: "request_correlation", outcome: "ambiguous", candidateInteractionIds: ["request:one", "request:two"] },
])("non-routed decisions cannot reach a delivery body %#", (fields) => {
  const decision = Ingress.Events.RoutingDecision.schema.parse({ ...base, ...fields });
  expect(() => requireRoutedDecision(decision)).toThrow(IngressRoutingError);
  try { requireRoutedDecision(decision); } catch (error) {
    if (!(error instanceof IngressRoutingError)) throw error;
    expect(error.code).toBe(fields.outcome === "ambiguous" ? "route_ambiguous" : "route_blocked");
    expect(error.decision).toEqual(decision);
  }
});
