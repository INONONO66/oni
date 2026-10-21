import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { main, planChanges } from "./ci-plan";
import { TOPOLOGY, type WorkspaceTopology } from "./topology";

const keys = (paths: readonly string[], topology: readonly WorkspaceTopology[] = TOPOLOGY) =>
  planChanges(paths, false, topology).matrix.include.map((row) => row.key);
const allKeys = [
  ...TOPOLOGY.map((workspace) => workspace.key),
  "scripts-tooling-1",
  "scripts-tooling-2",
];
const cli = join(import.meta.dir, "ci-plan.ts");
const planSchema = z
  .object({
    version: z.literal(2),
    class: z.enum(["docs", "desktop", "kernel", "tooling", "global"]),
    lanes: z.array(z.string()),
    toolingTests: z.boolean(),
    clients: z.boolean(),
    full: z.boolean(),
    verify: z.boolean(),
    dependencyReview: z.boolean(),
    reason: z.string().min(1),
    matrix: z
      .object({
        include: z.array(
          z.object({ key: z.string(), dir: z.string(), coverage: z.boolean() }).strict(),
        ),
      })
      .strict(),
  })
  .strict();

test.each([
  [["docs/nested/guide.md"], "docs", false],
  [["apps/desktop/src/main/index.ts"], "desktop", false],
  [["packages/ui/src/index.ts"], "desktop", false],
  [["packages/agent/src/index.ts"], "kernel", false],
  [["script/ci.ts"], "tooling", true],
  [["packages/protocol/src/index.ts"], "global", true],
  [["mystery/file.ts"], "global", true],
  [["packages/ui/../ledger/src/index.ts"], "global", true],
  [["README.md", "packages/ui/src/index.ts", "script/ci.ts"], "tooling", true],
] as const)("v2 classifies %j as %s", (paths, changeClass, toolingTests) => {
  expect(planChanges(paths)).toMatchObject({ class: changeClass, toolingTests });
});

test("merge-group planning is full and global", () => {
  const plan = planChanges(undefined, true);
  expect(plan).toMatchObject({ full: true, class: "global", toolingTests: true, clients: true });
  expect(plan.lanes).toEqual(allKeys);
});

test.each([
  ["clients/machine-client/src/main.rs", true],
  ["packages/protocol/src/index.ts", true],
  ["packages/machines/src/index.ts", false],
])("selects the Clients Rust lane as %s changes", (path, clients) => {
  expect(planChanges([path]).clients).toBe(clients);
});

test("v2 scopes a desktop change to its own lanes", () => {
  const plan = planChanges(["packages/ui/src/index.ts"]);
  expect(plan.lanes).toEqual(["ui", "desktopApp"]);
  const full = planChanges(undefined, true);
  expect(full.class).toBe("global");
  expect(full.lanes).toEqual(allKeys);
});

test("skips executable jobs when only root documentation changes", () => {
  // Given explicitly supplied documentation paths.
  const paths = ["README.md", "CONTRIBUTING.md", "docs/core-model.md"];
  // When the impact is planned.
  const plan = planChanges(paths);
  // Then no executable or dependency jobs are selected.
  expect(plan).toMatchObject({
    full: false,
    verify: false,
    dependencyReview: false,
    matrix: { include: [] },
  });
});

test.each([
  "packages/ui/src/button.tsx",
  "packages/ui/README.md",
  "packages/ui/test/deleted.test.ts",
])("selects UI consumers and schema-consuming scripts when %s changes", (path) => {
  // Given a workspace-owned file, including package documentation or a removed file.
  // When the impact is planned, then only its reverse closure and scripts run.
  expect(keys([path])).toEqual(["ui", "desktopApp"]);
  expect(planChanges([path]).dependencyReview).toBe(false);
});

test("selects every lane when the shared protocol changes", () => {
  // Given cross-repository schemas, when they change, then every lane runs.
  expect(keys(["packages/protocol/src/index.ts"])).toEqual(allKeys);
});

test.each([
  "package.json",
  "bun.lock",
  "tsconfig.base.json",
  "script/conformance/quality-contract.json",
  ".github/workflows/ci.yml",
  ".github/actions/setup/action.yml",
  "packages/new/package.json",
  "packages/ui/package.json",
  "mystery/file.ts",
  "packages/ui-extra/src/index.ts",
])("fails closed to full when %s changes", (path) => {
  // Given a global, manifest, or unowned path, when planned, then all gates run.
  expect(planChanges([path])).toMatchObject({ full: true, verify: true, dependencyReview: true });
  expect(keys([path])).toEqual(allKeys);
});

test("includes test-only permitted dependencies transitively without a workspace list", () => {
  // Given two future consumers, one importing UI only in its tests.
  const sample = TOPOLOGY[0];
  const topology: readonly WorkspaceTopology[] = [
    ...TOPOLOGY,
    {
      ...sample,
      key: "future",
      dir: "packages/future",
      packageName: "@oni/future",
      allowedDeps: ["@oni/ui"],
      srcAllowedDeps: [],
    },
    {
      ...sample,
      key: "downstream",
      dir: "apps/downstream",
      packageName: "@oni/downstream",
      allowedDeps: ["@oni/future"],
    },
    {
      ...sample,
      key: "wildcard",
      dir: "apps/wildcard",
      packageName: "@oni/wildcard",
      allowedDeps: "any-except-self",
    },
  ];
  // When UI changes, then both direct and transitive consumers are selected.
  expect(keys(["packages/ui/README.md"], topology)).toEqual([
    "ui",
    "desktopApp",
    "future",
    "downstream",
    "wildcard",
  ]);
});

test("rejects missing PR paths rather than treating missing input as an empty diff", () => {
  // Given no path discovery, when planned, then the caller cannot report green.
  expect(() => planChanges(undefined)).toThrow();
});

