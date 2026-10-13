import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { captureOutput, expectExitViolation } from "./capture-output.test-helper";
import { main } from "./lint-side-effects";

const hotFile = "packages/llm/src/processor/index.ts";

test("side-effect lint accepts the shipped processor in-process", async () => {
  const cwd = process.cwd();
  process.chdir(join(import.meta.dir, ".."));
  try {
    const output = await captureOutput(main);
    expect(output).toBe("OK: side-effect lint scanned 1 hot files\n");
  } finally {
    process.chdir(cwd);
  }
});

test("side-effect lint rejects a missing pinned processor in-process", async () => {
  const root = mkdtempSync(join(tmpdir(), "side-effect-lint-"));
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await expect(main()).rejects.toThrow(`Missing hot file: ${hotFile}`);
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("side-effect lint reports a raw processor emission in-process", async () => {
  const root = mkdtempSync(join(tmpdir(), "side-effect-lint-"));
  const target = join(root, hotFile);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "function emit(sink) { sink.onMessage(message); }\n");
  try {
    await expectExitViolation(root, main, `VIOLATION: ${hotFile}:1 [processor-projected-sink]`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
