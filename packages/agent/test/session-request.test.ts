import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { isolatedLedger } from "./helpers/isolated";
import { sessionTree } from "./helpers/session-tree";
import { fileRequest, planeAnswer, requestPlane } from "./helpers/session-request-plane";
import { openRequest } from "./helpers/open-request";
import { approvalAnswer, invocationNode, kernelOwnedRow, openRequestCommand } from "./helpers/request-fixtures";
import {
  canonicalDigest,
  PlainObjectSchema,
  type Delivery,
  type LedgerAction,
  type SessionTransition,
} from "@openomni/protocol";
import { decideRequestTransition, requestBindingDigest } from "../src/core/request";
import { TEST_APPROVAL_POLICY } from "./helpers/approval-policy";

const row = kernelOwnedRow("session", "running");
const original = invocationNode({
  sessionId: "session",
  parentId: null,
  domainRevisions: { person: 3 },
});
function request(): SessionTransition.Request {
  return openRequest({
    requestId: "invocation",
    sessionId: "session",
    turnId: null,
    callId: "call",
    parsedInput: { path: "original" },
    domainRevisions: { person: 3 },
  });
}
function answer(pending = request()): SessionTransition.Answer {
  return approvalAnswer(pending, "answer", 20);
}
function decide(
  payload: SessionTransition.Payload,
  pending?: SessionTransition.Request,
  actions = [original],
) {
  return decideRequestTransition(
    {
      version: 1,
      inputId: payload.kind === "request.answer" ? payload.answer.inputId : payload.kind,
      sessionId: row.id,
      at: 20,
      authority: { owner: "kernel", fence: 1 },
      expectedRevision: 1,
      payload,
    },
    { row, invocation: actions.find((action) => action.id === "invocation"),
      inputRecord: actions.find((action) => PlainObjectSchema.parse(action.intent.value).inputId === (payload.kind === "request.answer" ? payload.answer.inputId : payload.kind)),
      request: pending, domainRevisions: { person: 3 } },
    TEST_APPROVAL_POLICY.recentOpen,
  );
}
it("opens only the exact existing invocation and original effect", () => {
  const pending = request();
  expect(decide({ kind: "request.open", request: pending }).resolution).toBe("opened");
  expect(
    decide({ kind: "request.open", request: { ...pending, parsedInput: { path: "swapped" } } })
      .resolution,
  ).toBe("rejected");
  expect(decide({ kind: "request.open", request: pending }, undefined, []).resolution).toBe(
    "rejected",
  );
});
it("records one canonical resolution and deduplicates equivalent input after restart", () => {
  const pending = request();
  const payload = { kind: "request.answer", answer: answer(pending) } as const;
  const result = decide(payload, pending);
  expect(result.resolution).toBe("resolved");
  expect(result.request?.state).toBe("resolved");
  expect(result.actions.some((action) => action.id === "invocation:resolution")).toBe(true);
  const persisted = result.actions.map((action, index) => ({
    ...action,
    ordinal: index + 2,
    prevHash: "fixture-prev",
    actionHash: "fixture-hash",
  }));
  const repeated = decide(
    { ...payload, answer: { ...payload.answer, receivedAt: 30 } },
    result.request,
    [original, ...persisted],
  );
  expect(repeated.resolution).toBe("resolved");
  expect(repeated.actions).toEqual([]);
  expect(
    decide({ ...payload, answer: { ...payload.answer, content: "changed" } }, result.request, [
      original,
      ...persisted,
    ]).resolution,
  ).toBe("rejected");
  // A recorded input whose durable resolution no longer decodes is not replayed as a success.
  const corrupted: LedgerAction.Node[] = persisted.map((action) =>
    action.id === `invocation:input:${payload.answer.inputId}`
      ? {
          ...action,
          effect: { encodingVersion: 1 as const, value: { phase: "state", resolution: "???" } },
        }
      : action,
  );
  expect(decide(payload, result.request, [original, ...corrupted]).resolution).toBe("rejected");
});
it("expires late answers before binding checks without reopening or delivery effects", () => {
  const pending = request();
  const result = decide(
    {
      kind: "request.answer",
      answer: { ...answer(pending), receivedAt: 100, bindingDigest: "forged" },
    },
    pending,
  );
  expect(result.resolution).toBe("late_unknown");
  expect(result.request?.state).toBe("expired");
  expect(result.request?.outcome).toBe("outcome_unknown");
  expect(result.actions.filter((action) => action.id === "invocation:resolution")).toHaveLength(1);
});
it("rejects non-Owner approval and changed domain revisions", () => {
  const pending = request();
  expect(
    decide(
      {
        kind: "request.answer",
        answer: {
          ...answer(),
          principal: { kind: "owner", principalId: "different-owner", evidenceId: "authenticated" },
        },
      },
      pending,
    ).resolution,
  ).toBe("rejected");
  expect(
    decide(
      {
        kind: "request.answer",
        answer: {
          ...answer(),
          principal: { kind: "actor", principalId: "owner", evidenceId: "chat" },
        },
      },
      pending,
    ).resolution,
  ).toBe("rejected");
  expect(
    decide(
      { kind: "request.answer", answer: { ...answer(), domainRevisions: { person: 4 } } },
      pending,
    ).resolution,
  ).toBe("rejected");
});
it("refuses an answer addressed to another request before any record", () => {
  const pending = request();
  const valid = answer(pending);
  // Same session, different request: the current request must not absorb it.
  expect(
    decide({ kind: "request.answer", answer: { ...valid, requestId: "elsewhere" } }, pending),
  ).toEqual({ resolution: "rejected", actions: [] });
  // A request owned by another session is never answered under this row.
  expect(
    decide({ kind: "request.answer", answer: valid }, { ...pending, sessionId: "other" }),
  ).toEqual({ resolution: "rejected", actions: [] });
  expect(decide({ kind: "request.answer", answer: valid }, pending).resolution).toBe("resolved");
});
it("counts distinct responders, not repeated replies, for all and quorum", () => {
  const pending = {
    ...request(),
    mode: "answer" as const,
    expectedResponders: ["alice", "bob"],
    resolution: "all" as const,
    threshold: 2,
  };
  pending.bindingDigest = requestBindingDigest(pending);
  const first = {
    ...answer(pending),
    decision: "answer" as const,
    principal: { kind: "actor" as const, principalId: "alice", evidenceId: "driver" },
  };
  const attached = decide({ kind: "request.answer", answer: first }, pending);
  expect(attached.resolution).toBe("attached");
  const repeated = decide(
    { kind: "request.answer", answer: { ...first, inputId: "another" } },
    attached.request,
  );
  expect(repeated.resolution).toBe("duplicate");
  // A seen reply id replayed by a different responder is one duplicate record,
  // never a second reply: it cannot move the request toward the threshold.
  const replayed = decide(
    {
      kind: "request.answer",
      answer: { ...first, principal: { ...first.principal, principalId: "bob" } },
    },
    attached.request,
  );
  expect(replayed.resolution).toBe("duplicate");
  expect(replayed.request).toMatchObject({ state: "open", replies: attached.request?.replies });
  expect(replayed.actions.map((action) => action.id)).toEqual(["invocation:input:answer"]);
  const resolved = decide(
    {
      kind: "request.answer",
      answer: {
        ...first,
        inputId: "bob-answer",
        principal: { ...first.principal, principalId: "bob" },
      },
    },
    attached.request,
  );
  expect(resolved.resolution).toBe("resolved");
});
it("never borrows a foreign lease or accepts an obsolete revision", () => {
  const command: SessionTransition.Command = {
    version: 1,
    inputId: "open",
    sessionId: row.id,
    at: 20,
    expectedRevision: 1,
    authority: { owner: "foreign", fence: 1 },
    payload: { kind: "request.open", request: request() },
  };
  expect(decideRequestTransition(command, { row, invocation: original }, TEST_APPROVAL_POLICY.recentOpen).actions).toEqual([]);
  expect(
    decideRequestTransition(
      { ...command, authority: { owner: "kernel", fence: 1 }, expectedRevision: 0 },
      { row, invocation: original },
      TEST_APPROVAL_POLICY.recentOpen,
    ).resolution,
  ).toBe("rejected");
});
it("accepts an expected responder's refusal as the single terminal winner", () => {
  const pending = { ...request(), mode: "answer" as const, expectedResponders: ["alice"] };
  pending.bindingDigest = requestBindingDigest(pending);
  const result = decide(
    {
      kind: "request.answer",
      answer: {
        ...answer(pending),
        principal: { kind: "actor", principalId: "alice", evidenceId: "driver" },
        decision: "refuse",
      },
    },
    pending,
  );
  expect(result.resolution).toBe("refused");
  expect(result.request?.outcome).toBe("denied");
  expect(result.actions.filter((action) => action.id === "invocation:resolution")).toHaveLength(1);
});
it("refuses approval when current domain revisions cannot be read", () => {
  const pending = request();
  const result = decideRequestTransition(
    {
      version: 1,
      inputId: "answer",
      sessionId: row.id,
      at: 20,
      expectedRevision: 1,
      authority: { owner: "kernel", fence: 1 },
      payload: { kind: "request.answer", answer: answer(pending) },
    },
    { row, invocation: original, request: pending },
    TEST_APPROVAL_POLICY.recentOpen,
  );
  expect(result.resolution).toBe("rejected");
  expect(result.request?.state).toBe("open");
});

