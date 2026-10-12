import { expect, test } from "bun:test";
import { z } from "zod";
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

const LEDGER_KEYS = [
  "actionSeq",
  "actorId",
  "by",
  "decision",
  "factsDigest",
  "factsUsed",
  "inboundId",
  "inboundTreatment",
  "mode",
  "outcome",
  "reason",
  "runWhen",
  "sessionId",
  "stage",
  "surface",
  "target",
  "time",
  "traceId",
  "trustTier",
] as const;

for (const decision of ["matched", "filtered", "refused", "deduped", "grouped", "superseded"] as const) {
  test(`${decision} ledger row accepts exactly the allowlisted keys`, () => {
    const full = {
      ...base,
      decision,
      runWhen: { verdict: "yes" as const, reason: "owner mention" },
      target: "session:1",
      actionSeq: 2,
      sessionId: "session-1",
      actorId: "actor-1",
      trustTier: "owner" as const,
      inboundTreatment: "full_access" as const,
    };
    expect(schema.parse(full)).toEqual(full);
    expect(schema.safeParse({ ...full, extra: 1 }).success).toBe(false);
  });
}

// Asserted on the declared shape, not a parsed value: Zod drops absent optional keys from
// its output, so a new optional body-carrying field would otherwise keep this test green.
test("every ledger variant declares exactly the allowlisted keys", () => {
  const variants = schema instanceof z.ZodUnion ? schema.options : [];
  const ledgerShapes = variants.flatMap((option) =>
    option instanceof z.ZodObject &&
    option.shape.stage instanceof z.ZodLiteral &&
    option.shape.stage.value === "automation"
      ? [Object.keys(option.shape).sort()]
      : [],
  );
  expect(ledgerShapes).toHaveLength(6);
  for (const keys of ledgerShapes) {
    expect(keys).toEqual([...LEDGER_KEYS]);
  }
});

test("the ledger target is a session ref", () => {
  expect(schema.safeParse({ ...base, decision: "matched", target: "new" }).success).toBe(false);
  expect(schema.safeParse({ ...base, decision: "matched", target: "session:" }).success).toBe(false);
});

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
