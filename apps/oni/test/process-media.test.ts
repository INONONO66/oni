import { expect, test } from "bun:test";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { type Gateway, Operational } from "@oni/protocol";
import { Core } from "@oni/agent";
import { z } from "zod";
import { deliveryMedia } from "../src/composition/delivery-media";
import { createProcessSessionTransport } from "../src/composition/process-session";
import { messageFixture } from "./helpers/message-fixture";
import { appRuntime, closeAcquiredEffects, runRuntimeEffect } from "./helpers/effect";
import { boundToolHolder } from "./helpers/tool-ports";
import { bounded } from "./helpers/protected-dispatch";
import { contentBlocks, messageStart, messageEnd, sseResponse } from "./helpers/anthropic-sse";
import { DeliveryMediaRegistry } from "../src/runtime";

const IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1sAAAAASUVORK5CYII=";
const REF = "mac:/inbox/image.png";
const ImageBlock = z.object({
  type: z.literal("image"),
  source: z.object({ type: z.literal("base64"), media_type: z.literal("image/png"), data: z.string() }),
});
const ProviderBody = z.object({ messages: z.array(z.object({
  role: z.string(),
  content: z.array(z.union([ImageBlock, z.object({ type: z.literal("text"), text: z.string() })])),
})) });

function response(): Response {
  return sseResponse([
    messageStart(crypto.randomUUID(), "claude-opus-4-5", 4),
    ...contentBlocks([{ start: { type: "text", text: "" }, delta: { type: "text_delta", text: "MEDIA_RECEIVED" } }]),
    ...messageEnd("end_turn", 2),
  ]);
}

test.each(["bound", "empty", "failed"] as const)("the runtime loads only new history IDs with %s metadata", async (mode) => {
  const captures: z.infer<typeof ProviderBody>[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      captures.push(ProviderBody.parse(await request.json()));
      return response();
    },
  });
  const loads: string[][] = [];
  const warnings: z.infer<typeof Operational.Events.Warn.schema>[] = [];
  const runtime = appRuntime({
    composed: boundToolHolder(),
    media: {
      bytes: () => Effect.succeed({ bytes: Buffer.from(IMAGE, "base64"), mime: "image/png" }),
      derive: () => Effect.succeed({ parts: [] }),
      load: (registry, ids) => Effect.suspend(() => {
        loads.push([...ids]);
        if (mode === "failed") return Effect.fail(new Error("metadata unavailable"));
        if (mode === "bound") for (const id of ids) registry.remember(id, [{ kind: "image", ref: REF }]);
        return Effect.void;
      }),
    },
  });
  try {
    const llm = await runRuntimeEffect(runtime, Core.Llm);
    const model = await runRuntimeEffect(runtime, llm.resolveModel({ provider: "anthropic", id: "claude-opus-4-5" }, () => 100));
    const input: Parameters<typeof llm.run>[0] = {
      model,
      auth: { type: "api", key: "fixture-key" },
      transport: { baseUrl: `http://127.0.0.1:${provider.port}/v1` },
      messages: [],
      tools: [], now: () => 100, id: () => crypto.randomUUID(),
      trace: { traceId: "trace", sessionId: "session", runId: "run" },
      events: { publish: (event, data) => {
        if (event.name === Operational.Events.Warn.name) warnings.push(Operational.Events.Warn.schema.parse(data));
      } },
    };
    const sink = { onMessage: () => undefined, onToolCall: () => undefined, onToolResult: () => undefined };
    for (const id of ["first", "arrived-during-turn"]) {
      input.messages.push({
        info: {
          role: "user", id, sessionID: "session", agent: "resident", time: { created: 100 },
          model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
        },
        parts: [{ type: "text", id: `${id}-text`, messageID: id, sessionID: "session", text: id }],
      });
      await runRuntimeEffect(runtime, llm.run(input, sink));
    }
    expect(loads).toEqual([["first"], ["arrived-during-turn"]]);
    expect(captures.map((body) => body.messages.flatMap((message) =>
      message.content.filter((block) => block.type === "image")).length)).toEqual(mode === "bound" ? [1, 2] : [0, 0]);
    expect(warnings.map((warning) => warning.context)).toEqual(mode === "failed" ? [
      { messageId: "first", err: "Error: metadata unavailable" },
      { messageId: "arrived-during-turn", err: "Error: metadata unavailable" },
    ] : []);
  } finally {
    await runtime.dispose();
    await provider.stop(true);
  }
});

