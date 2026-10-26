import { ledger, resetLedger } from "../helpers/ledger";
import { Effect } from "effect";
import { channelRequests } from "../helpers/channel-requests";
import { channelTransaction } from "../helpers/channel-transaction";
import { effectFailure } from "../helpers/effect-failure";
import { runEffect } from "../helpers/effect";
import { openRequest, requestPort } from "../helpers/requests";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Gateway, type Delivery, type BusEvent, type PlainValue, Ingress } from "@oni/protocol";
import { createGatewayRouter, type GatewayRouterPorts } from "../../src/router";
import { IngressRoutingError } from "../../src/errors";
import { recordingDelivery } from "./_recording-delivery";

beforeEach(() => {
  resetLedger();
  ledger().stores.actors.registerIdentity({
    id: "responder",
    kind: "human",
    trustTier: "assigned_worker",
  });
  ledger().stores.actors.registerEndpoint({
    id: "telegram:seller",
    actorId: "responder",
    channel: "telegram",
    externalId: "seller",
  });
});
afterEach(() => {
  resetLedger();
});

test.each([
  ["report_result", "report_result"],
  ["ask_clarification", "ask_clarification"],
  ["invalid", "invalid"],
  [null, "invalid"],
  [0, "invalid"],
  [{ unexpected: true }, "invalid"],
] as const)("raw request reply projects %j as %s", async (action: PlainValue, expectedAction: string) => {
  // Given a durable request accepting only report_result.
  await runEffect(await openRequest("request-raw-action", {
    sessionId: "request-owner",
    correlation: { channelId: "dm", tokenHash: "token" },
    expectedResponders: ["responder"],
  }));
  const commits: Delivery.Commit[] = [];
  const decisions: Ingress.RoutingDecisionPayload[] = [];
  const ids = { value: 0 };
  const router = createGatewayRouter({
    requests: channelRequests(requestPort()),
    stores: ledger().stores,
    transaction: channelTransaction,
    now: () => 1,
    id: () => { ids.value += 1; return `raw-id-${ids.value}`; },
    sink: <T>(event: BusEvent.Descriptor<T>, data: T) => {
      if (event.name === Ingress.Events.RoutingDecision.name) {
        decisions.push(Ingress.Events.RoutingDecision.schema.parse(data));
      }
    },
    delivery: recordingDelivery(commits),
    prepare: (_sender: Gateway.IngestSender, _message: Gateway.SendMessage, target: string) => Effect.succeed({
      target,
      message: {
        sender: "external",
        addressee: "bot",
        identity: true,
        grantTier: true,
        egressBudget: true,
        eventIdUnique: true,
        replyCorrelation: true,
      },
    }),
    run: (_sender: Gateway.IngestSender, request: Parameters<GatewayRouterPorts["run"]>[1], body: Parameters<GatewayRouterPorts["run"]>[2]) => Effect.gen(function* () {
      return {
      terminal: "executed",
      matchedRuleIds: [],
      value: yield* body({
        action: {
          id: "source",
          sessionId: "request-owner",
          parentId: null,
          kind: "message",
          intent: { encodingVersion: 1, value: { value: request.intent } },
          effect: { encodingVersion: 1, value: {} },
          irreversible: true,
          ordinal: 1,
          ts: 1,
        },
        revision: 1,
      }),
      };
    }),
  });
  const facts: Gateway.IngressFacts = {
    eventId: "reply",
    surface: "telegram",
    channelId: "dm",
    addressees: [],
    dm: true,
    reply: { chain: [], tokenHash: "token" },
    payload: { action, output: "answer" },
    render: "answer",
  };

  // When a driver submits raw facts through the current public seam.
  const outcome = router.ingest(
    { kind: "external", surface: "telegram", externalId: "seller" },
    facts,
  );

  // Then only the allowed action can resolve the request and commit a prompt.
  if (action === "report_result") {
    expect(await runEffect(outcome)).toMatchObject({
      status: "executed",
      handle: { target: "request-owner" },
    });
    expect(commits).toHaveLength(0);
    expect(ledger().kernel.pendingMessages("request-owner")).toMatchObject([
      { content: [{ kind: "text", text: "answer" }] },
    ]);
    expect(ledger().kernel.requestById("request-raw-action")?.state).toBe("resolved");
  } else {
    const failure: Error = await effectFailure(outcome);
    expect(failure).toBeInstanceOf(IngressRoutingError);
    expect(failure).toMatchObject({ _tag: "IngressRoutingError", code: "route_blocked" });
    expect(decisions[0]).toMatchObject({
      stage: "request_correlation",
      outcome: "block",
      factsUsed: [
        "request:request:request-raw-action",
        `request.action:${expectedAction}`,
        "request.action:disallowed",
      ],
    });
    expect(commits).toHaveLength(0);
    expect(ledger().kernel.requestById("request-raw-action")).toMatchObject({
      state: "open",
      replies: [],
    });
  }
});
