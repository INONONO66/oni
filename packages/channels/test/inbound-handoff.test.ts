import { expect, test } from "bun:test";
import { Operational } from "@oni/protocol";
import { z } from "zod";
import { Dedupe } from "../src/support/dedupe";
import { FIXED_NOW } from "./helpers/injected";
import { handoffInbound } from "../src/support/inbound-handoff";

test.each([
  false,
  true,
])("failed handoff releases its claim; propagate=%s", async (rethrowFailure) => {
  const failure = new Error("handler failed");
  const schema = z.object({ traceId: z.string(), context: z.object({ err: z.string() }) });
  const errors: z.infer<typeof schema>[] = [];
  let attempts = 0;
  const input = {
    dedupe: new Dedupe(() => FIXED_NOW),
    key: "message",
    traceId: "trace",
    now: () => FIXED_NOW,
    errorMessage: "delivery failed",
    rethrowFailure,
    publish: (event, data) => {
      expect(event.name).toBe(Operational.Events.Error.name);
      errors.push(schema.parse(data));
    },
    handle: async () => {
      attempts += 1;
      if (attempts === 1) throw failure;
    },
  } satisfies Parameters<typeof handoffInbound>[0];
  const first = handoffInbound(input);
  if (rethrowFailure) await expect(first).rejects.toBe(failure);
  else await expect(first).resolves.toBeUndefined();
  await handoffInbound(input);
  expect(attempts).toBe(2);
  expect(errors).toEqual([{ traceId: "trace", context: { err: String(failure) } }]);
});

test("an in-flight or completed handoff is not delivered again", async () => {
  const released = Promise.withResolvers<void>();
  let calls = 0;
  const input = {
    dedupe: new Dedupe(() => FIXED_NOW),
    key: "message",
    traceId: "trace",
    now: () => FIXED_NOW,
    errorMessage: "delivery failed",
    rethrowFailure: true,
    publish: () => undefined,
    handle: async () => {
      calls += 1;
      await released.promise;
    },
  };
  const first = handoffInbound(input);
  try {
    const duplicate = handoffInbound(input);
    expect(calls).toBe(1);
    await duplicate;
  } finally {
    released.resolve();
  }
  await first;
  await handoffInbound(input);
  expect(calls).toBe(1);
});
