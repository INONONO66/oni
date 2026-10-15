import { expect, test } from "bun:test";
import { Operational } from "@openomni/protocol";
import { TelegramPoller } from "../src/provider/telegram/poller";
import type { TelegramUpdate } from "../src/provider/telegram/types";
import { testClockRuntime } from "./helpers/effect";
import { FIXED_NOW, sequentialIds } from "./helpers/injected";

/**
 * #1248: the poll loop is an Effect fiber on the injected clock. A poll error
 * puts the loop into a schedule sleep (1s jittered first step); stop()
 * settles the halt Deferred and interrupts that sleeping fiber — no retired
 * sleeper ever polls again, even when the clock advances past every delay.
 */
test("stop() interrupts the poll loop mid-backoff; a retired sleeper never polls again", async () => {
  const clock = testClockRuntime();
  let requests = 0;
  const failed = Promise.withResolvers<void>();
  const client = {
    async getUpdates(): Promise<TelegramUpdate[]> {
      requests += 1;
      throw new Error("telegram unreachable");
    },
    async answerCallbackQuery() { return; },
  };
  const poller = new TelegramPoller(
    client,
    { onMessage: () => undefined },
    (event) => {
      // The poll-error Warn publishes synchronously before the retry sleep —
      // the exact signal that the loop is now sleeping on the test clock.
      if (event.name === Operational.Events.Warn.name) failed.resolve();
    },
    { now: () => FIXED_NOW, id: sequentialIds(), run: clock.run },
  );
  try {
    const loop = poller.start();
    await failed.promise;
    expect(requests).toBe(1);
    poller.stop();
    await loop; // the interrupted loop resolves; it does not hang or throw
    await clock.adjust(10 * 60_000); // far past the 60s cap
    expect(requests).toBe(1);
  } finally {
    poller.stop();
    await clock.dispose();
  }
});

/**
 * #1312: `listenForAbort` owns the abort subscription, so a signal that is
 * already aborted when the cycle starts aborts the cycle's controller before
 * the request is built — zero getUpdates calls, not one full long poll.
 */
test("a pre-aborted signal performs zero getUpdates calls", async () => {
  const clock = testClockRuntime();
  let requests = 0;
  const client = {
    async getUpdates(): Promise<TelegramUpdate[]> {
      requests += 1;
      return [];
    },
    async answerCallbackQuery() { return; },
  };
  const poller = new TelegramPoller(
    client,
    { onMessage: () => undefined },
    () => undefined,
    { now: () => FIXED_NOW, id: sequentialIds(), run: clock.run },
  );
  try {
    const aborted = new AbortController();
    aborted.abort();
    await poller.pollOnce("trace-pre-aborted", aborted.signal);
    expect(requests).toBe(0);
  } finally {
    poller.stop();
    await clock.dispose();
  }
});
