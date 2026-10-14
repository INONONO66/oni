import { ledger } from "../helpers/ledger";
import { sessionTree } from "../../../agent/test/store/helpers/session-tree";
import { Effect } from "effect";
import { channelRequests } from "../helpers/channel-requests";
import { channelTransaction } from "../helpers/channel-transaction";
import { effectFailure } from "../helpers/effect-failure";
import { runEffect } from "../helpers/effect";
import { openRequest, requestPort, seededRequests } from "../helpers/requests";
import { replaceDecisionFacts } from "../helpers/ledger";
import { beforeEach, expect, test } from "bun:test";
import { Channel, Ingress, type Gateway, Outbound, type SessionTransition } from "@openomni/protocol";
import { Bus } from "../helpers/observation";
import { createExistingAgentMessaging } from "../../src/router/messaging/send";
import { commits, kernelRouter, makeRouter, resetRouterState, routingDecisions, } from "./_router-fixture";

const sender = { kind: "external", surface: "telegram", externalId: "seller-1" } as const;
function facts(
  eventId: string,
  payload: Gateway.IngressFacts["payload"] = { action: "report_result", output: "SN-A2334" },
): Gateway.IngressFacts {
  return {
    eventId,
    surface: "telegram",
    channelId: "telegram:dm",
    addressees: [],
    dm: true,
    reply: { chain: [], tokenHash: "token-hash-1" },
    payload,
    render: "SN-A2334",
  };
}
function scope(id: string) {
  return { surface: "telegram", channel: "telegram:dm", id: `telegram::telegram%3Adm:${id}` };
}
function registerResponder(actorId = "actor-external-child", externalId = "seller-1"): void {
  ledger().stores.actors.registerIdentity({ id: actorId, kind: "human", trustTier: "assigned_worker" });
  ledger().stores.actors.registerEndpoint({
    id: `telegram:${externalId}`,
    actorId,
    channel: "telegram",
    externalId,
  });
}

beforeEach(() => {
  resetRouterState();
  registerResponder();
});

test.each([0, 10] as const)("correlated reply bypasses a %s-second action trigger and commits only to its owner", async (windowSeconds) => {
  await runEffect(await openRequest("request-session-owner"));
  ledger().stores.automations.add(Ingress.Automation.parse({
    id: "request-trigger", name: "Request trigger", enabled: true, createdBy: "owner",
    triggers: [{ type: "message", surface: "telegram", event: "message" }],
    target: "session:worker", grouping: { by: "channel", windowSeconds },
  }));
  ledger().stores.surfaceKeys.claim(
    Channel.SurfaceKey.fromChannel({
      surface: "telegram",
      namespace: "telegram",
      kind: "dm",
      id: "telegram:dm",
    }),
    "surface-conflict",
  );
  const result = await runEffect(kernelRouter().ingest(sender, facts("reply")));
  expect(result).toMatchObject({
    status: "executed",
    handle: { target: "request-owner" },
    delivery: { kind: "session" },
  });
  expect(routingDecisions()).toHaveLength(1);
  expect(routingDecisions()[0]).toMatchObject({
    stage: "request_correlation",
    outcome: "route",
    sessionId: "request-owner",
  });
  expect(commits).toHaveLength(1);
  expect(commits[0]?.sessionId).toBe("request-owner");
  await runEffect(kernelRouter().advance(10_001));
  expect(commits).toHaveLength(1);
  expect(ledger().stores.automations.decisions(scope("reply").id)).toEqual([]);
  expect(ledger().stores.automations.groups()).toEqual([]);
  expect(ledger().kernel.requestById("request-session-owner")).toMatchObject({
    state: "resolved",

    replies: [{ replyId: scope("reply").id, responderId: "actor-external-child" }],
  });
});

test("first quorum reply commits input but leaves the request open", async () => {
  await runEffect(await openRequest("quorum", {
    expectedResponders: ["actor-external-child", "b", "c"],
    resolution: "quorum",
    threshold: 2,
  }));
  expect(await runEffect(kernelRouter().ingest(sender, facts("reply")))).toMatchObject({
    status: "executed",
    handle: { target: "request-owner" },
  });
  expect(ledger().kernel.requestById("quorum")).toMatchObject({ state: "open" });
  expect(ledger().kernel.requestById("quorum")?.replies).toHaveLength(1);
});

