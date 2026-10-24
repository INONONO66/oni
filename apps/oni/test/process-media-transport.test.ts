import { expect, test } from "bun:test";
import { Effect, Result } from "effect";
import { Gateway } from "@oni/protocol";
import { z } from "zod";
import type { PartBytes } from "@oni/llm";
import { createProcessSessionTransport } from "../src/composition/process-session";
import { ProcessReplyReceipt } from "../src/composition/process-replies";
import { deliveryMedia } from "../src/composition/delivery-media";
import { MEDIA_BYTE_CAP } from "../src/composition/media";
import { bounded } from "./helpers/protected-dispatch";
import { testClockRuntime } from "./helpers/effect";

type TransportOptions = Parameters<typeof createProcessSessionTransport>[0];

function fixture(scenario: string, source?: PartBytes, run?: NonNullable<TransportOptions["media"]>["run"]) {
  const registry = deliveryMedia();
  registry.remember("delivery", [{ kind: "image", ref: "mac:/inbox/a.png" }]);
  if (source !== undefined) registry.bind(source);
  const received: string[] = [];
  const transport = createProcessSessionTransport({
    command: [process.execPath, new URL(scenario === "derive"
      ? "./fixtures/process-derive-child.ts" : "./fixtures/process-session-child.ts", import.meta.url).pathname, scenario],
    child: {
      catalogPath: "unused", sessionsDir: "unused", entityIdleMs: 50,
      model: { provider: "fake", id: "fixture" }, apiKey: "unused",
    },
    media: {
      registry,
      run: run ?? ((effect, signal) => Effect.runPromise(Effect.result(effect), { signal })
        .then((result) => Result.getOrThrowWith(result, (error) => error))),
    },
    committed: (ids) => received.push(...ids),
    answer: async () => { throw new Error("unexpected answer"); },
    deliver: async () => { throw new Error("unexpected delivery"); },
  });
  return { transport, received, registry, [Symbol.asyncDispose]: () => transport.close() };
}

test("parent replies with exactly the requested delivery's media", async () => {
  await using f = fixture("media");
  await bounded(f.transport.wake("child"));
  expect(f.received.map((line) => ProcessReplyReceipt.parse(JSON.parse(line)))).toEqual([{
    ok: true, inputId: "lookup", parts: [{ kind: "image", ref: "mac:/inbox/a.png" }],
  }]);
});

test.each(["unbound", "read_failed", "too_large", "bound"] as const)("parent byte reply handles %s sources", async (mode) => {
  const source: PartBytes = () => mode === "read_failed"
    ? Effect.fail(new Error("machine read failed"))
    : Effect.succeed({ bytes: mode === "too_large" ? new Uint8Array(MEDIA_BYTE_CAP + 1) : new Uint8Array([0, 255]), mime: "image/png" });
  await using f = fixture("bytes", mode === "unbound" ? undefined : source);
  await bounded(f.transport.wake("child"));
  const receipt = ProcessReplyReceipt.parse(JSON.parse(f.received[0] ?? "null"));
  expect(receipt).toMatchObject(mode === "bound"
    ? { ok: true, bytes: "AP8=", mime: "image/png" }
    : { ok: false, code: mode });
});

test.each(["close", "exit"] as const)("a %s during a parent byte read interrupts the source and settles the child", async (mode) => {
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  await using f = fixture("bytes-pending", () => Effect.callback(() => {
    started.resolve();
    return Effect.sync(() => cancelled.resolve());
  }));
  const done = f.transport.wake("child").then(() => undefined, (error: Error) => error);
  await bounded(started.promise);
  if (mode === "close") await bounded(f.transport.close());
  else process.kill(Number(f.received[0]), "SIGTERM");
  expect(await bounded(done)).toMatchObject({ name: "ProcessSessionError", message: "session process closed: child" });
  await bounded(cancelled.promise);
});

test("a parent byte read times out on the injected clock", async () => {
  const clock = testClockRuntime();
  const started = Promise.withResolvers<void>();
  await using f = fixture("bytes", () => Effect.callback(() => { started.resolve(); }), clock.run);
  try {
    const done = f.transport.wake("child");
    await bounded(started.promise);
    await clock.adjust(30_000);
    await bounded(done);
    expect(ProcessReplyReceipt.parse(JSON.parse(f.received[0] ?? "null"))).toMatchObject({ ok: false, code: "timeout" });
  } finally {
    await clock.dispose();
  }
});

const Derived = z.object({
  result: z.object({ text: z.string().optional(), parts: z.array(Gateway.MediaPart) }),
  warnings: z.array(z.object({ ref: z.string(), err: z.string() })),
  receipt: ProcessReplyReceipt,
});

test.each(["bound", "unbound"] as const)("derived text and parts cross the real child wire with a %s parent", async (mode) => {
  await using f = fixture("derive");
  const part: Gateway.MediaPart = { kind: "image", ref: "mac:/inbox/frame.png", mime: "image/png" };
  if (mode === "bound") f.registry.bind(() => Effect.die(new Error("unexpected bytes")), (original, model) => Effect.sync(() => {
    expect(original).toEqual({ kind: "audio", ref: "mac:/inbox/note.ogg", mime: "audio/ogg" });
    expect(model).toEqual({ input: ["text", "image"], api: { npm: "@ai-sdk/openai", style: "responses" } });
    return { text: "TRANSCRIPT", parts: [part] };
  }));
  await bounded(f.transport.wake("child"));
  const result = Derived.parse(JSON.parse(f.received[0] ?? "null"));
  expect(result.result).toEqual(mode === "bound" ? { text: "TRANSCRIPT", parts: [part] } : { parts: [] });
  expect(result.warnings).toEqual(mode === "bound" ? [] : [{
    ref: "mac:/inbox/note.ogg", err: "ProcessReplyError: process media derivation unbound: mac:/inbox/note.ogg",
  }]);
  expect(result.receipt).toMatchObject(mode === "bound" ? { ok: true, text: "TRANSCRIPT", parts: [part] } : { ok: false, code: "unbound" });
});

test("a parent derive deadline becomes an empty child result and a warning", async () => {
  const clock = testClockRuntime();
  const started = Promise.withResolvers<void>();
  await using f = fixture("derive", undefined, clock.run);
  f.registry.bind(() => Effect.die(new Error("unexpected bytes")), () => Effect.callback(() => { started.resolve(); }));
  try {
    const done = f.transport.wake("child");
    await bounded(started.promise);
    await clock.adjust(30_000);
    await bounded(done);
    const result = Derived.parse(JSON.parse(f.received[0] ?? "null"));
    expect(result.result).toEqual({ parts: [] });
    expect(result.receipt).toMatchObject({ ok: false, code: "timeout" });
    expect(result.warnings).toEqual([{
      ref: "mac:/inbox/note.ogg", err: "ProcessReplyError: process media operation timed out: mac:/inbox/note.ogg",
    }]);
  } finally {
    await clock.dispose();
  }
});
