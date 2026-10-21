import { canonicalDigest, type SessionTransition } from "@oni/protocol";
import { Effect } from "effect";
import { requestLedger } from "./g0-request-ledger";
import { requestBindingDigest } from "../../src/core/session/request";
import { TEST_APPROVAL_POLICY } from "./approval-policy";

type Overrides = Partial<Omit<SessionTransition.Request, "bindingDigest">> &
  Pick<SessionTransition.Request, "requestId" | "sessionId" | "turnId" | "callId">;

/** One open first-responder approval request with its binding digest already sealed. */
export function openRequest(overrides: Overrides): SessionTransition.Request {
  const parsedInput = overrides.parsedInput ?? {};
  const request: SessionTransition.Request = {
    mode: "approval",
    parsedInput,
    inputHash: canonicalDigest(parsedInput),
    effectHash: canonicalDigest({ category: "mutation" }),
    generation: 1,
    toolsGeneration: 1,
    toolsHash: "tools",
    systemHash: "system",
    domainRevisions: {},
    deadline: 100,
    expectedResponders: [...TEST_APPROVAL_POLICY.responders],
    correlation: {},
    allowedActions: ["report_result"],
    resolution: "first",
    threshold: 1,
    seenReplyIds: [],
    replies: [],
    state: "open",
    outcome: null,
    createdAt: 1,
    ...overrides,
    bindingDigest: "",
  };
  request.bindingDigest = requestBindingDigest(request);
  return request;
}

/** One recorded pending tool invocation whose open request the tests replay. */
export function pendingRequest(id: string, deadline = 1000) {
  return Effect.gen(function* () {
    const fixture = yield* requestLedger({ id });
    const { identity } = fixture;
    const request = openRequest({
      requestId: `${id}:original`,
      sessionId: id,
      turnId: identity.turnId,
      callId: `${id}:call`,
      parsedInput: { path: id },
      toolsGeneration: identity.toolsGeneration,
      toolsHash: identity.toolsHash,
      systemHash: identity.systemHash,
      deadline,
      createdAt: 100,
    });
    yield* fixture.ledger.commit({
      id: request.requestId,
      parentId: identity.parentActionId,
      sessionId: id,
      kind: "tool",
      intent: {
        encodingVersion: 1,
        value: { phase: "intent", value: request.parsedInput, effectHash: request.effectHash },
      },
      effect: { encodingVersion: 1, value: { phase: "pending" } },
      irreversible: true,
      ts: 100,
    });
    return request;
  });
}