async function expectStableReplyReplay(): Promise<void> {
  const before = sessionTree("request-owner", ledger().sessions.actions);
  await runEffect(kernelRouter().ingest(sender, facts("reply")));
  expect(sessionTree("request-owner", ledger().sessions.actions)).toEqual(before);
  expect(ledger().kernel.pendingMessages("request-owner")).toHaveLength(1);
}

test("duplicate unresolved reply reuses its receipt without another durable input", async () => {
  await runEffect(await openRequest("duplicate", {
    expectedResponders: ["actor-external-child", "b"],
    resolution: "quorum",
    threshold: 2,
  }));
  await runEffect(kernelRouter().ingest(sender, facts("reply")));
  await expectStableReplyReplay();
  expect(ledger().kernel.requestById("duplicate")?.replies).toHaveLength(1);
  expect(commits).toHaveLength(1);
});

test("late reply lazily expires the request while retaining partial progress", async () => {
  await runEffect(await openRequest("late", {
    expectedResponders: ["actor-external-child", "b"],
    resolution: "quorum",
    threshold: 2,
    deadline: 10_000,
  }));
  const request = ledger().kernel.requestById("late");
  if (!request) throw new Error("missing request");
  expect(
    await runEffect(requestPort().answer({
      inputId: "early",
      requestId: "late",
      sessionId: request.sessionId,
      receivedAt: 1000,
      principal: { kind: "actor", principalId: "b", evidenceId: "early" },
      bindingDigest: request.bindingDigest,
      inputHash: request.inputHash,
      effectHash: request.effectHash,
      generation: request.generation,
      toolsHash: request.toolsHash,
      domainRevisions: request.domainRevisions,
      decision: "answer",
      allowedAction: "report_result",
      content: "partial",
    })),
  ).toBe("attached");
  expect(await effectFailure(
    makeRouter({ now: () => 10_001 }).ingest(sender, facts("late")),
  )).toMatchObject({
    code: "request_reply_rejected",
    _tag: "IngressRoutingError",
  });
  expect(ledger().kernel.requestById("late")).toMatchObject({
    state: "expired",
    outcome: "outcome_unknown",
  });
  expect(ledger().kernel.requestById("late")?.replies).toHaveLength(1);
  expect(commits).toEqual([]);
});

test("resolved reply redelivery preserves the original request revision", async () => {
  await runEffect(await openRequest("redelivery"));
  await runEffect(kernelRouter().ingest(sender, facts("reply")));
  const resolved = ledger().kernel.requestById("redelivery");
  await expectStableReplyReplay();
  expect(ledger().kernel.requestById("redelivery")).toEqual(resolved);
  // Kernel admission and receiving delivery are one durable transition.
  expect(commits).toHaveLength(1);
});

test.each([
  "before",
  "after",
] as const)("reply redelivery repairs a crash %s the owner delivery commit without another input", async (site: "before" | "after") => {
  await runEffect(await openRequest("handoff"));
  const handoffFault = new Error("delivery handoff fault");
  let fault = true;
  let now = 10;
  const requests = channelRequests(requestPort(() => now));
  const router = makeRouter({
    now: () => now,
    requests: {
      ...requests,
      answer: (input: Parameters<typeof requests.answer>[0]) => Effect.gen(function* () {
        if (fault && site === "before") {
          fault = false;
          throw handoffFault;
        }
        const resolution = yield* requests.answer(input);
        if (fault) {
          fault = false;
          throw handoffFault;
        }
        return resolution;
      }),
    },
  });
  expect(await effectFailure(router.ingest(sender, facts("handoff-reply")))).toBe(handoffFault);
  expect(ledger().kernel.requestById("handoff")?.state).toBe(
    site === "before" ? "open" : "resolved",
  );
  expect(ledger().kernel.pendingMessages("request-owner")).toHaveLength(site === "before" ? 0 : 1);
  now = 20;
  await runEffect(router.ingest(sender, facts("handoff-reply")));
  const before = sessionTree("request-owner", ledger().sessions.actions);
  now = 30;
  await runEffect(router.ingest(sender, facts("handoff-reply")));
  expect(sessionTree("request-owner", ledger().sessions.actions)).toEqual(before);
  expect(ledger().kernel.pendingMessages("request-owner")).toHaveLength(1);
  expect(ledger().kernel.requestById("handoff")?.replies).toHaveLength(1);
});