it("proposes observed global approval count only for a new approval open", () => {
  const pending = request();
  const command = openRequestCommand(row, pending);
  const recent = Array.from({ length: 7 }, (_, index) => ({
    ...pending,
    requestId: `other-${index}`,
    sessionId: `other-session-${index}`,
  }));
  const requests = [
    ...recent,
    { ...pending, requestId: "boundary", createdAt: 20 - 3_600_000 },
    { ...pending, requestId: "reply", mode: "answer" as const },
    { ...pending, requestId: "closed", state: "resolved" as const, outcome: "answered" as const },
  ];
  const snapshot = { row, invocation: original, requests };
  const opened = decideRequestTransition(command, snapshot, TEST_APPROVAL_POLICY.recentOpen);
  expect(opened.resolution).toBe("opened");
  expect(opened).toHaveProperty("requestCount", { since: 20 - 3_600_000, count: 7 });
  expect(
    decideRequestTransition(command, {
      ...snapshot,
      requests: [...requests, { ...pending, requestId: "eighth" }],
    }, TEST_APPROVAL_POLICY.recentOpen),
  ).toEqual({ resolution: "rejected", actions: [] });
  const persisted = opened.actions.map((action, index) => ({
    ...action,
    ordinal: index + 2,
    prevHash: "fixture-prev",
    actionHash: "fixture-hash",
  }));
  expect(
    decideRequestTransition(command, {
      ...snapshot,
      request: opened.request,
      inputRecord: persisted.find((action) => PlainObjectSchema.parse(action.intent.value).inputId === command.inputId),
    }, TEST_APPROVAL_POLICY.recentOpen),
  ).not.toHaveProperty("requestCount");
  const reply = { ...pending, mode: "answer" as const };
  reply.bindingDigest = requestBindingDigest(reply);
  const replyOpened = decideRequestTransition(
    {
      ...command,
      payload: { kind: "request.open", request: reply },
    },
    snapshot,
    TEST_APPROVAL_POLICY.recentOpen,
  );
  expect(replyOpened.resolution).toBe("opened");
  expect(replyOpened).not.toHaveProperty("requestCount");
});

