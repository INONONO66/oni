import { describe, expect, test } from "bun:test";
import { SessionHistory } from "../src";
import { Settings } from "../src/journal/core/session-configure";

const payload = { encodingVersion: 1, value: {} } as const;

function action(id: string, ordinal: number) {
  return {
    id,
    parentId: null,
    sessionId: "session",
    kind: "tool",
    intent: payload,
    effect: payload,
    irreversible: true,
    ts: 100,
    ordinal,
    prevHash: "fixture-prev",
    actionHash: "fixture-hash",
  } as const;
}

const page = {
  sessionId: "session",
  afterRevision: 2,
  headRevision: 6,
  actions: [action("a", 3), action("b", 4)],
  nextRevision: 4,
};

describe("SessionHistory.Page", () => {
  test("accepts a strictly ascending slice that continues, and a head slice that ends", () => {
    expect(SessionHistory.Page.parse(page).nextRevision).toBe(4);
    expect(
      SessionHistory.Page.parse({
        ...page,
        actions: [action("a", 3), action("b", 6)],
        nextRevision: null,
      }).actions,
    ).toHaveLength(2);
    expect(
      SessionHistory.Page.parse({ ...page, afterRevision: 6, actions: [], nextRevision: null })
        .actions,
    ).toEqual([]);
  });

  test("refuses ordinals outside (afterRevision, headRevision], non-ascending order and a wrong cursor", () => {
    const refused = [
      { actions: [action("a", 2), action("b", 3)] },
      { actions: [action("a", 3), action("b", 7)] },
      { actions: [action("a", 4), action("b", 3)] },
      { actions: [action("a", 3), action("b", 3)] },
      { nextRevision: null },
      { nextRevision: 3 },
      { actions: [action("a", 3), action("b", 6)], nextRevision: 6 },
      { actions: [], nextRevision: null },
    ];
    for (const fields of refused)
      expect(SessionHistory.Page.safeParse({ ...page, ...fields }).success).toBe(false);
  });
});

describe("SessionHistory requests", () => {
  test("page requests default to the first hundred actions and cap the limit", () => {
    expect(SessionHistory.PageRequest.parse({})).toEqual({ afterRevision: 0, limit: 100 });
    expect(SessionHistory.PageRequest.parse({ afterRevision: 7, limit: 256 })).toEqual({
      afterRevision: 7,
      limit: 256,
    });
    for (const fields of [{ limit: 0 }, { limit: 257 }, { afterRevision: -1 }, { extra: 1 }])
      expect(SessionHistory.PageRequest.safeParse(fields).success).toBe(false);
  });

  test("inspect requests default to direct children and cap traversal depth", () => {
    expect(SessionHistory.InspectRequest.parse({})).toEqual({ depth: 1 });
    expect(SessionHistory.InspectRequest.parse({ depth: 8 })).toEqual({ depth: 8 });
    for (const fields of [{ depth: 9 }, { depth: -1 }, { depth: 1.5 }])
      expect(SessionHistory.InspectRequest.safeParse(fields).success).toBe(false);
  });
});

describe("session.configure tool output budget", () => {
  test("accepts the lower and upper byte bounds", () => {
    expect(Settings.parse({ steering: "all", followUp: "all", toolOutputBudgetBytes: 200 }).toolOutputBudgetBytes).toBe(200);
    expect(Settings.parse({ steering: "all", followUp: "all", toolOutputBudgetBytes: 1_048_576 }).toolOutputBudgetBytes).toBe(1_048_576);
  });

  test("rejects budgets outside both byte bounds", () => {
    for (const toolOutputBudgetBytes of [199, 1_048_577])
      expect(Settings.safeParse({ steering: "all", followUp: "all", toolOutputBudgetBytes }).success).toBe(false);
  });
});

describe("SessionHistory projections", () => {
  const transition: SessionHistory.Transition = {
    revision: 3,
    actionId: "a",
    parentId: null,
    sessionId: "session",
    kind: "tool",
    phase: "intent",
    op: "write",
    at: 100,
    turnId: "turn",
    callId: "call",
    requestId: null,
    peerSessionId: null,
    cause: { kind: "root" },
    outcome: "pending",
    reason: null,
    digest: "d",
  };

  test("causes are one of action, delivery or root and carry only identities", () => {
    const causes: SessionHistory.Cause[] = [
      { kind: "action", actionId: "a" },
      { kind: "delivery", deliveryIds: ["i"] },
      { kind: "root" },
    ];
    for (const cause of causes)
      expect(SessionHistory.Transition.parse({ ...transition, cause }).cause).toEqual(cause);
    for (const cause of [
      { kind: "delivery", deliveryIds: [] },
      { kind: "root", actionId: "a" },
    ])
      expect(SessionHistory.Transition.safeParse({ ...transition, cause }).success).toBe(false);
  });

  test("outcome_unknown is a distinct outcome and payload fields are refused", () => {
    expect(SessionHistory.Outcome.parse("outcome_unknown")).toBe("outcome_unknown");
    expect(SessionHistory.Outcome.safeParse("unknown").success).toBe(false);
    expect(SessionHistory.Transition.safeParse({ ...transition, intent: payload }).success).toBe(
      false,
    );
  });

  test("an inspection nests child inspections to any depth", () => {
    const leaf: SessionHistory.Inspection = {
      sessionId: "child",
      parentId: "session",
      headRevision: 1,
      transitions: [transition],
      policy: [],
      requests: [],
      compactions: [],
      children: [],
    };
    const parsed = SessionHistory.Inspection.parse({
      ...leaf,
      sessionId: "session",
      parentId: null,
      children: [{ ...leaf, children: [{ ...leaf, sessionId: "grandchild", parentId: "child" }] }],
    });
    expect(parsed.children[0]?.children[0]?.sessionId).toBe("grandchild");
    expect(
      SessionHistory.Inspection.safeParse({ ...leaf, children: [{ sessionId: "x" }] }).success,
    ).toBe(false);
    expect(SessionHistory.PolicyFilter.parse({ verdict: "deny" })).toEqual({ verdict: "deny" });
  });
});
