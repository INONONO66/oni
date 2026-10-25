import { describe, expect, test } from "bun:test";
import type { Gateway, Message } from "@oni/protocol";
import { Effect } from "effect";
import type { Capability } from "../src";
import { assistantMessage } from "./helpers/fixtures";
import { useStreamCapture } from "./helpers/stream-capture";

const image: Gateway.MediaPart = { kind: "image", ref: "mac:/image", mime: "image/png" };
const pixels = new Uint8Array([137, 80, 78, 71]);
const block = { type: "image", image: pixels, mediaType: "image/png" } as const;
const model = { id: "vision", providerID: "openai", name: "vision", input: ["text", "image"] as const };
const vision = { ...model, input: [...model.input] };

function user(id: string, text: string): Message.WithParts {
  return {
    info: { id, sessionID: "s", role: "user", time: { created: 1 }, agent: "test", model: { providerID: "openai", modelID: "vision" } },
    parts: text === "" ? [] : [{ type: "text", id: `${id}-text`, messageID: id, sessionID: "s", text }],
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
  const media = (messageId: string) => ({
    parts: [{ messageId, parts: [image] }],
    bytes: () => Effect.succeed({ bytes: pixels, mime: "image/png" }),
  });
  const transcribed = (text: string) => capture.run({
    model: vision, messages: [user("u1", "listen")],
    media: {
      parts: [{ messageId: "u1", parts: [{ kind: "audio", ref: "voice" }] }],
      bytes: () => Effect.die(new Error("audio must derive before byte lookup")),
      derive: () => Effect.succeed({ text, parts: [] }),
    },
  });

  test("historical images stay on u1 rather than the last user", async () => {
    const messages = [user("u1", "first"), assistant, user("u2", "second")];
    await capture.run({ model: vision, messages, media: media("u1") });
    expect(capture.args.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "first" }, block] },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ]);
    expect(messages[0]?.parts).toHaveLength(1);
  });

  test("an assistant tail never creates a synthetic user", async () => {
    await capture.run({ model: vision, messages: [user("u1", "first"), assistant], media: media("u1") });
    expect(capture.args.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "first" }, block] },
      { role: "assistant", content: "answer" },
    ]);
  });

  test("tool continuation without a matching user does not resolve or relocate media", async () => {
    let reads = 0;
    await capture.run({
      model: vision, messages: [continuation],
      media: { parts: [{ messageId: "tool", parts: [image] }, { messageId: "missing", parts: [image] }],
        bytes: () => Effect.sync(() => { reads += 1; return { bytes: pixels, mime: "image/png" }; }) },
    });
    expect(capture.args.messages).toEqual([
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call", toolName: "read", input: {}, providerExecuted: false }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call", toolName: "read", output: { type: "text", value: "result" } }] },
    ]);
    expect(reads).toBe(0);
  });

  test("an existing empty user carries image-only content before cache normalization", async () => {
    await capture.run({
      model: { ...vision, id: "claude-vision", api: { npm: "@ai-sdk/anthropic" } },
      messages: [user("u1", "")], media: media("u1"),
    });
    expect(capture.args.messages).toEqual([{
      role: "user", content: [block],
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
    }]);
  });

  test("unresolved parts warn once while modality misses stay silent", async () => {
    await capture.run({
      model: vision, messages: [user("u1", "first")],
      media: { parts: [{ messageId: "u1", parts: [image, { kind: "audio", ref: "voice", mime: "audio/ogg" }] }],
        bytes: () => Effect.fail(new Error("missing bytes")) },
    });
    expect(capture.events.named("operational.warn")).toEqual([{
      traceId: "trace-stream-capture", sessionId: "session-stream-capture", time: 1_735_689_600_000,
      component: "llm.media", msg: "input part unresolved",
      context: { ref: image.ref, kind: "image", err: "Error: missing bytes" },
    }]);
    expect(capture.args.messages).toEqual([{ role: "user", content: "first" }]);
  });

  test("derived text stays with its user after images and survives normalization", async () => {
    await capture.run({
      model: { ...vision, id: "claude-vision", api: { npm: "@ai-sdk/anthropic" } },
      messages: [user("u1", "first"), assistant, user("u2", "second")],
      media: {
        ...media("u1"),
        parts: [{ messageId: "u1", parts: [{ kind: "audio", ref: "voice" }, image] }],
        derive: () => Effect.succeed({ text: "transcript", parts: [] }),
      },
    });
    expect(capture.args.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "first" }, block, { type: "text", text: "transcript" }] },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second", providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } } },
    ]);
  });

  test("input abort cancels pending media bytes and releases their source", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const pending = capture.run({
      model: vision, messages: [user("u1", "first")], signal: controller.signal,
      media: {
        parts: [{ messageId: "u1", parts: [image] }],
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
      messages: [user("u1", "listen")],
      media: {
        parts: [{ messageId: "u1", parts: [{ kind: "audio", ref: "voice", mime: "audio/wav" }] }],
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
