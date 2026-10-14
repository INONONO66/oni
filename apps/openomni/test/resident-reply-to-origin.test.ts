import { Effect } from "effect";
import { expect, test } from "bun:test";
import type { Core } from "@openomni/agent";
type RunInput = Core.RunInput;
type Sink = Core.LlmSink;
import type { Gateway } from "@openomni/protocol";
import type { MessagePort } from "../src/bundles/messaging/send-message/index";
import { residentRunner } from "./helpers/resident-runner";
import { requestToolStep, assistantMessage } from "./helpers/assistant-message";
import { localDelivery } from "./helpers/ledger";
import { runEffect } from "./helpers/effect";

interface Ingested {
  readonly sender: Gateway.IngestSender;
  readonly to: Gateway.SendMessage["to"];
  readonly content: string;
}

function capturingPort(ingested: Ingested[]): MessagePort {
  return {
    ingest: async (sender, message) => {
      const send = message as Gateway.SendMessage;
      ingested.push({ sender, to: send.to, content: send.content });
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

async function deliverExternal(
  resident: ReturnType<typeof residentRunner>,
  sessionId: string,
  origin: Record<string, string>,
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
    { sender: { kind: "session", id: "reply-origin-telegram" }, to: { kind: "actor", actorId: "person:owner" }, content: "pong" },
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
  expect(ingested.map((item) => item.content)).toEqual(["테스트 OK"]);
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
