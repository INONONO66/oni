import type { SessionTransition } from "@oni/protocol";

export const answer: SessionTransition.Answer = {
  inputId: "message",
  requestId: "request",
  sessionId: "receiver",
  receivedAt: 1,
  principal: { kind: "session", principalId: "child", evidenceId: "terminal" },
  bindingDigest: "binding",
  inputHash: "input",
  effectHash: "effect",
  generation: 1,
  toolsHash: "tools",
  domainRevisions: {},
  decision: "answer",
  allowedAction: "report_result",
  content: "answer",
};
