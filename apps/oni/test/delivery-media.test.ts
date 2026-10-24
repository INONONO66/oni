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
const gone: Gateway.MediaPart = { kind: "image", ref: "mac:/inbox/gone.png", mime: "image/png" };
const bytes: PartBytes = () => Effect.die(new Error("the host must not resolve bytes"));

function user(id: string): Message.WithParts {
  return {
    info: { id, sessionID: "s", role: "user", time: { created: 1 }, agent: "resident", model: { providerID: "p", modelID: "m" } },
    parts: [],
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

test("the registry ignores absent parts and evicts by latest remember at its cap", () => {
  const media = deliveryMedia(2);
  media.remember("d1", [png]);
  media.remember("empty", []);
  media.remember("absent", undefined);
  media.remember("d2", [gone]);
  media.remember("d3", [png, gone]);
  expect([media.recall("d1"), media.recall("empty"), media.recall("absent"), media.recall("d2"), media.recall("d3")])
    .toEqual([undefined, undefined, undefined, [gone], [png, gone]]);
  media.remember("d2", [png]);
  media.remember("d4", [gone]);
  expect([media.recall("d2"), media.recall("d3"), media.recall("d4")]).toEqual([[png], undefined, [gone]]);
});

test("the default registry retains at most 256 deliveries", () => {
  const media = deliveryMedia();
  for (let i = 0; i <= 256; i += 1) media.remember(String(i), [png]);
  expect(media.recall("0")).toBeUndefined();
  expect(media.recall("1")).toEqual([png]);
  expect(media.recall("256")).toEqual([png]);
});

test("the host forwards raw parts by user id even for a requested text model", async () => {
  const h = harness();
  h.media.bind(bytes);
  h.media.remember("u1", [png]);
  h.media.remember("u2", [gone]);
  h.media.remember("a1", [gone]);
  h.media.remember("missing", [gone]);
  const input = h.call([user("u1"), assistant, user("unregistered"), user("u2")]);
  await h.run(input);
  expect(h.calls).toEqual([[{
    ...input, media: { parts: [{ messageId: "u1", parts: [png] }, { messageId: "u2", parts: [gone] }], bytes },
  }, h.sink, h.dependencies]]);
  expect(input.media).toBeUndefined();
  expect(h.llm.resolveModel).toBe(h.service.resolveModel);
  expect(h.llm.classifyFailure).toBe(h.service.classifyFailure);
});

test("without registered user parts the delegate receives the original input", async () => {
  const h = harness();
  h.media.bind(bytes);
  h.media.remember("a1", [png]);
  const input = h.call([assistant, user("missing")]);
  await h.run(input);
  expect(h.calls[0]?.[0]).toBe(input);
});

test("late binding and rebinding select the current byte source without resolving it", async () => {
  const h = harness();
  h.media.remember("u1", [png]);
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

test("media is recalled when the delegate effect executes", async () => {
  const h = harness();
  const pending = h.llm.run(h.call([user("u1")]), h.sink);
  h.media.remember("u1", [png]);
  h.media.bind(bytes);
  await runEffect(pending);
  expect(h.calls[0]?.[0].media).toEqual({ parts: [{ messageId: "u1", parts: [png] }], bytes });
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
  socket.send(JSON.stringify({ text: "inspect video", eventId: "raw-video", parts: [part] }));
  const message = await entered.promise;
  expect(message.parts.flatMap((entry) => entry.type === "text" ? [entry.text] : [])).toEqual([
    `[attached: video 1s \u2192 ${part.ref}]\n\ninspect video`,
  ]);
  expect(media.recall(message.info.id)).toEqual([part]);
  expect(await runEffect(derive(part, { input: ["text"] }))).toEqual({ text: "[video 1s, 0 frames]", parts: [] });
  const warning = eventSignal<ReturnType<typeof Operational.Events.Warn.schema.parse>>("derivative warning");
  suite.defer(Bus.subscribe(Operational.Events.Warn, (event) => {
    if (event.context?.ref === `self:${inbox}/missing.wav`) warning.resolve(event);
  }));
  expect(await runEffect(derive({ kind: "audio", ref: `self:${inbox}/missing.wav` }, { input: ["text"] }))).toEqual({ parts: [] });
  expect((await warning.promise).context?.code).toBe("transcript_failed");
});