it("pins unknown physical receipts and deduplicates without their local timestamp", () => {
  const pending = request();
  const receipt: SessionTransition.DeliveryReceipt = {
    inputId: "request.delivery",
    requestId: pending.requestId,
    sessionId: row.id,
    sourceActionId: pending.requestId,
    value: "unknown",
    externalMessageId: "physical",
    at: 10,
  };
  const recorded = decide({ kind: "request.delivery", receipt }, pending);
  expect(recorded.resolution).toBe("delivery_recorded");
  expect(recorded.request?.correlation.replyToMessageId).toBe("physical");
  expect(recorded.request?.bindingDigest).not.toBe(pending.bindingDigest);
  const persisted = recorded.actions.map((action, index) => ({
    ...action,
    ordinal: index + 2,
    prevHash: "fixture-prev",
    actionHash: "fixture-hash",
  }));
  const repeated = decide(
    {
      kind: "request.delivery",
      receipt: { ...receipt, at: 30 },
    },
    recorded.request,
    [original, ...persisted],
  );
  expect(repeated.resolution).toBe("delivery_recorded");
  expect(repeated.actions).toEqual([]);
});

it("checks answer bindings before terminal duplication and never receives a rejected reply", () => {
  const pending = { ...request(), mode: "answer" as const };
  pending.bindingDigest = requestBindingDigest(pending);
  const reply = { ...answer(pending), decision: "answer" as const };
  const resolved = decide({ kind: "request.answer", answer: reply }, pending);
  expect(resolved.receive).toMatchObject({
    id: reply.inputId,
    sessionId: row.id,
    content: reply.content,
    parentActionId: pending.requestId,
  });
  const rejected = decide(
    {
      kind: "request.answer",
      answer: { ...reply, inputId: "forged", bindingDigest: "forged" },
    },
    resolved.request,
  );
  expect(rejected.resolution).toBe("rejected");
  expect(rejected.receive).toBeUndefined();
  const duplicate = decide(
    {
      kind: "request.answer",
      answer: { ...reply, inputId: "new-input" },
    },
    resolved.request,
  );
  expect(duplicate.resolution).toBe("duplicate");
  expect(duplicate.receive).toBeUndefined();
});

