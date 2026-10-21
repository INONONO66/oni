import { YAML } from "bun";
import { expect, test } from "bun:test";
import { z } from "zod";

const Step = z.object({
  uses: z.string().optional(),
  "continue-on-error": z.boolean().optional(),
  run: z.string().optional(),
  if: z.string().optional(),
  with: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).optional(),
});
const Job = z.object({
  if: z.string().optional(),
  permissions: z.object({ contents: z.string() }).optional(),
  env: z.record(z.string(), z.string()).optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  steps: z.array(Step),
});
const WorkflowInput = z.object({ description: z.string(), required: z.boolean(), default: z.string() });
const Workflow = z.object({
  permissions: z.object({ contents: z.string() }),
  on: z.object({
    push: z.object({ branches: z.array(z.string()), paths: z.array(z.string()).optional() }),
    pull_request: z.object({ paths: z.array(z.string()) }),
    schedule: z.array(z.object({ cron: z.string() })),
    workflow_dispatch: z.object({ inputs: z.record(z.string(), WorkflowInput) }),
  }),
  concurrency: z.object({ group: z.string(), "cancel-in-progress": z.string() }),
  jobs: z.object({ benchmark: Job, memory: Job, publish: Job }),
});
const workflow = Workflow.parse(
  YAML.parse(await Bun.file(new URL("../.github/workflows/benchmark.yml", import.meta.url)).text()),
);

test("benchmark PRs select benchmark inputs while main stays full", () => {
  expect(workflow.on.push).toEqual({ branches: ["main"] });
  expect(workflow.on.schedule.length).toBeGreaterThan(0);
  expect(workflow.on.pull_request.paths).toEqual([
    ".github/workflows/benchmark.yml", "script/benchmark-workflow.test.ts",
    "packages/agent/**", "packages/protocol/**",
    "script/summarize-benchmark-runs.ts", "script/check-benchmark-regression.ts",
    "script/conformance/summarize-benchmark-runs.test.ts", "script/check-benchmark-regression.test.ts",
    "package.json", "bun.lock", "bunfig.toml", "turbo.json", "tsconfig.base.json",
  ]);
});

test("benchmark history is never cancelled on main pushes", () => {
  expect(workflow.concurrency["cancel-in-progress"]).toBe(["$", "{{ github.event_name == 'pull_request' }}"].join(""));
});

test("benchmark input is validated before collection starts", () => {
  const steps = workflow.jobs.benchmark.steps;
  const validation = steps.findIndex((step) => step.run?.includes("--validate-input"));
  const collection = steps.findIndex((step) => step.run?.includes("seq 1"));
  expect(validation).toBeGreaterThanOrEqual(0);
  expect(collection).toBeGreaterThan(validation);
});

test("failed benchmark comparisons cannot publish a new reference", () => {
  const steps = workflow.jobs.publish.steps;
  const comparison = steps.findIndex((step) =>
    step.uses?.startsWith("benchmark-action/github-action-benchmark@"),
  );
  expect(comparison).toBeGreaterThanOrEqual(0);
  expect(steps[comparison]?.with?.["auto-push"]).toBe(false);
  expect(steps[comparison]?.with?.["output-file-path"]).toBe("bench-results/combined.json");
  for (const key of ["fail-on-alert", "alert-threshold", "comment-on-alert"]) {
    expect(steps[comparison]?.with?.[key]).toBeUndefined();
  }
  expect(steps.some((step) => step.run?.includes("--orphan"))).toBe(false);
  expect(workflow.jobs.publish.if).toBe("(github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')");
  const publication = steps.findIndex((step) =>
    step.run?.includes("git push origin gh-pages:gh-pages"),
  );
  expect(publication).toBeGreaterThan(comparison);
  expect(steps[publication]?.if).toBe("success()");
});

