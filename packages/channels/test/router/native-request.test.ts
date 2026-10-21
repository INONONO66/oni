import { ledger, resetLedger } from "../helpers/ledger";
import { sessionTree } from "../../../agent/test/store/helpers/session-tree";
import { channelRequests } from "../helpers/channel-requests";
import { beforeEach, expect, test } from "bun:test";
import { runEffect } from "../helpers/effect";
import { Effect } from "effect";
import { effectFailure } from "../helpers/effect-failure";
import { canonicalDigest, type SessionTransition } from "@oni/protocol";
import { answerNativeRequest } from "../../src/router/request/native";
import { openRequest, requestPort } from "../helpers/requests";
import { makeRouter } from "./_router-fixture";

beforeEach(() => {
  resetLedger();
});
const sender = { kind: "session", id: "child" } as const;
function outbound(
  overrides: Partial<SessionTransition.OutboundMessage> = {},
): SessionTransition.OutboundMessage {
  const payload = {
    messageId: "terminal:reply",
    sourceSessionId: "child",
    sourceActionId: "terminal",
    destinationSessionId: "request-owner",
    requestId: "original",
    replyTo: "binding",
    terminal: "completed" as const,
    content: "answer",
    ...overrides,
  };
  return { ...payload, digest: canonicalDigest(payload) };
}

test("native reply reaches the canonical receiving delivery once and retains its original binding", async () => {
  await runEffect(await openRequest("original", {
    expectedResponders: [sender.id],
    correlation: {},
    deadline: 100,
  }));
  const received: string[] = [];
  const port = channelRequests(requestPort(
    () => 2,
    (ids: readonly string[]) => received.push(...ids),
  ));
  const message = outbound();
  const gateway = makeRouter({
    now: () => 2,
    requests: port,
    prepare: () => Effect.succeed({
      target: message.destinationSessionId,
      origin: message,
      message: {
        sender: "session",
        senderRole: "child",
        targetKind: "session",
        type: "message",
        parentChild: true,
        fanout: 0,
        depth: 1,
        withinParentDeadline: true,
      },
    }),
    delivery: {
      commit: () => {
        throw new Error("native answer bypassed request admission");
      },
    },
  });
  const deliver = () =>
    gateway.ingest(sender, {
      to: { kind: "session", id: message.destinationSessionId },
      type: "message",
      content: message.content,
    });
  expect(await runEffect(deliver())).toMatchObject({ status: "executed", delivery: { kind: "session" } });
  expect(ledger().kernel.requestById("original")?.state).toBe("resolved");
  const before = sessionTree("request-owner", ledger().sessions.actions);
  expect(await runEffect(deliver())).toMatchObject({ status: "executed", delivery: { kind: "session" } });
  expect(sessionTree("request-owner", ledger().sessions.actions)).toEqual(before);
  expect(received).toEqual(["request-owner"]);
  expect(ledger().kernel.pendingMessages("request-owner")).toHaveLength(1);
  expect(ledger().kernel.pendingMessages("request-owner")[0]?.origin.value).toEqual(message);
});

test("native reply rejects an altered authenticated sender, content, or destination binding", async () => {
  await runEffect(await openRequest("original", { expectedResponders: [sender.id], correlation: {} }));
  const port = channelRequests(requestPort());
  const before = sessionTree("request-owner", ledger().sessions.actions);
  expect(await effectFailure(answerNativeRequest(port, { kind: "session", id: "stranger" }, outbound(), "answer", 2))).toMatchObject({ _tag: "ChannelsFailure", operation: "native.answer" });
  expect(await effectFailure(answerNativeRequest(port, sender, outbound(), "altered", 2))).toMatchObject({ _tag: "ChannelsFailure", operation: "native.answer" });
  expect(await effectFailure(answerNativeRequest(port, sender, outbound({ destinationSessionId: "other" }), "answer", 2))).toMatchObject({ _tag: "ChannelsFailure", operation: "native.answer" });
  expect(await effectFailure(answerNativeRequest(port, sender, outbound({ requestId: "missing" }), "answer", 2))).toMatchObject({ _tag: "ChannelsFailure", operation: "native.answer" });
  expect(await runEffect(answerNativeRequest(port, sender, undefined, "ordinary", 2))).toBe(false);
  expect(sessionTree("request-owner", ledger().sessions.actions)).toEqual(before);
});

test("a late native answer records the timeout winner without manufacturing new conversational input", async () => {
  await runEffect(await openRequest("original", { expectedResponders: [sender.id], correlation: {}, deadline: 2 }));
  expect(
    await runEffect(answerNativeRequest(
      channelRequests(requestPort(() => 2)),
      sender,
      outbound(),
      "answer",
      2,
    )),
  ).toBe(true);
  expect(ledger().kernel.requestById("original")?.state).toBe("expired");
  expect(ledger().kernel.pendingMessages("request-owner")).toEqual([]);
});
