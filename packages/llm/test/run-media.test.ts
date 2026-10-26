import { describe, expect, test } from "bun:test";
import { Delivery, type Gateway, type Message } from "@oni/protocol";
import { Effect } from "effect";
import type { Capability } from "../src";
import { assistantMessage } from "./helpers/fixtures";
import { useStreamCapture } from "./helpers/stream-capture";

const image: Gateway.MediaPart = { kind: "image", ref: "mac:/image", mime: "image/png" };
const pixels = new Uint8Array([137, 80, 78, 71]);
const block = { type: "image", image: pixels, mediaType: "image/png" } as const;
const model = { id: "vision", providerID: "openai", name: "vision", input: ["text", "image"] as const };
const vision = { ...model, input: [...model.input] };

function file(id: string, media: Gateway.MediaPart): Message.FilePart {
  return { type: "file", id: `${id}-${media.ref}`, messageID: id, sessionID: "s", ...media };
}

function user(id: string, text: string, media: readonly Gateway.MediaPart[] = []): Message.WithParts {
  return {
    info: { id, sessionID: "s", role: "user", time: { created: 1 }, agent: "test", model: { providerID: "openai", modelID: "vision" } },
    parts: [
      ...(text === "" ? [] : [{ type: "text" as const, id: `${id}-text`, messageID: id, sessionID: "s", text }]),
      ...media.map((part) => file(id, part)),
    ],
  };
}

const assistant: Message.WithParts = {
  info: assistantMessage("a1", "s"),
  parts: [{ type: "text", id: "a1-text", messageID: "a1", sessionID: "s", text: "answer" }],
};
const continuation: Message.WithParts = {
  info: assistantMessage("tool", "s"),
  parts: [{
    type: "tool", id: "tool-part", messageID: "tool", sessionID: "s", callID: "call", tool: "read",
    state: { status: "completed", input: {}, output: "result", title: "read", metadata: {}, time: { start: 1, end: 2 } },
  }],
};

