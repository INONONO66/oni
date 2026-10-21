import type { SessionTransition } from "@oni/protocol";
export function requestFixture(
  overrides: Partial<SessionTransition.Request> = {},
): SessionTransition.Request {
  return {
    requestId: "original-action",
    sessionId: "owner-session",
    turnId: null,
    callId: "call",
    mode: "answer",
    parsedInput: { content: "question" },
    inputHash: "input",
    effectHash: "effect",
    generation: 1,
    toolsGeneration: 1,
    toolsHash: "tools",
    systemHash: "system",
    domainRevisions: {},
    deadline: 100,
    expectedResponders: ["actor"],
    correlation: { channelId: "dm", replyToMessageId: "sent" },
    allowedActions: ["report_result"],
    bindingDigest: "binding",
    resolution: "first",
    threshold: 1,
    seenReplyIds: [],
    replies: [],
    state: "open",
    outcome: null,
    createdAt: 1,
    ...overrides,
  };
}