test("accepts an explicitly empty diff with a reason", () => {
  // Given successful discovery with zero paths, when planned, then no work is needed.
  expect(planChanges([])).toMatchObject({
    verify: false,
    reason: "empty-diff",
    matrix: { include: [] },
  });
});

test("validates dependency references even for documentation-only or full plans", () => {
  // Given an invalid graph, when planned, then neither fast path hides it.
  const topology = [{ ...TOPOLOGY[0], allowedDeps: ["@oni/missing"] }];
  expect(() => planChanges(["README.md"], false, topology)).toThrow();
  expect(() => planChanges(undefined, true, topology)).toThrow();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "oni-ci-plan-"));
  const env = {
    ...process.env,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_OUTPUT: "",
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, env });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git("init", "--quiet");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ workspaces: ["packages/*", "apps/*"] }),
  );
  for (const workspace of TOPOLOGY) {
    mkdirSync(join(root, workspace.dir), { recursive: true });
    writeFileSync(
      join(root, workspace.dir, "package.json"),
      JSON.stringify({ name: workspace.packageName }),
    );
  }
  mkdirSync(join(root, "script"), { recursive: true });
  writeFileSync(join(root, "script/fixture.ts"), "export const fixture = 1;\n");
  writeFileSync(join(root, "script/tsconfig.json"), '{"include":["*.ts"]}');
  const snapshot = () => {
    git("add", "--all");
    return git("commit-tree", git("write-tree"), "-m", "isolated fixture");
  };
  const run = (args: readonly string[], overrides: Record<string, string> = {}) =>
    Bun.spawnSync([process.execPath, cli, ...args], { cwd: root, env: { ...env, ...overrides } });
  return {
    root,
    git,
    snapshot,
    run,
    [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("plans both rename endpoints from real NUL-delimited git output without executing filenames", () => {
  // Given a real git rename with spaces, a newline, and shell metacharacters.
  using repo = fixture();
  const name = "two words\n$(touch PWNED).ts";
  writeFileSync(join(repo.root, "packages/ui", name), "same file\n");
  const base = repo.snapshot();
  renameSync(join(repo.root, "packages/ui", name), join(repo.root, "packages/machines", name));
  const head = repo.snapshot();
  const output = join(repo.root, "github-output");
  // When the actual CLI reads the diff.
  const result = repo.run(["--base", base, "--head", head], { GITHUB_OUTPUT: output });
  // Then both old and new owners propagate, with machine-only output fields.
  expect(result.exitCode).toBe(0);
  const plan = planSchema.parse(JSON.parse(result.stdout.toString()));
  expect(plan.lanes).toEqual(["machines", "codemode", "oniApp", "ui", "desktopApp"]);
  const lines = readFileSync(output, "utf8").trim().split("\n");
  expect(lines).toEqual([
    `full=${plan.full}`,
    `verify=${plan.verify}`,
    `dependencyReview=${plan.dependencyReview}`,
    `matrix=${JSON.stringify(plan.matrix)}`,
    `class=${plan.class}`,
    `toolingTests=${plan.toolingTests}`,
    `clients=${plan.clients}`,
  ]);
  expect(existsSync(join(repo.root, "PWNED"))).toBe(false);
});

test("fails the actual CLI when git cannot resolve a supplied commit", () => {
  // Given a valid repository but a missing object, when git fails, then no green plan is emitted.
  using repo = fixture();
  const result = repo.run(["--base", "1".repeat(40), "--head", repo.snapshot()]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString().length).toBeGreaterThan(0);
});

test("fails the actual CLI when PR input is absent", () => {
  // Given a PR without SHAs, when invoked, then it fails instead of skipping jobs.
  using repo = fixture();
  const result = repo.run([]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).toBe("");
});

test.each([
  "push",
  "workflow_dispatch",
  "schedule",
  "merge_group",
])("forces full for the %s event", (event) => {
  // Given a non-PR event without diff input, when invoked, then every gate runs.
  using repo = fixture();
  const result = repo.run([], { GITHUB_EVENT_NAME: event });
  expect(result.exitCode).toBe(0);
  expect(planSchema.parse(JSON.parse(result.stdout.toString()))).toMatchObject({
    full: true,
    verify: true,
    dependencyReview: true,
  });
});

test("accepts a truly empty git diff with an explicit reason", () => {
  // Given identical revisions, when the CLI discovers paths, then it can safely skip.
  using repo = fixture();
  const sha = repo.snapshot();
  const result = repo.run(["--base", sha, "--head", sha]);
  expect(result.exitCode).toBe(0);
  expect(planSchema.parse(JSON.parse(result.stdout.toString()))).toMatchObject({
    verify: false,
    reason: "empty-diff",
  });
});

test("fails topology inventory drift before emitting even a full plan", () => {
  // Given a newly discovered workspace not in topology, when forced full, then validation fails.
  using repo = fixture();
  mkdirSync(join(repo.root, "packages/new"));
  writeFileSync(join(repo.root, "packages/new/package.json"), "{}");
  const result = repo.run(["--full"]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).toBe("");
});

test("main writes the complete GITHUB_OUTPUT contract for a full run", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-plan-output-"));
  try {
    const output = join(dir, "github-output");
    writeFileSync(output, "");
    const cwd = process.cwd();
    process.chdir(join(import.meta.dir, ".."));
    try {
      main(["--full"], { GITHUB_OUTPUT: output });
    } finally {
      process.chdir(cwd);
    }
    const written = readFileSync(output, "utf8");
    for (const key of [
      "full=true",
      "verify=true",
      "dependencyReview=",
      "matrix=",
      "class=global",
      "toolingTests=",
      "clients=true",
    ]) {
      expect(written).toContain(key);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
