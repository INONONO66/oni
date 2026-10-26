import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { createProcessReplyChannel } from "../src/composition/process-replies";
import { testClockRuntime } from "./helpers/effect";
import { bounded } from "./helpers/protected-dispatch";
import { answer } from "./helpers/child-answer";

/**
 * #1248: the reply wait is Effect.timeoutOrElse on the injected runtime's
 * clock — no wall-clock timer. Crossing the 30s deadline on the TestClock
 * interrupts the wait and fails the exact pending answer with the typed
 * timeout error; the slot is then free for a retry.
 */
test("an unacknowledged answer fails with the typed timeout at the 30s deadline", async () => {
  const clock = testClockRuntime();
  const input = new PassThrough();
  const channel = createProcessReplyChannel(input, () => undefined, clock.run);
  try {
    input.write("initial\n");
    await channel.first;
    const rejected = channel.answer(answer).then(
      () => null,
      (error: Error) => error,
    );
    await clock.adjust(30_000);
    expect(await rejected).toMatchObject({ message: "process receiving receipt timed out" });
    // The timed-out slot is released: the same inputId may be asked again.
    const retry = channel.answer(answer).then(
      () => null,
      (error: Error) => error,
    );
    await clock.adjust(30_000);
    expect(await retry).toMatchObject({ message: "process receiving receipt timed out" });
  } finally {
    channel.close();
    input.destroy();
    await clock.dispose();
  }
});

test("an unacknowledged byte request expires on the injected clock", async () => {
  const clock = testClockRuntime();
  const input = new PassThrough();
  const written = Promise.withResolvers<void>();
  const channel = createProcessReplyChannel(input, () => written.resolve(), clock.run);
  try {
    input.write("initial\n");
    await channel.first;
    const rejected = clock.run(channel.media.bytes("ref")).catch((error: Error) => error);
    await written.promise;
    await clock.adjust(30_000);
    expect(await rejected).toMatchObject({ name: "ProcessReplyError", code: "timeout" });
  } finally {
    channel.close();
    input.destroy();
    await clock.dispose();
  }
});

/** A receipt arriving one tick before the deadline resolves — time is an input. */
test("a receipt just inside the deadline resolves instead of timing out", async () => {
  const clock = testClockRuntime();
  const input = new PassThrough();
  const channel = createProcessReplyChannel(input, () => undefined, clock.run);
  try {
    input.write("initial\n");
    await channel.first;
    const received = channel.answer(answer);
    await clock.adjust(29_999);
    input.write(`${JSON.stringify({ ok: true, inputId: answer.inputId, resolution: "resolved" })}\n`);
    expect(await received).toBe("resolved");
    // Nothing left pending: crossing the old deadline wakes no stale waiter.
    await clock.adjust(60_000);
  } finally {
    channel.close();
    input.destroy();
    await clock.dispose();
  }
});

test("a late expired receipt leaves unrelated bytes and a subsequent answer usable", async () => {
  const clock = testClockRuntime();
  const input = new PassThrough();
  const frames: string[] = [];
  const writes = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const channel = createProcessReplyChannel(input, (line) => {
    const frame = z.object({ kind: z.string(), inputId: z.string().optional() }).parse(JSON.parse(line));
    frames.push(frame.inputId ?? answer.inputId);
    writes[frames.length - 1]?.resolve();
  }, clock.run);
  try {
    input.write("initial\n");
    await channel.first;
    const expired = clock.run(channel.media.bytes("slow")).catch((error: Error) => error);
    await bounded(writes[0]?.promise ?? Promise.reject(new Error("missing write")));
    await clock.adjust(30_000);
    expect(await expired).toMatchObject({ code: "timeout" });
    const bytes = clock.run(channel.media.bytes("unrelated"));
    await bounded(writes[1]?.promise ?? Promise.reject(new Error("missing write")));
    input.write(`${JSON.stringify({ ok: true, inputId: frames[0], bytes: "AA==", mime: "image/png" })}\n`);
    input.write(`${JSON.stringify({ ok: true, inputId: frames[1], bytes: "AQ==", mime: "image/png" })}\n`);
    expect(await bounded(bytes)).toEqual({ bytes: new Uint8Array([1]), mime: "image/png" });
    const answered = channel.answer(answer);
    input.write(`${JSON.stringify({ ok: true, inputId: answer.inputId, resolution: "resolved" })}\n`);
    expect(await bounded(answered)).toBe("resolved");
    expect(frames).toHaveLength(3);
  } finally {
    channel.close();
    input.destroy();
    await clock.dispose();
  }
});

test("expired correlations evict the oldest ID after 256 timeouts", async () => {
  const clock = testClockRuntime();
  const input = new PassThrough();
  const frames: string[] = [];
  const written = Promise.withResolvers<void>();
  const channel = createProcessReplyChannel(input, (line) => {
    const frame = z.object({ inputId: z.string().optional() }).parse(JSON.parse(line));
    if (frame.inputId !== undefined) frames.push(frame.inputId);
    if (frames.length === 257) written.resolve();
  }, clock.run);
  try {
    input.write("initial\n");
    await channel.first;
    const requests = Array.from(new Array(257).keys(), (id) =>
      clock.run(channel.media.bytes(String(id))).catch((error: Error) => error));
    await bounded(written.promise);
    await clock.adjust(30_000);
    expect((await Promise.all(requests)).every((error) => error instanceof Error)).toBe(true);
    const answerAfterLate = channel.answer(answer);
    input.write(`${JSON.stringify({ ok: false, inputId: frames[1], code: "timeout", error: "late" })}\n`);
    input.write(`${JSON.stringify({ ok: true, inputId: answer.inputId, resolution: "resolved" })}\n`);
    expect(await bounded(answerAfterLate)).toBe("resolved");
    const unknown = channel.answer(answer).catch((error: Error) => error);
    input.write(`${JSON.stringify({ ok: false, inputId: frames[0], code: "timeout", error: "evicted" })}\n`);
    expect(await bounded(unknown)).toMatchObject({ code: "invalid_receipt" });
  } finally {
    channel.close();
    input.destroy();
    await clock.dispose();
  }
});
