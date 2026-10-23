import { expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import { APIError, InvalidProviderData, ModelUnavailable } from "../../src";
import type { StreamEvent } from "../../src/processor/event-schema";
import { usePrivateCatalog } from "../helpers/catalog";
import { runEffect } from "../helpers/native";
import { apiError } from "../helpers/retry";
import { textEvents } from "../helpers/processor";
import { connectionRefused, failed, harness, success } from "./fixtures";

usePrivateCatalog();

test("a refused proxy constructor falls back inside one service run", async () => {
  const h = harness();
  const outcome = await h.run((request) => h.calls === 1 ? failed(connectionRefused()) : success(request));
  expect(h.calls).toBe(2);
  expect(outcome).toMatchObject({
    type: "stop", routing: { requested: "proxy/x", selected: "direct/x",
      attempts: [
        { candidate: "proxy/x", action: "try" },
        { candidate: "proxy/x", action: "swap_model", failure: { detail: "unavailable" } },
        { candidate: "direct/x", action: "try" },
        { candidate: "direct/x", action: "selected" },
      ],
    },
  });
  expect(h.capture.textParts().map((part) => part.text)).toEqual(["first second"]);
  expect(h.capture.messages.every((message) => message.info.role === "assistant" && message.info.providerID === "direct")).toBe(true);
});

test.each([
  { statusCode: 400, message: "bad request", reason: "non_retryable" },
  { statusCode: 401, message: "denied", reason: "non_retryable" },
  { statusCode: 403, message: "content_policy_violation", reason: "content_policy" },
  { statusCode: 429, message: "monthly usage limit", reason: "billing" },
])("HTTP $statusCode verdict survives a nested socket reset", ({ statusCode, message, reason }) => {
  const http = apiError({ message, statusCode, isRetryable: statusCode === 429 });
  Object.assign(http.cause, { cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }) });
  expect(harness().service.classifyFailure({ error: new APIError({ cause: http.cause }) }))
    .toMatchObject({ kind: "terminal", providerReason: reason, status: statusCode });
});

test("reported over-window usage prevents a transport fallback", async () => {
  const h = harness();
  h.input.model = { ...h.input.model, limit: { context: 50 } };
  const outcome = await h.run((request) => h.calls === 1
    ? Effect.succeed({ fullStream: (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "step-start" };
      yield { type: "step-finish", finishReason: "stop", usage: { inputTokens: 100, outputTokens: 0 } };
      throw connectionRefused();
    })() })
    : success(request));
  expect(outcome).toMatchObject({ type: "error", routing: { attempts: [
    { action: "try" }, { action: "surface", failure: { kind: "overflow" } },
  ] } });
  expect(h.calls).toBe(1);
});

test("discarded attempt usage bills the caller without exposing its text or inflating final context", async () => {
  const h = harness();
  const snapshots: Array<{ input: number; output: number }> = [];
  const original = h.capture.sink.onMessage;
  h.capture.sink.onMessage = (message) => {
    if (message.info.role === "assistant") snapshots.push({
      input: message.info.tokens.input, output: message.info.tokens.output,
    });
    original(message);
  };
  const outcome = await h.run(() => h.calls === 1
    ? Effect.succeed({ fullStream: (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "step-start" };
      yield { type: "step-finish", finishReason: "stop", usage: { inputTokens: 100, outputTokens: 40 } };
      throw connectionRefused();
    })() })
    : Effect.succeed({ fullStream: (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "step-start" };
      yield* textEvents("answer");
      yield { type: "step-finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: "finish", finishReason: "stop" };
    })() }));
  expect(outcome).toMatchObject({
    type: "stop",
    evidence: { usage: { inputTokens: 10, outputTokens: 5 } },
    billedUsage: { inputTokens: 110, outputTokens: 45 },
    routing: { attempts: [
      { action: "try" },
      { action: "swap_model", usage: { inputTokens: 100, outputTokens: 40 } },
      { action: "try" },
      { action: "selected" },
    ] },
  });
  expect(snapshots.at(-1)).toMatchObject({ input: 10, output: 5 });
  expect(h.capture.textParts().map((part) => part.text)).toEqual(["answer"]);
  expect(h.capture.stepFinishParts().at(-1)).toMatchObject({ tokens: { input: 10 } });
});

test("all open candidates return a typed value with the earliest reopening and caller continues", async () => {
  const h = harness();
  const later = apiError({ message: "route gone", statusCode: 404, isRetryable: false,
    responseHeaders: { "retry-after-ms": "120000" } });
  const first = await h.run(() => failed(h.calls === 1 ? later : connectionRefused())).catch((error: ModelUnavailable) => error);
  expect(first).toBeInstanceOf(ModelUnavailable);
  const unavailable = await runEffect(Effect.flip(h.service.run(h.input, h.capture.sink, { createStream: success })));
  expect(unavailable).toBeInstanceOf(ModelUnavailable);
  expect(unavailable).toMatchObject({
    category: "proxy/x", nearestFallback: "small", openUntil: 60_000,
    routing: { attempts: [
      { candidate: "proxy/x", action: "skip_circuit" },
      { candidate: "direct/x", action: "skip_circuit" },
    ] },
  });
  expect(h.calls).toBe(2);
  h.advance(60_000);
  expect(await h.run(success)).toMatchObject({ type: "stop", routing: { selected: "direct/x" } });
});