test("unexpected responder is refused with an authoritative route correction", async () => {
  registerResponder("intruder", "intruder");
  await runEffect(await openRequest("intruder", { expectedResponders: ["someone-else"] }));
  expect(await effectFailure(
    kernelRouter().ingest({ ...sender, externalId: "intruder" }, facts("reply")),
  )).toMatchObject({
    code: "request_reply_rejected",
    _tag: "IngressRoutingError",
  });
  expect(ledger().kernel.requestById("intruder")).toMatchObject({ state: "open", replies: [] });
  expect(ledger().sessions.decisionFacts?.head(Ingress.routeStreamId(scope("reply")))?.type).toBe(
    "route.decided",
  );
  expect(
    ledger().sessions.decisionFacts?.head(Ingress.routeCorrectionStreamId(scope("reply"))),
  ).toMatchObject({
    type: "route.not_delivered",
    key: Ingress.routeCorrectionStreamId(scope("reply")),
  });
  expect(commits).toEqual([]);
});

test("same-precedence ambiguity is denied before delivery commit", async () => {
  await runEffect(await openRequest("a"));
  await runEffect(await openRequest("b"));
  expect(await runEffect(kernelRouter().ingest(sender, facts("reply")))).toMatchObject({
    status: "blocked_pre",
  });
  expect(routingDecisions()[0]).toMatchObject({
    stage: "request_correlation",
    outcome: "ambiguous",
    candidateInteractionIds: ["request:a", "request:b"],
  });
  expect(commits).toEqual([]);
});

test.each(["throw", "wrong_type"] as const)("route correction %s fails closed", async (fault: "throw" | "wrong_type") => {
  await runEffect(await openRequest("correction", { expectedResponders: ["someone-else"] }));
  replaceDecisionFacts((facts: Parameters<Parameters<typeof replaceDecisionFacts>[0]>[0]) => ({
    ...facts,
    record: (fact: Parameters<typeof facts.record>[0]) => {
      if (fact.type !== Ingress.ROUTE_NOT_DELIVERED_FACT_TYPE) return facts.record(fact);
      if (fault === "throw") throw new Error("correction unavailable");
      return { kind: "exists", fact: { ...fact, type: "other.fact", rowHash: "0".repeat(64) } };
    },
  }));
  expect(await effectFailure(kernelRouter().ingest(sender, facts("reply")))).toMatchObject({
    code: "route_record_failed",
  });
  expect(commits).toEqual([]);
});

test("missing decision-fact storage refuses a route correction", async () => {
  await runEffect(await openRequest("missing-correction", {
    expectedResponders: ["someone-else"],
  }));
  replaceDecisionFacts((decisionFacts) => ({
    ...decisionFacts,
    record: (fact: Parameters<typeof decisionFacts.record>[0]) => {
      const outcome = decisionFacts.record(fact);
      if (fact.type === Ingress.ROUTE_DECIDED_FACT_TYPE) {
        ledger().setDecisionFacts(undefined);
      }
      return outcome;
    },
  }));
  expect(await effectFailure(kernelRouter().ingest(sender, facts("reply")))).toMatchObject({
    code: "route_record_failed",
    message: "Storage adapter does not implement decision facts — routing corrections fail closed",
  });
  expect(commits).toEqual([]);
});

