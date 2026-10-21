import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Assemble the retired spellings so the receipt does not match its own source.
test("retired target-selection workspace and executor are absent repository-wide", () => {
  const retired = "placement";
  const root = join(import.meta.dir, "..");
  expect(existsSync(join(root, "packages", retired))).toBe(false);
  const result = Bun.spawnSync(
    [
      "git",
      "grep",
      "-n",
      "-E",
      `@oni/${retired}|packages/${retired}|${retired}GatedExecutor`,
      "--",
      ".",
      ":!**/dist/**",
    ],
    { cwd: root },
  );
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(1);
});
