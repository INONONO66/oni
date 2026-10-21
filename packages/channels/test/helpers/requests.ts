import { sessionTree } from "../../../agent/test/store/helpers/session-tree";
import { TEST_APPROVAL_POLICY } from "../../../agent/test/helpers/approval-policy";
import { Clock, Effect } from "effect";
import { Core } from "@oni/agent";
const Entropy = Core.Entropy;
const createSessionRequests = Core.createSessionRequests;
const decideRequestTransition = Core.decideRequestTransition;
type SessionRuntime = Core.SessionRuntime;
import { runEffect } from "./effect";
import { canonicalDigest, type Gateway, type PlainValue, type SessionTransition, } from "@oni/protocol";
import { adoptLedgerFence, ledger } from "./ledger";

/** Channel tests exercise routing, not configure authority: the pinned pre-policy admits every configure. */
const allowConfigure: SessionRuntime["authorizeConfigure"] = () => Effect.succeed(true);

/** A deterministic effect Clock over the injected test clock; no ambient time. */
function fixedClock(clock: () => number): Clock.Clock {
  const nanos = () => BigInt(clock()) * 1_000_000n;
  return {
    currentTimeMillisUnsafe: () => clock(),
    currentTimeMillis: Effect.sync(() => clock()),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: () => Effect.void,
  };
}

const entropyCounter = { value: 0 };
const testEntropy = {
  id: () => { entropyCounter.value += 1; return `entropy-${entropyCounter.value}`; },
  random: () => 0,
};

/** Real kernel authority and SQLite action history; no test lifecycle implementation. */
export function requestPort(
  clock: () => number = () => 1,
  onDeliveryCommitted?: (sessionIds: readonly string[]) => void,
  runtime: Partial<Omit<SessionRuntime, "processId" | "onDeliveryCommitted" | "authorizeConfigure">> = {},
) {
  return runEffect(
    createSessionRequests({
      openKernel: () => ledger().kernel,
      listSessions: () => ledger().kernel.listRows(),
      ...runtime,
      approvalPolicy: TEST_APPROVAL_POLICY,
      authorizeConfigure: allowConfigure,
      processId: "channels-test",
      onDeliveryCommitted,
    }).pipe(
      Effect.provide(Entropy.layer(testEntropy)),
      Effect.provideService(Clock.Clock, fixedClock(clock)),
    ),
    "sync",
  );
}

export function originalAction(requestId: string, sessionId: string, value: PlainValue = {}) {
  const kernel = ledger().kernel;
  runEffect(
    kernel
      .materialize({
        id: sessionId,
        parentId: null,
        role: "resident",
        tools: [],
        system: { preset: "", blocks: [] },
        policyGeneration: 0,
        actionId: `${sessionId}:configure`,
        at: 0,
      })
      .pipe(Effect.orDie),
    "sync",
  );
  const existing = sessionTree(sessionId, ledger().sessions.actions).find(
    (action) => action.id === requestId,
  );
  if (existing) return;
  const fence = adoptLedgerFence(sessionId, "fixture");
  const row = kernel.row(sessionId);
  runEffect(kernel.commit({
    sessionId,
    owner: "fixture",
    fence,
    expectedRevision: row.revision,
    now: 1,
    actions: [
      {
        id: requestId,
        sessionId,
        parentId: null,
        kind: "message",
        intent: {
          encodingVersion: 1,
          value: { phase: "intent", value, effectHash: canonicalDigest({}) },
        },
        effect: { encodingVersion: 1, value: {} },
        irreversible: true,
        ts: 1,
      },
    ],
    state: "idle",
  }), "sync");
}

export async function openRequest(requestId: string, overrides: Partial<Gateway.RequestSpec> = {}) {
  const spec: Gateway.RequestSpec = {
    requestId,
    sessionId: "request-owner",
    expectedResponders: ["actor-external-child"],
    correlation: { channelId: "telegram:dm", tokenHash: "token-hash-1" },
    allowedActions: ["report_result"],
    resolution: "first",
    threshold: 1,
    deadline: Number.MAX_SAFE_INTEGER,
    ...overrides,
  };
  originalAction(requestId, spec.sessionId);
  return requestPort().open({ ...spec, correlation: spec.correlation ?? {}, at: 1 });
}

export function seededRequests(clock?: () => number) {
  const at = { value: 1 };
  const port = requestPort(clock ?? (() => at.value));
  return {
    ...port,
    open: (input: Parameters<typeof port.open>[0]) => {
      at.value = input.at;
      originalAction(input.requestId, input.sessionId);
      return port.open(input);
    },
  };
}

export async function command(
  requestId: string,
  payload: SessionTransition.Payload,
  at: number,
  inputId = `${payload.kind}:${at}`,
) {
  const kernel = ledger().kernel;
  const request = kernel.requestById(requestId);
  if (!request) throw new Error("missing request");
  const sessionId = request.sessionId;
  const fence = adoptLedgerFence(sessionId, "command");
  const current = kernel.row(sessionId);
  const decision = decideRequestTransition(
    {
      version: 1,
      sessionId,
      inputId,
      at,
      authority: { owner: "command", fence },
      expectedRevision: current.revision,
      payload,
    },
    {
      row: current,
      inputRecord: kernel.requestInputById(sessionId, inputId),
      invocation: kernel.actionById(requestId),
      request,
    },
    TEST_APPROVAL_POLICY.recentOpen,
  );
  await runEffect(kernel.commit({
    sessionId,
    owner: "command",
    fence,
    now: at,
    expectedRevision: current.revision,
    actions: [...decision.actions],
    state: current.state,
  }));
  return decision;
}

export function answer(
  requestId: string,
  responderId: string,
  inputId: string,
  receivedAt: number,
) {
  const request = ledger().kernel.requestById(requestId);
  if (!request) throw new Error("missing request");
  return requestPort(() => receivedAt).answer({
    inputId,
    requestId,
    sessionId: request.sessionId,
    receivedAt,
    principal: { kind: "actor", principalId: responderId, evidenceId: inputId },
    bindingDigest: request.bindingDigest,
    inputHash: request.inputHash,
    effectHash: request.effectHash,
    generation: request.generation,
    toolsHash: request.toolsHash,
    domainRevisions: request.domainRevisions,
    decision: "answer",
    allowedAction: "report_result",
    content: `answer:${inputId}`,
  });
}
