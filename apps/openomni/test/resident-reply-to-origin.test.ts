import { Effect } from "effect";
import { expect, test } from "bun:test";
import type { Core } from "@openomni/agent";
type RunInput = Core.RunInput;
type Sink = Core.LlmSink;
import { Operational, Outbound, type Gateway } from "@openomni/protocol";
import type { MessagePort } from "../src/bundles/messaging/send-message/index";
import { residentRunner } from "./helpers/resident-runner";
import { requestToolStep, assistantMessage } from "./helpers/assistant-message";
import { localDelivery } from "./helpers/ledger";
import { runEffect } from "./helpers/effect";
import { providerFailure } from "./helpers/provider-failure";

interface Ingested {
  readonly sender: Gateway.IngestSender;
  readonly to: Gateway.SendMessage["to"];
  readonly content: Outbound.Payload;
}

function capturingPort(
  ingested: Ingested[],
  admit: (send: Gateway.SendMessage) => boolean = () => true,
): MessagePort {
  return {
    ingest: async (sender, message) => {
      const send = message as Gateway.SendMessage;
      ingested.push({ sender, to: send.to, content: Outbound.payload(send.content) });
      if (!admit(send)) return { status: "blocked_pre", reasonCode: "message.resident.actor_grant" } satisfies Gateway.IngestResult;
      return {
        status: "executed",
        handle: { messageId: `m-${ingested.length}`, target: "person:owner" },
        delivery: { kind: "actor", value: "accepted" },
      } satisfies Gateway.IngestResult;
    },
  };
}

interface ModelSend {
  readonly contact: string;
  readonly message?: string;
  readonly react?: string;
  readonly surface?: string;
  readonly conversation?: Gateway.Conversation;
}

function replyingLlm(reply: string, toolCall?: ModelSend, onToolResult?: (result: { readonly isError?: boolean | undefined; readonly content?: string | undefined }) => void) {
  return {
    resolveModel: (model: { readonly id: string; readonly provider: string }) =>
      Effect.succeed({ id: model.id, name: model.id, providerID: model.provider }),
    run: (input: RunInput, sink: Sink) => Effect.sync(() => {
      if (toolCall !== undefined) {
        const { contact, surface, conversation, ...letter } = toolCall;
        const result = requestToolStep(input, sink, {
          id: "call-1",
          tool: "send_message",
          input: {
            to: { kind: "contact", id: contact, ...(surface === undefined ? {} : { surface }), ...(conversation === undefined ? {} : { conversation }) },
            ...letter,
            kind: "prompt",
          },
        });
        if (result === undefined) return { type: "stop" as const };
        onToolResult?.(result);
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
  readonly inboundTreatment?: "full_access" | "evidence_only";
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
/** The delivered prompt's id: what the reply door names (#1569). */
const PROMPT_ID = "telegram::7:1";
const REPLY_TO_ORIGIN: Gateway.SendMessage["to"] = { kind: "origin", inReplyTo: PROMPT_ID };

const ACK = { pending: "👀", ok: "✅", failed: "❌" };
const ackOrigin = { ...telegramOwner, conversation: { channelId: "7", messageId: telegramOwner.messageId, dm: false } };

/** The reactions a turn sent through the gateway door, in order. */
const reactionsOf = (ingested: readonly Ingested[]) =>
  ingested.flatMap((entry) => (entry.content.kind === "react" ? [entry.content] : []));

test("a configured channel turn acknowledges through the gateway door, replies, then swaps in the terminal emoji", async () => {
  const ingested: Ingested[] = [];
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    ackReaction: ACK,
    tools: { messages: capturingPort(ingested) },
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("pong"),
  });
  await deliverExternal(resident, "reply-origin-ack", ackOrigin, "ping");
  expect(ingested.map((entry) => entry.content.kind)).toEqual(["react", "message", "react"]);
  expect(reactionsOf(ingested)).toEqual([
    { kind: "react", messageId: telegramOwner.messageId, emoji: "👀" },
    { kind: "react", messageId: telegramOwner.messageId, emoji: "✅", replaces: "👀" },
  ]);
  expect(ingested[0]).toMatchObject({
    sender: { kind: "session", id: "reply-origin-ack" },
    to: { kind: "actor", actorId: "person:owner", surface: "telegram", conversation: { channelId: "7", replyToMessageId: telegramOwner.messageId } },
  });
  expect(ingested[1]).toEqual({
    sender: { kind: "session", id: "reply-origin-ack" },
    to: REPLY_TO_ORIGIN,
    content: Outbound.payload("pong"),
  });
});

test("ack reactions are off by default", async () => {
  const ingested: Ingested[] = [];
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    tools: { messages: capturingPort(ingested) },
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("pong"),
  });
  await deliverExternal(resident, "reply-origin-ack-off", ackOrigin, "ping");
  expect(reactionsOf(ingested)).toEqual([]);
});

test("a failed turn settles the reaction as failed", async () => {
  const ingested: Ingested[] = [];
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    ackReaction: ACK,
    tools: { messages: capturingPort(ingested) },
    sessionRuntime: { clock: () => 10 },
    llm: {
      ...replyingLlm("unused"),
      run: () => Effect.succeed({ type: "error" as const, error: providerFailure("model down", new Error("model down")) }),
    },
  });
  const result = await deliverExternal(resident, "reply-origin-ack-failed", ackOrigin, "ping");
  expect(result.kind).toBe("error");
  expect(reactionsOf(ingested).map((reaction) => reaction.emoji)).toEqual(["👀", "❌"]);
});

