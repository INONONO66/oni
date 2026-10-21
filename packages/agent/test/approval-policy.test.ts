import { expect, it } from "bun:test";
import { Effect } from "effect";
import { canonicalDigest, type SessionTransition } from "@oni/protocol";
import { defineBundle, Manifest } from "../src/core/ports/capability";
import { compose, ComposeRefused } from "../src/core/composition/compose";
import { ApprovalPolicyPort } from "../src/core/composition/approval-policy";
import { createApprovalRequest } from "../src/core/journal/request-binding";
import { resolveAgentBudget } from "../src/core/loop/budget";
import { decideRequestTransition } from "../src/core/session/request";
import { openRequest } from "./helpers/open-request";
import { invocationNode, kernelOwnedRow, openRequestCommand } from "./helpers/request-fixtures";
import { runTestPromise } from "./helpers/isolated";
import { TEST_APPROVAL_POLICY, TEST_BUDGET } from "./helpers/approval-policy";

const row = kernelOwnedRow("session", "running");
const original = invocationNode({ sessionId: "session", parentId: null });

function pendingApproval(): SessionTransition.Request {
  return openRequest({
    requestId: "invocation",
    sessionId: "session",
    turnId: null,
    callId: "call",
    parsedInput: { path: "original" },
  });
}

const openCommand = (pending: SessionTransition.Request) => openRequestCommand(row, pending);

it("the injected recent-open quota decides admission: limit 2 rejects the third open approval, limit 3 admits it", () => {
  const pending = pendingApproval();
  const openApprovals = [
    { ...pending, requestId: "open-1", sessionId: "other-1" },
    { ...pending, requestId: "open-2", sessionId: "other-2" },
  ];
  const snapshot = { row, invocation: original, requests: openApprovals };
  const limited = decideRequestTransition(openCommand(pending), snapshot, {
    limit: 2,
    windowMs: TEST_APPROVAL_POLICY.recentOpen.windowMs,
  });
  expect(limited).toEqual({ resolution: "rejected", actions: [] });
  const admitted = decideRequestTransition(openCommand(pending), snapshot, {
    limit: 3,
    windowMs: TEST_APPROVAL_POLICY.recentOpen.windowMs,
  });
  expect(admitted.resolution).toBe("opened");
  expect(admitted).toHaveProperty("requestCount", { since: 20 - 3_600_000, count: 2 });
});

it("the injected responders land verbatim in the created approval request, with the injected expiry as the deadline", () => {
  const captured = {
    id: "req-1",
    sessionId: "session",
    turnId: "turn-1",
    callId: "call-1",
    inputHash: canonicalDigest({ path: "original" }),
    generation: 1,
    revision: 1,
    policyDecisionId: "policy-1",
    toolsGeneration: 1,
    toolsHash: "tools",
    intent: { path: "original" },
  };
  const durable = createApprovalRequest(
    captured,
    { effect: { category: "mutation" } },
    "system",
    1_000,
    TEST_APPROVAL_POLICY.defaultExpiryMs,
    ["reviewer"],
  );
  expect(durable.expectedResponders).toEqual(["reviewer"]);
  expect(durable.deadline).toBe(1_000 + 86_400_000);
});

it("a run with no explicit budget resolves to the policy's default budget; an explicit budget wins per field", () => {
  expect(resolveAgentBudget(TEST_APPROVAL_POLICY.defaultBudget)).toEqual(TEST_BUDGET);
  expect(resolveAgentBudget(TEST_APPROVAL_POLICY.defaultBudget, { maxTurns: 3 })).toEqual({
    ...TEST_BUDGET,
    maxTurns: 3,
  });
});

it("a manifest whose bundles require the approval-policy seam with no provider refuses seam_missing at compose", async () => {
  const manifest = Manifest.define({
    capabilities: [],
    bundles: [defineBundle({ name: "needs-approval-policy", requires: [ApprovalPolicyPort] })],
  });
  const refused = await runTestPromise(Effect.flip(compose(manifest)));
  expect(refused).toBeInstanceOf(ComposeRefused);
  expect(refused.code).toBe("seam_missing");
  expect(refused.detail).toBe("@oni/approval/ApprovalPolicy");
});
