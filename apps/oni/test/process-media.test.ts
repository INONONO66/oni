import { expect, test } from "bun:test";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { type Gateway, Operational } from "@oni/protocol";
import { Core } from "@oni/agent";
import { z } from "zod";
import { deliveryMedia } from "../src/composition/delivery-media";
import { createProcessSessionTransport } from "../src/composition/process-session";
import { messageFixture } from "./helpers/message-fixture";
import { appRuntime, closeAcquiredEffects, runAbortableEffect, runRuntimeEffect } from "./helpers/effect";
import { boundToolHolder } from "./helpers/tool-ports";
import { bounded } from "./helpers/protected-dispatch";
import { contentBlocks, messageStart, messageEnd, sseResponse } from "./helpers/anthropic-sse";

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

test.each(["bound", "unbound"] as const)("replayed user file reaches the in-process model as an image with a %s source", async (mode) => {
  const captures: z.infer<typeof ProviderBody>[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      captures.push(ProviderBody.parse(await request.json()));
      return response();
    },
  });
  const runtime = appRuntime({
    composed: boundToolHolder(),
    ...(mode === "unbound" ? {} : { media: {
      bytes: () => Effect.succeed({ bytes: Buffer.from(IMAGE, "base64"), mime: "image/png" }),
      derive: () => Effect.succeed({ parts: [] }),
    } }),
  });
  try {
    const llm = await runRuntimeEffect(runtime, Core.Llm);
    const model = await runRuntimeEffect(runtime, llm.resolveModel({ provider: "anthropic", id: "claude-opus-4-5" }, () => 100));
    const input: Parameters<typeof llm.run>[0] = {
      model,
      auth: { type: "api", key: "fixture-key" },
      transport: { baseUrl: `http://127.0.0.1:${provider.port}/v1` },
      messages: [{
        info: {
          role: "user", id: "replayed", sessionID: "session", agent: "resident", time: { created: 100 },
          model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
        },
        parts: [
          { type: "text", id: "replayed-text", messageID: "replayed", sessionID: "session", text: "inspect" },
          { type: "file", id: "replayed-file", messageID: "replayed", sessionID: "session", kind: "image", ref: REF, mime: "image/png" },
        ],
      }],
      tools: [], now: () => 100, id: () => crypto.randomUUID(),
      trace: { traceId: "trace", sessionId: "session", runId: "run" },
      events: { publish: () => undefined },
    };
    const sink = { onMessage: () => undefined, onToolCall: () => undefined, onToolResult: () => undefined };
    await runRuntimeEffect(runtime, llm.run(input, sink));
    const content = captures.flatMap((body) => body.messages.flatMap((message) => message.content));
    expect(content.flatMap((block) => block.type === "image" ? [block.source.data] : []))
      .toEqual(mode === "bound" ? [IMAGE] : []);
    expect(content.flatMap((block) => block.type === "text" ? [block.text] : []))
      .toEqual(mode === "bound" ? ["inspect"] : ["inspect", `[image: ${REF}]`]);
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
      run: runAbortableEffect,
    },
    committed: () => { throw new Error("resident fixture must not deliver"); },
    answer: async () => { throw new Error("resident fixture must not answer"); },
    deliver: async () => { throw new Error("resident fixture must not send"); },
  });
  try {
    await fixture.stage("inspect the attached image", { encodingVersion: 1, value: { kind: "sdk" } },
      mode === "derived" ? derived : { kind: "image", ref: REF, mime: "image/png" });

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
