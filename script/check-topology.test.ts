import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { captureConsole } from "./capture-output.test-helper";
import { main, topologyProblems, type TopologyConsumer } from "./check-topology";
import {
  assertTopologyComplete,
  ciTestSteps,
  TOPOLOGY,
  topologyInventoryDrift,
  type WorkspaceTopology,
} from "./topology";
import { main as generateAgentsDeps, renderTopology } from "./generate-agents-deps";

const consumers: readonly TopologyConsumer[] = [
  "dependency-bands",
  "import-cycles",
  "knip",
  "dead-exports",
  "ci-tests",
  "tsconfig",
];

const phantom: WorkspaceTopology = {
  key: "phantom",
  displayName: "phantom",
  dir: "packages/phantom",
  packageName: "@oni/phantom",
  allowedDeps: ["@oni/protocol"],
  testLane: true,
  // Explicitly skipped just like machines: coverage still has to account for
  // the workspace and reject its missing package boundary.
  coverageLane: false,
  knipWorkspace: true,
  tsconfigVerify: true,
};

const fixtureRoots: string[] = [];
afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "topology-consumers-"));
  fixtureRoots.push(root);
  const workspace: WorkspaceTopology = { ...phantom, allowedDeps: [], coverageLane: true };
  const files = {
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "packages/phantom/package.json": JSON.stringify({ name: workspace.packageName }),
    "packages/phantom/src/index.ts": "export const value = 1;",
    "packages/phantom/test/index.test.ts": "",
    "packages/phantom/tsconfig.json": "{}",
    "knip.json": JSON.stringify({ workspaces: { ".": {}, [workspace.dir]: {} } }),
    ".github/workflows/ci.yml": [
      "      # topology:test-steps:start",
      ciTestSteps([workspace]),
      "      # topology:test-steps:end",
    ].join("\n"),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { root, workspace };
}

const damagedConsumers: readonly {
  readonly name: string;
  readonly affected: readonly TopologyConsumer[];
  readonly damage: (root: string, workspace: WorkspaceTopology) => WorkspaceTopology;
}[] = [
  {
    name: "package identity",
    affected: ["dependency-bands"],
    damage(root, workspace) {
      writeFileSync(join(root, workspace.dir, "package.json"), '{"name":"wrong"}');
      return workspace;
    },
  },
  {
    name: "source inventory",
    affected: ["import-cycles"],
    damage(root, workspace) {
      rmSync(join(root, workspace.dir, "src/index.ts"));
      return workspace;
    },
  },
  {
    name: "project inventory",
    affected: ["tsconfig"],
    damage(root, workspace) {
      rmSync(join(root, workspace.dir, "tsconfig.json"));
      return workspace;
    },
  },
  {
    name: "dependency target",
    affected: ["dependency-bands"],
    damage(_root, workspace) {
      return { ...workspace, allowedDeps: ["@oni/missing"] };
    },
  },
  {
    name: "knip inventory",
    affected: ["knip", "dead-exports"],
    damage(root, workspace) {
      writeFileSync(join(root, "knip.json"), '{"workspaces":{".":{}}}');
      return workspace;
    },
  },
  {
    name: "CI test discovery",
    affected: ["ci-tests"],
    damage(root, workspace) {
      writeFileSync(join(root, ".github/workflows/ci.yml"), "");
      return workspace;
    },
  },
];

