import { afterEach, expect, spyOn, test } from "bun:test";
import { main } from "./check-core-end-state";

const exitCodeBefore = process.exitCode;

afterEach(() => {
  process.exitCode = exitCodeBefore;
});

test("main runs the core end-state gate and both clone scans against the real tree and reports OK", async () => {
  const errors: string[] = [];
  const logs: string[] = [];
  const stderr = spyOn(console, "error").mockImplementation((...chunks) => {
    errors.push(chunks.map(String).join(" "));
  });
  const stdout = spyOn(console, "log").mockImplementation((...chunks) => {
    logs.push(chunks.map(String).join(" "));
  });
  try {
    await main();
  } finally {
    stderr.mockRestore();
    stdout.mockRestore();
  }
  expect(errors).toEqual([]);
  expect(process.exitCode).toBe(exitCodeBefore);
  expect(logs).toEqual([
    "OK: core terminal source, alarm, size and assertion targets; inherited clone pins match",
  ]);
}, 300_000);
