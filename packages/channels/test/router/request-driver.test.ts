import { testRun } from "../helpers/injected";
import { Outbound } from "@oni/protocol";
import { ledger, resetLedger } from "../helpers/ledger";
import { sessionTree } from "../../../agent/test/store/helpers/session-tree";
type OutboundMessage = Parameters<Parameters<typeof createExistingAgentMessaging>[0]["deliver"]>[0];
import { channelTransaction } from "../helpers/channel-transaction";
import { channelRequests } from "../helpers/channel-requests";
import { afterEach, expect, test } from "bun:test";
import { runEffect } from "../helpers/effect";
import { kernelDeliveryReceipt } from "../../src/support/deliver";
import type { ChannelDeliveryRoute } from "../../src/router/message-ports";
import { TelegramAdapter } from "../../src/provider/telegram/surface";
import { TelegramNormalizer } from "../../src/provider/telegram/normalizer";
import { createExistingAgentMessaging } from "../../src/router/messaging/send";
import { makeRouter, resetStores } from "./_router-fixture";
import { originalAction, requestPort } from "../helpers/requests";

function registerTelegramTarget(): void {
  ledger().stores.actors.registerIdentity({ id: "target", kind: "human", trustTier: "collaborator" });
  ledger().stores.actors.registerEndpoint({
    id: "endpoint",
    actorId: "target",
    channel: "telegram",
    externalId: "1",
  });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetLedger();
});

test("router opens the immutable original message action before real Telegram delivery", async () => {
  resetStores();
  registerTelegramTarget();
  let observedRequestId: string | undefined;
  globalThis.fetch = (async (input: string | Request | URL) => {
    if (!String(input).endsWith("/sendMessage")) throw new Error("unexpected transport request");
    const request = ledger().kernel.requestRows()[0];
    expect(request?.state).toBe("open");
    expect(request?.parsedInput).toMatchObject({ content: "original question" });
    observedRequestId = request?.requestId;
    return Response.json({ ok: true, result: { message_id: 77 } });
  }) as typeof fetch;
  const driver = new TelegramAdapter("token", {}, () => undefined, { now: () => 10, id: () => "driver-id", random: () => 0, run: testRun });
  const router = makeRouter({
    now: () => 10,
    messaging: {
      grants: () => [
        { id: "grant", senderId: "source", targetActorId: "target", operations: ["awaited"] },
      ],
      deliveryRoutes: new Map<string, ChannelDeliveryRoute>([["telegram", (externalId, body, key) => driver.deliver(externalId, body, key).then(kernelDeliveryReceipt)]]),
    },
  });
  const result = await runEffect(router.ingest(
    { kind: "session", id: "source" },
    {
      to: { kind: "actor", actorId: "target" },
      type: "message",
      content: "original question",
      deadline: 100,
    },
  ));
  expect(result).toMatchObject({
    status: "executed",
    delivery: { kind: "actor", value: "accepted" },
  });
  if (result.status !== "executed") throw new Error("send was not executed");
  expect(observedRequestId).toBeDefined();
  expect(observedRequestId).not.toBe(result.handle.messageId);
  expect(
    sessionTree("source", ledger().sessions.actions).find((action: import("@oni/protocol").LedgerAction.Node) => action.id === observedRequestId)?.intent
      .value,
  ).toMatchObject({ phase: "intent", value: { content: "original question" } });
});