it("gives timeout and cancellation only one terminal winner", () => {
  const pending = { ...request(), deadline: 20 };
  pending.bindingDigest = requestBindingDigest(pending);
  const expired = decide({ kind: "request.timeout", requestId: pending.requestId }, pending);
  expect(expired.resolution).toBe("expired");
  const cancellation: SessionTransition.Payload = {
    kind: "request.cancel",
    requestId: pending.requestId,
    principal: { kind: "session", principalId: row.id, evidenceId: "owned" },
  };
  const lost = decide(cancellation, expired.request);
  expect(lost.resolution).toBe("duplicate");
  expect(lost.actions.some((action) => action.id.endsWith(":resolution"))).toBe(false);
  const cancelled = decide(cancellation, pending);
  expect(cancelled.resolution).toBe("cancelled");
  expect(
    decide({ kind: "request.timeout", requestId: pending.requestId }, cancelled.request).resolution,
  ).toBe("duplicate");
});

// W5.2: the input-queue table and the atomic cross-session child unit are deleted
// (production stores are per-session files, so a parent+child transaction
// cannot exist); commissioning moved to the entity plane. What remains live is
// the gateway admission intake: a received-message chain action committed in
// the same fenced batch as the request open.
it.each([false, true])("gateway admission intake commits atomically with the request open (fault: %s)", (fault: boolean) => fileRequest((dbPath) => Effect.gen(function* () {
  const { port, opening } = yield* requestPlane();
  const kernel = isolatedLedger().kernel;
  const before = sessionTree(kernel, "parent");
  using raw = new Database(dbPath);
  if (fault) raw.run(`CREATE TRIGGER refuse_admission BEFORE INSERT ON action
    WHEN NEW.id = 'commission:prompt'
    BEGIN SELECT RAISE(ABORT, 'test admission fault'); END`);
  const admission: Delivery.Commit = {
    id: "commission:prompt", sessionId: "parent", kind: "prompt", content: "commission",
    origin: { encodingVersion: 1, value: {
      kind: "message", messageId: "commission", senderSessionId: "parent", sourceActionId: "invocation",
    } },
    parentActionId: "invocation", createdAt: 100,
  };
  const opened = port.open({ ...opening, admission });
  if (fault) {
    expect(yield* Effect.flip(opened)).toMatchObject({ _tag: "CommitFailed", error: { _tag: "AgentFailure" } });
    expect(sessionTree(kernel, "parent")).toEqual(before);
    expect(kernel.requestById("invocation")).toBeUndefined();
    expect(kernel.pendingMessages("parent")).toEqual([]);
    return;
  }
  expect(yield* opened).toMatchObject({ callId: "original-call", parsedInput: { text: "captured" }, state: "open" });
  // The deadline is durable on the request row (the alarms table is deleted).
  expect(kernel.requestById("invocation")?.deadline).toBe(200);
  expect(kernel.pendingMessages("parent").map(({ id }) => id)).toEqual(["commission:prompt"]);
  expect(raw.query("SELECT id FROM session ORDER BY id").all()).toEqual([{ id: "parent" }]);
  // No lease release: the admission's fence owner stays durable.
  expect(kernel.row("parent").fenceOwner).not.toBeNull();
})));

it.each([
  { resolution: "first", threshold: 1 },
  { resolution: "quorum", threshold: 2 },
  { resolution: "all", threshold: 3 },
] as const)("file-backed %s answers only the captured invocation", ({ resolution, threshold }: { resolution: "first" | "quorum" | "all"; threshold: number }) => fileRequest(() => Effect.gen(function* () {
  const { port, opening } = yield* requestPlane();
  const opened = yield* port.open({ ...opening, resolution, threshold, expectedResponders: ["a", "b", "c"] });
  expect(opened).toMatchObject({ callId: "original-call", parsedInput: { text: "captured" }, effectHash: canonicalDigest({ route: "children" }) });
  expect(yield* port.answer({ ...planeAnswer(opened, "a", "ambiguous"), bindingDigest: "wrong-request" })).toBe("rejected");
  expect(isolatedLedger().kernel.pendingMessages("parent")).toEqual([]);
  for (const [index, responder] of ["a", "b", "c"].entries()) {
    const reply = planeAnswer(opened, responder);
    const resolution = index + 1 < threshold ? "attached" : index + 1 === threshold ? "resolved" : "duplicate";
    expect(yield* port.answer(reply)).toBe(resolution);
    expect(yield* port.answer({ ...reply, inputId: `${responder}:again` })).toBe("duplicate");
  }
  expect(isolatedLedger().kernel.requestById(opened.requestId)).toMatchObject({ state: "resolved", replies: opened.expectedResponders.slice(0, threshold).map((responderId) => ({ responderId })) });
  expect(isolatedLedger().kernel.pendingMessages("parent").map(({ id }) => isolatedLedger().kernel.actionById(id)?.parentId)).toEqual(Array.from({ length: threshold }, () => "invocation"));
  expect(sessionTree(isolatedLedger().kernel, "parent").filter(({ id }) => id === "invocation:resolution")).toHaveLength(1);
})));
