import { APPROVAL_POLICY } from "../../src/bundles/approval-policy/index";
import { type PlainValue, SessionTransition } from "@openomni/protocol";

/** Invariant open-approval facts; the per-call Request.parse validates the whole. */
const OPEN_APPROVAL = {
  state: "open",
  outcome: null,
  replies: [],
  seenReplyIds: [],
  threshold: 1,
  resolution: "first",
  allowedActions: ["report_result"],
  correlation: {},
  expectedResponders: [...APPROVAL_POLICY.responders],
  deadline: 1000,
  createdAt: 1,
  mode: "approval",
  generation: 1,
  toolsGeneration: 1,
} satisfies Partial<SessionTransition.Request>;

export function approvalRequest(
  parsedInput: PlainValue,
  domainRevisions: Record<string, number>,
): SessionTransition.Request {
  return SessionTransition.Request.parse({
    ...OPEN_APPROVAL,
    requestId: "request",
    sessionId: "session",
    turnId: null,
    callId: "call",
    parsedInput,
    inputHash: "input",
    effectHash: "effect",
    toolsHash: "tools",
    systemHash: "system",
    domainRevisions,
    bindingDigest: "binding",
  });
}