describe("topology conformance", () => {
  for (const { name, affected, damage } of damagedConsumers) {
    test(`detects damaged ${name} with the workspace inventory intact`, () => {
      const { root, workspace } = fixture();
      for (const problems of Object.values(topologyProblems([workspace], root))) {
        expect(problems).toEqual([]);
      }
      const damaged = damage(root, workspace);
      expect(() => assertTopologyComplete([damaged], root)).not.toThrow();
      const problems = topologyProblems([damaged], root);
      for (const consumer of consumers) {
        if (affected.includes(consumer)) expect(problems[consumer].length).toBeGreaterThan(0);
        else expect(problems[consumer]).toEqual([]);
      }
    });
  }

  test("the checked-in manifest conforms to every structural consumer", () => {
    const problems = topologyProblems();
    for (const consumer of consumers) expect(problems[consumer]).toEqual([]);
  });

  test("inventory refuses a root manifest without workspace globs", () => {
    const { root, workspace } = fixture();
    writeFileSync(join(root, "package.json"), '{"workspaces":42}');
    expect(() => topologyInventoryDrift([workspace], root)).toThrow(
      "root package.json workspaces must be an array of glob strings",
    );
  });

  test("CI steps honor explicit commands and unmeasured test lanes", () => {
    const unmeasured: WorkspaceTopology = { ...phantom, coverageLane: false };
    const custom: WorkspaceTopology = {
      ...phantom,
      key: "custom",
      dir: "apps/custom",
      ciTestCommand: "bun run test:ci",
    };
    const steps = ciTestSteps([unmeasured, custom]);
    expect(steps).toContain("run: bun test --timeout 15000\n");
    expect(steps).toContain("run: bun run test:ci\n");
    expect(steps).not.toContain("--coverage");
  });

  test("the app lane alone has a bounded test step", () => {
    const steps = ciTestSteps(TOPOLOGY);
    expect(steps).toContain("name: Test (oni app)\n        if: matrix.key == 'oniApp'\n        timeout-minutes: 10\n");
    // Exactly one bounded step: the app lane. Every other workspace declares no deadline.
    expect(steps.match(/timeout-minutes:/g)).toHaveLength(1);
    const bounded: readonly WorkspaceTopology[] = TOPOLOGY;
    expect(bounded.filter((workspace) => workspace.ciTestTimeoutMinutes !== undefined).map((workspace) => workspace.key)).toEqual(["oniApp"]);
  });

  test("generated dependency rows preserve manifest and source bands", () => {
    const base: WorkspaceTopology = { ...phantom, allowedDeps: "none" };
    const consumer: WorkspaceTopology = {
      ...phantom,
      key: "consumer",
      dir: "apps/consumer",
      packageName: "@oni/consumer",
      allowedDeps: [base.packageName],
      srcAllowedDeps: [],
    };
    const generated = renderTopology([base, consumer]);
    expect(generated).toContain("phantom <- apps/consumer");
    expect(generated).toContain("| `phantom` | none |");
    expect(generated).toContain("| `apps/consumer` | phantom; `src/` may depend on none |");
    expect(renderTopology([{ ...base, allowedDeps: "any-except-self" }])).toContain(
      "| `phantom` | any workspace except itself |",
    );
  });

  test("reports duplicated topology identity and missing manifest", () => {
    const { root, workspace } = fixture();
    const duplicate = { ...workspace, key: "duplicate" };
    const problems = topologyProblems([workspace, duplicate], root);
    expect(problems["dependency-bands"]).toContain(`duplicate workspace dir ${workspace.dir}`);
    expect(problems["dependency-bands"]).toContain(
      `duplicate package name ${workspace.packageName}`,
    );
    rmSync(join(root, workspace.dir, "package.json"));
    expect(topologyProblems([workspace], root)["dependency-bands"]).toContain(
      `${workspace.dir} has no package.json`,
    );
  });

  test("reports absent source and test roots for a workspace", () => {
    const { root, workspace } = fixture();
    rmSync(join(root, workspace.dir, "src"), { recursive: true });
    rmSync(join(root, workspace.dir, "test"), { recursive: true });
    expect(topologyProblems([workspace], root).tsconfig).toEqual(
      expect.arrayContaining([`${workspace.dir}/src is missing`, `${workspace.dir}/test is missing`]),
    );
  });

  test("a phantom manifest package is noticed by every consumer", () => {
    expect(() => assertTopologyComplete([...TOPOLOGY, phantom])).toThrow(
      "topology names workspace(s) with no on-disk package: packages/phantom",
    );
    const problems = topologyProblems([...TOPOLOGY, phantom]);
    const proof = Object.fromEntries(
      consumers.map((consumer) => [consumer, problems[consumer].join(" | ")]),
    );
    process.stdout.write(`PHANTOM-PROOF ${JSON.stringify(proof)}\n`);
    for (const consumer of consumers) {
      expect(problems[consumer].length, `${consumer} silently ignored phantom`).toBeGreaterThan(0);
    }
  });

  test("an omitted on-disk workspace is noticed by every consumer", () => {
    const omitted = TOPOLOGY.filter((workspace) => workspace.key !== "machines");
    expect(() => assertTopologyComplete(omitted)).toThrow("packages/machines");

    const problems = topologyProblems(omitted);
    const proof = Object.fromEntries(
      consumers.map((consumer) => [consumer, problems[consumer].join(" | ")]),
    );
    process.stdout.write(`OMISSION-PROOF ${JSON.stringify(proof)}\n`);
    for (const consumer of consumers) {
      expect(problems[consumer].length, `${consumer} silently ignored omission`).toBeGreaterThan(0);
      expect(problems[consumer].join(" | ")).toContain("packages/machines");
    }
  });
});

test("the real repository topology passes the executable gate", () => {
  expect(main()).toBe(0);
});

test("the executable gate returns failure and reports every consumer of inventory drift", () => {
  const { root } = fixture();
  const stderr: string[] = [];
  const write = spyOn(process.stderr, "write").mockImplementation((chunk: string) => {
    stderr.push(chunk);
    return true;
  });
  try {
    expect(main([], root)).toBe(1);
  } finally {
    write.mockRestore();
  }
  expect(stderr.join("")).toContain("VIOLATION [topology] dependency-bands: workspace inventory drift");
  expect(stderr.join("")).toContain("VIOLATION [topology] tsconfig: topology contributes zero tsconfig workspaces");
});

test("topology generator checks and updates only its generated document section", async () => {
  const { root, workspace } = fixture();
  const document = join(root, "AGENTS.md");
  const initial = "before\n<!-- BEGIN GENERATED TOPOLOGY -->\nstale\n<!-- END GENERATED TOPOLOGY -->\nafter\n";
  writeFileSync(document, initial);
  const argv = process.argv;
  const exitCode = process.exitCode;
  const console_ = captureConsole();
  try {
    process.argv = [process.execPath, "generate-agents-deps.ts", "--check"];
    await generateAgentsDeps(document, [workspace]);
    expect(process.exitCode).toBe(1);
    expect(readFileSync(document, "utf8")).toBe(initial);
    process.exitCode = 0;
    process.argv = [process.execPath, "generate-agents-deps.ts"];
    await generateAgentsDeps(document, [workspace]);
    const updated = readFileSync(document, "utf8");
    expect(updated).toBe(`before\n${renderTopology([workspace])}\nafter\n`);
    process.argv = [process.execPath, "generate-agents-deps.ts", "--check"];
    await generateAgentsDeps(document, [workspace]);
    expect(process.exitCode).toBe(0);
    expect(console_.messages).toContain("AGENTS.md dependency topology is current");
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    console_.restore();
  }
});

test("topology generator rejects documents without ordered section markers", async () => {
  const { root, workspace } = fixture();
  const document = join(root, "AGENTS.md");
  writeFileSync(document, "<!-- END GENERATED TOPOLOGY --><!-- BEGIN GENERATED TOPOLOGY -->");
  await expect(generateAgentsDeps(document, [workspace])).rejects.toThrow(
    "AGENTS.md must contain one",
  );
});