test("an evidence-only message is never reacted to nor answered", async () => {
  const ingested: Ingested[] = [];
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    ackReaction: ACK,
    tools: { messages: capturingPort(ingested) },
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("pong"),
  });
  await deliverExternal(resident, "reply-origin-ack-evidence", { ...ackOrigin, inboundTreatment: "evidence_only" }, "ping");
  expect(ingested).toEqual([]);
});

test("a port that throws on reactions does not fail the turn", async () => {
  let attempts = 0;
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    ackReaction: ACK,
    tools: {
      messages: {
        ingest: async (_sender, message) => {
          if (Outbound.payload((message as Gateway.SendMessage).content).kind !== "react")
            return { status: "blocked_pre", reasonCode: "message.resident.reply_unbound" };
          attempts += 1;
          throw new Error("gateway unreachable");
        },
      },
    },
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("pong"),
  });
  const result = await deliverExternal(resident, "reply-origin-ack-thrown", ackOrigin, "ping");
  expect(result.kind).toBe("result");
  expect(attempts).toBe(2);
});

test("a refused pending reaction does not fail the turn and still ends with the terminal emoji", async () => {
  const ingested: Ingested[] = [];
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    ackReaction: ACK,
    tools: { messages: capturingPort(ingested, (send) => {
        const content = Outbound.payload(send.content);
        return content.kind !== "react" || content.emoji !== "👀";
      }) },
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("pong"),
  });
  const result = await deliverExternal(resident, "reply-origin-ack-refused", ackOrigin, "ping");
  expect(result.kind).toBe("result");
  expect(reactionsOf(ingested).map((reaction) => reaction.emoji)).toEqual(["👀", "✅"]);
});

test("a turn answering an approved person on a channel replies through the reply door, naming the delivered prompt (#1569)", async () => {
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
  // The gateway folds the channel, conversation and thread from the prompt's
  // recorded origin (#1485/#1490); the turn names only the prompt it answers.
  expect(ingested).toEqual([
    {
      sender: { kind: "session", id: "reply-origin-telegram" },
      to: REPLY_TO_ORIGIN,
      content: Outbound.payload("pong"),
    },
  ]);
});

