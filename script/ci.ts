import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { TOPOLOGY } from "./topology";
import { pythonTests, scriptContracts, scriptPartitions, scriptTestCommand } from "./scripts-lanes";
import { changeClasses } from "./ci-plan";

const ROOT = join(import.meta.dir, "..");
const LANES = [
  ...TOPOLOGY.map((workspace) => ({
    key: workspace.key,
    dir: workspace.dir,
    coverage: workspace.coverageLane,
  })),
  ...scriptPartitions.filter((key) => key !== "scripts-contracts").map((key) => ({ key, dir: "script", coverage: true })),
];
const planSchema = z
  .object({
    version: z.literal(2),
    class: z.enum(changeClasses),
    toolingTests: z.boolean(),
    full: z.boolean(),
    verify: z.boolean(),
    dependencyReview: z.boolean(),
    reason: z.string(),
    matrix: z.object({
      include: z.array(
        z.object({
          key: z.string(),
          dir: z.string(),
          coverage: z.boolean(),
        }),
      ),
    }),
  })
  .superRefine((plan, ctx) => {
    const keys = new Set(plan.matrix.include.map((lane) => lane.key));
    if (
      keys.size !== plan.matrix.include.length ||
      plan.verify !== keys.size > 0 ||
      (plan.full && keys.size !== LANES.length) ||
      scriptPartitions.filter((key) => key !== "scripts-contracts").some((key) => keys.has(key) !== plan.toolingTests) ||
      plan.matrix.include.some(
        (lane) =>
          !LANES.some(
            (known) =>
              known.key === lane.key && known.dir === lane.dir && known.coverage === lane.coverage,
          ),
      )
    ) {
      ctx.addIssue({ code: "custom", message: "Invalid CI lane inventory" });
    }
  });

class CiError extends Error {
  constructor(readonly operation: string) {
    super(`CI failed: ${operation}`);
  }
}

