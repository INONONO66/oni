import { generationSnapshot } from "../../../src/core/store/configure";
import { beforeEach, expect, test } from "bun:test";
import type { LedgerAction, PlainValue, SessionTransition } from "@oni/protocol";

import { materializeSession } from "../helpers/session";
import { useMemoryStores } from "../helpers/storage";

const stores = useMemoryStores();
beforeEach(() => {
  materializeSession(stores.kernel, "source");
  materializeSession(stores.kernel, "other");
});

function append(
  id: string,
  kind: LedgerAction.Kind,
  intent: PlainValue = null,
  effect: PlainValue = null,
  sessionId = "source",
): LedgerAction.Receipt {
  const receipt = stores.session.actions.append(
    {
      id,
      parentId: null,
      sessionId,
      kind,
      intent: { encodingVersion: 1, value: intent },
      effect: { encodingVersion: 1, value: effect },
      irreversible: true,
      ts: 2,
    },
    stores.kernel.row(sessionId).revision,
  );
  if (receipt === undefined) throw new Error("read port fixture commit failed");
  return receipt;
}

function answer(messageId: string): SessionTransition.Answer {
  return {
    inputId: "input",
    requestId: "request",
    sessionId: "source",
    receivedAt: 2,
    principal: { kind: "session", principalId: "other", evidenceId: "evidence" },
    bindingDigest: "binding",
    inputHash: "input-hash",
    effectHash: "effect-hash",
    generation: 0,
    toolsHash: "tools-hash",
    domainRevisions: {},
    decision: "answer",
    allowedAction: "report_result",
    content: "answer",
    outbound: {
      messageId,
      sourceSessionId: "other",
      sourceActionId: "terminal",
      destinationSessionId: "source",
      requestId: "request",
      replyTo: "binding",
      terminal: "completed",
      content: "answer",
      digest: "digest",
    },
  };
}

test("actionById returns the exact committed node globally or absence", () => {
  const receipt = append("target", "turn", { phase: "intent" }, { phase: "state" }, "other");
  expect(stores.kernel.actionById("target")).toEqual(receipt.action);
  expect(stores.kernel.actionById("missing")).toBeUndefined();
});

test("latestGenerationFor folds only ordered configure rows and skips malformed snapshots", () => {
  const generation = generationSnapshot({
    generation: 2,
    revertTo: 1,
    tools: [],
    system: { preset: "latest", blocks: [] },
    policyGeneration: 3,
  });
  const snapshot = { ...generation, bundles: [...generation.bundles] };
  append("configured", "session.configure", null, { phase: "configured", snapshot });
  append("malformed", "session.configure", null, { phase: "configured", snapshot: null });
  append("not-configure", "turn", null, {
    phase: "configured",
    snapshot: { ...snapshot, generation: 99 },
  });
  append(
    "other-configure",
    "session.configure",
    null,
    { phase: "configured", snapshot: { ...snapshot, generation: 5 } },
    "other",
  );
  expect(stores.kernel.latestGenerationFor("source")).toEqual(snapshot);
  expect(() => stores.kernel.latestGenerationFor("missing")).toThrow(
    "session has no configured generation",
  );
});

test("policyDecisionRuleIds selects the latest exact session/hash/kind and preserves order", () => {
  append("old", "policy.decision", { inputHash: "hash", matchedRuleIds: ["old"] });
  append("current", "policy.decision", { inputHash: "hash", matchedRuleIds: ["b", "a", "b"] });
  append("other-hash", "policy.decision", { inputHash: "different", matchedRuleIds: ["wrong"] });
  append("other-kind", "message", { inputHash: "hash", matchedRuleIds: ["wrong"] });
  append(
    "other-session",
    "policy.decision",
    { inputHash: "hash", matchedRuleIds: ["wrong"] },
    null,
    "other",
  );
  expect(stores.kernel.policyDecisionRuleIds("source", "hash")).toEqual(["b", "a", "b"]);
  expect(stores.kernel.policyDecisionRuleIds("source", "missing")).toBeUndefined();
  expect(stores.kernel.policyDecisionRuleIds("missing", "hash")).toBeUndefined();
  append("empty", "policy.decision", { inputHash: "hash", matchedRuleIds: [] });
  expect(stores.kernel.policyDecisionRuleIds("source", "hash")).toEqual([]);
});