test("a drafted answer reaches the Owner through the bot on a platform the Owner has; with none it stays in the session (#1600 lane R2)", async () => {
  const sends: Gateway.SendMessage[] = [];
  const drafting: MessagePort = {
    ingest: async (_sender, message) => {
      const send = message as Gateway.SendMessage;
      sends.push(send);
      if (send.to.kind === "origin")
        return { status: "blocked_pre", reasonCode: "message.resident.reply_draft" } satisfies Gateway.IngestResult;
      return {
        status: "executed",
        handle: { messageId: `m-${sends.length}`, target: "person:owner" },
        delivery: { kind: "actor", value: "accepted" },
      } satisfies Gateway.IngestResult;
    },
  };
  const buyer = { surface: "instagram", externalId: "buyer-9", actorId: "person:buyer", messageId: "instagram::buyer-9:1" };
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    tools: { messages: drafting },
    ownerContact: () => ({ actorId: "person:owner", surface: "slack" }),
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("pong"),
  });
  expect((await deliverExternal(resident, "reply-origin-draft", buyer, "price?")).kind).toBe("result");
  expect(sends.map((send) => send.to)).toEqual([
    { kind: "origin", inReplyTo: buyer.messageId },
    { kind: "actor", actorId: "person:owner", surface: "slack" },
  ]);
  // The Owner's own mail: no consent asserted (the gateway asks none for a letter to the Owner), naming who, where, and the words.
  expect(sends[1]).toMatchObject({ type: "message" });
  expect(sends[1]).not.toHaveProperty("consented");
  expect(sends[1]?.content).toEqual(expect.stringContaining("Draft reply to buyer-9 on instagram (buyer-9)"));
  expect(sends[1]?.content).toEqual(expect.stringMatching(/\n\npong$/));
  // No platform the bot can write to the Owner on: the draft is the Owner's to read in the session.
  sends.length = 0;
  const unsent = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    tools: { messages: drafting },
    ownerContact: () => undefined,
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("pong"),
  });
  expect((await deliverExternal(unsent, "reply-origin-draft-unsent", buyer, "price?")).kind).toBe("result");
  expect(sends.map((send) => send.to)).toEqual([{ kind: "origin", inReplyTo: buyer.messageId }]);
  // Any other refusal of the reply is not a draft: nothing goes to the Owner even with a contact at hand.
  const refused: Ingested[] = [];
  const refusing = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    tools: { messages: capturingPort(refused, () => false) },
    ownerContact: () => ({ actorId: "person:owner", surface: "slack" }),
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("pong"),
  });
  expect((await deliverExternal(refusing, "reply-origin-refused-not-draft", buyer, "price?")).kind).toBe("result");
  expect(refused.map((entry) => entry.to)).toEqual([{ kind: "origin", inReplyTo: buyer.messageId }]);
});

test("a draft the door does not carry is reported to the Owner's ear, never lost in silence (#1600 lane R2)", async () => {
  const warns: string[] = [];
  const blockedDoor: MessagePort = {
    ingest: async (_sender, message) => {
      const send = message as Gateway.SendMessage;
      return {
        status: "blocked_pre",
        reasonCode: send.to.kind === "origin" ? "message.resident.reply_draft" : "message.resident.actor_grant",
      } satisfies Gateway.IngestResult;
    },
  };
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    tools: { messages: blockedDoor },
    ownerContact: () => ({ actorId: "person:owner", surface: "slack" }),
    sessionRuntime: {
      clock: () => 10,
      observations: {
        publish: (event, data) => {
          if (event.name === Operational.Events.Warn.name) warns.push(JSON.stringify(data));
        },
      },
    },
    llm: replyingLlm("pong"),
  });
  const buyer = { surface: "instagram", externalId: "buyer-9", actorId: "person:buyer", messageId: "instagram::buyer-9:1" };
  expect((await deliverExternal(resident, "reply-origin-draft-blocked", buyer, "price?")).kind).toBe("result");
  const reported = warns.filter((entry) => entry.includes("draft reply not delivered to the Owner"));
  expect(reported).toHaveLength(1);
  expect(reported[0]).toContain("blocked_pre:message.resident.actor_grant");
  expect(reported[0]).toContain("person:owner@slack");
});

