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
import { providerFailure } from "./helpers/provider-failure";

interface Ingested {
  readonly sender: Gateway.IngestSender;
  readonly to: Gateway.SendMessage["to"];
  readonly content: Gateway.SendMessage["content"];
}

function capturingPort(
  ingested: Ingested[],
  admit: (send: Gateway.SendMessage) => boolean = () => true,
  events?: string[],
): MessagePort {
  return {
    ingest: async (sender, message) => {
      const send = message as Gateway.SendMessage;
      ingested.push({ sender, to: send.to, content: send.content });
      events?.push("report");
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

test("a configured channel turn acknowledges before reporting and settles the reaction", async () => {
  const ingested: Ingested[] = [];
  const events: string[] = [];
  const reactions: Outbound.React[] = [];
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    ackReaction: { pending: "👀", ok: "✅", failed: "❌" },
    reactionRoutes: () => new Map([
      ["telegram", async (_externalId, payload) => {
        if (payload.kind !== "react") throw new Error("expected reaction");
        reactions.push(payload);
        events.push(payload.remove === true ? "terminal" : "ack");
        return { value: "accepted" as const, externalMessageId: payload.messageId };
      }],
    ]),
    tools: { messages: capturingPort(ingested, () => true, events) },
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("pong"),
  });
  await deliverExternal(
    resident,
    "reply-origin-ack",
    {
      ...telegramOwner,
      conversation: { channelId: "7", messageId: telegramOwner.messageId, dm: false },
    },
    "ping",
  );
  expect(events).toEqual(["ack", "report", "terminal"]);
  expect(reactions).toEqual([
    { kind: "react", messageId: telegramOwner.messageId, emoji: "👀" },
    { kind: "react", messageId: telegramOwner.messageId, emoji: "✅", remove: true },
  ]);
});

test("ack reactions are off by default", async () => {
  const reactions: Outbound.React[] = [];
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    reactionRoutes: () => new Map([
      ["telegram", async (_externalId, payload) => {
        if (payload.kind === "react") reactions.push(payload);
        return { value: "accepted" as const };
      }],
    ]),
    tools: { messages: capturingPort([]) },
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("pong"),
  });
  await deliverExternal(
    resident,
    "reply-origin-ack-off",
    { ...telegramOwner, conversation: { channelId: "7", messageId: telegramOwner.messageId, dm: false } },
    "ping",
  );
  expect(reactions).toEqual([]);
});

test("a reaction route that throws does not fail the turn", async () => {
  let attempts = 0;
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    ackReaction: { pending: "👀", ok: "✅", failed: "❌" },
    reactionRoutes: () => new Map([
      ["telegram", async () => {
        attempts += 1;
        throw new Error("platform unreachable");
      }],
    ]),
    tools: { messages: capturingPort([]) },
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("pong"),
  });
  const result = await deliverExternal(
    resident,
    "reply-origin-ack-thrown",
    { ...telegramOwner, conversation: { channelId: "7", messageId: telegramOwner.messageId, dm: false } },
    "ping",
  );
  expect(result.kind).toBe("result");
  expect(attempts).toBe(1);
});

test("a refused pending reaction does not fail the turn or add a terminal reaction", async () => {
  const reactions: Outbound.React[] = [];
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    ackReaction: { pending: "👀", ok: "✅", failed: "❌" },
    reactionRoutes: () => new Map([
      ["telegram", async (_externalId, payload) => {
        if (payload.kind === "react") reactions.push(payload);
        return { value: "rejected" as const };
      }],
    ]),
    tools: { messages: capturingPort([]) },
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("pong"),
  });
  const result = await deliverExternal(
    resident,
    "reply-origin-ack-refused",
    { ...telegramOwner, conversation: { channelId: "7", messageId: telegramOwner.messageId, dm: false } },
    "ping",
  );
  expect(result.kind).toBe("result");
  expect(reactions).toEqual([{ kind: "react", messageId: telegramOwner.messageId, emoji: "👀" }]);
});

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

test.each([
  { outcome: "result", stop: "stop" as const },
  { outcome: "error", stop: "error" as const },
])("an external turn pulses its recorded conversation until the model run ends ($outcome), before any report", async ({ outcome, stop }) => {
  const ingested: Ingested[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    tools: { messages: capturingPort(ingested, () => { events.push("report"); return true; }) },
    typingRoute: (surface) => surface === "telegram"
      ? {
          everyMs: 4_000,
          open: async (externalId, conversation) => {
            events.push(`open ${externalId} ${JSON.stringify(conversation)}`);
            return conversation ?? { channelId: externalId };
          },
          pulse: async () => {
            events.push("pulse");
            throw new Error("platform rejected typing");
          },
        }
      : undefined,
    sessionRuntime: { clock: () => 10 },
    llm: {
      ...replyingLlm("unused"),
      run: (input: RunInput, sink: Sink) => Effect.gen(function* () {
        started.resolve();
        yield* Effect.promise(() => release.promise);
        if (stop === "error") return { type: "error" as const, error: providerFailure("model down", new Error("model down")) };
        sink.onMessage(assistantMessage(input, { text: "pong" }));
        return { type: "stop" as const };
      }),
    },
  });
  const turn = deliverExternal(resident, `reply-origin-typing-${outcome}`, {
    ...telegramOwner,
    conversation: { channelId: "C1", messageId: "m-1", dm: false },
  }, "ping");
  await started.promise;
  expect(events).toEqual(['open 7 {"channelId":"C1","replyToMessageId":"m-1"}', "pulse"]);
  release.resolve();
  expect((await turn).kind).toBe(outcome);
  // The pulse scope closed with the model run; the report (the answer, or the
  // failure text) always comes after the last pulse.
  expect(events.slice(2)).toEqual(["report"]);
  expect(ingested).toHaveLength(1);
  if (outcome === "result") expect(ingested[0]?.content).toEqual(Outbound.payload("pong"));
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
