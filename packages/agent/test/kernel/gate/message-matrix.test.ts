import { KERNEL_POLICY_REGISTRY } from "../../../src/core/gate/compile";
import { expect, test } from "bun:test";
import { Gateway } from "@oni/protocol";
import { compilePolicySnapshot, type PolicyEvaluationInput } from "../../../src/core/gate/compile";
import { atGeneration, compaction, draft } from "./row-fixtures";

function compiled(message: Gateway.RuleTableA | Gateway.RuleTableB) {
  return compilePolicySnapshot({
    registry: KERNEL_POLICY_REGISTRY,
    generation: 1,
    rows: [
      atGeneration(compaction, 1),
      atGeneration(
        draft(
          message.id,
          "message",
          "pre",
          { type: message.effect, reason: message.id },
          { match: { message } },
        ),
        1,
      ),
    ],
  });
}
const external = {
  sender: "external",
  senderTier: "owner",
  addressee: "bot",
  identity: true,
  grantTier: true,
  egressBudget: true,
  eventIdUnique: true,
  replyCorrelation: true,
} as const;
const session = {
  sender: "session",
  senderRole: "resident",
  targetKind: "session",
  targetRole: "child",
  type: "message",
  parentChild: true,
  fanout: 0,
  depth: 1,
  withinParentDeadline: true,
  actorSendAllowed: true,
} as const;

test.each([
  ["identity", "identity"],
  ["grant_tier", "grantTier"],
  ["egress_budget", "egressBudget"],
  ["event_id_dedupe", "eventIdUnique"],
  ["reply_correlation", "replyCorrelation"],
] as const)("A %s projects the exact failed fact", (check, field) => {
  const policy = compiled(
    Gateway.RuleTableA.parse({
      id: "rule",
      table: "A",
      sender: "external",
      senderTier: "owner",
      addressee: "bot",
      effect: "deny",
      check,
    }),
  );
  const evaluate = (message: PolicyEvaluationInput["message"]) =>
    policy.evaluate({ kind: "message", phase: "pre", value: {}, message }).matchedRuleIds;
  expect(evaluate(external)).toEqual([]);
  expect(evaluate({ ...external, [field]: false })).toEqual(["rule"]);
  expect(evaluate({ ...external, [field]: false, senderTier: "observer" })).toEqual([]);
  expect(evaluate({ ...external, [field]: false, addressee: "ambient" })).toEqual([]);
  expect(evaluate(session)).toEqual([]);
});

test.each([
  [{ kind: "parent_child" }, { parentChild: false }],
  [{ kind: "fanout", max: 1 }, { fanout: 1 }],
  [{ kind: "depth", max: 1 }, { depth: 2 }],
  [{ kind: "deadline", withinParent: true }, { withinParentDeadline: false }],
  [{ kind: "actor_send" }, { actorSendAllowed: false }],
] as const)("B %j refuses at its boundary and matches all routing dimensions", (check, violation) => {
  const rule = Gateway.RuleTableB.parse({
    id: "rule",
    table: "B",
    sender: "session",
    senderRole: "resident",
    targetKind: "session",
    targetRole: "child",
    type: "message",
    effect: "deny",
    check,
  });
  const policy = compiled(rule);
  const evaluate = (message: PolicyEvaluationInput["message"]) =>
    policy.evaluate({ kind: "message", phase: "pre", value: {}, message }).matchedRuleIds;
  expect(evaluate(session)).toEqual([]);
  expect(evaluate({ ...session, ...violation })).toEqual(["rule"]);
  expect(evaluate({ ...session, ...violation, senderRole: "child" })).toEqual([]);
  expect(evaluate({ ...session, ...violation, targetKind: "actor" })).toEqual([]);
  expect(evaluate({ ...session, ...violation, targetRole: "resident" })).toEqual([]);
  expect(evaluate({ ...session, ...violation, type: "resume" })).toEqual([]);
  expect(evaluate(external)).toEqual([]);
});

test("explicit B type denial matches without an implicit role switch", () => {
  const policy = compiled(
    Gateway.RuleTableB.parse({
      id: "deny",
      table: "B",
      sender: "session",
      senderRole: "resident",
      type: "interrupt",
      effect: "deny",
      check: { kind: "type" },
    }),
  );
  expect(
    policy.evaluate({
      kind: "message",
      phase: "pre",
      value: {},
      message: { ...session, type: "interrupt" },
    }).matchedRuleIds,
  ).toEqual(["deny"]);
});
