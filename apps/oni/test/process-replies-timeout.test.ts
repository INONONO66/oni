import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { SessionTransition } from "@oni/protocol";
import { createProcessReplyChannel } from "../src/composition/process-replies";
import { testClockRuntime } from "./helpers/effect";

const answer: SessionTransition.Answer = {
  inputId: "message",
  requestId: "request",
  sessionId: "receiver",
  receivedAt: 1,
  principal: { kind: "session", principalId: "child", evidenceId: "terminal" },
  bindingDigest: "binding",
  inputHash: "input",
  effectHash: "effect",
  generation: 1,
  toolsHash: "tools",
  domainRevisions: {},
  decision: "answer",
  allowedAction: "report_result",
  content: "answer",
};

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
