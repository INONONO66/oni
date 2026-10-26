import { expect, test } from "bun:test";
import { classifyFailure, type LlmService, type PartBytes, type PartDerive } from "@oni/llm";
import { type Gateway, type Message, Operational } from "@oni/protocol";
import { Effect } from "effect";
import { deliveryMedia, mediaLlm } from "../src/composition/delivery-media";
import { DeliveryMediaRegistry } from "../src/runtime";
import { Bus } from "./helpers/bus";
import { runEffect, runRuntimeEffect } from "./helpers/effect";
import { eventSignal } from "./helpers/event-signal";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";

const suite = residentSuite();

type RunInput = Parameters<LlmService["run"]>[0];
const png: Gateway.MediaPart = { kind: "image", ref: "mac:/inbox/a.png", mime: "image/png" };
const bytes: PartBytes = () => Effect.die(new Error("the host must not resolve bytes"));

function user(id: string): Message.WithParts {
  return {
    info: { id, sessionID: "s", role: "user", time: { created: 1 }, agent: "resident", model: { providerID: "p", modelID: "m" } },
    parts: [{ type: "file", id: `${id}-file`, messageID: id, sessionID: "s", ...png }],
  };
}
const assistant: Message.WithParts = {
  info: {
    id: "a1", sessionID: "s", role: "assistant", time: { created: 1 }, parentID: "u1",
    modelID: "m", providerID: "p", agent: "resident",
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  parts: [],
};

function harness() {
  const calls: Parameters<LlmService["run"]>[] = [];
  const service: LlmService = {
    resolveModel: () => Effect.die(new Error("not under test")),
    run: (...args) => Effect.sync(() => {
      calls.push(args);
      return { type: "stop" as const };
    }),
    classifyFailure,
  };
  const media = deliveryMedia();
  const llm = mediaLlm(service, media);
  const call = (messages: Message.WithParts[]): RunInput => ({
    messages, tools: [], model: { id: "m", providerID: "p", name: "m", input: ["text"] },
    now: () => 7, id: () => "id", trace: { traceId: "t", sessionId: "s", runId: "r" },
    events: { publish: () => { throw new Error("the host must not publish media warnings"); } },
  });
  const sink = { onMessage: () => undefined, onToolCall: () => undefined, onToolResult: () => undefined };
  const dependencies = {};
  const run = (input: RunInput) => runEffect(llm.run(input, sink, dependencies));
  return { media, calls, call, run, llm, service, sink, dependencies };
}

test("the host binds bytes for replayed file parts without resolving them", async () => {
  const h = harness();
  h.media.bind(bytes);
  const input = h.call([user("u1"), assistant, user("unregistered"), user("u2")]);
  await h.run(input);
  expect(h.calls).toEqual([[{
    ...input, media: { bytes },
  }, h.sink, h.dependencies]]);
  expect(input.media).toBeUndefined();
  expect(h.llm.resolveModel).toBe(h.service.resolveModel);
  expect(h.llm.classifyFailure).toBe(h.service.classifyFailure);
});

test("a bound source reaches the delegate even without file parts", async () => {
  const h = harness();
  h.media.bind(bytes);
  const input = h.call([assistant]);
  await h.run(input);
  expect(h.calls[0]?.[0].media).toEqual({ bytes });
});

test("late binding and rebinding select the current byte source without resolving it", async () => {
  const h = harness();
  const input = h.call([user("u1")]);
  await h.run(input);
  expect(h.calls[0]?.[0]).toBe(input);
  const derive: PartDerive = () => Effect.die(new Error("derivation belongs to the selected candidate"));
  h.media.bind(bytes, derive);
  await h.run(input);
  expect(h.calls[1]?.[0].media?.bytes).toBe(bytes);
  expect(h.calls[1]?.[0].media?.derive).toBe(derive);
  const replacement: PartBytes = () => Effect.die(new Error("still not resolved by the host"));
  h.media.bind(replacement);
  await h.run(input);
  expect(h.calls[2]?.[0].media?.bytes).toBe(replacement);
  expect(h.calls[2]?.[0].media?.derive).toBeUndefined();
});

test("the current byte source is read when the delegate effect executes", async () => {
  const h = harness();
  const pending = h.llm.run(h.call([user("u1")]), h.sink);
  h.media.bind(bytes);
  await runEffect(pending);
  expect(h.calls[0]?.[0].media).toEqual({ bytes });
});

test("boot binds derivation while ingress preserves raw video for the selected candidate", async () => {
  const config = suite.config("media-bind-");
  const machines = config.machines;
  const inbox = machines?.self.exports[0]?.path;
  if (machines === undefined || inbox === undefined) throw new Error("fixture inbox missing");
  const entered = eventSignal<Message.WithParts>("raw user delivered");
  const app = await suite.boot({
    config: { ...config, machines: { ...machines, inbox } },
    llm: {
      resolveModel: fakeProviderModel,
      run: (input) => Effect.sync(() => {
        const message = input.messages.find((entry) => entry.info.role === "user");
        if (message !== undefined) entered.resolve(message);
        return { type: "stop" as const };
      }),
    },
  });
  const media = await runRuntimeEffect(app.runtime, DeliveryMediaRegistry);
  const bytes = media.bytes();
  const derive = media.derive();
  if (bytes === undefined || derive === undefined) throw new Error("boot did not bind media ports");
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, []);
  const part: Gateway.MediaPart = { kind: "video", ref: `self:${inbox}/clip.mp4`, durationMs: 1000 };
  const inputText = "INPUT_TEXT_SENTINEL_RAW_VIDEO";
  socket.send(JSON.stringify({ text: inputText, eventId: "raw-video", parts: [part] }));
  const message = await entered.promise;
  const deliveredText = message.parts.flatMap((entry) => entry.type === "text" ? [entry.text] : []).join("\n");
  expect(deliveredText.split(inputText)).toHaveLength(2);
  expect(deliveredText.split(part.ref)).toHaveLength(2);
  expect(message.parts.some((entry) => entry.type === "file" && entry.ref === part.ref)).toBe(true);
  expect(await runEffect(derive(part, { input: ["text"] }))).toEqual({ text: "[video 1s, 0 frames]", parts: [] });
  const warning = eventSignal<ReturnType<typeof Operational.Events.Warn.schema.parse>>("derivative warning");
  suite.defer(Bus.subscribe(Operational.Events.Warn, (event) => {
    if (event.context?.ref === `self:${inbox}/missing.wav`) warning.resolve(event);
  }));
  expect(await runEffect(derive({ kind: "audio", ref: `self:${inbox}/missing.wav` }, { input: ["text"] }))).toEqual({ parts: [] });
  expect((await warning.promise).context?.code).toBe("transcript_failed");
});