test("all events collect the accepted SHA and head on one runner before the sole paired gate", () => {
  const steps = workflow.jobs.benchmark.steps;
  const reference = steps.findIndex((step) => step.run?.includes("git show FETCH_HEAD:dev/bench/data.js"));
  const collection = steps.findIndex((step) => step.run?.includes("seq 1"));
  const summary = steps.findIndex((step) => step.run?.includes("summarize-benchmark-runs.ts --reference bench-results/reference/runs"));
  const gate = steps.findIndex((step) => step.run?.includes("--prepare-reference"));
  expect(reference).toBeGreaterThanOrEqual(0);
  expect(collection).toBeGreaterThan(reference);
  expect(summary).toBeGreaterThan(collection);
  expect(gate).toBeGreaterThan(summary);
  expect(steps[reference]?.run).toContain("git fetch --no-tags origin gh-pages");
  expect(steps[reference]?.run).toContain("reference_commit=$(bun run script/check-benchmark-regression.ts --accepted-commit bench-results/accepted.js)");
  expect(steps[reference]?.run).toContain('git fetch --no-tags origin "$reference_commit"');
  expect(steps[reference]?.run).toContain('git worktree add --detach "$REFERENCE_WORKTREE" "$reference_commit"');
  expect(steps[reference]?.run).toContain('cd "$REFERENCE_WORKTREE"');
  expect(steps[reference]?.run).toContain("bun install --frozen-lockfile");
  expect(steps[reference]?.run).toContain("bunx turbo run build --filter=@oni/protocol");
  expect(steps[collection]?.run).toContain("if (( run % 2 )); then revisions=(reference head); else revisions=(head reference); fi");
  expect(steps[collection]?.run).toContain('measure reference "$REFERENCE_WORKTREE" "$GITHUB_WORKSPACE/bench-results/reference/runs/$run"');
  expect(steps[collection]?.run).toContain('measure head "$GITHUB_WORKSPACE" "$GITHUB_WORKSPACE/bench-results/runs/$run"');
  expect(steps[collection]?.run).toContain("bun run --cwd packages/agent bench/store.ts");
  expect(steps[collection]?.run).toContain('cp packages/agent/bench-results/session.json "$output/session.json"');
  expect(steps[collection]?.run).toContain('cp packages/agent/bench-results/agent.json "$output/agent.json"');
  expect(steps[summary]?.run).toContain("bun run script/summarize-benchmark-runs.ts\n");
  expect(steps[summary]?.run).toContain(
    "bun run script/summarize-benchmark-runs.ts --reference bench-results/reference/runs bench-results/reference/combined.json bench-results/reference/statistics.json bench-results/reference/summary.md",
  );
  expect(steps[gate]?.run).toContain('--prepare-reference bench-results/reference/statistics.json bench-results/accepted.js "$(git -C "$REFERENCE_WORKTREE" rev-parse HEAD)" "$(git rev-parse HEAD)"');
  const decision = "bun run script/check-benchmark-regression.ts bench-results/statistics.json bench-results/reference.json";
  expect(steps[gate]?.run).toContain(decision);
  expect(steps.filter((step) => step.run?.includes(decision))).toHaveLength(1);
  expect(workflow.jobs.benchmark.env).toEqual({
    BENCHMARK_REGRESSION_PERCENT: "20",
    BENCHMARK_ACCEPT_BASELINE: [
      "$",
      "{{ (github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'benchmark:accept-baseline')) || (github.event_name == 'workflow_dispatch' && github.event.inputs.accept_baseline == 'true') }}",
    ].join(""),
  });
  expect(steps[reference]?.run).toContain('REFERENCE_WORKTREE="$RUNNER_TEMP/benchmark-reference"');
  expect(steps[reference]?.run).toContain('printf \'REFERENCE_WORKTREE=%s\\n\' "$REFERENCE_WORKTREE" >> "$GITHUB_ENV"');
  expect(workflow.on.workflow_dispatch.inputs.accept_baseline).toEqual({
    description: "Owner-approved baseline reset: accept regressions above the limit and publish the new reference",
    required: false,
    default: "false",
  });
  expect(workflow.on.workflow_dispatch.inputs["regression-percent"]).toBeUndefined();
  expect(workflow.permissions.contents).toBe("read");
  expect(workflow.jobs.benchmark.permissions).toBeUndefined();
  expect(workflow.jobs.benchmark.if).toBeUndefined();
  expect(steps.some((step) => step.run?.includes("git push"))).toBe(false);
  for (const index of [reference, collection, summary, gate]) {
    const step = steps[index];
    if (!step) throw new Error("Missing required benchmark step");
    expect(step.if).toBeUndefined();
    expect(step["continue-on-error"]).toBeUndefined();
    expect(step.run).toContain("set -euo pipefail");
    expect(step.run).not.toMatch(/\|\|\s*true|set \+e|continue-on-error/);
  }
});

test("memory guards do not prevent collection artifacts or comparison", () => {
  expect(workflow.jobs.memory).toBeDefined();
  expect(workflow.jobs.publish.needs).toBe("benchmark");
  const steps = workflow.jobs.benchmark.steps;
  expect(steps.some((step) => step.run?.includes("memory-regression.bench.ts"))).toBe(false);
  const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  expect(upload?.if).toBe("always()");
  expect(upload?.with?.["retention-days"]).toBe(14);
});