test("metadata IDs are refetched after either FIFO or registry eviction", async () => {
  const loads: string[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: response });
  const runtime = appRuntime({
    composed: boundToolHolder(),
    media: {
      bytes: () => Effect.die(new Error("fixture must not read bytes")),
      derive: () => Effect.succeed({ parts: [] }),
      load: (registry, ids) => Effect.sync(() => {
        loads.push(...ids);
        for (const id of ids) {
          if (id === "media") registry.remember(id, [{ kind: "image", ref: REF }]);
        }
      }),
    },
  });
  try {
    const llm = await runRuntimeEffect(runtime, Core.Llm);
    const registry = await runRuntimeEffect(runtime, DeliveryMediaRegistry);
    const model = await runRuntimeEffect(runtime, llm.resolveModel({ provider: "anthropic", id: "claude-opus-4-5" }, () => 1));
    const textModel = { ...model, input: ["text"] };
    const call = (ids: string[]) => runRuntimeEffect(runtime, llm.run({
      model: textModel,
      auth: { type: "api", key: "fixture-key" },
      transport: { baseUrl: `http://127.0.0.1:${provider.port}/v1` },
      messages: ids.map((id) => ({
        info: { role: "user" as const, id, sessionID: "session", agent: "resident", time: { created: 1 },
          model: { providerID: "anthropic", modelID: "fixture" } },
        parts: [{ type: "text" as const, id: `${id}-text`, messageID: id, sessionID: "session", text: id }],
      })),
      tools: [], now: () => 1, id: () => crypto.randomUUID(),
      trace: { traceId: "trace", sessionId: "session", runId: "run" }, events: { publish: () => undefined },
    }, { onMessage: () => undefined, onToolCall: () => undefined, onToolResult: () => undefined }));
    await call(["media", "empty"]);
    for (let id = 0; id < 256; id += 1) registry.remember(String(id), [{ kind: "image", ref: REF }]);
    await call(["media", "empty"]);
    expect(loads).toEqual(["media", "empty", "media"]);
    const more = Array.from(new Array(256).keys(), (id) => `empty-${id}`);
    await call(more);
    await call(["media", "empty", more[255] ?? "missing"]);
    expect(loads).toEqual(["media", "empty", "media", ...more, "empty"]);
  } finally {
    await runtime.dispose();
    await provider.stop(true);
  }
});

test.each(["bound", "unbound", "derived"] as const)("real process entry carries media with a %s parent byte source", async (mode) => {
  const fixture = messageFixture("resident");
  const registry = deliveryMedia();
  const captures: z.infer<typeof ProviderBody>[] = [];
  const requested = Promise.withResolvers<void>();
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      captures.push(ProviderBody.parse(await request.json()));
      requested.resolve();
      return response();
    },
  });
  const catalogPath = join(fixture.directory, "catalog.sqlite");
  let reads = 0;
  if (mode === "bound") registry.bind((ref) => Effect.sync(() => {
    expect(ref).toBe(REF);
    reads += 1;
    return { bytes: Buffer.from(IMAGE, "base64"), mime: "image/png" };
  }));
  const derived: Gateway.MediaPart = { kind: "audio", ref: "mac:/inbox/note.ogg", mime: "audio/ogg" };
  if (mode === "derived") registry.bind(
    () => Effect.die(new Error("audio must derive instead of reading bytes")),
    (part, model) => Effect.sync(() => {
      expect(part).toEqual(derived);
      expect(model.input).toContain("image");
      return { text: "TRANSCRIPT_RECEIVED", parts: [] };
    }),
  );
  const transport = createProcessSessionTransport({
    command: [
      process.execPath,
      new URL(mode === "unbound" ? "./fixtures/process-media-entry.ts" : "../src/process-entry.ts", import.meta.url).pathname,
    ],
    child: {
      catalogPath, sessionsDir: join(fixture.directory, "sessions"), entityIdleMs: 50,
      model: { provider: "anthropic", id: "claude-opus-4-5" }, apiKey: "fixture-key",
      transport: { baseUrl: `http://127.0.0.1:${provider.port}/v1` },
    },
    media: {
      registry,
      run: (effect, signal) => Effect.runPromise(Effect.result(effect), { signal })
        .then((result) => Result.getOrThrowWith(result, (error) => error)),
    },
    committed: () => { throw new Error("resident fixture must not deliver"); },
    answer: async () => { throw new Error("resident fixture must not answer"); },
    deliver: async () => { throw new Error("resident fixture must not send"); },
  });
  try {
    await fixture.stage("inspect the attached image", { encodingVersion: 1, value: { kind: "sdk" } });
    const pending = fixture.plane.openKernel(fixture.sessionId).pendingMessages(fixture.sessionId);
    const id = pending[0]?.id;
    if (id === undefined) throw new Error("missing fixture delivery");
    registry.remember(id, mode === "derived" ? [derived] : [{ kind: "image", ref: REF, mime: "image/png" }]);

    await bounded(transport.wake(fixture.sessionId));
    await bounded(requested.promise);

    expect(captures).toHaveLength(1);
    const images = captures.flatMap((body) => body.messages.flatMap((message) =>
      message.content.flatMap((block) => block.type === "image" ? [block.source.data] : [])));
    expect(images).toEqual(mode === "bound" ? [IMAGE] : []);
    expect(reads).toBe(mode === "bound" ? 1 : 0);
    const text = captures.flatMap((body) => body.messages.flatMap((message) =>
      message.content.flatMap((block) => block.type === "text" ? [block.text] : []))).join("\n");
    expect(text.includes("TRANSCRIPT_RECEIVED")).toBe(mode === "derived");
    const warningsPath = `${catalogPath}.warnings`;
    const warnings = existsSync(warningsPath)
      ? readFileSync(warningsPath, "utf8").trim().split("\n")
        .map((line) => Operational.Events.Warn.schema.parse(JSON.parse(line)))
        .filter((warning) => warning.component === "llm.media")
      : [];
    expect(warnings).toEqual(mode !== "unbound" ? [] : [expect.objectContaining({
      context: { ref: REF, kind: "image", err: `ProcessReplyError: process media byte source unbound: ${REF}` },
    })]);
    expect(fixture.plane.openKernel(fixture.sessionId).pendingMessages(fixture.sessionId)).toEqual([]);
  } finally {
    await transport.close();
    await provider.stop(true);
    await closeAcquiredEffects();
    fixture.plane.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
