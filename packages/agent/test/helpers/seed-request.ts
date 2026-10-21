import { Effect } from "effect";
import { Alarm, canonicalDigest, type LedgerAction, type SessionTransition } from "@oni/protocol";
import { armAction } from "../../src/core/ports/alarm";
import { decideRequestTransition } from "../../src/core/session/request";
import { openRequest } from "./open-request";
import { runAgent } from "./executor";
import { type ClusterHome, type FencedSession, fencedSession } from "./seeded-session";
import { TEST_APPROVAL_POLICY } from "../helpers/approval-policy";

/** Pinned so the answer-side rebuild hashes to the identical binding digest. */
const SEED_DEADLINE = 4_102_444_800_000;
const SEED_CREATED_AT = 1_000;

/** The pending `write` tool invocation node `requestId` (empty parsed input) under `parentId` at `ts`. */
export function pendingToolInvocation(
  sessionId: string,
  requestId: string,
  ts: number,
  parentId = `${sessionId}:materialize`,
): LedgerAction.Append {
  return {
    id: requestId,
    parentId,
    sessionId,
    kind: "tool",
    intent: {
      encodingVersion: 1,
      value: { phase: "intent", op: "write", value: {}, effectHash: canonicalDigest({ category: "mutation" }) },
    },
    effect: { encodingVersion: 1, value: { phase: "pending" } },
    ts,
    irreversible: true,
  };
}

/**
 * Open approval request `requestId` over its committed invocation node through
 * the pure request authority; returns the request plus the actions to commit.
 */
export function openRequestDecision(
  session: FencedSession,
  requestId: string,
  timing: { readonly deadline: number; readonly createdAt: number; readonly at: number },
): { readonly request: SessionTransition.Request; readonly actions: readonly LedgerAction.Append[] } {
  const { sessionId, kernel } = session;
  const row = kernel.row(sessionId);
  const request = openRequest({
    requestId,
    sessionId,
    turnId: null,
    callId: `${requestId}:call`,
    parsedInput: {},
    generation: row.policyGeneration,
    toolsGeneration: row.toolsGeneration,
    systemHash: row.systemHash,
    deadline: timing.deadline,
    createdAt: timing.createdAt,
  });
  const decision = decideRequestTransition(
    {
      version: 1,
      sessionId,
      inputId: `${requestId}:open-input`,
      at: timing.at,
      expectedRevision: row.revision,
      authority: { owner: session.owner, fence: session.fence },
      payload: { kind: "request.open", request },
    },
    { row, requests: [], invocation: kernel.actionById(requestId) },
    TEST_APPROVAL_POLICY.recentOpen,
  );
  if (decision.resolution !== "opened") throw new Error(`request seed refused: ${decision.resolution}`);
  return { request, actions: decision.actions };
}

/**
 * Materialize one session and commit a real open approval request through the
 * pure request authority: the pending tool invocation node first (admission
 * validates the binding against it), then the `request{phase: open}` record.
 */
export async function seedSessionWithOpenRequest(
  input: ClusterHome & { readonly sessionId: string; readonly requestId: string },
): Promise<SessionTransition.Request> {
  const { sessionId, requestId } = input;
  return runAgent(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* fencedSession(input, sessionId, { commitNow: Date.now });
        yield* session.commit([pendingToolInvocation(sessionId, requestId, Date.now())]);
        const { request, actions } = openRequestDecision(session, requestId, {
          deadline: SEED_DEADLINE,
          createdAt: SEED_CREATED_AT,
          at: Date.now(),
        });
        yield* session.commit([...actions]);
        return request;
      }),
    ),
  );
}

const RETRY_ALARM_ID = "op:attempt:1:retry";
const RETRY_PAYLOAD = { attempt: 1, reason: "transient_error" };

/**
 * The retried `op` llm node, its first attempt, and the chain-armed retry
 * occurrence (#1254 S4: a live occurrence is one the chain armed — the retry
 * port commits the arm row first, so the seed commits the same shape).
 */
export function retryAttemptChain(sessionId: string, opParentId: string | null): readonly LedgerAction.Append[] {
  const base = {
    sessionId,
    intent: { encodingVersion: 1 as const, value: { phase: "intent" } },
    effect: { encodingVersion: 1 as const, value: { phase: "pending" } },
    ts: 100,
    irreversible: true as const,
  };
  const armed = armAction({
    parentId: "op:attempt:1",
    sessionId,
    purpose: "retry",
    at: 100,
    supersedes: null,
    alarmId: RETRY_ALARM_ID,
    sourceKey: "retry",
    payload: RETRY_PAYLOAD,
    armSeq: 1,
    ts: 100,
  });
  return [
    { ...base, id: "op", parentId: opParentId, kind: "llm" },
    { ...base, id: "op:attempt:1", parentId: "op", kind: "llm" },
    armed.action,
  ];
}

/** The live retry envelope `retryAttemptChain` armed, due at `fireAt`. */
export function retryAlarmEnvelope(sessionId: string, fireAt: number) {
  return {
    occurrenceId: Alarm.occurrenceId(sessionId, RETRY_ALARM_ID, 1, "retry"),
    purpose: "retry",
    alarmId: RETRY_ALARM_ID,
    armSeq: 1,
    sourceKey: "retry",
    payload: JSON.stringify(RETRY_PAYLOAD),
    fireAt,
  };
}
