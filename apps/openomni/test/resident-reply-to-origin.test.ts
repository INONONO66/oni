import { Effect } from "effect";
import { expect, test } from "bun:test";
import type { Core } from "@openomni/agent";
type RunInput = Core.RunInput;
type Sink = Core.LlmSink;
import { Outbound, type Gateway } from "@openomni/protocol";
import type { MessagePort } from "../src/bundles/messaging/send-message/index";
import { residentRunner } from "./helpers/resident-runner";
import { requestToolStep, assistantMessage } from "./helpers/assistant-message";
import { localDelivery } from "./helpers/ledger";
import { runEffect } from "./helpers/effect";

interface Ingested {
  readonly sender: Gateway.IngestSender;
  readonly to: Gateway.SendMessage["to"];
  readonly content: Gateway.SendMessage["content"];
}

function capturingPort(
  ingested: Ingested[],
  admit: (send: Gateway.SendMessage) => boolean = () => true,
): MessagePort {
  return {
    ingest: async (sender, message) => {
      const send = message as Gateway.SendMessage;
      ingested.push({ sender, to: send.to, content: send.content });
      if (!admit(send)) return { status: "blocked_pre", reasonCode: "message.resident.actor_grant" } satisfies Gateway.IngestResult;
      return {
        status: "executed",
        handle: { messageId: `m-${ingested.length}`, target: "person:owner" },
        delivery: { kind: "actor", value: "accepted" },
      } satisfies Gateway.IngestResult;
    },
  };
}

function replyingLlm(reply: string, toolCall?: { readonly contact: string; readonly message: string }) {
  return {
    resolveModel: (model: { readonly id: string; readonly provider: string }) =>
      Effect.succeed({ id: model.id, name: model.id, providerID: model.provider }),
    run: (input: RunInput, sink: Sink) => Effect.sync(() => {
      if (toolCall !== undefined) {
        const result = requestToolStep(input, sink, {
          id: "call-1",
          tool: "send_message",
          input: { to: { kind: "contact", id: toolCall.contact }, message: toolCall.message, kind: "prompt" },
        });
        if (result === undefined) return { type: "stop" as const };
      }
      sink.onMessage(assistantMessage(input, { text: reply }));
      return { type: "stop" as const };
    }),
  };
}

interface ExternalOrigin {
  readonly surface: string;
  readonly externalId: string;
  readonly actorId: string;
  readonly messageId: string;
  readonly conversation?: Readonly<Record<string, string | boolean>>;
}

async function deliverExternal(
  resident: ReturnType<typeof residentRunner>,
  sessionId: string,
  origin: ExternalOrigin,
  content: string,
) {
  const exists = resident.plane.listSessions().some((row) => row.id === sessionId);
  await runEffect(localDelivery(resident.plane, "reply-origin-test", () => 10)({
    id: `${origin.surface}::${origin.externalId}:1`,
    sessionId,
    kind: "prompt",
    content,
    origin: { encodingVersion: 1, value: { kind: "external", inboundTreatment: "full_access", ...origin } },
    createdAt: 10,
    parentActionId: null,
    ...(exists ? {} : { createSession: resident.genesis(sessionId, null, "resident", "resident") }),
  }));
  const result = await resident.drain(sessionId);
  if (result === undefined) throw new Error("resident turn returned no result");
  return result;
}

const telegramOwner = { surface: "telegram", externalId: "7", actorId: "person:owner", messageId: "telegram::7:1" };

test("a turn answering an approved person on a channel reports its result to that person", async () => {
  const ingested: Ingested[] = [];
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    tools: { messages: capturingPort(ingested) },
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("pong"),
  });
  const result = await deliverExternal(resident, "reply-origin-telegram", telegramOwner, "ping");
  expect(result.kind).toBe("result");
  expect(ingested).toEqual([
    {
      sender: { kind: "session", id: "reply-origin-telegram" },
      to: { kind: "actor", actorId: "person:owner", surface: "telegram" },
      content: Outbound.payload("pong"),
    },
  ]);
});