function argv(command: readonly string[]): string[] {
  return command[0] === "bunx"
    ? [process.execPath, "x", ...command.slice(1)]
    : command[0] === "bun"
      ? [process.execPath, ...command.slice(1)]
      : [...command];
}
function run(command: readonly string[], cwd = ROOT, env: Record<string, string> = {}): void {
  const child = Bun.spawnSync(argv(command), { cwd, env: { ...process.env, ...env }, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (child.exitCode !== 0) throw new CiError(command.join(" "));
}

/** The Python analyzers' self-tests run directly; the scheduled mutation audit
 * owns Python evidence, so the PR gate only needs the tests to pass. */
function pythonSelfTests(root: string): void {
  const cwd = join(root, "script");
  const python = process.env.D945_PYTHON ?? "python3";
  const env = {
    QUALITY_MUTATION_DECISION: join(cwd, "conformance/quality-mutation-contract.json"),
  };
  for (const test of pythonTests()) run([python, test], cwd, env);
}

function readPlan(path?: string) {
  return planSchema.parse(
    JSON.parse(path ? readFileSync(path, "utf8") : (process.env.CI_PLAN ?? "null")),
  );
}

export function gate(plan: z.infer<typeof planSchema>, testOnly: boolean): void {
  const needs = z
    .record(
      z.string(),
      z.object({
        result: z.enum(["success", "failure", "cancelled", "skipped"]),
      }),
    )
    .parse(JSON.parse(process.env.CI_NEEDS ?? "null"));
  const required = new Map([
    ["plan", true],
    ["prepare", true],
    ["tests", plan.verify],
    ["scripts-contracts", true],
    ...(testOnly
      ? []
      : ([
          [
            "desktop-smoke",
            plan.verify && plan.matrix.include.some((lane) => lane.key === "desktopApp" || lane.key === "ui"),
          ],
          ["static", plan.verify],
          ["deps", plan.verify],
          ["patch-coverage", plan.verify && process.env.CI_EVENT === "pull_request"],
          ["dependency-review", plan.dependencyReview && process.env.CI_EVENT === "pull_request"],
        ] satisfies [string, boolean][])),
  ]);
  for (const [job, enabled] of required) {
    const result = needs[job]?.result;
    if (result !== (enabled ? "success" : "skipped"))
      throw new CiError(`${job}: ${result ?? "missing"}`);
  }
}

function artifacts(mode: "pack" | "restore", root: string): void {
  const archive = join(root, "workspace-dist.tar");
  if (mode === "restore") run(["tar", "-xf", archive], root);
  const dirs = TOPOLOGY.filter((workspace) => {
    const manifest = z
      .object({ scripts: z.record(z.string(), z.string()) })
      .parse(JSON.parse(readFileSync(join(root, workspace.dir, "package.json"), "utf8")));
    return Boolean(manifest.scripts.build);
  }).map((workspace) => `${workspace.dir}/dist`);
  for (const dir of dirs) {
    if (
      !existsSync(join(root, dir)) ||
      [...new Bun.Glob("**/*").scanSync({ cwd: join(root, dir), onlyFiles: true })].length === 0
    ) {
      throw new CiError(`missing build artifact: ${dir}`);
    }
  }
  if (mode === "pack") run(["tar", "-cf", archive, ...dirs], root);
}

/** Lanes whose tests attach a real client: build it once per lane unless the runner names one. */
function ensureClientBinary(key: string, root: string): void {
  if (key !== "machines" && key !== "codemode" && key !== "oniApp") return;
  const binary = process.env.ONI_MCLIENT_BIN ?? join(root, "clients/target/release/mclient");
  if (process.env.ONI_MCLIENT_BIN === undefined)
    run(["cargo", "build", "--release", "--locked", "-p", "oni-machine-client"], join(root, "clients"));
  else if (!existsSync(binary)) throw new CiError(`missing client binary: ${binary}`);
  process.env.ONI_MCLIENT_BIN = binary;
}

function testLane(key: string | undefined, root: string): void {
  if (key && scriptPartitions.some((partition) => partition === key)) {
    run(scriptTestCommand(key), join(root, "script"));
    if (key === "scripts-contracts") for (const command of scriptContracts) run(["bun", "run", `script/${command[0]}`, ...command.slice(1)], root);
    if (key === "scripts-tooling-1") pythonSelfTests(root);
    return;
  }
  const lane = LANES.find((candidate) => candidate.key === key);
  if (!lane) throw new CiError(`unknown lane: ${key}`);
  ensureClientBinary(lane.key, root);
  const workspace = TOPOLOGY.find((candidate) => candidate.key === lane.key);
  const override = workspace && "ciTestCommand" in workspace ? workspace.ciTestCommand : undefined;
  run(override ? override.split(" ") : [
    "bun", "test", "--timeout", "15000",
    ...(lane.coverage ? ["--coverage", "--coverage-reporter=lcov", "--coverage-dir=coverage"] : []),
  ], join(root, lane.dir));
}

export function ciMain(argv = Bun.argv.slice(2)): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      plan: { type: "string" },
      lane: { type: "string" },
      root: { type: "string" },
    },
  });
  switch (positionals[0]) {
    case "build":
      run(["bun", "run", "build"]);
      return;
    case "pack":
    case "restore":
      artifacts(positionals[0], values.root ?? ROOT);
      return;
    case "gate":
    case "test-gate":
      gate(readPlan(values.plan), positionals[0] === "test-gate");
      return;
    case "check-types": {
      const plan = readPlan(values.plan);
      const selected = new Set(plan.matrix.include.map((lane) => lane.key));
      const filters = TOPOLOGY.filter((workspace) => selected.has(workspace.key)).map(
        (workspace) => `--filter=${workspace.packageName}`,
      );
      // Artifacts are already restored: --only prevents dependency builds from running again.
      if (filters.length > 0) run(["bunx", "turbo", "run", "check-types", "--only", ...filters]);
      if (plan.toolingTests) run(["bunx", "tsc", "-p", "script/tsconfig.json"]);
      return;
    }
    case "test":
      testLane(values.lane, values.root ?? ROOT);
      return;
    default:
      throw new CiError(
        "expected build, pack, restore, check-types --plan FILE, test --lane KEY, gate or test-gate",
      );
  }
}

if (import.meta.main) ciMain();
