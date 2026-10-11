import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeJson, jsonArray, jsonObject, jsonString } from "./quality-inventory";
import { JOB_TIMEOUT_MINUTES } from "./quality-native-mutation";

// Workflow keys and command wiring are machine-consumed, not prose snapshots.
test("full mutation is an explicit scheduled workflow, never a silently skipped PR gate", () => {
  const parsed = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      "process.stdout.write(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text())))",
    ],
    {
      stdin: readFileSync(join(import.meta.dir, "../.github/workflows/quality-mutation.yml")),
      timeout: 5000,
    },
  );
  expect(parsed.exitCode).toBe(0);
  const workflow = jsonObject(decodeJson(parsed.stdout.toString()));
  const triggers = jsonObject(workflow.on);
  expect(jsonArray(triggers.schedule, jsonObject).length).toBeGreaterThan(0);
  expect(Object.hasOwn(triggers, "workflow_dispatch")).toBe(true);
  expect(Object.hasOwn(triggers, "pull_request")).toBe(false);
  const inputs = jsonObject(jsonObject(triggers.workflow_dispatch).inputs);
  expect(jsonObject(inputs.mutant_memory_mb).default).toBe(6144);
  const job = jsonObject(jsonObject(workflow.jobs).mutation);
  // The wrapper derives the runner deadline from this job timeout, so the yml
  // and the wrapper must agree on the outer deadline.
  expect(job["timeout-minutes"]).toBe(JOB_TIMEOUT_MINUTES);
  const steps = jsonArray(job.steps, jsonObject);
  expect(
    steps.some(
      (step) =>
        typeof step.run === "string" && step.run.includes("script/quality-native-mutation.ts"),
    ),
  ).toBe(true);
  expect(
    steps.some(
      (step) => typeof step.run === "string" && step.run.includes("script/check-quality-python.ts"),
    ),
  ).toBe(true);
  for (const step of steps) {
    if (typeof step.run !== "string" || !step.run.includes("script/quality-native-mutation.ts"))
      continue;
    expect(step["continue-on-error"]).toBeUndefined();
    expect(step.if).toBeUndefined();
    // The receipt is measurement, not a ratchet: no baseline argument exists.
    expect(jsonString(step.run)).not.toContain("--baseline");
    expect(jsonString(step.run)).toContain("--shard");
    expect(jsonString(step.run)).toContain("--budget-minutes");
    expect(jsonString(step.run)).toContain('args=(--mutant-memory-mb "$MUTANT_MEMORY_MB")');
    expect(jsonObject(step.env).MUTANT_MEMORY_MB).toBe(`\${{ inputs.mutant_memory_mb || 6144 }}`);
    expect(jsonString(step.run)).toContain("--progress");
  }
  // Sharded matrix: one failed shard must not cancel the others, and the shard
  // list comes from the plan job so shard_count stays a dispatch input.
  const strategy = jsonObject(job.strategy);
  expect(strategy["fail-fast"]).toBe(false);
  expect(jsonString(jsonObject(strategy.matrix).shard)).toContain("needs.plan.outputs.shards");
  expect(Object.hasOwn(jsonObject(workflow.jobs), "plan")).toBe(true);
  const uploads = steps.filter(
    (step) =>
      typeof step.name === "string" && jsonString(jsonObject(step.with ?? {}).name ?? "").includes("quality-mutation-progress-"),
  );
  expect(uploads.length).toBe(1);
  // Join job merges shard receipts through the real join entry point.
  const joinJob = jsonObject(jsonObject(workflow.jobs).join);
  const joinSteps = jsonArray(joinJob.steps, jsonObject);
  const joinRun = joinSteps.find(
    (step) => typeof step.run === "string" && step.run.includes("script/quality-mutation-join.ts"),
  );
  expect(joinRun).toBeDefined();
  expect(jsonString(jsonObject(joinRun ?? {}).run)).not.toContain("--baseline");
  expect(jsonString(jsonObject(joinRun ?? {}).run)).toContain("--shards");
  // A missing campaign receipt fails the scheduled run instead of warning.
  const receiptUpload = joinSteps.find(
    (step) => jsonString(jsonObject(step.with ?? {}).name ?? "") === "quality-mutation-receipt",
  );
  expect(jsonObject(jsonObject(receiptUpload ?? {}).with)["if-no-files-found"]).toBe("error");
});
