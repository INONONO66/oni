import { appendFileSync } from "node:fs";
import { scriptPartitions } from "./scripts-lanes";
import { parseArgs } from "node:util";
import { z } from "zod";
import { assertTopologyComplete, TOPOLOGY, type WorkspaceTopology } from "./topology";

export const changeClasses = ["docs", "desktop", "kernel", "tooling", "global"] as const;
export interface CiPlan {
  readonly version: 2;
  readonly class: (typeof changeClasses)[number];
  readonly lanes: readonly string[];
  readonly toolingTests: boolean;
  readonly clients: boolean;
  readonly full: boolean;
  readonly verify: boolean;
  readonly dependencyReview: boolean;
  readonly matrix: {
    readonly include: readonly {
      readonly key: string;
      readonly dir: string;
      readonly coverage: boolean;
    }[];
  };
  readonly reason: string;
}

function finishPlan(plan: Selection, changeClass: CiPlan["class"], clients: boolean): CiPlan {
  const whole = changeClass === "tooling" || changeClass === "global";
  const matrix = {
    include: [
      ...plan.matrix.include.filter((row) => row.dir !== "script"),
      ...(whole
        ? scriptPartitions
            .filter((key) => key !== "scripts-contracts")
            .map((key) => ({ key, dir: "script", coverage: true }))
        : []),
    ],
  };
  return {
    ...plan,
    matrix,
    version: 2,
    class: changeClass,
    lanes: matrix.include.map((row) => row.key),
    toolingTests: whole,
    clients,
  };
}

type ChangeSelection = {
  selected: Set<string>;
  changeClass: CiPlan["class"];
  globalReason?: string;
};
function maximumClass(current: CiPlan["class"], next: CiPlan["class"]): CiPlan["class"] {
  return changeClasses.indexOf(next) > changeClasses.indexOf(current) ? next : current;
}
function unsafePath(path: string): boolean {
  return path.split("/").some((part) => part === ".." || part === "." || part === "") || path.includes("\\");
}
function selectChanges(
  paths: readonly string[],
  topology: readonly WorkspaceTopology[],
): ChangeSelection {
  const selected = new Set<string>();
  let changeClass: CiPlan["class"] = "docs";
  for (const path of paths) {
    if (unsafePath(path)) return { selected, changeClass, globalReason: "global-or-unowned-path" };
    if (/^(?:[^/]+\.md|docs\/.*)$/.test(path)) continue;
    if (/(^|\/)(package\.json|bun\.lockb?)$/.test(path))
      return { selected, changeClass, globalReason: "dependency-manifest-change" };
    if (path.startsWith("clients/")) {
      selected.add("@oni/machines");
      changeClass = maximumClass(changeClass, "kernel");
      continue;
    }
    if (path.startsWith("script/") && !path.startsWith("script/conformance/")) {
      changeClass = "tooling";
      continue;
    }
    const owner = topology.find((workspace) => path.startsWith(`${workspace.dir}/`));
    if (!owner) return { selected, changeClass, globalReason: "global-or-unowned-path" };
    if (owner.packageName === "@oni/protocol")
      return { selected, changeClass, globalReason: "shared-contract-change" };
    const next = owner.dir === "apps/desktop" || owner.dir === "packages/ui" ? "desktop" : "kernel";
    changeClass = maximumClass(changeClass, next);
    selected.add(owner.packageName);
  }
  return { selected, changeClass };
}

export function planChanges(
  paths: readonly string[] | undefined,
  full = false,
  topology: readonly WorkspaceTopology[] = TOPOLOGY,
): CiPlan {
  validateGraph(topology);
  if (full) return finishPlan(fullPlan(topology, "full-requested"), "global", true);
  if (paths === undefined) throw new Error("PR planning requires discovered changed paths");

  const clients = paths.some(
    (path) =>
      path.startsWith("clients/") ||
      path.startsWith("packages/protocol/") ||
      path === "script/generate-machine-schema.ts" ||
      path === "script/check-clients-conformance.ts" ||
      path === "script/check-clients-conformance.test.ts" ||
      path === ".github/workflows/ci.yml",
  );
  const selection = selectChanges(paths, topology);
  if (selection.globalReason)
    return finishPlan(fullPlan(topology, selection.globalReason), "global", true);
  const { selected, changeClass } = selection;

  // allowedDeps intentionally includes test-only edges, unlike srcAllowedDeps.
  for (const dependency of selected) {
    for (const workspace of topology) {
      const band = workspace.allowedDeps;
      if (band === "any-except-self" || (band !== "none" && band.includes(dependency))) {
        selected.add(workspace.packageName);
      }
    }
  }
  const workspaces = topology.filter((workspace) => selected.has(workspace.packageName));
  const verify = workspaces.length > 0 || changeClass === "tooling";
  return finishPlan(
    {
      full: false,
      verify,
      dependencyReview: false,
      matrix: { include: verify ? rows(workspaces) : [] },
      reason: verify
        ? "workspace-impact"
        : paths.length === 0
          ? "empty-diff"
          : "root-documentation-only",
    },
    changeClass,
    clients,
  );
}

