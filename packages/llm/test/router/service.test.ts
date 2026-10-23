import { expect, test } from "bun:test";
import { Effect } from "effect";
import { ModelUnavailable } from "../../src";
import type { StreamEvent } from "../../src/processor/event-schema";
import { usePrivateCatalog } from "../helpers/catalog";
import { runEffect } from "../helpers/native";
import { apiError } from "../helpers/retry";
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

test("a pre-aborted call starts no candidate", async () => {
  const h = harness();
  h.input.signal = AbortSignal.abort();
  expect(await h.run(success)).toMatchObject({ type: "aborted", routing: { attempts: [] } });
  expect(h.calls).toBe(0);
});