test("recorded rejection correction is idempotent", async () => {
  await runEffect(await openRequest("correction", {
    expectedResponders: ["actor-external-child", "b"],
    resolution: "quorum",
    threshold: 2,
  }));
  await runEffect(kernelRouter().ingest(sender, facts("reply")));
  for (let repeat = 0; repeat < 2; repeat += 1) {
    expect(await effectFailure(kernelRouter().ingest(sender, facts("another-reply")))).toMatchObject({
      code: "request_reply_rejected",
    });
  }
  expect(
    ledger().sessions.decisionFacts?.head(Ingress.routeCorrectionStreamId(scope("another-reply"))),
  ).toMatchObject({
    type: "route.not_delivered",
    key: Ingress.routeCorrectionStreamId(scope("another-reply")),
  });
  expect(commits).toHaveLength(1);
});

test.each([
  "ask_clarification",
  "invalid",
])("disallowed request action %s never falls through to the surface", async (action: string) => {
  await runEffect(await openRequest("disallowed"));
  expect(await runEffect(kernelRouter().ingest(sender, facts("reply", { action })))).toMatchObject({
    status: "blocked_pre",
  });
  expect(routingDecisions()[0]).toMatchObject({ stage: "request_correlation", outcome: "block" });
  expect(ledger().kernel.requestById("disallowed")).toMatchObject({
    state: "open",
    replies: [],
  });
  expect(commits).toEqual([]);
});

test("awaited send resolves quorum from distinct authenticated responder endpoints", async () => {
  registerResponder("r1", "responder-1");
  registerResponder("r2", "responder-2");
  registerResponder("target", "target");
  const messaging = createExistingAgentMessaging({
    requests: channelRequests(seededRequests()),
    stores: ledger().stores,
    transaction: channelTransaction,
    deliver: () => ({ value: "accepted", externalMessageId: "platform-message" }),
    grants: () => [
      { id: "grant", senderId: "owner", targetActorId: "target", operations: ["awaited"] },
    ],
    publish: Bus.publish,
  });
  const sent = await runEffect(messaging.send({
    messageId: "outbound",
    senderId: "owner",
    target: { actorId: "target" },
    operation: "awaited",
    payload: Outbound.payload("verdict"),
    at: 1,
    traceId: "trace",
    requestSpec: {
      requestId: "quorum",
      sessionId: "request-owner",
      allowedActions: ["report_result"],
      expectedResponders: ["r1", "r2", "r3"],
      resolution: "quorum",
      threshold: 2,
      deadline: Number.MAX_SAFE_INTEGER,
      correlation: { channelId: "telegram:dm" },
    },
  }));
  expect(sent).toMatchObject({
    kind: "sent",
    operation: "awaited",
    request: {
      correlation: { endpointId: "telegram:target", replyToMessageId: "platform-message" },
    },
  });
  for (const externalId of ["responder-1", "responder-2"]) {
    expect(
      await runEffect(kernelRouter().ingest(
        { ...sender, externalId },
        { ...facts(externalId), reply: { chain: [], replyToMessageId: "platform-message" } },
      )),
    ).toMatchObject({ status: "executed", handle: { target: "request-owner" } });
    expect(ledger().kernel.requestById("quorum")?.state).toBe(
      externalId === "responder-1" ? "open" : "resolved",
    );
  }
  expect(
    ledger().kernel.requestById("quorum")?.replies.map((reply: SessionTransition.Request["replies"][number]) => reply.responderId),
  ).toEqual(["r1", "r2"]);
  expect(commits).toHaveLength(2);
});

test("blacklist takes precedence over reply correlation", async () => {
  await runEffect(await openRequest("blacklisted"));
  ledger().stores.blacklist.put({
    id: "blocked",
    kind: "endpoint",
    value: "telegram:seller-1",
    createdBy: "owner",
  });
  expect(await runEffect(kernelRouter().ingest(sender, facts("reply")))).toMatchObject({
    status: "blocked_pre",
  });
  expect(routingDecisions()[0]).toMatchObject({ stage: "blacklist", outcome: "drop" });
  expect(ledger().kernel.requestById("blacklisted")).toMatchObject({
    state: "open",
    replies: [],
  });
  expect(commits).toEqual([]);
});
