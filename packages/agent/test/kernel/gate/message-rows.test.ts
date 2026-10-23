import { KERNEL_POLICY_REGISTRY } from "../../../src/core/gate/compile";
import { policySnapshot } from "../../helpers/compiled-policy";
import { expect, test } from "bun:test";

import { atGeneration, compaction, draft } from "./row-fixtures";

const childRule = {
  id: "child-actor-deny",
  table: "B",
  sender: "session",
  senderRole: "child",
  targetKind: "actor",
  check: { kind: "actor_send" },
  effect: "deny",
} as const;

test("message policy selects child actor denial without matching external senders", () => {
  const policy = policySnapshot({
    registry: KERNEL_POLICY_REGISTRY,
    generation: 1,
    rows: [
      atGeneration(compaction, 1),
      atGeneration(
        draft(
          childRule.id,
          "message",
          "pre",
          { type: "deny", reason: "actor_send" },
          {
            match: { message: childRule },
          },
        ),
        1,
      ),
    ],
  });
  const child = policy.evaluate({
    kind: "message",
    phase: "pre",
    value: {},
    message: {
      sender: "session",
      senderRole: "child",
      targetKind: "actor",
      type: "message",
      parentChild: false,
      fanout: 0,
      depth: 1,
      withinParentDeadline: true,
    },
  });
  const external = policy.evaluate({
    kind: "message",
    phase: "pre",
    value: {},
    message: {
      sender: "external",
      addressee: "bot",
      identity: true,
      grantTier: true,
      egressBudget: true,
      eventIdUnique: true,
      replyCorrelation: true,
    },
  });
  expect(child.verdict).toBe("deny");
  expect(child.matchedRuleIds).toEqual(["child-actor-deny"]);
  expect(external.matchedRuleIds).toEqual([]);
});

test("send_message cannot bypass admission by omitting its authenticated context", () => {
  const policy = policySnapshot({
    registry: KERNEL_POLICY_REGISTRY,
    generation: 1,
    rows: [atGeneration(compaction, 1)],
  });
  expect(
    policy.evaluate({ kind: "message", phase: "pre", op: "send_message", value: {} }),
  ).toMatchObject({
    verdict: "deny",
    reason: "message_context_missing",
    matchedRuleIds: [],
  });
});

test("message post denial is rejected during compilation", () => {
  const rows = [
    atGeneration(compaction, 1),
    atGeneration(draft("late-denial", "message", "post", { type: "deny" }), 1),
  ];
  expect(() =>
    policySnapshot({ registry: KERNEL_POLICY_REGISTRY, generation: 1, rows }),
  ).toThrow(expect.objectContaining({ code: "invalid_verdict" }));
});