const malformedRuleIds: PlainValue[] = [null, [42], "rule"];
test.each(malformedRuleIds)("policyDecisionRuleIds rejects malformed identities: %j", (ids) => {
  append("valid", "policy.decision", { inputHash: "hash", matchedRuleIds: ["old"] });
  append("invalid", "policy.decision", { inputHash: "hash", matchedRuleIds: ids });
  expect(() => stores.kernel.policyDecisionRuleIds("source", "hash")).toThrow(
    "invalid message decision rule identity",
  );
});

test("policyDecisionRuleIds rejects absent identities rather than falling back", () => {
  append("absent", "policy.decision", { inputHash: "hash" });
  expect(() => stores.kernel.policyDecisionRuleIds("source", "hash")).toThrow(
    "invalid message decision rule identity",
  );
});

test("messageActionByPlatformId returns the first exact platform-message match", () => {
  append("wrong-kind", "turn", { value: { messageId: "platform" } });
  append("wrong-session", "message", { value: { messageId: "platform" } }, null, "other");
  append("wrong-path", "message", { messageId: "platform" });
  append("wrong-id", "message", { value: { messageId: "different" } });
  const first = append("first", "message", { value: { messageId: "platform" } });
  append("second", "message", { value: { messageId: "platform" } });
  expect(stores.kernel.messageActionByPlatformId("source", "platform")).toEqual(first.action);
  expect(stores.kernel.messageActionByPlatformId("source", "missing")).toBeUndefined();
  expect(stores.kernel.messageActionByPlatformId("missing", "platform")).toBeUndefined();
});

test("outboundReceipt returns prompt by id scoped to destination", () => {
  const receipt = append("prompt-id", "prompt");
  append("not-prompt", "message");
  expect(stores.kernel.outboundReceipt("source", "prompt-id")).toEqual(receipt);
  expect(stores.kernel.outboundReceipt("other", "prompt-id")).toBeUndefined();
  expect(stores.kernel.outboundReceipt("source", "not-prompt")).toBeUndefined();
  expect(stores.kernel.outboundReceipt("source", "missing")).toBeUndefined();
});

test("outboundReceipt decodes matching answered requests and skips invalid answers before a valid receipt", () => {
  append("wrong-session", "request", null, { phase: "answered", answer: answer("outbound") }, "other");
  append("wrong-kind", "turn", null, { phase: "answered", answer: answer("outbound") });
  append("wrong-message", "request", null, { phase: "answered", answer: answer("different") });
  append("malformed", "request", null, { phase: "answered", answer: { outbound: { messageId: "outbound" } } });
  expect(stores.kernel.outboundReceipt("source", "outbound")).toBeUndefined();
  const receipt = append("valid", "request", null, { phase: "answered", answer: answer("outbound") });
  append("later", "request", null, { phase: "answered", answer: answer("outbound") });
  expect(stores.kernel.outboundReceipt("source", "outbound")).toEqual(receipt);
});

test("outboundReceipt preserves ordinal precedence across both SQL arms", () => {
  const reply = append("reply-first", "request", null, { phase: "answered", answer: answer("prompt-later") });
  append("prompt-later", "prompt");
  expect(stores.kernel.outboundReceipt("source", "prompt-later")).toEqual(reply);
  const prompt = append("prompt-first", "prompt");
  append("reply-later", "request", null, { phase: "answered", answer: answer("prompt-first") });
  expect(stores.kernel.outboundReceipt("source", "prompt-first")).toEqual(prompt);
});
