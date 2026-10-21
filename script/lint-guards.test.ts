import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, expectExitViolation } from "./capture-output.test-helper";
import { main, validateGuardSource } from "./lint-guards";

test("the shipped tree passes every guard rule in-process", async () => {
  const cwd = process.cwd();
  process.chdir(join(import.meta.dir, ".."));
  try {
    // main exits the process on any guard violation, so returning is the verdict.
    const output = await captureOutput(async () => {
      await expect(main()).resolves.toBeUndefined();
    });
    expect(output).toMatch(/^OK: guard lint scanned \d+ TypeScript files\n$/);
  } finally {
    process.chdir(cwd);
  }
});

test.each([
  [
    "packages/channels/src/authn/decision.ts",
    "export const decide = () => true;",
    "missing-canonical-policy-evaluator",
    1,
  ],
  [
    "packages/channels/src/telegram/normalizer.ts",
    "\nevaluateTriggers(event);",
    "inline-channel-trigger-evaluation",
    2,
  ],
  [
    "packages/channels/src/authn/other.ts",
    "\nallowlist?.includes(actor);",
    "ad-hoc-list-membership",
    2,
  ],
  [
    "packages/channels/src/authn/other.ts",
    "\nif (!authorized) throw new Error();",
    "inline-authorization-throw",
    2,
  ],
  [
    "packages/channels/src/authn/other.ts",
    "\nif (isAuthorized === false) { throw new Error(); }",
    "inline-authorization-throw",
    2,
  ],
  [
    "apps/oni/src/other.ts",
    '\nconst rule = { reasonCodes: ["stalled"] };',
    "run-reason-code-vocabulary",
    2,
  ],
  [
    "apps/oni/src/other.ts",
    '\nif (reason === "budget_warning") stop();',
    "run-reason-code-vocabulary",
    2,
  ],
])("reports %s at the offending source line for %s", (path, source, ruleId, line) => {
  expect(validateGuardSource(path, source)).toContainEqual(
    expect.objectContaining({ filePath: path, ruleId, line }),
  );
});

test.each([
  ["packages/agent/src/core/gate/match.ts", "allowlist.includes(actor);"],
  ["apps/oni/src/other.test.ts", 'const reasonCodes = ["stalled"];'],
  ["packages/agent/src/core/ports/reason-codes.ts", 'const reasonCodes = ["stalled"];'],
  ["packages/channels/src/telegram/other.ts", "evaluateTriggers(event);"],
  ["packages/channels/src/authn/decision.ts", "evaluatePermission(actor);"],
])("permits the explicitly scoped guard exception in %s", (path, source) => {
  expect(validateGuardSource(path, source)).toEqual([]);
});

test("guard lint rejects a missing pinned file before scanning", async () => {
  const root = mkdtempSync(join(tmpdir(), "guard-lint-"));
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await expect(main()).rejects.toThrow("Missing pinned guard file:");
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("guard lint reports planted source violations in-process", async () => {
  const root = mkdtempSync(join(tmpdir(), "guard-lint-"));
  for (const file of [
    "packages/agent/src/core/gate/match.ts",
    "packages/channels/src/authn/decision.ts",
  ]) {
    const target = join(root, file);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, file.endsWith("/decision.ts") ? "export const decide = true;" : "");
  }
  try {
    await expectExitViolation(
      root,
      main,
      "VIOLATION: packages/channels/src/authn/decision.ts:1 [missing-canonical-policy-evaluator]",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