test("a refused or failed reply never fails the turn: the result is recorded either way", async () => {
  const ingested: Ingested[] = [];
  const refusing = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    tools: { messages: capturingPort(ingested, () => false) },
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("pong"),
  });
  expect((await deliverExternal(refusing, "reply-origin-refused-reply", telegramOwner, "ping")).kind).toBe("result");
  expect(ingested.map((entry) => entry.to)).toEqual([REPLY_TO_ORIGIN]);
  const throwing = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    tools: { messages: { ingest: async () => { throw new Error("gateway unreachable"); } } },
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("pong"),
  });
  expect((await deliverExternal(throwing, "reply-origin-thrown-reply", telegramOwner, "ping")).kind).toBe("result");
});

test.each([
  { outcome: "result", stop: "stop" as const },
  { outcome: "error", stop: "error" as const },
])("an external turn pulses its recorded conversation until the model run ends ($outcome), before any reply", async ({ outcome, stop }) => {
  const ingested: Ingested[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    tools: { messages: capturingPort(ingested, () => { events.push("reply"); return true; }) },
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
  // The pulse scope closed with the model run; the reply (the answer, or the
  // failure text) always comes after the last pulse.
  expect(events.slice(2)).toEqual(["reply"]);
  expect(ingested).toHaveLength(1);
  expect(ingested[0]?.to).toEqual(REPLY_TO_ORIGIN);
  if (outcome === "result") expect(ingested[0]?.content).toEqual(Outbound.payload("pong"));
});

test("the reply names the latest channel prompt the turn answers, whatever surface or thread it came from", async () => {
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
  expect(ingested.map((item) => item.to)).toEqual([{ kind: "origin", inReplyTo: "slack::T1:U1:1" }]);
});

test("a send_message letter to the conversation that prompted the turn is refused as same_conversation; the reply still goes", async () => {
  const ingested: Ingested[] = [];
  const results: { readonly isError?: boolean | undefined; readonly content?: string | undefined }[] = [];
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    tools: { messages: capturingPort(ingested) },
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("sent it", { contact: "person:owner", message: "테스트 OK" }, (result) => results.push(result)),
  });
  // A DM prompt: a letter to that person with no surface or conversation is the same conversation.
  await deliverExternal(resident, "reply-origin-same", telegramOwner, "send a test");
  expect(results).toHaveLength(1);
  expect(results[0]?.isError).toBe(true);
  expect(results[0]?.content).toContain("same_conversation");
  expect(ingested.map((item) => [item.to, item.content])).toEqual([[REPLY_TO_ORIGIN, Outbound.payload("sent it")]]);
});

test("a Slack-shaped origin (workspace recorded) still folds the conversation: reactions, threaded typing and the same_conversation refusal all hold", async () => {
  const ingested: Ingested[] = [];
  const results: { readonly isError?: boolean | undefined; readonly content?: string | undefined }[] = [];
  const opened: string[] = [];
  const slackOwner = { surface: "slack", externalId: "T1:U1", actorId: "person:owner", messageId: "1710.0002" };
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    ackReaction: ACK,
    tools: { messages: capturingPort(ingested) },
    typingRoute: (surface) => surface === "slack"
      ? {
          everyMs: 4_000,
          open: async (externalId, conversation) => {
            opened.push(JSON.stringify(conversation));
            return conversation ?? { channelId: externalId };
          },
          pulse: async () => undefined,
        }
      : undefined,
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm(
      "sent it",
      { contact: "person:owner", message: "again", surface: "slack", conversation: { channelId: "C1", threadId: "1710.0001" } },
      (result) => results.push(result),
    ),
  });
  await deliverExternal(resident, "reply-origin-workspace", {
    ...slackOwner,
    conversation: { channelId: "C1", threadId: "1710.0001", messageId: "1710.0002", dm: false, workspaceId: "T1" },
  }, "ping");
  expect(results.map((result) => result.isError === true)).toEqual([true]);
  expect(results[0]?.content).toContain("same_conversation");
  expect(opened).toEqual(['{"channelId":"C1","threadId":"1710.0001","replyToMessageId":"1710.0002"}']);
  expect(ingested.map((entry) => entry.content.kind)).toEqual(["react", "message", "react"]);
  expect(reactionsOf(ingested).map((reaction) => reaction.emoji)).toEqual(["👀", "✅"]);
});