function rows(topology: readonly WorkspaceTopology[]) {
  return [
    ...topology.map(({ key, dir, coverageLane }) => ({ key, dir, coverage: coverageLane })),
    { key: "scripts", dir: "script", coverage: true },
  ];
}

type Selection = Pick<CiPlan, "full" | "verify" | "dependencyReview" | "matrix" | "reason">;
function fullPlan(topology: readonly WorkspaceTopology[], reason: string): Selection {
  return {
    full: true,
    verify: true,
    dependencyReview: true,
    matrix: { include: rows(topology) },
    reason,
  };
}

function validateGraph(topology: readonly WorkspaceTopology[]): void {
  if (topology.length === 0) throw new Error("topology must contain workspaces");
  const names = new Set(topology.map((workspace) => workspace.packageName));
  const keys = new Set(topology.map((workspace) => workspace.key));
  const dirs = new Set(topology.map((workspace) => workspace.dir));
  if (
    names.size !== topology.length ||
    keys.size !== topology.length ||
    dirs.size !== topology.length ||
    keys.has("scripts")
  ) {
    throw new Error("topology workspace names, keys and directories must be unique");
  }
  for (const workspace of topology) {
    if (
      !/^[a-zA-Z0-9_-]+$/.test(workspace.key) ||
      !/^(packages|apps)\/[a-zA-Z0-9_-]+$/.test(workspace.dir)
    ) {
      throw new Error(`invalid topology workspace boundary: ${workspace.key}`);
    }
    const band = workspace.allowedDeps;
    if (band === "none" || band === "any-except-self") continue;
    for (const dependency of band) {
      if (!names.has(dependency)) throw new Error(`unknown topology dependency: ${dependency}`);
    }
  }
}

export function main(
  argv: readonly string[] = Bun.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (argv.includes("--help")) {
    process.stdout.write("Usage: bun run script/ci-plan.ts [--full | --base SHA --head SHA]\n");
    return;
  }
  const { values } = parseArgs({
    args: [...argv],
    options: { base: { type: "string" }, head: { type: "string" }, full: { type: "boolean" } },
    strict: true,
    allowPositionals: false,
  });
  // Inventory validation must run even when a docs-only/full shortcut is used.
  assertTopologyComplete(TOPOLOGY, process.cwd());
  const event = env.GITHUB_EVENT_NAME;
  const full =
    values.full === true || (event !== undefined && event !== "" && event !== "pull_request");
  let paths: readonly string[] | undefined;
  if (!full) {
    const sha = z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/);
    const base = sha.parse(values.base);
    const head = sha.parse(values.head);
    // Argument arrays, SHA validation, and NUL delimiters avoid shell expansion,
    // option injection, rename loss, and splitting filenames on whitespace.
    const result = Bun.spawnSync(
      ["git", "diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", base, head, "--"],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (result.exitCode !== 0)
      throw new Error(`git diff failed (${result.exitCode}): ${result.stderr.toString()}`);
    const output = result.stdout.toString();
    if (output !== "" && !output.endsWith("\0"))
      throw new Error("git diff output is not NUL terminated");
    paths = output === "" ? [] : output.slice(0, -1).split("\0");
  }
  const plan = planChanges(paths, full, TOPOLOGY);
  const outputPath = env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(
      outputPath,
      `full=${plan.full}\nverify=${plan.verify}\ndependencyReview=${plan.dependencyReview}\nmatrix=${JSON.stringify(plan.matrix)}\nclass=${plan.class}\ntoolingTests=${plan.toolingTests}\nclients=${plan.clients}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}

if (import.meta.main) main();
