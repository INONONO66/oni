import { expect, test } from "bun:test";
import { retryableOnce } from "../src/retryable-once";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";

/**
 * #1256 r2 C-1: the app `stop()` memo. Concurrent callers join ONE in-flight
 * run, a rejection clears the memo so the next call retries, and a success is
 * permanent.
 */

type Gate = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

const openGate = (): Gate => {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

test("a rejected run clears the memo so the next call retries; success is permanent", async () => {
  let attempts = 0;
  const gates: Gate[] = [];
  const stop = retryableOnce(() => {
    attempts += 1;
    const gate = openGate();
    gates.push(gate);
    return gate.promise;
  });

  // Concurrent callers share the single in-flight run.
  const first = stop();
  const joined = stop();
  expect(attempts).toBe(1);
  gates[0]?.reject(new Error("drain refused"));
  await expect(first).rejects.toThrow("drain refused");
  await expect(joined).rejects.toThrow("drain refused");

  // The rejection cleared the memo: the next call runs again...
  const second = stop();
  expect(attempts).toBe(2);
  gates[1]?.resolve();
  await second;

  // ...and the success is permanent: no further runs, same settled promise.
  await stop();
  expect(attempts).toBe(2);
  expect(stop()).toBe(second);
});

test("the real app stop(): a second shutdown during an in-flight close joins the SAME run", async () => {
  const suite = residentSuite();
  const app = await suite.boot({
    config: suite.config("retryable-once-state-"),
    llm: { resolveModel: fakeProviderModel },
  });
  try {
    // Two shutdowns racing the same in-flight close: the memo hands back the
    // identical promise — the app never tears down twice.
    const first = app.stop();
    const joined = app.stop();
    expect(joined).toBe(first);
    await first;
    await joined;
    // Success is permanent across later callers (suite cleanup re-enters here).
    expect(app.stop()).toBe(first);
  } finally {
    await suite.cleanup();
  }
});