test.each([
  "all",
  "quorum",
] as const)("real Telegram delivery and normalized replies preserve %s request ownership and pins", async (resolution: "all" | "quorum") => {
  resetStores();
  for (const id of ["target", "r1", "r2", "r3"]) {
    ledger().stores.actors.registerIdentity({ id, kind: "human", trustTier: "assigned_worker" });
    ledger().stores.actors.registerEndpoint({
      id: `telegram:${id}`,
      actorId: id,
      channel: "telegram",
      externalId: id === "target" ? "-100" : id.slice(1),
    });
  }
  originalAction("original-message-action", "source-session", { content: "verdict" });
  let posted = 0;
  globalThis.fetch = (async (input: string | Request | URL) => {
    if (!String(input).endsWith("/sendMessage")) throw new Error("unexpected Telegram request");
    posted += 1;
    return Response.json({ ok: true, result: { message_id: 77 } });
  }) as typeof fetch;
  const driver = new TelegramAdapter("token", {}, () => undefined, { now: () => 10, id: () => "driver-id", random: () => 0, run: testRun });
  const requests = channelRequests(requestPort(() => 10));
  const messaging = createExistingAgentMessaging({
    stores: ledger().stores,
    transaction: channelTransaction,
    requests,
    grants: () => [
      { id: "grant", senderId: "source-session", targetActorId: "target", operations: ["awaited"] },
    ],
    deliver: (message: OutboundMessage) =>
      driver.deliver(message.target.externalId, message.payload, message.idempotencyKey).then(kernelDeliveryReceipt),
    publish: () => undefined,
  });
  const input = {
    messageId: "physical-id",
    traceId: "trace",
    senderId: "source-session",
    target: { actorId: "target" },
    operation: "awaited" as const,
    payload: Outbound.payload("verdict"),
    at: 10,
    requestSpec: {
      requestId: "original-message-action",
      sessionId: "source-session",
      expectedResponders: ["r1", "r2", "r3"],
      allowedActions: ["report_result" as const],
      resolution,
      threshold: resolution === "all" ? 3 : 2,
      deadline: 100,
      correlation: { channelId: "-100" },
    },
  };
  const receipt = await runEffect(messaging.send(input));
  expect(receipt).toMatchObject({
    kind: "sent",
    delivery: "accepted",
    request: {
      requestId: "original-message-action",
      correlation: { replyToMessageId: "77" },
    },
  });
  expect(await runEffect(messaging.send({ ...input, at: 11 }))).toEqual({ ...receipt, at: 11 });
  expect(posted).toBe(1);
  expect(
    sessionTree("source-session", ledger().sessions.actions)
      .filter((action: import("@oni/protocol").LedgerAction.Node) => action.kind === "request")
      .map((action: import("@oni/protocol").LedgerAction.Node) => action.effect.value),
  ).toMatchObject([
    { request: { createdAt: 10 } },
    { receipt: { at: 10, value: "accepted", externalMessageId: "77" } },
    { receipt: { at: 11, value: "accepted", externalMessageId: "77" } },
  ]);
  const router = makeRouter({
    requests,
    now: () => 20,
  });
  const normalizer = new TelegramNormalizer({ botId: "42", botUsername: "bot" });
  for (let index = 1; index <= input.requestSpec.threshold; index += 1) {
    const inbound = normalizer.normalize({
      message_id: 100 + index,
      date: 1,
      chat: { id: -100, type: "group" },
      from: { id: index, is_bot: false, first_name: `r${index}` },
      text: `answer ${index}`,
      reply_to_message: { message_id: 77, date: 1, chat: { id: -100, type: "group" } },
    });
    if (!inbound) throw new Error("normalizer dropped reply");
    expect(await runEffect(router.ingest(inbound.sender, inbound.facts))).toMatchObject({
      status: "executed",
      handle: { target: "source-session" },
    });
    expect(ledger().kernel.requestById("original-message-action")?.state).toBe(
      index === input.requestSpec.threshold ? "resolved" : "open",
    );
  }
  expect(ledger().kernel.pendingMessages("source-session")).toHaveLength(input.requestSpec.threshold);
  expect(
    ledger().kernel.requestById("original-message-action")?.replies.map(
      (reply: { replyId: string; responderId: string; content: string; receivedAt: number; }) => reply.responderId,
    ),
  ).toEqual(["r1", "r2", "r3"].slice(0, input.requestSpec.threshold));
});

test.each([
  "unknown",
  "rejected",
] as const)("%s receipt with external id never becomes accepted on retry", async (value: "rejected" | "unknown") => {
  resetStores();
  registerTelegramTarget();
  originalAction("original", "source");
  let attempts = 0;
  const requests = channelRequests(requestPort());
  const messaging = createExistingAgentMessaging({
    stores: ledger().stores,
    transaction: channelTransaction,
    requests,
    grants: () => [
      { id: "grant", senderId: "source", targetActorId: "target", operations: ["awaited"] },
    ],
    deliver: () => {
      attempts += 1;
      return { value, externalMessageId: "uncertain-id" };
    },
    publish: () => undefined,
  });
  const input = {
    messageId: "physical",
    traceId: "trace",
    senderId: "source",
    target: { actorId: "target" },
    operation: "awaited" as const,
    payload: Outbound.payload("question"),
    at: 1,
    requestSpec: {
      requestId: "original",
      sessionId: "source",
      expectedResponders: ["target"],
      allowedActions: ["report_result" as const],
      resolution: "first" as const,
      threshold: 1,
      deadline: 100,
    },
  };
  expect(await runEffect(messaging.send(input))).toMatchObject({ kind: "sent", delivery: value });
  expect(await runEffect(messaging.send(input))).toMatchObject({ kind: "sent", delivery: value });
  expect(attempts).toBe(2);
  expect(ledger().kernel.requestById("original")?.correlation.replyToMessageId).toBe(
    "uncertain-id",
  );
  expect(ledger().kernel.requestById("original")?.state).toBe("open");
});