test("an external turn pulses its recorded channel conversation until the turn completes", async () => {
  const ingested: Ingested[] = [];
  const typed = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const calls: { externalId: string; conversation?: Gateway.Conversation }[] = [];
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    tools: { messages: capturingPort(ingested) },
    typingRoute: (surface) => surface === "telegram"
      ? async (externalId, conversation) => {
          calls.push({ externalId, ...(conversation === undefined ? {} : { conversation }) });
          typed.resolve();
          throw new Error("platform rejected typing");
        }
      : undefined,
    sessionRuntime: { clock: () => 10 },
    llm: {
      ...replyingLlm("unused"),
      run: (input: RunInput, sink: Sink) => Effect.gen(function* () {
        started.resolve();
        yield* Effect.promise(() => release.promise);
        sink.onMessage(assistantMessage(input, { text: "pong" }));
        return { type: "stop" as const };
      }),
    },
  });
  const turn = deliverExternal(resident, "reply-origin-typing", {
    ...telegramOwner,
    conversation: { channelId: "C1", messageId: "m-1", dm: false },
  }, "ping");
  await typed.promise;
  await started.promise;
  expect(calls).toEqual([{
    externalId: "7",
    conversation: { channelId: "C1", replyToMessageId: "m-1" },
  }]);
  release.resolve();
  expect((await turn).kind).toBe("result");
  expect(ingested[0]?.content).toEqual(Outbound.payload("pong"));
});

test("the report goes back on the channel the person wrote on, not another of their endpoints (#1485)", async () => {
  const ingested: Ingested[] = [];
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    tools: { messages: capturingPort(ingested) },
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("pong"),
  });
  await deliverExternal(
    resident,
    "reply-origin-slack",
    { surface: "slack", externalId: "T1:U1", actorId: "person:owner", messageId: "slack::T1:U1:1" },
    "ping",
  );
  expect(ingested.map((item) => item.to)).toEqual([{ kind: "actor", actorId: "person:owner", surface: "slack" }]);
});

test("a message written in a channel thread is answered in that thread, a DM directly (#1490)", async () => {
  const ingested: Ingested[] = [];
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    tools: { messages: capturingPort(ingested) },
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("pong"),
  });
  const slackOwner = { surface: "slack", externalId: "T1:U1", actorId: "person:owner", messageId: "1710.0002" };
  await deliverExternal(resident, "reply-origin-thread", {
    ...slackOwner,
    conversation: { channelId: "C1", threadId: "1710.0001", messageId: "1710.0002", dm: false },
  }, "ping");
  await deliverExternal(resident, "reply-origin-dm", {
    ...slackOwner,
    conversation: { channelId: "D1", messageId: "1710.0003", dm: true },
  }, "ping");
  expect(ingested.map((item) => item.to)).toEqual([
    {
      kind: "actor",
      actorId: "person:owner",
      surface: "slack",
      conversation: { channelId: "C1", threadId: "1710.0001", replyToMessageId: "1710.0002" },
    },
    { kind: "actor", actorId: "person:owner", surface: "slack" },
  ]);
});

test("an explicit send_message to the same person in the turn is not duplicated by the report", async () => {
  const ingested: Ingested[] = [];
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    tools: { messages: capturingPort(ingested) },
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("sent it", { contact: "person:owner", message: "테스트 OK" }),
  });
  await deliverExternal(resident, "reply-origin-explicit", telegramOwner, "send a test");
  expect(ingested.map((item) => item.content)).toEqual([Outbound.payload("테스트 OK")]);
});

test("a refused explicit send leaves the person still owed the report (#1485)", async () => {
  const ingested: Ingested[] = [];
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    // The model's own send (no surface) is refused; the pinned report is admitted.
    tools: { messages: capturingPort(ingested, (send) => send.to.kind === "actor" && send.to.surface !== undefined) },
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("could not send it", { contact: "person:owner", message: "테스트 OK" }),
  });
  await deliverExternal(resident, "reply-origin-refused", telegramOwner, "send a test");
  expect(ingested.map((item) => [item.content, item.to.kind === "actor" ? item.to.surface : undefined])).toEqual([
    [Outbound.payload("테스트 OK"), undefined],
    [Outbound.payload("could not send it"), "telegram"],
  ]);
});

test("a WebSocket owner reads the turn stream and is not written to again", async () => {
  const ingested: Ingested[] = [];
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    tools: { messages: capturingPort(ingested) },
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("pong"),
  });
  await deliverExternal(
    resident,
    "reply-origin-ws",
    { surface: "ws", externalId: "owner", actorId: "person:owner", messageId: "ws::owner:1" },
    "ping",
  );
  expect(ingested).toEqual([]);
});