test.each(["text-delta", "reasoning-delta", "tool-input-delta"])("a failure after %s surfaces without swapping", async (type) => {
  const h = harness();
  const outcome = await h.run(() => Effect.succeed({
    fullStream: (async function* (): AsyncGenerator<StreamEvent> {
      yield { type, id: "block", text: "partial" };
      throw connectionRefused();
    })(),
  }));
  expect(h.calls).toBe(1);
  expect(outcome).toMatchObject({
    type: "error", error: { message: "connection refused" },
    routing: { attempts: [{ action: "try" }, { candidate: "proxy/x", action: "surface" }] },
  });
});

test("absent chain rows preserve the single-attempt outcome and sink", async () => {
  const h = harness({});
  const outcome = await h.run(() => failed(connectionRefused()));
  expect(h.calls).toBe(1);
  expect(outcome).toMatchObject({ type: "error", error: { message: "connection refused" } });
  expect(outcome.routing).toBeUndefined();
  expect(h.capture.messages).toHaveLength(1);
});

test("three immediate server failures surface, then the next run skips only that selector", async () => {
  const h = harness();
  const failure = apiError({ message: "down", statusCode: 503, isRetryable: true });
  for (let index = 0; index < 3; index += 1) {
    expect(await h.run(() => failed(failure))).toMatchObject({ type: "error" });
  }
  expect(await h.run(success)).toMatchObject({ type: "stop", routing: { selected: "direct/x",
    attempts: [{ candidate: "proxy/x", action: "skip_circuit" }, { action: "try" }, { action: "selected" }],
  } });
  expect(h.calls).toBe(4);
});

test("fallback affinity survives continuation but reverts at a turn boundary", async () => {
  const h = harness();
  await h.run((request) => h.calls === 1 ? failed(connectionRefused()) : success(request));
  h.advance(60_000);
  expect(await h.run(success)).toMatchObject({ routing: { selected: "direct/x" } });
  h.input.trace.runId = "next-turn";
  expect(await h.run(success)).toMatchObject({ routing: { selected: "proxy/x" } });
});

test("partial fallback output pins its continuation but not a new turn", async () => {
  const h = harness();
  const partial = await h.run(() => h.calls === 1
    ? failed(connectionRefused())
    : Effect.succeed({ fullStream: (async function* (): AsyncGenerator<StreamEvent> {
      yield* textEvents("partial");
      throw connectionRefused();
    })() }));
  expect(partial).toMatchObject({ type: "error", routing: { selected: "direct/x" } });
  h.advance(60_000);
  expect(await h.run(success)).toMatchObject({ routing: { selected: "direct/x",
    attempts: [{ candidate: "direct/x", action: "try" }, { action: "selected" }] } });
  h.input.trace.runId = "next-turn";
  expect(await h.run(success)).toMatchObject({ routing: { selected: "proxy/x" } });
});

test("a pre-aborted call starts no candidate", async () => {
  const h = harness();
  h.input.signal = AbortSignal.abort();
  expect(await h.run(success)).toMatchObject({ type: "aborted", routing: { attempts: [] } });
  expect(h.calls).toBe(0);
});

test("configured routing resolves an explicit credential without configured slots", async () => {
  const h = harness({ chains: [{ primary: "proxy/x", selectors: ["proxy/x"] }] });
  h.input.auth = { type: "api", key: "explicit" };
  expect(await h.run(success)).toMatchObject({ type: "stop", routing: { selected: "proxy/x" } });
  expect(h.calls).toBe(1);
});

test("configured routing reports missing credential resolution without entering a provider", async () => {
  const h = harness({ chains: [{ primary: "proxy/x", selectors: ["proxy/x"] }] });
  await expect(h.run(success)).rejects.toBeInstanceOf(ModelUnavailable);
  expect(h.calls).toBe(0);
});

test("a typed provider setup failure is classified before stream output", async () => {
  const h = harness({ chains: [{ primary: "proxy/x", selectors: ["proxy/x"] }],
    credentials: [{ provider: "proxy", auth: { type: "api", key: "key" } }] });
  h.input.trace.traceId = "";
  await expect(h.run(success)).rejects.toBeInstanceOf(InvalidProviderData);
  expect(h.calls).toBe(0);
});

test("content policy refusal pins the rejecting selector for the same turn", async () => {
  const h = harness();
  const refused = apiError({ message: "content_policy_violation", statusCode: 403, isRetryable: false });
  expect(await h.run(() => h.calls === 1 ? failed(connectionRefused()) : failed(refused)))
    .toMatchObject({ type: "error", routing: { attempts: [
      { candidate: "proxy/x", action: "try" }, { candidate: "proxy/x", action: "swap_model" },
      { candidate: "direct/x", action: "try" }, { candidate: "direct/x", action: "surface" },
    ] } });
  h.advance(60_000);
  expect(await h.run(success)).toMatchObject({ routing: { selected: "direct/x" } });
  expect(h.calls).toBe(3);
});

test("active cancellation aborts its attempt without entering the fallback", async () => {
  const h = harness();
  const controller = new AbortController();
  h.input.signal = controller.signal;
  const entered = await runEffect(Deferred.make<void>());
  const release = await runEffect(Deferred.make<void>());
  const active = h.run(() => Effect.succeed({ fullStream: (async function* (): AsyncGenerator<StreamEvent> {
    await runEffect(Deferred.succeed(entered, undefined));
    await runEffect(Deferred.await(release));
    yield { type: "finish" };
  })() }));
  await runEffect(Deferred.await(entered));
  controller.abort();
  await runEffect(Deferred.succeed(release, undefined));
  expect(await active).toMatchObject({ type: "aborted", routing: { attempts: [
    { action: "try" }, { action: "abort" },
  ] } });
  expect(h.calls).toBe(1);
});
