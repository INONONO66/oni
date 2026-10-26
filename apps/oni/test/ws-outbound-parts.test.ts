import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { Gateway, Message, Outbound, Tool } from "@oni/protocol";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";
import { declarePerson } from "./helpers/declared-channel";
import { eventSignal } from "./helpers/event-signal";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextFrame } from "./helpers/ws";

const suite = residentSuite();

test("a socket image reaches the model and an outbound file stays a media frame", async () => {
  const config = suite.config("ws-media-roundtrip-", { wsToken: "token" });
  declarePerson(config.catalogPath, {
    id: "person:owner", displayName: "Owner", kind: "human", trustTier: "owner",
    endpoints: [{ channel: "ws", externalId: "owner" }],
  });
  const image: Gateway.MediaPart = { kind: "image", ref: "self:/inbox/question.png", mime: "image/png" };
  const file = { kind: "file", ref: "self:/inbox/report.pdf", name: "report.pdf", mime: "application/pdf" } as const;
  const spec: Outbound.Spec = {
    root: "body",
    elements: {
      body: { type: "Stack", props: {}, children: ["intro", "file", "outro"] },
      intro: { type: "Markdown", props: { text: "Here is the report" }, children: [] },
      file: { type: "File", props: { ref: file.ref, name: file.name, mime: file.mime }, children: [] },
      outro: { type: "Markdown", props: { text: "Please review it" }, children: [] },
    },
  };
  const entered = eventSignal<Message.WithParts>("socket image delivered to model");
  const delivered = eventSignal<Tool.Result>("outbound tool result");
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        const user = input.messages.find((message) => message.info.role === "user");
        if (user !== undefined) entered.resolve(user);
        const result = requestToolStep(input, sink, {
          id: "media-report", tool: "send_message",
          input: { to: { kind: "contact", id: "person:owner" }, message: spec },
        });
        if (result === undefined) return { type: "stop" as const };
        delivered.resolve(result);
        sink.onMessage(assistantMessage(input, { text: "Sent" }));
        return { type: "stop" as const };
      }),
    },
  });
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, ["auth", "token"]);
  const outbound = nextFrame(ws, (frame) => frame.type === "message");
  ws.send(JSON.stringify({ text: "What is in this image?", eventId: "image-question", parts: [image] }));

  const user = await entered.promise;
  expect(user.parts).toContainEqual(expect.objectContaining({
    type: "file", kind: "image", ref: image.ref,
  }));
  expect((await delivered.promise).isError).not.toBe(true);
  expect(await outbound).toMatchObject({
    type: "message", text: "Here is the report\n\nPlease review it", parts: [file],
  });
});

test("a mixed outbound letter renders code as text and sends only its image as media", async () => {
  const config = suite.config("ws-code-media-", { wsToken: "token" });
  declarePerson(config.catalogPath, {
    id: "person:owner", displayName: "Owner", kind: "human", trustTier: "owner",
    endpoints: [{ channel: "ws", externalId: "owner" }],
  });
  const image = { kind: "image", ref: "self:/inbox/result.png" } as const;
  const spec: Outbound.Spec = {
    root: "body",
    elements: {
      body: { type: "Stack", props: {}, children: ["intro", "code", "image"] },
      intro: { type: "Markdown", props: { text: "Run this" }, children: [] },
      code: { type: "Code", props: { text: "ls", lang: "sh" }, children: [] },
      image: { type: "Image", props: { ref: image.ref }, children: [] },
    },
  };
  const delivered = eventSignal<Tool.Result>("mixed outbound tool result");
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        const result = requestToolStep(input, sink, {
          id: "mixed-report", tool: "send_message",
          input: { to: { kind: "contact", id: "person:owner" }, message: spec },
        });
        if (result === undefined) return { type: "stop" as const };
        delivered.resolve(result);
        sink.onMessage(assistantMessage(input, { text: "Sent" }));
        return { type: "stop" as const };
      }),
    },
  });
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, ["auth", "token"]);
  const outbound = nextFrame(ws, (frame) => frame.type === "message");
  ws.send(JSON.stringify({ text: "Send the result", eventId: "mixed-request" }));

  expect((await delivered.promise).isError).not.toBe(true);
  expect(await outbound).toMatchObject({
    type: "message", text: "Run this\n\n```sh\nls\n```", parts: [image],
  });
});