describe("per-message input media", () => {
  const capture = useStreamCapture();
  const media = () => ({
    bytes: () => Effect.succeed({ bytes: pixels, mime: "image/png" }),
  });
  const transcribed = (text: string) => capture.run({
    model: vision, messages: [user("u1", "listen", [{ kind: "audio", ref: "voice" }])],
    media: {
      bytes: () => Effect.die(new Error("audio must derive before byte lookup")),
      derive: () => Effect.succeed({ text, parts: [] }),
    },
  });

  test("file without a media port becomes delivery placeholder text", async () => {
    await capture.run({ model: vision, messages: [user("u1", "first", [image])] });
    expect(capture.args.messages).toEqual([{
      role: "user",
      content: [{ type: "text", text: "first" }, { type: "text", text: Delivery.text([image]) }],
    }]);
    expect(capture.events.named("operational.warn")).toEqual([]);
  });

  test("unaccepted modality without derive becomes delivery placeholder text", async () => {
    const audio = { kind: "audio", ref: "voice", mime: "audio/ogg" } as const;
    await capture.run({
      model: vision, messages: [user("u1", "", [audio])],
      media: { bytes: () => Effect.die(new Error("modality must be rejected before byte lookup")) },
    });
    expect(capture.args.messages).toEqual([{
      role: "user", content: [{ type: "text", text: Delivery.text([audio]) }],
    }]);
    expect(capture.events.named("operational.warn")).toEqual([]);
  });

  test("user text and image render as text then image blocks", async () => {
    await capture.run({ model: vision, messages: [user("u1", "first", [image])], media: media() });
    expect(capture.args.messages).toEqual([{
      role: "user", content: [{ type: "text", text: "first" }, block],
    }]);
  });

  test("text before and after an image stays on opposite sides of its bytes", async () => {
    const message = user("u1", "BEFORE", [image]);
    await capture.run({
      model: vision,
      messages: [{ ...message, parts: [...message.parts, { type: "text", id: "after", messageID: "u1", sessionID: "s", text: "AFTER" }] }],
      media: media(),
    });
    expect(capture.args.messages).toEqual([{
      role: "user", content: [{ type: "text", text: "BEFORE" }, block, { type: "text", text: "AFTER" }],
    }]);
  });

  test("missing image stays before the readable image", async () => {
    const missing = { kind: "image", ref: "mac:/missing", mime: "image/png" } as const;
    await capture.run({
      model: vision, messages: [user("u1", "", [missing, image])],
      media: { bytes: (ref) => ref === image.ref
        ? Effect.succeed({ bytes: pixels, mime: "image/png" })
        : Effect.fail(new Error("missing bytes")) },
    });
    expect(capture.args.messages).toEqual([{
      role: "user", content: [{ type: "text", text: Delivery.text([missing]) }, block],
    }]);
  });

  test.each(["", "   "])("empty derivation text %j leaves a file-only placeholder", async (text) => {
    const report = { kind: "file", ref: "mac:/report.pdf", name: "report.pdf", mime: "application/pdf" } as const;
    await capture.run({
      model: vision, messages: [user("u1", "", [report])],
      media: {
        bytes: () => Effect.die(new Error("unsupported file must not read bytes")),
        derive: () => Effect.succeed({ parts: [], text }),
      },
    });
    expect(capture.args.messages).toEqual([{
      role: "user", content: [{ type: "text", text: Delivery.text([report]) }],
    }]);
  });

  test("derived replacement occupies its source position without a duplicate placeholder", async () => {
    const source = { kind: "audio", ref: "mac:/voice", mime: "audio/wav" } as const;
    const message = user("u1", "BEFORE", [source]);
    await capture.run({
      model: vision,
      messages: [{ ...message, parts: [...message.parts, { type: "text", id: "after", messageID: "u1", sessionID: "s", text: "AFTER" }] }],
      media: { ...media(), derive: () => Effect.succeed({ parts: [image] }) },
    });
    expect(capture.args.messages).toEqual([{
      role: "user", content: [{ type: "text", text: "BEFORE" }, block, { type: "text", text: "AFTER" }],
    }]);
  });

  test("historical images stay on u1 rather than the last user", async () => {
    const messages = [user("u1", "first", [image]), assistant, user("u2", "second")];
    await capture.run({ model: vision, messages, media: media() });
    expect(capture.args.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "first" }, block] },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ]);
    expect(messages[0]?.parts).toHaveLength(2);
  });

  test("an assistant tail never creates a synthetic user", async () => {
    await capture.run({ model: vision, messages: [user("u1", "first", [image]), assistant], media: media() });
    expect(capture.args.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "first" }, block] },
      { role: "assistant", content: "answer" },
    ]);
  });

  test("file part on an assistant message is ignored", async () => {
    let reads = 0;
    await capture.run({
      model: vision, messages: [{ ...continuation, parts: [...continuation.parts, file("tool", image)] }],
      media: { bytes: () => Effect.sync(() => { reads += 1; return { bytes: pixels, mime: "image/png" }; }) },
    });
    expect(capture.args.messages).toEqual([
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call", toolName: "read", input: {}, providerExecuted: false }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call", toolName: "read", output: { type: "text", value: "result" } }] },
    ]);
    expect(reads).toBe(0);
  });

  test("unresolved derived replacement becomes a placeholder and warns", async () => {
    const audio = { kind: "audio", ref: "voice" } as const;
    await capture.run({
      model: vision, messages: [user("u1", "", [audio])],
      media: {
        bytes: () => Effect.fail(new Error("missing frame")),
        derive: () => Effect.succeed({ parts: [image] }),
      },
    });
    expect(capture.args.messages).toEqual([{
      role: "user", content: [{ type: "text", text: Delivery.text([image]) }],
    }]);
    expect(capture.events.named("operational.warn")).toMatchObject([{
      component: "llm.media", context: { ref: image.ref, kind: "image", err: "Error: missing frame" },
    }]);
  });

  test("an existing empty user carries image-only content before cache normalization", async () => {
    await capture.run({
      model: { ...vision, id: "claude-vision", api: { npm: "@ai-sdk/anthropic" } },
      messages: [user("u1", "", [image])], media: media(),
    });
    expect(capture.args.messages).toEqual([{
      role: "user", content: [block],
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
    }]);
  });

  test("unresolved parts warn once while modality misses stay silent", async () => {
    await capture.run({
      model: vision, messages: [user("u1", "first", [image, { kind: "audio", ref: "voice", mime: "audio/ogg" }])],
      media: { bytes: () => Effect.fail(new Error("missing bytes")) },
    });
    expect(capture.events.named("operational.warn")).toEqual([{
      traceId: "trace-stream-capture", sessionId: "session-stream-capture", time: 1_735_689_600_000,
      component: "llm.media", msg: "input part unresolved",
      context: { ref: image.ref, kind: "image", err: "Error: missing bytes" },
    }]);
    expect(capture.args.messages).toEqual([{ role: "user", content: [
      { type: "text", text: "first" },
      { type: "text", text: Delivery.text([image]) },
      { type: "text", text: Delivery.text([{ kind: "audio", ref: "voice", mime: "audio/ogg" }]) },
    ] }]);
  });

  test("derived text stays at its source position and survives normalization", async () => {
    await capture.run({
      model: { ...vision, id: "claude-vision", api: { npm: "@ai-sdk/anthropic" } },
      messages: [user("u1", "first", [{ kind: "audio", ref: "voice" }, image]), assistant, user("u2", "second")],
      media: {
        ...media(),
        derive: () => Effect.succeed({ text: "transcript", parts: [] }),
      },
    });
    expect(capture.args.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "first" }, { type: "text", text: "transcript" }, block] },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second", providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } } },
    ]);
  });

  test("input abort cancels pending media bytes and releases their source", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const pending = capture.run({
      model: vision, messages: [user("u1", "first", [image])], signal: controller.signal,
      media: {
        bytes: () => Effect.callback(() => {
          started.resolve();
          return Effect.sync(() => released.resolve());
        }),
      },
    });
    await started.promise;
    controller.abort();
    const outcome = await pending;
    await released.promise;
    expect(outcome.type).toBe("aborted");
  });

  test("estimated usage counts derived transcript text when provider usage is missing", async () => {
    capture.stream([{ type: "finish-step", finishReason: "stop" }]);
    const plain = await capture.run({ model: vision, messages: [user("u1", "listen")] });
    const transcript = "TRANSCRIPT_WORD ".repeat(2000);
    const derived = await transcribed(transcript);
    expect(plain.type).toBe("stop");
    expect(derived.type).toBe("stop");
    if (plain.type !== "stop" || derived.type !== "stop") return;
    expect(derived.evidence?.usageProvenance).toBe("estimated");
    expect(derived.evidence?.usage.inputTokens).toBe((plain.evidence?.usage.inputTokens ?? 0) + transcript.length / 4);
    expect(capture.args.messages).toEqual([{ role: "user", content: [
      { type: "text", text: "listen" }, { type: "text", text: transcript },
    ] }]);
  });

  test("reported usage wins over derived transcript estimation", async () => {
    capture.stream([{ type: "finish-step", finishReason: "stop", usage: { inputTokens: 7, outputTokens: 3 } }]);
    const outcome = await transcribed("TRANSCRIPT_WORD ".repeat(2000));
    expect(outcome.type).toBe("stop");
    if (outcome.type !== "stop") return;
    expect(outcome.evidence?.usageProvenance).toBe("reported");
    expect(outcome.evidence?.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  });

  test.each([
    { style: "responses", proxy: false, native: false },
    { style: undefined, proxy: false, native: false },
    { style: "responses", proxy: true, native: true },
    { style: undefined, proxy: true, native: true },
    { style: "chat", proxy: false, native: true },
  ] as const)("run projects $style proxy=$proxy before deriving WAV", async ({ style, proxy, native }) => {
    const models: Capability.InputModel[] = [];
    await capture.run({
      model: { ...vision, input: ["text", "audio"], api: { npm: "@ai-sdk/openai", style } },
      auth: proxy ? { type: "proxy", baseURL: "https://proxy.invalid/v1" } : { type: "api", key: "test" },
      messages: [user("u1", "listen", [{ kind: "audio", ref: "voice", mime: "audio/wav" }])],
      media: {
        bytes: () => Effect.succeed({ bytes: pixels, mime: "audio/wav" }),
        derive: (_part, candidate) => Effect.sync(() => {
          models.push(candidate);
          return { text: "transcript", parts: [] };
        }),
      },
    });
    expect(models.map((candidate) => candidate.api?.style)).toEqual(native ? [] : ["responses"]);
    expect(capture.args.messages).toEqual([{
      role: "user", content: [
        { type: "text", text: "listen" },
        native ? { type: "file", data: pixels, mediaType: "audio/wav" } : { type: "text", text: "transcript" },
      ],
    }]);
  });
});
