import { expect, test } from "bun:test";
import { generateText, UnsupportedFunctionalityError } from "ai";
import type { Message, PlainObject } from "@oni/protocol";
import { PlainObjectSchema } from "@oni/protocol";
import { Effect } from "effect";
import { Capability, resolveInputParts, type Auth, type UserBlock } from "../../src";
import { Provider } from "../../src/provider";
import { effectiveStyle, getLanguage } from "../../src/provider/sdk";
import { createRouter } from "../../src/router/stream-fn";
import { sequentialIds } from "../helpers/fixtures";
import { runEffect } from "../helpers/native";
import { capturingSink } from "../helpers/processor";
import { jsonResponse, mockFetch, openAIResponse } from "../helpers/provider-fetch";

const model: Provider.Model = {
  ...Provider.fromModelsDevModel(
    { id: "openai", name: "OpenAI", env: [], npm: "@ai-sdk/openai", models: {} },
    { id: "audio", name: "Audio", input: ["text", "audio"] },
  ),
  api: { npm: "@ai-sdk/openai", style: "chat" },
};
const audio = new Uint8Array([1, 2, 3]);

function audioTransport(selected = model, auth: Auth.Info = { type: "api", key: "test" }) {
  const requests: PlainObject[] = [];
  const fetch = mockFetch((url, init) => {
    requests.push(PlainObjectSchema.parse(JSON.parse(String(init?.body))));
    if (String(url).endsWith("/responses")) return jsonResponse(openAIResponse(selected.id));
    return jsonResponse({
      id: "chat", object: "chat.completion", created: 1, model: "audio",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
  return {
    requests,
    run: async (content: UserBlock[]) => {
      const original = globalThis.fetch;
      globalThis.fetch = fetch;
      try {
        return await generateText({
          model: getLanguage(selected, auth), maxRetries: 0,
          messages: [{ role: "user", content }],
        });
      } finally {
        globalThis.fetch = original;
      }
    },
  };
}

test("audio/ogg is rejected by the real SDK before fetch", async () => {
  const call = audioTransport();
  const result = call.run([{ type: "file", data: audio, mediaType: "audio/ogg" }]);
  await expect(result).rejects.toBeInstanceOf(UnsupportedFunctionalityError);
  await expect(result).rejects.toMatchObject({ functionality: "audio content parts with media type audio/ogg" });
  expect(call.requests).toEqual([]);
  expect(Capability.accepts(model, { kind: "audio", mime: "audio/ogg" })).toBe(false);
});

test.each([
  ["audio/wav", "wav"],
  ["audio/mpeg", "mp3"],
  ["audio/mp3", "mp3"],
])("%s reaches fetch as %s audio", async (mime, format) => {
  const call = audioTransport();
  expect((await call.run([{ type: "file", data: audio, mediaType: mime }])).text).toBe("ok");
  expect(call.requests).toHaveLength(1);
  expect(call.requests[0]?.messages).toEqual([{
    role: "user", content: [{ type: "input_audio", input_audio: { data: "AQID", format } }],
  }]);
  expect(Capability.accepts(model, { kind: "audio", mime })).toBe(true);
});

test("extensionless declared WAV survives byte-source MIME through the real SDK", async () => {
  const call = audioTransport();
  const resolved = await runEffect(resolveInputParts({
    parts: [{ kind: "audio", ref: "mac:/inbox/note", mime: "audio/wav" }], model,
    bytes: () => Effect.succeed({ bytes: audio, mime: "application/octet-stream" }),
  }));
  await call.run(resolved.blocks);
  expect(call.requests[0]?.messages).toEqual([{
    role: "user", content: [{ type: "input_audio", input_audio: { data: "AQID", format: "wav" } }],
  }]);
});

test.each([
  { style: "responses", proxy: false },
  { style: undefined, proxy: false },
  { style: "responses", proxy: true },
  { style: undefined, proxy: true },
  { style: "chat", proxy: false },
] as const)("production resolver honors $style with proxy=$proxy for WAV", async ({ style, proxy }) => {
  const selected: Provider.Model = { ...model, api: { npm: "@ai-sdk/openai", style } };
  const auth: Auth.Info = proxy ? { type: "proxy", baseURL: "https://proxy.invalid/v1" } : { type: "api", key: "test" };
  const effective = { ...selected, api: { ...selected.api, npm: "@ai-sdk/openai", style: effectiveStyle(selected, auth) } };
  const derived: string[] = [];
  const resolved = await runEffect(resolveInputParts({
    parts: [{ kind: "audio", ref: "note", mime: "audio/wav" }], model: effective,
    bytes: () => Effect.succeed({ bytes: audio, mime: "audio/wav" }),
    derive: (part) => Effect.sync(() => {
      derived.push(part.ref);
      return { text: "transcript", parts: [] };
    }),
  }));
  const chat = proxy || style === "chat";
  expect(derived).toEqual(chat ? [] : ["note"]);
  expect(resolved.unaccepted).toEqual([]);
  const call = audioTransport(selected, auth);
  expect((await call.run(resolved.blocks)).text).toBe("ok");
  expect(call.requests).toHaveLength(1);
  if (chat) {
    expect(call.requests[0]?.messages).toEqual([{
      role: "user", content: [{ type: "input_audio", input_audio: { data: "AQID", format: "wav" } }],
    }]);
  } else {
    expect(call.requests[0]?.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "transcript" }] }]);
  }
});

