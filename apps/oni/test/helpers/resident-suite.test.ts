import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { residentSuite } from "./resident-suite";

const suite = residentSuite();

test("967-U1 cleanup attempts every disposer and propagates every rejection", async () => {
  // Given two independent teardown failures and owned temporary state.
  const directory = suite.tempDir("oni-cleanup-errors-");
  const first = new Error("U1_FIRST_DISPOSER_FAILURE");
  const second = new Error("U1_SECOND_DISPOSER_FAILURE");
  const disposed: number[] = [];
  suite.defer(() => {
    disposed.push(1);
    throw first;
  });
  suite.defer(async () => {
    disposed.push(2);
    throw second;
  });

  // When cleanup runs, both errors remain observable, in disposal order.
  const failure = await suite.cleanup().then(
    () => undefined,
    (error: AggregateError) => error,
  );
  // Then no failed disposer prevents another owner from being released.
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure?.errors).toEqual([second, first]);
  expect(disposed).toEqual([2, 1]);
  expect(existsSync(directory)).toBe(false);
});

test("967-U1 a single cleanup rejection retains its identity", async () => {
  const failure = new Error("U1_SINGLE_DISPOSER_FAILURE");
  suite.defer(() => {
    throw failure;
  });
  await expect(suite.cleanup()).rejects.toBe(failure);
});

test("967-U1 non-Error cleanup rejections retain their cause", async () => {
  const cause = Symbol("U1_NON_ERROR_REJECTION");
  suite.defer(() => {
    throw cause;
  });
  await expect(suite.cleanup()).rejects.toMatchObject({ cause });
});