test.each([
  // The channel's top level is another conversation than the thread the person wrote in.
  ["the same channel, outside the thread", { channelId: "7" }, false],
  ["the same channel and thread", { channelId: "7", threadId: "t-1" }, true],
  ["the same channel, another thread", { channelId: "7", threadId: "t-2" }, false],
  ["another channel", { channelId: "8", threadId: "t-1" }, false],
])("a letter into %s of a threaded prompt: refused %p", async (_name, conversation, refusedLetter) => {
  const ingested: Ingested[] = [];
  const results: { readonly isError?: boolean | undefined }[] = [];
  const resident = residentRunner({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    tools: { messages: capturingPort(ingested) },
    sessionRuntime: { clock: () => 10 },
    llm: replyingLlm("done", { contact: "person:owner", message: "elsewhere", surface: "telegram", conversation }, (result) => results.push(result)),
  });
  await deliverExternal(resident, `reply-origin-thread-${JSON.stringify(conversation).length}-${refusedLetter}`, {
    ...telegramOwner,
    conversation: { channelId: "7", threadId: "t-1", messageId: telegramOwner.messageId, dm: false },
  }, "ping");
  expect(results.map((result) => result.isError === true)).toEqual([refusedLetter]);
  expect(ingested.map((item) => item.to.kind)).toEqual(refusedLetter ? ["origin"] : ["actor", "origin"]);
});

test("a DM prompt refuses a letter naming no conversation or the DM chat itself, and passes one naming another chat", async () => {
  for (const [conversation, refusedLetter] of [
    [undefined, true],
    [{ channelId: "7" }, true],
    [{ channelId: "group-9" }, false],
  ] as const) {
    const ingested: Ingested[] = [];
    const results: { readonly isError?: boolean | undefined }[] = [];
    const resident = residentRunner({
      model: { provider: "fake", id: "resident-test" },
      apiKey: "test-key",
      tools: { messages: capturingPort(ingested) },
      sessionRuntime: { clock: () => 10 },
      llm: replyingLlm("done", { contact: "person:owner", message: "elsewhere", ...(conversation === undefined ? {} : { conversation }) }, (result) => results.push(result)),
    });
    await deliverExternal(resident, `reply-origin-dm-${conversation?.channelId ?? "none"}`, {
      ...telegramOwner,
      conversation: { channelId: "7", messageId: telegramOwner.messageId, dm: true },
    }, "ping");
    expect(results.map((result) => result.isError === true)).toEqual([refusedLetter]);
    expect(ingested.map((item) => item.to.kind)).toEqual(refusedLetter ? ["origin"] : ["actor", "origin"]);
  }
});

test("a send_message letter to the same person in another conversation, channel or a reaction passes, and the reply still goes", async () => {
  for (const [name, send] of [
    ["another chat", { contact: "person:owner", message: "elsewhere", surface: "telegram", conversation: { channelId: "group-9" } }],
    ["another channel", { contact: "person:owner", message: "elsewhere", surface: "slack" }],
    ["a reaction", { contact: "person:owner", react: "👍", surface: "telegram", conversation: { channelId: "7", replyToMessageId: PROMPT_ID } }],
  ] as const) {
    const ingested: Ingested[] = [];
    const results: { readonly isError?: boolean | undefined }[] = [];
    const resident = residentRunner({
      model: { provider: "fake", id: "resident-test" },
      apiKey: "test-key",
      tools: { messages: capturingPort(ingested) },
      sessionRuntime: { clock: () => 10 },
      llm: replyingLlm("done", send, (result) => results.push(result)),
    });
    await deliverExternal(resident, `reply-origin-other-${name.replace(" ", "-")}`, ackOrigin, "send a test");
    expect(results.map((result) => result.isError === true)).toEqual([false]);
    expect(ingested.map((item) => item.to.kind)).toEqual(["actor", "origin"]);
  }
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