test.each([
  { primaryVision: true, kind: "image" },
  { primaryVision: false, kind: "image" },
  { primaryVision: true, kind: "video" },
  { primaryVision: false, kind: "video" },
] as const)("candidate projection rebuilds $kind when primary vision is $primaryVision", async ({ primaryVision, kind }) => {
  const requests: PlainObject[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch((_url, init) => {
    const body = PlainObjectSchema.parse(JSON.parse(String(init?.body)));
    requests.push(body);
    if (body.model === "primary") return Response.json({ error: { message: "model not found", type: "invalid_request_error", code: "model_not_found" } }, { status: 404 });
    const chunks = [
      { id: "chat", model: "fallback", created: 1, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
      { id: "chat", model: "fallback", created: 1, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  try {
    const primary: Provider.Model = { ...model, id: "primary", input: primaryVision ? ["text", "image"] : ["text"] };
    const fallback: Provider.Model = { ...model, id: "fallback", input: primaryVision ? ["text"] : ["text", "image"] };
    const route = createRouter({ authFilePath: "/nonexistent/media/auth.json", resolveModel: () => Effect.succeed(fallback) }, {
      chains: [{ primary: "openai/primary", selectors: ["openai/primary", "openai/fallback"] }],
    });
    const user: Message.WithParts = {
      info: { id: "u1", sessionID: "s", role: "user", time: { created: 1 }, agent: "test", model: { providerID: "openai", modelID: "primary" } },
      parts: [{ id: "text", messageID: "u1", sessionID: "s", type: "text", text: "look" }],
    };
    let reads = 0;
    const outcome = await runEffect(route({
      messages: [user], tools: [], model: primary, auth: { type: "api", key: "test" },
      now: () => 1, id: sequentialIds(), trace: { traceId: "t", sessionId: "s", runId: "r" },
      events: { publish: () => undefined },
      media: {
        parts: [{ messageId: "u1", parts: [{ kind, ref: `mac:/${kind}`, mime: kind === "image" ? "image/png" : "video/mp4" }] }],
        bytes: () => Effect.sync(() => { reads += 1; return { bytes: new Uint8Array([137, 80, 78, 71]), mime: "image/png" }; }),
        ...(kind === "image" ? {} : {
          derive: (_part, candidate: Capability.InputModel) => Effect.succeed({
            text: `[video 1s, ${Capability.accepts(candidate, "image") ? 1 : 0} frames]`,
            parts: Capability.accepts(candidate, "image") ? [{ kind: "image" as const, ref: "mac:/frame", mime: "image/png" }] : [],
          }),
        }),
      },
    }, capturingSink().sink));
    expect(outcome).toMatchObject({ type: "stop", routing: { selected: "openai/fallback" } });
    expect(requests.map((request) => request.model)).toEqual(["primary", "fallback"]);
    const withImage: PlainObject[] = [{ role: "user", content: [
      { type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw==" } },
      ...(kind === "video" ? [{ type: "text", text: "[video 1s, 1 frames]" }] : []),
    ] }];
    const textOnly = [{ role: "user", content: kind === "image" ? "look" : [
      { type: "text", text: "look" }, { type: "text", text: "[video 1s, 0 frames]" },
    ] }];
    expect(requests.map((request) => request.messages)).toEqual(primaryVision ? [withImage, textOnly] : [textOnly, withImage]);
    expect(reads).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
